/**
 * Imports aliases from SimpleLogin or addy.io, through their APIs or a CSV export, with as much of
 * their history as the source offers: note, display name, on/off state, pin, forwarding address,
 * creation date, forward/block/reply/send counts and the dates of the latest of each. From
 * SimpleLogin's API it can also bring the contacts of each alias (they get new reverse aliases
 * here). Anything else the source knows (further mailboxes, PGP, labels, ids) is kept as details.
 *
 * Only aliases on the chosen domains are imported. An alias on SimpleLogin's or addy.io's own
 * domains keeps receiving mail there, so importing it would do nothing; an alias on your own
 * domain works here once that domain's mail reaches Mailflare.
 */
import { newId, now } from "./db";
import { cleanDisplayName, domainOf, extractEmail, makeReverseLocal, normalizeEmail } from "./format";
import { aliasDomainOfReverse, isOwnAddress } from "./domains";
import type { Settings } from "./settings";
import { discard, readTextLimited } from "./streams";

export type ImportSource = "simplelogin" | "addy" | "csv";

export type ImportedContact = {
	email: string;
	name: string | null;
	createdAt: number | null;
	lastSentAt: number | null;
	blocked: boolean;
};

export type ImportedAlias = {
	email: string;
	note: string | null;
	name: string | null;
	enabled: boolean;
	pinned: boolean;
	destination: string | null;
	createdAt: number | null;
	forwarded: number;
	blocked: number;
	replied: number;
	sent: number;
	lastForwardAt: number | null;
	lastBlockAt: number | null;
	lastReplyAt: number | null;
	lastSentAt: number | null;
	/** Everything else worth keeping, shown on the alias page. */
	details: Record<string, unknown>;
	/** The alias's id at the source, for fetching its contacts. */
	sourceId?: number;
	contacts?: ImportedContact[];
};

export type ImportResult = {
	found: number;
	created: number;
	updated: number;
	contacts: number;
	/** Aliases left out because their domain was not chosen, by domain. */
	skippedDomains: { domain: string; count: number }[];
	/** Forwarding addresses the import added that were not in use here before. */
	newDestinations: string[];
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
/** Pages fetched from one service, whatever the pages hold, so a bad server cannot loop forever. */
const MAX_PAGES = 1_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_DETAILS_BYTES = 8 * 1024;
/**
 * Requests to the other service in one import, retries included. Workers allow 1,000
 * subrequests per request on the Paid plan; this leaves room for the rest of the import.
 */
const MAX_FETCHES = 900;

/** Counts the requests of one import against MAX_FETCHES. */
export type FetchBudget = { left: number };
/**
 * On the Workers Free plan a request may make 50 subrequests, fetches and D1 queries together;
 * 25 fetches leave room for the queries of the import itself.
 */
const MAX_FETCHES_FREE = 25;
export const newFetchBudget = (plan: "free" | "paid" = "paid"): FetchBudget => ({ left: plan === "free" ? MAX_FETCHES_FREE : MAX_FETCHES });

const text = (value: unknown, max = 500): string | null => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
const count = (value: unknown): number => {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
};

/** Timestamps outside 1990–2200 are taken as wrong and dropped. */
const MIN_TIMESTAMP = 631152000;
const MAX_TIMESTAMP = 7258118400;

/**
 * Unix seconds from a Unix timestamp (seconds, milliseconds, microseconds or nanoseconds) or
 * a date string; UTC when no zone is given. Null for anything outside 1990–2200, so a wrong
 * value never reaches the dashboard's date formatting.
 */
export function toTimestamp(value: unknown): number | null {
	if (value === null || value === undefined || value === "") return null;
	let seconds: number;
	if (typeof value === "number" || (typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim()))) {
		seconds = Number(value);
		if (!Number.isFinite(seconds) || seconds <= 0) return null;
		while (seconds > MAX_TIMESTAMP) seconds /= 1000;
	} else {
		if (typeof value !== "string") return null;
		let source = value.trim();
		if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(source)) source = `${source.replace(" ", "T")}Z`;
		seconds = Date.parse(source) / 1000;
	}
	return Number.isFinite(seconds) && seconds >= MIN_TIMESTAMP && seconds <= MAX_TIMESTAMP ? Math.floor(seconds) : null;
}

