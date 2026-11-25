import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiKey } from "../src/apikeys";
import { loadConfig, saveConfig } from "../src/config";
import { signToken } from "../src/crypto";
import { ensureAngle, isPublicHost, replaceAddresses } from "../src/format";
import { translator } from "../src/i18n";
import { importAliases, parseAliasCsv, selectByDomain } from "../src/importer";
import worker, { app } from "../src/index";
import { buildMime } from "../src/mime";
import { sendOutbound } from "../src/outbound";
import { clientKey } from "../src/ratelimit";
import { loadSettings, saveSettings } from "../src/settings";
import { dotStuff, sendSmtp } from "../src/smtp";
import { cleanText } from "../src/trackers";
import { transformForward } from "../src/transform";
import { testDb } from "./helpers/d1";
import { noticeOf, signIn, TEST_SECRET } from "./helpers/session";

/** Regressions for audit6 security and code quality review findings. */
let db: D1Database;
let env: Env;
let sent: {
	from: unknown;
	to: unknown;
	subject?: string;
	html?: string;
	text?: string;
	headers?: Record<string, string>;
	attachments?: { disposition: string; contentId?: string; filename: string; type: string; content: ArrayBuffer }[];
}[];
const ORIGIN = "https://alias.test";
const PASS = "Authentication-Results: mx.cloudflare.net; spf=pass; dmarc=pass header.from=gmail.test";

beforeEach(async () => {
	db = testDb();
	sent = [];
	env = {
		DB: db,
		SIGNING_SECRET: TEST_SECRET,
		EMAIL: { send: async (message: (typeof sent)[number]) => (sent.push(message), { messageId: `<s${sent.length}@test>` }) },
	} as unknown as Env;
	await saveSettings(db, { ...(await loadSettings(db)), aliasDomains: ["a.test", "b.test"], defaultDestination: "owner+tag@gmail.test" });
	await db.prepare("INSERT INTO config (key, value) VALUES ('siteOrigin', ?)").bind(ORIGIN).run();
});

afterEach(() => vi.unstubAllGlobals());

function inboundRaw(to: string, from: string, raw: string) {
	let rejected: string | null = null;
	const headers = new Headers();
	for (const line of raw.split(/\r?\n\r?\n/)[0]!.split(/\r?\n/)) {
		const at = line.indexOf(":");
		if (at > 0) headers.append(line.slice(0, at), line.slice(at + 1).trim());
	}
	const msg = {
		to,
		from,
		headers,
		raw: new Response(raw).body,
		rawSize: raw.length,
		setReject: (reason: string) => {
			rejected = reason;
		},
	} as unknown as ForwardableEmailMessage;
	return { msg, rejected: () => rejected };
}

describe("1. outbound header injection via RFC 2047 Message-ID", () => {
	it("rejects control characters and malformed IDs in ensureAngle", () => {
		expect(ensureAngle("<ok@store.test>")).toBe("<ok@store.test>");
		expect(ensureAngle("bare@store.test")).toBe("<bare@store.test>");
		expect(ensureAngle("<ok@store.test>\r\nBcc: evil@attacker.test")).toBeNull();
		expect(ensureAngle("<ok@store.test>\nX-Evil: 1")).toBeNull();
		expect(ensureAngle("<has space@store.test>")).toBeNull();
	});

	it("blocks RFC 2047-decoded CRLF in inbound Message-ID and sanitizes legacy D1 rows on reply", async () => {
		// Base64 of: <orig@store.test>\r\nBcc: evil@attacker.test
		const encoded = "=?UTF-8?B?PG9yaWdAc3RvcmUudGVzdD4NCkJjYzogZXZpbEBhdHRhY2tlci50ZXN0?=";
		const raw = `From: bob@store.test\r\nTo: shop@a.test\r\nSubject: Hi\r\nMessage-ID: ${encoded}\r\nDate: Mon, 1 Jan 2026 00:00:00 +0000\r\n\r\nHello\r\n`;
		await worker.email!(inboundRaw("shop@a.test", "bob@store.test", raw).msg as never, env);
		expect(sent).toHaveLength(1);
		const row = await db.prepare("SELECT id, original_message_id, forwarded_message_id FROM forwards").first<{ id: string; original_message_id: string | null; forwarded_message_id: string }>();
		expect(row?.original_message_id).toBeNull();

		// Even if a legacy poisoned original_message_id already exists in D1, replies only emit valid Message-IDs.
		await db.prepare("UPDATE forwards SET original_message_id = ? WHERE id = ?").bind("<safe@store.test>\r\nBcc: evil@attacker.test", row!.id).run();
		const reverse = (sent[0]!.from as { email: string }).email;
		sent = [];
		const replyRaw = `${PASS}\r\nFrom: owner+tag@gmail.test\r\nTo: ${reverse}\r\nSubject: Re: Hi\r\nIn-Reply-To: ${row!.forwarded_message_id}\r\nReferences: ${row!.forwarded_message_id}\r\nMessage-ID: <rep1@gmail.test>\r\n\r\nThanks\r\n`;
		const { msg, rejected } = inboundRaw(reverse, "owner+tag@gmail.test", replyRaw);
		await worker.email!(msg as never, env);
		expect(rejected()).toBeNull();
		expect(sent).toHaveLength(1);
		expect(sent[0]!.headers?.["In-Reply-To"]).toBe("<safe@store.test>");
		expect(sent[0]!.headers?.References).toBe("<safe@store.test>");
	});
});

