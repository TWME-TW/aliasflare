import { listPgpKeys, PgpError, readPublicKey, savePgpKey, syncPgpRecipients } from "./pgp";
import { lookupWkdKey, readWkdKey, saveWkdKey, WKD_SUBDOMAIN, WkdError, wkdKeyOf } from "./wkd";
import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { html } from "hono/html";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import {
	endSession,
	isSignedIn,
	LIVE_SESSION,
	recentlyVerified,
	sessionId,
	claimedSessionId,
	requireAdmin,
	sameOrigin,
	setChallengeCookie,
	startSession,
	takeChallengeCookie,
	type AppEnv,
} from "./auth";
import { APP_SCRIPT, PASSKEY_SCRIPT } from "./client";
import { createApiKey, deleteApiKey, listApiKeys } from "./apikeys";
import { mailGateway } from "./mail-gateway";
import { createMailPassword, deleteMailPassword, listMailPasswords } from "./mail-passwords";
import { mcp } from "./mcp";
import { setUpCloudflare, type DomainSetup } from "./cloudflare";
import { api, apiThrottled } from "./compat/api";
import { ClientError, cleanPrefix, createAlias, createRandomAlias, forgetStatements, listDestinations } from "./compat/aliases";
import { ConfigError, DOMAIN_PATTERN, envOverrides, isWorkersPlan, loadConfig, mailflareReady, missingConnection, ownHosts, saveConfig, validOrigin, WORKER_NAME_PATTERN, type AppConfig } from "./config";
import { customValues, fillTemplate, isOutboundProvider, normalizeOutboundOptions, parseHeaderLines, SES_REGION, type OutboundOptions } from "./outbound";
import { aliasDomainOfReverse, clashingDomain, contactReverseAddress, isOwnAddress } from "./domains";
import { verifyWebhookSignature } from "./crypto";
import { ensureContact, getAlias, isForwardMode, newId, now, setForwardMode, type AliasRow, type BlocklistRow, type ContactRow } from "./db";
import { domainOf, extractEmail, hostnameOf, isPublicHost, MAX_NOTE_LENGTH, normalizeEmail, pageParam } from "./format";
import { handleDirectInbound, handleInbound, resendMailboxMessage, type InboundEvent } from "./forward";
import {
	deleteMailboxMessage,
	emptyMailboxFolder,
	folderStats,
	getMailboxMessage,
	isMailboxFolder,
	listMailboxMessages,
	moveMailboxMessage,
	readMailboxRaw,
	storeMailboxMessage,
	updateMailboxFlags,
	type MailboxFolder,
} from "./mailbox";
import { mailboxComposePage, mailboxDetailPage, mailboxListPage } from "./mailbox-ui";
import { listMailflareEmails, mailflareConfig, sendViaMailflare } from "./mailflare";
import { buildMime, newMessageId } from "./mime";
import { sendOutbound } from "./outbound";
import { resolveStorageBackend, validS3Endpoint } from "./storage";
import PostalMime from "postal-mime";
import { exportAliases } from "./export";
import {
	addSimpleLoginContacts,
	newFetchBudget,
	defaultImportDomains,
	detectCustomDomains,
	fetchAddy,
	fetchAddyExtras,
	importAddyExtras,
	type AddyExtras,
	fetchSimpleLogin,
	ImportError,
	importAliases,
	parseAliasCsv,
	selectByDomain,
	type ImportedAlias,
	type Selection,
} from "./importer";
import { isErrorNoticeKey, isLocale, isNoticeKey, isTheme, LANG_COOKIE, loadLocale, negotiateLocale, THEME_COOKIE, translator, type MessageKey } from "./i18n";
import {
	authenticationOptions,
	checkSetupCode,
	completeAuthentication,
	completeRegistration,
	hasPasskeys,
	issueSetupCode,
	listPasskeys,
	registrationOptions,
	relyingParty,
} from "./passkeys";
import { deviceLabel, listSessions, sessionHandle } from "./sessions";
import { handleReverseAliasMail } from "./reply";
import { createLabel, deleteLabel, LabelError, labelsOf, listLabels, MAX_LABELS, setAliasLabels, toggleAliasLabels, updateLabel } from "./labels";
import { cleanRule, createRule, deleteRule, getRule, listRules, MAX_CONDITIONS, MAX_RULES, MAX_VALUE_LENGTH, MAX_VALUES, moveRule, RuleError, setRuleActive, updateRule, webhookKey, type Rule } from "./rules";
import { isRandomAliasFormat, loadSettings, MAX_ALIAS_DOMAINS, normalizeSettings, saveSettingKeys, settingsFromRows, type Settings } from "./settings";
import {
	aliasPage,
	apiKeysPage,
	blocklistPage,
	encryptionPage,
	labelsPage,
	ruleEditPage,
	rulesPage,
	connectionPage,
	dashboardPage,
	FAVICON_SVG,
	STYLE,
	importPage,
	loginPage,
	mailboxSettingsPage,
	messagePage,
	onboardingPage,
	passkeysPage,
	settingsPage,
	setupPage,
	ALIAS_PAGE_SIZES,
	activityListPage,
	DEFAULT_ACTIVITY_PAGE_SIZE,
	DEFAULT_ALIAS_PAGE_SIZE,
	type ActivityItem,
	type Notice,
} from "./ui";
import { readLimited, readTextLimited } from "./streams";
import { clientKey } from "./ratelimit";
import { cleanUp } from "./cleanup";
import { claimLink, describeAction, isLinkUsed, performAction, releaseLink, resolveLink, safeHttpsUrl } from "./unsubscribe";

const MAX_WEBHOOK_BYTES = 64 * 1024;
const MAX_JSON_BYTES = 32 * 1024;

const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
	await next();
	c.header("X-Content-Type-Options", "nosniff");
	c.header("Referrer-Policy", "same-origin");
	c.header("X-Frame-Options", "DENY");
	if (new URL(c.req.url).protocol === "https:") c.header("Strict-Transport-Security", "max-age=31536000");
	if (NO_STORE.test(c.req.path)) c.header("Cache-Control", "no-store");
	if (!c.res.headers.has("Content-Security-Policy")) {
		c.header(
			"Content-Security-Policy",
			"default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self'; frame-src 'self'; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
		);
	}
});

/** A CSV import of at most 5 MB, with room for the rest of the form. */
const MAX_IMPORT_UPLOAD = 5_100_000;

/** Pages that show addresses, codes or one-time links, which no cache should keep. */
const NO_STORE = /^\/(?:unsubscribe|action|setup|login)(?:\/|$)/;

/** Static files: they need neither the configuration (a D1 read) nor a language. */
const STATIC_PATHS = new Set(["/assets/passkey.js", "/assets/app.js", "/assets/app.css", "/favicon.svg"]);
/** Paths allowed on a dedicated WKD host (openpgpkey.<aliasDomain>): advanced WKD lookups only. */
const WKD_ADVANCED_PATH = /^\/\.well-known\/openpgpkey\/[^/]+\/(?:hu\/[^/]+|policy)$/;
const normalizeHost = (value: string) => value.toLowerCase().replace(/\.$/, "");
/** A year, for a versioned asset URL; an unversioned one is kept briefly so a deploy shows soon. */
const assetCache = (c: C) => (c.req.query("v") ? "public, max-age=31536000, immutable" : "public, max-age=300");

app.use("*", async (c, next) => {
	const reqHost = normalizeHost(new URL(c.req.url).hostname);
	// Never bypass WKD host isolation on openpgpkey.<domain> for static assets.
	if ((c.req.method === "GET" || c.req.method === "HEAD") && STATIC_PATHS.has(c.req.path) && !reqHost.startsWith(`${WKD_SUBDOMAIN}.`)) return next();
	const chosen = getCookie(c, LANG_COOKIE);
	const chosenTheme = getCookie(c, THEME_COOKIE);
	const locale = await loadLocale(isLocale(chosen) ? chosen : negotiateLocale(c.req.header("Accept-Language")));
	c.set("t", translator(locale, isTheme(chosenTheme) ? chosenTheme : "system"));
	// The client APIs and public endpoints are open to anyone with the URL: their limits come before any D1 read.
	if (c.req.path === "/api" || c.req.path.startsWith("/api/") || c.req.path === "/mcp" || c.req.path.startsWith("/mcp/")) {
		if (!(c.req.method === "OPTIONS" && (c.req.path === "/api" || c.req.path.startsWith("/api/")))) {
			const throttled = await apiThrottled(c.env, c.req.header("CF-Connecting-IP"));
			if (throttled) return throttled;
		}
	} else if (c.env.API_RATE_LIMIT) {
		const client = clientKey(c.req.header("CF-Connecting-IP"));
		if (!(await c.env.API_RATE_LIMIT.limit({ key: `pub:${client}` })).success) {
			return c.text(c.get("t")("err.rateLimited"), 429);
		}
	}
	try {
		// One D1 round trip for what nearly every page needs: the configuration, the settings and
		// whether the session the cookie names is still live (its signature is checked later).
		const db = c.env.DB;
		const claimed = claimedSessionId(c);
		const reads = [db.prepare("SELECT key, value FROM config"), db.prepare("SELECT key, value FROM settings")];
		if (claimed) reads.push(db.prepare(LIVE_SESSION).bind(claimed, now()));
		const [config, settings, session] = await db.batch<{ key: string; value: string }>(reads);
		const loadedConfig = await loadConfig(c.env, config!.results);
		const loadedSettings = settingsFromRows(settings!.results);
		c.set("config", loadedConfig);
		c.set("settings", loadedSettings);
		const row = session?.results[0] as { seen?: number | null; verified?: number | null } | undefined;
		if (claimed) c.set("session", { id: claimed, live: !!row, seen: row?.seen ?? null, verified: row?.verified ?? null });
		// A WKD host (openpgpkey.<aliasDomain>) is routed here only to serve public keys: keep the
		// dashboard, login, health, assets, API, MCP, webhook and non-WKD paths off it so alias domains are not linked.
		const publicHost = loadedConfig.publicUrl ? normalizeHost(hostnameOf(loadedConfig.publicUrl) ?? "") : "";
		if (
			reqHost !== publicHost &&
			loadedSettings.aliasDomains.some((domain) => reqHost === `${WKD_SUBDOMAIN}.${domain}`) &&
			!((c.req.method === "GET" || c.req.method === "HEAD") && WKD_ADVANCED_PATH.test(c.req.path))
		) {
			return c.text("Not found", 404);
		}
	} catch (error) {
		if (!(error instanceof ConfigError)) throw error;
		console.error("Configuration error:", error.message);
		return c.text(`aliasflare cannot start: ${error.message}. Fix the Worker's variables or secrets and deploy again.`, 500);
	}
	await next();
});

type C = Context<AppEnv>;

/** The settings for showing a page: read at the start of a GET request, or read now after a change. */
async function pageSettings(c: C): Promise<Settings> {
	const early = c.req.method === "GET" ? c.get("settings") : undefined;
	return early ?? loadSettings(c.env.DB);
}

const MAX_FORM_BYTES = 512 * 1024;

app.onError((error, c) => {
	console.error("Unhandled request error:", error instanceof Error ? error.message : error);
	return c.text("Internal error", 500);
});

/** A body parsed as a form (urlencoded or multipart). */
const FORM_TYPES = /^(?:application\/x-www-form-urlencoded|multipart\/form-data)\b/i;

/**
 * Dashboard form POSTs. The body is read here, up to MAX_FORM_BYTES whatever Content-Length says
 * (a chunked body has none, and parseBody() would buffer it whole before any check). It is parsed
 * once here as well: a malformed form answers 400 instead of reaching the error handler as a 500,
 * and parseBody() then reads the parsed form rather than the body again.
 */
export async function readFormBody(c: C, next: () => Promise<void>): Promise<Response | void> {
	const path = c.req.path;
	const contentType = c.req.header("Content-Type") ?? "";
	if (
		c.req.method === "POST" &&
		!path.startsWith("/import/") &&
		!path.startsWith("/onboarding/import/") &&
		path !== "/api" &&
		!path.startsWith("/api/") &&
		path !== "/mcp" &&
		!path.startsWith("/mcp/") &&
		path !== "/webhook" &&
		FORM_TYPES.test(contentType)
	) {
		if (Number(c.req.header("Content-Length") ?? 0) > MAX_FORM_BYTES) {
			await c.req.raw.body?.cancel().catch(() => undefined);
			return c.text("Request too large", 413);
		}
		const bytes = await readLimited(c.req.raw.body, MAX_FORM_BYTES);
		if (bytes === null) return c.text("Request too large", 413);
		const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
		// The same bytes stand in for the body of the request the handlers read (/lang and /theme
		// read it as text), and as the parsed form parseBody() answers with. Cloudflare puts `cf` on
		// the request itself (the country a session records, say), and a new Request drops it.
		const cf = (c.req.raw as { cf?: unknown }).cf;
		c.req.raw = new Request(c.req.raw, { body: buffer, duplex: "half" } as RequestInit);
		if (cf !== undefined) Object.defineProperty(c.req.raw, "cf", { value: cf });
		let form: FormData;
		try {
			form = await new Response(buffer, { headers: { "Content-Type": contentType } }).formData();
		} catch {
			return c.text("Malformed form", 400);
		}
		// Hono types this cache as the parsed values but reads promises from it (see parseBody()).
		c.req.bodyCache.formData = Promise.resolve(form) as unknown as FormData;
	}
	return next();
}

app.use("*", readFormBody);

/**
 * A URL that shows a notice once at the top of the page. Only the message key and its
 * values travel in the URL, so a crafted link cannot put text of its own on the page.
 */
function noticeUrl(path: string, key: MessageKey, params?: Record<string, string>): string {
	const base = path.split("#")[0] || "/";
	const query = new URLSearchParams({ notice: key });
	for (const [name, value] of Object.entries(params ?? {})) query.set(`n.${name}`, value);
	return `${base}${base.includes("?") ? "&" : "?"}${query}`;
}

/** Where a change to one alias returns: its own page when made there, else the alias list. */
function aliasBack(form: Record<string, unknown>, address: string): string {
	return form.back === "alias" ? `/aliases/${encodeURIComponent(address)}` : "/";
}

function redirectWithNotice(c: C, path: string, key: MessageKey, params?: Record<string, string>) {
	return c.redirect(noticeUrl(path, key, params));
}

/** The notice as JSON for a form saved in place (X-Autosave), otherwise a redirect that shows it. */
function savedNotice(c: C, path: string, key: MessageKey, ok: boolean, params?: Record<string, string>) {
	if (c.req.header("X-Autosave") === "1") return c.json({ ok, message: c.get("t")(key, params) }, ok ? 200 : 400);
	return redirectWithNotice(c, path, key, params);
}

/** The notice named in the URL, translated, or nothing for an unknown key. */
function noticeFrom(c: C): Notice | undefined {
	const key = c.req.query("notice");
	if (!isNoticeKey(key)) return undefined;
	const params: Record<string, string> = {};
	for (const [name, value] of Object.entries(c.req.query())) if (name.startsWith("n.")) params[name.slice(2)] = value.slice(0, 200);
	// Values come from this site's redirects. A link from elsewhere (Sec-Fetch-Site is
	// cross-site or none) could put its own words into them, so such a notice is not shown.
	if (Object.keys(params).length && c.req.header("Sec-Fetch-Site") !== "same-origin") return undefined;
	return { text: c.get("t")(key, params), bad: isErrorNoticeKey(key) };
}

function publicOrigin(c: C): string {
	return c.get("config").publicUrl || new URL(c.req.url).origin;
}

