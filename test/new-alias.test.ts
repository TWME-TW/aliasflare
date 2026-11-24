import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/index";
import { saveSettings, loadSettings } from "../src/settings";
import { testDb } from "./helpers/d1";
import { noticeOf, signIn, TEST_SECRET } from "./helpers/session";

let db: D1Database;
let env: Env;

beforeEach(async () => {
	db = testDb();
	env = { DB: db, SIGNING_SECRET: TEST_SECRET, REVERSE_ALIAS_DOMAIN: "r.me.test" } as unknown as Env;
	await saveSettings(db, { ...(await loadSettings(db)), aliasDomains: ["me.test", "other.test"], defaultDestination: "owner@gmail.test", customSuffix: "random_string" });
});

async function create(fields: Record<string, string>) {
	const cookie = await signIn(db);
	const response = await app.fetch(
		new Request("https://alias.test/aliases/new", {
			method: "POST",
			headers: { Origin: "https://alias.test", Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(fields).toString(),
		}),
		env,
	);
	expect(response.status).toBe(302);
	return noticeOf(response.headers.get("Location"));
}

const addresses = async () => (await db.prepare("SELECT address FROM aliases ORDER BY address").all<{ address: string }>()).results.map((row) => row.address);

describe("creating an alias from the dashboard", () => {
	it("creates a named alias with note and forwarding address", async () => {
		expect(await create({ prefix: "Shop", domain: "me.test", note: "Groceries", destination: "else@gmail.test" })).toBe("Created shop@me.test.");
		const row = await db.prepare("SELECT * FROM aliases WHERE address = 'shop@me.test'").first<{ note: string; destination: string; forward_mode: string }>();
		expect(row).toMatchObject({ note: "Groceries", destination: "else@gmail.test", forward_mode: "all" });
	});

	it("adds a suffix in the chosen style when asked", async () => {
		const notice = await create({ prefix: "shop", domain: "other.test", suffix: "1" });
		expect(notice).toMatch(/^Created shop\.[a-z0-9]{6}@other\.test\.$/);
	});

	it("creates a random alias without a name", async () => {
		await create({ prefix: "", domain: "me.test" });
		expect(await addresses()).toEqual([expect.stringMatching(/^[a-z]+\.[a-z]+\d{1,3}@me\.test$/)]);
	});

	it("refuses taken names, bad names, foreign domains and looping forwarding addresses", async () => {
		await create({ prefix: "shop", domain: "me.test" });
		expect(await create({ prefix: "shop", domain: "me.test" })).toMatch(/already exists/);
		expect(await create({ prefix: "sh op!", domain: "me.test" })).toMatch(/Use only letters/);
		expect(await create({ prefix: "shop", domain: "gmail.com" })).toMatch(/alias domains/);
		expect(await create({ prefix: "shop", domain: "r.me.test" })).toMatch(/alias domains/);
		expect(await create({ prefix: "x", domain: "me.test", destination: "a@other.test" })).toMatch(/loop/i);
		expect(await create({ prefix: "x", domain: "me.test", destination: "not an address" })).not.toMatch(/^Created/);
		expect(await addresses()).toEqual(["shop@me.test"]);
	});

	it("restores a deleted alias with the same name", async () => {
		await create({ prefix: "old", domain: "me.test" });
		await db.prepare("UPDATE aliases SET deleted_at = 1 WHERE address = 'old@me.test'").run();
		expect(await create({ prefix: "old", domain: "me.test" })).toBe("Created old@me.test.");
		expect(await db.prepare("SELECT deleted_at FROM aliases WHERE address = 'old@me.test'").first("deleted_at")).toBeNull();
	});
});
