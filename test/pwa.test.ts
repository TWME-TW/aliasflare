import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import { testDb } from "./helpers/d1";
import { signIn, TEST_SECRET } from "./helpers/session";

const ORIGIN = "https://alias.test";
const publicFile = (name: string) => join(__dirname, "..", "public", name);

describe("installing the dashboard as an app", () => {
	it("links the manifest and an Apple touch icon, and lets the browser load the manifest", async () => {
		const env = { DB: testDb(), SIGNING_SECRET: TEST_SECRET } as unknown as Env;
		const response = await app.fetch(new Request(`${ORIGIN}/`, { headers: { Cookie: await signIn(env.DB) } }), env);
		const page = await response.text();
		expect(page).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
		expect(page).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
		expect(response.headers.get("Content-Security-Policy")).toContain("manifest-src 'self'");
	});

	it("has a manifest a browser can install from, with every icon it names", () => {
		const manifest = JSON.parse(readFileSync(publicFile("manifest.webmanifest"), "utf8")) as {
			name: string;
			start_url: string;
			display: string;
			icons: { src: string; sizes: string; purpose: string }[];
		};
		expect(manifest.name).toBe("aliasflare");
		expect(manifest.start_url).toBe("/");
		expect(manifest.display).toBe("standalone");
		const sizes = manifest.icons.map((icon) => icon.sizes);
		expect(sizes).toContain("192x192");
		expect(sizes).toContain("512x512");
		expect(manifest.icons.some((icon) => icon.purpose === "maskable")).toBe(true);
		for (const icon of [...manifest.icons.map((entry) => entry.src), "/apple-touch-icon.png"]) {
			expect(existsSync(publicFile(icon.slice(1))), icon).toBe(true);
		}
	});
});
