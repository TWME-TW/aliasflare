import type { AppConfig } from "./config";
import { verifyToken } from "./crypto";
import { getAlias, now, recordEvent, setForwardMode, type ForwardRow } from "./db";
import { domainOf, extractEmail } from "./format";
import type { Translate } from "./i18n";
import { mailflareConfig, sendViaMailflare } from "./mailflare";
import { loadSettings, type UnsubscribeBehavior } from "./settings";

const TIMEOUT_MS = 10_000;

/** How long the links in a forwarded message work. Each link also works only once. */
export const LINK_TTL_SECONDS = 60 * 60 * 24 * 90;

/** What a signed link does: the List-Unsubscribe link follows the setting; banner links are fixed. */
export type LinkAction = UnsubscribeBehavior;

/** How the sender's own unsubscribe is carried out, decided before the user confirms. */
export type UnsubscribePlan = { kind: "post" | "get"; url: string } | { kind: "mail"; to: string; subject: string } | null;

export type LinkTarget = {
	forward: ForwardRow;
	contactEmail: string | null;
	action: LinkAction;
	kind: "unsubscribe" | "action";
	plan: UnsubscribePlan;
	token: string;
};

async function loadForward(db: D1Database, forwardId: string): Promise<{ forward: ForwardRow; contactEmail: string | null } | null> {
	const forward = await db.prepare("SELECT * FROM forwards WHERE id = ?").bind(forwardId).first<ForwardRow>();
	if (!forward) return null;
	const contact = forward.contact_id
		? await db.prepare("SELECT email FROM contacts WHERE id = ?").bind(forward.contact_id).first<{ email: string }>()
		: null;
	return { forward, contactEmail: contact?.email ?? null };
}

/** Resolves a List-Unsubscribe link (/unsubscribe/…) or a banner link (/action/…). */
export async function resolveLink(
	env: Env,
	config: AppConfig,
	kind: "unsubscribe" | "action",
	token: string,
	blockedHosts: string[] = [],
): Promise<LinkTarget | null> {
	const payload = await verifyToken(config.signingSecret, kind, token);
	if (!payload) return null;
	const settings = await loadSettings(env.DB);
	let action: LinkAction;
	let forwardId: string;
	if (kind === "unsubscribe") {
		forwardId = payload;
		action = settings.unsubscribeBehavior;
	} else {
		const [verb, id] = payload.split("~");
		if (!id || (verb !== "block" && verb !== "disable")) return null;
		forwardId = id;
		action = verb === "block" ? "block_contact" : "disable_alias";
	}
	const loaded = await loadForward(env.DB, forwardId);
	if (!loaded) return null;
	const plan =
		action === "preserve_original"
			? unsubscribePlan(loaded.forward, loaded.contactEmail, {
					blockedHosts: [...blockedHosts, ...[config.mailflareUrl, config.publicUrl].filter(Boolean).map((url) => new URL(url).hostname)],
					// An alias domain also covers its reverse-alias domain r.<domain>.
					ownDomains: [...settings.aliasDomains, loaded.forward.alias_address.split("@").pop() ?? ""].filter(Boolean),
				})
			: null;
	return { ...loaded, action, kind, plan, token };
}

export function describeAction(target: LinkTarget, t: Translate): string {
	const { forward, contactEmail, action, plan } = target;
	const sender = contactEmail ?? t("action.thisSender");
	if (action === "disable_alias") return t("action.disable", { alias: forward.alias_address });
	if (action === "preserve_original" && plan?.kind === "mail") return t("action.preserveMail", { sender, alias: forward.alias_address, target: plan.to });
	if (action === "preserve_original" && plan) return t("action.preserve", { sender });
	return t("action.block", { sender, alias: forward.alias_address });
}

function parseUris(value: string): string[] {
	return (value.match(/<[^<>]+>/g) ?? []).map((uri) => uri.slice(1, -1).trim());
}

const PRIVATE_SUFFIXES = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|arpa|test|invalid|example)$/;

/**
 * The URL when it is a public https address this Worker may call: no IP literals, no
 * internal or single-label names, no other port, no credentials, and none of this
 * service's own hosts.
 */
export function safeHttpsUrl(value: string, blockedHosts: string[] = []): URL | null {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || url.username || url.password || url.port !== "") return null;
	const host = url.hostname.toLowerCase().replace(/\.$/, "");
	// The URL parser has already turned 0x7f.1 and similar into dotted IPv4.
	if (host.startsWith("[") || /^[\d.]+$/.test(host)) return null;
	if (!host.includes(".") || PRIVATE_SUFFIXES.test(host)) return null;
	if (blockedHosts.some((blocked) => blocked && (host === blocked.toLowerCase() || host.endsWith(`.${blocked.toLowerCase()}`)))) return null;
	return url;
}

/** The registrable part of a domain, roughly: example.com, or example.co.uk. */
export function siteOf(domain: string): string {
	const labels = domain.toLowerCase().replace(/\.$/, "").split(".");
	const last = labels.at(-1) ?? "";
	const second = labels.at(-2) ?? "";
	const keep = last.length === 2 && second.length <= 3 && labels.length > 2 ? 3 : 2;
	return labels.slice(-keep).join(".");
}

