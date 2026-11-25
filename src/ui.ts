import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { AliasRow, BlocklistRow, ContactRow } from "./db";
import { FORWARD_MODES } from "./db";
import { contactReverseAddress, reverseDomainFor } from "./domains";
import { SENDER_FORMATS } from "./format";
import { LOCALE_LIST, LOCALES, textDirection, type MessageKey, type Translate } from "./i18n";
import type { ApiKeyRow } from "./apikeys";
import type { DomainSetup } from "./cloudflare";
import type { ImportResult } from "./importer";
import type { PasskeyRow } from "./passkeys";
import { RANDOM_ALIAS_FORMATS, UNSUBSCRIBE_BEHAVIORS, type Settings } from "./settings";

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

/*
 * Visual style follows Mailflare's (Gmail-like): a #f6f8fc canvas, white cards with large radii,
 * #0b57d0 as the accent, pill-shaped buttons and navigation, and Mailflare's dark palette.
 */
export const STYLE = raw(`
:root { color-scheme: light dark;
	--bg:#f6f8fc; --card:#fff; --text:#202124; --muted:#5f6368; --line:#dadce0; --soft:#eef3fb; --hover:#e9eef6;
	--primary:#0b57d0; --primary-text:#fff; --primary-hover:#0a4fbe; --nav-active:#d3e3fd; --nav-active-text:#041e49;
	--danger:#b3261e; --danger-soft:#fce8e6; --ok:#146c2e; --ok-soft:#e6f4ea; --warn-soft:#fef7e0; --focus:rgba(11,87,208,.25);
	--radius:24px; --font: Geist, "Google Sans", Roboto, system-ui, -apple-system, "Segoe UI", "Noto Sans", "Noto Sans TC", "Noto Sans SC", "Noto Sans JP", "Noto Sans KR", "Noto Sans Arabic", "Noto Sans Devanagari", sans-serif; }
@media (prefers-color-scheme: dark) { :root {
	--bg:#202124; --card:#292a2d; --text:#e8eaed; --muted:#9aa0a6; --line:#3c4043; --soft:#303134; --hover:#35363a;
	--primary:#8ab4f8; --primary-text:#202124; --primary-hover:#aecbfa; --nav-active:#004a77; --nav-active-text:#c2e7ff;
	--danger:#f2b8b5; --danger-soft:#3c1f1e; --ok:#81c995; --ok-soft:#1e3324; --warn-soft:#3a3220; --focus:rgba(138,180,248,.3); } }
* { box-sizing:border-box; }
[hidden] { display:none !important; }
html { -webkit-text-size-adjust:100%; }
body { margin:0; font:15px/1.5 var(--font); background:var(--bg); color:var(--text); min-height:100vh; }
a { color:var(--primary); text-decoration:none; } a:hover { text-decoration:underline; }
svg.i { width:20px; height:20px; flex:none; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }

/* App shell: top bar, sidebar, content */
.topbar { display:flex; align-items:center; gap:12px; padding:12px 20px; min-height:64px; }
.brand { display:flex; align-items:center; gap:10px; font-size:20px; font-weight:600; color:var(--text); letter-spacing:-.01em; }
.brand:hover { text-decoration:none; } .brand svg { width:32px; height:32px; flex:none; }
.topbar .spacer { flex:1; }
.shell { display:grid; grid-template-columns:248px minmax(0,1fr); gap:8px; padding:0 16px 16px 8px; align-items:start; }
.sidebar { position:sticky; top:8px; display:flex; flex-direction:column; gap:2px; padding:4px 0; }
.sidebar a { display:flex; align-items:center; gap:14px; height:44px; padding:0 18px; border-radius:999px; color:var(--text); font-weight:500; }
.sidebar a:hover { background:var(--hover); text-decoration:none; }
.sidebar a[aria-current] { background:var(--nav-active); color:var(--nav-active-text); font-weight:600; }
.content { display:grid; gap:12px; min-width:0; }
.content > main, form.sections { display:grid; gap:12px; }
main.single, main.center { max-width:520px; margin:6vh auto 0; padding:0 16px; display:grid; gap:12px; }

section { background:var(--card); border-radius:var(--radius); padding:22px 26px; min-width:0; }
h1 { font-size:22px; font-weight:500; margin:0 0 8px; }
h2 { font-size:17px; font-weight:600; margin:0 0 12px; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
p { margin:8px 0; }
p.help, .muted { color:var(--muted); font-size:13px; margin:4px 0 0; }
code { font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; background:var(--soft); padding:1px 6px; border-radius:6px; word-break:break-all; }

/* Tables */
table { width:100%; border-collapse:collapse; font-size:14px; }
th, td { text-align:start; padding:12px 10px; border-bottom:1px solid var(--line); vertical-align:middle; }
tbody tr:last-child td { border-bottom:none; }
tbody tr:hover { background:var(--soft); }
th { color:var(--muted); font-weight:500; font-size:13px; }

/* Forms */
label { display:block; font-weight:500; margin:18px 0 6px; }
input[type=text], input[type=email], input[type=password], input[type=url], select {
	width:100%; max-width:480px; min-height:44px; padding:10px 14px; border:1px solid var(--line); border-radius:12px;
	background:var(--card); color:inherit; font:inherit; }
input:focus, select:focus, button:focus-visible, a:focus-visible { outline:none; border-color:var(--primary); box-shadow:0 0 0 3px var(--focus); }
td input[type=text], td input[type=email], td select { max-width:240px; min-height:36px; padding:6px 12px; border-radius:10px; }
.check { display:flex; gap:12px; align-items:flex-start; margin-top:18px; font-weight:500; }
.check input { margin-top:3px; width:18px; height:18px; flex:none; accent-color:var(--primary); }
fieldset { border:0; padding:0; margin:18px 0 0; min-width:0; }
legend { font-weight:600; padding:0; }
button { display:inline-flex; align-items:center; justify-content:center; gap:8px; min-height:40px; padding:0 20px; border-radius:999px;
	border:1px solid var(--line); background:var(--card); color:var(--primary); font:inherit; font-weight:500; cursor:pointer; white-space:nowrap; }
button:hover { background:var(--soft); }
button.primary { background:var(--primary); border-color:var(--primary); color:var(--primary-text); }
button.primary:hover { background:var(--primary-hover); border-color:var(--primary-hover); }
button.danger { color:var(--danger); } button.danger:hover { background:var(--danger-soft); }
button.ghost { border-color:transparent; color:var(--muted); } button.ghost:hover { background:var(--hover); color:var(--text); }
button:disabled { opacity:.6; cursor:wait; }
td button { min-height:34px; padding:0 14px; font-size:14px; }
form.inline { display:inline; margin:0; }
.row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.row input, .row select { flex:1 1 180px; }

/* Chips and messages */
.pill { display:inline-flex; align-items:center; padding:2px 10px; border-radius:999px; font-size:12px; font-weight:500; background:var(--soft); color:var(--muted); }
.pill.ok { background:var(--ok-soft); color:var(--ok); } .pill.bad { background:var(--danger-soft); color:var(--danger); }
.alias-cell { display:inline-flex; align-items:center; gap:2px; flex-wrap:wrap; }
button.copy { min-height:28px; padding:0 8px; }
.perms { list-style:none; padding:0; margin:10px 0 0; display:grid; gap:6px; }
.perms li { display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:14px; }
.pill.scope { background:var(--nav-active); color:var(--nav-active-text); }
.pill.scope.account { background:var(--warn-soft); color:var(--text); }
.perm-name { font-weight:600; color:var(--text); }
.perm-level { font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; padding:1px 8px; border-radius:6px; background:var(--ok-soft); color:var(--ok); }
.notice { padding:12px 18px; border-radius:16px; margin:0; background:var(--nav-active); color:var(--nav-active-text); }
.notice.bad { background:#fce8e6; color:#b3261e; }
@media (prefers-color-scheme: dark) { .notice.bad { background:#601410; color:#f2b8b5; } }
.error { color:var(--danger); margin:10px 0 0; }
ol.steps { padding-inline-start:20px; margin:8px 0 0; } ol.steps li { margin:6px 0; }
ul.results { list-style:none; padding:0; margin:12px 0; display:grid; gap:8px; } ul.results .muted { word-break:break-word; }
details { margin-top:16px; } summary { cursor:pointer; color:var(--primary); font-weight:500; }

/* Language menu and footer */
.lang { display:flex; align-items:center; gap:8px; color:var(--muted); font-size:13px; }
.lang svg.i { width:18px; height:18px; }
.lang select { min-height:36px; width:auto; max-width:200px; padding:4px 10px; border-radius:999px; font-size:14px; }
.lang button { min-height:36px; padding:0 14px; }
.sidebar .lang { margin:16px 18px 0; }
.sidebar .lang select { flex:1; max-width:none; }
footer.page { display:flex; justify-content:center; padding:24px 16px; }
.powered { color:var(--muted); font-size:12px; margin:12px 18px 0; }

@media (max-width: 900px) {
	.topbar { padding:8px 14px; min-height:56px; }
	.brand { font-size:18px; }
	.shell { display:block; padding:0 10px 16px; }
	.sidebar { position:static; flex-direction:row; overflow-x:auto; gap:6px; padding:0 4px 10px; scrollbar-width:none; }
	.sidebar::-webkit-scrollbar { display:none; }
	.sidebar a { flex:none; height:38px; padding:0 14px; gap:8px; background:var(--card); font-size:14px; }
	.sidebar .lang, .sidebar .powered { display:none; }
	.mobile-only { display:flex !important; }
	section { padding:18px; border-radius:20px; }
	main.single, main.center { margin-top:3vh; }
	input[type=text], input[type=email], input[type=password], input[type=url], select { max-width:none; font-size:16px; }
	table.rt thead { display:none; }
	table.rt, table.rt tbody, table.rt tr, table.rt td { display:block; width:100%; }
	table.rt tr { border:1px solid var(--line); border-radius:16px; margin:10px 0; padding:4px 14px; }
	table.rt tbody tr:hover { background:none; }
	table.rt td, table.rt td:first-child, table.rt td:last-child { display:flex; gap:12px; align-items:center; justify-content:space-between; border:none; padding:8px 0; text-align:end; }
	table.rt td + td { border-top:1px solid var(--line); }
	table.rt td::before { content:attr(data-label); color:var(--muted); font-size:12px; text-align:start; flex:0 0 32%; }
	table.rt td:empty { display:none; }
	table.rt td > form.row, table.rt td > .stack { flex:1; justify-content:flex-end; }
	td input[type=text], td input[type=email], td select { max-width:none; font-size:16px; }
}
.mobile-only { display:none; }
.toolbar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:12px 0; }
.toolbar input[type=search], .toolbar input[type=text] { flex:1 1 220px; width:auto; }
.toolbar select { width:auto; }
.bulk { padding:10px 12px; border-radius:16px; background:var(--bg); }
.create { margin:12px 0; padding:10px 14px; border-radius:16px; background:var(--bg); }
.create summary { cursor:pointer; font-weight:600; }
.create-form { display:grid; gap:10px; margin-top:10px; }
.create-address { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.create-address input { flex:1 1 200px; width:auto; }
.create-address select { width:auto; }
.create-form .check { margin-top:0; }
.create-form button { justify-self:start; }
th.pick, td.pick { width:36px; }
td.pick input, th.pick input { width:18px; height:18px; accent-color:var(--primary); }
.pager { display:flex; gap:16px; justify-content:center; align-items:center; margin-top:12px; }
form.note input { width:100%; min-width:12ch; }
.toast { position:fixed; inset-inline:0; bottom:24px; margin:0 auto; width:max-content; max-width:calc(100vw - 32px); z-index:10;
	padding:12px 20px; border-radius:12px; background:#323232; color:#fff; font-size:14px; box-shadow:0 4px 16px rgba(0,0,0,.25); }
.toast.bad { background:var(--danger); color:#fff; }
@media (prefers-color-scheme: dark) { .toast { background:#e8eaed; color:#202124; } .toast.bad { background:#f2b8b5; color:#601410; } }

.lang-label { margin:0; display:flex; }
.sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
.mt12 { margin-top:12px; }
.m0 { margin:0; }
.mono { font-family:ui-monospace,monospace; }
`);
/** Changes whenever the stylesheet does, so browsers fetch the new one after a deploy. */
export const STYLE_VERSION = (() => {
	let hash = 0;
	for (const char of String(STYLE)) hash = (hash * 31 + char.charCodeAt(0)) | 0;
	return (hash >>> 0).toString(36);
})();


