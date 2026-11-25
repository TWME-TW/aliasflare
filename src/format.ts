/** Pure helpers: sender formatting, reverse-alias naming and reverse-alias replacement. */

export type SenderFormat = "AT" | "A" | "NAME_ONLY" | "AT_ONLY" | "NO_NAME";

export const SENDER_FORMATS: { value: SenderFormat; label: string }[] = [
	{ value: "AT", label: "John Wick - john at wick.com" },
	{ value: "A", label: "John Wick - john(a)wick.com" },
	{ value: "NAME_ONLY", label: "John Wick" },
	{ value: "AT_ONLY", label: "john at wick.com" },
	{ value: "NO_NAME", label: "No name, only the reverse alias" },
];

export function isSenderFormat(value: unknown): value is SenderFormat {
	return SENDER_FORMATS.some((format) => format.value === value);
}

/**
 * The display name shown on a forwarded message. The address itself is always the
 * reverse alias; a real "@" never appears, so mail clients cannot mistake the name for
 * the sending address.
 */
export function formatSenderName(format: SenderFormat, name: string | null | undefined, email: string): string {
	const cleanName = sanitizeDisplayName(name);
	const at = email.replace("@", " at ");
	const a = email.replace("@", "(a)");
	switch (format) {
		case "AT":
			return cleanName ? `${cleanName} - ${at}` : at;
		case "A":
			return cleanName ? `${cleanName} - ${a}` : a;
		case "NAME_ONLY":
			return cleanName || at;
		case "AT_ONLY":
			return at;
		case "NO_NAME":
			return "";
	}
}

/** Strips characters that would let a sender spoof an address inside the display name. */
export function sanitizeDisplayName(name: string | null | undefined): string {
	if (!name) return "";
	return name
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/[<>"@]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 120)
		.replace(/[\uD800-\uDBFF]$/, "");
}

const RANDOM_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function randomToken(length: number): string {
	// Rejection sampling: bytes past the last whole multiple of the alphabet are skipped, so
	// every character is equally likely.
	const size = RANDOM_ALPHABET.length;
	const limit = 256 - (256 % size);
	let out = "";
	while (out.length < length) {
		for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
			if (byte >= limit) continue;
			out += RANDOM_ALPHABET[byte % size];
			if (out.length === length) break;
		}
	}
	return out;
}

/**
 * The local part of a new reverse alias. With `includeSender`, the correspondent's
 * address is readable in it (john_at_wick_com_x7k2p9), as SimpleLogin does; otherwise it
 * is random. The random suffix makes it unguessable either way.
 */
export function makeReverseLocal(senderEmail: string, includeSender: boolean): string {
	if (!includeSender) return `ra_${randomToken(16)}`;
	const readable = senderEmail
		.toLowerCase()
		.replace("@", "_at_")
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_|_$/g, "")
		.slice(0, 40);
	return `${readable}_${randomToken(8)}`;
}

/**
 * Reverse aliases use plus addressing: reply+<local>@<reverse domain>. Cloudflare Email Routing
 * matches them all with one rule for reply@<reverse domain>, since catch-all rules only exist on
 * apex domains and a subdomain allows at most 200 literal rules.
 */
export const REVERSE_BASE = "reply";

export function reverseAddress(reverseLocal: string, reverseDomain: string): string {
	return `${REVERSE_BASE}+${reverseLocal}@${reverseDomain}`;
}

/** The contact's reverse_local in an address on the reverse-alias domain (also the older bare form). */
export function reverseLocalOf(address: string): string | null {
	const at = address.lastIndexOf("@");
	if (at <= 0) return null;
	const local = address.slice(0, at).toLowerCase();
	if (local.startsWith(`${REVERSE_BASE}+`)) return local.slice(REVERSE_BASE.length + 1) || null;
	return local && local !== REVERSE_BASE ? local : null;
}

export function normalizeEmail(value: string): string {
	return value.trim().toLowerCase();
}

/**
 * A lower-case domain name: dotted labels ending in a top-level domain of letters, or an
 * internationalized one in its xn-- form. The one pattern for every domain this app checks.
 */
export const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

const PRIVATE_SUFFIXES = /(^|\.)(localhost|localdomain|local|internal|intranet|lan|home|corp|arpa|test|invalid|example)$/;

/** Hostname of a URL string, or null when the value is empty or malformed. */
export function hostnameOf(value: string | null | undefined): string | null {
	if (!value) return null;
	try {
		return new URL(value).hostname;
	} catch {
		return null;
	}
}

