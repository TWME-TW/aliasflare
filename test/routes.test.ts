import { describe, expect, it } from "vitest";
import { app } from "../src/index";

/** A D1 stand-in with no rows: enough for the middleware to run without a session. */
function emptyDb(): D1Database {
	const statement = {
		bind: () => statement,
		all: async () => ({ results: [], success: true, meta: {} }),
		first: async () => null,
		run: async () => ({ results: [], success: true, meta: { changes: 0 } }),
		raw: async () => [],
	};
	return { prepare: () => statement, batch: async (statements: unknown[]) => statements.map(() => ({ results: [], success: true, meta: {} })), exec: async () => ({}), dump: async () => new ArrayBuffer(0) } as unknown as D1Database;
}

const env = { DB: emptyDb(), SIGNING_SECRET: "test-signing-secret-that-is-long-enough-0123456789" } as unknown as Env;
const request = (method: string, path: string) =>
	app.fetch(new Request(`https://alias.test${path}`, { method, headers: { Origin: "https://alias.test", "Content-Type": "application/x-www-form-urlencoded" }, body: method === "GET" ? undefined : "x=1" }), env);

describe("dashboard routes need a session", () => {
	const changes = [
		"/connection/cloudflare",
		"/connection",
		"/settings",
		"/blocklist",
		"/blocklist/x/delete",
		"/import/csv",
		"/api-keys",
		"/api-keys/x/delete",
		"/passkeys/options",
		"/passkeys/x/delete",
		"/aliases/bulk",
		"/aliases/a%40b.c/note",
		"/aliases/a%40b.c/contacts",
	];
	for (const path of changes) {
		it(`POST ${path} is refused without signing in`, async () => {
			expect((await request("POST", path)).status).toBe(401);
		});
	}
	for (const path of ["/", "/settings", "/connection", "/import", "/api-keys", "/passkeys", "/aliases/a%40b.c", "/no-such-page"]) {
		it(`GET ${path} sends you to sign in`, async () => {
			const response = await request("GET", path);
			expect(response.status).toBe(302);
			expect(response.headers.get("Location")).toMatch(/\/login$/);
		});
	}
	it("public pages stay public", async () => {
		expect((await request("GET", "/health")).status).toBe(200);
		expect((await request("GET", "/favicon.svg")).status).toBe(200);
	});
});
