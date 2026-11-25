/**
 * The browsers signed in to the dashboard, for the Passkeys page: what each is, where it signed in
 * from, and when it was last active, so the owner can sign out one they do not recognise.
 */
import { now } from "./db";

export type SessionRow = {
	id: string;
	passkey_name: string;
	created_at: number;
	last_seen_at: number | null;
	user_agent: string | null;
	country: string | null;
};

export async function listSessions(db: D1Database): Promise<SessionRow[]> {
	const { results } = await db
		.prepare(
			`SELECT s.id, p.name AS passkey_name, s.created_at, s.last_seen_at, s.user_agent, s.country
			 FROM sessions s JOIN passkeys p ON p.id = s.passkey_id
			 WHERE s.expires_at >= ? ORDER BY COALESCE(s.last_seen_at, s.created_at) DESC`,
		)
		.bind(now())
		.all<SessionRow>();
	return results;
}

/**
 * What the page and its sign-out buttons name a session by. Not the id itself: that is the secret
 * half of the session cookie, and has no business in HTML.
 */
export async function sessionHandle(id: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`session-handle:${id}`)));
	return [...digest.slice(0, 12)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const BROWSERS: [RegExp, string][] = [
	[/\bEdg(?:e|A|iOS)?\//, "Edge"],
	[/\b(?:OPR|Opera)\//, "Opera"],
	[/\bSamsungBrowser\//, "Samsung Internet"],
	[/\b(?:Firefox|FxiOS)\//, "Firefox"],
	[/\b(?:Chrome|CriOS|Chromium)\//, "Chrome"],
	[/\bSafari\//, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
	[/\biPhone\b/, "iPhone"],
	[/\biPad\b/, "iPad"],
	[/\bAndroid\b/, "Android"],
	[/\bCrOS\b/, "ChromeOS"],
	[/\bWindows\b/, "Windows"],
	[/\bMac OS X\b|\bMacintosh\b/, "macOS"],
	[/\bLinux\b/, "Linux"],
];

/** "Chrome · Windows" from a User-Agent header, or null when neither part is recognised. */
export function deviceLabel(userAgent: string | null): string | null {
	if (!userAgent) return null;
	const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
	const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
	return [browser, system].filter(Boolean).join(" · ") || null;
}
