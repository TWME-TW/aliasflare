/**
 * Interface languages. English (src/locales/en.ts) is the source; every other language defines every
 * key (the Dictionary type enforces it) and keeps the same {placeholders}. The list matches Mailflare's,
 * plus Traditional Chinese.
 *
 * To add a language: create src/locales/<code>.ts, then register it in LOCALE_NAMES and LOADERS.
 */
import { en, type Dictionary, type MessageKey } from "./locales/en";

export type { MessageKey } from "./locales/en";

/**
 * Every language, in menu order, with the name it calls itself. Only English is part of the
 * Worker's start-up: another language is loaded the first time it is needed (see loadLocale), so a
 * fresh Worker does not build 34 dictionaries it will never use.
 */
export const LOCALE_NAMES = {
	en: "English",
	"zh-TW": "繁體中文",
	"zh-CN": "简体中文",
	ja: "日本語",
	ko: "한국어",
	"pt-BR": "Português (Brasil)",
	"pt-PT": "Português (Portugal)",
	es: "Español",
	fr: "Français",
	de: "Deutsch",
	it: "Italiano",
	nl: "Nederlands",
	pl: "Polski",
	ru: "Русский",
	uk: "Українська",
	tr: "Türkçe",
	id: "Bahasa Indonesia",
	ms: "Bahasa Melayu",
	vi: "Tiếng Việt",
	th: "ไทย",
	hi: "हिन्दी",
	bn: "বাংলা",
	mr: "मराठी",
	te: "తెలుగు",
	ta: "தமிழ்",
	gu: "ગુજરાતી",
	kn: "ಕನ್ನಡ",
	ml: "മലയാളം",
	pa: "ਪੰਜਾਬੀ",
	si: "සිංහල",
	ur: "اردو",
	ar: "العربية",
	fa: "فارسی",
	sw: "Kiswahili",
	ha: "Hausa",
} as const;

export type Locale = keyof typeof LOCALE_NAMES;
export const LOCALE_LIST = Object.keys(LOCALE_NAMES) as Locale[];

const LOADERS: Record<Exclude<Locale, "en">, () => Promise<{ default: Dictionary }>> = {
	"zh-TW": () => import("./locales/zh-TW"),
	"zh-CN": () => import("./locales/zh-CN"),
	ja: () => import("./locales/ja"),
	ko: () => import("./locales/ko"),
	"pt-BR": () => import("./locales/pt-BR"),
	"pt-PT": () => import("./locales/pt-PT"),
	es: () => import("./locales/es"),
	fr: () => import("./locales/fr"),
	de: () => import("./locales/de"),
	it: () => import("./locales/it"),
	nl: () => import("./locales/nl"),
	pl: () => import("./locales/pl"),
	ru: () => import("./locales/ru"),
	uk: () => import("./locales/uk"),
	tr: () => import("./locales/tr"),
	id: () => import("./locales/id"),
	ms: () => import("./locales/ms"),
	vi: () => import("./locales/vi"),
	th: () => import("./locales/th"),
	hi: () => import("./locales/hi"),
	bn: () => import("./locales/bn"),
	mr: () => import("./locales/mr"),
	te: () => import("./locales/te"),
	ta: () => import("./locales/ta"),
	gu: () => import("./locales/gu"),
	kn: () => import("./locales/kn"),
	ml: () => import("./locales/ml"),
	pa: () => import("./locales/pa"),
	si: () => import("./locales/si"),
	ur: () => import("./locales/ur"),
	ar: () => import("./locales/ar"),
	fa: () => import("./locales/fa"),
	sw: () => import("./locales/sw"),
	ha: () => import("./locales/ha"),
};

const loaded = new Map<Locale, Dictionary>([["en", en]]);

/** Loads a language's dictionary, once per Worker. translator() needs it loaded first. */
export async function loadLocale(locale: Locale): Promise<Locale> {
	if (!loaded.has(locale)) loaded.set(locale, (await LOADERS[locale as Exclude<Locale, "en">]()).default);
	return locale;
}

/** A language's whole dictionary (for tests and checks). */
export async function dictionaryFor(locale: Locale): Promise<Dictionary> {
	await loadLocale(locale);
	return loaded.get(locale)!;
}

