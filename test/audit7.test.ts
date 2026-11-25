import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiKey } from "../src/apikeys";
import { setUpDomain } from "../src/cloudflare";
import { createAlias, updateAlias } from "../src/compat/aliases";
import { loadConfig, saveConfig } from "../src/config";
import { signToken } from "../src/crypto";
import { boundedList } from "../src/db";
import { cleanAttachment, findAddressesOnDomain, isPublicHost } from "../src/format";
import { dmarcFailedAtCloudflare } from "../src/forward";
import { translator } from "../src/i18n";
import { addSimpleLoginContacts, importAliases, selectByDomain } from "../src/importer";
import worker, { app } from "../src/index";
import { getStoredMessage, mailflareConfig, MailflareError } from "../src/mailflare";
import { buildMime } from "../src/mime";
import { fillTemplate, parseHeaderLines, sendOutbound } from "../src/outbound";
import { issueSetupCode } from "../src/passkeys";
import { loadSettings, saveSettings } from "../src/settings";
import { sendSmtp, type SmtpConnect, type SmtpSocket } from "../src/smtp";
import { transformForward } from "../src/transform";
import { performAction, resolveLink } from "../src/unsubscribe";
import { testDb } from "./helpers/d1";
import { TEST_SECRET } from "./helpers/session";

/** Regressions for audit7 security and code quality review findings. */
let db: D1Database;
let env: Env;
let sent: {
	from: unknown;
	to: unknown;
	subject?: string;
	html?: string;
	text?: string;
	headers?: Record<string, string>;
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

function inboundRaw(to: string, from: string, raw: string, forward?: (dest: string) => Promise<void>) {
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
		forward: forward ?? (async () => undefined),
		setReject: (reason: string) => {
			rejected = reason;
		},
	} as unknown as ForwardableEmailMessage;
	return { msg, rejected: () => rejected };
}

describe("1. passThrough blocklist/contact bypass, rewrite envelope block, and spoof detection", () => {
	it("enforces blocklist and contact blocks in passThrough for quoted angle brackets, comments, and multi-address From", async () => {
		await saveSettings(db, { ...(await loadSettings(db)), forwardMethod: "direct" });
		await db.prepare("INSERT INTO blocklist (id, kind, value, created_at) VALUES ('bl1', 'address', 'blocked@evil.test', 1)").run();
		const forwarded: string[] = [];
		const deliver = (fromHeader: string, envelope = "bounce@clean.test") => {
			const raw = `From: ${fromHeader}\r\nTo: shop@a.test\r\nSubject: Hi\r\nMessage-ID: <${crypto.randomUUID()}@clean.test>\r\n\r\nHello\r\n`;
			return worker.email!(inboundRaw("shop@a.test", envelope, raw, async (dest) => void forwarded.push(dest)).msg as never, env);
		};

		await deliver('"Bob <bob>" <blocked@evil.test>');
		await deliver("blocked@evil.test (Bob)");
		await deliver("ok@other.test, blocked@evil.test");
		expect(forwarded).toHaveLength(0);

		// Per-alias contact block also catches quoted-angle-bracket From headers.
		await deliver("good@store.test", "good@store.test");
		expect(forwarded).toHaveLength(1);
		await db.prepare("UPDATE contacts SET blocked = 1 WHERE email = 'good@store.test'").run();
		await deliver('"Store <support>" <good@store.test>', "other@relay.test");
		expect(forwarded).toHaveLength(1);
	});

	it("blocks rewrite-mode mail when envelope sender is a blocked contact on the alias", async () => {
		await db.prepare("INSERT INTO aliases (address, num_id, uid, created_at, updated_at) VALUES ('shop@a.test', 1, 'u1', 1, 1)").run();
		await db.prepare("INSERT INTO contacts (id, num_id, alias_address, email, reverse_local, blocked, created_at) VALUES ('c1', 1, 'shop@a.test', 'spammer@evil.test', 'r1', 1, 1)").run();
		const raw = "From: innocent@other.test\r\nTo: shop@a.test\r\nSubject: Hi\r\nMessage-ID: <m1@evil.test>\r\n\r\nHello\r\n";
		await worker.email!(inboundRaw("shop@a.test", "spammer@evil.test", raw).msg as never, env);
		expect(sent).toHaveLength(0);
	});

	it("flags dmarc=permerror and multi-address From headers as spoofed", async () => {
		expect(dmarcFailedAtCloudflare("mx.cloudflare.net; spf=pass; dmarc=permerror header.from=bank.test")).toBe(true);
		const raw =
			"From: victim@bank.test, attacker@evil.test\r\nTo: shop@a.test\r\nSubject: Alert\r\nList-Unsubscribe: <https://evil.com/unsub>\r\nMessage-ID: <m2@evil.test>\r\n\r\nHi\r\n";
		await worker.email!(inboundRaw("shop@a.test", "attacker@evil.test", raw).msg as never, env);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.subject).toContain("Unverified");
		const row = await db.prepare("SELECT original_unsubscribe FROM forwards").first<{ original_unsubscribe: string | null }>();
		expect(row?.original_unsubscribe).toBeNull();
	});
});

