import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { sameOrigin } from "../src/auth";

const app = new Hono();
app.post("/x", (c) => c.text(sameOrigin(c) ? "ok" : "no"));

async function check(headers: Record<string, string>): Promise<string> {
	const res = await app.request("https://alias.example.com/x", { method: "POST", headers });
	return res.text();
}

describe("sameOrigin", () => {
	it("accepts a matching Origin", async () => {
		expect(await check({ Origin: "https://alias.example.com" })).toBe("ok");
	});
	it("rejects another Origin", async () => {
		expect(await check({ Origin: "https://evil.example.net" })).toBe("no");
	});
	it("accepts Origin: null only when Sec-Fetch-Site says same-origin", async () => {
		expect(await check({ Origin: "null", "Sec-Fetch-Site": "same-origin" })).toBe("ok");
		expect(await check({ Origin: "null", "Sec-Fetch-Site": "cross-site" })).toBe("no");
		expect(await check({ Origin: "null" })).toBe("no");
	});
	it("rejects a cross-site request without Origin", async () => {
		expect(await check({ "Sec-Fetch-Site": "cross-site" })).toBe("no");
	});
});
