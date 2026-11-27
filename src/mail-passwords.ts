/**
 * Mail App Passwords for IMAP / POP3 / SMTP access through the Mail Gateway API and Bridge.
 * Each password is shown once upon creation; only its SHA-256 hash is persisted in D1.
 */
import { sha256Hex } from "./apikeys";
import { newId, now } from "./db";

export type MailProtocol = "imap" | "pop3" | "smtp";

export type MailPasswordRow = {
	id: string;
	name: string;
	username: string;
	prefix: string;
	allow_imap: number;
	allow_pop3: number;
	allow_smtp: number;
	created_at: number;
	last_used_at: number | null;
	last_country: string | null;
};

const PASSWORD_PREFIX = "afm_";
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function randomMailPassword(): string {
	const out: string[] = [];
	while (out.length < 40) {
		for (const byte of crypto.getRandomValues(new Uint8Array(64))) {
			if (byte < 248 && out.length < 40) out.push(ALPHABET[byte % 62]!);
		}
	}
	return PASSWORD_PREFIX + out.join("");
}

export function cleanMailUsername(raw: string): string {
	const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9._@+-]/g, "").slice(0, 120);
	return cleaned || "aliasflare";
}

export async function createMailPassword(
	db: D1Database,
	input: { name: string; username?: string; allowImap?: boolean; allowPop3?: boolean; allowSmtp?: boolean },
): Promise<{ password: string; row: MailPasswordRow }> {
	const password = randomMailPassword();
	const allowImap = input.allowImap !== false ? 1 : 0;
	const allowPop3 = input.allowPop3 === true ? 1 : 0;
	const allowSmtp = input.allowSmtp !== false ? 1 : 0;
	const row: MailPasswordRow = {
		id: newId("mpw"),
		name: input.name.trim().slice(0, 60) || "Mail client",
		username: cleanMailUsername(input.username ?? "aliasflare"),
		prefix: password.slice(0, 11),
		allow_imap: allowImap,
		allow_pop3: allowPop3,
		allow_smtp: allowSmtp,
		created_at: now(),
		last_used_at: null,
		last_country: null,
	};
	await db
		.prepare(
			`INSERT INTO mail_passwords (id, name, username, prefix, hash, allow_imap, allow_pop3, allow_smtp, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(row.id, row.name, row.username, row.prefix, await sha256Hex(password), row.allow_imap, row.allow_pop3, row.allow_smtp, row.created_at)
		.run();
	return { password, row };
}

export async function listMailPasswords(db: D1Database): Promise<MailPasswordRow[]> {
	const { results } = await db
		.prepare("SELECT id, name, username, prefix, allow_imap, allow_pop3, allow_smtp, created_at, last_used_at, last_country FROM mail_passwords ORDER BY created_at DESC")
		.all<MailPasswordRow>();
	return results;
}

export async function deleteMailPassword(db: D1Database, id: string): Promise<void> {
	await db.prepare("DELETE FROM mail_passwords WHERE id = ?").bind(id).run();
}

/** Parses Basic (`username:afm_...`) or Bearer (`afm_...`) credentials from request headers. */
export function parseMailCredentials(headers: { get(name: string): string | null }): { username: string | null; password: string } | null {
	const auth = headers.get("Authorization")?.trim() ?? "";
	const basic = auth.match(/^Basic\s+([A-Za-z0-9+/=]+)$/i)?.[1];
	if (basic) {
		try {
			const decoded = atob(basic);
			const colon = decoded.indexOf(":");
			if (colon < 0) return null;
			const username = decoded.slice(0, colon).trim().toLowerCase();
			const password = decoded.slice(colon + 1);
			if (!password.startsWith(PASSWORD_PREFIX) || password.length > 100) return null;
			return { username: username || null, password };
		} catch {
			return null;
		}
	}
	const bearer = auth.match(/^Bearer\s+(\S+)$/i)?.[1];
	if (bearer && bearer.startsWith(PASSWORD_PREFIX) && bearer.length <= 100) {
		const userHeader = headers.get("X-Mail-Username")?.trim().toLowerCase() || null;
		return { username: userHeader, password: bearer };
	}
	return null;
}

/** Verifies a mail app password and optional protocol scope; updates last_used_at/last_country. */
export async function verifyMailPassword(
	db: D1Database,
	creds: { username: string | null; password: string },
	protocol?: MailProtocol,
	country: string | null = null,
): Promise<MailPasswordRow | null> {
	if (!creds.password.startsWith(PASSWORD_PREFIX)) return null;
	const row = await db
		.prepare("SELECT id, name, username, prefix, allow_imap, allow_pop3, allow_smtp, created_at, last_used_at, last_country FROM mail_passwords WHERE hash = ?")
		.bind(await sha256Hex(creds.password))
		.first<MailPasswordRow>();
	if (!row) return null;
	// If a username was supplied (e.g. IMAP/POP3/SMTP LOGIN), it must match the credential's username.
	if (creds.username && row.username.toLowerCase() !== creds.username.toLowerCase()) return null;
	if (protocol === "imap" && !row.allow_imap) return null;
	if (protocol === "pop3" && !row.allow_pop3) return null;
	if (protocol === "smtp" && !row.allow_smtp) return null;

	const moved = !!country && country !== row.last_country;
	// Match sessions' 5-minute throttle so active IMAP/Bridge polling does not burn D1 writes.
	if ((row.last_used_at ?? 0) < now() - 300 || moved) {
		await db
			.prepare("UPDATE mail_passwords SET last_used_at = ?, last_country = COALESCE(?, last_country) WHERE id = ?")
			.bind(now(), country, row.id)
			.run();
	}
	return row;
}
