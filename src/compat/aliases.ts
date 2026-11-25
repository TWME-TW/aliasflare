/**
 * Alias operations shared by the SimpleLogin and addy.io APIs. An alias is an address on one of
 * the configured alias domains, whose mail reaches this Worker through Cloudflare Email Routing's
 * catch-all (or Mailflare's, when Mailflare is used); one created here receives mail at once,
 * which is why new aliases may only use those domains.
 */
import { now, type AliasRow, type ContactRow } from "../db";
import { isOwnAddress } from "../domains";
import { cleanDisplayName, MAX_NOTE_LENGTH, normalizeEmail } from "../format";
import type { RandomAliasFormat, Settings } from "../settings";

export type AliasStats = {
	nb_forward: number;
	nb_reply: number;
	nb_block: number;
	nb_sent: number;
	last_forward_at: number | null;
	last_reply_at: number | null;
	last_block_at: number | null;
	last_sent_at: number | null;
};

export type AliasView = AliasRow & AliasStats;

export class ClientError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

const STATS_COLUMNS = `
	a.imported_forwarded + (SELECT COALESCE(SUM(c.forward_count), 0) FROM contacts c WHERE c.alias_address = a.address) AS nb_forward,
	a.imported_replied + (SELECT COALESCE(SUM(c.reply_count), 0) FROM contacts c WHERE c.alias_address = a.address) AS nb_reply,
	a.imported_blocked + (SELECT COUNT(*) FROM forwards f WHERE f.alias_address = a.address AND f.status = 'skipped') AS nb_block,
	a.imported_sent AS nb_sent,
	NULLIF(MAX(COALESCE((SELECT MAX(c.last_forward_at) FROM contacts c WHERE c.alias_address = a.address), 0), COALESCE(a.imported_last_forward_at, 0)), 0) AS last_forward_at,
	NULLIF(MAX(COALESCE((SELECT MAX(c.last_reply_at) FROM contacts c WHERE c.alias_address = a.address), 0), COALESCE(a.imported_last_reply_at, 0)), 0) AS last_reply_at,
	NULLIF(MAX(COALESCE((SELECT MAX(f.created_at) FROM forwards f WHERE f.alias_address = a.address AND f.status = 'skipped'), 0), COALESCE(a.imported_last_block_at, 0)), 0) AS last_block_at,
	a.imported_last_sent_at AS last_sent_at`;

export type AliasQuery = {
	deleted?: "without" | "with" | "only";
	enabled?: boolean;
	pinned?: boolean;
	search?: string;
	/** Only aliases on this domain. */
	domain?: string;
	/** Only aliases with this label. */
	label?: string;
	/** Only aliases forwarding to this address; the default one also matches aliases with no address of their own. */
	destination?: { email: string; isDefault: boolean };
	/** A key of ALIAS_SORT; without one, pinned first, then most recently created or used. */
	sort?: { key: string; desc: boolean };
	limit: number;
	offset: number;
};

// A Map, so a client's sort value cannot reach ORDER BY unless it is listed here.
export const ALIAS_SORT = new Map([
	["local_part", "a.address"],
	["email", "a.address"],
	["domain", "substr(a.address, instr(a.address, '@') + 1)"],
	["active", "(a.forward_mode != 'none')"],
	["created_at", "a.created_at"],
	["updated_at", "a.updated_at"],
	["deleted_at", "a.deleted_at"],
	["emails_forwarded", "nb_forward"],
	["emails_blocked", "nb_block"],
	["emails_replied", "nb_reply"],
	["emails_sent", "nb_sent"],
	["last_forwarded", "last_forward_at"],
	["last_blocked", "last_block_at"],
	["last_replied", "last_reply_at"],
	["last_sent", "last_sent_at"],
	["last_used", "a.last_used_at"],
]);