/** Lucide icons (ISC license), inlined so the page needs no extra requests. */
const ICONS = {
	aliases: `<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>`,
	blocklist: `<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>`,
	settings: `<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4"/>`,
	connection: `<path d="M12 22v-5M9 8V2M15 8V2M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>`,
	passkeys: `<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5"/>`,
	apiKeys: `<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>`,
	import: `<path d="M12 3v12"/><path d="m8 11 4 4 4-4"/><path d="M8 5H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-4"/>`,
	signOut: `<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>`,
	globe: `<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20"/>`,
} as const;

function icon(name: keyof typeof ICONS): Html {
	return html`<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${raw(ICONS[name])}</svg>`;
}

/** The app mark: an envelope with a return arrow, in Mailflare's blue. */
const LOGO = raw(`<svg viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="lg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6aa5ff"/><stop offset="1" stop-color="#1a63e0"/></linearGradient></defs><rect x="3" y="7" width="26" height="19" rx="4" fill="url(#lg)"/><path d="M4.5 9.5 16 18l11.5-8.5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity=".95"/><circle cx="25" cy="23" r="6" fill="#fff"/><path d="M27.5 23h-5m2-2.2L22.3 23l2.2 2.2" fill="none" stroke="#1a63e0" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`);

const COPY_ICON = raw('<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>');

/** Copies the address to the clipboard. Hidden until the page script shows it, since it needs script. */
function copyButton(t: Translate, value: string): Html {
	return html`<button type="button" class="ghost copy" data-copy="${value}" data-msg-copied="${t("common.copied", { value })}" title="${t("common.copy")}" aria-label="${t("common.copy")}: ${value}" hidden>${COPY_ICON}</button>`;
}

export type PageOptions = { t: Translate; nav?: boolean; script?: boolean; current?: string; path?: string };

