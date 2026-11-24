import { isSenderFormat, type SenderFormat } from "./format";
import { isLocale, type Locale } from "./i18n";

export type UnsubscribeBehavior = "disable_alias" | "block_contact" | "preserve_original";

export const UNSUBSCRIBE_BEHAVIORS: UnsubscribeBehavior[] = ["disable_alias", "block_contact", "preserve_original"];

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
