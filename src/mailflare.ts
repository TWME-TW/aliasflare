/**
 * The small part of Mailflare's API this Worker needs. One API key with the
 * `jmap` and `send` scopes covers it: JMAP reads the stored message (its mailbox and raw
 * MIME), and /api/v1/send sends replies so they land in Mailflare's Sent folder.
 */

import type { AppConfig } from "./config";
import { DOMAIN_PATTERN, hostnameOf } from "./format";
import { redact } from "./outbound";
import { discard, readLimited, readTextLimited } from "./streams";

/** JMAP answers here are a few small objects; a larger one is refused rather than buffered. */
const MAX_JSON_BYTES = 1024 * 1024;
const INTERNAL_HOST = /(^|\.)(localhost|localdomain|local|internal|intranet|lan|home|corp|arpa)$/;

function validJmapSegment(value: string): boolean {
	return !!value && value !== "." && value !== ".." && !/[\\/\u0000-\u001f\u007f]/.test(value);
}

async function readJson<T>(response: Response): Promise<T> {
	const text = await readTextLimited(response, MAX_JSON_BYTES);
	if (text === null) throw new MailflareError(`Mailflare answered with more than ${MAX_JSON_BYTES} bytes`, 502);
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new MailflareError("Mailflare returned invalid JSON", 502);
	}
}

const JMAP_CORE = "urn:ietf:params:jmap:core";
const JMAP_MAIL = "urn:ietf:params:jmap:mail";
const TIMEOUT_MS = 15_000;

export type MailflareConfig = { baseUrl: string; apiKey: string; service?: Fetcher };

export type StoredMessage = { mailboxId: string; raw: ArrayBuffer };

export type SendRequest = {
	mailboxId: string;
	from: string;
	to: string[];
	subject: string;
	html?: string;
	text?: string;
	inReplyTo?: string;
	references?: string[];
	attachments?: { filename: string; type: string; contentBase64: string }[];
};

export class MailflareError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

export function mailflareConfig(config: AppConfig): MailflareConfig {
	if (!config.mailflareUrl || !config.mailflareApiKey) throw new Error("The Mailflare URL and API key are not set yet");
	if (!config.mailflareService) {
		let parsed: URL;
		try {
			parsed = new URL(config.mailflareUrl);
		} catch {
			throw new MailflareError("Invalid Mailflare URL", 502);
		}
		const host = parsed.hostname.trim().toLowerCase().replace(/\.$/, "");
		const selfHosts = [config.publicUrl, config.siteOrigin]
			.map(hostnameOf)
			.filter((entry): entry is string => !!entry)
			.map((entry) => entry.trim().toLowerCase().replace(/\.$/, ""));
		if (
			parsed.protocol !== "https:" ||
			parsed.username ||
			parsed.password ||
			!host ||
			host.startsWith("[") ||
			/^[\d.]+$/.test(host) ||
			!DOMAIN_PATTERN.test(host) ||
			INTERNAL_HOST.test(host) ||
			selfHosts.some((self) => host === self || host.endsWith(`.${self}`))
		) {
			throw new MailflareError("Mailflare URL is not an allowed https host", 502);
		}
	}
	return { baseUrl: config.mailflareUrl, apiKey: config.mailflareApiKey, service: config.mailflareService };
}

async function call(config: MailflareConfig, path: string, init: RequestInit = {}, allowNotFound = false): Promise<Response> {
	// A service binding reaches Mailflare directly; otherwise go over its public URL.
	const send = config.service ? config.service.fetch.bind(config.service) : fetch;
	const response = await send(`${config.baseUrl}${path}`, {
		...init,
		redirect: "manual",
		signal: AbortSignal.timeout(TIMEOUT_MS),
		headers: { Authorization: `Bearer ${config.apiKey}`, ...(init.headers ?? {}) },
	});
	if (!response.ok) {
		// Only the start of an error body is wanted; the rest is let go of.
		const body = (await readTextLimited(response, 4096).catch(() => null)) ?? "";
		// Only a missing message/blob should surface as 404 (skipped); a 404 on /jmap/session or /jmap/api must retry.
		const status = response.status === 404 && !allowNotFound ? 502 : response.status;
		throw new MailflareError(`Mailflare ${path.split("?")[0]} answered ${response.status}: ${redact(body, config.apiKey).slice(0, 300)}`, status);
	}
	return response;
}