const empty = (email: string): ImportedAlias => ({
	email,
	note: null,
	name: null,
	enabled: true,
	pinned: false,
	destination: null,
	createdAt: null,
	forwarded: 0,
	blocked: 0,
	replied: 0,
	sent: 0,
	lastForwardAt: null,
	lastBlockAt: null,
	lastReplyAt: null,
	lastSentAt: null,
	details: {},
});

function clean(object: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}

async function getJson(url: string, headers: Record<string, string>, budget: FetchBudget): Promise<unknown> {
	for (let attempt = 0; ; attempt += 1) {
		if (budget.left <= 0) throw new ImportError("fetch", "this import needs more requests than one run may make; on the Workers Free plan, export a CSV file from the service and import that instead");
		budget.left -= 1;
		let response: Response;
		try {
			// No redirects: the key travels in a custom header that fetch would carry to any host.
			response = await fetch(url, {
				headers: { Accept: "application/json", "User-Agent": "aliasflare-import", ...headers },
				redirect: "manual",
				signal: AbortSignal.timeout(20_000),
			});
		} catch (error) {
			throw new ImportError("fetch", error instanceof Error ? error.message : String(error));
		}
		// Workers cannot refuse redirects outright: they come back as a 3xx and are not followed.
		if (!response.ok) await discard(response);
		if (response.status >= 300 && response.status < 400) throw new ImportError("fetch", `HTTP ${response.status} redirect, not followed`);
		if (response.status === 429 && attempt < 4) {
			// Rate limited: wait as asked (capped at 10 s), then try again.
			const retryAfter = Number(response.headers.get("Retry-After"));
			const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 10) : Math.min(2 ** attempt, 10);
			await new Promise((resolve) => setTimeout(resolve, wait * 1000));
			continue;
		}
		if (response.status === 401 || response.status === 403) throw new ImportError("auth");
		if (!response.ok) throw new ImportError("fetch", `HTTP ${response.status}`);
		const text = await readTextLimited(response, MAX_RESPONSE_BYTES);
		if (text === null) throw new ImportError("format", "response too large");
		try {
			return JSON.parse(text);
		} catch {
			throw new ImportError("format");
		}
	}
}

