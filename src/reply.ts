import PostalMime from "postal-mime";
import type { AppConfig } from "./config";
import { bytesToBase64 } from "./crypto";
import { getAlias, getContactByReverseLocal, getContactsByReverseLocals, mapForwardedToOriginal, now, recordEvent } from "./db";
import { domainOf, extractEmail, findAddressesOnDomain, normalizeEmail, parseMessageIds, replaceAddresses, type Replacement } from "./format";
import { mailflareConfig, sendViaMailflare } from "./mailflare";
import { loadSettings } from "./settings";

const MAX_ATTACHMENTS = 10;
const MAX_REFERENCES = 10;

/**
 * Reads the first Authentication-Results header of a raw message. Cloudflare Email
 * Routing prepends its own, so the first one is the only one that can be trusted.
 */
export function firstAuthenticationResults(rawHeaders: string): string | null {
	const unfolded = rawHeaders.replace(/\r?\n[ \t]+/g, " ");
	for (const line of unfolded.split(/\r?\n/)) {
		const match = line.match(/^authentication-results:\s*(.*)$/i);
		if (match) return match[1] ?? "";
	}
	return null;
}

/**
 * True when Cloudflare's own Authentication-Results says DMARC passed and, when it names
 * the From domain it evaluated, that domain is the expected one.
 */
export function dmarcPassedByCloudflare(value: string | null, fromDomain?: string): boolean {
	if (!value) return false;
	const [authserv, ...results] = value.split(";");
	if (authserv?.trim().split(/\s+/)[0]?.toLowerCase() !== "mx.cloudflare.net") return false;
	const dmarc = results.find((result) => /^\s*dmarc\s*=\s*pass\b/i.test(result));
	if (!dmarc) return false;
	const evaluated = dmarc.match(/header\.from\s*=\s*([^\s;]+)/i)?.[1]?.toLowerCase();
	return !fromDomain || !evaluated || evaluated === fromDomain.toLowerCase();
}

function headerSection(raw: Uint8Array): string {
	// Headers end at the first blank line; 64 KiB is far more than any real header block.
	const head = new TextDecoder().decode(raw.subarray(0, 65536));
	const end = head.search(/\r?\n\r?\n/);
	return end >= 0 ? head.slice(0, end) : head;
}

/**
 * Handles mail to a reverse alias: the user's reply (or new message) to a correspondent.
 * It must come from the alias's destination address with a DMARC pass, and is sent
 * through Mailflare as the alias so the correspondent never sees the real address.
 */
export async function handleReverseAliasMail(message: ForwardableEmailMessage, env: Env, config: AppConfig): Promise<void> {
	const db = env.DB;
	const reverseDomain = config.reverseDomain;
	const recipient = normalizeEmail(message.to);
	if (domainOf(recipient) !== reverseDomain) {
		message.setReject("This address does not exist");
		return;
	}
	const contact = await getContactByReverseLocal(db, recipient.slice(0, recipient.lastIndexOf("@")));
	if (!contact) {
		message.setReject("This address does not exist");
		return;
	}
	const alias = await getAlias(db, contact.alias_address);
	const settings = await loadSettings(db);
	const destination = alias?.destination || settings.defaultDestination;

	const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
	const authResults = firstAuthenticationResults(headerSection(raw));
	const email = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });
	const headerFrom = extractEmail(email.from?.address ?? null);

	// Only the alias owner may write through a reverse alias, or anyone could send as the alias.
	const dmarcPass = dmarcPassedByCloudflare(authResults, destination ? domainOf(destination) : undefined);
	if (!alias || !destination || headerFrom !== normalizeEmail(destination) || !dmarcPass) {
		await recordEvent(db, {
			kind: "reply",
			contactId: contact.id,
			aliasAddress: contact.alias_address,
			status: "rejected",
			detail: `Not accepted from ${headerFrom ?? "unknown sender"} (DMARC: ${dmarcPass ? "pass" : "not pass"})`,
		});
		message.setReject("Only the owner of this alias can send through this address");
		return;
	}

	let html = email.html ?? undefined;
	let text = email.text ?? undefined;
	if (settings.reverseAliasReplacement) {
		const body = `${html ?? ""}\n${text ?? ""}`;
		const reverseLocals = findAddressesOnDomain(body, reverseDomain).map((address) => address.slice(0, address.lastIndexOf("@")));
		const contacts = await getContactsByReverseLocals(db, reverseLocals);
		const replacements: Replacement[] = contacts.map((found) => ({ from: `${found.reverse_local}@${reverseDomain}`, to: found.email }));
		replacements.push({ from: destination, to: contact.alias_address });
		if (html) html = replaceAddresses(html, replacements);
		if (text) text = replaceAddresses(text, replacements);
	}

	const parentIds = [...parseMessageIds(email.inReplyTo), ...parseMessageIds(email.references)];
	const toOriginal = await mapForwardedToOriginal(db, parentIds);
	const inReplyTo = parseMessageIds(email.inReplyTo).map((id) => toOriginal.get(id) ?? id)[0];
	const references = parseMessageIds(email.references)
		.map((id) => toOriginal.get(id) ?? id)
		.slice(-MAX_REFERENCES);

	if (email.attachments.length > MAX_ATTACHMENTS) {
		await recordEvent(db, { kind: "reply", contactId: contact.id, aliasAddress: contact.alias_address, status: "rejected", detail: `${email.attachments.length} attachments; Mailflare accepts ${MAX_ATTACHMENTS}` });
		message.setReject(`Too many attachments: Mailflare sends at most ${MAX_ATTACHMENTS} per message`);
		return;
	}
	const attachments = email.attachments.map((attachment, index) => ({
		filename: attachment.filename || `attachment-${index + 1}`,
		type: attachment.mimeType || "application/octet-stream",
		contentBase64: bytesToBase64(new Uint8Array(attachment.content as ArrayBuffer)),
	}));

	try {
		await sendViaMailflare(mailflareConfig(config), {
			mailboxId: alias.mailbox_id,
			from: contact.alias_address,
			to: [contact.email],
			subject: email.subject?.trim() || "(no subject)",
			...(html ? { html } : {}),
			...(text ? { text } : {}),
			...(inReplyTo ? { inReplyTo } : {}),
			...(references.length ? { references } : {}),
			...(attachments.length ? { attachments } : {}),
		});
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.error("Reply failed", contact.id, detail);
		await recordEvent(db, { kind: "reply", contactId: contact.id, aliasAddress: contact.alias_address, status: "failed", detail });
		// Rejecting bounces the message back to the user, who learns it was not delivered.
		message.setReject("Mailflare could not send this message. Check the mailflare-alias activity log.");
		return;
	}

	await db.prepare("UPDATE contacts SET reply_count = reply_count + 1, last_reply_at = ? WHERE id = ?").bind(now(), contact.id).run();
	await recordEvent(db, { kind: "reply", contactId: contact.id, aliasAddress: contact.alias_address, status: "sent" });
}
