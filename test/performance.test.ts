import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import worker, { app } from "../src/index";
import { loadSettings, saveSettings } from "../src/settings";
import { APP_SCRIPT_VERSION } from "../src/ui";
import { testDb } from "./helpers/d1";
import { TEST_SECRET } from "./helpers/session";

describe("performance", () => {
	it("serves static files without touching D1, cached for a year when versioned", async () => {
		// No DB binding at all: any D1 call would throw.
		const env = { SIGNING_SECRET: TEST_SECRET } as unknown as Env;
		const versioned = await app.fetch(new Request(`https://alias.test/assets/app.js?v=${APP_SCRIPT_VERSION}`), env);
		expect(versioned.status).toBe(200);
		expect(versioned.headers.get("Cache-Control")).toContain("immutable");
		const plain = await app.fetch(new Request("https://alias.test/favicon.svg"), env);
		expect(plain.status).toBe(200);
		expect(plain.headers.get("Cache-Control")).toBe("public, max-age=86400");
	});

	it("sorts the alias list from an index, not by scanning every alias", () => {
		const sqlite = new DatabaseSync(":memory:");
		const dir = join(__dirname, "..", "migrations");
		for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) sqlite.exec(readFileSync(join(dir, file), "utf8"));
		const plan = sqlite
			.prepare("EXPLAIN QUERY PLAN SELECT address FROM aliases ORDER BY pinned DESC, MAX(created_at, COALESCE(last_used_at, 0)) DESC, num_id DESC LIMIT 100")
			.all() as { detail: string }[];
		const details = plan.map((row) => row.detail).join(" | ");
		expect(details).toContain("aliases_list_order_idx");
		expect(details).not.toContain("TEMP B-TREE");
	});

	it("records on the alias when mail last went through it", async () => {
		const db = testDb();
		const env = {
			DB: db,
			SIGNING_SECRET: TEST_SECRET,
			EMAIL: { send: async () => ({ messageId: "<s@test>" }) },
		} as unknown as Env;
		await saveSettings(db, { ...(await loadSettings(db)), aliasDomains: ["a.test"], defaultDestination: "owner@gmail.test" });
		const raw = `From: bob@store.test\r\nTo: shop@a.test\r\nSubject: Hi\r\nMessage-ID: <m1@x>\r\n\r\nHello\r\n`;
		const msg = { to: "shop@a.test", from: "bob@store.test", headers: new Headers({ "Message-ID": "<m1@x>" }), raw: new Response(raw).body, rawSize: raw.length, setReject: () => undefined };
		await worker.email!(msg as never, env);
		const row = await db.prepare("SELECT last_used_at FROM aliases WHERE address = 'shop@a.test'").first<{ last_used_at: number | null }>();
		expect(row?.last_used_at).toBeGreaterThan(0);
	});
});

describe("imported activity", () => {
	it("counts the other service's last forward as the alias's last use", async () => {
		const { importAliases, parseAliasCsv, selectByDomain } = await import("../src/importer");
		const db = testDb();
		await saveSettings(db, { ...(await loadSettings(db)), aliasDomains: ["me.com"], defaultDestination: "owner@gmail.test" });
		const rows = parseAliasCsv(
			"id,local_part,domain,email,active,description,from_name,emails_forwarded,emails_blocked,emails_replied,emails_sent,last_forwarded,created_at,deleted_at\n" +
				"1,news,me.com,news@me.com,1,,,12,0,0,0,2026-02-03 04:05:06,2025-01-01 00:00:00,\n" +
				"2,quiet,me.com,quiet@me.com,1,,,0,0,0,0,,2025-01-01 00:00:00,\n",
		);
		await importAliases(db, await loadSettings(db), "csv", selectByDomain(rows, ["me.com"]), rows.length, { keepDestinations: false });
		const { results } = await db.prepare("SELECT address, last_used_at FROM aliases ORDER BY address").all<{ address: string; last_used_at: number | null }>();
		expect(results).toEqual([
			{ address: "news@me.com", last_used_at: Date.UTC(2026, 1, 3, 4, 5, 6) / 1000 },
			{ address: "quiet@me.com", last_used_at: null },
		]);
	});
});

