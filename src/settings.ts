import { DOMAIN_PATTERN, extractEmail, isSenderFormat, type SenderFormat } from "./format";
import { isLocale, type Locale } from "./i18n";

export type UnsubscribeBehavior = "disable_alias" | "block_contact" | "redirect_contact" | "preserve_original";

export const UNSUBSCRIBE_BEHAVIORS: UnsubscribeBehavior[] = ["disable_alias", "block_contact", "redirect_contact", "preserve_original"];

/**
 * What happens when the sender's own unsubscribe cannot be used (there is none, or it
 * failed): one of the other actions, or nothing, so the link reports the failure.
 */
export type UnsubscribeFallback = Exclude<UnsubscribeBehavior, "preserve_original"> | "none";
export const UNSUBSCRIBE_FALLBACKS: UnsubscribeFallback[] = ["block_contact", "disable_alias", "redirect_contact", "none"];

/** The unsubscribe settings, for all alias domains or one. An empty redirect uses the general one. */
export type UnsubscribeRule = { behavior: UnsubscribeBehavior; fallback: UnsubscribeFallback; redirect: string };

/** How new random aliases are named: two words and digits, random characters, or a UUID. */
export type RandomAliasFormat = "random_words" | "random_characters" | "uuid";
export const RANDOM_ALIAS_FORMATS: RandomAliasFormat[] = ["random_words", "random_characters", "uuid"];

export function isRandomAliasFormat(value: unknown): value is RandomAliasFormat {
	return RANDOM_ALIAS_FORMATS.includes(value as RandomAliasFormat);
}


const DOMAIN = DOMAIN_PATTERN;

/** Alias domains one installation can have. */
export const MAX_ALIAS_DOMAINS = 20;

export type Settings = {
	senderFormat: SenderFormat;
	reverseAliasReplacement: boolean;
	includeSenderInReverseAlias: boolean;
	unsubscribeBehavior: UnsubscribeBehavior;
	/** When the sender's own unsubscribe cannot be used. */
	unsubscribeFallback: UnsubscribeFallback;
	/** Where an unsubscribed sender's mail goes with "redirect_contact" (a separate mailbox, say). */
	unsubscribeRedirect: string;
	/** Alias domains with unsubscribe settings of their own. */
	unsubscribeDomains: Record<string, UnsubscribeRule>;
	defaultDestination: string;
	autoForwardNewAliases: boolean;
	/**
	 * Mail to any address on an alias domain creates that alias (the default). When off, mail to an
	 * address that is not an alias yet is refused, so made-up addresses do not fill the list.
	 */
	createAliasesFromMail: boolean;
	removeTrackers: boolean;
	showBanner: boolean;
	/** Language of the banner and link pages in forwarded mail. */
	language: Locale;
	/** Serve the SimpleLogin API so SimpleLogin's apps and browser extension can manage aliases. */
	simpleloginApi: boolean;
	/** Serve the addy.io API for addy.io's apps and browser extension. */
	addyApi: boolean;
	/** Serve the MCP server at /mcp, so an AI assistant can list, create and switch aliases. */
	mcpServer: boolean;
	/** Domains new aliases can be created on. Mailflare must accept mail for any address there (a catch-all). */
	aliasDomains: string[];
	randomAliasFormat: RandomAliasFormat;
	/**
	 * Let apps change the settings their own settings screens show: alias format, default
	 * domain, sender format, default mailbox and the blocklist. Connection, API and keys stay here.
	 */
	appSettings: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
	senderFormat: "AT",
	reverseAliasReplacement: true,
	includeSenderInReverseAlias: false,
	unsubscribeBehavior: "disable_alias",
	unsubscribeFallback: "block_contact",
	unsubscribeRedirect: "",
	unsubscribeDomains: {},
	defaultDestination: "",
	autoForwardNewAliases: true,
	createAliasesFromMail: true,
	removeTrackers: true,
	showBanner: false,
	language: "en",
	simpleloginApi: false,
	addyApi: false,
	mcpServer: false,
	aliasDomains: [],
	randomAliasFormat: "random_words",
	appSettings: true,
};

export function isUnsubscribeBehavior(value: unknown): value is UnsubscribeBehavior {
	return UNSUBSCRIBE_BEHAVIORS.includes(value as UnsubscribeBehavior);
}

export function isUnsubscribeFallback(value: unknown): value is UnsubscribeFallback {
	return UNSUBSCRIBE_FALLBACKS.includes(value as UnsubscribeFallback);
}

/** A bare, lowercased address, or "" for anything that is not one. */
function cleanAddress(value: unknown): string {
	return typeof value === "string" ? (extractEmail(value.trim())?.toLowerCase() ?? "") : "";
}

