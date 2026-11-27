/**
 * First-class forwarding recipients (addy.io's Recipients / SimpleLogin's Mailboxes) and
 * multi-recipient alias attachments.
 *
 * Recipient IDs remain deterministic from destinationIds(email) so existing clients, tests and
 * saved references keep matching whether a recipient was explicitly created or discovered from
 * defaultDestination / aliases.destination / pgp_keys.
 */
import { destinationIds } from "./compat/aliases";
import { now, type AliasRow } from "./db";
import { isOwnAddress } from "./domains";
import { extractEmail, MAX_NOTE_LENGTH, normalizeEmail } from "./format";
import { readPublicKey, savePgpKey, syncPgpRecipients, type PgpKeyRow } from "./pgp";
import type { Settings } from "./settings";

export const MAX_RECIPIENTS = 100;
export const MAX_RECIPIENTS_PER_ALIAS = 10;

export type RecipientRow = {
	id: string;
	email: string;
	description: string | null;
	can_reply_send: number;
	should_encrypt: number;
	inline_encryption: number;
	protected_headers: number;
	remove_pgp_keys: number;
	remove_pgp_signatures: number;
	active: number;
	created_at: number;
	updated_at: number;
};

export type RecipientView = {
	id: string;
	numId: number;
	email: string;
	description: string | null;
	isDefault: boolean;
	aliasCount: number;
	canReplySend: boolean;
	shouldEncrypt: boolean;
	inlineEncryption: boolean;
	protectedHeaders: boolean;
	removePgpKeys: boolean;
	removePgpSignatures: boolean;
	fingerprint: string | null;
	active: boolean;
	createdAt: number;
	updatedAt: number;
};

export type RecipientFlag =
	| "can_reply_send"
	| "should_encrypt"
	| "inline_encryption"
	| "protected_headers"
	| "remove_pgp_keys"
	| "remove_pgp_signatures"
	| "active";

export class RecipientError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

/** Ensures a row exists in `recipients` for an address, migrating any existing pgp_keys flags. */
export async function ensureRecipientRow(db: D1Database, rawEmail: string, description: string | null = null): Promise<RecipientRow> {
	const email = normalizeEmail(rawEmail);
	const existing = await db.prepare("SELECT * FROM recipients WHERE email = ?").bind(email).first<RecipientRow>();
	if (existing) return existing;
	const { uid } = await destinationIds(email);
	const pgp = await db.prepare("SELECT * FROM pgp_keys WHERE email = ?").bind(email).first<PgpKeyRow>();
	const ts = now();
	await db
		.prepare(
			`INSERT INTO recipients (id, email, description, can_reply_send, should_encrypt, inline_encryption, protected_headers, remove_pgp_keys, remove_pgp_signatures, active, created_at, updated_at)
			 VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT (email) DO NOTHING`,
		)
		.bind(
			uid,
			email,
			description,
			pgp?.encrypt ? 1 : 0,
			pgp?.inline_encryption ? 1 : 0,
			pgp?.hide_subject ? 1 : 0,
			pgp?.remove_pgp_keys ? 1 : 0,
			pgp?.remove_pgp_signatures ? 1 : 0,
			ts,
			ts,
		)
		.run();
	return (await db.prepare("SELECT * FROM recipients WHERE email = ?").bind(email).first<RecipientRow>())!;
}

/**
 * Lists every known recipient: rows in `recipients`, the default destination, any address in
 * `aliases.destination` / `alias_recipients`, and any address in `pgp_keys`.
 */
