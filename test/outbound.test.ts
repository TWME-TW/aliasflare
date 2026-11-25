import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { loadSettings, saveSettings } from "../src/settings";
import { loadConfig } from "../src/config";
import { FREE_PLAN_REWRITE_BYTES } from "../src/forward";
import { testDb } from "./helpers/d1";
import { TEST_SECRET } from "./helpers/session";

/** Mail to other people through Resend or SMTP2GO, and the Workers Free plan's limits. */
let db: D1Database;
let env: Env;
let sent: { from: unknown; to: unknown }[];
let forwardedTo: string[];
let calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[];

beforeEach(async () => {
	db = testDb();
	sent = [];
	forwardedTo = [];
	calls = [];
	env = {
		DB: db,
		SIGNING_SECRET: TEST_SECRET,
		EMAIL: { send: async (message: { from: unknown; to: unknown }) => (sent.push(message), { messageId: `<s${sent.length}@test>` }) },
	} as unknown as Env;
	await saveSettings(db, { ...(await loadSettings(db)), aliasDomains: ["a.test"], defaultDestination: "owner@gmail.test" });
	await db.prepare("INSERT INTO config (key, value) VALUES ('siteOrigin', 'https://alias.test')").run();
});

afterEach(() => vi.unstubAllGlobals());

function stubProvider(answer: (url: string) => Response) {
	vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
		calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
		return answer(url);
	});
}

