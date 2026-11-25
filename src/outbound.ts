/**
 * Mail to other people: replies through a reverse alias and the sender's own mailto
 * unsubscribe. Cloudflare Email Sending sends it on the Workers Paid plan; on the Free plan
 * it only delivers to verified destination addresses, so another service can send it instead:
 * one with an HTTP API (Resend, SMTP2GO, Brevo, Postmark, Mailgun, Amazon SES, Mail.baby), any SMTP
 * server, or a request of the user's own design. Forwards to the owner's own mailbox always use
 * Email Sending: that mailbox is a verified destination, so they work on either plan.
 */
import type { AppConfig } from "./config";
import { bytesToBase64 } from "./crypto";
import { extractEmail, hostnameOf, isPublicHost, safeHttpsUrl } from "./format";
import { buildMime, formatAddress, newMessageId } from "./mime";
import { sendSmtp, type SmtpSecurity } from "./smtp";
import { readTextLimited } from "./streams";

export const OUTBOUND_PROVIDERS = ["cloudflare", "resend", "smtp2go", "brevo", "postmark", "mailgun", "ses", "mailbaby", "smtp", "custom"] as const;
export type OutboundProvider = (typeof OUTBOUND_PROVIDERS)[number];

export function isOutboundProvider(value: unknown): value is OutboundProvider {
	return OUTBOUND_PROVIDERS.includes(value as OutboundProvider);
}

/** Attachments each provider takes in one message. */
export const OUTBOUND_ATTACHMENT_LIMITS: Record<OutboundProvider, number> = { cloudflare: 32, resend: 50, smtp2go: 50, brevo: 50, postmark: 50, mailgun: 50, ses: 50, mailbaby: 50, smtp: 50, custom: 50 };

/**
 * What the providers need besides the secret (the API key, SMTP password or AWS secret key,
 * which stays in outboundApiKey). Stored as one JSON value; OUTBOUND_OPTIONS can set it.
 */
export type OutboundOptions = {
	smtpHost: string;
	smtpPort: number;
	smtpSecurity: SmtpSecurity;
	smtpUsername: string;
	mailgunRegion: "us" | "eu";
	sesRegion: string;
	sesAccessKeyId: string;
	/** Which Mail.baby mail order sends (its numeric id); empty for the account's first active one. */
	mailbabyOrderId: string;
	/** A custom request: https URL, "Name: value" header lines and a body with {{placeholders}}. */
	customUrl: string;
	customHeaders: string;
	customBody: string;
	/** Where the response's message id is, as a dotted path ("data.id"); empty for none. */
	customIdPath: string;
};

export const DEFAULT_OUTBOUND_OPTIONS: OutboundOptions = {
	smtpHost: "",
	smtpPort: 587,
	smtpSecurity: "starttls",
	smtpUsername: "",
	mailgunRegion: "us",
	sesRegion: "us-east-1",
	sesAccessKeyId: "",
	mailbabyOrderId: "",
	customUrl: "",
	customHeaders: "Authorization: Bearer {{api_key}}",
	customBody: '{"from": {{from_header}}, "to": [{{to}}], "subject": {{subject}}, "html": {{html}}, "text": {{text}}, "reply_to": {{reply_to}}, "headers": {{headers}}}',
	customIdPath: "id",
};

export const SES_REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/;

