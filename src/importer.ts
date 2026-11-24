/**
 * Imports alias settings from SimpleLogin or addy.io, through their APIs or a CSV export: the
 * address, note, display name, whether it is enabled, whether it is pinned, and where it forwards.
 *
 * Only aliases on the chosen domains are imported. An alias on SimpleLogin's or addy.io's own
 * domains keeps receiving mail there, so importing it would do nothing; an alias on your own
 * domain works here once that domain's mail reaches Mailflare.
 */
import { now } from "./db";
import { domainOf, extractEmail, normalizeEmail } from "./format";
import type { Settings } from "./settings";

export type ImportSource = "simplelogin" | "addy" | "csv";

export type ImportedAlias = {
	email: string;
	note: string | null;
	name: string | null;
	enabled: boolean;
	pinned: boolean;
	destination: string | null;
};

export type ImportResult = {
	found: number;
	created: number;
	updated: number;
	/** Aliases left out because their domain was not chosen, by domain. */
	skippedDomains: { domain: string; count: number }[];
};

export class ImportError extends Error {
	constructor(
		readonly reason: "auth" | "fetch" | "format" | "empty",
		detail = "",
	) {
		super(detail || reason);
	}
}

const MAX_ALIASES = 10_000;
const text = (value: unknown, max = 500): string | null => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
	let response: Response;
	try {
		response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "mailflare-alias-import", ...headers } });
	} catch (error) {
		throw new ImportError("fetch", error instanceof Error ? error.message : String(error));
	}
	if (response.status === 401 || response.status === 403) throw new ImportError("auth");
	if (!response.ok) throw new ImportError("fetch", `HTTP ${response.status}`);
	try {
		return await response.json();
	} catch {
		throw new ImportError("format");
	}
}

/** SimpleLogin: GET /api/v2/aliases?page_id=N, 20 per page, until a page comes back empty. */
export async function fetchSimpleLogin(base: string, apiKey: string): Promise<ImportedAlias[]> {
	const out: ImportedAlias[] = [];
	for (let page = 0; out.length < MAX_ALIASES; page += 1) {
		const body = (await getJson(`${base}/api/v2/aliases?page_id=${page}`, { Authentication: apiKey })) as { aliases?: unknown[] };
		if (!Array.isArray(body?.aliases)) throw new ImportError("format");
		if (body.aliases.length === 0) break;
		for (const raw of body.aliases as Record<string, unknown>[]) {
			const email = extractEmail(text(raw.email));
			if (!email) continue;
			const mailboxes = Array.isArray(raw.mailboxes) ? (raw.mailboxes as { email?: unknown }[]) : [];
			out.push({
				email,
				note: text(raw.note),
				name: text(raw.name, 100),
				enabled: raw.enabled !== false,
				pinned: raw.pinned === true,
				destination: extractEmail(text(mailboxes[0]?.email) ?? text((raw.mailbox as { email?: unknown } | undefined)?.email)),
			});
		}
	}
	return out;
}

