import * as openpgp from "openpgp";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiKey } from "../src/apikeys";
import { forgetAliases } from "../src/compat/aliases";
import { saveConfig } from "../src/config";
import { ensureAlias } from "../src/db";
import { isInlinePgpArmor, isPromotional } from "../src/forward";
import { isErrorNoticeKey } from "../src/i18n";
import { importAddyExtras } from "../src/importer";
import worker, { app } from "../src/index";
import { buildMime, pgpKind, topEntity } from "../src/mime";
import { handleReverseAliasMail } from "../src/reply";
import { callWebhooks } from "../src/rules";
import { loadSettings, saveSettings } from "../src/settings";
import { sendSmtp, type SmtpSocket } from "../src/smtp";
import { readWkdKey, wkdHash } from "../src/wkd";
import { testDb } from "./helpers/d1";
import { EmailMessage } from "./helpers/email";
import { signIn, TEST_SECRET } from "./helpers/session";

/** Regressions for audit13 code & security review findings. */
const ORIGIN = "https://alias.test";
const PASS = "Authentication-Results: mx.cloudflare.net; spf=pass; dmarc=pass header.from=home.test";
const rawOf = async (message: EmailMessage) => (typeof message.raw === "string" ? message.raw : await new Response(message.raw).text());

let publicKey: string;

beforeAll(async () => {
	({ publicKey } = await openpgp.generateKey({ type: "curve25519", userIDs: [{ email: "me@home.test" }], format: "armored" }));
});

afterEach(() => vi.unstubAllGlobals());

