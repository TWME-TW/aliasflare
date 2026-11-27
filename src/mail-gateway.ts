/**
 * Mail Gateway API (/mail-api/v1) for IMAP / POP3 / SMTP access.
 *
 * Cloudflare Workers cannot listen on raw TCP ports 143/993/110/995/465/587, so standard mail
 * clients connect to the stateless companion Bridge (`bridge/`), which authenticates each session
 * against this HTTPS API using scoped Mail App Passwords (`afm_...`).
 */
import { Hono, type Context } from "hono";
import PostalMime from "postal-mime";
import type { AppEnv } from "./auth";
import { ensureAlias, newId, now, recordEvent, type AliasRow } from "./db";
import { bytesToBase64 } from "./crypto";
import { getDomainRow } from "./domain-settings";
import { cleanDisplayName, domainOf, extractEmail, normalizeEmail } from "./format";
import {
	deleteMailboxMessage,
	folderStats,
	folderUidState,
	getMailboxMessage,
	isMailboxFolder,
	MAILBOX_FOLDERS,
	moveMailboxMessage,
	parseFlags,
	readMailboxRaw,
	storeMailboxMessage,
	updateMailboxFlags,
	type MailboxFolder,
	type MailboxMessageRow,
} from "./mailbox";
import { mailflareReady } from "./config";
import { mailflareConfig, sendViaMailflare } from "./mailflare";
import { parseMailCredentials, verifyMailPassword, type MailPasswordRow, type MailProtocol } from "./mail-passwords";
import { sendOutbound, type OutboundAttachment } from "./outbound";
import { runRules } from "./rules";
import { clientKey } from "./ratelimit";
import { loadSettings, type Settings } from "./settings";
import { readLimited } from "./streams";

const MAX_GATEWAY_RAW_BYTES = 10 * 1024 * 1024;
const MAX_SMTP_RECIPIENTS = 20;

const SPECIAL_USE: Record<MailboxFolder, string | null> = {
	INBOX: null,
	Skipped: "\\Junk",
	Failed: "\\Flagged",
	Sent: "\\Sent",
	Trash: "\\Trash",
};

type GatewayEnv = AppEnv & {
	Variables: AppEnv["Variables"] & {
		mailCred: MailPasswordRow;
		mailSettings: Settings;
	};
};

function base64ToUint8Array(b64: string): Uint8Array | null {
	try {
		const bin = atob(b64.replace(/\s+/g, ""));
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
		return out;
	} catch {
		return null;
	}
}

function synthesizeHeadersOnlyRaw(msg: {
	from_address: string;
	from_name: string | null;
	to_address: string;
	subject: string;
	snippet: string;
	raw_headers: string | null;
	created_at: number;
}): Uint8Array {
	const headerBlock =
		msg.raw_headers?.trim() ||
		[
			`From: ${msg.from_name ? `"${msg.from_name.replace(/"/g, "")}" <${msg.from_address}>` : msg.from_address || "unknown@invalid"}`,
			`To: ${msg.to_address || "unknown@invalid"}`,
			`Subject: ${msg.subject || "(no subject)"}`,
			`Date: ${new Date(msg.created_at * 1000).toUTCString()}`,
			"Content-Type: text/plain; charset=utf-8",
		].join("\r\n");
	const body = msg.snippet || "[Message body was not stored — headers only]";
	return new TextEncoder().encode(`${headerBlock}\r\n\r\n${body}\r\n`);
}

function protocolForPath(pathname: string): MailProtocol | null {
	if (pathname.includes("/imap/")) return "imap";
	if (pathname.includes("/pop3/")) return "pop3";
	if (pathname.includes("/smtp/")) return "smtp";
	return null;
}

export const mailGateway = new Hono<GatewayEnv>();

