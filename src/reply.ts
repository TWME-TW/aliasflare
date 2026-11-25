import PostalMime, { type Email } from "postal-mime";
import type { AppConfig } from "./config";
import { bytesToBase64 } from "./crypto";
import { siteOf } from "./unsubscribe";
import { getAlias, getContactByReverseLocal, getContactsByReverseLocals, mapForwardedToOriginal, now, recordEvent } from "./db";
import {
	cleanSubjectLine,
	domainOf,
	extractEmail,
	findAddressesOnDomain,
	normalizeEmail,
	parseMessageIds,
	replaceAddresses,
	reverseAddress,
	reverseLocalOf,
	type Replacement,
	cleanAttachment,
} from "./format";
import { mailflareReady } from "./config";
import { aliasDomainOfReverse, isOwnAddress } from "./domains";
import { mailflareConfig, sendViaMailflare } from "./mailflare";
import { loadSettings } from "./settings";
import { MAX_MESSAGE_BYTES } from "./mailflare";
import { FREE_PLAN_REWRITE_BYTES, LOOP_HEADER } from "./forward";
import { readLimited } from "./streams";
import { attachmentSearchText, carriesAddresses, MAX_NESTED_EML_PARSES, rewriteAttachment, scrubAttachedMessage } from "./attachments";
import { listDestinations } from "./compat/aliases";
import { ruleForwardAddresses, runRules } from "./rules";
import { OUTBOUND_ATTACHMENT_LIMITS, sendOutbound, unsendableAttachments } from "./outbound";

/** Mailflare's limit per message. */
const MAX_ATTACHMENTS = 10;
const MAX_SENDING_ATTACHMENTS = 50;
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
 * True when the raw header block has exactly one From header holding a single address
 * (no list or group). Unlike singleSender, Sender headers are allowed to differ (e.g. lists).
 */
export function hasSingleFromHeader(rawHeaders: string): boolean {
	const unfolded = rawHeaders.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/);
	const fromHeaders = unfolded.filter((line) => /^from\s*:/i.test(line));
	if (fromHeaders.length !== 1) return false;
	const value = fromHeaders[0]!.replace(/^from\s*:/i, "").replace(/"(?:[^"\\]|\\.)*"/g, '""');
	return (value.match(/@/g) ?? []).length === 1 && !/[,;:]/.test(value.replace(/<[^<>]*>/g, ""));
}

/**
 * The one sender address of a message, or null unless it has exactly one From header
 * holding exactly one plain mailbox (no group, no quoted local part) and any Sender
 * header names the same address.
 */