describe("1. PGP encryption cannot be bypassed by spoofed armor, duplicate Content-Type, or fake multipart/encrypted", () => {
	let db: D1Database;
	let env: Env;
	let sent: unknown[];
	let cookie: string;

	const post = (path: string, form: Record<string, string>) =>
		app.fetch(
			new Request(`${ORIGIN}${path}`, {
				method: "POST",
				headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams(form),
			}),
			env,
		);

	async function deliverRaw(to: string, raw: string, contentType = "text/plain") {
		const message = {
			to,
			from: "bob@store.test",
			headers: new Headers({ "Content-Type": contentType }),
			raw: new Response(raw).body,
			rawSize: raw.length,
			setReject: () => undefined,
			forward: async () => undefined,
		};
		await worker.email!(message as never, env);
	}

	beforeEach(async () => {
		db = testDb();
		sent = [];
		env = {
			DB: db,
			SIGNING_SECRET: TEST_SECRET,
			EMAIL: { send: async (message: unknown) => (sent.push(message), { messageId: `<s${sent.length}@test>` }) },
		} as unknown as Env;
		await saveSettings(db, { ...(await loadSettings(db)), aliasDomains: ["a.test"], defaultDestination: "me@home.test" });
		await saveConfig(db, { siteOrigin: ORIGIN });
		cookie = await signIn(db);
		await post("/encryption", { email: "me@home.test", key: publicKey });
		await post("/encryption/me%40home.test/encrypt", { on: "1" });
	});

	it("rejects two armor blocks sandwiching plaintext and non-PGP words inside armor markers", async () => {
		const sandwiched = [
			"-----BEGIN PGP MESSAGE-----",
			"",
			"wV4DAAAAAAAAAAASAQdAexample",
			"=abcd",
			"-----END PGP MESSAGE-----",
			"",
			"SECRET PLAINTEXT IN THE MIDDLE",
			"",
			"-----BEGIN PGP MESSAGE-----",
			"",
			"wV4DAAAAAAAAAAASAQdAexample",
			"=abcd",
			"-----END PGP MESSAGE-----",
		].join("\r\n");
		const plainWord = "-----BEGIN PGP MESSAGE-----\r\n\r\nCONFIDENTIAL\r\n-----END PGP MESSAGE-----";
		expect(isInlinePgpArmor(sandwiched)).toBe(false);
		expect(isInlinePgpArmor(plainWord)).toBe(false);
		// Genuine armor still counts, with the headers real clients add (Mailvelope writes a Comment).
		const genuine = ["-----BEGIN PGP MESSAGE-----", "Version: Mailvelope v5", "Comment: https://www.mailvelope.com", "", "wV4DAAAAAAAAAAASAQdAexample", "=abcd", "-----END PGP MESSAGE-----"];
		expect(isInlinePgpArmor(genuine.join("\r\n"))).toBe(true);
		expect(isInlinePgpArmor(genuine.filter((line) => !/^(Version|Comment):/.test(line)).join("\n"))).toBe(true);

		await deliverRaw("shop@a.test", `From: bob@store.test\r\nTo: shop@a.test\r\nSubject: Sandwich\r\nMessage-ID: <s1@x>\r\nContent-Type: text/plain\r\n\r\n${sandwiched}`);
		const out1 = await rawOf(sent[0] as EmailMessage);
		expect(sent[0]).toBeInstanceOf(EmailMessage);
		expect(out1).toContain("multipart/encrypted");
		expect(out1).not.toContain("SECRET PLAINTEXT");

		await deliverRaw("shop@a.test", `From: bob@store.test\r\nTo: shop@a.test\r\nSubject: Word\r\nMessage-ID: <s2@x>\r\nContent-Type: text/plain\r\n\r\n${plainWord}`);
		const out2 = await rawOf(sent[1] as EmailMessage);
		expect(sent[1]).toBeInstanceOf(EmailMessage);
		expect(out2).toContain("multipart/encrypted");
		expect(out2).not.toContain("CONFIDENTIAL");
	});

	it("rejects duplicate Content-Type headers, non-protocol params, and bare CR injection in pgpKind/topEntity", async () => {
		expect(pgpKind('Content-Type: multipart/encrypted; x-protocol="application/pgp-encrypted"; boundary="b1"')).toBeNull();
		expect(pgpKind('Content-Type: multipart/encrypted; protocol="application/pgp-encrypted-evil"; boundary="b1"')).toBeNull();
		expect(pgpKind('Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b1", text/html')).toBeNull();
		expect(
			pgpKind('Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b1"\r\nContent-Type: text/html'),
		).toBeNull();

		const bareCr = new TextEncoder().encode('Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b1"\rX-Injected: yes\r\n\r\nbody').buffer as ArrayBuffer;
		expect(topEntity(bareCr)).toBeNull();

		// Duplicate Content-Type smuggling must NOT skip encryption.
		const smuggled = [
			"From: bob@store.test",
			"To: shop@a.test",
			"Subject: Smuggled",
			"Message-ID: <smug@x>",
			'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b1"',
			"Content-Type: text/html; charset=utf-8",
			"",
			"<p>CONFIDENTIAL HTML</p>",
		].join("\r\n");
		await deliverRaw("shop@a.test", smuggled);
		const out = await rawOf(sent[0] as EmailMessage);
		expect(sent[0]).toBeInstanceOf(EmailMessage);
		expect(out).toContain("multipart/encrypted");
		expect(out).not.toContain("CONFIDENTIAL HTML");
	});

	it("encrypts a spoofed multipart/encrypted message whose parts are actually plaintext", async () => {
		const fakeEncrypted = [
			"From: bob@store.test",
			"To: shop@a.test",
			"Subject: Fake PGP",
			"Message-ID: <fake@x>",
			"MIME-Version: 1.0",
			'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b1"',
			"",
			"--b1",
			"Content-Type: text/html; charset=utf-8",
			"",
			"<p>UNENCRYPTED SECRET</p>",
			"--b1--",
		].join("\r\n");
		await deliverRaw("shop@a.test", fakeEncrypted, 'multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b1"');
		const out = await rawOf(sent[0] as EmailMessage);
		expect(sent[0]).toBeInstanceOf(EmailMessage);
		expect(out).toContain("multipart/encrypted");
		expect(out).not.toContain("UNENCRYPTED SECRET");
	});
});