describe("activity page", () => {
	it("reads forwards and events in time order from their indexes, without sorting the whole history", () => {
		const sqlite = new DatabaseSync(":memory:");
		const dir = join(__dirname, "..", "migrations");
		for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) sqlite.exec(readFileSync(join(dir, file), "utf8"));
		const plan = sqlite
			.prepare(
				`EXPLAIN QUERY PLAN SELECT 'forward' AS kind, status, alias_address AS alias, subject AS detail, updated_at AS at FROM forwards
				 UNION ALL SELECT kind, status, alias_address AS alias, detail, created_at AS at FROM events ORDER BY at DESC LIMIT 50 OFFSET 0`,
			)
			.all() as { detail: string }[];
		const details = plan.map((row) => row.detail).join(" | ");
		expect(details).toContain("forwards_updated_idx");
		expect(details).toContain("events_created_idx");
	});

	it("pages through all activity, newest first", async () => {
		const { signIn } = await import("./helpers/session");
		const db = testDb();
		for (let i = 0; i < 60; i += 1) {
			await db.prepare("INSERT INTO events (id, kind, status, alias_address, detail, created_at) VALUES (?, 'reply', 'done', 'a@me.test', ?, ?)").bind(`e${i}`, `event ${i}`, 1000 + i).run();
		}
		const env = { DB: db, SIGNING_SECRET: TEST_SECRET } as unknown as Env;
		const cookie = await signIn(db);
		const first = await (await app.fetch(new Request("https://alias.test/activity", { headers: { cookie } }), env)).text();
		expect(first).toContain("event 59");
		expect(first).not.toContain("event 9<");
		expect(first).toContain('href="/activity?page=2"');
		const second = await (await app.fetch(new Request("https://alias.test/activity?page=2", { headers: { cookie } }), env)).text();
		expect(second).toContain("event 0<");
	});
});

describe("activity links", () => {
	it("links each alias to its own settings page", async () => {
		const { signIn } = await import("./helpers/session");
		const db = testDb();
		await db.prepare("INSERT INTO events (id, kind, status, alias_address, detail, created_at) VALUES ('e1', 'reply', 'done', 'shop+x@me.test', 'd', 1)").run();
		const env = { DB: db, SIGNING_SECRET: TEST_SECRET } as unknown as Env;
		const page = await (await app.fetch(new Request("https://alias.test/activity", { headers: { cookie: await signIn(db) } }), env)).text();
		expect(page).toContain('<a href="/aliases/shop%2Bx%40me.test"><code>shop+x@me.test</code></a>');
	});
});

describe("alias page forwarding", () => {
	it("shows the forwarding address and mode, and saving them returns to the alias page", async () => {
		const { signIn } = await import("./helpers/session");
		const db = testDb();
		await db.prepare("INSERT INTO aliases (address, created_at, updated_at) VALUES ('shop@me.test', 1, 1)").run();
		const env = { DB: db, SIGNING_SECRET: TEST_SECRET } as unknown as Env;
		const cookie = await signIn(db);
		const page = await (await app.fetch(new Request("https://alias.test/aliases/shop%40me.test", { headers: { cookie } }), env)).text();
		expect(page).toContain('action="/aliases/shop%40me.test/destination"');
		expect(page).toContain('action="/aliases/shop%40me.test/mode"');
		const post = (path: string, body: string) =>
			app.fetch(new Request(`https://alias.test${path}`, { method: "POST", headers: { cookie, origin: "https://alias.test", "content-type": "application/x-www-form-urlencoded" }, body }), env);
		const saved = await post("/aliases/shop%40me.test/destination", "back=alias&destination=me%40gmail.test");
		expect(saved.headers.get("location")).toMatch(/^\/aliases\/shop%40me\.test\?notice=/);
		const mode = await post("/aliases/shop%40me.test/mode", "back=alias&mode=none");
		expect(mode.headers.get("location")).toMatch(/^\/aliases\/shop%40me\.test\?notice=/);
		expect(await db.prepare("SELECT destination, forward_mode FROM aliases").first()).toEqual({ destination: "me@gmail.test", forward_mode: "none" });
	});
});
