import PostalMime from "postal-mime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiKey } from "../src/apikeys";
import { calendarOrganizers, rewriteAttachment, scrubAttachedMessage } from "../src/attachments";
import { setUpDomain } from "../src/cloudflare";
import type { AppConfig } from "../src/config";
import { isOwnAddress, isReverseDomainOf } from "../src/domains";
import { cleanDisplayName, cleanSubjectLine, replaceAddresses, sanitizeDisplayName } from "../src/format";
import worker, { app } from "../src/index";
import { createLabel, setAliasLabels, updateLabel } from "../src/labels";
import { getStoredMessage, mailflareConfig } from "../src/mailflare";
import { normalizeOutboundOptions, parseHeaderLines, sendOutbound } from "../src/outbound";
import { completeAuthentication } from "../src/passkeys";
import { clientKey } from "../src/ratelimit";
import { handleReverseAliasMail, stripSignedLinks } from "../src/reply";
import { cleanRule, runRules } from "../src/rules";
import { loadSettings, normalizeSettings, saveSettings } from "../src/settings";
import { sendSmtp, type SmtpConnect, type SmtpSocket } from "../src/smtp";
import { testDb } from "./helpers/d1";
import { signIn, TEST_SECRET } from "./helpers/session";

/** Regressions for audit8 security and code quality review findings. */
let db: D1Database;
let env: Env;
let sent: {
	from: unknown;
	to: unknown;
	subject?: string;
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

const postForm = async (cookie: string, path: string, form: Record<string, string | string[]>) => {
	const body = new URLSearchParams();
	for (const [name, value] of Object.entries(form)) for (const one of [value].flat()) body.append(name, one);
	return app.fetch(
		new Request(`${ORIGIN}${path}`, {
			method: "POST",
			headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
			body,
		}),
		env,
	);
};

describe("1. Multi-forwardTo rule validation & reply owner intersection", () => {
	it("rejects a second unvalidated forwardTo action in dashboard saveRule", async () => {
		const cookie = await signIn(db);
		const res = await postForm(cookie, "/rules", {
			name: "Sneaky",
			operator: "AND",
			cond_type_0: "sender",
			cond_match_0: "contains",
			cond_values_0: "x",
			act_type_0: "forwardTo",
			act_value_0: "me@home.test",
			act_type_1: "forwardTo",
			act_value_1: "attacker@evil.test",
			forwards: "1",
			active: "1",
		});
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toContain("notice.ruleForwardTo");
		expect(await db.prepare("SELECT COUNT(*) AS n FROM rules").first()).toEqual({ n: 0 });
	});

	it("does not grant reply authority to a stale or unvalidated rule forwardTo address", async () => {
		await db.prepare("INSERT INTO contacts (id, alias_address, email, reverse_local, created_at) VALUES ('c1', 'shop@a.test', 'bob@store.test', 'rbob', 1)").run();
		// Even if a rule in D1 holds a stale/external forwardTo address, reply.ts must intersect with known destinations.
		await db
			.prepare(
				"INSERT INTO rules (id, name, position, operator, conditions, actions, forwards, replies, sends, active, created_at, updated_at) VALUES ('rl1', 'Old', 0, 'AND', '[{\"type\":\"alias\",\"match\":\"is exactly\",\"values\":[\"shop@a.test\"]}]', '[{\"type\":\"forwardTo\",\"value\":\"stranger@other.test\"}]', 1, 0, 0, 1, 1, 1)",
			)
			.run();
		const raw =
			"Authentication-Results: mx.cloudflare.net; spf=pass; dmarc=pass header.from=other.test\r\nFrom: stranger@other.test\r\nTo: reply+rbob@r.a.test\r\nSubject: Hi\r\nContent-Type: text/plain\r\n\r\nSpoof\r\n";
		let rejected: string | null = null;
		await handleReverseAliasMail(
			{ to: "reply+rbob@r.a.test", raw: new Response(raw).body, rawSize: raw.length, setReject: (why: string) => void (rejected = why) } as never,
			env,
			{ outboundProvider: "cloudflare", workersPlan: "paid" } as AppConfig,
		);
		expect(rejected).toMatch(/owner/i);
		expect(sent).toHaveLength(0);
	});
});

describe("2. Attachment scrubbing (.eml signed links/base64, folded .ics reverse aliases, calendarOrganizers)", () => {
	it("strips signed links and owner addresses from plain, folded, and base64-encoded .eml attachments", async () => {
		const token = `fw_${"a".repeat(32)}.1799999999.sig_TOKEN`;
		const plainEml = new TextEncoder().encode(
			`From: Owner <me@home.test>\r\nList-Unsubscribe:\r\n <https://alias.test/unsubscribe/${token}>\r\n\r\nDisable: https://alias.test/action/disable~${token}\r\n`,
		).buffer as ArrayBuffer;
		const scrubbedPlain = new TextDecoder().decode(
			rewriteAttachment(plainEml, "message", [{ from: "me@home.test", to: "shop@a.test" }], { stripLinks: stripSignedLinks }),
		);
		expect(scrubbedPlain).not.toContain("me@home.test");
		expect(scrubbedPlain).not.toContain(token);
		expect(scrubbedPlain).toContain("shop@a.test");

		const encodedBody = btoa(`Real owner: me@home.test\nAction: https://alias.test/action/block~${token}`);
		const b64Eml = new TextEncoder().encode(
			`From: me@home.test\r\nTo: reply+rbob@r.a.test\r\nSubject: Fwd\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${encodedBody}\r\n`,
		).buffer as ArrayBuffer;
		const scrubbedB64 = await scrubAttachedMessage(
			b64Eml,
			[
				{ from: "me@home.test", to: "shop@a.test" },
				{ from: "reply+rbob@r.a.test", to: "bob@store.test" },
			],
			stripSignedLinks,
		);
		const parsed = await PostalMime.parse(scrubbedB64);
		expect(parsed.from?.address).toBe("shop@a.test");
		expect(parsed.to?.[0]?.address).toBe("bob@store.test");
		expect(parsed.text).toContain("shop@a.test");
		expect(parsed.text).not.toContain("me@home.test");
		expect(parsed.text).not.toContain(token);
	});

	it("discovers and replaces a reverse alias folded across 75-octet .ics lines on reply", async () => {
		await db.prepare("INSERT INTO contacts (id, alias_address, email, reverse_local, created_at) VALUES ('c1', 'shop@a.test', 'bob@store.test', 'rbob_long_local', 1)").run();
		const ics = [
			"BEGIN:VCALENDAR",
			"METHOD:REPLY",
			"BEGIN:VEVENT",
			"ORGANIZER:mailto:reply+rbob_long_loc\r\n al@r.a.test",
			"ATTENDEE:mailto:me@home.test",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");
		const raw = [
			PASS,
			"From: me@home.test",
			"To: reply+rbob_long_local@r.a.test",
			"Subject: Re: Meeting",
			"MIME-Version: 1.0",
			'Content-Type: multipart/mixed; boundary="b"',
			"",
			"--b",
			"Content-Type: text/plain",
			"",
			"Accepted",
			"--b",
			'Content-Type: text/calendar; name="reply.ics"',
			'Content-Disposition: attachment; filename="reply.ics"',
			"",
			ics,
			"--b--",
			"",
		].join("\r\n");
		let rejected: string | null = null;
		await handleReverseAliasMail(
			{ to: "reply+rbob_long_local@r.a.test", raw: new Response(raw).body, rawSize: raw.length, setReject: (why: string) => void (rejected = why) } as never,
			env,
			{ outboundProvider: "cloudflare", workersPlan: "paid" } as AppConfig,
		);
		expect(rejected).toBeNull();
		const outIcs = new TextDecoder().decode(sent[0]!.attachments![0]!.content);
		expect(outIcs).toContain("mailto:bob@store.test");
		expect(outIcs).toContain("mailto:shop@a.test");
		expect(outIcs).not.toContain("r.a.test");
		expect(outIcs).not.toContain("me@home.test");
	});

	it("validates calendarOrganizers (CRLF, query stripping, bare email) and skips blocklisted/owner organizers", async () => {
		const ics = new TextEncoder().encode(
			"BEGIN:VCALENDAR\r\nORGANIZER:mailto:valid@org.test?subject=hi\r\nORGANIZER:mailto:\"bad\"@evil.test\r\nORGANIZER:mailto:blocked@evil.test\r\nORGANIZER:mailto:me@home.test\r\nEND:VCALENDAR\r\n",
		).buffer as ArrayBuffer;
		expect(calendarOrganizers(ics)).toEqual(["valid@org.test", "blocked@evil.test", "me@home.test"]);

		await db.prepare("INSERT INTO blocklist (id, kind, value, created_at) VALUES ('bl1', 'domain', 'evil.test', 1)").run();
		const raw = [
			"From: sender@ok.test",
			"To: shop@a.test",
			"Subject: Invite",
			"Message-ID: <cal1@ok.test>",
			"MIME-Version: 1.0",
			'Content-Type: multipart/mixed; boundary="b"',
			"",
			"--b",
			"Content-Type: text/plain",
			"",
			"Meet",
			"--b",
			'Content-Type: application/octet-stream; name="invite.vcs"',
			'Content-Disposition: attachment; filename="invite.vcs"',
			"",
			new TextDecoder().decode(ics),
			"--b--",
			"",
		].join("\r\n");
		await worker.email!(
			{ to: "shop@a.test", from: "sender@ok.test", headers: new Headers({ From: "sender@ok.test" }), raw: new Response(raw).body, rawSize: raw.length, forward: async () => {}, setReject: () => {} } as never,
			env,
		);
		const contacts = (await db.prepare("SELECT email FROM contacts ORDER BY email").all<{ email: string }>()).results.map((r) => r.email);
		expect(contacts).toEqual(["sender@ok.test", "valid@org.test"]);
	});
});

describe("3. Forward & reply security: auto-responder loop, >20 From passThrough, sender rule spoofing", () => {
	it("silently drops Auto-Submitted replies without bouncing to prevent auto-responder loops", async () => {
		await db.prepare("INSERT INTO contacts (id, alias_address, email, reverse_local, created_at) VALUES ('c1', 'shop@a.test', 'bob@store.test', 'rbob', 1)").run();
		const raw = `${PASS}\r\nFrom: me@home.test\r\nTo: reply+rbob@r.a.test\r\nAuto-Submitted: auto-replied\r\nSubject: Out of Office\r\nContent-Type: text/plain\r\n\r\nAway\r\n`;
		let rejected: string | null = null;
		await handleReverseAliasMail(
			{ to: "reply+rbob@r.a.test", raw: new Response(raw).body, rawSize: raw.length, setReject: (why: string) => void (rejected = why) } as never,
			env,
			{ outboundProvider: "cloudflare", workersPlan: "paid" } as AppConfig,
		);
		expect(rejected).toBeNull();
		expect(sent).toHaveLength(0);
		expect(await db.prepare("SELECT status, detail FROM events WHERE kind = 'reply'").first()).toEqual({ status: "rejected", detail: "Not sent: automatic reply" });
	});

	it("sends automatic replies when the owner allows it, but never a message aliasflare sent itself", async () => {
		await db.prepare("INSERT INTO contacts (id, alias_address, email, reverse_local, created_at) VALUES ('c1', 'shop@a.test', 'bob@store.test', 'rbob', 1)").run();
		await saveSettings(db, { ...(await loadSettings(db)), sendAutoReplies: true });
		const config = { outboundProvider: "cloudflare", workersPlan: "paid" } as AppConfig;
		const send = async (extra: string) => {
			const raw = `${PASS}\r\nFrom: me@home.test\r\nTo: reply+rbob@r.a.test\r\n${extra}\r\nSubject: Out of Office\r\nContent-Type: text/plain\r\n\r\nAway\r\n`;
			let rejected: string | null = null;
			await handleReverseAliasMail({ to: "reply+rbob@r.a.test", raw: new Response(raw).body, rawSize: raw.length, setReject: (why: string) => void (rejected = why) } as never, env, config);
			return rejected;
		};
		expect(await send("Auto-Submitted: auto-replied")).toBeNull();
		expect(sent).toHaveLength(1);
		expect(await send("X-Aliasflare: shop@a.test")).toBeNull();
		expect(sent).toHaveLength(1);
		expect(await db.prepare("SELECT detail FROM events WHERE kind = 'reply' AND status = 'rejected'").first()).toEqual({ detail: "Not sent: a message aliasflare sent itself" });
	});

	it("skips passThrough messages with >20 From addresses instead of truncating blocklist checks", async () => {
		await saveSettings(db, { ...(await loadSettings(db)), forwardMethod: "direct" });
		const manyFrom = [...Array.from({ length: 20 }, (_, i) => `a${i}@ok.test`), "blocked@evil.test"].join(", ");
		const forwarded: string[] = [];
		const raw = `From: ${manyFrom}\r\nTo: shop@a.test\r\nSubject: Hi\r\nMessage-ID: <m20@ok.test>\r\n\r\nHi\r\n`;
		await worker.email!(
			{ to: "shop@a.test", from: "a0@ok.test", headers: new Headers({ From: manyFrom }), raw: new Response(raw).body, rawSize: raw.length, forward: async (to: string) => void forwarded.push(to), setReject: () => {} } as never,
			env,
		);
		expect(forwarded).toHaveLength(0);
		expect(await db.prepare("SELECT error FROM forwards").first()).toEqual({ error: "too many From addresses" });
	});

	it("blocks spoofed From using envelope sender and prevents spoofed From from triggering positive sender rules", async () => {
		const { key } = await createApiKey(db, "app", "apps");
		const apiCall = (path: string, body: unknown) =>
			app.fetch(new Request(`${ORIGIN}/api${path}`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }), env);
		await apiCall("/v1/rules", { name: "Block Evil", conditions: [{ type: "sender", match: "ends with", values: ["@evil.test"] }], actions: [{ type: "block" }] });
		await apiCall("/v1/rules", { name: "VIP Tag", conditions: [{ type: "sender", match: "is exactly", values: ["vip@trusted.test"] }], actions: [{ type: "displayFrom", value: "Trusted VIP" }] });

		// Attacker uses MAIL FROM attacker@evil.test and spoofs From: vip@trusted.test -> must be blocked!
		const raw1 = "Authentication-Results: mx.cloudflare.net; dmarc=fail header.from=trusted.test\r\nFrom: vip@trusted.test\r\nTo: shop@a.test\r\nSubject: Hi\r\nMessage-ID: <sp1@evil.test>\r\n\r\nBody\r\n";
		await worker.email!(
			{ to: "shop@a.test", from: "attacker@evil.test", headers: new Headers({ From: "vip@trusted.test" }), raw: new Response(raw1).body, rawSize: raw1.length, forward: async () => {}, setReject: () => {} } as never,
			env,
		);
		expect(sent).toHaveLength(0);

		// Attacker uses unblocked MAIL FROM and spoofs From: vip@trusted.test with DMARC fail -> VIP displayFrom must NOT apply!
		const raw2 = "Authentication-Results: mx.cloudflare.net; dmarc=fail header.from=trusted.test\r\nFrom: vip@trusted.test\r\nTo: shop@a.test\r\nSubject: Hi\r\nMessage-ID: <sp2@other.test>\r\n\r\nBody\r\n";
		await worker.email!(
			{ to: "shop@a.test", from: "other@other.test", headers: new Headers({ From: "vip@trusted.test" }), raw: new Response(raw2).body, rawSize: raw2.length, forward: async () => {}, setReject: () => {} } as never,
			env,
		);
		expect(sent).toHaveLength(1);
		expect((sent[0]!.from as { name: string }).name).not.toBe("Trusted VIP");
	});

	it("does not let a bounce address trip a block rule whose negative sender condition the From meets", async () => {
		const { key } = await createApiKey(db, "app", "apps");
		await app.fetch(
			new Request(`${ORIGIN}/api/v1/rules`, {
				method: "POST",
				headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Only work", conditions: [{ type: "sender", match: "does not end with", values: ["@work.test"] }], actions: [{ type: "block" }] }),
			}),
			env,
		);
		const raw = `${PASS.replace("home.test", "work.test")}\r\nFrom: boss@work.test\r\nTo: shop@a.test\r\nSubject: Hi\r\nMessage-ID: <nb1@work.test>\r\n\r\nBody\r\n`;
		await worker.email!(
			{ to: "shop@a.test", from: "bounce-123@mailer.test", headers: new Headers({ From: "boss@work.test" }), raw: new Response(raw).body, rawSize: raw.length, forward: async () => {}, setReject: () => {} } as never,
			env,
		);
		expect(sent).toHaveLength(1);
		const raw2 = `From: someone@other.test\r\nTo: shop@a.test\r\nSubject: Hi\r\nMessage-ID: <nb2@other.test>\r\n\r\nBody\r\n`;
		await worker.email!(
			{ to: "shop@a.test", from: "someone@other.test", headers: new Headers({ From: "someone@other.test" }), raw: new Response(raw2).body, rawSize: raw2.length, forward: async () => {}, setReject: () => {} } as never,
			env,
		);
		expect(sent).toHaveLength(1);
	});
});

describe("4. API authorization (appSettings on rules), bulk efficiency, labels, and MCP", () => {
	it("enforces settings.appSettings on all mutating /v1/rules endpoints", async () => {
		await saveSettings(db, { ...(await loadSettings(db)), appSettings: false });
		const { key } = await createApiKey(db, "app", "apps");
		const req = (path: string, method: string, body?: unknown) =>
			app.fetch(
				new Request(`${ORIGIN}/api${path}`, {
					method,
					headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
					body: body === undefined ? undefined : JSON.stringify(body),
				}),
				env,
			);
		expect((await req("/v1/rules", "POST", { name: "X", conditions: [{ type: "subject", match: "contains", values: ["a"] }], actions: [{ type: "block" }] })).status).toBe(403);
		expect((await req("/v1/rules/rl1", "PATCH", { name: "Y" })).status).toBe(403);
		expect((await req("/v1/rules/rl1", "DELETE")).status).toBe(403);
		expect((await req("/v1/active-rules", "POST", { id: "rl1" })).status).toBe(403);
		expect((await req("/v1/active-rules/rl1", "DELETE")).status).toBe(403);
		expect((await req("/v1/reorder-rules", "POST", { ids: [] })).status).toBe(403);
		// Read-only listing still works.
		expect((await req("/v1/rules", "GET")).status).toBe(200);
	});

	it("handles bulk alias actions in batched D1 calls, rejects invalid custom local_part, normalizes inner slashes, and sets CORS on 429", async () => {
		const { key } = await createApiKey(db, "app", "apps");
		const ids = Array.from({ length: 60 }, (_, i) => `bulk-${i}`);
		await db.batch(
			ids.map((uid, i) =>
				db
					.prepare("INSERT INTO aliases (address, num_id, uid, forward_mode, forward_enabled, created_at, updated_at) VALUES (?, ?, ?, 'all', 1, 1, 1)")
					.bind(`b${i}@a.test`, 100 + i, uid),
			),
		);
		const res = await app.fetch(
			new Request(`${ORIGIN}/api/v1/aliases/deactivate/bulk`, {
				method: "POST",
				headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
				body: JSON.stringify({ ids }),
			}),
			env,
		);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { ids: string[] }).ids).toHaveLength(60);

		// Invalid local_part rejected instead of silently stripped
		const badLocal = await app.fetch(
			new Request(`${ORIGIN}/api/v1/aliases`, {
				method: "POST",
				headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
				body: JSON.stringify({ domain: "  ", format: "custom", local_part: "bad@name" }),
			}),
			env,
		);
		expect(badLocal.status).toBe(422);

		// Inner double slash normalized before routing
		const doubleSlash = await worker.fetch!(
			new Request(`${ORIGIN}/api//v1/app-version`, { headers: { Authorization: `Bearer ${key}` } }),
			env,
			{} as ExecutionContext,
		);
		expect(doubleSlash.status).toBe(200);

		// Rate-limited 429 carries CORS header
		const limitedEnv = { ...env, API_RATE_LIMIT: { limit: async () => ({ success: false }) } } as unknown as Env;
		const throttled = await app.fetch(new Request(`${ORIGIN}/api/v1/app-version`), limitedEnv);
		expect(throttled.status).toBe(429);
		expect(throttled.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});

	it("keeps setAliasLabels atomic per alias, maps updateLabel UNIQUE race, and validates MCP id/local_part", async () => {
		const a = await createLabel(db, { name: "Alpha" });
		const b = await createLabel(db, { name: "Beta" });
		await setAliasLabels(db, ["shop@a.test"], [a.id, b.id, "lb_missing"]);
		const rows = await db.prepare("SELECT label_id FROM alias_labels WHERE alias_address = 'shop@a.test'").all<{ label_id: string }>();
		expect(rows.results.map((r) => r.label_id).sort()).toEqual([a.id, b.id].sort());
		await expect(updateLabel(db, b.id, { name: "alpha" })).rejects.toMatchObject({ reason: "taken" });

		// MCP rejects id: null and empty local_part
		const { key: mcpKey } = await createApiKey(db, "ai", "mcp");
		const nullId = await app.fetch(
			new Request(`${ORIGIN}/mcp`, {
				method: "POST",
				headers: { Authorization: `Bearer ${mcpKey}`, "Content-Type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: null, method: "ping" }),
			}),
			env,
		);
		expect(nullId.status).toBe(400);
		const emptyLocal = await app.fetch(
			new Request(`${ORIGIN}/mcp`, {
				method: "POST",
				headers: { Authorization: `Bearer ${mcpKey}`, "Content-Type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_alias", arguments: { local_part: "   " } } }),
			}),
			env,
		);
		expect(((await emptyLocal.json()) as { result: { isError?: boolean } }).result.isError).toBe(true);
	});
});

