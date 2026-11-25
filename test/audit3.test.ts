import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { app } from "../src/index";
import { setUpDomain } from "../src/cloudflare";
import { extractEmail, pageParam, parseBareEmail } from "../src/format";
import { dmarcFailedAtCloudflare } from "../src/forward";
import { singleSender, stripSignedLinks } from "../src/reply";
import { loadSettings, saveSettings } from "../src/settings";
import { bannerHtml } from "../src/transform";
import { translator } from "../src/i18n";
import { performAction, type LinkTarget } from "../src/unsubscribe";
import { loadConfig } from "../src/config";
import type { ForwardRow } from "../src/db";
import { testDb } from "./helpers/d1";
import { signIn, TEST_SECRET } from "./helpers/session";

/** Regression tests for the findings of issue #2. */
type Sent = { from: string | { name: string; email: string }; to: unknown; subject: string; text?: string; html?: string };
let db: D1Database;
let env: Env;
let sent: Sent[];

beforeEach(async () => {
	db = testDb();
	sent = [];
	env = {
		DB: db,
		SIGNING_SECRET: TEST_SECRET,
		EMAIL: { send: async (message: Sent) => (sent.push(message), { messageId: `<sent${sent.length}@test>` }) },
	} as unknown as Env;
	await saveSettings(db, { ...(await loadSettings(db)), aliasDomains: ["a.test"], defaultDestination: "owner@gmail.test" });
	await db.prepare("INSERT INTO config (key, value) VALUES ('siteOrigin', 'https://alias.test')").run();
});

afterEach(() => vi.unstubAllGlobals());

/** An inbound message; `head` holds every header line, so a test can set its own Message-ID or Date. */
function inbound(to: string, envelopeFrom: string, head: string, body = "Hello") {
	const raw = `${head}\r\nTo: ${to}\r\nSubject: Hi\r\nContent-Type: text/plain\r\n\r\n${body}\r\n`;
	let rejected: string | null = null;
	const headers = new Headers();
	for (const line of raw.split("\r\n\r\n")[0]!.split("\r\n")) {
		const at = line.indexOf(":");
		if (at > 0) headers.append(line.slice(0, at), line.slice(at + 1).trim());
	}
	const msg = {
		to,
		from: envelopeFrom,
		headers,
		raw: new Response(raw).body,
		rawSize: raw.length,
		setReject: (reason: string) => {
			rejected = reason;
		},
	} as unknown as ForwardableEmailMessage;
	return { msg, rejected: () => rejected };
}
const deliver = (msg: ForwardableEmailMessage) => worker.email!(msg as never, env);
const PASS = "Authentication-Results: mx.cloudflare.net; spf=pass; dmarc=pass header.from=gmail.test";
const id = () => `Message-ID: <${crypto.randomUUID()}@x>`;

describe("1. quoted local parts", () => {
	it("never picks an address out of a quoted local part", () => {
		expect(extractEmail('"<ceo@victim.com>"@attacker.com')).toBeNull();
		expect(extractEmail('Boss <"<ceo@victim.com>"@attacker.com>')).toBeNull();
		expect(extractEmail("x <a@b.com> <c@d.com>")).toBeNull();
		expect(parseBareEmail('"x"@a.com')).toBeNull();
		expect(extractEmail('"Owner" <Owner@Gmail.com>')).toBe("owner@gmail.com");
		expect(extractEmail("bob@store.test")).toBe("bob@store.test");
	});

	it("does not take the hidden address as the sender, and marks the message unverified", async () => {
		const { msg } = inbound("shop@a.test", "mallory@attacker.com", `From: "<ceo@victim.com>"@attacker.com\r\n${id()}`);
		await deliver(msg);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.subject).toMatch(/^\[Unverified sender\]/);
		const contacts = (await db.prepare("SELECT email FROM contacts").all<{ email: string }>()).results.map((row) => row.email);
		expect(contacts).toEqual(["mallory@attacker.com"]);
	});
});