function languageMenu(t: Translate, path = "/", extraClass = ""): Html {
	return html`<form class="lang ${extraClass}" method="get" action="/lang">
<label for="lang-${extraClass || "main"}" class="lang-label">${icon("globe")}<span class="sr">${t("nav.language")}</span></label>
<input type="hidden" name="next" value="${path}" />
<select id="lang-${extraClass || "main"}" name="locale" data-autosubmit>
${LOCALE_LIST.map((locale) => html`<option value="${locale}" lang="${locale}" ${locale === t.locale ? "selected" : ""}>${LOCALES[locale]["lang.name"]}</option>`)}
</select>
<noscript><button type="submit">${t("lang.apply")}</button></noscript>
</form>`;
}

export function page(title: string, body: Html, options: PageOptions): Html {
	const { t } = options;
	const link = (href: string, key: MessageKey, name: keyof typeof ICONS) =>
		html`<a href="${href}" ${options.current === href ? html`aria-current="page"` : ""}>${icon(name)}<span>${t(key)}</span></a>`;
	const brand = html`<a class="brand" href="/">${LOGO}<span>aliasflare</span></a>`;
	return html`<!doctype html>
<html lang="${t.locale}" dir="${textDirection(t.locale)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex" />
<meta name="theme-color" content="#f6f8fc" media="(prefers-color-scheme: light)" />
<meta name="theme-color" content="#202124" media="(prefers-color-scheme: dark)" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<title>${title} · aliasflare</title>
<link rel="stylesheet" href="/assets/app.css?v=${STYLE_VERSION}" />
</head>
<body>
${options.nav
	? html`<header class="topbar">${brand}<span class="spacer"></span>
<form class="inline" method="post" action="/logout"><button class="ghost" title="${t("nav.signOut")}">${icon("signOut")}<span>${t("nav.signOut")}</span></button></form></header>
<div class="shell">
<nav class="sidebar" aria-label="aliasflare">
${link("/", "nav.aliases", "aliases")}${link("/import", "nav.import", "import")}${link("/blocklist", "nav.blocklist", "blocklist")}${link("/settings", "nav.settings", "settings")}${link("/connection", "nav.connection", "connection")}${link("/passkeys", "nav.passkeys", "passkeys")}${link("/api-keys", "nav.apiKeys", "apiKeys")}
<p class="powered">aliasflare · <a href="https://github.com/TWME-TW/aliasflare">GitHub</a></p>
</nav>
<div class="content">${body}</div>
<div class="toast" role="status" aria-live="polite" data-toast hidden></div>
</div>`
	: html`<header class="topbar">${brand}</header>${body}<footer class="page">${languageMenu(t, options.path)}</footer>`}
<script src="/assets/app.js"></script>
${options.script ? html`<script src="/assets/passkey.js"></script>` : ""}
</body>
</html>`;
}

/** Served at /favicon.svg. */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="lg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6aa5ff"/><stop offset="1" stop-color="#1a63e0"/></linearGradient></defs><rect x="3" y="7" width="26" height="19" rx="4" fill="url(#lg)"/><path d="M4.5 9.5 16 18l11.5-8.5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="25" cy="23" r="6" fill="#fff"/><path d="M27.5 23h-5m2-2.2L22.3 23l2.2 2.2" fill="none" stroke="#1a63e0" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;


function errorBox(t: Translate): Html {
	return html`<p class="error" data-error hidden></p><span hidden data-msg-unsupported="${t("passkey.unsupported")}" data-msg-cancelled="${t("passkey.cancelled")}"></span>`;
}

export function loginPage(t: Translate): Html {
	return page(
		t("login.title"),
		html`<main class="center"><section>
<h1>aliasflare</h1>
<form data-passkey="login">
<p class="help">${t("login.help")}</p>
<p><button class="primary">${t("login.button")}</button></p>
${errorBox(t)}
</form>
</section></main>`,
		{ t, script: true, path: "/login" },
	);
}

/** Renders text with `code` spans, for strings that mention commands. */
function withCode(text: string): Html {
	const parts = text.split("`");
	return html`${parts.map((part, index) => (index % 2 ? html`<code>${part}</code>` : part))}`;
}

export function setupPage(t: Translate, input: { codeInLogs: boolean; notice?: string }): Html {
	return page(
		t("setup.title"),
		html`<main class="center"><section>
<h1>${t("setup.welcome")}</h1>
${noticeBox(input.notice)}
<p>${t("setup.intro")}</p>
<form data-passkey="setup" data-next="/connection">
<label for="code">${t("setup.code")}</label>
<input id="code" name="code" type="text" autocomplete="one-time-code" autocapitalize="characters" required autofocus />
<p class="help">${withCode(input.codeInLogs ? t("setup.codeFromLogs") : t("setup.codeFromSecret"))}</p>
<label for="name">${t("setup.passkeyName")}</label>
<input id="name" name="name" type="text" value="${t("setup.defaultName")}" maxlength="60" />
<p><button class="primary">${t("setup.button")}</button></p>
${errorBox(t)}
</form>
${input.codeInLogs ? html`<form method="post" action="/setup/code"><button>${t("setup.newCode")}</button></form>` : ""}
</section></main>`,
		{ t, script: true, path: "/setup" },
	);
}

function checkbox(name: string, checked: boolean, label: string, help: string): Html {
	return html`<label class="check"><input type="checkbox" name="${name}" value="1" ${checked ? "checked" : ""} /><span>${label}<p class="help">${help}</p></span></label>`;
}

function noticeBox(notice?: string): Html | string {
	return notice ? html`<p class="notice" role="status">${notice}</p>` : "";
}

export type ActivityItem = { kind: string; status: string; alias: string | null; detail: string | null; at: number };

/** How long ago, like "3 hours ago", in the page's language. */
function ago(timestamp: number, locale: string, now = Date.now() / 1000): string {
	const seconds = Math.round(timestamp - now);
	const units: [Intl.RelativeTimeFormatUnit, number][] = [
		["year", 365 * 86400],
		["month", 30 * 86400],
		["week", 7 * 86400],
		["day", 86400],
		["hour", 3600],
		["minute", 60],
	];
	const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
	for (const [unit, size] of units) if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
	return format.format(0, "second");
}

function when(timestamp: number | null, locale: string): string {
	if (!timestamp) return "—";
	return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(timestamp * 1000)) + " UTC";
}

function translated(t: Translate, key: string, fallback: string): string {
	const value = t(key as MessageKey);
	return value === key ? fallback : value;
}

function statusPill(t: Translate, status: string): Html {
	const tone = status === "sent" || status === "done" ? "ok" : status === "failed" || status === "rejected" ? "bad" : "";
	return html`<span class="pill ${tone}">${translated(t, `status.${status}`, status)}</span>`;
}

/** Rows per page the alias list offers. */
export const ALIAS_PAGE_SIZES = [25, 50, 100, 200] as const;
export const DEFAULT_ALIAS_PAGE_SIZE = 100;

export type AliasListState = { query: string; filter: "all" | "active" | "disabled" | "pinned" | "deleted"; page: number; perPage: number; total: number };