function whereClause(query: Omit<AliasQuery, "limit" | "offset" | "sort">): { sql: string; params: unknown[] } {
	const conditions: string[] = [];
	const params: unknown[] = [];
	if ((query.deleted ?? "without") === "without") conditions.push("a.deleted_at IS NULL");
	if (query.deleted === "only") conditions.push("a.deleted_at IS NOT NULL");
	if (query.enabled !== undefined) conditions.push(query.enabled ? "a.forward_mode != 'none'" : "a.forward_mode = 'none'");
	if (query.pinned !== undefined) conditions.push(query.pinned ? "a.pinned = 1" : "a.pinned = 0");
	if (query.domain !== undefined) {
		conditions.push("a.address LIKE ? ESCAPE '\\'");
		params.push(`%@${query.domain.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}`);
	}
	if (query.label !== undefined) {
		conditions.push("a.address IN (SELECT alias_address FROM alias_labels WHERE label_id = ?)");
		params.push(query.label);
	}
	if (query.destination) {
		conditions.push(query.destination.isDefault ? "(a.destination = ? OR a.destination IS NULL OR a.destination = '')" : "a.destination = ?");
		params.push(query.destination.email);
	}
	if (query.search?.trim()) {
		conditions.push("(a.address LIKE ? ESCAPE '\\' OR COALESCE(a.note, '') LIKE ? ESCAPE '\\' OR COALESCE(a.name, '') LIKE ? ESCAPE '\\')");
		const like = `%${query.search.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
		params.push(like, like, like);
	}
	return { sql: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", params };
}

export async function listAliasViews(db: D1Database, query: AliasQuery): Promise<{ aliases: AliasView[]; total: number }> {
	const where = whereClause(query);
	const column = query.sort && ALIAS_SORT.get(query.sort.key);
	const order = column
		? `${column} ${query.sort!.desc ? "DESC" : "ASC"}, a.num_id ${query.sort!.desc ? "DESC" : "ASC"}`
		: "a.pinned DESC, MAX(a.created_at, COALESCE(a.last_used_at, 0)) DESC, a.num_id DESC";
	const [rows, count] = await db.batch([
		db
			.prepare(`SELECT a.*, ${STATS_COLUMNS} FROM aliases a ${where.sql} ORDER BY ${order} LIMIT ? OFFSET ?`)
			.bind(...where.params, query.limit, query.offset),
		db.prepare(`SELECT COUNT(*) AS total FROM aliases a ${where.sql}`).bind(...where.params),
	]);
	return { aliases: (rows?.results ?? []) as AliasView[], total: Number((count?.results?.[0] as { total?: number } | undefined)?.total ?? 0) };
}

export async function getAliasView(db: D1Database, by: { numId: number } | { uid: string } | { address: string }): Promise<AliasView | null> {
	const [column, value] = "numId" in by ? ["num_id", by.numId] : "uid" in by ? ["uid", by.uid] : ["address", by.address];
	return db.prepare(`SELECT a.*, ${STATS_COLUMNS} FROM aliases a WHERE a.${column} = ?`).bind(value).first<AliasView>();
}

/** Batch version of getAliasView by uid (chunked by 90 params to stay within D1 limits). Preserves input order. */
export async function getAliasViewsByUids(db: D1Database, uids: string[]): Promise<AliasView[]> {
	const unique = [...new Set(uids)];
	if (!unique.length) return [];
	const byUid = new Map<string, AliasView>();
	for (let i = 0; i < unique.length; i += 90) {
		const chunk = unique.slice(i, i + 90);
		const { results } = await db
			.prepare(`SELECT a.*, ${STATS_COLUMNS} FROM aliases a WHERE a.uid IN (${chunk.map(() => "?").join(", ")})`)
			.bind(...chunk)
			.all<AliasView>();
		for (const row of results) byUid.set(row.uid, row);
	}
	return unique.map((uid) => byUid.get(uid)).filter((row): row is AliasView => !!row);
}

/** The contact with the most recent forward or reply, for SimpleLogin's latest_activity. */
export async function latestContact(db: D1Database, address: string): Promise<ContactRow | null> {
	return db
		.prepare(
			"SELECT * FROM contacts WHERE alias_address = ? AND COALESCE(last_forward_at, last_reply_at) IS NOT NULL ORDER BY MAX(COALESCE(last_forward_at, 0), COALESCE(last_reply_at, 0)) DESC LIMIT 1",
		)
		.bind(address)
		.first<ContactRow>();
}

/** Batch version of latestContact for a page of aliases (one D1 batch instead of N queries). */
export async function latestContacts(db: D1Database, addresses: string[]): Promise<Map<string, ContactRow>> {
	const map = new Map<string, ContactRow>();
	if (!addresses.length) return map;
	const stmt = db.prepare(
		"SELECT * FROM contacts WHERE alias_address = ? AND COALESCE(last_forward_at, last_reply_at) IS NOT NULL ORDER BY MAX(COALESCE(last_forward_at, 0), COALESCE(last_reply_at, 0)) DESC LIMIT 1",
	);
	const results = await db.batch(addresses.map((address) => stmt.bind(address)));
	addresses.forEach((address, index) => {
		const row = (results[index]?.results?.[0] as ContactRow | undefined) ?? null;
		if (row) map.set(address, row);
	});
	return map;
}

export async function totals(db: D1Database): Promise<{ aliases: number; active: number; deleted: number; pinned: number; forwarded: number; replied: number; blocked: number }> {
	const row = await db
		.prepare(
			`SELECT
				(SELECT COUNT(*) FROM aliases WHERE deleted_at IS NULL) AS aliases,
				(SELECT COUNT(*) FROM aliases WHERE deleted_at IS NULL AND forward_mode != 'none') AS active,
				(SELECT COUNT(*) FROM aliases WHERE deleted_at IS NOT NULL) AS deleted,
				(SELECT COUNT(*) FROM aliases WHERE deleted_at IS NULL AND pinned = 1) AS pinned,
				(SELECT COALESCE(SUM(forward_count), 0) FROM contacts) + (SELECT COALESCE(SUM(imported_forwarded), 0) FROM aliases) AS forwarded,
				(SELECT COALESCE(SUM(reply_count), 0) FROM contacts) + (SELECT COALESCE(SUM(imported_replied), 0) FROM aliases) AS replied,
				(SELECT COUNT(*) FROM forwards WHERE status = 'skipped') + (SELECT COALESCE(SUM(imported_blocked), 0) FROM aliases) AS blocked`,
		)
		.first<Record<string, number>>();
	return {
		aliases: Number(row?.aliases ?? 0),
		active: Number(row?.active ?? 0),
		deleted: Number(row?.deleted ?? 0),
		pinned: Number(row?.pinned ?? 0),
		forwarded: Number(row?.forwarded ?? 0),
		replied: Number(row?.replied ?? 0),
		blocked: Number(row?.blocked ?? 0),
	};
}

// ── Destinations: SimpleLogin "mailboxes", addy.io "recipients" ──────────────────────────────

export type Destination = { email: string; numId: number; uid: string; isDefault: boolean; aliasCount: number };

async function digest(text: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** Stable ids derived from the address: a positive 31-bit integer and a UUID-shaped string. */
export async function destinationIds(email: string): Promise<{ numId: number; uid: string }> {
	const bytes = await digest(`destination:${email}`);
	const numId = (((bytes[0]! & 0x7f) << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) || 1;
	const hex = [...bytes.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	const uid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
	return { numId, uid };
}

export async function listDestinations(db: D1Database, settings: Settings): Promise<Destination[]> {
	const { results } = await db
		.prepare("SELECT destination, COUNT(*) AS n FROM aliases WHERE deleted_at IS NULL GROUP BY destination")
		.all<{ destination: string | null; n: number }>();
	const counts = new Map<string, number>();
	for (const row of results) {
		const email = row.destination?.toLowerCase() || settings.defaultDestination;
		if (email && !isOwnAddress(email, settings.aliasDomains)) counts.set(email, (counts.get(email) ?? 0) + Number(row.n));
	}
	if (settings.defaultDestination && !isOwnAddress(settings.defaultDestination, settings.aliasDomains) && !counts.has(settings.defaultDestination)) {
		counts.set(settings.defaultDestination, 0);
	}
	const out: Destination[] = [];
	for (const [email, aliasCount] of counts) {
		out.push({ email, aliasCount, isDefault: email === settings.defaultDestination, ...(await destinationIds(email)) });
	}
	return out.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.email.localeCompare(b.email));
}

/** Resolves client-supplied destination ids to an address for aliases.destination (null = default). */
export async function resolveDestination(db: D1Database, settings: Settings, id: number | string | null | undefined): Promise<string | null | undefined> {
	// null is what apps send for "no change" as often as leaving the field out.
	if (id === undefined || id === null) return undefined;
	if (typeof id !== "number" && typeof id !== "string") throw new ClientError(400, "Unknown mailbox");
	const match = (await listDestinations(db, settings)).find((d) => d.numId === Number(id) || d.uid === String(id));
	if (!match) throw new ClientError(400, "Unknown mailbox");
	return match.isDefault ? null : match.email;
}

export function destinationOf(alias: AliasRow, settings: Settings): string | null {
	return alias.destination || settings.defaultDestination || null;
}

// ── Creating aliases ──────────────────────────────────────────────────────────────────────────

const WORDS = (
	"amber anchor apple arrow aspen autumn badge bamboo basil beacon birch blossom breeze brook canyon cedar cherry cinder " +
	"clover cobalt comet coral cotton crane crystal dawn delta desert dune ember falcon fern field flint forest frost garden " +
	"ginger glacier granite harbor hazel heron hollow honey indigo island ivory jasper juniper kettle lagoon lantern lemon " +
	"linen lotus maple marble meadow mint moss nectar north oasis olive onyx orchid otter pebble pepper pine planet plum " +
	"prairie quartz quill rain raven reef ridge river robin saffron sage sand shadow silver sky slate spruce star stone " +
	"summit sun swift thistle thunder tide timber topaz tulip valley velvet violet walnut willow winter wren zephyr"
).split(" ");

function randomInt(max: number): number {
	const limit = Math.floor(0x100000000 / max) * max;
	for (;;) {
		const value = crypto.getRandomValues(new Uint32Array(1))[0]!;
		if (value < limit) return value % max;
	}
}

function randomChars(length: number): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	return Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join("");
}

export function randomLocalPart(format: RandomAliasFormat | "word" | "random_string" | string): string {
	if (format === "uuid") return crypto.randomUUID();
	if (format === "random_characters" || format === "random_string") return randomChars(10);
	return `${WORDS[randomInt(WORDS.length)]}.${WORDS[randomInt(WORDS.length)]}${randomInt(1000)}`;
}


const LOCAL_PART = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;

export function cleanPrefix(prefix: string): string {
	return prefix
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._+-]+/g, "")
		.replace(/^[._+-]+|[._+-]+$/g, "")
		.slice(0, 50);
}

export type CreateAliasInput = { localPart: string; domain: string; note?: string | null; name?: string | null; destination?: string | null; allowRestore?: boolean };

/** Creates an alias, or restores a deleted one with the same address (unless allowRestore is false). */
export async function createAlias(db: D1Database, settings: Settings, input: CreateAliasInput): Promise<AliasView> {
	const domain = input.domain.trim().toLowerCase();
	const localPart = input.localPart.trim().toLowerCase();
	if (!settings.aliasDomains.includes(domain)) {
		throw new ClientError(400, "This domain cannot be used for new aliases. Add it under Alias domains in the aliasflare settings.");
	}
	if (!LOCAL_PART.test(localPart) || localPart.includes("..")) throw new ClientError(400, "The alias contains characters that are not allowed.");
	const address = normalizeEmail(`${localPart}@${domain}`);
	if (address.length > 254) throw new ClientError(400, "The alias address is too long.");
	const name = cleanDisplayName(input.name);
	const note = input.note?.trim().slice(0, MAX_NOTE_LENGTH) || null;
	const existing = await db.prepare("SELECT * FROM aliases WHERE address = ?").bind(address).first<AliasRow>();
	const timestamp = now();
	if (existing && (!existing.deleted_at || input.allowRestore === false)) throw new ClientError(409, "This alias already exists.");
	if (existing) {
		await db
			.prepare("UPDATE aliases SET deleted_at = NULL, forward_mode = 'all', forward_enabled = 1, note = ?, name = ?, destination = ?, updated_at = ? WHERE address = ?")
			.bind(note, name, input.destination ?? null, timestamp, address)
			.run();
	} else {
		// Replies need a Mailflare mailbox; until the alias first receives mail, borrow the one of
		// another alias on the same domain. The webhook corrects it on the first message.
		const sibling = await db
			.prepare("SELECT mailbox_id FROM aliases WHERE address LIKE ? AND mailbox_id != '' ORDER BY updated_at DESC LIMIT 1")
			.bind(`%@${domain}`)
			.first<{ mailbox_id: string }>();
		// Mail to the same address can create it at the same moment; that is a taken name, not a crash.
		const insert = () =>
			db
				.prepare(
					`INSERT INTO aliases (address, mailbox_id, forward_enabled, forward_mode, destination, note, name, num_id, uid, created_at, updated_at)
					 VALUES (?, ?, 1, 'all', ?, ?, ?, (SELECT MAX(COALESCE(MAX(num_id), 0), COALESCE((SELECT value FROM num_id_floor WHERE tbl = 'aliases'), 0)) + 1 FROM aliases), ?, ?, ?) ON CONFLICT DO NOTHING`,
				)
				.bind(address, sibling?.mailbox_id ?? "", input.destination ?? null, note, name, crypto.randomUUID(), timestamp, timestamp)
				.run();
		for (let attempt = 0; ; attempt += 1) {
			if ((await insert()).meta.changes > 0) break;
			if (await db.prepare("SELECT 1 FROM aliases WHERE address = ?").bind(address).first()) throw new ClientError(409, "This alias already exists.");
			// Another alias took the same number at the same moment: try once more with the next one.
			if (attempt >= 2) throw new ClientError(503, "The alias could not be created. Try again.");
		}
	}
	const view = await getAliasView(db, { address });
	if (!view) throw new ClientError(500, "The alias could not be created.");
	return view;
}

export async function createRandomAlias(
	db: D1Database,
	settings: Settings,
	input: { domain?: string; format?: string; note?: string | null; destination?: string | null },
): Promise<AliasView> {
	const domain = input.domain || settings.aliasDomains[0];
	if (!domain) throw new ClientError(400, "No alias domain is set up. Add one under Alias domains in the aliasflare settings.");
	for (let attempt = 0; attempt < 5; attempt += 1) {
		try {
			return await createAlias(db, settings, {
				localPart: randomLocalPart(input.format || settings.randomAliasFormat),
				domain,
				note: input.note,
				destination: input.destination,
				allowRestore: false,
			});
		} catch (error) {
			if (!(error instanceof ClientError && error.status === 409)) throw error;
		}
	}
	throw new ClientError(500, "Could not find a free alias. Try again.");
}

// ── Changing aliases ──────────────────────────────────────────────────────────────────────────

export async function updateAlias(
	db: D1Database,
	address: string,
	fields: { note?: string | null; name?: string | null; pinned?: boolean; enabled?: boolean; destination?: string | null },
): Promise<void> {
	await updateAliases(db, [address], fields);
}

/** Batch-updates one or more aliases in chunks of 100 statements. */
export async function updateAliases(
	db: D1Database,
	addresses: string[],
	fields: { note?: string | null; name?: string | null; pinned?: boolean; enabled?: boolean; destination?: string | null },
): Promise<void> {
	if (!addresses.length) return;
	const sets: string[] = [];
	const params: unknown[] = [];
	if (fields.note !== undefined) sets.push("note = ?"), params.push(fields.note?.trim().slice(0, MAX_NOTE_LENGTH) || null);
	if (fields.name !== undefined) sets.push("name = ?"), params.push(cleanDisplayName(fields.name));
	if (fields.pinned !== undefined) sets.push("pinned = ?"), params.push(fields.pinned ? 1 : 0);
	if (fields.enabled !== undefined) {
		// Re-enabling keeps "Block promotions" if that was chosen before; disabling is "Forward nothing".
		sets.push(fields.enabled ? "forward_mode = CASE WHEN forward_mode = 'none' THEN 'all' ELSE forward_mode END" : "forward_mode = 'none'");
		sets.push("forward_enabled = ?"), params.push(fields.enabled ? 1 : 0);
	}
	if (fields.destination !== undefined) sets.push("destination = ?"), params.push(fields.destination);
	if (!sets.length) return;
	sets.push("updated_at = ?"), params.push(now());
	const sql = `UPDATE aliases SET ${sets.join(", ")} WHERE address = ?`;
	if (addresses.length === 1) {
		await db.prepare(sql).bind(...params, addresses[0]).run();
		return;
	}
	const statements = addresses.map((address) => db.prepare(sql).bind(...params, address));
	for (let i = 0; i < statements.length; i += 100) await db.batch(statements.slice(i, i + 100));
}

export async function deleteAlias(db: D1Database, address: string): Promise<void> {
	await deleteAliases(db, [address]);
}

export async function deleteAliases(db: D1Database, addresses: string[]): Promise<void> {
	if (!addresses.length) return;
	const ts = now();
	const statements = addresses.map((address) =>
		db.prepare("UPDATE aliases SET deleted_at = ?, forward_mode = 'none', forward_enabled = 0, pinned = 0, updated_at = ? WHERE address = ?").bind(ts, ts, address),
	);
	for (let i = 0; i < statements.length; i += 100) await db.batch(statements.slice(i, i + 100));
}

export async function restoreAlias(db: D1Database, address: string): Promise<void> {
	await restoreAliases(db, [address]);
}

export async function restoreAliases(db: D1Database, addresses: string[]): Promise<void> {
	if (!addresses.length) return;
	const ts = now();
	const statements = addresses.map((address) => db.prepare("UPDATE aliases SET deleted_at = NULL, updated_at = ? WHERE address = ?").bind(ts, address));
	for (let i = 0; i < statements.length; i += 100) await db.batch(statements.slice(i, i + 100));
}

/**
 * Statements that remove a deleted alias and everything recorded about it: its contacts,
 * forwards (subjects, unsubscribe links) and other activity. The alias row goes last, and
 * nothing is removed unless the alias is deleted.
 */
export function forgetStatements(db: D1Database, address: string): D1PreparedStatement[] {
	const ifDeleted = "EXISTS (SELECT 1 FROM aliases WHERE address = ? AND deleted_at IS NOT NULL)";
	return [
		db.prepare(`DELETE FROM forwards WHERE alias_address = ? AND ${ifDeleted}`).bind(address, address),
		db.prepare(`DELETE FROM events WHERE alias_address = ? AND ${ifDeleted}`).bind(address, address),
		db.prepare(`DELETE FROM contacts WHERE alias_address = ? AND ${ifDeleted}`).bind(address, address),
		db.prepare("DELETE FROM aliases WHERE address = ? AND deleted_at IS NOT NULL").bind(address),
	];
}

/** Removes the alias and everything about it for good; mail that still arrives makes it appear again. */
export async function forgetAlias(db: D1Database, address: string): Promise<void> {
	await forgetAliases(db, [address]);
}

/** Batch-forgets aliases, keeping each alias's 5 statements atomic in the same batch (20 aliases = 100 statements). */
export async function forgetAliases(db: D1Database, addresses: string[]): Promise<void> {
	if (!addresses.length) return;
	const ts = now();
	for (let i = 0; i < addresses.length; i += 20) {
		const chunk = addresses.slice(i, i + 20);
		await db.batch(chunk.flatMap((address) => [db.prepare("UPDATE aliases SET deleted_at = COALESCE(deleted_at, ?) WHERE address = ?").bind(ts, address), ...forgetStatements(db, address)]));
	}
}