/** Keeps known fields with usable values; anything else is the default. */
export function normalizeOutboundOptions(raw: unknown): OutboundOptions {
	const value = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
	const str = (key: keyof OutboundOptions, max: number) => (typeof value[key] === "string" ? (value[key] as string).trim().slice(0, max) : undefined);
	const port = Number(value.smtpPort);
	const host = str("smtpHost", 253)?.toLowerCase() ?? "";
	const region = str("sesRegion", 30)?.toLowerCase() ?? "";
	return {
		smtpHost: isPublicHost(host) ? host : "",
		smtpPort: Number.isInteger(port) && port > 0 && port < 65536 && port !== 25 ? port : DEFAULT_OUTBOUND_OPTIONS.smtpPort,
		smtpSecurity: value.smtpSecurity === "tls" ? "tls" : "starttls",
		smtpUsername: (str("smtpUsername", 320) ?? "").replace(/[\u0000-\u001f]/g, ""),
		mailgunRegion: value.mailgunRegion === "eu" ? "eu" : "us",
		sesRegion: SES_REGION.test(region) ? region : DEFAULT_OUTBOUND_OPTIONS.sesRegion,
		sesAccessKeyId: (str("sesAccessKeyId", 128) ?? "").replace(/[^A-Z0-9]/g, ""),
		// Checked whole (not cut first), and short enough to stay exact as a JSON number.
		mailbabyOrderId: typeof value.mailbabyOrderId === "string" && /^\d{1,15}$/.test(value.mailbabyOrderId.trim()) ? value.mailbabyOrderId.trim() : "",
		customUrl: str("customUrl", 2000) ?? "",
		customHeaders: str("customHeaders", 4000) ?? DEFAULT_OUTBOUND_OPTIONS.customHeaders,
		customBody: str("customBody", 20_000) ?? DEFAULT_OUTBOUND_OPTIONS.customBody,
		customIdPath: (str("customIdPath", 100) ?? DEFAULT_OUTBOUND_OPTIONS.customIdPath).replace(/[^\w.]/g, ""),
	};
}

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
	const name = from.name.replace(/["\\\u0000-\u001f\u007f]/g, "").trim();
	return name ? `"${name}" <${from.email}>` : from.email;
}

async function post(url: string, headers: Record<string, string>, body: unknown, secret = ""): Promise<{ status: number; json: unknown }> {
	return request(url, { "Content-Type": "application/json", Accept: "application/json", ...headers }, JSON.stringify(body), secret);
}

/** Text from a provider's answer, without the key in case the provider echoes it. */
function redact(text: string, secret: string): string {
	return secret.length >= 6 ? text.replaceAll(secret, "[redacted]") : text;
}

/** POSTs a body as it is; a status of 300 or more is an error, with the start of the answer. */
async function request(url: string, headers: Record<string, string>, body: string | FormData, secret = ""): Promise<{ status: number; json: unknown }> {
	const response = await fetch(url, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers, body });
	const text = (await readTextLimited(response, 64 * 1024).catch(() => null)) ?? "";
	let json: unknown = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		// Reported with the status below.
	}
	if (response.status >= 300) {
		throw new OutboundError(`${new URL(url).hostname} answered ${response.status}: ${redact(text, secret).slice(0, 300)}`);
	}
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
		apiKey,
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
		apiKey,
	);
	// SMTP2GO answers 200 even when the message was refused; the counts say what happened.
	const data = (json as { data?: { succeeded?: number; failed?: number; failures?: unknown; email_id?: unknown } } | null)?.data;
	if (!data || (data.failed ?? 0) > 0 || (data.succeeded ?? 0) < 1) {
		throw new OutboundError(`SMTP2GO did not send the message: ${redact(JSON.stringify(data?.failures ?? json), apiKey).slice(0, 300)}`);
	}
	return typeof data.email_id === "string" ? data.email_id : undefined;
}

function brevoAddress(from: OutboundMessage["from"]): { email: string; name?: string } {
	if (typeof from === "string") return { email: from };
	const name = from.name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 70);
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
		apiKey,
	);
	const id = (json as { messageId?: unknown } | null)?.messageId;
	return typeof id === "string" ? id : undefined;
}

async function viaPostmark(apiKey: string, message: OutboundMessage): Promise<string | undefined> {
	const headers = Object.entries(message.headers ?? {}).map(([Name, Value]) => ({ Name, Value }));
	const { json } = await post(
		"https://api.postmarkapp.com/email",
		{ "X-Postmark-Server-Token": apiKey },
		{
			From: mailbox(message.from),
			To: message.to,
			Subject: message.subject,
			...(message.replyTo ? { ReplyTo: message.replyTo } : {}),
			...(message.html ? { HtmlBody: message.html } : {}),
			...(message.text !== undefined ? { TextBody: message.text } : {}),
			...(headers.length ? { Headers: headers } : {}),
			...(message.attachments?.length
				? {
						Attachments: message.attachments.map((attachment) => ({
							Name: attachment.filename,
							Content: bytesToBase64(new Uint8Array(attachment.content)),
							ContentType: attachment.type,
							...(attachment.disposition === "inline" && attachment.contentId ? { ContentID: `cid:${attachment.contentId}` } : {}),
						})),
					}
				: {}),
		},
		apiKey,
	);
	const id = (json as { MessageID?: unknown; ErrorCode?: unknown } | null)?.MessageID;
	if ((json as { ErrorCode?: unknown } | null)?.ErrorCode) throw new OutboundError(`Postmark did not send the message: ${redact(JSON.stringify(json), apiKey).slice(0, 300)}`);
	return typeof id === "string" ? id : undefined;
}

