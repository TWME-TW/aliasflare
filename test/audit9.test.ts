import PostalMime from "postal-mime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiKey } from "../src/apikeys";
import { attachmentSearchText, scrubAttachedMessage } from "../src/attachments";
import { setUpDomain } from "../src/cloudflare";
import { loadConfig, type AppConfig } from "../src/config";
import { hmacHex } from "../src/crypto";
import { dmarcFailedAtCloudflare } from "../src/forward";
import { fetchAddyExtras, importAddyExtras, parseAliasCsv } from "../src/importer";
import worker, { app } from "../src/index";
import { createLabel, toggleAliasLabels } from "../src/labels";
import { buildMime, formatAddress } from "../src/mime";
import { normalizeOutboundOptions, parseHeaderLines, sendOutbound } from "../src/outbound";
import { handleReverseAliasMail, stripSignedLinks } from "../src/reply";
import { loadSettings, saveSettings } from "../src/settings";
import { cleanLink } from "../src/trackers";
import { testDb } from "./helpers/d1";
import { signIn, TEST_SECRET } from "./helpers/session";

/** Regressions for audit9 security and code quality review findings. */
let db: D1Database;
let env: Env;
let sent: {
	from: unknown;
	to: unknown;
	subject?: string;
	headers?: Record<string, string>;
	html?: string;
	text?: string;
	attachments?: { filename: string; type: string; content: ArrayBuffer }[];
}[];
const ORIGIN = "https://alias.test";
const PASS = "Authentication-Results: mx.cloudflare.net; spf=pass; dmarc=pass header.from=home.test";

beforeEach(async () => {
	db = testDb();
	sent = [];
	env = {
		DB: db,
		SIGNING_SECRET: TEST_SECRET,
		EMAIL: { send: async (message: (typeof sent)[number]) => (sent.push(message), { messageId: `<s${sent.length}@test>` }) },
	} as unknown as Env;
	await saveSettings(db, { ...(await loadSettings(db)), addyApi: true, simpleloginApi: true, mcpServer: true, aliasDomains: ["a.test"], defaultDestination: "me@home.test" });
	await db.prepare("INSERT INTO config (key, value) VALUES ('siteOrigin', ?)").bind(ORIGIN).run();
	await db.prepare("INSERT INTO aliases (address, num_id, uid, forward_mode, forward_enabled, created_at, updated_at) VALUES ('shop@a.test', 1, 'u1', 'all', 1, 1, 1)").run();
});

afterEach(() => vi.unstubAllGlobals());

describe("1. Negative-sender block rules against spoofed From & mixed sender conditions", () => {
	it("blocks spoofed From pretending to match a negative-sender allowlist rule and mixed OR/AND rules", async () => {
		const { key } = await createApiKey(db, "app", "apps");
		const addRule = (body: unknown) =>
			app.fetch(new Request(`${ORIGIN}/api/v1/rules`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }), env);

		// Rule: block everything not from @work.test
		await addRule({ name: "Only work", conditions: [{ type: "sender", match: "does not end with", values: ["@work.test"] }], actions: [{ type: "block" }] });

		// Attacker uses MAIL FROM attacker@evil.test and spoofs From: boss@work.test (dmarc=fail -> spoofed=true) -> MUST BE BLOCKED!
		const spoofedRaw =
			"Authentication-Results: mx.cloudflare.net; dmarc=fail header.from=work.test\r\nFrom: boss@work.test\r\nTo: shop@a.test\r\nSubject: Wire\r\nMessage-ID: <sp-neg@evil.test>\r\n\r\nSend money\r\n";
		await worker.email!(
			{ to: "shop@a.test", from: "attacker@evil.test", headers: new Headers({ From: "boss@work.test" }), raw: new Response(spoofedRaw).body, rawSize: spoofedRaw.length, forward: async () => {}, setReject: () => {} } as never,
			env,
		);
		expect(sent).toHaveLength(0);

		// Legitimate DMARC-passing work.test mail with different bounce envelope is STILL allowed.
		const legitRaw =
			"Authentication-Results: mx.cloudflare.net; spf=pass; dmarc=pass header.from=work.test\r\nFrom: boss@work.test\r\nTo: shop@a.test\r\nSubject: Hi\r\nMessage-ID: <ok-neg@work.test>\r\n\r\nHello\r\n";
		await worker.email!(
			{ to: "shop@a.test", from: "bounce@mailer.test", headers: new Headers({ From: "boss@work.test" }), raw: new Response(legitRaw).body, rawSize: legitRaw.length, forward: async () => {}, setReject: () => {} } as never,
			env,
		);
		expect(sent).toHaveLength(1);

		// Mixed OR rule: block if sender is attacker@evil.test OR sender does not end with @work.test.
		await db.prepare("DELETE FROM rules").run();
		await addRule({
			name: "Mixed OR",
			operator: "OR",
			conditions: [
				{ type: "sender", match: "is exactly", values: ["attacker@evil.test"] },
				{ type: "sender", match: "does not end with", values: ["@work.test"] },
			],
			actions: [{ type: "block" }],
		});
		const mixedRaw =
			"Authentication-Results: mx.cloudflare.net; spf=pass; dmarc=pass header.from=work.test\r\nFrom: boss@work.test\r\nTo: shop@a.test\r\nSubject: Hi\r\nMessage-ID: <mix@evil.test>\r\n\r\nHello\r\n";
		await worker.email!(
			{ to: "shop@a.test", from: "attacker@evil.test", headers: new Headers({ From: "boss@work.test" }), raw: new Response(mixedRaw).body, rawSize: mixedRaw.length, forward: async () => {}, setReject: () => {} } as never,
			env,
		);
		expect(sent).toHaveLength(1);
	});
});

