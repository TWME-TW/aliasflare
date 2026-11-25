import { mailflareReady, type AppConfig } from "./config";
import { sendOutbound } from "./outbound";
import { verifyToken } from "./crypto";
import { getAlias, now, recordEvent, setForwardMode, type ForwardRow } from "./db";
import { domainOf, extractEmail, hostnameOf, safeHttpsUrl } from "./format";
export { safeHttpsUrl };
import type { Translate } from "./i18n";
import { mailflareConfig, sendViaMailflare } from "./mailflare";
import { loadSettings, unsubscribeRuleFor, type UnsubscribeBehavior, type UnsubscribeFallback } from "./settings";
import { isOwnAddress } from "./domains";
import { discard } from "./streams";

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
	/** When the sender's own unsubscribe cannot be used. */
	fallback: UnsubscribeFallback;
	/** Where "redirect_contact" sends the sender's mail ("" when none is set). */
	redirect: string;
	/** Domains a redirect may not point into: it would loop. */
	ownDomains: string[];
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
		action = "preserve_original"; // replaced below, once the alias is known
	} else {
		const [verb, id] = payload.split("~");
		if (!id || (verb !== "block" && verb !== "disable")) return null;
		forwardId = id;
		action = verb === "block" ? "block_contact" : "disable_alias";
	}
	const loaded = await loadForward(env.DB, forwardId);
	if (!loaded) return null;
	// The alias's domain may have unsubscribe settings of its own.
	const rule = unsubscribeRuleFor(settings, loaded.forward.alias_address);
	if (kind === "unsubscribe") action = rule.behavior;
	const ownDomains = [...settings.aliasDomains, loaded.forward.alias_address.split("@").pop() ?? ""].filter(Boolean);
	const plan =
		action === "preserve_original"
			? unsubscribePlan(loaded.forward, loaded.contactEmail, {
					blockedHosts: [...blockedHosts, ...[config.mailflareUrl, config.publicUrl, config.siteOrigin].map(hostnameOf).filter((host): host is string => !!host)],
					// An alias domain also covers its reverse-alias domain r.<domain>.
					ownDomains: [...settings.aliasDomains, loaded.forward.alias_address.split("@").pop() ?? ""].filter(Boolean),
				})
			: null;
	const canonicalToken = `${kind}:${token}`;
	return { ...loaded, action, kind, plan, fallback: rule.fallback, redirect: rule.redirect, ownDomains, token: canonicalToken };
}

export function describeAction(target: LinkTarget, t: Translate): string {
	const { forward, contactEmail, action, plan, fallback } = target;
	const sender = contactEmail ?? t("action.thisSender");
	const alias = forward.alias_address;
	const simple = (what: UnsubscribeFallback): string =>
		what === "disable_alias"
			? t("action.disable", { alias })
			: what === "redirect_contact"
				? t("action.redirect", { sender, alias, target: target.redirect || "?" })
				: what === "none"
					? t("action.nothing", { sender })
					: t("action.block", { sender, alias });
	if (action !== "preserve_original") return simple(action);
	// No unsubscribe of the sender's own: what happens instead is what happens.
	if (!plan) return simple(fallback);
	// The usual case keeps its one sentence; another fallback is added as a second one.
	if (fallback === "block_contact") return plan.kind === "mail" ? t("action.preserveMail", { sender, alias, target: plan.to }) : t("action.preserve", { sender });
	const first = plan.kind === "mail" ? t("action.preserveMailOnly", { sender, alias, target: plan.to }) : t("action.preserveOnly", { sender });
	const then =
		fallback === "disable_alias"
			? t("action.thenDisable", { alias })
			: fallback === "redirect_contact"
				? t("action.thenRedirect", { sender, target: target.redirect || "?" })
				: t("action.thenNothing");
	return `${first} ${then}`;
}

function parseUris(value: string): string[] {
	return (value.match(/<[^<>]+>/g) ?? []).map((uri) => uri.slice(1, -1).trim());
}

/** Second-level labels under a country code that are public suffixes (co.uk, gouv.fr, com.au). */
const COUNTRY_SECOND_LEVELS = new Set(
	"ac asso co com edu go gob gouv gov govt info ltd mil ne net nhs nom or org plc police priv sch".split(" "),
);