// Authenticate every request using Mail App Passwords + check global & per-key protocol toggles.
mailGateway.use("*", async (c, next) => {
	// clientKey buckets IPv6 per /64: the bridge's egress hosts must not dodge the limit by
	// rotating addresses within their /64.
	const ip = clientKey(c.req.header("CF-Connecting-IP"));
	if (c.env.API_RATE_LIMIT) {
		const { success } = await c.env.API_RATE_LIMIT.limit({ key: `mailgw:${ip}` });
		if (!success) return c.json({ error: "Rate limit exceeded" }, 429);
	}
	const creds = parseMailCredentials(c.req.raw.headers);
	if (!creds) {
		return c.json({ error: "Authentication required" }, 401, { "WWW-Authenticate": 'Basic realm="aliasflare-mail"' });
	}
	const protocol = protocolForPath(new URL(c.req.url).pathname);
	const settings = await loadSettings(c.env.DB);

	if (protocol === "imap" && (!settings.mailboxEnabled || !settings.imapEnabled)) {
		return c.json({ error: "IMAP is disabled" }, 403);
	}
	if (protocol === "pop3" && (!settings.mailboxEnabled || !settings.pop3Enabled)) {
		return c.json({ error: "POP3 is disabled" }, 403);
	}
	if (protocol === "smtp" && !settings.smtpEnabled) {
		return c.json({ error: "SMTP is disabled" }, 403);
	}

	const country = ((c.req.raw as Request & { cf?: { country?: string } }).cf?.country ?? "").toUpperCase() || null;
	const row = await verifyMailPassword(c.env.DB, creds, protocol ?? undefined, country);
	if (!row) {
		return c.json({ error: "Invalid credentials or protocol not permitted" }, 401);
	}
	c.set("mailCred", row);
	c.set("mailSettings", settings);
	c.header("Cache-Control", "no-store");
	return next();
});

// Status & capability discovery for the Bridge.
mailGateway.get("/status", async (c) => {
	const cred = c.get("mailCred");
	const settings = c.get("mailSettings");
	return c.json({
		ok: true,
		username: cred.username,
		mailboxEnabled: settings.mailboxEnabled,
		protocols: {
			imap: settings.mailboxEnabled && settings.imapEnabled && !!cred.allow_imap,
			pop3: settings.mailboxEnabled && settings.pop3Enabled && !!cred.allow_pop3,
			smtp: settings.smtpEnabled && !!cred.allow_smtp,
		},
		pop3Folders: settings.pop3Folders,
		pop3DeleteAction: settings.pop3DeleteAction,
		smtpFromPolicy: settings.smtpFromPolicy,
		smtpRateLimitPerHour: settings.smtpRateLimitPerHour,
	});
});

// ---------- IMAP Endpoints ----------

mailGateway.get("/imap/folders", async (c) => {
	const db = c.env.DB;
	const stats = await folderStats(db);
	const folders = [];
	for (const name of MAILBOX_FOLDERS) {
		const uidState = await folderUidState(db, name);
		folders.push({
			name,
			specialUse: SPECIAL_USE[name],
			uidvalidity: uidState.uidvalidity,
			uidnext: uidState.uidnext,
			exists: stats[name].total,
			unseen: stats[name].unread,
		});
	}
	return c.json({ folders });
});

mailGateway.get("/imap/folders/:folder/messages", async (c) => {
	const folder = c.req.param("folder");
	if (!isMailboxFolder(folder)) return c.json({ error: "Unknown folder" }, 404);
	const sinceUid = Math.max(0, Math.floor(Number(c.req.query("sinceUid") ?? 0)) || 0);
	const limit = Math.min(2000, Math.max(1, Math.floor(Number(c.req.query("limit") ?? 1000)) || 1000));
	const uidState = await folderUidState(c.env.DB, folder);
	const { results } = await c.env.DB.prepare(
		"SELECT * FROM mailbox_messages WHERE folder = ? AND uid > ? ORDER BY uid ASC LIMIT ?",
	)
		.bind(folder, sinceUid, limit)
		.all<MailboxMessageRow>();
	return c.json({
		folder,
		uidvalidity: uidState.uidvalidity,
		uidnext: uidState.uidnext,
		messages: results.map((row) => ({
			id: row.id,
			uid: row.uid,
			flags: parseFlags(row.flags),
			size: row.size_bytes || row.snippet.length + (row.raw_headers?.length ?? 0),
			internalDate: new Date(row.created_at * 1000).toISOString(),
			createdAt: row.created_at,
			subject: row.subject,
			from: row.from_address,
			fromName: row.from_name,
			to: row.to_address,
			alias: row.alias_address,
			snippet: row.snippet,
			reason: row.reason,
			storageKind: row.storage_kind,
		})),
	});
});

