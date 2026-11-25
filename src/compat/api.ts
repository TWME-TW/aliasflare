/**
 * SimpleLogin- and addy.io-compatible APIs, so their official apps and browser extensions can list,
 * create and switch aliases. Each API is off until enabled in Settings, and every request needs an
 * API key created on the API keys page.
 *
 * SimpleLogin: https://github.com/simple-login/app/blob/master/docs/api.md
 * addy.io:     https://app.addy.io/docs/
 */
import { clientKey } from "../ratelimit";
import { Hono, type Context } from "hono";
import { presentedKey, verifyApiKey, type ApiKeyRow } from "../apikeys";
import { readTextLimited } from "../streams";
import type { AppEnv } from "../auth";
import { signToken, verifyToken } from "../crypto";
import { ensureContact, newId, now, type BlocklistRow, type ContactRow } from "../db";
import { cleanDisplayName, DOMAIN_PATTERN, domainOf, extractEmail, isSenderFormat, pageParam, reverseAddress } from "../format";
import { contactReverseAddress, isOwnAddress, reverseDomainFor } from "../domains";
import { loadSettings, normalizeSettings, saveSettings, type Settings } from "../settings";
import { createLabel, deleteLabel, getLabel, LabelError, labelsOf, listLabels, setAliasLabels, updateLabel, type LabelRow } from "../labels";
import { cleanRule, createRule, deleteRule, getRule, listRules, reorderRules, RuleError, setRuleActive, updateRule, type Rule } from "../rules";
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
	latestContacts,
	listAliasViews,
	listDestinations,
	resolveDestination,
	restoreAlias,
	totals,
	updateAlias,
	type AliasView,
} from "./aliases";

type ApiEnv = AppEnv & { Variables: AppEnv["Variables"] & { settings: Settings; apiKey: ApiKeyRow } };

/** JSON bodies from apps are small; anything larger is refused before it is parsed. */
const MAX_API_BODY_BYTES = 64 * 1024;

/** Marks an address that kept presenting wrong keys, so its next attempts stop before D1. */
const lockoutUrl = (ip: string) => `https://aliasflare.invalid/api-lockout/${encodeURIComponent(ip)}`;
const lockoutCache = (): Cache | null => (typeof caches === "undefined" ? null : (caches as unknown as { default: Cache }).default);

export async function recordApiLockout(ip: string): Promise<void> {
	await lockoutCache()?.put(lockoutUrl(ip), new Response("1", { headers: { "Cache-Control": "max-age=60" } })).catch(() => undefined);
}
type C = Context<ApiEnv>;

// The addy.io apps refuse a self-hosted server below their minimum version (1.7.4 in late 2026)
// and compare only these numbers, so report the addy.io API level aliasflare follows.
const VERSION = { version: "aliasflare (addy.io API 1.99)", major: 1, minor: 99, patch: 0 };
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

/**
 * Limits for the client APIs, checked before anything reads D1 (the app's configuration
 * included), so a flood of requests or key guesses never reaches the database.
 */
export async function apiThrottled(env: Env, ip: string | undefined): Promise<Response | null> {
	const client = clientKey(ip);
	if (env.API_RATE_LIMIT && !(await env.API_RATE_LIMIT.limit({ key: `api:${client}` })).success) {
		return Response.json({ error: "Too many requests", message: "Too Many Attempts." }, { status: 429 });
	}
	// An address over the failed-key limit is turned away here, before any key is looked up.
	const cache = lockoutCache();
	if (cache && (await cache.match(lockoutUrl(client)).catch(() => undefined))) return Response.json({ error: "Too many attempts", message: "Too Many Attempts." }, { status: 429 });
	return null;
}

