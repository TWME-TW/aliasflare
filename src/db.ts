import { domainOf, makeReverseLocal } from "./format";

export type ForwardMode = "all" | "no_promotions" | "none";

export const FORWARD_MODES: { value: ForwardMode; label: string }[] = [
	{ value: "all", label: "Forward everything" },
	{ value: "no_promotions", label: "Block promotions" },
	{ value: "none", label: "Forward nothing" },
];

export function isForwardMode(value: unknown): value is ForwardMode {
	return FORWARD_MODES.some((mode) => mode.value === value);
}

export type AliasRow = {
	address: string;
	mailbox_id: string;
	/** Legacy flag kept in sync with forward_mode; forward_mode is authoritative. */
	forward_enabled: number;
	forward_mode: ForwardMode;
	destination: string | null;
	note: string | null;
	created_at: number;
	updated_at: number;
};

export type ContactRow = {
	id: string;
	alias_address: string;
	email: string;
	name: string | null;
	reverse_local: string;
	blocked: number;
	forward_count: number;
	reply_count: number;
	last_forward_at: number | null;
	last_reply_at: number | null;
	created_at: number;
};

export type ForwardRow = {
	id: string;
	mailflare_message_id: string;
	alias_address: string;
	contact_id: string | null;
	original_message_id: string | null;
	forwarded_message_id: string | null;
	original_unsubscribe: string | null;
	original_unsubscribe_post: number;
	subject: string | null;
	trackers_removed: number;
	status: "processing" | "sent" | "skipped" | "failed";
	error: string | null;
	created_at: number;
	updated_at: number;
};

export function now(): number {
	return Math.floor(Date.now() / 1000);
}

export function newId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export async function getAlias(db: D1Database, address: string): Promise<AliasRow | null> {
	return db.prepare("SELECT * FROM aliases WHERE address = ?").bind(address).first<AliasRow>();
}

/** Returns the alias, creating it with the given defaults the first time it is seen. */
export async function ensureAlias(
	db: D1Database,
	address: string,
	mailboxId: string,
	defaults: { forwardEnabled: boolean; destination: string | null },
): Promise<AliasRow> {
	const timestamp = now();
	await db
		.prepare(
			"INSERT INTO aliases (address, mailbox_id, forward_enabled, forward_mode, destination, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (address) DO NOTHING",
		)
		.bind(address, mailboxId, defaults.forwardEnabled ? 1 : 0, defaults.forwardEnabled ? "all" : "none", defaults.destination, timestamp, timestamp)
		.run();
	const row = await getAlias(db, address);
	if (!row) throw new Error(`Alias ${address} could not be created`);
	if (row.mailbox_id !== mailboxId) {
		// The address moved to another Mailflare mailbox; replies must be sent from the new one.
		await db.prepare("UPDATE aliases SET mailbox_id = ?, updated_at = ? WHERE address = ?").bind(mailboxId, timestamp, address).run();
		row.mailbox_id = mailboxId;
	}
	return row;
}

export async function getContactByReverseLocal(db: D1Database, reverseLocal: string): Promise<ContactRow | null> {
	return db.prepare("SELECT * FROM contacts WHERE reverse_local = ?").bind(reverseLocal.toLowerCase()).first<ContactRow>();
}

export async function getContactsByReverseLocals(db: D1Database, locals: string[]): Promise<ContactRow[]> {
	if (locals.length === 0) return [];
	const placeholders = locals.map(() => "?").join(", ");
	const { results } = await db
		.prepare(`SELECT * FROM contacts WHERE reverse_local IN (${placeholders})`)
		.bind(...locals.map((local) => local.toLowerCase()))
		.all<ContactRow>();
	return results;
}

