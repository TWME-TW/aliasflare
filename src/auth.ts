import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppConfig } from "./config";
import { signToken, verifyToken } from "./crypto";
import { now } from "./db";
import { randomToken } from "./format";
import type { Translate } from "./i18n";

export type AppEnv = { Bindings: Env; Variables: { config: AppConfig; t: Translate } };

// Sent as __Host-af_session and __Host-af_challenge: Secure, Path=/ and no Domain, so a
// sibling subdomain cannot set or overwrite them.
export const SESSION_COOKIE = "af_session";
export const CHALLENGE_COOKIE = "af_challenge";
const COOKIE_PREFIX = "host" as const;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

/**
 * Starts a session for a passkey. The cookie holds a signed random id; the session itself
 * lives in D1, so signing out or removing the passkey ends it right away.
 */
export async function startSession(c: Context<AppEnv>, passkeyId: string): Promise<void> {
	const db = c.env.DB;
	const id = randomToken(32);
	const timestamp = now();
	await db.batch([
		db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(timestamp),
		db.prepare("INSERT INTO sessions (id, passkey_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(id, passkeyId, timestamp, timestamp + SESSION_TTL_SECONDS),
	]);
	const token = await signToken(c.get("config").signingSecret, "session", id, SESSION_TTL_SECONDS);
	setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: SESSION_TTL_SECONDS, prefix: COOKIE_PREFIX });
}

async function sessionId(c: Context<AppEnv>): Promise<string | null> {
	const token = getCookie(c, SESSION_COOKIE, COOKIE_PREFIX);
	return token ? verifyToken(c.get("config").signingSecret, "session", token) : null;
}

export async function endSession(c: Context<AppEnv>): Promise<void> {
	const id = await sessionId(c);
	if (id) await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
	deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true, prefix: COOKIE_PREFIX });
}

export function setChallengeCookie(c: Context, id: string): void {
	setCookie(c, CHALLENGE_COOKIE, id, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: 300, prefix: COOKIE_PREFIX });
}

export function takeChallengeCookie(c: Context): string | undefined {
	const id = getCookie(c, CHALLENGE_COOKIE, COOKIE_PREFIX);
	deleteCookie(c, CHALLENGE_COOKIE, { path: "/", secure: true, prefix: COOKIE_PREFIX });
	return id;
}

export async function isSignedIn(c: Context<AppEnv>): Promise<boolean> {
	const id = await sessionId(c);
	if (!id) return false;
	const row = await c.env.DB.prepare("SELECT 1 AS ok FROM sessions WHERE id = ? AND expires_at >= ?").bind(id, now()).first<{ ok: number }>();
	return !!row;
}

/**
 * True when a state-changing request comes from this site. Browsers send `Origin: null` on form posts
 * under some referrer policies and privacy settings; then only `Sec-Fetch-Site: same-origin` counts.
 * A request with neither header is refused: every current browser sends at least one of them.
 */
export function sameOrigin(c: Context): boolean {
	const origin = c.req.header("Origin");
	const fetchSite = c.req.header("Sec-Fetch-Site");
	if (origin && origin !== "null") return origin === new URL(c.req.url).origin;
	return fetchSite === "same-origin";
}

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
	if (!(await isSignedIn(c))) {
		return c.req.method === "GET" ? c.redirect("/login") : c.json({ error: c.get("t")("err.signInAgain") }, 401);
	}
	if (c.req.method !== "GET" && c.req.method !== "HEAD" && !sameOrigin(c)) return c.text(c.get("t")("err.crossSite"), 403);
	c.header("Cache-Control", "no-store");
	await next();
};
