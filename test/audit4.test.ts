import { beforeEach, describe, expect, it } from "vitest";
import worker, { app } from "../src/index";
import { loadSettings, saveSettings } from "../src/settings";
import { FREE_PLAN_REWRITE_BYTES } from "../src/forward";
import { sameSenderSite, siteOf, unsubscribePlan } from "../src/unsubscribe";
import { clientKey } from "../src/ratelimit";
import { cleanUp, ACTIVITY_RETENTION_SECONDS } from "../src/cleanup";
import { cleanAttachment, DOMAIN_PATTERN, parseMessageIds } from "../src/format";
import { toTimestamp, parseCsv } from "../src/importer";
import { translator } from "../src/i18n";
import type { ForwardRow } from "../src/db";
import { testDb } from "./helpers/d1";
import { signIn, TEST_SECRET } from "./helpers/session";

/** Regressions for issue #3. */
let db: D1Database;
let env: Env;
let sent: { from: unknown; to: unknown; html?: string; text?: string; headers?: Record<string, string> }[];
let forwardedTo: string[];

beforeEach(async () => {
	db = testDb();
	sent = [];
	forwardedTo = [];
	env = {
		DB: db,
		SIGNING_SECRET: TEST_SECRET,
		EMAIL: { send: async (message: (typeof sent)[number]) => (sent.push(message), { messageId: `<s${sent.length}@test>` }) },
	} as unknown as Env;
	await saveSettings(db, { ...(await loadSettings(db)), aliasDomains: ["a.test"], defaultDestination: "owner+tag@gmail.test" });
	await db.prepare("INSERT INTO config (key, value) VALUES ('siteOrigin', 'https://alias.test')").run();
});

function inbound(to: string, from: string, head: string, body = "Hello", size?: number) {
	const raw = `${head}\r\nTo: ${to}\r\nSubject: Hi\r\nMessage-ID: <${crypto.randomUUID()}@x>\r\n\r\n${body}\r\n`;
	let rejected: string | null = null;
	const headers = new Headers();
	for (const line of raw.split("\r\n\r\n")[0]!.split("\r\n")) {
		const at = line.indexOf(":");
		if (at > 0) headers.append(line.slice(0, at), line.slice(at + 1).trim());
	}
	const msg = {
		to,
		from,
		headers,
		raw: new Response(raw).body,
		rawSize: size ?? raw.length,
		forward: async (destination: string) => void forwardedTo.push(destination),
		setReject: (reason: string) => void (rejected = reason),
	} as unknown as ForwardableEmailMessage;
	return { msg, rejected: () => rejected };
}
const deliver = (msg: ForwardableEmailMessage) => worker.email!(msg as never, env);
const PASS = "Authentication-Results: mx.cloudflare.net; spf=pass; dmarc=pass header.from=gmail.test";
const big = FREE_PLAN_REWRITE_BYTES + 1;

describe("1. large messages passed through on the Free plan", () => {
	it("still honour a blocked contact, the From header's blocklist entry and the promotions filter", async () => {
		await db.prepare("INSERT INTO aliases (address, num_id, uid, forward_mode, created_at, updated_at) VALUES ('shop@a.test', 1, 'u1', 'no_promotions', 1, 1)").run();
		await db.prepare("INSERT INTO contacts (id, num_id, alias_address, email, reverse_local, blocked, created_at) VALUES ('c1', 1, 'shop@a.test', 'bob@store.test', 'r1', 1, 1)").run();
		await db.prepare("INSERT INTO blocklist (id, kind, value, created_at) VALUES ('b1', 'address', 'spam@evil.test', 1)").run();
		await deliver(inbound("shop@a.test", "bob@store.test", "From: bob@store.test", "x", big).msg);
		await deliver(inbound("shop@a.test", "other@relay.test", "From: spam@evil.test", "x", big).msg);
		await deliver(inbound("shop@a.test", "news@shop.test", "From: news@shop.test\r\nList-Unsubscribe: <https://shop.test/u>", "x", big).msg);
		expect(forwardedTo).toEqual([]);
		const { results } = await db.prepare("SELECT error FROM forwards ORDER BY created_at").all<{ error: string }>();
		expect(results.map((row) => row.error).sort()).toEqual(["blocklist: spam@evil.test", "promotional mail is blocked for this alias", "sender is blocked"]);
	});

	it("skips this Worker's own copies before reading them", async () => {
		const { msg } = inbound("shop@a.test", "bob@store.test", "From: bob@store.test\r\nX-Aliasflare: shop@a.test", "x", big);
		Object.defineProperty(msg, "raw", { get: () => { throw new Error("read"); } });
		await deliver(msg);
		expect(forwardedTo).toEqual([]);
		expect(await db.prepare("SELECT error FROM forwards").first()).toEqual({ error: "already forwarded by this Worker" });
	});
});