describe("2. Deep .eml scrubbing (plain transport headers, Message-ID ownSites, Invalid Date, deep nesting, encoded signed links)", () => {
	it("always rebuilds plain .eml to strip Received/Delivered-To/Message-ID ownSites and handles invalid Date", async () => {
		const rawPlain = new TextEncoder().encode(
			[
				"Received: from mx.home.test for <me+tag@home.test>",
				"Delivered-To: me@home.test",
				"Message-ID: <secret-id@mail.home.test>",
				"In-Reply-To: <earlier@mail.home.test>",
				"Date: not-a-real-date",
				"From: Owner <me@home.test>",
				"To: bob@store.test",
				"Subject: Plain",
				"",
				"Hello",
			].join("\r\n"),
		).buffer as ArrayBuffer;
		const scrubbed = await scrubAttachedMessage(rawPlain, [{ from: "me@home.test", to: "shop@a.test" }], stripSignedLinks, {
			ownSites: new Set(["home.test"]),
		});
		const text = new TextDecoder().decode(scrubbed);
		expect(text).not.toContain("Received:");
		expect(text).not.toContain("Delivered-To:");
		expect(text).not.toContain("home.test");
		expect(text).not.toContain("Invalid Date");
		expect(text).toContain("shop@a.test");
	});

	it("discovers RFC 2047 reverse aliases in attachmentSearchText and removes deeply nested .eml instead of leaking raw bytes", async () => {
		const rfc2047 = new TextEncoder().encode(
			"From: =?UTF-8?B?cmVwbHkrYWJjQHIuYS50ZXN0?= <bob@store.test>\r\nTo: shop@a.test\r\nSubject: hi\r\n\r\nbody\r\n",
		).buffer as ArrayBuffer;
		const searched = await attachmentSearchText(rfc2047, "message");
		expect(searched).toContain("reply+abc@r.a.test");

		const deepStub = await scrubAttachedMessage(rfc2047, [], stripSignedLinks, { depth: 5 });
		const parsed = await PostalMime.parse(deepStub);
		expect(parsed.subject).toBe("[attached message removed]");
		expect(parsed.text).toContain("removed for privacy");
	});

	it("strips encoded ~ / . / _ signed links without leaking origin and quotes/encodes long ASCII From names", () => {
		const token = `fw%5F${"a".repeat(32)}%2E1799999999%2Esig_TOKEN`;
		expect(stripSignedLinks(`click https://private.example/action/block%7E${token} now`)).toBe("click [link removed] now");
		expect(stripSignedLinks(`click https://private.example/action/disable&#0126;fw_${"a".repeat(32)}.123.abc now`)).toBe("click [link removed] now");

		// Long ASCII display name with RFC 5322 specials must be RFC 2047-encoded, not emitted unquoted.
		const longName = `${"a, b; c: ".repeat(110)}end`;
		const formatted = formatAddress({ name: longName, email: "shop@a.test" });
		expect(formatted).toContain("=?UTF-8?B?");
		expect(formatted).not.toContain("a, b;");
		// buildMime handles Invalid Date gracefully.
		const mime = buildMime({ from: "shop@a.test", to: "bob@store.test", subject: "Hi", text: "Hi" }, "<id@a.test>", new Date("invalid"));
		expect(mime).not.toContain("Invalid Date");
	});
});

