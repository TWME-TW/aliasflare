import PostalMime, { addressParser, type Email } from "postal-mime";
import { ownHosts, type AppConfig } from "./config";
import { signToken } from "./crypto";
import { CATCH_ALL_NOTE, ensureAlias, ensureContact, mapOriginalToForwarded, matchBlocklist, newId, now, type AliasRow, type ForwardRow } from "./db";
import { cleanAttachment, domainOf, ensureAngle, extractEmail, cleanSubjectLine, formatSenderName, parseBareEmail, normalizeEmail, parseMessageIds, reverseAddress as reverseAddressOf, sanitizeDisplayName } from "./format";
import { loadLocale, translator } from "./i18n";
import { getStoredMessage, mailflareConfig, MailflareError, MAX_MESSAGE_BYTES, type StoredMessage } from "./mailflare";
import { sha256Hex } from "./apikeys";
import { isOwnAddress, isReverseDomainOf, reverseDomainFor } from "./domains";
import { LINK_TTL_SECONDS } from "./unsubscribe";
import { authResultClauses, firstAuthenticationResults, hasSingleFromHeader } from "./reply";
import { createsAliasesFromMail, settingsFromRows } from "./settings";
import { readLimited } from "./streams";
import { calendarOrganizers, carriesAddresses, rewriteAttachment } from "./attachments";
import type { Replacement } from "./format";
import { callWebhooks, runRules } from "./rules";
import { anyPgpKeyFor, isPgpKeyAttachment, isPgpSignatureAttachment, sendEncrypted, sendInlineEncrypted, sendKept } from "./pgp";
import { pgpKind, topEntity } from "./mime";
import { getDomainRow, matchesSafeRegex } from "./domain-settings";
import { effectiveAliasDestinations, recipientPolicy } from "./recipients";
import { listLabels, toggleAliasLabels } from "./labels";

/**
 * RFC 4880 ASCII-armored OpenPGP message: optional standard armor headers, a blank line, strictly
 * Base64 lines, an optional CRC24 checksum line, and the matching END marker. Its first decoded
 * byte must also be a valid OpenPGP encrypted-message packet header (PKESK/SKESK/SED/SEIPD), so
 * neither plain words nor two blocks sandwiching readable text can switch the owner's encryption off.
 */
const INLINE_PGP_ARMOR =
	/^-----BEGIN PGP MESSAGE-----\r?\n(?:(?:Version|Comment|Charset|MessageID|Hash):[ \t][^\r\n]{0,200}\r?\n){0,8}\r?\n((?:[A-Za-z0-9+/]+[ \t]*\r?\n)*[A-Za-z0-9+/]+={0,2}[ \t]*\r?\n)(?:=[A-Za-z0-9+/]{4}[ \t]*\r?\n)?-----END PGP MESSAGE-----$/;

/** OpenPGP leading packet header bytes for encrypted messages (tags 1, 3, 9, 18; old and new formats). */
const ENCRYPTED_PACKET_TAGS = new Set([1, 3, 9, 18]);

export function isInlinePgpArmor(text: string): boolean {
	const match = INLINE_PGP_ARMOR.exec(text.trim());
	if (!match) return false;
	const b64 = match[1]!.replace(/\s+/g, "");
	if (b64.length < 4) return false;
	let firstByte: number;
	try {
		firstByte = atob(b64.slice(0, 4)).charCodeAt(0);
	} catch {
		return false;
	}
	if ((firstByte & 0x80) === 0) return false;
	const tag = (firstByte & 0x40) !== 0 ? firstByte & 0x3f : (firstByte >> 2) & 0x0f;
	return ENCRYPTED_PACKET_TAGS.has(tag);
}

/**
 * True only when a parsed `multipart/encrypted` message actually holds an RFC 3156 PGP/MIME
 * payload: no readable text/HTML parts, and strictly the version identification part plus an
 * armored PGP message part. Prevents a spoofed `Content-Type: multipart/encrypted` header around
 * plaintext from turning the owner's encryption off.
 */
function isValidPgpMimeEncrypted(email: Email): boolean {
	if (email.html || email.text || email.attachments.length !== 2) return false;
	const version = email.attachments.find((part) => part.mimeType?.trim().toLowerCase() === "application/pgp-encrypted");
	const payload = email.attachments.find((part) => part !== version && part.mimeType?.trim().toLowerCase() === "application/octet-stream");
	if (!version || !payload) return false;
	const decode = (content: ArrayBuffer | string) =>
		typeof content === "string" ? content : new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(new Uint8Array(content));
	if (!/^version:\s*1$/i.test(decode(version.content as ArrayBuffer | string).trim())) return false;
	return isInlinePgpArmor(decode(payload.content as ArrayBuffer | string));
}
import { listDestinations } from "./compat/aliases";
import type { Settings } from "./settings";
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
 * Claims a delivery so that retries and concurrent deliveries forward a message once, and reads
 * the alias again in the same round trip. The alias is read at the start of the message too, but
 * the owner may have turned it off, deleted it or changed its address since, and mail has to follow
 * that: the row that comes back here is the one the rest of the forwarding uses.
 */
