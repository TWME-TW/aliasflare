import * as openpgp from "openpgp";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiKey } from "../src/apikeys";
import { setUpDomain } from "../src/cloudflare";
import { APP_SCRIPT } from "../src/client";
import { saveConfig } from "../src/config";
import { ensureAlias } from "../src/db";
import { FREE_PLAN_REWRITE_BYTES, isInlinePgpArmor } from "../src/forward";
import worker, { app } from "../src/index";
import { pgpKind, topEntity } from "../src/mime";
import { loadSettings, saveSettings } from "../src/settings";
import { wkdHash } from "../src/wkd";
import { testDb } from "./helpers/d1";
import { signIn, TEST_SECRET } from "./helpers/session";

/** Regressions for audit14 code & security review findings. */
const ORIGIN = "https://alias.test";
const ENCRYPTED_PART = "-----BEGIN PGP MESSAGE-----\r\n\r\nwV4DAAAAAAAAAAASAQdAexample\r\n=abcd\r\n-----END PGP MESSAGE-----";

let publicKey: string;

beforeAll(async () => {
	({ publicKey } = await openpgp.generateKey({ type: "curve25519", userIDs: [{ email: "me@home.test" }], format: "armored" }));
});

afterEach(() => vi.unstubAllGlobals());

describe("1. Pass-through PGP encryption fails closed against spoofed multipart/encrypted", () => {
	let db: D1Database;
	let env: Env;
	let sent: unknown[];
	let passed: string[];
	let cookie: string;

	const post = (path: string, form: Record<string, string>) =>
		app.fetch(
			new Request(`${ORIGIN}${path}`, {
				method: "POST",
				headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams(form),
			}),
			env,
		);

	async function deliverRaw(to: string, raw: string, contentType: string, rawSize = raw.length) {
		const message = {
			to,
			from: "bob@store.test",
			headers: new Headers({ "Content-Type": contentType }),
			raw: new Response(raw).body,
			rawSize,
			setReject: () => undefined,
			forward: async (destination: string) => void passed.push(destination),
		};
		await worker.email!(message as never, env);
	}

	beforeEach(async () => {
		db = testDb();
		sent = [];
		passed = [];
		env = {
			DB: db,
			SIGNING_SECRET: TEST_SECRET,
			EMAIL: { send: async (message: unknown) => (sent.push(message), { messageId: `<s${sent.length}@test>` }) },
		} as unknown as Env;
		await saveSettings(db, { ...(await loadSettings(db)), aliasDomains: ["a.test"], defaultDestination: "me@home.test" });
		await saveConfig(db, { siteOrigin: ORIGIN });
		cookie = await signIn(db);
		await post("/encryption", { email: "me@home.test", key: publicKey });
		await post("/encryption/me%40home.test/encrypt", { on: "1" });
	});

	it("blocks spoofed multipart/encrypted plaintext in receive-only (direct) mode", async () => {
		await saveSettings(db, { ...(await loadSettings(db)), forwardMethod: "direct" });
		const fakeEncrypted = [
			"From: bob@store.test",
			"To: shop@a.test",
			"Subject: Fake PGP Direct",
			"Message-ID: <fakedirect@x>",
			"MIME-Version: 1.0",
			'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b1"',
			"",
			"--b1",
			"Content-Type: text/html; charset=utf-8",
			"",
			"<p>UNENCRYPTED SECRET</p>",
			"--b1--",
		].join("\r\n");
		await deliverRaw("shop@a.test", fakeEncrypted, 'multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b1"');
		expect(passed).toEqual([]);
		expect(sent).toEqual([]);
		const row = await db.prepare("SELECT status, error FROM forwards").first<{ status: string; error: string }>();
		expect(row?.status).toBe("failed");
		expect(row?.error).toContain("PGP");
	});

	it("blocks oversized messages with spoofed multipart/encrypted header on the Workers Free plan", async () => {
		const fakeEncrypted = [
			"From: bob@store.test",
			"To: shop@a.test",
			"Subject: Fake Big PGP",
			"Message-ID: <fakebig@x>",
			"MIME-Version: 1.0",
			'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b1"',
			"",
			"--b1",
			"Content-Type: text/plain",
			"",
			"UNENCRYPTED SECRET",
			"--b1--",
		].join("\r\n");
		await deliverRaw(
			"shop@a.test",
			fakeEncrypted,
			'multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b1"',
			FREE_PLAN_REWRITE_BYTES + 1024,
		);
		expect(passed).toEqual([]);
		expect(sent).toEqual([]);
		const row = await db.prepare("SELECT status, error FROM forwards").first<{ status: string; error: string }>();
		expect(row?.status).toBe("failed");
		expect(row?.error).toContain("PGP");
	});

	it("still passes through genuine RFC 3156 PGP/MIME in receive-only mode", async () => {
		await saveSettings(db, { ...(await loadSettings(db)), forwardMethod: "direct" });
		const genuine = [
			"From: bob@store.test",
			"To: shop@a.test",
			"Subject: Real PGP",
			"Message-ID: <realpgp@x>",
			"MIME-Version: 1.0",
			'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b1"',
			"",
			"--b1",
			"Content-Type: application/pgp-encrypted",
			"",
			"Version: 1",
			"",
			"--b1",
			'Content-Type: application/octet-stream; name="encrypted.asc"',
			"",
			ENCRYPTED_PART,
			"",
			"--b1--",
		].join("\r\n");
		await deliverRaw("shop@a.test", genuine, 'multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b1"');
		expect(passed).toEqual(["me@home.test"]);
	});

	it("rejects base64 padding on non-final lines of inline PGP armor", () => {
		const midPadding = "-----BEGIN PGP MESSAGE-----\r\n\r\nwV4D==\r\nAAAA\r\n-----END PGP MESSAGE-----";
		expect(isInlinePgpArmor(midPadding)).toBe(false);
	});
});

