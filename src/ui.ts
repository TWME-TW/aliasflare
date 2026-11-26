import { LABEL_COLOURS, MAX_LABEL_NAME, nearestColour, type LabelRow, type LabelWithCount } from "./labels";
import { ACTION_TYPES, CONDITION_TYPES, MATCHES, MAX_RULE_NAME, type Action, type Condition, type Rule } from "./rules";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { AliasRow, BlocklistRow, ContactRow } from "./db";
import { FORWARD_MODES } from "./db";
import { contactReverseAddress, reverseDomainFor } from "./domains";
import { MAX_NOTE_LENGTH, SENDER_FORMATS } from "./format";
import { LOCALE_LIST, LOCALE_NAMES, textDirection, THEMES, type MessageKey, type Theme, type Translate } from "./i18n";
import type { ApiKeyRow } from "./apikeys";
import type { DomainSetup } from "./cloudflare";
import type { ImportResult } from "./importer";
import type { PasskeyRow } from "./passkeys";
import type { SessionRow } from "./sessions";
import { FORWARD_METHODS, RANDOM_ALIAS_FORMATS, UNSUBSCRIBE_BEHAVIORS, UNSUBSCRIBE_FALLBACKS, type Settings } from "./settings";
import { APP_SCRIPT, PASSKEY_SCRIPT } from "./client";
import { OUTBOUND_PROVIDERS, type OutboundOptions, type OutboundProvider } from "./outbound";
import { WORKERS_PLANS, type WorkersPlan } from "./config";

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;
export type Notice = string | { text: string; bad?: boolean };

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
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"] { color-scheme: dark;
	--bg:#202124; --card:#292a2d; --text:#e8eaed; --muted:#9aa0a6; --line:#3c4043; --soft:#303134; --hover:#35363a;
	--primary:#8ab4f8; --primary-text:#202124; --primary-hover:#aecbfa; --nav-active:#004a77; --nav-active-text:#c2e7ff;
	--danger:#f2b8b5; --danger-soft:#3c1f1e; --ok:#81c995; --ok-soft:#1e3324; --warn-soft:#3a3220; --focus:rgba(138,180,248,.3); }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
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
.shell { display:grid; grid-template-columns:248px minmax(0,1fr); gap:8px; padding-block:0 16px; padding-inline:8px 16px; align-items:start; }
.sidebar { position:sticky; top:8px; display:flex; flex-direction:column; gap:2px; padding:4px 0; }
.sidebar a { display:flex; align-items:center; gap:14px; height:44px; padding:0 18px; border-radius:999px; color:var(--text); font-weight:500; transition:background-color .15s, color .15s; }
.sidebar a:hover { background:var(--hover); text-decoration:none; }
.sidebar a[aria-current] { background:var(--nav-active); color:var(--nav-active-text); font-weight:600; }
.content { display:grid; gap:12px; min-width:0; }
.content > main, form.sections { display:grid; gap:12px; }
main.single, main.center { max-width:520px; margin:6vh auto 0; padding:0 16px; display:grid; gap:12px; }

