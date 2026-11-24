import { describe, expect, it } from "vitest";
import { boundedList, blocklistCandidates } from "../src/db";
import { replaceAddresses } from "../src/format";
import { safeLocalPath } from "../src/index";
import { authResultClauses, dmarcPassedByCloudflare, singleSender } from "../src/reply";

describe("Authentication-Results parsing (issue #1, items 2-3)", () => {
	it("ignores semicolons and dmarc=pass inside quoted strings and comments", () => {
		const quoted = 'mx.cloudflare.net; spf=pass smtp.mailfrom="a; dmarc=pass header.from=gmail.com; b"@attacker.com; dmarc=fail header.from=gmail.com';
		expect(dmarcPassedByCloudflare(quoted, "gmail.com")).toBe(false);
		const comment = "mx.cloudflare.net; spf=pass (x; dmarc=pass header.from=gmail.com; y); dmarc=fail header.from=gmail.com";
		expect(dmarcPassedByCloudflare(comment, "gmail.com")).toBe(false);
		expect(authResultClauses('a; b="x;y" (c;d); e')).toEqual(["a", 'b="x;y"', "e"]);
	});
	it("needs exactly one DMARC result, naming the expected domain", () => {
		expect(dmarcPassedByCloudflare("mx.cloudflare.net; dmarc=pass header.from=gmail.com", "gmail.com")).toBe(true);
		expect(dmarcPassedByCloudflare("mx.cloudflare.net; dmarc=pass", "gmail.com")).toBe(false);
		expect(dmarcPassedByCloudflare("mx.cloudflare.net; dmarc=pass header.from=gmail.com; dmarc=fail header.from=gmail.com", "gmail.com")).toBe(false);
	});
});

describe("singleSender (issue #1, item 2)", () => {
	it("accepts one plain mailbox", () => {
		expect(singleSender('From: "Me" <me@gmail.com>\nTo: x@y.z', "me@gmail.com")).toBe("me@gmail.com");
	});
	it("refuses quoted local parts, lists, groups, two From headers and a different Sender", () => {
		expect(singleSender('From: "<victim@gmail.com>"@attacker.com', '"<victim@gmail.com>"@attacker.com')).toBeNull();
		expect(singleSender("From: victim@shared.org, attacker@shared.org", "victim@shared.org")).toBeNull();
		expect(singleSender("From: team: victim@shared.org;", "victim@shared.org")).toBeNull();
		expect(singleSender("From: victim@shared.org\nFrom: attacker@shared.org", "victim@shared.org")).toBeNull();
		expect(singleSender("From: victim@shared.org\nSender: attacker@shared.org", "victim@shared.org")).toBeNull();
		expect(singleSender("From: victim@shared.org\nSender: Victim <victim@shared.org>", "victim@shared.org")).toBe("victim@shared.org");
	});
});

describe("replaceAddresses (issue #1, item 10)", () => {
	it("inserts $ patterns as text", () => {
		expect(replaceAddresses("to r1@r.me.com now", [{ from: "r1@r.me.com", to: "a$&b$`@x.com" }])).toBe("to a$&b$`@x.com now");
	});
});

describe("D1 parameter limits (issue #1, item 11)", () => {
	it("de-duplicates and caps IN lists", () => {
		expect(boundedList(["a", "a", "b"])).toEqual(["a", "b"]);
		expect(boundedList(Array.from({ length: 500 }, (_, i) => `id${i}`))).toHaveLength(80);
	});
	it("caps blocklist candidates for a crafted domain", () => {
		expect(blocklistCandidates(`x@${"a.".repeat(300)}com`).length).toBeLessThanOrEqual(61);
	});
});

describe("safeLocalPath (issue #1, item 21)", () => {
	it("keeps local paths and refuses anything a browser could read as another site", () => {
		expect(safeLocalPath("/?q=a&page=2")).toBe("/?q=a&page=2");
		expect(safeLocalPath("/settings#x")).toBe("/settings#x");
		for (const bad of ["//evil.example", "/\t/evil.example", "/\\evil.example", "https://evil.example", "/\n/evil", "", undefined]) {
			expect(safeLocalPath(bad)).toBe("/");
		}
	});
});
