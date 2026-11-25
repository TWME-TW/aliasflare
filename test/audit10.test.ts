import PostalMime from "postal-mime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { attachmentSearchText, MAX_NESTED_ATTACHMENTS, MAX_NESTED_EML_PARSES, rewriteAttachment, scrubAttachedMessage } from "../src/attachments";
import { loadConfig, saveConfig, type AppConfig } from "../src/config";
import { app } from "../src/index";
import { mailflareConfig, MailflareError } from "../src/mailflare";
import { buildMime } from "../src/mime";
import { handleReverseAliasMail, stripSignedLinks } from "../src/reply";
import { createRule, runRules } from "../src/rules";
import { loadSettings, saveSettings } from "../src/settings";
import { testDb } from "./helpers/d1";
import { signIn, TEST_SECRET } from "./helpers/session";

/** Regressions for audit10 security review findings. */
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

const toArrayBuffer = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

beforeEach(async () => {
	db = testDb();
	sent = [];
	env = {
		DB: db,
		SIGNING_SECRET: TEST_SECRET,
		EMAIL: { send: async (message: (typeof sent)[number]) => (sent.push(message), { messageId: `<s${sent.length}@test>` }) },
	} as unknown as Env;
	await saveSettings(db, { ...(await loadSettings(db)), aliasDomains: ["a.test"], defaultDestination: "me@home.test" });
	await db.prepare("INSERT INTO config (key, value) VALUES ('siteOrigin', ?)").bind(ORIGIN).run();
	await db.prepare("INSERT INTO aliases (address, num_id, uid, forward_mode, forward_enabled, created_at, updated_at) VALUES ('shop@a.test', 1, 'u1', 'all', 1, 1, 1)").run();
});

describe("1. Linear-time stripSignedLinks against repeated scheme-less tokens", () => {
	it("handles thousands of contiguous scheme-less signed-path tokens in linear time", () => {
		const token = `/action/fw_${"a".repeat(32)}.1.sig`;
		const body = token.repeat(4000);
		const start = performance.now();
		const out = stripSignedLinks(body);
		const elapsedMs = performance.now() - start;
		expect(out).not.toContain("fw_");
		expect(elapsedMs).toBeLessThan(500);
	});

	it("still strips an https URL that follows a scheme-less signed path", () => {
		const bare = `/action/fw_${"a".repeat(32)}.1.sig1`;
		const full = `https://alias.test/unsubscribe/fw_${"b".repeat(32)}.1.sig2`;
		const out = stripSignedLinks(`prefix${bare},${full} end`);
		expect(out).toBe("prefix/action/[link removed],[link removed] end");
	});
});

