/**
 * PGP encryption of forwarded mail (as addy.io does it): each forwarding address can have a public
 * key, and mail to an address with encryption on goes out as PGP/MIME (RFC 3156) or PGP/Inline
 * (when inline_encryption is enabled). It is off until it is turned on.
 *
 * openpgp is loaded only when a key is read or a message encrypted, so a Worker that never
 * encrypts never pays for it.
 */
import { buildEncryptedMime, buildWithEntity, encryptedPayload, newMessageId, type EncryptedMessage, type Entity } from "./mime";
import { now } from "./db";
import { normalizeEmail } from "./format";
import { saveSettingKeys } from "./settings";

export const MAX_KEY_LENGTH = 100_000;

export type PgpKeyRow = {
	email: string;
	public_key: string;
	fingerprint: string;
	encrypt: number;
	hide_subject: number;
	inline_encryption?: number;
	remove_pgp_keys?: number;
	remove_pgp_signatures?: number;
	created_at: number;
	updated_at: number;
};

export class PgpError extends Error {
	constructor(readonly reason: "invalid" | "private" | "noEncryption" | "expired" | "tooLarge" | "keyInUse") {
		super(reason);
	}
}

const openpgp = () => import("openpgp");

/** Reads a public key someone pasted: its fingerprint, or why it cannot be used. */
export async function readPublicKey(armored: string): Promise<{ armored: string; fingerprint: string; userIds: string[] }> {
	const text = armored.trim();
	if (text.length > MAX_KEY_LENGTH) throw new PgpError("tooLarge");
	// A private key is refused before it is read: it must never be stored here.
	if (/-----BEGIN PGP PRIVATE KEY BLOCK-----/.test(text)) throw new PgpError("private");
	const { readKey } = await openpgp();
	let key: Awaited<ReturnType<typeof readKey>>;
	try {
		key = await readKey({ armoredKey: text });
	} catch {
		throw new PgpError("invalid");
	}
	if (key.isPrivate()) throw new PgpError("private");
	const expires = await key.getExpirationTime().catch(() => null);
	if (expires instanceof Date && expires.getTime() < Date.now()) throw new PgpError("expired");
	try {
		await key.getEncryptionKey();
	} catch {
		throw new PgpError("noEncryption");
	}
	return { armored: key.armor(), fingerprint: key.getFingerprint().toUpperCase(), userIds: key.getUserIDs().slice(0, 5) };
}

/** The fingerprint in groups of four, as apps show it. */
export function formatFingerprint(fingerprint: string): string {
	return fingerprint.replace(/(.{4})(?=.)/g, "$1 ");
}

/** The key of a forwarding address that has encryption on, if any. */
export async function encryptionKeyFor(db: D1Database, email: string): Promise<PgpKeyRow | null> {
	return await db.prepare("SELECT * FROM pgp_keys WHERE email = ? AND encrypt = 1").bind(normalizeEmail(email)).first<PgpKeyRow>();
}

/** The key of a forwarding address regardless of its encrypt flag (for rule-forced encryption). */
export async function anyPgpKeyFor(db: D1Database, email: string): Promise<PgpKeyRow | null> {
	return await db.prepare("SELECT * FROM pgp_keys WHERE email = ?").bind(normalizeEmail(email)).first<PgpKeyRow>();
}

/** The whole message, encrypted to the key, as raw PGP/MIME, with its Message-ID. */
export async function encryptMessage(message: EncryptedMessage, key: Pick<PgpKeyRow, "public_key" | "hide_subject">, entity?: Entity): Promise<{ raw: string; messageId: string }> {
	const { createMessage, encrypt, readKey } = await openpgp();
	const encryptionKeys = await readKey({ armoredKey: key.public_key });
	const armored = await encrypt({
		message: await createMessage({ binary: encryptedPayload(message, !!key.hide_subject, entity) }),
		encryptionKeys,
		format: "armored",
	});
	const messageId = newMessageId(message.from);
	return { raw: buildEncryptedMime(message, messageId, armored as string, !!key.hide_subject), messageId };
}

/** Encrypts plain text as an inline ASCII-armored OpenPGP message (addy.io's inline_encryption). */
export async function encryptInlineText(text: string, publicKeyArmored: string): Promise<string> {
	const { createMessage, encrypt, readKey } = await openpgp();
	const encryptionKeys = await readKey({ armoredKey: publicKeyArmored });
	const armored = await encrypt({
		message: await createMessage({ text }),
		encryptionKeys,
		format: "armored",
	});
	return armored as string;
}

/**
 * Writes down in the settings which addresses have encryption on. The settings are read for every
 * message anyway, so mail to an address without encryption costs no query for a key.
 */