describe("2. ReDoS prevention in cleanText and transformForward", () => {
	it("handles pathological trailing punctuation linearly in cleanText", () => {
		const input = `https://${".".repeat(50_000)}x`;
		const started = performance.now();
		const res = cleanText(input);
		expect(performance.now() - started).toBeLessThan(200);
		expect(res.text).toBe(input);
		expect(cleanText("Visit https://shop.com/?utm_source=1...").text).toBe("Visit https://shop.com/...");
	});

	it("handles removeTrackers when HTMLRewriter is absent and scans <head> in linear time", async () => {
		const malformedHead = `<html><head>${"<x>".repeat(5000)}<!-- </head> -->${"a".repeat(20_000)}<p>Body</p>`;
		const started = performance.now();
		const out = await transformForward(
			{ html: malformedHead, text: "https://shop.com/?utm_source=1" },
			{
				removeTrackers: true,
				banner: { alias: "shop@a.test", sender: "bob@store.test", blockUrl: "https://alias.test/b", disableUrl: "https://alias.test/d", spoofWarning: false },
				t: translator("en"),
			},
		);
		expect(performance.now() - started).toBeLessThan(200);
		expect(out.html).toContain("data-aliasflare-banner");
		expect(out.text).toContain("https://shop.com/");
		expect(out.text).not.toContain("utm_source");
	});
});

describe("3. MCP DNS rebinding, OPTIONS, and JSON-RPC validation", () => {
	it("blocks DNS rebinding where attacker Host matches Origin, handles OPTIONS, and validates JSON-RPC params", async () => {
		await saveSettings(db, { ...(await loadSettings(db)), mcpServer: true });
		const { key } = await createApiKey(db, "bot", "mcp");

		// DNS rebinding: Host and Origin both match attacker domain, which is neither siteOrigin/publicUrl nor loopback.
		const rebind = await app.fetch(
			new Request("http://rebind.evil:8787/mcp", {
				method: "POST",
				headers: { Origin: "http://rebind.evil:8787", Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
			}),
			env,
		);
		expect(rebind.status).toBe(403);

		// Configured siteOrigin is allowed.
		const sameSite = await app.fetch(
			new Request(`${ORIGIN}/mcp`, {
				method: "POST",
				headers: { Origin: ORIGIN, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
			}),
			env,
		);
		expect(sameSite.status).toBe(200);

		// OPTIONS returns 405 instead of falling through to requireAdmin (401).
		const opt = await app.fetch(new Request(`${ORIGIN}/mcp`, { method: "OPTIONS" }), env);
		expect(opt.status).toBe(405);
		expect(opt.headers.get("Allow")).toBe("POST");

		const call = (payload: unknown) =>
			app.fetch(
				new Request(`${ORIGIN}/mcp`, {
					method: "POST",
					headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
					body: JSON.stringify(payload),
				}),
				env,
			);

		// Invalid notification without jsonrpc/method is rejected with 400 -32600 instead of 202.
		expect((await call({})).status).toBe(400);
		expect((await call({ jsonrpc: "2.0" })).status).toBe(400);

		// Non-object params or tool arguments return -32602 and do not create an alias.
		expect(await (await call({ jsonrpc: "2.0", id: 2, method: "tools/call", params: [] })).json()).toMatchObject({ error: { code: -32602 } });
		expect(await (await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "create_alias", arguments: [] } })).json()).toMatchObject({ error: { code: -32602 } });
		expect(await db.prepare("SELECT COUNT(*) AS n FROM aliases").first("n")).toBe(0);

		// Invalid list_aliases arguments return isError; empty domain falls back to default domain.
		expect(await (await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_aliases", arguments: { status: "deleted" } } })).json()).toMatchObject({
			result: { isError: true },
		});
		expect(await (await call({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "list_aliases", arguments: { page: -1 } } })).json()).toMatchObject({
			result: { isError: true },
		});
		const created = await (await call({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "create_alias", arguments: { domain: "  " } } })).json();
		expect(created).toMatchObject({ result: { structuredContent: { alias: { address: expect.stringMatching(/@a\.test$/) } } } });
	});
});

