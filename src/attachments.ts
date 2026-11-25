import PostalMime from "postal-mime";
import { cleanAttachment, cleanSubjectLine, extractEmail, parseBareEmail, parseMessageIds, replaceAddresses, type Replacement } from "./format";
import { buildMime } from "./mime";

/**
 * Attachments that name people by address in plain text: calendar invitations (ORGANIZER,
 * ATTENDEE) and attached messages (their headers). The rest of a message is rewritten so the
 * owner's real address never reaches a correspondent; these parts need the same.
 */
export function carriesAddresses(type: string, filename: string): "calendar" | "message" | null {
	if (type === "text/calendar" || type === "application/ics" || /\.(ics|ifb|vcs)$/i.test(filename)) return "calendar";
	if (type === "message/rfc822" || type === "message/global" || /\.eml$/i.test(filename)) return "message";
	return null;
}

/** Bytes as a string of one character per byte, so any charset survives the round trip unchanged. */
function bytesToBinary(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return out;
}

function binaryToBytes(text: string): ArrayBuffer {
	const bytes = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i) & 0xff;
	return bytes.buffer;
}

/** Calendar lines longer than 75 octets are folded (a line break and a space), which can split an address. */
export const unfoldCalendar = (text: string) => text.replace(/\r?\n[ \t]/g, "");

/** Unfolds only the RFC 5322 header section of a raw message so folded addresses/links stay whole. */
function unfoldHeaders(text: string): string {
	const split = text.search(/\r?\n\r?\n/);
	if (split < 0) return text;
	return `${text.slice(0, split).replace(/\r?\n[ \t]+/g, " ")}${text.slice(split)}`;
}

/** The ORGANIZER addresses of a calendar attachment. */
export function calendarOrganizers(content: ArrayBuffer): string[] {
	const text = unfoldCalendar(bytesToBinary(new Uint8Array(content)));
	const found = new Set<string>();
	for (const match of text.matchAll(/^ORGANIZER[^:\r\n]*:mailto:([^\s;\r?]+@[^\s;\r?]+)(?:\?[^\r\n]*)?\r?$/gim)) {
		const email = parseBareEmail(match[1]);
		if (email) found.add(email);
	}
	return [...found];
}

/**
 * The attachment with each address replaced and optional signed links stripped. A calendar is
 * unfolded first, which calendar readers accept. In an attached message headers are unfolded
 * before scanning so folded addresses and List-Unsubscribe links are caught.
 */
export function rewriteAttachment(
	content: ArrayBuffer,
	kind: "calendar" | "message",
	replacements: Replacement[],
	options: { stripLinks?: (text: string) => string } = {},
): ArrayBuffer {
	if (!replacements.length && !options.stripLinks) return content;
	let text = bytesToBinary(new Uint8Array(content));
	if (kind === "calendar") text = unfoldCalendar(text);
	else text = unfoldHeaders(text);
	let out = replacements.length ? replaceAddresses(text, replacements, { encodedPlus: kind === "message" }) : text;
	if (options.stripLinks) out = options.stripLinks(out);
	return out === text && kind === "message" ? content : binaryToBytes(out);
}

const ENCODED_PART = /^content-transfer-encoding:\s*(?:base64|quoted-printable)\b/im;

/**
 * Extracts searchable plain text from a calendar or message attachment so reverse aliases inside
 * folded `.ics` lines or base64/quoted-printable `.eml` parts are discovered before rewriting.
 */
export async function attachmentSearchText(content: ArrayBuffer, kind: "calendar" | "message", depth = 0): Promise<string> {
	const raw = new TextDecoder("latin1").decode(content);
	if (kind === "calendar") return unfoldCalendar(raw);
	const unfolded = unfoldHeaders(raw);
	if (depth >= 2 || !ENCODED_PART.test(raw)) return unfolded;
	try {
		const parsed = await PostalMime.parse(content, { attachmentEncoding: "arraybuffer" });
		const nested = await Promise.all(
			parsed.attachments.map((attachment, index) => {
				const { filename, type } = cleanAttachment(attachment, index);
				const nestedKind = carriesAddresses(type, filename);
				return nestedKind ? attachmentSearchText(attachment.content as ArrayBuffer, nestedKind, depth + 1) : "";
			}),
		);
		return [unfolded, parsed.html ?? "", parsed.text ?? "", ...nested].join("\n");
	} catch {
		return unfolded;
	}
}

