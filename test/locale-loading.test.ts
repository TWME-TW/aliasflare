import { afterEach, describe, expect, it, vi } from "vitest";
import { dictionaryFor, translator } from "../src/i18n";
import { app } from "../src/index";
import { testDb } from "./helpers/d1";
import { signIn, TEST_SECRET } from "./helpers/session";

// Its own file, so no other test has loaded these languages yet: each check starts cold, the way a
// fresh Worker does.
describe("languages load when first needed", () => {
	afterEach(() => vi.restoreAllMocks());

	it("falls back to English, and says so, for a language nobody loaded", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		expect(translator("th")("nav.labels")).toBe("Labels");
		expect(error).toHaveBeenCalledWith("Language th used before it was loaded");
	});

	it("shows a page in the browser's language: the middleware loads it first", async () => {
		const error = vi.spyOn(console, "error");
		const env = { DB: testDb(), SIGNING_SECRET: TEST_SECRET } as unknown as Env;
		const cookie = `${await signIn(env.DB)}; af_lang=ko`;
		const page = await (await app.fetch(new Request("https://alias.test/labels", { headers: { Cookie: cookie } }), env)).text();
		expect(page).toContain('lang="ko"');
		expect(page).toContain((await dictionaryFor("ko"))["labels.title"]);
		expect(error).not.toHaveBeenCalled();
	});
});
