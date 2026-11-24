/**
 * Connection settings. They are entered on the dashboard after the first passkey is
 * registered and kept in D1, so a deploy needs no secrets. An environment variable or
 * secret of the same name, when set, overrides the stored value.
 */
import { randomToken } from "./format";
import type { MessageKey } from "./i18n";

export type AppConfig = {
	mailflareUrl: string;
	mailflareApiKey: string;
	webhookSecret: string;
	reverseDomain: string;
	signingSecret: string;
	publicUrl: string;
	/** Cloudflare API token that lets the dashboard set up Email Routing and Email Sending. */
	cloudflareApiToken: string;
	/** This Worker's name, which the Email Routing rule sends mail to. */
	workerName: string;
	mailflareService?: Fetcher;
};

type StoredKey =
	| "mailflareUrl"
	| "mailflareApiKey"
	| "webhookSecret"
	| "reverseDomain"
	| "signingSecret"
	| "publicUrl"
	| "cloudflareApiToken"
	| "workerName";

const ENV_OVERRIDES: Record<StoredKey, keyof Env> = {
	mailflareUrl: "MAILFLARE_URL",
	mailflareApiKey: "MAILFLARE_API_KEY",
	webhookSecret: "WEBHOOK_SECRET",
	reverseDomain: "REVERSE_ALIAS_DOMAIN",
	signingSecret: "SIGNING_SECRET",
	publicUrl: "PUBLIC_URL",
	cloudflareApiToken: "CLOUDFLARE_API_TOKEN",
	workerName: "WORKER_NAME",
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

async function readStored(db: D1Database): Promise<Partial<Record<StoredKey, string>>> {
	const { results } = await db.prepare("SELECT key, value FROM config").all<{ key: StoredKey; value: string }>();
	return Object.fromEntries(results.map((row) => [row.key, row.value]));
}

export async function saveConfig(db: D1Database, values: Partial<Record<StoredKey, string>>): Promise<void> {
	const statement = db.prepare("INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
	const entries = Object.entries(values).filter(([, value]) => typeof value === "string");
	if (entries.length) await db.batch(entries.map(([key, value]) => statement.bind(key, value)));
}

export async function loadConfig(env: Env): Promise<AppConfig> {
	const stored = await readStored(env.DB);
	const pick = (key: StoredKey): string => {
		const fromEnv = env[ENV_OVERRIDES[key]];
		if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
		return stored[key]?.trim() ?? "";
	};
	let signingSecret = pick("signingSecret");
	if (signingSecret.length < 32) {
		// First run: create the key that signs sessions and links. INSERT OR IGNORE keeps
		// the first value if two requests race.
		await env.DB.prepare("INSERT OR IGNORE INTO config (key, value) VALUES ('signingSecret', ?)").bind(randomToken(48)).run();
		signingSecret = (await readStored(env.DB)).signingSecret ?? "";
	}
	return {
		mailflareUrl: pick("mailflareUrl").replace(/\/+$/, ""),
		mailflareApiKey: pick("mailflareApiKey"),
		webhookSecret: pick("webhookSecret"),
		reverseDomain: pick("reverseDomain").toLowerCase(),
		signingSecret,
		publicUrl: pick("publicUrl").replace(/\/+$/, ""),
		cloudflareApiToken: pick("cloudflareApiToken"),
		workerName: pick("workerName") || "mailflare-alias",
		mailflareService: env.MAILFLARE_SERVICE,
	};
}

/** Settings still needed before mail can flow, as message keys for the interface. */
export function missingConnection(config: AppConfig): MessageKey[] {
	const missing: MessageKey[] = [];
	if (!config.mailflareUrl) missing.push("missing.mailflareUrl");
	if (!config.mailflareApiKey) missing.push("missing.apiKey");
	if (!config.webhookSecret) missing.push("missing.webhookSecret");
	if (!config.reverseDomain) missing.push("missing.reverseDomain");
	return missing;
}