/** The "New alias" form above the alias list. */
function newAliasForm(t: Translate, settings: Settings): Html | string {
	if (settings.aliasDomains.length === 0) {
		return html`<p class="notice">${t("new.noDomains")} <a href="/settings">${t("dash.goToSettings")}</a></p>`;
	}
	return html`<details class="create" open>
<summary>${t("new.title")}</summary>
<form method="post" action="/aliases/new" class="create-form">
<label>${t("new.kind")} <select name="kind" data-alias-kind>
<option value="custom">${t("new.kind.custom")}</option>
${RANDOM_ALIAS_FORMATS.map((format) => html`<option value="${format}">${t(`set.format.${format}`)}</option>`)}
</select></label>
<div class="create-address">
<input type="text" name="prefix" data-custom-only maxlength="50" autocomplete="off" spellcheck="false" placeholder="${t("new.prefixPlaceholder")}" aria-label="${t("new.prefix")}" />
<span aria-hidden="true">@</span>
<select name="domain" aria-label="${t("new.domain")}">
${settings.aliasDomains.map((domain) => html`<option value="${domain}">${domain}</option>`)}
</select>
</div>
<label>${t("new.note")} <input type="text" name="note" maxlength="500" /></label>
<label>${t("new.destination")} <input type="email" name="destination" maxlength="254" placeholder="${settings.defaultDestination || ""}" /></label>
<button>${t("new.create")}</button>
</form>
</details>`;
}

export function dashboardPage(
	t: Translate,
	input: {
		settings: Settings;
		aliases: (AliasRow & { contacts: number; used_at?: number | null })[];
		list: AliasListState;
		activity: ActivityItem[];
		missing: MessageKey[];
		notice?: string;
	},
): Html {
	const { settings, aliases, list, activity, missing, notice } = input;
	const listUrl = (changes: Partial<AliasListState>) => {
		const next = { ...list, ...changes };
		const params = new URLSearchParams();
		if (next.query) params.set("q", next.query);
		if (next.filter !== "all") params.set("filter", next.filter);
		if (next.perPage !== DEFAULT_ALIAS_PAGE_SIZE) params.set("per", String(next.perPage));
		if (next.page > 1) params.set("page", String(next.page));
		const search = params.toString();
		return search ? `/?${search}` : "/";
	};
	const lastPage = Math.max(1, Math.ceil(list.total / list.perPage));
	const deletedView = list.filter === "deleted";
	const actions: [string, string][] = deletedView
		? [
				["restore", t("bulk.restore")],
				["forget", t("bulk.forget")],
			]
		: [
				["all", t("mode.all")],
				["no_promotions", t("mode.no_promotions")],
				["none", t("mode.none")],
				["pin", t("bulk.pin")],
				["unpin", t("bulk.unpin")],
				["note", t("bulk.note")],
				["destination", t("bulk.destination")],
				["delete", t("bulk.delete")],
			];
	return page(
		t("dash.title"),
		html`<main>
${noticeBox(notice)}
${missing.length
	? html`<p class="notice">${t("dash.notConnected", { missing: missing.map((key) => t(key)).join(", ") })} <a href="/settings">${t("dash.finishConnection")}</a></p>`
	: ""}
${!settings.defaultDestination ? html`<p class="notice">${t("dash.setDestination")} <a href="/settings">${t("dash.goToSettings")}</a></p>` : ""}
<section>
<h2>${t("dash.title")}</h2>
<p class="help">${t("dash.aliasesHelp")}</p>
${newAliasForm(t, settings)}
<form class="toolbar" method="get" action="/" role="search">
<input type="search" name="q" value="${list.query}" placeholder="${t("dash.searchPlaceholder")}" aria-label="${t("dash.search")}" />
<select name="filter" aria-label="${t("dash.filter")}" data-autosubmit>
${(["all", "active", "disabled", "pinned", "deleted"] as const).map((filter) => html`<option value="${filter}" ${list.filter === filter ? "selected" : ""}>${t(`dash.filter.${filter}`)}</option>`)}
</select>
<select name="per" aria-label="${t("dash.perPageLabel")}" data-autosubmit>
${ALIAS_PAGE_SIZES.map((size) => html`<option value="${size}" ${list.perPage === size ? "selected" : ""}>${t("dash.perPage", { count: String(size) })}</option>`)}
</select>
<button>${t("dash.searchButton")}</button>
</form>
<p class="muted">${t("dash.results", { count: String(list.total) })}${list.query || list.filter !== "all" ? html` · <a href="/">${t("dash.clear")}</a>` : ""}</p>
${aliases.length === 0
	? html`<p class="muted">${list.query || list.filter !== "all" ? t("dash.noResults") : t("dash.noAliases")}</p>`
	: html`<form id="bulk" class="toolbar bulk" method="post" action="/aliases/bulk" data-bulk
 data-confirm-delete="${t("bulk.confirmDelete")}" data-confirm-forget="${t("bulk.confirmForget")}" data-none-selected="${t("bulk.noneSelected")}">
<input type="hidden" name="back" value="${listUrl({})}" />
<span class="muted" data-selected-count data-template="${t("bulk.selected", { count: "{count}" })}">${t("bulk.selected", { count: "0" })}</span>
<select name="action" aria-label="${t("bulk.action")}" required>
<option value="">${t("bulk.choose")}</option>
${actions.map(([value, label]) => html`<option value="${value}" ${value === "note" || value === "destination" ? html`data-needs-value` : ""}>${label}</option>`)}
</select>
<input type="text" name="value" placeholder="${t("bulk.value")}" aria-label="${t("bulk.value")}" data-bulk-value />
<button class="primary">${t("bulk.apply")}</button>
</form>
<table class="rt">
<thead><tr><th class="pick"><input type="checkbox" aria-label="${t("dash.selectAll")}" data-select-all /></th><th>${t("dash.colAlias")}</th><th>${t("dash.colNote")}</th><th>${t("dash.colForwardTo")}</th><th>${t("dash.colMode")}</th><th>${t("dash.colContacts")}</th><th>${t("dash.colLastUsed")}</th></tr></thead>
<tbody>
${aliases.map((alias) => {
	const base = `/aliases/${encodeURIComponent(alias.address)}`;
	return html`<tr>
<td class="pick"><input type="checkbox" form="bulk" name="ids" value="${alias.address}" aria-label="${t("dash.select", { alias: alias.address })}" data-pick /></td>
<td data-label="${t("dash.colAlias")}"><span class="alias-cell"><a href="${base}"><code>${alias.address}</code></a>${copyButton(t, alias.address)}</span>${alias.pinned ? html` <span class="pill">${t("dash.filter.pinned")}</span>` : ""}${alias.deleted_at ? html` <span class="pill bad">${t("dash.filter.deleted")}</span>` : ""}</td>
<td data-label="${t("dash.colNote")}"><form class="note" method="post" action="${base}/note" data-autosave data-msg-failed="${t("link.error")}">
<input type="hidden" name="back" value="list" />
<input type="text" name="note" value="${alias.note ?? ""}" maxlength="200" placeholder="${t("alias.notePlaceholder")}" aria-label="${t("dash.colNote")}: ${alias.address}" />
<noscript><button>${t("common.save")}</button></noscript></form></td>
<td data-label="${t("dash.colForwardTo")}"><form class="row" method="post" action="${base}/destination">
<input type="email" name="destination" value="${alias.destination ?? ""}" placeholder="${settings.defaultDestination || t("dash.default")}" aria-label="${t("dash.colForwardTo")}" />
<button>${t("common.save")}</button></form></td>
<td data-label="${t("dash.colMode")}"><form class="row" method="post" action="${base}/mode">
<select name="mode" aria-label="${t("dash.colMode")}">${FORWARD_MODES.map((mode) => html`<option value="${mode.value}" ${alias.forward_mode === mode.value ? "selected" : ""}>${t(`mode.${mode.value}`)}</option>`)}</select>
<button>${t("common.set")}</button></form></td>
<td data-label="${t("dash.colContacts")}">${alias.contacts}</td>
<td data-label="${t("dash.colLastUsed")}">${alias.used_at ? html`<time datetime="${new Date(alias.used_at * 1000).toISOString()}" title="${when(alias.used_at, t.locale)}">${ago(alias.used_at, t.locale)}</time>` : html`<span class="muted">${t("dash.neverUsed")}</span>`}</td>
</tr>`;
})}
</tbody></table>
${lastPage > 1
	? html`<nav class="pager" aria-label="${t("dash.pages")}">
${list.page > 1 ? html`<a href="${listUrl({ page: list.page - 1 })}">← ${t("dash.prev")}</a>` : ""}
<span class="muted">${list.page} / ${lastPage}</span>
${list.page < lastPage ? html`<a href="${listUrl({ page: list.page + 1 })}">${t("dash.next")} →</a>` : ""}
</nav>`
	: ""}`}
<p class="help">${t("dash.modesHelp")}</p>
</section>

<section>
<h2>${t("dash.activity")}</h2>
${activity.length === 0
	? html`<p class="muted">${t("dash.nothingYet")}</p>`
	: html`<table class="rt"><thead><tr><th>${t("dash.colWhen")}</th><th>${t("dash.colWhat")}</th><th>${t("dash.colAlias")}</th><th>${t("dash.colStatus")}</th><th>${t("dash.colDetail")}</th></tr></thead><tbody>
${activity.map(
	(item) => html`<tr><td data-label="${t("dash.colWhen")}">${when(item.at, t.locale)}</td><td data-label="${t("dash.colWhat")}">${translated(t, `kind.${item.kind}`, item.kind)}</td>
<td data-label="${t("dash.colAlias")}"><code>${item.alias ?? ""}</code></td><td data-label="${t("dash.colStatus")}">${statusPill(t, item.status)}</td>
<td data-label="${t("dash.colDetail")}" class="muted">${item.detail ?? ""}</td></tr>`,
)}
</tbody></table>`}
</section>
</main>`,
		{ t, nav: true, current: "/", path: "/" },
	);
}

