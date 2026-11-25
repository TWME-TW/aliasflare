import PostalMime, { type Email } from "postal-mime";
import type { AppConfig } from "./config";
import { signToken } from "./crypto";
import { ensureAlias, ensureContact, getAlias, mapOriginalToForwarded, matchBlocklist, newId, now, type ForwardRow } from "./db";
import { cleanAttachment, domainOf, ensureAngle, extractEmail, cleanSubjectLine, formatSenderName, parseBareEmail, normalizeEmail, parseMessageIds, reverseAddress as reverseAddressOf, sanitizeDisplayName } from "./format";
import { translator } from "./i18n";
import { getStoredMessage, mailflareConfig, MailflareError, MAX_MESSAGE_BYTES, type StoredMessage } from "./mailflare";
import { sha256Hex } from "./apikeys";
import { isOwnAddress, isReverseDomainOf, reverseDomainFor } from "./domains";
import { LINK_TTL_SECONDS } from "./unsubscribe";
import { authResultClauses, firstAuthenticationResults } from "./reply";
import { loadSettings } from "./settings";
import { readLimited } from "./streams";
import { transformForward, type BannerInfo } from "./transform";

export const LOOP_HEADER = "X-Aliasflare";
const STALE_PROCESSING_SECONDS = 120;
const MAX_REFERENCES = 10;
/** A message that failed this many times is given up on, so Mailflare stops retrying it. */
const MAX_ATTEMPTS = 5;
/** Forwards go out with Cloudflare Email Sending, which takes at most 32 attachments. */
const MAX_ATTACHMENTS = 32;
const MAX_UNSUBSCRIBE_LENGTH = 4096;
const MAX_NAME_LENGTH = 120;

export type InboundEvent = {
	messageId: string;
	from?: string;
	to?: string;
	subject?: string;
};

export type ForwardOutcome = { status: number; result: string };

/**
 * Claims a webhook delivery so that retries and concurrent deliveries forward a message
 * once. Returns the row id to work on, or an outcome to answer with right away.
 */
async function claim(db: D1Database, messageId: string, aliasAddress: string): Promise<{ id: string } | ForwardOutcome> {
	const timestamp = now();
	const id = newId("fw");
	const inserted = await db
		.prepare(
			"INSERT INTO forwards (id, inbound_id, alias_address, status, attempts, created_at, updated_at) VALUES (?, ?, ?, 'processing', 1, ?, ?) ON CONFLICT (inbound_id) DO NOTHING",
		)
		.bind(id, messageId, aliasAddress, timestamp, timestamp)
		.run();
	if (inserted.meta.changes > 0) return { id };

	const existing = await db.prepare("SELECT * FROM forwards WHERE inbound_id = ?").bind(messageId).first<ForwardRow>();
	if (!existing) return { status: 409, result: "busy" };
	if (existing.status === "sent" || existing.status === "skipped") return { status: 200, result: `duplicate (${existing.status})` };
	if (existing.status === "failed" && (existing.attempts ?? 0) >= MAX_ATTEMPTS) return { status: 200, result: `gave up after ${MAX_ATTEMPTS} attempts` };
	const reclaimed = await db
		.prepare(
			"UPDATE forwards SET status = 'processing', error = NULL, attempts = attempts + 1, updated_at = ? WHERE id = ? AND (status = 'failed' OR (status = 'processing' AND updated_at < ?))",
		)
		.bind(timestamp, existing.id, timestamp - STALE_PROCESSING_SECONDS)
		.run();
	if (reclaimed.meta.changes > 0) return { id: existing.id };
	// Another delivery is working on it; Mailflare retries later and finds it sent.
	return { status: 409, result: "in progress" };
}

async function finish(db: D1Database, id: string, fields: Partial<ForwardRow>): Promise<void> {
	const entries = Object.entries({ ...fields, updated_at: now() });
	await db
		.prepare(`UPDATE forwards SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE id = ?`)
		.bind(...entries.map(([, value]) => value ?? null), id)
		.run();
}

function headerValue(email: Email, name: string): string | null {
	const lower = name.toLowerCase();
	return email.headers.find((header) => header.key.toLowerCase() === lower)?.value ?? null;
}

/** Keeps only https and mailto entries of a List-Unsubscribe header. */
export function usableUnsubscribe(value: string | null): string | null {
	if (!value) return null;
	const uris = (value.match(/<[^<>]+>/g) ?? []).filter((uri) => /^<(https:|mailto:)/i.test(uri));
	return uris.length ? uris.join(", ") : null;
}

