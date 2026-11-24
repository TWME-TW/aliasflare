import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { AliasRow, BlocklistRow, ContactRow } from "./db";
import { FORWARD_MODES } from "./db";
import { SENDER_FORMATS } from "./format";
import { LOCALE_LIST, LOCALES, type MessageKey, type Translate } from "./i18n";
import type { PasskeyRow } from "./passkeys";
import { UNSUBSCRIBE_BEHAVIORS, type Settings } from "./settings";

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

const STYLE = raw(`
:root { color-scheme: light dark; --bg:#f7f7f8; --card:#fff; --text:#1d1d1f; --muted:#6b6b76; --line:#e3e3e8; --accent:#f38020; --accent-text:#b45309; --danger:#c62828; --ok:#2e7d32; }
@media (prefers-color-scheme: dark) { :root { --bg:#141416; --card:#1d1d20; --text:#ececf1; --muted:#9a9aa6; --line:#2e2e33; --accent-text:#f9a35a; --danger:#ef5350; --ok:#66bb6a; } }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin:0; font:15px/1.55 system-ui,-apple-system,"Segoe UI","Noto Sans TC","Noto Sans SC","Noto Sans JP",sans-serif; background:var(--bg); color:var(--text); }
header { display:flex; align-items:center; gap:12px 18px; padding:12px 24px; border-bottom:1px solid var(--line); background:var(--card); flex-wrap:wrap; position:sticky; top:0; z-index:1; }
header a { color:inherit; text-decoration:none; } header a.brand { font-weight:700; margin-right:auto; }
header nav { display:flex; gap:16px; align-items:center; font-size:14px; }
header nav a[aria-current] { color:var(--accent-text); font-weight:600; }
a { color:var(--accent-text); }
main { max-width:1080px; margin:0 auto; padding:24px; display:grid; gap:20px; }
section { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px 20px; min-width:0; }
h1 { font-size:20px; margin:0 0 8px; } h2 { font-size:16px; margin:0 0 12px; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
p.help, .muted { color:var(--muted); font-size:13px; margin:4px 0 0; }
table { width:100%; border-collapse:collapse; font-size:14px; }
th, td { text-align:left; padding:8px 6px; border-bottom:1px solid var(--line); vertical-align:middle; }
th { color:var(--muted); font-weight:500; font-size:12px; text-transform:uppercase; letter-spacing:.03em; }
code { font:13px ui-monospace,SFMono-Regular,Menlo,monospace; word-break:break-all; }
label { display:block; font-weight:500; margin:16px 0 4px; }
input[type=text], input[type=email], input[type=password], input[type=url], select { width:100%; max-width:460px; min-height:40px; padding:8px 10px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:inherit; font:inherit; }
td input[type=text], td input[type=email], td select { max-width:240px; min-height:34px; padding:5px 8px; }
.check { display:flex; gap:10px; align-items:flex-start; margin-top:16px; font-weight:500; } .check input { margin-top:5px; width:18px; height:18px; flex:none; }
button { min-height:36px; padding:7px 14px; border-radius:8px; border:1px solid var(--line); background:var(--bg); color:inherit; font:inherit; cursor:pointer; white-space:nowrap; }
button.primary { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:600; }
button.danger { color:var(--danger); } button:disabled { opacity:.6; cursor:wait; }
form.inline { display:inline; margin:0; }
.row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.row input, .row select { flex:1 1 180px; }
.pill { display:inline-block; padding:1px 8px; border-radius:999px; font-size:12px; border:1px solid var(--line); font-weight:500; }
.pill.ok { color:var(--ok); border-color:var(--ok); } .pill.bad { color:var(--danger); border-color:var(--danger); }
.notice { padding:10px 14px; border-radius:10px; border:1px solid var(--accent); margin:0; background:var(--card); }
.error { color:var(--danger); margin:10px 0 0; }
.center { max-width:500px; margin:8vh auto; }
ol.steps { padding-left:20px; margin:8px 0 0; } ol.steps li { margin:6px 0; }
footer { max-width:1080px; margin:0 auto; padding:8px 24px 32px; font-size:13px; color:var(--muted); display:flex; gap:12px; flex-wrap:wrap; }
footer a { color:inherit; } footer a[aria-current] { color:var(--text); font-weight:600; text-decoration:none; }

@media (max-width: 760px) {
	header { padding:10px 14px; gap:8px; }
	header nav { width:100%; overflow-x:auto; gap:14px; padding-bottom:2px; white-space:nowrap; scrollbar-width:none; }
	header nav::-webkit-scrollbar { display:none; }
	main { padding:14px; gap:14px; }
	section { padding:14px; border-radius:10px; }
	.center { margin:4vh auto; }
	input[type=text], input[type=email], input[type=password], input[type=url], select { max-width:none; font-size:16px; }
	table.rt thead { display:none; }
	table.rt, table.rt tbody, table.rt tr, table.rt td { display:block; width:100%; }
	table.rt tr { border:1px solid var(--line); border-radius:10px; margin:10px 0; padding:4px 12px; }
	table.rt td { display:flex; gap:12px; align-items:center; justify-content:space-between; border:none; padding:7px 0; text-align:right; }
	table.rt td + td { border-top:1px dashed var(--line); }
	table.rt td::before { content:attr(data-label); color:var(--muted); font-size:12px; text-align:left; flex:0 0 32%; }
	table.rt td:empty { display:none; }
	table.rt td > form.row, table.rt td > .stack { flex:1; justify-content:flex-end; }
	td input[type=text], td input[type=email], td select { max-width:none; font-size:16px; }
	footer { padding:8px 14px 24px; }
}
`);

