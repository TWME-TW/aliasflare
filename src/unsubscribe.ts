import type { AppConfig } from "./config";
import { verifyToken } from "./crypto";
import { getAlias, recordEvent, setForwardMode, type ForwardRow } from "./db";
import { extractEmail } from "./format";
import type { Translate } from "./i18n";
import { mailflareConfig, sendViaMailflare } from "./mailflare";
import { loadSettings, type UnsubscribeBehavior } from "./settings";

const TIMEOUT_MS = 10_000;

/** What a signed link does: the List-Unsubscribe link follows the setting; banner links are fixed. */
export type LinkAction = UnsubscribeBehavior;

export type LinkTarget = {
	forward: ForwardRow;
	contactEmail: string | null;
	action: LinkAction;
	kind: "unsubscribe" | "action";
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
export async function resolveLink(env: Env, config: AppConfig, kind: "unsubscribe" | "action", token: string): Promise<LinkTarget | null> {
	const payload = await verifyToken(config.signingSecret, kind, token);
	if (!payload) return null;
	let action: LinkAction;
	let forwardId: string;
	if (kind === "unsubscribe") {
		forwardId = payload;
		action = (await loadSettings(env.DB)).unsubscribeBehavior;
	} else {
		const [verb, id] = payload.split("~");
		if (!id || (verb !== "block" && verb !== "disable")) return null;
		forwardId = id;
		action = verb === "block" ? "block_contact" : "disable_alias";
	}
	const loaded = await loadForward(env.DB, forwardId);
	return loaded ? { ...loaded, action, kind } : null;
}

export function describeAction(target: LinkTarget, t: Translate): string {
	const { forward, contactEmail, action } = target;
	const sender = contactEmail ?? t("action.thisSender");
	if (action === "disable_alias") return t("action.disable", { alias: forward.alias_address });
	if (action === "preserve_original" && forward.original_unsubscribe) return t("action.preserve", { sender });
	return t("action.block", { sender, alias: forward.alias_address });
}

function parseUris(value: string): string[] {
	return (value.match(/<[^<>]+>/g) ?? []).map((uri) => uri.slice(1, -1).trim());
}

/** Runs the sender's List-Unsubscribe from this Worker, so the user's IP and address stay hidden. */
async function runOriginalUnsubscribe(env: Env, config: AppConfig, forward: ForwardRow): Promise<string> {
	const uris = parseUris(forward.original_unsubscribe ?? "");
	const https = uris.find((uri) => uri.toLowerCase().startsWith("https:"));
	if (https && forward.original_unsubscribe_post) {
		const response = await fetch(https, {
			method: "POST",
			redirect: "manual",
			signal: AbortSignal.timeout(TIMEOUT_MS),
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: "List-Unsubscribe=One-Click",
		});
		if (response.status >= 400) throw new Error(`The sender's unsubscribe endpoint answered ${response.status}`);
		return `one-click POST to ${new URL(https).hostname}`;
	}
	const mailto = uris.find((uri) => uri.toLowerCase().startsWith("mailto:"));
	if (mailto) {
		const url = new URL(mailto);
		const to = extractEmail(decodeURIComponent(url.pathname));
		if (!to) throw new Error("The sender's mailto unsubscribe address is invalid");
		const alias = await getAlias(env.DB, forward.alias_address);
		if (!alias) throw new Error("The alias no longer exists");
		await sendViaMailflare(mailflareConfig(config), {
			mailboxId: alias.mailbox_id,
			from: alias.address,
			to: [to],
			subject: url.searchParams.get("subject")?.slice(0, 200) || "unsubscribe",
			text: url.searchParams.get("body")?.slice(0, 2000) || "unsubscribe",
		});
		return `unsubscribe email to ${to}`;
	}
	if (https) {
		const response = await fetch(https, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (response.status >= 400) throw new Error(`The sender's unsubscribe page answered ${response.status}`);
		return `visited ${new URL(https).hostname}`;
	}
	throw new Error("The sender has no usable unsubscribe link");
}

async function blockContact(env: Env, forward: ForwardRow): Promise<string> {
	if (!forward.contact_id) throw new Error("This message has no sender on record");
	await env.DB.prepare("UPDATE contacts SET blocked = 1 WHERE id = ?").bind(forward.contact_id).run();
	return "sender blocked";
}

export async function performAction(env: Env, config: AppConfig, target: LinkTarget): Promise<string> {
	const { forward, action } = target;
	let detail: string;
	try {
		if (action === "disable_alias") {
			await setForwardMode(env.DB, forward.alias_address, "none");
			detail = "alias forwarding turned off";
		} else if (action === "preserve_original" && forward.original_unsubscribe) {
			try {
				detail = await runOriginalUnsubscribe(env, config, forward);
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

