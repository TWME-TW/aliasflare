import PostalMime from "postal-mime";
import { cleanAttachment, cleanSubjectLine, domainOf, extractEmail, parseBareEmail, parseMessageIds, replaceAddresses, sanitizeDisplayName, type Replacement } from "./format";
import { buildMime } from "./mime";
import { siteOf } from "./unsubscribe";

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
	let out = replacements.length ? replaceAddresses(text, replacements, { encodedPlus: true }) : text;
	if (options.stripLinks) out = options.stripLinks(out);
	return out === text && kind === "message" ? content : binaryToBytes(out);
}

const MAX_EML_DEPTH = 5;
// Each attached message, at any depth, costs one parse. Above the 50 attachments a reply may
// carry, so a reply forwarding many messages keeps them all; only crafted nesting runs out.
export const MAX_NESTED_EML_PARSES = 64;
export const MAX_NESTED_ATTACHMENTS = 32;

export type EmlParseBudget = { remaining: number };

/**
 * Extracts searchable plain text from a calendar or message attachment so reverse aliases inside
 * folded `.ics` lines, RFC 2047 headers, filenames, or nested `.eml` parts are discovered before rewriting.
 */
export async function attachmentSearchText(
	content: ArrayBuffer,
	kind: "calendar" | "message",
	depth = 0,
	budget: EmlParseBudget = { remaining: MAX_NESTED_EML_PARSES },
): Promise<string> {
	const raw = new TextDecoder("latin1").decode(content);
	if (kind === "calendar") return unfoldCalendar(raw);
	const unfolded = unfoldHeaders(raw);
	if (depth >= MAX_EML_DEPTH || budget.remaining <= 0) return unfolded;
	budget.remaining -= 1;
	try {
		const parsed = await PostalMime.parse(content, { attachmentEncoding: "arraybuffer" });
		const headerParts = [
			parsed.subject ?? "",
			parsed.from?.name ?? "",
			parsed.from?.address ?? "",
			...(parsed.to ?? []).flatMap((a) => [a.name ?? "", a.address ?? ""]),
			...(parsed.cc ?? []).flatMap((a) => [a.name ?? "", a.address ?? ""]),
			...(parsed.replyTo ?? []).flatMap((a) => [a.name ?? "", a.address ?? ""]),
			parsed.messageId ?? "",
			parsed.inReplyTo ?? "",
			parsed.references ?? "",
		];
		const nested: string[] = [];
		for (const [index, attachment] of parsed.attachments.slice(0, MAX_NESTED_ATTACHMENTS).entries()) {
			const { filename, type, contentId } = cleanAttachment(attachment, index);
			const nestedKind = carriesAddresses(type, filename);
			const body = nestedKind ? await attachmentSearchText(attachment.content as ArrayBuffer, nestedKind, depth + 1, budget) : "";
			nested.push([filename, contentId ?? "", body].join("\n"));
		}
		return [unfolded, ...headerParts, parsed.html ?? "", parsed.text ?? "", ...nested].join("\n");
	} catch {
		return unfolded;
	}
}

function safeMessageId(id: string | undefined, ownSites: Set<string>, scrub: (value: string) => string): string | null {
	if (!id) return null;
	const parsed = parseMessageIds(id)[0];
	if (!parsed) return null;
	const inner = parsed.slice(1, -1);
	// Drop any Message-ID referencing the owner's mail provider domain or an address that needed scrubbing.
	if (scrub(inner) !== inner) return null;
	const domain = inner.split("@").pop() ?? "";
	if (domain.includes(".") && ownSites.has(siteOf(domain))) return null;
	return parsed;
}

