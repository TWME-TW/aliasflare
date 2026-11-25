import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, loadConfig } from "../src/config";
import { signToken } from "../src/crypto";
import type { ForwardRow } from "../src/db";
import { handleInbound } from "../src/forward";
import { importAliases, parseAliasCsv, selectByDomain } from "../src/importer";
import { app } from "../src/index";
import { checkSetupCode } from "../src/passkeys";
import { loadSettings, saveSettings } from "../src/settings";
import { safeHttpsUrl, siteOf, unsubscribePlan } from "../src/unsubscribe";
import { testDb } from "./helpers/d1";
import { signIn, TEST_SECRET } from "./helpers/session";

let db: D1Database;
let env: Env;

beforeEach(async () => {
	db = testDb();
	env = { DB: db, SIGNING_SECRET: TEST_SECRET } as unknown as Env;
	await saveSettings(db, { ...(await loadSettings(db)), aliasDomains: ["me.test"], defaultDestination: "owner@gmail.test" });
});
afterEach(() => vi.unstubAllGlobals());

const ORIGIN = "https://alias.test";
function request(method: string, path: string, init: { cookie?: string; origin?: string | null; body?: string; headers?: Record<string, string> } = {}) {
	const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", ...init.headers };
	if (init.origin !== null) headers.Origin = init.origin ?? ORIGIN;
	if (init.cookie) headers.Cookie = init.cookie;
	return app.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body: method === "GET" ? undefined : (init.body ?? "") }), env);
}

describe("sessions (item 4)", () => {
	it("end when signing out", async () => {
		const cookie = await signIn(db);
		expect((await request("GET", "/settings", { cookie })).status).toBe(200);
		await request("POST", "/logout", { cookie });
		expect((await request("GET", "/settings", { cookie })).status).toBe(302);
	});
	it("end when their passkey is removed", async () => {
		const cookie = await signIn(db);
		await db.prepare("INSERT INTO passkeys (id, public_key, counter, name, created_at) VALUES ('pk2', 'k', 0, 'Other', 1)").run();
		const other = await signIn(db);
		await request("POST", "/passkeys/pk1/delete", { cookie: other });
		expect((await request("GET", "/settings", { cookie })).status).toBe(302);
	});
	it("refuse the old stateless cookie and a cookie without the __Host- prefix", async () => {
		const old = await signToken(TEST_SECRET, "session", "admin", 600);
		expect((await request("GET", "/settings", { cookie: `__Host-af_session=${old}` })).status).toBe(302);
		const cookie = (await signIn(db)).replace("__Host-", "");
		expect((await request("GET", "/settings", { cookie })).status).toBe(302);
	});
	it("refuse a change with neither Origin nor Sec-Fetch-Site", async () => {
		const cookie = await signIn(db);
		expect((await request("POST", "/settings", { cookie, origin: null })).status).toBe(403);
	});
	it("mark dashboard pages as not cacheable", async () => {
		const response = await request("GET", "/settings", { cookie: await signIn(db) });
		expect(response.headers.get("Cache-Control")).toBe("no-store");
	});
});

describe("request bodies (item 5)", () => {
	it("refuses a JSON body over the limit without reading it all", async () => {
		const response = await request("POST", "/login/verify", { body: "x".repeat(40_000), headers: { "Content-Type": "application/json" } });
		expect(response.status).toBe(400);
	});
});

describe("setup code (item 16)", () => {
	it("only accepts the SETUP_CODE secret once it is set", async () => {
		await db.prepare("INSERT INTO auth_challenges (id, purpose, challenge, expires_at) VALUES ('c', 'setup', 'LOGGEDCODE', ?)").bind(Date.now()).run();
		expect(await checkSetupCode({ DB: db } as Env, "loggedcode")).toBe(true);
		expect(await checkSetupCode({ DB: db, SETUP_CODE: "secret-code" } as unknown as Env, "loggedcode")).toBe(false);
		expect(await checkSetupCode({ DB: db, SETUP_CODE: "secret-code" } as unknown as Env, "SECRET-CODE")).toBe(true);
	});
});

