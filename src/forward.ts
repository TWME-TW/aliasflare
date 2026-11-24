import PostalMime, { type Email } from "postal-mime";
import type { AppConfig } from "./config";
import { signToken } from "./crypto";
import { ensureAlias, ensureContact, mapOriginalToForwarded, matchBlocklist, newId, now, type ForwardRow } from "./db";
import { domainOf, ensureAngle, extractEmail, formatSenderName, normalizeEmail, parseMessageIds, sanitizeDisplayName } from "./format";
import { translator } from "./i18n";
import { getStoredMessage, mailflareConfig, MailflareError } from "./mailflare";
import { firstAuthenticationResults } from "./reply";
import { loadSettings } from "./settings";
import { transformForward, type BannerInfo } from "./transform";

export const LOOP_HEADER = "X-Mailflare-Alias";
const LINK_TTL_SECONDS = 60 * 60 * 24 * 365 * 2;
const STALE_PROCESSING_SECONDS = 120;
const MAX_REFERENCES = 10;

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
			"INSERT INTO forwards (id, mailflare_message_id, alias_address, status, created_at, updated_at) VALUES (?, ?, ?, 'processing', ?, ?) ON CONFLICT (mailflare_message_id) DO NOTHING",
		)
		.bind(id, messageId, aliasAddress, timestamp, timestamp)
		.run();
	if (inserted.meta.changes > 0) return { id };

	const existing = await db.prepare("SELECT * FROM forwards WHERE mailflare_message_id = ?").bind(messageId).first<ForwardRow>();
	if (!existing) return { status: 409, result: "busy" };
	if (existing.status === "sent" || existing.status === "skipped") return { status: 200, result: `duplicate (${existing.status})` };
	const reclaimed = await db
		.prepare(
			"UPDATE forwards SET status = 'processing', error = NULL, updated_at = ? WHERE id = ? AND (status = 'failed' OR (status = 'processing' AND updated_at < ?))",
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

/** True only when Cloudflare checked the message and DMARC explicitly failed. */
export function dmarcFailedAtCloudflare(authResults: string | null): boolean {
	return !!authResults && /^\s*mx\.cloudflare\.net\b/i.test(authResults) && /\bdmarc\s*=\s*fail\b/i.test(authResults);
}

function rawHeaderSection(raw: ArrayBuffer): string {
	const head = new TextDecoder().decode(new Uint8Array(raw).subarray(0, 65536));
	const end = head.search(/\r?\n\r?\n/);
	return end >= 0 ? head.slice(0, end) : head;
}

/** Forwards one message Mailflare received to the alias's destination, from a reverse alias. */
export async function handleInbound(env: Env, config: AppConfig, event: InboundEvent, origin: string): Promise<ForwardOutcome> {
	const db = env.DB;
	const reverseDomain = config.reverseDomain;
	const aliasAddress = event.to ? extractEmail(event.to) : null;
	if (!event.messageId || !aliasAddress) return { status: 400, result: "missing messageId or recipient" };
	if (domainOf(aliasAddress) === reverseDomain) return { status: 200, result: "ignored: recipient is a reverse alias" };

	const claimed = await claim(db, event.messageId, aliasAddress);
	if (!("id" in claimed)) return claimed;
	const forwardId = claimed.id;
	const skip = async (reason: string): Promise<ForwardOutcome> => {
		await finish(db, forwardId, { status: "skipped", error: reason });
		return { status: 200, result: `skipped: ${reason}` };
	};

	try {
		const settings = await loadSettings(db);
		const stored = await getStoredMessage(mailflareConfig(config), event.messageId);
		const alias = await ensureAlias(db, aliasAddress, stored.mailboxId, {
			forwardEnabled: settings.autoForwardNewAliases,
			destination: settings.defaultDestination || null,
		});
		const destination = alias.destination || settings.defaultDestination;
		if (alias.forward_mode === "none") return await skip("forwarding is off for this alias");
		if (!destination) return await skip("no forwarding address");
		if (domainOf(destination) === reverseDomain || normalizeEmail(destination) === aliasAddress) return await skip("destination would loop");

		const email = await PostalMime.parse(stored.raw, { attachmentEncoding: "arraybuffer" });
		if (headerValue(email, LOOP_HEADER)) return await skip("already forwarded by this Worker");

		const senderEmail = extractEmail(email.from?.address ?? event.from ?? null);
		if (!senderEmail || domainOf(senderEmail) === reverseDomain) return await skip("no usable sender");
		const contact = await ensureContact(db, aliasAddress, senderEmail, email.from?.name || null, settings.includeSenderInReverseAlias);
		await finish(db, forwardId, {
			contact_id: contact.id,
			original_message_id: ensureAngle(email.messageId),
			original_unsubscribe: usableUnsubscribe(headerValue(email, "List-Unsubscribe")),
			original_unsubscribe_post: /^\s*List-Unsubscribe=One-Click\s*$/i.test(headerValue(email, "List-Unsubscribe-Post") ?? "") ? 1 : 0,
			subject: email.subject?.slice(0, 500) ?? null,
		});
		if (contact.blocked) return await skip("sender is blocked");
		const blocked = await matchBlocklist(db, senderEmail);
		if (blocked) return await skip(`blocklist: ${blocked.value}`);
		if (alias.forward_mode === "no_promotions" && isPromotional(email.headers)) return await skip("promotional mail is blocked for this alias");

		// Thread forwarded copies together: point at the copies the user's client already has.
		const parentIds = [...parseMessageIds(email.inReplyTo), ...parseMessageIds(email.references)];
		const toForwarded = await mapOriginalToForwarded(db, parentIds);
		const inReplyTo = parseMessageIds(email.inReplyTo).map((id) => toForwarded.get(id) ?? id)[0];
		const references = parseMessageIds(email.references)
			.map((id) => toForwarded.get(id) ?? id)
			.slice(-MAX_REFERENCES);

		const sign = (purpose: string, payload: string) => signToken(config.signingSecret, purpose, payload, LINK_TTL_SECONDS);
		const banner: BannerInfo | null = settings.showBanner
			? {
					alias: aliasAddress,
					sender: contact.name ? `${sanitizeDisplayName(contact.name)} <${contact.email}>` : contact.email,
					blockUrl: `${origin}/action/${await sign("action", `block~${forwardId}`)}`,
					disableUrl: `${origin}/action/${await sign("action", `disable~${forwardId}`)}`,
					spoofWarning: dmarcFailedAtCloudflare(firstAuthenticationResults(rawHeaderSection(stored.raw))),
				}
			: null;
		const body = await transformForward(
			{ html: email.html ?? undefined, text: email.text ?? undefined },
			{ removeTrackers: settings.removeTrackers, banner, t: translator(settings.language) },
		);

		const reverseAddress = `${contact.reverse_local}@${reverseDomain}`;
		const displayName = formatSenderName(settings.senderFormat, contact.name, contact.email);
		const headers: Record<string, string> = {
			"List-Unsubscribe": `<${origin}/unsubscribe/${await sign("unsubscribe", forwardId)}>`,
			"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
			[LOOP_HEADER]: aliasAddress,
		};
		if (inReplyTo) headers["In-Reply-To"] = inReplyTo;
		if (references.length) headers.References = references.join(" ");

		const result = await env.EMAIL.send({
			from: displayName ? { name: displayName, email: reverseAddress } : reverseAddress,
			to: destination,
			replyTo: reverseAddress,
			subject: email.subject?.trim() || "(no subject)",
			headers,
			...(body.html ? { html: body.html } : {}),
			text: body.text ?? (body.html ? undefined : ""),
			attachments: email.attachments.map((attachment, index) => {
				const filename = attachment.filename || `attachment-${index + 1}`;
				const type = attachment.mimeType || "application/octet-stream";
				const contentId = attachment.contentId?.replace(/^<|>$/g, "");
				return attachment.disposition === "inline" && contentId
					? { disposition: "inline" as const, contentId, filename, type, content: attachment.content as ArrayBuffer }
					: { disposition: "attachment" as const, filename, type, content: attachment.content as ArrayBuffer };
			}),
		});

		await finish(db, forwardId, {
			status: "sent",
			forwarded_message_id: ensureAngle(result.messageId),
			trackers_removed: body.trackersRemoved,
		});
		await db.prepare("UPDATE contacts SET forward_count = forward_count + 1, last_forward_at = ? WHERE id = ?").bind(now(), contact.id).run();
		return { status: 200, result: "forwarded" };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await finish(db, forwardId, { status: "failed", error: message.slice(0, 1000) });
		// A message Mailflare no longer has will never succeed; anything else is worth a retry.
		if (error instanceof MailflareError && error.status === 404) return { status: 200, result: "failed: message not found" };
		console.error("Forward failed", event.messageId, message);
		return { status: 500, result: "failed" };
	}
}