/** Suffixes under which every subdomain belongs to someone else. */
const SHARED_SUFFIXES = new Set(
	"github.io gitlab.io pages.dev workers.dev netlify.app vercel.app herokuapp.com web.app firebaseapp.com azurewebsites.net cloudfront.net blogspot.com wordpress.com substack.com".split(" "),
);

/**
 * Mailbox providers whose addresses belong to unrelated people. A sender there shares its
 * domain with everyone else's mailbox, so no address there counts as the sender's own site.
 */
const SHARED_MAILBOX_DOMAINS = new Set(
	"gmail.com googlemail.com outlook.com outlook.co.uk outlook.de outlook.fr outlook.jp outlook.es hotmail.com hotmail.co.uk hotmail.fr hotmail.de hotmail.es hotmail.it live.com live.co.uk live.fr live.de live.jp msn.com yahoo.com yahoo.co.uk yahoo.co.jp yahoo.fr yahoo.de yahoo.es yahoo.it yahoo.ca yahoo.com.au yahoo.com.tw yahoo.com.hk ymail.com rocketmail.com icloud.com me.com mac.com aol.com proton.me protonmail.com protonmail.ch pm.me gmx.com gmx.de gmx.net gmx.at gmx.ch gmx.fr web.de t-online.de orange.fr free.fr laposte.net sfr.fr mail.com yandex.com yandex.ru mail.ru qq.com 163.com 126.com zoho.com fastmail.com hey.com tutanota.com tuta.io naver.com daum.net hanmail.net seznam.cz wp.pl o2.pl interia.pl onet.pl".split(" "),
);

/** The registrable part of a domain, roughly: example.com, example.co.uk or name.github.io. */
export function siteOf(domain: string): string {
	const labels = domain.toLowerCase().replace(/\.$/, "").split(".");
	const last = labels.at(-1) ?? "";
	const second = labels.at(-2) ?? "";
	const suffix = SHARED_SUFFIXES.has(labels.slice(-2).join(".")) || (last.length === 2 && COUNTRY_SECOND_LEVELS.has(second));
	return labels.slice(-(suffix ? 3 : 2)).join(".");
}