/** An object from a JSON array: null, numbers and nested arrays in a list are skipped. */
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** SimpleLogin: GET /api/v2/aliases?page_id=N, 20 per page, until a page comes back empty. */
export async function fetchSimpleLogin(base: string, apiKey: string, budget: FetchBudget = newFetchBudget()): Promise<ImportedAlias[]> {
	const out: ImportedAlias[] = [];
	for (let page = 0; out.length < MAX_ALIASES && page < MAX_PAGES; page += 1) {
		const body = (await getJson(`${base}/api/v2/aliases?page_id=${page}`, { Authentication: apiKey }, budget)) as { aliases?: unknown[] };
		if (!Array.isArray(body?.aliases)) throw new ImportError("format");
		if (body.aliases.length === 0) break;
		for (const raw of body.aliases.filter(isRecord)) {
			const email = extractEmail(text(raw.email));
			if (!email) continue;
			const mailboxes = (Array.isArray(raw.mailboxes) ? (raw.mailboxes as { email?: unknown }[]) : [])
				.map((mailbox) => extractEmail(text(mailbox?.email)))
				.filter((value): value is string => !!value);
			const fallback = extractEmail(text((raw.mailbox as { email?: unknown } | undefined)?.email));
			const latest = raw.latest_activity as { action?: unknown; timestamp?: unknown; contact?: { email?: unknown; name?: unknown } } | null | undefined;
			const latestAt = toTimestamp(latest?.timestamp);
			const action = text(latest?.action);
			out.push({
				...empty(email),
				note: text(raw.note),
				name: text(raw.name, 100),
				enabled: raw.enabled !== false,
				pinned: raw.pinned === true,
				destination: mailboxes[0] ?? fallback,
				createdAt: toTimestamp(raw.creation_timestamp) ?? toTimestamp(raw.creation_date),
				forwarded: count(raw.nb_forward),
				blocked: count(raw.nb_block),
				replied: count(raw.nb_reply),
				// SimpleLogin reports only the latest activity, so only that one date is known.
				lastForwardAt: action === "forward" ? latestAt : null,
				lastBlockAt: action === "block" ? latestAt : null,
				lastReplyAt: action === "reply" ? latestAt : null,
				sourceId: Number.isInteger(raw.id) ? (raw.id as number) : undefined,
				details: clean({
					id: raw.id,
					mailboxes: mailboxes.length > 1 ? mailboxes : undefined,
					pgp: raw.support_pgp === true ? (raw.disable_pgp === true ? "off" : "on") : undefined,
					latest_activity:
						latest && action
							? clean({ action, at: latestAt, contact: extractEmail(text(latest.contact?.email)), contact_name: text(latest.contact?.name, 100) })
							: undefined,
				}),
			});
		}
	}
	return out;
}

/** SimpleLogin: GET /api/aliases/:id/contacts?page_id=N for each alias that has had any activity. */
export async function addSimpleLoginContacts(base: string, apiKey: string, aliases: ImportedAlias[], budget: FetchBudget = newFetchBudget()): Promise<void> {
	for (const alias of aliases) {
		const active = alias.forwarded + alias.blocked + alias.replied > 0 || alias.details.latest_activity !== undefined;
		if (alias.sourceId === undefined || !active) continue;
		const contacts: ImportedContact[] = [];
		// Contacts are extra: when the budget runs low they stop, and the aliases still import.
		// One alias whose list cannot be read keeps the contacts read so far and the others go on.
		for (let page = 0; budget.left > 5 && page < MAX_PAGES; page += 1) {
			let body: { contacts?: unknown[] };
			try {
				body = (await getJson(`${base}/api/aliases/${alias.sourceId}/contacts?page_id=${page}`, { Authentication: apiKey }, budget)) as { contacts?: unknown[] };
			} catch (error) {
				if (!(error instanceof ImportError)) throw error;
				break;
			}
			if (!Array.isArray(body?.contacts) || body.contacts.length === 0) break;
			for (const raw of body.contacts.filter(isRecord)) {
				const display = text(raw.contact, 1000);
				const email = extractEmail(display);
				if (!email) continue;
				const rawName = display?.match(/^\s*"?([^"<]+?)"?\s*</)?.[1]?.trim() ?? null;
				const name = cleanDisplayName(rawName);
				contacts.push({
					email,
					name: name && name.toLowerCase() !== email ? name : null,
					createdAt: toTimestamp(raw.creation_timestamp),
					lastSentAt: toTimestamp(raw.last_email_sent_timestamp),
					blocked: raw.block_forward === true,
				});
			}
			if (body.contacts.length < 20) break;
		}
		alias.contacts = contacts;
	}
}

