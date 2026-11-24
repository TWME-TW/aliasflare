import { isSenderFormat, type SenderFormat } from "./format";
import { isLocale, type Locale } from "./i18n";

export type UnsubscribeBehavior = "disable_alias" | "block_contact" | "preserve_original";

export const UNSUBSCRIBE_BEHAVIORS: UnsubscribeBehavior[] = ["disable_alias", "block_contact", "preserve_original"];

/** How new random aliases are named: two words and digits, random characters, or a UUID. */
export type RandomAliasFormat = "random_words" | "random_characters" | "uuid";
export const RANDOM_ALIAS_FORMATS: RandomAliasFormat[] = ["random_words", "random_characters", "uuid"];

export function isRandomAliasFormat(value: unknown): value is RandomAliasFormat {
	return RANDOM_ALIAS_FORMATS.includes(value as RandomAliasFormat);
}


const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export type Settings = {
	senderFormat: SenderFormat;
	reverseAliasReplacement: boolean;
	includeSenderInReverseAlias: boolean;
	unsubscribeBehavior: UnsubscribeBehavior;
	defaultDestination: string;
	autoForwardNewAliases: boolean;
	removeTrackers: boolean;
	showBanner: boolean;
	/** Language of the banner and link pages in forwarded mail. */
	language: Locale;
	/** Serve the SimpleLogin API so SimpleLogin's apps and browser extension can manage aliases. */
	simpleloginApi: boolean;
	/** Serve the addy.io API for addy.io's apps and browser extension. */
	addyApi: boolean;
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
	defaultDestination: "",
	autoForwardNewAliases: true,
	removeTrackers: true,
	showBanner: true,
	language: "en",
	simpleloginApi: false,
	addyApi: false,
	aliasDomains: [],
	randomAliasFormat: "random_words",
	appSettings: true,
};

function isUnsubscribeBehavior(value: unknown): value is UnsubscribeBehavior {
	return UNSUBSCRIBE_BEHAVIORS.includes(value as UnsubscribeBehavior);
}

/** Keeps only known keys with valid values; anything else falls back to the default. */
export function normalizeSettings(raw: Record<string, unknown>): Settings {
	return {
		senderFormat: isSenderFormat(raw.senderFormat) ? raw.senderFormat : DEFAULT_SETTINGS.senderFormat,
		reverseAliasReplacement:
			typeof raw.reverseAliasReplacement === "boolean" ? raw.reverseAliasReplacement : DEFAULT_SETTINGS.reverseAliasReplacement,
		includeSenderInReverseAlias:
			typeof raw.includeSenderInReverseAlias === "boolean"
				? raw.includeSenderInReverseAlias
				: DEFAULT_SETTINGS.includeSenderInReverseAlias,
		unsubscribeBehavior: isUnsubscribeBehavior(raw.unsubscribeBehavior) ? raw.unsubscribeBehavior : DEFAULT_SETTINGS.unsubscribeBehavior,
		defaultDestination: typeof raw.defaultDestination === "string" ? raw.defaultDestination.trim().toLowerCase() : "",
		autoForwardNewAliases:
			typeof raw.autoForwardNewAliases === "boolean" ? raw.autoForwardNewAliases : DEFAULT_SETTINGS.autoForwardNewAliases,
		removeTrackers: typeof raw.removeTrackers === "boolean" ? raw.removeTrackers : DEFAULT_SETTINGS.removeTrackers,
		showBanner: typeof raw.showBanner === "boolean" ? raw.showBanner : DEFAULT_SETTINGS.showBanner,
		language: isLocale(raw.language) ? raw.language : DEFAULT_SETTINGS.language,
		simpleloginApi: raw.simpleloginApi === true,
		addyApi: raw.addyApi === true,
		aliasDomains: Array.isArray(raw.aliasDomains)
			? [...new Set(raw.aliasDomains.filter((d): d is string => typeof d === "string").map((d) => d.trim().toLowerCase()).filter((d) => DOMAIN.test(d)))].slice(0, 20)
			: [],
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