/** Larger messages are not forwarded: Email Sending would refuse them anyway. */
export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

const ACCOUNT_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedAccountId: { keyHash: string; id: string; expiresAt: number } | null = null;

async function cacheKeyHash(config: MailflareConfig): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${config.service ? "binding" : "url"}|${config.baseUrl}|${config.apiKey}`));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function jmapAccountId(config: MailflareConfig): Promise<string> {
	// Keyed by a SHA-256 hash so the raw API key is never kept in module-level memory.
	const keyHash = await cacheKeyHash(config);
	if (cachedAccountId?.keyHash === keyHash && Date.now() < cachedAccountId.expiresAt) return cachedAccountId.id;
	const session = (await readJson(await call(config, "/jmap/session"))) as {
		primaryAccounts?: Record<string, string>;
	};
	const id = session.primaryAccounts?.[JMAP_MAIL];
	if (!id || !validJmapSegment(id)) throw new MailflareError("Mailflare's JMAP session has no valid mail account", 502);
	cachedAccountId = { keyHash, id, expiresAt: Date.now() + ACCOUNT_CACHE_TTL_MS };
	return id;
}

/** Reads a stored message by its Mailflare id: the mailbox it is in and its raw MIME. */
export async function getStoredMessage(config: MailflareConfig, messageId: string): Promise<StoredMessage> {
	const accountId = await jmapAccountId(config);
	const response = await call(config, "/jmap/api", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			using: [JMAP_CORE, JMAP_MAIL],
			methodCalls: [["Email/get", { accountId, ids: [messageId], properties: ["id", "mailboxIds", "blobId", "size"] }, "0"]],
		}),
	}).catch((error) => {
		if (error instanceof MailflareError && (error.status === 401 || error.status === 403 || error.status === 404)) cachedAccountId = null;
		throw error;
	});
	const body = await readJson<{ methodResponses?: [string, Record<string, unknown>, string][] }>(response);
	const [name, result] = body.methodResponses?.[0] ?? [];
	if (name !== "Email/get" || !result) {
		cachedAccountId = null;
		throw new MailflareError(`Mailflare JMAP Email/get failed: ${redact(JSON.stringify(result ?? body), config.apiKey).slice(0, 300)}`, 502);
	}
	const email = (result.list as { mailboxIds?: Record<string, boolean>; blobId?: string; size?: number }[] | undefined)?.[0];
	if (!email?.blobId) throw new MailflareError(`Message ${messageId} was not found in Mailflare`, 404);
	if (!validJmapSegment(email.blobId)) throw new MailflareError("Mailflare returned an invalid blob id", 502);
	if ((email.size ?? 0) > MAX_MESSAGE_BYTES) throw new MailflareError(`Message ${messageId} is larger than ${MAX_MESSAGE_BYTES} bytes`, 413);
	// Mailbox ids look like "<mailbox>", "<mailbox>~inbox" or "<mailbox>~f~<folder>".
	const firstMailbox = Object.entries(email.mailboxIds ?? {}).find(([, active]) => active === true)?.[0];
	const mailboxId = firstMailbox?.split("~")[0];
	if (!mailboxId) throw new Error(`Message ${messageId} has no mailbox`);

	const download = await call(
		config,
		`/jmap/download/${encodeURIComponent(accountId)}/${encodeURIComponent(email.blobId)}/message.eml?type=message/rfc822`,
		{},
		true,
	);
	return { mailboxId, raw: await readCapped(download, MAX_MESSAGE_BYTES) };
}

/** Reads a response body, stopping with a 413 MailflareError past `max` bytes. */
async function readCapped(response: Response, max: number): Promise<ArrayBuffer> {
	if (Number(response.headers.get("Content-Length") ?? 0) > max) {
		await discard(response);
		throw new MailflareError(`The message is larger than ${max} bytes`, 413);
	}
	const bytes = await readLimited(response.body, max);
	if (!bytes) throw new MailflareError(`The message is larger than ${max} bytes`, 413);
	return bytes.buffer as ArrayBuffer;
}

/** Sends through Mailflare, which stores the message in the mailbox's Sent folder. */
export async function sendViaMailflare(config: MailflareConfig, request: SendRequest): Promise<void> {
	const response = await call(config, "/api/v1/send", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(request),
	});
	await discard(response);
}

export type MailflareMailboxSummary = {
	id: string;
	name: string;
	role: string | null;
	totalEmails: number;
	unreadEmails: number;
};

export type MailflareEmailSummary = {
	id: string;
	subject: string;
	from: string;
	to: string;
	preview: string;
	receivedAt: string;
	seen: boolean;
	flagged: boolean;
	size: number;
};

/** Lists Mailflare mailboxes via JMAP Mailbox/get for deep integration in aliasflare's Mailbox view. */
export async function listMailflareMailboxes(config: MailflareConfig): Promise<MailflareMailboxSummary[]> {
	const accountId = await jmapAccountId(config);
	const response = await call(config, "/jmap/api", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			using: [JMAP_CORE, JMAP_MAIL],
			methodCalls: [["Mailbox/get", { accountId, properties: ["id", "name", "role", "totalEmails", "unreadEmails"] }, "0"]],
		}),
	});
	const body = await readJson<{ methodResponses?: [string, { list?: Record<string, unknown>[] }, string][] }>(response);
	const list = body.methodResponses?.[0]?.[1]?.list ?? [];
	return list.map((item) => ({
		id: String(item.id ?? ""),
		name: String(item.name ?? ""),
		role: typeof item.role === "string" ? item.role : null,
		totalEmails: Number(item.totalEmails ?? 0),
		unreadEmails: Number(item.unreadEmails ?? 0),
	}));
}

/** Lists recent Mailflare emails via JMAP Email/query + Email/get. */
export async function listMailflareEmails(
	config: MailflareConfig,
	options: { mailboxId?: string; text?: string; limit?: number } = {},
): Promise<MailflareEmailSummary[]> {
	const accountId = await jmapAccountId(config);
	const filter: Record<string, unknown> = {};
	if (options.mailboxId) filter.inMailbox = options.mailboxId;
	if (options.text?.trim()) filter.text = options.text.trim();
	const response = await call(config, "/jmap/api", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			using: [JMAP_CORE, JMAP_MAIL],
			methodCalls: [
				["Email/query", { accountId, filter, sort: [{ property: "receivedAt", isAscending: false }], limit: Math.min(options.limit ?? 30, 50) }, "q"],
				[
					"Email/get",
					{
						accountId,
						"#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
						properties: ["id", "subject", "from", "to", "preview", "receivedAt", "keywords", "size"],
					},
					"g",
				],
			],
		}),
	});
	const body = await readJson<{ methodResponses?: [string, { list?: Record<string, unknown>[] }, string][] }>(response);
	const got = body.methodResponses?.find(([name]) => name === "Email/get")?.[1]?.list ?? [];
	const addr = (arr: unknown) => {
		const first = Array.isArray(arr) ? (arr[0] as { name?: string; email?: string } | undefined) : undefined;
		return first?.email ? (first.name ? `${first.name} <${first.email}>` : first.email) : "";
	};
	return got.map((item) => {
		const kw = (item.keywords && typeof item.keywords === "object" ? item.keywords : {}) as Record<string, boolean>;
		return {
			id: String(item.id ?? ""),
			subject: String(item.subject ?? "(no subject)"),
			from: addr(item.from),
			to: addr(item.to),
			preview: String(item.preview ?? ""),
			receivedAt: String(item.receivedAt ?? ""),
			seen: kw.$seen === true,
			flagged: kw.$flagged === true,
			size: Number(item.size ?? 0),
		};
	});
}