export const LANG_COOKIE = "af_lang";
export const THEME_COOKIE = "af_theme";
export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export function isTheme(value: unknown): value is Theme {
	return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

const RTL = new Set<Locale>(["ar", "fa", "ur"]);

/** "rtl" for Arabic-script languages, otherwise "ltr". */
export function textDirection(locale: Locale): "ltr" | "rtl" {
	return RTL.has(locale) ? "rtl" : "ltr";
}

export function isLocale(value: unknown): value is Locale {
	return typeof value === "string" && Object.hasOwn(LOCALE_NAMES, value);
}

const BY_LOWER = new Map(LOCALE_LIST.map((locale) => [locale.toLowerCase(), locale]));

/** Maps one language tag to a supported language, or null. */
function matchTag(tag: string): Locale | null {
	const exact = BY_LOWER.get(tag);
	if (exact) return exact;
	const [primary = "", ...rest] = tag.split("-");
	if (primary === "zh") {
		// Simplified for mainland China, Singapore and Hans; Traditional for Taiwan, Hong Kong, Macau and Hant.
		return rest.some((part) => ["cn", "sg", "my", "hans"].includes(part)) ? "zh-CN" : "zh-TW";
	}
	if (primary === "pt") return "pt-BR";
	if (primary === "in") return "id"; // legacy tag for Indonesian
	return BY_LOWER.get(primary) ?? null;
}

/** Picks the best supported language from an Accept-Language header. */
export function negotiateLocale(acceptLanguage: string | null | undefined): Locale {
	if (!acceptLanguage) return "en";
	const ranked = acceptLanguage
		.split(",")
		.map((part) => {
			const [tag = "", ...params] = part.trim().split(";");
			const q = Number(params.find((param) => param.trim().startsWith("q="))?.trim().slice(2) ?? 1);
			return { tag: tag.trim().toLowerCase(), q: Number.isFinite(q) ? q : 0 };
		})
		.filter((entry) => entry.tag && entry.q > 0)
		.sort((a, b) => b.q - a.q);
	for (const { tag } of ranked) {
		const match = matchTag(tag);
		if (match) return match;
	}
	return "en";
}

export type Translate = ((key: MessageKey, params?: Record<string, string | number>) => string) & { locale: Locale; theme?: Theme };

/** True for a notice message key; notices travel in URLs as keys, never as text. */
export function isNoticeKey(value: unknown): value is MessageKey {
	return typeof value === "string" && value.startsWith("notice.") && Object.hasOwn(en, value);
}

const ERROR_NOTICE_KEYS = new Set<MessageKey>([
	"notice.badDestination",
	"notice.destinationOnReverse",
	"notice.badMailflareUrl",
	"notice.badPublicUrl",
	"notice.badBlock",
	"notice.bulkNoLabels",
	"notice.lastPasskey",
	"notice.badMode",
	"notice.loop",
	"notice.badContact",
	"notice.badAliasDomain",
	"notice.badWorkerName",
	"notice.needCloudflareToken",
	"notice.bulkBad",
	"notice.newExists",
	"notice.newBadPrefix",
	"notice.newBadDomain",
	"notice.newFailed",
	"notice.needAliasDomains",
	"notice.badProvider",
	"notice.freeSetupLimit",
	"notice.contactMissing",
	"notice.tooManyDomains",
	"notice.setupCodeWait",
	"notice.aliasMissing",
	"notice.unsubRedirectMissing",
	"notice.badSmtp",
	"notice.badSes",
	"notice.badCustom",
	"notice.labelName",
	"notice.labelTaken",
	"notice.labelLimit",
	"notice.labelMissing",
	"notice.ruleInvalid",
	"notice.ruleLimit",
	"notice.ruleMissing",
	"notice.ruleForwardTo",
	"notice.ruleWebhook",
	"notice.ruleUnsupported",
	"notice.reauth",
	"notice.pgpBadEmail",
	"notice.pgpInvalid",
	"notice.pgpPrivate",
	"notice.pgpNoEncryption",
	"notice.pgpExpired",
	"notice.pgpTooLarge",
	"notice.pgpMissing",
	"notice.wkdOtherAddress",
	"notice.wkdKeyInUse",
]);

/** True when a redirect notice reports a validation or action failure rather than success. */
export function isErrorNoticeKey(value: unknown): boolean {
	return isNoticeKey(value) && ERROR_NOTICE_KEYS.has(value);
}

export function translator(locale: Locale, theme: Theme = "system"): Translate {
	// Not loaded (a caller that forgot loadLocale): English rather than a failed page or message.
	const dictionary: Dictionary = loaded.get(locale) ?? (console.error(`Language ${locale} used before it was loaded`), en);
	const t = ((key: MessageKey, params?: Record<string, string | number>) => {
		// Own keys only, never inherited ones ("constructor"); an unknown key comes back as itself.
		const template = Object.hasOwn(dictionary, key) ? dictionary[key] : Object.hasOwn(en, key) ? en[key] : key;
		return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : match)) : template;
	}) as Translate;
	t.locale = locale;
	t.theme = theme;
	return t;
}