async function claim(
	db: D1Database,
	messageId: string,
	aliasAddress: string,
): Promise<{ id: string; alias: AliasRow | null } | ForwardOutcome> {
	const timestamp = now();
	const id = newId("fw");
	const [inserted, current] = await db.batch([
		db
			.prepare("INSERT INTO forwards (id, inbound_id, alias_address, status, attempts, created_at, updated_at) VALUES (?, ?, ?, 'processing', 1, ?, ?) ON CONFLICT (inbound_id) DO NOTHING")
			.bind(id, messageId, aliasAddress, timestamp, timestamp),
		db.prepare("SELECT * FROM aliases WHERE address = ?").bind(aliasAddress),
	]);
	const alias = (current?.results?.[0] as AliasRow | undefined) ?? null;
	if ((inserted?.meta.changes ?? 0) > 0) return { id, alias };

	const existing = await db.prepare("SELECT * FROM forwards WHERE inbound_id = ?").bind(messageId).first<ForwardRow>();
	if (!existing) return { status: 409, result: "busy" };
	if (existing.status === "sent" || existing.status === "skipped") return { status: 200, result: `duplicate (${existing.status})` };
	if ((existing.status === "failed" || (existing.status === "processing" && existing.updated_at < timestamp - STALE_PROCESSING_SECONDS)) && (existing.attempts ?? 0) >= MAX_ATTEMPTS) {
		return { status: 200, result: `gave up after ${MAX_ATTEMPTS} attempts` };
	}
	const reclaimed = await db
		.prepare(
			"UPDATE forwards SET status = 'processing', error = NULL, attempts = attempts + 1, updated_at = ? WHERE id = ? AND (status = 'failed' OR (status = 'processing' AND updated_at < ?))",
		)
		.bind(timestamp, existing.id, timestamp - STALE_PROCESSING_SECONDS)
		.run();
	if (reclaimed.meta.changes > 0) return { id: existing.id, alias };
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
		return name === "precedence" && value.split(",").some((part) => /^(bulk|list|junk)$/i.test(part.trim()));
	});
}

/**
 * Takes only the first Authentication-Results header when Fetch `Headers.get()` joined multiple
 * headers with `, `. RFC 8601 forbids unquoted commas outside comments, so the first top-level
 * comma marks where a second (sender-supplied) Authentication-Results header begins.
 */
function firstHeaderValue(value: string | null): string | null {
	if (!value) return null;
	let depth = 0;
	let quoted = false;
	for (let i = 0; i < value.length; i += 1) {
		const ch = value[i]!;
		if (quoted) {
			if (ch === "\\") i += 1;
			else if (ch === '"') quoted = false;
		} else if (depth > 0) {
			if (ch === "\\") i += 1;
			else if (ch === "(") depth += 1;
			else if (ch === ")") depth -= 1;
		} else if (ch === '"') {
			quoted = true;
		} else if (ch === "(") {
			depth = 1;
		} else if (ch === ",") {
			return value.slice(0, i);
		}
	}
	return value;
}

/**
 * True only when Cloudflare checked the message and DMARC explicitly failed. The header is
 * split like the reply check splits it, so quoted text, comments and look-alike hosts
 * (mx.cloudflare.net.example) are not read as Cloudflare's verdict.
 */
export function dmarcFailedAtCloudflare(authResults: string | null): boolean {
	const first = firstHeaderValue(authResults);
	if (!first) return false;
	const [authserv, ...results] = authResultClauses(first);
	if (authserv?.split(/\s+/)[0]?.toLowerCase() !== "mx.cloudflare.net") return false;
	return results.some((result) => /^dmarc\s*=\s*(?:fail|permerror)\b/i.test(result));
}

/** The header block, or null when it does not end within 64 KiB (then nothing in it is trusted). */
function rawHeaderSection(raw: ArrayBuffer): string | null {
	const head = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(new Uint8Array(raw).subarray(0, 65536));
	const end = head.search(/\r?\n\r?\n/);
	return end >= 0 ? head.slice(0, end) : null;
}