describe("5. Outbound redaction, non-JSON 200 error, custom header control chars, Mailflare/SMTP redaction, Cloudflare setup", () => {
	it("redacts Mailgun Basic auth token, Mailflare API key, and SMTP AUTH password from errors", async () => {
		const secret = "super-secret-key-999";
		const basic = btoa(`api:${secret}`);
		vi.stubGlobal("fetch", async () => new Response(`echoed Basic ${basic} and ${secret}`, { status: 401 }));
		await expect(
			sendOutbound(
				env,
				{ outboundProvider: "mailgun", outboundApiKey: secret, outboundOptions: normalizeOutboundOptions({}) } as AppConfig,
				{ from: "shop@a.test", to: "bob@store.test", subject: "Hi", text: "Hi" },
			),
		).rejects.toSatisfy((err: Error) => !err.message.includes(secret) && !err.message.includes(basic));

		// Mailflare error redacts API key
		vi.stubGlobal("fetch", async () => new Response(`bad token Bearer ${secret}`, { status: 500 }));
		await expect(getStoredMessage(mailflareConfig({ mailflareUrl: "https://mailflare.test", mailflareApiKey: secret } as AppConfig), "m1")).rejects.toSatisfy(
			(err: Error) => !err.message.includes(secret),
		);

		// SMTP AUTH error redacts password and base64 token
		const authB64 = btoa(`\0user\0${secret}`);
		const fakeConnect: SmtpConnect = () => {
			let push!: (t: string) => void;
			const readable = new ReadableStream<Uint8Array>({ start: (c) => void (push = (t) => c.enqueue(new TextEncoder().encode(t))) });
			let pending = "";
			const writable = new WritableStream<Uint8Array>({
				write(chunk) {
					pending += new TextDecoder().decode(chunk);
					for (let end = pending.indexOf("\r\n"); end >= 0; end = pending.indexOf("\r\n")) {
						const line = pending.slice(0, end);
						pending = pending.slice(end + 2);
						if (line.startsWith("EHLO")) push("250 AUTH PLAIN\r\n");
						else if (line.startsWith("AUTH")) push(`535 failed for ${authB64} (${secret})\r\n`);
					}
				},
			});
			queueMicrotask(() => push("220 ready\r\n"));
			return { readable, writable, close: async () => {} } as SmtpSocket;
		};
		await expect(
			sendSmtp({ host: "smtp.test", port: 465, security: "tls", username: "user", password: secret }, { from: "a@a.test", to: "b@b.test" }, "Subject: x\r\n\r\nhi", fakeConnect),
		).rejects.toSatisfy((err: Error) => !err.message.includes(secret) && !err.message.includes(authB64));
	});

	it("accepts a 2xx non-JSON answer (but not where 200 can mean unsent), rejects control chars in customHeaders, and rejects invalid mailbabyOrderId on /connection", async () => {
		vi.stubGlobal("fetch", async () => new Response("<html>accepted</html>", { status: 200 }));
		// The provider accepted it: bouncing would make the owner send it twice.
		await expect(
			sendOutbound(
				env,
				{ outboundProvider: "resend", outboundApiKey: "re_123456", outboundOptions: normalizeOutboundOptions({}) } as AppConfig,
				{ from: "shop@a.test", to: "bob@store.test", subject: "Hi", text: "Hi" },
			),
		).resolves.toEqual({ messageId: undefined });
		// Mail.baby's 200 carries a status: without it the message is not taken as sent.
		await expect(
			sendOutbound(
				env,
				{ outboundProvider: "mailbaby", outboundApiKey: "mb_123456", outboundOptions: normalizeOutboundOptions({}) } as AppConfig,
				{ from: "shop@a.test", to: "bob@store.test", subject: "Hi", text: "Hi" },
			),
		).rejects.toThrow(/Mail\.baby did not send/);

		expect(() => parseHeaderLines("X-Test: ok\rvalue")).toThrow(/control characters/i);
		expect(normalizeOutboundOptions({ mailbabyOrderId: "0" }).mailbabyOrderId).toBe("");

		const cookie = await signIn(db);
		const badOrder = await postForm(cookie, "/connection", { outboundProvider: "mailbaby", mailbabyOrderId: "not-a-number" });
		expect(badOrder.headers.get("location")).toContain("notice.badProvider");
	});

	it("checks subdomain DNS in enableRouting and refuses to overwrite an existing reply@r.<domain> rule pointing elsewhere", async () => {
		vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
			const parsed = new URL(url);
			const path = parsed.pathname.replace("/client/v4", "");
			const method = init.method ?? "GET";
			const ok = (result: unknown) => Response.json({ success: true, result });
			if (path === "/zones") return ok([{ id: "z1", name: "a.test" }]);
			if (path.endsWith("/email/routing/dns") && method === "POST" && init.body) {
				return Response.json({ success: false, errors: [{ code: 1001, message: "MX record already exists" }] }, { status: 409 });
			}
			if (path.endsWith("/dns_records") && method === "GET" && parsed.searchParams.get("name") === "r.a.test") {
				// Conflicting non-Cloudflare MX record on subdomain
				return ok([{ type: "MX", content: "route1.mx.cloudflare.net" }, { type: "MX", content: "mail.other.example" }]);
			}
			if (path.endsWith("/email/routing/rules") && method === "GET") {
				return ok([{ id: "r1", enabled: true, matchers: [{ type: "literal", field: "to", value: "reply@r.a.test" }], actions: [{ type: "worker", value: ["other-worker"] }] }]);
			}
			return ok({});
		});
		const { steps } = await setUpDomain({ token: "t", domain: "a.test", workerName: "aliasflare" });
		expect(steps.find((s) => s.step === "routing")?.ok).toBe(false);
		expect(steps.find((s) => s.step === "rule")?.ok).toBe(false);
	});
});