async function viaMailgun(apiKey: string, options: OutboundOptions, message: OutboundMessage): Promise<string | undefined> {
	// Mailgun sends for one domain per URL: the alias's own, verified there.
	const rawFrom = typeof message.from === "string" ? message.from : message.from.email;
	const address = extractEmail(rawFrom) ?? rawFrom;
	const domain = address.split("@").pop() ?? "";
	const form = new FormData();
	form.append("from", mailbox(message.from));
	form.append("to", message.to);
	form.append("subject", message.subject);
	if (message.text !== undefined) form.append("text", message.text);
	if (message.html) form.append("html", message.html);
	if (message.replyTo) form.append("h:Reply-To", message.replyTo);
	for (const [name, value] of Object.entries(message.headers ?? {})) form.append(`h:${name}`, value);
	for (const attachment of message.attachments ?? []) {
		const inline = attachment.disposition === "inline" && attachment.contentId;
		// Mailgun gives an inline part the file name as its Content-ID.
		form.append(inline ? "inline" : "attachment", new Blob([attachment.content], { type: attachment.type }), inline ? attachment.contentId : attachment.filename);
	}
	const host = options.mailgunRegion === "eu" ? "api.eu.mailgun.net" : "api.mailgun.net";
	const auth = bytesToBase64(new TextEncoder().encode(`api:${apiKey}`));
	const { json } = await request(`https://${host}/v3/${encodeURIComponent(domain)}/messages`, { Authorization: `Basic ${auth}`, Accept: "application/json" }, form, apiKey);
	const id = (json as { id?: unknown } | null)?.id;
	return typeof id === "string" ? id : undefined;
}

const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const sha256 = async (text: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
async function hmac(key: ArrayBuffer | Uint8Array, text: string): Promise<ArrayBuffer> {
	const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(text));
}

/** AWS Signature Version 4 for one POST to SES. */
export async function signSes(input: { region: string; accessKeyId: string; secret: string; body: string; date: Date }): Promise<Record<string, string>> {
	const host = `email.${input.region}.amazonaws.com`;
	const amzDate = input.date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
	const day = amzDate.slice(0, 8);
	const signed = "content-type;host;x-amz-date";
	const canonical = ["POST", "/v2/email/outbound-emails", "", `content-type:application/json\nhost:${host}\nx-amz-date:${amzDate}\n`, signed, await sha256(input.body)].join("\n");
	const scope = `${day}/${input.region}/ses/aws4_request`;
	const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256(canonical)].join("\n");
	let key = await hmac(new TextEncoder().encode(`AWS4${input.secret}`), day);
	for (const part of [input.region, "ses", "aws4_request"]) key = await hmac(key, part);
	return {
		"Content-Type": "application/json",
		"X-Amz-Date": amzDate,
		Authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${hex(await hmac(key, toSign))}`,
	};
}

async function viaSes(secret: string, options: OutboundOptions, message: OutboundMessage): Promise<string | undefined> {
	if (!options.sesAccessKeyId) throw new OutboundError("No AWS access key ID is set for Amazon SES");
	const from = typeof message.from === "string" ? message.from : message.from.email;
	const raw = buildMime(message, newMessageId(message.from));
	const body = JSON.stringify({ FromEmailAddress: from, Destination: { ToAddresses: [message.to] }, Content: { Raw: { Data: bytesToBase64(new TextEncoder().encode(raw)) } } });
	const headers = await signSes({ region: options.sesRegion, accessKeyId: options.sesAccessKeyId, secret, body, date: new Date() });
	const { json } = await request(`https://email.${options.sesRegion}.amazonaws.com/v2/email/outbound-emails`, headers, body, secret);
	const id = (json as { MessageId?: unknown } | null)?.MessageId;
	return typeof id === "string" ? id : undefined;
}

/**
 * Mail.baby (InterServer's relay) through /mail/rawsend: the message goes as built, so the
 * thread headers, inline parts and Message-ID stay as they are. Its own sending endpoints set
 * Reply-To to the sender and take no other headers.
 */
async function viaMailbaby(apiKey: string, options: OutboundOptions, message: OutboundMessage): Promise<string | undefined> {
	const messageId = newMessageId(message.from);
	const { json } = await post(
		"https://api.mailbaby.net/mail/rawsend",
		{ "X-API-KEY": apiKey },
		{ raw_email: buildMime(message, messageId), ...(options.mailbabyOrderId ? { id: Number(options.mailbabyOrderId) } : {}) },
		apiKey,
	);
	const answer = json as { status?: unknown; text?: unknown; message?: unknown } | null;
	if (answer?.status !== "ok") throw new OutboundError(`Mail.baby did not send the message: ${redact(JSON.stringify(json), apiKey).slice(0, 300)}`);
	return messageId;
}

async function viaSmtp(password: string, options: OutboundOptions, message: OutboundMessage, blockedHosts: string[] = []): Promise<string | undefined> {
	if (!options.smtpHost || !isPublicHost(options.smtpHost, blockedHosts)) throw new OutboundError("No valid public SMTP server is set");
	const messageId = newMessageId(message.from);
	const from = typeof message.from === "string" ? message.from : message.from.email;
	await sendSmtp(
		{ host: options.smtpHost, port: options.smtpPort, security: options.smtpSecurity, username: options.smtpUsername, password },
		{ from, to: message.to },
		buildMime(message, messageId),
	);
	return messageId;
}