describe("2. pgpKind parses Content-Type parameters safely and matches obsolete header whitespace", () => {
	it("ignores protocol= inside a quoted boundary parameter and rejects duplicate protocol params", () => {
		expect(pgpKind('Content-Type: multipart/signed; boundary="x; protocol=application/pgp-signature; y"; protocol="application/pkcs7-signature"')).toBeNull();
		expect(pgpKind('Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; protocol="application/other"; boundary="b1"')).toBeNull();
		expect(pgpKind('Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b1"')).toBe("encrypted");
		expect(pgpKind('Content-Type: multipart/signed; micalg=pgp-sha256; protocol="application/pgp-signature"; boundary="s1"')).toBe("signed");
	});

	it("treats Content-Type with obsolete whitespace before colon as duplicate when paired with another Content-Type", () => {
		const headers = 'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b1"\r\nContent-Type : text/html';
		expect(pgpKind(headers)).toBeNull();
		const raw = new TextEncoder().encode(`${headers}\r\n\r\nbody`).buffer as ArrayBuffer;
		expect(topEntity(raw)).toBeNull();
	});
});

describe("3. WKD host (openpgpkey.<domain>) cannot be bypassed via trailing dots, static assets, or non-WKD subpaths/methods", () => {
	let db: D1Database;
	let env: Env;

	beforeEach(async () => {
		db = testDb();
		env = { DB: db, SIGNING_SECRET: TEST_SECRET } as unknown as Env;
		await saveSettings(db, { ...(await loadSettings(db)), aliasDomains: ["a.test"], defaultDestination: "me@home.test", addyApi: true });
		await saveConfig(db, { publicUrl: ORIGIN });
		await ensureAlias(db, "shop@a.test", "", { forwardEnabled: true });
	});

	it("returns 404 for static assets, trailing-dot hostnames, non-WKD openpgpkey paths, and POST on openpgpkey.<domain>", async () => {
		const blocked: [string, string][] = [
			["GET", "https://openpgpkey.a.test/assets/app.js"],
			["GET", "https://openpgpkey.a.test/assets/app.css"],
			["GET", "https://openpgpkey.a.test/assets/passkey.js"],
			["GET", "https://openpgpkey.a.test/favicon.svg"],
			["GET", "https://openpgpkey.a.test./health"],
			["GET", "https://openpgpkey.a.test./login"],
			["GET", "https://openpgpkey.a.test./api/v1/app-version"],
			["GET", "https://openpgpkey.a.test/.well-known/openpgpkey/probe"],
			["GET", "https://openpgpkey.a.test/.well-known/openpgpkey/hu/" + (await wkdHash("shop@a.test"))],
			["POST", "https://openpgpkey.a.test/.well-known/openpgpkey/a.test/policy"],
		];
		for (const [method, url] of blocked) {
			const res = await app.fetch(new Request(url, { method }), env);
			expect({ method, url, status: res.status }).toEqual({ method, url, status: 404 });
		}
		// Valid WKD lookups still answer on openpgpkey.<domain> (including FQDN with trailing dot).
		expect((await app.fetch(new Request("https://openpgpkey.a.test/.well-known/openpgpkey/a.test/policy"), env)).status).toBe(200);
		expect((await app.fetch(new Request("https://openpgpkey.a.test./.well-known/openpgpkey/a.test/policy"), env)).status).toBe(200);
	});
});

