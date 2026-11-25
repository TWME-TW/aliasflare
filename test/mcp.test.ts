import { beforeEach, describe, expect, it } from "vitest";
import { createApiKey } from "../src/apikeys";
import { app } from "../src/index";
import { loadSettings, saveSettings } from "../src/settings";
import { testDb } from "./helpers/d1";
import { TEST_SECRET } from "./helpers/session";

let db: D1Database;
let env: Env;
let key: string;
const URL_ = "https://alias.test/mcp";

beforeEach(async () => {
	db = testDb();
	env = { DB: db, SIGNING_SECRET: TEST_SECRET } as unknown as Env;
	await saveSettings(db, { ...(await loadSettings(db)), aliasDomains: ["me.test", "work.test"], defaultDestination: "owner@gmail.test", mcpServer: true });
	key = (await createApiKey(db, "assistant", "mcp")).key;
});

let nextId = 1;
async function rpc(method: string, params: unknown = {}, init: { key?: string; headers?: Record<string, string> } = {}) {
	const response = await app.fetch(
		new Request(URL_, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${init.key ?? key}`, ...init.headers },
			body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
		}),
		env,
	);
	return { status: response.status, body: response.status === 200 ? ((await response.json()) as { result?: any; error?: { code: number } }) : null };
}
const call = async (name: string, args: Record<string, unknown> = {}) => (await rpc("tools/call", { name, arguments: args })).body!.result;

describe("the MCP server", () => {
	it("initializes, negotiating the protocol version, and lists its tools", async () => {
		const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
		expect(init.body!.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "aliasflare" } });
		expect((await rpc("initialize", { protocolVersion: "1999-01-01" })).body!.result.protocolVersion).toBe("2025-11-25");
		const names = (await rpc("tools/list")).body!.result.tools.map((tool: { name: string }) => tool.name);
		expect(names).toEqual(["list_domains", "list_aliases", "create_alias", "set_alias_mode", "set_alias_note"]);
		const notification = await app.fetch(new Request(URL_, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: '{"jsonrpc":"2.0","method":"notifications/initialized"}' }), env);
		expect(notification.status).toBe(202);
		expect((await rpc("no/such")).body!.error!.code).toBe(-32601);
	});

	it("creates, finds and switches aliases", async () => {
		const random = await call("create_alias", { note: "Shop" });
		expect(random.structuredContent.alias.address).toMatch(/@me\.test$/);
		const named = await call("create_alias", { local_part: "News Letter", domain: "work.test" });
		expect(named.structuredContent.alias.address).toBe("newsletter@work.test");
		expect((await call("create_alias", { local_part: "newsletter", domain: "work.test" })).isError).toBe(true);
		expect((await call("create_alias", { domain: "evil.test" })).isError).toBe(true);

		const found = await call("list_aliases", { search: "shop" });
		expect(found.structuredContent.aliases.map((alias: { note: string }) => alias.note)).toEqual(["Shop"]);
		await call("set_alias_mode", { address: "Newsletter@work.test", mode: "none" });
		await call("set_alias_note", { address: "newsletter@work.test", note: "  " });
		expect(await db.prepare("SELECT forward_mode, note FROM aliases WHERE address = 'newsletter@work.test'").first()).toEqual({ forward_mode: "none", note: null });
		expect((await call("list_aliases", { status: "disabled" })).structuredContent.total).toBe(1);
		expect((await call("set_alias_mode", { address: "nobody@me.test", mode: "all" })).isError).toBe(true);
		expect((await call("set_alias_mode", { address: "newsletter@work.test", mode: "drop" })).isError).toBe(true);
		expect((await call("list_domains")).structuredContent).toEqual({ domains: ["me.test", "work.test"], default_domain: "me.test" });
	});

	it("needs an MCP key, is off until enabled, and refuses other sites' pages", async () => {
		const appKey = (await createApiKey(db, "phone", "apps")).key;
		expect((await rpc("tools/list", {}, { key: appKey })).status).toBe(401);
		expect((await rpc("tools/list", {}, { key: "af_wrong" })).status).toBe(401);
		expect((await rpc("tools/list", {}, { headers: { Origin: "https://evil.test" } })).status).toBe(403);
		// An MCP key does not work for the apps' API either.
		await saveSettings(db, { ...(await loadSettings(db)), simpleloginApi: true });
		expect((await app.fetch(new Request("https://alias.test/api/user_info", { headers: { Authentication: key } }), env)).status).toBe(401);
		await saveSettings(db, { ...(await loadSettings(db)), mcpServer: false });
		expect((await rpc("tools/list")).status).toBe(404);
		expect((await app.fetch(new Request(URL_), env)).status).toBe(405);
	});
});
