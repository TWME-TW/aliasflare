import { signToken } from "../../src/crypto";
import { translator, type MessageKey } from "../../src/i18n";

export const TEST_SECRET = "test-signing-secret-that-is-long-enough-0123456789";

/** Adds a passkey and a session for it, and returns the Cookie header that carries the session. */
export async function signIn(db: D1Database, secret = TEST_SECRET): Promise<string> {
	await db
		.prepare("INSERT OR IGNORE INTO passkeys (id, public_key, counter, name, created_at) VALUES ('pk1', 'key', 0, 'Test', 1)")
		.run();
	const id = `s${crypto.randomUUID().replace(/-/g, "")}`;
	await db.prepare("INSERT INTO sessions (id, passkey_id, created_at, expires_at) VALUES (?, 'pk1', 1, ?)").bind(id, Math.floor(Date.now() / 1000) + 600).run();
	return `__Host-mfa_session=${await signToken(secret, "session", id, 600)}`;
}

/** The notice a redirect asks the next page to show, in English. */
export function noticeOf(location: string | null): string {
	const url = new URL(location ?? "/", "https://alias.test");
	const key = url.searchParams.get("notice");
	if (!key) return "";
	const params: Record<string, string> = {};
	for (const [name, value] of url.searchParams) if (name.startsWith("n.")) params[name.slice(2)] = value;
	return translator("en")(key as MessageKey, params);
}
