/**
 * Connection settings. They are entered on the dashboard after the first passkey is
 * registered and kept in D1, so a deploy needs no secrets. An environment variable or
 * secret of the same name, when set, overrides the stored value.
 */
import { randomToken } from "./format";
import type { MessageKey } from "./i18n";
import { isOutboundProvider, type OutboundProvider } from "./outbound";

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
	/**
	 * The Workers plan. Free allows 50 subrequests (fetches and D1 queries) and 10 ms of CPU per
	 * request, so imports are smaller and large messages are passed through unchanged.
	 */
	workersPlan: WorkersPlan;
	mailflareService?: Fetcher;
};

export const WORKERS_PLANS = ["free", "paid"] as const;
export type WorkersPlan = (typeof WORKERS_PLANS)[number];
export const isWorkersPlan = (value: unknown): value is WorkersPlan => WORKERS_PLANS.includes(value as WorkersPlan);

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
	| "workersPlan";

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
	workersPlan: "WORKERS_PLAN",
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
		throw new ConfigError("OUTBOUND_PROVIDER must be cloudflare, resend, smtp2go or brevo");
	}
	if (value("WORKERS_PLAN") && !isWorkersPlan(value("WORKERS_PLAN").toLowerCase())) throw new ConfigError("WORKERS_PLAN must be free or paid");
	// The setup code is all that stands between anyone and the first passkey.
	if (value("SETUP_CODE") && value("SETUP_CODE").length < 10) throw new ConfigError("SETUP_CODE must be at least 10 characters long");
	const worker = value("WORKER_NAME").toLowerCase();
	if (worker && !WORKER_NAME_PATTERN.test(worker)) throw new ConfigError("WORKER_NAME is not a valid Worker name");
}

export async function loadConfig(env: Env): Promise<AppConfig> {
	checkEnv(env);
	const stored = await readStored(env.DB);
	const pick = (key: StoredKey): string => {
		const fromEnv = env[ENV_OVERRIDES[key]];
		if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
		return stored[key]?.trim() ?? "";
	};
	let signingSecret = pick("signingSecret");
	if (signingSecret.length < 32) {
		// First run (no SIGNING_SECRET secret): create the key that signs sessions and links.
		// Only a missing or too short stored key is replaced, so two racing requests agree.
		await env.DB.prepare(
			"INSERT INTO config (key, value) VALUES ('signingSecret', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE length(trim(config.value)) < 32",
		)
			.bind(randomToken(48))
			.run();
		signingSecret = (await readStored(env.DB)).signingSecret?.trim() ?? "";
	}
	return {
		mailflareUrl: pick("mailflareUrl").replace(/\/+$/, ""),
		mailflareApiKey: pick("mailflareApiKey"),
		webhookSecret: pick("webhookSecret"),
		signingSecret,
		publicUrl: pick("publicUrl").replace(/\/+$/, ""),
		siteOrigin: pick("publicUrl").replace(/\/+$/, "") || (validOrigin(stored.siteOrigin ?? "") ?? ""),
		// Only from the CLOUDFLARE_API_TOKEN secret: a token typed on the dashboard is never stored.
		cloudflareApiToken: env.CLOUDFLARE_API_TOKEN?.trim() ?? "",
		workerName: pick("workerName").toLowerCase() || "aliasflare",
		outboundProvider: ((provider) => (isOutboundProvider(provider) ? provider : "cloudflare"))(pick("outboundProvider").toLowerCase()),
		outboundApiKey: pick("outboundApiKey"),
		// Free unless told otherwise: the stricter limits work on both plans.
		workersPlan: pick("workersPlan").toLowerCase() === "paid" ? "paid" : "free",
		mailflareService: env.MAILFLARE_SERVICE,
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