section { background:var(--card); border-radius:var(--radius); padding:22px 26px; min-width:0; }
h1 { font-size:22px; font-weight:500; margin:0 0 8px; }
h2 { font-size:17px; font-weight:600; margin:0 0 12px; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
h2 code { font-size:.9em; }
p { margin:8px 0; }
p.help, .muted { color:var(--muted); font-size:13px; margin:4px 0 0; }
span.help { display:block; color:var(--muted); font-size:13px; margin:4px 0 0; font-weight:400; }
code { font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; background:var(--soft); padding:1px 6px; border-radius:6px; word-break:break-all; direction:ltr; unicode-bidi:isolate; }

/* Tables */
.table-wrap { overflow-x:auto; max-width:100%; }
table { width:100%; border-collapse:collapse; font-size:14px; }
th, td { text-align:start; padding:12px 10px; border-bottom:1px solid var(--line); vertical-align:middle; }
tbody tr:last-child td { border-bottom:none; }
tbody tr:hover { background:var(--soft); }
th { color:var(--muted); font-weight:500; font-size:13px; }

/* Forms */
label { display:block; font-weight:500; margin:18px 0 6px; }
input[type=text], input[type=email], input[type=password], input[type=url], input[type=search], input[type=number], textarea, select {
	width:100%; max-width:480px; min-height:44px; padding:10px 14px; border:1px solid var(--line); border-radius:12px;
	background:var(--card); color:inherit; font:inherit; transition:border-color .15s, box-shadow .15s, opacity .15s; }
textarea { resize:vertical; line-height:1.45; }
input[type=email], input[type=url] { direction:ltr; unicode-bidi:isolate; text-align:start; }
input[type=file] { width:100%; max-width:480px; padding:8px 12px; border:1px solid var(--line); border-radius:12px; background:var(--card); color:inherit; font:inherit; cursor:pointer; }
input[type=file]::file-selector-button { margin-inline-end:12px; min-height:32px; padding:0 14px; border-radius:999px; border:1px solid var(--line); background:var(--soft); color:var(--primary); font:inherit; font-weight:500; cursor:pointer; }
input:focus, textarea:focus, select:focus, button:focus-visible, a:focus-visible, summary:focus-visible { outline:none; border-color:var(--primary); box-shadow:0 0 0 3px var(--focus); }
td input[type=text], td input[type=email], td select { max-width:240px; min-height:36px; padding:6px 12px; border-radius:10px; }
.check { display:flex; gap:12px; align-items:flex-start; margin-top:18px; font-weight:500; }
.check input { margin-top:3px; width:18px; height:18px; flex:none; accent-color:var(--primary); }
fieldset { border:0; padding:0; margin:18px 0 0; min-width:0; }
legend { font-weight:600; padding:0; }
button { display:inline-flex; align-items:center; justify-content:center; gap:8px; min-height:40px; padding:0 20px; border-radius:999px;
	border:1px solid var(--line); background:var(--card); color:var(--primary); font:inherit; font-weight:500; cursor:pointer; white-space:nowrap;
	transition:background-color .15s, border-color .15s, color .15s, box-shadow .15s, opacity .15s; }
button:hover:not(:disabled) { background:var(--soft); }
button.primary { background:var(--primary); border-color:var(--primary); color:var(--primary-text); }
button.primary:hover:not(:disabled) { background:var(--primary-hover); border-color:var(--primary-hover); }
button.danger { color:var(--danger); } button.danger:hover:not(:disabled) { background:var(--danger-soft); }
button.ghost { border-color:transparent; color:var(--muted); } button.ghost:hover:not(:disabled) { background:var(--hover); color:var(--text); }
button:disabled { opacity:.55; cursor:not-allowed; }
button[aria-busy="true"] { cursor:wait; }
@media (prefers-reduced-motion: no-preference) {
	button:active:not(:disabled), .pager a.pg:active { transform:scale(.98); }
}
td button { min-height:34px; padding:0 14px; font-size:14px; }
form.inline { display:inline; margin:0; }
.row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.row input, .row select, .row textarea { flex:1 1 180px; }
form.row textarea { flex:1 1 240px; width:auto; }

/* Chips and messages */
.pill { display:inline-flex; align-items:center; padding:2px 10px; border-radius:999px; font-size:12px; font-weight:500; white-space:nowrap; background:var(--soft); color:var(--muted); }
/* Label chips: a soft tint of the label's colour, its text a deeper (or, when dark, lighter) shade of it. */
:root { --lab-ink:#111827; --lab-ink-amount:45%; --lab-tint:14%; --lab-edge:30%; }
:root[data-theme="dark"] { --lab-ink:#ffffff; --lab-ink-amount:55%; --lab-tint:24%; --lab-edge:40%; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --lab-ink:#ffffff; --lab-ink-amount:55%; --lab-tint:24%; --lab-edge:40%; } }
.label-chip { --lc:#64748b; display:inline-flex; align-items:center; gap:6px; padding:1px 10px 1px 8px; border-radius:999px; font-size:12px; font-weight:600; line-height:20px; letter-spacing:.01em; text-decoration:none; white-space:nowrap;
	color:color-mix(in oklab, var(--lc), var(--lab-ink) var(--lab-ink-amount));
	background:color-mix(in oklab, var(--lc) var(--lab-tint), var(--card));
	border:1px solid color-mix(in oklab, var(--lc) var(--lab-edge), transparent); }
.label-chip::before { content:""; width:7px; height:7px; border-radius:50%; background:var(--lc); flex:none; }
a.label-chip:hover { background:color-mix(in oklab, var(--lc) calc(var(--lab-tint) + 8%), var(--card)); }
${LABEL_COLOURS.map((colour) => `[data-colour="${colour}"] { --lc:${colour}; }`).join("\n")}
.swatches { display:flex; flex-wrap:wrap; gap:2px; border:none; margin:0; padding:0; }
/* The colour button sits in its row like the inputs beside it; the palette opens over the page below it. */
.colour-pick { position:relative; display:inline-flex; margin:0; }
.colour-pick > summary { display:inline-flex; align-items:center; gap:6px; min-height:40px; padding:0 10px; border:1px solid var(--line); border-radius:999px; background:var(--card); color:var(--text); font-weight:400; cursor:pointer; list-style:none; }
.colour-pick > summary::-webkit-details-marker { display:none; }
.colour-pick > summary::after { content:"▾"; color:var(--muted); font-size:12px; }
.colour-pick > summary:hover { background:var(--hover); }
.colour-pick .dot { width:20px; height:20px; border-radius:50%; background:var(--lc, #64748b); box-shadow:inset 0 0 0 1px rgb(0 0 0 / .08); }
.colour-pick > .swatches { position:absolute; z-index:20; inset-inline-start:0; top:calc(100% + 6px); display:grid; grid-template-columns:repeat(6, auto); gap:2px; width:max-content; padding:6px; border:1px solid var(--line); border-radius:12px; background:var(--card); box-shadow:0 12px 32px rgb(0 0 0 / .18); }
.colour-pick[open] > summary::after { content:"▴"; }
/* With script, the palette is placed against the window (see client.ts), so no scroll box cuts it off. */
.colour-pick > .swatches.floating { position:fixed; inset:auto; }
.swatch { position:relative; display:inline-flex; margin:0; padding:3px; cursor:pointer; }
.swatch input { position:absolute; opacity:0; width:1px; height:1px; }
.swatch span { width:24px; height:24px; border-radius:50%; background:var(--lc, #64748b); box-shadow:inset 0 0 0 1px rgb(0 0 0 / .08); transition:transform .1s; }
.swatch:hover span { transform:scale(1.12); }
.swatch input:checked + span { box-shadow:0 0 0 2px var(--card), 0 0 0 4px var(--lc, #64748b); }
.swatch input:focus-visible + span { outline:2px solid var(--primary); outline-offset:4px; }
.label-new { display:flex; flex-wrap:wrap; gap:10px 12px; align-items:center; }
.label-new input[type=text] { flex:1 1 14rem; }
.label-edit { display:flex; flex-wrap:wrap; gap:8px 12px; align-items:center; }
.label-edit input[type=text] { flex:0 1 13rem; min-width:9rem; }
.labels-row { display:inline-flex; flex-wrap:wrap; gap:4px; margin-inline-start:6px; vertical-align:middle; }
.label-picks { display:flex; flex-wrap:wrap; gap:8px 18px; margin:8px 0; }
/* The batch bar's label picker: a drop-down list of every label that scrolls, however many there are. */
.label-menu { position:relative; margin:0; }
.label-menu > summary { display:flex; align-items:center; gap:8px; min-height:44px; padding:0 14px; border:1px solid var(--line); border-radius:12px; background:var(--card); color:var(--text); font-weight:400; cursor:pointer; list-style:none; white-space:nowrap; }
.label-menu > summary::-webkit-details-marker { display:none; }
.label-menu > summary::after { content:"▾"; color:var(--muted); }
.label-menu-list { position:absolute; z-index:20; inset-inline-start:0; top:calc(100% + 6px); display:grid; gap:2px; width:max-content; min-width:240px; max-width:min(360px, 90vw); max-height:300px; overflow:auto; padding:8px; border:1px solid var(--line); border-radius:12px; background:var(--card); box-shadow:0 12px 32px rgb(0 0 0 / .18); }
.label-menu-list input[type=search] { position:sticky; top:-8px; margin:-8px -8px 6px; width:calc(100% + 16px); max-width:none; border-radius:12px 12px 0 0; }
.label-menu-list label { display:flex; align-items:center; gap:10px; min-height:40px; margin:0; padding:0 8px; border-radius:8px; font-weight:400; cursor:pointer; }
.label-menu-list label[hidden] { display:none; }
.label-menu-list label:hover { background:var(--hover); }
.label-menu-list label.all { font-weight:500; border-bottom:1px solid var(--line); border-radius:8px 8px 0 0; margin-bottom:2px; }
@media (max-width: 720px) { .colour-pick > .swatches { inset-inline-start:auto; inset-inline-end:0; } .label-menu { flex:1 1 100%; } .label-menu-list { position:static; width:auto; max-width:none; margin-top:6px; box-shadow:none; } }
.label-picks label { display:inline-flex; align-items:center; gap:6px; font-weight:400; }
.rule-rows { display:grid; gap:10px; margin:10px 0; counter-reset:rule-row; }
/* Each condition or action is one card: what to look at and how, side by side, then the values. */
.rule-row { display:grid; grid-template-columns:auto minmax(0,1fr) minmax(0,1fr) minmax(0,1.6fr); gap:8px; align-items:start; padding:10px 12px; border:1px solid var(--line); border-radius:16px; background:var(--bg); transition:opacity .15s; }
.rule-row.act { grid-template-columns:auto minmax(0,1fr) minmax(0,1.6fr); }
.rule-row::before { counter-increment:rule-row; content:counter(rule-row); display:inline-flex; align-items:center; justify-content:center; width:26px; height:26px; margin-top:9px; border-radius:50%; background:var(--soft); color:var(--muted); font-size:12px; font-weight:600; }
.rule-row select, .rule-row input, .rule-row textarea { max-width:none; width:100%; }
.rule-row textarea { min-height:44px; resize:vertical; }
.rule-row:has(textarea:placeholder-shown), .rule-row.act:has(select[data-act-type] option[value=""]:checked) { opacity:.6; }
.rule-row:focus-within { opacity:1; border-color:var(--primary); }
@media (max-width: 720px) {
	.rule-row { grid-template-columns:auto minmax(0,1fr) minmax(0,1fr); }
	.rule-row > textarea { grid-column:2 / -1; }
	.rule-row.act { grid-template-columns:auto minmax(0,1fr); }
	.rule-row.act > input { grid-column:2; }
}
.pill.ok { background:var(--ok-soft); color:var(--ok); } .device { display:inline-flex; flex-wrap:wrap; align-items:center; justify-content:flex-end; gap:4px 8px; white-space:nowrap; } .pill.bad { background:var(--danger-soft); color:var(--danger); }
.alias-cell { display:inline-flex; align-items:center; gap:2px; flex-wrap:wrap; }
button.copy { min-height:28px; min-width:28px; padding:0 6px; }
button.copy .check-i { display:none; }
button.copy[data-copied] { color:var(--ok); }
button.copy[data-copied] .copy-i { display:none; }
button.copy[data-copied] .check-i { display:block; }
.perms { list-style:none; padding:0; margin:10px 0 0; display:grid; gap:6px; }
.perms li { display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:14px; }
.pill.scope { background:var(--nav-active); color:var(--nav-active-text); }
.pill.scope.account { background:var(--warn-soft); color:var(--text); }
.perm-name { font-weight:600; color:var(--text); }
.perm-level { font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; padding:1px 8px; border-radius:6px; background:var(--ok-soft); color:var(--ok); }
.notice { padding:12px 18px; border-radius:16px; margin:0; background:var(--nav-active); color:var(--nav-active-text); }
.notice.bad { background:#fce8e6; color:#b3261e; }
:root[data-theme="dark"] .notice.bad { background:#601410; color:#f2b8b5; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .notice.bad { background:#601410; color:#f2b8b5; } }
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
.sidebar .powered a { display:inline; height:auto; padding:0; border-radius:0; color:inherit; font-weight:400; text-decoration:underline; }
.sidebar .powered a:hover { background:none; }

@media (max-width: 900px) {
	.topbar { padding:8px 14px; min-height:56px; }
	.brand { font-size:18px; }
	.shell { display:block; padding:0 10px 16px; }
	.sidebar { position:static; flex-direction:row; overflow-x:auto; overscroll-behavior-x:contain; gap:6px; padding:0 4px 10px; scrollbar-width:none; }
	.sidebar::-webkit-scrollbar { display:none; }
	.sidebar a { flex:none; height:38px; padding:0 14px; gap:8px; background:var(--card); font-size:14px; }
	.sidebar .lang, .sidebar .powered { display:none; }
	.mobile-only { display:flex !important; }
	section { padding:18px; border-radius:20px; }
	main.single, main.center { margin-top:3vh; }
	input[type=text], input[type=email], input[type=password], input[type=url], input[type=search], input[type=number], textarea, select { max-width:none; font-size:16px; }
	table.rt thead { display:none; }
	table.rt, table.rt tbody, table.rt tr, table.rt td { display:block; width:100%; }
	table.rt tr { border:1px solid var(--line); border-radius:16px; margin:10px 0; padding:4px 14px; }
	table.rt tbody tr:hover { background:none; }
	table.rt td, table.rt td:first-child, table.rt td:last-child { display:flex; gap:12px; align-items:center; justify-content:space-between; border:none; padding:8px 0; text-align:end; }
	table.rt td + td { border-top:1px solid var(--line); }
	table.rt td::before { content:attr(data-label); color:var(--muted); font-size:12px; text-align:start; flex:0 0 32%; }
	table.rt td:empty { display:none; }
	table.rt td > form.row, table.rt td > form.label-edit, table.rt td > .stack { flex:1; justify-content:flex-end; }
	td input[type=text], td input[type=email], td select { max-width:none; font-size:16px; }
	table.rt.compact tr { display:grid; gap:6px 10px; margin:6px 0; padding:10px 12px; border-radius:14px; }
	table.rt.compact td, table.rt.compact td:first-child, table.rt.compact td:last-child { display:block; padding:0; border:none; text-align:start; min-width:0; }
	table.rt.compact td::before { content:none; }
	table.rt.aliases tr { grid-template-columns:auto minmax(0,1fr) auto; align-items:center; }
	table.rt.aliases td.pick { grid-row:1; grid-column:1; width:auto; }
	table.rt.aliases td.c-alias { grid-row:1; grid-column:2; }
	table.rt.aliases .alias-cell { display:flex; flex-wrap:nowrap; min-width:0; }
	table.rt.aliases .alias-cell code { overflow-wrap:anywhere; white-space:normal; }
	table.rt.aliases td.c-used { grid-row:1; grid-column:3; color:var(--muted); font-size:12px; white-space:nowrap; }
	table.rt.aliases td.c-note { grid-row:2; grid-column:1 / -1; }
	table.rt.aliases td.c-mode { grid-row:3; grid-column:1 / -1; }
	table.rt.aliases td.c-mode select { flex:1; width:100%; }
	table.rt.aliases td.c-note input, table.rt.aliases td.c-mode select { min-height:40px; padding-top:6px; padding-bottom:6px; }
	table.rt.aliases td.c-dest, table.rt.aliases td.c-count, table.rt.aliases td.c-created { display:none; }
	table.rt.activity tr { grid-template-columns:5.25rem minmax(0,1fr) auto; align-items:center; gap:4px 8px; padding:8px 12px; }
	table.rt.activity td.a-what { grid-row:1; grid-column:1; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
	table.rt.activity td.a-alias { grid-row:1; grid-column:2; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
	table.rt.activity td.a-when { grid-row:1; grid-column:3; color:var(--muted); font-size:12px; white-space:nowrap; }
	table.rt.activity td.a-status { grid-row:2; grid-column:1; }
	table.rt.activity td.a-detail { grid-row:2; grid-column:2 / -1; font-size:13px; white-space:normal; overflow-wrap:anywhere; }
	table.rt.activity td.a-detail:empty { display:block; }
}
.mobile-only { display:none; }
.toolbar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:12px 0; }
.toolbar input[type=search], .toolbar input[type=text] { flex:1 1 240px; width:auto; max-width:none; min-height:44px; }
.toolbar select { width:auto; min-height:44px; }
.toolbar button { min-height:44px; }
.bulk { padding:10px 12px; border-radius:16px; background:var(--bg); }
.bulk[data-empty] button.primary { opacity:.6; }
.create { margin:12px 0; padding:14px 16px; border-radius:16px; background:var(--bg); }
.create h2 { margin:0; }
/* An address breaks before its @ when it must, not in the middle of a word. */
code.addr { word-break:normal; overflow-wrap:anywhere; }
.alias-cell.keep { flex-wrap:nowrap; align-items:flex-start; } .alias-cell.keep code { min-width:0; }
.stack time { white-space:nowrap; font-size:12px; }
.create-random { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.create-extra { display:grid; gap:12px; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); align-items:end; }
.create-extra label { display:flex; flex-direction:column; gap:6px; margin:0; }
.create-extra input { max-width:none; }
.create-form { display:grid; gap:10px; margin-top:10px; }
.create-address { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.create-address input { flex:1 1 200px; width:auto; }
.create-address select { width:auto; }
.create-form .check { margin-top:0; }
.create-address button { flex:none; }
th.pick, td.pick { width:36px; }
td.pick input, th.pick input { width:18px; height:18px; accent-color:var(--primary); }
/* Pagers above and below a list: big buttons that keep their place, so they can be clicked again and again. */
.pager { display:flex; gap:12px; justify-content:center; align-items:center; margin:12px 0; }
.pager .pg { display:inline-flex; align-items:center; justify-content:center; gap:6px; min-width:8.5rem; min-height:44px; padding:0 20px; border:1px solid var(--line); border-radius:999px; background:var(--card); color:var(--primary); font-weight:600; text-decoration:none; user-select:none; touch-action:manipulation; transition:background-color .15s, border-color .15s; }
.pager a.pg:hover { background:var(--hover); text-decoration:none; }
.pager .pg[aria-disabled] { color:var(--muted); opacity:.45; }
.pager .at { min-width:5.5rem; text-align:center; font-variant-numeric:tabular-nums; color:var(--muted); }
@media (max-width: 720px) { .pager { gap:8px; } .pager .pg { min-width:0; flex:1; padding:0 12px; } }
form.note input { width:100%; min-width:12ch; }
form.inline-save { display:flex; gap:6px; align-items:center; }
form.inline-save input, form.inline-save select { width:100%; min-width:12ch; }
form[data-saving] input, form[data-saving] select { border-color:var(--primary); opacity:.75; }
table.aliases tbody tr:has(input[data-pick]:checked) { background:var(--soft); }
table.aliases tbody tr[data-mode="none"] td.c-alias code { opacity:.65; }
table.aliases tbody tr[data-deleted] { opacity:.78; }
table.aliases td.c-alias code { white-space:nowrap; }
table.aliases .alias-cell { flex-wrap:nowrap; }
table.aliases td.c-used, table.aliases td.c-created { white-space:nowrap; }
@media (min-width: 901px) and (max-width: 1400px) { table.aliases .c-created { display:none; } }
table.aliases td.c-mode select { width:auto; min-width:0; }
.toast { position:fixed; inset-inline:0; bottom:24px; margin:0 auto; width:max-content; max-width:calc(100vw - 32px); z-index:10;
	padding:12px 20px; border-radius:12px; background:#323232; color:#fff; font-size:14px; box-shadow:0 4px 16px rgba(0,0,0,.25); }
@media (prefers-reduced-motion: no-preference) {
	@keyframes toast-in { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }
	.toast:not([hidden]) { animation:toast-in .18s ease-out; }
}
.toast.bad { background:var(--danger); color:#fff; }
:root[data-theme="dark"] .toast { background:#e8eaed; color:#202124; }
:root[data-theme="dark"] .toast.bad { background:#f2b8b5; color:#601410; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .toast { background:#e8eaed; color:#202124; } :root:not([data-theme="light"]) .toast.bad { background:#f2b8b5; color:#601410; } }
.theme-btn { padding:0 12px; }
@media (max-width: 600px) { .theme-btn .theme-text { display:none; } }
[dir="rtl"] .arrow { display:inline-block; transform:scaleX(-1); }

/* Moving between pages: the menu marks the page at once (see the page script). Only when the next
   page has not arrived after a moment does a thin bar sweep along the top; it shows activity, not
   a share done, so it never seems to stop part way. */
html[data-navigating] body::before { content:""; position:fixed; top:0; left:0; width:30%; height:3px; z-index:50; border-radius:0 3px 3px 0; background:color-mix(in oklab, var(--primary) 35%, var(--bg)); opacity:0; animation:nav-sweep 1.1s ease-in-out .3s infinite, nav-show 0s .3s forwards; }
@keyframes nav-sweep { from { transform:translateX(-100%); } to { transform:translateX(340%); } }
@keyframes nav-show { to { opacity:1; } }
@media (prefers-reduced-motion: reduce) { html[data-navigating] body::before { width:100%; animation:nav-show 0s .3s forwards; } }

.lang-label { margin:0; display:flex; }
.sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
.mt12 { margin-top:12px; }
/* The settings page's sections, one tap away; it stays at the top while the page scrolls. */
.jump { position:sticky; top:0; z-index:5; display:flex; gap:8px; overflow-x:auto; scrollbar-width:none; padding:8px 0; background:var(--bg); }
.jump::-webkit-scrollbar { display:none; }
.jump a { flex:none; display:inline-flex; align-items:center; min-height:36px; padding:0 14px; border-radius:999px; background:var(--card); border:1px solid var(--line); color:var(--text); font-size:14px; font-weight:500; white-space:nowrap; }
.jump a:hover { background:var(--hover); text-decoration:none; }
.jump a[aria-current] { background:var(--nav-active); border-color:transparent; color:var(--nav-active-text); }
section[id] { scroll-margin-top:64px; }
.m0 { margin:0; }
.mono { font-family:ui-monospace,monospace; direction:ltr; unicode-bidi:isolate; }
`);
/** A short hash of a file's content: its URL changes whenever the file does. */
function contentVersion(text: string): string {
	let hash = 0;
	for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) | 0;
	return (hash >>> 0).toString(36);
}

/**
 * Versions in the asset URLs. A versioned URL never changes content, so browsers may keep it
 * for a year and fetch nothing on later page loads; a deploy that changes a file changes its URL.
 */
export const STYLE_VERSION = contentVersion(String(STYLE));
export const APP_SCRIPT_VERSION = contentVersion(APP_SCRIPT);
export const PASSKEY_SCRIPT_VERSION = contentVersion(PASSKEY_SCRIPT);


/** Lucide icons (ISC license), inlined so the page needs no extra requests. */
const ICONS = {
	aliases: `<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>`,
	blocklist: `<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>`,
	labels: `<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>`,
	rules: `<path d="M3 4h18l-7 8v6l-4 2v-8z"/>`,
	settings: `<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4"/>`,
	connection: `<path d="M12 22v-5M9 8V2M15 8V2M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>`,
	passkeys: `<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5"/>`,
	apiKeys: `<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>`,
	activity: `<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>`,
	import: `<path d="M12 3v12"/><path d="m8 11 4 4 4-4"/><path d="M8 5H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-4"/>`,
	signOut: `<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>`,
	globe: `<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20"/>`,
	sun: `<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2m-7.07-15.07 1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>`,
	moon: `<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>`,
	monitor: `<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8M12 17v4"/>`,
} as const;

function icon(name: keyof typeof ICONS): Html {
	return html`<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${raw(ICONS[name])}</svg>`;
}

/** The app mark: an envelope with a return arrow, in Mailflare's blue. */
const LOGO = raw(`<svg viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="lg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6aa5ff"/><stop offset="1" stop-color="#1a63e0"/></linearGradient></defs><rect x="3" y="7" width="26" height="19" rx="4" fill="url(#lg)"/><path d="M4.5 9.5 16 18l11.5-8.5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity=".95"/><circle cx="25" cy="23" r="6" fill="#fff"/><path d="M27.5 23h-5m2-2.2L22.3 23l2.2 2.2" fill="none" stroke="#1a63e0" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`);

const COPY_ICON = raw('<svg class="copy-i" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg><svg class="check-i" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>');

/** An address in code type that may break before its @ but not inside a word. */
function addressCode(address: string): Html {
	const at = address.lastIndexOf("@");
	return at > 0 ? html`<code class="addr">${address.slice(0, at)}<wbr />${address.slice(at)}</code>` : html`<code class="addr">${address}</code>`;
}

/** Copies the value to the clipboard. Hidden until the page script shows it, since it needs script. */
function copyButton(t: Translate, value: string): Html {
	return html`<button type="button" class="ghost copy" data-copy="${value}" data-msg-copied="${t("common.copied", { value })}" title="${t("common.copy")}" aria-label="${t("common.copy")}: ${value}" hidden>${COPY_ICON}</button>`;
}

export type PageOptions = { t: Translate; nav?: boolean; script?: boolean; current?: string; path?: string };

function languageMenu(t: Translate, path = "/", extraClass = ""): Html {
	return html`<form class="lang ${extraClass}" method="post" action="/lang">
<label for="lang-${extraClass || "main"}" class="lang-label">${icon("globe")}<span class="sr">${t("nav.language")}</span></label>
<input type="hidden" name="next" value="${path}" />
<select id="lang-${extraClass || "main"}" name="locale" data-autosubmit>
${LOCALE_LIST.map((locale) => html`<option value="${locale}" lang="${locale}" ${locale === t.locale ? "selected" : ""}>${LOCALE_NAMES[locale]}</option>`)}
</select>
<noscript><button type="submit">${t("lang.apply")}</button></noscript>
</form>`;
}

function themeToggle(t: Translate, path = "/"): Html {
	const current: Theme = t.theme ?? "system";
	const next: Theme = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length]!;
	const iconName = current === "dark" ? "moon" : current === "light" ? "sun" : "monitor";
	const label = t(`theme.${current}`);
	const full = `${t("theme.label")}: ${label}`;
	return html`<form class="inline" method="post" action="/theme" data-theme-toggle>
<input type="hidden" name="theme" value="${next}" />
<input type="hidden" name="next" value="${path}" />
<button class="ghost theme-btn" title="${full}" aria-label="${full}" data-label-prefix="${t("theme.label")}" data-label-system="${t("theme.system")}" data-label-light="${t("theme.light")}" data-label-dark="${t("theme.dark")}">${icon(iconName)}<span class="theme-text">${label}</span></button>
</form>`;
}

export function page(title: string, body: Html, options: PageOptions): Html {
	const { t } = options;
	const theme: Theme = t.theme ?? "system";
	const link = (href: string, key: MessageKey, name: keyof typeof ICONS) =>
		html`<a href="${href}" ${options.current === href ? html`aria-current="page"` : ""}>${icon(name)}<span>${t(key)}</span></a>`;
	const brand = html`<a class="brand" href="/">${LOGO}<span>aliasflare</span></a>`;
	const themeMeta =
		theme === "light"
			? html`<meta name="theme-color" content="#f6f8fc" />`
			: theme === "dark"
				? html`<meta name="theme-color" content="#202124" />`
				: html`<meta name="theme-color" content="#f6f8fc" media="(prefers-color-scheme: light)" />
<meta name="theme-color" content="#202124" media="(prefers-color-scheme: dark)" />`;
	return html`<!doctype html>
<html lang="${t.locale}" dir="${textDirection(t.locale)}"${theme !== "system" ? html` data-theme="${theme}"` : ""}>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex" />
${themeMeta}
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="manifest" href="/manifest.webmanifest" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<title>${title} · aliasflare</title>
<link rel="stylesheet" href="/assets/app.css?v=${STYLE_VERSION}" />
<link rel="expect" href="#page-end" blocking="render" />
</head>
<body>
${options.nav
	? html`<header class="topbar">${brand}<span class="spacer"></span>
${themeToggle(t, options.path)}
<form class="inline" method="post" action="/logout"><button class="ghost" title="${t("nav.signOut")}">${icon("signOut")}<span>${t("nav.signOut")}</span></button></form></header>
<div class="shell">
<nav class="sidebar" aria-label="aliasflare">
${link("/", "nav.aliases", "aliases")}${link("/activity", "nav.activity", "activity")}${link("/import", "nav.import", "import")}${link("/blocklist", "nav.blocklist", "blocklist")}${link("/labels", "nav.labels", "labels")}${link("/rules", "nav.rules", "rules")}${link("/settings", "nav.settings", "settings")}${link("/connection", "nav.connection", "connection")}${link("/passkeys", "nav.passkeys", "passkeys")}${link("/api-keys", "nav.apiKeys", "apiKeys")}
<p class="powered">aliasflare · <a href="https://github.com/TWME-TW/aliasflare">GitHub</a></p>
</nav>
<div class="content">${body}</div>
<div class="toast" role="status" aria-live="polite" data-toast hidden></div>
</div>`
	: html`<header class="topbar">${brand}<span class="spacer"></span>${themeToggle(t, options.path)}</header>${body}<footer class="page">${languageMenu(t, options.path)}</footer>`}
<script src="/assets/app.js?v=${APP_SCRIPT_VERSION}"></script>
${options.script ? html`<script src="/assets/passkey.js?v=${PASSKEY_SCRIPT_VERSION}"></script>` : ""}
<!-- The first paint waits for this mark (rel=expect above), so the page script has already put the
     page in place (a pager where it was, local times, copy buttons): nothing jumps once shown. -->
<span id="page-end" hidden></span>
</body>
</html>`;
}

/** Served at /favicon.svg. */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="lg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6aa5ff"/><stop offset="1" stop-color="#1a63e0"/></linearGradient></defs><rect x="3" y="7" width="26" height="19" rx="4" fill="url(#lg)"/><path d="M4.5 9.5 16 18l11.5-8.5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="25" cy="23" r="6" fill="#fff"/><path d="M27.5 23h-5m2-2.2L22.3 23l2.2 2.2" fill="none" stroke="#1a63e0" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;


function errorBox(t: Translate): Html {
	return html`<p class="error" role="alert" data-error hidden></p><span hidden data-msg-unsupported="${t("passkey.unsupported")}" data-msg-cancelled="${t("passkey.cancelled")}"></span>`;
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

export function setupPage(t: Translate, input: { codeInLogs: boolean; notice?: Notice }): Html {
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
	return html`<label class="check"><input type="checkbox" name="${name}" value="1" ${checked ? "checked" : ""} /><span>${label}${help ? html`<span class="help">${help}</span>` : ""}</span></label>`;
}

function noticeBox(notice?: Notice): Html | string {
	if (!notice) return "";
	const text = typeof notice === "string" ? notice : notice.text;
	const bad = typeof notice === "object" && !!notice.bad;
	return text ? html`<p class="${bad ? "notice bad" : "notice"}" role="${bad ? "alert" : "status"}">${text}</p>` : "";
}

export type ActivityItem = { kind: string; status: string; alias: string | null; detail: string | null; at: number };

/** How long ago, like "3 hours ago", in the page's language. */
/** Whether a stored timestamp can be shown as a date (a broken import could store anything). */
const showable = (timestamp: number | null | undefined): timestamp is number =>
	typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0 && timestamp < 8.64e12;

function isoTime(timestamp: number | null | undefined): string {
	return showable(timestamp) ? new Date(timestamp * 1000).toISOString() : "";
}

function ago(timestamp: number, locale: string, now = Date.now() / 1000): string {
	if (!showable(timestamp)) return "—";
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
	if (!showable(timestamp)) return "—";
	return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(timestamp * 1000)) + " UTC";
}

function timeTag(timestamp: number | null, locale: string): Html | string {
	if (!showable(timestamp)) return "—";
	return html`<time datetime="${isoTime(timestamp)}">${when(timestamp, locale)}</time>`;
}

function translated(t: Translate, key: string, fallback: string): string {
	const value = t(key as MessageKey);
	return value === key ? fallback : value;
}

function statusPill(t: Translate, status: string): Html {
	const tone = status === "sent" || status === "done" ? "ok" : status === "failed" || status === "rejected" ? "bad" : "";
	return html`<span class="pill ${tone}">${translated(t, `status.${status}`, status)}</span>`;
}

/** Rows per page the alias and activity lists offer. */
export const ALIAS_PAGE_SIZES = [25, 50, 100, 200] as const;
export const DEFAULT_ALIAS_PAGE_SIZE = 100;
export const DEFAULT_ACTIVITY_PAGE_SIZE = 50;

export type AliasListState = { query: string; filter: "all" | "active" | "disabled" | "pinned" | "deleted"; label: string; page: number; perPage: number; total: number };

/** The "New alias" form above the alias list. */
function newAliasForm(t: Translate, settings: Settings): Html | string {
	if (settings.aliasDomains.length === 0) {
		return html`<p class="notice">${t("new.noDomains")} <a href="/settings">${t("dash.goToSettings")}</a></p>`;
	}
	// One form: the first button (the one Enter presses) creates the named alias; each random
	// button skips the name and creates an alias of its kind on the chosen domain in one click.
	return html`<section class="create" aria-labelledby="new-title">
<h2 id="new-title">${t("new.title")}</h2>
<form method="post" action="/aliases/new" class="create-form">
<div class="create-address">
<input type="text" name="prefix" required maxlength="50" autocomplete="off" spellcheck="false" placeholder="${t("new.namePlaceholder")}" aria-label="${t("new.prefix")}" />
<span aria-hidden="true">@</span>
<select name="domain" aria-label="${t("new.domain")}">
${settings.aliasDomains.map((domain) => html`<option value="${domain}">${domain}</option>`)}
</select>
<button class="primary" name="kind" value="custom">${t("new.create")}</button>
</div>
<div class="create-random" role="group" aria-labelledby="new-random">
<span id="new-random" class="muted">${t("new.randomLabel")}</span>
${RANDOM_ALIAS_FORMATS.map((format) => html`<button name="kind" value="${format}" formnovalidate>${t(`new.random.${format}`)}</button>`)}
</div>
<div class="create-extra">
<label><span>${t("new.note")}</span><input type="text" name="note" maxlength="500" /></label>
<label><span>${t("new.destination")}</span><input type="email" name="destination" maxlength="254" placeholder="${settings.defaultDestination || ""}" /></label>
</div>
</form>
</section>`;
}

export function dashboardPage(
	t: Translate,
	input: {
		settings: Settings;
		aliases: (AliasRow & { contacts: number; used_at?: number | null; labels?: LabelRow[] })[];
		labels?: LabelRow[];
		list: AliasListState;
		activity: ActivityItem[];
		missing: MessageKey[];
		notice?: Notice;
	},
): Html {
	const { settings, aliases, list, activity, missing, notice } = input;
	const labels = input.labels ?? [];
	const listUrl = (changes: Partial<AliasListState>) => {
		const next = { ...list, ...changes };
		const params = new URLSearchParams();
		if (next.query) params.set("q", next.query);
		if (next.filter !== "all") params.set("filter", next.filter);
		if (next.label) params.set("label", next.label);
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
${labels.length
	? html`<select name="label" aria-label="${t("nav.labels")}" data-autosubmit>
<option value="">${t("dash.allLabels")}</option>
${labels.map((label) => html`<option value="${label.id}" ${list.label === label.id ? "selected" : ""}>${label.name}</option>`)}
</select>`
	: ""}
<select name="per" aria-label="${t("dash.perPageLabel")}" data-autosubmit>
${ALIAS_PAGE_SIZES.map((size) => html`<option value="${size}" ${list.perPage === size ? "selected" : ""}>${t("dash.perPage", { count: String(size) })}</option>`)}
</select>
<button>${t("dash.searchButton")}</button>
</form>
<p class="muted">${t("dash.results", { count: String(list.total) })}${list.query || list.filter !== "all" || list.label ? html` · <a href="/">${t("dash.clear")}</a>` : ""}</p>
${aliases.length === 0
	? html`<p class="muted">${list.query || list.filter !== "all" || list.label ? t("dash.noResults") : t("dash.noAliases")}</p>
${list.page > 1 ? pager(t, list.page, Math.max(list.page, lastPage), (page) => listUrl({ page: page >= list.page ? list.page : Math.max(1, Math.min(page, lastPage)) })) : ""}`
	: html`${pager(t, list.page, lastPage, (page) => listUrl({ page }))}
<form id="bulk" class="toolbar bulk" method="post" action="/aliases/bulk" data-bulk
 data-confirm-delete="${t("bulk.confirmDelete")}" data-confirm-forget="${t("bulk.confirmForget")}" data-none-selected="${t("bulk.noneSelected")}" data-no-labels="${t("bulk.noLabels")}">
<input type="hidden" name="back" value="${listUrl({})}" />
<span class="muted" data-selected-count data-template="${t("bulk.selected", { count: "{count}" })}">${t("bulk.selected", { count: "0" })}</span>
<select name="action" aria-label="${t("bulk.action")}" required>
<option value="">${t("bulk.choose")}</option>
${actions.map(([value, label]) => html`<option value="${value}" ${value === "note" || value === "destination" ? html`data-needs-value` : ""}>${label}</option>`)}
${labels.length && !deletedView
	? html`<optgroup label="${t("nav.labels")}">
<option value="label" data-needs-labels>${t("bulk.addLabels")}</option>
<option value="unlabel" data-needs-labels>${t("bulk.removeLabels")}</option>
</optgroup>`
	: ""}
</select>
<input type="text" name="value" placeholder="${t("bulk.value")}" aria-label="${t("bulk.value")}" data-bulk-value />
${labels.length && !deletedView
	? html`<details class="label-menu" data-bulk-labels>
<summary data-template="${t("bulk.labelsChosen", { count: "{count}" })}" data-empty="${t("bulk.chooseLabels")}">${t("bulk.chooseLabels")}</summary>
<div class="label-menu-list">
<input type="search" placeholder="${t("bulk.findLabel")}" aria-label="${t("bulk.findLabel")}" data-label-filter />
<label class="all"><input type="checkbox" data-label-all /><span>${t("bulk.allLabels")}</span></label>
${labels.map((label) => html`<label data-name="${label.name.toLowerCase()}"><input type="checkbox" name="labels" value="${label.id}" /><span class="label-chip" data-colour="${nearestColour(label.colour)}">${label.name}</span></label>`)}
</div>
</details>`
	: ""}
<button class="primary">${t("bulk.apply")}</button>
</form>
<div class="table-wrap"><table class="rt compact aliases">
<thead><tr><th class="pick"><input type="checkbox" aria-label="${t("dash.selectAll")}" data-select-all /></th><th>${t("dash.colAlias")}</th><th>${t("dash.colNote")}</th><th>${t("dash.colForwardTo")}</th><th>${t("dash.colMode")}</th><th>${t("dash.colContacts")}</th><th>${t("dash.colLastUsed")}</th><th class="c-created">${t("keys.colCreated")}</th></tr></thead>
<tbody>
${aliases.map((alias) => {
	const base = `/aliases/${encodeURIComponent(alias.address)}`;
	const isDeleted = !!alias.deleted_at;
	return html`<tr data-mode="${alias.forward_mode}"${isDeleted ? html` data-deleted="1"` : ""}>
<td class="pick"><input type="checkbox" form="bulk" name="ids" value="${alias.address}" aria-label="${t("dash.select", { alias: alias.address })}" data-pick /></td>
<td class="c-alias" data-label="${t("dash.colAlias")}"><span class="alias-cell"><a href="${base}"><code>${alias.address}</code></a>${copyButton(t, alias.address)}</span>${alias.pinned ? html` <span class="pill">${t("dash.filter.pinned")}</span>` : ""}${alias.labels?.length ? labelChips(alias.labels) : ""}${isDeleted ? html` <span class="pill bad">${t("dash.filter.deleted")}</span>` : ""}</td>
<td class="c-note" data-label="${t("dash.colNote")}">${isDeleted
		? html`<span class="muted">${alias.note || "—"}</span>`
		: html`<form class="note" method="post" action="${base}/note" data-autosave data-msg-failed="${t("link.error")}">
<input type="hidden" name="back" value="list" />
<input type="text" name="note" value="${alias.note ?? ""}" maxlength="${MAX_NOTE_LENGTH}" placeholder="${t("alias.notePlaceholder")}" aria-label="${t("dash.colNote")}: ${alias.address}" />
<noscript><button>${t("common.save")}</button></noscript></form>`}</td>
<td class="c-dest" data-label="${t("dash.colForwardTo")}">${isDeleted
		? html`<span class="muted">${alias.destination || settings.defaultDestination || t("dash.default")}</span>`
		: html`<form class="inline-save" method="post" action="${base}/destination" data-autosave data-msg-failed="${t("link.error")}">
<input type="hidden" name="back" value="list" />
<input type="email" name="destination" value="${alias.destination ?? ""}" maxlength="254" placeholder="${t("dash.default")}"${settings.defaultDestination ? html` title="${settings.defaultDestination}"` : ""} aria-label="${t("dash.colForwardTo")}: ${alias.address}" />
<noscript><button>${t("common.save")}</button></noscript></form>`}</td>
<td class="c-mode" data-label="${t("dash.colMode")}">${isDeleted
		? html`<span class="muted">${t(`mode.${alias.forward_mode}`)}</span>`
		: html`<form class="inline-save" method="post" action="${base}/mode" data-autosave data-msg-failed="${t("link.error")}">
<input type="hidden" name="back" value="list" />
<select name="mode" aria-label="${t("dash.colMode")}: ${alias.address}">${FORWARD_MODES.map((mode) => html`<option value="${mode.value}" ${alias.forward_mode === mode.value ? "selected" : ""}>${t(`mode.${mode.value}`)}</option>`)}</select>
<noscript><button>${t("common.set")}</button></noscript></form>`}</td>
<td class="c-count" data-label="${t("dash.colContacts")}">${alias.contacts}</td>
<td class="c-used" data-label="${t("dash.colLastUsed")}">${alias.used_at ? html`<time datetime="${isoTime(alias.used_at)}" title="${when(alias.used_at, t.locale)}">${ago(alias.used_at, t.locale)}</time>` : html`<span class="muted">${t("dash.neverUsed")}</span>`}</td>
<td class="c-created" data-label="${t("keys.colCreated")}"><time datetime="${isoTime(alias.created_at)}" title="${when(alias.created_at, t.locale)}">${ago(alias.created_at, t.locale)}</time></td>
</tr>`;
})}
</tbody></table></div>
${pager(t, list.page, lastPage, (page) => listUrl({ page }))}`}
<p class="help">${t("dash.modesHelp")}</p>
</section>

<section>
<h2>${t("dash.activity")}</h2>
${activityTable(t, activity)}
${activity.length ? html`<p><a href="/activity">${t("dash.allActivity")} <span class="arrow" aria-hidden="true">→</span></a></p>` : ""}
</section>
</main>`,
		{ t, nav: true, current: "/", path: "/" },
	);
}

function activityTable(t: Translate, items: ActivityItem[]): Html {
	if (items.length === 0) return html`<p class="muted">${t("dash.nothingYet")}</p>`;
	return html`<div class="table-wrap"><table class="rt compact activity"><thead><tr><th>${t("dash.colWhen")}</th><th>${t("dash.colWhat")}</th><th>${t("dash.colAlias")}</th><th>${t("dash.colStatus")}</th><th>${t("dash.colDetail")}</th></tr></thead><tbody>
${items.map(
	(item) => html`<tr><td class="a-when" data-label="${t("dash.colWhen")}"><time datetime="${isoTime(item.at)}" title="${when(item.at, t.locale)}">${ago(item.at, t.locale)}</time></td><td class="a-what" data-label="${t("dash.colWhat")}">${translated(t, `kind.${item.kind}`, item.kind)}</td>
<td class="a-alias" data-label="${t("dash.colAlias")}">${item.alias ? html`<a href="/aliases/${encodeURIComponent(item.alias)}"><code>${item.alias}</code></a>` : ""}</td><td class="a-status" data-label="${t("dash.colStatus")}">${statusPill(t, item.status)}</td>
<td class="a-detail muted" data-label="${t("dash.colDetail")}">${item.detail ?? ""}</td></tr>`,
)}
</tbody></table></div>`;
}

/** Every forward and event, newest first, searchable and paged. */
export function activityListPage(
	t: Translate,
	input: { items: ActivityItem[]; page: number; lastPage: number; query?: string; perPage?: number; total?: number },
): Html {
	const { items, page: current, lastPage } = input;
	const query = input.query ?? "";
	const perPage = input.perPage ?? DEFAULT_ACTIVITY_PAGE_SIZE;
	const total = input.total ?? items.length;
	const at = (changes: { page?: number; query?: string; perPage?: number }) => {
		const nextQuery = changes.query ?? query;
		const nextPer = changes.perPage ?? perPage;
		const nextPage = changes.page ?? current;
		const params = new URLSearchParams();
		if (nextQuery) params.set("q", nextQuery);
		if (nextPer !== DEFAULT_ACTIVITY_PAGE_SIZE) params.set("per", String(nextPer));
		if (nextPage > 1) params.set("page", String(nextPage));
		const search = params.toString();
		return search ? `/activity?${search}` : "/activity";
	};
	return page(
		t("nav.activity"),
		html`<main><section>
<h2>${t("nav.activity")}</h2>
<form class="toolbar" method="get" action="/activity" role="search">
<input type="search" name="q" value="${query}" placeholder="${t("activity.searchPlaceholder")}" aria-label="${t("dash.search")}" />
<select name="per" aria-label="${t("dash.perPageLabel")}" data-autosubmit>
${ALIAS_PAGE_SIZES.map((size) => html`<option value="${size}" ${perPage === size ? "selected" : ""}>${t("dash.perPage", { count: String(size) })}</option>`)}
</select>
<button>${t("dash.searchButton")}</button>
</form>
<p class="muted">${t("activity.results", { count: String(total) })}${query ? html` · <a href="${at({ query: "", page: 1 })}">${t("dash.clear")}</a>` : ""}</p>
${items.length === 0
	? html`<p class="muted">${query ? t("activity.noResults") : t("dash.nothingYet")}</p>
${current > 1 ? pager(t, current, Math.max(current, lastPage), (page) => at({ page: page >= current ? current : Math.max(1, Math.min(page, lastPage)) })) : ""}`
	: html`${pager(t, current, lastPage, (page) => at({ page }))}
${activityTable(t, items)}
${pager(t, current, lastPage, (page) => at({ page }))}`}
</section></main>`,
		{ t, nav: true, current: "/activity", path: at({}) },
	);
}

export function settingsPage(t: Translate, input: { settings: Settings; origin: string; notice?: Notice }): Html {
	const { settings, notice, origin } = input;
	return page(
		t("settings.title"),
		html`<main>
${noticeBox(notice)}
<nav class="jump" aria-label="${t("settings.title")}">
<a href="#language-settings">${t("settings.display")}</a><a href="#forwarding">${t("settings.section")}</a><a href="#unsubscribe">${t("settings.unsubscribe")}</a><a href="#clients">${t("set.clients")}</a>
</nav>
<form class="sections" method="post" action="/settings" data-autosave data-msg-failed="${t("link.error")}">
<section id="language-settings">
<h2>${t("settings.display")}</h2>
<label for="uiTheme">${t("theme.label")}</label>
<select id="uiTheme" name="uiTheme">
${THEMES.map((mode) => html`<option value="${mode}" ${(t.theme ?? "system") === mode ? "selected" : ""}>${t(`theme.${mode}`)}</option>`)}
</select>
<p class="help">${t("theme.help")}</p>

<label for="uiLocale">${t("set.uiLanguage")}</label>
<select id="uiLocale" name="uiLocale">
${LOCALE_LIST.map((locale) => html`<option value="${locale}" lang="${locale}" ${t.locale === locale ? "selected" : ""}>${LOCALE_NAMES[locale]}</option>`)}
</select>
<p class="help">${t("set.uiLanguageHelp")}</p>

<label for="language">${t("settings.mailLanguage")}</label>
<select id="language" name="language">
${LOCALE_LIST.map((locale) => html`<option value="${locale}" lang="${locale}" ${settings.language === locale ? "selected" : ""}>${LOCALE_NAMES[locale]}</option>`)}
</select>
</section>
<section id="forwarding">
<h2>${t("settings.section")}</h2>
<label for="defaultDestination">${t("settings.destination")}</label>
<input id="defaultDestination" name="defaultDestination" type="email" value="${settings.defaultDestination}" placeholder="you@gmail.com" />
<p class="help">${t("settings.destinationHelp")}</p>

<label for="forwardMethod">${t("settings.forwardMethod")}</label>
<select id="forwardMethod" name="forwardMethod">
${FORWARD_METHODS.map((method) => html`<option value="${method}" ${settings.forwardMethod === method ? "selected" : ""}>${t(`forwardMethod.${method}`)}</option>`)}
</select>
<p class="help">${t("settings.forwardMethodHelp")}</p>
<p class="notice" data-direct-note${settings.forwardMethod === "direct" ? "" : html` hidden`}>${t("settings.forwardMethodDirectNote")}</p>

<label for="senderFormat">${t("settings.senderFormat")}</label>
<select id="senderFormat" name="senderFormat">
${SENDER_FORMATS.map(
	(format) => html`<option value="${format.value}" ${settings.senderFormat === format.value ? "selected" : ""}>${format.value === "NO_NAME" ? t("settings.noName") : format.label}</option>`,
)}
</select>
<p class="help">${t("settings.senderFormatHelp")}</p>

${checkbox("reverseAliasReplacement", settings.reverseAliasReplacement, t("settings.replacement"), t("settings.replacementHelp"))}
${checkbox("includeSenderInReverseAlias", settings.includeSenderInReverseAlias, t("settings.includeSender"), t("settings.includeSenderHelp"))}
${checkbox("sendAutoReplies", settings.sendAutoReplies, t("settings.autoReplies"), t("settings.autoRepliesHelp"))}
${checkbox("removeTrackers", settings.removeTrackers, t("settings.trackers"), t("settings.trackersHelp"))}
${checkbox("showBanner", settings.showBanner, t("settings.banner"), t("settings.bannerHelp"))}
${checkbox("createAliasesFromMail", settings.createAliasesFromMail, t("settings.createFromMail"), t("settings.createFromMailHelp"))}
${settings.aliasDomains.length > 1
	? html`<fieldset class="domain-list"><legend class="help">${t("settings.createFromMailDomains")}</legend>
${settings.aliasDomains.map((domain) => html`<label class="check"><input type="hidden" name="fromMailShown:${domain}" value="1" /><input type="checkbox" name="fromMail:${domain}" value="1" ${settings.aliasesFromMailOff.includes(domain) ? "" : "checked"} /><span><code>${domain}</code></span></label>`)}
</fieldset>`
	: ""}
${checkbox("autoForwardNewAliases", settings.autoForwardNewAliases, t("settings.autoForward"), t("settings.autoForwardHelp"))}
</section>

<section id="unsubscribe">
<h2>${t("settings.unsubscribe")}</h2>
<label for="unsubscribeBehavior" class="sr">${t("settings.unsubscribe")}</label>
<select id="unsubscribeBehavior" name="unsubscribeBehavior">
${UNSUBSCRIBE_BEHAVIORS.map((behavior) => html`<option value="${behavior}" ${settings.unsubscribeBehavior === behavior ? "selected" : ""}>${t(`unsub.${behavior}`)}</option>`)}
</select>
<p class="help">${t("settings.unsubscribeHelp")}<br />
${UNSUBSCRIBE_BEHAVIORS.map((behavior) => html`<b>${t(`unsub.${behavior}`)}:</b> ${t(`unsub.${behavior}.help`)}<br />`)}</p>

<label for="unsubscribeFallback">${t("settings.unsubFallback")}</label>
<select id="unsubscribeFallback" name="unsubscribeFallback">
${UNSUBSCRIBE_FALLBACKS.map((fallback) => html`<option value="${fallback}" ${settings.unsubscribeFallback === fallback ? "selected" : ""}>${t(`unsubFallback.${fallback}`)}</option>`)}
</select>
<p class="help">${t("settings.unsubFallbackHelp")}</p>

<label for="unsubscribeRedirect">${t("settings.unsubRedirect")}</label>
<input id="unsubscribeRedirect" name="unsubscribeRedirect" type="email" value="${settings.unsubscribeRedirect}" placeholder="newsletters@example.com" autocapitalize="none" spellcheck="false" />
<p class="help">${t("settings.unsubRedirectHelp")}</p>

${settings.aliasDomains.length
	? html`<h3>${t("settings.unsubDomains")}</h3>
<p class="help">${t("settings.unsubDomainsHelp")}</p>
<div class="table-wrap"><table class="rt"><thead><tr><th>${t("settings.unsubColDomain")}</th><th>${t("settings.unsubscribe")}</th><th>${t("settings.unsubFallback")}</th><th>${t("settings.unsubRedirect")}</th></tr></thead><tbody>
${settings.aliasDomains.map((domain) => {
	const rule = Object.hasOwn(settings.unsubscribeDomains, domain) ? settings.unsubscribeDomains[domain] : undefined;
	return html`<tr>
<td data-label="${t("settings.unsubColDomain")}"><code>${domain}</code></td>
<td data-label="${t("settings.unsubscribe")}"><select name="unsubscribeBehavior:${domain}" aria-label="${t("settings.unsubscribe")} (${domain})"><option value="">${t("settings.unsubUseGeneral")}</option>
${UNSUBSCRIBE_BEHAVIORS.map((behavior) => html`<option value="${behavior}" ${rule?.behavior === behavior ? "selected" : ""}>${t(`unsub.${behavior}`)}</option>`)}</select></td>
<td data-label="${t("settings.unsubFallback")}"><select name="unsubscribeFallback:${domain}" aria-label="${t("settings.unsubFallback")} (${domain})"><option value="">${t("settings.unsubUseGeneral")}</option>
${UNSUBSCRIBE_FALLBACKS.map((fallback) => html`<option value="${fallback}" ${rule?.fallback === fallback ? "selected" : ""}>${t(`unsubFallback.${fallback}`)}</option>`)}</select></td>
<td data-label="${t("settings.unsubRedirect")}"><input name="unsubscribeRedirect:${domain}" type="email" value="${rule?.redirect ?? ""}" placeholder="${settings.unsubscribeRedirect || t("settings.unsubUseGeneral")}" aria-label="${t("settings.unsubRedirect")} (${domain})" autocapitalize="none" spellcheck="false" /></td>
</tr>`;
})}
</tbody></table></div>`
	: ""}
</section>

<section id="clients">
<h2>${t("set.clients")}</h2>
<p class="help">${t("set.clientsHelp")} <a href="/api-keys">${t("nav.apiKeys")} <span class="arrow" aria-hidden="true">→</span></a></p>
${checkbox("simpleloginApi", settings.simpleloginApi, t("set.simpleloginApi"), t("set.simpleloginApiHelp", { url: origin }))}
${checkbox("addyApi", settings.addyApi, t("set.addyApi"), t("set.addyApiHelp", { url: origin }))}
${checkbox("mcpServer", settings.mcpServer, t("set.mcpServer"), t("set.mcpServerHelp", { url: `${origin}/mcp` }))}

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

/** The fields of each provider that needs more than a key; the chosen one's are shown. */
function providerFields(t: Translate, options: OutboundOptions, provider: OutboundProvider, fixed: boolean): Html {
	const group = (name: OutboundProvider, body: (off: string) => Html) => {
		const active = provider === name;
		const off = fixed || !active ? "disabled" : "";
		return html`<div class="provider-fields" data-provider="${name}"${fixed ? html` data-fixed="1"` : ""}${active ? "" : html` hidden`}>${body(off)}</div>`;
	};
	const input = (name: keyof OutboundOptions, label: string, help: string, off: string, attrs = "") => html`
<label for="${name}">${label}</label>
<input id="${name}" name="${name}" type="text" value="${String(options[name])}" autocapitalize="none" spellcheck="false" ${raw(attrs)} ${off} />
${help ? html`<p class="help">${help}</p>` : ""}`;
	return html`${group(
	"smtp",
	(off) => html`${input("smtpHost", t("conn.smtpHost"), "", off, 'placeholder="smtp.example.com"')}
<label for="smtpPortField">${t("conn.smtpPort")}</label>
<div class="row"><input id="smtpPortField" name="smtpPort" type="number" min="1" max="65535" value="${String(options.smtpPort)}" ${off} />
<select name="smtpSecurity" aria-label="${t("conn.smtpSecurity")}" ${off}>
<option value="starttls" ${options.smtpSecurity === "starttls" ? "selected" : ""}>STARTTLS (587)</option>
<option value="tls" ${options.smtpSecurity === "tls" ? "selected" : ""}>TLS (465)</option></select></div>
<p class="help">${t("conn.smtpPortHelp")}</p>
${input("smtpUsername", t("conn.smtpUsername"), t("conn.smtpUsernameHelp"), off, 'autocomplete="off"')}`,
)}
${group(
	"mailgun",
	(off) => html`<label for="mailgunRegion">${t("conn.mailgunRegion")}</label>
<select id="mailgunRegion" name="mailgunRegion" ${off}><option value="us" ${options.mailgunRegion === "us" ? "selected" : ""}>US</option><option value="eu" ${options.mailgunRegion === "eu" ? "selected" : ""}>EU</option></select>
<p class="help">${t("conn.mailgunHelp")}</p>`,
)}
${group("mailbaby", (off) => input("mailbabyOrderId", t("conn.mailbabyOrder"), t("conn.mailbabyOrderHelp"), off, 'inputmode="numeric" pattern="[1-9][0-9]{0,14}" maxlength="15" placeholder="12345"'))}
${group("ses", (off) => html`${input("sesRegion", t("conn.sesRegion"), "", off, 'placeholder="us-east-1"')}${input("sesAccessKeyId", t("conn.sesAccessKey"), t("conn.sesHelp"), off, 'autocomplete="off"')}`)}
${group(
	"custom",
	(off) => html`${input("customUrl", t("conn.customUrl"), "", off, 'placeholder="https://api.example.com/send"')}
<label for="customHeaders">${t("conn.customHeaders")}</label>
<textarea id="customHeaders" name="customHeaders" rows="3" spellcheck="false" class="mono" ${off}>${options.customHeaders}</textarea>
<label for="customBody">${t("conn.customBody")}</label>
<textarea id="customBody" name="customBody" rows="6" spellcheck="false" class="mono" ${off}>${options.customBody}</textarea>
<p class="help">${t("conn.customHelp")}<br /><code>{{from}} {{from_name}} {{from_header}} {{to}} {{reply_to}} {{subject}} {{text}} {{html}} {{headers}} {{attachments}} {{raw}} {{message_id}} {{api_key}}</code></p>
${input("customIdPath", t("conn.customIdPath"), t("conn.customIdPathHelp"), off, 'placeholder="id"')}`,
)}`;
}

export function connectionPage(
	t: Translate,
	input: {
		values: { mailflareUrl: string; publicUrl: string; outboundProvider: OutboundProvider; workersPlan: WorkersPlan; outboundOptions: OutboundOptions };
		hasOutboundKey: boolean;
		hasApiKey: boolean;
		hasWebhookSecret: boolean;
		mailflare: boolean;
		fixed: Set<string>;
		webhookUrl: string;
		missing: MessageKey[];
		cloudflare: { hasToken: boolean; workerName: string; domains: string[]; setup?: DomainSetup[] };
		notice?: Notice;
	},
): Html {
	const { values, hasOutboundKey, hasApiKey, hasWebhookSecret, mailflare, fixed, webhookUrl, missing, cloudflare, notice } = input;
	const fixedNote = (key: string) => (fixed.has(key) ? html`<p class="help">${t("conn.fixed")}</p>` : "");
	const disabled = (key: string) => (fixed.has(key) ? "disabled" : "");
	const secretField = (key: string, label: string, isSet: boolean, help: string | Html) => html`
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
<form method="post" action="/connection/cloudflare" data-busy>
<fieldset><legend>${t("cf.domains")}</legend>
${cloudflare.domains.length
	? cloudflare.domains.map(
			(domain) => html`<label class="check"><input type="checkbox" name="domains" value="${domain}" checked /> <code>${domain}</code> <span class="muted"><span class="arrow" aria-hidden="true">→</span> ${t("cf.reverseIs", { reverse: reverseDomainFor(domain) })}</span></label>`,
		)
	: html`<p class="help">${t("notice.needAliasDomains")} <a href="/settings#clients">${t("nav.settings")} <span class="arrow" aria-hidden="true">→</span></a></p>`}
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
<p><button class="primary"${cloudflare.domains.length ? "" : html` disabled data-stay-disabled`}>${t("cf.run")}</button></p>
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
<section id="sending">
<h2>${t("conn.sendingTitle")}</h2>
<p class="help">${t("conn.sendingHelp")}</p>
<label for="workersPlan">${t("conn.plan")}</label>
<select id="workersPlan" name="workersPlan" ${disabled("workersPlan")}>
${WORKERS_PLANS.map((plan) => html`<option value="${plan}" ${values.workersPlan === plan ? "selected" : ""}>${t(`conn.plan.${plan}`)}</option>`)}
</select>
<p class="help">${t("conn.planHelp")}</p>${fixedNote("workersPlan")}
<p class="notice" data-free-notice${values.workersPlan === "free" && values.outboundProvider === "cloudflare" ? "" : html` hidden`}>${t("conn.freeNeedsProvider")}</p>
<label for="outboundProvider">${t("conn.provider")}</label>
<select id="outboundProvider" name="outboundProvider" ${disabled("outboundProvider")}>
${OUTBOUND_PROVIDERS.map((provider) => html`<option value="${provider}" ${values.outboundProvider === provider ? "selected" : ""}>${t(`conn.provider.${provider}`)}</option>`)}
</select>
<p class="help">${t("conn.providerHelp")}</p>${fixedNote("outboundProvider")}
<p class="notice" data-brevo-notice${values.outboundProvider === "brevo" ? "" : html` hidden`}>${t("conn.brevoLimits")}</p>
${providerFields(t, values.outboundOptions, values.outboundProvider, fixed.has("outboundOptions"))}
<div data-provider-key${values.outboundProvider === "cloudflare" ? html` hidden` : ""}>${secretField("outboundApiKey", t("conn.providerKey"), hasOutboundKey, t("conn.providerKeyHelp"))}</div>
<p><button class="primary">${t("conn.saveButton")}</button></p>
</section>
<section id="mailflare">
<h2>${t("conn.mailflareTitle")} ${mailflare ? html`<span class="pill ok">${t("conn.isSet")}</span>` : html`<span class="pill">${t("conn.notSet")}</span>`}</h2>
<p class="help">${t("conn.mailflareHelp")}</p>
<label for="mailflareUrl">${t("conn.mailflareUrl")}</label>
<input id="mailflareUrl" name="mailflareUrl" type="url" value="${values.mailflareUrl}" placeholder="https://mail.example.com" ${disabled("mailflareUrl")} />
<p class="help">${t("conn.mailflareUrlHelp")}</p>${fixedNote("mailflareUrl")}
${secretField("mailflareApiKey", t("conn.apiKey"), hasApiKey, t("conn.apiKeyHelp"))}
${secretField("webhookSecret", t("conn.webhookSecret"), hasWebhookSecret, html`${t("conn.webhookSecretHelp", { url: webhookUrl })} ${copyButton(t, webhookUrl)}`)}
<p><button class="primary">${t("conn.saveButton")}</button></p>
</section>
</form>
</main>`,
		{ t, nav: true, current: "/connection", path: "/connection" },
	);
}

export type DeviceView = SessionRow & { handle: string; current: boolean; label: string | null };

/** A country code as the reader's language names it ("TW" → "Taiwan"), or the code itself. */
function regionName(code: string, locale: string): string {
	try {
		return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
	} catch {
		return code;
	}
}

export function passkeysPage(t: Translate, input: { passkeys: PasskeyRow[]; devices: DeviceView[]; notice?: Notice }): Html {
	const { passkeys, devices, notice } = input;
	return page(
		t("pk.title"),
		html`<main>
${noticeBox(notice)}
<section>
<h2>${t("pk.title")}</h2>
<div class="table-wrap"><table class="rt"><thead><tr><th>${t("pk.colName")}</th><th>${t("pk.colAdded")}</th><th>${t("pk.colLastUsed")}</th><th></th></tr></thead><tbody>
${passkeys.map(
	(passkey) => html`<tr><td data-label="${t("pk.colName")}">${passkey.name}</td><td data-label="${t("pk.colAdded")}">${timeTag(passkey.created_at, t.locale)}</td>
<td data-label="${t("pk.colLastUsed")}">${timeTag(passkey.last_used_at, t.locale)}</td>
<td data-label="">${passkeys.length > 1
		? html`<form class="inline" method="post" action="/passkeys/${encodeURIComponent(passkey.id)}/delete"><button class="danger" aria-label="${t("pk.remove")}: ${passkey.name}">${t("pk.remove")}</button></form>`
		: html`<span class="muted">${t("pk.last")}</span>`}</td></tr>`,
)}
</tbody></table></div>
</section>
<section id="devices">
<h2>${t("pk.devices")}</h2>
<p class="help">${t("pk.devicesHelp")}</p>
<div class="table-wrap"><table class="rt"><thead><tr><th>${t("pk.colDevice")}</th><th>${t("pk.colWhere")}</th><th>${t("pk.colSignedIn")}</th><th>${t("pk.colActive")}</th><th>${t("pk.colPasskey")}</th><th></th></tr></thead><tbody>
${devices.map(
	(device) => html`<tr><td data-label="${t("pk.colDevice")}"><span class="device">${device.label ?? t("pk.unknownDevice")}${device.current ? html` <span class="pill ok">${t("pk.thisDevice")}</span>` : ""}</span></td>
<td data-label="${t("pk.colWhere")}">${device.country ? regionName(device.country, t.locale) : html`<span class="muted">—</span>`}</td>
<td data-label="${t("pk.colSignedIn")}">${timeTag(device.created_at, t.locale)}</td>
<td data-label="${t("pk.colActive")}">${timeTag(device.last_seen_at, t.locale)}</td>
<td data-label="${t("pk.colPasskey")}">${device.passkey_name}</td>
<td data-label=""><form class="inline" method="post" action="/sessions/${device.handle}/delete"><button class="danger" aria-label="${t("pk.signOut")}: ${device.label ?? t("pk.unknownDevice")}">${t("pk.signOut")}</button></form></td></tr>`,
)}
</tbody></table></div>
${devices.length > 1
	? html`<form method="post" action="/sessions/others/delete" class="mt12"><button class="danger">${t("pk.signOutOthers")}</button></form>`
	: ""}
</section>
<section>
<h2>${t("pk.add")}</h2>
<form data-passkey="add" data-next="/passkeys?notice=notice.passkeyAdded">
<label for="name">${t("pk.name")}</label>
<div class="row"><input id="name" name="name" type="text" value="${t("pk.defaultName")}" maxlength="60" /><button class="primary">${t("setup.button")}</button></div>
<p class="help">${t("pk.addHelp")} ${t("pk.reauthHelp")}</p>
${errorBox(t)}
</form>
</section>
</main>`,
		{ t, nav: true, script: true, current: "/passkeys", path: "/passkeys" },
	);
}

export function blocklistPage(t: Translate, input: { entries: BlocklistRow[]; notice?: Notice }): Html {
	const { entries, notice } = input;
	return page(
		t("bl.title"),
		html`<main>
${noticeBox(notice)}
<section>
<h2>${t("bl.title")}</h2>
<p class="help">${t("bl.help")} ${t("bl.helpMany")}</p>
<form class="row mt12" method="post" action="/blocklist">
<textarea name="value" rows="2" placeholder="${t("bl.placeholder")}" autocapitalize="none" spellcheck="false" required aria-label="${t("bl.colSender")}"></textarea>
<button class="primary">${t("bl.block")}</button>
</form>
${entries.length === 0
	? html`<p class="muted">${t("bl.empty")}</p>`
	: html`<div class="table-wrap"><table class="rt mt12"><thead><tr><th>${t("bl.colSender")}</th><th>${t("bl.colType")}</th><th>${t("bl.colHits")}</th><th>${t("bl.colAdded")}</th><th></th></tr></thead><tbody>
${entries.map(
	(entry) => html`<tr><td data-label="${t("bl.colSender")}"><code>${entry.value}</code></td><td data-label="${t("bl.colType")}">${t(entry.kind === "domain" ? "bl.domain" : "bl.address")}</td>
<td data-label="${t("bl.colHits")}">${entry.hits}</td><td data-label="${t("bl.colAdded")}">${timeTag(entry.created_at, t.locale)}</td>
<td data-label=""><form class="inline" method="post" action="/blocklist/${encodeURIComponent(entry.id)}/delete"><button aria-label="${t("bl.unblock")}: ${entry.value}">${t("bl.unblock")}</button></form></td></tr>`,
)}
</tbody></table></div>`}
</section>
</main>`,
		{ t, nav: true, current: "/blocklist", path: "/blocklist" },
	);
}

export function aliasPage(
	t: Translate,
	input: { alias: AliasRow; contacts: ContactRow[]; defaultDestination: string; labels?: LabelRow[]; aliasLabels?: string[]; notice?: Notice },
): Html {
	const { alias, contacts, defaultDestination, notice } = input;
	const labels = input.labels ?? [];
	const chosen = new Set(input.aliasLabels ?? []);
	const base = `/aliases/${encodeURIComponent(alias.address)}`;
	const isDeleted = !!alias.deleted_at;
	const chosenLabels = labels.filter((label) => chosen.has(label.id));
	return page(
		alias.address,
		html`<main>
<p class="m0"><a href="${isDeleted ? "/?filter=deleted" : "/"}">${t("alias.back")}</a></p>
${noticeBox(notice)}
<section>
<h2 class="alias-cell"><code>${alias.address}</code>${copyButton(t, alias.address)}${isDeleted ? html` <span class="pill bad">${t("dash.filter.deleted")}</span>` : ""}</h2>
<p class="help">${alias.mailbox_id ? html`${t("alias.mailbox")} <code>${alias.mailbox_id}</code> · ` : ""}${t(`mode.${alias.forward_mode}`)} · ${t("keys.colCreated")} ${timeTag(alias.created_at, t.locale)}</p>
${isDeleted
	? html`${alias.note ? html`<p><b>${t("alias.note")}:</b> ${alias.note}</p>` : ""}
<div class="row mt12">
<form class="inline" method="post" action="/aliases/bulk"><input type="hidden" name="action" value="restore" /><input type="hidden" name="ids" value="${alias.address}" /><input type="hidden" name="back" value="/" /><button class="primary">${t("bulk.restore")}</button></form>
<form class="inline" method="post" action="/aliases/bulk" data-confirm="${t("bulk.confirmForget")}"><input type="hidden" name="action" value="forget" /><input type="hidden" name="ids" value="${alias.address}" /><input type="hidden" name="back" value="/?filter=deleted" /><button class="danger">${t("bulk.forget")}</button></form>
</div>`
	: html`<form method="post" action="${base}/note" data-autosave data-msg-failed="${t("link.error")}">
<label for="note">${t("alias.note")}</label>
<div class="row"><input id="note" name="note" type="text" value="${alias.note ?? ""}" maxlength="${MAX_NOTE_LENGTH}" placeholder="${t("alias.notePlaceholder")}" /><noscript><button>${t("common.save")}</button></noscript></div>
</form>
<form method="post" action="${base}/contacts">
<label for="email">${t("alias.writeNew")}</label>
<div class="row"><input id="email" name="email" type="email" placeholder="someone@example.com" required /><button class="primary">${t("alias.create")}</button></div>
<p class="help">${t("alias.writeNewHelp", { alias: alias.address })}</p>
</form>`}
</section>
${isDeleted
	? ""
	: html`<section>
<h2>${t("alias.forwarding")}</h2>
<form method="post" action="${base}/destination" data-autosave data-msg-failed="${t("link.error")}">
<input type="hidden" name="back" value="alias" />
<label for="destination">${t("dash.colForwardTo")}</label>
<div class="row"><input id="destination" name="destination" type="email" value="${alias.destination ?? ""}" placeholder="${defaultDestination || t("dash.default")}" /><noscript><button>${t("common.save")}</button></noscript></div>
</form>
<form method="post" action="${base}/mode" data-autosave data-msg-failed="${t("link.error")}">
<input type="hidden" name="back" value="alias" />
<label for="mode">${t("dash.colMode")}</label>
<div class="row"><select id="mode" name="mode">${FORWARD_MODES.map((mode) => html`<option value="${mode.value}" ${alias.forward_mode === mode.value ? "selected" : ""}>${t(`mode.${mode.value}`)}</option>`)}</select><noscript><button>${t("common.set")}</button></noscript></div>
</form>
</section>`}
<section>
<h2>${t("nav.labels")}</h2>
${isDeleted
	? chosenLabels.length
		? html`<p>${labelChips(chosenLabels)}</p>`
		: html`<p class="muted">${t("labels.empty")}</p>`
	: labels.length
		? html`<form method="post" action="${base}/labels">
<div class="label-picks">${labels.map(
			(label) => html`<label><input type="checkbox" name="labels" value="${label.id}" ${chosen.has(label.id) ? "checked" : ""} /><span class="label-chip" data-colour="${nearestColour(label.colour)}">${label.name}</span></label>`,
		)}</div>
<button>${t("common.save")}</button> <a href="/labels">${t("labels.manage")} <span class="arrow" aria-hidden="true">→</span></a>
</form>`
		: html`<p class="muted">${t("labels.empty")} <a href="/labels">${t("labels.manage")} <span class="arrow" aria-hidden="true">→</span></a></p>`}
</section>
${importedHistory(t, alias)}
<section>
<h2>${t("alias.contacts")}</h2>
${contacts.length === 0
	? html`<p class="muted">${t("alias.noContacts")}</p>`
	: html`<div class="table-wrap"><table class="rt"><thead><tr><th>${t("alias.colContact")}</th><th>${t("alias.colReverse")}</th><th>${t("alias.colForwarded")}</th><th>${t("alias.colReplied")}</th>${isDeleted ? "" : html`<th></th>`}</tr></thead><tbody>
${contacts.map((contact) => {
	const reverse = contactReverseAddress(contact);
	return html`<tr>
<td data-label="${t("alias.colContact")}"><div class="stack">${contact.name ? html`${contact.name}<br />` : ""}${addressCode(contact.email)}
${isDeleted
		? ""
		: html`<form class="inline row" method="post" action="${base}/contacts/${contact.id}/destination"><input name="destination" type="email" value="${contact.destination ?? ""}" placeholder="${alias.destination || defaultDestination || t("alias.contactDestinationDefault")}" aria-label="${t("alias.contactDestination", { email: contact.email })}" autocapitalize="none" spellcheck="false" /><button>${t("common.set")}</button></form>`}</div></td>
<td data-label="${t("alias.colReverse")}"><span class="alias-cell keep">${addressCode(reverse)}${copyButton(t, reverse)}</span></td>
<td data-label="${t("alias.colForwarded")}"><div class="stack">${contact.forward_count}<br /><span class="muted">${timeTag(contact.last_forward_at, t.locale)}</span></div></td>
<td data-label="${t("alias.colReplied")}"><div class="stack">${contact.reply_count}<br /><span class="muted">${timeTag(contact.last_reply_at, t.locale)}</span></div></td>
${isDeleted
		? ""
		: html`<td data-label=""><div class="row"><form class="inline" method="post" action="${base}/contacts/${contact.id}/block">
<button class="${contact.blocked ? "" : "danger"}">${contact.blocked ? t("alias.unblock") : t("alias.block")}</button></form>
<form class="inline" method="post" action="${base}/contacts/${contact.id}/delete" data-confirm="${t("alias.confirmDeleteContact", { email: contact.email })}">
<button class="danger">${t("bulk.delete")}</button></form></div></td>`}
</tr>`;
})}
</tbody></table></div>`}
</section>
</main>`,
		{ t, nav: true, current: "/", path: base },
	);
}

export function messagePage(t: Translate, title: string, body: Html, path = "/"): Html {
	return page(title, html`<main class="center"><section><h1>${title}</h1>${body}</section></main>`, { t, path });
}

export function apiKeysPage(
	t: Translate,
	input: { keys: ApiKeyRow[]; enabled: { simplelogin: boolean; addy: boolean; mcp: boolean }; origin: string; newKey?: string; notice?: Notice },
): Html {
	const { keys, enabled, origin, newKey, notice } = input;
	return page(
		t("keys.title"),
		html`<main>
${noticeBox(notice)}
${newKey
	? html`<section><h2>${t("keys.createdTitle")}</h2><p class="notice" role="status">${t("keys.created")}</p>
<div class="row mt12"><input type="text" readonly value="${newKey}" aria-label="${t("keys.colKey")}" data-select spellcheck="false" class="mono" />${copyButton(t, newKey)}</div></section>`
	: ""}
<section>
<h2>${t("keys.title")}</h2>
<p class="help">${t("keys.help")}</p>
${enabled.simplelogin || enabled.addy || enabled.mcp
	? html`${enabled.simplelogin || enabled.addy ? html`<p>${t("keys.serverUrl")}: <span class="alias-cell"><code>${origin}</code>${copyButton(t, origin)}</span></p>` : ""}
${enabled.mcp ? html`<p>${t("keys.mcpUrl")}: <span class="alias-cell"><code>${origin}/mcp</code>${copyButton(t, `${origin}/mcp`)}</span></p>` : ""}
<p class="muted">${enabled.simplelogin ? html`<span class="pill ok">SimpleLogin</span> ` : ""}${enabled.addy ? html`<span class="pill ok">addy.io</span> ` : ""}${enabled.mcp ? html`<span class="pill ok">MCP</span>` : ""}</p>`
	: html`<p class="notice">${t("keys.off")} <a href="/settings#clients">${t("nav.settings")} <span class="arrow" aria-hidden="true">→</span></a></p>`}
${keys.length
	? html`<div class="table-wrap"><table class="rt"><thead><tr><th>${t("keys.colName")}</th><th>${t("keys.colScope")}</th><th>${t("keys.colKey")}</th><th>${t("keys.colCreated")}</th><th>${t("keys.colUsed")}</th><th>${t("pk.colWhere")}</th><th></th></tr></thead><tbody>
${keys.map(
	(key) => html`<tr><td data-label="${t("keys.colName")}">${key.name}</td><td data-label="${t("keys.colScope")}">${t(key.scope === "mcp" ? "keys.scopeMcp" : "keys.scopeApps")}</td><td data-label="${t("keys.colKey")}"><code>${key.prefix}…</code></td>
<td data-label="${t("keys.colCreated")}">${timeTag(key.created_at, t.locale)}</td><td data-label="${t("keys.colUsed")}">${timeTag(key.last_used_at, t.locale)}</td>
<td data-label="${t("pk.colWhere")}">${key.last_used_country ? regionName(key.last_used_country, t.locale) : html`<span class="muted">—</span>`}</td>
<td><form class="inline" method="post" action="/api-keys/${key.id}/delete"><button class="danger" aria-label="${t("keys.revoke")}: ${key.name}">${t("keys.revoke")}</button></form></td></tr>`,
)}
</tbody></table></div>`
	: html`<p class="muted">${t("keys.none")}</p>`}
</section>
<section>
<h2>${t("keys.add")}</h2>
<p class="help">${t("keys.reauthHelp")}</p>
<form method="post" action="/api-keys" data-reauth>
<div class="row">
<input name="name" type="text" maxlength="60" placeholder="${t("keys.namePlaceholder")}" aria-label="${t("keys.name")}" required />
<select name="scope" aria-label="${t("keys.colScope")}"><option value="apps">${t("keys.scopeApps")}</option><option value="mcp">${t("keys.scopeMcp")}</option></select>
<button class="primary">${t("keys.create")}</button>
</div>
${errorBox(t)}
</form>
</section>
</main>`,
		{ t, nav: true, script: true, current: "/api-keys", path: "/api-keys" },
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
<p class="notice" role="status">${t("imp.done", { found: String(result.found), created: String(result.created), updated: String(result.updated) })}${result.deleted ? html` ${t("imp.doneDeleted", { count: String(result.deleted) })}` : ""}${result.contacts ? html` ${t("imp.doneContacts", { count: String(result.contacts) })}` : ""}${result.labels ? html` ${t("imp.doneLabels", { count: String(result.labels) })}` : ""}${result.rules ? html` ${t("imp.doneRules", { count: String(result.rules) })}` : ""}${result.blocked ? html` ${t("imp.doneBlocked", { count: String(result.blocked) })}` : ""}</p>
${result.unread?.length ? html`<p class="notice bad" role="alert">${t("imp.unread", { parts: result.unread.join(", ") })}</p>` : ""}
${result.rulesSkipped?.length
	? html`<p>${t("imp.rulesSkipped")}</p><ul class="results">${result.rulesSkipped.map((name) => html`<li>${name}</li>`)}</ul>`
	: ""}
${result.skippedDomains.length
	? html`<p>${t("imp.skipped")}</p><ul class="results">${result.skippedDomains.map(
			(item) => html`<li><code>${item.domain}</code> <span class="muted">${t("imp.count", { count: String(item.count) })}</span></li>`,
		)}</ul><p class="help">${t("imp.skippedHelp")}</p>`
	: ""}
${result.newDestinations.length
	? html`<p>${t("imp.newDestinations")}</p><ul class="results">${result.newDestinations.map((email) => html`<li><code>${email}</code></li>`)}</ul>`
	: ""}
<p><a href="/">${t("imp.viewAliases")} <span class="arrow" aria-hidden="true">→</span></a></p></section>`
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
<section id="export">
<h2>${t("exp.title")}</h2>
<p class="help">${t("exp.help")}</p>
<form method="get" action="/export/aliases.csv"><p><button>${t("exp.button")}</button></p></form>
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
		const parsed: unknown = alias.imported_details ? JSON.parse(alias.imported_details) : {};
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) details = parsed as Record<string, unknown>;
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
		["hist.sourceId", details.id == null ? "" : String(details.id)],
	];
	const source = IMPORT_SOURCE_NAMES[alias.imported_from] ?? alias.imported_from;
	return html`<section>
<h2>${t("hist.title")}</h2>
<p class="help">${t("hist.from", { source, date: when(alias.imported_at, t.locale) })}${alias.imported_from === "csv" ? "" : html` ${t("hist.help", { source })}`}</p>
<p>${t("hist.created")}: ${timeTag(alias.created_at, t.locale)}</p>
<div class="table-wrap"><table class="rt"><thead><tr><th></th><th>${t("hist.colCount")}</th><th>${t("hist.colLast")}</th></tr></thead><tbody>
${rows.map(([key, total, last]) => html`<tr><th scope="row">${t(key)}</th><td data-label="${t("hist.colCount")}">${total}</td><td data-label="${t("hist.colLast")}">${timeTag(last, t.locale)}</td></tr>`)}
</tbody></table></div>
${latest?.action
	? html`<p>${t("hist.latest")}: ${latest.action}${latest.contact ? html` · ${latest.contact_name ? `${latest.contact_name} ` : ""}<code>${latest.contact}</code>` : ""} · ${timeTag(latest.at ?? null, t.locale)}</p>`
	: ""}
${extra.filter(([, value]) => value).map(([key, value]) => html`<p>${t(key)}: <code>${value}</code></p>`)}
</section>`;
}

// ---------- labels ----------

/** The colours to pick from; a label's own colour from an app is offered too. */
function swatches(t: Translate, current: string, id: string): Html {
	const colours: string[] = [...LABEL_COLOURS];
	if (!colours.includes(current)) colours.push(current);
	// One dot shows the colour; the palette opens under it when it is pressed.
	return html`<details class="colour-pick"><summary title="${t("labels.colour")}"><span class="sr">${t("labels.colour")}</span><span class="dot" data-colour="${nearestColour(current)}"></span></summary>
<fieldset class="swatches"><legend class="sr">${t("labels.colour")}</legend>${colours.map(
		(colour) => html`<label class="swatch" title="${colour}"><input type="radio" name="colour" value="${colour}" id="c-${id}-${colour.slice(1)}" ${colour === current ? "checked" : ""} /><span data-colour="${nearestColour(colour)}"></span></label>`,
	)}</fieldset></details>`;
}

/**
 * Previous and next as big buttons with the page between them. Both buttons are always there (an
 * unavailable one greyed out), so they stay in place for clicking again and again. Nothing for a
 * single page.
 */
function pager(t: Translate, page: number, lastPage: number, href: (page: number) => string): Html {
	if (lastPage <= 1) return html``;
	const button = (to: number, enabled: boolean, label: Html) =>
		enabled ? html`<a class="pg" href="${href(to)}">${label}</a>` : html`<span class="pg" aria-disabled="true">${label}</span>`;
	return html`<nav class="pager" aria-label="${t("dash.pages")}">
${button(page - 1, page > 1, html`<span class="arrow" aria-hidden="true">←</span> ${t("dash.prev")}`)}
<span class="at">${page} / ${lastPage}</span>
${button(page + 1, page < lastPage, html`${t("dash.next")} <span class="arrow" aria-hidden="true">→</span>`)}
</nav>`;
}

function labelChips(labels: LabelRow[]): Html {
	return html`<span class="labels-row">${labels.map((label) => html`<a class="label-chip" href="/?label=${encodeURIComponent(label.id)}" data-colour="${nearestColour(label.colour)}">${label.name}</a>`)}</span>`;
}

export function labelsPage(t: Translate, input: { labels: LabelWithCount[]; notice?: Notice }): Html {
	const { labels, notice } = input;
	const next = LABEL_COLOURS[labels.length % LABEL_COLOURS.length]!;
	return page(
		t("labels.title"),
		html`<main>
${noticeBox(notice)}
<section>
<h2>${t("labels.title")}</h2>
<p class="help">${t("labels.help")}</p>
<form class="label-new mt12" method="post" action="/labels">
<input name="name" type="text" maxlength="${MAX_LABEL_NAME}" required placeholder="${t("labels.name")}" aria-label="${t("labels.name")}" />
${swatches(t, next, "new")}
<button class="primary">${t("labels.add")}</button>
</form>
${labels.length === 0
	? html`<p class="muted">${t("labels.empty")}</p>`
	: html`<div class="table-wrap"><table class="rt mt12"><thead><tr><th>${t("labels.name")}</th><th>${t("labels.colAliases")}</th><th></th></tr></thead><tbody>
${labels.map(
	(label) => html`<tr>
<td data-label="${t("labels.name")}"><form class="label-edit" method="post" action="/labels/${encodeURIComponent(label.id)}">
<input name="name" type="text" value="${label.name}" maxlength="${MAX_LABEL_NAME}" required aria-label="${t("labels.name")}: ${label.name}" />
${swatches(t, label.colour, label.id)}
<button>${t("common.save")}</button>
</form></td>
<td data-label="${t("labels.colAliases")}"><a href="/?label=${encodeURIComponent(label.id)}">${label.aliases}</a></td>
<td data-label=""><form class="inline" method="post" action="/labels/${encodeURIComponent(label.id)}/delete" data-confirm="${t("labels.confirmDelete", { name: label.name })}"><button class="danger" aria-label="${t("bulk.delete")}: ${label.name}">${t("bulk.delete")}</button></form></td>
</tr>`,
)}
</tbody></table></div>`}
</section>
</main>`,
		{ t, nav: true, current: "/labels", path: "/labels" },
	);
}

// ---------- rules ----------

function conditionText(t: Translate, condition: Condition): string {
	return `${t(`rules.type.${condition.type}`)} ${t(`rules.match.${condition.match}`)} “${condition.values.join("”, “")}”`;
}

function actionText(t: Translate, action: Action): string {
	if (action.type === "block" || action.type === "removeAttachments" || action.type === "banner") return t(`rules.action.${action.type}`);
	// Only the host: a webhook address often carries a token of its own.
	if (action.type === "webhook") return `${t("rules.action.webhook")} (${URL.canParse(action.value) ? new URL(action.value).host : "?"})`;
	return `${t(`rules.action.${action.type}`)} “${action.value}”`;
}

export function rulesPage(t: Translate, input: { rules: Rule[]; notice?: Notice; webhookKey?: string }): Html {
	const { rules, notice, webhookKey } = input;
	const hasWebhook = rules.some((rule) => rule.actions.some((action) => action.type === "webhook"));
	return page(
		t("rules.title"),
		html`<main>
${noticeBox(notice)}
<section>
<h2>${t("rules.title")}</h2>
<p class="help">${t("rules.help")}</p>
<form method="get" action="/rules/new"><button class="primary">${t("rules.new")}</button></form>
${hasWebhook && webhookKey
	? html`<details class="mt12"><summary>${t("rules.webhookKey")}</summary>
<p class="help">${t("rules.webhookKeyHelp")}</p>
<input type="text" readonly value="${webhookKey}" aria-label="${t("rules.webhookKey")}" spellcheck="false" /></details>`
	: ""}
${rules.length === 0
	? html`<p class="muted">${t("rules.empty")}</p>`
	: html`<div class="table-wrap"><table class="rt mt12"><thead><tr><th>${t("rules.name")}</th><th>${t("rules.conditions")}</th><th>${t("rules.actions")}</th><th>${t("rules.colApplied")}</th><th></th></tr></thead><tbody>
${rules.map((rule, index) => {
	const base = `/rules/${encodeURIComponent(rule.id)}`;
	return html`<tr>
<td data-label="${t("rules.name")}"><a href="${base}">${rule.name}</a>${rule.active ? "" : html` <span class="pill">${t("rules.off")}</span>`}</td>
<td data-label="${t("rules.conditions")}">${rule.conditions.map((condition) => conditionText(t, condition)).join(` ${t(`rules.join.${rule.operator}`)} `)}</td>
<td data-label="${t("rules.actions")}">${rule.actions.map((action) => actionText(t, action)).join(" · ")}</td>
<td data-label="${t("rules.colApplied")}">${rule.applied}</td>
<td data-label=""><div class="row">
<form class="inline" method="post" action="${base}/active"><input type="hidden" name="active" value="${rule.active ? "0" : "1"}" /><button>${rule.active ? t("rules.turnOff") : t("rules.turnOn")}</button></form>
${index > 0 ? html`<form class="inline" method="post" action="${base}/move"><input type="hidden" name="step" value="-1" /><button title="${t("rules.moveUp")}" aria-label="${t("rules.moveUp")}: ${rule.name}">↑</button></form>` : ""}
${index < rules.length - 1 ? html`<form class="inline" method="post" action="${base}/move"><input type="hidden" name="step" value="1" /><button title="${t("rules.moveDown")}" aria-label="${t("rules.moveDown")}: ${rule.name}">↓</button></form>` : ""}
<form class="inline" method="post" action="${base}/delete" data-confirm="${t("rules.confirmDelete", { name: rule.name })}"><button class="danger" aria-label="${t("bulk.delete")}: ${rule.name}">${t("bulk.delete")}</button></form>
</div></td>
</tr>`;
})}
</tbody></table></div>`}
</section>
</main>`,
		{ t, nav: true, current: "/rules", path: "/rules" },
	);
}

export function ruleEditPage(t: Translate, input: { rule: Rule | null; destinations: string[]; notice?: Notice }): Html {
	const { rule, destinations, notice } = input;
	const conditions: (Condition | null)[] = [...(rule?.conditions ?? [])];
	while (conditions.length < Math.max(3, (rule?.conditions.length ?? 0) + 1)) conditions.push(null);
	const actions: (Action | null)[] = [...(rule?.actions ?? [])];
	while (actions.length < Math.max(3, (rule?.actions.length ?? 0) + 1)) actions.push(null);
	const action = rule ? `/rules/${encodeURIComponent(rule.id)}` : "/rules";
	const title = rule ? t("rules.edit") : t("rules.new");
	return page(
		title,
		html`<main>
<p class="m0"><a href="/rules"><span class="arrow" aria-hidden="true">←</span> ${t("rules.title")}</a></p>
${noticeBox(notice)}
<section>
<h2>${title}</h2>
<form method="post" action="${action}">
<label for="rule-name">${t("rules.name")}</label>
<input id="rule-name" name="name" type="text" value="${rule?.name ?? ""}" maxlength="${MAX_RULE_NAME}" required />
<h3>${t("rules.conditions")}</h3>
<p class="help">${t("rules.conditionsHelp")}</p>
<label for="rule-operator">${t("rules.operator")}</label>
<select id="rule-operator" name="operator">${(["AND", "OR"] as const).map((op) => html`<option value="${op}" ${(rule?.operator ?? "AND") === op ? "selected" : ""}>${t(`rules.operator.${op}`)}</option>`)}</select>
<div class="rule-rows">${conditions.map(
	(condition, i) => html`<div class="rule-row">
<select name="cond_type_${i}" aria-label="${t("rules.conditions")} ${i + 1}">${CONDITION_TYPES.map((type) => html`<option value="${type}" ${condition?.type === type ? "selected" : ""}>${t(`rules.type.${type}`)}</option>`)}</select>
<select name="cond_match_${i}" aria-label="${t("rules.matchLabel")} ${i + 1}">${MATCHES.map((match) => html`<option value="${match}" ${(condition?.match ?? "contains") === match ? "selected" : ""}>${t(`rules.match.${match}`)}</option>`)}</select>
<textarea name="cond_values_${i}" rows="${Math.min(5, Math.max(1, condition?.values.length ?? 1))}" placeholder="${t("rules.valuesPlaceholder")}" aria-label="${t("rules.values")} ${i + 1}">${condition?.values.join("\n") ?? ""}</textarea>
</div>`,
)}</div>
<h3>${t("rules.actions")}</h3>
<p class="help">${t("rules.actionsHelp")}</p>
<div class="rule-rows">${actions.map((act, i) => {
	const needsValue = !!act && act.type !== "block" && act.type !== "removeAttachments" && act.type !== "banner";
	return html`<div class="rule-row act">
<select name="act_type_${i}" data-act-type aria-label="${t("rules.actions")} ${i + 1}"><option value="">—</option>${ACTION_TYPES.map((type) => html`<option value="${type}" ${act?.type === type ? "selected" : ""}>${t(`rules.action.${type}`)}</option>`)}</select>
<input type="text" name="act_value_${i}" data-act-value value="${needsValue ? act.value : ""}" aria-label="${t("rules.value")} ${i + 1}"${act?.type === "forwardTo" ? html` list="rule-destinations"` : ""}${needsValue ? "" : html` hidden disabled`} />
</div>`;
})}</div>
<datalist id="rule-destinations">${destinations.map((email) => html`<option value="${email}"></option>`)}</datalist>
<h3>${t("rules.applyTo")}</h3>
${checkbox("forwards", rule ? !!rule.forwards : true, t("rules.forwards"), t("rules.forwardsHelp"))}
${checkbox("replies", rule ? !!(rule.replies || rule.sends) : false, t("rules.replies"), t("rules.repliesHelp"))}
${checkbox("active", rule ? !!rule.active : true, t("rules.active"), "")}
<p><button class="primary">${t("rules.save")}</button></p>
</form>
</section>
</main>`,
		{ t, nav: true, current: "/rules", path: action },
	);
}