/**
 * Bulk mail, as Firefox Relay's "block promotions" sees it: anything sent to a list.
 * Receipts and other one-to-one mail rarely carry these headers.
 */
export function isPromotional(headers: { key: string; value: string }[]): boolean {
	return headers.some(({ key, value }) => {
		const name = key.toLowerCase();
		if (name === "list-unsubscribe" || name === "list-id") return true;
		return name === "precedence" && /^(bulk|list|junk)$/i.test(value.trim());
	});
}

/**
 * True only when Cloudflare checked the message and DMARC explicitly failed. The header is
 * split like the reply check splits it, so quoted text, comments and look-alike hosts
 * (mx.cloudflare.net.example) are not read as Cloudflare's verdict.
 */
export function dmarcFailedAtCloudflare(authResults: string | null): boolean {
	if (!authResults) return false;
	const [authserv, ...results] = authResultClauses(authResults);
	if (authserv?.split(/\s+/)[0]?.toLowerCase() !== "mx.cloudflare.net") return false;
	return results.some((result) => /^dmarc\s*=\s*fail\b/i.test(result));
}

/** The header block, or null when it does not end within 64 KiB (then nothing in it is trusted). */
function rawHeaderSection(raw: ArrayBuffer): string | null {
	const head = new TextDecoder().decode(new Uint8Array(raw).subarray(0, 65536));
	const end = head.search(/\r?\n\r?\n/);
	return end >= 0 ? head.slice(0, end) : null;
}

/** Forwards one message Mailflare received (its message.inbound webhook) to the alias's destination. */
export async function handleInbound(env: Env, config: AppConfig, event: InboundEvent, origin: string): Promise<ForwardOutcome> {
	const aliasAddress = event.to ? extractEmail(event.to) : null;
	if (!event.messageId || !aliasAddress) return { status: 400, result: "missing messageId or recipient" };
	const outcome = await forwardMessage(env, config, {
		key: event.messageId,
		aliasAddress,
		envelopeFrom: event.from,
		origin,
		load: () => getStoredMessage(mailflareConfig(config), event.messageId),
		// A signed webhook could be replayed later, after the alias exists: record the delivery
		// even when there is no such alias, so a replay is a duplicate.
		claimUnknown: true,
	});
	// Mailflare has already accepted the message; there is nothing to refuse, and nothing to retry.
	if (outcome.status === 404) return { status: 200, result: "skipped: no such alias" };
	return outcome.status === 413 ? { status: 200, result: outcome.result } : outcome;
}

/** Reads a message stream up to MAX_MESSAGE_BYTES. */
async function readRaw(stream: ReadableStream<Uint8Array>, declared: number): Promise<ArrayBuffer> {
	if (declared > MAX_MESSAGE_BYTES) {
		await stream.cancel().catch(() => undefined);
		throw new MailflareError(`The message is ${declared} bytes; at most ${MAX_MESSAGE_BYTES} are forwarded`, 413);
	}
	const bytes = await readLimited(stream, MAX_MESSAGE_BYTES);
	if (!bytes) throw new MailflareError(`The message is larger than ${MAX_MESSAGE_BYTES} bytes`, 413);
	return bytes.buffer as ArrayBuffer;
}

/**
 * Forwards a message Cloudflare Email Routing delivered to this Worker (the catch-all of an
 * alias domain). Email Routing does not redeliver an accepted message, so the key only has to
 * tell retries of a failed delivery apart: the Message-ID with the recipient.
 */
export async function handleDirectInbound(message: ForwardableEmailMessage, env: Env, config: AppConfig): Promise<ForwardOutcome> {
	const aliasAddress = normalizeEmail(message.to);
	const messageId = message.headers.get("Message-ID")?.trim();
	// A retry of the same delivery has the same Message-ID, recipient, envelope sender, Date
	// and size. Someone else reusing a Message-ID they saw cannot match all of them, so they
	// cannot get a real message dropped as a duplicate.
	const parts = messageId
		? [messageId, aliasAddress, normalizeEmail(message.from ?? ""), message.headers.get("Date")?.trim() ?? "", String(message.rawSize)]
		: [crypto.randomUUID()];
	const key = `cf:${await sha256Hex(parts.join("\n"))}`;
	return forwardMessage(env, config, {
		key,
		aliasAddress,
		envelopeFrom: message.from,
		origin: config.siteOrigin,
		load: async () => ({ mailboxId: "", raw: await readRaw(message.raw, message.rawSize) }),
		size: message.rawSize,
		headers: message.headers,
		// Email Routing's own forward: no parsing, so no CPU, but the message goes as it is.
		passThrough: async (destination) => {
			await message.forward(destination, new Headers({ [LOOP_HEADER]: aliasAddress }));
		},
	});
}

