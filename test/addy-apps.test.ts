import { beforeEach, describe, expect, it } from "vitest";
import { createApiKey } from "../src/apikeys";
import { app } from "../src/index";
import { loadSettings, saveSettings } from "../src/settings";
import { testDb } from "./helpers/d1";
import { TEST_SECRET } from "./helpers/session";

/** What the addy.io Android and iOS apps and browser extension need to start and work. */
let db: D1Database;
let env: Env;
let key: string;

const call = async (path: string, method = "GET", body?: unknown) => {
	const response = await app.fetch(
		new Request(`https://alias.test/api${path}`, {
			method,
			headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
		env,
	);
	return { status: response.status, json: (response.status === 204 ? null : await response.json()) as any };
};

beforeEach(async () => {
	db = testDb();
	env = { DB: db, SIGNING_SECRET: TEST_SECRET } as unknown as Env;
	await saveSettings(db, { ...(await loadSettings(db)), addyApi: true, aliasDomains: ["a.test", "b.test"], defaultDestination: "me@home.test" });
	({ key } = await createApiKey(db, "app", "apps"));
	await db
		.prepare(
			`INSERT INTO aliases (address, num_id, uid, forward_mode, forward_enabled, pinned, destination, imported_forwarded, created_at, updated_at, deleted_at) VALUES
			('one@a.test', 1, 'u1', 'all', 1, 0, NULL, 5, 10, 10, NULL),
			('two@a.test', 2, 'u2', 'all', 1, 1, 'work@home.test', 1, 20, 40, NULL),
			('three@b.test', 3, 'u3', 'none', 0, 0, NULL, 9, 30, 30, NULL),
			('gone@b.test', 4, 'u4', 'none', 0, 0, NULL, 0, 5, 5, 50)`,
		)
		.run();
});

describe("addy.io apps", () => {
	it("pass the apps' minimum version check (1.7.4)", async () => {
		const { json } = await call("/v1/app-version");
		const { major, minor, patch } = json;
		expect(major * 1e6 + minor * 1e3 + patch).toBeGreaterThanOrEqual(1_007_004);
		expect(typeof json.version).toBe("string");
	});

	it("start: the account's default recipient and domain exist and can be looked up", async () => {
		const { json } = await call("/v1/account-details");
		expect(json.data.default_alias_domain).toBe("a.test");
		expect(typeof json.data.default_recipient_id).toBe("string");
		const recipient = await call(`/v1/recipients/${json.data.default_recipient_id}`);
		expect(recipient.status).toBe(200);
		expect(recipient.json.data.email).toBe("me@home.test");
		const options = await call("/v1/domain-options");
		expect(options.json).toMatchObject({ data: ["a.test", "b.test"], sharedDomains: [], defaultAliasDomain: "a.test" });
	});

	it("load empty labels, usernames, rules and failed deliveries instead of failing", async () => {
		for (const path of ["/v1/labels", "/v1/usernames", "/v1/rules", "/v1/failed-deliveries"]) {
			const { status, json } = await call(path);
			expect(status, path).toBe(200);
			expect(json.data, path).toEqual([]);
		}
		expect((await call("/v1/failed-deliveries")).json.meta).toMatchObject({ total: 0, links: [], last_page: 1 });
		expect((await call("/v1/labels", "POST", { name: "x" })).status).toBe(422);
	});

	it("sort the alias list", async () => {
		const ids = async (sort: string) => (await call(`/v1/aliases?sort=${sort}`)).json.data.map((alias: { id: string }) => alias.id);
		expect(await ids("-emails_forwarded")).toEqual(["u3", "u1", "u2"]);
		expect(await ids("updated_at")).toEqual(["u1", "u3", "u2"]);
		expect(await ids("email")).toEqual(["u1", "u3", "u2"]);
		expect(await ids("-created_at")).toEqual(["u3", "u2", "u1"]);
		// An unknown key falls back to the default order (pinned first).
		expect((await ids("password"))[0]).toBe("u2");
	});

	it("filter the alias list by domain and recipient", async () => {
		const domains = (await call("/v1/domains")).json.data as { id: string; domain: string }[];
		const b = domains.find((d) => d.domain === "b.test")!;
		expect((await call(`/v1/domains/${b.id}`)).json.data.domain).toBe("b.test");
		const onB = await call(`/v1/aliases?domain=${b.id}&filter[deleted]=with`);
		expect(onB.json.data.map((alias: { id: string }) => alias.id).sort()).toEqual(["u3", "u4"]);
		expect((await call("/v1/aliases?domain=nope")).json.data).toEqual([]);

		const recipients = (await call("/v1/recipients")).json.data as { id: string; email: string }[];
		const home = recipients.find((r) => r.email === "me@home.test")!;
		const work = recipients.find((r) => r.email === "work@home.test")!;
		expect((await call(`/v1/aliases?recipient=${work.id}`)).json.data.map((alias: { id: string }) => alias.id)).toEqual(["u2"]);
		expect((await call(`/v1/aliases?recipient=${home.id}&sort=email`)).json.data.map((alias: { id: string }) => alias.id)).toEqual(["u1", "u3"]);
	});

	it("act on several aliases at once", async () => {
		const got = await call("/v1/aliases/get/bulk", "POST", { ids: ["u1", "u4", "missing"] });
		expect(got.json.data.map((alias: { id: string }) => alias.id)).toEqual(["u1", "u4"]);

		const off = await call("/v1/aliases/deactivate/bulk", "POST", { ids: ["u1", "u2"] });
		expect(off.json).toMatchObject({ ids: ["u1", "u2"], message: expect.any(String) });
		expect((await call("/v1/aliases?filter[active]=true")).json.data).toEqual([]);

		await call("/v1/aliases/activate/bulk", "POST", { ids: ["u1"] });
		await call("/v1/aliases/pin/bulk", "POST", { ids: ["u1", "u3"] });
		expect((await call("/v1/aliases?filter[pinned]=true&sort=email")).json.data.map((alias: { id: string }) => alias.id)).toEqual(["u1", "u3", "u2"]);
		await call("/v1/aliases/unpin/bulk", "POST", { ids: ["u1", "u2", "u3"] });
		expect((await call("/v1/aliases?filter[pinned]=true")).json.data).toEqual([]);

		const recipients = (await call("/v1/recipients")).json.data as { id: string; email: string }[];
		const work = recipients.find((r) => r.email === "work@home.test")!;
		await call("/v1/aliases/recipients/bulk", "POST", { ids: ["u1", "u3"], recipient_ids: [work.id] });
		expect((await call(`/v1/aliases?recipient=${work.id}`)).json.meta.total).toBe(3);

		const deleted = await call("/v1/aliases/delete/bulk", "POST", { ids: ["u1", "u4"] });
		expect(deleted.json.ids).toEqual(["u1"]);
		const restored = await call("/v1/aliases/restore/bulk", "POST", { ids: ["u1", "u2", "u4"] });
		expect(restored.json.ids).toEqual(["u1", "u4"]);
		const forgotten = await call("/v1/aliases/forget/bulk", "POST", { ids: ["u4"] });
		expect(forgotten.json.ids).toEqual(["u4"]);
		expect((await call("/v1/aliases/u4")).status).toBe(404);

		expect((await call("/v1/aliases/delete/bulk", "POST", { ids: [] })).status).toBe(422);
		expect((await call("/v1/aliases/labels/bulk", "POST", { ids: ["u1"], label_ids: [] })).status).toBe(200);
		expect((await call("/v1/aliases/labels/bulk", "POST", { ids: ["u1"], label_ids: ["l1"] })).status).toBe(422);
	});

	it("give the blocklist page the meta the iOS app decodes", async () => {
		expect((await call("/v1/blocklist")).json.meta).toMatchObject({ links: [], path: expect.stringContaining("/api/v1/blocklist") });
	});
});