export function settingsPage(t: Translate, input: { settings: Settings; origin: string; notice?: string }): Html {
	const { settings, notice, origin } = input;
	return page(
		t("settings.title"),
		html`<main>
${noticeBox(notice)}
<form class="sections" method="post" action="/settings" data-autosave data-msg-failed="${t("link.error")}">
<section id="language-settings">
<h2>${t("nav.language")}</h2>
<label for="uiLocale">${t("set.uiLanguage")}</label>
<select id="uiLocale" name="uiLocale">
${LOCALE_LIST.map((locale) => html`<option value="${locale}" lang="${locale}" ${t.locale === locale ? "selected" : ""}>${LOCALES[locale]["lang.name"]}</option>`)}
</select>
<p class="help">${t("set.uiLanguageHelp")}</p>

<label for="language">${t("settings.mailLanguage")}</label>
<select id="language" name="language">
${LOCALE_LIST.map((locale) => html`<option value="${locale}" lang="${locale}" ${settings.language === locale ? "selected" : ""}>${LOCALES[locale]["lang.name"]}</option>`)}
</select>
</section>
<section>
<h2>${t("settings.section")}</h2>
<label for="defaultDestination">${t("settings.destination")}</label>
<input id="defaultDestination" name="defaultDestination" type="email" value="${settings.defaultDestination}" placeholder="you@gmail.com" />
<p class="help">${t("settings.destinationHelp")}</p>

<label for="senderFormat">${t("settings.senderFormat")}</label>
<select id="senderFormat" name="senderFormat">
${SENDER_FORMATS.map(
	(format) => html`<option value="${format.value}" ${settings.senderFormat === format.value ? "selected" : ""}>${format.value === "NO_NAME" ? t("settings.noName") : format.label}</option>`,
)}
</select>
<p class="help">${t("settings.senderFormatHelp")}</p>

${checkbox("reverseAliasReplacement", settings.reverseAliasReplacement, t("settings.replacement"), t("settings.replacementHelp"))}
${checkbox("includeSenderInReverseAlias", settings.includeSenderInReverseAlias, t("settings.includeSender"), t("settings.includeSenderHelp"))}
${checkbox("removeTrackers", settings.removeTrackers, t("settings.trackers"), t("settings.trackersHelp"))}
${checkbox("showBanner", settings.showBanner, t("settings.banner"), t("settings.bannerHelp"))}
${checkbox("autoForwardNewAliases", settings.autoForwardNewAliases, t("settings.autoForward"), t("settings.autoForwardHelp"))}

<label for="unsubscribeBehavior">${t("settings.unsubscribe")}</label>
<select id="unsubscribeBehavior" name="unsubscribeBehavior">
${UNSUBSCRIBE_BEHAVIORS.map((behavior) => html`<option value="${behavior}" ${settings.unsubscribeBehavior === behavior ? "selected" : ""}>${t(`unsub.${behavior}`)}</option>`)}
</select>
<p class="help">${t("settings.unsubscribeHelp")}<br />
${UNSUBSCRIBE_BEHAVIORS.map((behavior) => html`<b>${t(`unsub.${behavior}`)}:</b> ${t(`unsub.${behavior}.help`)}<br />`)}</p>
</section>

<section id="clients">
<h2>${t("set.clients")}</h2>
<p class="help">${t("set.clientsHelp")} <a href="/api-keys">${t("nav.apiKeys")} →</a></p>
${checkbox("simpleloginApi", settings.simpleloginApi, t("set.simpleloginApi"), t("set.simpleloginApiHelp", { url: origin }))}
${checkbox("addyApi", settings.addyApi, t("set.addyApi"), t("set.addyApiHelp", { url: origin }))}

<label for="aliasDomains">${t("set.aliasDomains")}</label>
<input id="aliasDomains" name="aliasDomains" type="text" value="${settings.aliasDomains.join(", ")}" placeholder="mail.example.com" autocapitalize="none" spellcheck="false" />
<p class="help">${t("set.aliasDomainsHelp")}</p>

<label for="randomAliasFormat">${t("set.randomFormat")}</label>
<select id="randomAliasFormat" name="randomAliasFormat">
${RANDOM_ALIAS_FORMATS.map((format) => html`<option value="${format}" ${settings.randomAliasFormat === format ? "selected" : ""}>${t(`set.format.${format}`)}</option>`)}
</select>

${checkbox("appSettings", settings.appSettings, t("set.appSettings"), t("set.appSettingsHelp"))}

<noscript><p><button class="primary">${t("settings.saveButton")}</button></p></noscript>
</section>
</form>
</main>`,
		{ t, nav: true, current: "/settings", path: "/settings" },
	);
}

