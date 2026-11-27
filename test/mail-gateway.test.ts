import { PassThrough, Duplex } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/index";
import { createMailPassword, deleteMailPassword, listMailPasswords } from "../src/mail-passwords";
import { storeMailboxMessage } from "../src/mailbox";
import { DEFAULT_SETTINGS, saveSettings } from "../src/settings";
import { DEFAULT_S3_OPTIONS } from "../src/storage";
import { MailGatewayClient } from "../bridge/src/gateway";
import { attachImapSession } from "../bridge/src/imap";
import { attachPop3Session } from "../bridge/src/pop3";
import { attachSmtpSession } from "../bridge/src/smtp";
import { testDb } from "./helpers/d1";

function createPair(): { client: Duplex; server: Duplex } {
	const c2s = new PassThrough();
	const s2c = new PassThrough();
	const client = new Duplex({
		read() {},
		write(chunk, enc, cb) {
			c2s.write(chunk, enc, cb);
		},
		final(cb) {
			c2s.end(cb);
		},
	});
	s2c.on("data", (d) => client.push(d));
	s2c.on("end", () => client.push(null));

	const server = new Duplex({
		read() {},
		write(chunk, enc, cb) {
			s2c.write(chunk, enc, cb);
		},
		final(cb) {
			s2c.end(cb);
		},
	});
	c2s.on("data", (d) => server.push(d));
	c2s.on("end", () => server.push(null));

	return { client, server };
}

async function runTranscript(
	attach: (sock: Duplex) => void,
	commands: string[],
): Promise<string> {
	const { client, server } = createPair();
	let output = "";
	const done = new Promise<string>((resolve) => {
		client.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
		});
		client.on("end", () => resolve(output));
	});
	attach(server);
	for (const cmd of commands) {
		await new Promise((r) => setTimeout(r, 25));
		client.write(`${cmd}\r\n`);
	}
	return Promise.race([
		done,
		new Promise<string>((resolve) => setTimeout(() => resolve(output), 2000)),
	]);
}

