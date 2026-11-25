import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import { testDb } from "./helpers/d1";
import { signIn, TEST_SECRET } from "./helpers/session";

/** The alias list saves the forwarding address and mode in place, like the note. */
describe("saving an alias's forwarding in place", () => {
	const setUp = async () => {
		const db = testDb();
		await db.prepare("INSERT INTO settings (key, value) VALUES ('aliasDomains', '[\"me.test\"]')").run();
		await db.prepare("INSERT INTO aliases (address, num_id, uid, created_at, updated_at) VALUES ('shop@me.test', 1, 'u1', 1, 1)").run();
		const env = { DB: db, SIGNING_SECRET: TEST_SECRET } as unknown as Env;
		const cookie = await signIn(db);
		const post = (path: string, body: string, autosave = true) =>
			app.fetch(
				new Request(`https://alias.test/aliases/shop%40me.test/${path}`, {
					method: "POST",
					headers: { cookie, origin: "https://alias.test", "content-type": "application/x-www-form-urlencoded", ...(autosave ? { "X-Autosave": "1" } : {}) },
					body,
				}),
				env,
			);
		const row = () => db.prepare("SELECT destination, forward_mode FROM aliases WHERE address = 'shop@me.test'").first();
		return { post, row };
	};

	it("answers in JSON and saves", async () => {
		const { post, row } = await setUp();
		const mode = await post("mode", "mode=no_promotions");
		expect(mode.status).toBe(200);
		expect(await mode.json()).toMatchObject({ ok: true });
		const destination = await post("destination", "destination=lists%40example.org");
		expect(await destination.json()).toMatchObject({ ok: true });
		expect(await row()).toEqual({ destination: "lists@example.org", forward_mode: "no_promotions" });
	});

	it("reports a bad value without saving it", async () => {
		const { post, row } = await setUp();
		for (const [path, body] of [["mode", "mode=everything"], ["destination", "destination=nope"], ["destination", "destination=x%40me.test"]] as const) {
			const response = await post(path, body);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ ok: false });
		}
		expect(await row()).toEqual({ destination: null, forward_mode: "all" });
	});

	it("still redirects for a plain form post", async () => {
		const { post } = await setUp();
		const response = await post("mode", "mode=none", false);
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toContain("notice=notice.modeSaved");
	});
});
