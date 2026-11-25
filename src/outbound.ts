/**
 * Mail to other people: replies through a reverse alias and the sender's own mailto
 * unsubscribe. Cloudflare Email Sending sends it on the Workers Paid plan; on the Free plan
 * it only delivers to verified destination addresses, so a free service with an HTTP API
 * (Resend, SMTP2GO or Brevo) can send it instead. Forwards to the owner's own mailbox always use
 * Email Sending: that mailbox is a verified destination, so they work on either plan.
 */
import type { AppConfig } from "./config";
import { bytesToBase64 } from "./crypto";
import { readTextLimited } from "./streams";

export const OUTBOUND_PROVIDERS = ["cloudflare", "resend", "smtp2go", "brevo"] as const;
export type OutboundProvider = (typeof OUTBOUND_PROVIDERS)[number];

export function isOutboundProvider(value: unknown): value is OutboundProvider {
	return OUTBOUND_PROVIDERS.includes(value as OutboundProvider);
}

/** Attachments each provider takes in one message. */
export const OUTBOUND_ATTACHMENT_LIMITS: Record<OutboundProvider, number> = { cloudflare: 32, resend: 50, smtp2go: 50, brevo: 50 };

/** File types Brevo accepts as attachments; it refuses the whole message for any other. */
const BREVO_EXTENSIONS = new Set(
	"xlsx xls ods docx docm doc csv pdf txt gif jpg jpeg png tif tiff rtf bmp cgm css shtml html htm zip xml ppt pptx tar ez ics mobi msg pub eps odt mp3 m4a m4v wma ogg flac wav aif aifc aiff mp4 mov avi mkv mpeg mpg wmv pkpass xlsm".split(" "),
);

/** Why the provider cannot send these attachments, or null when it can. */
export function unsendableAttachments(provider: OutboundProvider, filenames: string[]): string | null {
	if (provider !== "brevo") return null;
	const refused = filenames.filter((name) => !BREVO_EXTENSIONS.has(name.split(".").pop()?.toLowerCase() ?? ""));
	return refused.length ? `Brevo does not send these file types: ${refused.slice(0, 5).join(", ")}` : null;
}

export type OutboundAttachment = {
	disposition: "attachment" | "inline";
	filename: string;
	type: string;
	content: ArrayBuffer;
	contentId?: string;
};

export type OutboundMessage = {
	from: string | { name: string; email: string };
	to: string;
	replyTo?: string;
	subject: string;
	html?: string;
	text?: string;
	headers?: Record<string, string>;
	attachments?: OutboundAttachment[];
};

export class OutboundError extends Error {}

const TIMEOUT_MS = 20_000;

function mailbox(from: OutboundMessage["from"]): string {
	if (typeof from === "string") return from;
	const name = from.name.replace(/["\\\r\n]/g, "").trim();
	return name ? `"${name}" <${from.email}>` : from.email;
}

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; json: unknown }> {
	const response = await fetch(url, {
		method: "POST",
		redirect: "manual",
		signal: AbortSignal.timeout(TIMEOUT_MS),
		headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
		body: JSON.stringify(body),
	});
	const text = (await readTextLimited(response, 64 * 1024).catch(() => null)) ?? "";
	let json: unknown = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		// Reported with the status below.
	}
	if (response.status >= 300) throw new OutboundError(`${new URL(url).hostname} answered ${response.status}: ${text.slice(0, 300)}`);
	return { status: response.status, json };
}

async function viaResend(apiKey: string, message: OutboundMessage): Promise<string | undefined> {
	const { json } = await post(
		"https://api.resend.com/emails",
		{ Authorization: `Bearer ${apiKey}` },
		{
			from: mailbox(message.from),
			to: [message.to],
			subject: message.subject,
			...(message.replyTo ? { reply_to: message.replyTo } : {}),
			...(message.html ? { html: message.html } : {}),
			...(message.text !== undefined ? { text: message.text } : {}),
			...(message.headers && Object.keys(message.headers).length ? { headers: message.headers } : {}),
			...(message.attachments?.length
				? {
						attachments: message.attachments.map((attachment) => ({
							filename: attachment.filename,
							content: bytesToBase64(new Uint8Array(attachment.content)),
							content_type: attachment.type,
							...(attachment.disposition === "inline" && attachment.contentId ? { content_id: attachment.contentId } : {}),
						})),
					}
				: {}),
		},
	);
	const id = (json as { id?: unknown } | null)?.id;
	return typeof id === "string" ? id : undefined;
}

