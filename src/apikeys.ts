import { newId, now } from "./db";

/**
 * API keys for SimpleLogin and addy.io clients. A key is shown once when it is created; only its
 * SHA-256 hash is stored, so a database leak does not reveal usable keys.
 */

/** What a key is for: the SimpleLogin and addy.io apps, or the MCP server. A key works only for its own. */
export type ApiKeyScope = "apps" | "mcp";
export const API_KEY_SCOPES: ApiKeyScope[] = ["apps", "mcp"];

export type ApiKeyRow = { id: string; name: string; prefix: string; scope: ApiKeyScope; created_at: number; last_used_at: number | null };

const KEY_PREFIX = "af_";
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomKey(): string {
	// 40 characters from 62 symbols, about 238 bits. Rejection sampling keeps every symbol equally likely.
	const out: string[] = [];
	while (out.length < 40) {
		for (const byte of crypto.getRandomValues(new Uint8Array(64))) {
			if (byte < 248 && out.length < 40) out.push(ALPHABET[byte % 62]!);
		}
	}
	return KEY_PREFIX + out.join("");
}

export async function createApiKey(db: D1Database, name: string, scope: ApiKeyScope = "apps"): Promise<{ key: string; row: ApiKeyRow }> {
	const key = randomKey();
	const row: ApiKeyRow = { id: newId("key"), name: name.trim().slice(0, 60) || "API key", prefix: key.slice(0, 10), scope, created_at: now(), last_used_at: null };
	await db
		.prepare("INSERT INTO api_keys (id, name, prefix, hash, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)")
		.bind(row.id, row.name, row.prefix, await sha256Hex(key), row.scope, row.created_at)
		.run();
	return { key, row };
}

export async function listApiKeys(db: D1Database): Promise<ApiKeyRow[]> {
	const { results } = await db.prepare("SELECT id, name, prefix, scope, created_at, last_used_at FROM api_keys ORDER BY created_at").all<ApiKeyRow>();
	return results;
}

export async function deleteApiKey(db: D1Database, id: string): Promise<void> {
	await db.prepare("DELETE FROM api_keys WHERE id = ?").bind(id).run();
}

/**
 * Reads the key from SimpleLogin's `Authentication: <key>` header or the usual
 * `Authorization: Bearer <key>` that addy.io clients send.
 */
export function presentedKey(headers: { get(name: string): string | null }): string | null {
	const bearer = headers.get("Authorization")?.match(/^Bearer\s+(\S+)\s*$/i)?.[1];
	const plain = headers.get("Authentication")?.trim();
	const key = bearer || plain || null;
	return key && key.startsWith(KEY_PREFIX) && key.length <= 100 ? key : null;
}

/** Returns the matching key of this scope, recording when it was last used (at most once a minute). */
export async function verifyApiKey(db: D1Database, key: string, scope: ApiKeyScope): Promise<ApiKeyRow | null> {
	const row = await db
		.prepare("SELECT id, name, prefix, scope, created_at, last_used_at FROM api_keys WHERE hash = ? AND scope = ?")
		.bind(await sha256Hex(key), scope)
		.first<ApiKeyRow>();
	if (row && (row.last_used_at ?? 0) < now() - 60) {
		await db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(now(), row.id).run();
	}
	return row;
}