/** addy.io: GET /api/v1/aliases?page[size]=100&page[number]=N until meta.last_page. Deleted aliases are left out. */
export async function fetchAddy(base: string, apiKey: string, budget: FetchBudget = newFetchBudget()): Promise<ImportedAlias[]> {
	const out: ImportedAlias[] = [];
	for (let page = 1; out.length < MAX_ALIASES && page <= MAX_PAGES; page += 1) {
		const body = (await getJson(`${base}/api/v1/aliases?page%5Bsize%5D=100&page%5Bnumber%5D=${page}`, {
			Authorization: `Bearer ${apiKey}`,
			"X-Requested-With": "XMLHttpRequest",
		}, budget)) as { data?: unknown[]; meta?: { last_page?: number } };
		if (!Array.isArray(body?.data)) throw new ImportError("format");
		for (const raw of body.data.filter(isRecord)) {
			const email = extractEmail(text(raw.email));
			if (!email || raw.deleted_at) continue;
			const recipients = (Array.isArray(raw.recipients) ? (raw.recipients as { email?: unknown }[]) : [])
				.map((recipient) => extractEmail(text(recipient?.email)))
				.filter((value): value is string => !!value);
			const labels = (Array.isArray(raw.labels) ? (raw.labels as { name?: unknown }[]) : []).map((label) => text(label?.name, 60)).filter(Boolean);
			out.push({
				...empty(email),
				note: text(raw.description),
				name: text(raw.from_name, 100),
				enabled: raw.active !== false,
				pinned: raw.pinned === true,
				destination: recipients[0] ?? null,
				createdAt: toTimestamp(raw.created_at),
				forwarded: count(raw.emails_forwarded),
				blocked: count(raw.emails_blocked),
				replied: count(raw.emails_replied),
				sent: count(raw.emails_sent),
				lastForwardAt: toTimestamp(raw.last_forwarded),
				lastBlockAt: toTimestamp(raw.last_blocked),
				lastReplyAt: toTimestamp(raw.last_replied),
				lastSentAt: toTimestamp(raw.last_sent),
				details: clean({
					id: raw.id,
					recipients: recipients.length > 1 ? recipients : undefined,
					labels: labels.length ? labels : undefined,
					extension: text(raw.extension, 64),
					attached_recipients_only: raw.attached_recipients_only === true ? true : undefined,
				}),
			});
		}
		const last = Number(body.meta?.last_page ?? page);
		if (body.data.length === 0 || !(page < last)) break;
	}
	return out;
}

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(input: string, maxRows = Infinity): string[][] {
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
			row.push(field);
			if (row.some((cell) => cell.trim() !== "")) rows.push(row);
			row = [];
			field = "";
			// Enough rows read: the rest of a long file is not parsed at all.
			if (rows.length >= maxRows) return rows;
		} else field += char;
	}
	if (field !== "" || row.length) {
		row.push(field);
		if (row.some((cell) => cell.trim() !== "")) rows.push(row);
	}
	return rows;
}

const COLUMNS = {
	email: ["alias", "email", "address"],
	note: ["note", "description"],
	name: ["name", "from_name"],
	enabled: ["enabled", "active"],
	pinned: ["pinned"],
	destination: ["mailboxes", "mailbox", "recipients", "recipient", "recipient_emails"],
	createdAt: ["created_at", "creation_date", "creation_timestamp", "created"],
	forwarded: ["emails_forwarded", "nb_forward", "forwarded"],
	blocked: ["emails_blocked", "nb_block", "blocked"],
	replied: ["emails_replied", "nb_reply", "replied"],
	sent: ["emails_sent", "nb_sent", "sent"],
	lastForwardAt: ["last_forwarded"],
	lastBlockAt: ["last_blocked"],
	lastReplyAt: ["last_replied"],
	lastSentAt: ["last_sent"],
	deletedAt: ["deleted_at"],
};

const truthy = (value: string | undefined) => !value || !/^(false|0|no|off|disabled|inactive)$/i.test(value.trim());

