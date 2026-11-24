import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/index";
import { loadSettings, saveSettings } from "../src/settings";
import { testDb } from "./helpers/d1";
import { signIn, TEST_SECRET } from "./helpers/session";

let db: D1Database;
let env: Env;

beforeEach(async () => {
	db = testDb();
	env = { DB: db, SIGNING_SECRET: TEST_SECRET } as unknown as Env;
	const insert = (address: string, numId: number, createdAt: number, pinned = 0) =>
		db
			.prepare("INSERT INTO aliases (address, num_id, uid, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
			.bind(address, numId, `u${numId}`, pinned, createdAt, createdAt)
			.run();
	await insert("old-pinned@me.test", 1, 100, 1);
	await insert("old-busy@me.test", 2, 200);
	await insert("old-quiet@me.test", 3, 300);
	await insert("new@me.test", 4, 1000);
	// old-busy@ was created early but forwarded mail most recently.
	await db
		.prepare("INSERT INTO contacts (id, num_id, alias_address, email, reverse_local, last_forward_at, created_at) VALUES ('c1', 1, 'old-busy@me.test', 'x@y.test', 'r1', 2000, 200)")
		.run();
});

async function dashboard(): Promise<string> {
	const response = await app.fetch(new Request("https://alias.test/", { headers: { cookie: await signIn(db) } }), env);
	return response.text();
}

describe("alias list", () => {
	it("puts pinned aliases first, then the newest or most recently used", async () => {
		const page = await dashboard();
		const order = [...page.matchAll(/data-copy="([^"]+)"/g)].map((match) => match[1]);
		expect(order).toEqual(["old-pinned@me.test", "old-busy@me.test", "new@me.test", "old-quiet@me.test"]);
	});

	it("shows as many rows as asked for, keeps that size in the page links, and opens the new-alias form", async () => {
		await saveSettings(db, { ...(await loadSettings(db)), aliasDomains: ["me.test"] });
		const cookie = await signIn(db);
		for (let i = 0; i < 30; i += 1) {
			await db.prepare("INSERT INTO aliases (address, num_id, uid, created_at, updated_at) VALUES (?, ?, ?, 1, 1)").bind(`bulk${i}@me.test`, 100 + i, `b${i}`).run();
		}
		const page = await (await app.fetch(new Request("https://alias.test/?per=25", { headers: { cookie } }), env)).text();
		expect([...page.matchAll(/data-copy="/g)]).toHaveLength(25);
		expect(page).toContain('href="/?per=25&amp;page=2"');
		expect(page).toMatch(/<option value="25" selected>/);
		expect(page).toContain('<details class="create" open>');
		const unknown = await (await app.fetch(new Request("https://alias.test/?per=7", { headers: { cookie } }), env)).text();
		expect([...unknown.matchAll(/data-copy="/g)]).toHaveLength(34);
	});

	it("has a copy button for each alias, shown only by the page script", async () => {
		const page = await dashboard();
		expect(page).toMatch(/<button type="button" class="ghost copy" data-copy="new@me.test"[^>]*hidden>/);
	});
});
