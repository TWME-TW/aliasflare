/**
 * Built-in mailbox: stores skipped/rejected, failed, local-mailbox, sent, and optional forwarded
 * email copies with standard IMAP-compatible folders, UIDVALIDITY/UIDNEXT tracking, flags,
 * quota enforcement, retention cleanup, and R2/S3/D1 storage abstraction.
 */
import PostalMime, { type Email } from "postal-mime";
import type { AppConfig } from "./config";
import { newId, now } from "./db";
import { cleanSubjectLine } from "./format";
import type { Settings } from "./settings";
import { deleteRawBlob, getRawBlob, putRawBlob, resolveStorageBackend } from "./storage";

export const MAILBOX_FOLDERS = ["INBOX", "Skipped", "Failed", "Sent", "Trash"] as const;
export type MailboxFolder = (typeof MAILBOX_FOLDERS)[number];

export function isMailboxFolder(value: unknown): value is MailboxFolder {
	return MAILBOX_FOLDERS.includes(value as MailboxFolder);
}

/** Special destination address meaning "store directly in aliasflare's built-in INBOX without forwarding". */
export const LOCAL_MAILBOX_ADDRESS = "mailbox@local.aliasflare";

export type SkipReasonKind =
	| "alias_off"
	| "promotions"
	| "rule_block"
	| "blocked_sender"
	| "unknown_alias"
	| "other";

export type MailboxMessageRow = {
	id: string;
	folder: MailboxFolder;
	uid: number;
	alias_address: string | null;
	forward_id: string | null;
	from_address: string;
	from_name: string | null;
	to_address: string;
	subject: string;
	snippet: string;
	reason: string | null;
	reason_detail: string | null;
	flags: string;
	size_bytes: number;
	storage_kind: "r2" | "s3" | "d1" | "headers_only";
	storage_key: string | null;
	raw_headers: string | null;
	created_at: number;
	updated_at: number;
};

export type MailboxMessage = Omit<MailboxMessageRow, "flags"> & { flags: string[] };

export function parseFlags(raw: string): string[] {
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === "string") : [];
	} catch {
		return [];
	}
}

function hydrate(row: MailboxMessageRow): MailboxMessage {
	return { ...row, flags: parseFlags(row.flags) };
}

/** Whether a skipped message with this reason should be saved into the Skipped folder. */
export function shouldStoreSkipped(settings: Settings, kind: SkipReasonKind): boolean {
	if (!settings.mailboxEnabled) return false;
	switch (kind) {
		case "alias_off":
			return settings.storeSkippedAliasOff;
		case "promotions":
			return settings.storeSkippedPromotions;
		case "rule_block":
			return settings.storeSkippedRuleBlock;
		case "blocked_sender":
			return settings.storeSkippedBlockedSender;
		case "unknown_alias":
			return settings.storeSkippedUnknownAlias;
		case "other":
			return settings.storeSkippedAliasOff;
	}
}

/** Allocates the next monotonic IMAP UID for a folder (initializes UIDVALIDITY on first use). */
export async function nextFolderUid(db: D1Database, folder: MailboxFolder): Promise<{ uid: number; uidvalidity: number }> {
	const ts = now();
	await db
		.prepare("INSERT INTO mailbox_uid_state (folder, uidvalidity, uidnext) VALUES (?, ?, 1) ON CONFLICT (folder) DO NOTHING")
		.bind(folder, ts)
		.run();
	const row = await db
		.prepare("UPDATE mailbox_uid_state SET uidnext = uidnext + 1 WHERE folder = ? RETURNING uidnext - 1 AS uid, uidvalidity")
		.bind(folder)
		.first<{ uid: number; uidvalidity: number }>();
	return { uid: Number(row?.uid ?? 1), uidvalidity: Number(row?.uidvalidity ?? ts) };
}

