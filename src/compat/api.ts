/**
 * SimpleLogin- and addy.io-compatible APIs, so their official apps and browser extensions can list,
 * create and switch aliases. Each API is off until enabled in Settings, and every request needs an
 * API key created on the API keys page.
 *
 * SimpleLogin: https://github.com/simple-login/app/blob/master/docs/api.md
 * addy.io:     https://app.addy.io/docs/
 */
import { Hono, type Context } from "hono";
import { presentedKey, verifyApiKey } from "../apikeys";
import type { AppEnv } from "../auth";
import { signToken, verifyToken } from "../crypto";
import { ensureContact, newId, now, type BlocklistRow, type ContactRow } from "../db";
import { domainOf, extractEmail, isSenderFormat, reverseAddress } from "../format";
import { contactReverseAddress, isOwnAddress, reverseDomainFor } from "../domains";
import { loadSettings, normalizeSettings, saveSettings, type Settings } from "../settings";
import {
	ClientError,
	cleanPrefix,
	createAlias,
	createRandomAlias,
	deleteAlias,
	destinationOf,
	destinationIds,
	forgetAlias,
	getAliasView,
	latestContact,
	listAliasViews,
	listDestinations,
	resolveDestination,
	restoreAlias,
	totals,
	updateAlias,
	type AliasView,
} from "./aliases";

type ApiEnv = AppEnv & { Variables: AppEnv["Variables"] & { settings: Settings } };
type C = Context<ApiEnv>;

const VERSION = { version: "0.2.0", major: 0, minor: 2, patch: 0 };
const SL_PAGE_SIZE = 20;

export const api = new Hono<ApiEnv>();