api.use("*", async (c, next) => {
	const settings = await loadSettings(c.env.DB);
	if (!(isAddy(c) ? settings.addyApi : settings.simpleloginApi)) return c.json({ error: "Not found", message: "Not found" }, 404);
	// The apps check the version before signing in.
	if (c.req.path === "/api/v1/app-version") return c.json(VERSION);
	if (c.req.path === "/api/auth/login") {
		return c.json({ error: "Sign in with an API key. Create one on the API keys page of aliasflare." }, 403);
	}
	const key = presentedKey(c.req.raw.headers);
	// The request limits ran before this (see apiThrottled); failed keys also count against the stricter one.
	const ip = clientKey(c.req.header("CF-Connecting-IP"));
	const valid = key ? await verifyApiKey(c.env.DB, key, "apps") : null;
	if (!valid) {
		if (c.env.LOGIN_RATE_LIMIT && !(await c.env.LOGIN_RATE_LIMIT.limit({ key: `api:${ip}` })).success) {
			await recordApiLockout(ip);
			return c.json({ error: "Too many attempts", message: "Too Many Attempts." }, 429);
		}
		return c.json({ error: "Wrong api key", message: "Unauthenticated." }, 401);
	}
	c.set("settings", settings);
	c.set("apiKey", valid);
	await next();
});

/**
 * The JSON object a request carries, read up to MAX_API_BODY_BYTES. `lenient` reads it
 * whatever the Content-Type and treats bad JSON as empty (the settings screens of some apps
 * send it that way); otherwise only a JSON Content-Type is read and bad JSON is a 400.
 */
async function readBody(c: C, lenient: boolean): Promise<Record<string, unknown>> {
	if (!lenient && !/json/i.test(c.req.header("Content-Type") ?? "")) return {};
	const text = await readTextLimited(c.req.raw, MAX_API_BODY_BYTES);
	if (text === null) throw new ClientError(413, "The request body is too large.");
	if (!text.trim()) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		if (lenient) return {};
		throw new ClientError(400, "The request body is not valid JSON.");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		if (lenient) return {};
		throw new ClientError(400, "The request body must be a JSON object.");
	}
	return parsed as Record<string, unknown>;
}

const body = (c: C) => readBody(c, false);

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

async function slAlias(c: C, alias: AliasView, preloadedContact?: ContactRow | null) {
	const settings = c.get("settings");
	const destination = destinationOf(alias, settings);
	const mailbox = destination ? { id: (await destinationIds(destination)).numId, email: destination } : { id: 0, email: "" };
	const contact = preloadedContact !== undefined ? preloadedContact : await latestContact(c.env.DB, alias.address);
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
	const contact = Number.isInteger(id)
		? await c.env.DB.prepare("SELECT c.* FROM contacts c JOIN aliases a ON a.address = c.alias_address WHERE c.num_id = ? AND a.deleted_at IS NULL").bind(id).first<ContactRow>()
		: null;
	if (!contact) throw new ClientError(404, "Contact not found");
	return contact;
}

function pageId(c: C): number {
	return pageParam(c.req.query("page_id"), 0, 0);
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

const queryFlag = (value: string | undefined): boolean | undefined => {
	if (value === undefined) return undefined;
	const lower = value.trim().toLowerCase();
	if (lower === "false" || lower === "0") return false;
	return true;
};

async function slListAliases(c: C) {
	const input = c.req.method === "POST" ? await body(c) : {};
	const query = str(input.query, 200) ?? c.req.query("query")?.slice(0, 200);
	const pinned = queryFlag(c.req.query("pinned"));
	const disabled = queryFlag(c.req.query("disabled"));
	const enabled = queryFlag(c.req.query("enabled"));
	const filter = {
		...(pinned === true ? { pinned: true } : {}),
		...(disabled === true ? { enabled: false } : enabled === true ? { enabled: true } : {}),
	};
	const { aliases } = await listAliasViews(c.env.DB, { ...filter, search: query, limit: SL_PAGE_SIZE, offset: pageId(c) * SL_PAGE_SIZE });
	const latest = await latestContacts(c.env.DB, aliases.map((alias) => alias.address));
	return c.json({ aliases: await Promise.all(aliases.map((alias) => slAlias(c, alias, latest.get(alias.address) ?? null))) });
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
	const name = text.includes("<") ? cleanDisplayName(text.slice(0, text.indexOf("<"))) : null;
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

const jsonBody = (c: C) => readBody(c, true);

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
	requireAppSettings(c);
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
	requireAppSettings(c);
	const body = await jsonBody(c);
	if (body.email !== undefined || body.cancel_email_change !== undefined) {
		throw new ClientError(400, "Change forwarding addresses in the aliasflare dashboard.");
	}
	const id = c.req.param("id");
	const settings = c.get("settings");
	const match = (await listDestinations(c.env.DB, settings)).find((d) => d.numId === Number(id) || d.uid === id);
	if (!match) throw new ClientError(404, "Unknown mailbox");
	if (body.default === true && !match.isDefault) {
		if (isOwnAddress(match.email, settings.aliasDomains)) throw new ClientError(400, "This forwarding address would loop.");
		await changeSettings(c, { defaultDestination: match.email });
	}
	return c.json({ updated: true });
});