async function readJson<T>(c: C): Promise<T | null> {
	const text = await readTextLimited(c.req.raw, MAX_JSON_BYTES);
	if (text === null) return null;
	try {
		return JSON.parse(text || "{}") as T;
	} catch {
		return null;
	}
}

async function rateLimited(c: C, bucket: "auth" | "ui" | "link" = "auth"): Promise<boolean> {
	const key = `${bucket}:${clientKey(c.req.header("CF-Connecting-IP"))}`;
	return !!c.env.LOGIN_RATE_LIMIT && !(await c.env.LOGIN_RATE_LIMIT.limit({ key })).success;
}

const jsonError = (c: C, key: MessageKey, status: 400 | 401 | 403 | 409 | 429) => c.json({ error: c.get("t")(key) }, status);

// Public on purpose, for uptime monitors: it tells only whether setup is complete, nothing else.
app.get("/health", async (c) => c.json({ ok: missingConnection(c.get("settings") ?? (await loadSettings(c.env.DB))).length === 0 }));

// ---------- Web Key Directory (public: senders' apps look keys up here) ----------

/** The alias domain a WKD request is for, from its host: openpgpkey.<domain> (advanced) or <domain> (direct). */
function wkdDomain(c: C, named?: string): string | null {
	const host = normalizeHost(new URL(c.req.url).hostname);
	const domains = c.get("settings")?.aliasDomains ?? [];
	if (named !== undefined) {
		const domain = named.toLowerCase();
		return host === `${WKD_SUBDOMAIN}.${domain}` && domains.includes(domain) ? domain : null;
	}
	return domains.includes(host) ? host : null;
}

async function wkdKey(c: C, domain: string | null, hash: string): Promise<Response> {
	c.header("Access-Control-Allow-Origin", "*");
	if (!domain || !/^[ybndrfg8ejkmcpqxot1uwisza345h769]{32}$/.test(hash)) return c.text("Not found", 404);
	const key = await lookupWkdKey(c.env.DB, domain, hash);
	if (!key) return c.text("Not found", 404);
	c.header("Cache-Control", "public, max-age=3600");
	return c.body(key as Uint8Array<ArrayBuffer>, 200, { "Content-Type": "application/octet-stream" });
}

function wkdPolicy(c: C, domain: string | null): Response {
	c.header("Access-Control-Allow-Origin", "*");
	return domain ? c.body("", 200, { "Content-Type": "text/plain" }) : c.text("Not found", 404);
}

app.get("/.well-known/openpgpkey/:domain/hu/:hash", (c) => wkdKey(c, wkdDomain(c, c.req.param("domain")), c.req.param("hash")));
app.get("/.well-known/openpgpkey/:domain/policy", (c) => wkdPolicy(c, wkdDomain(c, c.req.param("domain"))));
app.get("/.well-known/openpgpkey/hu/:hash", (c) => wkdKey(c, wkdDomain(c), c.req.param("hash")));
app.get("/.well-known/openpgpkey/policy", (c) => wkdPolicy(c, wkdDomain(c)));

app.get("/assets/passkey.js", (c) => {
	c.header("Cache-Control", assetCache(c));
	return c.body(PASSKEY_SCRIPT, 200, { "Content-Type": "text/javascript; charset=utf-8" });
});

app.get("/favicon.svg", (c) => {
	c.header("Cache-Control", "public, max-age=86400");
	return c.body(FAVICON_SVG, 200, { "Content-Type": "image/svg+xml" });
});

app.get("/assets/app.css", (c) => {
	c.header("Cache-Control", assetCache(c));
	return c.body(String(STYLE), 200, { "Content-Type": "text/css; charset=utf-8" });
});

app.get("/assets/app.js", (c) => {
	c.header("Cache-Control", assetCache(c));
	return c.body(APP_SCRIPT, 200, { "Content-Type": "text/javascript; charset=utf-8" });
});

/**
 * A path on this site to redirect to, or "/". Control characters and backslashes are
 * refused outright, since browsers drop or rewrite them and "/\t/evil.example" would
 * otherwise become "//evil.example". A path that only becomes "//evil.example" once the URL
 * parser has resolved its dot segments ("/..//evil.example") is refused too: a browser reads
 * a Location starting with "//" as another site.
 */
export function safeLocalPath(value: string | undefined | null): string {
	if (!value || !value.startsWith("/") || /[\x00-\x1f\x7f\\]/.test(value)) return "/";
	try {
		const parsed = new URL(value, "https://local.invalid");
		if (parsed.origin !== "https://local.invalid" || parsed.pathname.startsWith("//")) return "/";
		return `${parsed.pathname}${parsed.search}${parsed.hash}`;
	} catch {
		return "/";
	}
}

// A POST from this site only: another site cannot switch the dashboard's language.
app.post("/lang", async (c) => {
	if (!sameOrigin(c)) return c.text(c.get("t")("err.crossSite"), 403);
	if (await rateLimited(c, "ui")) return c.text(c.get("t")("err.rateLimited"), 429);
	const raw = await readTextLimited(c.req.raw, 4096);
	if (raw === null) return c.text("Payload too large", 413);
	const params = new URLSearchParams(raw);
	const locale = params.get("locale");
	if (isLocale(locale)) {
		setCookie(c, LANG_COOKIE, locale, { path: "/", httpOnly: true, secure: true, sameSite: "Lax", maxAge: 60 * 60 * 24 * 365 });
	}
	return c.redirect(safeLocalPath(params.get("next")), 303);
});

// Light / dark / system theme preference stored in a browser cookie (same-origin POST only).
app.post("/theme", async (c) => {
	if (!sameOrigin(c)) return c.text(c.get("t")("err.crossSite"), 403);
	if (await rateLimited(c, "ui")) return c.text(c.get("t")("err.rateLimited"), 429);
	const raw = await readTextLimited(c.req.raw, 4096);
	if (raw === null) return c.text("Payload too large", 413);
	const params = new URLSearchParams(raw);
	const theme = params.get("theme");
	if (isTheme(theme)) {
		setCookie(c, THEME_COOKIE, theme, { path: "/", httpOnly: true, secure: true, sameSite: "Lax", maxAge: 60 * 60 * 24 * 365 });
	}
	if (c.req.header("X-Theme") === "1") return c.json({ ok: true, theme: isTheme(theme) ? theme : c.get("t").theme ?? "system" });
	return c.redirect(safeLocalPath(params.get("next")), 303);
});

// SimpleLogin and addy.io client APIs (off until enabled in Settings).
app.route("/api", api);

// MCP server for AI assistants (off until enabled in Settings; its own API keys).
app.route("/mcp", mcp);

// Mail Gateway API for the IMAP / POP3 / SMTP Bridge (off per protocol until enabled in Settings; Mail App Passwords).
app.route("/mail-api/v1", mailGateway);

// Mailflare webhook: message.inbound → forward to the alias's destination.
app.post("/webhook", async (c) => {
	const config = c.get("config");
	if (!mailflareReady(config)) return c.json({ error: "Mailflare is not configured" }, 503);
	const body = await readTextLimited(c.req.raw, MAX_WEBHOOK_BYTES);
	if (body === null) return c.json({ error: "Payload too large" }, 413);
	if (!(await verifyWebhookSignature(config.webhookSecret, body, c.req.header("X-Email-Platform-Signature") ?? null))) {
		return c.json({ error: "Invalid signature" }, 401);
	}
	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		return c.json({ error: "Invalid JSON" }, 400);
	}
	const event = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as { type?: unknown; data?: unknown }) : null;
	if (!event || event.type !== "message.inbound" || !event.data || typeof event.data !== "object" || Array.isArray(event.data)) {
		return c.json({ result: "ignored" });
	}
	const data = event.data as Record<string, unknown>;
	if (
		typeof data.messageId !== "string" ||
		(data.to !== undefined && typeof data.to !== "string") ||
		(data.from !== undefined && typeof data.from !== "string") ||
		(data.subject !== undefined && typeof data.subject !== "string")
	) {
		return c.json({ error: "Invalid webhook payload" }, 400);
	}
	const outcome = await handleInbound(c.env, config, data as unknown as InboundEvent, publicOrigin(c));
	return c.json({ result: outcome.result }, outcome.status as 200);
});

// Signed links in forwarded mail. GET only shows a confirmation, so link scanners change
// nothing; the change happens on POST (RFC 8058 one-click unsubscribe, or the button).
// Each link works once: a link that leaks, say in a quoted reply, cannot be replayed.
for (const kind of ["unsubscribe", "action"] as const) {
	const invalid = (c: C) => {
		const t = c.get("t");
		return c.html(messagePage(t, t("link.invalidTitle"), html`<p>${t("link.invalid")}</p>`, c.req.path), 404);
	};
	const resolve = (c: C) => resolveLink(c.env, c.get("config"), kind, c.req.param("token") ?? "", [new URL(c.req.url).hostname]);
	app.get(`/${kind}/:token`, async (c) => {
		const t = c.get("t");
		const target = await resolve(c);
		if (!target) return invalid(c);
		if (await isLinkUsed(c.env.DB, target.token)) {
			return c.html(messagePage(t, t("link.done"), html`<p>${t("link.used")}</p>`, c.req.path));
		}
		const title = kind === "unsubscribe" ? t("link.unsubscribe") : target.action === "disable_alias" ? t("link.disable") : t("link.block");
		const nothingToRun = target.action === "preserve_original" && !target.plan && target.fallback === "none";
		return c.html(
			messagePage(
				t,
				title,
				nothingToRun
					? html`<p>${describeAction(target, t)}</p>`
					: html`<p>${describeAction(target, t)}</p><form method="post"><button class="primary">${title}</button></form>`,
				c.req.path,
			),
		);
	});
	app.post(`/${kind}/:token`, async (c) => {
		const t = c.get("t");
		// The one-click unsubscribe POST comes from mail providers' servers, without an Origin;
		// the banner buttons are only ever pressed on this site's own confirmation page.
		if (kind === "action" && !sameOrigin(c)) return c.text(t("err.crossSite"), 403);
		if (await rateLimited(c, "link")) return c.text(t("err.rateLimited"), 429);
		const target = await resolve(c);
		if (!target) return invalid(c);
		if (!(await claimLink(c.env.DB, target.token))) {
			return c.html(messagePage(t, t("link.done"), html`<p>${t("link.used")}</p>`, c.req.path));
		}
		let done;
		try {
			({ done } = await performAction(c.env, c.get("config"), target));
		} catch (error) {
			await releaseLink(c.env.DB, target.token);
			console.error("Link action failed", kind, error instanceof Error ? error.message : error);
			return c.html(messagePage(t, t("link.error"), html`<p>${t("link.tryAgain")}</p>`, c.req.path), 500);
		}
		// What actually happened: a block, when the sender's own unsubscribe could not be run.
		return c.html(messagePage(t, t("link.done"), html`<p>${describeAction(done, t)}</p>`, c.req.path));
	});
}

// First run: register the first passkey with the one-time setup code.
app.get("/setup", async (c) => {
	if (await hasPasskeys(c.env.DB)) return c.redirect("/login");
	const codeInLogs = !c.env.SETUP_CODE?.trim();
	if (codeInLogs) await issueSetupCode(c.env.DB);
	return c.html(setupPage(c.get("t"), { codeInLogs, notice: noticeFrom(c) }));
});

// Writes a fresh setup code to the logs, for whoever started watching them after the first one.
app.post("/setup/code", async (c) => {
	if (!sameOrigin(c)) return c.text(c.get("t")("err.crossSite"), 403);
	if (await rateLimited(c)) return c.text(c.get("t")("err.rateLimited"), 429);
	if (await hasPasskeys(c.env.DB)) return c.redirect("/login");
	if (c.env.SETUP_CODE?.trim()) return c.redirect("/setup");
	if (!(await issueSetupCode(c.env.DB, true)).created) return redirectWithNotice(c, "/setup", "notice.setupCodeWait");
	return redirectWithNotice(c, "/setup", "notice.setupCodeIssued");
});

app.post("/setup/options", async (c) => {
	if (!sameOrigin(c)) return jsonError(c, "err.crossSite", 403);
	if (await rateLimited(c)) return jsonError(c, "err.rateLimited", 429);
	if (await hasPasskeys(c.env.DB)) return jsonError(c, "err.setupDone", 409);
	const body = await readJson<{ code?: unknown }>(c);
	if (typeof body?.code !== "string" || !body.code || !(await checkSetupCode(c.env, body.code))) return jsonError(c, "err.badCode", 401);
	const { options, challengeId } = await registrationOptions(c.env.DB, relyingParty(c.req.url), "setup_register");
	setChallengeCookie(c, challengeId);
	return c.json({ options });
});

app.post("/setup/verify", async (c) => {
	if (!sameOrigin(c)) return jsonError(c, "err.crossSite", 403);
	if (await rateLimited(c)) return jsonError(c, "err.rateLimited", 429);
	if (await hasPasskeys(c.env.DB)) return jsonError(c, "err.setupDone", 409);
	const body = await readJson<{ response?: RegistrationResponseJSON; name?: unknown }>(c);
	if (!body?.response) return jsonError(c, "err.missingResponse", 400);
	const passkey = await completeRegistration(
		c.env.DB,
		relyingParty(c.req.url),
		takeChallengeCookie(c),
		body.response,
		typeof body.name === "string" ? body.name : "",
		"setup_register",
	).catch((error) => {
		console.warn("Setup passkey registration failed:", error instanceof Error ? error.message : error);
		return null;
	});
	if (!passkey) return jsonError(c, "err.registerFailed", 400);
	await c.env.DB.prepare("DELETE FROM auth_challenges WHERE purpose = 'setup'").run();
	// The language picked during setup also becomes the language of forwarded-mail banners.
	await saveSettingKeys(c.env.DB, { language: c.get("t").locale });
	await startSession(c, passkey.id);
	return c.json({ ok: true });
});

app.get("/login", async (c) => {
	if (!(await hasPasskeys(c.env.DB))) return c.redirect("/setup");
	if (await isSignedIn(c)) return c.redirect("/");
	return c.html(loginPage(c.get("t")));
});

app.post("/login/options", async (c) => {
	if (!sameOrigin(c)) return jsonError(c, "err.crossSite", 403);
	if (await rateLimited(c)) return jsonError(c, "err.rateLimited", 429);
	const { options, challengeId } = await authenticationOptions(c.env.DB, relyingParty(c.req.url));
	setChallengeCookie(c, challengeId);
	return c.json({ options });
});

app.post("/login/verify", async (c) => {
	if (!sameOrigin(c)) return jsonError(c, "err.crossSite", 403);
	if (await rateLimited(c)) return jsonError(c, "err.rateLimited", 429);
	const body = await readJson<{ response?: AuthenticationResponseJSON }>(c);
	if (!body?.response) return jsonError(c, "err.missingResponse", 400);
	const passkey = await completeAuthentication(c.env.DB, relyingParty(c.req.url), takeChallengeCookie(c), body.response).catch((error) => {
		console.warn("Passkey authentication failed:", error instanceof Error ? error.message : error);
		return null;
	});
	if (!passkey) return jsonError(c, "err.loginFailed", 401);
	await startSession(c, passkey.id);
	return c.json({ ok: true });
});

app.post("/logout", async (c) => {
	if (!sameOrigin(c)) return c.text(c.get("t")("err.crossSite"), 403);
	if (await rateLimited(c, "ui")) return c.text(c.get("t")("err.rateLimited"), 429);
	await endSession(c);
	return c.redirect("/login");
});

// Everything registered below is the dashboard and needs a signed-in passkey session (and a
// same-origin request for changes). The public routes above return before this runs, so a new
// dashboard route is protected without being listed anywhere.
app.use("*", requireAdmin);

