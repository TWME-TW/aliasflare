import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppConfig } from "./config";
import { signToken, verifyToken } from "./crypto";
import type { Translate } from "./i18n";

export type AppEnv = { Bindings: Env; Variables: { config: AppConfig; t: Translate } };

export const SESSION_COOKIE = "mfa_session";
export const CHALLENGE_COOKIE = "mfa_challenge";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export async function startSession(c: Context<AppEnv>): Promise<void> {
	const token = await signToken(c.get("config").signingSecret, "session", "admin", SESSION_TTL_SECONDS);
	setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: SESSION_TTL_SECONDS });
}

export function endSession(c: Context): void {
	deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
}

export function setChallengeCookie(c: Context, id: string): void {
	setCookie(c, CHALLENGE_COOKIE, id, { httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: 300 });
}

export function takeChallengeCookie(c: Context): string | undefined {
	const id = getCookie(c, CHALLENGE_COOKIE);
	deleteCookie(c, CHALLENGE_COOKIE, { path: "/", secure: true });
	return id;
}

export async function isSignedIn(c: Context<AppEnv>): Promise<boolean> {
	const token = getCookie(c, SESSION_COOKIE);
	return !!token && (await verifyToken(c.get("config").signingSecret, "session", token)) === "admin";
}

/** Rejects cross-site requests; the cookies are SameSite=Strict as well. */
export function sameOrigin(c: Context): boolean {
	const origin = c.req.header("Origin");
	if (!origin) return c.req.header("Sec-Fetch-Site") !== "cross-site";
	return origin === new URL(c.req.url).origin;
}

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
	if (!(await isSignedIn(c))) {
		return c.req.method === "GET" ? c.redirect("/login") : c.json({ error: c.get("t")("err.signInAgain") }, 401);
	}
	if (c.req.method !== "GET" && c.req.method !== "HEAD" && !sameOrigin(c)) return c.text(c.get("t")("err.crossSite"), 403);
	await next();
};