/**
 * On the Workers Free plan a request has 10 ms of CPU. Reading a message and rewriting it
 * takes about 1 ms per 70 KB, so a larger message is passed through unchanged instead.
 */
export const FREE_PLAN_REWRITE_BYTES = 512 * 1024;

type ForwardInput = {
	/** Identifies the delivery, so the same message is forwarded once. */
	key: string;
	aliasAddress: string;
	envelopeFrom?: string;
	/** Origin of the links in the banner and the unsubscribe header. */
	origin: string;
	load: () => Promise<StoredMessage>;
	/** Declared size of the message, when known before it is read. */
	size?: number;
	/** Record a delivery to an address that is not an alias (and will not become one). */
	claimUnknown?: boolean;
	/** The message's headers, when they are known before it is read. */
	headers?: Headers;
	/** Delivers the message unchanged, when it is too large to rewrite on the Free plan. */
	passThrough?: (destination: string) => Promise<void>;
};

async function forwardMessage(env: Env, config: AppConfig, input: ForwardInput): Promise<ForwardOutcome> {
	const db = env.DB;
	const { aliasAddress, origin } = input;
	const event = { messageId: input.key, from: input.envelopeFrom };
	const aliasDomain = domainOf(aliasAddress);
	const reverseDomain = reverseDomainFor(aliasDomain);

	// Mail to an address that is not an alias yet creates one only when that is turned on.
	// Otherwise it is refused before anything is written, so mail to made-up addresses
	// leaves no rows behind.
	const settings = await loadSettings(db);
	const known = await getAlias(db, aliasAddress);
	const unknown = !known && !settings.createAliasesFromMail;
	if (unknown && !input.claimUnknown) return { status: 404, result: "no such alias" };

	const claimed = await claim(db, input.key, aliasAddress);
	if (!("id" in claimed)) return claimed;
	const forwardId = claimed.id;
	const skip = async (reason: string): Promise<ForwardOutcome> => {
		await finish(db, forwardId, { status: "skipped", error: reason });
		return { status: 200, result: `skipped: ${reason}` };
	};
	if (unknown) {
		await finish(db, forwardId, { status: "skipped", error: "no such alias" });
		return { status: 404, result: "no such alias" };
	}

	try {
		if (isReverseDomainOf(aliasDomain, settings.aliasDomains)) return await skip("the recipient is a reverse alias");
		// A known alias that is deleted or off needs nothing from Mailflare: skip before downloading.
		if (known?.deleted_at) return await skip("the alias was deleted");
		if (known?.forward_mode === "none") return await skip("forwarding is off for this alias");
		// A copy this Worker sent itself is recognised from its headers, before it is read.
		if (input.headers?.get(LOOP_HEADER)) return await skip("already forwarded by this Worker");
		const passThrough = config.workersPlan === "free" && input.passThrough && (input.size ?? 0) > FREE_PLAN_REWRITE_BYTES ? input.passThrough : null;
		const stored = passThrough ? null : await input.load();
		const alias = await ensureAlias(db, aliasAddress, stored?.mailboxId ?? "", {
			forwardEnabled: settings.autoForwardNewAliases,
			destination: settings.defaultDestination || null,
		});
		const destination = alias.destination || settings.defaultDestination;
		if (alias.deleted_at) return await skip("the alias was deleted");
		if (alias.forward_mode === "none") return await skip("forwarding is off for this alias");
		if (!destination) return await skip("no forwarding address");
		if (isOwnAddress(destination, [...settings.aliasDomains, aliasDomain])) return await skip("destination would loop");

		if (passThrough) {
			// The body is not read, but the headers are: the same filters run on the envelope
			// sender and the From header as on a rewritten message.
			const headers = input.headers ?? new Headers();
			const senders = [...new Set([parseBareEmail(event.from), extractEmail(headers.get("From") ?? "")].filter((value): value is string => !!value))];
			if (!senders.length || senders.some((sender) => isReverseDomainOf(domainOf(sender), [...settings.aliasDomains, aliasDomain]))) return await skip("no usable sender");
			for (const sender of senders) {
				const blocked = await matchBlocklist(db, sender);
				if (blocked) return await skip(`blocklist: ${blocked.value}`);
			}
			const { results: known } = await db
				.prepare(`SELECT email, blocked, destination FROM contacts WHERE alias_address = ? AND email IN (${senders.map(() => "?").join(", ")})`)
				.bind(aliasAddress, ...senders)
				.all<{ email: string; blocked: number; destination: string | null }>();
			if (known.some((contact) => contact.blocked)) return await skip("sender is blocked");
			// The From header's contact first: that is the sender the user sees.
			const redirect = (known.find((contact) => contact.email === senders[1]) ?? known[0])?.destination;
			const target = redirect && !isOwnAddress(redirect, [...settings.aliasDomains, aliasDomain]) ? redirect : destination;
			if (alias.forward_mode === "no_promotions" && isPromotional([...headers].map(([key, value]) => ({ key, value })))) {
				return await skip("promotional mail is blocked for this alias");
			}
			await passThrough(target);
			const sentAt = now();
			try {
				await db.batch([
					db
						.prepare("UPDATE forwards SET status = 'sent', error = ?, updated_at = ? WHERE id = ?")
						.bind(`passed through unchanged: larger than ${FREE_PLAN_REWRITE_BYTES / 1024} KB on the Workers Free plan, so replies to it do not go through the alias`, sentAt, forwardId),
					db.prepare("UPDATE aliases SET last_used_at = ? WHERE address = ?").bind(sentAt, aliasAddress),
				]);
			} catch (error) {
				console.error("Passed through, but recording it failed", event.messageId, error instanceof Error ? error.message : error);
			}
			return { status: 200, result: "passed through" };
		}

		const email = await PostalMime.parse(stored!.raw, { attachmentEncoding: "arraybuffer" });
		if (headerValue(email, LOOP_HEADER)) return await skip("already forwarded by this Worker");

		// The parsed From address must itself be one plain address. One that is not (a quoted
		// local part hiding another address, say) is not trusted: the envelope sender stands in,
		// and the message is marked as from an unverified sender.
		const headerSender = parseBareEmail(email.from?.address);
		const malformedFrom = !!email.from?.address && !headerSender;
		const senderEmail = headerSender ?? parseBareEmail(event.from);
		if (!senderEmail || isReverseDomainOf(domainOf(senderEmail), [...settings.aliasDomains, aliasDomain])) return await skip("no usable sender");
		const headerBlock = rawHeaderSection(stored!.raw);
		const spoofed = malformedFrom || headerBlock === null || dmarcFailedAtCloudflare(firstAuthenticationResults(headerBlock));
		await finish(db, forwardId, {
			original_message_id: ensureAngle(email.messageId),
			// The unsubscribe of a sender that failed DMARC is not trusted: unsubscribing blocks it instead.
			original_unsubscribe: spoofed ? null : (usableUnsubscribe(headerValue(email, "List-Unsubscribe"))?.slice(0, MAX_UNSUBSCRIBE_LENGTH) ?? null),
			original_unsubscribe_post: /^\s*List-Unsubscribe=One-Click\s*$/i.test(headerValue(email, "List-Unsubscribe-Post") ?? "") ? 1 : 0,
			subject: email.subject?.slice(0, 500) ?? null,
		});
		// Filters run before a contact is made, so a blocked sender gets no reverse alias. The
		// envelope sender is checked too: the From header alone is the sender's to choose.
		const envelopeSender = parseBareEmail(event.from);
		for (const candidate of new Set([senderEmail, envelopeSender].filter((value): value is string => !!value))) {
			const blocked = await matchBlocklist(db, candidate);
			if (blocked) return await skip(`blocklist: ${blocked.value}`);
		}
		if (alias.forward_mode === "no_promotions" && isPromotional(email.headers)) return await skip("promotional mail is blocked for this alias");
		if (email.attachments.length > MAX_ATTACHMENTS) return await skip(`${email.attachments.length} attachments (at most ${MAX_ATTACHMENTS})`);

		// A display name from a message that failed DMARC is not trusted to rename a contact.
		const senderName = spoofed ? null : email.from?.name?.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, MAX_NAME_LENGTH) || null;
		const contact = await ensureContact(db, aliasAddress, senderEmail, senderName, settings.includeSenderInReverseAlias);
		await finish(db, forwardId, { contact_id: contact.id });
		if (contact.blocked) return await skip("sender is blocked");
		// A sender can have an address of its own (set by an unsubscribe, say).
		const recipient = contact.destination && !isOwnAddress(contact.destination, [...settings.aliasDomains, aliasDomain]) ? contact.destination : destination;

		// Thread forwarded copies together: point at the copies the user's client already has.
		const parentIds = [...parseMessageIds(email.inReplyTo), ...parseMessageIds(email.references).slice(-MAX_REFERENCES)];
		const toForwarded = await mapOriginalToForwarded(db, aliasAddress, parentIds);
		const inReplyTo = parseMessageIds(email.inReplyTo).map((id) => toForwarded.get(id) ?? id)[0];
		const references = parseMessageIds(email.references)
			.map((id) => toForwarded.get(id) ?? id)
			.slice(-MAX_REFERENCES);

		const sign = (purpose: string, payload: string) => signToken(config.signingSecret, purpose, payload, LINK_TTL_SECONDS);
		// Without a known origin there is nowhere for the banner's links to point.
		const banner: BannerInfo | null = settings.showBanner && origin
			? {
					alias: aliasAddress,
					sender: contact.name ? `${sanitizeDisplayName(contact.name)} <${contact.email}>` : contact.email,
					blockUrl: `${origin}/action/${await sign("action", `block~${forwardId}`)}`,
					disableUrl: `${origin}/action/${await sign("action", `disable~${forwardId}`)}`,
					spoofWarning: spoofed,
				}
			: null;
		const body = await transformForward(
			{ html: email.html ?? undefined, text: email.text ?? undefined },
			{ removeTrackers: settings.removeTrackers, banner, t: translator(settings.language) },
		);

		const reverseAddress = reverseAddressOf(contact.reverse_local, reverseDomain);
		const displayName = formatSenderName(settings.senderFormat, contact.name, contact.email);
		const headers: Record<string, string> = {
			[LOOP_HEADER]: aliasAddress,
			"X-Original-To": aliasAddress,
		};
		// A relative unsubscribe link would be useless; leave the header out until the origin is known.
		if (origin) {
			headers["List-Unsubscribe"] = `<${origin}/unsubscribe/${await sign("unsubscribe", forwardId)}>`;
			headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
		}
		if (inReplyTo) headers["In-Reply-To"] = inReplyTo;
		if (references.length) headers.References = references.join(" ");

		// The banner can be hidden by the message's own CSS; a subject prefix cannot.
		const subject = cleanSubjectLine(email.subject) || "(no subject)";
		const result = await env.EMAIL.send({
			from: displayName ? { name: displayName, email: reverseAddress } : reverseAddress,
			// Cloudflare will not take a To header of our own, so the alias goes in the display name:
			// the message still reads as sent to the alias, and the real mailbox stays the recipient.
			to: { name: aliasAddress, email: recipient },
			replyTo: reverseAddress,
			subject: spoofed ? `${translator(settings.language)("banner.spoofSubject")} ${subject}` : subject,
			headers,
			...(body.html ? { html: body.html } : {}),
			text: body.text ?? (body.html ? undefined : ""),
			attachments: email.attachments.map((attachment, index) => {
				const { filename, type, contentId } = cleanAttachment(attachment, index);
				return attachment.disposition === "inline" && contentId
					? { disposition: "inline" as const, contentId, filename, type, content: attachment.content as ArrayBuffer }
					: { disposition: "attachment" as const, filename, type, content: attachment.content as ArrayBuffer };
			}),
		});

		// The message is out. Record that in one batch, and never report a failure from here on:
		// a retry would send it a second time.
		const sentAt = now();
		try {
			await db.batch([
				db
					.prepare("UPDATE forwards SET status = 'sent', forwarded_message_id = ?, trackers_removed = ?, updated_at = ? WHERE id = ?")
					.bind(ensureAngle(result.messageId) ?? null, body.trackersRemoved, sentAt, forwardId),
				db.prepare("UPDATE contacts SET forward_count = forward_count + 1, last_forward_at = ? WHERE id = ?").bind(sentAt, contact.id),
				db.prepare("UPDATE aliases SET last_used_at = ? WHERE address = ?").bind(sentAt, aliasAddress),
			]);
		} catch (error) {
			console.error("Forwarded, but recording it failed", event.messageId, error instanceof Error ? error.message : error);
		}
		return { status: 200, result: "forwarded" };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await finish(db, forwardId, { status: "failed", error: message.slice(0, 1000) });
		// A message Mailflare no longer has, or one too large to send, will never succeed. Too
		// large is reported as such, so mail delivered directly can be refused with a bounce.
		if (error instanceof MailflareError && (error.status === 404 || error.status === 413)) {
			await finish(db, forwardId, { status: "skipped" });
			return { status: error.status === 413 ? 413 : 200, result: `skipped: ${message.slice(0, 200)}` };
		}
		console.error("Forward failed", event.messageId, message);
		return { status: 500, result: "failed" };
	}
}
