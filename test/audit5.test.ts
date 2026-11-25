import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiKey } from "../src/apikeys";
import { cleanUp } from "../src/cleanup";
import { ConfigError, loadConfig, saveConfig } from "../src/config";
import { signToken, verifyToken } from "../src/crypto";
import { blocklistCandidates, ensureAlias } from "../src/db";
import { aliasDomainOfReverse } from "../src/domains";
import { cleanAttachment, parseBareEmail, parseMessageIds, replaceAddresses, reverseLocalOf } from "../src/format";
import { fetchAddy, importAliases, parseCsv, selectByDomain } from "../src/importer";
import worker, { app } from "../src/index";
import { buildMime } from "../src/mime";
import { normalizeOutboundOptions, sendOutbound } from "../src/outbound";
import { loadSettings, normalizeSettings, saveSettings, unsubscribeRuleFor } from "../src/settings";
import { sendSmtp, type SmtpConnect, type SmtpSocket } from "../src/smtp";
import { cleanLink, cleanText } from "../src/trackers";
import { transformForward } from "../src/transform";
import { LINK_TTL_SECONDS, sameSenderSite } from "../src/unsubscribe";
import { translator } from "../src/i18n";
import { testDb } from "./helpers/d1";
import { signIn, TEST_SECRET } from "./helpers/session";

/** Regressions for issue #5 and light/dark theme support. */
let db: D1Database;
let env: Env;
let sent: { from: unknown; to: unknown; html?: string; text?: string; headers?: Record<string, string> }[];
let forwardedTo: string[];
const ORIGIN = "https://alias.test";

beforeEach(async () => {
	db = testDb();
	sent = [];
	forwardedTo = [];
	env = {
		DB: db,
		SIGNING_SECRET: TEST_SECRET,
		EMAIL: { send: async (message: (typeof sent)[number]) => (sent.push(message), { messageId: `<s${sent.length}@test>` }) },
	} as unknown as Env;
	await saveSettings(db, { ...(await loadSettings(db)), aliasDomains: ["a.test", "b.test"], defaultDestination: "owner+tag@gmail.test" });
	await db.prepare("INSERT INTO config (key, value) VALUES ('siteOrigin', ?)").bind(ORIGIN).run();
});

afterEach(() => vi.unstubAllGlobals());

describe("1. one-time signed link canonicalization", () => {
	it("rejects non-canonical integer expiry representations in verifyToken", async () => {
		const token = await signToken(TEST_SECRET, "unsubscribe", "fw_123", 600);
		const [payload, expires, mac] = token.split(".");
		expect(await verifyToken(TEST_SECRET, "unsubscribe", token)).toBe("fw_123");
		for (const variant of [`0${expires}`, `00${expires}`, `+${expires}`, `${expires}e0`, `0x${Number(expires).toString(16)}`]) {
			expect(await verifyToken(TEST_SECRET, "unsubscribe", `${payload}.${variant}.${mac}`), variant).toBeNull();
		}
	});

	it("cannot replay an /unsubscribe link by altering expiry formatting", async () => {
		await db.prepare("INSERT INTO aliases (address, num_id, uid, created_at, updated_at) VALUES ('shop@a.test', 1, 'u1', 1, 1)").run();
		await db.prepare("INSERT INTO contacts (id, num_id, alias_address, email, reverse_local, created_at) VALUES ('c1', 1, 'shop@a.test', 'news@store.test', 'r1', 1)").run();
		await db.prepare("INSERT INTO forwards (id, inbound_id, alias_address, contact_id, status, created_at, updated_at) VALUES ('fw_1', 'i1', 'shop@a.test', 'c1', 'sent', 1, 1)").run();
		const token = await signToken(TEST_SECRET, "unsubscribe", "fw_1", 600);
		const [payload, expires, mac] = token.split(".");
		const first = await app.fetch(new Request(`${ORIGIN}/unsubscribe/${token}`, { method: "POST", body: "List-Unsubscribe=One-Click" }), env);
		expect(first.status).toBe(200);
		await db.prepare("UPDATE aliases SET forward_mode = 'all', forward_enabled = 1 WHERE address = 'shop@a.test'").run();
		const replay = await app.fetch(new Request(`${ORIGIN}/unsubscribe/${payload}.0${expires}.${mac}`, { method: "POST", body: "List-Unsubscribe=One-Click" }), env);
		expect(replay.status).toBe(404);
		expect(await db.prepare("SELECT forward_mode FROM aliases WHERE address = 'shop@a.test'").first("forward_mode")).toBe("all");
	});
});