describe("4. owner email scrubbing in replies and encoded address variants", () => {
	it("always scrubs the owner address even when reverseAliasReplacement is disabled, and handles encoded @ and mailto%3A", async () => {
		await saveSettings(db, { ...(await loadSettings(db)), reverseAliasReplacement: false });
		const fwdRaw = "From: bob@store.test\r\nTo: shop@a.test\r\nSubject: Hi\r\nMessage-ID: <f1@store.test>\r\n\r\nHello\r\n";
		await worker.email!(inboundRaw("shop@a.test", "bob@store.test", fwdRaw).msg as never, env);
		const reverse = (sent[0]!.from as { email: string }).email;
		sent = [];

		const replyRaw =
			`${PASS}\r\nFrom: owner+tag@gmail.test\r\nTo: ${reverse}\r\nSubject: Re: Hi\r\nMessage-ID: <r1@gmail.test>\r\nContent-Type: text/html; charset=utf-8\r\n\r\n` +
			`<p>Quoted: owner+tag@gmail.test, mailto:owner%2Btag%40gmail.test, mailto%3Aowner+tag@gmail.test, owner+tag&#64;gmail.test</p>\r\n`;
		const { msg, rejected } = inboundRaw(reverse, "owner+tag@gmail.test", replyRaw);
		await worker.email!(msg as never, env);
		expect(rejected()).toBeNull();
		expect(sent).toHaveLength(1);
		expect(sent[0]!.html).not.toContain("gmail.test");
		expect(sent[0]!.html).toContain("shop@a.test");
		expect(replaceAddresses("mailto%3Aowner+tag%40gmail.test", [{ from: "owner+tag@gmail.test", to: "shop@a.test" }], { encodedPlus: true })).toBe("mailto%3Ashop@a.test");
	});
});

describe("5. rate limit bucketing, IPv4-mapped IPv6, and pre-D1 public throttling", () => {
	it("normalizes IPv4-mapped IPv6 addresses to IPv4 instead of collapsing into one /64", () => {
		expect(clientKey("::ffff:203.0.113.10")).toBe("203.0.113.10");
		expect(clientKey("::ffff:198.51.100.20")).toBe("198.51.100.20");
		expect(clientKey("0:0:0:0:0:ffff:cb00:710a")).toBe("203.0.113.10");
		expect(clientKey("2001:db8:1:2::99")).toBe("2001:db8:1:2::/64");
	});

	it("isolates ui/link/auth rate limit buckets and throttles public routes before D1 reads", async () => {
		const seen: string[] = [];
		env = {
			...env,
			LOGIN_RATE_LIMIT: {
				limit: async ({ key }: { key: string }) => {
					seen.push(key);
					return { success: !key.startsWith("ui:") };
				},
			},
		} as unknown as Env;
		const themeRes = await app.fetch(
			new Request(`${ORIGIN}/theme`, { method: "POST", headers: { Origin: ORIGIN, "CF-Connecting-IP": "1.2.3.4", "Content-Type": "application/x-www-form-urlencoded" }, body: "theme=dark" }),
			env,
		);
		expect(themeRes.status).toBe(429);
		const loginRes = await app.fetch(
			new Request(`${ORIGIN}/login/options`, { method: "POST", headers: { Origin: ORIGIN, "CF-Connecting-IP": "1.2.3.4" } }),
			env,
		);
		expect(loginRes.status).toBe(200);
		expect(seen).toContain("ui:1.2.3.4");
		expect(seen).toContain("auth:1.2.3.4");

		let dbCalls = 0;
		const origPrepare = db.prepare.bind(db);
		db.prepare = ((sql: string) => {
			dbCalls += 1;
			return origPrepare(sql);
		}) as D1Database["prepare"];
		const throttledEnv = { ...env, API_RATE_LIMIT: { limit: async () => ({ success: false }) } } as unknown as Env;
		const healthRes = await app.fetch(new Request(`${ORIGIN}/health`, { headers: { "CF-Connecting-IP": "1.2.3.4" } }), throttledEnv);
		expect(healthRes.status).toBe(429);
		expect(dbCalls).toBe(0);
	});
});

