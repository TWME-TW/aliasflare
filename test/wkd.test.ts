import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as openpgp from "openpgp";
import { app } from "../src/index";
import { ensureAlias } from "../src/db";
import { loadSettings, saveSettings } from "../src/settings";
import { wkdHash, zbase32 } from "../src/wkd";
import { testDb } from "./helpers/d1";
import { signIn, TEST_SECRET } from "./helpers/session";

/** WKD for single aliases: a key made for the alias alone, published on openpgpkey.<domain>. */
let db: D1Database;
let env: Env;
let cookie: string;
let aliasKey: string;
let mixedKey: string;
let otherKey: string;

const ORIGIN = "https://alias.test";
const post = (path: string, form: Record<string, string>) =>
	app.fetch(new Request(`${ORIGIN}${path}`, { method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) }), env);
const notice = (response: Response) => new URL(response.headers.get("location") ?? "", ORIGIN).searchParams.get("notice");
const lookup = (url: string) => app.fetch(new Request(url), env);
const generate = async (...emails: string[]) =>
	(await openpgp.generateKey({ type: "curve25519", userIDs: emails.map((email, index) => (index ? { email } : { name: "Shop", email })), format: "armored" })).publicKey;

beforeAll(async () => {
	aliasKey = await generate("shop@a.test");
	mixedKey = await generate("shop@a.test", "me@home.test");
	otherKey = await generate("me@home.test");
});

beforeEach(async () => {
	db = testDb();
	env = { DB: db, SIGNING_SECRET: TEST_SECRET } as unknown as Env;
	await saveSettings(db, { ...(await loadSettings(db)), aliasDomains: ["a.test"], defaultDestination: "me@home.test" });
	await db.prepare("INSERT INTO config (key, value) VALUES ('siteOrigin', ?)").bind(ORIGIN).run();
	await ensureAlias(db, "shop@a.test", "", { forwardEnabled: true });
	await ensureAlias(db, "news@a.test", "", { forwardEnabled: true });
	cookie = await signIn(db);
});

describe("the WKD hash", () => {
	it("matches the draft's example", async () => {
		expect(await wkdHash("Joe.Doe@Example.ORG")).toBe("iy9q119eutrkn8s1mk4r39qejnbu3n5q");
		expect(zbase32(new Uint8Array([0]))).toBe("yy");
	});
});

describe("publishing a key for an alias", () => {
	it("serves it on openpgpkey.<domain>, to anyone, as a binary key", async () => {
		expect(notice(await post("/aliases/shop%40a.test/wkd", { key: aliasKey }))).toBe("notice.wkdSaved");
		const hash = await wkdHash("shop@a.test");
		const response = await lookup(`https://openpgpkey.a.test/.well-known/openpgpkey/a.test/hu/${hash}?l=shop`);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/octet-stream");
		expect(response.headers.get("access-control-allow-origin")).toBe("*");
		const key = await openpgp.readKey({ binaryKey: new Uint8Array(await response.arrayBuffer()) });
		expect(key.getFingerprint()).toBe((await openpgp.readKey({ armoredKey: aliasKey })).getFingerprint());
		expect((await lookup("https://openpgpkey.a.test/.well-known/openpgpkey/a.test/policy")).status).toBe(200);
		const page = await (await app.fetch(new Request(`${ORIGIN}/aliases/shop%40a.test`, { headers: { cookie } }), env)).text();
		expect(page).toContain("openpgpkey.a.test/*");
	});

	it("answers the direct method on the domain itself, and nothing on other hosts or for other aliases", async () => {
		await post("/aliases/shop%40a.test/wkd", { key: aliasKey });
		const hash = await wkdHash("shop@a.test");
		expect((await lookup(`https://a.test/.well-known/openpgpkey/hu/${hash}`)).status).toBe(200);
		expect((await lookup(`${ORIGIN}/.well-known/openpgpkey/hu/${hash}`)).status).toBe(404);
		expect((await lookup(`https://openpgpkey.b.test/.well-known/openpgpkey/b.test/hu/${hash}`)).status).toBe(404);
		expect((await lookup(`https://openpgpkey.a.test/.well-known/openpgpkey/b.test/hu/${hash}`)).status).toBe(404);
		expect((await lookup(`https://openpgpkey.a.test/.well-known/openpgpkey/a.test/hu/${await wkdHash("news@a.test")}`)).status).toBe(404);
		expect((await lookup(`https://openpgpkey.a.test/.well-known/openpgpkey/a.test/hu/not-a-hash`)).status).toBe(404);
	});

	it("refuses a key that names another address, or one used elsewhere", async () => {
		expect(notice(await post("/aliases/shop%40a.test/wkd", { key: otherKey }))).toBe("notice.wkdOtherAddress");
		expect(notice(await post("/aliases/shop%40a.test/wkd", { key: mixedKey }))).toBe("notice.wkdOtherAddress");
		expect(notice(await post("/aliases/shop%40a.test/wkd", { key: "nonsense" }))).toBe("notice.pgpInvalid");
		// The same key on two aliases, or also a forwarding address's key, would tie them together.
		await post("/aliases/shop%40a.test/wkd", { key: aliasKey });
		const twin = await generate("news@a.test");
		await post("/encryption", { email: "me@home.test", key: twin });
		expect(notice(await post("/aliases/news%40a.test/wkd", { key: twin }))).toBe("notice.wkdKeyInUse");
		expect(await db.prepare("SELECT COUNT(*) AS n FROM wkd_keys").first("n")).toBe(1);
	});

	it("refuses the same pairing from the other side: an alias's published key onto a forwarding address", async () => {
		// The check used to run one way only. Saving a WKD key looked at the forwarding keys, but
		// saving a forwarding key never looked at wkd_keys, so an alias's public key could also
		// become the key a real mailbox's mail is encrypted to — tying the alias to that mailbox,
		// which is exactly what a per-alias key must not do.
		expect(notice(await post("/aliases/shop%40a.test/wkd", { key: aliasKey }))).toBe("notice.wkdSaved");
		expect(notice(await post("/encryption", { email: "me@home.test", key: aliasKey }))).toBe("notice.wkdKeyInUse");
		expect(await db.prepare("SELECT COUNT(*) AS n FROM pgp_keys").first("n")).toBe(0);
		// A key that is published nowhere still saves, so the ordinary path is untouched.
		const plain = await generate("me@home.test");
		expect(notice(await post("/encryption", { email: "me@home.test", key: plain }))).toBe("notice.pgpSaved");
	});

	it("stops answering when the key is removed or the alias deleted", async () => {
		await post("/aliases/shop%40a.test/wkd", { key: aliasKey });
		const url = `https://openpgpkey.a.test/.well-known/openpgpkey/a.test/hu/${await wkdHash("shop@a.test")}`;
		await db.prepare("UPDATE aliases SET deleted_at = 1 WHERE address = 'shop@a.test'").run();
		expect((await lookup(url)).status).toBe(404);
		await db.prepare("UPDATE aliases SET deleted_at = NULL WHERE address = 'shop@a.test'").run();
		expect((await lookup(url)).status).toBe(200);
		expect(notice(await post("/aliases/shop%40a.test/wkd/delete", {}))).toBe("notice.wkdDeleted");
		expect((await lookup(url)).status).toBe(404);
	});
});
