import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import { deviceLabel } from "../src/sessions";
import { testDb } from "./helpers/d1";
import { noticeOf, signIn, TEST_SECRET } from "./helpers/session";

const ORIGIN = "https://alias.test";
const CHROME_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const SAFARI_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";

function environment(): Env {
	return { DB: testDb(), SIGNING_SECRET: TEST_SECRET } as unknown as Env;
}

const idOf = (cookie: string) => cookie.split("=")[1]!.split(".")[0]!;

function request(env: Env, cookie: string, path: string, init: RequestInit = {}) {
	const headers = new Headers(init.headers);
	headers.set("Cookie", cookie);
	headers.set("Origin", ORIGIN);
	return app.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), env);
}

const form = (body: Record<string, string>): RequestInit => ({
	method: "POST",
	headers: { "Content-Type": "application/x-www-form-urlencoded" },
	body: new URLSearchParams(body).toString(),
});

describe("adding a passkey or an API key asks for the passkey again", () => {
	it("refuses a new API key from a session that has not just confirmed its passkey", async () => {
		const env = environment();
		const cookie = await signIn(env.DB, TEST_SECRET, { verified: false });
		const response = await request(env, cookie, "/api-keys", form({ name: "phone", scope: "apps" }));
		expect(response.status).toBe(302);
		expect(noticeOf(response.headers.get("Location"))).toBe("Confirm with your passkey first, then try again.");
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM api_keys").first<{ n: number }>())?.n).toBe(0);
	});

	it("creates the key right after the passkey was confirmed", async () => {
		const env = environment();
		const cookie = await signIn(env.DB);
		const response = await request(env, cookie, "/api-keys", form({ name: "phone", scope: "apps" }));
		expect(response.status).toBe(200);
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM api_keys").first<{ n: number }>())?.n).toBe(1);
	});

	it("does not start or finish adding a passkey without a fresh confirmation", async () => {
		const env = environment();
		const stale = await signIn(env.DB, TEST_SECRET, { verified: false });
		for (const path of ["/passkeys/options", "/passkeys/verify"]) {
			const response = await request(env, stale, path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
			expect(response.status).toBe(403);
		}
		// A confirmation older than five minutes no longer counts.
		await env.DB.prepare("UPDATE sessions SET verified_at = ? WHERE id = ?").bind(Math.floor(Date.now() / 1000) - 301, idOf(stale)).run();
		expect((await request(env, stale, "/passkeys/options", { method: "POST", body: "{}" })).status).toBe(403);

		const fresh = await signIn(env.DB);
		const response = await request(env, fresh, "/passkeys/options", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
		expect(response.status).toBe(200);
		expect(await response.json()).toHaveProperty("options.challenge");
	});

	it("asks the browser for a passkey only when there is no recent confirmation", async () => {
		const env = environment();
		const stale = await signIn(env.DB, TEST_SECRET, { verified: false });
		const asked = await request(env, stale, "/reauth/options", { method: "POST", body: "{}" });
		expect(asked.status).toBe(200);
		expect(await asked.json()).toHaveProperty("options.challenge");
		expect(asked.headers.get("Set-Cookie")).toContain("__Host-af_challenge=");

		const fresh = await signIn(env.DB);
		expect(await (await request(env, fresh, "/reauth/options", { method: "POST", body: "{}" })).json()).toEqual({ fresh: true });
	});

	it("does not take a sign-in challenge as a confirmation, or the other way round", async () => {
		const env = environment();
		const cookie = await signIn(env.DB, TEST_SECRET, { verified: false });
		await env.DB.prepare("INSERT INTO auth_challenges (id, purpose, challenge, expires_at) VALUES ('ch1', 'login', 'abc', ?)").bind(Math.floor(Date.now() / 1000) + 60).run();
		const response = await request(env, `${cookie}; __Host-af_challenge=ch1`, "/reauth/verify", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ response: { id: "pk1", rawId: "pk1", type: "public-key", response: {} } }),
		});
		expect(response.status).toBe(401);
		expect((await env.DB.prepare("SELECT verified_at FROM sessions WHERE id = ?").bind(idOf(cookie)).first<{ verified_at: number | null }>())?.verified_at).toBeNull();
	});
});

