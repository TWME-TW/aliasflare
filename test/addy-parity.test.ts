import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiKey } from "../src/apikeys";
import { aliasesCsv, csvCell } from "../src/export";
import worker, { app } from "../src/index";
import { parseAliasCsv } from "../src/importer";
import { callWebhooks, cleanRule, runRules, webhookKey, RuleError } from "../src/rules";
import { hmacHex } from "../src/crypto";
import { loadSettings, saveSettings } from "../src/settings";
import { testDb } from "./helpers/d1";
import { signIn, TEST_SECRET } from "./helpers/session";

/** What addy.io has that aliasflare gained: catch-all per domain, alias export, webhook rules. */
let db: D1Database;
let env: Env;
let key: string;
let sent: unknown[];

const ORIGIN = "https://alias.test";
const call = async (path: string, method = "GET", body?: unknown) => {
	const response = await app.fetch(
		new Request(`${ORIGIN}/api${path}`, {
			method,
			headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
		env,
	);
	return { status: response.status, json: (response.status === 204 ? null : await response.json()) as any };
};
const post = (cookie: string, path: string, form: Record<string, string>) =>
	app.fetch(new Request(`${ORIGIN}${path}`, { method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) }), env);

/** One message to `to`, the way Email Routing hands it to the Worker. */
async function deliver(to: string, subject = "Hi") {
	const raw = `From: bob@store.test\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${crypto.randomUUID()}@x>\r\n\r\nHello\r\n`;
	const message = { to, from: "bob@store.test", headers: new Headers(), raw: new Response(raw).body, rawSize: raw.length, setReject: () => undefined };
	await worker.email!(message as never, env);
}
const aliasCount = async () => Number((await db.prepare("SELECT COUNT(*) AS n FROM aliases").first<{ n: number }>())?.n);

beforeEach(async () => {
	db = testDb();
	sent = [];
	env = { DB: db, SIGNING_SECRET: TEST_SECRET, EMAIL: { send: async (message: unknown) => (sent.push(message), { messageId: "<s@test>" }) } } as unknown as Env;
	await saveSettings(db, { ...(await loadSettings(db)), addyApi: true, aliasDomains: ["a.test", "b.test"], defaultDestination: "me@home.test" });
	await db.prepare("INSERT INTO config (key, value) VALUES ('siteOrigin', ?)").bind(ORIGIN).run();
	({ key } = await createApiKey(db, "app", "apps"));
});

afterEach(() => vi.unstubAllGlobals());

describe("mail creating aliases, domain by domain", () => {
	it("creates aliases on a domain that allows it and refuses them on one that does not", async () => {
		await saveSettings(db, { ...(await loadSettings(db)), aliasesFromMailOff: ["b.test"] });
		await deliver("new@b.test");
		expect(await aliasCount()).toBe(0);
		await deliver("new@a.test");
		expect(await aliasCount()).toBe(1);
	});

	it("saves the ticked domains, and a domain added in the same save starts on", async () => {
		const cookie = await signIn(db);
		await post(cookie, "/settings", {
			aliasDomains: "a.test b.test c.test",
			createAliasesFromMail: "1",
			"fromMailShown:a.test": "1",
			"fromMail:a.test": "1",
			"fromMailShown:b.test": "1",
		});
		const settings = await loadSettings(db);
		expect(settings.aliasDomains).toEqual(["a.test", "b.test", "c.test"]);
		expect(settings.aliasesFromMailOff).toEqual(["b.test"]);
		const page = await (await app.fetch(new Request(`${ORIGIN}/settings`, { headers: { cookie } }), env)).text();
		expect(page).toContain('name="fromMail:a.test" value="1" checked');
		expect(page).not.toContain('name="fromMail:b.test" value="1" checked');
	});

	it("is shown and switched per domain in the addy.io API", async () => {
		const domains = (await call("/v1/domains")).json.data;
		expect(domains.map((d: { catch_all: boolean }) => d.catch_all)).toEqual([true, true]);
		expect((await call(`/v1/catch-all-domains/${domains[1].id}`, "DELETE")).status).toBe(204);
		expect((await loadSettings(db)).aliasesFromMailOff).toEqual(["b.test"]);
		const on = await call("/v1/catch-all-domains", "POST", { id: domains[1].id });
		expect(on.json.data).toMatchObject({ domain: "b.test", catch_all: true });
		expect((await loadSettings(db)).aliasesFromMailOff).toEqual([]);
		expect((await call("/v1/catch-all-domains", "POST", { id: "nope" })).status).toBe(404);
	});

	it("turning one domain on while mail creates no aliases anywhere leaves the others off", async () => {
		await saveSettings(db, { ...(await loadSettings(db)), createAliasesFromMail: false });
		const domains = (await call("/v1/domains")).json.data;
		expect(domains.map((d: { catch_all: boolean }) => d.catch_all)).toEqual([false, false]);
		await call("/v1/catch-all-domains", "POST", { id: domains[0].id });
		const settings = await loadSettings(db);
		expect({ on: settings.createAliasesFromMail, off: settings.aliasesFromMailOff }).toEqual({ on: true, off: ["b.test"] });
	});

	it("is a setting apps change only when they may", async () => {
		await saveSettings(db, { ...(await loadSettings(db)), appSettings: false });
		const domains = (await call("/v1/domains")).json.data;
		expect((await call(`/v1/catch-all-domains/${domains[0].id}`, "DELETE")).status).toBe(403);
	});
});

describe("exporting aliases", () => {
	it("downloads every alias, deleted ones and labels included, for the owner only", async () => {
		await db
			.prepare(
				"INSERT INTO aliases (address, num_id, uid, forward_mode, forward_enabled, note, name, pinned, destination, deleted_at, created_at, updated_at) VALUES ('shop@a.test', 1, 'u1', 'no_promotions', 1, 'Shop, \"big\"', 'Me', 1, 'x@home.test', NULL, 1700000000, 1), ('old@a.test', 2, 'u2', 'none', 0, NULL, NULL, 0, NULL, 1700000100, 1700000050, 1)",
			)
			.run();
		await db.prepare("INSERT INTO labels (id, name, colour, created_at, updated_at) VALUES ('lb_1', 'Shopping', 'blue', 1, 1), ('lb_2', 'Money', 'green', 1, 1)").run();
		await db.prepare("INSERT INTO alias_labels (alias_address, label_id) VALUES ('shop@a.test', 'lb_1'), ('shop@a.test', 'lb_2')").run();
		expect((await app.fetch(new Request(`${ORIGIN}/export/aliases.csv`), env)).status).not.toBe(200);
		const response = await app.fetch(new Request(`${ORIGIN}/export/aliases.csv`, { headers: { cookie: await signIn(db) } }), env);
		expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
		expect(response.headers.get("Content-Disposition")).toMatch(/^attachment; filename="aliasflare-aliases-\d{4}-\d{2}-\d{2}\.csv"$/);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		const csv = await response.text();
		expect(csv.split("\r\n")).toEqual([
			"email,description,from_name,active,forward_mode,pinned,recipients,labels,created_at,last_used_at,deleted_at",
			'shop@a.test,"Shop, ""big""",Me,true,no_promotions,true,x@home.test,Money;Shopping,2023-11-14 22:13:20,,',
			"old@a.test,,,false,none,false,,,2023-11-14 22:14:10,,2023-11-14 22:15:00",
			"",
		]);
	});

	it("keeps a spreadsheet from reading a note as a formula, and the import reads it back", () => {
		expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
		expect(csvCell("-1")).toBe("'-1");
		expect(csvCell("plain")).toBe("plain");
		const csv = aliasesCsv(
			[{ address: "shop@a.test", note: "=cmd", name: "@me", forward_mode: "no_promotions", pinned: 1, destination: null, created_at: 1700000000, last_used_at: null, deleted_at: null }],
			new Map([["shop@a.test", ["Shopping", "Money"]]]),
		);
		const [alias] = parseAliasCsv(csv);
		expect(alias).toMatchObject({ email: "shop@a.test", note: "=cmd", name: "@me", enabled: true, pinned: true, forwardMode: "no_promotions", labels: ["Shopping", "Money"], createdAt: 1700000000 });
	});

	it("imports its own export again, labels and forwarding included", async () => {
		const cookie = await signIn(db);
		const csv = aliasesCsv(
			[{ address: "shop@a.test", note: "n", name: null, forward_mode: "no_promotions", pinned: 0, destination: null, created_at: 1700000000, last_used_at: null, deleted_at: null }],
			new Map([["shop@a.test", ["Shopping"]]]),
		);
		const form = new FormData();
		form.set("file", new File([csv], "aliases.csv", { type: "text/csv" }));
		form.set("domains", "a.test");
		await app.fetch(new Request(`${ORIGIN}/import/csv`, { method: "POST", headers: { cookie, origin: ORIGIN }, body: form }), env);
		expect(await db.prepare("SELECT forward_mode, note FROM aliases WHERE address = 'shop@a.test'").first()).toEqual({ forward_mode: "no_promotions", note: "n" });
		const labels = await db.prepare("SELECT l.name FROM alias_labels al JOIN labels l ON l.id = al.label_id WHERE al.alias_address = 'shop@a.test'").all<{ name: string }>();
		expect(labels.results.map((row) => row.name)).toEqual(["Shopping"]);
	});
});

describe("webhook rules", () => {
	const rule = (url: string) => ({ name: "Hook", conditions: [{ type: "sender", match: "contains", values: ["store"] }], actions: [{ type: "webhook", value: url }] });

	it("take a public https address only", () => {
		expect(cleanRule(rule("https://hooks.example.com/x?t=1")).actions).toEqual([{ type: "webhook", value: "https://hooks.example.com/x?t=1" }]);
		for (const bad of ["http://hooks.example.com/", "https://127.0.0.1/", "https://localhost/", "https://u:p@hooks.example.com/", "https://hooks.example.com:8443/", `https://x.example.com/${"a".repeat(600)}`]) {
			expect(() => cleanRule(rule(bad)), bad).toThrow(RuleError);
		}
	});

	it("refuse this deployment's own host, which would call itself for every message", () => {
		// Every other place an owner-entered address is called (SMTP, a custom sender, the importer's
		// server, unsubscribe targets) blocks the deployment's own hosts; a webhook into aliasflare
		// would fire on each matching message and loop back into the same Worker.
		const self = ["mail.example.com"];
		expect(() => cleanRule(rule("https://mail.example.com/webhook"), self)).toThrow(RuleError);
		expect(() => cleanRule(rule("https://sub.mail.example.com/webhook"), self)).toThrow(RuleError);
		// Another host is still fine, and the same address passes when it is not ours.
		expect(cleanRule(rule("https://hooks.example.com/in"), self).actions).toEqual([{ type: "webhook", value: "https://hooks.example.com/in" }]);
		expect(cleanRule(rule("https://mail.example.com/webhook")).actions).toEqual([{ type: "webhook", value: "https://mail.example.com/webhook" }]);
	});

	it("are called, signed, when a forwarded message matches, and the message still goes", async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		vi.stubGlobal("fetch", async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response("ok")));
		const created = await call("/v1/rules", "POST", { ...rule("https://hooks.example.com/in"), operator: "AND", forwards: true });
		expect(created.status).toBe(201);
		await deliver("shop@a.test", "Order 1");
		expect(sent).toHaveLength(1);
		expect(calls).toHaveLength(1);
		const body = String(calls[0]!.init.body);
		expect(JSON.parse(body)).toMatchObject({ event: "rule.matched", rule: "Hook", alias: "shop@a.test", sender: "bob@store.test", subject: "Order 1" });
		const signature = (calls[0]!.init.headers as Record<string, string>)["X-Aliasflare-Signature"];
		expect(signature).toBe(await hmacHex(await webhookKey(TEST_SECRET), body));
	});

	it("never hold up or fail the message when the receiver fails", async () => {
		vi.stubGlobal("fetch", async () => {
			throw new Error("down");
		});
		await callWebhooks(TEST_SECRET, [{ rule: "Hook", url: "https://hooks.example.com/" }], { alias: "a@a.test", sender: "b@b.test", subject: "s" });
		await call("/v1/rules", "POST", { ...rule("https://hooks.example.com/in"), operator: "AND", forwards: true });
		await deliver("shop@a.test");
		expect(sent).toHaveLength(1);
	});

	it("call at most three webhooks for one message", async () => {
		for (let i = 0; i < 5; i += 1) await call("/v1/rules", "POST", { ...rule(`https://hooks.example.com/${i}`), name: `Hook ${i}`, operator: "AND", forwards: true });
		const outcome = await runRules(db, "forwards", { sender: "bob@store.test", subject: "s", alias: "shop@a.test" });
		expect(outcome.webhooks).toHaveLength(3);
	});

	it("show the signing key on the Rules page once a rule has one", async () => {
		const cookie = await signIn(db);
		const page = async () => (await app.fetch(new Request(`${ORIGIN}/rules`, { headers: { cookie } }), env)).text();
		const keyText = await webhookKey(TEST_SECRET);
		expect(await page()).not.toContain(keyText);
		await call("/v1/rules", "POST", { ...rule("https://hooks.example.com/in?token=secret"), operator: "AND", forwards: true });
		const shown = await page();
		expect(shown).toContain(keyText);
		// The list shows only the host: a webhook address often carries a token.
		expect(shown).toContain("(hooks.example.com)");
		expect(shown).not.toContain("token=secret");
	});
});