describe("3. Forward & reply hardening (Authentication-Results comma split, missing From, sendAutoReplies loop & header)", () => {
	it("ignores forged second Authentication-Results header joined with comma and marks missing From as spoofed", async () => {
		expect(dmarcFailedAtCloudflare("mx.cloudflare.net; spf=pass; dmarc=pass header.from=trusted.test, attacker.test; dmarc=fail")).toBe(false);
		expect(dmarcFailedAtCloudflare("mx.cloudflare.net; dmarc=fail header.from=trusted.test, other; dmarc=pass")).toBe(true);

		const noFromRaw = "To: shop@a.test\r\nSubject: No From\r\nMessage-ID: <nf1@other.test>\r\n\r\nBody\r\n";
		await worker.email!(
			{ to: "shop@a.test", from: "env@other.test", headers: new Headers({ To: "shop@a.test" }), raw: new Response(noFromRaw).body, rawSize: noFromRaw.length, forward: async () => {}, setReject: () => {} } as never,
			env,
		);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.subject).toMatch(/\[.*\] No From/);
	});

	it("adds Auto-Submitted header when sendAutoReplies is on and blocks auto-reply loops to own/owner addresses", async () => {
		await saveSettings(db, { ...(await loadSettings(db)), sendAutoReplies: true });
		await db
			.prepare(
				"INSERT INTO contacts (id, alias_address, email, reverse_local, created_at) VALUES ('c1', 'shop@a.test', 'bob@store.test', 'rbob', 1), ('c2', 'shop@a.test', 'me@home.test', 'rself', 2)",
			)
			.run();
		const autoToBob = `${PASS}\r\nFrom: me@home.test\r\nTo: reply+rbob@r.a.test\r\nAuto-Submitted: auto-replied\r\nSubject: OOO\r\nContent-Type: text/plain\r\n\r\nAway\r\n`;
		await handleReverseAliasMail(
			{ to: "reply+rbob@r.a.test", raw: new Response(autoToBob).body, rawSize: autoToBob.length, setReject: () => {} } as never,
			env,
			{ outboundProvider: "cloudflare", workersPlan: "paid" } as AppConfig,
		);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.headers?.["Auto-Submitted"]).toBe("auto-replied");

		// Auto-reply whose contact is the owner's own mailbox must be dropped as a loop.
		const autoToSelf = `${PASS}\r\nFrom: me@home.test\r\nTo: reply+rself@r.a.test\r\nAuto-Submitted: auto-replied\r\nSubject: OOO\r\nContent-Type: text/plain\r\n\r\nAway\r\n`;
		await handleReverseAliasMail(
			{ to: "reply+rself@r.a.test", raw: new Response(autoToSelf).body, rawSize: autoToSelf.length, setReject: () => {} } as never,
			env,
			{ outboundProvider: "cloudflare", workersPlan: "paid" } as AppConfig,
		);
		expect(sent).toHaveLength(1);
	});
});

