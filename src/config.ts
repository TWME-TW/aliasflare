/**
 * Connection settings. They are entered on the dashboard after the first passkey is
 * registered and kept in D1, so a deploy needs no secrets. An environment variable or
 * secret of the same name, when set, overrides the stored value.
 */
import { hostnameOf, randomToken } from "./format";
import type { MessageKey } from "./i18n";
import { isOutboundProvider, normalizeOutboundOptions, type OutboundOptions, type OutboundProvider } from "./outbound";
import { DEFAULT_S3_OPTIONS, normalizeS3Prefix, validS3Endpoint, type S3Options } from "./storage";

export type AppConfig = {
	mailflareUrl: string;
	mailflareApiKey: string;
	webhookSecret: string;
	signingSecret: string;
	publicUrl: string;
	/**
	 * Origin for links in forwarded mail: the public URL, or else the address the dashboard was
	 * last opened on, since mail arriving through Email Routing comes with no request URL.
	 */
	siteOrigin: string;
	/** Cloudflare API token that lets the dashboard set up Email Routing and Email Sending. */
	cloudflareApiToken: string;
	/** This Worker's name, which the Email Routing rule sends mail to. */
	workerName: string;
	/** What sends mail to other people (replies, unsubscribe mail). */
	outboundProvider: OutboundProvider;
	outboundApiKey: string;
	/** The provider's other settings (SMTP server, AWS region, the custom request…). */
	outboundOptions: OutboundOptions;
	/**
	 * The Workers plan. Free allows 50 subrequests (fetches and D1 queries) and 10 ms of CPU per
	 * request, so imports are smaller and large messages are passed through unchanged.
	 */
	workersPlan: WorkersPlan;
	mailflareService?: Fetcher;
	/** Optional S3-compatible object storage for the built-in mailbox (AWS S3, Backblaze B2, MinIO, R2 S3 API...). */
	mailboxS3: S3Options;
};

export const WORKERS_PLANS = ["free", "paid"] as const;
export type WorkersPlan = (typeof WORKERS_PLANS)[number];
export const isWorkersPlan = (value: unknown): value is WorkersPlan => WORKERS_PLANS.includes(value as WorkersPlan);

/**
 * The hosts this deployment answers on, for the checks that call an address the owner typed: a
 * request from here to here would be a loop. Same list outbound.ts and unsubscribe.ts use.
 */
export function ownHosts(config: AppConfig): string[] {
	return [config.publicUrl, config.siteOrigin, config.mailflareUrl].map(hostnameOf).filter((host): host is string => !!host);
}

type StoredKey =
	| "mailflareUrl"
	| "mailflareApiKey"
	| "webhookSecret"
	| "signingSecret"
	| "publicUrl"
	| "cloudflareApiToken"
	| "workerName"
	| "outboundProvider"
	| "outboundApiKey"
	| "outboundOptions"
	| "workersPlan"
	| "mailboxS3Endpoint"
	| "mailboxS3Bucket"
	| "mailboxS3Region"
	| "mailboxS3AccessKeyId"
	| "mailboxS3SecretAccessKey"
	| "mailboxS3PathStyle"
	| "mailboxS3Prefix";

const ENV_OVERRIDES: Record<StoredKey, keyof Env> = {
	mailflareUrl: "MAILFLARE_URL",
	mailflareApiKey: "MAILFLARE_API_KEY",
	webhookSecret: "WEBHOOK_SECRET",
	signingSecret: "SIGNING_SECRET",
	publicUrl: "PUBLIC_URL",
	cloudflareApiToken: "CLOUDFLARE_API_TOKEN",
	workerName: "WORKER_NAME",
	outboundProvider: "OUTBOUND_PROVIDER",
	outboundApiKey: "OUTBOUND_API_KEY",
	outboundOptions: "OUTBOUND_OPTIONS",
	workersPlan: "WORKERS_PLAN",
	mailboxS3Endpoint: "MAILBOX_S3_ENDPOINT",
	mailboxS3Bucket: "MAILBOX_S3_BUCKET",
	mailboxS3Region: "MAILBOX_S3_REGION",
	mailboxS3AccessKeyId: "MAILBOX_S3_ACCESS_KEY_ID",
	mailboxS3SecretAccessKey: "MAILBOX_S3_SECRET_ACCESS_KEY",
	mailboxS3PathStyle: "MAILBOX_S3_PATH_STYLE",
	mailboxS3Prefix: "MAILBOX_S3_PREFIX",
};