/** The values a custom request can use, each as JSON ({{subject}} becomes "Hello"). */
export function customValues(message: OutboundMessage, apiKey: string, messageId: string, raw: () => string): Record<string, () => unknown> {
	const from = typeof message.from === "string" ? { email: message.from, name: "" } : message.from;
	return {
		from: () => from.email,
		from_name: () => from.name || null,
		from_header: () => formatAddress(message.from).replace(/^<(.*)>$/, "$1"),
		to: () => message.to,
		reply_to: () => message.replyTo ?? null,
		subject: () => message.subject,
		text: () => message.text ?? null,
		html: () => message.html ?? null,
		headers: () => message.headers ?? {},
		attachments: () =>
			(message.attachments ?? []).map((attachment) => ({
				filename: attachment.filename,
				content_type: attachment.type,
				content: bytesToBase64(new Uint8Array(attachment.content)),
				disposition: attachment.disposition,
				content_id: attachment.contentId ?? null,
			})),
		raw: () => bytesToBase64(new TextEncoder().encode(raw())),
		message_id: () => messageId,
		api_key: () => apiKey,
	};
}

/** Fills {{name}} placeholders: as JSON in a body, as plain text in a header. Unknown ones are an error. */
export function fillTemplate(template: string, values: Record<string, () => unknown>, as: "json" | "text"): string {
	return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_match, name: string) => {
		if (!Object.hasOwn(values, name)) throw new OutboundError(`Unknown placeholder {{${name}}}`);
		const value = values[name]!();
		return as === "json" ? JSON.stringify(value) : String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/[^\x20-\xff]+/g, "");
	});
}

const FORBIDDEN_HEADER_NAMES = new Set(["__proto__", "constructor", "prototype"]);

/** "Name: value" lines as headers; blank lines are skipped. */
export function parseHeaderLines(lines: string): [string, string][] {
	const out: [string, string][] = [];
	for (const line of lines.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const at = line.indexOf(":");
		const name = at > 0 ? line.slice(0, at).trim() : "";
		if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name) || FORBIDDEN_HEADER_NAMES.has(name.toLowerCase())) {
			throw new OutboundError(`Not a header line: ${line.slice(0, 60)}`);
		}
		out.push([name, line.slice(at + 1).trim()]);
	}
	return out;
}

async function viaCustom(apiKey: string, options: OutboundOptions, message: OutboundMessage, blockedHosts: string[] = []): Promise<string | undefined> {
	const safeUrl = options.customUrl ? safeHttpsUrl(options.customUrl, blockedHosts) : null;
	if (!safeUrl) throw new OutboundError("No valid public https URL is set for the custom request");
	const messageId = newMessageId(message.from);
	const values = customValues(message, apiKey, messageId, () => buildMime(message, messageId));
	const headers: Record<string, string> = Object.assign(Object.create(null), { "Content-Type": "application/json", Accept: "application/json" });
	for (const [name, value] of parseHeaderLines(options.customHeaders)) {
		const lower = name.toLowerCase();
		for (const existing of Object.keys(headers)) {
			if (existing.toLowerCase() === lower) delete headers[existing];
		}
		headers[name] = fillTemplate(value, values, "text");
	}
	const { json } = await request(safeUrl.href, headers, fillTemplate(options.customBody, values, "json"), apiKey);
	if (!options.customIdPath) return undefined;
	let found: unknown = json;
	for (const key of options.customIdPath.split(".")) found = found && typeof found === "object" && Object.hasOwn(found, key) ? (found as Record<string, unknown>)[key] : undefined;
	return typeof found === "string" ? found : typeof found === "number" ? String(found) : undefined;
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
	const provider = config.outboundProvider;
	const options = config.outboundOptions;
	// An SMTP server may take mail without a password; everything else needs its secret.
	if (!config.outboundApiKey && !(provider === "smtp" && !options.smtpUsername) && provider !== "custom") throw new OutboundError(`No API key is set for ${provider}`);
	const key = config.outboundApiKey;
	const blockedHosts = [config.publicUrl, config.siteOrigin, config.mailflareUrl].map(hostnameOf).filter((host): host is string => !!host);
	switch (provider) {
		case "resend":
			return { messageId: await viaResend(key, message) };
		case "smtp2go":
			return { messageId: await viaSmtp2go(key, message) };
		case "brevo":
			return { messageId: await viaBrevo(key, message) };
		case "postmark":
			return { messageId: await viaPostmark(key, message) };
		case "mailgun":
			return { messageId: await viaMailgun(key, options, message) };
		case "ses":
			return { messageId: await viaSes(key, options, message) };
		case "mailbaby":
			return { messageId: await viaMailbaby(key, options, message) };
		case "smtp":
			return { messageId: await viaSmtp(key, options, message, blockedHosts) };
		case "custom":
			return { messageId: await viaCustom(key, options, message, blockedHosts) };
	}
}