describe("2. the sender's own unsubscribe", () => {
	it("is not kept for a message that failed DMARC", async () => {
		const head = "Authentication-Results: mx.cloudflare.net; dmarc=fail header.from=bank.test\r\nFrom: bob@bank.test\r\nList-Unsubscribe: <https://bank.test/u>";
		await deliver(inbound("shop@a.test", "bob@bank.test", head).msg);
		expect(await db.prepare("SELECT original_unsubscribe FROM forwards").first()).toEqual({ original_unsubscribe: null });
	});

	it("never mails another person at a shared mailbox provider, and tries every mailto", () => {
		expect(sameSenderSite("victim@gmail.com", "news@gmail.com")).toBe(false);
		expect(sameSenderSite("u@lists.shop.co.uk", "news@shop.co.uk")).toBe(true);
		expect(siteOf("a.b.gouv.fr")).toBe("b.gouv.fr");
		expect(siteOf("me.github.io")).toBe("me.github.io");
		const forward = { original_unsubscribe: "<mailto:x@other.test>, <mailto:u@shop.test?subject=stop>", original_unsubscribe_post: 0 } as ForwardRow;
		expect(unsubscribePlan(forward, "news@shop.test", { blockedHosts: [], ownDomains: ["a.test"] })).toEqual({ kind: "mail", to: "u@shop.test", subject: "stop" });
	});
});

describe("3. replies leak nothing about the owner", () => {
	it("replace an HTML-encoded + address and drop the owner's own Message-IDs", async () => {
		await deliver(inbound("shop@a.test", "bob@store.test", "From: bob@store.test").msg);
		const reverse = (sent[0]!.from as { email: string }).email;
		sent = [];
		const head = `${PASS}\r\nFrom: owner+tag@gmail.test\r\nIn-Reply-To: <CAown1@mail.gmail.test>\r\nReferences: <orig@store.test> <CAown1@mail.gmail.test>\r\nContent-Type: text/html`;
		await deliver(inbound(reverse, "owner+tag@gmail.test", head, '<p>Write to owner&#43;tag@gmail.test</p>').msg);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.html).toContain("shop@a.test");
		expect(sent[0]!.html).not.toContain("gmail.test");
		expect(sent[0]!.headers?.["In-Reply-To"]).toBeUndefined();
		expect(sent[0]!.headers?.References).toBe("<orig@store.test>");
	});
});

