import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { html } from "hono/html";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import {
	endSession,
	isSignedIn,
	requireAdmin,
	sameOrigin,
	setChallengeCookie,
	startSession,
	takeChallengeCookie,
	type AppEnv,
} from "./auth";
import { APP_SCRIPT, PASSKEY_SCRIPT } from "./client";
import { createApiKey, deleteApiKey, listApiKeys } from "./apikeys";
import { setUpCloudflare, type DomainSetup } from "./cloudflare";
import { api } from "./compat/api";
import { ClientError, cleanPrefix, createAlias, createRandomAlias } from "./compat/aliases";
import { ConfigError, DOMAIN_PATTERN, envOverrides, isWorkersPlan, loadConfig, mailflareReady, missingConnection, saveConfig, validOrigin, WORKER_NAME_PATTERN, type AppConfig } from "./config";
import { isOutboundProvider } from "./outbound";
import { aliasDomainOfReverse, clashingDomain, contactReverseAddress, isOwnAddress } from "./domains";
import { verifyWebhookSignature } from "./crypto";
import { ensureContact, getAlias, isForwardMode, newId, now, setForwardMode, type AliasRow, type BlocklistRow, type ContactRow } from "./db";
import { domainOf, extractEmail, MAX_NOTE_LENGTH, normalizeEmail, pageParam } from "./format";
import { handleDirectInbound, handleInbound, type InboundEvent } from "./forward";
import {
	addSimpleLoginContacts,
	newFetchBudget,
	defaultImportDomains,
	fetchAddy,
	fetchSimpleLogin,
	ImportError,
	importAliases,
	parseAliasCsv,
	selectByDomain,
	type ImportedAlias,
	type Selection,
} from "./importer";
import { isLocale, isNoticeKey, LANG_COOKIE, negotiateLocale, translator, type MessageKey } from "./i18n";
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
import { handleReverseAliasMail } from "./reply";
import { isRandomAliasFormat, loadSettings, normalizeSettings, saveSettings } from "./settings";
import {
	aliasPage,
	apiKeysPage,
	blocklistPage,
	connectionPage,
	dashboardPage,
	FAVICON_SVG,
	STYLE,
	importPage,
	loginPage,
	messagePage,
	passkeysPage,
	settingsPage,
	setupPage,
	ALIAS_PAGE_SIZES,
	activityListPage,
	DEFAULT_ALIAS_PAGE_SIZE,
	type ActivityItem,
} from "./ui";
import { readTextLimited } from "./streams";
import { claimLink, describeAction, performAction, releaseLink, resolveLink, safeHttpsUrl } from "./unsubscribe";

const MAX_WEBHOOK_BYTES = 64 * 1024;
const MAX_JSON_BYTES = 32 * 1024;

const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
	await next();
	c.header("X-Content-Type-Options", "nosniff");
	c.header("Referrer-Policy", "same-origin");
	c.header("X-Frame-Options", "DENY");
	c.header(
		"Content-Security-Policy",
		"default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
	);
});

/** Static files: they need neither the configuration (a D1 read) nor a language. */
const STATIC_PATHS = new Set(["/assets/passkey.js", "/assets/app.js", "/assets/app.css", "/favicon.svg"]);
/** A year, for a versioned asset URL; an unversioned one is kept briefly so a deploy shows soon. */
const assetCache = (c: C) => (c.req.query("v") ? "public, max-age=31536000, immutable" : "public, max-age=300");

app.use("*", async (c, next) => {
	if (STATIC_PATHS.has(c.req.path)) return next();
	try {
		c.set("config", await loadConfig(c.env));
	} catch (error) {
		if (!(error instanceof ConfigError)) throw error;
		console.error("Configuration error:", error.message);
		return c.text(`aliasflare cannot start: ${error.message}. Fix the Worker's variables or secrets and deploy again.`, 500);
	}
	const chosen = getCookie(c, LANG_COOKIE);
	c.set("t", translator(isLocale(chosen) ? chosen : negotiateLocale(c.req.header("Accept-Language"))));
	await next();
});

type C = Context<AppEnv>;

/**
 * A URL that shows a notice once at the top of the page. Only the message key and its
 * values travel in the URL, so a crafted link cannot put text of its own on the page.
 */
function noticeUrl(path: string, key: MessageKey, params?: Record<string, string>): string {
	const query = new URLSearchParams({ notice: key });
	for (const [name, value] of Object.entries(params ?? {})) query.set(`n.${name}`, value);
	return `${path}${path.includes("?") ? "&" : "?"}${query}`;
}