/** Reads SimpleLogin's or addy.io's alias export, or any CSV with an "alias" or "email" column. */
export function parseAliasCsv(input: string): ImportedAlias[] {
	// The header, the aliases taken, and a few blank lines to spare.
	const [header, ...rows] = parseCsv(input, MAX_ALIASES + 100);
	if (!header) throw new ImportError("empty");
	const names = header.map((cell) => cell.trim().toLowerCase().replace(/\s+/g, "_"));
	const index = Object.fromEntries(
		Object.entries(COLUMNS).map(([key, candidates]) => [key, names.findIndex((name) => candidates.includes(name))]),
	) as Record<keyof typeof COLUMNS, number>;
	if (index.email < 0) throw new ImportError("format");
	const cell = (row: string[], key: keyof typeof COLUMNS) => (index[key] >= 0 ? row[index[key]] : undefined);
	const out: ImportedAlias[] = [];
	for (const row of rows) {
		if (out.length >= MAX_ALIASES) break;
		const email = extractEmail(cell(row, "email"));
		if (!email || (cell(row, "deletedAt") ?? "").trim() !== "") continue;
		const destinations = (cell(row, "destination") ?? "")
			.split(/[\s,;]+/)
			.map((value) => extractEmail(value))
			.filter((value): value is string => !!value);
		out.push({
			...empty(email),
			note: text(cell(row, "note")),
			name: text(cell(row, "name"), 100),
			enabled: truthy(cell(row, "enabled")),
			pinned: (cell(row, "pinned") ?? "").trim() !== "" && truthy(cell(row, "pinned")),
			destination: destinations[0] ?? null,
			createdAt: toTimestamp(cell(row, "createdAt")),
			forwarded: count(cell(row, "forwarded")),
			blocked: count(cell(row, "blocked")),
			replied: count(cell(row, "replied")),
			sent: count(cell(row, "sent")),
			lastForwardAt: toTimestamp(cell(row, "lastForwardAt")),
			lastBlockAt: toTimestamp(cell(row, "lastBlockAt")),
			lastReplyAt: toTimestamp(cell(row, "lastReplyAt")),
			lastSentAt: toTimestamp(cell(row, "lastSentAt")),
			details: clean({ mailboxes: destinations.length > 1 ? destinations : undefined }),
		});
	}
	return out;
}

/** Domains offered by default: alias domains and the domains of aliases already known here. */
export async function defaultImportDomains(db: D1Database, settings: Settings): Promise<string[]> {
	const { results } = await db.prepare("SELECT DISTINCT substr(address, instr(address, '@') + 1) AS domain FROM aliases").all<{ domain: string }>();
	return [...new Set([...settings.aliasDomains, ...results.map((row) => row.domain)])].sort();
}

export type Selection = { chosen: ImportedAlias[]; skippedDomains: ImportResult["skippedDomains"] };

/** Splits aliases into those on the chosen domains (deduplicated) and counts of the rest by domain. */
export function selectByDomain(aliases: ImportedAlias[], domains: string[], existingAliasDomains: string[] = []): Selection {
	const wanted = new Set(domains.map((domain) => domain.toLowerCase()));
	const known = new Set([...wanted, ...existingAliasDomains.map((domain) => domain.toLowerCase())]);
	const skipped = new Map<string, number>();
	const unique = new Map<string, ImportedAlias>();
	for (const alias of aliases) {
		const email = normalizeEmail(alias.email);
		const domain = domainOf(email);
		if (!wanted.has(domain) || known.has(aliasDomainOfReverse(domain) ?? "")) skipped.set(domain, (skipped.get(domain) ?? 0) + 1);
		else unique.set(email, { ...alias, email });
	}
	return {
		chosen: [...unique.values()],
		skippedDomains: [...skipped].map(([domain, count]) => ({ domain, count })).sort((a, b) => b.count - a.count),
	};
}

/** Imported details as JSON, or a short note when they are too large to keep. */
function detailsJson(details: Record<string, unknown>): string | null {
	if (!Object.keys(details).length) return null;
	const json = JSON.stringify(details);
	return json.length <= MAX_DETAILS_BYTES ? json : JSON.stringify({ note: "details too large to keep" });
}

/**
 * Saves the chosen aliases. New aliases take every imported setting. Aliases that already exist
 * keep their own settings, gain a note or name they did not have, keep the earlier creation date,
 * and get the imported history replaced by this import's. Contacts are added, or merged by address.
 */