export async function syncPgpRecipients(db: D1Database): Promise<void> {
	const { results } = await db.prepare("SELECT email FROM pgp_keys WHERE encrypt = 1 ORDER BY email").all<{ email: string }>();
	await saveSettingKeys(db, { pgpRecipients: results.map((row) => row.email) });
}

/** Every key, for the encryption page. */
export async function listPgpKeys(db: D1Database): Promise<PgpKeyRow[]> {
	return (await db.prepare("SELECT * FROM pgp_keys ORDER BY email").all<PgpKeyRow>()).results;
}

/**
 * Saves or replaces an address's key; encryption stays as it was (off for a new key). A key already
 * published for an alias by WKD is refused: it would tie that alias to this forwarding address,
 * which is the one thing a per-alias key must not do. The other order is refused when a WKD key is
 * saved (see wkd.ts), so neither direction can pair an alias with a real mailbox.
 */
export async function savePgpKey(db: D1Database, email: string, key: { armored: string; fingerprint: string }): Promise<void> {
	const timestamp = now();
	const result = await db
		.prepare(
			`INSERT INTO pgp_keys (email, public_key, fingerprint, encrypt, hide_subject, created_at, updated_at)
			 SELECT ?, ?, ?, 0, 0, ?, ?
			 WHERE NOT EXISTS (SELECT 1 FROM wkd_keys WHERE fingerprint = ?)
			 ON CONFLICT (email) DO UPDATE SET public_key = excluded.public_key, fingerprint = excluded.fingerprint, updated_at = excluded.updated_at`,
		)
		.bind(normalizeEmail(email), key.armored, key.fingerprint, timestamp, timestamp, key.fingerprint)
		.run();
	if ((result.meta.changes ?? 0) === 0) throw new PgpError("keyInUse");
}

/** Encrypts a forwarded message and sends it as raw PGP/MIME through Email Sending. */
export async function sendEncrypted(env: Env, message: Outgoing, key: PgpKeyRow, entity?: Entity): Promise<{ messageId?: string }> {
	const { raw, messageId } = await encryptMessage(message, key, entity);
	return await sendRaw(env, message, raw, messageId);
}

/** Encrypts a forwarded message using Inline PGP (plain text body encrypted; attachments encrypted or dropped as per inline PGP). */
export async function sendInlineEncrypted(env: Env, message: Outgoing, key: PgpKeyRow): Promise<{ messageId?: string }> {
	const plain = message.text || (message.html ? message.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "");
	const armored = await encryptInlineText(plain, key.public_key);
	const result = (await env.EMAIL.send({
		from: message.from,
		to: message.to,
		replyTo: message.replyTo,
		subject: message.subject,
		headers: message.headers,
		text: armored,
	})) as { messageId?: string } | undefined;
	return { messageId: result?.messageId };
}

/**
 * Sends mail that is PGP encrypted or signed already with its own body exactly as it came, under
 * our headers: rebuilding it would break the encryption's structure or the signature.
 */
export async function sendKept(env: Env, message: Outgoing, entity: Entity): Promise<{ messageId?: string }> {
	const messageId = newMessageId(message.from);
	return await sendRaw(env, message, new Response(buildWithEntity(message, messageId, entity)).body!, messageId);
}

/** True when an attachment is an attached OpenPGP public key. */
export function isPgpKeyAttachment(attachment: { filename?: string | null; mimeType?: string | null }): boolean {
	const type = (attachment.mimeType ?? "").trim().toLowerCase();
	if (type === "application/pgp-keys") return true;
	const name = (attachment.filename ?? "").trim().toLowerCase();
	return name.endsWith(".asc") && (name.includes("openpgp") || name.includes("pubkey") || name.includes("publickey") || name.startsWith("0x"));
}

/** True when an attachment is an OpenPGP detached signature. */
export function isPgpSignatureAttachment(attachment: { filename?: string | null; mimeType?: string | null }): boolean {
	const type = (attachment.mimeType ?? "").trim().toLowerCase();
	if (type === "application/pgp-signature") return true;
	const name = (attachment.filename ?? "").trim().toLowerCase();
	return name === "signature.asc" || name.endsWith(".sig");
}

type Outgoing = EncryptedMessage & { to: { name: string; email: string } };

async function sendRaw(env: Env, message: Outgoing, raw: string | ReadableStream, messageId: string): Promise<{ messageId?: string }> {
	const { EmailMessage } = await import("cloudflare:email");
	const from = typeof message.from === "string" ? message.from : message.from.email;
	const result = (await env.EMAIL.send(new EmailMessage(from, message.to.email, raw))) as { messageId?: string } | undefined;
	return { messageId: result?.messageId ?? messageId };
}
