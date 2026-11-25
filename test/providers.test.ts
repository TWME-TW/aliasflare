import PostalMime from "postal-mime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, saveConfig } from "../src/config";
import worker from "../src/index";
import { buildMime, encodeWords } from "../src/mime";
import { customValues, fillTemplate, normalizeOutboundOptions, sendOutbound, signSes, type OutboundMessage } from "../src/outbound";
import { dotStuff, sendSmtp, type SmtpConnect, type SmtpSocket } from "../src/smtp";
import { loadSettings, saveSettings } from "../src/settings";
import { testDb } from "./helpers/d1";
import { TEST_SECRET } from "./helpers/session";

const message: OutboundMessage = {
	from: { name: "Ünïcode Shop", email: "shop@me.test" },
	to: "bob@store.test",
	replyTo: "shop@me.test",
	subject: "Re: 你好 — a long subject that needs more than one encoded word to fit",
	text: "Hello\n.dot line",
	html: '<p>Hi <img src="cid:logo"></p>',
	headers: { "In-Reply-To": "<a@store.test>", "Content-Type": "evil", Bcc: "x@evil.test" },
	attachments: [
		{ disposition: "inline", filename: "logo.png", type: "image/png", contentId: "logo", content: new Uint8Array([1, 2, 3]).buffer },
		{ disposition: "attachment", filename: "報告.pdf", type: "application/pdf", content: new Uint8Array([4, 5]).buffer },
	],
};

describe("MIME messages", () => {
	it("parse back to what was sent, with no header smuggled in", async () => {
		const raw = buildMime(message, "<id1@me.test>", new Date("2026-01-02T03:04:05Z"));
		expect(raw).not.toMatch(/^Bcc:/m);
		expect(raw.split("\r\n").every((line) => line.length <= 998)).toBe(true);
		const parsed = await PostalMime.parse(raw);
		expect(parsed.from).toMatchObject({ name: "Ünïcode Shop", address: "shop@me.test" });
		expect(parsed.subject).toBe(message.subject);
		expect(parsed.messageId).toBe("<id1@me.test>");
		expect(parsed.inReplyTo).toBe("<a@store.test>");
		expect(parsed.text?.trim()).toBe("Hello\n.dot line");
		expect(parsed.html).toContain("cid:logo");
		expect(parsed.attachments.map((a) => [a.filename, a.mimeType, a.contentId ?? null])).toEqual([
			["logo.png", "image/png", "<logo>"],
			["報告.pdf", "application/pdf", null],
		]);
	});

	it("keep header values on one line", () => {
		expect(encodeWords("a\r\nBcc: x")).toBe("a Bcc: x");
	});
});

/** A scripted SMTP server on the other end of a fake socket. */
function fakeServer(reply: (line: string) => string | null, log: string[]): SmtpConnect {
	return (_address, options) => {
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
							if (line === ".") (inData = false), push("250 queued\r\n");
							continue;
						}
						if (line === "DATA") inData = true;
						const answer = reply(line);
						if (answer) push(answer);
						if (line === "STARTTLS") socket = make();
					}
				},
			});
			return { readable, writable, startTls: () => socket, close: async () => {} };
		};
		let socket = make();
		const first = socket;
		queueMicrotask(() => push("220 ready\r\n"));
		expect(options.secureTransport).toBe("starttls");
		return first;
	};
}

describe("SMTP", () => {
	const answers = (line: string) =>
		line.startsWith("EHLO")
			? "250-smtp.test\r\n250-STARTTLS\r\n250 AUTH LOGIN PLAIN\r\n"
			: line === "STARTTLS"
				? "220 go ahead\r\n"
				: line.startsWith("AUTH")
					? "235 ok\r\n"
					: line === "DATA"
						? "354 send\r\n"
						: line === "QUIT"
							? "221 bye\r\n"
							: "250 ok\r\n";

	it("upgrades to TLS, signs in and sends with dots doubled", async () => {
		const log: string[] = [];
		await sendSmtp({ host: "smtp.test", port: 587, security: "starttls", username: "u", password: "p" }, { from: "shop@me.test", to: "bob@store.test" }, "Subject: x\r\n\r\n.hidden\r\n", fakeServer(answers, log));
		expect(log).toEqual(["EHLO aliasflare", "STARTTLS", "EHLO aliasflare", `AUTH PLAIN ${btoa("\0u\0p")}`, "MAIL FROM:<shop@me.test>", "RCPT TO:<bob@store.test>", "DATA", "Subject: x", "", "..hidden", ".", "QUIT"]);
	});

	it("reports a refused recipient without the password", async () => {
		const refuse = (line: string) => (line.startsWith("RCPT") ? "550 no such user\r\n" : answers(line));
		const error = await sendSmtp({ host: "smtp.test", port: 587, security: "starttls", username: "u", password: "secret" }, { from: "a@me.test", to: "b@x.test" }, "x", fakeServer(refuse, [])).catch((e) => e);
		expect(String(error)).toContain("550 no such user");
		expect(String(error)).not.toContain("secret");
		expect(dotStuff("a\n.b")).toBe("a\r\n..b\r\n.\r\n");
		await expect(sendSmtp({ host: "h.test", port: 25, security: "starttls", username: "", password: "" }, { from: "a@b.test", to: "c@d.test" }, "x")).rejects.toThrow("port 25");
	});
});