app.use("*", async (c, next) => {
	const config = c.get("config");
	const origin = new URL(c.req.url).origin;
	if (!config.publicUrl && c.req.method === "GET" && config.siteOrigin !== origin && validOrigin(origin)) {
		await saveConfig(c.env.DB, { siteOrigin: origin });
		c.set("config", { ...config, siteOrigin: origin });
	}
	await next();
});

/** Entries of recent activity on the alias list; the rest are on the activity page. */
/** Alias domains one Cloudflare setup run may handle on the Workers Free plan. */
const FREE_PLAN_SETUP_DOMAINS = 2;
const DASHBOARD_ACTIVITY = 10;

/**
 * Forwards and other events, newest first. Without a search term, both halves read an index
 * in time order (forwards_updated_idx, events_created_idx), so a page never sorts the whole history.
 */
async function activityPage(db: D1Database, limit: number, offset: number, query = ""): Promise<ActivityItem[]> {
	if (!query) {
		const { results } = await db
			.prepare(
				`SELECT 'forward' AS kind, status, alias_address AS alias,
					CASE WHEN error IS NOT NULL THEN error
						WHEN trackers_removed > 0 THEN COALESCE(subject, '') || ' · ' || trackers_removed || ' tracker(s)'
						ELSE subject END AS detail,
					updated_at AS at FROM forwards
				UNION ALL
				SELECT kind, status, alias_address AS alias, detail, created_at AS at FROM events
				ORDER BY at DESC LIMIT ? OFFSET ?`,
			)
			.bind(limit, offset)
			.all<ActivityItem>();
		return results;
	}
	const like = `%${query.toLowerCase().replace(/[!%_]/g, (char) => `!${char}`)}%`;
	const { results } = await db
		.prepare(
			`SELECT 'forward' AS kind, status, alias_address AS alias,
				CASE WHEN error IS NOT NULL THEN error
					WHEN trackers_removed > 0 THEN COALESCE(subject, '') || ' · ' || trackers_removed || ' tracker(s)'
					ELSE subject END AS detail,
				updated_at AS at FROM forwards
				WHERE 'forward' LIKE ? ESCAPE '!' OR status LIKE ? ESCAPE '!' OR alias_address LIKE ? ESCAPE '!' OR COALESCE(subject, '') LIKE ? ESCAPE '!' OR COALESCE(error, '') LIKE ? ESCAPE '!'
			UNION ALL
			SELECT kind, status, alias_address AS alias, detail, created_at AS at FROM events
				WHERE kind LIKE ? ESCAPE '!' OR status LIKE ? ESCAPE '!' OR COALESCE(alias_address, '') LIKE ? ESCAPE '!' OR COALESCE(detail, '') LIKE ? ESCAPE '!'
			ORDER BY at DESC LIMIT ? OFFSET ?`,
		)
		.bind(like, like, like, like, like, like, like, like, like, limit, offset)
		.all<ActivityItem>();
	return results;
}

async function activityTotal(db: D1Database, query = ""): Promise<number> {
	if (!query) {
		const row = await db.prepare("SELECT (SELECT COUNT(*) FROM forwards) + (SELECT COUNT(*) FROM events) AS total").first<{ total: number }>();
		return row?.total ?? 0;
	}
	const like = `%${query.toLowerCase().replace(/[!%_]/g, (char) => `!${char}`)}%`;
	const row = await db
		.prepare(
			`SELECT
				(SELECT COUNT(*) FROM forwards WHERE 'forward' LIKE ? ESCAPE '!' OR status LIKE ? ESCAPE '!' OR alias_address LIKE ? ESCAPE '!' OR COALESCE(subject, '') LIKE ? ESCAPE '!' OR COALESCE(error, '') LIKE ? ESCAPE '!')
				+ (SELECT COUNT(*) FROM events WHERE kind LIKE ? ESCAPE '!' OR status LIKE ? ESCAPE '!' OR COALESCE(alias_address, '') LIKE ? ESCAPE '!' OR COALESCE(detail, '') LIKE ? ESCAPE '!') AS total`,
		)
		.bind(like, like, like, like, like, like, like, like, like)
		.first<{ total: number }>();
	return row?.total ?? 0;
}

// ---------- built-in mailbox (Webmail) ----------

app.get("/mailbox", async (c) => {
	const db = c.env.DB;
	const settings = await pageSettings(c);
	const config = c.get("config");
	const source = c.req.query("source") === "mailflare" && mailflareReady(config) && settings.mailboxMailflareIntegration ? "mailflare" : "local";
	const rawFolder = c.req.query("folder") ?? "all";
	const folder: MailboxFolder | "all" = isMailboxFolder(rawFolder) ? rawFolder : "all";
	const query = (c.req.query("q") ?? "").trim().slice(0, 200);
	const pageNum = pageParam(c.req.query("page"), 1);
	const perPage = 30;
	const stats = await folderStats(db);
	const storageBackend = resolveStorageBackend(c.env, config, settings.mailboxStorageBackend);

	if (source === "mailflare") {
		try {
			const mailflareMessages = await listMailflareEmails(mailflareConfig(config), { text: query || undefined, limit: 30 });
			return c.html(
				mailboxListPage(c.get("t"), {
					folder,
					source,
					messages: [],
					mailflareMessages,
					mailflareEnabled: true,
					stats,
					storageBackend,
					query,
					page: 1,
					lastPage: 1,
					total: mailflareMessages.length,
					notice: noticeFrom(c),
				}),
			);
		} catch (error) {
			return c.html(
				mailboxListPage(c.get("t"), {
					folder,
					source,
					messages: [],
					mailflareError: error instanceof Error ? error.message : String(error),
					mailflareEnabled: true,
					stats,
					storageBackend,
					query,
					page: 1,
					lastPage: 1,
					total: 0,
					notice: noticeFrom(c),
				}),
			);
		}
	}

	const { messages, total } = await listMailboxMessages(db, { folder, search: query, limit: perPage, offset: (pageNum - 1) * perPage });
	const lastPage = Math.max(1, Math.ceil(total / perPage));
	return c.html(
		mailboxListPage(c.get("t"), {
			folder,
			source,
			messages,
			mailflareEnabled: mailflareReady(config) && settings.mailboxMailflareIntegration,
			stats,
			storageBackend,
			query,
			page: pageNum,
			lastPage,
			total,
			notice: noticeFrom(c),
		}),
	);
});

/**
 * Recipient suggestions for Compose: the people the aliases have mail with (most recent first),
 * matched on address or name, one entry per address with the alias it last used.
 */
app.get("/mailbox/recipients", async (c) => {
	const q = (c.req.query("q") ?? "").trim().toLowerCase().slice(0, 100);
	const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
	const { results } = await c.env.DB.prepare(
		`SELECT c.email, c.name, c.alias_address,
		        MAX(COALESCE(c.last_reply_at, 0), COALESCE(c.last_forward_at, 0), COALESCE(c.last_sent_at, 0), c.created_at) AS seen
		 FROM contacts c JOIN aliases a ON a.address = c.alias_address
		 WHERE c.blocked = 0 AND a.deleted_at IS NULL AND (c.email LIKE ?1 ESCAPE '\\' OR LOWER(COALESCE(c.name, '')) LIKE ?1 ESCAPE '\\')
		 ORDER BY seen DESC LIMIT 100`,
	)
		.bind(like)
		.all<{ email: string; name: string | null; alias_address: string }>();
	const seen = new Set<string>();
	const recipients: { email: string; name: string | null; alias: string }[] = [];
	for (const row of results) {
		if (seen.has(row.email)) continue;
		seen.add(row.email);
		recipients.push({ email: row.email, name: row.name, alias: row.alias_address });
		if (recipients.length >= 15) break;
	}
	c.header("Cache-Control", "no-store");
	return c.json({ recipients });
});

app.get("/mailbox/compose", async (c) => {
	const { results } = await c.env.DB.prepare("SELECT address FROM aliases WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 200").all<{ address: string }>();
	const aliases = results.map((r) => r.address);
	return c.html(
		mailboxComposePage(c.get("t"), {
			aliases,
			from: c.req.query("from") ?? aliases[0] ?? "",
			to: c.req.query("to") ?? "",
			subject: c.req.query("subject") ?? "",
			text: "",
			notice: noticeFrom(c),
		}),
	);
});

app.post("/mailbox/compose", async (c) => {
	const form = await c.req.parseBody();
	const fromAddr = normalizeEmail(typeof form.from === "string" ? form.from : "");
	const toAddr = extractEmail(typeof form.to === "string" ? form.to : "");
	const subject = (typeof form.subject === "string" ? form.subject : "").trim().slice(0, 500) || "(no subject)";
	const text = typeof form.text === "string" ? form.text : "";
	const alias = await getAlias(c.env.DB, fromAddr);
	if (!alias || alias.deleted_at || !toAddr) return redirectWithNotice(c, "/mailbox/compose", "notice.mbSendFailed");
	const config = c.get("config");
	const settings = await loadSettings(c.env.DB);
	const displayName = alias.name || settings.defaultFromName || "";
	const fromHeader = displayName ? { name: displayName, email: alias.address } : alias.address;
	try {
		if (alias.mailbox_id && mailflareReady(config)) {
			await sendViaMailflare(mailflareConfig(config), {
				mailboxId: alias.mailbox_id,
				from: displayName ? `"${displayName}" <${alias.address}>` : alias.address,
				to: [toAddr],
				subject,
				text,
			});
		} else {
			await sendOutbound(c.env, config, { from: fromHeader, to: toAddr, subject, text });
		}
		if (settings.mailboxEnabled && settings.storeSentCopy) {
			const rawMime = buildMime({ from: fromHeader, to: toAddr, subject, text }, newMessageId(fromHeader));
			await storeMailboxMessage(c.env, config, settings, {
				folder: "Sent",
				aliasAddress: alias.address,
				fromAddress: alias.address,
				fromName: displayName || null,
				toAddress: toAddr,
				subject,
				reason: "sent",
				flags: ["\\Seen"],
				raw: new TextEncoder().encode(rawMime),
			});
		}
		return redirectWithNotice(c, "/mailbox?folder=Sent", "notice.mbSent");
	} catch (error) {
		console.error("Mailbox compose failed:", error instanceof Error ? error.message : error);
		return redirectWithNotice(c, "/mailbox/compose", "notice.mbSendFailed");
	}
});

app.post("/mailbox/empty", async (c) => {
	const form = await c.req.parseBody();
	const folder = typeof form.folder === "string" && (form.folder === "Trash" || form.folder === "Skipped") ? form.folder : null;
	if (!folder) return redirectWithNotice(c, "/mailbox", "notice.bulkBad");
	await emptyMailboxFolder(c.env, c.get("config"), folder);
	return redirectWithNotice(c, `/mailbox?folder=${folder}`, "notice.mbEmptied");
});

app.get("/mailbox/:id", async (c) => {
	const msg = await getMailboxMessage(c.env.DB, c.req.param("id"));
	if (!msg) return c.notFound();
	if (!msg.flags.includes("\\Seen")) {
		await updateMailboxFlags(c.env.DB, msg.id, { add: ["\\Seen"] });
		msg.flags.push("\\Seen");
	}
	const raw = await readMailboxRaw(c.env, c.get("config"), msg);
	const parsed = raw ? await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" }).catch(() => null) : null;
	return c.html(mailboxDetailPage(c.get("t"), { message: msg, parsed, hasRaw: !!raw, notice: noticeFrom(c) }));
});

app.get("/mailbox/:id/html", async (c) => {
	const msg = await getMailboxMessage(c.env.DB, c.req.param("id"));
	if (!msg) return c.notFound();
	const raw = await readMailboxRaw(c.env, c.get("config"), msg);
	const parsed = raw ? await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" }).catch(() => null) : null;
	if (!parsed?.html) return c.notFound();
	// Strict sandbox CSP: zero scripts, zero external images/fonts/connections, allowed only inside our iframe.
	c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'");
	c.header("X-Frame-Options", "SAMEORIGIN");
	c.header("Cache-Control", "no-store");
	return c.html(parsed.html);
});

app.get("/mailbox/:id/raw", async (c) => {
	const msg = await getMailboxMessage(c.env.DB, c.req.param("id"));
	if (!msg) return c.notFound();
	const raw = await readMailboxRaw(c.env, c.get("config"), msg);
	if (!raw) return c.notFound();
	return c.body(raw as Uint8Array<ArrayBuffer>, 200, {
		"Content-Type": "message/rfc822",
		"Content-Disposition": `attachment; filename="${msg.id}.eml"`,
		"Cache-Control": "no-store",
	});
});

app.get("/mailbox/:id/attachment/:index", async (c) => {
	const msg = await getMailboxMessage(c.env.DB, c.req.param("id"));
	if (!msg) return c.notFound();
	const idx = Number(c.req.param("index"));
	if (!Number.isInteger(idx) || idx < 0) return c.notFound();
	const raw = await readMailboxRaw(c.env, c.get("config"), msg);
	const parsed = raw ? await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" }).catch(() => null) : null;
	const att = parsed?.attachments[idx];
	if (!att) return c.notFound();
	const filename = (att.filename ?? `attachment-${idx + 1}`).replace(/["\r\n/\\]/g, "_").slice(0, 120);
	const bytes = typeof att.content === "string" ? new TextEncoder().encode(att.content) : new Uint8Array(att.content);
	return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
		"Content-Type": att.mimeType || "application/octet-stream",
		"Content-Disposition": `attachment; filename="${filename}"`,
		"Cache-Control": "no-store",
	});
});

app.post("/mailbox/:id/resend", async (c) => {
	const id = c.req.param("id");
	const outcome = await resendMailboxMessage(c.env, c.get("config"), id);
	return redirectWithNotice(c, `/mailbox/${encodeURIComponent(id)}`, outcome.ok ? "notice.mbResent" : "notice.mbResendFailed");
});

app.post("/mailbox/:id/read", async (c) => {
	const id = c.req.param("id");
	const form = await c.req.parseBody();
	const seen = form.seen === "1";
	await updateMailboxFlags(c.env.DB, id, seen ? { add: ["\\Seen"] } : { remove: ["\\Seen"] });
	return c.redirect(`/mailbox/${encodeURIComponent(id)}`);
});

app.post("/mailbox/:id/move", async (c) => {
	const id = c.req.param("id");
	const form = await c.req.parseBody();
	const target = isMailboxFolder(form.folder) ? form.folder : "Trash";
	await moveMailboxMessage(c.env.DB, id, target);
	return redirectWithNotice(c, `/mailbox?folder=${encodeURIComponent(target)}`, "notice.mbMoved");
});

app.post("/mailbox/:id/delete", async (c) => {
	await deleteMailboxMessage(c.env, c.get("config"), c.req.param("id"));
	return redirectWithNotice(c, "/mailbox?folder=Trash", "notice.mbDeleted");
});

app.get("/activity", async (c) => {
	const db = c.env.DB;
	const query = (c.req.query("q") ?? "").trim().slice(0, 100);
	const page = pageParam(c.req.query("page"), 1);
	const requestedSize = Number(c.req.query("per"));
	const perPage = (ALIAS_PAGE_SIZES as readonly number[]).includes(requestedSize) ? requestedSize : DEFAULT_ACTIVITY_PAGE_SIZE;
	const [items, total] = await Promise.all([activityPage(db, perPage, (page - 1) * perPage, query), activityTotal(db, query)]);
	const lastPage = Math.max(1, Math.ceil(total / perPage));
	return c.html(activityListPage(c.get("t"), { items, page, lastPage, query, perPage, total }));
});