describe("2. reverse-alias scrubbing for encoded @ / mailto%3A and reply threading", () => {
	it("scrubs reverse aliases encoded with %40, &#64;, and mailto%3A and maps earlier surviving References", async () => {
		const fwdRaw = "From: bob@store.test\r\nTo: shop@a.test\r\nSubject: Hi\r\nMessage-ID: <orig0@store.test>\r\n\r\nHello\r\n";
		await worker.email!(inboundRaw("shop@a.test", "bob@store.test", fwdRaw).msg as never, env);
		const reverse = (sent[0]!.from as { email: string }).email;
		const [local] = reverse.split("@");
		const row = await db.prepare("SELECT forwarded_message_id FROM forwards").first<{ forwarded_message_id: string }>();
		expect(findAddressesOnDomain(`mailto%3A${reverse}`, "r.a.test")).toEqual([reverse]);

		// Add a second owner address on contact.destination to test multi-owner Message-ID filtering.
		await db.prepare("UPDATE contacts SET destination = 'alt@proton.test' WHERE email = 'bob@store.test'").run();
		sent = [];
		const trailingOwnRefs = Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? `<own${i}@gmail.test>` : `<alt${i}@proton.test>`)).join(" ");
		const replyRaw =
			`${PASS}\r\nFrom: owner+tag@gmail.test\r\nTo: ${reverse}\r\nSubject: Re: Hi\r\nReferences: ${row!.forwarded_message_id} ${trailingOwnRefs}\r\nMessage-ID: <rep@gmail.test>\r\nContent-Type: text/html; charset=utf-8\r\n\r\n` +
			`<p>${local!.replace("+", "%2B")}%40r.a.test and ${local}&#64;r.a.test and mailto%3A${reverse}</p>\r\n`;
		const { msg, rejected } = inboundRaw(reverse, "owner+tag@gmail.test", replyRaw);
		await worker.email!(msg as never, env);
		expect(rejected()).toBeNull();
		expect(sent).toHaveLength(1);
		expect(sent[0]!.html).not.toContain("r.a.test");
		expect(sent[0]!.html).toContain("bob@store.test");
		expect(sent[0]!.headers?.References).toBe("<orig0@store.test>");
	});
});