describe("HTTP providers", () => {
	let db: D1Database;
	let env: Env;
	let calls: { url: string; headers: Headers; body: string | FormData }[];
	beforeEach(() => {
		db = testDb();
		env = { DB: db, SIGNING_SECRET: TEST_SECRET } as unknown as Env;
		calls = [];
		vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
			calls.push({ url, headers: new Headers(init.headers), body: init.body as string | FormData });
			return Response.json(url.includes("postmark") ? { MessageID: "pm-1", ErrorCode: 0 } : url.includes("amazonaws") ? { MessageId: "ses-1" } : url.includes("mailgun") ? { id: "<mg-1>" } : { data: { id: 42 } });
		});
	});
	afterEach(() => vi.unstubAllGlobals());

	const use = async (provider: string, options: Record<string, unknown> = {}) => {
		await saveConfig(db, { outboundProvider: provider, outboundApiKey: "KEY", outboundOptions: JSON.stringify(options) });
		return sendOutbound(env, await loadConfig(env), message);
	};

	it("send through Postmark, Mailgun and Amazon SES", async () => {
		expect(await use("postmark")).toEqual({ messageId: "pm-1" });
		const postmark = JSON.parse(calls[0]!.body as string);
		expect(calls[0]!.headers.get("X-Postmark-Server-Token")).toBe("KEY");
		expect(postmark.Attachments[0]).toMatchObject({ Name: "logo.png", ContentID: "cid:logo" });

		expect(await use("mailgun", { mailgunRegion: "eu" })).toEqual({ messageId: "<mg-1>" });
		expect(calls[1]!.url).toBe("https://api.eu.mailgun.net/v3/me.test/messages");
		expect(calls[1]!.headers.get("Authorization")).toBe(`Basic ${btoa("api:KEY")}`);
		expect((calls[1]!.body as FormData).get("h:In-Reply-To")).toBe("<a@store.test>");

		expect(await use("ses", { sesRegion: "eu-west-1", sesAccessKeyId: "AKIDEXAMPLE" })).toEqual({ messageId: "ses-1" });
		expect(calls[2]!.url).toBe("https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails");
		expect(calls[2]!.headers.get("Authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
		const raw = atob(JSON.parse(calls[2]!.body as string).Content.Raw.Data);
		expect(raw).toContain("To: <bob@store.test>");
	});

	it("sign SES requests the same way each time", async () => {
		const input = { region: "us-east-1", accessKeyId: "AKID", secret: "s", body: "{}", date: new Date("2026-01-02T03:04:05Z") };
		const first = await signSes(input);
		expect(first["X-Amz-Date"]).toBe("20260102T030405Z");
		expect(await signSes(input)).toEqual(first);
		expect((await signSes({ ...input, body: "{ }" })).Authorization).not.toBe(first.Authorization);
	});

	it("send a custom request, with JSON values and the key in a header", async () => {
		const result = await use("custom", {
			customUrl: "https://api.example.com/send",
			customHeaders: "X-Key: {{api_key}}",
			customBody: '{"to": {{to}}, "subject": {{subject}}, "files": {{attachments}}, "raw": {{raw}}}',
			customIdPath: "data.id",
		});
		expect(result).toEqual({ messageId: "42" });
		expect(calls[0]!.headers.get("X-Key")).toBe("KEY");
		const body = JSON.parse(calls[0]!.body as string);
		expect(body).toMatchObject({ to: "bob@store.test", subject: message.subject });
		expect(body.files[1].filename).toBe("報告.pdf");
		expect(atob(body.raw)).toContain("MIME-Version: 1.0");
		const values = customValues(message, "k", "<i>", () => "r");
		expect(() => fillTemplate("{{nope}}", values, "json")).toThrow("Unknown placeholder");
		expect(fillTemplate("Bearer {{api_key}}", customValues(message, "a\r\nX: y", "<i>", () => ""), "text")).toBe("Bearer a X: y");
	});

	it("keep only usable options", () => {
		expect(normalizeOutboundOptions({ smtpHost: "bad host", smtpPort: 25, sesRegion: "nowhere", sesAccessKeyId: "AK ID!" })).toMatchObject({ smtpHost: "", smtpPort: 587, sesRegion: "us-east-1", sesAccessKeyId: "AKID" });
	});
});

describe("receive-only forwarding", () => {
	it("passes mail on unchanged, keeps the sender as a contact, and still blocks", async () => {
		const db = testDb();
		const env = { DB: db, SIGNING_SECRET: TEST_SECRET, EMAIL: { send: async () => ({ messageId: "x" }) } } as unknown as Env;
		await saveSettings(db, { ...(await loadSettings(db)), aliasDomains: ["me.test"], defaultDestination: "owner@gmail.test", forwardMethod: "direct" });
		const forwarded: string[] = [];
		const deliver = (from: string) => {
			const raw = `From: ${from}\r\nTo: shop@me.test\r\nSubject: Hi\r\n\r\nHello\r\n`;
			return worker.email!(
				{ to: "shop@me.test", from, headers: new Headers({ From: from }), raw: new Response(raw).body, rawSize: raw.length, forward: async (to: string) => void forwarded.push(to), setReject: () => {} } as never,
				env,
			);
		};
		await deliver("news@store.test");
		expect(forwarded).toEqual(["owner@gmail.test"]);
		expect(await db.prepare("SELECT email, forward_count FROM contacts").first()).toEqual({ email: "news@store.test", forward_count: 1 });
		await db.prepare("UPDATE contacts SET blocked = 1").run();
		await deliver("news@store.test");
		expect(forwarded).toHaveLength(1);
	});
});