function cleanSubject(value: string | null): string {
	const cleaned = (value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200);
	return cleaned || "unsubscribe";
}

/**
 * Picks how to run the sender's own unsubscribe. A one-click POST to a public https URL
 * comes first; an email only goes to an address on the sender's own site, never to this
 * service's domains, with a fixed body; a plain https visit comes last.
 */
export function unsubscribePlan(
	forward: ForwardRow,
	contactEmail: string | null,
	limits: { blockedHosts: string[]; ownDomains: string[] },
): UnsubscribePlan {
	const uris = parseUris(forward.original_unsubscribe ?? "");
	const https = uris.map((uri) => (uri.toLowerCase().startsWith("https:") ? safeHttpsUrl(uri, limits.blockedHosts) : null)).find(Boolean);
	if (https && forward.original_unsubscribe_post) return { kind: "post", url: https.href };
	const mailto = uris.find((uri) => uri.toLowerCase().startsWith("mailto:"));
	if (mailto && contactEmail) {
		try {
			const url = new URL(mailto);
			const to = extractEmail(decodeURIComponent(url.pathname));
			const owned = (domain: string) => limits.ownDomains.some((own) => domain === own || domain.endsWith(`.${own}`));
			if (to && siteOf(domainOf(to)) === siteOf(domainOf(contactEmail)) && !owned(domainOf(to))) {
				return { kind: "mail", to, subject: cleanSubject(url.searchParams.get("subject")) };
			}
		} catch {
			// An unreadable mailto is skipped like a missing one.
		}
	}
	if (https) return { kind: "get", url: https.href };
	return null;
}

/** Runs the sender's List-Unsubscribe from this Worker, so the user's IP and address stay hidden. */
async function runOriginalUnsubscribe(env: Env, config: AppConfig, forward: ForwardRow, plan: NonNullable<UnsubscribePlan>): Promise<string> {
	if (plan.kind === "mail") {
		const alias = await getAlias(env.DB, forward.alias_address);
		if (!alias || alias.deleted_at) throw new Error("The alias no longer exists");
		await sendViaMailflare(mailflareConfig(config), {
			mailboxId: alias.mailbox_id,
			from: alias.address,
			to: [plan.to],
			subject: plan.subject,
			// Never the body the sender suggested: this mail goes out under the alias's name.
			text: "unsubscribe",
		});
		return `unsubscribe email to ${plan.to}`;
	}
	const response = await fetch(plan.url, {
		redirect: "manual",
		signal: AbortSignal.timeout(TIMEOUT_MS),
		...(plan.kind === "post"
			? { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" }
			: {}),
	});
	await response.body?.cancel();
	if (response.status >= 400) throw new Error(`The sender's unsubscribe page answered ${response.status}`);
	return `${plan.kind === "post" ? "one-click POST to" : "visited"} ${new URL(plan.url).hostname}`;
}

async function blockContact(env: Env, forward: ForwardRow): Promise<string> {
	if (!forward.contact_id) throw new Error("This message has no sender on record");
	await env.DB.prepare("UPDATE contacts SET blocked = 1 WHERE id = ?").bind(forward.contact_id).run();
	return "sender blocked";
}

async function tokenHash(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Marks a link as used. Returns false when it already was, so a link that leaked (for
 * example in a quoted reply) cannot be replayed.
 */
export async function claimLink(db: D1Database, token: string): Promise<boolean> {
	const result = await db.prepare("INSERT INTO used_links (token_hash, used_at) VALUES (?, ?) ON CONFLICT DO NOTHING").bind(await tokenHash(token), now()).run();
	return result.meta.changes > 0;
}

/** Makes a link usable again after its action failed, so the user can retry. */
export async function releaseLink(db: D1Database, token: string): Promise<void> {
	await db.prepare("DELETE FROM used_links WHERE token_hash = ?").bind(await tokenHash(token)).run();
}

export async function performAction(env: Env, config: AppConfig, target: LinkTarget): Promise<string> {
	const { forward, action, plan } = target;
	let detail: string;
	try {
		if (action === "disable_alias") {
			await setForwardMode(env.DB, forward.alias_address, "none");
			detail = "alias forwarding turned off";
		} else if (action === "preserve_original" && plan) {
			try {
				detail = await runOriginalUnsubscribe(env, config, forward, plan);
			} catch (error) {
				// Still stop the mail, even when the sender's own mechanism is broken.
				const reason = error instanceof Error ? error.message : String(error);
				detail = `${await blockContact(env, forward)}; the sender's unsubscribe failed: ${reason}`;
			}
		} else {
			detail = await blockContact(env, forward);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await recordEvent(env.DB, { kind: target.kind, contactId: forward.contact_id, aliasAddress: forward.alias_address, status: "failed", detail: message });
		throw error;
	}
	await recordEvent(env.DB, { kind: target.kind, contactId: forward.contact_id, aliasAddress: forward.alias_address, status: "done", detail });
	return detail;
}

