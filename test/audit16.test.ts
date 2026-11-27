import { Duplex, PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { attachImapSession } from "../bridge/src/imap";
import type { ImapFolderInfo, MailGatewayClient } from "../bridge/src/gateway";
import { createApiKey } from "../src/apikeys";
import { createAlias, getAliasView, listAliasViews, listDestinations, listKnownDestinationEmails, totals } from "../src/compat/aliases";
import { signToken } from "../src/crypto";
import { ensureAlias, ensureContact, matchBlocklistAny, newId, now } from "../src/db";
import { isSafeRegex } from "../src/domain-settings";
import { handleDirectInbound } from "../src/forward";
import worker, { app } from "../src/index";
import { createMailPassword } from "../src/mail-passwords";
import { storeMailboxMessage } from "../src/mailbox";
import { createRule } from "../src/rules";
import { DEFAULT_SETTINGS, saveSettings } from "../src/settings";
import { DEFAULT_S3_OPTIONS } from "../src/storage";
import { testDb } from "./helpers/d1";

const SECRET = "test-signing-secret-audit16-1234567890";

function spyDb(db: D1Database) {
	const sqls: string[] = [];
	const origPrepare = db.prepare.bind(db);
	const origBatch = db.batch.bind(db);
	const wrapped = Object.create(db) as D1Database;
	wrapped.prepare = ((sql: string) => {
		const stmt = origPrepare(sql);
		const origFirst = stmt.first.bind(stmt);
		const origAll = stmt.all.bind(stmt);
		const origRun = stmt.run.bind(stmt);
		const origBind = stmt.bind.bind(stmt);
		const wrapStmt = (s: D1PreparedStatement): D1PreparedStatement => {
			(s as unknown as { __sql?: string }).__sql = sql;
			s.first = (async (...args: unknown[]) => {
				sqls.push(sql);
				return (origFirst as (...a: unknown[]) => Promise<unknown>)(...args);
			}) as typeof s.first;
			s.all = (async (...args: unknown[]) => {
				sqls.push(sql);
				return (origAll as (...a: unknown[]) => Promise<unknown>)(...args);
			}) as typeof s.all;
			s.run = (async (...args: unknown[]) => {
				sqls.push(sql);
				return (origRun as (...a: unknown[]) => Promise<unknown>)(...args);
			}) as typeof s.run;
			s.bind = ((...args: unknown[]) => {
				const bound = origBind(...args);
				const bFirst = bound.first.bind(bound);
				const bAll = bound.all.bind(bound);
				const bRun = bound.run.bind(bound);
				(bound as unknown as { __sql?: string }).__sql = sql;
				bound.first = (async (...a: unknown[]) => {
					sqls.push(sql);
					return (bFirst as (...x: unknown[]) => Promise<unknown>)(...a);
				}) as typeof bound.first;
				bound.all = (async (...a: unknown[]) => {
					sqls.push(sql);
					return (bAll as (...x: unknown[]) => Promise<unknown>)(...a);
				}) as typeof bound.all;
				bound.run = (async (...a: unknown[]) => {
					sqls.push(sql);
					return (bRun as (...x: unknown[]) => Promise<unknown>)(...a);
				}) as typeof bound.run;
				return bound;
			}) as typeof s.bind;
			return s;
		};
		return wrapStmt(stmt);
	}) as typeof db.prepare;
	wrapped.batch = (async (stmts: D1PreparedStatement[]) => origBatch(stmts)) as typeof db.batch;
	return { db: wrapped, sqls };
}

async function makeSignedInCookie(db: D1Database): Promise<string> {
	const ts = now();
	await db.prepare("INSERT INTO passkeys (id, public_key, counter, name, created_at) VALUES ('pk_1', 'AA==', 0, 'Test', ?)").bind(ts).run();
	await db
		.prepare("INSERT INTO sessions (id, passkey_id, created_at, expires_at, last_seen_at) VALUES ('sess_audit16_123456', 'pk_1', ?, ?, ?)")
		.bind(ts, ts + 3600, ts)
		.run();
	const token = await signToken(SECRET, "session", "sess_audit16_123456", 3600);
	return `__Host-af_session=${token}`;
}

function makeEnv(db: D1Database, overrides: Partial<Env> = {}): Env {
	return {
		DB: db,
		SIGNING_SECRET: SECRET,
		PUBLIC_URL: "https://alias.test",
		EMAIL: { send: async () => ({ messageId: "<sent@alias.test>" }) } as unknown as SendEmail,
		...overrides,
	} as Env;
}

describe("Audit 16: Security fixes & Cloudflare efficiency optimizations", () => {
	describe("ReDoS hardening in isSafeRegex()", () => {
		it("rejects nested alternation under quantifier and polynomial quantifier chains", () => {
			expect(isSafeRegex("((a|aa))+")).toBe(false);
			expect(isSafeRegex("(a|b|ab)+")).toBe(false);
			expect(isSafeRegex("((x|xx)*)")).toBe(false);
			expect(isSafeRegex(".*.*.*.*.*.*X")).toBe(false);
			expect(isSafeRegex("a+b+c+d+e+")).toBe(false);
		});

		it("accepts legitimate domain auto-create patterns", () => {
			expect(isSafeRegex("^[a-z0-9]+-[a-z0-9]+$")).toBe(true);
			expect(isSafeRegex("^(shop|news)-[0-9]{2,6}$")).toBe(true);
			expect(isSafeRegex("^dev\\.[a-z0-9._-]+$")).toBe(true);
		});
	});

	describe("Mail Gateway security, rate limits, bounded JSON & efficiency", () => {
		it("enforces pre-D1 API_RATE_LIMIT and LOGIN_RATE_LIMIT on /mail-api/v1", async () => {
			const rawDb = testDb();
			await saveSettings(rawDb, { ...DEFAULT_SETTINGS, aliasDomains: ["alias.test"], mailboxEnabled: true, imapEnabled: true });
			const { db, sqls } = spyDb(rawDb);

			// 1. Pre-D1 rate limit blocks before any D1 query.
			const blockedEnv = makeEnv(db, {
				API_RATE_LIMIT: { limit: async () => ({ success: false }) } as unknown as RateLimit,
			});
			const r429 = await app.fetch(
				new Request("https://alias.test/mail-api/v1/status", {
					headers: { Authorization: `Basic ${Buffer.from("user:wrong").toString("base64")}`, "CF-Connecting-IP": "198.51.100.10" },
				}),
				blockedEnv,
			);
			expect(r429.status).toBe(429);
			expect(sqls.length).toBe(0);

			// 2. Repeated wrong Mail App Passwords hit LOGIN_RATE_LIMIT (keyed per address and username) -> 429,
			// but never lock out the address: another app behind the same bridge IP still signs in.
			const { password } = await createMailPassword(rawDb, { name: "Phone", username: "phone", allowImap: true, allowPop3: false, allowSmtp: false });
			const keys: string[] = [];
			const loginLimitEnv = makeEnv(rawDb, {
				API_RATE_LIMIT: { limit: async () => ({ success: true }) } as unknown as RateLimit,
				LOGIN_RATE_LIMIT: { limit: async ({ key }: { key: string }) => (keys.push(key), { success: false }) } as unknown as RateLimit,
			});
			const status = async (user: string, pass: string) =>
				(
					await app.fetch(
						new Request("https://alias.test/mail-api/v1/status", {
							headers: { Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`, "CF-Connecting-IP": "198.51.100.11" },
						}),
						loginLimitEnv,
					)
				).status;
			expect(await status("laptop", `${password}x`)).toBe(429);
			expect(keys).toEqual(["mailgw:198.51.100.11:laptop"]);
			expect(await status("phone", password)).toBe(200);
		});

		it("rejects oversized JSON control bodies (413) and performs zero D1 writes on GET /imap/folders", async () => {
			const rawDb = testDb();
			await saveSettings(rawDb, { ...DEFAULT_SETTINGS, aliasDomains: ["alias.test"], mailboxEnabled: true, imapEnabled: true });
			const { password } = await createMailPassword(rawDb, { name: "Test", username: "imapuser", allowImap: true, allowPop3: false, allowSmtp: false });
			const auth = `Basic ${Buffer.from(`imapuser:${password}`).toString("base64")}`;

			// Oversized JSON to PATCH /imap/messages/:id/flags (>16 KiB)
			const hugeBody = JSON.stringify({ add: ["a".repeat(20_000)] });
			const r413 = await app.fetch(
				new Request("https://alias.test/mail-api/v1/imap/messages/mb_1/flags", {
					method: "PATCH",
					headers: { Authorization: auth, "Content-Type": "application/json" },
					body: hugeBody,
				}),
				makeEnv(rawDb),
			);
			expect(r413.status).toBe(413);

			// First auth updates last_used_at once; second call within 300s should do ZERO D1 writes on GET /imap/folders.
			await app.fetch(new Request("https://alias.test/mail-api/v1/imap/folders", { headers: { Authorization: auth } }), makeEnv(rawDb));
			const { db, sqls } = spyDb(rawDb);
			const res = await app.fetch(new Request("https://alias.test/mail-api/v1/imap/folders", { headers: { Authorization: auth } }), makeEnv(db));
			expect(res.status).toBe(200);
			const data = (await res.json()) as { folders: { name: string; uidnext: number }[] };
			expect(data.folders.map((f) => f.name)).toEqual(["INBOX", "Skipped", "Failed", "Sent", "Trash"]);
			const writes = sqls.filter((s) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(s));
			expect(writes).toEqual([]);
		});

		it("evaluates sends rules against secondary SMTP recipients and sanitizes headers", async () => {
			const db = testDb();
			await saveSettings(db, {
				...DEFAULT_SETTINGS,
				aliasDomains: ["alias.test"],
				defaultDestination: "owner@example.com",
				mailboxEnabled: true,
				smtpEnabled: true,
			});
			await ensureAlias(db, "shop@alias.test", "", { forwardEnabled: true });
			await createRule(db, {
				name: "Block evil recipient",
				operator: "AND",
				conditions: [{ type: "recipient", match: "is exactly", values: ["blocked@evil.example"] }],
				actions: [{ type: "block", value: "" }],
				forwards: false,
				replies: false,
				sends: true,
				active: true,
			});
			const { password } = await createMailPassword(db, { name: "SMTP", username: "smtpuser", allowImap: false, allowPop3: false, allowSmtp: true });
			const auth = `Basic ${Buffer.from(`smtpuser:${password}`).toString("base64")}`;
			const rawEml = Buffer.from("From: shop@alias.test\r\nTo: ok@example.org, blocked@evil.example\r\nSubject: Hello\r\n\r\nHi\r\n").toString("base64");

			const blockedRes = await app.fetch(
				new Request("https://alias.test/mail-api/v1/smtp/send", {
					method: "POST",
					headers: { Authorization: auth, "Content-Type": "application/json" },
					body: JSON.stringify({ mailFrom: "shop@alias.test", rcptTo: ["ok@example.org", "blocked@evil.example"], raw: rawEml }),
				}),
				makeEnv(db),
			);
			expect(blockedRes.status).toBe(403);
			expect(((await blockedRes.json()) as { error: string }).error).toContain("Blocked by rule");
		});
	});

	describe("Mailbox attachment download & HTML preview hardening", () => {
		it("handles non-ASCII attachment filenames without 500 and forces octet-stream on text/html", async () => {
			const db = testDb();
			const settings = { ...DEFAULT_SETTINGS, aliasDomains: ["alias.test"], mailboxEnabled: true };
			await saveSettings(db, settings);
			const cookie = await makeSignedInCookie(db);
			const config = {
				siteOrigin: "https://alias.test",
				publicUrl: "https://alias.test",
				signingSecret: SECRET,
				outboundProvider: "cloudflare" as const,
				outboundApiKey: "",
				outboundOptions: {} as never,
				workersPlan: "paid" as const,
				mailflareUrl: "",
				mailflareApiKey: "",
				webhookSecret: "",
				cloudflareApiToken: "",
				workerName: "aliasflare",
				mailboxS3: { ...DEFAULT_S3_OPTIONS },
			};
			const rawMime = [
				"From: sender@example.org",
				"To: shop@alias.test",
				"Subject: Files",
				'Content-Type: multipart/mixed; boundary="b1"',
				"",
				"--b1",
				"Content-Type: text/html; charset=utf-8",
				"",
				"<p>Hello</p>",
				"--b1",
				"Content-Type: application/pdf",
				"Content-Disposition: attachment; filename*=UTF-8''%E7%99%BC%E7%A5%A8.pdf",
				"",
				"%PDF-1.4",
				"--b1",
				"Content-Type: text/html; charset=utf-8",
				'Content-Disposition: attachment; filename="evil.html"',
				"",
				"<script>alert(1)</script>",
				"--b1--",
				"",
			].join("\r\n");

			const stored = await storeMailboxMessage(makeEnv(db), config, settings, {
				folder: "INBOX",
				raw: new TextEncoder().encode(rawMime),
			});
			expect(stored).not.toBeNull();

			// Non-ASCII PDF attachment
			const pdfRes = await app.fetch(
				new Request(`https://alias.test/mailbox/${stored!.id}/attachment/0`, { headers: { Cookie: cookie } }),
				makeEnv(db),
			);
			expect(pdfRes.status).toBe(200);
			expect(pdfRes.headers.get("Content-Type")).toBe("application/pdf");
			expect(pdfRes.headers.get("Content-Disposition")).toContain("filename*=UTF-8''%E7%99%BC%E7%A5%A8.pdf");

			// HTML attachment forced to application/octet-stream
			const htmlAttRes = await app.fetch(
				new Request(`https://alias.test/mailbox/${stored!.id}/attachment/1`, { headers: { Cookie: cookie } }),
				makeEnv(db),
			);
			expect(htmlAttRes.status).toBe(200);
			expect(htmlAttRes.headers.get("Content-Type")).toBe("application/octet-stream");

			// HTML preview has tightened CSP
			const previewRes = await app.fetch(
				new Request(`https://alias.test/mailbox/${stored!.id}/html`, { headers: { Cookie: cookie } }),
				makeEnv(db),
			);
			expect(previewRes.status).toBe(200);
			const csp = previewRes.headers.get("Content-Security-Policy") ?? "";
			expect(csp).toContain("form-action 'none'");
			expect(csp).toContain("base-uri 'none'");
		});
	});

	describe("Forwarding D1 write consolidation & blocklist batching", () => {
		it("writes to forwards only twice per delivered message (claim INSERT + final batch UPDATE)", async () => {
			const rawDb = testDb();
			const settings = {
				...DEFAULT_SETTINGS,
				aliasDomains: ["alias.test"],
				defaultDestination: "owner@example.com",
				forwardMethod: "rewrite" as const,
			};
			await saveSettings(rawDb, settings);
			await ensureAlias(rawDb, "news@alias.test", "", { forwardEnabled: true });

			const { db, sqls } = spyDb(rawDb);
			const rawBytes = new TextEncoder().encode(
				"From: Sender <sender@example.org>\r\nTo: news@alias.test\r\nSubject: Weekly\r\nMessage-ID: <m1@example.org>\r\n\r\nHello world\r\n",
			);
			const message = {
				from: "sender@example.org",
				to: "news@alias.test",
				rawSize: rawBytes.byteLength,
				headers: new Headers({ "Message-ID": "<m1@example.org>", Date: "Fri, 01 Jan 2026 00:00:00 +0000" }),
				raw: new ReadableStream<Uint8Array>({
					start(c) {
						c.enqueue(rawBytes);
						c.close();
					},
				}),
				setReject() {},
				forward: async () => {},
				reply: async () => {},
			} as unknown as ForwardableEmailMessage;

			await worker.email!(message, makeEnv(db));

			const forwardWrites = sqls.filter((s) => /\b(INSERT INTO forwards|UPDATE forwards)\b/i.test(s));
			expect(forwardWrites.length).toBe(2);

			// Verify metadata was still persisted cleanly.
			const row = await rawDb.prepare("SELECT status, subject, original_message_id, contact_id FROM forwards").first<Record<string, unknown>>();
			expect(row?.status).toBe("sent");
			expect(row?.subject).toBe("Weekly");
			expect(row?.original_message_id).toBe("<m1@example.org>");
			expect(row?.contact_id).toBeTruthy();
		});

		it("matchBlocklistAny checks multiple senders in one SQL query", async () => {
			const rawDb = testDb();
			await rawDb.prepare("INSERT INTO blocklist (id, kind, value, created_at) VALUES ('bl_1', 'domain', 'spam.example', ?)").bind(now()).run();
			const { db, sqls } = spyDb(rawDb);
			const hit = await matchBlocklistAny(db, ["ok@good.example", "bad@sub.spam.example"]);
			expect(hit?.value).toBe("spam.example");
			// 1 SELECT + 1 hit counter UPDATE
			const selects = sqls.filter((s) => /^\s*SELECT\b/i.test(s));
			expect(selects.length).toBe(1);
		});
	});

	describe("Compat API, alias stats CTE, bulk endpoints & SQL indexes", () => {
		it("computes accurate alias stats, totals, destinations, and preloads /v1/aliases/get/bulk without N+1", async () => {
			const rawDb = testDb();
			const settings = {
				...DEFAULT_SETTINGS,
				aliasDomains: ["alias.test"],
				defaultDestination: "owner@example.com",
				addyApi: true,
				appSettings: true,
			};
			await saveSettings(rawDb, settings);
			const a1 = await createAlias(rawDb, settings, { localPart: "one", domain: "alias.test" });
			const a2 = await createAlias(rawDb, settings, { localPart: "two", domain: "alias.test", destination: "alt@example.com" });
			const c1 = await ensureContact(rawDb, a1.address, "friend@example.org", "Friend", false);
			await rawDb.prepare("UPDATE contacts SET forward_count = 3, reply_count = 1, last_forward_at = 1700000000 WHERE id = ?").bind(c1.id).run();
			await rawDb
				.prepare("INSERT INTO forwards (id, inbound_id, alias_address, status, created_at, updated_at) VALUES ('fw_skip', 'in_1', ?, 'skipped', 1700000100, 1700000100)")
				.bind(a1.address)
				.run();

			const view = await getAliasView(rawDb, { address: a1.address });
			expect(view?.nb_forward).toBe(3);
			expect(view?.nb_reply).toBe(1);
			expect(view?.nb_block).toBe(1);
			expect(view?.last_forward_at).toBe(1700000000);
			expect(view?.last_block_at).toBe(1700000100);

			const sortedByFwd = await listAliasViews(rawDb, { sort: { key: "emails_forwarded", desc: true }, limit: 10, offset: 0 });
			expect(sortedByFwd.aliases[0]?.address).toBe(a1.address);

			const t = await totals(rawDb);
			expect(t.aliases).toBe(2);
			expect(t.forwarded).toBe(3);
			expect(t.replied).toBe(1);
			expect(t.blocked).toBe(1);

			const known = await listKnownDestinationEmails(rawDb, settings);
			expect(known.has("owner@example.com")).toBe(true);
			expect(known.has("alt@example.com")).toBe(true);

			const dests = await listDestinations(rawDb, settings);
			expect(dests.find((d) => d.email === "owner@example.com")?.aliasCount).toBe(1);
			expect(dests.find((d) => d.email === "alt@example.com")?.aliasCount).toBe(1);

			// Bulk get preloads recipients without per-alias N+1 queries.
			const { key } = await createApiKey(rawDb, "Addy", "apps");
			const { db, sqls } = spyDb(rawDb);
			const bulkRes = await app.fetch(
				new Request("https://alias.test/api/v1/aliases/get/bulk", {
					method: "POST",
					headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
					body: JSON.stringify({ ids: [a1.uid, a2.uid] }),
				}),
				makeEnv(db),
			);
			expect(bulkRes.status).toBe(200);
			const bulkData = (await bulkRes.json()) as { data: { id: string }[] };
			expect(bulkData.data.length).toBe(2);
			// Should stay small and constant (not scaling linearly per alias).
			expect(sqls.length).toBeLessThan(20);
		});

		it("batches failed-deliveries and blocklist bulk delete endpoints", async () => {
			const db = testDb();
			await saveSettings(db, { ...DEFAULT_SETTINGS, aliasDomains: ["alias.test"], addyApi: true, appSettings: true });
			const { key } = await createApiKey(db, "Addy", "apps");
			const ts = now();
			await db
				.prepare("INSERT INTO forwards (id, inbound_id, alias_address, status, dismissed, created_at, updated_at) VALUES ('fw_f1', 'i1', 'a@alias.test', 'failed', 0, ?, ?), ('fw_f2', 'i2', 'a@alias.test', 'failed', 0, ?, ?)")
				.bind(ts, ts, ts, ts)
				.run();
			await db
				.prepare("INSERT INTO blocklist (id, kind, value, created_at) VALUES ('bl_d1', 'domain', 'a.example', ?), ('bl_d2', 'domain', 'b.example', ?)")
				.bind(ts, ts)
				.run();

			const fdRes = await app.fetch(
				new Request("https://alias.test/api/v1/failed-deliveries/delete/bulk", {
					method: "POST",
					headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
					body: JSON.stringify({ ids: ["fw_f1", "fw_f2", "fw_missing"] }),
				}),
				makeEnv(db),
			);
			expect(fdRes.status).toBe(200);
			expect(((await fdRes.json()) as { ids: string[] }).ids.sort()).toEqual(["fw_f1", "fw_f2"]);

			const blRes = await app.fetch(
				new Request("https://alias.test/api/v1/blocklist/delete/bulk", {
					method: "POST",
					headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
					body: JSON.stringify({ ids: ["bl_d1", "bl_d2", "bl_missing"] }),
				}),
				makeEnv(db),
			);
			expect(blRes.status).toBe(200);
			expect(((await blRes.json()) as { ids: string[] }).ids.sort()).toEqual(["bl_d1", "bl_d2"]);
		});

		it("uses new migration 0020 indexes in SQLite query plans", async () => {
			const db = testDb();
			const plan1 = await db
				.prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM events WHERE kind = 'smtp_send' AND created_at > 1000")
				.all<{ detail: string }>();
			expect(plan1.results.some((r) => r.detail.includes("events_kind_created_idx"))).toBe(true);

			const plan2 = await db
				.prepare("EXPLAIN QUERY PLAN SELECT id FROM mailbox_messages WHERE folder = 'Trash' AND updated_at < 1000")
				.all<{ detail: string }>();
			expect(plan2.results.some((r) => r.detail.includes("mailbox_messages_trash_updated_idx"))).toBe(true);
		});
	});

	describe("Bridge IMAP hardening & lightweight NOOP/IDLE polling", () => {
		it("refreshes fully on an explicit NOOP, so flags changed elsewhere reach the client", async () => {
			let folderCalls = 0;
			let messageCalls = 0;
			const folders: ImapFolderInfo[] = [{ name: "INBOX", specialUse: null, uidvalidity: 1, uidnext: 2, exists: 1, unseen: 0 }];
			const fakeGateway = {
				status: async () => ({
					ok: true,
					username: "u",
					mailboxEnabled: true,
					protocols: { imap: true, pop3: false, smtp: false },
					pop3Folders: ["INBOX"],
					pop3DeleteAction: "trash",
					smtpFromPolicy: "existing_aliases",
					smtpRateLimitPerHour: 50,
				}),
				imapFolders: async () => {
					folderCalls += 1;
					return folders;
				},
				imapMessages: async () => {
					messageCalls += 1;
					return {
						folder: "INBOX",
						uidvalidity: 1,
						uidnext: 2,
						messages: [
							{
								id: "mb_1",
								uid: 1,
								flags: ["\\Seen"],
								size: 42,
								internalDate: "2026-01-01T00:00:00.000Z",
								createdAt: 1700000000,
								subject: "Hi",
								from: "a@example.org",
								fromName: null,
								to: "b@alias.test",
								alias: "b@alias.test",
								snippet: "Hi",
								reason: null,
							},
						],
					};
				},
			} as unknown as MailGatewayClient;

			const c2s = new PassThrough();
			const s2c = new PassThrough();
			const server = new Duplex({
				read() {},
				write(chunk, _enc, cb) {
					s2c.write(chunk, cb);
				},
				final(cb) {
					s2c.end(cb);
				},
			});
			c2s.on("data", (d) => server.push(d));
			c2s.on("end", () => server.push(null));

			let out = "";
			const ended = new Promise<void>((resolve) => {
				s2c.on("data", (d) => {
					out += d.toString("utf8");
				});
				s2c.on("end", resolve);
			});

			attachImapSession(server, { gateway: fakeGateway, allowPlaintextAuth: true }, false);
			for (const cmd of ["A1 LOGIN u p", "A2 SELECT INBOX", "A3 NOOP", "A4 LOGOUT"]) {
				await new Promise((r) => setTimeout(r, 20));
				c2s.write(`${cmd}\r\n`);
			}
			await Promise.race([ended, new Promise((r) => setTimeout(r, 1000))]);
			expect(out).toContain("A3 OK NOOP completed");
			// SELECT and NOOP each fetch the list (flags may have changed with the same count); only
			// the IDLE timer uses the lighter imapFolders() check.
			expect(messageCalls).toBe(2);
			expect(folderCalls).toBe(0);
		});
	});
});