export async function importAliases(
	db: D1Database,
	settings: Settings,
	source: ImportSource,
	selection: Selection,
	found: number,
	options: { keepDestinations?: boolean; batchSize?: number } = {},
): Promise<ImportResult> {
	const list = selection.chosen;
	// Forwarding addresses already in use here. Others from the import are only taken when asked:
	// every forwarding address can write through reverse aliases and appears in the apps.
	const known = new Set<string>([settings.defaultDestination].filter(Boolean).map((email) => email.toLowerCase()));
	const { results: used } = await db
		.prepare("SELECT DISTINCT destination FROM aliases WHERE destination IS NOT NULL AND imported_from IS NULL AND deleted_at IS NULL")
		.all<{ destination: string }>();
	for (const row of used) known.add(row.destination.toLowerCase());
	const existing = new Set<string>();
	// One query for every address, not one per chunk: on the Workers Free plan a request may
	// make only 50 D1 queries in all.
	const { results: storedAliases } = await db.prepare("SELECT address FROM aliases").all<{ address: string }>();
	const wanted = new Set(list.map((alias) => alias.email));
	for (const row of storedAliases) if (wanted.has(row.address)) existing.add(row.address);
	const allOwnDomains = [
		...new Set([
			...settings.aliasDomains,
			...storedAliases.map((row) => domainOf(row.address)),
			...list.map((alias) => domainOf(alias.email)),
		]),
	];
	const newDestinations = new Set<string>();
	const destinationFor = (alias: ImportedAlias): string | null => {
		const destination = alias.destination?.toLowerCase();
		// All domains in this import batch and existing aliases count too, so an import cannot set up a loop.
		if (!destination || destination === alias.email || isOwnAddress(destination, allOwnDomains)) return null;
		if (destination === settings.defaultDestination.toLowerCase()) return null;
		if (known.has(destination)) return destination;
		if (!options.keepDestinations) return null;
		newDestinations.add(destination);
		return destination;
	};

	// Replies need a Mailflare mailbox; borrow the one of another alias on the same domain until
	// the alias receives its first message (the webhook corrects it then).
	// One query for all domains: the newest mailbox per domain.
	const mailboxByDomain = new Map<string, string>();
	const { results: mailboxes } = await db
		.prepare("SELECT address, mailbox_id FROM aliases WHERE mailbox_id != '' ORDER BY updated_at DESC")
		.all<{ address: string; mailbox_id: string }>();
	for (const row of mailboxes) {
		const domain = domainOf(row.address);
		if (!mailboxByDomain.has(domain)) mailboxByDomain.set(domain, row.mailbox_id);
	}

	const timestamp = now();
	const history = (alias: ImportedAlias) => [
		source,
		timestamp,
		alias.forwarded,
		alias.blocked,
		alias.replied,
		alias.sent,
		alias.lastForwardAt,
		alias.lastBlockAt,
		alias.lastReplyAt,
		alias.lastSentAt,
		detailsJson(alias.details),
	];
	const statements: D1PreparedStatement[] = list.map((alias) => {
		const name = cleanDisplayName(alias.name);
		if (existing.has(alias.email)) {
			return db
				.prepare(
					`UPDATE aliases SET note = COALESCE(NULLIF(note, ''), ?), name = COALESCE(NULLIF(name, ''), ?), created_at = MIN(created_at, COALESCE(?, created_at)),
					 imported_from = ?, imported_at = ?, imported_forwarded = ?, imported_blocked = ?, imported_replied = ?, imported_sent = ?,
					 imported_last_forward_at = ?, imported_last_block_at = ?, imported_last_reply_at = ?, imported_last_sent_at = ?, imported_details = ?,
					 updated_at = ? WHERE address = ?`,
				)
				.bind(alias.note, name, alias.createdAt, ...history(alias), timestamp, alias.email);
		}
		const destination = destinationFor(alias);
		return db
			.prepare(
				`INSERT INTO aliases (address, mailbox_id, forward_enabled, forward_mode, destination, note, name, pinned, num_id, uid, created_at, updated_at,
				 imported_from, imported_at, imported_forwarded, imported_blocked, imported_replied, imported_sent,
				 imported_last_forward_at, imported_last_block_at, imported_last_reply_at, imported_last_sent_at, imported_details)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(num_id), 0) + 1 FROM aliases), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT (address) DO NOTHING`,
			)
			.bind(
				alias.email,
				mailboxByDomain.get(domainOf(alias.email)) ?? "",
				alias.enabled ? 1 : 0,
				alias.enabled ? "all" : "none",
				destination,
				alias.note,
				name,
				alias.pinned ? 1 : 0,
				crypto.randomUUID(),
				alias.createdAt ?? timestamp,
				timestamp,
				...history(alias),
			);
	});

	let contacts = 0;
	for (const alias of list) {
		const seenContacts = new Set<string>();
		for (const contact of alias.contacts ?? []) {
			const email = normalizeEmail(contact.email);
			if (isOwnAddress(email, allOwnDomains) || seenContacts.has(email)) continue;
			seenContacts.add(email);
			contacts += 1;
			statements.push(
				db
					.prepare(
						`INSERT INTO contacts (id, alias_address, email, name, reverse_local, blocked, last_reply_at, num_id, created_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(num_id), 0) + 1 FROM contacts), ?)
						 ON CONFLICT (alias_address, email) DO UPDATE SET
						   name = COALESCE(NULLIF(contacts.name, ''), excluded.name),
						   blocked = MAX(contacts.blocked, excluded.blocked),
						   last_reply_at = NULLIF(MAX(COALESCE(contacts.last_reply_at, 0), COALESCE(excluded.last_reply_at, 0)), 0),
						   created_at = MIN(contacts.created_at, excluded.created_at)`,
					)
					.bind(
						newId("ct"),
						alias.email,
						email,
						cleanDisplayName(contact.name),
						makeReverseLocal(email, settings.includeSenderInReverseAlias),
						contact.blocked ? 1 : 0,
						contact.lastSentAt,
						contact.createdAt ?? timestamp,
					),
			);
		}
	}
	// A batch is one query; scale up dynamically so large imports with many contacts stay well below Workers' subrequest limit.
	const batchSize = Math.max(options.batchSize ?? 100, Math.ceil(statements.length / 400));
	let created = 0;
	let updated = 0;
	for (let i = 0; i < statements.length; i += batchSize) {
		const results = await db.batch(statements.slice(i, i + batchSize));
		results.forEach((result, offset) => {
			const idx = i + offset;
			if (idx >= list.length) return;
			const changes = result.meta.changes ?? 0;
			if (existing.has(list[idx]!.email)) updated += changes > 0 ? 1 : 0;
			else created += changes > 0 ? 1 : 0;
		});
	}
	// The imported history (the other service's last forward, reply or send, and the contacts'
	// own) counts toward when each alias was last used.
	await db
		.prepare(
			`UPDATE aliases SET last_used_at = NULLIF(MAX(COALESCE(last_used_at, 0), COALESCE(imported_last_forward_at, 0), COALESCE(imported_last_reply_at, 0), COALESCE(imported_last_sent_at, 0),
			   COALESCE((SELECT MAX(MAX(COALESCE(c.last_forward_at, 0), COALESCE(c.last_reply_at, 0))) FROM contacts c WHERE c.alias_address = aliases.address), 0)), 0)
			 WHERE imported_at = ?`,
		)
		.bind(timestamp)
		.run();

	return {
		found,
		created,
		updated,
		contacts,
		skippedDomains: selection.skippedDomains,
		newDestinations: [...newDestinations].sort(),
	};
}
