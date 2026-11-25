/**
 * The small part of Mailflare's API this Worker needs. One API key with the
 * `jmap` and `send` scopes covers it: JMAP reads the stored message (its mailbox and raw
 * MIME), and /api/v1/send sends replies so they land in Mailflare's Sent folder.
 */

import type { AppConfig } from "./config";
import { discard, readLimited, readTextLimited } from "./streams";

/** JMAP answers here are a few small objects; a larger one is refused rather than buffered. */
const MAX_JSON_BYTES = 1024 * 1024;

async function readJson<T>(response: Response): Promise<T> {
	const text = await readTextLimited(response, MAX_JSON_BYTES);
	if (text === null) throw new MailflareError(`Mailflare answered with more than ${MAX_JSON_BYTES} bytes`, 502);
	return JSON.parse(text) as T;
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
	return { baseUrl: config.mailflareUrl, apiKey: config.mailflareApiKey, service: config.mailflareService };
}

async function call(config: MailflareConfig, path: string, init: RequestInit = {}): Promise<Response> {
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
		throw new MailflareError(`Mailflare ${path.split("?")[0]} answered ${response.status}: ${body.slice(0, 300)}`, response.status);
	}
	return response;
}

/** Larger messages are not forwarded: Email Sending would refuse them anyway. */
export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

let cachedAccountId: { key: string; id: string } | null = null;

async function jmapAccountId(config: MailflareConfig): Promise<string> {
	// Keyed by where and how Mailflare is reached as well, so a changed URL never reuses an id.
	const key = `${config.service ? "binding" : "url"}|${config.baseUrl}|${config.apiKey}`;
	if (cachedAccountId?.key === key) return cachedAccountId.id;
	const session = (await readJson(await call(config, "/jmap/session"))) as {
		primaryAccounts?: Record<string, string>;
	};
	const id = session.primaryAccounts?.[JMAP_MAIL];
	if (!id) throw new Error("Mailflare's JMAP session has no mail account");
	cachedAccountId = { key, id };
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
	});
	const body = await readJson<{ methodResponses?: [string, Record<string, unknown>, string][] }>(response);
	const [name, result] = body.methodResponses?.[0] ?? [];
	if (name !== "Email/get" || !result) throw new Error(`Mailflare JMAP Email/get failed: ${JSON.stringify(result ?? body).slice(0, 300)}`);
	const email = (result.list as { mailboxIds?: Record<string, boolean>; blobId?: string; size?: number }[] | undefined)?.[0];
	if (!email?.blobId) throw new MailflareError(`Message ${messageId} was not found in Mailflare`, 404);
	if ((email.size ?? 0) > MAX_MESSAGE_BYTES) throw new MailflareError(`Message ${messageId} is larger than ${MAX_MESSAGE_BYTES} bytes`, 413);
	// Mailbox ids look like "<mailbox>", "<mailbox>~inbox" or "<mailbox>~f~<folder>".
	const firstMailbox = Object.entries(email.mailboxIds ?? {}).find(([, active]) => active === true)?.[0];
	const mailboxId = firstMailbox?.split("~")[0];
	if (!mailboxId) throw new Error(`Message ${messageId} has no mailbox`);

	const download = await call(
		config,
		`/jmap/download/${encodeURIComponent(accountId)}/${encodeURIComponent(email.blobId)}/message.eml?type=message/rfc822`,
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