/** Whether mail to `to` stays with the sender: the same site, and not a shared mailbox provider. */
export function sameSenderSite(to: string, sender: string): boolean {
	const site = siteOf(domainOf(sender));
	return !SHARED_MAILBOX_DOMAINS.has(site) && siteOf(domainOf(to)) === site;
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
	const owned = (domain: string) => limits.ownDomains.some((own) => domain === own || domain.endsWith(`.${own}`));
	// Every mailto is tried in turn: the first usable one is taken.
	for (const mailto of contactEmail ? uris.filter((uri) => uri.toLowerCase().startsWith("mailto:")) : []) {
		try {
			const url = new URL(mailto);
			const to = extractEmail(decodeURIComponent(url.pathname));
			if (to && sameSenderSite(to, contactEmail!) && !owned(domainOf(to))) {
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
		// Never the body the sender suggested: this mail goes out under the alias's name.
		// Sent the way replies are: through Mailflare for an alias it receives, otherwise with Email Sending.
		if (alias.mailbox_id && mailflareReady(config)) {
			await sendViaMailflare(mailflareConfig(config), { mailboxId: alias.mailbox_id, from: alias.address, to: [plan.to], subject: plan.subject, text: "unsubscribe" });
		} else {
			await sendOutbound(env, config, { from: alias.address, to: plan.to, subject: plan.subject, text: "unsubscribe" });
		}
		return `unsubscribe email to ${plan.to}`;
	}
	const response = await fetch(plan.url, {
		redirect: "manual",
		signal: AbortSignal.timeout(TIMEOUT_MS),
		...(plan.kind === "post"
			? { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" }
			: {}),
	});
	await discard(response);
	// Redirects are not followed (they could lead anywhere), so one is not a done unsubscribe.
	if (response.status >= 300) throw new Error(`The sender's unsubscribe page answered ${response.status}`);
	return `${plan.kind === "post" ? "one-click POST to" : "visited"} ${new URL(plan.url).hostname}`;
}

/** Sends this sender's mail to the alias to another address from now on. */
async function redirectContact(env: Env, target: LinkTarget): Promise<string> {
	const { forward, redirect, ownDomains } = target;
	if (!forward.contact_id) throw new Error("This message has no sender on record");
	if (!redirect) throw new Error("No address is set to send this sender's mail to");
	if (isOwnAddress(redirect, ownDomains)) throw new Error("The redirect address is on an alias domain");
	await env.DB.prepare("UPDATE contacts SET destination = ?, blocked = 0 WHERE id = ?").bind(redirect, forward.contact_id).run();
	return `sender's mail now goes to ${redirect}`;
}

/** One of the simple actions (everything but the sender's own unsubscribe). */
async function simpleAction(env: Env, target: LinkTarget, action: UnsubscribeFallback): Promise<string> {
	if (action === "disable_alias") {
		await setForwardMode(env.DB, target.forward.alias_address, "none");
		return "alias forwarding turned off";
	}
	if (action === "redirect_contact") return await redirectContact(env, target);
	if (action === "none") throw new Error("This sender has no unsubscribe of its own, and nothing else is set to happen");
	return await blockContact(env, target.forward);
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

/** True when a one-time link has already been consumed. */
export async function isLinkUsed(db: D1Database, token: string): Promise<boolean> {
	return (await db.prepare("SELECT 1 FROM used_links WHERE token_hash = ?").bind(await tokenHash(token)).first()) !== null;
}

/**
 * Marks a link as used. Returns false when it already was, so a link that leaked (for
 * example in a quoted reply) cannot be replayed.
 */
export async function claimLink(db: D1Database, token: string): Promise<boolean> {
	const timestamp = now();
	// Links expire after LINK_TTL_SECONDS, so older records are no longer needed to stop a replay.
	const [, inserted] = await db.batch([
		db.prepare("DELETE FROM used_links WHERE used_at < ?").bind(timestamp - LINK_TTL_SECONDS - 86400),
		db.prepare("INSERT INTO used_links (token_hash, used_at) VALUES (?, ?) ON CONFLICT DO NOTHING").bind(await tokenHash(token), timestamp),
	]);
	return (inserted?.meta.changes ?? 0) > 0;
}

/** Makes a link usable again after its action failed, so the user can retry. */
export async function releaseLink(db: D1Database, token: string): Promise<void> {
	await db.prepare("DELETE FROM used_links WHERE token_hash = ?").bind(await tokenHash(token)).run();
}

/**
 * Carries out a link's action. Returns what was done, which is the block instead of the
 * sender's own unsubscribe when that one failed, so the page can say so.
 */
export async function performAction(env: Env, config: AppConfig, target: LinkTarget): Promise<{ detail: string; done: LinkTarget }> {
	const { forward, action, plan } = target;
	let detail: string;
	let done: LinkTarget = target;
	try {
		if (action !== "preserve_original") {
			detail = await simpleAction(env, target, action);
		} else if (plan) {
			try {
				detail = await runOriginalUnsubscribe(env, config, forward, plan);
			} catch (error) {
				// The sender's own mechanism is broken: what is set for that case happens instead.
				const reason = error instanceof Error ? error.message : String(error);
				if (target.fallback === "none") throw new Error(`The sender's unsubscribe failed: ${reason}`);
				detail = `${await simpleAction(env, target, target.fallback)}; the sender's unsubscribe failed: ${reason}`;
				done = { ...target, action: target.fallback, plan: null };
			}
		} else {
			detail = await simpleAction(env, target, target.fallback);
			if (target.fallback !== "none") done = { ...target, action: target.fallback, plan: null };
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await recordEvent(env.DB, { kind: target.kind, contactId: forward.contact_id, aliasAddress: forward.alias_address, status: "failed", detail: message });
		throw error;
	}
	try {
		await recordEvent(env.DB, { kind: target.kind, contactId: forward.contact_id, aliasAddress: forward.alias_address, status: "done", detail });
	} catch (error) {
		console.error("Link action succeeded, but recording it failed", target.kind, error instanceof Error ? error.message : error);
	}
	return { detail, done };
}

