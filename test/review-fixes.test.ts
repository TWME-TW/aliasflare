import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { calendarOrganizers, carriesAddresses, rewriteAttachment } from "../src/attachments";
import { CATCH_ALL_NOTE, ensureAlias, ensureContact } from "../src/db";
import { handleInbound, MAX_NEW_ALIASES_FROM_MAIL_PER_DAY } from "../src/forward";
import { checkSetupCode, issueSetupCode } from "../src/passkeys";
import type { AppConfig } from "../src/config";
import { findAddressesOnDomain } from "../src/format";
import { stripSignedLinks } from "../src/reply";
import { loadSettings, saveSettings } from "../src/settings";
import { testDb } from "./helpers/d1";
import { TEST_SECRET } from "./helpers/session";

/** Findings of the independent review (M1-M3). */
let db: D1Database;
let env: Env;
let sent: { attachments?: { filename: string; content: ArrayBuffer | string }[] }[];

beforeEach(async () => {
	db = testDb();
	sent = [];
	env = {
		DB: db,
		SIGNING_SECRET: TEST_SECRET,
		EMAIL: { send: async (message: (typeof sent)[number]) => (sent.push(message), { messageId: `<s${sent.length}@test>` }) },
	} as unknown as Env;
	await saveSettings(db, { ...(await loadSettings(db)), aliasDomains: ["a.test"], defaultDestination: "owner@gmail.test", autoForwardNewAliases: true });
	await db.prepare("INSERT INTO config (key, value) VALUES ('siteOrigin', 'https://alias.test')").run();
});

const text = (content: ArrayBuffer | string) => (typeof content === "string" ? content : new TextDecoder().decode(content));

describe("M1. aliases created by incoming mail", () => {
	it("follow the default forwarding address instead of copying it", async () => {
		const alias = await ensureAlias(db, "new@a.test", "", { forwardEnabled: true });
		expect(alias.destination).toBeNull();
	});

	it("are moved back to the default by the migration when they hold the current one", async () => {
		await db
			.prepare(
				`INSERT INTO aliases (address, num_id, uid, destination, note, created_at, updated_at) VALUES
				('a@a.test', 1, 'u1', 'owner@gmail.test', 'Created by catchall option', 1, 1),
				('b@a.test', 2, 'u2', 'old@gmail.test', 'Created by catchall option', 1, 1),
				('c@a.test', 3, 'u3', 'owner@gmail.test', 'mine', 1, 1)`,
			)
			.run();
		const sql = readFileSync(join(__dirname, "..", "migrations", "0007_catchall_default_destination.sql"), "utf8");
		await db.prepare(sql.replace(/^--.*$/gm, "").trim()).run();
		const { results } = await db.prepare("SELECT address, destination FROM aliases ORDER BY address").all();
		expect(results).toEqual([
			{ address: "a@a.test", destination: null },
			{ address: "b@a.test", destination: "old@gmail.test" },
			{ address: "c@a.test", destination: "owner@gmail.test" },
		]);
	});
});

describe("M2. scanning a large reply", () => {
	it("finds addresses in linear time with the same results", () => {
		expect(findAddressesOnDomain("Write to Bob+x@R.a.test, or <x.y@r.a.test>. Not z@r.a.testing or w@r.a.test.com", "r.a.test")).toEqual(["bob+x@r.a.test", "x.y@r.a.test"]);
		expect(findAddressesOnDomain("mailto%3Ab@r.a.test", "r.a.test")).toEqual(["b@r.a.test"]);
		const started = performance.now();
		findAddressesOnDomain("a".repeat(300_000), "r.a.test");
		findAddressesOnDomain("a.".repeat(150_000) + "@r.a.test", "r.a.test");
		expect(performance.now() - started).toBeLessThan(500);
	});

	it("removes signed links in linear time with the same results", () => {
		const token = `fw_${"0".repeat(32)}.123.abc_DEF`;
		expect(stripSignedLinks(`see https://x.test/a/action/block~${token} and <http://h/unsubscribe/${token}>`)).toBe("see [link removed] and <[link removed]>");
		expect(stripSignedLinks(`path only /action/${token}`)).toBe("path only /action/[link removed]");
		const started = performance.now();
		stripSignedLinks("https://x".repeat(40_000));
		stripSignedLinks(`https://${"a/".repeat(100_000)}action/x`);
		expect(performance.now() - started).toBeLessThan(500);
	});
});

