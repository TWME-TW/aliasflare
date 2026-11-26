import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as openpgp from "openpgp";
import worker, { app } from "../src/index";
import { HIDDEN_SUBJECT } from "../src/mime";
import { readPublicKey, PgpError } from "../src/pgp";
import { loadSettings, saveSettings } from "../src/settings";
import { EmailMessage } from "./helpers/email";
import { testDb } from "./helpers/d1";
import { signIn, TEST_SECRET } from "./helpers/session";

/** PGP encryption of forwarded mail: off until turned on, never sent in the clear once it is on. */
let db: D1Database;
let env: Env;
let sent: unknown[];
let passed: string[];
let cookie: string;
let publicKey: string;
let privateKey: string;

const ORIGIN = "https://alias.test";
const post = (path: string, form: Record<string, string>) =>
	app.fetch(new Request(`${ORIGIN}${path}`, { method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) }), env);
const notice = (response: Response) => new URL(response.headers.get("location") ?? "", ORIGIN).searchParams.get("notice");

async function deliver(to: string, subject = "Your order") {
	const raw = `From: bob@store.test\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${crypto.randomUUID()}@x>\r\n\r\nHello there\r\n`;
	const message = {
		to,
		from: "bob@store.test",
		headers: new Headers({ Subject: subject }),
		raw: new Response(raw).body,
		rawSize: raw.length,
		setReject: () => undefined,
		forward: async (destination: string) => void passed.push(destination),
	};
	await worker.email!(message as never, env);
}

/** The body of a PGP/MIME message, decrypted with the test's private key. */
async function decrypt(raw: string): Promise<string> {
	const armored = raw.slice(raw.indexOf("-----BEGIN PGP MESSAGE-----"), raw.indexOf("-----END PGP MESSAGE-----") + 25);
	const { data } = await openpgp.decrypt({
		message: await openpgp.readMessage({ armoredMessage: armored }),
		decryptionKeys: await openpgp.readPrivateKey({ armoredKey: privateKey }),
		format: "binary",
	});
	return new TextDecoder().decode(data as Uint8Array);
}

beforeAll(async () => {
	({ publicKey, privateKey } = await openpgp.generateKey({ type: "curve25519", userIDs: [{ email: "me@home.test" }], format: "armored" }));
});

beforeEach(async () => {
	db = testDb();
	sent = [];
	passed = [];
	env = { DB: db, SIGNING_SECRET: TEST_SECRET, EMAIL: { send: async (message: unknown) => (sent.push(message), { messageId: "<s@test>" }) } } as unknown as Env;
	await saveSettings(db, { ...(await loadSettings(db)), aliasDomains: ["a.test"], defaultDestination: "me@home.test" });
	await db.prepare("INSERT INTO config (key, value) VALUES ('siteOrigin', ?)").bind(ORIGIN).run();
	cookie = await signIn(db);
});

describe("public keys", () => {
	it("reads a public key and gives its fingerprint", async () => {
		const key = await readPublicKey(publicKey);
		expect(key.fingerprint).toMatch(/^[0-9A-F]{40,64}$/);
		expect(key.userIds).toEqual(["<me@home.test>"]);
	});

	it("refuses a private key, text that is not a key, and a key that is too large", async () => {
		await expect(readPublicKey(privateKey)).rejects.toMatchObject({ reason: "private" });
		await expect(readPublicKey("hello")).rejects.toMatchObject({ reason: "invalid" });
		await expect(readPublicKey("x".repeat(100_001))).rejects.toBeInstanceOf(PgpError);
	});

	it("is saved from the Encryption page with encryption off, and a private key is never stored", async () => {
		expect(notice(await post("/encryption", { email: "me@home.test", key: privateKey }))).toBe("notice.pgpPrivate");
		expect(await db.prepare("SELECT COUNT(*) AS n FROM pgp_keys").first("n")).toBe(0);
		expect(notice(await post("/encryption", { email: "Me@Home.test", key: publicKey }))).toBe("notice.pgpSaved");
		const row = await db.prepare("SELECT * FROM pgp_keys").first<{ email: string; encrypt: number }>();
		expect(row).toMatchObject({ email: "me@home.test", encrypt: 0 });
		expect((await loadSettings(db)).pgpRecipients).toEqual([]);
	});

	it("warns on the Workers Free plan", async () => {
		const page = async () => (await app.fetch(new Request(`${ORIGIN}/encryption`, { headers: { cookie } }), env)).text();
		expect(await page()).toContain("10 ms");
		await db.prepare("INSERT INTO config (key, value) VALUES ('workersPlan', 'paid')").run();
		expect(await page()).not.toContain("10 ms");
	});
});

