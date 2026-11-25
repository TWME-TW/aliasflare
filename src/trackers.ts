/**
 * Email tracker removal, in the spirit of Firefox Relay and DuckDuckGo Email Protection:
 * drop tracking pixels and strip tracking parameters from links. It is deliberately
 * conservative; it never rewrites link destinations, so nothing breaks beyond a missing pixel.
 */

/** Query parameters that only identify the recipient or the campaign. */
const TRACKING_PARAMS = new Set([
	"fbclid", "gclid", "dclid", "gbraid", "wbraid", "msclkid", "yclid", "twclid", "ttclid", "igshid", "li_fat_id",
	"mc_cid", "mc_eid", "_hsenc", "_hsmi", "__hssc", "__hstc", "__hsfp", "hsctatracking", "mkt_tok", "vero_id", "vero_conv",
	"oly_anon_id", "oly_enc_id", "rb_clickid", "s_cid", "ml_subscriber", "ml_subscriber_hash", "wickedid", "_kx", "ck_subscriber_id",
	"sc_cid", "trk", "trkcampaign", "mbid", "cmpid", "elqtrackid", "elqtrack", "elq", "elqaid", "elqat", "spm", "ref_src", "_ga",
]);
const TRACKING_PARAM_PREFIXES = ["utm_", "pk_", "mtm_", "hmb_", "ga_", "_ga_"];

const MAX_SRC_LENGTH = 2048;

/** URL patterns of known open-tracking pixels, whatever their declared size. */
const TRACKER_URL_PATTERNS: RegExp[] = [
	/list-manage\.com\/track\/open/i,
	/\/wf\/open\?/i, // SendGrid
	/mandrillapp\.com\/track\/open/i,
	/\/track\/open(\.php)?\b/i,
	/\.hubspotemail\.net\//i,
	/hubspotlinks\.com\/[^?#\s]{0,300}\/(e|o)\b/i,
	/\bopen\.convertkit-mail\d*\.com\//i,
	/\bmktoresp\.com\//i,
	/\bexct\.net\/open/i,
	/\brs6\.net\/on\.jsp/i,
	/\bmailtrack\.io\//i,
	/\bmltrk\.io\//i,
	/\bstreak\.com\/[^?#\s]{0,300}\/(pixel|open)/i,
	/\bt\.yesware\.com\//i,
	/\bbl-1\.com\//i, // Bananatag
	/\bmixmax\.com\/(api\/)?track/i,
	/\bsuperhuman\.com\/[^?#\s]{0,300}\.(gif|png)/i,
	/\bemltrk\.com\//i,
	/\bpixel\.(mailchimp|wp|facebook)\.com\//i,
	/\bopen\.substack\.com\//i,
	/\bemail\.mg\.[^/]+\/o\//i, // Mailgun
	/\bsparkpostmail\.com\/q\//i,
	/\bpostmarkapp\.com\/[^?#\s]{0,300}\/open/i,
	/\bcustomeriomail\.com\/e\/o\//i,
	/\bklclick\d*\.com\/[^?#\s]{0,300}\/open/i,
	/\/(open|opened|pixel|beacon)\.(gif|png|jpg)\b/i,
];

export function isTrackingParam(name: string): boolean {
	const lower = name.toLowerCase();
	return TRACKING_PARAMS.has(lower) || TRACKING_PARAM_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** Removes tracking query parameters from an http(s) link while preserving raw encoding of unrelated params. */
export function cleanLink(href: string): { href: string; changed: boolean } {
	let url: URL;
	try {
		url = new URL(href);
	} catch {
		return { href, changed: false };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return { href, changed: false };
	if (!url.search || url.search.length <= 1) return { href, changed: false };
	const raw = url.search.slice(1);
	const parts = raw.split("&");
	let changed = false;
	const kept: string[] = [];
	for (const part of parts) {
		const eq = part.indexOf("=");
		const rawName = eq >= 0 ? part.slice(0, eq) : part;
		let decodedName = rawName.replace(/\+/g, " ");
		try {
			decodedName = decodeURIComponent(decodedName);
		} catch {
			// Keep undecodable key as-is.
		}
		if (rawName && isTrackingParam(decodedName)) changed = true;
		else kept.push(part);
	}
	if (!changed) return { href, changed: false };
	const query = kept.length ? `?${kept.join("&")}` : "";
	const qIndex = href.indexOf("?");
	const hIndex = href.indexOf("#", qIndex >= 0 ? qIndex : 0);
	const before = qIndex >= 0 ? href.slice(0, qIndex) : href;
	const hash = hIndex >= 0 ? href.slice(hIndex) : "";
	return { href: `${before}${query}${hash}`, changed: true };
}

function pixelSize(value: string | null): number | null {
	if (value === null) return null;
	const match = value.trim().match(/^(\d+(?:\.\d+)?)(px)?$/i);
	return match ? Number(match[1]) : null;
}

/** True for an image that exists only to report an open. */
export function isTrackerImage(attributes: { src: string | null; width: string | null; height: string | null; style: string | null }): boolean {
	const { width, height, style } = attributes;
	// Patterns only look at the start of the address, which keeps a huge src cheap to test.
	const src = attributes.src?.slice(0, MAX_SRC_LENGTH) ?? null;
	if (src && TRACKER_URL_PATTERNS.some((pattern) => pattern.test(src))) return true;
	const w = pixelSize(width);
	const h = pixelSize(height);
	if (w !== null && h !== null && w <= 2 && h <= 2) return true;
	if (style) {
		const css = style.toLowerCase().replace(/\s+/g, "");
		if (/display:none|visibility:hidden/.test(css) && src) return true;
		const cw = css.match(/(?:^|;)width:(\d+(?:\.\d+)?)px/)?.[1];
		const ch = css.match(/(?:^|;)height:(\d+(?:\.\d+)?)px/)?.[1];
		if (cw !== undefined && ch !== undefined && Number(cw) <= 2 && Number(ch) <= 2) return true;
	}
	return false;
}

/** Plain-text links: strip tracking parameters from every http(s) URL. */
export function cleanText(text: string): { text: string; removed: number } {
	let removed = 0;
	const out = text.replace(/https?:\/\/[^\s<>"')\]]+/gi, (match) => {
		let end = match.length;
		while (end > 0 && ".,;:!?".includes(match[end - 1]!)) end -= 1;
		const trail = match.slice(end);
		const link = end < match.length ? match.slice(0, end) : match;
		const cleaned = cleanLink(link);
		if (cleaned.changed) removed += 1;
		return cleaned.href + trail;
	});
	return { text: out, removed };
}