describe("Mail Gateway API (/mail-api/v1) and IMAP / POP3 / SMTP Bridge", () => {
	let db: D1Database;
	let sentOutbound: { from: string; to: string; subject: string }[];
	let env: Env;
	const baseConfig = {
		siteOrigin: "https://alias.test",
		publicUrl: "https://alias.test",
		signingSecret: "test-signing-secret-12345678901234567890",
		outboundProvider: "cloudflare" as const,
		outboundApiKey: "",
		outboundOptions: {} as any,
		workersPlan: "paid" as const,
		mailflareUrl: "",
		mailflareApiKey: "",
		webhookSecret: "",
		cloudflareApiToken: "",
		workerName: "aliasflare",
		mailboxS3: { ...DEFAULT_S3_OPTIONS },
	};

	const rawEml = (from: string, to: string, subject: string, body: string) =>
		new TextEncoder().encode(`From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${crypto.randomUUID()}@test>\r\n\r\n${body}\r\n`);

	const basicHeader = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

	const callGateway = async (path: string, creds: { user: string; pass: string }, opts: RequestInit = {}) => {
		const res = await app.fetch(
			new Request(`https://alias.test/mail-api/v1${path}`, {
				...opts,
				headers: {
					Authorization: basicHeader(creds.user, creds.pass),
					...(opts.body ? { "Content-Type": "application/json" } : {}),
					...(opts.headers ?? {}),
				},
			}),
			env,
		);
		return res;
	};

	beforeEach(async () => {
		db = testDb();
		sentOutbound = [];
		env = {
			DB: db,
			SIGNING_SECRET: baseConfig.signingSecret,
			WORKERS_PLAN: "paid",
			EMAIL: {
				send: async (payload: any) => {
					sentOutbound.push({
						from: typeof payload.from === "string" ? payload.from : payload.from.email,
						to: Array.isArray(payload.to) ? payload.to[0] : payload.to,
						subject: payload.subject ?? "",
					});
					return { messageId: `<out-${sentOutbound.length}@alias.test>` };
				},
			} as any,
		} as unknown as Env;

		await saveSettings(db, {
			...DEFAULT_SETTINGS,
			aliasDomains: ["a.test"],
			defaultDestination: "me@home.test",
		});
		await db
			.prepare("INSERT INTO aliases (address, num_id, uid, forward_mode, forward_enabled, created_at, updated_at) VALUES ('shop@a.test', 1, 'u1', 'all', 1, 1, 1)")
			.run();
	});

	it("keeps IMAP, POP3 and SMTP off by default and enforces per-password scopes", async () => {
		const { password, row } = await createMailPassword(db, {
			name: "Thunderbird",
			username: "owner",
			allowImap: true,
			allowPop3: false,
			allowSmtp: true,
		});
		expect(password.startsWith("afm_")).toBe(true);
		expect((await listMailPasswords(db)).map((r) => r.id)).toContain(row.id);

		// Global toggles are off by default -> 403
		expect((await callGateway("/imap/folders", { user: "owner", pass: password })).status).toBe(403);
		expect((await callGateway("/pop3/messages", { user: "owner", pass: password })).status).toBe(403);
		expect(
			(
				await callGateway("/smtp/send", { user: "owner", pass: password }, {
					method: "POST",
					body: JSON.stringify({ mailFrom: "shop@a.test", rcptTo: ["friend@x.test"], raw: "" }),
				})
			).status,
		).toBe(403);

		// Enable all 3 protocols globally
		await saveSettings(db, {
			...DEFAULT_SETTINGS,
			aliasDomains: ["a.test"],
			imapEnabled: true,
			pop3Enabled: true,
			smtpEnabled: true,
		});

		// Wrong username -> 401
		expect((await callGateway("/imap/folders", { user: "wrong", pass: password })).status).toBe(401);
		// IMAP allowed by scope -> 200
		expect((await callGateway("/imap/folders", { user: "owner", pass: password })).status).toBe(200);
		// POP3 NOT allowed by password scope -> 401
		expect((await callGateway("/pop3/messages", { user: "owner", pass: password })).status).toBe(401);

		// Revoking the password immediately invalidates access
		await deleteMailPassword(db, row.id);
		expect((await callGateway("/imap/folders", { user: "owner", pass: password })).status).toBe(401);
	});

	it("supports IMAP folders, flags, move, copy, append, and expunge via Gateway API", async () => {
		await saveSettings(db, { ...DEFAULT_SETTINGS, aliasDomains: ["a.test"], imapEnabled: true });
		const { password } = await createMailPassword(db, { name: "Client", username: "me", allowImap: true, allowPop3: false, allowSmtp: false });
		const creds = { user: "me", pass: password };

		const stored = await storeMailboxMessage(env, baseConfig, { ...DEFAULT_SETTINGS, imapEnabled: true }, {
			folder: "Skipped",
			aliasAddress: "shop@a.test",
			fromAddress: "promo@store.test",
			toAddress: "shop@a.test",
			subject: "Blocked promo",
			reason: "promotions",
			raw: rawEml("promo@store.test", "shop@a.test", "Blocked promo", "Discount 50%"),
		});
		expect(stored).not.toBeNull();

		const foldersRes = await (await callGateway("/imap/folders", creds)).json() as any;
		const skippedFolder = foldersRes.folders.find((f: any) => f.name === "Skipped");
		expect(skippedFolder.exists).toBe(1);
		expect(skippedFolder.unseen).toBe(1);

		// Flags
		const flagRes = await callGateway(`/imap/messages/${stored!.id}/flags`, creds, {
			method: "PATCH",
			body: JSON.stringify({ add: ["\\Seen", "\\Flagged"] }),
		});
		expect((await flagRes.json() as any).flags).toEqual(["\\Seen", "\\Flagged"]);

		// Copy to INBOX
		const copyRes = await callGateway(`/imap/messages/${stored!.id}/copy`, creds, {
			method: "POST",
			body: JSON.stringify({ folder: "INBOX" }),
		});
		const copied = await copyRes.json() as any;
		expect(copied.folder).toBe("INBOX");
		expect(copied.id).not.toBe(stored!.id);

		// Mark original \Deleted and expunge Skipped
		await callGateway(`/imap/messages/${stored!.id}/flags`, creds, {
			method: "PATCH",
			body: JSON.stringify({ add: ["\\Deleted"] }),
		});
		const expungeRes = await callGateway("/imap/folders/Skipped/expunge", creds, { method: "POST" });
		expect((await expungeRes.json() as any).expunged).toEqual([stored!.uid]);

		// Append new message to Sent
		const appendRes = await callGateway("/imap/folders/Sent/append", creds, {
			method: "POST",
			body: JSON.stringify({
				raw: Buffer.from(rawEml("shop@a.test", "bob@x.test", "Appended", "Hello Bob")).toString("base64"),
				flags: ["\\Seen"],
			}),
		});
		expect(appendRes.status).toBe(201);
	});

	it("supports POP3 folder selection and delete actions (trash / archive / expunge)", async () => {
		const settings = {
			...DEFAULT_SETTINGS,
			aliasDomains: ["a.test"],
			pop3Enabled: true,
			pop3Folders: ["INBOX", "Failed"] as ("INBOX" | "Failed")[],
			pop3DeleteAction: "trash" as const,
		};
		await saveSettings(db, settings);
		const { password } = await createMailPassword(db, { name: "Pop", username: "pop", allowImap: false, allowPop3: true, allowSmtp: false });
		const creds = { user: "pop", pass: password };

		const m1 = await storeMailboxMessage(env, baseConfig, settings, {
			folder: "Failed",
			fromAddress: "a@x.test",
			toAddress: "shop@a.test",
			subject: "Failed msg",
			raw: rawEml("a@x.test", "shop@a.test", "Failed msg", "Body 1"),
		});
		await storeMailboxMessage(env, baseConfig, settings, {
			folder: "Skipped",
			fromAddress: "b@x.test",
			toAddress: "shop@a.test",
			subject: "Hidden from POP3",
			raw: rawEml("b@x.test", "shop@a.test", "Hidden from POP3", "Body 2"),
		});

		const list = await (await callGateway("/pop3/messages", creds)).json() as any;
		expect(list.messages).toHaveLength(1);
		expect(list.messages[0].id).toBe(m1!.id);

		// Delete moves to Trash
		const del = await callGateway(`/pop3/messages/${m1!.id}`, creds, { method: "DELETE" });
		expect((await del.json() as any).action).toBe("trash");
		const row = await db.prepare("SELECT folder FROM mailbox_messages WHERE id = ?").bind(m1!.id).first<{ folder: string }>();
		expect(row?.folder).toBe("Trash");
	});

	it("enforces SMTP From policy (existing_aliases vs auto_create), rate limits, and Sent copy", async () => {
		await saveSettings(db, {
			...DEFAULT_SETTINGS,
			aliasDomains: ["a.test"],
			smtpEnabled: true,
			smtpFromPolicy: "existing_aliases",
			smtpRateLimitPerHour: 2,
			storeSentCopy: true,
		});
		const { password } = await createMailPassword(db, { name: "Smtp", username: "smtp", allowImap: false, allowPop3: false, allowSmtp: true });
		const creds = { user: "smtp", pass: password };

		const sendBody = (from: string, to: string, subject: string) =>
			JSON.stringify({
				mailFrom: from,
				rcptTo: [to],
				raw: Buffer.from(rawEml(from, to, subject, "Hi from SMTP")).toString("base64"),
			});

		// Non-existent alias blocked under existing_aliases policy
		expect((await callGateway("/smtp/send", creds, { method: "POST", body: sendBody("new@a.test", "bob@x.test", "Test") })).status).toBe(403);

		// Existing alias succeeds and archives in Sent
		const okRes = await callGateway("/smtp/send", creds, { method: "POST", body: sendBody("shop@a.test", "bob@x.test", "Hello Bob") });
		expect(okRes.status).toBe(200);
		expect(sentOutbound).toHaveLength(1);
		expect(sentOutbound[0]).toMatchObject({ from: "shop@a.test", to: "bob@x.test", subject: "Hello Bob" });

		const sentCount = await db.prepare("SELECT COUNT(*) AS n FROM mailbox_messages WHERE folder = 'Sent'").first<{ n: number }>();
		expect(Number(sentCount?.n)).toBe(1);

		// Enable auto_create -> new@a.test succeeds and creates alias
		await saveSettings(db, {
			...DEFAULT_SETTINGS,
			aliasDomains: ["a.test"],
			smtpEnabled: true,
			smtpFromPolicy: "auto_create",
			smtpRateLimitPerHour: 2,
		});
		const autoRes = await callGateway("/smtp/send", creds, { method: "POST", body: sendBody("new@a.test", "bob@x.test", "Auto") });
		expect(autoRes.status).toBe(200);

		// 3rd send within the hour hits rate limit (429)
		const limitedRes = await callGateway("/smtp/send", creds, { method: "POST", body: sendBody("shop@a.test", "bob@x.test", "Too many") });
		expect(limitedRes.status).toBe(429);
	});

	it("runs end-to-end IMAP, POP3, and SMTP Bridge sessions against the Worker Gateway", async () => {
		const settings = {
			...DEFAULT_SETTINGS,
			aliasDomains: ["a.test"],
			imapEnabled: true,
			pop3Enabled: true,
			smtpEnabled: true,
			pop3Folders: ["INBOX", "Skipped", "Failed"] as ("INBOX" | "Skipped" | "Failed")[],
		};
		await saveSettings(db, settings);
		const { password } = await createMailPassword(db, {
			name: "All",
			username: "bridgeuser",
			allowImap: true,
			allowPop3: true,
			allowSmtp: true,
		});
		await storeMailboxMessage(env, baseConfig, settings, {
			folder: "INBOX",
			aliasAddress: "shop@a.test",
			fromAddress: "alice@x.test",
			toAddress: "shop@a.test",
			subject: "Welcome to Bridge",
			raw: rawEml("alice@x.test", "shop@a.test", "Welcome to Bridge", "Hello via IMAP and POP3"),
		});

		const gateway = new MailGatewayClient("https://alias.test", async (input, init) => {
			const req = input instanceof Request ? input : new Request(String(input), init);
			return await app.fetch(req, env);
		});

		// 1. Plaintext auth refused when not TLS and allowPlaintextAuth=false
		const refusedImap = await runTranscript(
			(s) => attachImapSession(s, { gateway, allowPlaintextAuth: false }, false),
			[`a1 LOGIN bridgeuser ${password}`, "a2 LOGOUT"],
		);
		expect(refusedImap).toContain("PRIVACYREQUIRED");

		// 2. IMAP full session (simulated TLS)
		const imapOut = await runTranscript(
			(s) => attachImapSession(s, { gateway }, true),
			[
				"a1 CAPABILITY",
				`a2 LOGIN bridgeuser ${password}`,
				'a3 LIST "" "*"',
				"a4 SELECT INBOX",
				"a5 FETCH 1 (UID FLAGS BODY.PEEK[HEADER.FIELDS (SUBJECT)] BODY.PEEK[TEXT])",
				"a6 STORE 1 +FLAGS (\\Flagged)",
				"a7 LOGOUT",
			],
		);
		expect(imapOut).toContain("a2 OK");
		expect(imapOut).toContain('"Skipped"');
		expect(imapOut).toContain('"Failed"');
		expect(imapOut).toContain("Subject: Welcome to Bridge");
		expect(imapOut).toContain("Hello via IMAP and POP3");
		expect(imapOut).toContain("\\Flagged");

		// 3. POP3 full session (simulated TLS)
		const pop3Out = await runTranscript(
			(s) => attachPop3Session(s, { gateway }, true),
			["CAPA", "USER bridgeuser", `PASS ${password}`, "STAT", "UIDL", "RETR 1", "QUIT"],
		);
		expect(pop3Out).toContain("+OK Logged in, 1 messages");
		expect(pop3Out).toContain("Welcome to Bridge");
		expect(pop3Out).toContain("Hello via IMAP and POP3");

		// 4. SMTP full session (simulated TLS)
		const authPlain = Buffer.from(`\0bridgeuser\0${password}`, "utf8").toString("base64");
		const smtpOut = await runTranscript(
			(s) => attachSmtpSession(s, { gateway }, true),
			[
				"EHLO client.test",
				`AUTH PLAIN ${authPlain}`,
				"MAIL FROM:<shop@a.test>",
				"RCPT TO:<carol@x.test>",
				"DATA",
				"From: shop@a.test",
				"To: carol@x.test",
				"Subject: Sent via Bridge SMTP",
				"",
				"Body sent from Thunderbird",
				".",
				"QUIT",
			],
		);
		expect(smtpOut).toContain("235 2.7.0 Authentication successful");
		expect(smtpOut).toContain("250 2.0.0 Queued");
		expect(sentOutbound).toHaveLength(1);
		expect(sentOutbound[0]).toMatchObject({ from: "shop@a.test", to: "carol@x.test", subject: "Sent via Bridge SMTP" });
	});
});
