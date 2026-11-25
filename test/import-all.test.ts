import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { loadSettings, saveSettings } from "../src/settings";
import { testDb } from "./helpers/d1";
import { signIn, TEST_SECRET } from "./helpers/session";

/** Everything addy.io has comes over; the blocklist takes several entries; labels are set in bulk. */
let db: D1Database;
let env: Env;

beforeEach(async () => {
	db = testDb();
	env = { DB: db, SIGNING_SECRET: TEST_SECRET } as unknown as Env;
	await saveSettings(db, { ...(await loadSettings(db)), aliasDomains: ["a.test"], defaultDestination: "owner@gmail.test" });
	await db.prepare("INSERT INTO config (key, value) VALUES ('siteOrigin', 'https://alias.test')").run();
});

afterEach(() => vi.unstubAllGlobals());

const post = async (cookie: string, path: string, form: Record<string, string | string[]>) => {
	const body = new URLSearchParams();
	for (const [name, value] of Object.entries(form)) for (const one of [value].flat()) body.append(name, one);
	return app.fetch(new Request(`https://alias.test${path}`, { method: "POST", headers: { cookie, origin: "https://alias.test", "content-type": "application/x-www-form-urlencoded" }, body }), env);
};

describe("importing from addy.io", () => {
	it("brings deleted aliases (deleted), labels, rules and the blocklist", async () => {
		const asked: string[] = [];
		vi.stubGlobal("fetch", async (url: string) => {
			const { pathname, search } = new URL(url);
			asked.push(pathname + decodeURIComponent(search));
			const json = (data: unknown, meta?: unknown) => Response.json({ data, ...(meta ? { meta } : {}) });
			if (pathname === "/api/v1/aliases") {
				return json(
					[
						{ id: 1, email: "news@a.test", active: true, description: "News", labels: [{ name: "Shopping", colour: "#06b6d4" }, { name: "Only on alias" }], recipients: [] },
						{ id: 2, email: "gone@a.test", active: true, pinned: true, deleted_at: "2026-01-01 00:00:00", labels: [], recipients: [] },
					],
					{ last_page: 1 },
				);
			}
			if (pathname === "/api/v1/labels") return json([{ id: "x", name: "Shopping", colour: "#06b6d4" }, { id: "y", name: "Work", colour: "#ef4444" }]);
			if (pathname === "/api/v1/rules") {
				return json([
					{ name: "Regex", order: 0, operator: "AND", conditions: [{ type: "sender", match: "matches regex", values: [".*"] }], actions: [{ type: "block" }] },
					{ name: "Tag news", order: 1, operator: "AND", conditions: [{ type: "sender", match: "ends with", values: ["@news.test"] }], actions: [{ type: "subject", value: "[News]" }], forwards: true, active: true },
				]);
			}
			if (pathname === "/api/v1/blocklist") return json([{ value: "spam@bad.test", type: "email", blocked: 4 }, { value: "bad.test", type: "domain", blocked: 0 }, { value: "not valid", type: "email" }]);
			return new Response("not found", { status: 404 });
		});
		const cookie = await signIn(db);
		const page = await (await post(cookie, "/import/addy", { apiKey: "k", domains: "a.test" })).text();
		expect(asked[0]).toContain("filter[deleted]=with");
		expect(asked[0]).toContain("with=recipients,labels");

		expect(await db.prepare("SELECT deleted_at, pinned, forward_mode FROM aliases WHERE address = 'gone@a.test'").first()).toEqual({ deleted_at: Date.UTC(2026, 0, 1) / 1000, pinned: 0, forward_mode: "none" });
		expect(await db.prepare("SELECT deleted_at FROM aliases WHERE address = 'news@a.test'").first()).toEqual({ deleted_at: null });
		// addy.io's cyan becomes the palette's nearest colour, so it shows as a colour here.
		const { results: labels } = await db.prepare("SELECT name, colour FROM labels ORDER BY name").all();
		expect(labels).toEqual([
			{ name: "Only on alias", colour: expect.stringMatching(/^#[0-9a-f]{6}$/) },
			{ name: "Shopping", colour: "#0ea5e9" },
			{ name: "Work", colour: "#f43f5e" },
		]);
		const { results: tagged } = await db.prepare("SELECT l.name FROM alias_labels al JOIN labels l ON l.id = al.label_id WHERE al.alias_address = 'news@a.test' ORDER BY l.name").all();
		expect(tagged).toEqual([{ name: "Only on alias" }, { name: "Shopping" }]);
		const { results: rules } = await db.prepare("SELECT name, conditions FROM rules").all();
		expect(rules).toEqual([{ name: "Tag news", conditions: JSON.stringify([{ type: "sender", match: "ends with", values: ["@news.test"] }]) }]);
		const { results: blocked } = await db.prepare("SELECT kind, value, hits FROM blocklist ORDER BY value").all();
		expect(blocked).toEqual([
			{ kind: "domain", value: "bad.test", hits: 0 },
			{ kind: "address", value: "spam@bad.test", hits: 4 },
		]);
		expect(page).toContain("1 of them were deleted there");
		expect(page).toContain("3 labels added.");
		expect(page).toContain("1 rules added.");
		expect(page).toContain("2 senders added to the blocklist.");
		expect(page).toContain("<li>Regex</li>");

		// Importing again adds nothing twice.
		await post(cookie, "/import/addy", { apiKey: "k", domains: "a.test" });
		expect(await db.prepare("SELECT (SELECT COUNT(*) FROM rules) AS rules, (SELECT COUNT(*) FROM labels) AS labels, (SELECT COUNT(*) FROM blocklist) AS blocked, (SELECT COUNT(*) FROM alias_labels) AS tags").first()).toEqual({
			rules: 1,
			labels: 3,
			blocked: 2,
			tags: 2,
		});
	});

	it("still imports the aliases when the labels, rules or blocklist cannot be read", async () => {
		vi.stubGlobal("fetch", async (url: string) => {
			const { pathname } = new URL(url);
			if (pathname === "/api/v1/aliases") return Response.json({ data: [{ id: 1, email: "news@a.test", active: true }], meta: { last_page: 1 } });
			return new Response("not found", { status: 404 });
		});
		const cookie = await signIn(db);
		const page = await (await post(cookie, "/import/addy", { apiKey: "k", domains: "a.test" })).text();
		expect(await db.prepare("SELECT COUNT(*) AS n FROM aliases").first()).toEqual({ n: 1 });
		expect(page).toContain("labels, rules, blocklist");
	});
});

describe("the blocklist", () => {
	it("takes several senders at once, separated by commas, spaces or lines", async () => {
		const cookie = await signIn(db);
		const response = await post(cookie, "/blocklist", { value: "Spam@Bad.test, @junk.test;<x@y.test>\nnot-valid  junk.test" });
		expect(response.headers.get("location")).toContain("notice.blockedSome");
		const { results } = await db.prepare("SELECT kind, value FROM blocklist ORDER BY value").all();
		expect(results).toEqual([
			{ kind: "domain", value: "junk.test" },
			{ kind: "address", value: "spam@bad.test" },
			{ kind: "address", value: "x@y.test" },
		]);
		// Full-width and Arabic commas separate too.
		await post(cookie, "/blocklist", { value: "w1@bad.test，w2@bad.test、w3@bad.test،w4@bad.test" });
		expect(await db.prepare("SELECT COUNT(*) AS n FROM blocklist WHERE value LIKE 'w_@bad.test'").first()).toEqual({ n: 4 });
		const one = await post(cookie, "/blocklist", { value: "solo@bad.test" });
		expect(one.headers.get("location")).toContain("notice.blocked&");
	});
});

describe("labels in bulk", () => {
	it("adds and removes several labels at once, and asks for one when none is chosen", async () => {
		const cookie = await signIn(db);
		for (const name of ["One", "Two"]) await post(cookie, "/labels", { name, colour: "#6366f1" });
		const ids = (await db.prepare("SELECT id FROM labels ORDER BY name").all<{ id: string }>()).results.map((row) => row.id);
		for (const address of ["p@a.test", "q@a.test"]) await db.prepare("INSERT INTO aliases (address, num_id, uid, created_at, updated_at) VALUES (?, ?, ?, 1, 1)").bind(address, address.length + address.charCodeAt(0), address).run();
		await post(cookie, "/aliases/bulk", { action: "label", labels: ids, ids: ["p@a.test", "q@a.test"], back: "/" });
		expect(await db.prepare("SELECT COUNT(*) AS n FROM alias_labels").first()).toEqual({ n: 4 });
		await post(cookie, "/aliases/bulk", { action: "unlabel", labels: ids, ids: ["p@a.test"], back: "/" });
		expect(await db.prepare("SELECT COUNT(*) AS n FROM alias_labels").first()).toEqual({ n: 2 });
		const none = await post(cookie, "/aliases/bulk", { action: "label", ids: ["p@a.test"], back: "/" });
		expect(none.headers.get("location")).toContain("notice.bulkNoLabels");
		// The list offers two actions and one picker, not two options per label.
		const list = await (await app.fetch(new Request("https://alias.test/", { headers: { cookie } }), env)).text();
		expect(list).toContain('<option value="label" data-needs-labels>');
		expect([...list.matchAll(/name="labels" value="lb_/g)]).toHaveLength(2);
	});
});