/** Returns UIDVALIDITY and UIDNEXT for a folder. */
export async function folderUidState(db: D1Database, folder: MailboxFolder): Promise<{ uidvalidity: number; uidnext: number }> {
	const ts = now();
	await db
		.prepare("INSERT INTO mailbox_uid_state (folder, uidvalidity, uidnext) VALUES (?, ?, 1) ON CONFLICT (folder) DO NOTHING")
		.bind(folder, ts)
		.run();
	const row = await db
		.prepare("SELECT uidvalidity, uidnext FROM mailbox_uid_state WHERE folder = ?")
		.bind(folder)
		.first<{ uidvalidity: number; uidnext: number }>();
	return { uidvalidity: Number(row?.uidvalidity ?? ts), uidnext: Number(row?.uidnext ?? 1) };
}

function extractHeaderBlock(raw: Uint8Array): string {
	const slice = raw.subarray(0, Math.min(raw.byteLength, 32 * 1024));
	const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(slice);
	const sep = text.search(/\r?\n\r?\n/);
	return sep >= 0 ? text.slice(0, sep) : text;
}

function makeSnippet(text?: string | null, html?: string | null): string {
	const source = text?.trim() || (html ? html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ") : "");
	return source.replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Enforces mailboxQuotaMb before inserting a new blob: either evicts oldest messages or refuses blob storage. */
async function enforceQuota(env: Env, config: AppConfig, settings: Settings, incomingBytes: number): Promise<boolean> {
	const quotaBytes = settings.mailboxQuotaMb * 1024 * 1024;
	if (quotaBytes <= 0) return true;
	const totalRow = await env.DB.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS total FROM mailbox_messages WHERE storage_kind != 'headers_only'").first<{ total: number }>();
	let current = Number(totalRow?.total ?? 0);
	if (current + incomingBytes <= quotaBytes) return true;
	if (settings.mailboxQuotaPolicy === "stop_storing") return false;

	// Evict oldest messages (Trash first, then Skipped, then others) until under quota.
	const { results } = await env.DB.prepare(
		`SELECT id, size_bytes, storage_kind, storage_key FROM mailbox_messages
		 WHERE storage_kind != 'headers_only'
		 ORDER BY CASE folder WHEN 'Trash' THEN 0 WHEN 'Skipped' THEN 1 ELSE 2 END ASC, created_at ASC LIMIT 50`,
	).all<{ id: string; size_bytes: number; storage_kind: string; storage_key: string | null }>();
	for (const candidate of results) {
		if (current + incomingBytes <= quotaBytes) break;
		await deleteRawBlob(env, config, candidate);
		await env.DB.prepare("DELETE FROM mailbox_messages WHERE id = ?").bind(candidate.id).run();
		current -= Number(candidate.size_bytes ?? 0);
	}
	return current + incomingBytes <= quotaBytes;
}

export type StoreMessageInput = {
	folder: MailboxFolder;
	aliasAddress?: string | null;
	forwardId?: string | null;
	fromAddress?: string;
	fromName?: string | null;
	toAddress?: string;
	subject?: string;
	snippet?: string;
	reason?: string | null;
	reasonDetail?: string | null;
	flags?: string[];
	raw?: Uint8Array | ArrayBuffer | null;
	parsed?: Email | null;
};

/** Stores a message in the built-in mailbox (raw blob in R2/S3/D1 if within size & quota limits, else headers_only). */
export async function storeMailboxMessage(
	env: Env,
	config: AppConfig,
	settings: Settings,
	input: StoreMessageInput,
): Promise<MailboxMessage | null> {
	if (!settings.mailboxEnabled) return null;
	const rawBytes = input.raw instanceof Uint8Array ? input.raw : input.raw ? new Uint8Array(input.raw) : null;
	const sizeBytes = rawBytes?.byteLength ?? 0;

	let parsed = input.parsed ?? null;
	if (!parsed && rawBytes && sizeBytes <= 2 * 1024 * 1024) {
		try {
			parsed = await PostalMime.parse(rawBytes, { attachmentEncoding: "arraybuffer" });
		} catch {
			parsed = null;
		}
	}

	const fromAddress = (input.fromAddress || parsed?.from?.address || "").trim().toLowerCase().slice(0, 320);
	const fromName = (input.fromName ?? parsed?.from?.name ?? null)?.slice(0, 120) || null;
	const toAddress = (input.toAddress || input.aliasAddress || "").trim().toLowerCase().slice(0, 320);
	const subject = cleanSubjectLine(input.subject ?? parsed?.subject ?? "").slice(0, 500) || "(no subject)";
	const snippet = input.snippet ?? makeSnippet(parsed?.text, parsed?.html);

	const id = newId("mb");
	const { uid } = await nextFolderUid(env.DB, input.folder);
	const ts = now();

	const backend = resolveStorageBackend(env, config, settings.mailboxStorageBackend);
	// On D1 fallback the blob is stored as base64 (4/3 the size, before any gzip gain), and D1 takes
	// at most 2,000,000 bytes per value: 1,400 KiB of raw mail always fits.
	const maxBytes = Math.min(settings.mailboxMaxMessageKb * 1024, backend === "d1" ? 1400 * 1024 : 25 * 1024 * 1024);
	let storageKind: "r2" | "s3" | "d1" | "headers_only" = "headers_only";
	let storageKey: string | null = null;
	let rawHeaders: string | null = rawBytes ? extractHeaderBlock(rawBytes) : null;

	// Insert the message metadata row first so mailbox_blobs foreign key succeeds for D1 storage.
	await env.DB.prepare(
		`INSERT INTO mailbox_messages (id, folder, uid, alias_address, forward_id, from_address, from_name, to_address, subject, snippet, reason, reason_detail, flags, size_bytes, storage_kind, storage_key, raw_headers, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'headers_only', NULL, ?, ?, ?)`,
	)
		.bind(
			id,
			input.folder,
			uid,
			input.aliasAddress ?? null,
			input.forwardId ?? null,
			fromAddress,
			fromName,
			toAddress,
			subject,
			snippet,
			input.reason ?? null,
			input.reasonDetail?.slice(0, 1000) ?? null,
			JSON.stringify(input.flags ?? []),
			sizeBytes,
			rawHeaders,
			ts,
			ts,
		)
		.run();

	if (rawBytes && sizeBytes > 0 && sizeBytes <= maxBytes) {
		try {
			const hasRoom = await enforceQuota(env, config, settings, sizeBytes);
			if (hasRoom) {
				const stored = await putRawBlob(env, config, settings.mailboxStorageBackend, id, rawBytes);
				storageKind = stored.storageKind;
				storageKey = stored.storageKey;
				rawHeaders = null;
				await env.DB.prepare("UPDATE mailbox_messages SET storage_kind = ?, storage_key = ?, raw_headers = NULL WHERE id = ?")
					.bind(storageKind, storageKey, id)
					.run();
			}
		} catch (error) {
			console.warn("Mailbox raw blob storage failed, kept headers_only:", id, error instanceof Error ? error.message : error);
		}
	}

	const row = await env.DB.prepare("SELECT * FROM mailbox_messages WHERE id = ?").bind(id).first<MailboxMessageRow>();
	return row ? hydrate(row) : null;
}

export async function getMailboxMessage(db: D1Database, id: string): Promise<MailboxMessage | null> {
	const row = await db.prepare("SELECT * FROM mailbox_messages WHERE id = ?").bind(id).first<MailboxMessageRow>();
	return row ? hydrate(row) : null;
}

export async function getMailboxMessageByForwardId(db: D1Database, forwardId: string): Promise<MailboxMessage | null> {
	const row = await db
		.prepare("SELECT * FROM mailbox_messages WHERE forward_id = ? ORDER BY created_at DESC LIMIT 1")
		.bind(forwardId)
		.first<MailboxMessageRow>();
	return row ? hydrate(row) : null;
}

export async function readMailboxRaw(env: Env, config: AppConfig, msg: Pick<MailboxMessageRow, "id" | "storage_kind" | "storage_key">): Promise<Uint8Array | null> {
	return getRawBlob(env, config, msg);
}

export type MailboxFolderStats = Record<MailboxFolder, { total: number; unread: number }>;

export async function folderStats(db: D1Database): Promise<MailboxFolderStats> {
	const { results } = await db
		.prepare("SELECT folder, COUNT(*) AS total, SUM(CASE WHEN flags NOT LIKE '%\\Seen%' THEN 1 ELSE 0 END) AS unread FROM mailbox_messages GROUP BY folder")
		.all<{ folder: string; total: number; unread: number }>();
	const stats: MailboxFolderStats = {
		INBOX: { total: 0, unread: 0 },
		Skipped: { total: 0, unread: 0 },
		Failed: { total: 0, unread: 0 },
		Sent: { total: 0, unread: 0 },
		Trash: { total: 0, unread: 0 },
	};
	for (const row of results) {
		if (isMailboxFolder(row.folder)) {
			stats[row.folder] = { total: Number(row.total ?? 0), unread: Number(row.unread ?? 0) };
		}
	}
	return stats;
}

export async function listMailboxMessages(
	db: D1Database,
	query: { folder?: MailboxFolder | "all"; search?: string; unreadOnly?: boolean; limit: number; offset: number },
): Promise<{ messages: MailboxMessage[]; total: number }> {
	const where: string[] = [];
	const params: unknown[] = [];
	if (query.folder && query.folder !== "all") {
		where.push("folder = ?");
		params.push(query.folder);
	} else {
		where.push("folder != 'Trash'");
	}
	if (query.unreadOnly) where.push("flags NOT LIKE '%\\Seen%'");
	// Mailflare-inspired structured search: from:, to:, subject:, reason:, is:unread, is:read, is:starred, plus free-text terms.
	if (query.search?.trim()) {
		const tokens = query.search.trim().slice(0, 200).match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
		for (const rawToken of tokens.slice(0, 10)) {
			const token = rawToken.replace(/^"|"$/g, "");
			const lower = token.toLowerCase();
			if (lower === "is:unread") {
				where.push("flags NOT LIKE '%\\Seen%'");
				continue;
			}
			if (lower === "is:read") {
				where.push("flags LIKE '%\\Seen%'");
				continue;
			}
			if (lower === "is:starred" || lower === "is:flagged") {
				where.push("flags LIKE '%\\Flagged%'");
				continue;
			}
			const colon = lower.indexOf(":");
			if (colon > 0) {
				const key = lower.slice(0, colon);
				const val = lower.slice(colon + 1);
				if (val && (key === "from" || key === "to" || key === "subject" || key === "reason" || key === "alias")) {
					const like = `%${val.replace(/[!%_]/g, "!$&")}%`;
					const col =
						key === "from"
							? "lower(from_address)"
							: key === "to"
								? "lower(to_address)"
								: key === "alias"
									? "lower(COALESCE(alias_address, ''))"
									: key === "reason"
										? "lower(COALESCE(reason, '') || ' ' || COALESCE(reason_detail, ''))"
										: "lower(subject)";
					where.push(`${col} LIKE ? ESCAPE '!'`);
					params.push(like);
					continue;
				}
			}
			const like = `%${lower.replace(/[!%_]/g, "!$&")}%`;
			where.push(
				"(lower(subject) LIKE ? ESCAPE '!' OR lower(from_address) LIKE ? ESCAPE '!' OR lower(COALESCE(alias_address, '')) LIKE ? ESCAPE '!' OR lower(COALESCE(reason_detail, '')) LIKE ? ESCAPE '!' OR lower(snippet) LIKE ? ESCAPE '!')",
			);
			params.push(like, like, like, like, like);
		}
	}
	const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
	const [rowsRes, countRes] = await db.batch([
		db.prepare(`SELECT * FROM mailbox_messages ${clause} ORDER BY created_at DESC, uid DESC LIMIT ? OFFSET ?`).bind(...params, query.limit, query.offset),
		db.prepare(`SELECT COUNT(*) AS total FROM mailbox_messages ${clause}`).bind(...params),
	]);
	return {
		messages: ((rowsRes?.results ?? []) as MailboxMessageRow[]).map(hydrate),
		total: Number((countRes?.results?.[0] as { total?: number } | undefined)?.total ?? 0),
	};
}

/** Permanently deletes all messages in a folder (e.g. Trash or Skipped), cleaning up blobs. */
export async function emptyMailboxFolder(env: Env, config: AppConfig, folder: MailboxFolder): Promise<number> {
	// Batched so a huge folder (e.g. thousands of skipped spam captures) is emptied completely,
	// with a bound per call to keep one request from running away.
	const BATCH = 500;
	const MAX_BATCHES = 20;
	let deleted = 0;
	for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
		const { results } = await env.DB.prepare("SELECT id, storage_kind, storage_key FROM mailbox_messages WHERE folder = ? LIMIT ?")
			.bind(folder, BATCH)
			.all<{ id: string; storage_kind: string; storage_key: string | null }>();
		if (!results.length) break;
		for (const item of results) {
			await deleteRawBlob(env, config, item);
			await env.DB.prepare("DELETE FROM mailbox_messages WHERE id = ?").bind(item.id).run();
		}
		deleted += results.length;
		if (results.length < BATCH) break;
	}
	return deleted;
}

export async function updateMailboxFlags(db: D1Database, id: string, opts: { add?: string[]; remove?: string[]; set?: string[] }): Promise<MailboxMessage | null> {
	const existing = await getMailboxMessage(db, id);
	if (!existing) return null;
	const flagSet = new Set(opts.set ?? existing.flags);
	for (const f of opts.add ?? []) flagSet.add(f);
	for (const f of opts.remove ?? []) flagSet.delete(f);
	const next = [...flagSet];
	await db.prepare("UPDATE mailbox_messages SET flags = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(next), now(), id).run();
	return { ...existing, flags: next };
}

/** Moves a message to another folder and assigns a fresh UID in the target folder (RFC 3501 compliant). */
export async function moveMailboxMessage(db: D1Database, id: string, targetFolder: MailboxFolder): Promise<MailboxMessage | null> {
	const existing = await getMailboxMessage(db, id);
	if (!existing) return null;
	if (existing.folder === targetFolder) return existing;
	const { uid } = await nextFolderUid(db, targetFolder);
	const ts = now();
	await db.prepare("UPDATE mailbox_messages SET folder = ?, uid = ?, updated_at = ? WHERE id = ?").bind(targetFolder, uid, ts, id).run();
	return { ...existing, folder: targetFolder, uid, updated_at: ts };
}

export async function deleteMailboxMessage(env: Env, config: AppConfig, id: string): Promise<boolean> {
	const existing = await env.DB.prepare("SELECT id, storage_kind, storage_key FROM mailbox_messages WHERE id = ?")
		.bind(id)
		.first<{ id: string; storage_kind: string; storage_key: string | null }>();
	if (!existing) return false;
	await deleteRawBlob(env, config, existing);
	const result = await env.DB.prepare("DELETE FROM mailbox_messages WHERE id = ?").bind(id).run();
	return (result.meta.changes ?? 0) > 0;
}

/** Daily cleanup of expired mailbox messages and old Trash items. */
export async function cleanupMailbox(env: Env, config: AppConfig, settings: Settings, at = now()): Promise<number> {
	const toDelete: { id: string; storage_kind: string; storage_key: string | null }[] = [];
	// Trash is always purged after 30 days (or retentionDays if shorter).
	const trashDays = settings.mailboxRetentionDays > 0 ? Math.min(settings.mailboxRetentionDays, 30) : 30;
	const trashCutoff = at - trashDays * 86400;
	const trashRes = await env.DB.prepare("SELECT id, storage_kind, storage_key FROM mailbox_messages WHERE folder = 'Trash' AND updated_at < ? LIMIT 200")
		.bind(trashCutoff)
		.all<{ id: string; storage_kind: string; storage_key: string | null }>();
	toDelete.push(...trashRes.results);

	if (settings.mailboxRetentionDays > 0) {
		const cutoff = at - settings.mailboxRetentionDays * 86400;
		const oldRes = await env.DB.prepare("SELECT id, storage_kind, storage_key FROM mailbox_messages WHERE created_at < ? LIMIT 200")
			.bind(cutoff)
			.all<{ id: string; storage_kind: string; storage_key: string | null }>();
		const seen = new Set(toDelete.map((r) => r.id));
		for (const row of oldRes.results) if (!seen.has(row.id)) toDelete.push(row);
	}

	for (const item of toDelete) {
		await deleteRawBlob(env, config, item);
		await env.DB.prepare("DELETE FROM mailbox_messages WHERE id = ?").bind(item.id).run();
	}
	return toDelete.length;
}