describe("2. outbound SSRF guards and OUTBOUND_OPTIONS validation", () => {
	it("rejects IPv4 literals and internal suffixes for smtpHost", () => {
		for (const bad of ["127.0.0.1", "169.254.169.254", "10.0.0.1", "mail.local", "smtp.internal", "localhost"]) {
			expect(normalizeOutboundOptions({ smtpHost: bad }).smtpHost, bad).toBe("");
		}
		expect(normalizeOutboundOptions({ smtpHost: "smtp.mailprovider.com" }).smtpHost).toBe("smtp.mailprovider.com");
	});

	it("enforces safeHttpsUrl inside viaCustom even when loaded from OUTBOUND_OPTIONS", async () => {
		await expect(loadConfig({ ...env, OUTBOUND_OPTIONS: "null" } as Env)).rejects.toBeInstanceOf(ConfigError);
		await expect(loadConfig({ ...env, OUTBOUND_OPTIONS: "[]" } as Env)).rejects.toBeInstanceOf(ConfigError);
		await saveConfig(db, { outboundProvider: "custom", outboundOptions: JSON.stringify({ customUrl: "https://127.0.0.1/send" }) });
		await expect(sendOutbound(env, await loadConfig(env), { from: "shop@a.test", to: "bob@store.test", subject: "Hi", text: "Hi" })).rejects.toThrow(/public https URL/);
	});

	it("does not skip custom JSON check on X-Content-Type headers and blocks mailflareUrl", async () => {
		const cookie = await signIn(db);
		await saveConfig(db, { mailflareUrl: "https://mf.mailprovider.com" });
		const post = (fields: Record<string, string>) =>
			app.fetch(
				new Request(`${ORIGIN}/connection`, {
					method: "POST",
					headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({ smtpPort: "587", ...fields }).toString(),
				}),
				env,
			);
		const sameHost = await post({ customUrl: "https://mf.mailprovider.com/api", customHeaders: "", customBody: "{}" });
		expect(sameHost.headers.get("location")).toContain("notice.badCustom");
		const badJson = await post({ customUrl: "https://api.mailprovider.com/send", customHeaders: "X-Content-Type: text/plain", customBody: "{not json" });
		expect(badJson.headers.get("location")).toContain("notice.badCustom");
	});
});

describe("3. direct inbound 409 retry and mailbox_id preservation", () => {
	it("throws on 409 in-progress claim so Email Routing retries instead of dropping", async () => {
		const raw = "From: bob@store.test\r\nTo: shop@a.test\r\nSubject: Hi\r\nMessage-ID: <m409@store.test>\r\nDate: Mon, 1 Jan 2026 00:00:00 +0000\r\n\r\nHello\r\n";
		const headers = new Headers({ From: "bob@store.test", "Message-ID": "<m409@store.test>", Date: "Mon, 1 Jan 2026 00:00:00 +0000" });
		const makeMsg = () =>
			({
				to: "shop@a.test",
				from: "bob@store.test",
				headers,
				raw: new Response(raw).body,
				rawSize: raw.length,
				forward: async (d: string) => void forwardedTo.push(d),
				setReject: () => {},
			}) as unknown as ForwardableEmailMessage;
		// Seed an active processing row with the same inbound_id by running once with a hanging EMAIL.send.
		let release!: () => void;
		env.EMAIL = { send: () => new Promise<{ messageId: string }>((r) => { release = () => r({ messageId: "<ok@test>" }); }) } as unknown as SendEmail;
		const first = worker.email!(makeMsg() as never, env);
		await new Promise((r) => setTimeout(r, 10));
		await expect(worker.email!(makeMsg() as never, env)).rejects.toThrow(/in progress/);
		release();
		await first;
	});

	it("preserves an existing Mailflare mailbox_id when ensureAlias is called with empty mailboxId", async () => {
		await ensureAlias(db, "shop@a.test", "mb_123", { forwardEnabled: true, destination: null });
		const after = await ensureAlias(db, "shop@a.test", "", { forwardEnabled: true, destination: null });
		expect(after.mailbox_id).toBe("mb_123");
	});
});