export function singleSender(rawHeaders: string, parsedFrom: string | undefined): string | null {
	if (!hasSingleFromHeader(rawHeaders)) return null;
	if (!parsedFrom || /["<>()\s,;:\\]/.test(parsedFrom) || !/^[^@]+@[^@]+\.[^@]+$/.test(parsedFrom)) return null;
	const from = parsedFrom.toLowerCase();
	const unfolded = rawHeaders.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/);
	// Every Sender header, not just the first, has to name the same address.
	const senders = unfolded.filter((line) => /^sender\s*:/i.test(line));
	if (senders.length > 1) return null;
	if (senders.length === 1 && extractEmail(senders[0]!.replace(/^sender\s*:/i, "")) !== from) return null;
	return from;
}

/** Signed block, turn-off and unsubscribe links of this service, with any host in front. */
const SIGNED_PATH =
	/\/(?:action|unsubscribe)\/(?:(?:block|disable)(?:~|%7e|&#0*126;|&#x0*7e;|&tilde;))?fw(?:_|%5f)[0-9a-f]{32}(?:\.|%2e)\d+(?:\.|%2e)[A-Za-z0-9_-]+/gi;
const URL_CHAR = /[^\s"'<>]/;

/**
 * Replaces each URL that ends in a signed path. The path is found first and the URL's start
 * walked back to: a pattern starting at "https://" with an open-ended host retried at every
 * "http" of a large body and took seconds. The walk stops at the previous match.
 */
function stripSignedUrls(body: string): string {
	let out = "";
	let done = 0;
	let scanned = 0;
	for (const match of body.matchAll(SIGNED_PATH)) {
		const floor = Math.max(done, scanned);
		let start = match.index;
		while (start > floor && URL_CHAR.test(body[start - 1]!)) start -= 1;
		scanned = match.index + match[0].length;
		const scheme = body.slice(start, match.index).search(/https?:\/\/[^\s"'<>]/i);
		if (scheme < 0) continue;
		out += `${body.slice(done, start + scheme)}[link removed]`;
		done = scanned;
	}
	return out + body.slice(done);
}
/**
 * The token of such a link on its own, wherever it appears: with "~" written as %7E or an HTML
 * entity, or inside a link a mail filter wrapped (Safe Links and the like), the URL above does
 * not match, but the token still works, so it is removed too.
 */
const SIGNED_TOKEN =
	/(?:(?:block|disable)(?:~|%7e|&#0*126;|&#x0*7e;|&tilde;))?fw(?:_|%5f)[0-9a-f]{32}(?:\.|%2e)\d+(?:\.|%2e)[A-Za-z0-9_-]+/gi;

export function stripSignedLinks(body: string): string {
	return stripSignedUrls(body).replace(SIGNED_TOKEN, "[link removed]");
}

/** The ways a "+" or "@" is written in mail bodies: in mailto: links (%2B/%40) and as HTML entities. */
const ENCODED_PLUS_PATTERN = /%2b|&#0*43;|&#x0*2b;|&plus;/gi;
const ENCODED_AT_PATTERN = /%40|&#0*64;|&#x0*40;|&commat;/gi;

/**
 * Message-IDs to send on in In-Reply-To and References. A forwarded copy's ID becomes the
 * original's. An ID that maps to nothing and was made by the owner's own mail provider (the
 * owner's earlier replies) is dropped: it would show the correspondent where the owner's
 * real mailbox is.
 */
function threadIds(ids: string[], toOriginal: Map<string, string>, owners: string[]): string[] {
	const ownSites = new Set(owners.map((owner) => siteOf(domainOf(owner))).filter(Boolean));
	return ids.flatMap((id) => {
		const original = toOriginal.get(id);
		if (original) {
			const safe = parseMessageIds(original)[0];
			return safe ? [safe] : [];
		}
		const domain = id.slice(1, -1).split("@").pop() ?? "";
		return domain.includes(".") && ownSites.has(siteOf(domain)) ? [] : [id];
	});
}

/** Drops the forwarding banner from quoted HTML (where the mail client kept its attribute). */
async function removeBanner(html: string): Promise<string> {
	if (typeof HTMLRewriter === "undefined" || !html.includes("data-aliasflare-banner")) return html;
	return new HTMLRewriter()
		.on("[data-aliasflare-banner]", {
			element(element) {
				element.remove();
			},
		})
		.transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }))
		.text();
}

/**
 * The header block. Headers end at the first blank line; 64 KiB is far more than any real
 * header block, so one that does not end by then is refused (null) rather than read in part:
 * a second From or Sender past the cut would be seen by the parser but not by the checks.
 */
function headerSection(raw: Uint8Array): string | null {
	const head = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(raw.subarray(0, 65536));
	const end = head.search(/\r?\n\r?\n/);
	return end >= 0 ? head.slice(0, end) : null;
}

/**
 * Why a message to a reverse alias is not sent on: one this Worker sent itself (a real loop, always
 * dropped), or an automatic reply (out of office, a delivery report) unless the owner lets those go
 * out. Null when it is sent.
 */
function automaticReason(headers: { key: string; value: string }[] | undefined, sendAutoReplies: boolean): string | null {
	if (!headers?.length) return null;
	if (headers.some(({ key }) => key.toLowerCase() === LOOP_HEADER.toLowerCase())) return "Not sent: a message aliasflare sent itself";
	return !sendAutoReplies && isAutoReply(headers) ? "Not sent: automatic reply" : null;
}

/** True for automatic replies (out of office, delivery reports), per RFC 3834 and common headers. */
function isAutoReply(headers: { key: string; value: string }[]): boolean {
	return headers.some(({ key, value }) => {
		const name = key.toLowerCase();
		const trimmed = value.trim().toLowerCase();
		if (name === "auto-submitted") return !!trimmed && trimmed !== "no";
		if (name === "precedence") return /^auto[-_]?reply$/i.test(trimmed);
		if (name === "x-autoreply") return /^(yes|true|1)$/i.test(trimmed);
		return false;
	});
}

/**
 * Handles mail to a reverse alias: the user's reply (or new message) to a correspondent.
 * It must come from the alias's destination address with a DMARC pass, and is sent
 * as the alias (through Mailflare or Email Sending) so the correspondent never sees the real address.
 */
export async function handleReverseAliasMail(message: ForwardableEmailMessage, env: Env, config: AppConfig): Promise<void> {
	const db = env.DB;
	const recipient = normalizeEmail(message.to);
	const reverseDomain = domainOf(recipient);
	const aliasDomain = aliasDomainOfReverse(reverseDomain);
	if (!aliasDomain) {
		message.setReject("This address does not exist");
		return;
	}
	const reverseLocal = reverseLocalOf(recipient);
	const contact = reverseLocal ? await getContactByReverseLocal(db, reverseLocal) : null;
	// A reverse alias only works on its own alias's domain, so one domain's reverse alias
	// cannot be used through another domain (and nothing ties the two domains together).
	if (!contact || domainOf(contact.alias_address) !== aliasDomain) {
		message.setReject("This address does not exist");
		return;
	}
	const alias = await getAlias(db, contact.alias_address);
	if (!alias || alias.deleted_at) {
		message.setReject("This address does not exist");
		return;
	}
	const settings = await loadSettings(db);
	// The owner writes from the alias's address, or from the one this sender's mail goes to.
	// A rule may forward the alias's mail to another of the owner's known mailboxes, so those count too.
	const knownDestinations = new Set((await listDestinations(db, settings)).map((d) => normalizeEmail(d.email)));
	const ruleOwners = (await ruleForwardAddresses(db)).filter((address) => knownDestinations.has(normalizeEmail(address)));
	const owners = [...new Set([alias.destination || settings.defaultDestination, contact.destination, ...ruleOwners].filter((value): value is string => !!value))];

	// A reply always has to be rewritten (it goes out as the alias), so on the Free plan, with
	// 10 ms of CPU, a large one is refused with a clear reason rather than cut off midway.
	const sizeLimit = config.workersPlan === "free" ? FREE_PLAN_REWRITE_BYTES : MAX_MESSAGE_BYTES;
	let raw = message.rawSize > sizeLimit ? null : await readLimited(message.raw, sizeLimit);
	if (!raw) {
		await message.raw.cancel().catch(() => undefined);
		const why = config.workersPlan === "free" ? `at most ${sizeLimit / 1024} KB on the Workers Free plan` : `at most ${sizeLimit} bytes`;
		await recordEvent(db, { kind: "reply", contactId: contact.id, aliasAddress: contact.alias_address, status: "rejected", detail: `Too large: ${why}` });
		message.setReject(`Message too large: ${why}`);
		return;
	}
	const headers = headerSection(raw);
	const authResults = headers === null ? null : firstAuthenticationResults(headers);
	// The sender is checked before the message is parsed, from its header block alone: a large
	// message from anyone else costs no parsing.
	const headerOnly = headers === null ? null : await PostalMime.parse(`${headers}\r\n\r\n`).catch(() => null);
	const headerFrom = headers === null ? null : singleSender(headers, headerOnly?.from?.address);

	// Only the alias owner may write through a reverse alias, or anyone could send as the alias.
	const destination = owners.find((owner) => normalizeEmail(owner) === headerFrom) ?? owners[0] ?? "";
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
	// Drop automatic replies silently (no bounce, per RFC 3834) to prevent vacation/auto-responder loops.
	const incomingAutoReply = isAutoReply(headerOnly?.headers ?? []);
	const automatic = automaticReason(headerOnly?.headers, settings.sendAutoReplies);
	if (automatic) {
		await recordEvent(db, { kind: "reply", contactId: contact.id, aliasAddress: contact.alias_address, status: "rejected", detail: automatic });
		return;
	}
	// Even when sendAutoReplies is on, never auto-reply back to an own alias or owner mailbox (loop).
	if (
		incomingAutoReply &&
		(isOwnAddress(contact.email, [...settings.aliasDomains, aliasDomain]) ||
			knownDestinations.has(normalizeEmail(contact.email)) ||
			owners.some((owner) => normalizeEmail(owner) === normalizeEmail(contact.email)))
	) {
		await recordEvent(db, { kind: "reply", contactId: contact.id, aliasAddress: contact.alias_address, status: "rejected", detail: "Not sent: automatic reply loop" });
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
	// Rules for replies: the sender they test is the correspondent, the one the reply goes to.
	const rules = await runRules(db, "replies", { sender: contact.email, subject: headerOnly?.subject ?? "", alias: contact.alias_address });
	if (rules.block) {
		await recordEvent(db, { kind: "reply", contactId: contact.id, aliasAddress: contact.alias_address, status: "rejected", detail: `Not sent: the rule ${rules.block}` });
		message.setReject(`Not sent: blocked by the rule ${rules.block}`);
		return;
	}

	let email: Email;
	try {
		email = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });
	} catch (error) {
		const detail = `Unreadable message: ${error instanceof Error ? error.message : String(error)}`;
		await recordEvent(db, { kind: "reply", contactId: contact.id, aliasAddress: contact.alias_address, status: "rejected", detail });
		message.setReject("This message could not be read");
		return;
	} finally {
		// Drop the raw buffer before transforms and MIME serialization so GC can reclaim it.
		raw = null;
	}
	if (rules.removeAttachments) email.attachments = [];
	// An alias Mailflare receives also sends through Mailflare, so the reply is kept in its
	// mailbox there. Every other alias sends with the provider chosen on the Connection page.
	const viaMailflare = !!alias.mailbox_id && mailflareReady(config);
	const limit = viaMailflare ? MAX_ATTACHMENTS : Math.min(MAX_SENDING_ATTACHMENTS, OUTBOUND_ATTACHMENT_LIMITS[config.outboundProvider]);
	if (email.attachments.length > limit) {
		await recordEvent(db, { kind: "reply", contactId: contact.id, aliasAddress: contact.alias_address, status: "rejected", detail: `${email.attachments.length} attachments; at most ${limit}` });
		message.setReject(`Too many attachments: at most ${limit} per message`);
		return;
	}
	// A quoted forward carries the banner with its block / turn-off links; they are the
	// owner's, so neither the banner nor any signed link may reach the correspondent.
	let html = email.html ? await removeBanner(stripSignedLinks(email.html)) : undefined;
	let text = email.text ? stripSignedLinks(email.text) : undefined;
	const replacements: Replacement[] = [];
	// Calendar answers and attached messages name addresses too; they are rewritten like the body.
	const addressParts = email.attachments.map((attachment, index) => {
		const { filename, type } = cleanAttachment(attachment, index);
		return carriesAddresses(type, filename);
	});
	if (settings.reverseAliasReplacement) {
		const searchBudget = { remaining: MAX_NESTED_EML_PARSES };
		const partTexts: string[] = [];
		for (const [index, attachment] of email.attachments.entries()) {
			partTexts.push(addressParts[index] ? await attachmentSearchText(attachment.content as ArrayBuffer, addressParts[index]!, 0, searchBudget) : "");
		}
		const body = [html ?? "", text ?? "", ...partTexts].join("\n");
		// mailto: links and HTML bodies may encode "+" as %2B and "@" as %40 / &#64;.
		const normalizedBody = body.replace(ENCODED_PLUS_PATTERN, "+").replace(ENCODED_AT_PATTERN, "@");
		const reverseLocals = findAddressesOnDomain(normalizedBody, reverseDomain)
			.map(reverseLocalOf)
			.filter((local): local is string => !!local);
		// Only this alias's own correspondents: a reverse alias of another alias stays as it is.
		const contacts = await getContactsByReverseLocals(db, contact.alias_address, reverseLocals);
		for (const found of contacts) {
			replacements.push(
				{ from: reverseAddress(found.reverse_local, reverseDomain), to: found.email },
				{ from: `${found.reverse_local}@${reverseDomain}`, to: found.email },
			);
		}
	}
	// Always scrub the owner's own address from quoted replies, even when reverse-alias replacement is off.
	for (const owner of owners) replacements.push({ from: owner, to: contact.alias_address });
	if (replacements.length) {
		if (html) html = replaceAddresses(html, replacements, { encodedPlus: true });
		if (text) text = replaceAddresses(text, replacements, { encodedPlus: true });
	}

	const rawInReplyTo = parseMessageIds(email.inReplyTo);
	const rawReferences = parseMessageIds(email.references);
	// Map recent references before dropping own-site IDs so surviving earlier IDs are never left unmapped.
	const parentIds = [...rawInReplyTo, ...rawReferences.slice(-80)];
	const toOriginal = await mapForwardedToOriginal(db, contact.alias_address, parentIds);
	const inReplyTo = threadIds(rawInReplyTo, toOriginal, owners)[0];
	const references = threadIds(rawReferences, toOriginal, owners).slice(-MAX_REFERENCES);

	const ownSites = new Set(owners.map((owner) => siteOf(domainOf(owner))).filter(Boolean));
	const scrubBudget = { remaining: MAX_NESTED_EML_PARSES };
	const files = [];
	for (const [index, attachment] of email.attachments.entries()) {
		files.push({
			...cleanAttachment(attachment, index),
			inline: attachment.disposition === "inline" || !!attachment.related,
			content:
				addressParts[index] === "message"
					? await scrubAttachedMessage(attachment.content as ArrayBuffer, replacements, stripSignedLinks, { ownSites, removeBanner, budget: scrubBudget })
					: addressParts[index] === "calendar"
						? rewriteAttachment(attachment.content as ArrayBuffer, "calendar", replacements, { stripLinks: stripSignedLinks })
						: (attachment.content as ArrayBuffer),
		});
	}
	const refused = viaMailflare ? null : unsendableAttachments(config.outboundProvider, files.map((file) => file.filename));
	if (refused) {
		await recordEvent(db, { kind: "reply", contactId: contact.id, aliasAddress: contact.alias_address, status: "rejected", detail: refused });
		message.setReject(refused);
		return;
	}
	const subject = cleanSubjectLine(rules.subject ?? email.subject) || "(no subject)";
	const name = alias.name?.replace(/[\u0000-\u001f\u007f"\\<>]/g, "").trim() || "";

	try {
		if (viaMailflare) {
			await sendViaMailflare(mailflareConfig(config), {
				mailboxId: alias.mailbox_id,
				from: name ? `"${name}" <${contact.alias_address}>` : contact.alias_address,
				to: [contact.email],
				subject,
				...(html ? { html } : {}),
				// A reply that was only the quoted banner is left with no body: send an empty text one.
				...(text ? { text } : html ? {} : { text: "" }),
				...(inReplyTo ? { inReplyTo } : {}),
				...(references.length ? { references } : {}),
				...(files.length
					? { attachments: files.map((file) => ({ filename: file.filename, type: file.type, contentBase64: bytesToBase64(new Uint8Array(file.content)) })) }
					: {}),
			});
		} else {
			const headers: Record<string, string> = {};
			if (inReplyTo) headers["In-Reply-To"] = inReplyTo;
			if (references.length) headers.References = references.join(" ");
			if (incomingAutoReply) headers["Auto-Submitted"] = "auto-replied";
			await sendOutbound(env, config, {
				from: name ? { name, email: contact.alias_address } : contact.alias_address,
				to: contact.email,
				subject,
				headers,
				...(html ? { html } : {}),
				text: text ?? (html ? undefined : ""),
				attachments: files.map((file) => ({
					disposition: file.inline && file.contentId ? ("inline" as const) : ("attachment" as const),
					...(file.contentId ? { contentId: file.contentId } : {}),
					filename: file.filename,
					type: file.type,
					content: file.content,
				})),
			});
		}
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.error("Reply failed", contact.id, detail);
		await recordEvent(db, { kind: "reply", contactId: contact.id, aliasAddress: contact.alias_address, status: "failed", detail });
		// Rejecting bounces the message back to the user, who learns it was not delivered.
		message.setReject("This message could not be sent. Check the aliasflare activity log.");
		return;
	}

	// The reply is out. A failure to record it must not throw: Email Routing would retry the
	// delivery and the correspondent would get the reply twice.
	try {
		const repliedAt = now();
		await db.batch([
			db.prepare("UPDATE contacts SET reply_count = reply_count + 1, last_reply_at = ? WHERE id = ?").bind(repliedAt, contact.id),
			db.prepare("UPDATE aliases SET last_used_at = ? WHERE address = ?").bind(repliedAt, contact.alias_address),
		]);
		await recordEvent(db, { kind: "reply", contactId: contact.id, aliasAddress: contact.alias_address, status: "sent" });
	} catch (error) {
		console.error("Reply sent, but recording it failed", contact.id, error instanceof Error ? error.message : error);
	}
}