describe("signed-in devices", () => {
	it("lists each browser with its device, marks this one, and never prints a session id", async () => {
		const env = environment();
		const mine = await signIn(env.DB, TEST_SECRET, { userAgent: CHROME_WINDOWS });
		const other = await signIn(env.DB, TEST_SECRET, { userAgent: SAFARI_IPHONE });
		await env.DB.prepare("UPDATE sessions SET country = 'TW' WHERE id = ?").bind(idOf(other)).run();
		const page = await (await request(env, mine, "/passkeys")).text();
		expect(page).toContain("Chrome · Windows");
		expect(page).toContain("Safari · iPhone");
		expect(page).toContain("This device");
		expect(page).toContain("Taiwan");
		expect(page).toContain("Sign out all other devices");
		expect(page).not.toContain(idOf(mine));
		expect(page).not.toContain(idOf(other));
	});

	it("signs out another device by its handle, and this one back to the sign-in page", async () => {
		const env = environment();
		const mine = await signIn(env.DB, TEST_SECRET, { userAgent: CHROME_WINDOWS });
		const other = await signIn(env.DB, TEST_SECRET, { userAgent: SAFARI_IPHONE });
		const page = await (await request(env, mine, "/passkeys")).text();
		const handles = [...page.matchAll(/action="\/sessions\/([0-9a-f]{24})\/delete"/g)].map((match) => match[1]!);
		expect(handles).toHaveLength(2);

		// The other device: whichever handle is not on the row marked "This device".
		const rows = page.split("<tr>").filter((row) => row.includes("/sessions/"));
		const otherHandle = handles.find((handle) => rows.some((row) => row.includes(handle) && !row.includes("This device")))!;
		const signedOut = await request(env, mine, `/sessions/${otherHandle}/delete`, form({}));
		expect(noticeOf(signedOut.headers.get("Location"))).toBe("That device was signed out.");
		expect((await request(env, other, "/settings")).status).toBe(302);
		expect((await request(env, mine, "/settings")).status).toBe(200);

		const myHandle = handles.find((handle) => handle !== otherHandle)!;
		const self = await request(env, mine, `/sessions/${myHandle}/delete`, form({}));
		expect(self.headers.get("Location")).toBe("/login");
		expect((await request(env, mine, "/settings")).status).toBe(302);
	});

	it("signs out every other device and keeps this one", async () => {
		const env = environment();
		const mine = await signIn(env.DB);
		const others = [await signIn(env.DB), await signIn(env.DB)];
		const response = await request(env, mine, "/sessions/others/delete", form({}));
		expect(noticeOf(response.headers.get("Location"))).toBe("Signed out 2 other devices.");
		expect((await request(env, mine, "/settings")).status).toBe(200);
		for (const cookie of others) expect((await request(env, cookie, "/settings")).status).toBe(302);
	});

	it("refuses a cross-site request to sign devices out", async () => {
		const env = environment();
		const mine = await signIn(env.DB);
		const other = await signIn(env.DB);
		const response = await app.fetch(
			new Request(`${ORIGIN}/sessions/others/delete`, { method: "POST", headers: { Cookie: mine, Origin: "https://evil.example" } }),
			env,
		);
		expect(response.status).toBe(403);
		expect((await request(env, other, "/settings")).status).toBe(200);
	});

	it("updates last active at most every few minutes", async () => {
		const env = environment();
		const cookie = await signIn(env.DB);
		const id = idOf(cookie);
		const seen = async () => (await env.DB.prepare("SELECT last_seen_at AS t FROM sessions WHERE id = ?").bind(id).first<{ t: number }>())!.t;
		await env.DB.prepare("UPDATE sessions SET last_seen_at = 100 WHERE id = ?").bind(id).run();
		await request(env, cookie, "/settings");
		const first = await seen();
		expect(first).toBeGreaterThan(Math.floor(Date.now() / 1000) - 5);
		await env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").bind(first - 60, id).run();
		await request(env, cookie, "/settings");
		expect(await seen()).toBe(first - 60);
	});

	it("names common browsers and systems", () => {
		expect(deviceLabel(CHROME_WINDOWS)).toBe("Chrome · Windows");
		expect(deviceLabel(SAFARI_IPHONE)).toBe("Safari · iPhone");
		expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0")).toBe("Edge · macOS");
		expect(deviceLabel("Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0")).toBe("Firefox · Linux");
		expect(deviceLabel("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36")).toBe("Chrome · Android");
		expect(deviceLabel("curl/8.0")).toBeNull();
		expect(deviceLabel(null)).toBeNull();
	});
});
