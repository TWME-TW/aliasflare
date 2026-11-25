import { normalizeEmail, replaceAddresses, type Replacement } from "./format";

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
const unfold = (text: string) => text.replace(/\r?\n[ \t]/g, "");

/** The ORGANIZER addresses of a calendar attachment. */
export function calendarOrganizers(content: ArrayBuffer): string[] {
	const text = unfold(bytesToBinary(new Uint8Array(content)));
	const found = new Set<string>();
	for (const match of text.matchAll(/^ORGANIZER[^:\r\n]*:mailto:([^\s;]+@[^\s;]+)$/gim)) found.add(normalizeEmail(match[1]!));
	return [...found];
}

/**
 * The attachment with each address replaced. A calendar is unfolded first, which calendar
 * readers accept. In an attached message only text that is not base64 or quoted-printable
 * encoded is seen: its headers and plain parts.
 */
export function rewriteAttachment(content: ArrayBuffer, kind: "calendar" | "message", replacements: Replacement[]): ArrayBuffer {
	if (!replacements.length) return content;
	let text = bytesToBinary(new Uint8Array(content));
	if (kind === "calendar") text = unfold(text);
	const out = replaceAddresses(text, replacements, { encodedPlus: kind === "message" });
	return out === text && kind === "message" ? content : binaryToBytes(out);
}
