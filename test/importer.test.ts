import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAddy, fetchSimpleLogin, ImportError, parseAliasCsv, parseCsv } from "../src/importer";

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
		expect(rows).toEqual([
			{ email: "shop@me.com", note: "Shopping", name: null, enabled: true, pinned: false, destination: "a@gmail.com" },
			{ email: "old@me.com", note: null, name: null, enabled: false, pinned: false, destination: "a@gmail.com" },
		]);
	});
	it("reads addy.io's export and skips deleted aliases", () => {
		const rows = parseAliasCsv(
			"id,local_part,domain,email,active,description,from_name,deleted_at\n" +
				"1,news,me.com,news@me.com,1,Newsletters,News Me,\n" +
				"2,gone,me.com,gone@me.com,0,,,2026-01-01 00:00:00\n",
		);
		expect(rows).toEqual([{ email: "news@me.com", note: "Newsletters", name: "News Me", enabled: true, pinned: false, destination: null }]);
	});
	it("rejects a file without an address column", () => {
		expect(() => parseAliasCsv("foo,bar\n1,2")).toThrow(ImportError);
	});
});

describe("API importers", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("pages through SimpleLogin until an empty page", async () => {
		const seen: string[] = [];
		vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
			seen.push(`${url} ${(init.headers as Record<string, string>).Authentication}`);
			const page = Number(new URL(url).searchParams.get("page_id"));
			const aliases = page === 0 ? [{ email: "a@me.com", enabled: false, note: "n", name: "A", pinned: true, mailboxes: [{ email: "x@gmail.com" }] }] : [];
			return Response.json({ aliases });
		});
		const rows = await fetchSimpleLogin("https://sl.test", "key1");
		expect(seen).toEqual(["https://sl.test/api/v2/aliases?page_id=0 key1", "https://sl.test/api/v2/aliases?page_id=1 key1"]);
		expect(rows).toEqual([{ email: "a@me.com", note: "n", name: "A", enabled: false, pinned: true, destination: "x@gmail.com" }]);
	});

	it("pages through addy.io until the last page", async () => {
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			calls += 1;
			return Response.json({
				data: [{ email: `a${calls}@me.com`, active: true, description: null, recipients: [] }],
				meta: { last_page: 2 },
			});
		});
		const rows = await fetchAddy("https://addy.test", "key2");
		expect(calls).toBe(2);
		expect(rows.map((row) => row.email)).toEqual(["a1@me.com", "a2@me.com"]);
	});

	it("reports a refused key", async () => {
		vi.stubGlobal("fetch", async () => new Response("no", { status: 401 }));
		await expect(fetchAddy("https://addy.test", "bad")).rejects.toMatchObject({ reason: "auth" });
	});
});
