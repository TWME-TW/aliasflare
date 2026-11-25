import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../src/crypto";
import worker, { app } from "../src/index";
import { loadSettings, normalizeSettings, saveSettings, unsubscribeRuleFor, type Settings } from "../src/settings";
import { testDb } from "./helpers/d1";
import { signIn, TEST_SECRET } from "./helpers/session";

/** Unsubscribe: redirecting a sender, the fallback, and per-domain rules. */
let db: D1Database;
let env: Env;
let sent: { to: { email: string } | string }[];
const ORIGIN = "https://alias.test";

beforeEach(async () => {
	db = testDb();
	sent = [];
	env = {
		DB: db,
		SIGNING_SECRET: TEST_SECRET,
		EMAIL: { send: async (message: (typeof sent)[number]) => (sent.push(message), { messageId: `<s${sent.length}@test>` }) },
	} as unknown as Env;
	await db.prepare("INSERT INTO config (key, value) VALUES ('siteOrigin', ?)").bind(ORIGIN).run();
	await configure({});
	await db.prepare("INSERT INTO aliases (address, num_id, uid, created_at, updated_at) VALUES ('shop@me.test', 1, 'u1', 1, 1), ('shop@work.test', 2, 'u2', 1, 1)").run();
	await db.prepare("INSERT INTO contacts (id, num_id, alias_address, email, reverse_local, created_at) VALUES ('c1', 1, 'shop@me.test', 'news@store.test', 'rnews', 1), ('c2', 2, 'shop@work.test', 'news@store.test', 'rnews2', 1)").run();
});
afterEach(() => vi.unstubAllGlobals());

async function configure(changes: Partial<Settings>) {
	await saveSettings(db, { ...(await loadSettings(db)), aliasDomains: ["me.test", "work.test"], defaultDestination: "owner@gmail.test", ...changes });
}

