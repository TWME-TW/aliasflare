/**
 * Builds a whole RFC 5322 message (MIME, CRLF line ends) from an outbound message, for the
 * providers that take raw mail: SMTP, Amazon SES and a custom request's {{raw}}.
 *
 * Bodies and attachments are base64, so any text survives any server; non-ASCII names and
 * subjects use RFC 2047 encoded words, and file names RFC 2231.
 */
import { bytesToBase64 } from "./crypto";
import type { OutboundMessage } from "./outbound";

const CRLF = "\r\n";
const encoder = new TextEncoder();

/** No CR, LF or other control characters: a header value can never start another header. */
const oneLine = (value: string) => value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();

/** Base64 in lines of 76 characters. */
function base64Lines(bytes: Uint8Array): string {
	const encoded = bytesToBase64(bytes);
	const lines: string[] = [];
	for (let index = 0; index < encoded.length; index += 76) lines.push(encoded.slice(index, index + 76));
	return lines.join(CRLF);
}

/** Folds a long ASCII header value on spaces so no line exceeds RFC 5322's 998-byte limit. */
function foldAscii(value: string, max = 900): string {
	if (value.length <= max) return value;
	const lines: string[] = [];
	let current = "";
	for (const token of value.split(" ")) {
		if (!current) current = token;
		else if (current.length + 1 + token.length <= max) current += ` ${token}`;
		else lines.push(current), (current = token);
	}
	if (current) lines.push(current);
	return lines.join(`${CRLF} `);
}

/** The value as is when it is plain ASCII (folded if long), otherwise RFC 2047 words of at most 45 bytes each. */
export function encodeWords(value: string, forceEncode = false): string {
	const clean = oneLine(value);
	if (!forceEncode && /^[\x20-\x7e]*$/.test(clean) && clean.split(" ").every((token) => token.length <= 900)) return foldAscii(clean);
	const words: string[] = [];
	let chunk = "";
	for (const char of clean) {
		if (encoder.encode(chunk + char).length > 45) words.push(chunk), (chunk = "");
		chunk += char;
	}
	if (chunk) words.push(chunk);
	return words.map((word) => `=?UTF-8?B?${bytesToBase64(encoder.encode(word))}?=`).join(`${CRLF} `);
}

const bareAddress = (value: string) => oneLine(value).replace(/[<>\s]+/g, "");

