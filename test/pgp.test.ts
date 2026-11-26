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

/** The whole message as text, however it was handed to Email Sending. */
const rawOf = async (message: EmailMessage) => (typeof message.raw === "string" ? message.raw : await new Response(message.raw).text());

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
		const raw = await rawOf(message);
		expect(message).toBeInstanceOf(EmailMessage);
		expect(message.to).toBe("me@home.test");
		expect(raw).toContain('Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"');
		expect(raw).toContain("Subject: Your order");
		expect(raw).toMatch(/^Message-ID: <.+>$/m);
		expect(raw).not.toContain("Hello there");
		const inner = await decrypt(raw);
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
		const raw = await rawOf(message);
		expect(raw).toContain(`Subject: ${HIDDEN_SUBJECT}\r\n`);
		expect(raw).not.toContain("Secret plans");
		const inner = await decrypt(raw);
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

	it("never sends in the clear when the address is marked encrypted but its key is gone", async () => {
		// The settings name the addresses to encrypt; the key table is what that list is made from.
		// If they disagree — the key deleted without the flag, a settings write from an app, a
		// half-finished delete — the message must fail rather than go out readable. Before this was
		// checked it fell through to the plain send, which is the one outcome turning encryption on
		// promises never to have.
		await post("/encryption/me%40home.test/encrypt", { on: "1" });
		await db.prepare("DELETE FROM pgp_keys WHERE email = 'me@home.test'").run();
		expect((await loadSettings(db)).pgpRecipients).toEqual(["me@home.test"]);
		await deliver("shop@a.test");
		expect(sent).toEqual([]);
		const row = await db.prepare("SELECT status, error FROM forwards").first<{ status: string; error: string }>();
		expect(row?.status).toBe("failed");
		expect(row?.error).toContain("key is missing");
	});

	it("keeps the encrypted addresses when the settings are saved", async () => {
		await post("/encryption/me%40home.test/encrypt", { on: "1" });
		await post("/settings", { aliasDomains: "a.test", defaultDestination: "me@home.test" });
		expect((await loadSettings(db)).pgpRecipients).toEqual(["me@home.test"]);
	});
});

