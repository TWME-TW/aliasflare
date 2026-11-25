import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiKey } from "../src/apikeys";
import type { AppConfig } from "../src/config";
import worker, { app } from "../src/index";
import { handleReverseAliasMail } from "../src/reply";
import { cleanRule, ruleMatches, type Rule } from "../src/rules";
import { loadSettings, saveSettings } from "../src/settings";
import { testDb } from "./helpers/d1";
import { signIn, TEST_SECRET } from "./helpers/session";

/** Labels, rules and failed deliveries: the dashboard and the addy.io API. */
let db: D1Database;
let env: Env;
let key: string;
let sent: { to: { email: string } | string; subject: string; from: unknown; attachments?: unknown[]; html?: string; text?: string }[];

const call = async (path: string, method = "GET", body?: unknown) => {
	const response = await app.fetch(
		new Request(`https://alias.test/api${path}`, {
			method,
			headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
		env,
	);
	return { status: response.status, json: (response.status === 204 ? null : await response.json()) as any };
};

const post = async (cookie: string, path: string, form: Record<string, string | string[]>) => {
	const body = new URLSearchParams();
	for (const [name, value] of Object.entries(form)) for (const one of [value].flat()) body.append(name, one);
	return app.fetch(
		new Request(`https://alias.test${path}`, { method: "POST", headers: { cookie, origin: "https://alias.test", "content-type": "application/x-www-form-urlencoded" }, body }),
		env,
	);
};
const get = async (cookie: string, path: string) => (await app.fetch(new Request(`https://alias.test${path}`, { headers: { cookie } }), env)).text();

beforeEach(async () => {
	db = testDb();
	sent = [];
	env = {
		DB: db,
		SIGNING_SECRET: TEST_SECRET,
		EMAIL: { send: async (message: (typeof sent)[number]) => (sent.push(message), { messageId: `<s${sent.length}@test>` }) },
	} as unknown as Env;
	await saveSettings(db, { ...(await loadSettings(db)), addyApi: true, aliasDomains: ["a.test"], defaultDestination: "me@home.test" });
	await db.prepare("INSERT INTO config (key, value) VALUES ('siteOrigin', 'https://alias.test')").run();
	({ key } = await createApiKey(db, "app", "apps"));
	await db
		.prepare("INSERT INTO aliases (address, num_id, uid, forward_mode, forward_enabled, created_at, updated_at) VALUES ('shop@a.test', 1, 'u1', 'all', 1, 1, 1), ('news@a.test', 2, 'u2', 'all', 1, 2, 2)")
		.run();
});

describe("labels in the addy.io API", () => {
	it("are created, given to aliases, filtered on, renamed and deleted", async () => {
		const created = await call("/v1/labels", "POST", { name: "Shopping", colour: "#FF0000" });
		expect(created.status).toBe(201);
		expect(created.json.data).toMatchObject({ name: "Shopping", colour: "#ff0000" });
		const id = created.json.data.id;
		expect((await call("/v1/labels", "POST", { name: "shopping" })).status).toBe(422);
		expect((await call("/v1/labels", "POST", { name: "" })).status).toBe(422);

		await call("/v1/aliases/labels/bulk", "POST", { ids: ["u1"], label_ids: [id] });
		const one = await call("/v1/aliases/u1");
		expect(one.json.data.labels).toEqual([expect.objectContaining({ id, name: "Shopping" })]);
		const filtered = await call(`/v1/aliases?filter[label]=${id}`);
		expect(filtered.json.data.map((alias: { id: string }) => alias.id)).toEqual(["u1"]);
		expect((await call("/v1/labels")).json.data[0]).toMatchObject({ id, aliases_count: 1 });

		const made = await call("/v1/aliases", "POST", { domain: "a.test", format: "custom", local_part: "new", label_ids: [id] });
		expect(made.json.data.labels.map((label: { id: string }) => label.id)).toEqual([id]);

		expect((await call(`/v1/labels/${id}`, "PATCH", { name: "Shops", colour: "#00ff00" })).json.data).toMatchObject({ name: "Shops", colour: "#00ff00" });
		expect((await call(`/v1/labels/${id}`, "DELETE")).status).toBe(204);
		expect((await call("/v1/aliases/u1")).json.data.labels).toEqual([]);
		expect(await db.prepare("SELECT COUNT(*) AS n FROM alias_labels").first()).toEqual({ n: 0 });
	});
});

describe("labels in the dashboard", () => {
	it("are managed on their page, set on the alias page, added in bulk and filtered on", async () => {
		const cookie = await signIn(db);
		expect((await post(cookie, "/labels", { name: "Work", colour: "#6366f1" })).status).toBe(302);
		const { id } = (await db.prepare("SELECT id FROM labels").first<{ id: string }>())!;
		expect(await get(cookie, "/labels")).toContain("Work");

		await post(cookie, "/aliases/shop%40a.test/labels", { labels: [id] });
		expect(await get(cookie, "/aliases/shop%40a.test")).toMatch(/value="lb_[0-9a-f]+" checked/);

		await post(cookie, "/aliases/bulk", { action: `label:${id}`, ids: ["news@a.test", "shop@a.test"], back: "/" });
		expect(await db.prepare("SELECT COUNT(*) AS n FROM alias_labels WHERE label_id = ?").bind(id).first()).toEqual({ n: 2 });
		await post(cookie, "/aliases/bulk", { action: `unlabel:${id}`, ids: ["news@a.test"], back: "/" });

		const page = await get(cookie, `/?label=${id}`);
		expect(page).toContain("shop@a.test");
		expect(page).not.toContain(">news@a.test<");
		expect(page).toContain('class="label-chip"');

		await post(cookie, `/labels/${id}/delete`, {});
		expect(await db.prepare("SELECT COUNT(*) AS n FROM labels").first()).toEqual({ n: 0 });
	});
});

describe("rules", () => {
	const rule = (raw: Record<string, unknown>) => ({ ...cleanRule(raw), id: "r", position: 0, applied: 0, last_applied: null, created_at: 0, updated_at: 0 }) as unknown as Rule;

	it("match on sender, subject and alias, with any or all conditions", () => {
		const message = { sender: "Deals@Shop.test", subject: "Big SALE today", alias: "shop@a.test" };
		expect(ruleMatches(rule({ name: "x", conditions: [{ type: "sender", match: "ends with", values: ["@shop.test"] }], actions: [{ type: "block" }] }), message)).toBe(true);
		expect(ruleMatches(rule({ name: "x", conditions: [{ type: "subject", match: "contains", values: "promo, sale" }], actions: [{ type: "block" }] }), message)).toBe(true);
		expect(ruleMatches(rule({ name: "x", conditions: [{ type: "subject", match: "does not contain", values: ["promo", "sale"] }], actions: [{ type: "block" }] }), message)).toBe(false);
		const both = { name: "x", conditions: [{ type: "alias", match: "is exactly", values: ["other@a.test"] }, { type: "sender", match: "starts with", values: ["deals"] }], actions: [{ type: "block" }] };
		expect(ruleMatches(rule(both), message)).toBe(false);
		expect(ruleMatches(rule({ ...both, operator: "OR" }), message)).toBe(true);
	});

	it("refuse a rule without a name, condition or supported action", () => {
		expect(() => cleanRule({ name: "", conditions: [{ type: "sender", match: "contains", values: ["x"] }], actions: [{ type: "block" }] })).toThrow();
		expect(() => cleanRule({ name: "x", conditions: [{ type: "sender", match: "matches regex", values: ["x"] }], actions: [{ type: "block" }] })).toThrow();
		expect(() => cleanRule({ name: "x", conditions: [{ type: "sender", match: "contains", values: ["x"] }], actions: [{ type: "webhook", value: "https://x" }] })).toThrow();
	});

	it("are created, reordered, turned off and deleted through the addy.io API", async () => {
		const recipients = (await call("/v1/recipients")).json.data as { id: string; email: string }[];
		const home = recipients.find((r) => r.email === "me@home.test")!;
		const a = await call("/v1/rules", "POST", {
			name: "Deals",
			conditions: [{ type: "sender", match: "contains", values: ["deals"] }],
			actions: [{ type: "forwardTo", value: home.id }],
			operator: "AND",
			forwards: true,
			replies: false,
			sends: false,
		});
		expect(a.status).toBe(201);
		expect(a.json.data).toMatchObject({ name: "Deals", order: 0, active: true, actions: [{ type: "forwardTo", value: home.id }] });
		expect((await call("/v1/rules", "POST", { name: "Bad", conditions: [{ type: "sender", match: "contains", values: ["x"] }], actions: [{ type: "forwardTo", value: "nope" }] })).status).toBe(422);
		const b = await call("/v1/rules", "POST", { name: "Second", conditions: [{ type: "subject", match: "contains", values: ["x"] }], actions: [{ type: "block", value: true }] });
		await call("/v1/reorder-rules", "POST", { ids: [b.json.data.id, a.json.data.id] });
		expect((await call("/v1/rules")).json.data.map((r: { name: string }) => r.name)).toEqual(["Second", "Deals"]);
		expect((await call(`/v1/active-rules/${b.json.data.id}`, "DELETE")).status).toBe(204);
		expect((await call(`/v1/rules/${b.json.data.id}`)).json.data.active).toBe(false);
		expect((await call(`/v1/rules/${b.json.data.id}`, "PATCH", { name: "Renamed", conditions: [{ type: "subject", match: "is exactly", values: ["y"] }], actions: [{ type: "subject", value: "Z" }] })).json.data).toMatchObject({ name: "Renamed" });
		expect((await call(`/v1/rules/${a.json.data.id}`, "DELETE")).status).toBe(204);
		expect((await call("/v1/rules")).json.data).toHaveLength(1);
	});

	it("are made in the dashboard's editor", async () => {
		const cookie = await signIn(db);
		const response = await post(cookie, "/rules", {
			name: "Receipts",
			operator: "AND",
			cond_type_0: "subject",
			cond_match_0: "contains",
			cond_values_0: "receipt, invoice",
			cond_type_1: "sender",
			cond_match_1: "contains",
			cond_values_1: "",
			act_type_0: "subject",
			act_value_0: "[Receipt]",
			act_type_1: "",
			forwards: "1",
			active: "1",
		});
		expect(response.headers.get("location")).toContain("notice.ruleSaved");
		const rules = await (await import("../src/rules")).listRules(db);
		expect(rules).toHaveLength(1);
		expect(rules[0]).toMatchObject({ name: "Receipts", conditions: [{ type: "subject", match: "contains", values: ["receipt", "invoice"] }], actions: [{ type: "subject", value: "[Receipt]" }] });
		expect(await get(cookie, "/rules")).toContain("Receipts");
		expect(await get(cookie, `/rules/${rules[0]!.id}`)).toContain('value="receipt, invoice"');
		const own = await post(cookie, "/rules", { name: "Loop", cond_type_0: "sender", cond_match_0: "contains", cond_values_0: "x", act_type_0: "forwardTo", act_value_0: "x@a.test", forwards: "1" });
		expect(own.headers.get("location")).toContain("notice.ruleForwardTo");
	});
});

const deliver = async (from: string, subject: string, to = "shop@a.test") => {
	const raw = [
		`From: ${from}`,
		`To: ${to}`,
		`Subject: ${subject}`,
		`Message-ID: <${crypto.randomUUID()}@x>`,
		"MIME-Version: 1.0",
		'Content-Type: multipart/mixed; boundary="b"',
		"",
		"--b",
		"Content-Type: text/plain",
		"",
		"Hello",
		"--b",
		'Content-Type: application/pdf; name="a.pdf"',
		'Content-Disposition: attachment; filename="a.pdf"',
		"Content-Transfer-Encoding: base64",
		"",
		"JVBERi0xLjQK",
		"--b--",
		"",
	].join("\r\n");
	await worker.email!({ to, from, headers: new Headers({ From: from, To: to }), raw: new Response(raw).body, rawSize: raw.length, forward: async () => {}, setReject: () => {} } as never, env);
};

describe("rules on forwarded mail", () => {
	it("block, rewrite the subject and sender name, remove attachments and forward elsewhere", async () => {
		await call("/v1/rules", "POST", { name: "No ads", conditions: [{ type: "subject", match: "contains", values: ["ad:"] }], actions: [{ type: "block" }] });
		await call("/v1/rules", "POST", {
			name: "Receipts",
			conditions: [{ type: "sender", match: "ends with", values: ["@shop.test"] }],
			actions: [{ type: "subject", value: "Receipt" }, { type: "displayFrom", value: "The Shop" }, { type: "removeAttachments", value: true }],
		});
		await deliver("promo@other.test", "AD: buy now");
		expect(sent).toHaveLength(0);
		expect(await db.prepare("SELECT error FROM forwards").first()).toEqual({ error: "blocked by the rule No ads" });

		await deliver("orders@shop.test", "Your order");
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ subject: "Receipt", from: { name: "The Shop" }, attachments: [] });

		const cookie = await signIn(db);
		await post(cookie, "/rules", { name: "Lists", cond_type_0: "alias", cond_match_0: "is exactly", cond_values_0: "news@a.test", act_type_0: "forwardTo", act_value_0: "lists@home.test", forwards: "1", active: "1" });
		await deliver("someone@else.test", "Weekly", "news@a.test");
		expect(sent[1]?.to).toMatchObject({ email: "lists@home.test" });
		const applied = await db.prepare("SELECT name, applied FROM rules ORDER BY position").all();
		expect(applied.results).toEqual([
			{ name: "No ads", applied: 1 },
			{ name: "Receipts", applied: 1 },
			{ name: "Lists", applied: 1 },
		]);
	});
});