/**
 * The message's full header section, for deciding whether mail is PGP/MIME. Unlike rawHeaderSection
 * this looks through the whole header section, however long it is, because the answer decides
 * whether the body may be rebuilt at all — and passing the whole header block lets pgpKind reject
 * duplicate Content-Type headers instead of looking only at the first.
 */
function fullHeaderSection(raw: ArrayBuffer): string | null {
	const bytes = new Uint8Array(raw);
	// Only the search for the blank line costs anything, and it stops at the header section's end.
	let end = -1;
	for (let i = 0; i < bytes.length - 1; i++) {
		if (bytes[i] !== 10) continue;
		if (bytes[i + 1] === 10 || (bytes[i + 1] === 13 && bytes[i + 2] === 10)) {
			end = i > 0 && bytes[i - 1] === 13 ? i - 1 : i;
			break;
		}
	}
	if (end < 0) return null;
	return new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes.subarray(0, end));
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
export async function handleDirectInbound(message: ForwardableEmailMessage, env: Env, config: AppConfig, preloaded?: Preloaded): Promise<ForwardOutcome> {
	const aliasAddress = normalizeEmail(message.to);
	const messageId = message.headers.get("Message-ID")?.trim();
	const date = message.headers.get("Date")?.trim() ?? "";
	// A retry of the same delivery has the same Message-ID, recipient, envelope sender, Date
	// and size. Someone else reusing a Message-ID they saw cannot match all of them, so they
	// cannot get a real message dropped as a duplicate. Without a Message-ID, Date+Subject+size
	// still caps retries of a failing delivery at MAX_ATTEMPTS.
	const parts = messageId
		? [messageId, aliasAddress, normalizeEmail(message.from ?? ""), date, String(message.rawSize)]
		: date
			? ["no-mid", aliasAddress, normalizeEmail(message.from ?? ""), date, message.headers.get("Subject")?.trim() ?? "", String(message.rawSize)]
			: [crypto.randomUUID()];
	const key = `cf:${await sha256Hex(parts.join("\n"))}`;
	return forwardMessage(env, config, {
		key,
		aliasAddress,
		envelopeFrom: message.from,
		origin: config.siteOrigin,
		load: async () => ({ mailboxId: "", raw: await readRaw(message.raw, message.rawSize) }),
		size: message.rawSize,
		preloaded,
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

/** The settings and the alias, when the caller has read them already. */
type Preloaded = { settings: Settings; known: AliasRow | null };

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
	preloaded?: Preloaded;
};

/** Aliases incoming mail may create in 24 hours; past that, mail to a new address is refused until the next day. */
export const MAX_NEW_ALIASES_FROM_MAIL_PER_DAY = 200;

async function newAliasesFromMailToday(db: D1Database): Promise<number> {
	const row = await db.prepare("SELECT COUNT(*) AS n FROM aliases WHERE note = ? AND created_at > ?").bind(CATCH_ALL_NOTE, now() - 86400).first<{ n: number }>();
	return Number(row?.n ?? 0);
}

/** The settings and the alias in one D1 round trip. */
async function loadSettingsAndAlias(db: D1Database, aliasAddress: string): Promise<Preloaded> {
	const [settings, alias] = await db.batch<Record<string, unknown>>([db.prepare("SELECT key, value FROM settings"), db.prepare("SELECT * FROM aliases WHERE address = ?").bind(aliasAddress)]);
	return { settings: settingsFromRows(settings!.results as { key: string; value: string }[]), known: (alias!.results[0] as AliasRow | undefined) ?? null };
}

async function forwardMessage(env: Env, config: AppConfig, input: ForwardInput): Promise<ForwardOutcome> {
	const db = env.DB;
	const { origin } = input;
	let aliasAddress = input.aliasAddress;
	const event = { messageId: input.key, from: input.envelopeFrom };
	const aliasDomain = domainOf(aliasAddress);
	const reverseDomain = reverseDomainFor(aliasDomain);

	// Mail to an address that is not an alias yet creates one only when that is turned on.
	// Also resolve addy.io-style +extension subaddressing to an existing base alias when present.
	const loaded = input.preloaded ?? (await loadSettingsAndAlias(db, aliasAddress));
	const settings = loaded.settings;
	let known = loaded.known;
	let extension: string | null = null;
	if (!known) {
		const local = aliasAddress.slice(0, aliasAddress.lastIndexOf("@"));
		const plus = local.indexOf("+");
		if (plus > 0 && plus < local.length - 1) {
			const baseAddress = `${local.slice(0, plus)}@${aliasDomain}`;
			const baseAlias = await db.prepare("SELECT * FROM aliases WHERE address = ?").bind(baseAddress).first<AliasRow>();
			if (baseAlias && !baseAlias.deleted_at) {
				known = baseAlias;
				aliasAddress = baseAddress;
				extension = local.slice(plus + 1);
			}
		}
	}
	const domainRow = await getDomainRow(db, aliasDomain);
	if (domainRow && domainRow.active === 0) {
		const claimedInactive = await claim(db, input.key, aliasAddress);
		if (!("id" in claimedInactive)) return claimedInactive;
		await finish(db, claimedInactive.id, { status: "skipped", error: "this domain is deactivated" });
		return { status: 200, result: "skipped: this domain is deactivated" };
	}
	const localPart = aliasAddress.slice(0, aliasAddress.lastIndexOf("@"));
	const regexBlocked = !known && !!domainRow?.auto_create_regex && !matchesSafeRegex(domainRow.auto_create_regex, localPart);
	// Only on an alias domain (Mailflare may receive for others), and not without end: mail to
	// thousands of made-up addresses would otherwise make thousands of aliases.
	const unknown =
		!known &&
		(regexBlocked || !createsAliasesFromMail(settings, aliasDomain) || (await newAliasesFromMailToday(db)) >= MAX_NEW_ALIASES_FROM_MAIL_PER_DAY);
	if (unknown && !input.claimUnknown) return { status: 404, result: "no such alias" };

	const claimed = await claim(db, input.key, aliasAddress);
	if (!("id" in claimed)) return claimed;
	const forwardId = claimed.id;
	// What the alias is now, not what it was when the message arrived: the owner may have turned it
	// off, deleted it or changed where it forwards in between, and the message follows the row.
	const current = claimed.alias;
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
		// It was there when the message arrived and has been removed for good since (Forget): the
		// owner wants it gone, so it is not made again from this message.
		if (known && !current) return await skip("the alias was deleted");
		// A known alias that is deleted or off needs nothing from Mailflare: skip before downloading.
		if (current?.deleted_at) return await skip("the alias was deleted");
		if (current?.forward_mode === "none") return await skip("forwarding is off for this alias");
		// A copy this Worker sent itself is recognised from its headers, before it is read.
		if (input.headers?.get(LOOP_HEADER)) return await skip("already forwarded by this Worker");
		// Mail is passed through unchanged in receive-only mode, and on the Free plan when it is too
		// large to rewrite in 10 ms of CPU. Only mail from Email Routing can be: Mailflare's is not ours to pass on.
		const direct = settings.forwardMethod === "direct";
		const tooLarge = config.workersPlan === "free" && (input.size ?? 0) > FREE_PLAN_REWRITE_BYTES;
		const passThrough = input.passThrough && (direct || tooLarge) ? input.passThrough : null;
		let stored = passThrough ? null : await input.load();
		// No address of its own: the alias follows its domain's default, or the account default.
		const alias = await ensureAlias(db, aliasAddress, stored?.mailboxId ?? "", { forwardEnabled: settings.autoForwardNewAliases }, current);
		const aliasTargets = (await effectiveAliasDestinations(db, alias, settings, domainRow?.default_recipient)).filter(
			(addr) => !isOwnAddress(addr, [...settings.aliasDomains, aliasDomain]),
		);
		const destination = aliasTargets[0] ?? "";
		if (alias.deleted_at) return await skip("the alias was deleted");
		if (alias.forward_mode === "none") return await skip("forwarding is off for this alias");
		if (!destination) {
			const rawDest = alias.destination || domainRow?.default_recipient || settings.defaultDestination;
			if (rawDest && isOwnAddress(rawDest, [...settings.aliasDomains, aliasDomain])) return await skip("destination would loop");
			return await skip("no forwarding address");
		}

		if (passThrough) {
			// The body is not read, but the headers are: the same filters run on the envelope
			// sender and every address in the From header as on a rewritten message.
			const headers = input.headers ?? new Headers();
			const envelopeSender = parseBareEmail(event.from);
			const rawFromEntries = addressParser(headers.get("From") ?? "", { flatten: true });
			const parsedFrom = rawFromEntries
				.map((entry) => parseBareEmail(entry.address))
				.filter((value): value is string => !!value);
			if (parsedFrom.length > 20) return await skip("too many From addresses");
			const senders = [...new Set([envelopeSender, ...parsedFrom].filter((value): value is string => !!value))];
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
			const primarySender = parsedFrom[0] ?? envelopeSender!;
			const redirect = (known.find((contact) => contact.email === primarySender) ?? known[0])?.destination;
			if (alias.forward_mode === "no_promotions" && isPromotional([...headers].map(([key, value]) => ({ key, value })))) {
				return await skip("promotional mail is blocked for this alias");
			}
			// The message is passed on unchanged, so of a rule's actions only Block and Forward to act on it.
			const passSpoofed = rawFromEntries.length !== 1 || parsedFrom.length !== 1 || dmarcFailedAtCloudflare(headers.get("Authentication-Results"));
			const ruleSubject = await decodedSubject(headers.get("Subject"));
			const rules = await runRules(db, "forwards", {
				sender: primarySender,
				senders,
				envelopeSender,
				displayFrom: rawFromEntries[0]?.name ?? null,
				spoofed: passSpoofed,
				subject: ruleSubject,
				alias: aliasAddress,
				aliasDescription: alias.note,
				recipient: destination,
				extension,
			});
			await callWebhooks(config.signingSecret, rules.webhooks, { alias: aliasAddress, sender: primarySender, subject: ruleSubject }, ownHosts(config));
			if (rules.block) return await skip(`blocked by the rule ${rules.block}`);
			if (rules.aliasDescription) {
				await db.prepare("UPDATE aliases SET note = ?, updated_at = ? WHERE address = ?").bind(rules.aliasDescription, now(), aliasAddress).run();
			}
			if (rules.addLabels?.length) {
				await attachRuleLabels(db, aliasAddress, rules.addLabels);
			}
			const ruleTarget = await ruleTargetOf(db, settings, rules.forwardTo, aliasDomain);
			const target = ruleTarget ?? (redirect && !isOwnAddress(redirect, [...settings.aliasDomains, aliasDomain]) ? redirect : destination);
			const targetPolicy = await recipientPolicy(db, target);
			if (!targetPolicy.active) return await skip("recipient is deactivated");
			// The sender is kept as a contact, so it can be blocked or redirected like any other.
			// Mail to an address with encryption on is never passed on in the clear.
			// Mail that is PGP encrypted already can go as it is only once the body itself is
			// verified to be RFC 3156 PGP/MIME — never on an unverified Content-Type header alone.
			const passWantsEncryption =
				rules.encryption !== undefined ? rules.encryption : targetPolicy.shouldEncrypt || settings.pgpRecipients.includes(normalizeEmail(target));
			if (passWantsEncryption) {
				let verifiedEncrypted = false;
				if (!tooLarge && pgpKind(`Content-Type: ${headers.get("Content-Type") ?? ""}`) === "encrypted") {
					try {
						const rawLoaded = await input.load();
						const rawPgp = pgpKind(fullHeaderSection(rawLoaded.raw));
						const rawKept = rawPgp === "encrypted" ? topEntity(rawLoaded.raw) : null;
						if (rawKept) {
							const parsed = await PostalMime.parse(rawLoaded.raw, { attachmentEncoding: "arraybuffer" });
							verifiedEncrypted = isValidPgpMimeEncrypted(parsed);
						}
					} catch {
						verifiedEncrypted = false;
					}
				}
				if (!verifiedEncrypted) {
					await finish(db, forwardId, {
						status: "failed",
						error: direct
							? "not sent: this forwarding address has PGP encryption on, and receive-only mode cannot encrypt"
							: `not sent: this forwarding address has PGP encryption on, and a message larger than ${FREE_PLAN_REWRITE_BYTES / 1024} KB cannot be encrypted on the Workers Free plan`,
					});
					return { status: 200, result: "not sent: cannot encrypt" };
				}
			}
			const contact = await ensureContact(db, aliasAddress, primarySender, null, settings.includeSenderInReverseAlias);
			await passThrough(target);
			const sentAt = now();
			const why = direct
				? "forwarded unchanged (receive-only mode): replies go from your own address"
				: `passed through unchanged: larger than ${FREE_PLAN_REWRITE_BYTES / 1024} KB on the Workers Free plan, so replies to it do not go through the alias`;
			try {
				await db.batch([
					db.prepare("UPDATE forwards SET status = 'sent', error = ?, contact_id = ?, updated_at = ? WHERE id = ?").bind(why, contact.id, sentAt, forwardId),
					db.prepare("UPDATE aliases SET last_used_at = ? WHERE address = ?").bind(sentAt, aliasAddress),
					db.prepare("UPDATE contacts SET forward_count = forward_count + 1, last_forward_at = ? WHERE id = ?").bind(sentAt, contact.id),
				]);
			} catch (error) {
				console.error("Passed through, but recording it failed", event.messageId, error instanceof Error ? error.message : error);
			}
			return { status: 200, result: "passed through" };
		}

		const headerBlock = rawHeaderSection(stored!.raw);
		// PGP/MIME mail, encrypted or signed, keeps its own body: rebuilt from its parts it would
		// no longer decrypt in the owner's app, or its signature would fail. The kind is read from
		// the whole header section rather than the 64 KiB rule check, so headers the rules decline
		// to look at cannot make PGP mail look like an ordinary message.
		const pgp = pgpKind(fullHeaderSection(stored!.raw));
		const kept = pgp ? topEntity(stored!.raw) : null;
		// Without the entity there is nothing to keep, and rebuilding PGP/MIME would hand the owner
		// something their app cannot open. Refuse instead of sending a broken message.
		if (pgp && !kept) return await skip("unreadable PGP/MIME message");
		let email: Email;
		try {
			email = await PostalMime.parse(stored!.raw, { attachmentEncoding: "arraybuffer" });
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			return await skip(`unreadable message: ${detail.slice(0, 200)}`);
		} finally {
			// Drop the raw buffer before transforms and sending so GC can reclaim it.
			stored = null;
		}
		if (headerValue(email, LOOP_HEADER)) return await skip("already forwarded by this Worker");

		// The parsed From address must itself be one plain address. One that is not (a quoted
		// local part hiding another address, or multiple From addresses/headers) is not trusted:
		// the envelope sender stands in when needed, and the message is marked as unverified.
		const headerSender = parseBareEmail(email.from?.address);
		const missingOrMalformedFrom = !headerSender;
		const senderEmail = headerSender ?? parseBareEmail(event.from);
		if (!senderEmail || isReverseDomainOf(domainOf(senderEmail), [...settings.aliasDomains, aliasDomain])) return await skip("no usable sender");
		const multiFrom = headerBlock !== null && !!headerSender && !hasSingleFromHeader(headerBlock);
		const spoofed = missingOrMalformedFrom || multiFrom || headerBlock === null || dmarcFailedAtCloudflare(firstAuthenticationResults(headerBlock));
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
		if (envelopeSender && envelopeSender !== senderEmail) {
			const blockedEnvelope = await db
				.prepare("SELECT 1 FROM contacts WHERE alias_address = ? AND email = ? AND blocked = 1")
				.bind(aliasAddress, envelopeSender)
				.first();
			if (blockedEnvelope) return await skip("sender is blocked");
		}
		if (alias.forward_mode === "no_promotions" && isPromotional(email.headers)) return await skip("promotional mail is blocked for this alias");
		if (email.attachments.length > MAX_ATTACHMENTS) return await skip(`${email.attachments.length} attachments (at most ${MAX_ATTACHMENTS})`);

		// A display name from a message that failed DMARC is not trusted to rename a contact.
		const senderName = spoofed ? null : email.from?.name?.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, MAX_NAME_LENGTH) || null;
		const contact = await ensureContact(db, aliasAddress, senderEmail, senderName, settings.includeSenderInReverseAlias);
		await finish(db, forwardId, { contact_id: contact.id });
		if (contact.blocked) return await skip("sender is blocked");
		// A sender can have an address of its own (set by an unsubscribe, say).
		const ruleSenders = [senderEmail, ...(envelopeSender ? [envelopeSender] : [])];
		const rules = await runRules(db, "forwards", {
			sender: senderEmail,
			senders: ruleSenders,
			envelopeSender,
			displayFrom: senderName,
			spoofed,
			subject: email.subject ?? "",
			alias: aliasAddress,
			aliasDescription: alias.note,
			recipient: destination,
			extension,
		});
		await callWebhooks(config.signingSecret, rules.webhooks, { alias: aliasAddress, sender: senderEmail, subject: email.subject ?? "" }, ownHosts(config));
		if (rules.block) return await skip(`blocked by the rule ${rules.block}`);
		if (rules.aliasDescription) {
			await db.prepare("UPDATE aliases SET note = ?, updated_at = ? WHERE address = ?").bind(rules.aliasDescription, now(), aliasAddress).run();
		}
		if (rules.addLabels?.length) {
			await attachRuleLabels(db, aliasAddress, rules.addLabels);
		}
		// A rule's Forward to comes first, then the sender's own address, then the alias's target(s).
		const ruleRecipient = await ruleTargetOf(db, settings, rules.forwardTo, aliasDomain);
		const targetList = ruleRecipient
			? [ruleRecipient]
			: contact.destination && !isOwnAddress(contact.destination, [...settings.aliasDomains, aliasDomain])
				? [contact.destination]
				: aliasTargets;
		const policies = await Promise.all(targetList.map(async (addr) => ({ email: addr, policy: await recipientPolicy(db, addr) })));
		const activeTargets = policies.filter((item) => item.policy.active);
		if (!activeTargets.length) return await skip("recipient is deactivated");
		const primaryRecipient = activeTargets[0]!.email;

		// Thread forwarded copies together: point at the copies the user's client already has.
		const parentIds = [...parseMessageIds(email.inReplyTo), ...parseMessageIds(email.references).slice(-MAX_REFERENCES)];
		const toForwarded = await mapOriginalToForwarded(db, aliasAddress, parentIds);
		const inReplyTo = parseMessageIds(email.inReplyTo).map((id) => toForwarded.get(id) ?? id)[0];
		const references = parseMessageIds(email.references)
			.map((id) => toForwarded.get(id) ?? id)
			.slice(-MAX_REFERENCES);

		// The banner and the spoof warning are in the language set for forwarded mail.
		await loadLocale(settings.language);
		const sign = (purpose: string, payload: string) => signToken(config.signingSecret, purpose, payload, LINK_TTL_SECONDS);
		const warnInBanner = spoofed && (settings.spamWarningBehaviour === "both" || settings.spamWarningBehaviour === "banner");
		const warnInSubject = spoofed && (settings.spamWarningBehaviour === "both" || settings.spamWarningBehaviour === "subject");
		const effectiveBannerLocation =
			rules.bannerLocation === "off" && warnInBanner
				? settings.bannerLocation === "off"
					? "off"
					: settings.bannerLocation
				: (rules.bannerLocation ?? settings.bannerLocation);
		// Without a known origin there is nowhere for the banner's links to point.
		const banner: BannerInfo | null =
			effectiveBannerLocation !== "off" && origin
				? {
						alias: aliasAddress,
						sender: contact.name ? `${sanitizeDisplayName(contact.name)} <${contact.email}>` : contact.email,
						blockUrl: `${origin}/action/${await sign("action", `block~${forwardId}`)}`,
						disableUrl: `${origin}/action/${await sign("action", `disable~${forwardId}`)}`,
						spoofWarning: warnInBanner,
					}
				: null;
		// A kept body is sent as it came: no banner and no tracker removal can go into it.
		const anyKeepsSigned = kept !== null && pgp === "signed" && activeTargets.some((t) => !t.policy.removePgpSignatures);
		const needsRebuilt = !kept || (pgp === "signed" && activeTargets.some((t) => t.policy.removePgpSignatures));
		const body: { html?: string; text?: string; trackersRemoved: number } = needsRebuilt
			? await transformForward(
					{ html: email.html ?? undefined, text: email.text ?? undefined },
					{ removeTrackers: settings.removeTrackers, banner, bannerLocation: effectiveBannerLocation === "bottom" ? "bottom" : "top", t: translator(settings.language) },
				)
			: { trackersRemoved: 0 };

		const reverseAddress = reverseAddressOf(contact.reverse_local, reverseDomain);
		// A calendar client answers an invitation straight to its ORGANIZER, from the owner's real
		// mailbox. Each organizer becomes a reverse alias, so the answer comes back through here
		// like a reply (which puts the alias in place of the owner's address).
		const calendarReplacements: Replacement[] = [];
		if (needsRebuilt) {
			for (const [index, attachment] of email.attachments.entries()) {
				const { filename, type } = cleanAttachment(attachment, index);
				if (carriesAddresses(type, filename) !== "calendar") continue;
				for (const organizer of calendarOrganizers(attachment.content as ArrayBuffer).slice(0, 3)) {
					if (calendarReplacements.length >= 5 || calendarReplacements.some((r) => r.from === organizer)) continue;
					if (
						organizer === normalizeEmail(destination) ||
						activeTargets.some((t) => organizer === normalizeEmail(t.email)) ||
						isOwnAddress(organizer, [...settings.aliasDomains, aliasDomain]) ||
						isReverseDomainOf(domainOf(organizer), settings.aliasDomains) ||
						(await matchBlocklist(db, organizer))
					) {
						continue;
					}
					const organizerContact = organizer === contact.email ? contact : await ensureContact(db, aliasAddress, organizer, null, settings.includeSenderInReverseAlias);
					calendarReplacements.push({ from: organizer, to: reverseAddressOf(organizerContact.reverse_local, reverseDomain) });
				}
			}
		}
		const displayName = rules.displayFrom ? sanitizeDisplayName(rules.displayFrom) : formatSenderName(settings.senderFormat, contact.name, contact.email);
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
		const rawSubject = cleanSubjectLine(rules.subject ?? (settings.defaultEmailSubject || email.subject)) || "(no subject)";
		const finalSubject = warnInSubject ? cleanSubjectLine(`${translator(settings.language)("banner.spoofSubject")} ${rawSubject}`) : rawSubject;

		const inlinePgp = !email.html && !email.attachments.length && isInlinePgpArmor(email.text ?? "");
		const encryptedAlready = (kept !== null && pgp === "encrypted" && isValidPgpMimeEncrypted(email)) || inlinePgp;

		let firstResult: { messageId?: string } | undefined;
		for (const { email: recipient, policy } of activeTargets) {
			const stripKeys = policy.removePgpKeys;
			const stripSigs = policy.removePgpSignatures;
			const targetKept = kept && !(pgp === "signed" && stripSigs) ? kept : null;
			const filteredAttachments = (rules.removeAttachments ? [] : email.attachments).filter(
				(attachment) => !(stripKeys && isPgpKeyAttachment(attachment)) && !(stripSigs && isPgpSignatureAttachment(attachment)),
			);
			const outgoing = {
				from: displayName ? { name: displayName, email: reverseAddress } : reverseAddress,
				to: { name: aliasAddress, email: recipient },
				replyTo: reverseAddress,
				subject: finalSubject,
				headers,
				...(body.html ? { html: body.html } : {}),
				text: body.text ?? (body.html ? undefined : ""),
				attachments: filteredAttachments.map((attachment, index) => {
					const { filename, type, contentId } = cleanAttachment(attachment, index);
					const content =
						carriesAddresses(type, filename) === "calendar"
							? rewriteAttachment(attachment.content as ArrayBuffer, "calendar", calendarReplacements)
							: (attachment.content as ArrayBuffer);
					return (attachment.disposition === "inline" || attachment.related) && contentId
						? { disposition: "inline" as const, contentId, filename, type, content }
						: { disposition: "attachment" as const, filename, type, content };
				}),
			};
			const wantsEncryption =
				!encryptedAlready &&
				(rules.encryption !== undefined ? rules.encryption : policy.shouldEncrypt || settings.pgpRecipients.includes(normalizeEmail(recipient)));
			const pgpKey = wantsEncryption ? (policy.pgpKey ?? (await anyPgpKeyFor(db, recipient))) : null;
			if (wantsEncryption && !pgpKey) {
				await finish(db, forwardId, { status: "failed", error: "not sent: this forwarding address has PGP encryption on, but its key is missing" });
				return { status: 200, result: "not sent: cannot encrypt" };
			}
			const result = pgpKey
				? policy.inlineEncryption && !targetKept
					? await sendInlineEncrypted(env, outgoing, pgpKey)
					: await sendEncrypted(env, outgoing, { ...pgpKey, hide_subject: policy.protectedHeaders ? 1 : pgpKey.hide_subject }, targetKept ?? undefined)
				: targetKept
					? await sendKept(env, outgoing, targetKept)
					: await env.EMAIL.send(outgoing);
			firstResult ??= result;
		}
		const result = firstResult ?? {};
		void primaryRecipient;
		void anyKeepsSigned;

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

/**
 * Where a rule's Forward to may send: one of the owner's forwarding addresses (an alias's or the
 * default one). A rule saved before that was required, or whose address no alias uses any more,
 * falls back to the usual destination.
 */
async function ruleTargetOf(db: D1Database, settings: Settings, address: string | undefined, aliasDomain: string): Promise<string | null> {
	if (!address || isOwnAddress(address, [...settings.aliasDomains, aliasDomain])) return null;
	const known = await listDestinations(db, settings);
	return known.some((destination) => destination.email === address) ? address : null;
}

async function attachRuleLabels(db: D1Database, aliasAddress: string, targets: string[]): Promise<void> {
	const existing = await listLabels(db);
	const matchedIds: string[] = [];
	for (const raw of targets) {
		const lower = raw.trim().toLowerCase();
		const found = existing.find((l) => l.id === raw || l.name.toLowerCase() === lower);
		if (found) matchedIds.push(found.id);
	}
	if (matchedIds.length) await toggleAliasLabels(db, [aliasAddress], matchedIds, true);
}

/** A Subject header's value with its RFC 2047 encoded words decoded, as a rule should see it. */
async function decodedSubject(value: string | null): Promise<string> {
	const subject = (value ?? "").replace(/[\r\n]+/g, " ");
	if (!subject.includes("=?")) return subject;
	try {
		return (await PostalMime.parse(`Subject: ${subject}\r\n\r\n`)).subject ?? subject;
	} catch {
		return subject;
	}
}