function normalizeRules(raw: unknown, domains: string[]): Record<string, UnsubscribeRule> {
	const rules: Record<string, UnsubscribeRule> = {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return rules;
	for (const domain of domains) {
		const rule: unknown = Object.hasOwn(raw, domain) ? (raw as Record<string, unknown>)[domain] : null;
		if (!rule || typeof rule !== "object") continue;
		const { behavior, fallback, redirect } = rule as Record<string, unknown>;
		if (!isUnsubscribeBehavior(behavior)) continue;
		rules[domain] = { behavior, fallback: isUnsubscribeFallback(fallback) ? fallback : DEFAULT_SETTINGS.unsubscribeFallback, redirect: cleanAddress(redirect) };
	}
	return rules;
}

/** The unsubscribe settings for an alias: its domain's own, or the general ones. */
export function unsubscribeRuleFor(settings: Settings, aliasAddress: string): UnsubscribeRule {
	const domain = aliasAddress.split("@").pop()?.toLowerCase() ?? "";
	const own = Object.hasOwn(settings.unsubscribeDomains, domain) ? settings.unsubscribeDomains[domain] : undefined;
	return {
		behavior: own?.behavior ?? settings.unsubscribeBehavior,
		fallback: own?.fallback ?? settings.unsubscribeFallback,
		redirect: own?.redirect || settings.unsubscribeRedirect,
	};
}

/** Keeps only known keys with valid values; anything else falls back to the default. */
export function normalizeSettings(raw: Record<string, unknown>): Settings {
	const aliasDomains = Array.isArray(raw.aliasDomains)
		? [...new Set(raw.aliasDomains.filter((d): d is string => typeof d === "string").map((d) => d.trim().toLowerCase()).filter((d) => DOMAIN.test(d)))].slice(0, MAX_ALIAS_DOMAINS)
		: [];
	return {
		senderFormat: isSenderFormat(raw.senderFormat) ? raw.senderFormat : DEFAULT_SETTINGS.senderFormat,
		reverseAliasReplacement:
			typeof raw.reverseAliasReplacement === "boolean" ? raw.reverseAliasReplacement : DEFAULT_SETTINGS.reverseAliasReplacement,
		includeSenderInReverseAlias:
			typeof raw.includeSenderInReverseAlias === "boolean"
				? raw.includeSenderInReverseAlias
				: DEFAULT_SETTINGS.includeSenderInReverseAlias,
		unsubscribeBehavior: isUnsubscribeBehavior(raw.unsubscribeBehavior) ? raw.unsubscribeBehavior : DEFAULT_SETTINGS.unsubscribeBehavior,
		unsubscribeFallback: isUnsubscribeFallback(raw.unsubscribeFallback) ? raw.unsubscribeFallback : DEFAULT_SETTINGS.unsubscribeFallback,
		unsubscribeRedirect: cleanAddress(raw.unsubscribeRedirect),
		unsubscribeDomains: normalizeRules(raw.unsubscribeDomains, aliasDomains),
		defaultDestination: typeof raw.defaultDestination === "string" ? raw.defaultDestination.trim().toLowerCase() : "",
		autoForwardNewAliases:
			typeof raw.autoForwardNewAliases === "boolean" ? raw.autoForwardNewAliases : DEFAULT_SETTINGS.autoForwardNewAliases,
		createAliasesFromMail: typeof raw.createAliasesFromMail === "boolean" ? raw.createAliasesFromMail : DEFAULT_SETTINGS.createAliasesFromMail,
		removeTrackers: typeof raw.removeTrackers === "boolean" ? raw.removeTrackers : DEFAULT_SETTINGS.removeTrackers,
		showBanner: typeof raw.showBanner === "boolean" ? raw.showBanner : DEFAULT_SETTINGS.showBanner,
		language: isLocale(raw.language) ? raw.language : DEFAULT_SETTINGS.language,
		simpleloginApi: raw.simpleloginApi === true,
		addyApi: raw.addyApi === true,
		mcpServer: raw.mcpServer === true,
		aliasDomains,
		randomAliasFormat: isRandomAliasFormat(raw.randomAliasFormat) ? raw.randomAliasFormat : DEFAULT_SETTINGS.randomAliasFormat,
		appSettings: typeof raw.appSettings === "boolean" ? raw.appSettings : DEFAULT_SETTINGS.appSettings,
	};
}

export async function loadSettings(db: D1Database): Promise<Settings> {
	const { results } = await db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
	const raw: Record<string, unknown> = {};
	for (const row of results) {
		try {
			raw[row.key] = JSON.parse(row.value);
		} catch {
			// Ignore a corrupt value; the default applies.
		}
	}
	return normalizeSettings(raw);
}

export async function saveSettings(db: D1Database, settings: Settings): Promise<void> {
	const statement = db.prepare(
		"INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
	);
	await db.batch(Object.entries(settings).map(([key, value]) => statement.bind(key, JSON.stringify(value))));
}