export async function listRecipients(db: D1Database, settings: Settings): Promise<RecipientView[]> {
	const [recRes, attachCountsRes, fallbackCountsRes, pgpRes, domainRes] = await db.batch([
		db.prepare("SELECT * FROM recipients"),
		db.prepare(
			`SELECT lower(ar.recipient_email) AS email, COUNT(*) AS cnt
			 FROM alias_recipients ar
			 JOIN aliases a ON a.address = ar.alias_address
			 WHERE a.deleted_at IS NULL
			 GROUP BY lower(ar.recipient_email)`,
		),
		db.prepare(
			`SELECT lower(COALESCE(NULLIF(a.destination, ''), NULLIF(d.default_recipient, ''), '')) AS email, COUNT(*) AS cnt
			 FROM aliases a
			 LEFT JOIN domains d ON d.domain = lower(substr(a.address, instr(a.address, '@') + 1))
			 WHERE a.deleted_at IS NULL
			   AND NOT EXISTS (SELECT 1 FROM alias_recipients ar WHERE ar.alias_address = a.address)
			 GROUP BY lower(COALESCE(NULLIF(a.destination, ''), NULLIF(d.default_recipient, ''), ''))`,
		),
		db.prepare("SELECT * FROM pgp_keys"),
		db.prepare("SELECT domain, default_recipient FROM domains WHERE default_recipient IS NOT NULL AND default_recipient != ''"),
	]);

	const storedByEmail = new Map<string, RecipientRow>();
	for (const row of (recRes?.results ?? []) as RecipientRow[]) {
		storedByEmail.set(normalizeEmail(row.email), row);
	}
	const pgpByEmail = new Map<string, PgpKeyRow>();
	for (const row of (pgpRes?.results ?? []) as PgpKeyRow[]) {
		pgpByEmail.set(normalizeEmail(row.email), row);
	}

	const counts = new Map<string, number>();
	const addEmail = (email: string, delta: number) => {
		const normalized = normalizeEmail(email);
		if (!normalized || isOwnAddress(normalized, settings.aliasDomains)) return;
		counts.set(normalized, (counts.get(normalized) ?? 0) + delta);
	};

	for (const email of storedByEmail.keys()) addEmail(email, 0);
	for (const row of (domainRes?.results ?? []) as { domain: string; default_recipient: string }[]) {
		addEmail(row.default_recipient, 0);
	}
	if (settings.defaultDestination) addEmail(settings.defaultDestination, 0);

	for (const row of (attachCountsRes?.results ?? []) as { email: string; cnt: number }[]) {
		addEmail(row.email, Number(row.cnt ?? 0));
	}
	for (const row of (fallbackCountsRes?.results ?? []) as { email: string; cnt: number }[]) {
		const target = row.email || settings.defaultDestination;
		if (target) addEmail(target, Number(row.cnt ?? 0));
	}

	const out: RecipientView[] = [];
	for (const [email, aliasCount] of counts) {
		const { uid, numId } = await destinationIds(email);
		const row = storedByEmail.get(email);
		const pgp = pgpByEmail.get(email);
		const isDefault = email === settings.defaultDestination;
		// When pgp_keys has encryption toggled via the legacy /encryption page, honor it.
		const shouldEncrypt = pgp ? pgp.encrypt === 1 : (row?.should_encrypt === 1 || settings.pgpRecipients.includes(email));
		const protectedHeaders = pgp ? pgp.hide_subject === 1 : row?.protected_headers === 1;
		const inlineEncryption = pgp ? pgp.inline_encryption === 1 : row?.inline_encryption === 1;
		const removePgpKeys = row ? row.remove_pgp_keys === 1 : pgp?.remove_pgp_keys === 1;
		const removePgpSignatures = row ? row.remove_pgp_signatures === 1 : pgp?.remove_pgp_signatures === 1;
		out.push({
			id: row?.id ?? uid,
			numId,
			email,
			description: row?.description ?? (isDefault ? "Default" : null),
			isDefault,
			aliasCount,
			canReplySend: row ? row.can_reply_send === 1 : true,
			shouldEncrypt,
			inlineEncryption,
			protectedHeaders,
			removePgpKeys,
			removePgpSignatures,
			fingerprint: pgp?.fingerprint ?? null,
			active: row ? row.active === 1 : true,
			createdAt: row?.created_at ?? 946684800,
			updatedAt: row?.updated_at ?? 946684800,
		});
	}
	return out.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.email.localeCompare(b.email));
}

export async function findRecipientById(db: D1Database, settings: Settings, id: string): Promise<RecipientView | null> {
	const all = await listRecipients(db, settings);
	return all.find((r) => r.id === id || String(r.numId) === id) ?? null;
}

export async function findRecipientByEmail(db: D1Database, settings: Settings, email: string): Promise<RecipientView | null> {
	const normalized = normalizeEmail(email);
	const all = await listRecipients(db, settings);
	return all.find((r) => r.email === normalized) ?? null;
}

