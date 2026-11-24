import { beforeEach, describe, expect, it } from "vitest";
import { createApiKey } from "../src/apikeys";
import worker from "../src/index";
import { loadSettings, saveSettings } from "../src/settings";
import { testDb } from "./helpers/d1";
import { TEST_SECRET } from "./helpers/session";

/**
 * Replays what the SimpleLogin browser extension (simple-login/browser-extension, popup Main.vue)
 * does after signing in with an API key. Its popup stays on "loading" if any of the first calls
 * fails or has an unexpected shape, so each one is checked the way the extension reads it.
 */
let env: Env;
let key: string;

beforeEach(async () => {
	const db = testDb();
	env = { DB: db, SIGNING_SECRET: TEST_SECRET } as unknown as Env;
	await saveSettings(db, { ...(await loadSettings(db)), simpleloginApi: true, aliasDomains: ["me.test"], defaultDestination: "owner@gmail.test" });
	key = (await createApiKey(db, "extension")).key;
	await db.prepare("INSERT INTO aliases (address, mailbox_id, num_id, uid, created_at, updated_at) VALUES ('shop@me.test', 'mb', 1, 'u1', 1, 1)").run();
});

async function call(method: string, path: string, body?: unknown, base = "https://alias.test") {
	const headers: Record<string, string> = { Authentication: key };
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const response = await worker.fetch(new Request(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, {} as ExecutionContext);
	return { status: response.status, data: response.headers.get("Content-Type")?.includes("json") ? await response.json() : await response.text() };
}

describe("SimpleLogin browser extension", () => {
	it("gets through the popup's first screen", async () => {
		const options = await call("GET", "/api/v4/alias/options?hostname=shop.example.com");
		expect(options.status).toBe(200);
		const data = options.data as { can_create: boolean; prefix_suggestion: string; suffixes: [string, string][] };
		expect(data.can_create).toBe(true);
		expect(typeof data.prefix_suggestion).toBe("string");
		expect(data.suffixes.length).toBeGreaterThan(0);
		expect(data.suffixes[0]).toHaveLength(2);

		const mailboxes = await call("GET", "/api/mailboxes");
		expect(mailboxes.status).toBe(200);
		expect(Array.isArray((mailboxes.data as { mailboxes: unknown[] }).mailboxes)).toBe(true);

		const info = await call("GET", "/api/user_info");
		expect((info.data as { can_create_reverse_alias: boolean }).can_create_reverse_alias).toBe(true);

		const page0 = await call("POST", "/api/v2/aliases?page_id=0", { query: "" });
		expect(page0.status).toBe(200);
		expect((page0.data as { aliases: { email: string }[] }).aliases.map((alias) => alias.email)).toEqual(["shop@me.test"]);
		const page1 = await call("POST", "/api/v2/aliases?page_id=1", { query: "" });
		expect((page1.data as { aliases: unknown[] }).aliases).toEqual([]);
	});

	it("works when the API URL was entered with a trailing slash", async () => {
		const options = await call("GET", "//api/v4/alias/options?hostname=x.com");
		expect(options.status).toBe(200);
		const aliases = await call("POST", "//api/v2/aliases?page_id=0", { query: "" });
		expect(aliases.status).toBe(200);
	});

	it("creates an alias from a signed suffix", async () => {
		const options = (await call("GET", "/api/v4/alias/options?hostname=x.com")).data as { suffixes: [string, string][] };
		const created = await call("POST", "/api/v2/alias/custom/new?hostname=x.com", { alias_prefix: "shop2", signed_suffix: options.suffixes[0]![1], mailbox_ids: [] });
		expect(created.status).toBe(201);
	});
});