async function unsubscribe(alias: string, fields: { original_unsubscribe?: string; post?: number } = {}) {
	const id = `fw_${crypto.randomUUID().replaceAll("-", "")}`;
	await db
		.prepare("INSERT INTO forwards (id, inbound_id, alias_address, contact_id, original_unsubscribe, original_unsubscribe_post, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'sent', 1, 1)")
		.bind(id, id, alias, alias === "shop@me.test" ? "c1" : "c2", fields.original_unsubscribe ?? null, fields.post ?? 0)
		.run();
	const token = await signToken(TEST_SECRET, "unsubscribe", id, 600);
	const response = await app.fetch(new Request(`${ORIGIN}/unsubscribe/${token}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" }), env);
	return { status: response.status, text: await response.text() };
}

const contact = (id: string) => db.prepare("SELECT blocked, destination FROM contacts WHERE id = ?").bind(id).first<{ blocked: number; destination: string | null }>();
const mode = (address: string) => db.prepare("SELECT forward_mode FROM aliases WHERE address = ?").bind(address).first("forward_mode");

describe("settings", () => {
	it("keep only valid rules, for alias domains that exist", () => {
		const settings = normalizeSettings({
			aliasDomains: ["me.test"],
			unsubscribeFallback: "explode",
			unsubscribeRedirect: "Lists <Lists@Example.com>",
			unsubscribeDomains: { "me.test": { behavior: "redirect_contact", fallback: "none", redirect: "nope" }, "gone.test": { behavior: "block_contact" }, constructor: { behavior: "block_contact" } },
		});
		expect(settings.unsubscribeFallback).toBe("block_contact");
		expect(settings.unsubscribeRedirect).toBe("lists@example.com");
		expect(settings.unsubscribeDomains).toEqual({ "me.test": { behavior: "redirect_contact", fallback: "none", redirect: "" } });
		expect(unsubscribeRuleFor(settings, "a@me.test")).toEqual({ behavior: "redirect_contact", fallback: "none", redirect: "lists@example.com" });
		expect(unsubscribeRuleFor(settings, "a@other.test").behavior).toBe("disable_alias");
		// A domain that overrides only the behavior keeps the general fallback.
		const only = normalizeSettings({ aliasDomains: ["me.test"], unsubscribeFallback: "disable_alias", unsubscribeDomains: { "me.test": { behavior: "block_contact" } } });
		expect(unsubscribeRuleFor(only, "a@me.test")).toEqual({ behavior: "block_contact", fallback: "disable_alias", redirect: "" });
	});

	it("are saved from the settings form, and a redirect needs an address", async () => {
		const cookie = await signIn(db);
		const save = (body: string) =>
			app.fetch(new Request(`${ORIGIN}/settings`, { method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded", "X-Autosave": "1" }, body }), env);
		const base = "aliasDomains=me.test%2C+work.test&defaultDestination=owner%40gmail.test&unsubscribeBehavior=block_contact&unsubscribeFallback=block_contact";
		expect((await save(`${base}&unsubscribeBehavior%3Awork.test=redirect_contact&unsubscribeFallback%3Awork.test=none`)).status).toBe(400);
		expect((await save(`${base}&unsubscribeRedirect=shop%40me.test`)).status).toBe(400);
		const ok = await save(`${base}&unsubscribeBehavior%3Awork.test=redirect_contact&unsubscribeFallback%3Awork.test=none&unsubscribeRedirect%3Awork.test=lists%40gmail.test`);
		expect(ok.status).toBe(200);
		expect((await loadSettings(db)).unsubscribeDomains).toEqual({ "work.test": { behavior: "redirect_contact", fallback: "none", redirect: "lists@gmail.test" } });
		const page = await (await app.fetch(new Request(`${ORIGIN}/settings`, { headers: { cookie } }), env)).text();
		expect(page).toContain('name="unsubscribeBehavior:work.test"');
	});
});

describe("unsubscribing", () => {
	it("can send the sender's mail to another address, which then receives and may reply", async () => {
		await configure({ unsubscribeBehavior: "redirect_contact", unsubscribeRedirect: "lists@gmail.test" });
		expect((await unsubscribe("shop@me.test")).status).toBe(200);
		expect(await contact("c1")).toEqual({ blocked: 0, destination: "lists@gmail.test" });

		const raw = "From: news@store.test\r\nTo: shop@me.test\r\nSubject: Sale\r\nMessage-ID: <n1@store.test>\r\n\r\nHello\r\n";
		const headers = new Headers({ From: "news@store.test" });
		await worker.email!({ to: "shop@me.test", from: "news@store.test", headers, raw: new Response(raw).body, rawSize: raw.length, setReject: () => {} } as never, env);
		expect(sent.map((message) => (typeof message.to === "string" ? message.to : message.to.email))).toEqual(["lists@gmail.test"]);
	});

	it("follows the alias domain's own rule", async () => {
		await configure({ unsubscribeBehavior: "disable_alias", unsubscribeDomains: { "work.test": { behavior: "block_contact", fallback: "block_contact", redirect: "" } } });
		await unsubscribe("shop@work.test");
		expect(await contact("c2")).toMatchObject({ blocked: 1 });
		expect(await mode("shop@work.test")).toBe("all");
		await unsubscribe("shop@me.test");
		expect(await mode("shop@me.test")).toBe("none");
	});

	it("uses the fallback when the sender's one-click unsubscribe fails", async () => {
		vi.stubGlobal("fetch", async () => new Response("no", { status: 500 }));
		await configure({ unsubscribeBehavior: "preserve_original", unsubscribeFallback: "disable_alias" });
		const result = await unsubscribe("shop@me.test", { original_unsubscribe: "<https://store.test/u>", post: 1 });
		expect(result.status).toBe(200);
		expect(await mode("shop@me.test")).toBe("none");
		expect(await contact("c1")).toMatchObject({ blocked: 0 });
	});

	it("uses the fallback when the sender has no unsubscribe of its own", async () => {
		await configure({ unsubscribeBehavior: "preserve_original", unsubscribeFallback: "redirect_contact", unsubscribeRedirect: "lists@gmail.test" });
		await unsubscribe("shop@me.test");
		expect(await contact("c1")).toEqual({ blocked: 0, destination: "lists@gmail.test" });
	});

	it("changes nothing and reports the failure when the fallback is nothing", async () => {
		vi.stubGlobal("fetch", async () => new Response("no", { status: 500 }));
		await configure({ unsubscribeBehavior: "preserve_original", unsubscribeFallback: "none" });
		const result = await unsubscribe("shop@me.test", { original_unsubscribe: "<https://store.test/u>", post: 1 });
		expect(result.status).toBeGreaterThanOrEqual(400);
		expect(await contact("c1")).toEqual({ blocked: 0, destination: null });
		expect(await mode("shop@me.test")).toBe("all");
	});
});

describe("a contact's own address", () => {
	it("is set and cleared on the alias page, never to an alias domain", async () => {
		const cookie = await signIn(db);
		const set = (value: string) =>
			app.fetch(new Request(`${ORIGIN}/aliases/shop%40me.test/contacts/c1/destination`, { method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: `destination=${encodeURIComponent(value)}` }), env);
		expect((await set("x@work.test")).headers.get("location")).toContain("destinationOnReverse");
		await set("Lists@Gmail.test");
		expect(await contact("c1")).toMatchObject({ destination: "lists@gmail.test" });
		await set("");
		expect(await contact("c1")).toMatchObject({ destination: null });
	});
});
