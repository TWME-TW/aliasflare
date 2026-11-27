import { cleanDisplayName, cleanSubjectLine, DOMAIN_PATTERN, extractEmail, isSenderFormat, type SenderFormat } from "./format";
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
/** Per-domain unsubscribe overrides; omitted fields inherit the general setting. */
export type UnsubscribeDomainRule = { behavior?: UnsubscribeBehavior; fallback?: UnsubscribeFallback; redirect: string };

/** How new random aliases are named: two words and digits, a single noun and digits, random characters, or a UUID. */
export type RandomAliasFormat = "random_words" | "random_noun" | "random_characters" | "uuid";
export const RANDOM_ALIAS_FORMATS: RandomAliasFormat[] = ["random_words", "random_noun", "random_characters", "uuid"];

export function isRandomAliasFormat(value: unknown): value is RandomAliasFormat {
	return RANDOM_ALIAS_FORMATS.includes(value as RandomAliasFormat);
}

/** Where the forwarding banner is placed on forwarded mail. */
export type BannerLocation = "off" | "top" | "bottom";
export const BANNER_LOCATIONS: BannerLocation[] = ["off", "top", "bottom"];

export function isBannerLocation(value: unknown): value is BannerLocation {
	return BANNER_LOCATIONS.includes(value as BannerLocation);
}

/** How DMARC failure / spoofed sender warnings are shown on forwarded mail. */
export type SpamWarningBehaviour = "off" | "banner" | "subject" | "both";
export const SPAM_WARNING_BEHAVIOURS: SpamWarningBehaviour[] = ["both", "banner", "subject", "off"];

export function isSpamWarningBehaviour(value: unknown): value is SpamWarningBehaviour {
	return SPAM_WARNING_BEHAVIOURS.includes(value as SpamWarningBehaviour);
}

/** Separator between words in random_words / random_noun aliases. */
export type AliasSeparator = "." | "-" | "_";
export const ALIAS_SEPARATORS: AliasSeparator[] = [".", "-", "_"];

export function isAliasSeparator(value: unknown): value is AliasSeparator {
	return ALIAS_SEPARATORS.includes(value as AliasSeparator);
}

const DOMAIN = DOMAIN_PATTERN;

/** Alias domains one installation can have. */
export const MAX_ALIAS_DOMAINS = 20;

/**
 * How mail reaches the owner: rewritten (from a reverse alias, so replies go through the alias,
 * with trackers removed and the banner) or passed on unchanged by Email Routing (receive only:
 * nothing is sent, but replies go from the owner's own address).
 */
export type ForwardMethod = "rewrite" | "direct";
export const FORWARD_METHODS: ForwardMethod[] = ["rewrite", "direct"];