function redirectWithNotice(c: C, path: string, key: MessageKey, params?: Record<string, string>) {
	return c.redirect(noticeUrl(path, key, params));
}

/** The notice named in the URL, translated, or nothing for an unknown key. */
function noticeFrom(c: C): string | undefined {
	const key = c.req.query("notice");
	if (!isNoticeKey(key)) return undefined;
	const params: Record<string, string> = {};
	for (const [name, value] of Object.entries(c.req.query())) if (name.startsWith("n.")) params[name.slice(2)] = value.slice(0, 200);
	return c.get("t")(key, params);
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

async function rateLimited(c: C): Promise<boolean> {
	const key = c.req.header("CF-Connecting-IP") ?? "unknown";
	return !!c.env.LOGIN_RATE_LIMIT && !(await c.env.LOGIN_RATE_LIMIT.limit({ key })).success;
}

const jsonError = (c: C, key: MessageKey, status: 400 | 401 | 403 | 409 | 429) => c.json({ error: c.get("t")(key) }, status);

app.get("/health", async (c) => c.json({ ok: missingConnection(await loadSettings(c.env.DB)).length === 0 }));

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

// The language menu submits here (GET /lang?locale=…&next=…); /lang/:locale is the no-form link form.
/**
 * A path on this site to redirect to, or "/". Control characters and backslashes are
 * refused outright, since browsers drop or rewrite them and "/\t/evil.example" would
 * otherwise become "//evil.example".
 */
export function safeLocalPath(value: string | undefined | null): string {
	if (!value || !value.startsWith("/") || /[\x00-\x1f\x7f\\]/.test(value)) return "/";
	try {
		const parsed = new URL(value, "https://local.invalid");
		return parsed.origin === "https://local.invalid" ? `${parsed.pathname}${parsed.search}${parsed.hash}` : "/";
	} catch {
		return "/";
	}
}

app.get("/lang/:locale?", (c) => {
	const locale = c.req.param("locale") ?? c.req.query("locale");
	if (isLocale(locale)) {
		setCookie(c, LANG_COOKIE, locale, { path: "/", secure: true, sameSite: "Lax", maxAge: 60 * 60 * 24 * 365 });
	}
	return c.redirect(safeLocalPath(c.req.query("next")));
});

// SimpleLogin and addy.io client APIs (off until enabled in Settings).
app.route("/api", api);

// Mailflare webhook: message.inbound → forward to the alias's destination.
app.post("/webhook", async (c) => {
	const config = c.get("config");
	if (!mailflareReady(config)) return c.json({ error: "Mailflare is not configured" }, 503);
	const body = await readTextLimited(c.req.raw, MAX_WEBHOOK_BYTES);
	if (body === null) return c.json({ error: "Payload too large" }, 413);
	if (!(await verifyWebhookSignature(config.webhookSecret, body, c.req.header("X-Email-Platform-Signature") ?? null))) {
		return c.json({ error: "Invalid signature" }, 401);
	}
	let payload: { type?: string; data?: InboundEvent };
	try {
		payload = JSON.parse(body);
	} catch {
		return c.json({ error: "Invalid JSON" }, 400);
	}
	if (payload.type !== "message.inbound" || !payload.data) return c.json({ result: "ignored" });
	const outcome = await handleInbound(c.env, config, payload.data, publicOrigin(c));
	return c.json({ result: outcome.result }, outcome.status as 200);
});

// Signed links in forwarded mail. GET only shows a confirmation, so link scanners change
// nothing; the change happens on POST (RFC 8058 one-click unsubscribe, or the button).
// Each link works once: a link that leaks, say in a quoted reply, cannot be replayed.
for (const kind of ["unsubscribe", "action"] as const) {
	const invalid = (c: C) => {
		const t = c.get("t");
		return c.html(messagePage(t, t("link.invalidTitle"), html`<p>${t("link.invalid")}</p>`), 404);
	};
	const resolve = (c: C) => resolveLink(c.env, c.get("config"), kind, c.req.param("token") ?? "", [new URL(c.req.url).hostname]);
	app.get(`/${kind}/:token`, async (c) => {
		const t = c.get("t");
		const target = await resolve(c);
		if (!target) return invalid(c);
		const title = kind === "unsubscribe" ? t("link.unsubscribe") : target.action === "disable_alias" ? t("link.disable") : t("link.block");
		return c.html(
			messagePage(t, title, html`<p>${describeAction(target, t)}</p><form method="post"><button class="primary">${title}</button></form>`),
		);
	});
	app.post(`/${kind}/:token`, async (c) => {
		const t = c.get("t");
		// The one-click unsubscribe POST comes from mail providers' servers, without an Origin;
		// the banner buttons are only ever pressed on this site's own confirmation page.
		if (kind === "action" && !sameOrigin(c)) return c.text(t("err.crossSite"), 403);
		if (await rateLimited(c)) return c.text(t("err.rateLimited"), 429);
		const target = await resolve(c);
		if (!target) return invalid(c);
		if (!(await claimLink(c.env.DB, target.token))) {
			return c.html(messagePage(t, t("link.done"), html`<p>${t("link.used")}</p>`));
		}
		let done;
		try {
			({ done } = await performAction(c.env, c.get("config"), target));
		} catch (error) {
			await releaseLink(c.env.DB, target.token);
			console.error("Link action failed", kind, error instanceof Error ? error.message : error);
			return c.html(messagePage(t, t("link.error"), html`<p>${t("link.tryAgain")}</p>`), 500);
		}
		// What actually happened: a block, when the sender's own unsubscribe could not be run.
		return c.html(messagePage(t, t("link.done"), html`<p>${describeAction(done, t)}</p>`));
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
	if (await hasPasskeys(c.env.DB)) return c.redirect("/login");
	if (await rateLimited(c)) return c.text(c.get("t")("err.rateLimited"), 429);
	if (!c.env.SETUP_CODE?.trim()) await issueSetupCode(c.env.DB, true);
	return redirectWithNotice(c, "/setup", "notice.setupCodeIssued");
});

app.post("/setup/options", async (c) => {
	if (!sameOrigin(c)) return jsonError(c, "err.crossSite", 403);
	if (await hasPasskeys(c.env.DB)) return jsonError(c, "err.setupDone", 409);
	if (await rateLimited(c)) return jsonError(c, "err.rateLimited", 429);
	const body = await readJson<{ code?: string }>(c);
	if (!body?.code || !(await checkSetupCode(c.env, body.code))) return jsonError(c, "err.badCode", 401);
	const { options, challengeId } = await registrationOptions(c.env.DB, relyingParty(c.req.url), "setup_register");
	setChallengeCookie(c, challengeId);
	return c.json({ options });
});

app.post("/setup/verify", async (c) => {
	if (!sameOrigin(c)) return jsonError(c, "err.crossSite", 403);
	if (await hasPasskeys(c.env.DB)) return jsonError(c, "err.setupDone", 409);
	if (await rateLimited(c)) return jsonError(c, "err.rateLimited", 429);
	const body = await readJson<{ response?: RegistrationResponseJSON; name?: string }>(c);
	if (!body?.response) return jsonError(c, "err.missingResponse", 400);
	const passkey = await completeRegistration(
		c.env.DB,
		relyingParty(c.req.url),
		takeChallengeCookie(c),
		body.response,
		body.name ?? "",
		"setup_register",
	).catch(() => null);
	if (!passkey) return jsonError(c, "err.registerFailed", 400);
	await c.env.DB.prepare("DELETE FROM auth_challenges WHERE purpose = 'setup'").run();
	// The language picked during setup also becomes the language of forwarded-mail banners.
	const settings = await loadSettings(c.env.DB);
	await saveSettings(c.env.DB, { ...settings, language: c.get("t").locale });
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
	const passkey = await completeAuthentication(c.env.DB, relyingParty(c.req.url), takeChallengeCookie(c), body.response).catch(() => null);
	if (!passkey) return jsonError(c, "err.loginFailed", 401);
	await startSession(c, passkey.id);
	return c.json({ ok: true });
});

app.post("/logout", async (c) => {
	if (!sameOrigin(c)) return c.text(c.get("t")("err.crossSite"), 403);
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
const FREE_PLAN_SETUP_DOMAINS = 3;
const DASHBOARD_ACTIVITY = 10;
const ACTIVITY_PER_PAGE = 50;

/**
 * Forwards and other events, newest first. One compound query whose two halves each read an
 * index in time order (forwards_updated_idx, events_created_idx), so a page never sorts the
 * whole history.
 */
async function activityPage(db: D1Database, limit: number, offset: number): Promise<ActivityItem[]> {
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

app.get("/activity", async (c) => {
	const db = c.env.DB;
	const page = pageParam(c.req.query("page"), 1);
	const [items, counted] = await Promise.all([
		activityPage(db, ACTIVITY_PER_PAGE, (page - 1) * ACTIVITY_PER_PAGE),
		db.prepare("SELECT (SELECT COUNT(*) FROM forwards) + (SELECT COUNT(*) FROM events) AS total").first<{ total: number }>(),
	]);
	const lastPage = Math.max(1, Math.ceil((counted?.total ?? 0) / ACTIVITY_PER_PAGE));
	return c.html(activityListPage(c.get("t"), { items, page, lastPage }));
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
	const settings = await loadSettings(db);
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
	if (query) {
		const fields = ["address", "COALESCE(note, '')", "COALESCE(name, '')", "COALESCE(destination, '')"];
		where.push(`(${fields.map((field) => `${field} LIKE ? ESCAPE '!'`).join(" OR ")})`);
		const like = `%${query.toLowerCase().replace(/[!%_]/g, (char) => `!${char}`)}%`;
		params.push(like, like, like, like);
	}
	const clause = `WHERE ${where.join(" AND ")}`;
	const [{ results: aliases }, counted] = await Promise.all([
		db
			.prepare(
				`SELECT aliases.*, (SELECT COUNT(*) FROM contacts WHERE contacts.alias_address = aliases.address) AS contacts, last_used_at AS used_at FROM aliases ${clause}
				 ORDER BY pinned DESC, ${LAST_USED} DESC, num_id DESC LIMIT ? OFFSET ?`,
			)
			.bind(...params, perPage, (pageNumber - 1) * perPage)
			.all<AliasRow & { contacts: number }>(),
		db.prepare(`SELECT COUNT(*) AS total FROM aliases ${clause}`).bind(...params).first<{ total: number }>(),
	]);
	const list = { query, filter, page: pageNumber, perPage, total: counted?.total ?? 0 };
	const activity = await activityPage(db, DASHBOARD_ACTIVITY, 0);
	return c.html(
		dashboardPage(c.get("t"), { settings, aliases, list, activity, missing: missingConnection(settings), notice: noticeFrom(c) }),
	);
});

app.get("/settings", async (c) =>
	c.html(
		settingsPage(c.get("t"), {
			settings: await loadSettings(c.env.DB),
			origin: publicOrigin(c),
			notice: noticeFrom(c),
		}),
	),
);

app.post("/settings", async (c) => {
	const form = await c.req.parseBody();
	// The page saves each change as it happens (X-Autosave) and expects JSON; without script it posts the form.
	// The dashboard language lives in a cookie in this browser; the page reloads to show it.
	const uiLocale = form.uiLocale;
	const localeChanged = isLocale(uiLocale) && uiLocale !== c.get("t").locale;
	if (localeChanged) {
		setCookie(c, LANG_COOKIE, uiLocale, { path: "/", secure: true, sameSite: "Lax", maxAge: 60 * 60 * 24 * 365 });
		c.set("t", translator(uiLocale));
	}
	const reply = (key: MessageKey, ok: boolean, params?: Record<string, string>) =>
		c.req.header("X-Autosave") === "1"
			? c.json({ ok, message: c.get("t")(key, params), reload: localeChanged }, ok ? 200 : 400)
			: redirectWithNotice(c, "/settings", key, params);
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
	if (destination && !extractEmail(destination)) return reply("notice.badDestination", false);
	if (destination && isOwnAddress(extractEmail(destination)!, aliasDomains)) return reply("notice.destinationOnReverse", false);
	const settings = normalizeSettings({
		simpleloginApi: form.simpleloginApi === "1",
		addyApi: form.addyApi === "1",
		aliasDomains,
		randomAliasFormat: form.randomAliasFormat,
		appSettings: form.appSettings === "1",
		senderFormat: form.senderFormat,
		reverseAliasReplacement: form.reverseAliasReplacement === "1",
		includeSenderInReverseAlias: form.includeSenderInReverseAlias === "1",
		autoForwardNewAliases: form.autoForwardNewAliases === "1",
		createAliasesFromMail: form.createAliasesFromMail === "1",
		removeTrackers: form.removeTrackers === "1",
		showBanner: form.showBanner === "1",
		unsubscribeBehavior: form.unsubscribeBehavior,
		language: form.language,
		// The bare address, so "Owner <owner@example.com>" is stored as owner@example.com.
		defaultDestination: destination ? (extractEmail(destination) ?? "") : "",
	});
	await saveSettings(c.env.DB, settings);
	return reply("notice.settingsSaved", true);
});

async function renderConnection(c: C, config: AppConfig, setup?: DomainSetup[]) {
	const settings = await loadSettings(c.env.DB);
	return c.html(
		connectionPage(c.get("t"), {
			values: { mailflareUrl: config.mailflareUrl, publicUrl: config.publicUrl, outboundProvider: config.outboundProvider, workersPlan: config.workersPlan },
			hasOutboundKey: !!config.outboundApiKey,
			hasApiKey: !!config.mailflareApiKey,
			hasWebhookSecret: !!config.webhookSecret,
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
	const settings = await loadSettings(c.env.DB);
	const chosen = (Array.isArray(form.domains) ? form.domains : [form.domains]).filter((domain): domain is string => typeof domain === "string");
	const domains = settings.aliasDomains.filter((domain) => chosen.includes(domain));
	if (!domains.length) return redirectWithNotice(c, "/connection", "notice.needAliasDomains");
	// Each domain takes about a dozen Cloudflare API calls; the Free plan allows 50 subrequests per request.
	if (config.workersPlan === "free" && domains.length > FREE_PLAN_SETUP_DOMAINS) {
		return redirectWithNotice(c, "/connection", "notice.freeSetupLimit", { count: String(FREE_PLAN_SETUP_DOMAINS) });
	}
	if (!token) return redirectWithNotice(c, "/connection", "notice.needCloudflareToken");
	const setup = await setUpCloudflare({ token, domains, workerName: config.workerName, replaceCatchAll: form.replaceCatchAll === "1" });
	return renderConnection(c, config, setup);
});


app.post("/connection", async (c) => {
	const form = await c.req.parseBody();
	const fixed = envOverrides(c.env);
	const text = (key: string) => (typeof form[key] === "string" ? (form[key] as string).trim() : "");
	const values: Record<string, string> = {};

	if (!fixed.has("mailflareUrl")) {
		const origin = text("mailflareUrl") ? validOrigin(text("mailflareUrl")) : "";
		if (origin === null) return redirectWithNotice(c, "/connection", "notice.badMailflareUrl");
		values.mailflareUrl = origin;
	}
	if (!fixed.has("publicUrl")) {
		const origin = text("publicUrl") ? validOrigin(text("publicUrl")) : "";
		if (origin === null) return redirectWithNotice(c, "/connection", "notice.badPublicUrl");
		values.publicUrl = origin;
	}
	if (!fixed.has("outboundProvider") && text("outboundProvider")) {
		if (!isOutboundProvider(text("outboundProvider"))) return redirectWithNotice(c, "/connection", "notice.badProvider");
		values.outboundProvider = text("outboundProvider");
	}
	if (!fixed.has("workersPlan") && text("workersPlan")) {
		if (!isWorkersPlan(text("workersPlan"))) return redirectWithNotice(c, "/connection", "notice.badProvider");
		values.workersPlan = text("workersPlan");
	}
	// Secret fields are write-only: blank keeps the stored value.
	for (const key of ["mailflareApiKey", "webhookSecret", "outboundApiKey"] as const) {
		if (!fixed.has(key) && text(key)) values[key] = text(key);
	}
	await saveConfig(c.env.DB, values);
	return redirectWithNotice(c, "/connection", "notice.connectionSaved");
});

app.get("/blocklist", async (c) => {
	const { results } = await c.env.DB.prepare("SELECT * FROM blocklist ORDER BY created_at DESC").all<BlocklistRow>();
	return c.html(blocklistPage(c.get("t"), { entries: results, notice: noticeFrom(c) }));
});

app.post("/blocklist", async (c) => {
	const form = await c.req.parseBody();
	const raw = (typeof form.value === "string" ? form.value : "").trim().toLowerCase().replace(/^@/, "");
	const email = raw.includes("@") ? extractEmail(raw) : null;
	const domain = !raw.includes("@") && DOMAIN_PATTERN.test(raw) ? raw : null;
	const value = email ?? domain;
	if (!value) return redirectWithNotice(c, "/blocklist", "notice.badBlock");
	await c.env.DB.prepare("INSERT INTO blocklist (id, kind, value, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (value) DO NOTHING")
		.bind(newId("bl"), email ? "address" : "domain", value, now())
		.run();
	return redirectWithNotice(c, "/blocklist", "notice.blocked", { value });
});

app.post("/blocklist/:id/delete", async (c) => {
	await c.env.DB.prepare("DELETE FROM blocklist WHERE id = ?").bind(c.req.param("id")).run();
	return redirectWithNotice(c, "/blocklist", "notice.unblocked");
});

// ---------- import from SimpleLogin / addy.io ----------

const IMPORT_SOURCES = {
	simplelogin: { label: "SimpleLogin", server: "https://app.simplelogin.io", fetch: fetchSimpleLogin },
	addy: { label: "addy.io", server: "https://app.addy.io", fetch: fetchAddy },
	csv: { label: "CSV", server: "", fetch: null },
} as const;

app.get("/import", async (c) => {
	const settings = await loadSettings(c.env.DB);
	return c.html(importPage(c.get("t"), { domains: await defaultImportDomains(c.env.DB, settings) }));
});

app.post("/import/:source", async (c) => {
	const t = c.get("t");
	const sourceName = c.req.param("source");
	if (!Object.hasOwn(IMPORT_SOURCES, sourceName)) return c.notFound();
	const source = IMPORT_SOURCES[sourceName as keyof typeof IMPORT_SOURCES];
	const settings = await loadSettings(c.env.DB);
	const form = await c.req.parseBody();
	const domains = (typeof form.domains === "string" ? form.domains : "")
		.split(/[\s,]+/)
		.map((domain) => domain.trim().toLowerCase())
		.filter((domain) => DOMAIN_PATTERN.test(domain));
	const render = async (extra: { error?: string; result?: Awaited<ReturnType<typeof importAliases>> }) =>
		c.html(
			importPage(t, { domains: domains.length ? domains : await defaultImportDomains(c.env.DB, settings), source: source.label, ...extra }),
			extra.error ? 400 : 200,
		);
	if (!domains.length) return render({ error: t("imp.err.noDomains") });

	let server = "";
	let aliases: ImportedAlias[];
	let selection: Selection;
	try {
		if (source.fetch) {
			const apiKey = typeof form.apiKey === "string" ? form.apiKey.trim() : "";
			if (!apiKey) return render({ error: t("imp.err.auth") });
			const url = new URL(typeof form.server === "string" && form.server.trim() ? form.server.trim() : source.server);
			if (url.protocol !== "https:") return render({ error: t("imp.err.badServer") });
			// A public host only: not an IP address, an internal name or this service itself. A
			// port is allowed, for self-hosted servers.
			const host = new URL(url.href);
			host.port = "";
			const ownHosts = [new URL(c.req.url).hostname, ...[c.get("config").publicUrl, c.get("config").siteOrigin, c.get("config").mailflareUrl].filter(Boolean).map((value) => new URL(value).hostname)];
			if (!safeHttpsUrl(host.href, ownHosts)) return render({ error: t("imp.err.badServer") });
			server = url.origin;
			// One budget for the whole import, so aliases and contacts together stay inside Workers' subrequest limit.
			const budget = newFetchBudget(c.get("config").workersPlan);
			aliases = await source.fetch(server, apiKey, budget);
			selection = selectByDomain(aliases, domains);
			// Contacts are fetched only for the aliases being imported, one list per alias.
			if (sourceName === "simplelogin" && form.contacts === "1") await addSimpleLoginContacts(server, apiKey, selection.chosen, budget);
		} else {
			const file = form.file;
			if (!(file instanceof File) || file.size === 0) return render({ error: t("imp.err.empty") });
			if (file.size > 5_000_000) return render({ error: t("imp.err.format") });
			aliases = parseAliasCsv(await file.text());
			selection = selectByDomain(aliases, domains);
		}
	} catch (error) {
		if (error instanceof TypeError) return render({ error: t("imp.err.badServer") });
		if (!(error instanceof ImportError)) throw error;
		const message =
			error.reason === "fetch"
				? t("imp.err.fetch", { server, detail: error.message })
				: t(error.reason === "auth" ? "imp.err.auth" : error.reason === "empty" ? "imp.err.empty" : "imp.err.format");
		return render({ error: message });
	}
	const result = await importAliases(c.env.DB, settings, sourceName as keyof typeof IMPORT_SOURCES, selection, aliases.length, {
		keepDestinations: form.destinations === "1",
		// Fewer, larger batches on the Free plan, where a request may make only 50 D1 queries.
		batchSize: c.get("config").workersPlan === "free" ? 500 : 100,
	});
	console.log(JSON.stringify({ event: "import", source: sourceName, ...result, skippedDomains: result.skippedDomains.length, newDestinations: result.newDestinations.length }));
	return render({ result });
});

async function renderApiKeys(c: C, extra: { newKey?: string; notice?: string } = {}) {
	const settings = await loadSettings(c.env.DB);
	return c.html(
		apiKeysPage(c.get("t"), {
			keys: await listApiKeys(c.env.DB),
			enabled: { simplelogin: settings.simpleloginApi, addy: settings.addyApi },
			origin: publicOrigin(c),
			notice: extra.notice ?? noticeFrom(c),
			newKey: extra.newKey,
		}),
	);
}

app.get("/api-keys", (c) => renderApiKeys(c));

app.post("/api-keys", async (c) => {
	const form = await c.req.parseBody();
	const { key } = await createApiKey(c.env.DB, typeof form.name === "string" ? form.name : "");
	// Shown once, straight in the response; it is never stored or put in a URL.
	c.header("Cache-Control", "no-store");
	return renderApiKeys(c, { newKey: key });
});

app.post("/api-keys/:id/delete", async (c) => {
	await deleteApiKey(c.env.DB, c.req.param("id"));
	return redirectWithNotice(c, "/api-keys", "notice.keyRevoked");
});

app.get("/passkeys", async (c) => c.html(passkeysPage(c.get("t"), { passkeys: await listPasskeys(c.env.DB), notice: noticeFrom(c) })));

app.post("/passkeys/options", async (c) => {
	const { options, challengeId } = await registrationOptions(c.env.DB, relyingParty(c.req.url));
	setChallengeCookie(c, challengeId);
	return c.json({ options });
});

app.post("/passkeys/verify", async (c) => {
	const body = await readJson<{ response?: RegistrationResponseJSON; name?: string }>(c);
	if (!body?.response) return jsonError(c, "err.missingResponse", 400);
	const passkey = await completeRegistration(c.env.DB, relyingParty(c.req.url), takeChallengeCookie(c), body.response, body.name ?? "").catch(
		() => null,
	);
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
					? statement("UPDATE aliases SET note = ?, updated_at = ? WHERE address = ?", value.slice(0, MAX_NOTE_LENGTH) || null, timestamp)
					: action === "destination"
						? statement("UPDATE aliases SET destination = ?, updated_at = ? WHERE address = ?", destination, timestamp)
						: action === "delete"
							? statement(
									"UPDATE aliases SET deleted_at = ?, forward_mode = 'none', forward_enabled = 0, pinned = 0, updated_at = ? WHERE address = ? AND deleted_at IS NULL",
									timestamp,
									timestamp,
								)
							: action === "restore"
								? statement("UPDATE aliases SET deleted_at = NULL, updated_at = ? WHERE address = ? AND deleted_at IS NOT NULL", timestamp)
								: // Permanently deleting is only offered for deleted aliases, and only removes those.
									ids.flatMap((id) => [
										db.prepare("DELETE FROM contacts WHERE alias_address = ? AND EXISTS (SELECT 1 FROM aliases WHERE address = ? AND deleted_at IS NOT NULL)").bind(id, id),
										db.prepare("DELETE FROM aliases WHERE address = ? AND deleted_at IS NOT NULL").bind(id),
									]);
	let changed = 0;
	for (let i = 0; i < statements.length; i += 100) {
		for (const result of await db.batch(statements.slice(i, i + 100))) changed += result.meta.changes ?? 0;
	}
	if (action === "forget") changed = Math.min(changed, ids.length);
	return done("notice.bulkDone", { count: String(Math.min(changed, ids.length)) });
});

app.post("/aliases/:address/mode", async (c) => {
	const address = normalizeEmail(c.req.param("address"));
	const form = await c.req.parseBody();
	if (!isForwardMode(form.mode)) return redirectWithNotice(c, "/", "notice.badMode");
	await setForwardMode(c.env.DB, address, form.mode);
	return redirectWithNotice(c, "/", "notice.modeSaved", { alias: address });
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
	// A random kind (words, characters or UUID) ignores any name; "custom" uses the name.
	const kind = isRandomAliasFormat(form.kind) ? form.kind : null;
	const prefix = kind ? "" : field("prefix", 64);
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
	const raw = typeof form.destination === "string" ? form.destination.trim() : "";
	const destination = raw ? extractEmail(raw) : null;
	if (raw && !destination) return redirectWithNotice(c, "/", "notice.badDestination");
	if (destination && (isOwnAddress(destination, [...(await loadSettings(c.env.DB)).aliasDomains, domainOf(address)]) || destination === address)) {
		return redirectWithNotice(c, "/", "notice.loop");
	}
	await c.env.DB.prepare("UPDATE aliases SET destination = ?, updated_at = ? WHERE address = ?").bind(destination, now(), address).run();
	return redirectWithNotice(c, "/", "notice.aliasDestinationSaved", { alias: address });
});

app.post("/aliases/:address/note", async (c) => {
	const address = normalizeEmail(c.req.param("address"));
	const form = await c.req.parseBody();
	const note = (typeof form.note === "string" ? form.note : "").trim().slice(0, MAX_NOTE_LENGTH) || null;
	const result = await c.env.DB.prepare("UPDATE aliases SET note = ?, updated_at = ? WHERE address = ?").bind(note, now(), address).run();
	if (c.req.header("X-Autosave") === "1") {
		// Saved in place from the alias list or alias page.
		return result.meta.changes > 0 ? c.json({ ok: true, message: c.get("t")("notice.noteSaved") }) : c.json({ ok: false, message: c.get("t")("link.error") }, 404);
	}
	const back = form.back === "list" ? "/" : `/aliases/${encodeURIComponent(address)}`;
	return redirectWithNotice(c, back, "notice.noteSaved");
});

app.get("/aliases/:address", async (c) => {
	const alias = await getAlias(c.env.DB, normalizeEmail(c.req.param("address")));
	if (!alias) return c.notFound();
	const { results: contacts } = await c.env.DB.prepare(
		"SELECT * FROM contacts WHERE alias_address = ? ORDER BY COALESCE(last_forward_at, created_at) DESC LIMIT 1000",
	)
		.bind(alias.address)
		.all<ContactRow>();
	return c.html(aliasPage(c.get("t"), { alias, contacts, notice: noticeFrom(c) }));
});

app.post("/aliases/:address/contacts", async (c) => {
	const alias = await getAlias(c.env.DB, normalizeEmail(c.req.param("address")));
	if (!alias) return c.notFound();
	const base = `/aliases/${encodeURIComponent(alias.address)}`;
	const form = await c.req.parseBody();
	const settings = await loadSettings(c.env.DB);
	const email = extractEmail(typeof form.email === "string" ? form.email : "");
	if (!email || isOwnAddress(email, [...settings.aliasDomains, domainOf(alias.address)])) return redirectWithNotice(c, base, "notice.badContact");
	const contact = await ensureContact(c.env.DB, alias.address, email, null, settings.includeSenderInReverseAlias);
	return redirectWithNotice(c, base, "notice.contactCreated", { reverse: contactReverseAddress(contact), email });
});

app.post("/aliases/:address/contacts/:id/block", async (c) => {
	const address = normalizeEmail(c.req.param("address"));
	await c.env.DB.prepare("UPDATE contacts SET blocked = 1 - blocked WHERE id = ? AND alias_address = ?").bind(c.req.param("id"), address).run();
	return c.redirect(`/aliases/${encodeURIComponent(address)}`);
});

export { app };

export default {
	fetch(request, env, ctx) {
		// An API URL saved with a trailing slash ("https://host/") makes apps call "//api/…".
		const url = new URL(request.url);
		if (url.pathname.startsWith("//")) {
			url.pathname = url.pathname.replace(/^\/+/, "/");
			return app.fetch(new Request(url, request), env, ctx);
		}
		return app.fetch(request, env, ctx);
	},
	async email(message, env) {
		const config = await loadConfig(env).catch((error) => {
			console.error("Configuration error:", error instanceof Error ? error.message : error);
			return null;
		});
		if (!config) {
			message.setReject("This address is temporarily unavailable");
			return;
		}
		// An alias domain may itself start with "r." (when its parent is not an alias domain),
		// so alias domains are matched first.
		const domain = domainOf(normalizeEmail(message.to));
		const settings = await loadSettings(env.DB);
		if (!settings.aliasDomains.includes(domain)) {
			if (aliasDomainOfReverse(domain)) await handleReverseAliasMail(message, env, config);
			else message.setReject("This address does not exist");
			return;
		}
		const outcome = await handleDirectInbound(message, env, config);
		if (outcome.status === 404) {
			message.setReject("This address does not exist");
			return;
		}
		// A failure the next attempt may fix: throwing makes the sending server try again later.
		if (outcome.status >= 500) throw new Error(`Forwarding failed: ${outcome.result}`);
	},
} satisfies ExportedHandler<Env>;