/** Returns the contact for (alias, sender), creating it with a fresh reverse alias the first time. */
export async function ensureContact(
	db: D1Database,
	aliasAddress: string,
	email: string,
	name: string | null,
	includeSenderInReverseAlias: boolean,
): Promise<ContactRow> {
	const existing = await db
		.prepare("SELECT * FROM contacts WHERE alias_address = ? AND email = ?")
		.bind(aliasAddress, email)
		.first<ContactRow>();
	if (existing) {
		if (name && name !== existing.name) {
			await db.prepare("UPDATE contacts SET name = ? WHERE id = ?").bind(name, existing.id).run();
			existing.name = name;
		}
		return existing;
	}
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const id = newId("ct");
		const reverseLocal = makeReverseLocal(email, includeSenderInReverseAlias);
		const result = await db
			.prepare(
				"INSERT INTO contacts (id, alias_address, email, name, reverse_local, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
			)
			.bind(id, aliasAddress, email, name, reverseLocal, now())
			.run();
		if (result.meta.changes > 0) {
			const created = await db.prepare("SELECT * FROM contacts WHERE id = ?").bind(id).first<ContactRow>();
			if (created) return created;
		}
		// Either a concurrent delivery created the same contact, or the reverse alias collided.
		const raced = await db
			.prepare("SELECT * FROM contacts WHERE alias_address = ? AND email = ?")
			.bind(aliasAddress, email)
			.first<ContactRow>();
		if (raced) return raced;
	}
	throw new Error("Could not allocate a unique reverse alias");
}

export async function recordEvent(
	db: D1Database,
	event: { kind: string; contactId?: string | null; aliasAddress?: string | null; status: string; detail?: string | null },
): Promise<void> {
	await db
		.prepare("INSERT INTO events (id, kind, contact_id, alias_address, status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
		.bind(newId("ev"), event.kind, event.contactId ?? null, event.aliasAddress ?? null, event.status, event.detail?.slice(0, 1000) ?? null, now())
		.run();
}

/** Maps Message-IDs the user's mail client saw (forwarded copies) back to the originals. */
export async function mapForwardedToOriginal(db: D1Database, ids: string[]): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	if (ids.length === 0) return map;
	const placeholders = ids.map(() => "?").join(", ");
	const { results } = await db
		.prepare(
			`SELECT forwarded_message_id, original_message_id FROM forwards WHERE forwarded_message_id IN (${placeholders}) AND original_message_id IS NOT NULL`,
		)
		.bind(...ids)
		.all<{ forwarded_message_id: string; original_message_id: string }>();
	for (const row of results) map.set(row.forwarded_message_id, row.original_message_id);
	return map;
}

/** The reverse of mapForwardedToOriginal, so forwarded copies thread together in the user's client. */
export async function mapOriginalToForwarded(db: D1Database, ids: string[]): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	if (ids.length === 0) return map;
	const placeholders = ids.map(() => "?").join(", ");
	const { results } = await db
		.prepare(
			`SELECT original_message_id, forwarded_message_id FROM forwards WHERE original_message_id IN (${placeholders}) AND forwarded_message_id IS NOT NULL`,
		)
		.bind(...ids)
		.all<{ forwarded_message_id: string; original_message_id: string }>();
	for (const row of results) map.set(row.original_message_id, row.forwarded_message_id);
	return map;
}

export async function setForwardMode(db: D1Database, address: string, mode: ForwardMode): Promise<void> {
	await db
		.prepare("UPDATE aliases SET forward_mode = ?, forward_enabled = ?, updated_at = ? WHERE address = ?")
		.bind(mode, mode === "none" ? 0 : 1, now(), address)
		.run();
}

export type BlocklistRow = { id: string; kind: "address" | "domain"; value: string; hits: number; created_at: number };

/** Candidate blocklist values for a sender: the address, its domain and every parent domain. */
export function blocklistCandidates(email: string): string[] {
	const labels = domainOf(email).split(".");
	const domains: string[] = [];
	for (let index = 0; index < labels.length - 1; index += 1) domains.push(labels.slice(index).join("."));
	return [email, ...domains];
}

/** Returns the matching blocklist entry, counting the hit. */
export async function matchBlocklist(db: D1Database, email: string): Promise<BlocklistRow | null> {
	const candidates = blocklistCandidates(email);
	const placeholders = candidates.map(() => "?").join(", ");
	const row = await db
		.prepare(`SELECT * FROM blocklist WHERE value IN (${placeholders}) ORDER BY kind = 'address' DESC, length(value) DESC LIMIT 1`)
		.bind(...candidates)
		.first<BlocklistRow>();
	if (row) await db.prepare("UPDATE blocklist SET hits = hits + 1 WHERE id = ?").bind(row.id).run();
	return row;
}