/** Which values come from the environment, so the dashboard can show them as fixed. */
export function envOverrides(env: Env): Set<StoredKey> {
	const set = new Set<StoredKey>();
	for (const [key, name] of Object.entries(ENV_OVERRIDES) as [StoredKey, keyof Env][]) {
		const value = env[name];
		if (typeof value === "string" && value.trim()) set.add(key);
	}
	return set;
}

async function readStored(db: D1Database): Promise<Partial<Record<StoredKey | "siteOrigin", string>>> {
	const { results } = await db.prepare("SELECT key, value FROM config").all<{ key: StoredKey | "siteOrigin"; value: string }>();
	return Object.fromEntries(results.map((row) => [row.key, row.value]));
}

export async function saveConfig(db: D1Database, values: Partial<Record<StoredKey | "siteOrigin", string>>): Promise<void> {
	const statement = db.prepare("INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
	const entries = Object.entries(values).filter(([, value]) => typeof value === "string");
	if (entries.length) await db.batch(entries.map(([key, value]) => statement.bind(key, value)));
}

export { DOMAIN_PATTERN } from "./format";
export const WORKER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The https origin of a URL without credentials, or null. */
export function validOrigin(value: string): string | null {
	try {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password ? url.origin : null;
	} catch {
		return null;
	}
}

/** A setting from the environment that cannot be used. The Worker refuses to run with it. */
export class ConfigError extends Error {}

/**
 * Environment values get the same checks as values entered on the dashboard. A bad one
 * stops the Worker with a clear error instead of being ignored or sending secrets over http.
 */
function checkEnv(env: Env): void {
	const value = (name: keyof Env) => {
		const raw = env[name];
		return typeof raw === "string" ? raw.trim() : "";
	};
	const secret = value("SIGNING_SECRET");
	if (secret && secret.length < 32) throw new ConfigError("SIGNING_SECRET must be at least 32 characters long");
	for (const name of ["MAILFLARE_URL", "PUBLIC_URL"] as const) {
		if (value(name) && !validOrigin(value(name))) throw new ConfigError(`${name} must be an https:// URL without a user name or password`);
	}
	if (value("OUTBOUND_PROVIDER") && !isOutboundProvider(value("OUTBOUND_PROVIDER").toLowerCase())) {
		throw new ConfigError("OUTBOUND_PROVIDER must be cloudflare, resend, smtp2go, brevo, postmark, mailgun, ses, mailbaby, smtp or custom");
	}
	if (value("OUTBOUND_OPTIONS")) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(value("OUTBOUND_OPTIONS"));
		} catch {
			throw new ConfigError("OUTBOUND_OPTIONS must be a JSON object");
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ConfigError("OUTBOUND_OPTIONS must be a JSON object");
	}
	if (value("WORKERS_PLAN") && !isWorkersPlan(value("WORKERS_PLAN").toLowerCase())) throw new ConfigError("WORKERS_PLAN must be free or paid");
	// The setup code is all that stands between anyone and the first passkey.
	if (value("SETUP_CODE") && value("SETUP_CODE").length < 10) throw new ConfigError("SETUP_CODE must be at least 10 characters long");
	const worker = value("WORKER_NAME").toLowerCase();
	if (worker && !WORKER_NAME_PATTERN.test(worker)) throw new ConfigError("WORKER_NAME is not a valid Worker name");
}

function parseJson(text: string): unknown {
	try {
		return text ? JSON.parse(text) : {};
	} catch {
		return {};
	}
}