export type PageOptions = { t: Translate; nav?: boolean; script?: boolean; current?: string; path?: string };

function languageFooter(t: Translate, path = "/"): Html {
	const back = encodeURIComponent(path);
	return html`<footer><span>${t("nav.language")}:</span>${LOCALE_LIST.map(
		(locale) => html`<a href="/lang/${locale}?next=${back}" lang="${locale}" ${locale === t.locale ? "aria-current" : ""}>${LOCALES[locale]["lang.name"]}</a>`,
	)}</footer>`;
}

export function page(title: string, body: Html, options: PageOptions): Html {
	const { t } = options;
	const link = (href: string, key: MessageKey) => html`<a href="${href}" ${options.current === href ? "aria-current" : ""}>${t(key)}</a>`;
	return html`<!doctype html>
<html lang="${t.locale}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex" />
<meta name="theme-color" content="#f38020" />
<title>${title} · mailflare-alias</title>
<style>${STYLE}</style>
</head>
<body>
${options.nav
	? html`<header><a class="brand" href="/">mailflare-alias</a><nav>
${link("/", "nav.aliases")}${link("/blocklist", "nav.blocklist")}${link("/settings", "nav.settings")}${link("/connection", "nav.connection")}${link("/passkeys", "nav.passkeys")}
<form class="inline" method="post" action="/logout"><button>${t("nav.signOut")}</button></form></nav></header>`
	: ""}
${body}
${languageFooter(t, options.path)}
${options.script ? html`<script src="/assets/passkey.js"></script>` : ""}
</body>
</html>`;
}

function errorBox(t: Translate): Html {
	return html`<p class="error" data-error hidden></p><span hidden data-msg-unsupported="${t("passkey.unsupported")}" data-msg-cancelled="${t("passkey.cancelled")}"></span>`;
}