/**
 * Scrubs an attached `.eml` (`message/rfc822`) on an outbound reply: strips signed links and
 * replaces owner/reverse addresses across headers, plain bodies, and encoded (base64 /
 * quoted-printable) inner MIME parts.
 */
export async function scrubAttachedMessage(
	content: ArrayBuffer,
	replacements: Replacement[],
	stripLinks: (text: string) => string,
	depth = 0,
): Promise<ArrayBuffer> {
	const raw = bytesToBinary(new Uint8Array(content));
	if (depth >= 2 || !ENCODED_PART.test(raw)) {
		return rewriteAttachment(content, "message", replacements, { stripLinks });
	}
	try {
		const parsed = await PostalMime.parse(content, { attachmentEncoding: "arraybuffer" });
		const scrub = (value: string) => {
			let out = stripLinks(value);
			if (replacements.length) out = replaceAddresses(out, replacements, { encodedPlus: true });
			return out;
		};
		const rawFrom = parsed.from?.address ? scrub(parsed.from.address) : "";
		const fromEmail = extractEmail(rawFrom) ?? (rawFrom || "unknown@invalid");
		const fromName = parsed.from?.name ? scrub(parsed.from.name) : "";
		const rawTo = parsed.to?.[0]?.address ? scrub(parsed.to[0].address) : "";
		const toEmail = extractEmail(rawTo) ?? (rawTo || "unknown@invalid");
		const replyToRaw = parsed.replyTo?.[0]?.address ? scrub(parsed.replyTo[0].address) : undefined;
		const replyTo = replyToRaw ? (extractEmail(replyToRaw) ?? undefined) : undefined;
		const headers: Record<string, string> = {};
		const inReplyTo = parseMessageIds(parsed.inReplyTo)[0];
		const references = parseMessageIds(parsed.references).slice(-10);
		if (inReplyTo) headers["In-Reply-To"] = inReplyTo;
		if (references.length) headers.References = references.join(" ");
		const attachments = await Promise.all(
			parsed.attachments.map(async (attachment, index) => {
				const cleaned = cleanAttachment(attachment, index);
				const nestedKind = carriesAddresses(cleaned.type, cleaned.filename);
				const data =
					nestedKind === "message"
						? await scrubAttachedMessage(attachment.content as ArrayBuffer, replacements, stripLinks, depth + 1)
						: nestedKind === "calendar"
							? rewriteAttachment(attachment.content as ArrayBuffer, "calendar", replacements, { stripLinks })
							: (attachment.content as ArrayBuffer);
				return {
					disposition: (attachment.disposition === "inline" || !!attachment.related) && cleaned.contentId ? ("inline" as const) : ("attachment" as const),
					...(cleaned.contentId ? { contentId: cleaned.contentId } : {}),
					filename: cleaned.filename,
					type: cleaned.type,
					content: data,
				};
			}),
		);
		const rebuilt = buildMime(
			{
				from: fromName ? { name: fromName, email: fromEmail } : fromEmail,
				to: toEmail,
				...(replyTo ? { replyTo } : {}),
				subject: cleanSubjectLine(scrub(parsed.subject ?? "")) || "(no subject)",
				...(parsed.html ? { html: scrub(parsed.html) } : {}),
				...(parsed.text ? { text: scrub(parsed.text) } : parsed.html ? {} : { text: "" }),
				headers,
				attachments,
			},
			parseMessageIds(parsed.messageId)[0] ?? `<${crypto.randomUUID()}@invalid>`,
			parsed.date ? new Date(parsed.date) : new Date(),
		);
		return new TextEncoder().encode(rebuilt).buffer as ArrayBuffer;
	} catch {
		return rewriteAttachment(content, "message", replacements, { stripLinks });
	}
}