function inbound(to: string, from: string, head: string, body = "Hello", size?: number) {
	const raw = `${head}\r\nTo: ${to}\r\nSubject: Hi\r\nMessage-ID: <${crypto.randomUUID()}@x>\r\nContent-Type: text/plain\r\n\r\n${body}\r\n`;
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

async function reverseAliasOfBob(): Promise<string> {
	await deliver(inbound("shop@a.test", "bob@store.test", "From: bob@store.test").msg);
	const reverse = (sent[0]!.from as { email: string }).email;
	sent = [];
	return reverse;
}

describe("replies through another provider", () => {
	it("go through Resend with the alias as sender and the thread headers", async () => {
		await db.prepare("INSERT INTO config (key, value) VALUES ('outboundProvider', 'resend'), ('outboundApiKey', 're_test')").run();
		stubProvider(() => Response.json({ id: "abc" }));
		const reverse = await reverseAliasOfBob();
		const { msg, rejected } = inbound(reverse, "owner@gmail.test", `${PASS}\r\nFrom: owner@gmail.test\r\nIn-Reply-To: <p@x>`, "Thanks");
		await deliver(msg);
		expect(rejected()).toBeNull();
		expect(sent).toHaveLength(0);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe("https://api.resend.com/emails");
		expect(calls[0]!.headers.Authorization).toBe("Bearer re_test");
		expect(calls[0]!.body).toMatchObject({ from: "shop@a.test", to: ["bob@store.test"], subject: "Hi", headers: { "In-Reply-To": "<p@x>" } });
	});

	it("are bounced back when SMTP2GO reports a failure despite its 200", async () => {
		await db.prepare("INSERT INTO config (key, value) VALUES ('outboundProvider', 'smtp2go'), ('outboundApiKey', 'api-test')").run();
		stubProvider(() => Response.json({ data: { succeeded: 0, failed: 1, failures: ["sender not verified"] } }));
		const reverse = await reverseAliasOfBob();
		const { msg, rejected } = inbound(reverse, "owner@gmail.test", `${PASS}\r\nFrom: owner@gmail.test`, "Thanks");
		await deliver(msg);
		expect(calls[0]!.headers["X-Smtp2go-Api-Key"]).toBe("api-test");
		expect(calls[0]!.body).toMatchObject({ sender: "shop@a.test", to: ["bob@store.test"] });
		expect(rejected()).toMatch(/could not be sent/);
	});
});

describe("replies through Mail.baby", () => {
	it("go as a whole message to rawsend, from the chosen mail order, with the thread headers", async () => {
		await db
			.prepare("INSERT INTO config (key, value) VALUES ('outboundProvider', 'mailbaby'), ('outboundApiKey', 'mb-key-test'), ('outboundOptions', '{\"mailbabyOrderId\":\"39\"}')")
			.run();
		stubProvider(() => Response.json({ status: "ok", text: "185caa69ff7000f47c" }));
		const reverse = await reverseAliasOfBob();
		const { msg, rejected } = inbound(reverse, "owner@gmail.test", `${PASS}\r\nFrom: owner@gmail.test\r\nIn-Reply-To: <p@x>`, "Thanks");
		await deliver(msg);
		expect(rejected()).toBeNull();
		expect(calls[0]!.url).toBe("https://api.mailbaby.net/mail/rawsend");
		expect(calls[0]!.headers["X-API-KEY"]).toBe("mb-key-test");
		expect(calls[0]!.body.id).toBe(39);
		const raw = String(calls[0]!.body.raw_email);
		expect(raw).toMatch(/^From: <?shop@a\.test>?\r$/m);
		expect(raw).toMatch(/^To: <?bob@store\.test>?\r$/m);
		expect(raw).toMatch(/^In-Reply-To: <p@x>\r$/m);
		expect(raw).toMatch(/^Message-ID: <[^>]+@a\.test>\r$/m);
		// Bodies are base64: the text part carries the reply.
		expect(raw).toContain(btoa("Thanks").slice(0, 8));
	});

	it("are bounced back when Mail.baby refuses them", async () => {
		await db.prepare("INSERT INTO config (key, value) VALUES ('outboundProvider', 'mailbaby'), ('outboundApiKey', 'mb-key-test')").run();
		stubProvider(() => Response.json({ code: 401, message: "API key is missing or invalid" }, { status: 401 }));
		const reverse = await reverseAliasOfBob();
		const { msg, rejected } = inbound(reverse, "owner@gmail.test", `${PASS}\r\nFrom: owner@gmail.test`, "Thanks");
		await deliver(msg);
		expect(calls[0]!.body.id).toBeUndefined();
		expect(rejected()).toMatch(/could not be sent/);
	});

	it("keep only a numeric mail order id", async () => {
		const { normalizeOutboundOptions } = await import("../src/outbound");
		expect(normalizeOutboundOptions({ mailbabyOrderId: " 66 " }).mailbabyOrderId).toBe("66");
		expect(normalizeOutboundOptions({ mailbabyOrderId: "mb66" }).mailbabyOrderId).toBe("");
	});
});

describe("replies through Brevo", () => {
	beforeEach(async () => {
		await db.prepare("INSERT INTO config (key, value) VALUES ('outboundProvider', 'brevo'), ('outboundApiKey', 'xkeysib-test')").run();
	});

	it("go out as the alias, without the standard headers Brevo refuses", async () => {
		stubProvider(() => Response.json({ messageId: "<m@brevo>" }, { status: 201 }));
		const reverse = await reverseAliasOfBob();
		const { msg, rejected } = inbound(reverse, "owner@gmail.test", `${PASS}\r\nFrom: owner@gmail.test\r\nIn-Reply-To: <p@x>`, "Thanks");
		await deliver(msg);
		expect(rejected()).toBeNull();
		expect(calls[0]!.url).toBe("https://api.brevo.com/v3/smtp/email");
		expect(calls[0]!.headers["api-key"]).toBe("xkeysib-test");
		expect(calls[0]!.body).toMatchObject({ sender: { email: "shop@a.test" }, to: [{ email: "bob@store.test" }], subject: "Hi" });
		expect(calls[0]!.body.headers).toBeUndefined();
	});

	it("bounces a reply with a file type Brevo does not send", async () => {
		stubProvider(() => Response.json({ messageId: "<m@brevo>" }, { status: 201 }));
		const reverse = await reverseAliasOfBob();
		const head = `${PASS}\r\nFrom: owner@gmail.test\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=B`;
		const body = `--B\r\nContent-Type: text/plain\r\n\r\nThanks\r\n--B\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=tool.exe\r\n\r\nMZ\r\n--B--`;
		const raw = `${head}\r\nTo: ${reverse}\r\nSubject: Hi\r\n\r\n${body}\r\n`;
		let rejected: string | null = null;
		await deliver({
			to: reverse,
			from: "owner@gmail.test",
			headers: new Headers({ "Authentication-Results": "mx.cloudflare.net; spf=pass; dmarc=pass header.from=gmail.test", From: "owner@gmail.test" }),
			raw: new Response(raw).body,
			rawSize: raw.length,
			setReject: (reason: string) => void (rejected = reason),
		} as unknown as ForwardableEmailMessage);
		expect(rejected).toMatch(/tool\.exe/);
		expect(calls).toHaveLength(0);
	});
});

describe("the Workers Free plan", () => {
	it("is assumed unless the Paid plan is chosen", async () => {
		expect((await loadConfig(env)).workersPlan).toBe("free");
		await db.prepare("INSERT INTO config (key, value) VALUES ('workersPlan', 'paid')").run();
		expect((await loadConfig(env)).workersPlan).toBe("paid");
	});

	it("passes a large message through unchanged instead of rewriting it", async () => {
		const { msg, rejected } = inbound("shop@a.test", "bob@store.test", "From: bob@store.test", "Hello", FREE_PLAN_REWRITE_BYTES + 1);
		await deliver(msg);
		expect(rejected()).toBeNull();
		expect(forwardedTo).toEqual(["owner@gmail.test"]);
		expect(sent).toHaveLength(0);
		const row = await db.prepare("SELECT status, error FROM forwards").first<{ status: string; error: string }>();
		expect(row).toMatchObject({ status: "sent" });
		expect(row?.error).toMatch(/passed through unchanged/);
	});

	it("rewrites a large message on the Paid plan", async () => {
		await db.prepare("INSERT INTO config (key, value) VALUES ('workersPlan', 'paid')").run();
		await deliver(inbound("shop@a.test", "bob@store.test", "From: bob@store.test", "Hello", FREE_PLAN_REWRITE_BYTES + 1).msg);
		expect(forwardedTo).toEqual([]);
		expect(sent).toHaveLength(1);
	});

	it("refuses a large reply with the reason", async () => {
		const reverse = await reverseAliasOfBob();
		const { msg, rejected } = inbound(reverse, "owner@gmail.test", `${PASS}\r\nFrom: owner@gmail.test`, "Thanks", FREE_PLAN_REWRITE_BYTES + 1);
		await deliver(msg);
		expect(rejected()).toMatch(/Workers Free plan/);
	});
});
