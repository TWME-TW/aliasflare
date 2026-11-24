import { describe, expect, it } from "vitest";
import { presentedKey } from "../src/apikeys";
import { zoneCandidates } from "../src/cloudflare";
import { cleanPrefix, destinationIds, randomLocalPart } from "../src/compat/aliases";
import { reverseAddress, reverseLocalOf } from "../src/format";
import { normalizeSettings } from "../src/settings";

const headers = (entries: Record<string, string>) => new Headers(entries);

describe("reverse aliases use plus addressing", () => {
	it("builds and parses reply+<local>@domain", () => {
		expect(reverseAddress("ra_abc", "r.example.com")).toBe("reply+ra_abc@r.example.com");
		expect(reverseLocalOf("reply+ra_abc@r.example.com")).toBe("ra_abc");
		expect(reverseLocalOf("REPLY+RA_ABC@r.example.com")).toBe("ra_abc");
	});
	it("still understands the older bare form, but not the base address alone", () => {
		expect(reverseLocalOf("ra_abc@r.example.com")).toBe("ra_abc");
		expect(reverseLocalOf("reply@r.example.com")).toBeNull();
		expect(reverseLocalOf("reply+@r.example.com")).toBeNull();
	});
});

describe("API keys", () => {
	it("reads SimpleLogin's Authentication header and a Bearer token", () => {
		expect(presentedKey(headers({ Authentication: "mfa_abc" }))).toBe("mfa_abc");
		expect(presentedKey(headers({ Authorization: "Bearer mfa_xyz" }))).toBe("mfa_xyz");
	});
	it("ignores keys without the prefix", () => {
		expect(presentedKey(headers({ Authorization: "Bearer sk_live_123" }))).toBeNull();
		expect(presentedKey(headers({}))).toBeNull();
	});
});

describe("client helpers", () => {
	it("lists zone candidates from the domain up to the registrable name", () => {
		expect(zoneCandidates("r.mail.example.com")).toEqual(["r.mail.example.com", "mail.example.com", "example.com"]);
	});
	it("makes aliases in each format", () => {
		expect(randomLocalPart("uuid")).toMatch(/^[0-9a-f-]{36}$/);
		expect(randomLocalPart("random_characters")).toMatch(/^[a-z0-9]{10}$/);
		expect(randomLocalPart("random_words")).toMatch(/^[a-z]+\.[a-z]+\d{1,3}$/);
	});
	it("cleans prefixes from hostnames and user input", () => {
		expect(cleanPrefix("  Shop.Example!! ")).toBe("shop.example");
		expect(cleanPrefix("..--x--..")).toBe("x");
		expect(cleanPrefix("<script>")).toBe("script");
	});
	it("derives stable destination ids", async () => {
		const a = await destinationIds("you@gmail.com");
		expect(await destinationIds("you@gmail.com")).toEqual(a);
		expect(a.numId).toBeGreaterThan(0);
		expect(a.numId).toBeLessThan(2 ** 31);
		expect(a.uid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	});
	it("keeps the client APIs off unless turned on, and validates alias domains", () => {
		const settings = normalizeSettings({ aliasDomains: ["Mail.Example.com", "not a domain", "mail.example.com"] });
		expect(settings.simpleloginApi).toBe(false);
		expect(settings.addyApi).toBe(false);
		expect(settings.aliasDomains).toEqual(["mail.example.com"]);
	});
});