describe("2. Outbound replies scrub owner domain/address from top-level Content-ID, filename, and subject", () => {
	it("rewrites leaking inline Content-ID (and matching cid: in HTML), attachment filename, and subject", async () => {
		const db = testDb();
		const sent: {
			subject?: string;
			html?: string;
			attachments?: { filename: string; contentId?: string; disposition: string }[];
		}[] = [];
		const env = {
			DB: db,
			SIGNING_SECRET: TEST_SECRET,
			EMAIL: { send: async (message: (typeof sent)[number]) => (sent.push(message), { messageId: "<s@test>" }) },
		} as unknown as Env;
		await saveSettings(db, { ...(await loadSettings(db)), aliasDomains: ["a.test"], defaultDestination: "me@home.test" });
		await saveConfig(db, { siteOrigin: ORIGIN, workersPlan: "paid" });
		await db
			.prepare("INSERT INTO aliases (address, num_id, uid, forward_mode, forward_enabled, created_at, updated_at) VALUES ('shop@a.test', 1, 'u1', 'all', 1, 1, 1)")
			.run();
		await db
			.prepare("INSERT INTO contacts (id, alias_address, email, reverse_local, created_at) VALUES ('c1', 'shop@a.test', 'them@example.com', 'ra_abc', 1)")
			.run();

		const rawMime = buildMime(
			{
				from: "me@home.test",
				to: "reply+ra_abc@r.a.test",
				subject: "Re: reply+ra_abc@r.a.test from me@home.test",
				html: '<p>See image: <img src="cid:part1.img@home.test"></p>',
				text: "See image",
				headers: { "Authentication-Results": PASS.replace(/^Authentication-Results:\s*/, "") },
				attachments: [
					{
						disposition: "inline",
						contentId: "part1.img@home.test",
						filename: "me@home.test_screenshot.png",
						type: "image/png",
						content: new Uint8Array([1, 2, 3]).buffer as ArrayBuffer,
					},
				],
			},
			"<reply@home.test>",
			new Date(0),
		);
		const rawBytes = new TextEncoder().encode(rawMime);
		const message = {
			from: "me@home.test",
			to: "reply+ra_abc@r.a.test",
			rawSize: rawBytes.byteLength,
			raw: new ReadableStream({ start(c) { c.enqueue(rawBytes); c.close(); } }),
			setReject: () => undefined,
		} as unknown as ForwardableEmailMessage;

		await handleReverseAliasMail(message, env, { ...(await (await import("../src/config")).loadConfig(env)), workersPlan: "paid" });
		expect(sent).toHaveLength(1);
		const reply = sent[0]!;
		expect(reply.subject).not.toContain("home.test");
		expect(reply.subject).not.toContain("ra_abc");
		expect(reply.subject).toContain("shop@a.test");
		expect(reply.subject).toContain("them@example.com");
		const img = reply.attachments![0]!;
		expect(img.filename).not.toContain("home.test");
		expect(img.contentId).toBeDefined();
		expect(img.contentId).not.toContain("home.test");
		expect(img.contentId).toMatch(/@invalid$/);
		expect(reply.html).not.toContain("home.test");
		expect(reply.html).toContain(`cid:${img.contentId}`);
	});
});

describe("3. WKD rejects keys hiding another address in the User ID and isolates openpgpkey.<domain> routes", () => {
	it("refuses a WKD key whose User ID contains a second email address before <alias>", async () => {
		const multiAngle = (
			await openpgp.generateKey({
				type: "curve25519",
				userIDs: [{ name: "Alice <me@home.test>", email: "shop@a.test" }],
				format: "armored",
			})
		).publicKey;
		const inName = (
			await openpgp.generateKey({
				type: "curve25519",
				userIDs: [{ name: "me@home.test", email: "shop@a.test" }],
				format: "armored",
			})
		).publicKey;
		await expect(readWkdKey(multiAngle, "shop@a.test")).rejects.toMatchObject({ reason: "otherAddress" });
		await expect(readWkdKey(inName, "shop@a.test")).rejects.toMatchObject({ reason: "otherAddress" });
	});

	it("returns 404 for non-WKD routes on openpgpkey.<aliasDomain>", async () => {
		const db = testDb();
		const env = { DB: db, SIGNING_SECRET: TEST_SECRET } as unknown as Env;
		await saveSettings(db, { ...(await loadSettings(db)), aliasDomains: ["a.test"], defaultDestination: "me@home.test", addyApi: true });
		await saveConfig(db, { publicUrl: ORIGIN });
		await ensureAlias(db, "shop@a.test", "", { forwardEnabled: true });

		for (const path of ["/health", "/login", "/setup", "/api/v1/app-version", "/mcp", "/webhook"]) {
			const res = await app.fetch(new Request(`https://openpgpkey.a.test${path}`), env);
			expect({ path, status: res.status }).toEqual({ path, status: 404 });
		}
		// WKD endpoints on openpgpkey.a.test still work normally.
		expect((await app.fetch(new Request("https://openpgpkey.a.test/.well-known/openpgpkey/a.test/policy"), env)).status).toBe(200);
		expect((await app.fetch(new Request(`https://openpgpkey.a.test/.well-known/openpgpkey/a.test/hu/${await wkdHash("shop@a.test")}`), env)).status).toBe(404);
	});
});

