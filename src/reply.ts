import PostalMime from "postal-mime";
import type { AppConfig } from "./config";
import { bytesToBase64 } from "./crypto";
import { getAlias, getContactByReverseLocal, getContactsByReverseLocals, mapForwardedToOriginal, now, recordEvent } from "./db";
import {
	domainOf,
	extractEmail,
	findAddressesOnDomain,
	normalizeEmail,
	parseMessageIds,
	replaceAddresses,
	reverseAddress,
	reverseLocalOf,
	type Replacement,
} from "./format";
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
 * Splits an Authentication-Results value (RFC 8601) into its clauses at top-level
 * semicolons. Comments are dropped and quoted strings kept whole, so a semicolon or a
 * "dmarc=pass" inside a quoted address or a comment cannot start a clause of its own.
 */
export function authResultClauses(value: string): string[] {
	const clauses: string[] = [];
	let current = "";
	let depth = 0;
	let quoted = false;
	for (let i = 0; i < value.length; i++) {
		const ch = value[i]!;
		if (quoted) {
			current += ch;
			if (ch === "\\") current += value[++i] ?? "";
			else if (ch === '"') quoted = false;
		} else if (depth > 0) {
			if (ch === "\\") i++;
			else if (ch === "(") depth++;
			else if (ch === ")") depth--;
		} else if (ch === '"') {
			quoted = true;
			current += ch;
		} else if (ch === "(") {
			depth = 1;
			current += " ";
		} else if (ch === ";") {
			clauses.push(current.trim());
			current = "";
		} else current += ch;
	}
	clauses.push(current.trim());
	return clauses;
}

/**
 * True when Cloudflare's own Authentication-Results has exactly one DMARC result, it is
 * a pass, and (when a domain is expected) it names that domain as the From domain.
 */
export function dmarcPassedByCloudflare(value: string | null, fromDomain?: string): boolean {
	if (!value) return false;
	const [authserv, ...results] = authResultClauses(value);
	if (authserv?.split(/\s+/)[0]?.toLowerCase() !== "mx.cloudflare.net") return false;
	const dmarc = results.filter((result) => /^dmarc\s*=/i.test(result));
	if (dmarc.length !== 1 || !/^dmarc\s*=\s*pass\b/i.test(dmarc[0]!)) return false;
	if (!fromDomain) return true;
	const evaluated = dmarc[0]!.match(/(?:^|\s)header\.from\s*=\s*([A-Za-z0-9.-]+)(?=\s|$)/i)?.[1]?.toLowerCase();
	return evaluated === fromDomain.toLowerCase();
}

/**
 * The one sender address of a message, or null unless it has exactly one From header
 * holding exactly one plain mailbox (no group, no quoted local part) and any Sender
 * header names the same address.
 */
export function singleSender(rawHeaders: string, parsedFrom: string | undefined): string | null {
	const unfolded = rawHeaders.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/);
	const fromHeaders = unfolded.filter((line) => /^from\s*:/i.test(line));
	if (fromHeaders.length !== 1) return null;
	if (!parsedFrom || /["<>()\s,;:\\]/.test(parsedFrom) || !/^[^@]+@[^@]+\.[^@]+$/.test(parsedFrom)) return null;
	const from = parsedFrom.toLowerCase();
	// More than one address (a list or a group) shows up as more than one "@" outside quotes.
	const value = fromHeaders[0]!.replace(/^from\s*:/i, "").replace(/"(?:[^"\\]|\\.)*"/g, '""');
	if ((value.match(/@/g) ?? []).length !== 1 || /[,;:]/.test(value.replace(/<[^<>]*>/g, ""))) return null;
	const sender = unfolded.find((line) => /^sender\s*:/i.test(line));
	if (sender && extractEmail(sender.replace(/^sender\s*:/i, "")) !== from) return null;
	return from;
}

/** Signed block, turn-off and unsubscribe links of this service, with any host in front. */
const SIGNED_LINK = /https?:\/\/[^\s"'<>]+\/(?:action|unsubscribe)\/(?:(?:block|disable)~)?fw_[0-9a-f]{32}\.\d+\.[A-Za-z0-9_-]+/gi;

export function stripSignedLinks(body: string): string {
	return body.replace(SIGNED_LINK, "[link removed]");
}

/** Drops the forwarding banner from quoted HTML (where the mail client kept its attribute). */
async function removeBanner(html: string): Promise<string> {
	if (typeof HTMLRewriter === "undefined" || !html.includes("data-mailflare-alias-banner")) return html;
	return new HTMLRewriter()
		.on("[data-mailflare-alias-banner]", {
			element(element) {
				element.remove();
			},
		})
		.transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }))
		.text();
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
	const reverseLocal = reverseLocalOf(recipient);
	const contact = reverseLocal ? await getContactByReverseLocal(db, reverseLocal) : null;
	if (!contact) {
		message.setReject("This address does not exist");
		return;
	}
	const alias = await getAlias(db, contact.alias_address);
	if (!alias || alias.deleted_at) {
		message.setReject("This address does not exist");
		return;
	}
	const settings = await loadSettings(db);
	const destination = alias.destination || settings.defaultDestination;

	const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
	const headers = headerSection(raw);
	const authResults = firstAuthenticationResults(headers);
	const email = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });
	const headerFrom = singleSender(headers, email.from?.address);

	// Only the alias owner may write through a reverse alias, or anyone could send as the alias.
	const dmarcPass = !!destination && dmarcPassedByCloudflare(authResults, domainOf(destination));
	if (!destination || headerFrom !== normalizeEmail(destination) || !dmarcPass) {
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
	// The owner turned this alias or this correspondent off: an auto-reply or a stray reply
	// should not go out anyway.
	if (alias.forward_mode === "none" || contact.blocked) {
		const why = contact.blocked ? "the correspondent is blocked" : "the alias is turned off";
		await recordEvent(db, { kind: "reply", contactId: contact.id, aliasAddress: contact.alias_address, status: "rejected", detail: `Not sent: ${why}` });
		message.setReject(`Not sent: ${why}`);
		return;
	}

	// A quoted forward carries the banner with its block / turn-off links; they are the
	// owner's, so neither the banner nor any signed link may reach the correspondent.
	let html = email.html ? await removeBanner(stripSignedLinks(email.html)) : undefined;
	let text = email.text ? stripSignedLinks(email.text) : undefined;
	if (settings.reverseAliasReplacement) {
		const body = `${html ?? ""}\n${text ?? ""}`;
		const reverseLocals = findAddressesOnDomain(body, reverseDomain)
			.map(reverseLocalOf)
			.filter((local): local is string => !!local);
		// Only this alias's own correspondents: a reverse alias of another alias stays as it is.
		const contacts = await getContactsByReverseLocals(db, contact.alias_address, reverseLocals);
		const replacements: Replacement[] = contacts.flatMap((found) => [
			{ from: reverseAddress(found.reverse_local, reverseDomain), to: found.email },
			{ from: `${found.reverse_local}@${reverseDomain}`, to: found.email },
		]);
		replacements.push({ from: destination, to: contact.alias_address });
		if (html) html = replaceAddresses(html, replacements);
		if (text) text = replaceAddresses(text, replacements);
	}

	const parentIds = [...parseMessageIds(email.inReplyTo), ...parseMessageIds(email.references).slice(-MAX_REFERENCES)];
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
			from: alias.name ? `"${alias.name.replace(/["\\\r\n<>]/g, "")}" <${contact.alias_address}>` : contact.alias_address,
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