/** "Name" <address>, the name encoded when it needs to be. */
export function formatAddress(from: OutboundMessage["from"]): string {
	if (typeof from === "string") return `<${bareAddress(from)}>`;
	const name = oneLine(from.name).replace(/["\\]/g, "");
	const email = bareAddress(from.email);
	if (!name) return `<${email}>`;
	return /^[\x20-\x7e]*$/.test(name) && name.length + email.length + 6 <= 900 && name.split(" ").every((token) => token.length <= 900)
		? `"${name}" <${email}>`
		: `${encodeWords(name, true)} <${email}>`;
}

/** RFC 2231 attr-char percent-encoding from UTF-8 bytes (never throws URIError on lone surrogates). */
function rfc2231Encode(value: string): string {
	const bytes = encoder.encode(value);
	let out = "";
	for (const byte of bytes) {
		const ch = String.fromCharCode(byte);
		out += /^[A-Za-z0-9!#$&+\-.^_`|~]$/.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
	}
	return out;
}

/** A parameter value: quoted ASCII, or RFC 2231 UTF-8 (split into continuations so no line exceeds 998 bytes). */
function parameter(name: string, value: string): string {
	const clean = oneLine(value).replace(/["\\]/g, "_");
	if (/^[\x20-\x7e]*$/.test(clean) && name.length + clean.length + 3 <= 700) return `${name}="${clean}"`;
	const encoded = rfc2231Encode(clean);
	if (name.length + encoded.length + 10 <= 700) return `${name}*=UTF-8''${encoded}`;
	const parts: string[] = [];
	for (let pos = 0, section = 0; pos < encoded.length; section += 1) {
		const budget = section === 0 ? 60 : 70;
		let end = Math.min(encoded.length, pos + budget);
		// Never split in the middle of a %XX escape sequence.
		if (end < encoded.length) {
			if (encoded[end - 1] === "%") end -= 1;
			else if (end >= 2 && encoded[end - 2] === "%") end -= 2;
		}
		const chunk = encoded.slice(pos, end);
		parts.push(section === 0 ? `${name}*0*=UTF-8''${chunk}` : `${name}*${section}*=${chunk}`);
		pos = end;
	}
	return parts.join(`;${CRLF} `);
}

const boundary = () => `=_af_${crypto.randomUUID().replaceAll("-", "")}`;

type Part = { headers: string[]; body: string };

function textPart(type: "plain" | "html", content: string): Part {
	return { headers: [`Content-Type: text/${type}; charset=UTF-8`, "Content-Transfer-Encoding: base64"], body: base64Lines(encoder.encode(content)) };
}

function multipart(subtype: string, parts: Part[]): Part {
	const mark = boundary();
	const body = parts.map((part) => `--${mark}${CRLF}${part.headers.join(CRLF)}${CRLF}${CRLF}${part.body}`).join(CRLF) + `${CRLF}--${mark}--`;
	return { headers: [`Content-Type: multipart/${subtype}; boundary="${mark}"`], body };
}

/** Header names the caller may not set: the message's own structure and addresses. */
const RESERVED = /^(from|to|cc|bcc|reply-to|subject|date|message-id|mime-version|content-.*|sender|return-path)$/i;

/** The message's body as one MIME entity: its Content-Type headers and what follows them. */
export function buildBody(message: Pick<OutboundMessage, "text" | "html" | "attachments">): Part {
	const body: Part[] = [];
	if (message.text !== undefined || !message.html) body.push(textPart("plain", message.text ?? ""));
	if (message.html) body.push(textPart("html", message.html));
	let root: Part = body.length === 1 ? body[0]! : multipart("alternative", body);

	const files = message.attachments ?? [];
	const inline = files.filter((file) => file.disposition === "inline" && file.contentId);
	const attached = files.filter((file) => !inline.includes(file));
	const filePart = (file: (typeof files)[number], disposition: "inline" | "attachment"): Part => ({
		headers: [
			`Content-Type: ${/^[\w.+-]+\/[\w.+-]+$/.test(file.type) ? file.type : "application/octet-stream"}; ${parameter("name", file.filename)}`,
			"Content-Transfer-Encoding: base64",
			`Content-Disposition: ${disposition}; ${parameter("filename", file.filename)}`,
			...(disposition === "inline" ? [`Content-ID: <${oneLine(file.contentId ?? "").replace(/[^\x21-\x7e]+/g, "").replace(/[<>]/g, "")}>`] : []),
		],
		body: base64Lines(new Uint8Array(file.content)),
	});
	if (inline.length) root = multipart("related", [root, ...inline.map((file) => filePart(file, "inline"))]);
	if (attached.length) root = multipart("mixed", [root, ...attached.map((file) => filePart(file, "attachment"))]);
	return root;
}

/** The headers every message has, then the caller's own (never one of the reserved ones). */
function envelope(message: Pick<OutboundMessage, "from" | "replyTo" | "subject" | "headers"> & { to: OutboundMessage["from"] }, messageId: string, date: Date): string[] {
	const validDate = Number.isNaN(date.getTime()) ? new Date() : date;
	return [
		`From: ${formatAddress(message.from)}`,
		`To: ${formatAddress(message.to)}`,
		...(message.replyTo ? [`Reply-To: <${bareAddress(message.replyTo)}>`] : []),
		`Subject: ${encodeWords(message.subject)}`,
		`Date: ${validDate.toUTCString().replace("GMT", "+0000")}`,
		`Message-ID: ${oneLine(messageId)}`,
		"MIME-Version: 1.0",
		...Object.entries(message.headers ?? {})
			.filter(([name]) => /^[A-Za-z0-9-]{1,76}$/.test(name) && !RESERVED.test(name))
			.map(([name, value]) => {
				const structured = /^(in-reply-to|references)$/i.test(name);
				return `${name}: ${structured ? foldAscii(oneLine(value).replace(/[^\x20-\x7e]+/g, "")) : encodeWords(value)}`;
			}),
	];
}

export function buildMime(message: OutboundMessage, messageId: string, date = new Date()): string {
	const root = buildBody(message);
	return `${[...envelope(message, messageId, date), ...root.headers].join(CRLF)}${CRLF}${CRLF}${root.body}${CRLF}`;
}

export type EncryptedMessage = Pick<OutboundMessage, "from" | "replyTo" | "subject" | "headers" | "text" | "html" | "attachments"> & { to: OutboundMessage["from"] };

/** The subject a message shows outside when its real one is inside the encryption. */
export const HIDDEN_SUBJECT = "...";

/**
 * The part that gets encrypted (RFC 3156): the body entity, with the subject, sender and recipient
 * inside it as protected headers when the subject is hidden, so the reader's app can show them.
 */
export function encryptedPayload(message: EncryptedMessage, hideSubject: boolean): Uint8Array {
	const root = buildBody(message);
	const headers = hideSubject
		? [
				`${root.headers[0]}; protected-headers="v1"`,
				...root.headers.slice(1),
				`Subject: ${encodeWords(message.subject)}`,
				`From: ${formatAddress(message.from)}`,
				`To: ${formatAddress(message.to)}`,
			]
		: root.headers;
	return encoder.encode(`${headers.join(CRLF)}${CRLF}${CRLF}${root.body}${CRLF}`);
}

/** The whole PGP/MIME message (RFC 3156) around an armored OpenPGP message. */
export function buildEncryptedMime(message: EncryptedMessage, messageId: string, armored: string, hideSubject: boolean, date = new Date()): string {
	const mark = boundary();
	const headers = [
		...envelope({ ...message, subject: hideSubject ? HIDDEN_SUBJECT : message.subject }, messageId, date),
		`Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${mark}"`,
	];
	const body = [
		"This is an OpenPGP/MIME encrypted message (RFC 4880 and 3156)",
		`--${mark}`,
		"Content-Type: application/pgp-encrypted",
		"Content-Description: PGP/MIME version identification",
		"",
		"Version: 1",
		"",
		`--${mark}`,
		'Content-Type: application/octet-stream; name="encrypted.asc"',
		"Content-Description: OpenPGP encrypted message",
		'Content-Disposition: inline; filename="encrypted.asc"',
		"",
		armored.replace(/\r?\n/g, CRLF).trimEnd(),
		"",
		`--${mark}--`,
	];
	return `${headers.join(CRLF)}${CRLF}${CRLF}${body.join(CRLF)}${CRLF}`;
}

/** A new Message-ID on the sender's domain. */
export function newMessageId(from: OutboundMessage["from"]): string {
	const address = typeof from === "string" ? from : from.email;
	return `<${crypto.randomUUID()}@${address.split("@").pop() || "aliasflare.invalid"}>`;
}