export function loginPage(t: Translate): Html {
	return page(
		t("login.title"),
		html`<main class="center"><section>
<h1>mailflare-alias</h1>
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

export function setupPage(t: Translate, input: { codeInLogs: boolean }): Html {
	return page(
		t("setup.title"),
		html`<main class="center"><section>
<h1>${t("setup.welcome")}</h1>
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

export function dashboardPage(
	t: Translate,
	input: { settings: Settings; aliases: (AliasRow & { contacts: number })[]; activity: ActivityItem[]; missing: MessageKey[]; notice?: string },
): Html {
	const { settings, aliases, activity, missing, notice } = input;
	return page(
		t("dash.title"),
		html`<main>
${noticeBox(notice)}
${missing.length
	? html`<p class="notice">${t("dash.notConnected", { missing: missing.map((key) => t(key)).join(", ") })} <a href="/connection">${t("dash.finishConnection")}</a></p>`
	: ""}
${!settings.defaultDestination ? html`<p class="notice">${t("dash.setDestination")} <a href="/settings">${t("dash.goToSettings")}</a></p>` : ""}
<section>
<h2>${t("dash.title")}</h2>
<p class="help">${t("dash.aliasesHelp")}</p>
${aliases.length === 0
	? html`<p class="muted">${t("dash.noAliases")}</p>`
	: html`<table class="rt">
<thead><tr><th>${t("dash.colAlias")}</th><th>${t("dash.colNote")}</th><th>${t("dash.colForwardTo")}</th><th>${t("dash.colMode")}</th><th>${t("dash.colContacts")}</th></tr></thead>
<tbody>
${aliases.map((alias) => {
	const base = `/aliases/${encodeURIComponent(alias.address)}`;
	return html`<tr>
<td data-label="${t("dash.colAlias")}"><a href="${base}"><code>${alias.address}</code></a></td>
<td data-label="${t("dash.colNote")}" class="muted">${alias.note ?? ""}</td>
<td data-label="${t("dash.colForwardTo")}"><form class="row" method="post" action="${base}/destination">
<input type="email" name="destination" value="${alias.destination ?? ""}" placeholder="${settings.defaultDestination || t("dash.default")}" aria-label="${t("dash.colForwardTo")}" />
<button>${t("common.save")}</button></form></td>
<td data-label="${t("dash.colMode")}"><form class="row" method="post" action="${base}/mode">
<select name="mode" aria-label="${t("dash.colMode")}">${FORWARD_MODES.map((mode) => html`<option value="${mode.value}" ${alias.forward_mode === mode.value ? "selected" : ""}>${t(`mode.${mode.value}`)}</option>`)}</select>
<button>${t("common.set")}</button></form></td>
<td data-label="${t("dash.colContacts")}">${alias.contacts}</td>
</tr>`;
})}
</tbody></table>`}
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

export function settingsPage(t: Translate, input: { settings: Settings; reverseDomain: string; notice?: string }): Html {
	const { settings, notice } = input;
	return page(
		t("settings.title"),
		html`<main>
${noticeBox(notice)}
<section>
<h2>${t("settings.section")}</h2>
<form method="post" action="/settings">
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

<label for="language">${t("settings.mailLanguage")}</label>
<select id="language" name="language">
${LOCALE_LIST.map((locale) => html`<option value="${locale}" ${settings.language === locale ? "selected" : ""}>${LOCALES[locale]["lang.name"]}</option>`)}
</select>

<label for="unsubscribeBehavior">${t("settings.unsubscribe")}</label>
<select id="unsubscribeBehavior" name="unsubscribeBehavior">
${UNSUBSCRIBE_BEHAVIORS.map((behavior) => html`<option value="${behavior}" ${settings.unsubscribeBehavior === behavior ? "selected" : ""}>${t(`unsub.${behavior}`)}</option>`)}
</select>
<p class="help">${t("settings.unsubscribeHelp")}<br />
${UNSUBSCRIBE_BEHAVIORS.map((behavior) => html`<b>${t(`unsub.${behavior}`)}:</b> ${t(`unsub.${behavior}.help`)}<br />`)}</p>

<p><button class="primary">${t("settings.saveButton")}</button></p>
</form>
</section>
</main>`,
		{ t, nav: true, current: "/settings", path: "/settings" },
	);
}

export function connectionPage(
	t: Translate,
	input: {
		values: { mailflareUrl: string; reverseDomain: string; publicUrl: string };
		hasApiKey: boolean;
		hasWebhookSecret: boolean;
		fixed: Set<string>;
		webhookUrl: string;
		missing: MessageKey[];
		notice?: string;
	},
): Html {
	const { values, hasApiKey, hasWebhookSecret, fixed, webhookUrl, missing, notice } = input;
	const fixedNote = (key: string) => (fixed.has(key) ? html`<p class="help">${t("conn.fixed")}</p>` : "");
	const disabled = (key: string) => (fixed.has(key) ? "disabled" : "");
	const secretField = (key: string, label: string, isSet: boolean, help: string) => html`
<label for="${key}">${label} ${isSet ? html`<span class="pill ok">${t("conn.isSet")}</span>` : html`<span class="pill bad">${t("conn.notSet")}</span>`}</label>
<input id="${key}" name="${key}" type="password" autocomplete="off" placeholder="${isSet ? t("conn.keepCurrent") : ""}" ${disabled(key)} />
<p class="help">${help}</p>${fixedNote(key)}`;
	return page(
		t("conn.title"),
		html`<main>
${noticeBox(notice)}
<section>
<h2>${t("conn.title")} ${missing.length ? html`<span class="pill bad">${t("conn.incomplete")}</span>` : html`<span class="pill ok">${t("conn.ready")}</span>`}</h2>
<form method="post" action="/connection">
<label for="mailflareUrl">${t("conn.mailflareUrl")}</label>
<input id="mailflareUrl" name="mailflareUrl" type="url" value="${values.mailflareUrl}" placeholder="https://mail.example.com" ${disabled("mailflareUrl")} />
<p class="help">${t("conn.mailflareUrlHelp")}</p>${fixedNote("mailflareUrl")}

${secretField("mailflareApiKey", t("conn.apiKey"), hasApiKey, t("conn.apiKeyHelp"))}
${secretField("webhookSecret", t("conn.webhookSecret"), hasWebhookSecret, t("conn.webhookSecretHelp", { url: webhookUrl }))}

<label for="reverseDomain">${t("conn.reverseDomain")}</label>
<input id="reverseDomain" name="reverseDomain" type="text" value="${values.reverseDomain}" placeholder="r.example.com" autocapitalize="none" ${disabled("reverseDomain")} />
<p class="help">${t("conn.reverseDomainHelp")}</p>${fixedNote("reverseDomain")}

<label for="publicUrl">${t("conn.publicUrl")}</label>
<input id="publicUrl" name="publicUrl" type="url" value="${values.publicUrl}" placeholder="https://alias.example.com" ${disabled("publicUrl")} />
<p class="help">${t("conn.publicUrlHelp")}</p>${fixedNote("publicUrl")}

<p><button class="primary">${t("conn.saveButton")}</button></p>
</form>
</section>
<section>
<h2>${t("conn.checklist")}</h2>
<ol class="steps">
<li>${t("conn.step1", { domain: values.reverseDomain || t("conn.theReverseDomain") })}</li>
<li>${t("conn.step2")}</li>
<li>${t("conn.step3")}</li>
</ol>
</section>
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
<form data-passkey="add" data-next="/passkeys?notice=${encodeURIComponent(t("notice.passkeyAdded"))}">
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
<form class="row" method="post" action="/blocklist" style="margin-top:12px">
<input name="value" type="text" placeholder="${t("bl.placeholder")}" autocapitalize="none" required aria-label="${t("bl.colSender")}" />
<button class="primary">${t("bl.block")}</button>
</form>
${entries.length === 0
	? html`<p class="muted">${t("bl.empty")}</p>`
	: html`<table class="rt" style="margin-top:12px"><thead><tr><th>${t("bl.colSender")}</th><th>${t("bl.colType")}</th><th>${t("bl.colHits")}</th><th>${t("bl.colAdded")}</th><th></th></tr></thead><tbody>
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

export function aliasPage(t: Translate, input: { alias: AliasRow; contacts: ContactRow[]; reverseDomain: string; notice?: string }): Html {
	const { alias, contacts, reverseDomain, notice } = input;
	const base = `/aliases/${encodeURIComponent(alias.address)}`;
	return page(
		alias.address,
		html`<main>
<p style="margin:0"><a href="/">${t("alias.back")}</a></p>
${noticeBox(notice)}
<section>
<h2><code>${alias.address}</code></h2>
<p class="help">${t("alias.mailbox")} <code>${alias.mailbox_id}</code> · ${t(`mode.${alias.forward_mode}`)}</p>
<form method="post" action="${base}/note">
<label for="note">${t("alias.note")}</label>
<div class="row"><input id="note" name="note" type="text" value="${alias.note ?? ""}" maxlength="200" placeholder="${t("alias.notePlaceholder")}" /><button>${t("common.save")}</button></div>
</form>
<form method="post" action="${base}/contacts">
<label for="email">${t("alias.writeNew")}</label>
<div class="row"><input id="email" name="email" type="email" placeholder="someone@example.com" required /><button class="primary">${t("alias.create")}</button></div>
<p class="help">${t("alias.writeNewHelp", { alias: alias.address })}</p>
</form>
</section>
<section>
<h2>${t("alias.contacts")}</h2>
${contacts.length === 0
	? html`<p class="muted">${t("alias.noContacts")}</p>`
	: html`<table class="rt"><thead><tr><th>${t("alias.colContact")}</th><th>${t("alias.colReverse")}</th><th>${t("alias.colForwarded")}</th><th>${t("alias.colReplied")}</th><th></th></tr></thead><tbody>
${contacts.map(
	(contact) => html`<tr>
<td data-label="${t("alias.colContact")}"><span class="stack">${contact.name ? html`${contact.name}<br />` : ""}<code>${contact.email}</code></span></td>
<td data-label="${t("alias.colReverse")}"><code>${contact.reverse_local}@${reverseDomain}</code></td>
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