mailGateway.get("/imap/messages/:id/raw", async (c) => {
	const msg = await getMailboxMessage(c.env.DB, c.req.param("id"));
	if (!msg) return c.json({ error: "Message not found" }, 404);
	const raw = (await readMailboxRaw(c.env, c.get("config"), msg)) ?? synthesizeHeadersOnlyRaw(msg);
	return c.body(raw as Uint8Array<ArrayBuffer>, 200, { "Content-Type": "message/rfc822" });
});

mailGateway.patch("/imap/messages/:id/flags", async (c) => {
	const body = await c.req.json<{ add?: string[]; remove?: string[]; set?: string[] }>().catch(() => null);
	if (!body || typeof body !== "object") return c.json({ error: "Invalid JSON" }, 400);
	const cleanList = (arr?: unknown) =>
		Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 64).slice(0, 32) : undefined;
	const updated = await updateMailboxFlags(c.env.DB, c.req.param("id"), {
		add: cleanList(body.add),
		remove: cleanList(body.remove),
		set: cleanList(body.set),
	});
	if (!updated) return c.json({ error: "Message not found" }, 404);
	return c.json({ id: updated.id, flags: updated.flags });
});

mailGateway.post("/imap/messages/:id/move", async (c) => {
	const body = await c.req.json<{ folder?: string }>().catch(() => null);
	if (!body || !isMailboxFolder(body.folder)) return c.json({ error: "Invalid folder" }, 400);
	const moved = await moveMailboxMessage(c.env.DB, c.req.param("id"), body.folder);
	if (!moved) return c.json({ error: "Message not found" }, 404);
	return c.json({ id: moved.id, folder: moved.folder, uid: moved.uid });
});

mailGateway.post("/imap/messages/:id/copy", async (c) => {
	const body = await c.req.json<{ folder?: string }>().catch(() => null);
	if (!body || !isMailboxFolder(body.folder)) return c.json({ error: "Invalid folder" }, 400);
	const original = await getMailboxMessage(c.env.DB, c.req.param("id"));
	if (!original) return c.json({ error: "Message not found" }, 404);
	const raw = await readMailboxRaw(c.env, c.get("config"), original);
	const copied = await storeMailboxMessage(c.env, c.get("config"), c.get("mailSettings"), {
		folder: body.folder,
		aliasAddress: original.alias_address,
		fromAddress: original.from_address,
		fromName: original.from_name,
		toAddress: original.to_address,
		subject: original.subject,
		snippet: original.snippet,
		reason: original.reason,
		reasonDetail: original.reason_detail,
		flags: original.flags,
		raw,
	});
	if (!copied) return c.json({ error: "Failed to copy message" }, 500);
	return c.json({ id: copied.id, folder: copied.folder, uid: copied.uid });
});

mailGateway.post("/imap/folders/:folder/expunge", async (c) => {
	const folder = c.req.param("folder");
	if (!isMailboxFolder(folder)) return c.json({ error: "Unknown folder" }, 404);
	const { results } = await c.env.DB.prepare(
		"SELECT id, uid FROM mailbox_messages WHERE folder = ? AND flags LIKE '%\\Deleted%' ORDER BY uid ASC LIMIT 500",
	)
		.bind(folder)
		.all<{ id: string; uid: number }>();
	const expunged: number[] = [];
	for (const row of results) {
		await deleteMailboxMessage(c.env, c.get("config"), row.id);
		expunged.push(row.uid);
	}
	return c.json({ folder, expunged });
});