describe("4. Connection validation, addy.io single-domain catch-all sync, Cloudflare WKD casing, and browser PGP hardening", () => {
	it("rejects own-host smtpHost and bad placeholders in non-JSON customBody on POST /connection", async () => {
		const db = testDb();
		const env = { DB: db, SIGNING_SECRET: TEST_SECRET } as unknown as Env;
		await saveConfig(db, { publicUrl: "https://dash.example.com" });
		const cookie = await signIn(db);
		const post = (form: Record<string, string>) =>
			app.fetch(
				new Request("https://dash.example.com/connection", {
					method: "POST",
					headers: { cookie, origin: "https://dash.example.com", "content-type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams(form),
				}),
				env,
			);
		const noticeOf = (res: Response) => new URL(res.headers.get("location") ?? "", "https://dash.example.com").searchParams.get("notice");

		const smtpRes = await post({ outboundProvider: "smtp", smtpHost: "dash.example.com", smtpPort: "587", smtpSecurity: "starttls" });
		expect(noticeOf(smtpRes)).toBe("notice.badSmtp");

		const customRes = await post({
			outboundProvider: "custom",
			customUrl: "https://api.mailprovider.com/send",
			customHeaders: "Content-Type: text/plain",
			customBody: "Hello {{no_such_placeholder}}",
			customIdPath: "",
		});
		expect(noticeOf(customRes)).toBe("notice.badCustom");
	});

	it("sets createAliasesFromMail to false when disabling catch-all on the only alias domain via addy.io API", async () => {
		const db = testDb();
		const env = { DB: db, SIGNING_SECRET: TEST_SECRET } as unknown as Env;
		await saveSettings(db, { ...(await loadSettings(db)), addyApi: true, aliasDomains: ["a.test"], defaultDestination: "me@home.test" });
		const { key } = await createApiKey(db, "app", "apps");
		const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

		const list = await (await app.fetch(new Request(`${ORIGIN}/api/v1/domains`, { headers }), env)).json() as { data: { id: string; catch_all: boolean }[] };
		expect(list.data[0]!.catch_all).toBe(true);

		const off = await app.fetch(new Request(`${ORIGIN}/api/v1/catch-all-domains/${list.data[0]!.id}`, { method: "DELETE", headers }), env);
		expect(off.status).toBe(204);
		const afterOff = await loadSettings(db);
		expect(afterOff.createAliasesFromMail).toBe(false);
		expect(afterOff.aliasesFromMailOff).toEqual([]);

		// Re-enabling works cleanly too.
		const on = await app.fetch(new Request(`${ORIGIN}/api/v1/catch-all-domains`, { method: "POST", headers, body: JSON.stringify({ id: list.data[0]!.id }) }), env);
		expect(on.status).toBe(200);
		const afterOn = await loadSettings(db);
		expect(afterOn.createAliasesFromMail).toBe(true);
		expect(afterOn.aliasesFromMailOff).toEqual([]);
	});

	it("compares WKD custom domain hostnames and worker names case-insensitively", async () => {
		const writes: string[] = [];
		vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
			const path = new URL(url).pathname.replace("/client/v4", "");
			const method = init.method ?? "GET";
			if (method !== "GET") writes.push(`${method} ${path}`);
			const ok = (result: unknown) => Response.json({ success: true, result });
			if (path === "/zones") return ok([{ id: "z1", name: "a.test", account: { id: "acc1" } }]);
			if (path === "/accounts/acc1/workers/domains" && method === "GET") return ok([{ id: "d1", hostname: "OpenPGPKey.A.Test", service: "AliasFlare" }]);
			if (path.endsWith("/catch_all") && method === "GET") return ok({ id: "ca", enabled: true, matchers: [{ type: "all" }], actions: [{ type: "worker", value: ["aliasflare"] }] });
			if (path.endsWith("/email/routing/rules") && method === "GET") return ok([]);
			return ok({});
		});
		const { steps } = await setUpDomain({ token: "t", domain: "a.test", workerName: "aliasflare", wkdHost: true });
		expect(steps.find((step) => step.step === "wkd")).toMatchObject({ ok: true });
		expect(writes.some((w) => w.includes("/workers/domains"))).toBe(false);
	});

	it("validates module path, clears passphrase input, and revokes blob URL on pagehide in browser PGP generator", () => {
		expect(APP_SCRIPT).toContain('if (mod !== "/vendor/openpgp.min.mjs") return;');
		expect(APP_SCRIPT).toContain('if (passphraseInput) passphraseInput.value = "";');
		expect(APP_SCRIPT).toContain('window.addEventListener("pagehide", revoke, { once: true });');
	});
});