/** What the Cloudflare token needs, as the token form names it, with the scope each one is granted on. */
const TOKEN_PERMISSIONS: ["zone" | "account", string, string][] = [
	["zone", "Zone", "Read"],
	["zone", "Zone Settings", "Edit"],
	["zone", "DNS", "Edit"],
	["zone", "Email Routing Rules", "Edit"],
	["account", "Email Sending", "Edit"],
];

export function connectionPage(
	t: Translate,
	input: {
		values: { mailflareUrl: string; publicUrl: string };
		hasApiKey: boolean;
		hasWebhookSecret: boolean;
		mailflare: boolean;
		fixed: Set<string>;
		webhookUrl: string;
		missing: MessageKey[];
		cloudflare: { hasToken: boolean; workerName: string; domains: string[]; setup?: DomainSetup[] };
		notice?: string;
	},
): Html {
	const { values, hasApiKey, hasWebhookSecret, mailflare, fixed, webhookUrl, missing, cloudflare, notice } = input;
	const fixedNote = (key: string) => (fixed.has(key) ? html`<p class="help">${t("conn.fixed")}</p>` : "");
	const disabled = (key: string) => (fixed.has(key) ? "disabled" : "");
	const secretField = (key: string, label: string, isSet: boolean, help: string) => html`
<label for="${key}">${label} ${isSet ? html`<span class="pill ok">${t("conn.isSet")}</span>` : html`<span class="pill bad">${t("conn.notSet")}</span>`}</label>
<input id="${key}" name="${key}" type="password" autocomplete="off" placeholder="${isSet ? t("conn.keepCurrent") : ""}" ${disabled(key)} />
<p class="help">${help}</p>${fixedNote(key)}`;
	const example = cloudflare.domains[0] ?? "example.com";
	return page(
		t("conn.title"),
		html`<main>
${noticeBox(notice)}
<section id="cloudflare">
<h2>${t("cf.title")} ${missing.length ? html`<span class="pill bad">${t("conn.incomplete")}</span>` : html`<span class="pill ok">${t("conn.ready")}</span>`}</h2>
<p class="help">${t("cf.help")}</p>
<p class="notice">${t("cf.warnMx")}</p>
${cloudflare.setup
	? cloudflare.setup.map(
			(result) => html`<h3><code>${result.domain}</code></h3><ul class="results">${result.steps.map(
				(step) => html`<li><span class="pill ${step.ok ? "ok" : "bad"}">${step.ok ? "✓" : "✕"}</span> <b>${t(`cf.step.${step.step}`)}</b> <span class="muted">${step.detail}</span></li>`,
			)}</ul>`,
		)
	: ""}
<form method="post" action="/connection/cloudflare">
<fieldset><legend>${t("cf.domains")}</legend>
${cloudflare.domains.length
	? cloudflare.domains.map(
			(domain) => html`<label class="check"><input type="checkbox" name="domains" value="${domain}" checked /> <code>${domain}</code> <span class="muted">→ ${t("cf.reverseIs", { reverse: reverseDomainFor(domain) })}</span></label>`,
		)
	: html`<p class="help">${t("notice.needAliasDomains")} <a href="/settings#clients">${t("nav.settings")} →</a></p>`}
</fieldset>
${secretField("cloudflareApiToken", t("cf.token"), cloudflare.hasToken, t("cf.tokenHelp"))}
<ul class="perms">${TOKEN_PERMISSIONS.map(
	([scope, name, level]) => html`<li><span class="pill scope ${scope}">${t(scope === "zone" ? "cf.scopeZone" : "cf.scopeAccount")}</span><span class="perm-name">${name}</span><span class="perm-level">${level}</span></li>`,
)}</ul>
<p class="help">${t("cf.tokenScope")}</p>
${checkbox("replaceCatchAll", false, t("cf.replaceCatchAll"), t("cf.replaceCatchAllHelp"))}
<label for="workerName">${t("cf.workerName")}</label>
<input id="workerName" name="workerName" type="text" value="${cloudflare.workerName}" autocapitalize="none" spellcheck="false" ${disabled("workerName")} />
<p class="help">${t("cf.workerNameHelp")}</p>${fixedNote("workerName")}
<p><button class="primary" ${cloudflare.domains.length ? "" : "disabled"}>${t("cf.run")}</button></p>
</form>
<details><summary>${t("conn.checklist")}</summary>
<ol class="steps">
<li>${t("conn.step1", { domain: example, worker: cloudflare.workerName })}</li>
<li>${t("conn.step2", { reverse: reverseDomainFor(example), worker: cloudflare.workerName })}</li>
<li>${t("conn.step3", { domain: example, reverse: reverseDomainFor(example) })}</li>
<li>${t("conn.step4")}</li>
</ol>
</details>
</section>
<form method="post" action="/connection" class="sections">
<section>
<h2>${t("conn.publicUrl")}</h2>
<input id="publicUrl" name="publicUrl" type="url" value="${values.publicUrl}" placeholder="https://alias.example.com" aria-label="${t("conn.publicUrl")}" ${disabled("publicUrl")} />
<p class="help">${t("conn.publicUrlHelp")}</p>${fixedNote("publicUrl")}
<p><button class="primary">${t("conn.saveButton")}</button></p>
</section>
<section id="mailflare">
<h2>${t("conn.mailflareTitle")} ${mailflare ? html`<span class="pill ok">${t("conn.isSet")}</span>` : html`<span class="pill">${t("conn.notSet")}</span>`}</h2>
<p class="help">${t("conn.mailflareHelp")}</p>
<label for="mailflareUrl">${t("conn.mailflareUrl")}</label>
<input id="mailflareUrl" name="mailflareUrl" type="url" value="${values.mailflareUrl}" placeholder="https://mail.example.com" ${disabled("mailflareUrl")} />
<p class="help">${t("conn.mailflareUrlHelp")}</p>${fixedNote("mailflareUrl")}
${secretField("mailflareApiKey", t("conn.apiKey"), hasApiKey, t("conn.apiKeyHelp"))}
${secretField("webhookSecret", t("conn.webhookSecret"), hasWebhookSecret, t("conn.webhookSecretHelp", { url: webhookUrl }))}
<p><button class="primary">${t("conn.saveButton")}</button></p>
</section>
</form>
</main>`,
		{ t, nav: true, current: "/connection", path: "/connection" },
	);
}

export function passkeysPage(t: Translate, input: { passkeys: PasskeyRow[]; notice?: string }): Html {
	const { passkeys, notice } = input;
	return page(
		t("pk.title"),
		html`<main>
${noticeBox(notice)}
<section>
<h2>${t("pk.title")}</h2>
<table class="rt"><thead><tr><th>${t("pk.colName")}</th><th>${t("pk.colAdded")}</th><th>${t("pk.colLastUsed")}</th><th></th></tr></thead><tbody>
${passkeys.map(
	(passkey) => html`<tr><td data-label="${t("pk.colName")}">${passkey.name}</td><td data-label="${t("pk.colAdded")}">${when(passkey.created_at, t.locale)}</td>
<td data-label="${t("pk.colLastUsed")}">${when(passkey.last_used_at, t.locale)}</td>
<td data-label="">${passkeys.length > 1
		? html`<form class="inline" method="post" action="/passkeys/${encodeURIComponent(passkey.id)}/delete"><button class="danger">${t("pk.remove")}</button></form>`
		: html`<span class="muted">${t("pk.last")}</span>`}</td></tr>`,
)}
</tbody></table>
</section>
<section>
<h2>${t("pk.add")}</h2>
<form data-passkey="add" data-next="/passkeys?notice=notice.passkeyAdded">
<label for="name">${t("pk.name")}</label>
<div class="row"><input id="name" name="name" type="text" value="${t("pk.defaultName")}" maxlength="60" /><button class="primary">${t("setup.button")}</button></div>
<p class="help">${t("pk.addHelp")}</p>
${errorBox(t)}
</form>
</section>
</main>`,
		{ t, nav: true, script: true, current: "/passkeys", path: "/passkeys" },
	);
}