describe("4. Importer, bulk labels, API settings race, MCP, config, outbound, trackers, Cloudflare", () => {
	it("maps addy.io recipient UUIDs in imported rules, rejects disallowed forwardTo targets, and ignores CSV deleted_at sentinels", async () => {
		vi.stubGlobal("fetch", async (url: string) => {
			const { pathname } = new URL(url);
			if (pathname === "/api/v1/labels") return Response.json({ data: [] });
			if (pathname === "/api/v1/recipients") {
				return Response.json({ data: [{ id: "rcpt-home", email: "me@home.test" }, { id: "rcpt-evil", email: "stranger@evil.test" }] });
			}
			if (pathname === "/api/v1/rules") {
				return Response.json({
					data: [
						{ name: "Allowed", order: 1, operator: "AND", conditions: [{ type: "subject", match: "contains", values: ["ok"] }], actions: [{ type: "forwardTo", value: "rcpt-home" }] },
						{ name: "Disallowed", order: 2, operator: "AND", conditions: [{ type: "subject", match: "contains", values: ["bad"] }], actions: [{ type: "forwardTo", value: "rcpt-evil" }] },
					],
				});
			}
			if (pathname === "/api/v1/blocklist") return Response.json({ data: [] });
			return new Response("not found", { status: 404 });
		});
		const extras = await fetchAddyExtras("https://app.addy.test", "k");
		const res = await importAddyExtras(db, extras, [], { allowedDestinations: new Set(["me@home.test"]), ownDomains: ["a.test"] });
		expect(res.rules).toBe(1);
		expect(res.rulesSkipped).toEqual(["Disallowed"]);

		const parsedCsv = parseAliasCsv("alias,deleted_at\r\nactive1@a.test,null\r\nactive2@a.test,false\r\nactive3@a.test,0\r\ngone@a.test,2026-01-01 00:00:00\r\n");
		expect(parsedCsv.map((a) => [a.email, a.deletedAt !== null])).toEqual([
			["active1@a.test", false],
			["active2@a.test", false],
			["active3@a.test", false],
			["gone@a.test", true],
		]);
	});

	it("batches multi-label toggles returning distinct alias counts, enforces MCP additionalProperties, and avoids clobbering concurrent settings", async () => {
		const l1 = await createLabel(db, { name: "L1" });
		const l2 = await createLabel(db, { name: "L2" });
		await db.prepare("INSERT INTO aliases (address, num_id, uid, forward_mode, forward_enabled, created_at, updated_at) VALUES ('two@a.test', 2, 'u2', 'all', 1, 2, 2)").run();
		const addedCount = await toggleAliasLabels(db, ["shop@a.test", "two@a.test"], [l1.id, l2.id], true);
		expect(addedCount).toBe(2);

		// MCP rejects unknown arguments (additionalProperties: false) and empty domain
		const { key: mcpKey } = await createApiKey(db, "ai", "mcp");
		const badArg = await app.fetch(
			new Request(`${ORIGIN}/mcp`, {
				method: "POST",
				headers: { Authorization: `Bearer ${mcpKey}`, "Content-Type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_alias", arguments: { localPart: "typo" } } }),
			}),
			env,
		);
		expect(((await badArg.json()) as { result: { isError?: boolean } }).result.isError).toBe(true);

		// API changeSettings reloads and writes only modified keys (preserving admin changes made after middleware started).
		const { key: appKey } = await createApiKey(db, "app", "apps");
		const patchRes = await app.fetch(
			new Request(`${ORIGIN}/api/setting`, {
				method: "PATCH",
				headers: { Authentication: appKey, "Content-Type": "application/json" },
				body: JSON.stringify({ sender_format: "NAME_ONLY" }),
			}),
			env,
		);
		expect(patchRes.status).toBe(200);
		expect((await loadSettings(db)).senderFormat).toBe("NAME_ONLY");

		// POST /v1/aliases accepts 55-char valid local_part (51-64 chars)
		const longLocal = "a".repeat(55);
		const longAlias = await app.fetch(
			new Request(`${ORIGIN}/api/v1/aliases`, {
				method: "POST",
				headers: { Authorization: `Bearer ${appKey}`, "Content-Type": "application/json" },
				body: JSON.stringify({ domain: "a.test", format: "custom", local_part: longLocal }),
			}),
			env,
		);
		expect(longAlias.status).toBe(201);

		// Bulk labels/recipients reject missing array instead of silently wiping
		const missingLabels = await app.fetch(
			new Request(`${ORIGIN}/api/v1/aliases/labels/bulk`, {
				method: "POST",
				headers: { Authorization: `Bearer ${appKey}`, "Content-Type": "application/json" },
				body: JSON.stringify({ ids: ["u1"] }),
			}),
			env,
		);
		expect(missingLabels.status).toBe(422);
	});

	it("heals tab-padded signingSecret, validates webhook payload types, rejects non-ByteString headers, preserves raw query params in cleanLink, and paginates Cloudflare MX records", async () => {
		// Tab-padded signingSecret self-heals properly
		const noSecretEnv = { DB: db } as unknown as Env;
		await db.prepare("INSERT INTO config (key, value) VALUES ('signingSecret', ?)").bind("\t".repeat(40)).run();
		const healed = await loadConfig(noSecretEnv);
		expect(healed.signingSecret.length).toBeGreaterThanOrEqual(32);

		// Signed webhook with non-string messageId returns 400 instead of 500
		await db
			.prepare("INSERT INTO config (key, value) VALUES ('mailflareUrl', 'https://mailflare.test'), ('mailflareApiKey', 'mf_key_test'), ('webhookSecret', 'whsec_test_secret_123456')")
			.run();
		const body = JSON.stringify({ type: "message.inbound", data: { messageId: 12345, to: ["bad"] } });
		const sig = await hmacHex("whsec_test_secret_123456", body);
		const whRes = await app.fetch(
			new Request(`${ORIGIN}/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "X-Email-Platform-Signature": sig }, body }),
			env,
		);
		expect(whRes.status).toBe(400);

		// Non-ByteString static header rejected
		expect(() => parseHeaderLines("X-Note: 你好")).toThrow(/invalid or control/i);

		// Plain-text empty body falls back to space for Resend
		let capturedBody = "";
		vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => {
			capturedBody = String(init?.body ?? "");
			return Response.json({ id: "ok" });
		});
		await sendOutbound(
			env,
			{ outboundProvider: "resend", outboundApiKey: "re_123456", outboundOptions: normalizeOutboundOptions({}) } as AppConfig,
			{ from: "shop@a.test", to: "bob@store.test", subject: "Hi", text: "" },
		);
		expect(JSON.parse(capturedBody).text).toBe(" ");

		// cleanLink preserves raw percent-encoding and valueless flags
		const cleaned = cleanLink("https://example.com/pay?sig=a%20b%2Fc&confirm&utm_source=mail#frag");
		expect(cleaned).toEqual({ href: "https://example.com/pay?sig=a%20b%2Fc&confirm#frag", changed: true });

		// Cloudflare setUpDomain strips trailing dot and paginates dns_records
		let dnsPageSeen = 0;
		vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
			const parsed = new URL(url);
			const path = parsed.pathname.replace("/client/v4", "");
			const method = init.method ?? "GET";
			if (path === "/zones") return Response.json({ success: true, result: [{ id: "z1", name: "a.test" }] });
			if (path.endsWith("/email/routing/dns") && method === "POST" && init.body) {
				return Response.json({ success: false, errors: [{ code: 81057, message: "MX record already exists" }] }, { status: 400 });
			}
			if (path.endsWith("/dns_records") && method === "GET") {
				dnsPageSeen = Number(parsed.searchParams.get("page") ?? 1);
				return Response.json({
					success: true,
					result:
						dnsPageSeen === 1
							? Array.from({ length: 100 }, () => ({ type: "MX", content: "route1.mx.cloudflare.net" }))
							: [{ type: "MX", content: "mail.conflict.example" }],
				});
			}
			if (path.endsWith("/email/routing/rules") && method === "GET") return Response.json({ success: true, result: [] });
			return Response.json({ success: true, result: {} });
		});
		const setup = await setUpDomain({ token: "t", domain: "a.test.", workerName: "aliasflare" });
		expect(setup.domain).toBe("a.test");
		expect(dnsPageSeen).toBe(2);
		expect(setup.steps.find((s) => s.step === "routing")?.ok).toBe(false);

		// Dashboard oversized POST rejected with 413
		const cookie = await signIn(db);
		const huge = await app.fetch(
			new Request(`${ORIGIN}/blocklist`, {
				method: "POST",
				headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded", "content-length": String(600_000) },
				body: "value=a@b.test",
			}),
			env,
		);
		expect(huge.status).toBe(413);
	});
});