describe("6. compat API filters, body validation, appSettings, and own-domain destination filtering", () => {
	it("parses SimpleLogin boolean filters properly, rejects non-object JSON, enforces appSettings, and filters own-domain mailboxes", async () => {
		await saveSettings(db, { ...(await loadSettings(db)), simpleloginApi: true, addyApi: true, appSettings: false });
		const { key } = await createApiKey(db, "app", "apps");
		await db
			.prepare(
				"INSERT INTO aliases (address, num_id, uid, forward_mode, forward_enabled, pinned, destination, created_at, updated_at) VALUES ('active@a.test', 1, 'u1', 'all', 1, 0, 'loop@b.test', 1, 1), ('off@a.test', 2, 'u2', 'none', 0, 1, NULL, 2, 2)",
			)
			.run();

		// ?pinned=false must not filter to pinned=true.
		const unpinned = await app.fetch(new Request(`${ORIGIN}/api/v2/aliases?pinned=false`, { headers: { Authentication: key } }), env);
		const list = (await unpinned.json()) as { aliases: { email: string }[] };
		expect(list.aliases).toHaveLength(2);

		// Non-object JSON body returns 400 instead of creating a random alias.
		const badArray = await app.fetch(
			new Request(`${ORIGIN}/api/v1/aliases`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: "[]" }),
			env,
		);
		expect(badArray.status).toBe(400);

		// PATCH /api/setting enforces appSettings even for a no-op payload.
		const noopSetting = await app.fetch(
			new Request(`${ORIGIN}/api/setting`, { method: "PATCH", headers: { Authentication: key, "Content-Type": "application/json" }, body: "{}" }),
			env,
		);
		expect(noopSetting.status).toBe(403);

		// Mailboxes list excludes destinations on own alias domains (loop@b.test).
		const mailboxes = await (await app.fetch(new Request(`${ORIGIN}/api/v2/mailboxes`, { headers: { Authentication: key } }), env)).json();
		expect((mailboxes as { mailboxes: { email: string }[] }).mailboxes.map((m) => m.email)).toEqual(["owner+tag@gmail.test"]);
	});
});

