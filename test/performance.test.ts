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
