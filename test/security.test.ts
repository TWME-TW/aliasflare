import { describe, expect, it } from "vitest";
import { hmacHex, signToken, verifyToken, verifyWebhookSignature } from "../src/crypto";
import { usableUnsubscribe } from "../src/forward";
import { dmarcPassedByCloudflare, firstAuthenticationResults } from "../src/reply";
import { normalizeSettings } from "../src/settings";

const SECRET = "0123456789abcdef0123456789abcdef";

describe("webhook signature", () => {
	it("accepts Mailflare's hex HMAC and rejects anything else", async () => {
		const body = '{"type":"message.inbound"}';
		const signature = await hmacHex(SECRET, body);
		expect(await verifyWebhookSignature(SECRET, body, signature)).toBe(true);
		expect(await verifyWebhookSignature(SECRET, body, signature.toUpperCase())).toBe(true);
		expect(await verifyWebhookSignature(SECRET, `${body} `, signature)).toBe(false);
		expect(await verifyWebhookSignature(SECRET, body, null)).toBe(false);
		expect(await verifyWebhookSignature("other-secret", body, signature)).toBe(false);
	});
});

describe("signed tokens", () => {
	it("round-trips and is bound to its purpose", async () => {
		const token = await signToken(SECRET, "unsubscribe", "fw_123", 60);
		expect(await verifyToken(SECRET, "unsubscribe", token)).toBe("fw_123");
		expect(await verifyToken(SECRET, "session", token)).toBeNull();
		expect(await verifyToken("x".repeat(32), "unsubscribe", token)).toBeNull();
	});

	it("rejects tampered and expired tokens", async () => {
		const token = await signToken(SECRET, "unsubscribe", "fw_123", 60);
		const [, expires, mac] = token.split(".");
		expect(await verifyToken(SECRET, "unsubscribe", `fw_999.${expires}.${mac}`)).toBeNull();
		expect(await verifyToken(SECRET, "unsubscribe", `fw_123.${Number(expires) + 1000}.${mac}`)).toBeNull();
		const expired = await signToken(SECRET, "unsubscribe", "fw_123", -1);
		expect(await verifyToken(SECRET, "unsubscribe", expired)).toBeNull();
	});
});

describe("Authentication-Results", () => {
	it("trusts only the first header, and only from Cloudflare", () => {
		const headers = [
			"Authentication-Results: mx.cloudflare.net;",
			" dkim=pass header.d=gmail.com; spf=pass; dmarc=pass header.from=gmail.com",
			"Authentication-Results: mx.cloudflare.net; dmarc=fail",
			"From: me@gmail.com",
		].join("\r\n");
		expect(dmarcPassedByCloudflare(firstAuthenticationResults(headers))).toBe(true);
	});

	it("rejects a forged header placed by the sender", () => {
		const headers = ["Authentication-Results: mx.cloudflare.net; dmarc=fail", "Authentication-Results: mx.cloudflare.net; dmarc=pass"].join("\n");
		expect(dmarcPassedByCloudflare(firstAuthenticationResults(headers))).toBe(false);
		expect(dmarcPassedByCloudflare("evil.example; dmarc=pass")).toBe(false);
		expect(dmarcPassedByCloudflare("mx.cloudflare.net; dmarc=passive")).toBe(false);
		expect(dmarcPassedByCloudflare(null)).toBe(false);
	});

	it("requires the evaluated From domain to be the user's", () => {
		const value = "mx.cloudflare.net; spf=pass; dmarc=pass header.from=evil.example";
		expect(dmarcPassedByCloudflare(value, "gmail.com")).toBe(false);
		expect(dmarcPassedByCloudflare(value, "evil.example")).toBe(true);
	});
});

describe("usableUnsubscribe", () => {
	it("keeps https and mailto, drops the rest", () => {
		expect(usableUnsubscribe("<http://x.com/u>, <https://x.com/u>, <mailto:u@x.com?subject=bye>")).toBe(
			"<https://x.com/u>, <mailto:u@x.com?subject=bye>",
		);
		expect(usableUnsubscribe("<http://x.com/u>")).toBeNull();
		expect(usableUnsubscribe(null)).toBeNull();
	});
});

describe("normalizeSettings", () => {
	it("falls back to defaults for unknown values", () => {
		const settings = normalizeSettings({ senderFormat: "EVIL", unsubscribeBehavior: "drop_db", reverseAliasReplacement: "yes" });
		expect(settings.senderFormat).toBe("AT");
		expect(settings.unsubscribeBehavior).toBe("disable_alias");
		expect(settings.reverseAliasReplacement).toBe(true);
	});
});
