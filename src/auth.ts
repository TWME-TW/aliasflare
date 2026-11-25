import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppConfig } from "./config";
import { signToken, verifyToken } from "./crypto";
import { now } from "./db";
import { randomToken } from "./format";
import type { Translate } from "./i18n";
import type { Settings } from "./settings";

/**
 * `settings` and `session` are read in the same D1 round trip as the configuration, at the start of
 * a request: `session` says whether the session id in the cookie (not yet checked) is still live.
 */
export type AppEnv = { Bindings: Env; Variables: { config: AppConfig; t: Translate; settings?: Settings; session?: SessionState } };

/** The session row the cookie names, read with the configuration: whether it is live, and its timestamps. */
export type SessionState = { id: string; live: boolean; seen?: number | null; verified?: number | null };

// Sent as __Host-af_session and __Host-af_challenge: Secure, Path=/ and no Domain, so a
// sibling subdomain cannot set or overwrite them.
export const SESSION_COOKIE = "af_session";
export const CHALLENGE_COOKIE = "af_challenge";
const COOKIE_PREFIX = "host" as const;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
/** How long a passkey confirmation lets the owner add a passkey or an API key without another one. */
export const REAUTH_WINDOW_SECONDS = 5 * 60;
/** "Last active" is written at most this often, so browsing does not write to D1 on every page. */
const SEEN_EVERY_SECONDS = 5 * 60;

/**
 * Starts a session for a passkey. The cookie holds a signed random id; the session itself
 * lives in D1, so signing out or removing the passkey ends it right away.
 */
export async function startSession(c: Context<AppEnv>, passkeyId: string): Promise<void> {
	const db = c.env.DB;
	const id = randomToken(32);
	const timestamp = now();
	// The browser and country are kept only to tell the owner's devices apart on the Passkeys page.
	const userAgent = c.req.header("User-Agent")?.slice(0, 300) || null;
	const country = (c.req.raw as { cf?: { country?: unknown } }).cf?.country;
	await db.batch([
		db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(timestamp),
		db
			.prepare("INSERT INTO sessions (id, passkey_id, created_at, expires_at, user_agent, country, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
			.bind(id, passkeyId, timestamp, timestamp + SESSION_TTL_SECONDS, userAgent, typeof country === "string" && /^[A-Z]{2}$/.test(country) ? country : null, timestamp),
	]);
	const token = await signToken(c.get("config").signingSecret, "session", id, SESSION_TTL_SECONDS);
	setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: SESSION_TTL_SECONDS, prefix: COOKIE_PREFIX });
}

/** The session id the cookie claims, before its signature is checked: only to look the row up early. */
export function claimedSessionId(c: Context): string | null {
	const token = getCookie(c, SESSION_COOKIE, COOKIE_PREFIX);
	const id = token?.split(".")[0];
	return id && /^[A-Za-z0-9_-]{16,128}$/.test(id) ? id : null;
}

export async function sessionId(c: Context<AppEnv>): Promise<string | null> {
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

/**
 * A session counts only while its passkey does. The schema deletes a passkey's sessions with it, but
 * that is the database's job: removing passkeys by hand (the "lost all your passkeys" recovery) or
 * restoring a database where foreign keys were off would otherwise leave old cookies working.
 */
export const LIVE_SESSION =
	"SELECT 1 AS ok, s.last_seen_at AS seen, s.verified_at AS verified FROM sessions s JOIN passkeys p ON p.id = s.passkey_id WHERE s.id = ? AND s.expires_at >= ?";

export async function isSignedIn(c: Context<AppEnv>): Promise<boolean> {
	const id = await sessionId(c);
	if (!id) return false;
	// Already read with the configuration; the signature, checked just now, says the id is ours.
	const known = c.get("session");
	if (known && known.id === id) return known.live;
	const row = await c.env.DB.prepare(LIVE_SESSION).bind(id, now()).first<{ ok: number; seen: number | null; verified: number | null }>();
	c.set("session", { id, live: !!row, seen: row?.seen ?? null, verified: row?.verified ?? null });
	return !!row;
}

/**
 * True when this session confirmed its passkey within the last few minutes. Adding a passkey or an
 * API key asks for it, so a stolen session cookie alone cannot add a way back in that outlives it.
 */
export async function recentlyVerified(c: Context<AppEnv>): Promise<boolean> {
	if (!(await isSignedIn(c))) return false;
	const verified = c.get("session")?.verified;
	return typeof verified === "number" && verified >= now() - REAUTH_WINDOW_SECONDS;
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
	const session = c.get("session");
	if (session?.live && (session.seen ?? 0) < now() - SEEN_EVERY_SECONDS) {
		await c.env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").bind(now(), session.id).run();
	}
	await next();
};