const ALIAS_FILTERS = ["all", "active", "disabled", "pinned", "deleted"] as const;
export type AliasFilter = (typeof ALIAS_FILTERS)[number];
/**
 * When an alias was created or last used, for "newest or most recently used first". The same
 * expression as aliases_list_order_idx, so the sort reads that index.
 */
const LAST_USED = `MAX(created_at, COALESCE(last_used_at, 0))`;

app.get("/", async (c) => {
	const db = c.env.DB;
	const settings = await pageSettings(c);
	const query = (c.req.query("q") ?? "").trim().slice(0, 100);
	const requested = c.req.query("filter") as AliasFilter;
	const filter: AliasFilter = ALIAS_FILTERS.includes(requested) ? requested : "all";
	const pageNumber = pageParam(c.req.query("page"), 1);
	const requestedSize = Number(c.req.query("per"));
	const perPage = (ALIAS_PAGE_SIZES as readonly number[]).includes(requestedSize) ? requestedSize : DEFAULT_ALIAS_PAGE_SIZE;
	const where = [filter === "deleted" ? "deleted_at IS NOT NULL" : "deleted_at IS NULL"];
	const params: unknown[] = [];
	if (filter === "active") where.push("forward_mode != 'none'");
	if (filter === "disabled") where.push("forward_mode = 'none'");
	if (filter === "pinned") where.push("pinned = 1");
	// The labels are read alongside the aliases, so a label id is only checked for its form here.
	const requestedLabel = c.req.query("label") ?? "";
	const label = /^lb_[0-9a-f]{32}$/.test(requestedLabel) ? requestedLabel : "";
	if (label) {
		where.push("address IN (SELECT alias_address FROM alias_labels WHERE label_id = ?)");
		params.push(label);
	}
	if (query) {
		const fields = ["address", "COALESCE(note, '')", "COALESCE(name, '')", "COALESCE(destination, '')"];
		where.push(`(${fields.map((field) => `${field} LIKE ? ESCAPE '!'`).join(" OR ")})`);
		const like = `%${query.toLowerCase().replace(/[!%_]/g, (char) => `!${char}`)}%`;
		params.push(like, like, like, like);
	}
	const clause = `WHERE ${where.join(" AND ")}`;
	const [labels, { results: aliases }, counted, activity] = await Promise.all([
		listLabels(db),
		db
			.prepare(
				`SELECT aliases.*, (SELECT COUNT(*) FROM contacts WHERE contacts.alias_address = aliases.address) AS contacts, last_used_at AS used_at FROM aliases ${clause}
				 ORDER BY pinned DESC, ${LAST_USED} DESC, num_id DESC LIMIT ? OFFSET ?`,
			)
			.bind(...params, perPage, (pageNumber - 1) * perPage)
			.all<AliasRow & { contacts: number }>(),
		db.prepare(`SELECT COUNT(*) AS total FROM aliases ${clause}`).bind(...params).first<{ total: number }>(),
		activityPage(db, DASHBOARD_ACTIVITY, 0),
	]);
	const list = { query, filter, label: labels.some((row) => row.id === label) ? label : "", page: pageNumber, perPage, total: counted?.total ?? 0 };
	const byAlias = labels.length ? await labelsOf(db, aliases.map((alias) => alias.address)) : new Map();
	const withLabels = aliases.map((alias) => ({ ...alias, labels: byAlias.get(alias.address) ?? [] }));
	return c.html(
		dashboardPage(c.get("t"), { settings, aliases: withLabels, labels, list, activity, missing: missingConnection(settings), notice: noticeFrom(c) }),
	);
});

app.get("/settings", async (c) =>
	c.html(
		settingsPage(c.get("t"), {
			settings: await pageSettings(c),
			origin: publicOrigin(c),
			notice: noticeFrom(c),
		}),
	),
);

app.post("/settings", async (c) => {
	const form = await c.req.parseBody();
	// The page saves each change as it happens (X-Autosave) and expects JSON; without script it posts the form.
	// The dashboard language lives in a cookie in this browser; the page reloads to show it.
	// The language only changes once everything else is valid, so an error is not lost to a reload.
	const uiLocale = form.uiLocale;
	const localeChanged = isLocale(uiLocale) && uiLocale !== c.get("t").locale;
	if (localeChanged) await loadLocale(uiLocale);
	const uiTheme = form.uiTheme;
	const themeChanged = isTheme(uiTheme) && uiTheme !== (c.get("t").theme ?? "system");
	const reply = (key: MessageKey, ok: boolean, params?: Record<string, string>) => {
		if (ok && themeChanged) {
			setCookie(c, THEME_COOKIE, uiTheme, { path: "/", httpOnly: true, secure: true, sameSite: "Lax", maxAge: 60 * 60 * 24 * 365 });
		}
		if (ok && localeChanged) {
			setCookie(c, LANG_COOKIE, uiLocale, { path: "/", httpOnly: true, secure: true, sameSite: "Lax", maxAge: 60 * 60 * 24 * 365 });
			c.set("t", translator(uiLocale, ok && themeChanged ? uiTheme : c.get("t").theme ?? "system"));
		}
		return c.req.header("X-Autosave") === "1"
			? c.json({ ok, message: c.get("t")(key, params), reload: ok && localeChanged, ...(ok && themeChanged ? { theme: uiTheme } : {}) }, ok ? 200 : 400)
			: redirectWithNotice(c, "/settings", key, params);
	};
	const destination = typeof form.defaultDestination === "string" ? form.defaultDestination.trim() : "";
	const aliasDomains = [
		...new Set(
			(typeof form.aliasDomains === "string" ? form.aliasDomains : "")
				.split(/[\s,]+/)
				.map((domain) => domain.trim().toLowerCase().replace(/\.$/, ""))
				.filter(Boolean),
		),
	];
	const badDomain = aliasDomains.find((domain) => !DOMAIN_PATTERN.test(domain)) ?? clashingDomain(aliasDomains);
	if (badDomain) return reply("notice.badAliasDomain", false, { value: badDomain });
	if (aliasDomains.length > MAX_ALIAS_DOMAINS) return reply("notice.tooManyDomains", false, { count: String(MAX_ALIAS_DOMAINS) });
	if (destination && !extractEmail(destination)) return reply("notice.badDestination", false);
	if (destination && isOwnAddress(extractEmail(destination)!, aliasDomains)) return reply("notice.destinationOnReverse", false);
	// Unsubscribe: the general rule, then one per alias domain that overrides any field.
	const field = (name: string) => (typeof form[name] === "string" ? (form[name] as string).trim() : "");
	const unsubscribeDomains: Record<string, { behavior: string; fallback: string; redirect: string }> = {};
	for (const domain of aliasDomains) {
		const behavior = field(`unsubscribeBehavior:${domain}`);
		const fallback = field(`unsubscribeFallback:${domain}`);
		const redirect = field(`unsubscribeRedirect:${domain}`);
		if (behavior || fallback || redirect) unsubscribeDomains[domain] = { behavior, fallback, redirect };
	}
	const generalBehavior = field("unsubscribeBehavior");
	const generalFallback = field("unsubscribeFallback");
	const generalRedirect = field("unsubscribeRedirect");
	const rules = [
		{ behavior: generalBehavior, fallback: generalFallback, redirect: generalRedirect },
		...Object.values(unsubscribeDomains).map((rule) => ({
			behavior: rule.behavior || generalBehavior,
			fallback: rule.fallback || generalFallback,
			redirect: rule.redirect,
		})),
	];
	for (const rule of rules) {
		if (!rule.redirect) continue;
		const address = extractEmail(rule.redirect);
		if (!address) return reply("notice.badDestination", false);
		if (isOwnAddress(address, aliasDomains)) return reply("notice.destinationOnReverse", false);
	}
	if (rules.some((rule) => (rule.behavior === "redirect_contact" || rule.fallback === "redirect_contact") && !rule.redirect && !generalRedirect)) {
		return reply("notice.unsubRedirectMissing", false);
	}
	const bannerLocation =
		typeof form.bannerLocation === "string" ? form.bannerLocation : form.showBanner === "1" ? "top" : "off";
	const currentSettings = await loadSettings(c.env.DB);
	const mailboxShown = form.mailboxSettingsShown === "1";
	const mailboxPatch = mailboxShown
		? {
				mailboxEnabled: form.mailboxEnabled === "1",
				storeFailed: form.storeFailed === "1",
				storeSkippedAliasOff: form.storeSkippedAliasOff === "1",
				storeSkippedPromotions: form.storeSkippedPromotions === "1",
				storeSkippedRuleBlock: form.storeSkippedRuleBlock === "1",
				storeSkippedBlockedSender: form.storeSkippedBlockedSender === "1",
				storeSkippedUnknownAlias: form.storeSkippedUnknownAlias === "1",
				storeForwardedCopy: form.storeForwardedCopy === "1",
				storeSentCopy: form.storeSentCopy === "1",
				mailboxMailflareIntegration: form.mailboxMailflareIntegration === "1",
				mailboxRetentionDays: form.mailboxRetentionDays,
				mailboxMaxMessageKb: form.mailboxMaxMessageKb,
				mailboxQuotaMb: form.mailboxQuotaMb,
				mailboxQuotaPolicy: form.mailboxQuotaPolicy,
				mailboxStorageBackend: form.mailboxStorageBackend,
				imapEnabled: form.imapEnabled === "1",
				pop3Enabled: form.pop3Enabled === "1",
				smtpEnabled: form.smtpEnabled === "1",
				pop3Folders: (["INBOX", "Skipped", "Failed", "Sent", "Trash"] as const).filter((f) => form[`pop3Folder:${f}`] === "1"),
				pop3DeleteAction: form.pop3DeleteAction,
				smtpFromPolicy: form.smtpFromPolicy,
				smtpRateLimitPerHour: form.smtpRateLimitPerHour,
			}
		: {
				mailboxEnabled: currentSettings.mailboxEnabled,
				storeFailed: currentSettings.storeFailed,
				storeSkippedAliasOff: currentSettings.storeSkippedAliasOff,
				storeSkippedPromotions: currentSettings.storeSkippedPromotions,
				storeSkippedRuleBlock: currentSettings.storeSkippedRuleBlock,
				storeSkippedBlockedSender: currentSettings.storeSkippedBlockedSender,
				storeSkippedUnknownAlias: currentSettings.storeSkippedUnknownAlias,
				storeForwardedCopy: currentSettings.storeForwardedCopy,
				storeSentCopy: currentSettings.storeSentCopy,
				mailboxMailflareIntegration: currentSettings.mailboxMailflareIntegration,
				mailboxRetentionDays: currentSettings.mailboxRetentionDays,
				mailboxMaxMessageKb: currentSettings.mailboxMaxMessageKb,
				mailboxQuotaMb: currentSettings.mailboxQuotaMb,
				mailboxQuotaPolicy: currentSettings.mailboxQuotaPolicy,
				mailboxStorageBackend: currentSettings.mailboxStorageBackend,
				imapEnabled: currentSettings.imapEnabled,
				pop3Enabled: currentSettings.pop3Enabled,
				smtpEnabled: currentSettings.smtpEnabled,
				pop3Folders: currentSettings.pop3Folders,
				pop3DeleteAction: currentSettings.pop3DeleteAction,
				smtpFromPolicy: currentSettings.smtpFromPolicy,
				smtpRateLimitPerHour: currentSettings.smtpRateLimitPerHour,
			};
	const settings = normalizeSettings({
		simpleloginApi: form.simpleloginApi === "1",
		addyApi: form.addyApi === "1",
		mcpServer: form.mcpServer === "1",
		forwardMethod: form.forwardMethod,
		aliasDomains,
		randomAliasFormat: form.randomAliasFormat,
		aliasSeparator: form.aliasSeparator,
		appSettings: form.appSettings === "1",
		senderFormat: form.senderFormat,
		reverseAliasReplacement: form.reverseAliasReplacement === "1",
		sendAutoReplies: form.sendAutoReplies === "1",
		includeSenderInReverseAlias: form.includeSenderInReverseAlias === "1",
		autoForwardNewAliases: form.autoForwardNewAliases === "1",
		createAliasesFromMail: form.createAliasesFromMail === "1",
		// Off: a domain whose box was shown and left unticked. A domain added in this same save had
		// no box yet, so it starts on.
		aliasesFromMailOff: aliasDomains.filter((domain) => form[`fromMailShown:${domain}`] === "1" && form[`fromMail:${domain}`] !== "1"),
		removeTrackers: form.removeTrackers === "1",
		bannerLocation,
		showBanner: bannerLocation !== "off",
		defaultFromName: typeof form.defaultFromName === "string" ? form.defaultFromName : "",
		defaultEmailSubject: typeof form.defaultEmailSubject === "string" ? form.defaultEmailSubject : "",
		spamWarningBehaviour: form.spamWarningBehaviour,
		wkdAutoEncrypt: form.wkdAutoEncrypt === "1",
		unsubscribeBehavior: form.unsubscribeBehavior,
		unsubscribeFallback: form.unsubscribeFallback,
		unsubscribeRedirect: generalRedirect,
		unsubscribeDomains,
		language: form.language,
		// The bare address, so "Owner <owner@example.com>" is stored as owner@example.com.
		defaultDestination: destination ? (extractEmail(destination) ?? "") : "",
		...mailboxPatch,
	});
	// Which addresses get encrypted mail is set on the Encryption page, not here.
	const { pgpRecipients: _kept, ...changed } = settings;
	await saveSettingKeys(c.env.DB, changed);
	return reply("notice.settingsSaved", true);
});

app.get("/settings/mailbox", async (c) =>
	c.html(mailboxSettingsPage(c.get("t"), { settings: await pageSettings(c), notice: noticeFrom(c) })),
);

app.post("/settings/mailbox", async (c) => {
	const form = await c.req.parseBody();
	const current = await loadSettings(c.env.DB);
	const settings = normalizeSettings({
		...current,
		mailboxEnabled: form.mailboxEnabled === "1",
		storeFailed: form.storeFailed === "1",
		storeSkippedAliasOff: form.storeSkippedAliasOff === "1",
		storeSkippedPromotions: form.storeSkippedPromotions === "1",
		storeSkippedRuleBlock: form.storeSkippedRuleBlock === "1",
		storeSkippedBlockedSender: form.storeSkippedBlockedSender === "1",
		storeSkippedUnknownAlias: form.storeSkippedUnknownAlias === "1",
		storeForwardedCopy: form.storeForwardedCopy === "1",
		storeSentCopy: form.storeSentCopy === "1",
		mailboxMailflareIntegration: form.mailboxMailflareIntegration === "1",
		mailboxRetentionDays: form.mailboxRetentionDays,
		mailboxMaxMessageKb: form.mailboxMaxMessageKb,
		mailboxQuotaMb: form.mailboxQuotaMb,
		mailboxQuotaPolicy: form.mailboxQuotaPolicy,
		mailboxStorageBackend: form.mailboxStorageBackend,
		imapEnabled: form.imapEnabled === "1",
		pop3Enabled: form.pop3Enabled === "1",
		smtpEnabled: form.smtpEnabled === "1",
		pop3Folders: (["INBOX", "Skipped", "Failed", "Sent", "Trash"] as const).filter((f) => form[`pop3Folder:${f}`] === "1"),
		pop3DeleteAction: form.pop3DeleteAction,
		smtpFromPolicy: form.smtpFromPolicy,
		smtpRateLimitPerHour: form.smtpRateLimitPerHour,
	});
	const { pgpRecipients: _kept, ...changed } = settings;
	await saveSettingKeys(c.env.DB, changed);
	return savedNotice(c, "/settings/mailbox", "notice.settingsSaved", true);
});