export async function createRecipient(db: D1Database, settings: Settings, rawEmail: string): Promise<RecipientView> {
	const email = extractEmail(rawEmail);
	if (!email || email !== rawEmail.trim().toLowerCase()) {
		throw new RecipientError(422, "Enter a valid email address.");
	}
	if (isOwnAddress(email, settings.aliasDomains)) {
		throw new RecipientError(422, "This recipient address would loop.");
	}
	const existing = await listRecipients(db, settings);
	if (existing.some((r) => r.email === email)) {
		throw new RecipientError(422, "This recipient already exists.");
	}
	if (existing.length >= MAX_RECIPIENTS) {
		throw new RecipientError(422, `At most ${MAX_RECIPIENTS} recipients are allowed.`);
	}
	await ensureRecipientRow(db, email);
	return (await findRecipientByEmail(db, settings, email))!;
}

export async function updateRecipient(db: D1Database, settings: Settings, id: string, input: { description?: string | null }): Promise<RecipientView> {
	const match = await findRecipientById(db, settings, id);
	if (!match) throw new RecipientError(404, "Not found");
	await ensureRecipientRow(db, match.email);
	if (input.description !== undefined) {
		const desc = input.description === null ? null : input.description.trim().slice(0, MAX_NOTE_LENGTH) || null;
		await db.prepare("UPDATE recipients SET description = ?, updated_at = ? WHERE email = ?").bind(desc, now(), match.email).run();
	}
	return (await findRecipientByEmail(db, settings, match.email))!;
}

export async function deleteRecipient(db: D1Database, settings: Settings, id: string): Promise<void> {
	const match = await findRecipientById(db, settings, id);
	if (!match) throw new RecipientError(404, "Not found");
	if (match.isDefault) {
		throw new RecipientError(422, "Cannot delete the default recipient. Set another default recipient first.");
	}
	const ts = now();
	await db.batch([
		db.prepare("DELETE FROM alias_recipients WHERE recipient_email = ?").bind(match.email),
		db.prepare("UPDATE aliases SET destination = NULL, updated_at = ? WHERE destination = ?").bind(ts, match.email),
		db.prepare("UPDATE domains SET default_recipient = NULL, updated_at = ? WHERE default_recipient = ?").bind(ts, match.email),
		db.prepare("DELETE FROM pgp_keys WHERE email = ?").bind(match.email),
		db.prepare("DELETE FROM recipients WHERE email = ?").bind(match.email),
	]);
	await syncPgpRecipients(db);
}

/** Updates one boolean flag on a recipient, keeping pgp_keys and settings.pgpRecipients in sync. */
export async function setRecipientFlag(db: D1Database, settings: Settings, id: string, flag: RecipientFlag, value: boolean): Promise<RecipientView> {
	const match = await findRecipientById(db, settings, id);
	if (!match) throw new RecipientError(404, "Not found");
	if ((flag === "should_encrypt" || flag === "inline_encryption" || flag === "protected_headers") && value && !match.fingerprint) {
		throw new RecipientError(422, "Add a PGP public key for this recipient before enabling encryption.");
	}
	if (flag === "active" && !value && match.isDefault) {
		throw new RecipientError(422, "Cannot deactivate the default recipient.");
	}
	await ensureRecipientRow(db, match.email);
	const ts = now();
	const intVal = value ? 1 : 0;
	const statements: D1PreparedStatement[] = [
		db.prepare(`UPDATE recipients SET ${flag} = ?, updated_at = ? WHERE email = ?`).bind(intVal, ts, match.email),
	];
	if (flag === "should_encrypt") {
		statements.push(db.prepare("UPDATE pgp_keys SET encrypt = ?, updated_at = ? WHERE email = ?").bind(intVal, ts, match.email));
	} else if (flag === "protected_headers") {
		statements.push(db.prepare("UPDATE pgp_keys SET hide_subject = ?, updated_at = ? WHERE email = ?").bind(intVal, ts, match.email));
	} else if (flag === "inline_encryption") {
		statements.push(db.prepare("UPDATE pgp_keys SET inline_encryption = ?, updated_at = ? WHERE email = ?").bind(intVal, ts, match.email));
	} else if (flag === "remove_pgp_keys") {
		statements.push(db.prepare("UPDATE pgp_keys SET remove_pgp_keys = ?, updated_at = ? WHERE email = ?").bind(intVal, ts, match.email));
	} else if (flag === "remove_pgp_signatures") {
		statements.push(db.prepare("UPDATE pgp_keys SET remove_pgp_signatures = ?, updated_at = ? WHERE email = ?").bind(intVal, ts, match.email));
	}
	await db.batch(statements);
	if (flag === "should_encrypt") await syncPgpRecipients(db);
	return (await findRecipientByEmail(db, settings, match.email))!;
}

