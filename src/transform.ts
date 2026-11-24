import type { Translate } from "./i18n";
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
	const sentTo = escapeHtml(t("banner.sentTo", { alias: "{alias}", sender: "{sender}" }))
		.replace("{alias}", `<b>${escapeHtml(info.alias)}</b>`)
		.replace("{sender}", escapeHtml(info.sender));
	const trackers = trackersRemoved > 0 ? ` · ${escapeHtml(t("banner.trackers", { count: trackersRemoved }))}` : "";
	return `<div data-mailflare-alias-banner="1" lang="${t.locale}" style="display:block!important;visibility:visible!important;opacity:1!important;position:static!important;height:auto!important;max-height:none!important;overflow:visible!important;margin:0 0 16px;padding:10px 12px;border:1px solid #dadce0;border-radius:12px;background:#f6f8fc;font:12px/1.5 -apple-system,'Segoe UI',Roboto,sans-serif;color:#5f6368;">${warning}${sentTo}${trackers}<br /><a href="${escapeHtml(info.blockUrl)}" style="${link}">${escapeHtml(t("banner.block"))}</a> · <a href="${escapeHtml(info.disableUrl)}" style="${link}">${escapeHtml(t("banner.disable"))}</a></div>`;
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

/** Removes trackers from forwarded HTML and text, then adds the banner. */
export async function transformForward(
	input: { html?: string; text?: string },
	options: { removeTrackers: boolean; banner: BannerInfo | null; t: Translate },
): Promise<{ html?: string; text?: string; trackersRemoved: number }> {
	let { html, text } = input;
	let trackersRemoved = 0;

	if (options.removeTrackers) {
		if (html) {
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
			html = await new HTMLRewriter()
				.on("body", {
					element(element) {
						element.prepend(block, { html: true });
						inserted = true;
					},
				})
				.transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }))
				.text();
			if (!inserted) html = block + html;
		}
		if (text !== undefined || !html) text = bannerText(banner, trackersRemoved, options.t) + (text ?? "");
	}
	return { html, text, trackersRemoved };
}