describe("rules on replies", () => {
	const config = { mailflareUrl: "https://mailflare.test", mailflareApiKey: "k", webhookSecret: "w" } as AppConfig;
	let outgoing: { subject?: string }[];
	beforeEach(async () => {
		outgoing = [];
		await db.prepare("UPDATE aliases SET mailbox_id = 'mb1' WHERE address = 'shop@a.test'").run();
		await db.prepare("INSERT INTO contacts (id, alias_address, email, reverse_local, created_at) VALUES ('c1', 'shop@a.test', 'bob@store.test', 'rbob', 1)").run();
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			outgoing.push(JSON.parse(String(init.body)));
			return Response.json({ ok: true });
		});
	});
	afterEach(() => vi.unstubAllGlobals());
	const reply = async (subject: string) => {
		const raw = `Authentication-Results: mx.cloudflare.net; spf=pass; dmarc=pass header.from=home.test\r\nFrom: me@home.test\r\nTo: reply+rbob@r.a.test\r\nSubject: ${subject}\r\nContent-Type: text/plain\r\n\r\nHi\r\n`;
		let rejected: string | null = null;
		await handleReverseAliasMail({ to: "reply+rbob@r.a.test", raw: new Response(raw).body, setReject: (why: string) => void (rejected = why) } as never, env, config);
		return rejected;
	};

	it("act only when asked to, with the correspondent as the sender", async () => {
		await call("/v1/rules", "POST", { name: "Never Bob", conditions: [{ type: "sender", match: "is exactly", values: ["bob@store.test"] }], actions: [{ type: "block" }], forwards: false, replies: true });
		await call("/v1/rules", "POST", { name: "Tag", conditions: [{ type: "subject", match: "starts with", values: ["re:"] }], actions: [{ type: "subject", value: "Tagged" }], forwards: true, replies: false });
		expect(await reply("Re: hello")).toContain("Never Bob");
		expect(outgoing).toHaveLength(0);
		await call("/v1/rules", "GET");
		const id = (await db.prepare("SELECT id FROM rules WHERE name = 'Never Bob'").first<{ id: string }>())!.id;
		await call(`/v1/active-rules/${id}`, "DELETE");
		expect(await reply("Re: hello")).toBeNull();
		expect(outgoing[0]?.subject).toBe("Re: hello");
	});
});

describe("failed deliveries in the addy.io API", () => {
	it("list forwards that failed, and delete one", async () => {
		await db
			.prepare(
				"INSERT INTO forwards (id, inbound_id, alias_address, status, error, created_at, updated_at) VALUES ('f1', 'i1', 'shop@a.test', 'failed', 'mailbox full', 5, 6), ('f2', 'i2', 'shop@a.test', 'sent', NULL, 7, 7)",
			)
			.run();
		const list = await call("/v1/failed-deliveries");
		expect(list.json.data).toEqual([expect.objectContaining({ id: "f1", alias_email: "shop@a.test", alias_id: "u1", code: "mailbox full", status: "failed" })]);
		expect(list.json.meta).toMatchObject({ total: 1, links: [] });
		expect((await call("/v1/failed-deliveries/f1")).json.data.id).toBe("f1");
		expect((await call("/v1/failed-deliveries/f1/resend", "POST")).status).toBe(422);
		expect((await call("/v1/failed-deliveries/f2", "DELETE")).status).toBe(404);
		expect((await call("/v1/failed-deliveries/f1", "DELETE")).status).toBe(204);
		expect((await call("/v1/failed-deliveries")).json.data).toEqual([]);
	});
});