const ICS = (organizer: string, attendee: string) =>
	["BEGIN:VCALENDAR", "METHOD:REQUEST", "BEGIN:VEVENT", `ORGANIZER;CN=Bob:mailto:${organizer}`, `ATTENDEE;CN=Very Long Attendee Name;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailt\r\n o:${attendee}`, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");

describe("M3. calendar invitations and attached messages", () => {
	it("are recognised and rewritten, folded lines included", () => {
		expect(carriesAddresses("text/calendar", "x")).toBe("calendar");
		expect(carriesAddresses("application/octet-stream", "invite.ics")).toBe("calendar");
		expect(carriesAddresses("message/rfc822", "x")).toBe("message");
		expect(carriesAddresses("image/png", "a.png")).toBeNull();
		const ics = new TextEncoder().encode(ICS("bob@store.test", "owner@gmail.test")).buffer as ArrayBuffer;
		expect(calendarOrganizers(ics)).toEqual(["bob@store.test"]);
		const out = text(rewriteAttachment(ics, "calendar", [{ from: "owner@gmail.test", to: "shop@a.test" }]));
		expect(out).not.toContain("owner@gmail.test");
		expect(out).toContain("mailto:shop@a.test");
		const eml = new TextEncoder().encode("From: Owner <owner@gmail.test>\r\nTo: x@y.test\r\n\r\nhi owner@gmail.test\r\n").buffer as ArrayBuffer;
		expect(text(rewriteAttachment(eml, "message", [{ from: "owner@gmail.test", to: "shop@a.test" }]))).toBe("From: Owner <shop@a.test>\r\nTo: x@y.test\r\n\r\nhi shop@a.test\r\n");
	});

	it("forwarded: the organizer becomes a reverse alias, so the answer comes back through the Worker", async () => {
		const raw = [
			"From: Bob <bob@store.test>",
			"To: shop@a.test",
			"Subject: Meeting",
			"Message-ID: <m1@store.test>",
			"MIME-Version: 1.0",
			'Content-Type: multipart/mixed; boundary="b"',
			"",
			"--b",
			"Content-Type: text/plain",
			"",
			"Join us",
			"--b",
			'Content-Type: text/calendar; method=REQUEST; name="invite.ics"',
			'Content-Disposition: attachment; filename="invite.ics"',
			"",
			ICS("bob@store.test", "shop@a.test"),
			"--b--",
			"",
		].join("\r\n");
		const headers = new Headers({ From: "Bob <bob@store.test>", To: "shop@a.test" });
		await worker.email!(
			{ to: "shop@a.test", from: "bob@store.test", headers, raw: new Response(raw).body, rawSize: raw.length, forward: async () => {}, setReject: () => {} } as never,
			env,
		);
		const contact = await db.prepare("SELECT reverse_local FROM contacts WHERE email = 'bob@store.test'").first<{ reverse_local: string }>();
		expect(contact).not.toBeNull();
		const invite = sent[0]?.attachments?.find((attachment) => attachment.filename === "invite.ics");
		expect(invite).toBeDefined();
		const body = text(invite!.content);
		expect(body).not.toContain("mailto:bob@store.test");
		const organizer = body.split(/\r?\n/).find((line) => line.startsWith("ORGANIZER"));
		expect(organizer).toContain(`${contact!.reverse_local}@r.a.test`);
	});
});

describe("L2-L5", () => {
	it("L2: a permanently deleted alias's or contact's number is not handed out again", async () => {
		const first = await ensureAlias(db, "x1@a.test", "", { forwardEnabled: true });
		const second = await ensureAlias(db, "x2@a.test", "", { forwardEnabled: true });
		await db.prepare("DELETE FROM aliases WHERE address = 'x2@a.test'").run();
		const third = await ensureAlias(db, "x3@a.test", "", { forwardEnabled: true });
		expect(third.num_id).toBeGreaterThan(second.num_id);
		expect(second.num_id).toBeGreaterThan(first.num_id);
		const c1 = await ensureContact(db, "x1@a.test", "p@q.test", null, false);
		await db.prepare("DELETE FROM contacts WHERE id = ?").bind(c1.id).run();
		const c2 = await ensureContact(db, "x1@a.test", "r@q.test", null, false);
		expect(c2.num_id).toBeGreaterThan(c1.num_id);
	});

	it("L3 + L5: incoming mail creates aliases only on an alias domain, and at most so many a day", async () => {
		const config = { mailflareUrl: "https://mailflare.test", mailflareApiKey: "k", webhookSecret: "w" } as AppConfig;
		const other = await handleInbound(env, config, { messageId: "m1", to: "x@elsewhere.test", from: "s@t.test" } as never, "https://alias.test");
		expect(other.result).toBe("skipped: no such alias");
		expect(await db.prepare("SELECT COUNT(*) AS n FROM aliases").first()).toEqual({ n: 0 });

		const values = Array.from({ length: MAX_NEW_ALIASES_FROM_MAIL_PER_DAY }, (_, i) => `('n${i}@a.test', ${i + 1}, 'u${i}', '${CATCH_ALL_NOTE}', ${Math.floor(Date.now() / 1000)}, 1)`);
		await db.prepare(`INSERT INTO aliases (address, num_id, uid, note, created_at, updated_at) VALUES ${values.join(", ")}`).run();
		const full = await handleInbound(env, config, { messageId: "m2", to: "fresh@a.test", from: "s@t.test" } as never, "https://alias.test");
		expect(full.result).toBe("skipped: no such alias");
		expect(await db.prepare("SELECT 1 FROM aliases WHERE address = 'fresh@a.test'").first()).toBeNull();
	});

	it("L4: asking for a new setup code does not end the earlier one", async () => {
		const codes: string[] = [];
		const log = console.log;
		console.log = (line: string) => void codes.push(String(line).match(/Setup code: (\w+)/)?.[1] ?? "");
		try {
			await issueSetupCode(db);
			await db.prepare("UPDATE auth_challenges SET expires_at = expires_at - 120 WHERE purpose = 'setup'").run();
			expect((await issueSetupCode(db, true)).created).toBe(true);
		} finally {
			console.log = log;
		}
		expect(codes.filter(Boolean)).toHaveLength(2);
		for (const code of codes) expect(await checkSetupCode(env, code)).toBe(true);
		expect(await checkSetupCode(env, "WRONG")).toBe(false);
	});
});