async function renderConnection(c: C, config: AppConfig, setup?: DomainSetup[]) {
	const settings = await pageSettings(c);
	return c.html(
		connectionPage(c.get("t"), {
			values: {
				mailflareUrl: config.mailflareUrl,
				publicUrl: config.publicUrl,
				outboundProvider: config.outboundProvider,
				workersPlan: config.workersPlan,
				outboundOptions: config.outboundOptions,
				mailboxS3: config.mailboxS3,
			},
			hasOutboundKey: !!config.outboundApiKey,
			hasApiKey: !!config.mailflareApiKey,
			hasWebhookSecret: !!config.webhookSecret,
			hasS3Secret: !!config.mailboxS3.secretAccessKey,
			hasR2: !!c.env.MAILBOX_BUCKET,
			mailflare: mailflareReady(config),
			fixed: envOverrides(c.env),
			webhookUrl: `${publicOrigin(c)}/webhook`,
			missing: missingConnection(settings),
			cloudflare: { hasToken: envOverrides(c.env).has("cloudflareApiToken"), workerName: config.workerName, domains: settings.aliasDomains, setup },
			notice: noticeFrom(c),
		}),
	);
}

app.get("/connection", (c) => renderConnection(c, c.get("config")));

// Sets up Email Routing and Email Sending for the chosen alias domains.
app.post("/connection/cloudflare", async (c) => {
	const form = await c.req.parseBody({ all: true });
	const fixed = envOverrides(c.env);
	const text = (key: string) => (typeof form[key] === "string" ? (form[key] as string).trim() : "");
	const values: Record<string, string> = {};
	// The token can edit the zone, so it is used for this request only and never stored.
	// A CLOUDFLARE_API_TOKEN secret is the way to keep one; an older stored token is removed.
	const token = fixed.has("cloudflareApiToken") ? c.get("config").cloudflareApiToken : text("cloudflareApiToken");
	await c.env.DB.prepare("DELETE FROM config WHERE key = 'cloudflareApiToken'").run();
	if (!fixed.has("workerName")) {
		const name = text("workerName").toLowerCase();
		if (name && !WORKER_NAME_PATTERN.test(name)) return redirectWithNotice(c, "/connection", "notice.badWorkerName");
		values.workerName = name;
	}
	await saveConfig(c.env.DB, values);
	const config = await loadConfig(c.env);
	let settings = await loadSettings(c.env.DB);
	// Allow adding alias domains directly on the Connection page so setup is never blocked.
	const addedDomains = [
		...new Set(
			text("aliasDomains")
				.split(/[\s,]+/)
				.map((domain) => domain.trim().toLowerCase().replace(/\.$/, ""))
				.filter(Boolean),
		),
	];
	if (addedDomains.length) {
		const merged = [...new Set([...settings.aliasDomains, ...addedDomains])];
		const badDomain = merged.find((domain) => !DOMAIN_PATTERN.test(domain)) ?? clashingDomain(merged);
		if (badDomain) return redirectWithNotice(c, "/connection", "notice.badAliasDomain", { value: badDomain });
		if (merged.length > MAX_ALIAS_DOMAINS) return redirectWithNotice(c, "/connection", "notice.tooManyDomains", { count: String(MAX_ALIAS_DOMAINS) });
		if (settings.defaultDestination && isOwnAddress(settings.defaultDestination, merged)) {
			return redirectWithNotice(c, "/connection", "notice.destinationOnReverse");
		}
		await saveSettingKeys(c.env.DB, { aliasDomains: merged });
		settings = { ...settings, aliasDomains: merged };
	}
	const chosen = (Array.isArray(form.domains) ? form.domains : [form.domains]).filter((domain): domain is string => typeof domain === "string");
	const domains = [...new Set([...settings.aliasDomains.filter((domain) => chosen.includes(domain)), ...addedDomains])];
	if (!domains.length) return redirectWithNotice(c, "/connection", "notice.needAliasDomains");
	// Each domain takes about a dozen Cloudflare API calls; the Free plan allows 50 subrequests per request.
	if (config.workersPlan === "free" && domains.length > FREE_PLAN_SETUP_DOMAINS) {
		return redirectWithNotice(c, "/connection", "notice.freeSetupLimit", { count: String(FREE_PLAN_SETUP_DOMAINS) });
	}
	if (!token) return redirectWithNotice(c, "/connection", "notice.needCloudflareToken");
	const setup = await setUpCloudflare({ token, domains, workerName: config.workerName, replaceCatchAll: form.replaceCatchAll === "1", wkdHost: form.wkdHost === "1" });
	return renderConnection(c, config, setup);
});


app.post("/connection", async (c) => {
	const form = await c.req.parseBody();
	const fixed = envOverrides(c.env);
	const text = (key: string) => (typeof form[key] === "string" ? (form[key] as string).trim() : "");
	const values: Record<string, string> = {};

	const config = c.get("config");
	const reqHost = hostnameOf(c.req.url);
	if (!fixed.has("publicUrl") && typeof form.publicUrl === "string") {
		const origin = text("publicUrl") ? validOrigin(text("publicUrl")) : "";
		if (origin === null) return redirectWithNotice(c, "/connection", "notice.badPublicUrl");
		values.publicUrl = origin;
	}
	if (!fixed.has("mailflareUrl") && typeof form.mailflareUrl === "string") {
		const origin = text("mailflareUrl") ? validOrigin(text("mailflareUrl")) : "";
		if (origin === null) return redirectWithNotice(c, "/connection", "notice.badMailflareUrl");
		// The API key goes to this URL: not to an IP address, an internal name or this Worker
		// itself (a port is fine). With a service binding the requests never leave Cloudflare.
		if (origin && !c.env.MAILFLARE_SERVICE) {
			const host = new URL(origin);
			host.port = "";
			const selfHosts = [reqHost, ...[config.publicUrl, values.publicUrl, config.siteOrigin].map(hostnameOf)].filter((h): h is string => !!h);
			if (!safeHttpsUrl(host.href, selfHosts)) return redirectWithNotice(c, "/connection", "notice.badMailflareUrl");
		}
		values.mailflareUrl = origin;
	}
	if (!fixed.has("outboundProvider") && text("outboundProvider")) {
		if (!isOutboundProvider(text("outboundProvider"))) return redirectWithNotice(c, "/connection", "notice.badProvider");
		values.outboundProvider = text("outboundProvider");
	}
	const optionKeys = ["smtpHost", "smtpPort", "smtpSecurity", "smtpUsername", "mailgunRegion", "sesRegion", "sesAccessKeyId", "mailbabyOrderId", "customUrl", "customHeaders", "customBody", "customIdPath"] as const;
	const hasOutboundOptions = optionKeys.some((key) => typeof form[key] === "string");
	if (!fixed.has("outboundOptions") && hasOutboundOptions) {
		const raw = (name: string) => (typeof form[name] === "string" ? (form[name] as string) : "");
		// Only the chosen provider's fields are sent (the others are disabled): the saved values of the
		// other providers stay, so switching back later finds them as they were.
		const submitted = Object.fromEntries(optionKeys.filter((key) => typeof form[key] === "string").map((key) => [key, raw(key)]));
		const options: OutboundOptions = normalizeOutboundOptions({ ...config.outboundOptions, ...submitted });
		const blocked = [reqHost, ...[config.publicUrl, values.publicUrl, config.siteOrigin, config.mailflareUrl, values.mailflareUrl].map(hostnameOf)].filter((h): h is string => !!h);
		if (raw("smtpHost").trim() && (!options.smtpHost || !isPublicHost(options.smtpHost, blocked))) return redirectWithNotice(c, "/connection", "notice.badSmtp");
		const rawPort = raw("smtpPort").trim();
		const parsedPort = Number(rawPort);
		if (rawPort && (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535 || parsedPort === 25)) return redirectWithNotice(c, "/connection", "notice.badSmtp");
		if (raw("sesRegion").trim() && !SES_REGION.test(raw("sesRegion").trim().toLowerCase())) return redirectWithNotice(c, "/connection", "notice.badSes");
		if (raw("mailbabyOrderId").trim() && !options.mailbabyOrderId) return redirectWithNotice(c, "/connection", "notice.badProvider");
		const effectiveProvider = values.outboundProvider ?? config.outboundProvider;
		const customSubmitted = (["customUrl", "customHeaders", "customBody", "customIdPath"] as const).some((key) => typeof form[key] === "string");
		if ((customSubmitted || effectiveProvider === "custom") && options.customUrl) {
			// The key and messages go to this URL: a public https host, not this Worker or Mailflare.
			if (!safeHttpsUrl(options.customUrl, blocked)) {
				return redirectWithNotice(c, "/connection", "notice.badCustom");
			}
			try {
				// A sample message must render cleanly (and give valid JSON when sending JSON), so a mistake shows now and not on the first reply.
				const sample = customValues({ from: { name: "A", email: "a@example.com" }, to: "b@example.com", subject: "s", text: "t", html: "<p>h</p>" }, "key", "<id@example.com>", () => "raw");
				for (const [, value] of parseHeaderLines(options.customHeaders)) fillTemplate(value, sample, "text");
				const renderedBody = fillTemplate(options.customBody, sample, "json");
				if (!/^content-type:\s*(?!application\/json)/im.test(options.customHeaders)) JSON.parse(renderedBody);
			} catch {
				return redirectWithNotice(c, "/connection", "notice.badCustom");
			}
		}
		values.outboundOptions = JSON.stringify(options);
	}
	if (!fixed.has("workersPlan") && text("workersPlan")) {
		if (!isWorkersPlan(text("workersPlan"))) return redirectWithNotice(c, "/connection", "notice.badProvider");
		values.workersPlan = text("workersPlan");
	}
	// S3-compatible mailbox storage fields.
	if (!fixed.has("mailboxS3Endpoint") && typeof form.mailboxS3Endpoint === "string") {
		const selfHosts = [reqHost, ...[config.publicUrl, values.publicUrl, config.siteOrigin].map(hostnameOf)].filter((h): h is string => !!h);
		const ep = validS3Endpoint(text("mailboxS3Endpoint"), selfHosts);
		if (ep === null) return redirectWithNotice(c, "/connection", "notice.badS3");
		values.mailboxS3Endpoint = ep;
	}
	for (const key of ["mailboxS3Bucket", "mailboxS3Region", "mailboxS3AccessKeyId", "mailboxS3Prefix"] as const) {
		if (!fixed.has(key) && typeof form[key] === "string") values[key] = text(key);
	}
	if (!fixed.has("mailboxS3PathStyle") && form.mailboxS3PathStyleShown === "1") {
		values.mailboxS3PathStyle = form.mailboxS3PathStyle === "1" ? "true" : "false";
	}
	// Secret fields are write-only: blank keeps the stored value.
	for (const key of ["mailflareApiKey", "webhookSecret", "outboundApiKey", "mailboxS3SecretAccessKey"] as const) {
		if (!fixed.has(key) && text(key)) values[key] = text(key);
	}
	await saveConfig(c.env.DB, values);
	return redirectWithNotice(c, "/connection", "notice.connectionSaved");
});

app.get("/blocklist", async (c) => {
	const { results } = await c.env.DB.prepare("SELECT * FROM blocklist ORDER BY created_at DESC LIMIT 5000").all<BlocklistRow>();
	return c.html(blocklistPage(c.get("t"), { entries: results, notice: noticeFrom(c) }));
});

/** Senders to block from what was typed: addresses and domains, separated by commas, spaces, semicolons or lines. */
export function parseBlockEntries(input: string): { entries: { kind: "address" | "domain"; value: string }[]; bad: string[] } {
	const entries = new Map<string, "address" | "domain">();
	const bad: string[] = [];
	for (const piece of input.slice(0, 50_000).split(/[\s,;，、；،]+/).filter(Boolean).slice(0, 500)) {
		const raw = piece.trim().toLowerCase().replace(/^@/, "").replace(/^<(.*)>$/, "$1");
		const email = raw.includes("@") ? extractEmail(raw) : null;
		const domain = !raw.includes("@") && DOMAIN_PATTERN.test(raw) ? raw : null;
		if (email === raw || domain) entries.set(raw, domain ? "domain" : "address");
		else bad.push(piece.slice(0, 100));
	}
	return { entries: [...entries].map(([value, kind]) => ({ kind, value })), bad };
}

function joinNoticeValues(values: string[], maxItems = 10, maxChars = 200): string {
	let out = "";
	for (const value of values.slice(0, maxItems)) {
		const next = out ? `${out}, ${value}` : value;
		if (next.length > maxChars) break;
		out = next;
	}
	return out || values[0]?.slice(0, maxChars) || "";
}

app.post("/blocklist", async (c) => {
	const form = await c.req.parseBody();
	const { entries, bad } = parseBlockEntries(typeof form.value === "string" ? form.value : "");
	if (!entries.length) return redirectWithNotice(c, "/blocklist", "notice.badBlock");
	const timestamp = now();
	const statements = entries.map((entry) =>
		c.env.DB.prepare("INSERT INTO blocklist (id, kind, value, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (value) DO NOTHING").bind(newId("bl"), entry.kind, entry.value, timestamp),
	);
	for (let i = 0; i < statements.length; i += 100) await c.env.DB.batch(statements.slice(i, i + 100));
	if (bad.length) return redirectWithNotice(c, "/blocklist", "notice.blockedSome", { count: String(entries.length), values: joinNoticeValues(bad) });
	return entries.length === 1
		? redirectWithNotice(c, "/blocklist", "notice.blocked", { value: entries[0]!.value })
		: redirectWithNotice(c, "/blocklist", "notice.blockedMany", { count: String(entries.length) });
});

app.post("/blocklist/:id/delete", async (c) => {
	await c.env.DB.prepare("DELETE FROM blocklist WHERE id = ?").bind(c.req.param("id")).run();
	return redirectWithNotice(c, "/blocklist", "notice.unblocked");
});

// ---------- PGP encryption ----------

const PGP_NOTICES: Record<PgpError["reason"], MessageKey> = {
	invalid: "notice.pgpInvalid",
	private: "notice.pgpPrivate",
	noEncryption: "notice.pgpNoEncryption",
	expired: "notice.pgpExpired",
	tooLarge: "notice.pgpTooLarge",
	// A key already published for an alias: the WKD page's rule, applied in the other order.
	keyInUse: "notice.wkdKeyInUse",
};

app.get("/encryption", async (c) => {
	const keys = await listPgpKeys(c.env.DB);
	return c.html(encryptionPage(c.get("t"), { keys, freePlan: c.get("config").workersPlan === "free", notice: noticeFrom(c) }));
});

app.post("/encryption", async (c) => {
	const form = await c.req.parseBody();
	const email = extractEmail(typeof form.email === "string" ? form.email.trim() : "");
	if (!email) return redirectWithNotice(c, "/encryption", "notice.pgpBadEmail");
	try {
		const key = await readPublicKey(typeof form.key === "string" ? form.key : "");
		await savePgpKey(c.env.DB, email, key);
	} catch (error) {
		if (error instanceof PgpError) return redirectWithNotice(c, "/encryption", PGP_NOTICES[error.reason]);
		throw error;
	}
	await syncPgpRecipients(c.env.DB);
	return redirectWithNotice(c, "/encryption", "notice.pgpSaved", { email });
});

