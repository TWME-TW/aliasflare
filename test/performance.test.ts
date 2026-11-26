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

	it("reads what a message needs in one round trip, and reads the alias again only to claim it", async () => {
		const real = testDb();
		await saveSettings(real, { ...(await loadSettings(real)), aliasDomains: ["a.test"], defaultDestination: "owner@gmail.test", language: "ja" });
		await real.prepare("INSERT INTO aliases (address, num_id, uid, forward_mode, forward_enabled, created_at, updated_at) VALUES ('shop@a.test', 1, 'u1', 'all', 1, 1, 1)").run();
		const statements: string[] = [];
		const batches: string[][] = [];
		const db = new Proxy(real, {
			get(target, name) {
				if (name === "prepare") return (sql: string) => (statements.push(sql), target.prepare(sql));
				if (name === "batch") {
					return (list: D1PreparedStatement[]) => {
						// The statements of each batch, recorded from prepare() order: a batch is one round trip.
						batches.push(statements.slice(-list.length));
						return target.batch(list);
					};
				}
				const value = Reflect.get(target, name);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const sent: unknown[] = [];
		const env = { DB: db, SIGNING_SECRET: TEST_SECRET, EMAIL: { send: async (message: unknown) => (sent.push(message), { messageId: "<s@test>" }) } } as unknown as Env;
		const raw = `From: bob@store.test\r\nTo: shop@a.test\r\nSubject: Hi\r\nMessage-ID: <m2@x>\r\n\r\nHello\r\n`;
		const msg = { to: "shop@a.test", from: "bob@store.test", headers: new Headers({ "Message-ID": "<m2@x>" }), raw: new Response(raw).body, rawSize: raw.length, setReject: () => undefined };
		await worker.email!(msg as never, env);
		expect(sent).toHaveLength(1);
		const count = (pattern: RegExp) => statements.filter((sql) => pattern.test(sql)).length;
		expect(count(/^SELECT key, value FROM settings$/)).toBe(1);
		expect(count(/^SELECT key, value FROM config$/)).toBe(1);
		// Once with the configuration, to know whether the alias exists, and once when claiming the
		// delivery: the owner may have turned the alias off or deleted it while the message was being
		// read, and the forwarding must follow the row as it is now, not as it was.
		expect(count(/^SELECT \* FROM aliases WHERE address = \?$/)).toBe(2);
		// The alias exists: nothing tries to create it again.
		expect(count(/^INSERT INTO aliases/)).toBe(0);
		// The first three go together as one round trip: the configuration, the settings, the alias.
		expect(batches[0]).toEqual(["SELECT key, value FROM config", "SELECT key, value FROM settings", "SELECT * FROM aliases WHERE address = ?"]);
		// Claiming the delivery carries the second alias read in the same round trip as the insert.
		expect(batches.some((batch) => batch.length === 2 && batch[0]!.startsWith("INSERT INTO forwards") && batch[1]!.startsWith("SELECT * FROM aliases"))).toBe(true);
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
