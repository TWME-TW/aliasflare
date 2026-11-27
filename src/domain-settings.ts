/**
 * Per-domain configuration (addy.io's Custom Domains): stable UUIDs, active flag,
 * catch-all, description, default from_name, default_recipient, default_attached_recipients_only,
 * and ReDoS-safe auto_create_regex.
 */
import { now } from "./db";
import { clashingDomain, isOwnAddress } from "./domains";
import { cleanDisplayName, DOMAIN_PATTERN, MAX_NOTE_LENGTH, normalizeEmail } from "./format";
import { createsAliasesFromMail, MAX_ALIAS_DOMAINS, type Settings } from "./settings";

export const MAX_REGEX_LENGTH = 200;

export type DomainRow = {
	domain: string;
	description: string | null;
	from_name: string | null;
	default_recipient: string | null;
	active: number;
	default_attached_recipients_only: number;
	auto_create_regex: string | null;
	created_at: number;
	updated_at: number;
};

export type DomainView = {
	id: string;
	domain: string;
	description: string | null;
	fromName: string | null;
	defaultRecipient: string | null;
	aliasesCount: number;
	active: boolean;
	catchAll: boolean;
	defaultAttachedRecipientsOnly: boolean;
	autoCreateRegex: string | null;
	createdAt: number;
	updatedAt: number;
};

export class DomainError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