// Browser extensions call from their own origin. Keys travel in headers, never cookies, so allowing
// any origin does not expose the dashboard session.
api.use("*", async (c, next) => {
	c.header("Access-Control-Allow-Origin", "*");
	c.header("Access-Control-Allow-Headers", "Authentication, Authorization, Content-Type, Accept, X-Requested-With");
	c.header("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
	c.header("Access-Control-Max-Age", "86400");
	c.header("Cache-Control", "no-store");
	if (c.req.method === "OPTIONS") return c.body(null, 204);
	await next();
});

api.onError((error, c) => {
	if (error instanceof ClientError) return c.json({ error: error.message, message: error.message }, error.status as 400);
	console.error("API error", error);
	return c.json({ error: "Internal error", message: "Internal error" }, 500);
});

const isAddy = (c: C) => c.req.path.startsWith("/api/v1/");

api.use("*", async (c, next) => {
	const settings = await loadSettings(c.env.DB);
	if (!(isAddy(c) ? settings.addyApi : settings.simpleloginApi)) return c.json({ error: "Not found", message: "Not found" }, 404);
	// The apps check the version before signing in.
	if (c.req.path === "/api/v1/app-version") return c.json(VERSION);
	if (c.req.path === "/api/auth/login") {
		return c.json({ error: "Sign in with an API key. Create one on the API keys page of aliasflare." }, 403);
	}
	const key = presentedKey(c.req.raw.headers);
	// Every request counts against a per-address limit before the key is looked up, so a
	// flood of guesses never reaches D1. Failed keys also count against the stricter one.
	const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
	if (c.env.API_RATE_LIMIT && !(await c.env.API_RATE_LIMIT.limit({ key: `api:${ip}` })).success) {
		return c.json({ error: "Too many requests", message: "Too Many Attempts." }, 429);
	}
	const valid = key ? await verifyApiKey(c.env.DB, key) : null;
	if (!valid) {
		if (c.env.LOGIN_RATE_LIMIT && !(await c.env.LOGIN_RATE_LIMIT.limit({ key: `api:${ip}` })).success) {
			return c.json({ error: "Too many attempts", message: "Too Many Attempts." }, 429);
		}
		return c.json({ error: "Wrong api key", message: "Unauthenticated." }, 401);
	}
	c.set("settings", settings);
	await next();
});

async function body(c: C): Promise<Record<string, unknown>> {
	if (!/json/i.test(c.req.header("Content-Type") ?? "")) return {};
	try {
		const parsed = await c.req.json();
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		throw new ClientError(400, "The request body is not valid JSON.");
	}
}

const str = (value: unknown, max = 500): string | undefined => (typeof value === "string" ? value.slice(0, max) : undefined);

// ═════════════════════════════════════════ SimpleLogin ═════════════════════════════════════════

const isoSeconds = (seconds: number) => new Date(seconds * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "+00:00");

function reverseAliasAddress(c: C, contact: ContactRow): string {
	return contactReverseAddress(contact);
}

function slContact(c: C, contact: ContactRow, existed?: boolean) {
	const address = reverseAliasAddress(c, contact);
	const last = Math.max(contact.last_forward_at ?? 0, contact.last_reply_at ?? 0) || null;
	return {
		id: contact.num_id,
		contact: contact.name ? `${contact.name} <${contact.email}>` : contact.email,
		creation_date: isoSeconds(contact.created_at),
		creation_timestamp: contact.created_at,
		last_email_sent_date: last ? isoSeconds(last) : null,
		last_email_sent_timestamp: last,
		reverse_alias: `"${contact.email.replace("@", " at ")}" <${address}>`,
		reverse_alias_address: address,
		block_forward: contact.blocked === 1,
		...(existed === undefined ? {} : { existed }),
	};
}

async function slAlias(c: C, alias: AliasView) {
	const settings = c.get("settings");
	const destination = destinationOf(alias, settings);
	const mailbox = destination ? { id: (await destinationIds(destination)).numId, email: destination } : { id: 0, email: "" };
	const contact = await latestContact(c.env.DB, alias.address);
	let latest = null;
	if (contact) {
		const replied = (contact.last_reply_at ?? 0) > (contact.last_forward_at ?? 0);
		latest = {
			action: replied ? "reply" : "forward",
			timestamp: (replied ? contact.last_reply_at : contact.last_forward_at) ?? contact.created_at,
			contact: { email: contact.email, name: contact.name, reverse_alias: slContact(c, contact).reverse_alias },
		};
	}
	return {
		id: alias.num_id,
		email: alias.address,
		name: alias.name,
		enabled: alias.forward_mode !== "none",
		creation_timestamp: alias.created_at,
		creation_date: isoSeconds(alias.created_at),
		note: alias.note,
		nb_block: Number(alias.nb_block),
		nb_forward: Number(alias.nb_forward),
		nb_reply: Number(alias.nb_reply),
		support_pgp: false,
		disable_pgp: false,
		mailbox,
		mailboxes: mailbox.email ? [mailbox] : [],
		latest_activity: latest,
		pinned: alias.pinned === 1,
	};
}

async function slFindAlias(c: C): Promise<AliasView> {
	const id = Number(c.req.param("id"));
	const alias = Number.isInteger(id) ? await getAliasView(c.env.DB, { numId: id }) : null;
	if (!alias || alias.deleted_at) throw new ClientError(404, "Alias not found");
	return alias;
}

async function slFindContact(c: C): Promise<ContactRow> {
	const id = Number(c.req.param("id"));
	const contact = Number.isInteger(id) ? await c.env.DB.prepare("SELECT * FROM contacts WHERE num_id = ?").bind(id).first<ContactRow>() : null;
	if (!contact) throw new ClientError(404, "Contact not found");
	return contact;
}

function pageId(c: C): number {
	const value = Number(c.req.query("page_id") ?? 0);
	return Number.isInteger(value) && value >= 0 ? value : 0;
}

api.get("/user_info", (c) =>
	c.json({
		name: "aliasflare",
		is_premium: true,
		email: c.get("settings").defaultDestination,
		in_trial: false,
		trial_end_timestamp: null,
		profile_picture_url: null,
		max_alias_free_plan: 0,
		can_create_reverse_alias: true,
		connection: "api_key",
	}),
);

api.get("/user/cookie_token", (c) => c.json({ error: "Open the aliasflare dashboard in your browser instead." }, 403));
api.get("/logout", (c) => c.json({ msg: "logged out" }));

api.get("/stats", async (c) => {
	const all = await totals(c.env.DB);
	return c.json({ nb_alias: all.aliases, nb_block: all.blocked, nb_forward: all.forwarded, nb_reply: all.replied });
});

async function suffixes(c: C) {
	const secret = c.get("config").signingSecret;
	const out = [];
	for (const domain of c.get("settings").aliasDomains) {
		// Only the plain domain: no random tail, so each alias domain is listed once.
		const suffix = `@${domain}`;
		out.push({
			suffix,
			signed_suffix: await signToken(secret, "sl-suffix", btoa(suffix).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"), 6 * 3600),
			is_custom: true,
			is_premium: false,
		});
	}
	return out;
}

function prefixSuggestion(c: C): string {
	const hostname = (c.req.query("hostname") ?? "").toLowerCase();
	return cleanPrefix(hostname.replace(/^www\./, "").split(".")[0] ?? "");
}

api.get("/v5/alias/options", async (c) =>
	c.json({ can_create: c.get("settings").aliasDomains.length > 0, prefix_suggestion: prefixSuggestion(c), suffixes: await suffixes(c) }),
);

// Used by the browser extension: suffixes as [suffix, signed_suffix] pairs.
api.get("/v4/alias/options", async (c) =>
	c.json({
		can_create: c.get("settings").aliasDomains.length > 0,
		prefix_suggestion: prefixSuggestion(c),
		suffixes: (await suffixes(c)).map((suffix) => [suffix.suffix, suffix.signed_suffix]),
	}),
);

const createCustomAlias = async (c: C) => {
	const input = await body(c);
	const prefix = cleanPrefix(str(input.alias_prefix) ?? "");
	const signed = str(input.signed_suffix, 1000) ?? "";
	const payload = await verifyToken(c.get("config").signingSecret, "sl-suffix", signed);
	if (!payload) throw new ClientError(412, "The alias options expired. Reload and try again.");
	const suffix = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
	const at = suffix.lastIndexOf("@");
	if (!prefix || at < 0) throw new ClientError(400, "Enter an alias prefix.");
	// v3 takes mailbox_ids; v2 (the browser extension) uses the default mailbox.
	const mailboxIds = Array.isArray(input.mailbox_ids) ? input.mailbox_ids : input.mailbox_id !== undefined ? [input.mailbox_id] : [];
	const destination = await resolveDestination(c.env.DB, c.get("settings"), mailboxIds[0] as number | undefined);
	const alias = await createAlias(c.env.DB, c.get("settings"), {
		localPart: prefix + suffix.slice(0, at),
		domain: suffix.slice(at + 1),
		note: str(input.note) ?? null,
		name: str(input.name, 100) ?? null,
		destination: destination ?? null,
	});
	return c.json(await slAlias(c, alias), 201);
};
api.post("/v3/alias/custom/new", createCustomAlias);
api.post("/v2/alias/custom/new", createCustomAlias);

api.post("/alias/random/new", async (c) => {
	const input = await body(c);
	const mode = c.req.query("mode");
	const alias = await createRandomAlias(c.env.DB, c.get("settings"), {
		format: mode === "uuid" ? "uuid" : mode === "word" ? "random_words" : undefined,
		note: str(input.note) ?? null,
	});
	return c.json(await slAlias(c, alias), 201);
});

async function slListAliases(c: C) {
	const input = c.req.method === "POST" ? await body(c) : {};
	const query = str(input.query) ?? c.req.query("query");
	const filter = c.req.query("pinned") !== undefined ? { pinned: true } : c.req.query("disabled") !== undefined ? { enabled: false } : c.req.query("enabled") !== undefined ? { enabled: true } : {};
	const { aliases } = await listAliasViews(c.env.DB, { ...filter, search: query, limit: SL_PAGE_SIZE, offset: pageId(c) * SL_PAGE_SIZE });
	return c.json({ aliases: await Promise.all(aliases.map((alias) => slAlias(c, alias))) });
}
api.get("/v2/aliases", slListAliases);
api.post("/v2/aliases", slListAliases);

api.get("/aliases/:id", async (c) => c.json(await slAlias(c, await slFindAlias(c))));

api.delete("/aliases/:id", async (c) => {
	await deleteAlias(c.env.DB, (await slFindAlias(c)).address);
	return c.json({ deleted: true });
});

api.post("/aliases/:id/toggle", async (c) => {
	const alias = await slFindAlias(c);
	const enabled = alias.forward_mode === "none";
	await updateAlias(c.env.DB, alias.address, { enabled });
	return c.json({ enabled });
});

const updateSlAlias = async (c: C) => {
	const alias = await slFindAlias(c);
	const input = await body(c);
	const mailboxId = Array.isArray(input.mailbox_ids) ? input.mailbox_ids[0] : input.mailbox_id;
	await updateAlias(c.env.DB, alias.address, {
		note: input.note === null ? null : str(input.note),
		name: input.name === null ? null : str(input.name, 100),
		pinned: typeof input.pinned === "boolean" ? input.pinned : undefined,
		destination: await resolveDestination(c.env.DB, c.get("settings"), mailboxId as number | undefined),
	});
	return c.json({ ok: true });
};
// SimpleLogin documents PUT; some clients send PATCH.
api.put("/aliases/:id", updateSlAlias);
api.patch("/aliases/:id", updateSlAlias);

api.get("/aliases/:id/activities", async (c) => {
	const alias = await slFindAlias(c);
	const { results } = await c.env.DB.prepare(
		`SELECT f.created_at, f.status, c.email, c.reverse_local, c.name FROM forwards f JOIN contacts c ON c.id = f.contact_id
		 WHERE f.alias_address = ? AND f.status IN ('sent', 'skipped') ORDER BY f.created_at DESC LIMIT ? OFFSET ?`,
	)
		.bind(alias.address, SL_PAGE_SIZE, pageId(c) * SL_PAGE_SIZE)
		.all<{ created_at: number; status: string; email: string; reverse_local: string; name: string | null }>();
	return c.json({
		activities: results.map((row) => {
			const address = reverseAddress(row.reverse_local, reverseDomainFor(domainOf(alias.address)));
			return {
				action: row.status === "sent" ? "forward" : "block",
				from: row.email,
				to: alias.address,
				timestamp: row.created_at,
				reverse_alias: `"${row.email.replace("@", " at ")}" <${address}>`,
				reverse_alias_address: address,
			};
		}),
	});
});

api.get("/aliases/:id/contacts", async (c) => {
	const alias = await slFindAlias(c);
	const { results } = await c.env.DB.prepare("SELECT * FROM contacts WHERE alias_address = ? ORDER BY created_at DESC LIMIT ? OFFSET ?")
		.bind(alias.address, SL_PAGE_SIZE, pageId(c) * SL_PAGE_SIZE)
		.all<ContactRow>();
	return c.json({ contacts: results.map((contact) => slContact(c, contact)) });
});

api.post("/aliases/:id/contacts", async (c) => {
	const alias = await slFindAlias(c);
	const text = str((await body(c)).contact) ?? "";
	const email = extractEmail(text);
	if (!email || isOwnAddress(email, [...c.get("settings").aliasDomains, domainOf(alias.address)])) throw new ClientError(400, "Enter a valid email address.");
	const name = text.includes("<") ? text.slice(0, text.indexOf("<")).replace(/["\\]/g, "").trim() || null : null;
	const before = await c.env.DB.prepare("SELECT 1 FROM contacts WHERE alias_address = ? AND email = ?").bind(alias.address, email).first();
	const contact = await ensureContact(c.env.DB, alias.address, email, name, c.get("settings").includeSenderInReverseAlias);
	return c.json(slContact(c, contact, !!before), before ? 200 : 201);
});

api.delete("/contacts/:id", async (c) => {
	const contact = await slFindContact(c);
	await c.env.DB.prepare("DELETE FROM contacts WHERE id = ?").bind(contact.id).run();
	return c.json({ deleted: true });
});

api.post("/contacts/:id/toggle", async (c) => {
	const contact = await slFindContact(c);
	const blocked = contact.blocked !== 1;
	await c.env.DB.prepare("UPDATE contacts SET blocked = ? WHERE id = ?").bind(blocked ? 1 : 0, contact.id).run();
	return c.json({ block_forward: blocked });
});

const slMailboxes = async (c: C) => {
	const destinations = await listDestinations(c.env.DB, c.get("settings"));
	return c.json({
		mailboxes: destinations.map((d) => ({ id: d.numId, email: d.email, default: d.isDefault, creation_timestamp: 0, nb_alias: d.aliasCount, verified: true })),
	});
};
api.get("/v2/mailboxes", slMailboxes);
// The browser extension still reads the v1 list.
api.get("/mailboxes", slMailboxes);

// ── Settings changed from apps ────────────────────────────────────────────────────────────────

/** Saves settings an app changed, if apps may change settings. */
async function changeSettings(c: C, update: Partial<Settings>): Promise<Settings> {
	requireAppSettings(c);
	const next = normalizeSettings({ ...c.get("settings"), ...update });
	await saveSettings(c.env.DB, next);
	c.set("settings", next);
	return next;
}

function requireAppSettings(c: C): void {
	if (!c.get("settings").appSettings) {
		throw new ClientError(403, "Changing settings from apps is turned off. Turn it on in the aliasflare settings.");
	}
}

async function jsonBody(c: C): Promise<Record<string, unknown>> {
	const body = await c.req.json().catch(() => null);
	return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function slSetting(settings: Settings) {
	return {
		alias_generator: settings.randomAliasFormat === "uuid" ? "uuid" : "word",
		notification: false,
		random_alias_default_domain: settings.aliasDomains[0] ?? "",
		sender_format: settings.senderFormat,
		// Custom aliases take no random suffix here; apps still expect the field.
		random_alias_suffix: "word",
	};
}
api.get("/setting", (c) => c.json(slSetting(c.get("settings"))));

// SimpleLogin apps change one or more of these at a time.
api.patch("/setting", async (c) => {
	const body = await jsonBody(c);
	const settings = c.get("settings");
	const update: Partial<Settings> = {};
	if (body.alias_generator !== undefined) {
		if (body.alias_generator === "uuid") update.randomAliasFormat = "uuid";
		// "word" covers both kinds of non-UUID names here; keep random characters if they were chosen.
		else if (body.alias_generator === "word") update.randomAliasFormat = settings.randomAliasFormat === "uuid" ? "random_words" : settings.randomAliasFormat;
		else throw new ClientError(400, "Invalid alias_generator");
	}
	if (body.random_alias_suffix !== undefined) {
		// Accepted for apps that send it, but there is no suffix to change.
		if (body.random_alias_suffix !== "word" && body.random_alias_suffix !== "random_string") throw new ClientError(400, "Invalid random_alias_suffix");
	}
	if (body.random_alias_default_domain !== undefined) {
		const domain = typeof body.random_alias_default_domain === "string" ? body.random_alias_default_domain.trim().toLowerCase() : "";
		if (!settings.aliasDomains.includes(domain)) throw new ClientError(400, "Invalid domain");
		update.aliasDomains = [domain, ...settings.aliasDomains.filter((d) => d !== domain)];
	}
	if (body.sender_format !== undefined) {
		if (!isSenderFormat(body.sender_format)) throw new ClientError(400, "Invalid sender_format");
		update.senderFormat = body.sender_format;
	}
	if (body.notification !== undefined && typeof body.notification !== "boolean") throw new ClientError(400, "Invalid notification");
	// aliasflare sends no notification emails, so "notification" is accepted and stays off.
	return c.json(slSetting(Object.keys(update).length ? await changeSettings(c, update) : settings));
});

// Making a mailbox the default one sets the default forwarding address.
api.put("/mailboxes/:id", async (c) => {
	const body = await jsonBody(c);
	if (body.email !== undefined || body.cancel_email_change !== undefined) {
		throw new ClientError(400, "Change forwarding addresses in the aliasflare dashboard.");
	}
	const id = c.req.param("id");
	const match = (await listDestinations(c.env.DB, c.get("settings"))).find((d) => d.numId === Number(id) || d.uid === id);
	if (!match) throw new ClientError(404, "Unknown mailbox");
	if (body.default === true && !match.isDefault) await changeSettings(c, { defaultDestination: match.email });
	return c.json({ updated: true });
});

const slDomains = (c: C) => c.json(c.get("settings").aliasDomains.map((domain) => ({ domain, is_custom: true })));
api.get("/v2/setting/domains", slDomains);
api.get("/setting/domains", (c) => c.json(c.get("settings").aliasDomains.map((domain) => [true, domain])));

// ═════════════════════════════════════════ addy.io ═════════════════════════════════════════

const OWNER_ID = "00000000-0000-4000-8000-000000000001";
const addyDate = (seconds: number | null | undefined) => (seconds ? new Date(seconds * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "") : null);

async function addyRecipient(email: string, aliasCount: number, settings: Settings) {
	const { uid } = await destinationIds(email);
	return {
		id: uid,
		user_id: OWNER_ID,
		email,
		description: email === settings.defaultDestination ? "Default" : null,
		can_reply_send: true,
		should_encrypt: false,
		inline_encryption: false,
		protected_headers: false,
		remove_pgp_keys: false,
		remove_pgp_signatures: false,
		fingerprint: null,
		active: true,
		email_verified_at: "2000-01-01 00:00:00",
		aliases_count: aliasCount,
		created_at: "2000-01-01 00:00:00",
		updated_at: "2000-01-01 00:00:00",
	};
}

async function addyAlias(c: C, alias: AliasView) {
	const settings = c.get("settings");
	const destination = destinationOf(alias, settings);
	const at = alias.address.lastIndexOf("@");
	return {
		id: alias.uid,
		user_id: OWNER_ID,
		aliasable_id: null,
		aliasable_type: null,
		local_part: alias.address.slice(0, at),
		extension: null,
		domain: alias.address.slice(at + 1),
		email: alias.address,
		active: alias.forward_mode !== "none",
		pinned: alias.pinned === 1,
		description: alias.note,
		from_name: alias.name,
		attached_recipients_only: false,
		emails_forwarded: Number(alias.nb_forward),
		emails_blocked: Number(alias.nb_block),
		emails_replied: Number(alias.nb_reply),
		emails_sent: Number(alias.nb_sent),
		recipients: destination && alias.destination ? [await addyRecipient(destination, 0, settings)] : [],
		labels: [],
		last_forwarded: addyDate(alias.last_forward_at),
		last_blocked: addyDate(alias.last_block_at),
		last_replied: addyDate(alias.last_reply_at),
		last_sent: addyDate(alias.last_sent_at),
		created_at: addyDate(alias.created_at),
		updated_at: addyDate(alias.updated_at),
		deleted_at: addyDate(alias.deleted_at),
	};
}

async function addyFind(c: C, id: string, includeDeleted = false): Promise<AliasView> {
	const alias = await getAliasView(c.env.DB, { uid: id });
	if (!alias || (alias.deleted_at && !includeDeleted)) throw new ClientError(404, "Not found");
	return alias;
}

api.get("/v1/api-token-details", async (c) => {
	const key = presentedKey(c.req.raw.headers);
	const row = key ? await verifyApiKey(c.env.DB, key) : null;
	return c.json({ name: row?.name ?? "API key", created_at: addyDate(row?.created_at), expires_at: null });
});

api.get("/v1/account-details", async (c) => {
	const settings = c.get("settings");
	const all = await totals(c.env.DB);
	const defaultRecipient = settings.defaultDestination ? (await destinationIds(settings.defaultDestination)).uid : null;
	const destinations = await listDestinations(c.env.DB, settings);
	return c.json({
		data: {
			id: OWNER_ID,
			username: "aliasflare",
			from_name: null,
			email_subject: null,
			banner_location: settings.showBanner ? "top" : "off",
			spam_warning_behaviour: "off",
			wkd_auto_encrypt: 0,
			bandwidth: 0,
			username_count: 1,
			username_limit: 1,
			default_username_id: OWNER_ID,
			default_recipient_id: defaultRecipient,
			default_alias_domain: settings.aliasDomains[0] ?? null,
			default_alias_format: settings.randomAliasFormat,
			alias_separator: ".",
			custom_alias_random_characters: false,
			custom_alias_random_length: 0,
			custom_alias_random_charset: "alphanumeric",
			subscription: "lite",
			subscription_type: null,
			subscription_ends_at: null,
			family_plan_role: null,
			bandwidth_limit: 0,
			recipient_count: destinations.length,
			recipient_limit: 0,
			active_domain_count: settings.aliasDomains.length,
			active_domain_limit: 0,
			active_shared_domain_alias_count: 0,
			active_shared_domain_alias_limit: 0,
			active_rule_count: 0,
			active_rule_limit: 0,
			total_emails_forwarded: all.forwarded,
			total_emails_blocked: all.blocked,
			total_emails_replied: all.replied,
			total_emails_sent: 0,
			total_aliases: all.aliases + all.deleted,
			total_active_aliases: all.active,
			total_inactive_aliases: all.aliases - all.active,
			total_pinned_aliases: all.pinned,
			total_deleted_aliases: all.deleted,
			created_at: "2000-01-01 00:00:00",
			updated_at: "2000-01-01 00:00:00",
		},
	});
});

api.get("/v1/account-notifications", (c) => c.json({ data: [] }));

// addy.io's blocklist is the blocklist here: "email" entries are addresses, "domain" entries domains.
const addyBlock = (row: BlocklistRow) => ({
	id: row.id,
	user_id: OWNER_ID,
	value: row.value,
	type: row.kind === "address" ? "email" : "domain",
	blocked: row.hits,
	last_blocked: null,
	created_at: addyDate(row.created_at),
	updated_at: addyDate(row.created_at),
});

const BLOCK_DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function blockValue(type: unknown, value: unknown): { kind: "address" | "domain"; value: string } {
	const raw = (typeof value === "string" ? value : "").trim().toLowerCase().replace(/^@/, "");
	if (type === "email") {
		const email = extractEmail(raw);
		if (email && email === raw) return { kind: "address", value: email };
	} else if (type === "domain" && BLOCK_DOMAIN.test(raw)) {
		return { kind: "domain", value: raw };
	}
	throw new ClientError(422, "The value is not a valid email address or domain.");
}

async function addBlocks(c: C, entries: { kind: "address" | "domain"; value: string }[]): Promise<{ rows: BlocklistRow[]; skipped: number }> {
	requireAppSettings(c);
	const created: string[] = [];
	for (const entry of entries) {
		const id = newId("bl");
		const result = await c.env.DB.prepare("INSERT INTO blocklist (id, kind, value, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (value) DO NOTHING")
			.bind(id, entry.kind, entry.value, now())
			.run();
		if (result.meta.changes > 0) created.push(id);
	}
	const rows = created.length
		? (await c.env.DB.prepare(`SELECT * FROM blocklist WHERE id IN (${created.map(() => "?").join(", ")})`).bind(...created).all<BlocklistRow>()).results
		: [];
	return { rows, skipped: entries.length - rows.length };
}

// A Map, so "toString" or "constructor" cannot reach ORDER BY.
const BLOCKLIST_SORT = new Map([
	["created_at", "created_at"],
	["value", "value"],
	["blocked", "hits"],
	["last_blocked", "created_at"],
]);

api.get("/v1/blocklist", async (c) => {
	const search = (c.req.query("filter[search]") ?? "").toLowerCase().slice(0, 200);
	const type = c.req.query("filter[type]");
	const sort = c.req.query("sort") ?? "-created_at";
	const column = BLOCKLIST_SORT.get(sort.replace(/^-/, "")) ?? "created_at";
	const size = Math.min(Math.max(Number(c.req.query("page[size]")) || 100, 1), 100);
	const pageNumber = Math.max(Number(c.req.query("page[number]")) || 1, 1);
	const where: string[] = [];
	const params: unknown[] = [];
	if (search) where.push("value LIKE ? ESCAPE '!'"), params.push(`%${search.replace(/[!%_]/g, "!$&")}%`);
	if (type === "email" || type === "domain") where.push("kind = ?"), params.push(type === "email" ? "address" : "domain");
	const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
	const [list, counted] = await Promise.all([
		c.env.DB.prepare(`SELECT * FROM blocklist ${clause} ORDER BY ${column} ${sort.startsWith("-") ? "DESC" : "ASC"} LIMIT ? OFFSET ?`)
			.bind(...params, size, (pageNumber - 1) * size)
			.all<BlocklistRow>(),
		c.env.DB.prepare(`SELECT COUNT(*) AS total FROM blocklist ${clause}`).bind(...params).first<{ total: number }>(),
	]);
	const total = counted?.total ?? 0;
	const lastPage = Math.max(Math.ceil(total / size), 1);
	return c.json({
		data: list.results.map(addyBlock),
		links: { first: null, last: null, prev: null, next: null },
		meta: { current_page: pageNumber, from: total ? (pageNumber - 1) * size + 1 : null, last_page: lastPage, per_page: size, to: Math.min(pageNumber * size, total) || null, total },
	});
});

api.post("/v1/blocklist", async (c) => {
	const body = await jsonBody(c);
	const { rows } = await addBlocks(c, [blockValue(body.type, body.value)]);
	if (!rows[0]) throw new ClientError(422, "This value is already on your blocklist.");
	return c.json({ data: addyBlock(rows[0]) }, 201);
});

api.post("/v1/blocklist/store/bulk", async (c) => {
	const body = await jsonBody(c);
	const values = Array.isArray(body.values) ? [...new Set(body.values)].slice(0, 100) : [];
	if (!values.length) throw new ClientError(422, "No values given.");
	const { rows, skipped } = await addBlocks(c, values.map((value) => blockValue(body.type, value)));
	const added = rows.length;
	const message =
		added === 0
			? skipped > 0
				? "All entries were already on your blocklist."
				: "No entries added."
			: `${added === 1 ? "1 entry" : `${added} entries`} added to blocklist.${skipped > 0 ? ` ${skipped} already on blocklist.` : ""}`;
	return c.json({ data: rows.map(addyBlock), message, skipped }, 201);
});

api.delete("/v1/blocklist/:id", async (c) => {
	requireAppSettings(c);
	const result = await c.env.DB.prepare("DELETE FROM blocklist WHERE id = ?").bind(c.req.param("id")).run();
	if (!result.meta.changes) throw new ClientError(404, "Not found");
	return c.body(null, 204);
});

api.post("/v1/blocklist/delete/bulk", async (c) => {
	requireAppSettings(c);
	const body = await jsonBody(c);
	const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string").slice(0, 100) : [];
	const found = ids.length
		? (await c.env.DB.prepare(`SELECT id FROM blocklist WHERE id IN (${ids.map(() => "?").join(", ")})`).bind(...ids).all<{ id: string }>()).results.map((row) => row.id)
		: [];
	if (!found.length) return c.json({ message: "No blocklist entries found" }, 404);
	await c.env.DB.prepare(`DELETE FROM blocklist WHERE id IN (${found.map(() => "?").join(", ")})`).bind(...found).run();
	return c.json({ message: found.length === 1 ? "1 entry removed from blocklist" : `${found.length} entries removed from blocklist`, ids: found });
});

api.get("/v1/domain-options", (c) => {
	const settings = c.get("settings");
	return c.json({ data: settings.aliasDomains, sharedDomains: [], defaultAliasDomain: settings.aliasDomains[0] ?? null, defaultAliasFormat: settings.randomAliasFormat });
});

api.get("/v1/aliases", async (c) => {
	const deleted = c.req.query("filter[deleted]");
	const active = c.req.query("filter[active]");
	const pinned = c.req.query("filter[pinned]");
	const size = Math.min(100, Math.max(1, Number(c.req.query("page[size]") ?? 100) || 100));
	const page = Math.max(1, Number(c.req.query("page[number]") ?? 1) || 1);
	const { aliases, total } = await listAliasViews(c.env.DB, {
		deleted: deleted === "with" || deleted === "only" ? deleted : "without",
		enabled: active === "true" ? true : active === "false" ? false : undefined,
		pinned: pinned === "true" ? true : pinned === "false" ? false : undefined,
		search: c.req.query("filter[search]"),
		limit: size,
		offset: (page - 1) * size,
	});
	const lastPage = Math.max(1, Math.ceil(total / size));
	const url = new URL(c.req.url);
	const pageUrl = (n: number) => {
		const next = new URL(url);
		next.searchParams.set("page[number]", String(n));
		return next.toString();
	};
	const from = total ? (page - 1) * size + 1 : null;
	return c.json({
		data: await Promise.all(aliases.map((alias) => addyAlias(c, alias))),
		links: { first: pageUrl(1), last: pageUrl(lastPage), prev: page > 1 ? pageUrl(page - 1) : null, next: page < lastPage ? pageUrl(page + 1) : null },
		meta: {
			current_page: page,
			from,
			last_page: lastPage,
			links: [],
			path: `${url.origin}${url.pathname}`,
			per_page: size,
			to: from ? from + aliases.length - 1 : null,
			total,
		},
	});
});

api.post("/v1/aliases", async (c) => {
	const input = await body(c);
	const settings = c.get("settings");
	const domain = str(input.domain, 253) ?? settings.aliasDomains[0] ?? "";
	const format = str(input.format, 40) ?? settings.randomAliasFormat;
	const recipientIds = Array.isArray(input.recipient_ids) ? input.recipient_ids : [];
	const destination = (await resolveDestination(c.env.DB, settings, recipientIds[0] as string | undefined)) ?? null;
	const note = str(input.description) ?? null;
	const alias =
		format === "custom"
			? await createAlias(c.env.DB, settings, { localPart: cleanPrefix(str(input.local_part, 64) ?? ""), domain, note, destination })
			: await createRandomAlias(c.env.DB, settings, { domain, format, note, destination });
	return c.json({ data: await addyAlias(c, alias) }, 201);
});

api.get("/v1/aliases/:id", async (c) => c.json({ data: await addyAlias(c, await addyFind(c, c.req.param("id"), true)) }));

api.patch("/v1/aliases/:id", async (c) => {
	const alias = await addyFind(c, c.req.param("id"));
	const input = await body(c);
	await updateAlias(c.env.DB, alias.address, {
		note: input.description === null ? null : str(input.description),
		name: input.from_name === null ? null : str(input.from_name, 100),
	});
	return c.json({ data: await addyAlias(c, await addyFind(c, alias.uid)) });
});

api.delete("/v1/aliases/:id", async (c) => {
	await deleteAlias(c.env.DB, (await addyFind(c, c.req.param("id"))).address);
	return c.body(null, 204);
});

api.patch("/v1/aliases/:id/restore", async (c) => {
	const alias = await addyFind(c, c.req.param("id"), true);
	await restoreAlias(c.env.DB, alias.address);
	return c.json({ data: await addyAlias(c, await addyFind(c, alias.uid)) });
});

api.delete("/v1/aliases/:id/forget", async (c) => {
	await forgetAlias(c.env.DB, (await addyFind(c, c.req.param("id"), true)).address);
	return c.body(null, 204);
});

async function setFlag(c: C, id: unknown, fields: { enabled?: boolean; pinned?: boolean }): Promise<AliasView> {
	const alias = await addyFind(c, typeof id === "string" ? id : "");
	await updateAlias(c.env.DB, alias.address, fields);
	return addyFind(c, alias.uid);
}

api.post("/v1/active-aliases", async (c) => c.json({ data: await addyAlias(c, await setFlag(c, (await body(c)).id, { enabled: true })) }));
api.delete("/v1/active-aliases/:id", async (c) => {
	await setFlag(c, c.req.param("id"), { enabled: false });
	return c.body(null, 204);
});
api.post("/v1/pinned-aliases", async (c) => c.json({ data: await addyAlias(c, await setFlag(c, (await body(c)).id, { pinned: true })) }));
api.delete("/v1/pinned-aliases/:id", async (c) => {
	await setFlag(c, c.req.param("id"), { pinned: false });
	return c.body(null, 204);
});

api.post("/v1/alias-recipients", async (c) => {
	const input = await body(c);
	const alias = await addyFind(c, str(input.alias_id, 64) ?? "");
	const ids = Array.isArray(input.recipient_ids) ? input.recipient_ids : [];
	const destination = ids.length ? await resolveDestination(c.env.DB, c.get("settings"), ids[0] as string) : null;
	await updateAlias(c.env.DB, alias.address, { destination: destination ?? null });
	return c.json({ data: await addyAlias(c, await addyFind(c, alias.uid)) });
});

api.get("/v1/recipients", async (c) => {
	const settings = c.get("settings");
	const destinations = await listDestinations(c.env.DB, settings);
	return c.json({ data: await Promise.all(destinations.map((d) => addyRecipient(d.email, d.aliasCount, settings))) });
});

api.get("/v1/recipients/:id", async (c) => {
	const settings = c.get("settings");
	const match = (await listDestinations(c.env.DB, settings)).find((d) => d.uid === c.req.param("id"));
	if (!match) throw new ClientError(404, "Not found");
	return c.json({ data: await addyRecipient(match.email, match.aliasCount, settings) });
});

api.get("/v1/domains", (c) =>
	c.json({
		data: c.get("settings").aliasDomains.map((domain, index) => ({
			id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
			user_id: OWNER_ID,
			domain,
			description: null,
			from_name: null,
			aliases_count: 0,
			default_recipient: null,
			active: true,
			catch_all: true,
			auto_create_regex: null,
			domain_verified_at: "2000-01-01 00:00:00",
			domain_mx_validated_at: "2000-01-01 00:00:00",
			domain_sending_verified_at: "2000-01-01 00:00:00",
			created_at: "2000-01-01 00:00:00",
			updated_at: "2000-01-01 00:00:00",
		})),
	}),
);

api.all("*", (c) => c.json({ error: "Not supported by aliasflare", message: "Not Found" }, 404));