async function addForward(fields: Partial<ForwardRow> = {}) {
	await db.prepare("INSERT OR IGNORE INTO aliases (address, mailbox_id, created_at, updated_at) VALUES ('shop@me.test', 'mb', 1, 1)").run();
	await db
		.prepare("INSERT OR IGNORE INTO contacts (id, alias_address, email, reverse_local, created_at) VALUES ('c1', 'shop@me.test', 'news@store.test', 'rnews', 1)")
		.run();
	const id = `fw_${"a".repeat(32)}`;
	await db
		.prepare(
			"INSERT INTO forwards (id, inbound_id, alias_address, contact_id, original_unsubscribe, original_unsubscribe_post, status, created_at, updated_at) VALUES (?, 'm1', 'shop@me.test', 'c1', ?, ?, 'sent', 1, 1)",
		)
		.bind(id, fields.original_unsubscribe ?? null, fields.original_unsubscribe_post ?? 0)
		.run();
	return id;
}

describe("mail links (item 6)", () => {
	it("work once, and the banner buttons only from this site", async () => {
		const id = await addForward();
		const token = await signToken(TEST_SECRET, "action", `block~${id}`, 600);
		expect((await request("POST", `/action/${token}`, { origin: "https://evil.test" })).status).toBe(403);
		const first = await (await request("POST", `/action/${token}`)).text();
		expect(first).not.toContain("already used");
		expect(await db.prepare("SELECT blocked FROM contacts WHERE id = 'c1'").first("blocked")).toBe(1);
		await db.prepare("UPDATE contacts SET blocked = 0").run();
		expect(await (await request("POST", `/action/${token}`)).text()).toContain("already used");
		expect(await db.prepare("SELECT blocked FROM contacts WHERE id = 'c1'").first("blocked")).toBe(0);
	});
	it("accept the one-click unsubscribe POST without an Origin", async () => {
		const id = await addForward();
		const token = await signToken(TEST_SECRET, "unsubscribe", id, 600);
		const response = await request("POST", `/unsubscribe/${token}`, { origin: null, body: "List-Unsubscribe=One-Click" });
		expect(response.status).toBe(200);
	});
});

describe("the sender's own unsubscribe (items 7 and 17)", () => {
	const forward = (value: string, post = 0) => ({ original_unsubscribe: value, original_unsubscribe_post: post }) as ForwardRow;
	const limits = { blockedHosts: ["alias.test"], ownDomains: ["me.test", "r.me.test"] };

	it("refuses internal and unusual https addresses", () => {
		for (const bad of [
			"http://store.test/u",
			"https://127.0.0.1/u",
			"https://0x7f.1/u",
			"https://[::1]/u",
			"https://localhost/u",
			"https://intranet/u",
			"https://box.internal/u",
			"https://store.example:8443/u",
			"https://user:pw@store.example/u",
			"https://alias.test/u",
			"https://x.alias.test/u",
		]) {
			expect(safeHttpsUrl(bad, ["alias.test"]), bad).toBeNull();
		}
		expect(safeHttpsUrl("https://list.store.com/u?id=1")?.hostname).toBe("list.store.com");
	});

	it("only mails an address on the sender's own site, never this service's domains, with a clean subject", () => {
		expect(unsubscribePlan(forward("<mailto:leave@lists.store.com?subject=bye%0D%0ABcc:%20x@y.z&body=spam>"), "news@store.com", limits)).toEqual({
			kind: "mail",
			to: "leave@lists.store.com",
			subject: "bye Bcc: x@y.z",
		});
		expect(unsubscribePlan(forward("<mailto:victim@other.com>"), "news@store.com", limits)).toBeNull();
		expect(unsubscribePlan(forward("<mailto:someone@me.test>"), "news@me.test", limits)).toBeNull();
		expect(siteOf("mail.shop.co.uk")).toBe("shop.co.uk");
	});

	it("prefers a safe one-click POST and skips unsafe https", () => {
		expect(unsubscribePlan(forward("<https://127.0.0.1/u>, <https://esp.example.com/u>", 1), "a@store.com", limits)).toEqual({ kind: "post", url: "https://esp.example.com/u" });
	});
});