mailGateway.post("/imap/folders/:folder/append", async (c) => {
	const folder = c.req.param("folder");
	if (!isMailboxFolder(folder)) return c.json({ error: "Unknown folder" }, 404);
	const contentType = (c.req.header("Content-Type") ?? "").toLowerCase();
	let rawBytes: Uint8Array | null = null;
	let flags: string[] = [];

	if (contentType.includes("application/json")) {
		const body = await c.req.json<{ raw?: string; flags?: string[] }>().catch(() => null);
		if (!body?.raw || typeof body.raw !== "string") return c.json({ error: "Missing raw message" }, 400);
		rawBytes = base64ToUint8Array(body.raw);
		if (!rawBytes || rawBytes.byteLength > MAX_GATEWAY_RAW_BYTES) return c.json({ error: "Invalid or oversized message" }, 413);
		if (Array.isArray(body.flags)) flags = body.flags.filter((f): f is string => typeof f === "string").slice(0, 32);
	} else {
		rawBytes = await readLimited(c.req.raw.body, MAX_GATEWAY_RAW_BYTES);
		if (!rawBytes || rawBytes.byteLength === 0) return c.json({ error: "Empty or oversized message" }, 413);
		const flagsHeader = c.req.header("X-Mail-Flags");
		if (flagsHeader) flags = flagsHeader.split(/\s+/).filter(Boolean).slice(0, 32);
	}

	const stored = await storeMailboxMessage(c.env, c.get("config"), c.get("mailSettings"), {
		folder,
		flags,
		reason: "imap_append",
		raw: rawBytes,
	});
	if (!stored) return c.json({ error: "Mailbox storage disabled" }, 403);
	return c.json({ id: stored.id, folder: stored.folder, uid: stored.uid }, 201);
});

// ---------- POP3 Endpoints ----------

mailGateway.get("/pop3/messages", async (c) => {
	const settings = c.get("mailSettings");
	const folders = settings.pop3Folders.length ? settings.pop3Folders : (["INBOX"] as MailboxFolder[]);
	const placeholders = folders.map(() => "?").join(", ");
	const { results } = await c.env.DB.prepare(
		`SELECT id, folder, uid, size_bytes, snippet, raw_headers, created_at FROM mailbox_messages
		 WHERE folder IN (${placeholders}) AND flags NOT LIKE '%\\Deleted%'
		 ORDER BY created_at ASC, uid ASC LIMIT 2000`,
	)
		.bind(...folders)
		.all<{ id: string; folder: string; uid: number; size_bytes: number; snippet: string; raw_headers: string | null; created_at: number }>();
	return c.json({
		messages: results.map((row) => ({
			id: row.id,
			uidl: row.id,
			folder: row.folder,
			size: row.size_bytes || row.snippet.length + (row.raw_headers?.length ?? 0),
			createdAt: row.created_at,
		})),
	});
});

/** A message POP3 may see: only in the folders Settings expose to POP3. */
async function pop3Message(c: Context<GatewayEnv>, id: string) {
	const msg = await getMailboxMessage(c.env.DB, id);
	const settings = c.get("mailSettings");
	const folders: readonly string[] = settings.pop3Folders.length ? settings.pop3Folders : ["INBOX"];
	return msg && folders.includes(msg.folder) ? msg : null;
}

mailGateway.get("/pop3/messages/:id/raw", async (c) => {
	const msg = await pop3Message(c, c.req.param("id"));
	if (!msg) return c.json({ error: "Message not found" }, 404);
	const raw = (await readMailboxRaw(c.env, c.get("config"), msg)) ?? synthesizeHeadersOnlyRaw(msg);
	return c.body(raw as Uint8Array<ArrayBuffer>, 200, { "Content-Type": "message/rfc822" });
});

mailGateway.delete("/pop3/messages/:id", async (c) => {
	const id = c.req.param("id");
	const settings = c.get("mailSettings");
	const msg = await pop3Message(c, id);
	if (!msg) return c.json({ error: "Message not found" }, 404);
	if (settings.pop3DeleteAction === "expunge") {
		await deleteMailboxMessage(c.env, c.get("config"), id);
	} else if (settings.pop3DeleteAction === "archive") {
		await updateMailboxFlags(c.env.DB, id, { add: ["\\Seen"] });
	} else {
		await moveMailboxMessage(c.env.DB, id, "Trash");
	}
	return c.json({ ok: true, id, action: settings.pop3DeleteAction });
});