async function viaSmtp2go(apiKey: string, message: OutboundMessage): Promise<string | undefined> {
	const headers = Object.entries({ ...(message.headers ?? {}), ...(message.replyTo ? { "Reply-To": message.replyTo } : {}) }).map(([header, value]) => ({ header, value }));
	const encode = (attachment: OutboundAttachment) => ({ fileblob: bytesToBase64(new Uint8Array(attachment.content)), mimetype: attachment.type });
	const inline = (message.attachments ?? []).filter((attachment) => attachment.disposition === "inline" && attachment.contentId);
	const attached = (message.attachments ?? []).filter((attachment) => !inline.includes(attachment));
	const { json } = await post(
		"https://api.smtp2go.com/v3/email/send",
		{ "X-Smtp2go-Api-Key": apiKey },
		{
			sender: mailbox(message.from),
			to: [message.to],
			subject: message.subject,
			...(message.html ? { html_body: message.html } : {}),
			...(message.text !== undefined ? { text_body: message.text } : {}),
			...(headers.length ? { custom_headers: headers } : {}),
			...(attached.length ? { attachments: attached.map((attachment) => ({ filename: attachment.filename, ...encode(attachment) })) } : {}),
			// SMTP2GO matches inline parts to cid: references by file name.
			...(inline.length ? { inlines: inline.map((attachment) => ({ filename: attachment.contentId, ...encode(attachment) })) } : {}),
		},
	);
	// SMTP2GO answers 200 even when the message was refused; the counts say what happened.
	const data = (json as { data?: { succeeded?: number; failed?: number; failures?: unknown; email_id?: unknown } } | null)?.data;
	if (!data || (data.failed ?? 0) > 0 || (data.succeeded ?? 0) < 1) {
		throw new OutboundError(`SMTP2GO did not send the message: ${JSON.stringify(data?.failures ?? json).slice(0, 300)}`);
	}
	return typeof data.email_id === "string" ? data.email_id : undefined;
}

function brevoAddress(from: OutboundMessage["from"]): { email: string; name?: string } {
	if (typeof from === "string") return { email: from };
	const name = from.name.replace(/[\r\n]/g, "").trim().slice(0, 70);
	return name ? { email: from.email, name } : { email: from.email };
}

async function viaBrevo(apiKey: string, message: OutboundMessage): Promise<string | undefined> {
	// Brevo takes only custom headers: standard ones such as In-Reply-To and References are
	// not supported, so threading rests on the subject. It has no inline parts either, so
	// inline images arrive as attachments.
	const custom = Object.fromEntries(Object.entries(message.headers ?? {}).filter(([name]) => /^X-/i.test(name)));
	const { json } = await post(
		"https://api.brevo.com/v3/smtp/email",
		{ "api-key": apiKey },
		{
			sender: brevoAddress(message.from),
			to: [{ email: message.to }],
			subject: message.subject,
			...(message.replyTo ? { replyTo: { email: message.replyTo } } : {}),
			// One body per message: HTML when there is one, else the plain text.
			...(message.html ? { htmlContent: message.html } : { textContent: message.text || " " }),
			...(Object.keys(custom).length ? { headers: custom } : {}),
			...(message.attachments?.length
				? { attachment: message.attachments.map((attachment) => ({ name: attachment.filename, content: bytesToBase64(new Uint8Array(attachment.content)) })) }
				: {}),
		},
	);
	const id = (json as { messageId?: unknown } | null)?.messageId;
	return typeof id === "string" ? id : undefined;
}

/** Sends mail to someone other than the owner, with the provider chosen on the Connection page. */
export async function sendOutbound(env: Env, config: AppConfig, message: OutboundMessage): Promise<{ messageId?: string }> {
	if (config.outboundProvider === "cloudflare") {
		const result = await env.EMAIL.send({
			from: message.from,
			to: message.to,
			subject: message.subject,
			...(message.replyTo ? { replyTo: message.replyTo } : {}),
			...(message.html ? { html: message.html } : {}),
			...(message.text !== undefined ? { text: message.text } : {}),
			...(message.headers ? { headers: message.headers } : {}),
			...(message.attachments?.length
				? {
						attachments: message.attachments.map((attachment) =>
							attachment.disposition === "inline" && attachment.contentId
								? { disposition: "inline" as const, contentId: attachment.contentId, filename: attachment.filename, type: attachment.type, content: attachment.content }
								: { disposition: "attachment" as const, filename: attachment.filename, type: attachment.type, content: attachment.content },
						),
					}
				: {}),
		} as Parameters<SendEmail["send"]>[0]);
		return { messageId: (result as { messageId?: string } | undefined)?.messageId };
	}
	if (!config.outboundApiKey) throw new OutboundError(`No API key is set for ${config.outboundProvider}`);
	const send = { resend: viaResend, smtp2go: viaSmtp2go, brevo: viaBrevo }[config.outboundProvider];
	const messageId = await send(config.outboundApiKey, message);
	return { messageId };
}