describe("2. the sender's mailto unsubscribe without Mailflare", () => {
	it("sends it with Email Sending, and reports the block when it falls back", async () => {
		await deliver(inbound("shop@a.test", "news@store.test", `From: news@store.test\r\n${id()}\r\nList-Unsubscribe: <mailto:leave@store.test?subject=stop>`).msg);
		const forward = (await db.prepare("SELECT * FROM forwards").first<ForwardRow>())!;
		const config = await loadConfig(env);
		const target: LinkTarget = { forward, contactEmail: "news@store.test", action: "preserve_original", kind: "unsubscribe", plan: { kind: "mail", to: "leave@store.test", subject: "stop" }, token: "t" };
		sent = [];
		const { done } = await performAction(env, config, target);
		expect(sent).toEqual([{ from: "shop@a.test", to: "leave@store.test", subject: "stop", text: "unsubscribe" }]);
		expect(done.action).toBe("preserve_original");

		env.EMAIL = { send: async () => Promise.reject(new Error("refused")) } as unknown as SendEmail;
		const fallback = await performAction(env, config, target);
		expect(fallback.done).toMatchObject({ action: "block_contact", plan: null });
	});
});

describe("3. signed links in replies", () => {
	const token = `fw_${"a".repeat(32)}.1700000000.sig_-x`;
	it("removes the token however it is written or wrapped", () => {
		for (const body of [
			`https://alias.test/action/disable%7E${token}`,
			`https://alias.test/action/disable&#126;${token}`,
			`https://safelinks.example/?url=https%3A%2F%2Falias.test%2Faction%2Fdisable%7E${token}&data=1`,
			`https://alias.test/action/block~${token}`,
		]) {
			expect(stripSignedLinks(body)).not.toContain(token);
		}
	});

	it("replaces a reverse alias written with %2B in a mailto link", async () => {
		await deliver(inbound("shop@a.test", "bob@store.test", `From: bob@store.test\r\n${id()}`).msg);
		const reverse = (sent[0]!.from as { email: string }).email;
		sent = [];
		const encoded = reverse.replace("+", "%2B");
		const { msg, rejected } = inbound(reverse, "owner@gmail.test", `${PASS}\r\nFrom: owner@gmail.test\r\n${id()}`, `See mailto:${encoded} and mailto:owner@gmail.test`);
		await deliver(msg);
		expect(rejected()).toBeNull();
		expect(sent[0]!.text).not.toContain(encoded.split("@")[0]);
		expect(sent[0]!.text).toContain("mailto:bob@store.test");
	});
});

describe("4. the default forwarding address", () => {
	it("is stored as the bare address", async () => {
		const response = await app.fetch(
			new Request("https://alias.test/settings", {
				method: "POST",
				headers: { cookie: await signIn(db), Origin: "https://alias.test", "Content-Type": "application/x-www-form-urlencoded", "X-Autosave": "1" },
				body: new URLSearchParams({ aliasDomains: "a.test", defaultDestination: "Owner <Owner@Gmail.test>" }),
			}),
			env,
		);
		expect(response.status).toBeLessThan(400);
		expect((await loadSettings(db)).defaultDestination).toBe("owner@gmail.test");
	});
});

describe("5. reply header checks", () => {
	it("refuses a second Sender header", () => {
		expect(singleSender("From: owner@gmail.test\r\nSender: owner@gmail.test\r\nSender: x@evil.test", "owner@gmail.test")).toBeNull();
		expect(singleSender("From: owner@gmail.test\r\nSender: owner@gmail.test", "owner@gmail.test")).toBe("owner@gmail.test");
	});

	it("refuses a reply whose headers do not end within 64 KiB", async () => {
		await deliver(inbound("shop@a.test", "bob@store.test", `From: bob@store.test\r\n${id()}`).msg);
		const reverse = (sent[0]!.from as { email: string }).email;
		sent = [];
		const filler = Array.from({ length: 800 }, (_, i) => `X-Pad-${i}: ${"p".repeat(90)}`).join("\r\n");
		const { msg, rejected } = inbound(reverse, "owner@gmail.test", `${PASS}\r\nFrom: owner@gmail.test\r\n${filler}\r\n${id()}`);
		await deliver(msg);
		expect(rejected()).toMatch(/Only the owner/);
		expect(sent).toHaveLength(0);
	});
});