// ---------- SMTP Submission Endpoint ----------

mailGateway.post("/smtp/send", async (c) => {
	const settings = c.get("mailSettings");
	const config = c.get("config");
	const db = c.env.DB;

	// Enforce hourly SMTP submission rate limit.
	const hourAgo = now() - 3600;
	const rateRow = await db
		.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'smtp_send' AND created_at > ?")
		.bind(hourAgo)
		.first<{ n: number }>();
	if (Number(rateRow?.n ?? 0) >= settings.smtpRateLimitPerHour) {
		return c.json({ error: "Hourly SMTP rate limit exceeded" }, 429);
	}

	const body = await c.req.json<{ mailFrom?: string; rcptTo?: string[]; raw?: string }>().catch(() => null);
	if (!body || typeof body.mailFrom !== "string" || !Array.isArray(body.rcptTo) || typeof body.raw !== "string") {
		return c.json({ error: "Expected { mailFrom, rcptTo, raw }" }, 400);
	}
	const mailFrom = extractEmail(body.mailFrom);
	if (!mailFrom) return c.json({ error: "Invalid mailFrom address" }, 400);
	const recipients = [...new Set(body.rcptTo.map((r) => (typeof r === "string" ? extractEmail(r) : null)).filter((r): r is string => !!r))].slice(
		0,
		MAX_SMTP_RECIPIENTS,
	);
	if (!recipients.length) return c.json({ error: "No valid recipients" }, 400);

	const rawBytes = base64ToUint8Array(body.raw);
	if (!rawBytes || rawBytes.byteLength === 0 || rawBytes.byteLength > MAX_GATEWAY_RAW_BYTES) {
		return c.json({ error: "Invalid or oversized message body" }, 413);
	}

	// Verify that mailFrom belongs to an active alias (or auto-create if policy permits).
	const fromDomain = domainOf(mailFrom);
	let alias = await db.prepare("SELECT * FROM aliases WHERE address = ?").bind(mailFrom).first<AliasRow>();
	if (alias?.deleted_at) return c.json({ error: "Alias is deleted" }, 403);
	if (!alias) {
		if (settings.smtpFromPolicy !== "auto_create" || !settings.aliasDomains.includes(fromDomain)) {
			return c.json({ error: "Sender must be an existing alias" }, 403);
		}
		alias = await ensureAlias(db, mailFrom, "", { forwardEnabled: settings.autoForwardNewAliases });
	}
	if (alias.forward_mode === "none") {
		return c.json({ error: "Alias is disabled" }, 403);
	}
	// A deactivated domain neither receives nor sends, as for replies.
	const domainRow = await getDomainRow(db, domainOf(alias.address));
	if (domainRow && domainRow.active === 0) return c.json({ error: "This domain is deactivated" }, 403);

	let parsed;
	try {
		parsed = await PostalMime.parse(rawBytes, { attachmentEncoding: "arraybuffer" });
	} catch {
		return c.json({ error: "Unreadable MIME message" }, 400);
	}

	const subject = parsed.subject?.slice(0, 500) || "(no subject)";
	// The name goes into a From header: control characters, quotes and brackets are cleaned out.
	const displayName = cleanDisplayName(parsed.from?.name || alias.name || settings.defaultFromName) ?? "";
	const fromHeader = displayName ? { name: displayName, email: alias.address } : alias.address;

	// Apply rules configured for outgoing sends/replies.
	const rules = await runRules(db, "sends", {
		sender: alias.address,
		senders: [alias.address],
		displayFrom: displayName || null,
		subject,
		alias: alias.address,
		aliasDescription: alias.note,
		recipient: recipients[0] ?? "",
	});
	if (rules.block) {
		return c.json({ error: `Blocked by rule: ${rules.block}` }, 403);
	}

	const attachments: OutboundAttachment[] = (rules.removeAttachments ? [] : parsed.attachments).map((att) => {
		const rawBytesAtt = typeof att.content === "string" ? new TextEncoder().encode(att.content) : new Uint8Array(att.content);
		const copy = new Uint8Array(rawBytesAtt.byteLength);
		copy.set(rawBytesAtt);
		return {
			disposition: att.disposition === "inline" ? "inline" : "attachment",
			filename: att.filename || "attachment",
			type: att.mimeType || "application/octet-stream",
			content: copy.buffer,
			...(att.contentId ? { contentId: att.contentId } : {}),
		};
	});

	const extraHeaders: Record<string, string> = {};
	if (parsed.inReplyTo) extraHeaders["In-Reply-To"] = parsed.inReplyTo;
	if (parsed.references) extraHeaders.References = parsed.references;

	const sentIds: string[] = [];
	const notSent: string[] = [];
	for (const to of recipients) {
		const cleanTo = normalizeEmail(to);
		try {
			if (alias.mailbox_id && mailflareReady(config)) {
				await sendViaMailflare(mailflareConfig(config), {
					mailboxId: alias.mailbox_id,
					from: displayName ? `"${displayName}" <${alias.address}>` : alias.address,
					to: [cleanTo],
					subject: rules.subject ?? subject,
					text: parsed.text || undefined,
					html: parsed.html || undefined,
					...(parsed.inReplyTo ? { inReplyTo: parsed.inReplyTo } : {}),
					...(parsed.references ? { references: parsed.references.split(/\s+/).filter(Boolean) } : {}),
					...(attachments.length
						? {
								attachments: attachments.map((att) => ({
									filename: att.filename,
									type: att.type,
									contentBase64: bytesToBase64(new Uint8Array(att.content as ArrayBuffer)),
								})),
							}
						: {}),
				});
				sentIds.push(newId("smtp"));
			} else {
				const res = await sendOutbound(c.env, config, {
					from: fromHeader,
					to: cleanTo,
					subject: rules.subject ?? subject,
					text: parsed.text || undefined,
					html: parsed.html || undefined,
					headers: Object.keys(extraHeaders).length ? extraHeaders : undefined,
					attachments: attachments.length ? attachments : undefined,
				});
				sentIds.push(res.messageId || newId("smtp"));
			}
		} catch (error) {
			notSent.push(`${cleanTo}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
		}
	}
	if (notSent.length) {
		const detail = notSent.join("; ").slice(0, 1000);
		if (settings.mailboxEnabled && settings.storeFailed) {
			await storeMailboxMessage(c.env, config, settings, {
				folder: "Failed",
				aliasAddress: alias.address,
				fromAddress: alias.address,
				fromName: displayName || null,
				toAddress: recipients.join(", "),
				subject,
				reason: "smtp_failed",
				reasonDetail: detail,
				raw: rawBytes,
				parsed,
			}).catch(() => undefined);
		}
		// SMTP has no partial success after DATA: with nothing sent the client may try again, but
		// once a copy went out a retry would send it twice, so the rest is recorded in Failed.
		if (!sentIds.length) return c.json({ error: `Failed to send: ${detail.slice(0, 200)}` }, 502);
		await recordEvent(db, { kind: "send", aliasAddress: alias.address, status: "failed", detail: `SMTP not sent to ${detail}` }).catch(() => undefined);
	}

	await recordEvent(db, {
		kind: "smtp_send",
		aliasAddress: alias.address,
		status: "ok",
		detail: `SMTP sent to ${recipients.join(", ")}`,
	});
	await db.prepare("UPDATE aliases SET last_used_at = ? WHERE address = ?").bind(now(), alias.address).run();

	if (settings.mailboxEnabled && settings.storeSentCopy) {
		await storeMailboxMessage(c.env, config, settings, {
			folder: "Sent",
			aliasAddress: alias.address,
			fromAddress: alias.address,
			fromName: displayName || null,
			toAddress: recipients.join(", "),
			subject: rules.subject ?? subject,
			reason: "smtp_sent",
			flags: ["\\Seen"],
			raw: rawBytes,
			parsed,
		}).catch(() => undefined);
	}

	return c.json({ ok: true, messageIds: sentIds, recipients });
});