describe("inbound mail (items 12, 13 and 14)", () => {
	let sent: { subject: string }[];
	let downloads: number;
	const config = { mailflareUrl: "https://mailflare.test", mailflareApiKey: "k", webhookSecret: "w", signingSecret: TEST_SECRET, siteOrigin: "https://alias.test" } as never;

	function stubMailflare(raw: string) {
		downloads = 0;
		vi.stubGlobal("fetch", async (url: string) => {
			if (url.endsWith("/jmap/session")) return Response.json({ primaryAccounts: { "urn:ietf:params:jmap:mail": "acc" } });
			if (url.endsWith("/jmap/api")) {
				return Response.json({ methodResponses: [["Email/get", { list: [{ id: "m", mailboxIds: { mb: true }, blobId: "b", size: raw.length }] }, "0"]] });
			}
			downloads += 1;
			return new Response(raw);
		});
	}
	const send = (headers: string) => {
		sent = [];
		env = { ...env, EMAIL: { send: async (message: { subject: string }) => (sent.push(message), { messageId: "<x@y>" }) } } as unknown as Env;
		stubMailflare(`${headers}\r\nTo: shop@me.test\r\nSubject: Hello\r\nMessage-ID: <1@store.com>\r\nContent-Type: text/plain\r\n\r\nHi\r\n`);
	};
	const inbound = (id: string, from?: string) => handleInbound(env, config, { messageId: id, to: "shop@me.test", from }, ORIGIN);

	it("checks the envelope sender against the blocklist too", async () => {
		await db.prepare("INSERT INTO blocklist (id, kind, value, created_at) VALUES ('b1', 'domain', 'spammer.test', 1)").run();
		send("From: friend@store.com");
		expect((await inbound("m1", "bounce@spammer.test")).result).toMatch(/blocklist/);
		expect(await db.prepare("SELECT COUNT(*) AS n FROM contacts").first("n")).toBe(0);
	});

	it("marks the subject of a message that failed DMARC", async () => {
		send("Authentication-Results: mx.cloudflare.net; dmarc=fail header.from=bank.com\r\nFrom: Bank <alerts@bank.com>");
		await inbound("m2");
		expect(sent[0]?.subject).toBe("[Unverified sender] Hello");
		expect(await db.prepare("SELECT name FROM contacts").first("name")).toBeNull();
	});

	it("does not download mail for a deleted alias", async () => {
		await db.prepare("INSERT INTO aliases (address, mailbox_id, deleted_at, created_at, updated_at) VALUES ('shop@me.test', 'mb', 5, 1, 1)").run();
		send("From: a@store.com");
		expect((await inbound("m3")).result).toMatch(/deleted/);
		expect(downloads).toBe(0);
	});
});

describe("import forwarding addresses (item 15)", () => {
	const csv = "alias,mailboxes\nx@me.test,stranger@other.test\ny@me.test,y@me.test\nz@me.test,owner@gmail.test\n";
	const run = async (keepDestinations: boolean) => {
		const rows = parseAliasCsv(csv);
		const result = await importAliases(db, await loadSettings(db), "csv", selectByDomain(rows, ["me.test"]), rows.length, { keepDestinations });
		const { results } = await db.prepare("SELECT address, destination FROM aliases ORDER BY address").all<{ address: string; destination: string | null }>();
		return { result, destinations: Object.fromEntries(results.map((row) => [row.address, row.destination])) };
	};
	it("leaves new forwarding addresses out unless asked, and never loops", async () => {
		const off = await run(false);
		expect(off.destinations).toEqual({ "x@me.test": null, "y@me.test": null, "z@me.test": null });
		expect(off.result.newDestinations).toEqual([]);
	});
	it("lists the new forwarding addresses it added when asked", async () => {
		const on = await run(true);
		expect(on.destinations["x@me.test"]).toBe("stranger@other.test");
		expect(on.destinations["y@me.test"]).toBeNull();
		expect(on.result.newDestinations).toEqual(["stranger@other.test"]);
	});
});