describe("6. duplicate detection", () => {
	it("forwards a second message that only shares the Message-ID", async () => {
		const shared = "Message-ID: <same@x>";
		await deliver(inbound("shop@a.test", "mallory@evil.test", `From: mallory@evil.test\r\n${shared}\r\nDate: Mon, 1 Jan 2024 00:00:00 +0000`).msg);
		await deliver(inbound("shop@a.test", "bank@bank.test", `From: bank@bank.test\r\n${shared}\r\nDate: Tue, 2 Jan 2024 00:00:00 +0000`).msg);
		expect(sent).toHaveLength(2);
	});
});

describe("7. API keys", () => {
	it("reports the key's own name from the key checked on the way in", async () => {
		await saveSettings(db, { ...(await loadSettings(db)), addyApi: true });
		const { createApiKey } = await import("../src/apikeys");
		const { key } = await createApiKey(db, "Phone");
		const response = await app.fetch(new Request("https://alias.test/api/v1/api-token-details", { headers: { Authorization: `Bearer ${key}` } }), env);
		expect(((await response.json()) as { name: string }).name).toBe("Phone");
	});
});

describe("8. banner placeholders", () => {
	it("keeps {sender} and $& in an alias as plain text", () => {
		const html = bannerHtml({ alias: "a{sender}$&@a.test", sender: "bob@store.test", blockUrl: "https://x/1", disableUrl: "https://x/2", spoofWarning: false }, 0, translator("en"));
		expect(html).toContain("<b>a{sender}$&amp;@a.test</b>");
	});
});

describe("10. other checks", () => {
	it("reads only Cloudflare's own DMARC verdict", () => {
		expect(dmarcFailedAtCloudflare("mx.cloudflare.net.evil.test; dmarc=fail")).toBe(false);
		expect(dmarcFailedAtCloudflare('mx.cloudflare.net; spf=pass (note "dmarc=fail") dmarc=pass')).toBe(false);
		expect(dmarcFailedAtCloudflare("mx.cloudflare.net; dmarc=fail header.from=x.test")).toBe(true);
	});

	it("ignores page numbers that are not whole numbers in range", () => {
		expect(pageParam("Infinity", 1)).toBe(1);
		expect(pageParam("1e308", 1)).toBe(1);
		expect(pageParam("2.5", 1)).toBe(1);
		expect(pageParam("0", 0, 0)).toBe(0);
		expect(pageParam("3", 1)).toBe(3);
	});

	it("does not overwrite a catch-all it could not read", async () => {
		const writes: string[] = [];
		vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
			const path = new URL(url).pathname.replace("/client/v4", "");
			if ((init.method ?? "GET") !== "GET") writes.push(path);
			if (path === "/zones") return Response.json({ success: true, result: [{ id: "z1", name: "a.test" }] });
			if (path.endsWith("/catch_all") && !init.method) return Response.json({ success: false, errors: [{ code: 1, message: "busy" }] }, { status: 503 });
			return Response.json({ success: true, result: {} });
		});
		const { steps } = await setUpDomain({ token: "t", domain: "a.test", workerName: "aliasflare" });
		expect(steps.find((step) => step.step === "catchall")).toMatchObject({ ok: false });
		expect(writes.some((path) => path.endsWith("/catch_all"))).toBe(false);
	});

	it("refuses an import server that is an IP address or an internal name", async () => {
		const cookie = await signIn(db);
		for (const server of ["https://127.0.0.1", "https://intranet.local:8443", "https://alias.test"]) {
			const response = await app.fetch(
				new Request("https://alias.test/import/simplelogin", {
					method: "POST",
					headers: { cookie, Origin: "https://alias.test", "Content-Type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({ server, apiKey: "k", domains: "a.test" }),
				}),
				env,
			);
			expect(await response.text(), server).toContain(translator("en")("imp.err.badServer"));
		}
	});
});