describe("mail that is PGP encrypted or signed already", () => {
	const ENCRYPTED_PART = "-----BEGIN PGP MESSAGE-----\r\n\r\nwV4DAAAAAAAAAAASAQdAexample\r\n=abcd\r\n-----END PGP MESSAGE-----";
	const encrypted = (to: string) =>
		`From: Bob <bob@store.test>\r\nTo: ${to}\r\nSubject: Encrypted for you\r\nMessage-ID: <${crypto.randomUUID()}@x>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/encrypted;\r\n protocol="application/pgp-encrypted"; boundary="b1"\r\n\r\n` +
		`--b1\r\nContent-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n\r\n--b1\r\nContent-Type: application/octet-stream; name="encrypted.asc"\r\n\r\n${ENCRYPTED_PART}\r\n\r\n--b1--\r\n`;
	const SIGNED_BODY =
		`--s1\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\nSigned text, café https://x.test/?utm_source=a\r\n\r\n--s1\r\nContent-Type: application/pgp-signature; name="signature.asc"\r\n\r\n-----BEGIN PGP SIGNATURE-----\r\n\r\niHUEARYKAB0WIQexample\r\n=wxyz\r\n-----END PGP SIGNATURE-----\r\n\r\n--s1--\r\n`;
	const signed = (to: string) =>
		`From: bob@store.test\r\nTo: ${to}\r\nSubject: Signed\r\nMessage-ID: <${crypto.randomUUID()}@x>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/signed; micalg=pgp-sha256;\r\n protocol="application/pgp-signature"; boundary="s1"\r\n\r\n${SIGNED_BODY}`;

	async function deliverRaw(to: string, raw: string) {
		const contentType = /^Content-Type:([^\r\n]*(?:\r\n[ \t][^\r\n]*)*)/m.exec(raw)![1]!.replace(/\r\n[ \t]/g, " ").trim();
		const message = {
			to,
			from: "bob@store.test",
			headers: new Headers({ "Content-Type": contentType }),
			raw: new Response(raw).body,
			rawSize: raw.length,
			setReject: () => undefined,
			forward: async (destination: string) => void passed.push(destination),
		};
		await worker.email!(message as never, env);
	}

	it("forwards PGP/MIME with its encrypted body untouched, under the reverse alias", async () => {
		await deliverRaw("shop@a.test", encrypted("shop@a.test"));
		const message = sent[0] as EmailMessage;
		expect(message).toBeInstanceOf(EmailMessage);
		const raw = await rawOf(message);
		expect(raw).toContain('Content-Type: multipart/encrypted;\r\n protocol="application/pgp-encrypted"; boundary="b1"');
		expect(raw).toContain(ENCRYPTED_PART);
		expect(raw).toContain("Subject: Encrypted for you");
		expect(raw).not.toContain("bob@store.test>");
		expect(raw).toMatch(/^Reply-To: <.+@.+>$/m);
		expect(raw).toMatch(/^Message-ID: <.+>$/m);
		expect(await db.prepare("SELECT status FROM forwards").first("status")).toBe("sent");
	});

	it("does not encrypt it a second time when encryption is on", async () => {
		await post("/encryption", { email: "me@home.test", key: publicKey });
		await post("/encryption/me%40home.test/encrypt", { on: "1" });
		await deliverRaw("shop@a.test", encrypted("shop@a.test"));
		const raw = await rawOf(sent[0] as EmailMessage);
		expect(raw.match(/BEGIN PGP MESSAGE/g)).toHaveLength(1);
		expect(raw).toContain(ENCRYPTED_PART);
	});

	it("passes it through in receive-only mode even when encryption is on", async () => {
		await post("/encryption", { email: "me@home.test", key: publicKey });
		await post("/encryption/me%40home.test/encrypt", { on: "1" });
		await saveSettings(db, { ...(await loadSettings(db)), forwardMethod: "direct" });
		await deliverRaw("shop@a.test", encrypted("shop@a.test"));
		expect(passed).toEqual(["me@home.test"]);
	});

	it("keeps a signed message byte for byte, so its signature still holds", async () => {
		await deliverRaw("shop@a.test", signed("shop@a.test"));
		const raw = await rawOf(sent[0] as EmailMessage);
		expect(JSON.stringify(raw.slice(raw.indexOf('protocol="application/pgp-signature"')))).toBe(JSON.stringify(`protocol="application/pgp-signature"; boundary="s1"\r\n\r\n${SIGNED_BODY}`));
		expect(raw).toContain("utm_source=a");
	});

	it("encrypts a signed message whole when encryption is on", async () => {
		await post("/encryption", { email: "me@home.test", key: publicKey });
		await post("/encryption/me%40home.test/encrypt", { on: "1" });
		await post("/encryption/me%40home.test/subject", { on: "1" });
		await deliverRaw("shop@a.test", signed("shop@a.test"));
		const raw = await rawOf(sent[0] as EmailMessage);
		expect(raw).toContain("multipart/encrypted");
		const inner = await decrypt(raw);
		expect(inner).toContain('protocol="application/pgp-signature"; boundary="s1"; protected-headers="v1"');
		expect(inner).toContain("Subject: Signed");
		expect(inner.endsWith(SIGNED_BODY)).toBe(true);
	});

	it("does not encrypt inline PGP again", async () => {
		await post("/encryption", { email: "me@home.test", key: publicKey });
		await post("/encryption/me%40home.test/encrypt", { on: "1" });
		await deliverRaw("shop@a.test", `From: bob@store.test\r\nTo: shop@a.test\r\nSubject: Inline\r\nMessage-ID: <i@x>\r\nContent-Type: text/plain\r\n\r\n${ENCRYPTED_PART}\r\n`);
		expect(sent[0]).not.toBeInstanceOf(EmailMessage);
		expect((sent[0] as { text: string }).text).toContain("-----BEGIN PGP MESSAGE-----");
	});

	it("cannot be made to skip encryption by an armor line the sender writes", async () => {
		// "Already encrypted" is decided from the message, which the sender writes. If a line that
		// merely begins an armor block counted, any sender could switch the owner's encryption off
		// and have the rest of the message — an HTML part beside it included — delivered readable.
		await post("/encryption", { email: "me@home.test", key: publicKey });
		await post("/encryption/me%40home.test/encrypt", { on: "1" });
		const alternative = [
			"--b1",
			"Content-Type: text/plain; charset=utf-8",
			"",
			"hello",
			"-----BEGIN PGP MESSAGE-----",
			"",
			"--b1",
			"Content-Type: text/html; charset=utf-8",
			"",
			"<p>CONFIDENTIAL</p>",
			"--b1--",
		].join("\r\n");
		const raw = `From: bob@store.test\r\nTo: shop@a.test\r\nSubject: Your order\r\nMessage-ID: <u@x>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="b1"\r\n\r\n${alternative}`;
		await deliverRaw("shop@a.test", raw);
		expect(sent[0]).toBeInstanceOf(EmailMessage);
		expect(await rawOf(sent[0] as EmailMessage)).toContain("multipart/encrypted");

		// A body that opens with armor but carries readable text after it counts the same way.
		await deliverRaw("shop@a.test", `From: bob@store.test\r\nTo: shop@a.test\r\nSubject: Half\r\nMessage-ID: <h@x>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n-----BEGIN PGP MESSAGE-----\r\n\r\nreadable text after the marker\r\n`);
		expect(sent[1]).toBeInstanceOf(EmailMessage);
	});

	it("keeps PGP/MIME whole even when its header section is longer than the rule check reads", async () => {
		// The checks that read headers give up at 64 KiB, and "too long to look at" must not be read
		// as "not PGP": a message with padded headers would then be rebuilt and reach the owner
		// undecryptable. The kind is therefore read from the whole header section.
		const padding = `X-Pad: ${"a".repeat(70_000)}`;
		const raw = `From: bob@store.test\r\nTo: shop@a.test\r\nSubject: Encrypted\r\nMessage-ID: <big@x>\r\nContent-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b1"\r\n${padding}\r\n\r\n${ENCRYPTED_PART}`;
		await deliverRaw("shop@a.test", raw);
		const message = sent[0] as EmailMessage;
		expect(message).toBeInstanceOf(EmailMessage);
		const out = await rawOf(message);
		expect(out).toContain("multipart/encrypted");
		expect(out).toContain("-----BEGIN PGP MESSAGE-----");
	});

	it("refuses PGP/MIME whose entity cannot be found at all, rather than rebuilding it", async () => {
		// No blank line means no header section and no entity to keep. Rebuilding would produce parts
		// the owner's app cannot decrypt — a recorded failure is better than a broken message.
		const { topEntity, pgpKind } = await import("../src/mime");
		const truncated = new TextEncoder().encode(`Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b1"\r\n`).buffer as ArrayBuffer;
		expect(pgpKind("Content-Type: multipart/encrypted; protocol=\"application/pgp-encrypted\"")).toBe("encrypted");
		expect(topEntity(truncated)).toBeNull();
	});
});