describe("3. pre-D1 throttling, /logout rate limit, HttpOnly cookies, /setup order, and lockout cache resilience", () => {
	it("throttles exact /api, /lang, /theme, /logout, and 404 paths before D1 reads", async () => {
		let dbCalls = 0;
		const origPrepare = db.prepare.bind(db);
		db.prepare = ((sql: string) => {
			dbCalls += 1;
			return origPrepare(sql);
		}) as D1Database["prepare"];
		const throttledEnv = { ...env, API_RATE_LIMIT: { limit: async () => ({ success: false }) } } as unknown as Env;

		for (const req of [
			new Request(`${ORIGIN}/api`, { headers: { "CF-Connecting-IP": "1.2.3.4" } }),
			new Request(`${ORIGIN}/lang`, { method: "POST", headers: { Origin: ORIGIN, "CF-Connecting-IP": "1.2.3.4" }, body: "locale=en" }),
			new Request(`${ORIGIN}/logout`, { method: "POST", headers: { Origin: ORIGIN, "CF-Connecting-IP": "1.2.3.4" } }),
			new Request(`${ORIGIN}/does-not-exist`, { headers: { "CF-Connecting-IP": "1.2.3.4" } }),
		]) {
			const res = await app.fetch(req, throttledEnv);
			expect(res.status, req.url).toBe(429);
		}
		expect(dbCalls).toBe(0);
	});

	it("rate-limits /logout and /setup/options before passkeys lookup, sets HttpOnly on lang/theme cookies, and survives cache failures", async () => {
		const langRes = await app.fetch(
			new Request(`${ORIGIN}/lang`, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" }, body: "locale=en" }),
			env,
		);
		expect(langRes.headers.get("set-cookie")).toContain("HttpOnly");
		const themeRes = await app.fetch(
			new Request(`${ORIGIN}/theme`, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" }, body: "theme=dark" }),
			env,
		);
		expect(themeRes.headers.get("set-cookie")).toContain("HttpOnly");

		const loginLimitedEnv = { ...env, LOGIN_RATE_LIMIT: { limit: async () => ({ success: false }) } } as unknown as Env;
		const logoutRes = await app.fetch(new Request(`${ORIGIN}/logout`, { method: "POST", headers: { Origin: ORIGIN } }), loginLimitedEnv);
		expect(logoutRes.status).toBe(429);

		// Even if a passkey exists, /setup/options rate-limits before querying passkeys.
		await db.prepare("INSERT INTO passkeys (id, public_key, counter, name, created_at) VALUES ('pk1', 'k', 0, 'n', 1)").run();
		const setupRes = await app.fetch(
			new Request(`${ORIGIN}/setup/options`, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ code: "x" }) }),
			loginLimitedEnv,
		);
		expect(setupRes.status).toBe(429);

		// Failing Cache API during lockout recording must still return 429, not 500.
		await saveSettings(db, { ...(await loadSettings(db)), simpleloginApi: true });
		vi.stubGlobal("caches", {
			default: {
				match: async () => {
					throw new Error("cache down");
				},
				put: async () => {
					throw new Error("cache down");
				},
			},
		});
		const apiRes = await app.fetch(new Request(`${ORIGIN}/api/user_info`, { headers: { Authentication: "af_wrong" } }), loginLimitedEnv);
		expect(apiRes.status).toBe(429);
	});
});

describe("4. SSRF, Mailflare JMAP safety, and Cloudflare setup hardening", () => {
	it("normalizes trailing dots in isPublicHost blockedHosts and enforces Mailflare runtime host/JMAP checks", async () => {
		expect(isPublicHost("alias.example.com", ["alias.example.com."])).toBe(false);
		expect(() => mailflareConfig({ mailflareUrl: "https://alias.test", mailflareApiKey: "k", siteOrigin: "https://alias.test", publicUrl: "" } as never)).toThrow(MailflareError);
		expect(() => mailflareConfig({ mailflareUrl: "https://127.0.0.1", mailflareApiKey: "k", siteOrigin: "https://alias.test", publicUrl: "" } as never)).toThrow(MailflareError);

		// /jmap/session 404 maps to 502 (retriable), not 404 (permanent skip).
		vi.stubGlobal("fetch", async () => new Response("missing", { status: 404 }));
		await expect(getStoredMessage({ baseUrl: "https://mf.mailprovider.com", apiKey: "k" }, "m1")).rejects.toMatchObject({ status: 502 });

		// Non-JSON 200 throws MailflareError(502) instead of SyntaxError.
		vi.stubGlobal("fetch", async () => new Response("<html>err</html>", { status: 200 }));
		await expect(getStoredMessage({ baseUrl: "https://mf.mailprovider.com", apiKey: "k" }, "m1")).rejects.toMatchObject({ status: 502 });

		// Path traversal in accountId is rejected.
		vi.stubGlobal("fetch", async () => Response.json({ primaryAccounts: { "urn:ietf:params:jmap:mail": ".." } }));
		await expect(getStoredMessage({ baseUrl: "https://mf.mailprovider.com", apiKey: "k" }, "m1")).rejects.toMatchObject({ status: 502 });
	});

	it("filters active zones, reports DNS conflicts in enableRouting, normalizes domain case, and caps response size in Cloudflare setup", async () => {
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
			urls.push(url);
			const path = new URL(url).pathname.replace("/client/v4", "");
			if (path === "/zones") return Response.json({ success: true, result: [{ id: "z1", name: "a.test" }] });
			if (path.endsWith("/email/routing/dns") && init.method === "POST") {
				return Response.json({ success: false, errors: [{ code: 81057, message: "MX record already exists" }] }, { status: 400 });
			}
			if (path.endsWith("/email/routing/rules") && (init.method ?? "GET") === "GET") return Response.json({ success: true, result: [] });
			return Response.json({ success: true, result: {} });
		});
		const res = await setUpDomain({ token: "t", domain: "A.TEST", workerName: "aliasflare" });
		expect(urls[0]).toContain("status=active");
		expect(res.domain).toBe("a.test");
		expect(res.steps.find((s) => s.step === "routing")).toMatchObject({ ok: false });
		expect(res.steps.find((s) => s.step === "catchall")).toMatchObject({ ok: false });

		// Running setup again on a domain whose Email Routing is already on is not a conflict.
		vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
			const path = new URL(url).pathname.replace("/client/v4", "");
			if (path === "/zones") return Response.json({ success: true, result: [{ id: "z1", name: "a.test" }] });
			if (path.endsWith("/email/routing/dns") && init.method === "POST") {
				return Response.json({ success: false, errors: [{ code: 81057, message: "MX record already exists" }] }, { status: 400 });
			}
			if (path.endsWith("/email/routing") && (init.method ?? "GET") === "GET") return Response.json({ success: true, result: { enabled: true, status: "ready" } });
			if (path.endsWith("/email/routing/rules") && (init.method ?? "GET") === "GET") return Response.json({ success: true, result: [] });
			return Response.json({ success: true, result: {} });
		});
		const again = await setUpDomain({ token: "t", domain: "a.test", workerName: "aliasflare" });
		expect(again.steps.find((s) => s.step === "routing")).toMatchObject({ ok: true });
	});
});