describe("4-9. input limits, MCP, unsubscribe, reply redaction, SMTP and importer hardening", () => {
	it("caps POST /lang body size and handles non-GET requests to static paths without 500", async () => {
		const big = await app.fetch(
			new Request(`${ORIGIN}/lang`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: "locale=" + "a".repeat(5000) }),
			env,
		);
		expect(big.status).toBe(413);
		const postAsset = await app.fetch(new Request(`${ORIGIN}/assets/app.js`, { method: "POST" }), env);
		expect(postAsset.status).toBe(401);
	});

	it("enforces Cache-Control: no-store, -32600 for invalid method with id, and refuses restoring deleted aliases on /mcp", async () => {
		await saveSettings(db, { ...(await loadSettings(db)), mcpServer: true });
		const { key } = await createApiKey(db, "bot", "mcp");
		await db.prepare("INSERT INTO aliases (address, num_id, uid, destination, deleted_at, created_at, updated_at) VALUES ('old@a.test', 1, 'u1', 'custom@gmail.test', 10, 1, 1)").run();
		const call = (payload: unknown) =>
			app.fetch(
				new Request(`${ORIGIN}/mcp`, {
					method: "POST",
					headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
					body: JSON.stringify(payload),
				}),
				env,
			);
		const bad = await call({ jsonrpc: "2.0", id: 1, method: 123 });
		expect(bad.status).toBe(400);
		expect(bad.headers.get("Cache-Control")).toBe("no-store");
		expect(await bad.json()).toMatchObject({ id: 1, error: { code: -32600 } });
		const restore = await call({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create_alias", arguments: { domain: "a.test", local_part: "old" } } });
		expect(await restore.json()).toMatchObject({ result: { isError: true } });
		expect(await db.prepare("SELECT deleted_at, destination FROM aliases WHERE address = 'old@a.test'").first()).toEqual({ deleted_at: 10, destination: "custom@gmail.test" });
	});

	it("blocks shared webmail ccTLD domains in sameSenderSite", () => {
		expect(sameSenderSite("victim@yahoo.co.jp", "news@yahoo.co.jp")).toBe(false);
		expect(sameSenderSite("victim@hotmail.co.uk", "news@hotmail.co.uk")).toBe(false);
		expect(sameSenderSite("victim@protonmail.ch", "news@protonmail.ch")).toBe(false);
		expect(sameSenderSite("leave@lists.shop.co.uk", "news@shop.co.uk")).toBe(true);
	});

	it("redacts arbitrary zero-padded HTML entities for '+' in replaceAddresses", () => {
		const html = "<p>owner&#0043;tag@gmail.test and owner&#x02b;tag@gmail.test</p>";
		expect(replaceAddresses(html, [{ from: "owner+tag@gmail.test", to: "shop@a.test" }], { encodedPlus: true })).toBe("<p>shop@a.test and shop@a.test</p>");
	});

	it("rejects SMTP envelope injection and caps cumulative multi-line SMTP replies", async () => {
		await expect(sendSmtp({ host: "smtp.example.com", port: 587, security: "starttls", username: "", password: "" }, { from: "a@b.com\r\nQUIT", to: "c@d.com" }, "Hi")).rejects.toThrow(/Invalid SMTP/);
		const floodingServer: SmtpConnect = () => {
			let sentLines = 0;
			const readable = new ReadableStream<Uint8Array>({
				pull(controller) {
					sentLines += 1;
					controller.enqueue(new TextEncoder().encode(`250-line-${sentLines}\r\n`));
				},
			});
			const writable = new WritableStream<Uint8Array>();
			return { readable, writable, close: async () => {} } as SmtpSocket;
		};
		await expect(
			sendSmtp({ host: "smtp.example.com", port: 465, security: "tls", username: "", password: "" }, { from: "a@b.com", to: "c@d.com" }, "Hi", floodingServer),
		).rejects.toThrow(/too long/);
	});

	it("blocks contacts on own alias domains and cross-domain batch loops during import", async () => {
		const aliases = [
			{
				email: "one@new1.test",
				note: null,
				name: "Bad\r\nName",
				enabled: true,
				pinned: false,
				destination: "two@new2.test",
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
					{ email: "loop@a.test", name: "Own", createdAt: 1, lastSentAt: null, blocked: false },
					{ email: "ok@external.test", name: "Bob\r\n<x>", createdAt: 1, lastSentAt: null, blocked: false },
				],
			},
			{
				email: "two@new2.test",
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
		];
		await importAliases(db, await loadSettings(db), "simplelogin", selectByDomain(aliases, ["new1.test", "new2.test"]), aliases.length, { keepDestinations: true });
		expect(await db.prepare("SELECT destination, name FROM aliases WHERE address = 'one@new1.test'").first()).toEqual({ destination: null, name: "Bad Name" });
		const { results: contacts } = await db.prepare("SELECT email, name FROM contacts WHERE alias_address = 'one@new1.test'").all<{ email: string; name: string }>();
		expect(contacts).toEqual([{ email: "ok@external.test", name: "Bob x" }]);
	});
});

describe("10-12. MIME, trackers, settings, API, cleanup and utility fixes", () => {
	it("handles unpaired UTF-16 surrogates in attachment filenames and folds long ASCII headers", () => {
		const emojiName = `${"a".repeat(199)}😀.pdf`;
		const cleaned = cleanAttachment({ filename: emojiName, mimeType: "application/pdf" }, 0);
		expect(() =>
			buildMime({
				from: "shop@a.test",
				to: "bob@store.test",
				subject: Array.from({ length: 120 }, (_, i) => `word${i}`).join(" "),
				text: "hi",
				headers: { References: Array.from({ length: 10 }, (_, i) => `<${"x".repeat(120)}-${i}@store.test>`).join(" ") },
				attachments: [{ disposition: "attachment", filename: cleaned.filename, type: cleaned.type, content: new Uint8Array([1]).buffer }],
			}, "<id@a.test>"),
		).not.toThrow();
		const mime = buildMime({ from: "shop@a.test", to: "bob@store.test", subject: Array.from({ length: 120 }, (_, i) => `word${i}`).join(" "), text: "hi" }, "<id@a.test>");
		expect(mime.split("\r\n").every((line) => line.length <= 998)).toBe(true);
	});

	it("preserves _gallery and trailing sentence punctuation in trackers", () => {
		expect(cleanLink("https://shop.com/?_gallery=1&_ga=2&_ga_ABC=3").href).toBe("https://shop.com/?_gallery=1");
		expect(cleanText("See https://shop.com/?utm_source=x.").text).toBe("See https://shop.com/.");
	});

	it("does not inject banner inside <head> comment when <body> is absent", async () => {
		const html = "<html><head><!-- </head> --><title>T</title></head><p>Body</p></html>";
		const out = await transformForward(
			{ html },
			{
				removeTrackers: false,
				banner: { alias: "shop@a.test", sender: "bob@store.test", blockUrl: "https://alias.test/b", disableUrl: "https://alias.test/d", spoofWarning: false },
				t: translator("en"),
			},
		);
		expect(out.html).toContain("</head><div data-aliasflare-banner");
	});

	it("preserves per-domain fallback/redirect overrides when behavior inherits general setting", () => {
		const settings = normalizeSettings({
			aliasDomains: ["a.test"],
			unsubscribeBehavior: "preserve_original",
			unsubscribeFallback: "block_contact",
			unsubscribeDomains: { "a.test": { behavior: "", fallback: "disable_alias", redirect: "lists@gmail.test" } },
		});
		expect(unsubscribeRuleFor(settings, "x@a.test")).toEqual({ behavior: "preserve_original", fallback: "disable_alias", redirect: "lists@gmail.test" });
	});

	it("handles addy pagination past last_page, empty domain fallback, NaN last_page, blank CSV rows and cleanup", async () => {
		await saveSettings(db, { ...(await loadSettings(db)), addyApi: true, simpleloginApi: true });
		const { key } = await createApiKey(db, "app", "apps");
		await db.prepare("INSERT INTO aliases (address, num_id, uid, created_at, updated_at) VALUES ('one@a.test', 1, 'u1', 1, 1)").run();
		const res = await app.fetch(new Request(`${ORIGIN}/api/v1/aliases?page[number]=5&page[size]=10`, { headers: { Authorization: `Bearer ${key}` } }), env);
		const json = (await res.json()) as { meta: { from: number | null; to: number | null } };
		expect(json.meta.from).toBeNull();
		expect(json.meta.to).toBeNull();

		const created = await app.fetch(
			new Request(`${ORIGIN}/api/v1/aliases`, {
				method: "POST",
				headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
				body: JSON.stringify({ format: "custom", local_part: "custom1", domain: "" }),
			}),
			env,
		);
		expect(created.status).toBe(201);

		vi.stubGlobal("fetch", async () => Response.json({ data: [{ email: "x@a.test" }], meta: { last_page: "bad" } }));
		expect(await fetchAddy("https://app.addy.io", "k")).toHaveLength(1);
		expect(parseCsv("\n\na,b\n\nc,d\n", 2)).toEqual([["a", "b"], ["c", "d"]]);

		expect(reverseLocalOf("no-at-sign")).toBeNull();
		expect(parseBareEmail("user@127.0.0.1")).toBeNull();
		expect(parseMessageIds("<ok@x> <bad\u2603@x>")).toEqual(["<ok@x>"]);
		expect(blocklistCandidates("User@Sub.Example.com")[0]).toBe("user@sub.example.com");
		expect(aliasDomainOfReverse("R.A.TEST")).toBe("a.test");

		const nowSec = 10 * LINK_TTL_SECONDS;
		await db.prepare("INSERT INTO auth_challenges (id, purpose, challenge, expires_at) VALUES ('old_ch', 'login', 'c', 1), ('new_ch', 'login', 'c', ?)").bind(nowSec + 60).run();
		await db.prepare("INSERT INTO used_links (token_hash, used_at) VALUES ('old_tok', 1), ('new_tok', ?)").bind(nowSec).run();
		await cleanUp(db, nowSec);
		expect(await db.prepare("SELECT id FROM auth_challenges").all()).toMatchObject({ results: [{ id: "new_ch" }] });
		expect(await db.prepare("SELECT token_hash FROM used_links").all()).toMatchObject({ results: [{ token_hash: "new_tok" }] });
	});
});

describe("light/dark/system theme setting", () => {
	it("persists theme via POST /theme (same-origin only) and renders data-theme and theme-color in SSR HTML", async () => {
		const cross = await app.fetch(
			new Request(`${ORIGIN}/theme`, { method: "POST", headers: { origin: "https://evil.test", "content-type": "application/x-www-form-urlencoded" }, body: "theme=dark" }),
			env,
		);
		expect(cross.status).toBe(403);

		const setDark = await app.fetch(
			new Request(`${ORIGIN}/theme`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: "theme=dark&next=/login" }),
			env,
		);
		expect(setDark.status).toBe(303);
		expect(setDark.headers.get("location")).toBe("/login");
		expect(setDark.headers.get("set-cookie")).toContain("af_theme=dark");

		const darkHtml = await (await app.fetch(new Request(`${ORIGIN}/setup`, { headers: { Cookie: "af_theme=dark" } }), env)).text();
		expect(darkHtml).toContain('data-theme="dark"');
		expect(darkHtml).toContain('<meta name="theme-color" content="#202124" />');

		const lightHtml = await (await app.fetch(new Request(`${ORIGIN}/setup`, { headers: { Cookie: "af_theme=light" } }), env)).text();
		expect(lightHtml).toContain('data-theme="light"');
		expect(lightHtml).toContain('<meta name="theme-color" content="#f6f8fc" />');

		const systemHtml = await (await app.fetch(new Request(`${ORIGIN}/setup`, { headers: { Cookie: "af_theme=system" } }), env)).text();
		expect(systemHtml).not.toContain("data-theme=");
	});

	it("updates theme cookie via /settings autosave and returns theme in JSON response", async () => {
		const cookie = await signIn(db);
		const res = await app.fetch(
			new Request(`${ORIGIN}/settings`, {
				method: "POST",
				headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded", "X-Autosave": "1" },
				body: "aliasDomains=a.test&defaultDestination=owner%40gmail.test&uiTheme=dark",
			}),
			env,
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("set-cookie")).toContain("af_theme=dark");
		expect(await res.json()).toMatchObject({ ok: true, theme: "dark" });
	});
});