describe("7. SSRF, config resilience, outbound, SMTP, MIME, inline images, routes, importer & client fixes", () => {
	it("blocks .localdomain, handles malformed D1 URLs, merges custom headers case-insensitively, and enforces SMTP/MIME invariants", async () => {
		expect(isPublicHost("localhost.localdomain")).toBe(false);

		// Malformed stored URLs in D1 do not throw TypeError in loadConfig.
		await db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('mailflareUrl', 'not a url'), ('publicUrl', 'http://bad')").run();
		const cfg = await loadConfig(env);
		expect(cfg.mailflareUrl).toBe("");
		expect(cfg.publicUrl).toBe("");

		// Case-insensitive header override in viaCustom (no duplicate Content-Type).
		let capturedHeaders: Record<string, string> = {};
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			capturedHeaders = init.headers as Record<string, string>;
			return Response.json({ id: "c1" });
		});
		await saveConfig(db, {
			outboundProvider: "custom",
			outboundOptions: JSON.stringify({ customUrl: "https://api.mailprovider.com/send", customHeaders: "content-type: text/plain\naccept: text/plain", customBody: "{{subject}}" }),
		});
		await sendOutbound(env, await loadConfig(env), { from: "shop@a.test", to: "bob@store.test", subject: "Hi", text: "Hi" });
		expect(Object.keys(capturedHeaders).filter((k) => k.toLowerCase() === "content-type")).toEqual(["content-type"]);
		expect(capturedHeaders["content-type"]).toBe("text/plain");

		// SMTP rejects spaces/control chars in envelope and dotStuff normalizes bare CR.
		await expect(
			sendSmtp({ host: "smtp.example.com", port: 587, security: "starttls", username: "", password: "" }, { from: "a b@c.com", to: "d@e.com" }, "Hi"),
		).rejects.toThrow(/Invalid SMTP/);
		expect(dotStuff("a\r.b\rc")).toBe("a\r\n..b\r\nc\r\n.\r\n");

		// MIME splits long non-ASCII filenames into RFC 2231 continuations and encodes long spaceless subjects within 998 bytes.
		const mime = buildMime(
			{
				from: "shop@a.test",
				to: "bob@store.test",
				subject: "x".repeat(1200),
				text: "hi",
				attachments: [{ disposition: "attachment", filename: `${"測".repeat(180)}.pdf`, type: "application/pdf", content: new Uint8Array([1]).buffer }],
			},
			"<id@a.test>",
		);
		expect(mime).toContain("filename*0*=UTF-8''");
		expect(mime).toContain("filename*1*=");
		expect(mime.split("\r\n").every((line) => line.length <= 998)).toBe(true);
	});

	it("preserves multipart/related inline images without Content-Disposition: inline", async () => {
		const raw =
			'From: bob@store.test\r\nTo: shop@a.test\r\nSubject: Pic\r\nMessage-ID: <pic1@store.test>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="rel"\r\n\r\n' +
			'--rel\r\nContent-Type: text/html\r\n\r\n<img src="cid:img1@store.test">\r\n' +
			'--rel\r\nContent-Type: image/png; name="a.png"\r\nContent-Transfer-Encoding: base64\r\nContent-ID: <img1@store.test>\r\n\r\niVBORw0KGgo=\r\n--rel--\r\n';
		await worker.email!(inboundRaw("shop@a.test", "bob@store.test", raw).msg as never, env);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.attachments?.[0]).toMatchObject({ disposition: "inline", contentId: "img1@store.test" });
	});

	it("validates custom alias empty prefix, blocks editing deleted aliases, shows used link on GET, and hardens connection & importer", async () => {
		const cookie = await signIn(db);
		const postForm = (path: string, fields: Record<string, string>) =>
			app.fetch(
				new Request(`${ORIGIN}${path}`, {
					method: "POST",
					headers: { cookie, Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams(fields).toString(),
				}),
				env,
			);

		// Explicit kind=custom with empty prefix must fail rather than create a random alias.
		const badCustom = await postForm("/aliases/new", { kind: "custom", prefix: "   ", domain: "a.test" });
		expect(noticeOf(badCustom.headers.get("location"))).toMatch(/letters/);
		expect(await db.prepare("SELECT COUNT(*) AS n FROM aliases").first("n")).toBe(0);

		// Soft-deleted alias cannot be edited via /note, /destination, /contacts, or /aliases/bulk.
		await db.prepare("INSERT INTO aliases (address, num_id, uid, deleted_at, created_at, updated_at) VALUES ('gone@a.test', 1, 'u1', 10, 1, 1)").run();
		expect(noticeOf((await postForm("/aliases/gone@a.test/note", { note: "new" })).headers.get("location"))).toMatch(/does not exist or was deleted/i);
		expect(noticeOf((await postForm("/aliases/gone@a.test/destination", { destination: "x@gmail.test" })).headers.get("location"))).toMatch(/does not exist or was deleted/i);
		expect((await postForm("/aliases/gone@a.test/contacts", { email: "bob@store.test" })).status).toBe(404);
		await postForm("/aliases/bulk", { action: "note", value: "bulk", ids: "gone@a.test" });
		expect(await db.prepare("SELECT note, destination FROM aliases WHERE address = 'gone@a.test'").first()).toEqual({ note: null, destination: null });

		// POST /connection saves outboundOptions without smtpPort and blocks newly submitted mailflareUrl as customUrl.
		const connConflict = await postForm("/connection", {
			mailflareUrl: "https://mf-new.mailprovider.com",
			customUrl: "https://mf-new.mailprovider.com/send",
			customHeaders: "",
			customBody: "{}",
		});
		expect(connConflict.headers.get("location")).toContain("notice.badCustom");
		const connOk = await postForm("/connection", { customUrl: "https://api.mailprovider.com/send", customHeaders: "", customBody: "{}" });
		expect(connOk.headers.get("location")).toContain("notice.connectionSaved");
		expect((await loadConfig(env)).outboundOptions.customUrl).toBe("https://api.mailprovider.com/send");

		// Revisiting a consumed one-time link on GET immediately reports it as already used.
		await db.prepare("INSERT INTO aliases (address, num_id, uid, created_at, updated_at) VALUES ('live@a.test', 2, 'u2', 1, 1)").run();
		await db.prepare("INSERT INTO contacts (id, num_id, alias_address, email, reverse_local, created_at) VALUES ('c1', 1, 'live@a.test', 'news@store.test', 'r1', 1)").run();
		await db.prepare("INSERT INTO forwards (id, inbound_id, alias_address, contact_id, status, created_at, updated_at) VALUES ('fw_u', 'i1', 'live@a.test', 'c1', 'sent', 1, 1)").run();
		const token = await signToken(TEST_SECRET, "unsubscribe", "fw_u", 600);
		expect((await app.fetch(new Request(`${ORIGIN}/unsubscribe/${token}`, { method: "POST" }), env)).status).toBe(200);
		const getAfter = await (await app.fetch(new Request(`${ORIGIN}/unsubscribe/${token}`), env)).text();
		expect(getAfter).toContain("already used");
		expect(getAfter).not.toContain('<form method="post">');

		// selectByDomain skips reverse domains of already-configured aliasDomains, and importAliases deduplicates contacts.
		const selected = selectByDomain(
			[
				{
					email: "x@r.a.test",
					note: null,
					name: null,
					enabled: true,
					pinned: false,
					destination: null,
					createdAt: 1,
					forwarded: 0,
					blocked: 0,
					replied: 0,
					sent: 0,
					lastForwardAt: null,
					lastBlockAt: null,
					lastReplyAt: null,
					lastSentAt: null,
					details: {},
				},
				{
					email: "ok@b.test",
					note: null,
					name: null,
					enabled: true,
					pinned: false,
					destination: null,
					createdAt: 1,
					forwarded: 0,
					blocked: 0,
					replied: 0,
					sent: 0,
					lastForwardAt: null,
					lastBlockAt: null,
					lastReplyAt: null,
					lastSentAt: null,
					details: {},
					contacts: [
						{ email: "Bob@Store.test", name: "Bob", createdAt: 1, lastSentAt: null, blocked: false },
						{ email: "bob@store.test", name: "Bob 2", createdAt: 2, lastSentAt: null, blocked: false },
					],
				},
			],
			["r.a.test", "b.test"],
			["a.test"],
		);
		expect(selected.chosen.map((a) => a.email)).toEqual(["ok@b.test"]);
		const imported = await importAliases(db, await loadSettings(db), "simplelogin", selected, 2);
		expect(imported.contacts).toBe(1);
		expect(parseAliasCsv("email,deleted_at\ndeleted@a.test,2026-01-01\nlive2@a.test,\n").map((a) => [a.email, a.deletedAt])).toEqual([["deleted@a.test", Date.UTC(2026, 0, 1) / 1000], ["live2@a.test", null]]);

		// Client script flushes focused email inputs on pagehide and syncs initial autosave state.
		const js = await (await app.fetch(new Request(`${ORIGIN}/assets/app.js`), env)).text();
		expect(js).toContain("input[type=text]:focus, input[type=email]:focus");
		expect(js).toContain("form._syncLastSent");
	});
});