describe("5. SMTP multi-line AUTH/streaming/validation and outbound header/redaction hardening", () => {
	it("parses multi-line AUTH to select LOGIN, rejects unsupported AUTH, rejects empty envelope/bad port, and chunks DATA", async () => {
		const makeServer = (ehlo: string, log: string[]): SmtpConnect => {
			return () => {
				let push!: (text: string) => void;
				let inData = false;
				const make = (): SmtpSocket => {
					const readable = new ReadableStream<Uint8Array>({
						start(controller) {
							push = (text) => controller.enqueue(new TextEncoder().encode(text));
						},
					});
					let pending = "";
					const writable = new WritableStream<Uint8Array>({
						write(chunk) {
							pending += new TextDecoder().decode(chunk);
							for (let end = pending.indexOf("\r\n"); end >= 0; end = pending.indexOf("\r\n")) {
								const line = pending.slice(0, end);
								pending = pending.slice(end + 2);
								log.push(line);
								if (inData) {
									if (line === ".") (inData = false), push("250 ok\r\n");
									continue;
								}
								if (line === "DATA") (inData = true), push("354 go\r\n");
								else if (line.startsWith("EHLO")) push(ehlo);
								else if (line === "AUTH LOGIN") push("334 VXNlcm5hbWU6\r\n");
								else if (line === btoa("u")) push("334 UGFzc3dvcmQ6\r\n");
								else if (line === btoa("p")) push("235 ok\r\n");
								else if (line === "QUIT") push("221 bye\r\n");
								else push("250 ok\r\n");
							}
						},
					});
					return { readable, writable, close: async () => {} };
				};
				const socket = make();
				queueMicrotask(() => push("220 ready\r\n"));
				return socket;
			};
		};

		const log: string[] = [];
		await sendSmtp(
			{ host: "smtp.mailprovider.com", port: 465, security: "tls", username: "u", password: "p" },
			{ from: "a@me.test", to: "b@store.test" },
			"Subject: x\r.dot\nline",
			makeServer("250-smtp.test\r\n250-AUTH CRAM-MD5\r\n250 AUTH LOGIN\r\n", log),
		);
		expect(log).toContain("AUTH LOGIN");
		expect(log).toContain("..dot");
		expect(log).toContain("line");

		await expect(
			sendSmtp(
				{ host: "smtp.mailprovider.com", port: 465, security: "tls", username: "u", password: "p" },
				{ from: "a@me.test", to: "b@store.test" },
				"x",
				makeServer("250-smtp.test\r\n250 AUTH XOAUTH2\r\n", []),
			),
		).rejects.toThrow(/AUTH PLAIN or AUTH LOGIN/);
		await expect(sendSmtp({ host: "smtp.mailprovider.com", port: 0, security: "tls", username: "", password: "" }, { from: "a@b.test", to: "c@d.test" }, "x")).rejects.toThrow(/port/);
		await expect(sendSmtp({ host: "smtp.mailprovider.com", port: 465, security: "tls", username: "", password: "" }, { from: "", to: "c@d.test" }, "x")).rejects.toThrow(/envelope/);
	});

	it("strips non-Latin1 in text templates, blocks __proto__ header, redacts echoed API keys, and enforces blockedHosts on SMTP", async () => {
		expect(fillTemplate("{{subject}}", { subject: () => "Hi 你好\x00world" }, "text")).toBe("Hi  world");
		expect(() => parseHeaderLines("__proto__: polluted")).toThrow(/Not a header line/);

		vi.stubGlobal("fetch", async () => new Response("rejected key super-secret-key-999", { status: 401 }));
		await saveConfig(db, { outboundProvider: "resend", outboundApiKey: "super-secret-key-999" });
		const err = await sendOutbound(env, await loadConfig(env), { from: "shop@a.test", to: "bob@store.test", subject: "Hi", text: "Hi" }).catch((e) => e);
		expect(String(err)).not.toContain("super-secret-key-999");
		expect(String(err)).toContain("[redacted]");

		// SMTP respects blockedHosts (siteOrigin / publicUrl / mailflareUrl).
		await saveConfig(db, {
			publicUrl: "https://self.mailprovider.com",
			outboundProvider: "smtp",
			outboundOptions: JSON.stringify({ smtpHost: "self.mailprovider.com", smtpPort: 587 }),
		});
		await expect(sendOutbound(env, await loadConfig(env), { from: "shop@a.test", to: "bob@store.test", subject: "Hi", text: "Hi" })).rejects.toThrow(/public SMTP/);
	});
});