describe("6. rate limit keys", () => {
	it("group an IPv6 address by its /64", () => {
		expect(clientKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
		expect(clientKey("2001:db8:1:2:bbbb:cccc:dddd:eeee")).toBe("2001:db8:1:2::/64");
		expect(clientKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
		expect(clientKey("203.0.113.9")).toBe("203.0.113.9");
	});
});

describe("7. activity is not kept forever", () => {
	it("goes with an alias deleted for good, and after a year", async () => {
		await db.prepare("INSERT INTO aliases (address, num_id, uid, deleted_at, created_at, updated_at) VALUES ('gone@a.test', 1, 'u1', 5, 1, 1)").run();
		await db.prepare("INSERT INTO forwards (id, inbound_id, alias_address, status, created_at, updated_at) VALUES ('f1', 'i1', 'gone@a.test', 'sent', 1, 1)").run();
		await db.prepare("INSERT INTO events (id, kind, status, alias_address, created_at) VALUES ('e1', 'reply', 'sent', 'gone@a.test', 1)").run();
		const cookie = await signIn(db);
		const response = await app.fetch(
			new Request("https://alias.test/aliases/bulk", {
				method: "POST",
				headers: { cookie, origin: "https://alias.test", "content-type": "application/x-www-form-urlencoded" },
				body: "action=forget&ids=gone%40a.test",
			}),
			env,
		);
		expect(response.headers.get("location")).toContain("n.count=1");
		expect(await db.prepare("SELECT (SELECT COUNT(*) FROM forwards) + (SELECT COUNT(*) FROM events) AS n").first()).toEqual({ n: 0 });

		const at = 10 * ACTIVITY_RETENTION_SECONDS;
		await db.prepare("INSERT INTO forwards (id, inbound_id, alias_address, status, created_at, updated_at) VALUES ('old', 'i2', 'x@a.test', 'sent', ?, 1), ('new', 'i3', 'x@a.test', 'sent', ?, 1)").bind(at - ACTIVITY_RETENTION_SECONDS - 1, at).run();
		await cleanUp(db, at);
		const { results } = await db.prepare("SELECT id FROM forwards").all<{ id: string }>();
		expect(results.map((row) => row.id)).toEqual(["new"]);
	});
});

describe("9. values from outside", () => {
	it("reject timestamps out of range and accept micro- and nanoseconds", () => {
		expect(toTimestamp(1.7e18)).toBe(1700000000);
		expect(toTimestamp(1.7e15)).toBe(1700000000);
		expect(toTimestamp(99e99)).toBeNull();
		expect(toTimestamp("1800-01-01")).toBeNull();
	});

	it("accept a fractional page size from the addy.io API", async () => {
		await saveSettings(db, { ...(await loadSettings(db)), addyApi: true });
		const cookie = await signIn(db);
		const response = await app.fetch(new Request("https://alias.test/api/v1/aliases?page[size]=10.5", { headers: { cookie } }), env);
		expect(response.status).not.toBe(500);
	});
});

describe("11–13. input hardening", () => {
	it("names attachments safely, with an extension from their type", () => {
		expect(cleanAttachment({ filename: "", mimeType: "image/png", contentId: "<a\r\nb>" }, 0)).toEqual({ filename: "attachment-1.png", type: "image/png", contentId: "ab" });
		expect(cleanAttachment({ filename: "../x.pdf", mimeType: "bad type" }, 1)).toEqual({ filename: ".. x .pdf", type: "application/octet-stream", contentId: undefined });
		expect(parseMessageIds(`<${"a".repeat(300)}@x> <ok@x> <bad\u0001@x>`)).toEqual(["<ok@x>"]);
	});

	it("accepts internationalized top-level domains", () => {
		expect(DOMAIN_PATTERN.test("example.xn--p1ai")).toBe(true);
		expect(DOMAIN_PATTERN.test("example.c")).toBe(false);
	});

	it("stops reading a CSV once it has enough rows", () => {
		expect(parseCsv("a\nb\nc\nd\n", 2)).toEqual([["a"], ["b"]]);
	});

	it("changes the language only from this site, with a POST", async () => {
		const crossSite = await app.fetch(new Request("https://alias.test/lang", { method: "POST", headers: { origin: "https://evil.test", "content-type": "application/x-www-form-urlencoded" }, body: "locale=ar" }), env);
		expect(crossSite.status).toBe(403);
		const own = await app.fetch(new Request("https://alias.test/lang", { method: "POST", headers: { origin: "https://alias.test", "content-type": "application/x-www-form-urlencoded" }, body: "locale=ar&next=/settings" }), env);
		expect(own.headers.get("set-cookie")).toContain("ar");
		expect((await app.fetch(new Request("https://alias.test/lang?locale=ar"), env)).headers.get("set-cookie")).toBeNull();
	});

	it("keeps link pages out of caches and sends HSTS", async () => {
		const response = await app.fetch(new Request("https://alias.test/unsubscribe/nonsense"), env);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("strict-transport-security")).toContain("max-age=");
	});

	it("does not report saving the mode of an alias that does not exist", async () => {
		const cookie = await signIn(db);
		const response = await app.fetch(
			new Request("https://alias.test/aliases/nobody%40a.test/mode", { method: "POST", headers: { cookie, origin: "https://alias.test", "content-type": "application/x-www-form-urlencoded" }, body: "mode=none" }),
			env,
		);
		expect(response.headers.get("location")).toContain("notice.aliasMissing");
	});
});

describe("14. translations", () => {
	it("give back an unknown key as itself, and never an inherited property", () => {
		const t = translator("en");
		expect(t("no.such.key" as never)).toBe("no.such.key");
		expect(t("constructor" as never)).toBe("constructor");
		expect(t("notice.newCreated", { constructor: "x" } as never)).toBe("Created {alias}.");
	});
});
