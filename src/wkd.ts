/**
 * Web Key Directory (draft-koch-openpgp-webkey-service) for single aliases. An alias with WKD on
 * publishes a public key made for it alone, so a sender's app (Thunderbird, GnuPG, Proton, …)
 * finds it and encrypts mail to the alias; that mail is forwarded with its body untouched and
 * the owner decrypts it with that key. aliasflare never holds a private key.
 *
 * Only the advanced method's host is meant to be routed here: openpgpkey.<alias domain>, so the
 * domain's own website is not touched. The direct method's paths answer too, for a domain whose
 * apex is routed to this Worker anyway.
 *
 * A key must name the alias and nothing else: one that also carried the owner's own address, or
 * that is used for another alias or a forwarding address, would tie the alias to them.
 */
import { now } from "./db";
import { readPublicKey } from "./pgp";
import { bytesToBase64 } from "./crypto";
import { extractEmail } from "./format";

export const WKD_SUBDOMAIN = "openpgpkey";

export type WkdKeyRow = { alias_address: string; domain: string; hash: string; fingerprint: string; key_binary: string; created_at: number };

export class WkdError extends Error {
	constructor(readonly reason: "otherAddress" | "keyInUse") {
		super(reason);
	}
}

const ZBASE32 = "ybndrfg8ejkmcpqxot1uwisza345h769";

/** z-base-32 (RFC 6189) of the bytes, as WKD uses for the hashed local part. */
export function zbase32(bytes: Uint8Array): string {
	let out = "";
	let buffer = 0;
	let bits = 0;
	for (const byte of bytes) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += ZBASE32[(buffer >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += ZBASE32[(buffer << (5 - bits)) & 31];
	return out;
}

/** The WKD hash of an address's local part: z-base-32 of the SHA-1 of it in lower case. */
export async function wkdHash(address: string): Promise<string> {
	const local = address.slice(0, address.lastIndexOf("@")).toLowerCase();
	return zbase32(new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(local))));
}

/** Reads a key for an alias: public, able to encrypt, and with no user ID but the alias's. */
export async function readWkdKey(armored: string, alias: string): Promise<{ binary: string; fingerprint: string }> {
	const { readKey } = await import("openpgp");
	// The common checks (not private, not expired, can encrypt) first.
	const checked = await readPublicKey(armored);
	const key = await readKey({ armoredKey: checked.armored });
	const userIds = key.users.map((user) => user.userID?.userID ?? "").filter((id) => id);
	if (!userIds.length || userIds.some((id) => extractEmail(id.includes("<") ? id.slice(id.lastIndexOf("<")) : id) !== alias)) throw new WkdError("otherAddress");
	return { binary: bytesToBase64(key.write()), fingerprint: checked.fingerprint };
}

export async function wkdKeyOf(db: D1Database, alias: string): Promise<WkdKeyRow | null> {
	return await db.prepare("SELECT * FROM wkd_keys WHERE alias_address = ?").bind(alias).first<WkdKeyRow>();
}

/** Publishes the key for the alias, refusing one in use for another alias or a forwarding address. */
export async function saveWkdKey(db: D1Database, alias: string, key: { binary: string; fingerprint: string }): Promise<void> {
	const [elsewhere, forwarding] = await db.batch([
		db.prepare("SELECT 1 FROM wkd_keys WHERE fingerprint = ? AND alias_address != ?").bind(key.fingerprint, alias),
		db.prepare("SELECT 1 FROM pgp_keys WHERE fingerprint = ?").bind(key.fingerprint),
	]);
	if (elsewhere!.results.length || forwarding!.results.length) throw new WkdError("keyInUse");
	const domain = alias.slice(alias.lastIndexOf("@") + 1);
	await db
		.prepare(
			`INSERT INTO wkd_keys (alias_address, domain, hash, fingerprint, key_binary, created_at) VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT (alias_address) DO UPDATE SET fingerprint = excluded.fingerprint, key_binary = excluded.key_binary, created_at = excluded.created_at`,
		)
		.bind(alias, domain, await wkdHash(alias), key.fingerprint, key.binary, now())
		.run();
}

/** The key published for a hashed local part on a domain, if its alias is still live. */
export async function lookupWkdKey(db: D1Database, domain: string, hash: string): Promise<Uint8Array | null> {
	const row = await db
		.prepare("SELECT w.key_binary FROM wkd_keys w JOIN aliases a ON a.address = w.alias_address WHERE w.domain = ? AND w.hash = ? AND a.deleted_at IS NULL")
		.bind(domain, hash)
		.first<{ key_binary: string }>();
	if (!row) return null;
	return Uint8Array.from(atob(row.key_binary), (char) => char.charCodeAt(0));
}