describe("configuration from the environment (item 19)", () => {
	it("refuses a short signing secret and insecure URLs", async () => {
		await expect(loadConfig({ DB: db, SIGNING_SECRET: "short" } as unknown as Env)).rejects.toBeInstanceOf(ConfigError);
		await expect(loadConfig({ DB: db, SIGNING_SECRET: TEST_SECRET, MAILFLARE_URL: "http://mailflare.test" } as unknown as Env)).rejects.toBeInstanceOf(ConfigError);
		await expect(loadConfig({ DB: db, SIGNING_SECRET: TEST_SECRET, WORKER_NAME: "not a worker name" } as unknown as Env)).rejects.toBeInstanceOf(ConfigError);
	});
	it("replaces only a missing or too short stored secret", async () => {
		await db.prepare("INSERT INTO config (key, value) VALUES ('signingSecret', 'tooshort')").run();
		const first = await loadConfig({ DB: db } as Env);
		expect(first.signingSecret.length).toBeGreaterThanOrEqual(32);
		expect((await loadConfig({ DB: db } as Env)).signingSecret).toBe(first.signingSecret);
	});
});

describe("the Cloudflare API token (item 20)", () => {
	it("is never stored", async () => {
		const cookie = await signIn(db);
		vi.stubGlobal("fetch", async () => Response.json({ success: false, errors: [{ code: 1, message: "nope" }], result: null }));
		await request("POST", "/connection/cloudflare", { cookie, body: "cloudflareApiToken=tok123" });
		expect(await db.prepare("SELECT COUNT(*) AS n FROM config WHERE key = 'cloudflareApiToken'").first("n")).toBe(0);
	});
});

describe("API rate limit (item 23)", () => {
	it("is checked before the key is looked up", async () => {
		await saveSettings(db, { ...(await loadSettings(db)), simpleloginApi: true });
		let lookups = 0;
		const original = db.prepare.bind(db);
		db.prepare = ((sql: string) => {
			if (sql.includes("FROM api_keys")) lookups += 1;
			return original(sql);
		}) as D1Database["prepare"];
		env = { ...env, API_RATE_LIMIT: { limit: async () => ({ success: false }) } } as unknown as Env;
		const response = await app.fetch(new Request(`${ORIGIN}/api/user_info`, { headers: { Authentication: "af_whatever" } }), env);
		expect(response.status).toBe(429);
		expect(lookups).toBe(0);
	});
});

describe("notices and styles (hardening notes)", () => {
	it("shows only known notices, translated", async () => {
		const cookie = await signIn(db);
		const crafted = await (await request("GET", "/settings?notice=Your%20account%20is%20locked", { cookie })).text();
		expect(crafted).not.toContain("Your account is locked");
		const known = await (await request("GET", "/settings?notice=notice.newCreated&n.alias=a%40me.test", { cookie, headers: { "Sec-Fetch-Site": "same-origin" } })).text();
		expect(known).toContain("Created a@me.test.");
		// A link from another site cannot put its own words into a notice's values.
		const fromElsewhere = await (await request("GET", "/settings?notice=notice.newCreated&n.alias=Call%20us", { cookie, headers: { "Sec-Fetch-Site": "cross-site" } })).text();
		expect(fromElsewhere).not.toContain("Call us");
	});
	it("serves the stylesheet as a file and allows no inline styles", async () => {
		const response = await request("GET", "/assets/app.css");
		expect(response.headers.get("Content-Type")).toContain("text/css");
		expect(response.headers.get("Content-Security-Policy")).toContain("style-src 'self'");
		const login = await (await request("GET", "/setup")).text();
		expect(login).toContain("/assets/app.css");
		expect(login).not.toMatch(/<style|style="/);
	});
});