/** Deterministic UUIDv5-shaped ID from a domain name, stable even when aliasDomains is reordered. */
export async function domainUid(domain: string): Promise<string> {
	const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`domain:${domain.toLowerCase()}`)));
	const hex = [...bytes.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * ReDoS-safe regular expression validator for Cloudflare Workers' strict CPU budget.
 * Rejects patterns that are too long, invalid, use backreferences / lookbehind, or contain
 * nested quantifiers (e.g. (a+)+, (a*)*, ([a-z]+)*, (a|aa)+) that can cause catastrophic backtracking.
 */
export function isSafeRegex(pattern: string): boolean {
	if (!pattern || pattern.length > MAX_REGEX_LENGTH) return false;
	if (/[\u0000-\u001f\u007f]/.test(pattern)) return false;
	// Backreferences (\1..\9, \k<...>) and lookarounds can cause exponential backtracking.
	if (/\\(?:[1-9]|k<)/.test(pattern)) return false;
	if (/\(\?(?:<=|<!|=|!)/.test(pattern)) return false;
	// Track parenthesized group nesting and whether each group contains an inner quantifier or alternation.
	const stack: { hasQuantifier: boolean; hasAlternation: boolean }[] = [];
	let inClass = false;
	let groupCount = 0;
	let unboundedQuantifiers = 0;
	let lastWasQuantifier = false;
	for (let i = 0; i < pattern.length; i += 1) {
		const ch = pattern[i]!;
		if (ch === "\\") {
			i += 1;
			lastWasQuantifier = false;
			continue;
		}
		if (inClass) {
			if (ch === "]") inClass = false;
			lastWasQuantifier = false;
			continue;
		}
		if (ch === "[") {
			inClass = true;
			lastWasQuantifier = false;
			continue;
		}
		if (ch === "(") {
			groupCount += 1;
			if (groupCount > 15 || stack.length >= 6) return false;
			stack.push({ hasQuantifier: false, hasAlternation: false });
			lastWasQuantifier = false;
			continue;
		}
		if (ch === "|") {
			if (stack.length > 0) stack[stack.length - 1]!.hasAlternation = true;
			lastWasQuantifier = false;
			continue;
		}
		if (ch === ")") {
			const closed = stack.pop();
			if (!closed) return false;
			const next = pattern[i + 1];
			const followedByRepeat = next === "+" || next === "*" || next === "{";
			if (followedByRepeat && (closed.hasQuantifier || closed.hasAlternation)) return false;
			if (stack.length > 0) {
				if (closed.hasQuantifier || followedByRepeat) stack[stack.length - 1]!.hasQuantifier = true;
				if (closed.hasAlternation) stack[stack.length - 1]!.hasAlternation = true;
			}
			lastWasQuantifier = false;
			continue;
		}
		const isQuantifier = ch === "+" || ch === "*" || ch === "{";
		if (isQuantifier) {
			if (lastWasQuantifier) return false;
			let isUnbounded = ch === "+" || ch === "*";
			if (ch === "{") {
				const close = pattern.indexOf("}", i + 1);
				if (close < 0) return false;
				const inner = pattern.slice(i + 1, close);
				if (!/^\d{1,3}(?:,\d{0,3})?$/.test(inner)) return false;
				const [minStr, maxStr] = inner.split(",");
				const min = Number(minStr);
				const max = maxStr === undefined ? min : maxStr === "" ? 100 : Number(maxStr);
				if (min > 100 || max > 100 || max < min) return false;
				if (maxStr === "" || max - min > 20) isUnbounded = true;
				i = close;
			}
			if (isUnbounded) {
				unboundedQuantifiers += 1;
				if (unboundedQuantifiers > 4) return false;
			}
			if (stack.length > 0) stack[stack.length - 1]!.hasQuantifier = true;
			lastWasQuantifier = true;
			continue;
		}
		if (ch === "?") {
			lastWasQuantifier = false;
			continue;
		}
		lastWasQuantifier = false;
	}
	if (inClass || stack.length > 0) return false;
	try {
		new RegExp(pattern, "i");
		return true;
	} catch {
		return false;
	}
}

/** Tests a string (capped at 1000 chars) against a validated safe regex, case-insensitively. */
export function matchesSafeRegex(pattern: string, value: string): boolean {
	if (!isSafeRegex(pattern)) return false;
	try {
		return new RegExp(pattern, "i").test(value.slice(0, 1000));
	} catch {
		return false;
	}
}

export async function getDomainRow(db: D1Database, domain: string): Promise<DomainRow | null> {
	return db.prepare("SELECT * FROM domains WHERE domain = ?").bind(domain.toLowerCase()).first<DomainRow>();
}

export async function ensureDomainRow(db: D1Database, domain: string): Promise<DomainRow> {
	const normalized = domain.toLowerCase();
	const existing = await getDomainRow(db, normalized);
	if (existing) return existing;
	const ts = now();
	await db
		.prepare("INSERT INTO domains (domain, active, default_attached_recipients_only, created_at, updated_at) VALUES (?, 1, 0, ?, ?) ON CONFLICT (domain) DO NOTHING")
		.bind(normalized, ts, ts)
		.run();
	return (await getDomainRow(db, normalized))!;
}

/** Lists every alias domain in settings merged with its `domains` table metadata and live alias count. */
export async function listDomainConfigs(db: D1Database, settings: Settings): Promise<DomainView[]> {
	if (!settings.aliasDomains.length) return [];
	const [domainRows, aliasCounts] = await db.batch([
		db.prepare("SELECT * FROM domains"),
		db.prepare("SELECT lower(substr(address, instr(address, '@') + 1)) AS domain, COUNT(*) AS n FROM aliases WHERE deleted_at IS NULL GROUP BY domain"),
	]);
	const byDomain = new Map<string, DomainRow>();
	for (const row of (domainRows?.results ?? []) as DomainRow[]) byDomain.set(row.domain.toLowerCase(), row);
	const counts = new Map<string, number>();
	for (const row of (aliasCounts?.results ?? []) as { domain: string; n: number }[]) counts.set(row.domain, Number(row.n));

	const out: DomainView[] = [];
	for (const domain of settings.aliasDomains) {
		const row = byDomain.get(domain);
		out.push({
			id: await domainUid(domain),
			domain,
			description: row?.description ?? null,
			fromName: row?.from_name ?? null,
			defaultRecipient: row?.default_recipient ?? null,
			aliasesCount: counts.get(domain) ?? 0,
			active: row ? row.active === 1 : true,
			catchAll: createsAliasesFromMail(settings, domain),
			defaultAttachedRecipientsOnly: row ? row.default_attached_recipients_only === 1 : false,
			autoCreateRegex: row?.auto_create_regex ?? null,
			createdAt: row?.created_at ?? 946684800,
			updatedAt: row?.updated_at ?? 946684800,
		});
	}
	return out;
}

export async function findDomainById(db: D1Database, settings: Settings, id: string): Promise<DomainView | null> {
	const all = await listDomainConfigs(db, settings);
	return all.find((d) => d.id === id) ?? null;
}

export async function updateDomainConfig(
	db: D1Database,
	settings: Settings,
	id: string,
	input: { description?: string | null; fromName?: string | null; autoCreateRegex?: string | null; defaultRecipient?: string | null },
): Promise<DomainView> {
	const match = await findDomainById(db, settings, id);
	if (!match) throw new DomainError(404, "Not found");
	await ensureDomainRow(db, match.domain);
	const sets: string[] = [];
	const params: unknown[] = [];
	if (input.description !== undefined) {
		sets.push("description = ?");
		params.push(input.description === null ? null : input.description.trim().slice(0, MAX_NOTE_LENGTH) || null);
	}
	if (input.fromName !== undefined) {
		sets.push("from_name = ?");
		params.push(input.fromName === null ? null : cleanDisplayName(input.fromName, 100));
	}
	if (input.autoCreateRegex !== undefined) {
		const raw = input.autoCreateRegex === null ? "" : input.autoCreateRegex.trim();
		if (raw && !isSafeRegex(raw)) {
			throw new DomainError(422, "The auto_create_regex is invalid or unsafe (avoid nested quantifiers, backreferences, lookarounds, or patterns over 200 characters).");
		}
		sets.push("auto_create_regex = ?");
		params.push(raw || null);
	}
	if (input.defaultRecipient !== undefined) {
		const raw = input.defaultRecipient === null ? "" : normalizeEmail(input.defaultRecipient);
		if (raw && isOwnAddress(raw, settings.aliasDomains)) {
			throw new DomainError(422, "This recipient address would loop.");
		}
		sets.push("default_recipient = ?");
		params.push(raw || null);
	}
	if (sets.length) {
		sets.push("updated_at = ?");
		params.push(now());
		await db.prepare(`UPDATE domains SET ${sets.join(", ")} WHERE domain = ?`).bind(...params, match.domain).run();
	}
	return (await findDomainById(db, settings, id))!;
}

export async function setDomainFlag(
	db: D1Database,
	settings: Settings,
	id: string,
	flag: "active" | "default_attached_recipients_only",
	value: boolean,
): Promise<DomainView> {
	const match = await findDomainById(db, settings, id);
	if (!match) throw new DomainError(404, "Not found");
	await ensureDomainRow(db, match.domain);
	await db.prepare(`UPDATE domains SET ${flag} = ?, updated_at = ? WHERE domain = ?`).bind(value ? 1 : 0, now(), match.domain).run();
	return (await findDomainById(db, settings, id))!;
}

export function validateNewDomain(domain: string, existingDomains: string[]): string {
	const cleaned = domain.trim().toLowerCase().replace(/\.$/, "");
	if (!DOMAIN_PATTERN.test(cleaned)) throw new DomainError(422, "Enter a valid domain name.");
	if (existingDomains.includes(cleaned)) throw new DomainError(422, "This domain is already configured.");
	if (existingDomains.length >= MAX_ALIAS_DOMAINS) throw new DomainError(422, `At most ${MAX_ALIAS_DOMAINS} alias domains are allowed.`);
	const clash = clashingDomain([...existingDomains, cleaned]);
	if (clash) throw new DomainError(422, `Domain ${cleaned} conflicts with another configured alias or reverse domain.`);
	return cleaned;
}