/** The configuration; `rows` are the config table's rows when they were read already (in a batch). */
export async function loadConfig(env: Env, rows?: { key: string; value: string }[]): Promise<AppConfig> {
	checkEnv(env);
	const stored: Partial<Record<StoredKey | "siteOrigin", string>> = rows ? Object.fromEntries(rows.map((row) => [row.key, row.value])) : await readStored(env.DB);
	const pick = (key: StoredKey): string => {
		const fromEnv = env[ENV_OVERRIDES[key]];
		if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
		return stored[key]?.trim() ?? "";
	};
	let signingSecret = pick("signingSecret");
	if (signingSecret.length < 32) {
		// First run (no SIGNING_SECRET secret): create the key that signs sessions and links.
		// Strip all ASCII whitespace in SQLite (not only space) so JS .trim() and SQL trim() agree.
		await env.DB.prepare(
			"INSERT INTO config (key, value) VALUES ('signingSecret', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE length(trim(config.value, char(9, 10, 11, 12, 13, 32))) < 32",
		)
			.bind(randomToken(48))
			.run();
		signingSecret = (await readStored(env.DB)).signingSecret?.trim() ?? "";
		if (signingSecret.length < 32) throw new ConfigError("signingSecret could not be initialized");
	}
	const mailflareUrl = validOrigin(pick("mailflareUrl")) ?? "";
	const publicUrl = validOrigin(pick("publicUrl")) ?? "";
	const rawS3Endpoint = pick("mailboxS3Endpoint");
	const s3PathStyleRaw = pick("mailboxS3PathStyle").toLowerCase();
	const mailboxS3: S3Options = {
		endpoint: validS3Endpoint(rawS3Endpoint) ?? "",
		bucket: pick("mailboxS3Bucket").replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 128),
		region: pick("mailboxS3Region").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40) || DEFAULT_S3_OPTIONS.region,
		accessKeyId: pick("mailboxS3AccessKeyId").replace(/[\u0000-\u001f]/g, "").slice(0, 128),
		secretAccessKey: pick("mailboxS3SecretAccessKey").replace(/[\u0000-\u001f]/g, "").slice(0, 256),
		pathStyle: s3PathStyleRaw ? s3PathStyleRaw !== "false" && s3PathStyleRaw !== "0" : DEFAULT_S3_OPTIONS.pathStyle,
		prefix: pick("mailboxS3Prefix") ? normalizeS3Prefix(pick("mailboxS3Prefix")) : DEFAULT_S3_OPTIONS.prefix,
	};
	return {
		mailflareUrl,
		mailflareApiKey: pick("mailflareApiKey"),
		webhookSecret: pick("webhookSecret"),
		signingSecret,
		publicUrl,
		siteOrigin: publicUrl || (validOrigin(stored.siteOrigin ?? "") ?? ""),
		// Only from the CLOUDFLARE_API_TOKEN secret: a token typed on the dashboard is never stored.
		cloudflareApiToken: env.CLOUDFLARE_API_TOKEN?.trim() ?? "",
		workerName: pick("workerName").toLowerCase() || "aliasflare",
		outboundProvider: ((provider) => (isOutboundProvider(provider) ? provider : "cloudflare"))(pick("outboundProvider").toLowerCase()),
		outboundApiKey: pick("outboundApiKey"),
		outboundOptions: normalizeOutboundOptions(parseJson(pick("outboundOptions"))),
		// Free unless told otherwise: the stricter limits work on both plans.
		workersPlan: pick("workersPlan").toLowerCase() === "paid" ? "paid" : "free",
		mailflareService: env.MAILFLARE_SERVICE,
		mailboxS3,
	};
}

/** True when the optional Mailflare backend is fully set up: its webhook and its send API. */
export function mailflareReady(config: AppConfig): boolean {
	return !!(config.mailflareUrl && config.mailflareApiKey && config.webhookSecret);
}

/** Settings still needed before mail can flow, as message keys for the interface. */
export function missingConnection(settings: { aliasDomains: string[]; defaultDestination: string }): MessageKey[] {
	const missing: MessageKey[] = [];
	if (!settings.aliasDomains.length) missing.push("missing.aliasDomains");
	if (!settings.defaultDestination) missing.push("missing.defaultDestination");
	return missing;
}
