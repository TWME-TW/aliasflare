import { describe, expect, it } from "vitest";
import {
	extractEmail,
	findAddressesOnDomain,
	formatSenderName,
	makeReverseLocal,
	parseMessageIds,
	replaceAddresses,
	sanitizeDisplayName,
} from "../src/format";

describe("formatSenderName", () => {
	it("renders every SimpleLogin format", () => {
		expect(formatSenderName("AT", "John Wick", "john@wick.com")).toBe("John Wick - john at wick.com");
		expect(formatSenderName("A", "John Wick", "john@wick.com")).toBe("John Wick - john(a)wick.com");
		expect(formatSenderName("NAME_ONLY", "John Wick", "john@wick.com")).toBe("John Wick");
		expect(formatSenderName("AT_ONLY", "John Wick", "john@wick.com")).toBe("john at wick.com");
		expect(formatSenderName("NO_NAME", "John Wick", "john@wick.com")).toBe("");
	});

	it("falls back to the address when there is no name", () => {
		expect(formatSenderName("AT", null, "john@wick.com")).toBe("john at wick.com");
		expect(formatSenderName("NAME_ONLY", "", "john@wick.com")).toBe("john at wick.com");
	});

	it("never lets a display name carry an address", () => {
		expect(sanitizeDisplayName('Bank <security@bank.com>\r\n"x"')).toBe("Bank securitybank.com x");
		expect(formatSenderName("NAME_ONLY", "a@b.com", "x@y.com")).not.toContain("@");
	});
});

describe("makeReverseLocal", () => {
	it("is random by default", () => {
		const local = makeReverseLocal("john@wick.com", false);
		expect(local).toMatch(/^ra_[a-z0-9]{16}$/);
		expect(local).not.toContain("john");
	});

	it("includes a readable sender when asked", () => {
		expect(makeReverseLocal("John.Wick+news@Wick.com", true)).toMatch(/^john_wick_news_at_wick_com_[a-z0-9]{8}$/);
	});

	it("stays short for long addresses", () => {
		expect(makeReverseLocal(`${"a".repeat(200)}@example.com`, true).length).toBeLessThanOrEqual(49);
	});
});

describe("extractEmail", () => {
	it("reads bare and named addresses", () => {
		expect(extractEmail("John <John@Wick.com>")).toBe("john@wick.com");
		expect(extractEmail(" a@b.co ")).toBe("a@b.co");
		expect(extractEmail("not an address")).toBeNull();
		expect(extractEmail(null)).toBeNull();
	});
});

describe("replaceAddresses", () => {
	const replacements = [
		{ from: "ra_abc@r.example.com", to: "john@wick.com" },
		{ from: "me@gmail.com", to: "shop@mail.example.com" },
	];

	it("replaces reverse aliases and the user's address, case-insensitively", () => {
		const body = "On Mon, John - john at wick.com <RA_ABC@r.example.com> wrote:\nCc me@gmail.com.";
		expect(replaceAddresses(body, replacements)).toBe(
			"On Mon, John - john at wick.com <john@wick.com> wrote:\nCc shop@mail.example.com.",
		);
	});

	it("does not touch longer addresses that merely contain one", () => {
		expect(replaceAddresses("xme@gmail.com me@gmail.com.au", replacements)).toBe("xme@gmail.com me@gmail.com.au");
	});

	it("works inside HTML", () => {
		expect(replaceAddresses('<a href="mailto:ra_abc@r.example.com">ra_abc@r.example.com</a>', replacements)).toBe(
			'<a href="mailto:john@wick.com">john@wick.com</a>',
		);
	});
});

describe("findAddressesOnDomain", () => {
	it("finds each reverse alias once", () => {
		expect(findAddressesOnDomain("a ra_x@r.example.com, RA_X@r.example.com b ra_y@r.example.com.", "r.example.com")).toEqual([
			"ra_x@r.example.com",
			"ra_y@r.example.com",
		]);
	});

	it("ignores other domains and subdomains", () => {
		expect(findAddressesOnDomain("ra_x@r.example.com.evil.net ra_y@xr.example.com", "r.example.com")).toEqual([]);
	});
});

describe("parseMessageIds", () => {
	it("reads ids from header values", () => {
		expect(parseMessageIds("<a@b> <c@d>\r\n <e@f>")).toEqual(["<a@b>", "<c@d>", "<e@f>"]);
		expect(parseMessageIds(undefined)).toEqual([]);
	});
});