/** Uploads or replaces a recipient's PGP public key (refuses private, expired, invalid, or WKD-shared keys). */
export async function setRecipientKey(db: D1Database, settings: Settings, id: string, armoredKey: string): Promise<RecipientView> {
	const match = await findRecipientById(db, settings, id);
	if (!match) throw new RecipientError(404, "Not found");
	await ensureRecipientRow(db, match.email);
	const parsed = await readPublicKey(armoredKey);
	await savePgpKey(db, match.email, parsed);
	// In addy.io, uploading a key turns encryption on for that recipient by default.
	const ts = now();
	await db.batch([
		db.prepare("UPDATE pgp_keys SET encrypt = 1, updated_at = ? WHERE email = ?").bind(ts, match.email),
		db.prepare("UPDATE recipients SET should_encrypt = 1, updated_at = ? WHERE email = ?").bind(ts, match.email),
	]);
	await syncPgpRecipients(db);
	return (await findRecipientByEmail(db, settings, match.email))!;
}

/** Removes a recipient's PGP public key and turns off PGP encryption flags. */
export async function deleteRecipientKey(db: D1Database, settings: Settings, id: string): Promise<RecipientView> {
	const match = await findRecipientById(db, settings, id);
	if (!match) throw new RecipientError(404, "Not found");
	const ts = now();
	await db.batch([
		db.prepare("DELETE FROM pgp_keys WHERE email = ?").bind(match.email),
		db
			.prepare("UPDATE recipients SET should_encrypt = 0, inline_encryption = 0, protected_headers = 0, updated_at = ? WHERE email = ?")
			.bind(ts, match.email),
	]);
	await syncPgpRecipients(db);
	return (await findRecipientByEmail(db, settings, match.email))!;
}

/** Explicit attached recipient emails for a batch of aliases. */
export async function attachedRecipientsMap(db: D1Database, aliasAddresses: string[]): Promise<Map<string, string[]>> {
	const map = new Map<string, string[]>();
	const unique = [...new Set(aliasAddresses)];
	for (let i = 0; i < unique.length; i += 90) {
		const chunk = unique.slice(i, i + 90);
		const { results } = await db
			.prepare(`SELECT alias_address, recipient_email FROM alias_recipients WHERE alias_address IN (${chunk.map(() => "?").join(", ")}) ORDER BY position ASC`)
			.bind(...chunk)
			.all<{ alias_address: string; recipient_email: string }>();
		for (const row of results) {
			const list = map.get(row.alias_address) ?? [];
			list.push(normalizeEmail(row.recipient_email));
			map.set(row.alias_address, list);
		}
	}
	return map;
}

/**
 * Sets an alias's attached recipients (supports 0..MAX_RECIPIENTS_PER_ALIAS).
 * Keeps `aliases.destination` synced with the primary recipient (or null when empty/default-only)
 * so legacy single-destination callers keep working.
 */
