import { describe, expect, it } from "vitest";
import { LOCALES, negotiateLocale, translator } from "../src/i18n";
import { bannerHtml } from "../src/transform";

describe("i18n", () => {
	it("defines every key in every language, with the same placeholders", () => {
		const english = LOCALES.en as Record<string, string>;
		for (const [locale, dictionary] of Object.entries(LOCALES)) {
			const entries = dictionary as Record<string, string>;
			expect(Object.keys(entries).sort(), locale).toEqual(Object.keys(english).sort());
			for (const [key, value] of Object.entries(english)) {
				const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
				expect(placeholders(entries[key] ?? ""), `${locale} ${key}`).toEqual(placeholders(value));
			}
		}
	});

	it("negotiates from Accept-Language", () => {
		expect(negotiateLocale("zh-TW,zh;q=0.9,en;q=0.8")).toBe("zh-TW");
		expect(negotiateLocale("zh-HK")).toBe("zh-TW");
		expect(negotiateLocale("zh-CN,zh;q=0.9")).toBe("zh-CN");
		expect(negotiateLocale("ja-JP")).toBe("ja");
		expect(negotiateLocale("fr-FR,de;q=0.5")).toBe("en");
		expect(negotiateLocale("en;q=0.1, ja;q=0.9")).toBe("ja");
		expect(negotiateLocale(null)).toBe("en");
	});

	it("fills placeholders", () => {
		expect(translator("zh-TW")("notice.blocked", { value: "x.com" })).toBe("已封鎖 x.com。");
		expect(translator("ja")("banner.trackers", { count: 2 })).toBe("トラッカーを 2 件削除");
	});

	it("keeps the banner escaped in every language", () => {
		for (const locale of Object.keys(LOCALES) as (keyof typeof LOCALES)[]) {
			const out = bannerHtml(
				{ alias: "a@x.com", sender: "<img src=x onerror=alert(1)>", blockUrl: "https://w/a", disableUrl: "https://w/b", spoofWarning: false },
				0,
				translator(locale),
			);
			expect(out, locale).not.toContain("<img");
			expect(out, locale).toContain("<b>a@x.com</b>");
		}
	});
});
