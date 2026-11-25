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
	await db.prepare("UPDATE aliases SET last_used_at = 2000 WHERE address = 'old-busy@me.test'").run();
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
		expect(page).toContain('<section class="create"');
		expect(page).not.toContain('<details class="create"');
		expect(page).toContain('name="kind" value="uuid" formnovalidate');
		const unknown = await (await app.fetch(new Request("https://alias.test/?per=7", { headers: { cookie } }), env)).text();
		expect([...unknown.matchAll(/data-copy="/g)]).toHaveLength(34);
	});

	it("shows how long ago each alias was last used, or that it never was", async () => {
		const page = await dashboard();
		const row = (address: string) => page.slice(page.indexOf(`data-copy="${address}"`)).split("</tr>")[0]!;
		expect(row("old-busy@me.test")).toMatch(/<time datetime="1970-01-01T00:33:20.000Z" title="[^"]+">\d+ years ago<\/time>/);
		expect(row("new@me.test")).toContain(">Never</span>");
	});

	it("has a copy button for each alias, shown only by the page script", async () => {
		const page = await dashboard();
		expect(page).toMatch(/<button type="button" class="ghost copy" data-copy="new@me.test"[^>]*hidden>/);
	});
});

describe("one-click random aliases", () => {
	it("creates an alias of the kind on the button, ignoring any name typed", async () => {
		const { signIn } = await import("./helpers/session");
		const { loadSettings, saveSettings } = await import("../src/settings");
		const db = testDb();
		await saveSettings(db, { ...(await loadSettings(db)), aliasDomains: ["me.test"] });
		const env = { DB: db, SIGNING_SECRET: TEST_SECRET } as unknown as Env;
		const cookie = await signIn(db);
		const response = await app.fetch(
			new Request("https://alias.test/aliases/new", {
				method: "POST",
				headers: { cookie, origin: "https://alias.test", "content-type": "application/x-www-form-urlencoded" },
				body: "prefix=&domain=me.test&kind=uuid&note=&destination=",
			}),
			env,
		);
		expect(response.status).toBe(302);
		const row = await db.prepare("SELECT address FROM aliases").first<{ address: string }>();
		expect(row?.address).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@me\.test$/);
	});
});

describe("creation time", () => {
	it("is shown for each alias on the list and on its page", async () => {
		const db = testDb();
		const created = Math.floor(Date.now() / 1000) - 3 * 86400;
		await db.prepare("INSERT INTO aliases (address, num_id, uid, created_at, updated_at) VALUES ('shop@me.test', 1, 'u1', ?, ?)").bind(created, created).run();
		const env = { DB: db, SIGNING_SECRET: TEST_SECRET } as unknown as Env;
		const cookie = await signIn(db);
		const iso = new Date(created * 1000).toISOString();
		const list = await (await app.fetch(new Request("https://alias.test/", { headers: { cookie } }), env)).text();
		expect(list).toContain('<th class="c-created">Created</th>');
		expect(list).toContain(`<td class="c-created" data-label="Created"><time datetime="${iso}"`);
		const page = await (await app.fetch(new Request("https://alias.test/aliases/shop%40me.test", { headers: { cookie } }), env)).text();
		expect(page).toContain(`Created <time datetime="${iso}">`);
	});
});

describe("deleting a contact", () => {
	it("removes only that alias's contact, after asking", async () => {
		const db = testDb();
		await db.prepare("INSERT INTO aliases (address, num_id, uid, created_at, updated_at) VALUES ('shop@me.test', 1, 'u1', 1, 1), ('other@me.test', 2, 'u2', 1, 1)").run();
		await db
			.prepare("INSERT INTO contacts (id, num_id, alias_address, email, reverse_local, created_at) VALUES ('c1', 1, 'shop@me.test', 'bob@store.test', 'r1', 1), ('c2', 2, 'other@me.test', 'eve@store.test', 'r2', 1)")
			.run();
		const env = { DB: db, SIGNING_SECRET: TEST_SECRET } as unknown as Env;
		const cookie = await signIn(db);
		const page = await (await app.fetch(new Request("https://alias.test/aliases/shop%40me.test", { headers: { cookie } }), env)).text();
		expect(page).toContain('action="/aliases/shop%40me.test/contacts/c1/delete" data-confirm=');
		const post = (path: string) => app.fetch(new Request(`https://alias.test${path}`, { method: "POST", headers: { cookie, origin: "https://alias.test" } }), env);
		// Another alias's contact cannot be deleted through this alias.
		await post("/aliases/shop%40me.test/contacts/c2/delete");
		const deleted = await post("/aliases/shop%40me.test/contacts/c1/delete");
		expect(deleted.headers.get("location")).toContain("notice.contactDeleted");
		const { results } = await db.prepare("SELECT id FROM contacts").all<{ id: string }>();
		expect(results.map((row) => row.id)).toEqual(["c2"]);
	});
});
