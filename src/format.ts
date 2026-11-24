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
		.replace(/[\r\n\t]/g, " ")
		.replace(/[<>"@]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 120);
}

const RANDOM_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function randomToken(length: number): string {
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	let out = "";
	for (const byte of bytes) out += RANDOM_ALPHABET[byte % RANDOM_ALPHABET.length];
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
	const local = address.slice(0, address.lastIndexOf("@")).toLowerCase();
	if (local.startsWith(`${REVERSE_BASE}+`)) return local.slice(REVERSE_BASE.length + 1) || null;
	return local && local !== REVERSE_BASE ? local : null;
}

export function normalizeEmail(value: string): string {
	return value.trim().toLowerCase();
}

/** Extracts the bare address from `"Name" <a@b>` or `a@b`. */
export function extractEmail(value: string | null | undefined): string | null {
	if (!value) return null;
	const angle = value.match(/<([^<>\s]+@[^<>\s]+)>/);
	const candidate = angle ? angle[1] : value.trim();
	if (!candidate || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate)) return null;
	return normalizeEmail(candidate);
}

export function domainOf(email: string): string {
	return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type Replacement = { from: string; to: string };

/**
 * Replaces addresses inside a reply body, case-insensitively: each reverse alias with
 * the real correspondent address, and the user's own address with the alias. This keeps
 * the quoted "On …, X <reverse alias> wrote:" line from leaking either side.
 */
export function replaceAddresses(body: string, replacements: Replacement[]): string {
	let out = body;
	for (const { from, to } of replacements) {
		if (!from) continue;
		const pattern = new RegExp(`(?<![A-Za-z0-9._%+-])${escapeRegExp(from)}(?![A-Za-z0-9.-]*[A-Za-z0-9])`, "gi");
		out = out.replace(pattern, to);
	}
	return out;
}

/** Every address on `domain` that appears in the text, lower-cased and de-duplicated. */
export function findAddressesOnDomain(text: string, domain: string): string[] {
	const pattern = new RegExp(`[A-Za-z0-9._%+-]+@${escapeRegExp(domain)}(?![A-Za-z0-9-]|\\.[A-Za-z0-9])`, "gi");
	return [...new Set((text.match(pattern) ?? []).map(normalizeEmail))];
}

/** Message-IDs from an In-Reply-To or References header value. */
export function parseMessageIds(value: string | null | undefined): string[] {
	if (!value) return [];
	return value.match(/<[^<>\s]+>/g) ?? [];
}

export function ensureAngle(id: string | null | undefined): string | null {
	if (!id) return null;
	const trimmed = id.trim();
	if (!trimmed) return null;
	return trimmed.startsWith("<") ? trimmed : `<${trimmed}>`;
}