describe("2. Bounded nested .eml parsing and early reply attachment limit enforcement", () => {
	it("leaves room for every attached message a reply may carry", () => {
		// A reply holds at most 50 attachments; each attached message costs one parse.
		expect(MAX_NESTED_EML_PARSES).toBeGreaterThan(50);
	});

	it("bounds total PostalMime parses across wide nested .eml attachments", async () => {
		const leafEml = toArrayBuffer("From: leak@home.test\r\nTo: other@example.com\r\nSubject: Leaf\r\n\r\nBody me@home.test");
		// A small budget, well under the 32-part width cap, so it runs out on width alone.
		const budgetSize = 8;
		const nestedCount = budgetSize + 6;
		const outerRaw = buildMime(
			{
				from: "sender@example.com",
				to: "shop@a.test",
				subject: "Outer",
				text: "Outer body",
				attachments: Array.from({ length: nestedCount }, (_, i) => ({
					disposition: "attachment" as const,
					filename: `nested-${i}.eml`,
					type: "message/rfc822",
					content: leafEml,
				})),
			},
			"<outer@example.com>",
			new Date(0),
		);
		const parseSpy = vi.spyOn(PostalMime, "parse");
		try {
			const searchBudget = { remaining: budgetSize };
			await attachmentSearchText(toArrayBuffer(outerRaw), "message", 0, searchBudget);
			expect(searchBudget.remaining).toBe(0);
			expect(parseSpy.mock.calls.length).toBeLessThanOrEqual(budgetSize);

			parseSpy.mockClear();
			const scrubBudget = { remaining: budgetSize };
			const scrubbed = await scrubAttachedMessage(toArrayBuffer(outerRaw), [{ from: "me@home.test", to: "shop@a.test" }], stripSignedLinks, { budget: scrubBudget });
			expect(scrubBudget.remaining).toBe(0);
			expect(parseSpy.mock.calls.length).toBeLessThanOrEqual(budgetSize);

			// Inner messages past the budget must be replaced by safe stubs, never leaked raw.
			const rebuilt = await PostalMime.parse(scrubbed, { attachmentEncoding: "arraybuffer" });
			const stubbed = rebuilt.attachments.slice(budgetSize - 1);
			expect(stubbed.length).toBeGreaterThan(0);
			for (const part of stubbed) {
				const parsedStub = await PostalMime.parse(part.content as ArrayBuffer);
				expect(parsedStub.subject).toBe("[attached message removed]");
				expect(parsedStub.text).not.toContain("me@home.test");
				expect(parsedStub.text).toContain("Nested attached message removed for privacy.");
			}
		} finally {
			parseSpy.mockRestore();
		}
	});

	it("stubs an attached .eml with more than MAX_NESTED_ATTACHMENTS inner parts", async () => {
		const dummy = toArrayBuffer("x");
		const outerRaw = buildMime(
			{
				from: "sender@example.com",
				to: "shop@a.test",
				subject: "Too many",
				text: "Body me@home.test",
				attachments: Array.from({ length: MAX_NESTED_ATTACHMENTS + 1 }, (_, i) => ({
					disposition: "attachment" as const,
					filename: `f-${i}.txt`,
					type: "text/plain",
					content: dummy,
				})),
			},
			"<many@example.com>",
			new Date(0),
		);
		const scrubbed = await scrubAttachedMessage(toArrayBuffer(outerRaw), [{ from: "me@home.test", to: "shop@a.test" }], stripSignedLinks);
		const parsedStub = await PostalMime.parse(scrubbed);
		expect(parsedStub.subject).toBe("[attached message removed]");
		expect(parsedStub.text).toContain("too many attachments");
		expect(parsedStub.text).not.toContain("me@home.test");
	});

	it("rejects replies exceeding the attachment limit before parsing nested attachments", async () => {
		await db
			.prepare("INSERT INTO contacts (id, alias_address, email, reverse_local, created_at) VALUES ('c1', 'shop@a.test', 'them@example.com', 'ra_abc', 1)")
			.run();
		await saveConfig(db, { outboundProvider: "resend", outboundApiKey: "re_test_key" });
		const config: AppConfig = { ...(await loadConfig(env)), outboundProvider: "resend", workersPlan: "paid" };
		const leafEml = toArrayBuffer("From: a@b.test\r\nTo: c@d.test\r\nSubject: s\r\n\r\nhi");
		// Resend limit is 50; build 51 attachments.
		const rawMime = buildMime(
			{
				from: "me@home.test",
				to: "reply+ra_abc@r.a.test",
				subject: "Re: many",
				text: "hi",
				headers: { "Authentication-Results": PASS.replace(/^Authentication-Results:\s*/, "") },
				attachments: Array.from({ length: 51 }, (_, i) => ({
					disposition: "attachment" as const,
					filename: `part-${i}.eml`,
					type: "message/rfc822",
					content: leafEml,
				})),
			},
			"<reply@home.test>",
			new Date(0),
		);
		const rawBytes = new TextEncoder().encode(rawMime);
		const parseSpy = vi.spyOn(PostalMime, "parse");
		const rejected: string[] = [];
		const message = {
			from: "me@home.test",
			to: "reply+ra_abc@r.a.test",
			rawSize: rawBytes.byteLength,
			raw: new ReadableStream({ start(c) { c.enqueue(rawBytes); c.close(); } }),
			setReject: (reason: string) => rejected.push(reason),
		} as unknown as ForwardableEmailMessage;

		try {
			await handleReverseAliasMail(message, env, config);
			expect(rejected[0]).toMatch(/Too many attachments/);
			// Only the header-only check + top-level parse should have run (2 calls), never the 51 nested .eml attachments.
			expect(parseSpy.mock.calls.length).toBe(2);
		} finally {
			parseSpy.mockRestore();
		}
	});
});

