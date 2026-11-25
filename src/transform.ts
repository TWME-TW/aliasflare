import { textDirection, type Translate } from "./i18n";
import { cleanLink, cleanText, isTrackerImage } from "./trackers";

export type BannerInfo = {
	alias: string;
	sender: string;
	blockUrl: string;
	disableUrl: string;
	spoofWarning: boolean;
};

export function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

/** The block shown above a forwarded message, like SimpleLogin's and addy.io's. */
export function bannerHtml(info: BannerInfo, trackersRemoved: number, t: Translate): string {
	const link = "color:#0b57d0;text-decoration:none;font-weight:600;";
	const warning = info.spoofWarning
		? `<div style="margin:0 0 6px;padding:6px 8px;border-radius:8px;background:#fce8e6;color:#b3261e;">${escapeHtml(t("banner.spoof"))}</div>`
		: "";
	// Escape the sentence first, then put the escaped alias and sender into it.
	// One pass with a function: an alias or sender holding "{sender}" or "$&" stays plain text.
	const values: Record<string, string> = { alias: `<b>${escapeHtml(info.alias)}</b>`, sender: escapeHtml(info.sender) };
	const sentTo = escapeHtml(t("banner.sentTo", { alias: "{alias}", sender: "{sender}" })).replace(/\{(alias|sender)\}/g, (_, key: string) => values[key]!);
	const trackers = trackersRemoved > 0 ? ` · ${escapeHtml(t("banner.trackers", { count: trackersRemoved }))}` : "";
	return `<div data-aliasflare-banner="1" lang="${t.locale}" dir="${textDirection(t.locale)}" style="display:block!important;visibility:visible!important;opacity:1!important;position:static!important;height:auto!important;max-height:none!important;overflow:visible!important;margin:0 0 16px;padding:10px 12px;border:1px solid #dadce0;border-radius:12px;background:#f6f8fc;font:12px/1.5 -apple-system,'Segoe UI',Roboto,sans-serif;color:#5f6368;">${warning}${sentTo}${trackers}<br /><a href="${escapeHtml(info.blockUrl)}" style="${link}">${escapeHtml(t("banner.block"))}</a> · <a href="${escapeHtml(info.disableUrl)}" style="${link}">${escapeHtml(t("banner.disable"))}</a></div>`;
}

export function bannerText(info: BannerInfo, trackersRemoved: number, t: Translate): string {
	const lines = [
		...(info.spoofWarning ? [t("banner.spoof")] : []),
		t("banner.sentTo", { alias: info.alias, sender: info.sender }) + (trackersRemoved > 0 ? ` · ${t("banner.trackers", { count: trackersRemoved })}` : ""),
		`${t("banner.block")}: ${info.blockUrl}`,
		`${t("banner.disable")}: ${info.disableUrl}`,
	];
	return `${lines.join("\n")}\n${"-".repeat(40)}\n\n`;
}

/** Linear-time scan for a leading <!doctype>/<html>/<head>...</head> block when HTMLRewriter is unavailable. */
function leadingHeadBlock(html: string): string {
	const lower = html.toLowerCase();
	const len = html.length;
	let pos = 0;
	const skipWs = () => {
		while (pos < len && /\s/.test(html[pos]!)) pos += 1;
	};
	skipWs();
	if (lower.startsWith("<!doctype", pos)) {
		const close = html.indexOf(">", pos);
		if (close < 0) return "";
		pos = close + 1;
		skipWs();
	}
	if (lower.startsWith("<html", pos) && (pos + 5 === len || /[\s>/]/.test(html[pos + 5]!))) {
		const close = html.indexOf(">", pos);
		if (close < 0) return html.slice(0, pos);
		pos = close + 1;
		skipWs();
	}
	if (lower.startsWith("<head", pos) && (pos + 5 === len || /[\s>/]/.test(html[pos + 5]!))) {
		const openEnd = html.indexOf(">", pos);
		if (openEnd < 0) return html.slice(0, pos);
		let scan = openEnd + 1;
		while (scan < len) {
			const nextTag = html.indexOf("<", scan);
			if (nextTag < 0) return html.slice(0, pos);
			if (lower.startsWith("<!--", nextTag)) {
				const end = html.indexOf("-->", nextTag + 4);
				if (end < 0) return html.slice(0, pos);
				scan = end + 3;
			} else if (lower.startsWith("</head", nextTag) && (nextTag + 6 === len || /[\s>]/.test(html[nextTag + 6]!))) {
				const close = html.indexOf(">", nextTag + 6);
				if (close < 0) return html.slice(0, pos);
				pos = close + 1;
				skipWs();
				return html.slice(0, pos);
			} else {
				const rawTag = (["style", "script", "title"] as const).find(
					(tag) => lower.startsWith(`<${tag}`, nextTag) && (nextTag + tag.length + 1 === len || /[\s>/]/.test(html[nextTag + tag.length + 1]!)),
				);
				if (rawTag) {
					const end = lower.indexOf(`</${rawTag}`, nextTag + rawTag.length + 1);
					if (end < 0) return html.slice(0, pos);
					const close = html.indexOf(">", end + rawTag.length + 2);
					if (close < 0) return html.slice(0, pos);
					scan = close + 1;
				} else {
					scan = nextTag + 1;
				}
			}
		}
	}
	return html.slice(0, pos);
}

/** Removes trackers from forwarded HTML and text, then adds the banner. */
export async function transformForward(
	input: { html?: string; text?: string },
	options: { removeTrackers: boolean; banner: BannerInfo | null; t: Translate },
): Promise<{ html?: string; text?: string; trackersRemoved: number }> {
	let { html, text } = input;
	let trackersRemoved = 0;

	if (options.removeTrackers) {
		if (html && typeof HTMLRewriter !== "undefined") {
			html = await new HTMLRewriter()
				.on("img", {
					element(element) {
						const attributes = {
							src: element.getAttribute("src"),
							width: element.getAttribute("width"),
							height: element.getAttribute("height"),
							style: element.getAttribute("style"),
						};
						if (isTrackerImage(attributes)) {
							element.remove();
							trackersRemoved += 1;
						}
					},
				})
				.on("a[href]", {
					element(element) {
						const href = element.getAttribute("href");
						if (!href) return;
						const cleaned = cleanLink(href);
						if (cleaned.changed) {
							element.setAttribute("href", cleaned.href);
							trackersRemoved += 1;
						}
					},
				})
				.transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }))
				.text();
		}
		if (text) {
			const cleaned = cleanText(text);
			text = cleaned.text;
			// An HTML message's text part repeats the same links; count them once.
			if (!html) trackersRemoved += cleaned.removed;
		}
	}

	if (options.banner) {
		const banner = options.banner;
		if (html) {
			let inserted = false;
			const block = bannerHtml(banner, trackersRemoved, options.t);
			if (typeof HTMLRewriter !== "undefined") {
				html = await new HTMLRewriter()
					.on("body", {
						element(element) {
							element.prepend(block, { html: true });
							inserted = true;
						},
					})
					.transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }))
					.text();
				// Without a <body>, place the banner right after <head> via HTMLRewriter (safe against
				// </head> inside comments or <style>).
				if (!inserted) {
					html = await new HTMLRewriter()
						.on("head", {
							element(element) {
								element.after(block, { html: true });
								inserted = true;
							},
						})
						.transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }))
						.text();
				}
			}
			if (!inserted) {
				const lead = leadingHeadBlock(html);
				html = lead + block + html.slice(lead.length);
			}
		}
		if (text !== undefined || !html) text = bannerText(banner, trackersRemoved, options.t) + (text ?? "");
	}
	return { html, text, trackersRemoved };
}
