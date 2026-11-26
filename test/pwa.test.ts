import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
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

	it("gives the files Cloudflare serves itself the same baseline headers as the Worker", () => {
		// These never pass through the Worker, so `_headers` is the only place they can get them.
		const headers = readFileSync(publicFile("_headers"), "utf8");
		expect(headers).toContain("X-Content-Type-Options: nosniff");
		expect(headers).toContain("Referrer-Policy: same-origin");
		expect(headers).toContain("Content-Security-Policy: default-src 'none'");
		expect(headers).toContain("frame-ancestors 'none'");
	});

	it("takes no path from the Worker: an asset would be served in its place", () => {
		// `assets` in wrangler.jsonc hands public/ to Cloudflare, which answers those paths itself,
		// without running the Worker. A file named like a route (or under /assets/, /api or /mcp)
		// would silently replace it, dashboard session and its headers included, so adding one has
		// to fail here first.
		const files: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				// `_headers` is read by Cloudflare and never served, so it is not a path of its own.
				else if (relative(join(__dirname, "..", "public"), full) !== "_headers") files.push(`/${relative(join(__dirname, "..", "public"), full).split("\\").join("/")}`);
			}
		};
		walk(join(__dirname, "..", "public"));

		const workerPaths = new Set(app.routes.map((route) => route.path));
		const RESERVED = ["/assets/", "/api", "/mcp", "/webhook", "/unsubscribe/", "/action/", "/setup", "/login", "/logout", "/health"];
		const clashes = files.filter((file) => workerPaths.has(file) || RESERVED.some((prefix) => file === prefix || file.startsWith(prefix)));
		expect(clashes).toEqual([]);
	});
});
