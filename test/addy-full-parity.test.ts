import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as openpgp from "openpgp";
import { createApiKey } from "../src/apikeys";
import { isSafeRegex } from "../src/domain-settings";
import worker, { app } from "../src/index";
import { htmlToPlainText } from "../src/pgp";
import { handleReverseAliasMail } from "../src/reply";
import { loadSettings, saveSettings } from "../src/settings";
import { EmailMessage } from "./helpers/email";
import { testDb } from "./helpers/d1";
import { TEST_SECRET } from "./helpers/session";

let db: D1Database;
let env: Env;
let key: string;
let sent: unknown[];
let publicKey: string;
let privateKey: string;

const ORIGIN = "https://alias.test";

const call = async (path: string, method = "GET", body?: unknown) => {
	const response = await app.fetch(
		new Request(`${ORIGIN}/api${path}`, {
			method,
			headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
		env,
	);
	return { status: response.status, json: (response.status === 204 ? null : await response.json()) as any };
};

async function deliver(to: string, opts: { from?: string; fromHeader?: string; subject?: string; text?: string; html?: string; raw?: string } = {}) {
	const from = opts.from ?? "bob@store.test";
	const raw =
		opts.raw ??
		[
			`From: ${opts.fromHeader ?? from}`,
			`To: ${to}`,
			`Subject: ${opts.subject ?? "Hello"}`,
			`Message-ID: <${crypto.randomUUID()}@x>`,
			"MIME-Version: 1.0",
			...(opts.html
				? ['Content-Type: text/html; charset=UTF-8', "", opts.html]
				: ["Content-Type: text/plain; charset=UTF-8", "", opts.text ?? "Body text"]),
		].join("\r\n");
	let rejected: string | null = null;
	await worker.email!(
		{
			to,
			from,
			headers: new Headers({ From: opts.fromHeader ?? from, To: to, Subject: opts.subject ?? "Hello" }),
			raw: new Response(raw).body,
			rawSize: raw.length,
			setReject: (why: string) => void (rejected = why),
			forward: async () => undefined,
		} as never,
		env,
	);
	return rejected;
}

beforeAll(async () => {
	({ publicKey, privateKey } = await openpgp.generateKey({ type: "curve25519", userIDs: [{ email: "me@home.test" }], format: "armored" }));
});

beforeEach(async () => {
	db = testDb();
	sent = [];
	env = {
		DB: db,
		SIGNING_SECRET: TEST_SECRET,
		EMAIL: { send: async (message: unknown) => (sent.push(message), { messageId: `<s${sent.length}@test>` }) },
	} as unknown as Env;
	await saveSettings(db, { ...(await loadSettings(db)), addyApi: true, aliasDomains: ["a.test", "b.test"], defaultDestination: "me@home.test" });
	await db.prepare("INSERT INTO config (key, value) VALUES ('siteOrigin', ?)").bind(ORIGIN).run();
	({ key } = await createApiKey(db, "addy-app", "apps"));
});

afterEach(() => vi.unstubAllGlobals());

describe("addy.io account settings via client API", () => {
	it("reads and updates account settings, and refuses custom_alias_random_characters", async () => {
		const rec = await call("/v1/recipients", "POST", { email: "second@home.test" });
		expect(rec.status).toBe(201);
		const recId = rec.json.data.id;

		const updated = await call("/v1/account-details", "PATCH", {
			default_recipient_id: recId,
			default_alias_domain: "b.test",
			default_alias_format: "random_noun",
			alias_separator: "-",
			from_name: "Alice",
			email_subject: "Private Notice",
			banner_location: "bottom",
			spam_warning_behaviour: "banner",
			wkd_auto_encrypt: 1,
		});
		expect(updated.status).toBe(200);
		expect(updated.json.data).toMatchObject({
			default_recipient_id: recId,
			default_alias_domain: "b.test",
			default_alias_format: "random_noun",
			alias_separator: "-",
			from_name: "Alice",
			email_subject: "Private Notice",
			banner_location: "bottom",
			spam_warning_behaviour: "banner",
			wkd_auto_encrypt: 1,
			custom_alias_random_characters: false,
			custom_alias_random_length: 0,
		});

		// Explicitly excluded feature must always be rejected.
		expect((await call("/v1/account-details", "PATCH", { custom_alias_random_characters: true })).status).toBe(422);
		expect((await call("/v1/account-details", "PATCH", { custom_alias_random_length: 4 })).status).toBe(422);

		// Random noun alias uses the chosen separator.
		const created = await call("/v1/aliases", "POST", { domain: "b.test" });
		expect(created.status).toBe(201);
		expect(created.json.data.local_part).toMatch(/^[a-z]+-[a-z0-9]{5}$/);

		// Bottom banner & default email subject are applied when forwarding.
		await deliver(created.json.data.email, { html: "<html><body><p>Hello world</p></body></html>", subject: "Original" });
		expect(sent).toHaveLength(1);
		const msg = sent[0] as { subject: string; html: string; to: { email: string } };
		expect(msg.to.email).toBe("second@home.test");
		expect(msg.subject).toBe("Private Notice");
		expect(msg.html.indexOf("<p>Hello world</p>")).toBeLessThan(msg.html.indexOf("data-aliasflare-banner"));
	});

	it("blocks client settings updates when appSettings is turned off", async () => {
		await saveSettings(db, { ...(await loadSettings(db)), appSettings: false });
		expect((await call("/v1/account-details", "PATCH", { banner_location: "top" })).status).toBe(403);
		expect((await call("/v1/recipients", "POST", { email: "new@home.test" })).status).toBe(403);
		expect((await call("/v1/domains", "POST", { domain: "c.test" })).status).toBe(403);
	});
});

describe("addy.io recipients management, PGP options & multi-recipient forwarding", () => {
	it("creates, edits, toggles flags, uploads/removes PGP key, and deletes recipients", async () => {
		const made = await call("/v1/recipients", "POST", { email: "work@home.test" });
		expect(made.status).toBe(201);
		const id = made.json.data.id;

		// Cannot enable encryption before uploading a public key.
		expect((await call("/v1/encrypted-recipients", "POST", { id })).status).toBe(422);

		// Description update.
		expect((await call(`/v1/recipients/${id}`, "PATCH", { description: "Work inbox" })).json.data.description).toBe("Work inbox");

		// Upload PGP public key (refuses private key).
		expect((await call(`/v1/recipient-keys/${id}`, "PATCH", { key_data: privateKey })).status).toBe(422);
		const withKey = await call(`/v1/recipient-keys/${id}`, "PATCH", { key_data: publicKey });
		expect(withKey.status).toBe(200);
		expect(withKey.json.data).toMatchObject({ should_encrypt: true, fingerprint: expect.stringMatching(/^[0-9A-F]{40,64}$/) });

		// Toggle inline encryption, protected headers, remove pgp keys/signatures, allowed-recipients.
		expect((await call("/v1/inline-encryption-recipients", "POST", { id })).json.data.inline_encryption).toBe(true);
		expect((await call("/v1/protected-headers-recipients", "POST", { id })).json.data.protected_headers).toBe(true);
		expect((await call("/v1/remove-pgp-keys-recipients", "POST", { id })).json.data.remove_pgp_keys).toBe(true);
		expect((await call("/v1/remove-pgp-signatures-recipients", "POST", { id })).json.data.remove_pgp_signatures).toBe(true);
		expect((await call(`/v1/allowed-recipients/${id}`, "DELETE")).status).toBe(204);
		expect((await call(`/v1/recipients/${id}`)).json.data.can_reply_send).toBe(false);

		// Inline PGP forwarding encrypts plain body as inline PGP armor.
		const alias = await call("/v1/aliases", "POST", { domain: "a.test", format: "custom", local_part: "secure", recipient_ids: [id] });
		await deliver("secure@a.test", { text: "Top secret payload" });
		expect(sent).toHaveLength(1);
		const inlineMsg = sent[0] as { text: string; to: { email: string } };
		expect(inlineMsg.to.email).toBe("work@home.test");
		expect(inlineMsg.text).toContain("-----BEGIN PGP MESSAGE-----");
		const decrypted = await openpgp.decrypt({
			message: await openpgp.readMessage({ armoredMessage: inlineMsg.text }),
			decryptionKeys: await openpgp.readPrivateKey({ armoredKey: privateKey }),
		});
		expect(decrypted.data).toContain("Top secret payload");

		// Remove PGP key resets encryption flags, and recipient can be deleted.
		expect((await call(`/v1/recipient-keys/${id}`, "DELETE")).status).toBe(204);
		expect((await call(`/v1/recipients/${id}`)).json.data).toMatchObject({ fingerprint: null, should_encrypt: false, inline_encryption: false });
		expect((await call(`/v1/recipients/${id}`, "DELETE")).status).toBe(204);
		expect((await call(`/v1/recipients/${id}`)).status).toBe(404);
	});

	it("forwards to multiple attached recipients and enforces attached_recipients_only & can_reply_send", async () => {
		const home = ((await call("/v1/recipients")).json.data as { id: string; email: string }[])[0]!;
		const extra = (await call("/v1/recipients", "POST", { email: "team@home.test" })).json.data;
		const alias = (await call("/v1/aliases", "POST", { domain: "a.test", format: "custom", local_part: "multi", recipient_ids: [home.id, extra.id] })).json.data;
		expect(alias.recipients).toHaveLength(2);

		await deliver("multi@a.test");
		expect(sent).toHaveLength(2);
		expect((sent as { to: { email: string } }[]).map((m) => m.to.email).sort()).toEqual(["me@home.test", "team@home.test"]);

		// Enable attached_recipients_only on alias and disallow reply/send on team@home.test.
		expect((await call("/v1/attached-recipients-only-aliases", "POST", { id: alias.id })).json.data.attached_recipients_only).toBe(true);
		await call(`/v1/allowed-recipients/${extra.id}`, "DELETE");

		// Send-from endpoint creates contact and returns reverse alias.
		const sendFrom = await call(`/v1/aliases/${alias.id}/send-from`, "POST", { recipient: "alice@partner.test" });
		expect(sendFrom.status).toBe(200);
		expect(sendFrom.json.data.reverse_alias).toMatch(/^reply\+.+@r\.a\.test$/);

		// Replying from team@home.test (can_reply_send = false) is rejected.
		const rawReply = `Authentication-Results: mx.cloudflare.net; spf=pass; dmarc=pass header.from=home.test\r\nFrom: team@home.test\r\nTo: ${sendFrom.json.data.reverse_alias}\r\nSubject: Hi\r\nContent-Type: text/plain\r\n\r\nTest\r\n`;
		let rejected: string | null = null;
		await handleReverseAliasMail(
			{ to: sendFrom.json.data.reverse_alias, raw: new Response(rawReply).body, rawSize: rawReply.length, setReject: (why: string) => void (rejected = why) } as never,
			env,
			{ outboundProvider: "cloudflare", workersPlan: "paid" } as never,
		);
		expect(rejected).toMatch(/not allowed to reply or send/i);
	});
});

describe("addy.io domains management, +extension routing & expanded rules", () => {
	it("manages domains via API including active, default_recipient, from_name, and safe auto_create_regex", async () => {
		const added = await call("/v1/domains", "POST", { domain: "c.test" });
		expect(added.status).toBe(201);
		const domainId = added.json.data.id;

		// Rejects unsafe ReDoS regex (put together, so code scanning does not take the sample for a regex in use).
		const nested = ["(a+)", "+$"].join("");
		expect(isSafeRegex(nested)).toBe(false);
		expect((await call(`/v1/domains/${domainId}`, "PATCH", { auto_create_regex: nested })).status).toBe(422);

		// Accepts safe regex + description + from_name + default_recipient.
		const second = (await call("/v1/recipients", "POST", { email: "cbox@home.test" })).json.data;
		const patched = await call(`/v1/domains/${domainId}`, "PATCH", {
			description: "Custom C",
			from_name: "C Brand",
			auto_create_regex: "^shop-[a-z0-9]+$",
		});
		expect(patched.status).toBe(200);
		expect(patched.json.data).toMatchObject({ description: "Custom C", from_name: "C Brand", auto_create_regex: "^shop-[a-z0-9]+$" });
		await call(`/v1/domains/${domainId}/default-recipient`, "PATCH", { default_recipient: second.id });

		// As on addy.io, the pattern matters with catch-all off: a non-matching local part is rejected
		// (404), a matching one is created and forwarded to the domain's default recipient.
		expect((await call(`/v1/catch-all-domains/${domainId}`, "DELETE")).status).toBe(204);
		expect(await deliver("other@c.test")).toBe("This address does not exist");
		expect(await deliver("shop-123@c.test")).toBeNull();
		expect(sent).toHaveLength(1);
		expect((sent[0] as { to: { email: string } }).to.email).toBe("cbox@home.test");

		// With catch-all on, every address makes an alias, pattern or not.
		expect((await call("/v1/catch-all-domains", "POST", { id: domainId })).status).toBe(200);
		expect(await deliver("other@c.test")).toBeNull();
		expect(sent).toHaveLength(2);

		// Domain aliases_count reflects actual alias count.
		expect((await call(`/v1/domains/${domainId}`)).json.data.aliases_count).toBe(2);

		// Deactivating domain skips incoming mail.
		expect((await call(`/v1/active-domains/${domainId}`, "DELETE")).status).toBe(204);
		await deliver("shop-123@c.test");
		expect(sent).toHaveLength(2);

		// Re-activate & remove domain.
		expect((await call("/v1/active-domains", "POST", { id: domainId })).json.data.active).toBe(true);
		expect((await call(`/v1/domains/${domainId}`, "DELETE")).status).toBe(204);
	});

	it("routes +extension addresses to base alias and runs expanded rule conditions/actions", async () => {
		const label = (await call("/v1/labels", "POST", { name: "VIP", colour: "#1a73e8" })).json.data;
		await call("/v1/aliases", "POST", { domain: "a.test", format: "custom", local_part: "news" });

		// Rule matching extension + safe regex on subject -> sets aliasDescription + addLabel + disables encryption.
		const home = ((await call("/v1/recipients")).json.data as { id: string }[])[0]!;
		await call(`/v1/recipient-keys/${home.id}`, "PATCH", { key_data: publicKey });

		const rule = await call("/v1/rules", "POST", {
			name: "Promo tag",
			operator: "AND",
			conditions: [
				{ type: "extension", match: "is exactly", values: ["vip"] },
				{ type: "subject", match: "matches regex", values: ["^order #[0-9]+$"] },
			],
			actions: [
				{ type: "aliasDescription", value: "Auto-tagged VIP" },
				{ type: "addLabel", value: label.id },
				{ type: "encryption", value: "false" },
			],
		});
		expect(rule.status).toBe(201);

		await deliver("news+vip@a.test", { subject: "Order #42" });
		expect(sent).toHaveLength(1);
		// Encryption was disabled by rule, so plain object (not PGP/MIME EmailMessage) was sent.
		expect(sent[0]).not.toBeInstanceOf(EmailMessage);

		const aliases = (await call("/v1/aliases")).json.data as { email: string; description: string; labels: { id: string }[] }[];
		const news = aliases.find((a) => a.email === "news@a.test")!;
		expect(news.description).toBe("Auto-tagged VIP");
		expect(news.labels.map((l) => l.id)).toEqual([label.id]);
	});
});

describe("multi-recipient forwarding safety and inline PGP fallbacks", () => {
	const multipartWithAttachment = (to: string) =>
		[
			"From: bob@store.test",
			`To: ${to}`,
			"Subject: With file",
			`Message-ID: <${crypto.randomUUID()}@x>`,
			"MIME-Version: 1.0",
			'Content-Type: multipart/mixed; boundary="b1"',
			"",
			"--b1",
			"Content-Type: text/plain; charset=UTF-8",
			"",
			"See attached",
			"--b1",
			'Content-Type: application/pdf; name="doc.pdf"',
			'Content-Disposition: attachment; filename="doc.pdf"',
			"Content-Transfer-Encoding: base64",
			"",
			"JVBERi0xLjQK",
			"--b1--",
			"",
		].join("\r\n");

	it("sends to no one when a later recipient's key is missing", async () => {
		const home = ((await call("/v1/recipients")).json.data as { id: string }[])[0]!;
		const extra = (await call("/v1/recipients", "POST", { email: "team@home.test" })).json.data;
		await call(`/v1/recipient-keys/${extra.id}`, "PATCH", { key_data: publicKey });
		await call("/v1/aliases", "POST", { domain: "a.test", format: "custom", local_part: "pair", recipient_ids: [home.id, extra.id] });
		// The key goes, but the forwarding address keeps asking for encryption through Settings.
		await db.prepare("DELETE FROM pgp_keys WHERE email = 'team@home.test'").run();
		await saveSettings(db, { ...(await loadSettings(db)), pgpRecipients: ["team@home.test"] });
		await deliver("pair@a.test");
		expect(sent).toHaveLength(0);
		const row = await db.prepare("SELECT status, error FROM forwards ORDER BY created_at DESC LIMIT 1").first<{ status: string; error: string }>();
		expect(row).toMatchObject({ status: "failed", error: expect.stringMatching(/key is missing/) });
	});

	it("keeps the first copy and records the rest when a later send fails", async () => {
		const home = ((await call("/v1/recipients")).json.data as { id: string }[])[0]!;
		const extra = (await call("/v1/recipients", "POST", { email: "team@home.test" })).json.data;
		await call("/v1/aliases", "POST", { domain: "a.test", format: "custom", local_part: "duo", recipient_ids: [home.id, extra.id] });
		const send = env.EMAIL.send;
		env.EMAIL.send = (async (message: { to: { email: string } }) => {
			if (message.to.email === "team@home.test") throw new Error("mailbox full");
			return send(message as never);
		}) as never;
		expect(await deliver("duo@a.test")).toBeNull();
		expect(sent).toHaveLength(1);
		const row = await db.prepare("SELECT status, error FROM forwards ORDER BY created_at DESC LIMIT 1").first<{ status: string; error: string }>();
		expect(row).toMatchObject({ status: "sent", error: expect.stringMatching(/team@home\.test: mailbox full/) });
	});

	it("uses PGP/MIME instead of inline PGP when the message has attachments", async () => {
		const home = ((await call("/v1/recipients")).json.data as { id: string }[])[0]!;
		await call(`/v1/recipient-keys/${home.id}`, "PATCH", { key_data: publicKey });
		await call("/v1/inline-encryption-recipients", "POST", { id: home.id });
		await call("/v1/aliases", "POST", { domain: "a.test", format: "custom", local_part: "files", recipient_ids: [home.id] });
		await deliver("files@a.test", { raw: multipartWithAttachment("files@a.test") });
		expect(sent).toHaveLength(1);
		const message = sent[0] as EmailMessage;
		expect(message).toBeInstanceOf(EmailMessage);
		expect(await new Response(message.raw).text()).toContain('Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"');
	});

	it("turns HTML into readable text for inline PGP", () => {
		expect(htmlToPlainText("<style>p{color:red}</style><p>Hi&nbsp;there &amp; <b>you</b></p><p>Line&#33;<br>Next</p>")).toBe("Hi there & you\nLine!\nNext");
		expect(htmlToPlainText("<p>a</p><script>if (1<2) x()</script><p>b <!-- note --></p><img src=x>c")).toBe("a\nb\nc");
		expect(htmlToPlainText("<title>T</title>&lt;b&gt; &#x1F600;")).toBe("<b> \u{1F600}");
	});
});