app.post("/encryption/:email/:field{encrypt|subject|delete}", async (c) => {
	const email = normalizeEmail(c.req.param("email"));
	const field = c.req.param("field");
	const on = (await c.req.parseBody()).on === "1" ? 1 : 0;
	const statement =
		field === "delete"
			? c.env.DB.prepare("DELETE FROM pgp_keys WHERE email = ?").bind(email)
			: c.env.DB.prepare(`UPDATE pgp_keys SET ${field === "encrypt" ? "encrypt" : "hide_subject"} = ?, updated_at = ? WHERE email = ?`).bind(on, now(), email);
	const result = await statement.run();
	if (!result.meta.changes) return redirectWithNotice(c, "/encryption", "notice.pgpMissing");
	if (field === "delete") {
		await c.env.DB.prepare("UPDATE recipients SET should_encrypt = 0, inline_encryption = 0, protected_headers = 0, updated_at = ? WHERE email = ?").bind(now(), email).run();
	} else {
		const recCol = field === "encrypt" ? "should_encrypt" : "protected_headers";
		await c.env.DB.prepare(`UPDATE recipients SET ${recCol} = ?, updated_at = ? WHERE email = ?`).bind(on, now(), email).run();
	}
	await syncPgpRecipients(c.env.DB);
	const done: MessageKey = field === "delete" ? "notice.pgpDeleted" : field === "subject" ? "notice.pgpSubject" : on ? "notice.pgpOn" : "notice.pgpOff";
	return redirectWithNotice(c, "/encryption", done, { email });
});

// ---------- labels ----------

const LABEL_NOTICES: Record<LabelError["reason"], MessageKey> = {
	name: "notice.labelName",
	colour: "notice.labelName",
	taken: "notice.labelTaken",
	limit: "notice.labelLimit",
	missing: "notice.labelMissing",
};

async function labelRoute(c: C, run: () => Promise<unknown>, done: MessageKey): Promise<Response> {
	try {
		await run();
	} catch (error) {
		if (error instanceof LabelError) return redirectWithNotice(c, "/labels", LABEL_NOTICES[error.reason], { max: String(MAX_LABELS) });
		throw error;
	}
	return redirectWithNotice(c, "/labels", done);
}

app.get("/labels", async (c) => c.html(labelsPage(c.get("t"), { labels: await listLabels(c.env.DB), notice: noticeFrom(c) })));
app.post("/labels", async (c) => {
	const form = await c.req.parseBody();
	return labelRoute(c, () => createLabel(c.env.DB, { name: form.name, colour: form.colour }), "notice.labelSaved");
});
app.post("/labels/:id", async (c) => {
	const form = await c.req.parseBody();
	return labelRoute(c, () => updateLabel(c.env.DB, c.req.param("id"), { name: form.name, colour: form.colour }), "notice.labelSaved");
});
app.post("/labels/:id/delete", async (c) => {
	await deleteLabel(c.env.DB, c.req.param("id"));
	return redirectWithNotice(c, "/labels", "notice.labelDeleted");
});

// ---------- rules ----------

/** A rule from the editor's rows: a row without values (or an action without a type) is left out. */
function ruleFromForm(form: Record<string, unknown>, existing: Rule | null) {
	const conditions = [];
	const actions = [];
	for (let i = 0; i < 20; i += 1) {
		const values = typeof form[`cond_values_${i}`] === "string" ? (form[`cond_values_${i}`] as string) : "";
		if (values.trim()) conditions.push({ type: form[`cond_type_${i}`], match: form[`cond_match_${i}`], values });
		const type = form[`act_type_${i}`];
		if (typeof type === "string" && type) {
			const val = form[`act_value_${i}`];
			actions.push({ type, value: type === "banner" ? (typeof val === "string" && val.trim() ? val.trim() : "off") : val });
		}
	}
	// The editor has one box for replies and new messages; an app may have set them apart, which
	// stays so while the box is left as it was.
	const box = form.replies === "1";
	const unchanged = existing && box === !!(existing.replies || existing.sends);
	const replies = unchanged ? !!existing.replies : box;
	const sends = unchanged ? !!existing.sends : box;
	return { name: form.name, operator: form.operator, conditions, actions, forwards: form.forwards === "1", replies, sends, active: form.active === "1" };
}

const RULE_NOTICES: Record<RuleError["reason"], MessageKey> = {
	invalid: "notice.ruleInvalid",
	limit: "notice.ruleLimit",
	missing: "notice.ruleMissing",
	forwardTo: "notice.ruleForwardTo",
	webhook: "notice.ruleWebhook",
	unsupported: "notice.ruleUnsupported",
};

async function saveRule(c: C, id: string | null): Promise<Response> {
	const back = id ? `/rules/${encodeURIComponent(id)}` : "/rules/new";
	try {
		const existing = id ? await getRule(c.env.DB, id) : null;
		if (id && !existing) return redirectWithNotice(c, "/rules", "notice.ruleMissing");
		const reqHost = hostnameOf(c.req.url);
		const input = cleanRule(ruleFromForm(await c.req.parseBody(), existing), [...ownHosts(c.get("config")), ...(reqHost ? [reqHost] : [])]);
		// Mail goes only to the owner's own forwarding addresses, as in the apps: it carries the
		// banner's signed links, which should not reach anyone else. Check every forwardTo action.
		const forwardTos = input.actions.filter((action) => action.type === "forwardTo");
		if (forwardTos.length) {
			const allowed = await ruleDestinations(c);
			if (forwardTos.some((action) => !allowed.includes(action.value))) return redirectWithNotice(c, back, "notice.ruleForwardTo");
		}
		if (id) await updateRule(c.env.DB, id, input);
		else await createRule(c.env.DB, input);
	} catch (error) {
		if (error instanceof RuleError) {
			return redirectWithNotice(c, back, RULE_NOTICES[error.reason], {
				max: String(MAX_RULES),
				conditions: String(MAX_CONDITIONS),
				values: String(MAX_VALUES),
				length: String(MAX_VALUE_LENGTH),
			});
		}
		throw error;
	}
	return redirectWithNotice(c, "/rules", "notice.ruleSaved");
}

app.get("/rules", async (c) => c.html(rulesPage(c.get("t"), { rules: await listRules(c.env.DB), notice: noticeFrom(c), webhookKey: await webhookKey(c.get("config").signingSecret) })));
/** The addresses a rule may forward to: the owner's forwarding addresses. */
async function ruleDestinations(c: C): Promise<string[]> {
	return (await listDestinations(c.env.DB, await loadSettings(c.env.DB))).map((destination) => destination.email);
}

app.get("/rules/new", async (c) => c.html(ruleEditPage(c.get("t"), { rule: null, destinations: await ruleDestinations(c), notice: noticeFrom(c) })));
app.post("/rules", (c) => saveRule(c, null));
app.get("/rules/:id", async (c) => {
	const rule = await getRule(c.env.DB, c.req.param("id"));
	if (!rule) return redirectWithNotice(c, "/rules", "notice.ruleMissing");
	return c.html(ruleEditPage(c.get("t"), { rule, destinations: await ruleDestinations(c), notice: noticeFrom(c) }));
});
app.post("/rules/:id", (c) => saveRule(c, c.req.param("id")));
app.post("/rules/:id/active", async (c) => {
	const form = await c.req.parseBody();
	await setRuleActive(c.env.DB, c.req.param("id"), form.active === "1");
	return redirectWithNotice(c, "/rules", "notice.ruleSaved");
});
app.post("/rules/:id/move", async (c) => {
	const form = await c.req.parseBody();
	await moveRule(c.env.DB, c.req.param("id"), form.step === "-1" ? -1 : 1);
	return c.redirect("/rules");
});
app.post("/rules/:id/delete", async (c) => {
	await deleteRule(c.env.DB, c.req.param("id"));
	return redirectWithNotice(c, "/rules", "notice.ruleDeleted");
});

// ---------- import from SimpleLogin / addy.io ----------

const IMPORT_SOURCES = {
	simplelogin: { label: "SimpleLogin", server: "https://app.simplelogin.io", fetch: fetchSimpleLogin },
	addy: { label: "addy.io", server: "https://app.addy.io", fetch: fetchAddy },
	csv: { label: "CSV", server: "", fetch: null },
} as const;

// Every alias as CSV, for a backup or to move elsewhere; the import below reads it back.
app.get("/export/aliases.csv", async (c) => {
	const day = new Date().toISOString().slice(0, 10);
	return c.body(await exportAliases(c.env.DB), 200, {
		"Content-Type": "text/csv; charset=utf-8",
		"Content-Disposition": `attachment; filename="aliasflare-aliases-${day}.csv"`,
		"Cache-Control": "no-store",
	});
});

app.get("/import", async (c) => {
	const settings = await loadSettings(c.env.DB);
	return c.html(
		importPage(c.get("t"), {
			domains: await defaultImportDomains(c.env.DB, settings),
			addDomainsDefault: settings.aliasDomains.length === 0,
		}),
	);
});

type ImportOutcome = {
	domains: string[];
	sourceLabel: string;
	error?: string;
	result?: Awaited<ReturnType<typeof importAliases>>;
	addedDomains?: string[];
	status?: 400 | 413;
};

async function executeImport(c: C, sourceName: string, options: { allowAutoDetect: boolean }): Promise<ImportOutcome | null> {
	const t = c.get("t");
	if (!Object.hasOwn(IMPORT_SOURCES, sourceName)) return null;
	const source = IMPORT_SOURCES[sourceName as keyof typeof IMPORT_SOURCES];
	// A CSV file is at most 5 MB: enforce the cap on both declared length and actual stream bytes.
	if (Number(c.req.header("Content-Length") ?? 0) > MAX_IMPORT_UPLOAD) return { domains: [], sourceLabel: source.label, error: t("imp.err.format"), status: 413 };
	const rawBytes = await readLimited(c.req.raw.body, MAX_IMPORT_UPLOAD);
	if (rawBytes === null) return { domains: [], sourceLabel: source.label, error: t("imp.err.format"), status: 413 };
	const settings = await loadSettings(c.env.DB);
	const bounded = new Request(c.req.url, { method: c.req.method, headers: c.req.raw.headers, body: rawBytes.buffer as ArrayBuffer });
	const form: Record<string, string | File> = Object.create(null);
	try {
		const data = await bounded.formData();
		for (const [k, v] of data.entries()) form[k] = v;
	} catch {
		return { domains: [], sourceLabel: source.label, error: t("imp.err.format"), status: 400 };
	}
	let domains = [
		...new Set(
			(typeof form.domains === "string" ? form.domains : "")
				.split(/[\s,]+/)
				.map((domain) => domain.trim().toLowerCase().replace(/\.$/, ""))
				.filter((domain) => DOMAIN_PATTERN.test(domain)),
		),
	];
	if (!domains.length && !options.allowAutoDetect) {
		return { domains: await defaultImportDomains(c.env.DB, settings), sourceLabel: source.label, error: t("imp.err.noDomains"), status: 400 };
	}

	let server = "";
	let aliases: ImportedAlias[];
	let selection: Selection;
	let extras: AddyExtras | null = null;
	try {
		if (source.fetch) {
			const apiKey = typeof form.apiKey === "string" ? form.apiKey.trim() : "";
			if (!apiKey) return { domains, sourceLabel: source.label, error: t("imp.err.auth"), status: 400 };
			let url: URL;
			try {
				url = new URL(typeof form.server === "string" && form.server.trim() ? form.server.trim() : source.server);
			} catch {
				return { domains, sourceLabel: source.label, error: t("imp.err.badServer"), status: 400 };
			}
			if (url.protocol !== "https:") return { domains, sourceLabel: source.label, error: t("imp.err.badServer"), status: 400 };
			// A public host only: not an IP address, an internal name or this service itself. A
			// port is allowed, for self-hosted servers.
			const host = new URL(url.href);
			host.port = "";
			const ownHostsList = [c.req.url, c.get("config").publicUrl, c.get("config").siteOrigin, c.get("config").mailflareUrl]
				.map(hostnameOf)
				.filter((h): h is string => !!h);
			if (!safeHttpsUrl(host.href, ownHostsList)) return { domains, sourceLabel: source.label, error: t("imp.err.badServer"), status: 400 };
			server = url.origin;
			// One budget for the whole import, so aliases and contacts together stay inside Workers' subrequest limit.
			const budget = newFetchBudget(c.get("config").workersPlan);
			aliases = await source.fetch(server, apiKey, budget);
			if (!domains.length) {
				domains = detectCustomDomains(aliases, settings.aliasDomains);
				if (!domains.length) return { domains: [], sourceLabel: source.label, error: t("imp.err.noCustomDomains"), status: 400 };
			}
			selection = selectByDomain(aliases, domains, settings.aliasDomains);
			// Contacts are fetched only for the aliases being imported, one list per alias.
			if (sourceName === "simplelogin" && form.contacts === "1") await addSimpleLoginContacts(server, apiKey, selection.chosen, budget);
			// addy.io's labels, rules and blocklist come with its aliases.
			if (sourceName === "addy") extras = await fetchAddyExtras(server, apiKey, budget);
		} else {
			const file = form.file;
			if (!(file instanceof File) || file.size === 0) return { domains, sourceLabel: source.label, error: t("imp.err.empty"), status: 400 };
			if (file.size > 5_000_000) return { domains, sourceLabel: source.label, error: t("imp.err.format"), status: 400 };
			aliases = parseAliasCsv(await file.text());
			if (!domains.length) {
				domains = detectCustomDomains(aliases, settings.aliasDomains);
				if (!domains.length) return { domains: [], sourceLabel: source.label, error: t("imp.err.noCustomDomains"), status: 400 };
			}
			selection = selectByDomain(aliases, domains, settings.aliasDomains);
			// A labels column (aliasflare's own export) brings its labels, made by name as needed.
			if (selection.chosen.some((alias) => alias.labels?.length)) extras = { labels: [], rules: [], blocklist: [], unread: [] };
		}
	} catch (error) {
		if (!(error instanceof ImportError)) throw error;
		const message =
			error.reason === "fetch"
				? t("imp.err.fetch", { server, detail: error.message })
				: t(error.reason === "auth" ? "imp.err.auth" : error.reason === "empty" ? "imp.err.empty" : "imp.err.format");
		return { domains, sourceLabel: source.label, error: message, status: 400 };
	}

	// Optionally register imported custom domains into aliasDomains so the user does not have to enter them twice.
	const addedDomains: string[] = [];
	let effectiveSettings = settings;
	if (form.addDomains === "1") {
		const importedDomains = [...new Set(selection.chosen.map((alias) => domainOf(alias.email)))];
		const nextDomains = [...settings.aliasDomains];
		for (const d of importedDomains) {
			if (nextDomains.length >= MAX_ALIAS_DOMAINS) break;
			if (nextDomains.includes(d) || !DOMAIN_PATTERN.test(d)) continue;
			const trial = [...nextDomains, d];
			if (clashingDomain(trial)) continue;
			if (settings.defaultDestination && isOwnAddress(settings.defaultDestination, trial)) continue;
			nextDomains.push(d);
			addedDomains.push(d);
		}
		if (addedDomains.length) {
			await saveSettingKeys(c.env.DB, { aliasDomains: nextDomains });
			effectiveSettings = { ...settings, aliasDomains: nextDomains };
		}
	}

	// Labels first: importing the aliases labels them by name. Rules' forwardTo targets must be
	// known owner destinations (plus any destinations being imported when keepDestinations is on).
	const keepDestinations = form.destinations === "1";
	const batchSize = c.get("config").workersPlan === "free" ? 500 : 100;
	let extra: Partial<Awaited<ReturnType<typeof importAddyExtras>>> = {};
	if (extras) {
		const ownDomains = [...new Set([...effectiveSettings.aliasDomains, ...domains, ...selection.chosen.map((alias) => domainOf(alias.email))])];
		const allowedDestinations = new Set((await listDestinations(c.env.DB, effectiveSettings)).map((d) => d.email.toLowerCase()));
		if (keepDestinations) {
			for (const alias of selection.chosen) {
				if (alias.destination && !isOwnAddress(alias.destination, ownDomains)) allowedDestinations.add(alias.destination.toLowerCase());
			}
		}
		const reqHost = hostnameOf(c.req.url);
		extra = await importAddyExtras(c.env.DB, extras, selection.chosen, {
			batchSize,
			allowedDestinations,
			ownDomains,
			ownHosts: [...ownHosts(c.get("config")), ...(reqHost ? [reqHost] : [])],
		});
	}
	const result = {
		...(await importAliases(c.env.DB, effectiveSettings, sourceName as keyof typeof IMPORT_SOURCES, selection, aliases.length, {
			keepDestinations,
			// Fewer, larger batches on the Free plan, where a request may make only 50 D1 queries.
			batchSize,
		})),
		...extra,
	};
	console.log(
		JSON.stringify({ event: "import", source: sourceName, ...result, skippedDomains: result.skippedDomains.length, newDestinations: result.newDestinations.length, rulesSkipped: result.rulesSkipped?.length }),
	);
	return { domains, sourceLabel: source.label, result, addedDomains };
}

