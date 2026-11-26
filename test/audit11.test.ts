import { describe, expect, it } from "vitest";
import { app, safeLocalPath } from "../src/index";
import { testDb } from "./helpers/d1";
import { signIn, TEST_SECRET } from "./helpers/session";

const ORIGIN = "https://alias.test";

function environment(): Env {
	return { DB: testDb(), SIGNING_SECRET: TEST_SECRET } as unknown as Env;
}

describe("1. safeLocalPath only ever answers a path on this site", () => {
	it("keeps paths, queries and fragments", () => {
		expect(safeLocalPath("/")).toBe("/");
		expect(safeLocalPath("/?q=a&page=2")).toBe("/?q=a&page=2");
		expect(safeLocalPath("/aliases/a%40b.test#note")).toBe("/aliases/a%40b.test#note");
		expect(safeLocalPath("/a//b")).toBe("/a//b");
		expect(safeLocalPath("/%2f%2fevil.example")).toBe("/%2f%2fevil.example");
	});

	it("refuses a path that the URL parser turns into //another-host", () => {
		// Each of these resolves to the path "//evil.example", which a browser reads as another site.
		for (const value of ["//evil.example", "/..//evil.example", "/.//evil.example", "/a/..//evil.example", "/..///evil.example"]) {
			expect(safeLocalPath(value)).toBe("/");
		}
		for (const value of ["/\t/evil.example", "/\\evil.example", "https://evil.example", "/\n/evil", "", undefined]) {
			expect(safeLocalPath(value)).toBe("/");
		}
	});

	it("keeps /lang and /theme on this site whatever next says", async () => {
		const env = environment();
		for (const path of ["/lang", "/theme"]) {
			const response = await app.fetch(
				new Request(`${ORIGIN}${path}`, {
					method: "POST",
					headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
					body: `locale=en&theme=dark&next=${encodeURIComponent("/..//evil.example")}`,
				}),
				env,
			);
			expect(response.status).toBe(303);
			const location = new URL(response.headers.get("Location") ?? "", ORIGIN);
			expect(location.origin).toBe(ORIGIN);
			expect(location.pathname).toBe("/");
		}
	});
});

describe("2. a session is only as good as its passkey", () => {
	it("stops working once the passkey row is gone, even when the database does not cascade", async () => {
		const env = environment();
		const cookie = await signIn(env.DB);
		const settings = () => app.fetch(new Request(`${ORIGIN}/settings`, { headers: { Origin: ORIGIN, Cookie: cookie } }), env);
		expect((await settings()).status).toBe(200);

		// The "lost all your passkeys" recovery from the README, with foreign keys off: the
		// session row stays, and must still count for nothing.
		await env.DB.exec("PRAGMA foreign_keys = OFF");
		await env.DB.prepare("DELETE FROM passkeys").run();
		expect(Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())?.n)).toBe(1);
		expect((await settings()).status).toBe(302);
	});
});

/**
 * Routes anyone may call, and why. Everything else is the dashboard and must need a session, so a
 * new route cannot be added without protection and without a reviewer noticing it here.
 */
const PUBLIC_ROUTES: [RegExp, string][] = [
	[/^GET \/health$/, "uptime monitors"],
	[/^GET /.well-known/openpgpkey/(?:[^/]+/)?(?:hu/[^/]+|policy)$/, "Web Key Directory: public keys of aliases that publish one"],
	[/^GET \/(assets\/(?:app\.js|app\.css|passkey\.js)|favicon\.svg)$/, "static files"],
	[/^POST \/(?:lang|theme)$/, "language and theme, same-origin only"],
	[/^(?:GET|POST) \/(?:setup|login)(?:\/|$)/, "first-run setup and passkey sign-in"],
	[/^POST \/logout$/, "signing out"],
	[/^(?:GET|POST) \/(?:unsubscribe|action)\/[^/]+$/, "signed links in forwarded mail"],
	[/^POST \/webhook$/, "Mailflare, signed"],
	[/^(?:GET|POST|PUT|PATCH|DELETE|ALL|OPTIONS) \/(?:api|mcp)(?:\/|$)/, "client APIs and MCP, keyed"],
];

describe("3. every route is either public on purpose or needs a session", () => {
	it("refuses an unauthenticated request to every dashboard route", async () => {
		const env = environment();
		for (const route of app.routes) {
			if (route.path.includes("*")) continue;
			const line = `${route.method} ${route.path}`;
			if (PUBLIC_ROUTES.some(([pattern]) => pattern.test(line))) continue;
			const method = route.method === "ALL" ? "POST" : route.method;
			const url = `${ORIGIN}${route.path.replace(/:\w+/g, "x")}`;
			const response = await app.fetch(
				new Request(url, {
					method,
					headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
					body: method === "GET" || method === "HEAD" ? undefined : "a=1",
				}),
				env,
			);
			expect({ route: line, status: response.status }).toEqual({ route: line, status: method === "GET" ? 302 : 401 });
		}
	});
});