/** True when a hostname is a public domain (no IP literals, no single-label or private names, none of `blockedHosts`). */
export function isPublicHost(hostname: string, blockedHosts: string[] = []): boolean {
	const host = hostname.trim().toLowerCase().replace(/\.$/, "");
	if (!host || host.startsWith("[") || /^[\d.]+$/.test(host)) return false;
	if (!DOMAIN_PATTERN.test(host) || PRIVATE_SUFFIXES.test(host)) return false;
	if (
		blockedHosts.some((entry) => {
			const blocked = entry.trim().toLowerCase().replace(/\.$/, "");
			return !!blocked && (host === blocked || host.endsWith(`.${blocked}`));
		})
	) {
		return false;
	}
	return true;
}

/**
 * The URL when it is a public https address this Worker may call: no IP literals, no
 * internal or single-label names, no other port, no credentials, and none of this
 * service's own hosts.
 */
export function safeHttpsUrl(value: string, blockedHosts: string[] = []): URL | null {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || url.username || url.password || url.port !== "") return null;
	return isPublicHost(url.hostname, blockedHosts) ? url : null;
}

/** Strips control characters, quotes, backslashes and angle brackets from a stored display name. */
export function cleanDisplayName(value: string | null | undefined, max = 100): string | null {
	return (value ?? "").replace(/[\u0000-\u001f\u007f"<>\\]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max).replace(/[\uD800-\uDBFF]$/, "") || null;
}

/**
 * A plain address: a dot-atom local part (no quoted local part, so nothing like
 * `"<ceo@victim.com>"@attacker.com`) at a dotted host name.
 */
const BARE_ADDRESS =
	/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/** The address, lower-cased, when the whole value is one plain address; otherwise null. */
export function parseBareEmail(value: string | null | undefined): string | null {
	const candidate = value?.trim() ?? "";
	if (candidate.length > 254 || !BARE_ADDRESS.test(candidate)) return null;
	const normalized = normalizeEmail(candidate);
	return DOMAIN_PATTERN.test(domainOf(normalized)) ? normalized : null;
}

/**
 * The bare address of `a@b` or `Name <a@b>`. The angle brackets must close the value and be
 * the only ones in it, so an address hidden inside a quoted local part is never picked out.
 */
export function extractEmail(value: string | null | undefined): string | null {
	if (!value) return null;
	const bare = parseBareEmail(value);
	if (bare) return bare;
	const named = value.trim().match(/^[^<>]*<([^<>]*)>$/);
	return named ? parseBareEmail(named[1]) : null;
}

/** Drops control characters (a decoded CR or LF among them) from a subject and caps at RFC 5322 line limit. */
export function cleanSubjectLine(value: string | null | undefined): string {
	return (value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 998).replace(/[\uD800-\uDBFF]$/, "");
}

/** The longest note an alias keeps, wherever it is set (dashboard, apps or import). */
export const MAX_NOTE_LENGTH = 500;

/** A page number from a query string: a whole number from `min` to a million, else `fallback`. */
export function pageParam(value: string | null | undefined, fallback: number, min = 1): number {
	const number = Number(value);
	return value != null && value !== "" && Number.isSafeInteger(number) && number >= min && number <= 1_000_000 ? number : fallback;
}

export function domainOf(email: string): string {
	return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type Replacement = { from: string; to: string };

const ENCODED_PLUS_DECODE = /%2b|&#0*43;|&#x0*2b;|&plus;/gi;
const ENCODED_AT_DECODE = /%40|&#0*64;|&#x0*40;|&commat;/gi;

/**
 * Replaces addresses inside a reply body, case-insensitively: each reverse alias with
 * the real correspondent address, and the user's own address with the alias. This keeps
 * the quoted "On …, X <reverse alias> wrote:" line from leaking either side.
 * Combines entries into batched alternation patterns so large contact sets stay linear.
 */
export function replaceAddresses(body: string, replacements: Replacement[], options: { encodedPlus?: boolean } = {}): string {
	const map = new Map<string, string>();
	for (const { from, to } of replacements) {
		if (!from) continue;
		const key = from.toLowerCase();
		if (!map.has(key)) map.set(key, to);
	}
	if (!map.size) return body;
	const entries = [...map.keys()].sort((a, b) => b.length - a.length);
	const prefix = options.encodedPlus ? "(?:(?<![A-Za-z0-9._%+-])|(?<=%[0-9a-f]{2}))" : "(?<![A-Za-z0-9._%+-])";
	const suffix = "(?![A-Za-z0-9.-]*[A-Za-z0-9])";
	const encode = (from: string) =>
		options.encodedPlus
			? escapeRegExp(from)
					.replaceAll("\\+", "(?:\\+|%2b|&#0*43;|&#x0*2b;|&plus;)")
					.replaceAll("@", "(?:@|%40|&#0*64;|&#x0*40;|&commat;)")
			: escapeRegExp(from);
	let out = body;
	for (let i = 0; i < entries.length; i += 500) {
		const chunk = entries.slice(i, i + 500);
		const pattern = new RegExp(`${prefix}(?:${chunk.map(encode).join("|")})${suffix}`, "gi");
		out = out.replace(pattern, (matched) => {
			const normalized = (options.encodedPlus ? matched.replace(ENCODED_PLUS_DECODE, "+").replace(ENCODED_AT_DECODE, "@") : matched).toLowerCase();
			return map.get(normalized) ?? matched;
		});
	}
	return out;
}

/** Every address on `domain` that appears in the text, lower-cased and de-duplicated. */
export function findAddressesOnDomain(text: string, domain: string): string[] {
	// Remaining %XX escapes (such as mailto%3A or %3C) act as delimiters, not local-part characters.
	const cleaned = text.replace(/%[0-9a-f]{2}/gi, " ");
	// Find "@domain" (a fixed string, so linear), then walk back over the local part. A pattern
	// starting with the local part retries at every letter of a long run and takes seconds on a
	// large body. The walk stops at the previous "@", so no character is walked twice.
	const found = new Set<string>();
	const pattern = new RegExp(`@${escapeRegExp(domain)}(?![A-Za-z0-9-]|\\.[A-Za-z0-9])`, "gi");
	for (const match of cleaned.matchAll(pattern)) {
		let start = match.index;
		while (start > 0 && LOCAL_CHAR.test(cleaned[start - 1]!)) start -= 1;
		if (start < match.index) found.add(normalizeEmail(cleaned.slice(start, match.index + match[0].length)));
	}
	return [...found];
}

const LOCAL_CHAR = /[A-Za-z0-9._+-]/;

/** Message-IDs from an In-Reply-To or References header value: printable ASCII, no angle brackets, at most 250 characters each. */
export function parseMessageIds(value: string | null | undefined): string[] {
	if (!value) return [];
	return (value.match(/<[\x21-\x3b\x3d\x3f-\x7e]{1,250}>/g) ?? []);
}

const EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/bmp": "bmp",
	"image/tiff": "tif",
	"application/pdf": "pdf",
	"text/plain": "txt",
	"text/html": "html",
	"text/csv": "csv",
	"text/calendar": "ics",
	"application/zip": "zip",
};

/**
 * Name, type and Content-ID of an attachment, safe to put in headers and API calls: no
 * control characters or path separators, a well-formed media type, and a file name with an
 * extension that matches the type when the sender gave none (pasted images often have none).
 */
export function cleanAttachment(attachment: { filename?: string | null; mimeType?: string | null; contentId?: string | null }, index: number) {
	const typed = (attachment.mimeType ?? "").trim().toLowerCase();
	const type = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(typed) ? typed : "application/octet-stream";
	let filename = (attachment.filename ?? "").replace(/[\u0000-\u001f\u007f/\\]+/g, " ").trim().slice(0, 200).replace(/[\uD800-\uDBFF]$/, "");
	if (!filename) filename = `attachment-${index + 1}`;
	if (!/\.[A-Za-z0-9]{1,8}$/.test(filename) && EXTENSIONS[type]) filename = `${filename}.${EXTENSIONS[type]}`;
	const contentId = attachment.contentId?.replace(/^<|>$/g, "").replace(/[^\x21-\x7e]+/g, "").replace(/[<>]+/g, "").slice(0, 200) || undefined;
	return { filename, type, contentId };
}

export function ensureAngle(id: string | null | undefined): string | null {
	if (!id || /[\u0000-\u001f\u007f]/.test(id)) return null;
	const trimmed = id.trim();
	if (!trimmed) return null;
	const wrapped = trimmed.startsWith("<") ? trimmed : `<${trimmed}>`;
	return /^<[\x21-\x3b\x3d\x3f-\x7e]{1,250}>$/.test(wrapped) ? wrapped : null;
}