export async function setAliasRecipients(db: D1Database, addresses: string[], emails: string[], defaultDestination: string): Promise<void> {
	if (!addresses.length) return;
	const uniqueEmails = [...new Set(emails.map(normalizeEmail).filter(Boolean))].slice(0, MAX_RECIPIENTS_PER_ALIAS);
	const ts = now();
	const primary = uniqueEmails.length === 0 ? null : uniqueEmails.length === 1 && uniqueEmails[0] === defaultDestination ? null : uniqueEmails[0]!;
	const statements: D1PreparedStatement[] = [];
	for (const address of addresses) {
		statements.push(db.prepare("DELETE FROM alias_recipients WHERE alias_address = ?").bind(address));
		for (let pos = 0; pos < uniqueEmails.length; pos += 1) {
			statements.push(
				db
					.prepare("INSERT INTO alias_recipients (alias_address, recipient_email, position) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
					.bind(address, uniqueEmails[pos], pos),
			);
		}
		statements.push(
			db.prepare("UPDATE aliases SET destination = ?, updated_at = ? WHERE address = ? AND deleted_at IS NULL").bind(primary, ts, address),
		);
	}
	for (let i = 0; i < statements.length; i += 100) {
		await db.batch(statements.slice(i, i + 100));
	}
}

/** Effective target recipient emails for an alias (for forwarding). */
export async function effectiveAliasDestinations(
	db: D1Database,
	alias: Pick<AliasRow, "address" | "destination">,
	settings: Settings,
	domainDefaultRecipient?: string | null,
): Promise<string[]> {
	const { results } = await db
		.prepare("SELECT recipient_email FROM alias_recipients WHERE alias_address = ? ORDER BY position ASC")
		.bind(alias.address)
		.all<{ recipient_email: string }>();
	if (results.length > 0) {
		return [...new Set(results.map((r) => normalizeEmail(r.recipient_email)))];
	}
	const fallback = alias.destination?.toLowerCase() || domainDefaultRecipient?.toLowerCase() || settings.defaultDestination;
	return fallback ? [normalizeEmail(fallback)] : [];
}

export type RecipientPolicy = {
	active: boolean;
	canReplySend: boolean;
	shouldEncrypt: boolean;
	inlineEncryption: boolean;
	protectedHeaders: boolean;
	removePgpKeys: boolean;
	removePgpSignatures: boolean;
	pgpKey: PgpKeyRow | null;
};

function buildRecipientPolicy(rec: RecipientRow | null, pgp: PgpKeyRow | null): RecipientPolicy {
	const shouldEncrypt = pgp ? pgp.encrypt === 1 : rec?.should_encrypt === 1;
	const protectedHeaders = pgp ? pgp.hide_subject === 1 : rec?.protected_headers === 1;
	const inlineEncryption = pgp ? pgp.inline_encryption === 1 : rec?.inline_encryption === 1;
	const removePgpKeys = rec ? rec.remove_pgp_keys === 1 : pgp?.remove_pgp_keys === 1;
	const removePgpSignatures = rec ? rec.remove_pgp_signatures === 1 : pgp?.remove_pgp_signatures === 1;
	return {
		active: rec ? rec.active === 1 : true,
		canReplySend: rec ? rec.can_reply_send === 1 : true,
		shouldEncrypt,
		inlineEncryption,
		protectedHeaders,
		removePgpKeys,
		removePgpSignatures,
		pgpKey: pgp,
	};
}

/** Loads recipient behavior row + pgp key row for one destination email. */
export async function recipientPolicy(db: D1Database, email: string): Promise<RecipientPolicy> {
	const normalized = normalizeEmail(email);
	const [recRes, pgpRes] = await db.batch([
		db.prepare("SELECT * FROM recipients WHERE email = ?").bind(normalized),
		db.prepare("SELECT * FROM pgp_keys WHERE email = ?").bind(normalized),
	]);
	const rec = (recRes?.results?.[0] as RecipientRow | undefined) ?? null;
	const pgp = (pgpRes?.results?.[0] as PgpKeyRow | undefined) ?? null;
	return buildRecipientPolicy(rec, pgp);
}

/** Batch-loads recipient policies for multiple destination emails in one D1 round trip. */
export async function recipientPolicies(db: D1Database, emails: string[]): Promise<Map<string, RecipientPolicy>> {
	const unique = [...new Set(emails.map(normalizeEmail).filter(Boolean))];
	const map = new Map<string, RecipientPolicy>();
	if (!unique.length) return map;
	const marks = unique.map(() => "?").join(", ");
	const [recRes, pgpRes] = await db.batch([
		db.prepare(`SELECT * FROM recipients WHERE email IN (${marks})`).bind(...unique),
		db.prepare(`SELECT * FROM pgp_keys WHERE email IN (${marks})`).bind(...unique),
	]);
	const recByEmail = new Map<string, RecipientRow>();
	for (const row of (recRes?.results ?? []) as RecipientRow[]) recByEmail.set(normalizeEmail(row.email), row);
	const pgpByEmail = new Map<string, PgpKeyRow>();
	for (const row of (pgpRes?.results ?? []) as PgpKeyRow[]) pgpByEmail.set(normalizeEmail(row.email), row);
	for (const email of unique) {
		map.set(email, buildRecipientPolicy(recByEmail.get(email) ?? null, pgpByEmail.get(email) ?? null));
	}
	return map;
}