describe("6. Hardening & code quality (domains, settings, ratelimit, passkeys, rules, format)", () => {
	it("normalizes mixed-case domains, non-canonical IPv4-mapped IPv6, invalid rule operators, and reply-only rule counts", async () => {
		expect(isOwnAddress("x@a.test", ["A.TEST"])).toBe(true);
		expect(isReverseDomainOf("r.a.test", ["A.TEST"])).toBe(true);
		expect(clientKey("0:0::ffff:192.0.2.1")).toBe("192.0.2.1");
		expect(clientKey("::0:ffff:c000:0201")).toBe("192.0.2.1");
		expect(normalizeSettings({ defaultDestination: "not-an-email" }).defaultDestination).toBe("");
		expect(normalizeSettings({ defaultDestination: "Me <me@home.test>" }).defaultDestination).toBe("me@home.test");
		expect(() => cleanRule({ name: "BadOp", operator: "XOR", conditions: [{ type: "subject", match: "contains", values: ["x"] }], actions: [{ type: "block" }] })).toThrow(/invalid/);

		// Reply rule with only forward-only action must not increment applied count
		await db
			.prepare(
				"INSERT INTO rules (id, name, position, operator, conditions, actions, forwards, replies, sends, active, created_at, updated_at) VALUES ('rl_only_fw', 'FwdOnly', 0, 'AND', '[{\"type\":\"subject\",\"match\":\"contains\",\"values\":[\"hi\"]}]', '[{\"type\":\"displayFrom\",\"value\":\"Name\"}]', 1, 1, 0, 1, 1, 1)",
			)
			.run();
		const outcome = await runRules(db, "replies", { sender: "bob@store.test", subject: "  hi \r\n", alias: "shop@a.test" });
		expect(outcome.applied).toEqual([]);

		// completeAuthentication returns null cleanly when response.id is missing
		await db.prepare("INSERT INTO auth_challenges (id, purpose, challenge, expires_at) VALUES ('ch1', 'login', 'abc', 9999999999)").run();
		expect(await completeAuthentication(db, { rpID: "alias.test", origin: ORIGIN }, "ch1", {} as never)).toBeNull();

		// format.ts single-pass replaceAddresses, subject cap, and surrogate safety
		expect(replaceAddresses("Reply to reply%2Babc%40r.a.test and me@home.test", [{ from: "reply+abc@r.a.test", to: "bob@store.test" }, { from: "me@home.test", to: "shop@a.test" }], { encodedPlus: true })).toBe(
			"Reply to bob@store.test and shop@a.test",
		);
		expect(cleanSubjectLine("a".repeat(1200)).length).toBe(998);
		expect(sanitizeDisplayName(`${"a".repeat(119)}\uD83D\uDE00`).length).toBe(119);
		expect(cleanDisplayName(`${"a".repeat(99)}\uD83D\uDE00`, 100)?.length).toBe(99);
	});
});