describe("forwarding", () => {
	beforeEach(async () => {
		await post("/encryption", { email: "me@home.test", key: publicKey });
	});

	it("sends mail in the clear while encryption is off", async () => {
		await deliver("shop@a.test");
		expect(sent).toHaveLength(1);
		expect(sent[0]).not.toBeInstanceOf(EmailMessage);
	});

	it("sends PGP/MIME the owner can decrypt once encryption is on", async () => {
		expect(notice(await post("/encryption/me%40home.test/encrypt", { on: "1" }))).toBe("notice.pgpOn");
		expect((await loadSettings(db)).pgpRecipients).toEqual(["me@home.test"]);
		await deliver("shop@a.test");
		expect(sent).toHaveLength(1);
		const message = sent[0] as EmailMessage;
		expect(message).toBeInstanceOf(EmailMessage);
		expect(message.to).toBe("me@home.test");
		expect(message.raw).toContain('Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"');
		expect(message.raw).toContain("Subject: Your order");
		expect(message.raw).toMatch(/^Message-ID: <.+>$/m);
		expect(message.raw).not.toContain("Hello there");
		const inner = await decrypt(message.raw);
		expect(inner).toContain("Content-Type: text/");
		expect(atob(inner.split("\r\n\r\n")[1]!.replace(/\s+/g, ""))).toContain("Hello there");
		const row = await db.prepare("SELECT status FROM forwards").first("status");
		expect(row).toBe("sent");
	});

	it("moves the subject inside when it is hidden", async () => {
		await post("/encryption/me%40home.test/encrypt", { on: "1" });
		await post("/encryption/me%40home.test/subject", { on: "1" });
		await deliver("shop@a.test", "Secret plans");
		const message = sent[0] as EmailMessage;
		expect(message.raw).toContain(`Subject: ${HIDDEN_SUBJECT}\r\n`);
		expect(message.raw).not.toContain("Secret plans");
		const inner = await decrypt(message.raw);
		expect(inner).toContain('protected-headers="v1"');
		expect(inner).toContain("Subject: Secret plans");
	});

	it("never passes mail through unencrypted in receive-only mode", async () => {
		await post("/encryption/me%40home.test/encrypt", { on: "1" });
		await saveSettings(db, { ...(await loadSettings(db)), forwardMethod: "direct" });
		await deliver("shop@a.test");
		expect(passed).toEqual([]);
		expect(sent).toEqual([]);
		const row = await db.prepare("SELECT status, error FROM forwards").first<{ status: string; error: string }>();
		expect(row?.status).toBe("failed");
		expect(row?.error).toContain("PGP");
	});

	it("goes back to plain mail when the key is removed", async () => {
		await post("/encryption/me%40home.test/encrypt", { on: "1" });
		expect(notice(await post("/encryption/me%40home.test/delete", {}))).toBe("notice.pgpDeleted");
		expect((await loadSettings(db)).pgpRecipients).toEqual([]);
		await deliver("shop@a.test");
		expect(sent[0]).not.toBeInstanceOf(EmailMessage);
		expect(notice(await post("/encryption/nobody%40home.test/encrypt", { on: "1" }))).toBe("notice.pgpMissing");
	});

	it("keeps the encrypted addresses when the settings are saved", async () => {
		await post("/encryption/me%40home.test/encrypt", { on: "1" });
		await post("/settings", { aliasDomains: "a.test", defaultDestination: "me@home.test" });
		expect((await loadSettings(db)).pgpRecipients).toEqual(["me@home.test"]);
	});
});