describe("UI layout and activity search / pagination", () => {
	it("styles search inputs consistently and aligns create-alias note and destination fields", async () => {
		const css = await (await app.fetch(new Request(`${ORIGIN}/assets/app.css`), env)).text();
		expect(css).toContain("input[type=search]");
		expect(css).toContain(".create-extra { display:grid;");
		expect(css).toContain("align-items:end;");
		expect(css).toContain(".create-extra label { display:flex; flex-direction:column;");
	});

	it("supports searching and changing per-page count on /activity", async () => {
		const cookie = await signIn(db);
		for (let i = 1; i <= 30; i += 1) {
			await db
				.prepare("INSERT INTO forwards (id, inbound_id, alias_address, subject, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'sent', ?, ?)")
				.bind(`f${i}`, `in${i}`, i === 1 ? "special@a.test" : `user${i}@a.test`, i === 1 ? "Invoice 100%" : `Hello ${i}`, i, i)
				.run();
		}
		await db
			.prepare("INSERT INTO events (id, kind, alias_address, status, detail, created_at) VALUES ('e1', 'reply', 'replybox@a.test', 'sent', 'Replied to Bob', 100)")
			.run();

		const paged = await (await app.fetch(new Request(`${ORIGIN}/activity?per=25&page=1`, { headers: { cookie } }), env)).text();
		expect(paged).toContain("31 entries");
		expect(paged).toContain('name="q"');
		expect(paged).toContain('name="per"');
		expect(paged).toContain("/activity?per=25&amp;page=2");

		const searched = await (await app.fetch(new Request(`${ORIGIN}/activity?q=100%25&per=25`, { headers: { cookie } }), env)).text();
		expect(searched).toContain("1 entries");
		expect(searched).toContain("special@a.test");
		expect(searched).not.toContain("user2@a.test");

		const eventSearch = await (await app.fetch(new Request(`${ORIGIN}/activity?q=replybox`, { headers: { cookie } }), env)).text();
		expect(eventSearch).toContain("1 entries");
		expect(eventSearch).toContain("replybox@a.test");
	});
});
