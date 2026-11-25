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
export function encodeWords(value: string): string {
	const clean = oneLine(value);
	if (/^[\x20-\x7e]*$/.test(clean) && clean.split(" ").every((token) => token.length <= 900)) return foldAscii(clean);
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
	return /^[\x20-\x7e]*$/.test(name) && name.split(" ").every((token) => token.length <= 900) ? `"${name}" <${email}>` : `${encodeWords(name)} <${email}>`;
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
	if (/^[\x20-\x7e]*$/.test(clean) && name.length + clean.length + 3 <= 800) return `${name}="${clean}"`;
	const encoded = rfc2231Encode(clean);
	if (name.length + encoded.length + 10 <= 800) return `${name}*=UTF-8''${encoded}`;
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

export function buildMime(message: OutboundMessage, messageId: string, date = new Date()): string {
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
			...(disposition === "inline" ? [`Content-ID: <${oneLine(file.contentId ?? "").replace(/[<>]/g, "")}>`] : []),
		],
		body: base64Lines(new Uint8Array(file.content)),
	});
	if (inline.length) root = multipart("related", [root, ...inline.map((file) => filePart(file, "inline"))]);
	if (attached.length) root = multipart("mixed", [root, ...attached.map((file) => filePart(file, "attachment"))]);

	const headers = [
		`From: ${formatAddress(message.from)}`,
		`To: <${bareAddress(message.to)}>`,
		...(message.replyTo ? [`Reply-To: <${bareAddress(message.replyTo)}>`] : []),
		`Subject: ${encodeWords(message.subject)}`,
		`Date: ${date.toUTCString().replace("GMT", "+0000")}`,
		`Message-ID: ${oneLine(messageId)}`,
		"MIME-Version: 1.0",
		...Object.entries(message.headers ?? {})
			.filter(([name]) => /^[A-Za-z0-9-]{1,76}$/.test(name) && !RESERVED.test(name))
			.map(([name, value]) => {
				const structured = /^(in-reply-to|references)$/i.test(name);
				return `${name}: ${structured ? foldAscii(oneLine(value).replace(/[^\x20-\x7e]+/g, "")) : encodeWords(value)}`;
			}),
		...root.headers,
	];
	return `${headers.join(CRLF)}${CRLF}${CRLF}${root.body}${CRLF}`;
}

/** A new Message-ID on the sender's domain. */
export function newMessageId(from: OutboundMessage["from"]): string {
	const address = typeof from === "string" ? from : from.email;
	return `<${crypto.randomUUID()}@${address.split("@").pop() || "aliasflare.invalid"}>`;
}