app.post("/import/:source", async (c) => {
	const outcome = await executeImport(c, c.req.param("source"), { allowAutoDetect: false });
	if (!outcome) return c.notFound();
	if (outcome.status === 413) return c.text(outcome.error ?? "", 413);
	const settings = await loadSettings(c.env.DB);
	return c.html(
		importPage(c.get("t"), {
			domains: outcome.domains.length ? outcome.domains : await defaultImportDomains(c.env.DB, settings),
			source: outcome.sourceLabel,
			result: outcome.result,
			addedDomains: outcome.addedDomains,
			addDomainsDefault: settings.aliasDomains.length === 0,
			error: outcome.error,
		}),
		outcome.error ? 400 : 200,
	);
});

// ---------- guided initial setup wizard (/onboarding) ----------

async function renderOnboarding(
	c: C,
	step: 1 | 2 | 3,
	extra: {
		config?: AppConfig;
		setup?: DomainSetup[];
		importDomains?: string[];
		importResult?: Awaited<ReturnType<typeof importAliases>>;
		addedDomains?: string[];
		importError?: string;
		importSource?: string;
		notice?: Notice;
	} = {},
) {
	const config = extra.config ?? c.get("config");
	const settings = await loadSettings(c.env.DB);
	const fixed = envOverrides(c.env);
	return c.html(
		onboardingPage(c.get("t"), {
			step,
			settings,
			cloudflare: {
				hasToken: fixed.has("cloudflareApiToken"),
				workerName: config.workerName,
				workersPlan: config.workersPlan,
				setup: extra.setup,
			},
			fixed,
			importDomains: extra.importDomains ?? (await defaultImportDomains(c.env.DB, settings)),
			importResult: extra.importResult,
			addedDomains: extra.addedDomains,
			importError: extra.importError,
			importSource: extra.importSource,
			notice: extra.notice ?? noticeFrom(c),
		}),
		extra.importError ? 400 : 200,
	);
}

app.get("/onboarding", async (c) => {
	const raw = Number(c.req.query("step"));
	const step: 1 | 2 | 3 = raw === 2 ? 2 : raw === 3 ? 3 : 1;
	return renderOnboarding(c, step);
});

app.post("/onboarding/domains", async (c) => {
	const form = await c.req.parseBody();
	const fixed = envOverrides(c.env);
	const text = (key: string) => (typeof form[key] === "string" ? (form[key] as string).trim() : "");
	const aliasDomains = [
		...new Set(
			text("aliasDomains")
				.split(/[\s,]+/)
				.map((domain) => domain.trim().toLowerCase().replace(/\.$/, ""))
				.filter(Boolean),
		),
	];
	if (!aliasDomains.length) return redirectWithNotice(c, "/onboarding?step=1", "notice.needAliasDomains");
	const badDomain = aliasDomains.find((domain) => !DOMAIN_PATTERN.test(domain)) ?? clashingDomain(aliasDomains);
	if (badDomain) return redirectWithNotice(c, "/onboarding?step=1", "notice.badAliasDomain", { value: badDomain });
	if (aliasDomains.length > MAX_ALIAS_DOMAINS) {
		return redirectWithNotice(c, "/onboarding?step=1", "notice.tooManyDomains", { count: String(MAX_ALIAS_DOMAINS) });
	}
	const destination = text("defaultDestination");
	if (destination && !extractEmail(destination)) return redirectWithNotice(c, "/onboarding?step=1", "notice.badDestination");
	if (destination && isOwnAddress(extractEmail(destination)!, aliasDomains)) {
		return redirectWithNotice(c, "/onboarding?step=1", "notice.destinationOnReverse");
	}
	const configValues: Record<string, string> = {};
	if (!fixed.has("workersPlan") && text("workersPlan")) {
		if (!isWorkersPlan(text("workersPlan"))) return redirectWithNotice(c, "/onboarding?step=1", "notice.badProvider");
		configValues.workersPlan = text("workersPlan");
	}
	if (!fixed.has("workerName") && typeof form.workerName === "string") {
		const name = text("workerName").toLowerCase();
		if (name && !WORKER_NAME_PATTERN.test(name)) return redirectWithNotice(c, "/onboarding?step=1", "notice.badWorkerName");
		configValues.workerName = name;
	}
	// Never store a Cloudflare API token submitted from the dashboard.
	const token = fixed.has("cloudflareApiToken") ? c.get("config").cloudflareApiToken : text("cloudflareApiToken");
	await c.env.DB.prepare("DELETE FROM config WHERE key = 'cloudflareApiToken'").run();
	await saveConfig(c.env.DB, configValues);
	await saveSettingKeys(c.env.DB, {
		aliasDomains,
		defaultDestination: destination ? (extractEmail(destination) ?? "") : "",
	});
	const config = await loadConfig(c.env);
	const wantsCloudflare = text("intent") !== "save" && !!token;
	if (!wantsCloudflare) return redirectWithNotice(c, "/onboarding?step=2", "notice.domainsSaved");
	if (config.workersPlan === "free" && aliasDomains.length > FREE_PLAN_SETUP_DOMAINS) {
		return redirectWithNotice(c, "/onboarding?step=1", "notice.freeSetupLimit", { count: String(FREE_PLAN_SETUP_DOMAINS) });
	}
	const setup = await setUpCloudflare({
		token,
		domains: aliasDomains,
		workerName: config.workerName,
		replaceCatchAll: form.replaceCatchAll === "1",
		wkdHost: form.wkdHost === "1",
	});
	return renderOnboarding(c, 1, { config, setup, notice: { text: c.get("t")("notice.domainsSaved") } });
});

app.post("/onboarding/import/:source", async (c) => {
	const outcome = await executeImport(c, c.req.param("source"), { allowAutoDetect: true });
	if (!outcome) return c.notFound();
	if (outcome.status === 413) return c.text(outcome.error ?? "", 413);
	return renderOnboarding(c, 2, {
		importDomains: outcome.domains,
		importSource: outcome.sourceLabel,
		importResult: outcome.result,
		addedDomains: outcome.addedDomains,
		importError: outcome.error,
	});
});

async function renderApiKeys(
	c: C,
	extra: { newKey?: string; newMailPassword?: { username: string; password: string }; notice?: Notice } = {},
) {
	const [settings, keys, mailPasswords] = await Promise.all([
		loadSettings(c.env.DB),
		listApiKeys(c.env.DB),
		listMailPasswords(c.env.DB),
	]);
	return c.html(
		apiKeysPage(c.get("t"), {
			keys,
			mailPasswords,
			enabled: { simplelogin: settings.simpleloginApi, addy: settings.addyApi, mcp: settings.mcpServer },
			mailProtocols: { imap: settings.imapEnabled, pop3: settings.pop3Enabled, smtp: settings.smtpEnabled },
			origin: publicOrigin(c),
			notice: extra.notice ?? noticeFrom(c),
			newKey: extra.newKey,
			newMailPassword: extra.newMailPassword,
		}),
	);
}

app.get("/api-keys", (c) => renderApiKeys(c));

app.post("/api-keys", async (c) => {
	// A key outlives the session, so it takes a fresh passkey confirmation, not just the cookie.
	if (!(await recentlyVerified(c))) return redirectWithNotice(c, "/api-keys", "notice.reauth");
	const form = await c.req.parseBody();
	const { key } = await createApiKey(c.env.DB, typeof form.name === "string" ? form.name : "", form.scope === "mcp" ? "mcp" : "apps");
	// Shown once, straight in the response; it is never stored or put in a URL.
	c.header("Cache-Control", "no-store");
	return renderApiKeys(c, { newKey: key });
});

app.post("/api-keys/:id/delete", async (c) => {
	await deleteApiKey(c.env.DB, c.req.param("id"));
	return redirectWithNotice(c, "/api-keys", "notice.keyRevoked");
});

app.post("/mail-passwords", async (c) => {
	// A mail app password also outlives the session, so require fresh passkey verification.
	if (!(await recentlyVerified(c))) return redirectWithNotice(c, "/api-keys", "notice.reauth");
	const form = await c.req.parseBody();
	const { password, row } = await createMailPassword(c.env.DB, {
		name: typeof form.name === "string" ? form.name : "",
		username: typeof form.username === "string" ? form.username : "aliasflare",
		allowImap: form.allowImap === "1",
		allowPop3: form.allowPop3 === "1",
		allowSmtp: form.allowSmtp === "1",
	});
	c.header("Cache-Control", "no-store");
	return renderApiKeys(c, { newMailPassword: { username: row.username, password } });
});

app.post("/mail-passwords/:id/delete", async (c) => {
	await deleteMailPassword(c.env.DB, c.req.param("id"));
	return redirectWithNotice(c, "/api-keys", "notice.keyRevoked");
});

app.get("/passkeys", async (c) => {
	const [passkeys, sessions] = await Promise.all([listPasskeys(c.env.DB), listSessions(c.env.DB)]);
	const current = await sessionId(c);
	const devices = await Promise.all(
		sessions.map(async (row) => ({ ...row, handle: await sessionHandle(row.id), current: row.id === current, label: deviceLabel(row.user_agent) })),
	);
	return c.html(passkeysPage(c.get("t"), { passkeys, devices, notice: noticeFrom(c) }));
});

// Confirming the passkey again, inside a session. With a confirmation from the last few minutes
// there is nothing to ask, and the browser goes straight on.
app.post("/reauth/options", async (c) => {
	if (await rateLimited(c)) return jsonError(c, "err.rateLimited", 429);
	if (await recentlyVerified(c)) return c.json({ fresh: true });
	const { options, challengeId } = await authenticationOptions(c.env.DB, relyingParty(c.req.url), "reauth");
	setChallengeCookie(c, challengeId);
	return c.json({ options });
});

app.post("/reauth/verify", async (c) => {
	if (await rateLimited(c)) return jsonError(c, "err.rateLimited", 429);
	const body = await readJson<{ response?: AuthenticationResponseJSON }>(c);
	if (!body?.response) return jsonError(c, "err.missingResponse", 400);
	const passkey = await completeAuthentication(c.env.DB, relyingParty(c.req.url), takeChallengeCookie(c), body.response, "reauth").catch((error) => {
		console.warn("Passkey confirmation failed:", error instanceof Error ? error.message : error);
		return null;
	});
	const id = await sessionId(c);
	if (!passkey || !id) return jsonError(c, "err.loginFailed", 401);
	await c.env.DB.prepare("UPDATE sessions SET verified_at = ? WHERE id = ?").bind(now(), id).run();
	return c.json({ ok: true });
});

app.post("/sessions/others/delete", async (c) => {
	const id = await sessionId(c);
	const result = await c.env.DB.prepare("DELETE FROM sessions WHERE id != ?").bind(id ?? "").run();
	return redirectWithNotice(c, "/passkeys", "notice.othersSignedOut", { count: String(result.meta.changes ?? 0) });
});

app.post("/sessions/:handle/delete", async (c) => {
	const handle = c.req.param("handle");
	const sessions = await listSessions(c.env.DB);
	let target: string | undefined;
	for (const row of sessions) if ((await sessionHandle(row.id)) === handle) target = row.id;
	if (!target) return redirectWithNotice(c, "/passkeys", "notice.sessionGone");
	if (target === (await sessionId(c))) {
		await endSession(c);
		return c.redirect("/login");
	}
	await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(target).run();
	return redirectWithNotice(c, "/passkeys", "notice.sessionEnded");
});

app.post("/passkeys/options", async (c) => {
	if (!(await recentlyVerified(c))) return jsonError(c, "err.reauth", 403);
	const { options, challengeId } = await registrationOptions(c.env.DB, relyingParty(c.req.url));
	setChallengeCookie(c, challengeId);
	return c.json({ options });
});

app.post("/passkeys/verify", async (c) => {
	if (!(await recentlyVerified(c))) return jsonError(c, "err.reauth", 403);
	const body = await readJson<{ response?: RegistrationResponseJSON; name?: unknown }>(c);
	if (!body?.response) return jsonError(c, "err.missingResponse", 400);
	const passkey = await completeRegistration(
		c.env.DB,
		relyingParty(c.req.url),
		takeChallengeCookie(c),
		body.response,
		typeof body.name === "string" ? body.name : "",
	).catch((error) => {
		console.warn("Passkey registration failed:", error instanceof Error ? error.message : error);
		return null;
	});
	if (!passkey) return jsonError(c, "err.registerFailed", 400);
	return c.json({ ok: true });
});

app.post("/passkeys/:id/delete", async (c) => {
	// Never remove the last passkey, or nobody could sign in again.
	const id = c.req.param("id");
	const result = await c.env.DB.prepare("DELETE FROM passkeys WHERE id = ? AND (SELECT COUNT(*) FROM passkeys) > 1").bind(id).run();
	// Sessions started with that passkey end with it (also by ON DELETE CASCADE where enforced).
	if (result.meta.changes > 0) await c.env.DB.prepare("DELETE FROM sessions WHERE passkey_id = ?").bind(id).run();
	return redirectWithNotice(c, "/passkeys", result.meta.changes > 0 ? "notice.passkeyRemoved" : "notice.lastPasskey");
});

// Batch actions on the aliases ticked in the list.
const BULK_ACTIONS = ["all", "no_promotions", "none", "pin", "unpin", "note", "destination", "delete", "restore", "forget"] as const;