describe("4. Rule webhooks block own hosts on import and re-validate at runtime", () => {
	it("skips imported addy.io webhook rules targeting own hosts", async () => {
		const db = testDb();
		const res = await importAddyExtras(
			db,
			{
				labels: [],
				blocklist: [],
				unread: [],
				rules: [
					{
						name: "Self hook",
						conditions: [{ type: "sender", match: "contains", values: ["a"] }],
						actions: [{ type: "webhook", value: "https://dash.example.com/webhook" }],
					},
				],
			},
			[],
			{ ownHosts: ["dash.example.com"] },
		);
		expect(res.rules).toBe(0);
		expect(res.rulesSkipped).toEqual(["Self hook"]);
	});

	it("skips disallowed or own-host webhook URLs at runtime in callWebhooks", async () => {
		const calls: string[] = [];
		vi.stubGlobal("fetch", async (url: string) => (calls.push(url), new Response("ok")));
		await callWebhooks(
			TEST_SECRET,
			[
				{ rule: "Self", url: "https://dash.example.com/webhook" },
				{ rule: "Loopback", url: "https://127.0.0.1/hook" },
				{ rule: "Public", url: "https://hooks.example.com/ok" },
			],
			{ alias: "a@a.test", sender: "b@b.test", subject: "s" },
			["dash.example.com"],
		);
		expect(calls).toEqual(["https://hooks.example.com/ok"]);
	});

	it("blocks creating a webhook rule targeting the current request host via API", async () => {
		const db = testDb();
		const env = { DB: db, SIGNING_SECRET: TEST_SECRET } as unknown as Env;
		await saveSettings(db, { ...(await loadSettings(db)), addyApi: true, aliasDomains: ["a.test"], defaultDestination: "me@home.test" });
		const { key } = await createApiKey(db, "app", "apps");
		const res = await app.fetch(
			new Request("https://dash.example.com/api/v1/rules", {
				method: "POST",
				headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "Loop",
					conditions: [{ type: "sender", match: "contains", values: ["x"] }],
					actions: [{ type: "webhook", value: "https://dash.example.com/webhook" }],
				}),
			}),
			env,
		);
		expect(res.status).toBe(422);
	});
});

