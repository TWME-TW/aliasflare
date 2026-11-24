import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import { DEFAULT_SETTINGS } from "../src/settings";
import { testDb } from "./helpers/d1";
import { TEST_SECRET } from "./helpers/session";

describe("client APIs on a fresh install", () => {
	it("are all off until turned on in Settings", async () => {
		expect(DEFAULT_SETTINGS.simpleloginApi).toBe(false);
		expect(DEFAULT_SETTINGS.addyApi).toBe(false);
		const env = { DB: testDb(), SIGNING_SECRET: TEST_SECRET } as unknown as Env;
		for (const path of ["/api/user_info", "/api/v4/alias/options", "/api/v1/account-details"]) {
			const response = await app.fetch(new Request(`https://alias.test${path}`, { headers: { Authentication: "af_x", Authorization: "Bearer af_x" } }), env);
			expect(response.status, path).toBe(404);
		}
	});
});
