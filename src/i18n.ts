/**
 * Interface languages. English (src/locales/en.ts) is the source; every other language defines every
 * key (the Dictionary type enforces it) and keeps the same {placeholders}. The list matches Mailflare's,
 * plus Traditional Chinese.
 *
 * To add a language: create src/locales/<code>.ts, then register it in LOCALES and LOCALE_INFO.
 */
import { en, type Dictionary, type MessageKey } from "./locales/en";
import ar from "./locales/ar";
import bn from "./locales/bn";
import de from "./locales/de";
import es from "./locales/es";
import fa from "./locales/fa";
import fr from "./locales/fr";
import gu from "./locales/gu";
import ha from "./locales/ha";
import hi from "./locales/hi";
import id from "./locales/id";
import it from "./locales/it";
import ja from "./locales/ja";
import kn from "./locales/kn";
import ko from "./locales/ko";
import ml from "./locales/ml";
import mr from "./locales/mr";
import ms from "./locales/ms";
import nl from "./locales/nl";
import pa from "./locales/pa";
import pl from "./locales/pl";
import ptBR from "./locales/pt-BR";
import ptPT from "./locales/pt-PT";
import ru from "./locales/ru";
import si from "./locales/si";
import sw from "./locales/sw";
import ta from "./locales/ta";
import te from "./locales/te";
import th from "./locales/th";
import tr from "./locales/tr";
import uk from "./locales/uk";
import ur from "./locales/ur";
import vi from "./locales/vi";
import zhCN from "./locales/zh-CN";
import zhTW from "./locales/zh-TW";

export type { MessageKey } from "./locales/en";

export const LOCALES = {
	en,
	"zh-TW": zhTW,
	"zh-CN": zhCN,
	ja,
	ko,
	"pt-BR": ptBR,
	"pt-PT": ptPT,
	es,
	fr,
	de,
	it,
	nl,
	pl,
	ru,
	uk,
	tr,
	id,
	ms,
	vi,
	th,
	hi,
	bn,
	mr,
	te,
	ta,
	gu,
	kn,
	ml,
	pa,
	si,
	ur,
	ar,
	fa,
	sw,
	ha,
} satisfies Record<string, Dictionary>;

export type Locale = keyof typeof LOCALES;
export const LOCALE_LIST = Object.keys(LOCALES) as Locale[];
export const LANG_COOKIE = "mfa_lang";

const RTL = new Set<Locale>(["ar", "fa", "ur"]);

/** "rtl" for Arabic-script languages, otherwise "ltr". */
export function textDirection(locale: Locale): "ltr" | "rtl" {
	return RTL.has(locale) ? "rtl" : "ltr";
}

export function isLocale(value: unknown): value is Locale {
	return typeof value === "string" && Object.hasOwn(LOCALES, value);
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

export type Translate = ((key: MessageKey, params?: Record<string, string | number>) => string) & { locale: Locale };

export function translator(locale: Locale): Translate {
	const dictionary: Dictionary = LOCALES[locale];
	const t = ((key: MessageKey, params?: Record<string, string | number>) => {
		const template = dictionary[key] ?? en[key];
		return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match)) : template;
	}) as Translate;
	t.locale = locale;
	return t;
}