describe("5. Code quality & hardening fixes", () => {
	it("marks notice.ruleWebhook and notice.reauth as error notices", () => {
		expect(isErrorNoticeKey("notice.ruleWebhook")).toBe(true);
		expect(isErrorNoticeKey("notice.reauth")).toBe(true);
	});

	it("detects promotional Precedence when Headers joined duplicate headers", () => {
		expect(isPromotional([{ key: "precedence", value: "bulk, normal" }])).toBe(true);
		expect(isPromotional([{ key: "precedence", value: "normal, list" }])).toBe(true);
		expect(isPromotional([{ key: "precedence", value: "normal" }])).toBe(false);
	});

	it("preserves request.cf when collapsing double slashes in fetch()", async () => {
		const db = testDb();
		const env = { DB: db, SIGNING_SECRET: TEST_SECRET } as unknown as Env;
		await saveSettings(db, { ...(await loadSettings(db)), addyApi: true, aliasDomains: ["a.test"], defaultDestination: "me@home.test" });
		const { key, row } = await createApiKey(db, "phone", "apps");
		const req = new Request(`${ORIGIN}//api//v1/domain-options`, { headers: { Authorization: `Bearer ${key}` } });
		Object.defineProperty(req, "cf", { value: { country: "TW" } });
		const res = await worker.fetch!(req as never, env, {} as ExecutionContext);
		expect(res.status).toBe(200);
		const stored = await db.prepare("SELECT last_used_country FROM api_keys WHERE id = ?").bind(row.id).first<{ last_used_country: string | null }>();
		expect(stored?.last_used_country).toBe("TW");
	});

	it("batches forgetAliases within 100 statements per D1 batch", async () => {
		const db = testDb();
		const batchSizes: number[] = [];
		const origBatch = db.batch.bind(db);
		db.batch = (async (statements: D1PreparedStatement[]) => {
			batchSizes.push(statements.length);
			return origBatch(statements);
		}) as typeof db.batch;
		const addresses: string[] = [];
		for (let i = 0; i < 20; i += 1) {
			const addr = `a${i}@a.test`;
			addresses.push(addr);
			await ensureAlias(db, addr, "", { forwardEnabled: true });
		}
		await forgetAliases(db, addresses);
		expect(batchSizes.every((size) => size <= 100)).toBe(true);
		expect(Number((await db.prepare("SELECT COUNT(*) AS n FROM aliases").first<{ n: number }>())?.n)).toBe(0);
	});

	it("rejects pipelined plaintext data received after 220 STARTTLS (RFC 3207)", async () => {
		const replies = ["220 smtp.example.com ESMTP\r\n", "250-smtp.example.com\r\n250 STARTTLS\r\n", "220 Ready\r\n250 INJECTED\r\n"];
		let idx = 0;
		const socket: SmtpSocket = {
			readable: new ReadableStream({
				pull(controller) {
					if (idx < replies.length) controller.enqueue(new TextEncoder().encode(replies[idx++]!));
					else controller.close();
				},
			}),
			writable: new WritableStream(),
			startTls: () => socket,
			close: async () => undefined,
		};
		await expect(
			sendSmtp(
				{ host: "smtp.example.com", port: 587, security: "starttls", username: "", password: "" },
				{ from: "a@a.test", to: "b@b.test" },
				"Subject: Hi\r\n\r\nBody",
				() => socket,
			),
		).rejects.toThrow(/Unexpected data received before STARTTLS/);
	});

	it("creates no calendar organizer contacts when forwarding a kept PGP/MIME message", async () => {
		const db = testDb();
		const sent: unknown[] = [];
		const env = {
			DB: db,
			SIGNING_SECRET: TEST_SECRET,
			EMAIL: { send: async (message: unknown) => (sent.push(message), { messageId: "<s@test>" }) },
		} as unknown as Env;
		await saveSettings(db, { ...(await loadSettings(db)), aliasDomains: ["a.test"], defaultDestination: "me@home.test" });
		await saveConfig(db, { siteOrigin: ORIGIN });
		const signed = [
			"From: bob@store.test",
			"To: shop@a.test",
			"Subject: Signed invite",
			"Message-ID: <sigcal@x>",
			"MIME-Version: 1.0",
			'Content-Type: multipart/signed; protocol="application/pgp-signature"; boundary="s1"',
			"",
			"--s1",
			"Content-Type: text/calendar",
			"",
			"BEGIN:VCALENDAR\r\nORGANIZER:mailto:org@external.test\r\nEND:VCALENDAR",
			"--s1",
			"Content-Type: application/pgp-signature",
			"",
			"-----BEGIN PGP SIGNATURE-----\r\n\r\nsig\r\n-----END PGP SIGNATURE-----",
			"--s1--",
		].join("\r\n");
		const message = {
			to: "shop@a.test",
			from: "bob@store.test",
			headers: new Headers({ "Content-Type": 'multipart/signed; protocol="application/pgp-signature"; boundary="s1"' }),
			raw: new Response(signed).body,
			rawSize: signed.length,
			setReject: () => undefined,
		};
		await worker.email!(message as never, env);
		expect(sent).toHaveLength(1);
		const contacts = await db.prepare("SELECT email FROM contacts").all<{ email: string }>();
		expect(contacts.results.map((r) => r.email)).toEqual(["bob@store.test"]);
	});
});
