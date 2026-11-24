import { afterEach, describe, expect, it, vi } from "vitest";
import { addSimpleLoginContacts, fetchAddy, fetchSimpleLogin, ImportError, parseAliasCsv, parseCsv, selectByDomain, toTimestamp } from "../src/importer";

describe("parseCsv", () => {
	it("handles quotes, doubled quotes, commas, newlines in fields and CRLF", () => {
		expect(parseCsv('a,b\r\n"x, y","say ""hi""\nthere"\r\n\r\n')).toEqual([
			["a", "b"],
			["x, y", 'say "hi"\nthere'],
		]);
	});
	it("drops a byte order mark", () => {
		expect(parseCsv("﻿alias\nx@y.z")).toEqual([["alias"], ["x@y.z"]]);
	});
});

describe("parseAliasCsv", () => {
	it("reads SimpleLogin's export", () => {
		const rows = parseAliasCsv("alias,note,enabled,mailboxes\nshop@me.com,Shopping,True,a@gmail.com b@gmail.com\nold@me.com,,False,a@gmail.com\n");
		expect(rows.map(({ email, note, enabled, destination, details }) => ({ email, note, enabled, destination, details }))).toEqual([
			{ email: "shop@me.com", note: "Shopping", enabled: true, destination: "a@gmail.com", details: { mailboxes: ["a@gmail.com", "b@gmail.com"] } },
			{ email: "old@me.com", note: null, enabled: false, destination: "a@gmail.com", details: {} },
		]);
	});

	it("reads addy.io's export with its counts and dates, and skips deleted aliases", () => {
		const rows = parseAliasCsv(
			"id,local_part,domain,email,active,description,from_name,emails_forwarded,emails_blocked,emails_replied,emails_sent,last_forwarded,created_at,deleted_at\n" +
				"1,news,me.com,news@me.com,1,Newsletters,News Me,12,3,2,1,2026-02-03 04:05:06,2025-01-01 00:00:00,\n" +
				"2,gone,me.com,gone@me.com,0,,,0,0,0,0,,2025-01-01 00:00:00,2026-01-01 00:00:00\n",
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			email: "news@me.com",
			note: "Newsletters",
			name: "News Me",
			enabled: true,
			forwarded: 12,
			blocked: 3,
			replied: 2,
			sent: 1,
			lastForwardAt: Date.UTC(2026, 1, 3, 4, 5, 6) / 1000,
			createdAt: Date.UTC(2025, 0, 1) / 1000,
		});
	});

	it("rejects a file without an address column", () => {
		expect(() => parseAliasCsv("foo,bar\n1,2")).toThrow(ImportError);
	});
});

describe("API importers", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("pages through SimpleLogin and keeps everything it reports", async () => {
		const seen: string[] = [];
		vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
			seen.push(`${url} ${(init.headers as Record<string, string>).Authentication}`);
			const page = Number(new URL(url).searchParams.get("page_id"));
			const aliases =
				page === 0
					? [
							{
								id: 7,
								email: "a@me.com",
								enabled: false,
								note: "n",
								name: "A",
								pinned: true,
								creation_timestamp: 1700000000,
								nb_forward: 5,
								nb_block: 1,
								nb_reply: 2,
								support_pgp: true,
								disable_pgp: false,
								latest_activity: { action: "reply", timestamp: 1710000000, contact: { email: "bob@shop.com", name: "Bob" } },
								mailboxes: [{ email: "x@gmail.com" }, { email: "y@gmail.com" }],
							},
						]
					: [];
			return Response.json({ aliases });
		});
		const rows = await fetchSimpleLogin("https://sl.test", "key1");
		expect(seen).toEqual(["https://sl.test/api/v2/aliases?page_id=0 key1", "https://sl.test/api/v2/aliases?page_id=1 key1"]);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			email: "a@me.com",
			note: "n",
			name: "A",
			enabled: false,
			pinned: true,
			destination: "x@gmail.com",
			createdAt: 1700000000,
			forwarded: 5,
			blocked: 1,
			replied: 2,
			lastReplyAt: 1710000000,
			lastForwardAt: null,
			sourceId: 7,
			details: {
				id: 7,
				mailboxes: ["x@gmail.com", "y@gmail.com"],
				pgp: "on",
				latest_activity: { action: "reply", at: 1710000000, contact: "bob@shop.com", contact_name: "Bob" },
			},
		});
	});

	it("fetches SimpleLogin contacts only for aliases with activity", async () => {
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (url: string) => {
			urls.push(url);
			return Response.json({
				contacts: url.includes("page_id=0")
					? [{ contact: '"Bob Shop" <bob@shop.com>', creation_timestamp: 1700000000, last_email_sent_timestamp: 1710000000, block_forward: true }]
					: [],
			});
		});
		const busy = { ...parseAliasCsv("alias\nbusy@me.com")[0]!, sourceId: 1, forwarded: 3 };
		const quiet = { ...parseAliasCsv("alias\nquiet@me.com")[0]!, sourceId: 2 };
		await addSimpleLoginContacts("https://sl.test", "k", [busy, quiet]);
		expect(urls).toEqual(["https://sl.test/api/aliases/1/contacts?page_id=0"]);
		expect(busy.contacts).toEqual([{ email: "bob@shop.com", name: "Bob Shop", createdAt: 1700000000, lastSentAt: 1710000000, blocked: true }]);
		expect(quiet.contacts).toBeUndefined();
	});

	it("pages through addy.io until the last page", async () => {
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			calls += 1;
			return Response.json({
				data: [{ email: `a${calls}@me.com`, active: true, description: null, recipients: [], emails_sent: 4, last_sent: "2026-01-02 03:04:05" }],
				meta: { last_page: 2 },
			});
		});
		const rows = await fetchAddy("https://addy.test", "key2");
		expect(calls).toBe(2);
		expect(rows.map((row) => row.email)).toEqual(["a1@me.com", "a2@me.com"]);
		expect(rows[0]).toMatchObject({ sent: 4, lastSentAt: Date.UTC(2026, 0, 2, 3, 4, 5) / 1000 });
	});

	it("reports a refused key", async () => {
		vi.stubGlobal("fetch", async () => new Response("no", { status: 401 }));
		await expect(fetchAddy("https://addy.test", "bad")).rejects.toMatchObject({ reason: "auth" });
	});
});

describe("toTimestamp", () => {
	it("reads seconds, milliseconds, ISO dates and zone-less dates as UTC", () => {
		expect(toTimestamp(1700000000)).toBe(1700000000);
		expect(toTimestamp("1700000000000")).toBe(1700000000);
		expect(toTimestamp("2026-02-03 04:05:06")).toBe(Date.UTC(2026, 1, 3, 4, 5, 6) / 1000);
		expect(toTimestamp("2026-02-03T04:05:06+08:00")).toBe(Date.UTC(2026, 1, 2, 20, 5, 6) / 1000);
		expect(toTimestamp("")).toBeNull();
		expect(toTimestamp("soon")).toBeNull();
	});
});

describe("selectByDomain", () => {
	it("keeps chosen domains, removes duplicates and counts the rest", () => {
		const rows = parseAliasCsv("alias\nA@Me.com\na@me.com\nx@simplelogin.com\ny@simplelogin.com\nr@r.me.com");
		const { chosen, skippedDomains } = selectByDomain(rows, ["me.com", "r.me.com"], "r.me.com");
		expect(chosen.map((alias) => alias.email)).toEqual(["a@me.com"]);
		expect(skippedDomains).toEqual([
			{ domain: "simplelogin.com", count: 2 },
			{ domain: "r.me.com", count: 1 },
		]);
	});
});
