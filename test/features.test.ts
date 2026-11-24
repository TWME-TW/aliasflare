import { describe, expect, it } from "vitest";
import { blocklistCandidates } from "../src/db";
import { dmarcFailedAtCloudflare, isPromotional } from "../src/forward";
import { cleanLink, cleanText, isTrackerImage } from "../src/trackers";
import { translator } from "../src/i18n";
import { bannerHtml, bannerText } from "../src/transform";

const img = (src: string | null, width: string | null = null, height: string | null = null, style: string | null = null) => ({
	src,
	width,
	height,
	style,
});

describe("tracker removal", () => {
	it("strips tracking parameters and keeps the rest", () => {
		const result = cleanLink("https://shop.example/item?id=42&utm_source=news&utm_medium=email&fbclid=abc&mc_eid=x");
		expect(result).toEqual({ href: "https://shop.example/item?id=42", changed: true });
	});

	it("leaves clean, relative and non-http links untouched", () => {
		expect(cleanLink("https://example.com/a?id=1").changed).toBe(false);
		expect(cleanLink("mailto:a@b.com?subject=utm_x").changed).toBe(false);
		expect(cleanLink("/relative?utm_source=x").changed).toBe(false);
	});

	it("recognises tracking pixels by size, style or known URL", () => {
		expect(isTrackerImage(img("https://x.com/a.gif", "1", "1"))).toBe(true);
		expect(isTrackerImage(img("https://x.com/a.gif", null, null, "width: 1px; height: 1px"))).toBe(true);
		expect(isTrackerImage(img("https://x.com/a.gif", null, null, "display:none"))).toBe(true);
		expect(isTrackerImage(img("https://us1.list-manage.com/track/open.php?u=1"))).toBe(true);
		expect(isTrackerImage(img("https://u1.sendgrid.net/wf/open?upn=abc", "600", "1"))).toBe(true);
	});

	it("keeps real images", () => {
		expect(isTrackerImage(img("https://cdn.example.com/logo.png", "120", "40"))).toBe(false);
		expect(isTrackerImage(img("https://cdn.example.com/hero.jpg"))).toBe(false);
		expect(isTrackerImage(img("https://cdn.example.com/spacer.gif", "1", "20"))).toBe(false);
	});

	it("cleans links in plain text", () => {
		const { text, removed } = cleanText("See https://a.com/x?utm_campaign=z and https://b.com/y.");
		expect(text).toBe("See https://a.com/x and https://b.com/y.");
		expect(removed).toBe(1);
	});
});

describe("promotional mail", () => {
	it("is mail sent to a list", () => {
		expect(isPromotional([{ key: "list-unsubscribe", value: "<https://x>" }])).toBe(true);
		expect(isPromotional([{ key: "List-Id", value: "news.example.com" }])).toBe(true);
		expect(isPromotional([{ key: "precedence", value: "bulk" }])).toBe(true);
		expect(isPromotional([{ key: "subject", value: "Your receipt" }])).toBe(false);
	});
});

describe("spoofing warning", () => {
	it("warns only on Cloudflare's explicit DMARC failure", () => {
		expect(dmarcFailedAtCloudflare("mx.cloudflare.net; spf=fail; dmarc=fail header.from=bank.com")).toBe(true);
		expect(dmarcFailedAtCloudflare("mx.cloudflare.net; dmarc=pass")).toBe(false);
		expect(dmarcFailedAtCloudflare("mx.cloudflare.net; dmarc=none")).toBe(false);
		expect(dmarcFailedAtCloudflare("evil.example; dmarc=fail")).toBe(false);
		expect(dmarcFailedAtCloudflare(null)).toBe(false);
	});
});

describe("blocklist matching", () => {
	it("covers the address, its domain and parent domains", () => {
		expect(blocklistCandidates("a@mail.news.example.com")).toEqual([
			"a@mail.news.example.com",
			"mail.news.example.com",
			"news.example.com",
			"example.com",
		]);
	});
});

describe("banner", () => {
	const info = {
		alias: "shop@mail.example.com",
		sender: 'Eve <eve@x.com>"><script>alert(1)</script>',
		blockUrl: "https://w.example/action/a",
		disableUrl: "https://w.example/action/b",
		spoofWarning: true,
	};

	it("escapes sender-controlled text", () => {
		const out = bannerHtml(info, 3, translator("en"));
		expect(out).not.toContain("<script>");
		expect(out).toContain("&lt;script&gt;");
		expect(out).toContain("3 tracker(s) removed");
		expect(out).toContain("did not pass DMARC");
	});

	it("has a plain-text form", () => {
		const out = bannerText({ ...info, spoofWarning: false }, 0, translator("en"));
		expect(out).toContain("Sent to shop@mail.example.com");
		expect(out).toContain("Block this sender: https://w.example/action/a");
		expect(out).not.toContain("WARNING");
	});
});