export function blocklistPage(t: Translate, input: { entries: BlocklistRow[]; notice?: string }): Html {
	const { entries, notice } = input;
	return page(
		t("bl.title"),
		html`<main>
${noticeBox(notice)}
<section>
<h2>${t("bl.title")}</h2>
<p class="help">${t("bl.help")}</p>
<form class="row mt12" method="post" action="/blocklist">
<input name="value" type="text" placeholder="${t("bl.placeholder")}" autocapitalize="none" required aria-label="${t("bl.colSender")}" />
<button class="primary">${t("bl.block")}</button>
</form>
${entries.length === 0
	? html`<p class="muted">${t("bl.empty")}</p>`
	: html`<table class="rt mt12"><thead><tr><th>${t("bl.colSender")}</th><th>${t("bl.colType")}</th><th>${t("bl.colHits")}</th><th>${t("bl.colAdded")}</th><th></th></tr></thead><tbody>
${entries.map(
	(entry) => html`<tr><td data-label="${t("bl.colSender")}"><code>${entry.value}</code></td><td data-label="${t("bl.colType")}">${t(entry.kind === "domain" ? "bl.domain" : "bl.address")}</td>
<td data-label="${t("bl.colHits")}">${entry.hits}</td><td data-label="${t("bl.colAdded")}">${when(entry.created_at, t.locale)}</td>
<td data-label=""><form class="inline" method="post" action="/blocklist/${encodeURIComponent(entry.id)}/delete"><button>${t("bl.unblock")}</button></form></td></tr>`,
)}
</tbody></table>`}
</section>
</main>`,
		{ t, nav: true, current: "/blocklist", path: "/blocklist" },
	);
}

export function aliasPage(t: Translate, input: { alias: AliasRow; contacts: ContactRow[]; notice?: string }): Html {
	const { alias, contacts, notice } = input;
	const base = `/aliases/${encodeURIComponent(alias.address)}`;
	return page(
		alias.address,
		html`<main>
<p class="m0"><a href="/">${t("alias.back")}</a></p>
${noticeBox(notice)}
<section>
<h2 class="alias-cell"><code>${alias.address}</code>${copyButton(t, alias.address)}</h2>
<p class="help">${alias.mailbox_id ? html`${t("alias.mailbox")} <code>${alias.mailbox_id}</code> · ` : ""}${t(`mode.${alias.forward_mode}`)}</p>
<form method="post" action="${base}/note" data-autosave data-msg-failed="${t("link.error")}">
<label for="note">${t("alias.note")}</label>
<div class="row"><input id="note" name="note" type="text" value="${alias.note ?? ""}" maxlength="200" placeholder="${t("alias.notePlaceholder")}" /><noscript><button>${t("common.save")}</button></noscript></div>
</form>
<form method="post" action="${base}/contacts">
<label for="email">${t("alias.writeNew")}</label>
<div class="row"><input id="email" name="email" type="email" placeholder="someone@example.com" required /><button class="primary">${t("alias.create")}</button></div>
<p class="help">${t("alias.writeNewHelp", { alias: alias.address })}</p>
</form>
</section>
${importedHistory(t, alias)}
<section>
<h2>${t("alias.contacts")}</h2>
${contacts.length === 0
	? html`<p class="muted">${t("alias.noContacts")}</p>`
	: html`<table class="rt"><thead><tr><th>${t("alias.colContact")}</th><th>${t("alias.colReverse")}</th><th>${t("alias.colForwarded")}</th><th>${t("alias.colReplied")}</th><th></th></tr></thead><tbody>
${contacts.map(
	(contact) => html`<tr>
<td data-label="${t("alias.colContact")}"><span class="stack">${contact.name ? html`${contact.name}<br />` : ""}<code>${contact.email}</code></span></td>
<td data-label="${t("alias.colReverse")}"><code>${contactReverseAddress(contact)}</code></td>
<td data-label="${t("alias.colForwarded")}"><span class="stack">${contact.forward_count}<br /><span class="muted">${when(contact.last_forward_at, t.locale)}</span></span></td>
<td data-label="${t("alias.colReplied")}"><span class="stack">${contact.reply_count}<br /><span class="muted">${when(contact.last_reply_at, t.locale)}</span></span></td>
<td data-label=""><form class="inline" method="post" action="${base}/contacts/${contact.id}/block">
<button class="${contact.blocked ? "" : "danger"}">${contact.blocked ? t("alias.unblock") : t("alias.block")}</button></form></td>
</tr>`,
)}
</tbody></table>`}
</section>
</main>`,
		{ t, nav: true, current: "/", path: base },
	);
}

export function messagePage(t: Translate, title: string, body: Html): Html {
	return page(title, html`<main class="center"><section><h1>${title}</h1>${body}</section></main>`, { t });
}

export function apiKeysPage(
	t: Translate,
	input: { keys: ApiKeyRow[]; enabled: { simplelogin: boolean; addy: boolean }; origin: string; newKey?: string; notice?: string },
): Html {
	const { keys, enabled, origin, newKey, notice } = input;
	return page(
		t("keys.title"),
		html`<main>
${noticeBox(notice)}
${newKey
	? html`<section><h2>${t("keys.createdTitle")}</h2><p class="notice" role="status">${t("keys.created")}</p>
<p><input type="text" readonly value="${newKey}" aria-label="${t("keys.colKey")}" data-select spellcheck="false" class="mono" /></p></section>`
	: ""}
<section>
<h2>${t("keys.title")}</h2>
<p class="help">${t("keys.help")}</p>
${enabled.simplelogin || enabled.addy
	? html`<p>${t("keys.serverUrl")}: <code>${origin}</code></p>
<p class="muted">${enabled.simplelogin ? html`<span class="pill ok">SimpleLogin</span> ` : ""}${enabled.addy ? html`<span class="pill ok">addy.io</span>` : ""}</p>`
	: html`<p class="notice">${t("keys.off")} <a href="/settings#clients">${t("nav.settings")} →</a></p>`}
${keys.length
	? html`<table class="rt"><thead><tr><th>${t("keys.colName")}</th><th>${t("keys.colKey")}</th><th>${t("keys.colCreated")}</th><th>${t("keys.colUsed")}</th><th></th></tr></thead><tbody>
${keys.map(
	(key) => html`<tr><td data-label="${t("keys.colName")}">${key.name}</td><td data-label="${t("keys.colKey")}"><code>${key.prefix}…</code></td>
<td data-label="${t("keys.colCreated")}">${when(key.created_at, t.locale)}</td><td data-label="${t("keys.colUsed")}">${when(key.last_used_at, t.locale)}</td>
<td><form class="inline" method="post" action="/api-keys/${key.id}/delete"><button class="danger">${t("keys.revoke")}</button></form></td></tr>`,
)}
</tbody></table>`
	: html`<p class="muted">${t("keys.none")}</p>`}
</section>
<section>
<h2>${t("keys.add")}</h2>
<form method="post" action="/api-keys" class="row">
<input name="name" type="text" maxlength="60" placeholder="${t("keys.namePlaceholder")}" aria-label="${t("keys.name")}" required />
<button class="primary">${t("keys.create")}</button>
</form>
</section>
</main>`,
		{ t, nav: true, current: "/api-keys", path: "/api-keys" },
	);
}

