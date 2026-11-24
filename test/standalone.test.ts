import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { clashingDomain, contactReverseAddress, isOwnAddress } from "../src/domains";
import { loadSettings, saveSettings } from "../src/settings";
import { testDb } from "./helpers/d1";
import { signIn, TEST_SECRET } from "./helpers/session";

/**
 * Without Mailflare: Email Routing delivers mail for alias domains (catch-all) and reverse
 * aliases (r.<domain>) to the Worker, which sends with Email Sending. Each alias domain has its
 * own reverse-alias domain.
 */
type Sent = { from: string | { name: string; email: string }; to: string; subject: string; text?: string; headers?: Record<string, string> };
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
	await saveSettings(db, { ...(await loadSettings(db)), aliasDomains: ["a.test", "b.test"], defaultDestination: "owner@gmail.test" });
	await db.prepare("INSERT INTO config (key, value) VALUES ('siteOrigin', 'https://alias.test')").run();
});

function message(to: string, from: string, headers: string, body = "Hello") {
	const raw = `${headers}\r\nTo: ${to}\r\nSubject: Hi\r\nMessage-ID: <${crypto.randomUUID()}@x>\r\nContent-Type: text/plain\r\n\r\n${body}\r\n`;
	let rejected: string | null = null;
	const parsed = new Headers();
	for (const line of raw.split("\r\n\r\n")[0]!.split("\r\n")) {
		const at = line.indexOf(":");
		if (at > 0) parsed.append(line.slice(0, at), line.slice(at + 1).trim());
	}
	const msg = {
		to,
		from,
		headers: parsed,
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

describe("domains", () => {
	it("knows each alias domain's own reverse-alias domain", () => {
		expect(contactReverseAddress({ reverse_local: "x1", alias_address: "shop@a.test" })).toBe("reply+x1@r.a.test");
		expect(isOwnAddress("me@r.a.test", ["a.test"])).toBe(true);
		expect(isOwnAddress("me@r.other.test", ["a.test"])).toBe(false);
		expect(clashingDomain(["a.test", "r.a.test"])).toBe("a.test");
		expect(clashingDomain(["r.example.test"])).toBeNull();
	});

	it("refuses an alias domain that is another one's reverse-alias domain", async () => {
		const cookie = await signIn(db);
		const response = await worker.fetch(
			new Request("https://alias.test/settings", {
				method: "POST",
				headers: { cookie, Origin: "https://alias.test", "Content-Type": "application/x-www-form-urlencoded", "X-Autosave": "1" },
				body: new URLSearchParams({ aliasDomains: "a.test, r.a.test", defaultDestination: "owner@gmail.test" }),
			}),
			env,
			{} as ExecutionContext,
		);
		expect(response.status).toBe(400);
	});
});

describe("mail through Email Routing", () => {
	it("forwards mail for any address on an alias domain from that domain's reverse alias", async () => {
		const { msg, rejected } = message("shop@a.test", "bob@store.test", "From: Bob <bob@store.test>");
		await deliver(msg);
		expect(rejected()).toBeNull();
		expect(sent).toHaveLength(1);
		const from = sent[0]!.from as { email: string };
		expect(from.email).toMatch(/^reply\+[a-z0-9_]+@r\.a\.test$/);
		// Delivered to the real mailbox, but shown as sent to the alias.
		expect(sent[0]!.to).toEqual({ name: "shop@a.test", email: "owner@gmail.test" });
		expect(sent[0]!.headers?.["X-Original-To"]).toBe("shop@a.test");
		expect(sent[0]!.headers?.["List-Unsubscribe"]).toMatch(/^<https:\/\/alias\.test\/unsubscribe\//);
		expect(await db.prepare("SELECT mailbox_id FROM aliases WHERE address = 'shop@a.test'").first("mailbox_id")).toBe("");
	});

	it("gives the same sender a different reverse alias on another domain", async () => {
		await deliver(message("shop@a.test", "bob@store.test", "From: bob@store.test").msg);
		await deliver(message("news@b.test", "bob@store.test", "From: bob@store.test").msg);
		const [first, second] = sent.map((mail) => (typeof mail.from === "string" ? mail.from : mail.from.email));
		expect(first).toMatch(/@r\.a\.test$/);
		expect(second).toMatch(/@r\.b\.test$/);
		expect(first!.split("@")[0]).not.toBe(second!.split("@")[0]);
	});

	it("rejects mail for a domain that is not an alias domain", async () => {
		const { msg, rejected } = message("x@c.test", "bob@store.test", "From: bob@store.test");
		await deliver(msg);
		expect(rejected()).toMatch(/does not exist/);
		expect(sent).toHaveLength(0);
	});

	it("sends the owner's reply from the alias with Email Sending", async () => {
		await deliver(message("shop@a.test", "bob@store.test", "From: bob@store.test").msg);
		const reverse = (sent[0]!.from as { email: string }).email;
		sent = [];
		const { msg, rejected } = message(reverse, "owner@gmail.test", `${PASS}\r\nFrom: owner@gmail.test`, `Thanks, write to owner@gmail.test`);
		await deliver(msg);
		expect(rejected()).toBeNull();
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ from: "shop@a.test", to: "bob@store.test" });
		expect(sent[0]!.text).toContain("shop@a.test");
		expect(sent[0]!.text).not.toContain("owner@gmail.test");
	});

	it("does not let one domain's reverse alias be used through another domain", async () => {
		await deliver(message("shop@a.test", "bob@store.test", "From: bob@store.test").msg);
		const local = (sent[0]!.from as { email: string }).email.split("@")[0];
		sent = [];
		const { msg, rejected } = message(`${local}@r.b.test`, "owner@gmail.test", `${PASS}\r\nFrom: owner@gmail.test`);
		await deliver(msg);
		expect(rejected()).toMatch(/does not exist/);
		expect(sent).toHaveLength(0);
	});

	it("lets the sending server retry when forwarding fails", async () => {
		env = { ...env, EMAIL: { send: async () => Promise.reject(new Error("sending is down")) } } as unknown as Env;
		await expect(deliver(message("shop@a.test", "bob@store.test", "From: bob@store.test").msg)).rejects.toThrow(/Forwarding failed/);
	});
});

describe("site origin", () => {
	it("remembers where the dashboard is opened, for links in mail from Email Routing", async () => {
		await db.prepare("DELETE FROM config WHERE key = 'siteOrigin'").run();
		const cookie = await signIn(db);
		await worker.fetch(new Request("https://dash.example.test/settings", { headers: { cookie } }), env, {} as ExecutionContext);
		expect(await db.prepare("SELECT value FROM config WHERE key = 'siteOrigin'").first("value")).toBe("https://dash.example.test");
	});
});