/** addy.io: GET /api/v1/aliases?page[size]=100&page[number]=N until meta.last_page. Deleted aliases are left out. */
export async function fetchAddy(base: string, apiKey: string): Promise<ImportedAlias[]> {
	const out: ImportedAlias[] = [];
	for (let page = 1; out.length < MAX_ALIASES; page += 1) {
		const body = (await getJson(`${base}/api/v1/aliases?page%5Bsize%5D=100&page%5Bnumber%5D=${page}`, {
			Authorization: `Bearer ${apiKey}`,
			"X-Requested-With": "XMLHttpRequest",
		})) as { data?: unknown[]; meta?: { last_page?: number } };
		if (!Array.isArray(body?.data)) throw new ImportError("format");
		for (const raw of body.data as Record<string, unknown>[]) {
			const email = extractEmail(text(raw.email));
			if (!email || raw.deleted_at) continue;
			const recipients = Array.isArray(raw.recipients) ? (raw.recipients as { email?: unknown }[]) : [];
			out.push({
				email,
				note: text(raw.description),
				name: text(raw.from_name, 100),
				enabled: raw.active !== false,
				pinned: raw.pinned === true,
				destination: extractEmail(text(recipients[0]?.email)),
			});
		}
		const last = Number(body.meta?.last_page ?? page);
		if (body.data.length === 0 || page >= last) break;
	}
	return out;
}

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(input: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	const source = input.replace(/^﻿/, "");
	for (let i = 0; i < source.length; i += 1) {
		const char = source[i]!;
		if (quoted) {
			if (char === '"' && source[i + 1] === '"') (field += '"'), (i += 1);
			else if (char === '"') quoted = false;
			else field += char;
		} else if (char === '"' && field === "") quoted = true;
		else if (char === ",") row.push(field), (field = "");
		else if (char === "\n" || char === "\r") {
			if (char === "\r" && source[i + 1] === "\n") i += 1;
			row.push(field), rows.push(row), (row = []), (field = "");
		} else field += char;
	}
	if (field !== "" || row.length) row.push(field), rows.push(row);
	return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

const COLUMNS = {
	email: ["alias", "email", "address"],
	note: ["note", "description"],
	name: ["name", "from_name"],
	enabled: ["enabled", "active"],
	pinned: ["pinned"],
	destination: ["mailboxes", "mailbox", "recipients", "recipient", "recipient_emails"],
};

const truthy = (value: string | undefined) => !value || !/^(false|0|no|off|disabled|inactive)$/i.test(value.trim());

/** Reads SimpleLogin's or addy.io's alias export, or any CSV with an "alias" or "email" column. */
export function parseAliasCsv(input: string): ImportedAlias[] {
	const [header, ...rows] = parseCsv(input);
	if (!header) throw new ImportError("empty");
	const names = header.map((cell) => cell.trim().toLowerCase().replace(/\s+/g, "_"));
	const find = (candidates: string[]) => names.findIndex((name) => candidates.includes(name));
	const index = Object.fromEntries(Object.entries(COLUMNS).map(([key, candidates]) => [key, find(candidates)])) as Record<keyof typeof COLUMNS, number>;
	if (index.email < 0) throw new ImportError("format");
	const cell = (row: string[], key: keyof typeof COLUMNS) => (index[key] >= 0 ? row[index[key]] : undefined);
	const out: ImportedAlias[] = [];
	for (const row of rows.slice(0, MAX_ALIASES)) {
		const email = extractEmail(cell(row, "email"));
		if (!email) continue;
		const deleted = names.includes("deleted_at") && (row[names.indexOf("deleted_at")] ?? "").trim() !== "";
		if (deleted) continue;
		out.push({
			email,
			note: text(cell(row, "note")),
			name: text(cell(row, "name"), 100),
			enabled: truthy(cell(row, "enabled")),
			pinned: (cell(row, "pinned") ?? "").trim() !== "" && truthy(cell(row, "pinned")),
			destination: extractEmail((cell(row, "destination") ?? "").split(/[\s,;]+/)[0]),
		});
	}
	return out;
}

/** Domains offered by default: alias domains and the domains of aliases already known here. */
export async function defaultImportDomains(db: D1Database, settings: Settings): Promise<string[]> {
	const { results } = await db.prepare("SELECT DISTINCT substr(address, instr(address, '@') + 1) AS domain FROM aliases").all<{ domain: string }>();
	return [...new Set([...settings.aliasDomains, ...results.map((row) => row.domain)])].sort();
}

/**
 * Adds the aliases on the chosen domains. New aliases keep their enabled state and pin; aliases
 * that already exist keep their own settings and only gain a note or name they did not have.
 */
export async function importAliases(
	db: D1Database,
	settings: Settings,
	reverseDomain: string,
	aliases: ImportedAlias[],
	domains: string[],
): Promise<ImportResult> {
	const chosen = new Set(domains.map((domain) => domain.toLowerCase()));
	const skipped = new Map<string, number>();
	const unique = new Map<string, ImportedAlias>();
	for (const alias of aliases) {
		const email = normalizeEmail(alias.email);
		const domain = domainOf(email);
		if (!chosen.has(domain) || domain === reverseDomain) {
			skipped.set(domain, (skipped.get(domain) ?? 0) + 1);
			continue;
		}
		unique.set(email, { ...alias, email });
	}
	const list = [...unique.values()];

	const existing = new Set<string>();
	for (let i = 0; i < list.length; i += 90) {
		const chunk = list.slice(i, i + 90);
		const { results } = await db
			.prepare(`SELECT address FROM aliases WHERE address IN (${chunk.map(() => "?").join(", ")})`)
			.bind(...chunk.map((alias) => alias.email))
			.all<{ address: string }>();
		for (const row of results) existing.add(row.address);
	}

	// Replies need a Mailflare mailbox; borrow the one of another alias on the same domain until
	// the alias receives its first message (the webhook corrects it then).
	const mailboxByDomain = new Map<string, string>();
	for (const domain of new Set(list.map((alias) => domainOf(alias.email)))) {
		const row = await db
			.prepare("SELECT mailbox_id FROM aliases WHERE address LIKE ? AND mailbox_id != '' ORDER BY updated_at DESC LIMIT 1")
			.bind(`%@${domain}`)
			.first<{ mailbox_id: string }>();
		mailboxByDomain.set(domain, row?.mailbox_id ?? "");
	}

	const timestamp = now();
	const statements = list.map((alias) => {
		const destination = alias.destination && alias.destination !== settings.defaultDestination && domainOf(alias.destination) !== reverseDomain ? alias.destination : null;
		const mode = alias.enabled ? "all" : "none";
		return existing.has(alias.email)
			? db
					.prepare("UPDATE aliases SET note = COALESCE(NULLIF(note, ''), ?), name = COALESCE(NULLIF(name, ''), ?), updated_at = ? WHERE address = ?")
					.bind(alias.note, alias.name, timestamp, alias.email)
			: db
					.prepare(
						`INSERT INTO aliases (address, mailbox_id, forward_enabled, forward_mode, destination, note, name, pinned, num_id, uid, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(num_id), 0) + 1 FROM aliases), ?, ?, ?)`,
					)
					.bind(
						alias.email,
						mailboxByDomain.get(domainOf(alias.email)) ?? "",
						alias.enabled ? 1 : 0,
						mode,
						destination,
						alias.note,
						alias.name,
						alias.pinned ? 1 : 0,
						crypto.randomUUID(),
						timestamp,
						timestamp,
					);
	});
	for (let i = 0; i < statements.length; i += 100) await db.batch(statements.slice(i, i + 100));

	return {
		found: aliases.length,
		created: list.filter((alias) => !existing.has(alias.email)).length,
		updated: list.filter((alias) => existing.has(alias.email)).length,
		skippedDomains: [...skipped].map(([domain, count]) => ({ domain, count })).sort((a, b) => b.count - a.count),
	};
}