export function importPage(
	t: Translate,
	input: { domains: string[]; result?: ImportResult; error?: string; source?: string },
): Html {
	const { domains, result, error, source } = input;
	const keyField = (id: string, help: MessageKey) => html`<label for="${id}-key">${t("imp.apiKey")}</label>
<input id="${id}-key" name="apiKey" type="password" autocomplete="off" spellcheck="false" required />
<p class="help">${t(help)}</p>`;
	const serverField = (id: string, value: string) => html`<details><summary>${t("imp.server")}</summary>
<input name="server" type="url" value="${value}" aria-label="${t("imp.server")}" />
<p class="help">${t("imp.serverHelp")}</p></details>`;
	const domainsField = html`<input type="hidden" name="domains" value="${domains.join(" ")}" data-domains />
${checkbox("destinations", false, t("imp.destinations"), t("imp.destinationsHelp"))}`;
	return page(
		t("imp.title"),
		html`<main>
${error ? html`<p class="notice bad" role="alert">${error}</p>` : ""}
${result
	? html`<section><h2>${t("imp.resultTitle", { source: source ?? "" })}</h2>
<p class="notice" role="status">${t("imp.done", { found: String(result.found), created: String(result.created), updated: String(result.updated) })}${result.contacts ? html` ${t("imp.doneContacts", { count: String(result.contacts) })}` : ""}</p>
${result.skippedDomains.length
	? html`<p>${t("imp.skipped")}</p><ul class="results">${result.skippedDomains.map(
			(item) => html`<li><code>${item.domain}</code> <span class="muted">${t("imp.count", { count: String(item.count) })}</span></li>`,
		)}</ul><p class="help">${t("imp.skippedHelp")}</p>`
	: ""}
${result.newDestinations.length
	? html`<p>${t("imp.newDestinations")}</p><ul class="results">${result.newDestinations.map((email) => html`<li><code>${email}</code></li>`)}</ul>`
	: ""}
<p><a href="/">${t("imp.viewAliases")} →</a></p></section>`
	: ""}
<section>
<h2>${t("imp.title")}</h2>
<p class="help">${t("imp.help")}</p>
<label for="imp-domains">${t("imp.domains")}</label>
<textarea id="imp-domains" rows="3" spellcheck="false" data-domains-source>${domains.join("\n")}</textarea>
<p class="help">${t("imp.domainsHelp")}</p>
</section>
<section>
<h2>${t("imp.fromSimplelogin")}</h2>
<form method="post" action="/import/simplelogin" data-import>
${keyField("sl", "imp.slKeyHelp")}
${checkbox("contacts", true, t("imp.contacts"), t("imp.contactsHelp"))}
${serverField("sl", "https://app.simplelogin.io")}${domainsField}
<p><button class="primary">${t("imp.button")}</button></p>
</form>
</section>
<section>
<h2>${t("imp.fromAddy")}</h2>
<form method="post" action="/import/addy" data-import>
${keyField("addy", "imp.addyKeyHelp")}${serverField("addy", "https://app.addy.io")}${domainsField}
<p><button class="primary">${t("imp.button")}</button></p>
</form>
</section>
<section>
<h2>${t("imp.fromCsv")}</h2>
<form method="post" action="/import/csv" enctype="multipart/form-data" data-import>
<label for="imp-file">${t("imp.file")}</label>
<input id="imp-file" name="file" type="file" accept=".csv,text/csv" required />
<p class="help">${t("imp.csvHelp")}</p>${domainsField}
<p><button class="primary">${t("imp.button")}</button></p>
</form>
</section>
</main>`,
		{ t, nav: true, current: "/import", path: "/import" },
	);
}

const IMPORT_SOURCE_NAMES: Record<string, string> = { simplelogin: "SimpleLogin", addy: "addy.io", csv: "CSV" };

/** What an imported alias brought from SimpleLogin or addy.io: counts, dates and other details. */
function importedHistory(t: Translate, alias: AliasRow): Html | string {
	if (!alias.imported_from) return "";
	let details: Record<string, unknown> = {};
	try {
		details = alias.imported_details ? (JSON.parse(alias.imported_details) as Record<string, unknown>) : {};
	} catch {
		// Shown without details.
	}
	const list = (value: unknown) => (Array.isArray(value) ? value.map(String).join(", ") : "");
	const latest = details.latest_activity as { action?: string; at?: number; contact?: string; contact_name?: string } | undefined;
	const rows: [MessageKey, number, number | null][] = [
		["hist.forwarded", alias.imported_forwarded, alias.imported_last_forward_at],
		["hist.blocked", alias.imported_blocked, alias.imported_last_block_at],
		["hist.replied", alias.imported_replied, alias.imported_last_reply_at],
		["hist.sent", alias.imported_sent, alias.imported_last_sent_at],
	];
	const extra: [MessageKey, string][] = [
		["hist.mailboxes", list(details.mailboxes ?? details.recipients)],
		["hist.labels", list(details.labels)],
		["hist.pgp", typeof details.pgp === "string" ? details.pgp : ""],
		["hist.sourceId", details.id === undefined ? "" : String(details.id)],
	];
	const source = IMPORT_SOURCE_NAMES[alias.imported_from] ?? alias.imported_from;
	return html`<section>
<h2>${t("hist.title")}</h2>
<p class="help">${t("hist.from", { source, date: when(alias.imported_at, t.locale) })}${alias.imported_from === "csv" ? "" : html` ${t("hist.help", { source })}`}</p>
<p>${t("hist.created")}: ${when(alias.created_at, t.locale)}</p>
<table class="rt"><thead><tr><th></th><th>${t("hist.colCount")}</th><th>${t("hist.colLast")}</th></tr></thead><tbody>
${rows.map(([key, total, last]) => html`<tr><th scope="row">${t(key)}</th><td data-label="${t("hist.colCount")}">${total}</td><td data-label="${t("hist.colLast")}">${when(last, t.locale)}</td></tr>`)}
</tbody></table>
${latest?.action
	? html`<p>${t("hist.latest")}: ${latest.action}${latest.contact ? html` · ${latest.contact_name ? `${latest.contact_name} ` : ""}<code>${latest.contact}</code>` : ""} · ${when(latest.at ?? null, t.locale)}</p>`
	: ""}
${extra.filter(([, value]) => value).map(([key, value]) => html`<p>${t(key)}: <code>${value}</code></p>`)}
</section>`;
}