describe("3. Percent-encoded and HTML-entity address scrubbing in calendar attachments", () => {
	it("rewrites %40, %2B, and entity-encoded owner/reverse addresses inside .ics files", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"BEGIN:VEVENT",
			"ATTENDEE:mailto:me@home.test",
			"URL:https://cal.example/rsvp?owner=me%40home.test&reply=reply%2Bra_abc%40r.a.test",
			"DESCRIPTION:Contact me&#64;home.test or reply&#43;ra_abc&#64;r.a.test",
			"END:VEVENT",
			"END:VCALENDAR",
		].join("\r\n");
		const out = new TextDecoder().decode(
			rewriteAttachment(toArrayBuffer(ics), "calendar", [
				{ from: "me@home.test", to: "shop@a.test" },
				{ from: "reply+ra_abc@r.a.test", to: "them@example.com" },
			]),
		);
		expect(out).not.toContain("home.test");
		expect(out).not.toContain("ra_abc");
		expect(out).toContain("ATTENDEE:mailto:shop@a.test");
		expect(out).toContain("owner=shop@a.test&reply=them@example.com");
		expect(out).toContain("Contact shop@a.test or them@example.com");
	});
});

describe("4. Bounded subject normalization in runRules", () => {
	it("evaluates many subject rules against an oversized subject quickly without excessive allocation", async () => {
		for (let i = 0; i < 30; i += 1) {
			await createRule(db, {
				name: `Subj ${i}`,
				active: true,
				operator: "AND",
				conditions: [{ type: "subject", match: "contains", values: [`needle-${i}`] }],
				actions: [{ type: "block", value: "" }],
				forwards: true,
				replies: false,
				sends: false,
			});
		}
		const hugeSubject = `URGENT invoice ${"x".repeat(500_000)}`;
		const start = performance.now();
		const outcome = await runRules(db, "forwards", { sender: "them@example.com", subject: hugeSubject, alias: "shop@a.test" });
		const elapsedMs = performance.now() - start;
		expect(outcome.block).toBeUndefined();
		expect(elapsedMs).toBeLessThan(200);
	});
});

describe("5. Strict domain check in mailflareConfig", () => {
	it("rejects single-label internal hostnames while allowing valid dotted domains", () => {
		for (const bad of ["https://metadata", "https://redis", "https://localhost", "https://127.0.0.1"]) {
			expect(() =>
				mailflareConfig({ mailflareUrl: bad, mailflareApiKey: "k", siteOrigin: ORIGIN, publicUrl: "" } as AppConfig),
			).toThrow(MailflareError);
		}
		expect(
			mailflareConfig({ mailflareUrl: "https://mailflare.test", mailflareApiKey: "k", siteOrigin: ORIGIN, publicUrl: "" } as AppConfig).baseUrl,
		).toBe("https://mailflare.test");
	});
});

describe("6. Partial POST validation on /connection", () => {
	it("rejects invalid customHeaders or customBody submitted without customUrl when customUrl is already saved", async () => {
		const cookie = await signIn(db);
		await saveConfig(db, {
			outboundProvider: "custom",
			outboundOptions: JSON.stringify({
				customUrl: "https://api.mailprovider.com/send",
				customHeaders: "Authorization: Bearer {{apiKey}}",
				customBody: '{"to": {{to}}}',
			}),
		});
		const response = await app.fetch(
			new Request(`${ORIGIN}/connection`, {
				method: "POST",
				headers: { Cookie: cookie, Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ customBody: "{not valid json" }),
			}),
			env,
		);
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toContain("notice=notice.badCustom");
	});

	it("still allows switching to smtp and saving smtp options when an unrelated customUrl is stored", async () => {
		const cookie = await signIn(db);
		await saveConfig(db, {
			outboundProvider: "custom",
			outboundOptions: JSON.stringify({
				customUrl: "https://api.mailprovider.com/send",
				customHeaders: "Authorization: Bearer {{apiKey}}",
				customBody: '{"to": {{to}}}',
			}),
		});
		const response = await app.fetch(
			new Request(`${ORIGIN}/connection`, {
				method: "POST",
				headers: { Cookie: cookie, Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ outboundProvider: "smtp", smtpHost: "smtp.mailprovider.com", smtpPort: "587", smtpSecurity: "starttls" }),
			}),
			env,
		);
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toContain("notice=notice.connectionSaved");
	});
});