export type Settings = {
	forwardMethod: ForwardMethod;
	senderFormat: SenderFormat;
	reverseAliasReplacement: boolean;
	/** Whether automatic replies (out of office and the like) the owner sends to a reverse alias go out. */
	sendAutoReplies: boolean;
	includeSenderInReverseAlias: boolean;
	unsubscribeBehavior: UnsubscribeBehavior;
	/** When the sender's own unsubscribe cannot be used. */
	unsubscribeFallback: UnsubscribeFallback;
	/** Where an unsubscribed sender's mail goes with "redirect_contact" (a separate mailbox, say). */
	unsubscribeRedirect: string;
	/** Alias domains with unsubscribe settings of their own. */
	unsubscribeDomains: Record<string, UnsubscribeDomainRule>;
	defaultDestination: string;
	autoForwardNewAliases: boolean;
	/**
	 * Mail to any address on an alias domain creates that alias (the default). When off, mail to an
	 * address that is not an alias yet is refused, so made-up addresses do not fill the list.
	 */
	createAliasesFromMail: boolean;
	/** Alias domains where mail does not create aliases even so (addy.io's catch-all off for a domain). */
	aliasesFromMailOff: string[];
	/** Forwarding addresses that get mail encrypted to their PGP key (kept from the pgp_keys table). */
	pgpRecipients: string[];
	removeTrackers: boolean;
	/** Legacy flag kept in sync with bannerLocation !== "off". */
	showBanner: boolean;
	/** Where the forwarding banner is shown: off, top, or bottom (addy.io's banner_location). */
	bannerLocation: BannerLocation;
	/** Account-wide default From display name for replies and sends (fallback when alias/domain have none). */
	defaultFromName: string;
	/** Account-wide default subject override for forwarded mail (empty = keep original subject). */
	defaultEmailSubject: string;
	/** How DMARC failures are highlighted on forwarded mail. */
	spamWarningBehaviour: SpamWarningBehaviour;
	/** Separator for generated word-based aliases. */
	aliasSeparator: AliasSeparator;
	/** Account-level WKD auto-encrypt preference reported to addy.io clients. */
	wkdAutoEncrypt: boolean;
	/** Language of the banner and link pages in forwarded mail. */
	language: Locale;
	/** Serve the SimpleLogin API so SimpleLogin's apps and browser extension can manage aliases. */
	simpleloginApi: boolean;
	/** Serve the addy.io API for addy.io's apps and browser extension. */
	addyApi: boolean;
	/** Serve the MCP server at /mcp, so an AI assistant can list, create and switch aliases. */
	mcpServer: boolean;
	/** Domains new aliases can be created on. Every address there must reach this Worker: Email Routing's catch-all, or Mailflare's. */
	aliasDomains: string[];
	randomAliasFormat: RandomAliasFormat;
	/**
	 * Let apps change the settings their own settings screens show: alias format, default
	 * domain, sender format, default mailbox, recipients, domains, rules and the blocklist.
	 */
	appSettings: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
	forwardMethod: "rewrite",
	senderFormat: "AT",
	reverseAliasReplacement: true,
	sendAutoReplies: false,
	includeSenderInReverseAlias: false,
	unsubscribeBehavior: "disable_alias",
	unsubscribeFallback: "block_contact",
	unsubscribeRedirect: "",
	unsubscribeDomains: {},
	defaultDestination: "",
	autoForwardNewAliases: true,
	createAliasesFromMail: true,
	aliasesFromMailOff: [],
	pgpRecipients: [],
	removeTrackers: true,
	showBanner: false,
	bannerLocation: "off",
	defaultFromName: "",
	defaultEmailSubject: "",
	spamWarningBehaviour: "both",
	aliasSeparator: ".",
	wkdAutoEncrypt: false,
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

function normalizeRules(raw: unknown, domains: string[]): Record<string, UnsubscribeDomainRule> {
	const rules: Record<string, UnsubscribeDomainRule> = {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return rules;
	for (const domain of domains) {
		const rule: unknown = Object.hasOwn(raw, domain) ? (raw as Record<string, unknown>)[domain] : null;
		if (!rule || typeof rule !== "object" || Array.isArray(rule)) continue;
		const { behavior, fallback, redirect } = rule as Record<string, unknown>;
		const validBehavior = isUnsubscribeBehavior(behavior) ? behavior : undefined;
		const validFallback = isUnsubscribeFallback(fallback) ? fallback : undefined;
		const validRedirect = cleanAddress(redirect);
		if (!validBehavior && !validFallback && !validRedirect) continue;
		rules[domain] = {
			...(validBehavior ? { behavior: validBehavior } : {}),
			// A fallback left out follows the general setting, also when the behavior is overridden.
			...(validFallback ? { fallback: validFallback } : {}),
			redirect: validRedirect,
		};
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

/** Whether mail to an address on this domain that is not an alias yet creates it. */
export function createsAliasesFromMail(settings: Settings, domain: string): boolean {
	return settings.createAliasesFromMail && settings.aliasDomains.includes(domain) && !settings.aliasesFromMailOff.includes(domain);
}

/** Keeps only known keys with valid values; anything else falls back to the default. */
export function normalizeSettings(raw: Record<string, unknown>): Settings {
	const aliasDomains = Array.isArray(raw.aliasDomains)
		? [...new Set(raw.aliasDomains.filter((d): d is string => typeof d === "string").map((d) => d.trim().toLowerCase()).filter((d) => DOMAIN.test(d)))].slice(0, MAX_ALIAS_DOMAINS)
		: [];
	let bannerLocation: BannerLocation;
	if (isBannerLocation(raw.bannerLocation)) {
		// Support callers that spread loaded settings (bannerLocation: "off") and only flip showBanner: true.
		bannerLocation = raw.bannerLocation === "off" && raw.showBanner === true ? "top" : raw.bannerLocation;
	} else if (typeof raw.showBanner === "boolean") {
		bannerLocation = raw.showBanner ? "top" : "off";
	} else {
		bannerLocation = DEFAULT_SETTINGS.bannerLocation;
	}
	return {
		forwardMethod: raw.forwardMethod === "direct" ? "direct" : "rewrite",
		senderFormat: isSenderFormat(raw.senderFormat) ? raw.senderFormat : DEFAULT_SETTINGS.senderFormat,
		reverseAliasReplacement:
			typeof raw.reverseAliasReplacement === "boolean" ? raw.reverseAliasReplacement : DEFAULT_SETTINGS.reverseAliasReplacement,
		sendAutoReplies: typeof raw.sendAutoReplies === "boolean" ? raw.sendAutoReplies : DEFAULT_SETTINGS.sendAutoReplies,
		includeSenderInReverseAlias:
			typeof raw.includeSenderInReverseAlias === "boolean"
				? raw.includeSenderInReverseAlias
				: DEFAULT_SETTINGS.includeSenderInReverseAlias,
		unsubscribeBehavior: isUnsubscribeBehavior(raw.unsubscribeBehavior) ? raw.unsubscribeBehavior : DEFAULT_SETTINGS.unsubscribeBehavior,
		unsubscribeFallback: isUnsubscribeFallback(raw.unsubscribeFallback) ? raw.unsubscribeFallback : DEFAULT_SETTINGS.unsubscribeFallback,
		unsubscribeRedirect: cleanAddress(raw.unsubscribeRedirect),
		unsubscribeDomains: normalizeRules(raw.unsubscribeDomains, aliasDomains),
		defaultDestination: cleanAddress(raw.defaultDestination),
		autoForwardNewAliases:
			typeof raw.autoForwardNewAliases === "boolean" ? raw.autoForwardNewAliases : DEFAULT_SETTINGS.autoForwardNewAliases,
		createAliasesFromMail: typeof raw.createAliasesFromMail === "boolean" ? raw.createAliasesFromMail : DEFAULT_SETTINGS.createAliasesFromMail,
		pgpRecipients: Array.isArray(raw.pgpRecipients) ? [...new Set(raw.pgpRecipients.map(cleanAddress).filter(Boolean))].slice(0, 1000) : [],
		aliasesFromMailOff: Array.isArray(raw.aliasesFromMailOff) ? aliasDomains.filter((domain) => (raw.aliasesFromMailOff as unknown[]).includes(domain)) : [],
		removeTrackers: typeof raw.removeTrackers === "boolean" ? raw.removeTrackers : DEFAULT_SETTINGS.removeTrackers,
		showBanner: bannerLocation !== "off",
		bannerLocation,
		defaultFromName: typeof raw.defaultFromName === "string" ? (cleanDisplayName(raw.defaultFromName, 100) ?? "") : "",
		defaultEmailSubject: typeof raw.defaultEmailSubject === "string" ? cleanSubjectLine(raw.defaultEmailSubject).slice(0, 200) : "",
		spamWarningBehaviour: isSpamWarningBehaviour(raw.spamWarningBehaviour) ? raw.spamWarningBehaviour : DEFAULT_SETTINGS.spamWarningBehaviour,
		aliasSeparator: isAliasSeparator(raw.aliasSeparator) ? raw.aliasSeparator : DEFAULT_SETTINGS.aliasSeparator,
		wkdAutoEncrypt: raw.wkdAutoEncrypt === true,
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
	return settingsFromRows(results);
}

/** Settings from the settings table's rows. */
export function settingsFromRows(results: { key: string; value: string }[]): Settings {
	const raw: Record<string, unknown> = Object.create(null);
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
	const normalized = normalizeSettings(settings as unknown as Record<string, unknown>);
	await saveSettingKeys(db, normalized);
}

/** Updates only the given settings keys, so concurrent changes to other keys are never overwritten. */
export async function saveSettingKeys(db: D1Database, values: Partial<Settings>): Promise<void> {
	const toSave: Partial<Settings> = { ...values };
	if (toSave.bannerLocation !== undefined) {
		toSave.showBanner = toSave.bannerLocation !== "off";
	} else if (toSave.showBanner !== undefined) {
		toSave.bannerLocation = toSave.showBanner ? "top" : "off";
	}
	const entries = Object.entries(toSave);
	if (!entries.length) return;
	const statement = db.prepare(
		"INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
	);
	await db.batch(entries.map(([key, value]) => statement.bind(key, JSON.stringify(value))));
}
