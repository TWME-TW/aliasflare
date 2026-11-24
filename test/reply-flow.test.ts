import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config";
import { handleReverseAliasMail } from "../src/reply";
import { loadSettings, saveSettings } from "../src/settings";
import { testDb } from "./helpers/d1";

const config = { mailflareUrl: "https://mailflare.test", mailflareApiKey: "k", reverseDomain: "r.me.test" } as AppConfig;
let db: D1Database;
let sent: { to: string[]; from: string; text?: string }[];

beforeEach(async () => {
	db = testDb();
	sent = [];
	await saveSettings(db, { ...(await loadSettings(db)), aliasDomains: ["me.test"], defaultDestination: "owner@gmail.test" });
	await db.prepare("INSERT INTO aliases (address, mailbox_id, created_at, updated_at) VALUES ('shop@me.test', 'mb1', 1, 1), ('other@me.test', 'mb1', 1, 1)").run();
	await db
		.prepare(
			"INSERT INTO contacts (id, alias_address, email, reverse_local, created_at) VALUES ('c1', 'shop@me.test', 'bob@store.test', 'rbob', 1), ('c2', 'other@me.test', 'secret@private.test', 'rsecret', 1)",
		)
		.run();
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		sent.push(JSON.parse(String(init.body)));
		return Response.json({ ok: true });
	});
});
afterEach(() => vi.unstubAllGlobals());

function mail(headers: string, body = "Hello") {
	const raw = `${headers}\r\nTo: reply+rbob@r.me.test\r\nSubject: Hi\r\nContent-Type: text/plain\r\n\r\n${body}\r\n`;
	let rejected: string | null = null;
	const message = {
		to: "reply+rbob@r.me.test",
		raw: new Response(raw).body,
		setReject: (reason: string) => {
			rejected = reason;
		},
	} as unknown as ForwardableEmailMessage;
	return { message, rejected: () => rejected };
}

const PASS = "Authentication-Results: mx.cloudflare.net; spf=pass; dmarc=pass header.from=gmail.test";

describe("replying through a reverse alias", () => {
	it("sends the owner's reply as the alias", async () => {
		const { message, rejected } = mail(`${PASS}\r\nFrom: Owner <owner@gmail.test>`);
		await handleReverseAliasMail(message, { DB: db } as Env, config);
		expect(rejected()).toBeNull();
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ to: ["bob@store.test"], from: "shop@me.test" });
	});

	it("does not reveal another alias's correspondent", async () => {
		const { message } = mail(`${PASS}\r\nFrom: owner@gmail.test`, "see reply+rsecret@r.me.test and reply+rbob@r.me.test");
		await handleReverseAliasMail(message, { DB: db } as Env, config);
		expect(sent[0]?.text).toContain("reply+rsecret@r.me.test");
		expect(sent[0]?.text).toContain("bob@store.test");
		expect(sent[0]?.text).not.toContain("secret@private.test");
	});

	it("refuses forged senders, deleted or turned-off aliases and blocked correspondents", async () => {
		const cases: [string, () => Promise<unknown>][] = [
			[`${PASS}\r\nFrom: "<owner@gmail.test>"@evil.test`, async () => {}],
			[`${PASS}\r\nFrom: owner@gmail.test, evil@gmail.test`, async () => {}],
			["Authentication-Results: mx.cloudflare.net; dmarc=pass\r\nFrom: owner@gmail.test", async () => {}],
			[`${PASS}\r\nFrom: owner@gmail.test`, () => db.prepare("UPDATE aliases SET deleted_at = 5").run()],
			[`${PASS}\r\nFrom: owner@gmail.test`, () => db.prepare("UPDATE aliases SET deleted_at = NULL, forward_mode = 'none'").run()],
			[`${PASS}\r\nFrom: owner@gmail.test`, () => db.batch([db.prepare("UPDATE aliases SET forward_mode = 'all'"), db.prepare("UPDATE contacts SET blocked = 1")])],
		];
		for (const [headers, prepare] of cases) {
			await prepare();
			const { message, rejected } = mail(headers);
			await handleReverseAliasMail(message, { DB: db } as Env, config);
			expect(rejected(), headers).not.toBeNull();
		}
		expect(sent).toHaveLength(0);
	});
});