app.post("/aliases/bulk", async (c) => {
	const form = await c.req.parseBody({ all: true });
	const back = typeof form.back === "string" && /^\/(\?|$)/.test(form.back) ? safeLocalPath(form.back) : "/";
	const done = (key: MessageKey, params?: Record<string, string>) =>
		c.redirect(noticeUrl(back, key, params));
	const action = form.action as (typeof BULK_ACTIONS)[number];
	const ids = [...new Set((Array.isArray(form.ids) ? form.ids : [form.ids]).filter((id): id is string => typeof id === "string").map(normalizeEmail))].slice(0, 500);
	if ((form.action === "label" || form.action === "unlabel") && ids.length) {
		const labelIds = [...new Set((Array.isArray(form.labels) ? form.labels : [form.labels]).filter((id): id is string => typeof id === "string" && /^lb_[0-9a-f]{32}$/.test(id)))].slice(0, 100);
		if (!labelIds.length) return done("notice.bulkNoLabels");
		const changed = await toggleAliasLabels(c.env.DB, ids, labelIds, form.action === "label");
		return done("notice.bulkDone", { count: String(changed) });
	}
	if (!BULK_ACTIONS.includes(action) || ids.length === 0) return done("notice.bulkBad");
	const value = typeof form.value === "string" ? form.value.trim() : "";
	const db = c.env.DB;
	let destination: string | null = null;
	if (action === "destination") {
		destination = value ? extractEmail(value) : null;
		if (value && !destination) return done("notice.badDestination");
		const own = [...(await loadSettings(db)).aliasDomains, ...ids.map(domainOf)];
		if (destination && (isOwnAddress(destination, own) || ids.includes(destination))) return done("notice.loop");
	}
	const timestamp = now();
	const statement = (sql: string, ...bind: unknown[]) => ids.map((id) => db.prepare(sql).bind(...bind, id));
	const statements =
		action === "all" || action === "no_promotions" || action === "none"
			? statement("UPDATE aliases SET forward_mode = ?, forward_enabled = ?, updated_at = ? WHERE address = ? AND deleted_at IS NULL", action, action === "none" ? 0 : 1, timestamp)
			: action === "pin" || action === "unpin"
				? statement("UPDATE aliases SET pinned = ?, updated_at = ? WHERE address = ? AND deleted_at IS NULL", action === "pin" ? 1 : 0, timestamp)
				: action === "note"
					? statement("UPDATE aliases SET note = ?, updated_at = ? WHERE address = ? AND deleted_at IS NULL", value.slice(0, MAX_NOTE_LENGTH) || null, timestamp)
					: action === "destination"
						? statement("UPDATE aliases SET destination = ?, updated_at = ? WHERE address = ? AND deleted_at IS NULL", destination, timestamp)
						: action === "delete"
							? statement(
									"UPDATE aliases SET deleted_at = ?, forward_mode = 'none', forward_enabled = 0, pinned = 0, updated_at = ? WHERE address = ? AND deleted_at IS NULL",
									timestamp,
									timestamp,
								)
							: action === "restore"
								? statement("UPDATE aliases SET deleted_at = NULL, updated_at = ? WHERE address = ? AND deleted_at IS NOT NULL", timestamp)
								: // Permanently deleting is only offered for deleted aliases, and only removes those,
									// with everything recorded about them: contacts, forwards and other activity.
									ids.flatMap((id) => forgetStatements(db, id));
	// Only the last statement for each alias says whether that alias changed.
	const perAlias = statements.length / ids.length;
	let changed = 0;
	for (let i = 0; i < statements.length; i += 100) {
		const results = await db.batch(statements.slice(i, i + 100));
		results.forEach((result, offset) => {
			if ((i + offset) % perAlias === perAlias - 1) changed += result.meta.changes ?? 0;
		});
	}
	return done("notice.bulkDone", { count: String(Math.min(changed, ids.length)) });
});

app.post("/aliases/:address/mode", async (c) => {
	const address = normalizeEmail(c.req.param("address"));
	const form = await c.req.parseBody();
	const back = aliasBack(form, address);
	if (!isForwardMode(form.mode)) return savedNotice(c, back, "notice.badMode", false);
	if (!(await setForwardMode(c.env.DB, address, form.mode))) return savedNotice(c, back, "notice.aliasMissing", false);
	return savedNotice(c, back, "notice.modeSaved", true, { alias: address });
});

app.post("/aliases/new", async (c) => {
	const db = c.env.DB;
	const settings = await loadSettings(db);
	const form = await c.req.parseBody();
	const field = (name: string, max: number) => (typeof form[name] === "string" ? (form[name] as string).trim().slice(0, max) : "");
	const domain = field("domain", 253).toLowerCase();
	if (!settings.aliasDomains.includes(domain)) return redirectWithNotice(c, "/", "notice.newBadDomain");
	const rawDestination = field("destination", 254);
	const destination = rawDestination ? extractEmail(rawDestination) : null;
	if (rawDestination && !destination) return redirectWithNotice(c, "/", "notice.badDestination");
	if (destination && isOwnAddress(destination, settings.aliasDomains)) {
		return redirectWithNotice(c, "/", "notice.loop");
	}
	const note = field("note", 500) || null;
	// A random kind (words, characters or UUID) ignores any name; "custom" requires a name.
	const kind = isRandomAliasFormat(form.kind) ? form.kind : null;
	const prefix = kind ? "" : field("prefix", 64);
	if (form.kind === "custom" && !prefix) return redirectWithNotice(c, "/", "notice.newBadPrefix");
	try {
		let alias;
		if (!prefix) {
			alias = await createRandomAlias(db, settings, { domain, note, destination, ...(kind ? { format: kind } : {}) });
		} else {
			const cleaned = cleanPrefix(prefix);
			if (!cleaned || cleaned !== prefix.toLowerCase()) return redirectWithNotice(c, "/", "notice.newBadPrefix");
			alias = await createAlias(db, settings, { localPart: cleaned, domain, note, destination });
		}
		return redirectWithNotice(c, "/", "notice.newCreated", { alias: alias.address });
	} catch (error) {
		if (error instanceof ClientError) {
			return redirectWithNotice(c, "/", error.status === 409 ? "notice.newExists" : error.status === 400 ? "notice.newBadPrefix" : "notice.newFailed");
		}
		throw error;
	}
});

app.post("/aliases/:address/destination", async (c) => {
	const address = normalizeEmail(c.req.param("address"));
	const form = await c.req.parseBody();
	const back = aliasBack(form, address);
	const raw = typeof form.destination === "string" ? form.destination.trim() : "";
	const destination = raw ? extractEmail(raw) : null;
	if (raw && !destination) return savedNotice(c, back, "notice.badDestination", false);
	if (destination && (isOwnAddress(destination, [...(await loadSettings(c.env.DB)).aliasDomains, domainOf(address)]) || destination === address)) {
		return savedNotice(c, back, "notice.loop", false);
	}
	const saved = await c.env.DB.prepare("UPDATE aliases SET destination = ?, updated_at = ? WHERE address = ? AND deleted_at IS NULL").bind(destination, now(), address).run();
	if (!saved.meta.changes) return savedNotice(c, back, "notice.aliasMissing", false);
	return savedNotice(c, back, "notice.aliasDestinationSaved", true, { alias: address });
});

app.post("/aliases/:address/note", async (c) => {
	const address = normalizeEmail(c.req.param("address"));
	const form = await c.req.parseBody();
	const note = (typeof form.note === "string" ? form.note : "").trim().slice(0, MAX_NOTE_LENGTH) || null;
	const result = await c.env.DB.prepare("UPDATE aliases SET note = ?, updated_at = ? WHERE address = ? AND deleted_at IS NULL").bind(note, now(), address).run();
	if (c.req.header("X-Autosave") === "1") {
		// Saved in place from the alias list or alias page.
		return result.meta.changes > 0
			? c.json({ ok: true, message: c.get("t")("notice.noteSaved") })
			: c.json({ ok: false, message: c.get("t")("notice.aliasMissing") }, 404);
	}
	const back = form.back === "list" ? "/" : `/aliases/${encodeURIComponent(address)}`;
	return redirectWithNotice(c, back, result.meta.changes > 0 ? "notice.noteSaved" : "notice.aliasMissing");
});

app.get("/aliases/:address", async (c) => {
	const db = c.env.DB;
	const address = normalizeEmail(c.req.param("address"));
	// Everything on the page at once: the alias, its contacts and labels, and all labels.
	const [alias, { results: contacts }, labels, chosen, { defaultDestination }, wkd] = await Promise.all([
		getAlias(db, address),
		db.prepare("SELECT * FROM contacts WHERE alias_address = ? ORDER BY COALESCE(last_forward_at, created_at) DESC LIMIT 1000").bind(address).all<ContactRow>(),
		listLabels(db),
		labelsOf(db, [address]),
		pageSettings(c),
		wkdKeyOf(db, address),
	]);
	if (!alias) return c.notFound();
	const aliasLabels = (chosen.get(address) ?? []).map((label) => label.id);
	return c.html(aliasPage(c.get("t"), { alias, contacts, defaultDestination, labels, aliasLabels, wkd, notice: noticeFrom(c) }));
});

const WKD_NOTICES: Record<PgpError["reason"] | WkdError["reason"], MessageKey> = {
	invalid: "notice.pgpInvalid",
	private: "notice.pgpPrivate",
	noEncryption: "notice.pgpNoEncryption",
	expired: "notice.pgpExpired",
	tooLarge: "notice.pgpTooLarge",
	otherAddress: "notice.wkdOtherAddress",
	keyInUse: "notice.wkdKeyInUse",
};

app.post("/aliases/:address/wkd", async (c) => {
	const address = normalizeEmail(c.req.param("address"));
	const back = `/aliases/${encodeURIComponent(address)}`;
	const alias = await getAlias(c.env.DB, address);
	if (!alias || alias.deleted_at) return c.notFound();
	const form = await c.req.parseBody();
	try {
		await saveWkdKey(c.env.DB, address, await readWkdKey(typeof form.key === "string" ? form.key : "", address));
	} catch (error) {
		if (error instanceof PgpError || error instanceof WkdError) return redirectWithNotice(c, back, WKD_NOTICES[error.reason], { alias: address });
		throw error;
	}
	return redirectWithNotice(c, back, "notice.wkdSaved", { alias: address });
});

app.post("/aliases/:address/wkd/delete", async (c) => {
	const address = normalizeEmail(c.req.param("address"));
	await c.env.DB.prepare("DELETE FROM wkd_keys WHERE alias_address = ?").bind(address).run();
	return redirectWithNotice(c, `/aliases/${encodeURIComponent(address)}`, "notice.wkdDeleted", { alias: address });
});

app.post("/aliases/:address/labels", async (c) => {
	const address = normalizeEmail(c.req.param("address"));
	const alias = await getAlias(c.env.DB, address);
	if (!alias || alias.deleted_at) return c.notFound();
	const form = await c.req.parseBody({ all: true });
	const chosen = (Array.isArray(form.labels) ? form.labels : [form.labels]).filter((id): id is string => typeof id === "string");
	await setAliasLabels(c.env.DB, [address], chosen);
	return redirectWithNotice(c, `/aliases/${encodeURIComponent(address)}`, "notice.aliasLabelsSaved", { alias: address });
});

app.post("/aliases/:address/contacts", async (c) => {
	const alias = await getAlias(c.env.DB, normalizeEmail(c.req.param("address")));
	if (!alias || alias.deleted_at) return c.notFound();
	const base = `/aliases/${encodeURIComponent(alias.address)}`;
	const form = await c.req.parseBody();
	const settings = await loadSettings(c.env.DB);
	const email = extractEmail(typeof form.email === "string" ? form.email : "");
	if (!email || isOwnAddress(email, [...settings.aliasDomains, domainOf(alias.address)])) return redirectWithNotice(c, base, "notice.badContact");
	const contact = await ensureContact(c.env.DB, alias.address, email, null, settings.includeSenderInReverseAlias);
	return redirectWithNotice(c, base, "notice.contactCreated", { reverse: contactReverseAddress(contact), email });
});

// Where one sender's mail goes: another address, or (empty) the alias's own again.
app.post("/aliases/:address/contacts/:id/destination", async (c) => {
	const address = normalizeEmail(c.req.param("address"));
	const base = `/aliases/${encodeURIComponent(address)}`;
	const form = await c.req.parseBody();
	const raw = typeof form.destination === "string" ? form.destination.trim() : "";
	const destination = raw ? extractEmail(raw) : null;
	if (raw && !destination) return redirectWithNotice(c, base, "notice.badDestination");
	const settings = await loadSettings(c.env.DB);
	if (destination && isOwnAddress(destination, [...settings.aliasDomains, domainOf(address)])) return redirectWithNotice(c, base, "notice.destinationOnReverse");
	const result = await c.env.DB
		.prepare("UPDATE contacts SET destination = ? WHERE id = ? AND alias_address = ? AND EXISTS (SELECT 1 FROM aliases WHERE address = ? AND deleted_at IS NULL)")
		.bind(destination?.toLowerCase() ?? null, c.req.param("id"), address, address)
		.run();
	if (!result.meta.changes) return redirectWithNotice(c, base, "notice.contactMissing");
	return redirectWithNotice(c, base, "notice.contactDestinationSaved");
});

app.post("/aliases/:address/contacts/:id/block", async (c) => {
	const address = normalizeEmail(c.req.param("address"));
	await c.env.DB
		.prepare("UPDATE contacts SET blocked = 1 - blocked WHERE id = ? AND alias_address = ? AND EXISTS (SELECT 1 FROM aliases WHERE address = ? AND deleted_at IS NULL)")
		.bind(c.req.param("id"), address, address)
		.run();
	return c.redirect(`/aliases/${encodeURIComponent(address)}`);
});

/**
 * Removes a contact and its history with the alias. Its reverse alias stops working; if the
 * sender writes again, they become a new contact with a new reverse alias. The activity log
 * keeps its entries.
 */
app.post("/aliases/:address/contacts/:id/delete", async (c) => {
	const address = normalizeEmail(c.req.param("address"));
	const result = await c.env.DB.prepare("DELETE FROM contacts WHERE id = ? AND alias_address = ?").bind(c.req.param("id"), address).run();
	return redirectWithNotice(c, `/aliases/${encodeURIComponent(address)}`, result.meta.changes > 0 ? "notice.contactDeleted" : "notice.contactMissing");
});

export { app };

export default {
	fetch(request, env, ctx) {
		// An API URL saved with a trailing slash ("https://host/") makes apps call "//api/…" or "/api//v1/…".
		const url = new URL(request.url);
		if (url.pathname.includes("//")) {
			url.pathname = url.pathname.replace(/\/{2,}/g, "/");
			const normalized = new Request(url, request);
			const cf = (request as { cf?: unknown }).cf;
			if (cf !== undefined) Object.defineProperty(normalized, "cf", { value: cf });
			return app.fetch(normalized, env, ctx);
		}
		return app.fetch(request, env, ctx);
	},
	async scheduled(_controller, env, ctx) {
		ctx.waitUntil(
			(async () => {
				const config = await loadConfig(env);
				const settings = await loadSettings(env.DB);
				await cleanUp(env.DB, now(), { env, config, settings });
			})(),
		);
	},
	async email(message, env) {
		// One D1 round trip for what every message needs: the configuration, the settings and the
		// alias it was sent to (none for a reply, whose address is a reverse alias).
		const address = normalizeEmail(message.to);
		const db = env.DB;
		const loaded = await db
			.batch<Record<string, unknown>>([db.prepare("SELECT key, value FROM config"), db.prepare("SELECT key, value FROM settings"), db.prepare("SELECT * FROM aliases WHERE address = ?").bind(address)])
			.then(async ([config, settings, alias]) => ({
				config: await loadConfig(env, config!.results as { key: string; value: string }[]),
				settings: settingsFromRows(settings!.results as { key: string; value: string }[]),
				known: (alias!.results[0] as AliasRow | undefined) ?? null,
			}))
			.catch((error) => {
				console.error("Configuration error:", error instanceof Error ? error.message : error);
				return null;
			});
		if (!loaded) {
			message.setReject("This address is temporarily unavailable");
			return;
		}
		const { config, settings, known } = loaded;
		// An alias domain may itself start with "r." (when its parent is not an alias domain),
		// so alias domains are matched first.
		const domain = domainOf(address);
		if (!settings.aliasDomains.includes(domain)) {
			if (aliasDomainOfReverse(domain)) await handleReverseAliasMail(message, env, config, settings);
			else message.setReject("This address does not exist");
			return;
		}
		const outcome = await handleDirectInbound(message, env, config, { settings, known });
		if (outcome.status === 404) {
			message.setReject("This address does not exist");
			return;
		}
		if (outcome.status === 413) {
			message.setReject("Message too large");
			return;
		}
		// A failure or in-progress race the next attempt may fix: throwing makes the sending server try again later.
		if (outcome.status === 409 || outcome.status >= 500) throw new Error(`Forwarding failed: ${outcome.result}`);
	},
} satisfies ExportedHandler<Env>;