describe("6. MIME, transform, unsubscribe, passkeys, compat API, MCP, importer, DB, and client fixes", () => {
	it("folds long ASCII From names, strips non-ASCII Content-ID, and avoids duplicate banners", async () => {
		const mime = buildMime(
			{
				from: { name: "word ".repeat(220).trim(), email: "shop@a.test" },
				to: "bob@store.test",
				subject: "Hi",
				text: "hi",
				attachments: [{ disposition: "inline", contentId: "id-測試@a.test", filename: "a.png", type: "image/png", content: new Uint8Array([1]).buffer }],
			},
			"<m1@a.test>",
		);
		expect(mime.split("\r\n").every((line) => line.length <= 998)).toBe(true);
		expect(mime).toContain("Content-ID: <id-@a.test>");
		expect(cleanAttachment({ filename: "a.png", mimeType: "image/png", contentId: "<id-測試@a.test>" }, 0).contentId).toBe("id-@a.test");

		const out = await transformForward(
			{ html: "<body><p>1</p></body><body><p>2</p></body>" },
			{
				removeTrackers: false,
				banner: { alias: "shop@a.test", sender: "bob@store.test", blockUrl: "https://alias.test/b", disableUrl: "https://alias.test/d", spoofWarning: false },
				t: translator("en"),
			},
		);
		expect(out.html?.match(/data-aliasflare-banner/g)).toHaveLength(1);
	});

	it("keeps unsubscribe successful if stream cancel or post-action event logging fails", async () => {
		await saveSettings(db, { ...(await loadSettings(db)), unsubscribeBehavior: "preserve_original", unsubscribeFallback: "block_contact" });
		await db.prepare("INSERT INTO aliases (address, num_id, uid, created_at, updated_at) VALUES ('shop@a.test', 1, 'u1', 1, 1)").run();
		await db.prepare("INSERT INTO contacts (id, num_id, alias_address, email, reverse_local, created_at) VALUES ('c1', 1, 'shop@a.test', 'news@store.com', 'r1', 1)").run();
		await db
			.prepare(
				"INSERT INTO forwards (id, inbound_id, alias_address, contact_id, original_unsubscribe, original_unsubscribe_post, status, created_at, updated_at) VALUES ('fw_1', 'i1', 'shop@a.test', 'c1', '<https://store.com/unsub>', 1, 'sent', 1, 1)",
			)
			.run();
		vi.stubGlobal("fetch", async () => ({
			status: 200,
			body: {
				cancel: async () => {
					throw new Error("stream error");
				},
			},
		}));
		const token = await signToken(TEST_SECRET, "unsubscribe", "fw_1", 600);
		const target = await resolveLink(env, await loadConfig(env), "unsubscribe", token);
		expect(target?.plan).toMatchObject({ kind: "post" });
		const origPrepare = db.prepare.bind(db);
		db.prepare = ((sql: string) => {
			if (sql.includes("INSERT INTO events")) throw new Error("log write failed");
			return origPrepare(sql);
		}) as D1Database["prepare"];
		const outcome = await performAction(env, await loadConfig(env), target!);
		expect(outcome.done.action).toBe("preserve_original");
	});

	it("validates alias length >254, trims notes, combines SL filters, rejects [null] recipients, validates MCP types, and fixes importer/passkeys/db/client", async () => {
		const settings = await loadSettings(db);
		const longDomain = `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(50)}.test`;
		await saveSettings(db, { ...settings, aliasDomains: ["a.test", longDomain], simpleloginApi: true, addyApi: true, mcpServer: true });
		const updatedSettings = await loadSettings(db);
		await expect(createAlias(db, updatedSettings, { localPart: "x".repeat(40), domain: longDomain })).rejects.toThrow(/too long/);

		const created = await createAlias(db, updatedSettings, { localPart: "hello", domain: "a.test", note: "init" });
		await updateAlias(db, created.address, { note: "   " });
		expect((await db.prepare("SELECT note FROM aliases WHERE address = ?").bind(created.address).first<{ note: string | null }>())?.note).toBeNull();

		// SL pinned + disabled filter combination & addy [null] recipient_ids rejection.
		await db.prepare("UPDATE aliases SET pinned = 1 WHERE address = ?").bind(created.address).run();
		const { key: appKey } = await createApiKey(db, "app", "apps");
		const pinnedDisabled = await (await app.fetch(new Request(`${ORIGIN}/api/v2/aliases?pinned=true&disabled=true`, { headers: { Authentication: appKey } }), env)).json();
		expect((pinnedDisabled as { aliases: unknown[] }).aliases).toHaveLength(0);
		const badRecipient = await app.fetch(
			new Request(`${ORIGIN}/api/v1/alias-recipients`, {
				method: "POST",
				headers: { Authorization: `Bearer ${appKey}`, "Content-Type": "application/json" },
				body: JSON.stringify({ alias_id: created.uid, recipient_ids: [null] }),
			}),
			env,
		);
		expect(badRecipient.status).toBe(400);

		// MCP create_alias rejects non-string arguments rather than silently creating a random alias.
		const { key: mcpKey } = await createApiKey(db, "bot", "mcp");
		const mcpRes = await (
			await app.fetch(
				new Request(`${ORIGIN}/mcp`, {
					method: "POST",
					headers: { Authorization: `Bearer ${mcpKey}`, "Content-Type": "application/json" },
					body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_alias", arguments: { local_part: 123 } } }),
				}),
				env,
			)
		).json();
		expect(mcpRes).toMatchObject({ result: { isError: true } });

		// Importer handles contact strings longer than 300 chars and excludes existing DB alias domains from destinations.
		const longName = "N".repeat(280);
		vi.stubGlobal("fetch", async () => Response.json({ contacts: [{ contact: `"${longName}" <bob@store.com>`, creation_timestamp: 1700000000, last_email_sent_timestamp: null, block_forward: false }] }));
		const importedList = selectByDomain(
			[
				{
					email: "imp@b.test",
					note: null,
					name: null,
					enabled: true,
					pinned: false,
					destination: "other@a.test",
					createdAt: 1,
					forwarded: 1,
					blocked: 0,
					replied: 0,
					sent: 0,
					lastForwardAt: null,
					lastBlockAt: null,
					lastReplyAt: null,
					lastSentAt: null,
					details: {},
					sourceId: 5,
				},
			],
			["b.test"],
		);
		await addSimpleLoginContacts("https://sl.test", "k", importedList.chosen);
		expect(importedList.chosen[0]!.contacts?.[0]?.email).toBe("bob@store.com");
		const impRes = await importAliases(db, { ...updatedSettings, aliasDomains: ["b.test"] }, "simplelogin", importedList, 1, { keepDestinations: true });
		expect(impRes.created).toBe(1);
		expect((await db.prepare("SELECT destination FROM aliases WHERE address = 'imp@b.test'").first<{ destination: string | null }>())?.destination).toBeNull();

		// issueSetupCode with replace=false does not overwrite an existing valid code; boundedList clamps to 90.
		const firstCode = await issueSetupCode(db, false);
		expect(firstCode.created).toBe(true);
		const secondCode = await issueSetupCode(db, false);
		expect(secondCode.created).toBe(false);
		expect(boundedList(Array.from({ length: 150 }, (_, i) => `v${i}`), 150)).toHaveLength(90);

		// Client script preserves pendingReload across queued saves and guards lastSent reset on catch.
		const js = await (await app.fetch(new Request(`${ORIGIN}/assets/app.js`), env)).text();
		expect(js).toContain("let pendingReload = false;");
		expect(js).toContain("if (id === latest) {");
	});
});