function safeDate(raw: string | undefined): Date {
	if (!raw) return new Date();
	const parsed = new Date(raw);
	return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function stubMessage(reason: string): ArrayBuffer {
	const rebuilt = buildMime(
		{ from: "unknown@invalid", to: "unknown@invalid", subject: "[attached message removed]", text: reason },
		`<${crypto.randomUUID()}@invalid>`,
		new Date(),
	);
	return new TextEncoder().encode(rebuilt).buffer as ArrayBuffer;
}

export type ScrubMessageOptions = {
	ownSites?: Set<string>;
	removeBanner?: (html: string) => Promise<string>;
	depth?: number;
	budget?: EmlParseBudget;
};

/**
 * Scrubs an attached `.eml` (`message/rfc822`) on an outbound reply: always parses and rebuilds
 * via `PostalMime` + `buildMime` so transport headers (`Received`, `Delivered-To`, `Return-Path`,
 * `Authentication-Results`, owner `Message-ID`), banners, signed links, and owner/reverse addresses
 * across plain and encoded inner parts cannot leak.
 */
export async function scrubAttachedMessage(
	content: ArrayBuffer,
	replacements: Replacement[],
	stripLinks: (text: string) => string,
	options: ScrubMessageOptions = {},
): Promise<ArrayBuffer> {
	const depth = options.depth ?? 0;
	const budget = options.budget ?? { remaining: MAX_NESTED_EML_PARSES };
	if (depth >= MAX_EML_DEPTH || budget.remaining <= 0) {
		return stubMessage("Nested attached message removed for privacy.");
	}
	budget.remaining -= 1;
	const ownSites = options.ownSites ?? new Set<string>();
	try {
		const parsed = await PostalMime.parse(content, { attachmentEncoding: "arraybuffer" });
		if (parsed.attachments.length > MAX_NESTED_ATTACHMENTS) {
			return stubMessage("Attached message has too many attachments and was removed for privacy.");
		}
		const scrub = (value: string) => {
			let out = stripLinks(value);
			if (replacements.length) out = replaceAddresses(out, replacements, { encodedPlus: true });
			return out;
		};
		const rawFrom = parsed.from?.address ? scrub(parsed.from.address) : "";
		const fromEmail = extractEmail(rawFrom) ?? "unknown@invalid";
		const fromName = parsed.from?.name ? sanitizeDisplayName(scrub(parsed.from.name)) : "";
		const rawTo = parsed.to?.[0]?.address ? scrub(parsed.to[0].address) : "";
		const toEmail = extractEmail(rawTo) ?? "unknown@invalid";
		const replyToRaw = parsed.replyTo?.[0]?.address ? scrub(parsed.replyTo[0].address) : undefined;
		const replyTo = replyToRaw ? (extractEmail(replyToRaw) ?? undefined) : undefined;
		const headers: Record<string, string> = {};
		const inReplyTo = safeMessageId(parsed.inReplyTo, ownSites, scrub);
		const references = parseMessageIds(parsed.references)
			.slice(-10)
			.map((id) => safeMessageId(id, ownSites, scrub))
			.filter((id): id is string => !!id);
		if (inReplyTo) headers["In-Reply-To"] = inReplyTo;
		if (references.length) headers.References = references.join(" ");
		let html = parsed.html ? scrub(parsed.html) : undefined;
		if (html && options.removeBanner) html = await options.removeBanner(html);
		const text = parsed.text ? scrub(parsed.text) : undefined;
		const attachments = [];
		for (const [index, attachment] of parsed.attachments.entries()) {
			const cleaned = cleanAttachment(attachment, index);
			const nestedKind = carriesAddresses(cleaned.type, cleaned.filename);
			const scrubbedFilename = cleanAttachment({ filename: scrub(cleaned.filename), mimeType: cleaned.type }, index).filename;
			let scrubbedCid = cleaned.contentId ? scrub(cleaned.contentId) : undefined;
			if (scrubbedCid) {
				const cidDomain = scrubbedCid.split("@").pop() ?? "";
				if (cidDomain.includes(".") && ownSites.has(siteOf(cidDomain))) {
					scrubbedCid = `${crypto.randomUUID()}@invalid`;
				}
			}
			const data =
				nestedKind === "message"
					? await scrubAttachedMessage(attachment.content as ArrayBuffer, replacements, stripLinks, { ...options, depth: depth + 1, budget })
					: nestedKind === "calendar"
						? rewriteAttachment(attachment.content as ArrayBuffer, "calendar", replacements, { stripLinks })
						: (attachment.content as ArrayBuffer);
			attachments.push({
				disposition: (attachment.disposition === "inline" || !!attachment.related) && scrubbedCid ? ("inline" as const) : ("attachment" as const),
				...(scrubbedCid ? { contentId: scrubbedCid } : {}),
				filename: scrubbedFilename,
				type: cleaned.type,
				content: data,
			});
		}
		const rebuilt = buildMime(
			{
				from: fromName ? { name: fromName, email: fromEmail } : fromEmail,
				to: toEmail,
				...(replyTo ? { replyTo } : {}),
				subject: cleanSubjectLine(scrub(parsed.subject ?? "")) || "(no subject)",
				...(html ? { html } : {}),
				...(text ? { text } : html ? {} : { text: "" }),
				headers,
				attachments,
			},
			safeMessageId(parsed.messageId, ownSites, scrub) ?? `<${crypto.randomUUID()}@invalid>`,
			safeDate(parsed.date),
		);
		return new TextEncoder().encode(rebuilt).buffer as ArrayBuffer;
	} catch {
		return stubMessage("Unreadable attached message removed for privacy.");
	}
}