const slDomains = (c: C) => c.json(c.get("settings").aliasDomains.map((domain) => ({ domain, is_custom: true })));
api.get("/v2/setting/domains", slDomains);
api.get("/setting/domains", (c) => c.json(c.get("settings").aliasDomains.map((domain) => [true, domain])));

// ═════════════════════════════════════════ addy.io ═════════════════════════════════════════

const OWNER_ID = "00000000-0000-4000-8000-000000000001";
const addyDomainId = (index: number) => `00000000-0000-4000-9000-${String(index + 1).padStart(12, "0")}`;
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

async function addyAlias(c: C, alias: AliasView, labels?: LabelRow[]) {
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
		labels: (labels ?? (await labelsOf(c.env.DB, [alias.address])).get(alias.address) ?? []).map((label) => addyLabel(label)),
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
	// The key was checked on the way in; no second lookup.
	const row = c.get("apiKey");
	return c.json({ name: row.name, created_at: addyDate(row.created_at), expires_at: null });
});

api.get("/v1/account-details", async (c) => {
	const settings = c.get("settings");
	const all = await totals(c.env.DB);
	const destinations = await listDestinations(c.env.DB, settings);
	const defaultRecipient = destinations[0]?.uid ?? "";
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
			username_count: 0,
			username_limit: 1,
			default_username_id: OWNER_ID,
			default_recipient_id: defaultRecipient,
			default_alias_domain: settings.aliasDomains[0] ?? "",
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

const BLOCK_DOMAIN = DOMAIN_PATTERN;

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

/** A page size from 1 to 100 (100 when missing or not a number); a fraction is rounded down. */
function pageSize(value: string | undefined): number {
	const size = Math.floor(Number(value));
	return Number.isFinite(size) && size >= 1 ? Math.min(size, 100) : 100;
}

async function addBlocks(c: C, entries: { kind: "address" | "domain"; value: string }[]): Promise<{ rows: BlocklistRow[]; skipped: number }> {
	requireAppSettings(c);
	if (entries.length === 0) return { rows: [], skipped: 0 };
	// One batch (one query), so a bulk add of 100 stays inside the Free plan's 50 queries.
	const ids = entries.map(() => newId("bl"));
	const results = await c.env.DB.batch(
		entries.map((entry, index) =>
			c.env.DB.prepare("INSERT INTO blocklist (id, kind, value, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (value) DO NOTHING").bind(ids[index], entry.kind, entry.value, now()),
		),
	);
	const created = ids.filter((_, index) => (results[index]?.meta.changes ?? 0) > 0);
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
	const size = pageSize(c.req.query("page[size]"));
	const pageNumber = pageParam(c.req.query("page[number]"), 1);
	const where: string[] = [];
	const params: unknown[] = [];
	if (search) where.push("value LIKE ? ESCAPE '!'"), params.push(`%${search.replace(/[!%_]/g, "!$&")}%`);
	if (type === "email" || type === "domain") where.push("kind = ?"), params.push(type === "email" ? "address" : "domain");
	const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
	const [list, counted] = await c.env.DB.batch([
		c.env.DB.prepare(`SELECT * FROM blocklist ${clause} ORDER BY ${column} ${sort.startsWith("-") ? "DESC" : "ASC"} LIMIT ? OFFSET ?`).bind(...params, size, (pageNumber - 1) * size),
		c.env.DB.prepare(`SELECT COUNT(*) AS total FROM blocklist ${clause}`).bind(...params),
	]);
	const rows = (list?.results ?? []) as BlocklistRow[];
	const total = Number((counted?.results?.[0] as { total?: number } | undefined)?.total ?? 0);
	const lastPage = Math.max(Math.ceil(total / size), 1);
	const from = rows.length ? (pageNumber - 1) * size + 1 : null;
	return c.json({
		data: rows.map(addyBlock),
		links: { first: null, last: null, prev: null, next: null },
		// The iOS app needs links and path whenever meta is present.
		meta: { current_page: pageNumber, from, last_page: lastPage, links: [], path: `${new URL(c.req.url).origin}/api/v1/blocklist`, per_page: size, to: from ? from + rows.length - 1 : null, total },
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
	return c.json({ data: settings.aliasDomains, sharedDomains: [], defaultAliasDomain: settings.aliasDomains[0] ?? "", defaultAliasFormat: settings.randomAliasFormat });
});

api.get("/v1/aliases", async (c) => {
	const deleted = c.req.query("filter[deleted]");
	const active = c.req.query("filter[active]");
	const pinned = c.req.query("filter[pinned]");
	const size = pageSize(c.req.query("page[size]"));
	const page = pageParam(c.req.query("page[number]"), 1);
	const settings = c.get("settings");
	const sort = c.req.query("sort");
	// The apps filter by domain id and recipient id; an unknown one matches nothing.
	const domainId = c.req.query("domain");
	const recipientId = c.req.query("recipient");
	const domain = domainId ? (settings.aliasDomains.find((_, index) => addyDomainId(index) === domainId) ?? "\u0000") : undefined;
	const recipient = recipientId ? (await listDestinations(c.env.DB, settings)).find((d) => d.uid === recipientId) : undefined;
	const { aliases, total } = await listAliasViews(c.env.DB, {
		deleted: deleted === "with" || deleted === "only" ? deleted : "without",
		enabled: active === "true" ? true : active === "false" ? false : undefined,
		pinned: pinned === "true" ? true : pinned === "false" ? false : undefined,
		search: c.req.query("filter[search]")?.slice(0, 200),
		domain,
		destination: recipientId ? (recipient ?? { email: "\u0000", isDefault: false }) : undefined,
		label: c.req.query("filter[label]") || undefined,
		sort: sort ? { key: sort.replace(/^-/, ""), desc: sort.startsWith("-") } : undefined,
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
	const from = aliases.length ? (page - 1) * size + 1 : null;
	return c.json({
		data: await (async () => {
			const labels = await labelsOf(c.env.DB, aliases.map((alias) => alias.address));
			return Promise.all(aliases.map((alias) => addyAlias(c, alias, labels.get(alias.address) ?? [])));
		})(),
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
	const domain = str(input.domain, 253) || settings.aliasDomains[0] || "";
	const format = str(input.format, 40) ?? settings.randomAliasFormat;
	const recipientIds = Array.isArray(input.recipient_ids) ? input.recipient_ids : [];
	const destination = (await resolveDestination(c.env.DB, settings, recipientIds[0] as string | undefined)) ?? null;
	const note = str(input.description) ?? null;
	const alias =
		format === "custom"
			? await createAlias(c.env.DB, settings, { localPart: cleanPrefix(str(input.local_part, 64) ?? ""), domain, note, destination })
			: await createRandomAlias(c.env.DB, settings, { domain, format, note, destination });
	if (Array.isArray(input.label_ids) && input.label_ids.length) await setAliasLabels(c.env.DB, [alias.address], input.label_ids);
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
	if (ids.length && typeof ids[0] !== "string") throw new ClientError(400, "Unknown mailbox");
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

const addyDomain = (domain: string, index: number) => ({
	id: addyDomainId(index),
	user_id: OWNER_ID,
	domain,
	description: null,
	from_name: null,
	aliases_count: 0,
	default_recipient: null,
	active: true,
	catch_all: true,
	shared_with_family: false,
	default_attached_recipients_only: false,
	auto_create_regex: null,
	domain_verified_at: "2000-01-01 00:00:00",
	domain_mx_validated_at: "2000-01-01 00:00:00",
	domain_sending_verified_at: "2000-01-01 00:00:00",
	created_at: "2000-01-01 00:00:00",
	updated_at: "2000-01-01 00:00:00",
});

api.get("/v1/domains", (c) => c.json({ data: c.get("settings").aliasDomains.map(addyDomain) }));

api.get("/v1/domains/:id", (c) => {
	const index = c.get("settings").aliasDomains.findIndex((_, i) => addyDomainId(i) === c.req.param("id"));
	if (index < 0) throw new ClientError(404, "Not found");
	return c.json({ data: addyDomain(c.get("settings").aliasDomains[index]!, index) });
});

// Bulk alias actions from the apps' multiple selection: { ids: [...] } in, { message, ids } out,
// ids being those that were changed.
const BULK_LIMIT = 100;

async function bulkAliases(c: C, includeDeleted: boolean): Promise<{ input: Record<string, unknown>; aliases: AliasView[] }> {
	const input = await body(c);
	const ids = Array.isArray(input.ids) ? input.ids.filter((id): id is string => typeof id === "string").slice(0, BULK_LIMIT) : [];
	if (!ids.length) throw new ClientError(422, "The ids field is required.");
	const aliases: AliasView[] = [];
	for (const id of new Set(ids)) {
		const alias = await getAliasView(c.env.DB, { uid: id });
		if (alias && (includeDeleted || !alias.deleted_at)) aliases.push(alias);
	}
	if (!aliases.length) throw new ClientError(404, "No aliases found");
	return { input, aliases };
}

const bulkDone = (c: C, aliases: AliasView[], verb: string) =>
	c.json({ message: `${aliases.length} alias${aliases.length === 1 ? "" : "es"} ${verb} successfully`, ids: aliases.map((alias) => alias.uid) });

api.post("/v1/aliases/get/bulk", async (c) => {
	const { aliases } = await bulkAliases(c, true);
	const labels = await labelsOf(c.env.DB, aliases.map((alias) => alias.address));
	return c.json({ data: await Promise.all(aliases.map((alias) => addyAlias(c, alias, labels.get(alias.address) ?? []))) });
});

for (const [action, verb, includeDeleted, run] of [
	["activate", "activated", false, (db: D1Database, address: string) => updateAlias(db, address, { enabled: true })],
	["deactivate", "deactivated", false, (db: D1Database, address: string) => updateAlias(db, address, { enabled: false })],
	["pin", "pinned", false, (db: D1Database, address: string) => updateAlias(db, address, { pinned: true })],
	["unpin", "unpinned", false, (db: D1Database, address: string) => updateAlias(db, address, { pinned: false })],
	["delete", "deleted", false, deleteAlias],
	["restore", "restored", true, restoreAlias],
	["forget", "forgotten", true, forgetAlias],
] as const) {
	api.post(`/v1/aliases/${action}/bulk`, async (c) => {
		const { aliases } = await bulkAliases(c, includeDeleted);
		const changed = action === "restore" ? aliases.filter((alias) => alias.deleted_at) : aliases;
		for (const alias of changed) await run(c.env.DB, alias.address);
		return bulkDone(c, changed, verb);
	});
}

api.post("/v1/aliases/recipients/bulk", async (c) => {
	const { input, aliases } = await bulkAliases(c, false);
	const ids = Array.isArray(input.recipient_ids) ? input.recipient_ids : [];
	if (ids.length && typeof ids[0] !== "string") throw new ClientError(400, "Unknown mailbox");
	const destination = ids.length ? await resolveDestination(c.env.DB, c.get("settings"), ids[0] as string) : null;
	for (const alias of aliases) await updateAlias(c.env.DB, alias.address, { destination: destination ?? null });
	return bulkDone(c, aliases, "updated");
});

// aliasflare has no usernames (addy.io's own subdomains; alias domains take their place). The apps
// load the list on start, so it is answered with an empty one; adding one, a domain or a recipient
// is refused: those are set up in aliasflare.
const NOT_SUPPORTED = "Not supported by aliasflare";
api.get("/v1/usernames", (c) => c.json({ data: [] }));
for (const path of ["/v1/usernames", "/v1/domains", "/v1/recipients"]) {
	api.post(path, (c) => c.json({ message: NOT_SUPPORTED, errors: { id: [NOT_SUPPORTED] } }, 422));
}

// ---------- labels ----------

function addyLabel(label: LabelRow, aliasesCount?: number) {
	return {
		id: label.id,
		user_id: OWNER_ID,
		name: label.name,
		colour: label.colour,
		...(aliasesCount === undefined ? {} : { aliases_count: aliasesCount }),
		created_at: addyDate(label.created_at),
		updated_at: addyDate(label.updated_at),
	};
}

const LABEL_ERRORS: Record<LabelError["reason"], [number, string]> = {
	name: [422, "The name field is required."],
	colour: [422, "The colour must be a hex colour such as #1a73e8."],
	taken: [422, "A label with that name already exists."],
	limit: [422, "There are too many labels."],
	missing: [404, "Not found"],
};

async function labelCall<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof LabelError) throw new ClientError(...LABEL_ERRORS[error.reason]);
		throw error;
	}
}

api.get("/v1/labels", async (c) => c.json({ data: (await listLabels(c.env.DB)).map((label) => addyLabel(label, label.aliases)) }));
api.get("/v1/labels/:id", async (c) => {
	const label = (await listLabels(c.env.DB)).find((row) => row.id === c.req.param("id"));
	if (!label) throw new ClientError(404, "Not found");
	return c.json({ data: addyLabel(label, label.aliases) });
});
api.post("/v1/labels", async (c) => {
	const input = await body(c);
	return c.json({ data: addyLabel(await labelCall(() => createLabel(c.env.DB, { name: input.name, colour: input.colour })), 0) }, 201);
});
api.patch("/v1/labels/:id", async (c) => {
	const input = await body(c);
	return c.json({ data: addyLabel(await labelCall(() => updateLabel(c.env.DB, c.req.param("id"), { name: input.name, colour: input.colour }))) });
});
api.delete("/v1/labels/:id", async (c) => {
	if (!(await deleteLabel(c.env.DB, c.req.param("id")))) throw new ClientError(404, "Not found");
	return c.body(null, 204);
});
// Gives each alias exactly these labels; an empty list removes them all.
api.post("/v1/aliases/labels/bulk", async (c) => {
	const { input, aliases } = await bulkAliases(c, false);
	await setAliasLabels(c.env.DB, aliases.map((alias) => alias.address), Array.isArray(input.label_ids) ? input.label_ids : []);
	return bulkDone(c, aliases, "updated");
});

// ---------- rules ----------

type Destinations = Awaited<ReturnType<typeof listDestinations>>;
const ruleDestinations = (c: C): Promise<Destinations> => listDestinations(c.env.DB, c.get("settings"));

// A rule's Forward to is an address here and a recipient id in the apps.
async function addyRule(c: C, rule: Rule, known?: Destinations) {
	const destinations = known ?? (await ruleDestinations(c));
	return {
		id: rule.id,
		user_id: OWNER_ID,
		name: rule.name,
		order: rule.position,
		conditions: rule.conditions,
		actions: rule.actions.map((action) =>
			action.type === "forwardTo" ? { ...action, value: destinations.find((d) => d.email === action.value)?.uid ?? action.value } : action,
		),
		operator: rule.operator,
		forwards: !!rule.forwards,
		replies: !!rule.replies,
		sends: !!rule.sends,
		active: !!rule.active,
		applied: rule.applied,
		last_applied: addyDate(rule.last_applied),
		created_at: addyDate(rule.created_at),
		updated_at: addyDate(rule.updated_at),
	};
}

const RULE_ERRORS: Record<RuleError["reason"], [number, string]> = {
	invalid: [422, "A rule needs a name, a condition and an action aliasflare supports."],
	limit: [422, "There are too many rules."],
	missing: [404, "Not found"],
	forwardTo: [422, "The Forward to recipient is not known."],
	unsupported: [422, "aliasflare cannot apply this rule as given: it supports no regular expressions, webhooks, encryption or description changes, and at most 10 conditions, 20 values in a condition and 200 characters in a value."],
};

/** A rule from an app; its Forward to may stay the address it had, even if no alias uses it any more. */
async function ruleInput(c: C, existing: Rule | null = null) {
	const input = await body(c);
	const destinations = await ruleDestinations(c);
	const kept = existing?.actions.find((action) => action.type === "forwardTo")?.value;
	const actions = (Array.isArray(input.actions) ? input.actions : []).map((action) => {
		if (!action || typeof action !== "object" || (action as { type?: unknown }).type !== "forwardTo") return action;
		const value = (action as { value?: unknown }).value;
		const match = destinations.find((d) => d.uid === value || String(d.numId) === String(value));
		if (match) return { type: "forwardTo", value: match.email };
		if (kept && typeof value === "string" && value.toLowerCase() === kept) return { type: "forwardTo", value: kept };
		throw new ClientError(...RULE_ERRORS.forwardTo);
	});
	try {
		return cleanRule({ ...input, actions });
	} catch (error) {
		if (error instanceof RuleError) throw new ClientError(...RULE_ERRORS[error.reason]);
		throw error;
	}
}

async function ruleCall<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof RuleError) throw new ClientError(...RULE_ERRORS[error.reason]);
		throw error;
	}
}

async function findRule(c: C, id: string): Promise<Rule> {
	const rule = await getRule(c.env.DB, id);
	if (!rule) throw new ClientError(404, "Not found");
	return rule;
}

api.get("/v1/rules", async (c) => {
	const destinations = await ruleDestinations(c);
	return c.json({ data: await Promise.all((await listRules(c.env.DB)).map((rule) => addyRule(c, rule, destinations))) });
});
api.get("/v1/rules/:id", async (c) => c.json({ data: await addyRule(c, await findRule(c, c.req.param("id"))) }));
api.post("/v1/rules", async (c) => {
	const input = await ruleInput(c);
	return c.json({ data: await addyRule(c, await ruleCall(() => createRule(c.env.DB, input))) }, 201);
});
api.patch("/v1/rules/:id", async (c) => {
	const input = await ruleInput(c, await findRule(c, c.req.param("id")));
	return c.json({ data: await addyRule(c, await ruleCall(() => updateRule(c.env.DB, c.req.param("id"), input))) });
});
api.delete("/v1/rules/:id", async (c) => {
	if (!(await deleteRule(c.env.DB, c.req.param("id")))) throw new ClientError(404, "Not found");
	return c.body(null, 204);
});
api.post("/v1/active-rules", async (c) => {
	const id = str((await body(c)).id, 64) ?? "";
	if (!(await setRuleActive(c.env.DB, id, true))) throw new ClientError(404, "Not found");
	return c.json({ data: await addyRule(c, await findRule(c, id)) });
});
api.delete("/v1/active-rules/:id", async (c) => {
	if (!(await setRuleActive(c.env.DB, c.req.param("id"), false))) throw new ClientError(404, "Not found");
	return c.body(null, 204);
});
api.post("/v1/reorder-rules", async (c) => {
	const ids = (await body(c)).ids;
	await reorderRules(c.env.DB, Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string").slice(0, 100) : []);
	return c.json({ success: true });
});

// ---------- failed deliveries ----------

// Forwards that could not be sent. No copy is kept, so one cannot be downloaded or sent again.
// Deleting one only hides it here: the row is also the forward's retry record and its activity
// entry, so a redelivery of the same message does not start its attempts over.
type FailedRow = { id: string; alias_address: string; error: string | null; created_at: number; updated_at: number; alias_uid: string | null; alias_note: string | null; sender: string | null };

const FAILED_SELECT = `SELECT f.id, f.alias_address, f.error, f.created_at, f.updated_at, a.uid AS alias_uid, a.note AS alias_note, ct.email AS sender
	FROM forwards f LEFT JOIN aliases a ON a.address = f.alias_address LEFT JOIN contacts ct ON ct.id = f.contact_id WHERE f.status = 'failed' AND f.dismissed = 0`;

function addyFailed(row: FailedRow) {
	return {
		id: row.id,
		user_id: OWNER_ID,
		recipient_id: null,
		recipient_email: null,
		alias_id: row.alias_uid,
		alias_email: row.alias_address,
		alias_description: row.alias_note,
		bounce_type: "soft",
		remote_mta: "",
		sender: row.sender,
		destination: null,
		ir_dedupe_key: null,
		type: "failed",
		email_type: "F",
		email_type_text: "Forward",
		status: "failed",
		code: (row.error ?? "").slice(0, 500),
		is_stored: false,
		quarantined: false,
		resent: false,
		attempted_at: addyDate(row.updated_at),
		created_at: addyDate(row.created_at),
		updated_at: addyDate(row.updated_at),
	};
}

api.get("/v1/failed-deliveries", async (c) => {
	const size = pageSize(c.req.query("page[size]"));
	const pageNumber = pageParam(c.req.query("page[number]"), 1);
	const [list, counted] = await c.env.DB.batch([
		c.env.DB.prepare(`${FAILED_SELECT} ORDER BY f.created_at DESC LIMIT ? OFFSET ?`).bind(size, (pageNumber - 1) * size),
		c.env.DB.prepare("SELECT COUNT(*) AS total FROM forwards WHERE status = 'failed' AND dismissed = 0"),
	]);
	const rows = (list?.results ?? []) as FailedRow[];
	const total = Number((counted?.results?.[0] as { total?: number } | undefined)?.total ?? 0);
	const from = rows.length ? (pageNumber - 1) * size + 1 : null;
	const url = new URL(c.req.url);
	const lastPage = Math.max(1, Math.ceil(total / size));
	const pageUrl = (n: number) => {
		const next = new URL(url);
		next.searchParams.set("page[number]", String(n));
		return next.toString();
	};
	return c.json({
		data: rows.map(addyFailed),
		links: { first: pageUrl(1), last: pageUrl(lastPage), prev: pageNumber > 1 ? pageUrl(pageNumber - 1) : null, next: pageNumber < lastPage ? pageUrl(pageNumber + 1) : null },
		meta: { current_page: pageNumber, from, last_page: lastPage, links: [], path: `${url.origin}${url.pathname}`, per_page: size, to: from ? from + rows.length - 1 : null, total },
	});
});
api.get("/v1/failed-deliveries/:id", async (c) => {
	const row = await c.env.DB.prepare(`${FAILED_SELECT} AND f.id = ?`).bind(c.req.param("id")).first<FailedRow>();
	if (!row) throw new ClientError(404, "Not found");
	return c.json({ data: addyFailed(row) });
});
api.delete("/v1/failed-deliveries/:id", async (c) => {
	const result = await c.env.DB.prepare("UPDATE forwards SET dismissed = 1 WHERE id = ? AND status = 'failed' AND dismissed = 0").bind(c.req.param("id")).run();
	if (!result.meta.changes) throw new ClientError(404, "Not found");
	return c.body(null, 204);
});
for (const path of ["/v1/failed-deliveries/:id/resend", "/v1/failed-deliveries/:id/download"]) {
	api.all(path, (c) => c.json({ message: "aliasflare keeps no copy of a message that failed, so it cannot be sent again or downloaded." }, 422));
}

api.all("*", (c) => c.json({ error: "Not supported by aliasflare", message: "Not Found" }, 404));

