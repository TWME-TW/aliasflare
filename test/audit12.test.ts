import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import type { AppEnv } from "../src/auth";
import { testDb } from "./helpers/d1";
import { signIn, TEST_SECRET } from "./helpers/session";

/** Regressions for the audit12 security review findings (dashboard form bodies). */

const ORIGIN = "https://alias.test";

function environment(): Env {
	return { DB: testDb(), SIGNING_SECRET: TEST_SECRET } as unknown as Env;
}

/** A request whose body has no Content-Length: Workers hand chunked bodies over this way. */
function chunkedRequest(path: string, cookie: string, contentType: string, bytes: Uint8Array): Request {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (let offset = 0; offset < bytes.length; offset += 16 * 1024) controller.enqueue(bytes.subarray(offset, offset + 16 * 1024));
			controller.close();
		},
	});
	return new Request(`${ORIGIN}${path}`, {
		method: "POST",
		headers: { Cookie: cookie, Origin: ORIGIN, "Sec-Fetch-Site": "same-origin", "Content-Type": contentType },
		body,
		duplex: "half",
	} as RequestInit);
}

describe("1. dashboard form bodies are bounded by what is read, not by Content-Length", () => {
	it("refuses a chunked body past the cap although it declares no length", async () => {
		const env = environment();
		const cookie = await signIn(env.DB);
		const big = new TextEncoder().encode(`note=${"a".repeat(600 * 1024)}`);
		const response = await app.fetch(chunkedRequest("/aliases/a%40b.test/note", cookie, "application/x-www-form-urlencoded", big), env);
		expect(response.status).toBe(413);
	});

	it("still accepts a body under the cap", async () => {
		const env = environment();
		const cookie = await signIn(env.DB);
		const body = new TextEncoder().encode("note=hello");
		const response = await app.fetch(chunkedRequest("/aliases/a%40b.test/note", cookie, "application/x-www-form-urlencoded", body), env);
		expect([200, 302, 404]).toContain(response.status);
	});
});

describe("2. only the client APIs and MCP are exempt from the form cap", () => {
	it("a dashboard route whose name starts with /api is capped too", async () => {
		const env = environment();
		const cookie = await signIn(env.DB);
		const body = new TextEncoder().encode(`name=${"a".repeat(2 * 1024 * 1024)}`);
		const response = await app.fetch(chunkedRequest("/api-keys", cookie, "application/x-www-form-urlencoded", body), env);
		expect(response.status).toBe(413);
	});
});

describe("3. a malformed form is refused, not a server error", () => {
	it("answers 400 for a multipart body that cannot be parsed", async () => {
		const env = environment();
		const cookie = await signIn(env.DB);
		const cases: [string, string][] = [
			["multipart/form-data", "a=1"],
			["multipart/form-data; boundary=", "a=1"],
			["multipart/form-data; boundary=xyz", "a=1"],
		];
		for (const [contentType, body] of cases) {
			const response = await app.fetch(
				new Request(`${ORIGIN}/settings`, {
					method: "POST",
					headers: { Cookie: cookie, Origin: ORIGIN, "Sec-Fetch-Site": "same-origin", "Content-Type": contentType },
					body,
				}),
				env,
			);
			expect({ contentType, status: response.status }).toEqual({ contentType, status: 400 });
		}
	});

	it("still reads a well-formed multipart form", async () => {
		const env = environment();
		const cookie = await signIn(env.DB);
		const boundary = "af-boundary";
		const body = `--${boundary}\r\nContent-Disposition: form-data; name="defaultDestination"\r\n\r\nme@home.test\r\n--${boundary}--\r\n`;
		const response = await app.fetch(
			new Request(`${ORIGIN}/settings`, {
				method: "POST",
				headers: { Cookie: cookie, Origin: ORIGIN, "Sec-Fetch-Site": "same-origin", "Content-Type": `multipart/form-data; boundary=${boundary}` },
				body,
			}),
			env,
		);
		expect([200, 302]).toContain(response.status);
	});
});

describe("4. the body check keeps what Cloudflare puts on the request", () => {
	it("hands the rebuilt request a body that can still be read as text", async () => {
		const env = environment();
		const response = await app.fetch(
			new Request(`${ORIGIN}/lang`, {
				method: "POST",
				headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/x-www-form-urlencoded" },
				body: "locale=ja&next=%2F",
			}),
			env,
		);
		expect(response.status).toBe(303);
		expect(response.headers.get("Location")).toBe("/");
		expect(response.headers.get("Set-Cookie")).toContain("af_lang=ja");
	});

	it("keeps cf available to the handlers, which record a new session's country", async () => {
		// The middleware swaps `c.req.raw` for one whose body it has read. Anything Cloudflare put
		// on the original has to be there still, or a new session records no country at all.
		const { Hono } = await import("hono");
		const { readFormBody } = await import("../src/index");
		const probe = new Hono<AppEnv>();
		probe.use("*", readFormBody);
		let seen: unknown = "the handler never ran";
		probe.post("/probe", (c) => {
			seen = (c.req.raw as { cf?: unknown }).cf;
			return c.text(`${c.req.raw.headers.get("X-Kept")}`);
		});
		const request = new Request(`${ORIGIN}/probe`, {
			method: "POST",
			headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded", "X-Kept": "yes" },
			body: "a=1",
		});
		Object.defineProperty(request, "cf", { value: { country: "JP" } });
		const response = await probe.fetch(request);
		expect(seen).toEqual({ country: "JP" });
		expect(await response.text()).toBe("yes");
	});
});
