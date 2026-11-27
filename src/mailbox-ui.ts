/**
 * Dashboard Webmail UI for aliasflare's built-in mailbox (and optional Mailflare view).
 * Uses strict <iframe sandbox=""> isolation for HTML email previews so scripts and external
 * tracking pixels never run inside the dashboard.
 */
import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { Email } from "postal-mime";
import type { Translate } from "./i18n";
import { MAILBOX_FOLDERS, type MailboxFolder, type MailboxFolderStats, type MailboxMessage } from "./mailbox";
import type { MailflareEmailSummary } from "./mailflare";
import { noticeBox, page, type Notice } from "./ui";

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

function fmtTime(epoch: number, locale: string): string {
	if (!epoch) return "—";
	try {
		return new Date(epoch * 1000).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" });
	} catch {
		return new Date(epoch * 1000).toISOString().slice(0, 16).replace("T", " ");
	}
}

function fmtBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function mailboxListPage(
	t: Translate,
	input: {
		folder: MailboxFolder | "all";
		source: "local" | "mailflare";
		messages: MailboxMessage[];
		mailflareMessages?: MailflareEmailSummary[];
		mailflareError?: string;
		mailflareEnabled: boolean;
		stats: MailboxFolderStats;
		storageBackend: string;
		query: string;
		page: number;
		lastPage: number;
		total: number;
		notice?: Notice;
	},
): Html {
	const { folder, source, messages, mailflareMessages, mailflareError, mailflareEnabled, stats, storageBackend, query, page: cur, lastPage, total, notice } = input;
	const folderHref = (f: MailboxFolder | "all") => `/mailbox?folder=${encodeURIComponent(f)}${query ? `&q=${encodeURIComponent(query)}` : ""}`;
	const totalNonTrash = stats.INBOX.total + stats.Skipped.total + stats.Failed.total + stats.Sent.total;
	const unreadNonTrash = stats.INBOX.unread + stats.Skipped.unread + stats.Failed.unread + stats.Sent.unread;

	return page(
		t("mb.title"),
		html`<main>
${noticeBox(notice)}
<section>
<div class="row">
<h2 class="m0">${t("mb.title")}</h2>
<span class="pill">${storageBackend.toUpperCase()}</span>
<span class="spacer"></span>
<a href="/mailbox/compose"><button type="button" class="primary">${t("mb.compose")}</button></a>
</div>
<p class="help">${t("mb.help")}</p>

<nav class="jump mt12" aria-label="${t("mb.folders")}">
<a href="${folderHref("all")}" ${source === "local" && folder === "all" ? html`aria-current="page"` : ""}>${t("mb.folder.all")} (${totalNonTrash}${unreadNonTrash ? ` · ${unreadNonTrash}` : ""})</a>
${MAILBOX_FOLDERS.map(
	(f) =>
		html`<a href="${folderHref(f)}" ${source === "local" && folder === f ? html`aria-current="page"` : ""}>${t(`mb.folder.${f}`)} (${stats[f].total}${stats[f].unread ? ` · ${stats[f].unread}` : ""})</a>`,
)}
${mailflareEnabled ? html`<a href="/mailbox?source=mailflare" ${source === "mailflare" ? html`aria-current="page"` : ""}>Mailflare</a>` : ""}
</nav>

${source === "mailflare"
	? html`${mailflareError ? html`<p class="notice bad">${mailflareError}</p>` : ""}
${!mailflareMessages?.length
	? html`<p class="muted mt12">${t("mb.empty")}</p>`
	: html`<div class="table-wrap"><table class="rt mt12"><thead><tr><th>${t("mb.colFrom")}</th><th>${t("mb.colSubject")}</th><th>${t("mb.colTo")}</th><th>${t("dash.colWhen")}</th></tr></thead><tbody>
${mailflareMessages.map(
	(m) => html`<tr>
<td data-label="${t("mb.colFrom")}">${m.from || "—"}</td>
<td data-label="${t("mb.colSubject")}"><b>${m.subject}</b><div class="muted">${m.preview}</div></td>
<td data-label="${t("mb.colTo")}"><code>${m.to}</code></td>
<td data-label="${t("dash.colWhen")}">${m.receivedAt.slice(0, 16).replace("T", " ")}</td>
</tr>`,
)}
</tbody></table></div>`}`
	: html`<form class="toolbar" method="get" action="/mailbox" role="search">
<input type="hidden" name="folder" value="${folder}" />
<input type="search" name="q" value="${query}" placeholder="${t("mb.searchPlaceholder")}" aria-label="${t("dash.search")}" />
<button>${t("dash.searchButton")}</button>
${folder === "Trash" || folder === "Skipped"
	? html`<button type="submit" form="empty-folder-form" class="danger">${t("mb.emptyFolder")}</button>`
	: ""}
</form>
${folder === "Trash" || folder === "Skipped"
	? html`<form id="empty-folder-form" method="post" action="/mailbox/empty" data-confirm="${t("mb.confirmEmpty")}"><input type="hidden" name="folder" value="${folder}" /></form>`
	: ""}
<p class="muted">${t("activity.results", { count: String(total) })}${query ? html` · <a href="${folderHref(folder).replace(/&q=.*$/, "")}">${t("dash.clear")}</a>` : ""}</p>

${messages.length === 0
	? html`<p class="muted mt12">${t("mb.empty")}</p>`
	: html`<div class="table-wrap"><table class="rt mt12"><thead><tr><th>${t("mb.colFrom")}</th><th>${t("mb.colSubject")}</th><th>${t("mb.colAlias")}</th><th>${t("mb.colFolder")}</th><th>${t("dash.colWhen")}</th></tr></thead><tbody>
${messages.map((msg) => {
	const unread = !msg.flags.includes("\\Seen");
	return html`<tr>
<td data-label="${t("mb.colFrom")}">${unread ? html`<b>${msg.from_name || msg.from_address || "—"}</b>` : (msg.from_name || msg.from_address || "—")}</td>
<td data-label="${t("mb.colSubject")}"><a href="/mailbox/${encodeURIComponent(msg.id)}">${unread ? html`<b>${msg.subject}</b>` : msg.subject}</a>${msg.reason_detail ? html` <span class="pill ${msg.folder === "Failed" ? "bad" : ""}">${msg.reason_detail.slice(0, 80)}</span>` : ""}${msg.snippet ? html`<div class="muted">${msg.snippet.slice(0, 120)}</div>` : ""}</td>
<td data-label="${t("mb.colAlias")}">${msg.alias_address ? html`<code>${msg.alias_address}</code>` : "—"}</td>
<td data-label="${t("mb.colFolder")}"><span class="pill">${t(`mb.folder.${msg.folder}`)}</span></td>
<td data-label="${t("dash.colWhen")}">${fmtTime(msg.created_at, t.locale)}</td>
</tr>`;
})}
</tbody></table></div>
${lastPage > 1
	? html`<nav class="pager" aria-label="${t("dash.pages")}">
${cur > 1 ? html`<a class="pg" href="/mailbox?folder=${encodeURIComponent(folder)}&page=${cur - 1}${query ? `&q=${encodeURIComponent(query)}` : ""}">← ${t("dash.prev")}</a>` : html`<span class="pg" aria-disabled="true">← ${t("dash.prev")}</span>`}
<span class="at">${cur} / ${lastPage}</span>
${cur < lastPage ? html`<a class="pg" href="/mailbox?folder=${encodeURIComponent(folder)}&page=${cur + 1}${query ? `&q=${encodeURIComponent(query)}` : ""}">${t("dash.next")} →</a>` : html`<span class="pg" aria-disabled="true">${t("dash.next")} →</span>`}
</nav>`
	: ""}`}`}
</section>
</main>`,
		{ t, nav: true, current: "/mailbox", path: `/mailbox?folder=${encodeURIComponent(folder)}` },
	);
}

export function mailboxDetailPage(
	t: Translate,
	input: {
		message: MailboxMessage;
		parsed: Email | null;
		hasRaw: boolean;
		notice?: Notice;
	},
): Html {
	const { message, parsed, hasRaw, notice } = input;
	const seen = message.flags.includes("\\Seen");
	const base = `/mailbox/${encodeURIComponent(message.id)}`;
	const attachments = parsed?.attachments ?? [];
	const replyHref =
		message.alias_address && message.from_address
			? `/mailbox/compose?from=${encodeURIComponent(message.alias_address)}&to=${encodeURIComponent(message.from_address)}&subject=${encodeURIComponent(message.subject.toLowerCase().startsWith("re:") ? message.subject : `Re: ${message.subject}`)}`
			: "/mailbox/compose";

	return page(
		message.subject,
		html`<main>
<p class="m0"><a href="/mailbox?folder=${encodeURIComponent(message.folder)}"><span class="arrow" aria-hidden="true">←</span> ${t("mb.title")}</a></p>
${noticeBox(notice)}
<section>
<h2>${message.subject}</h2>
<p class="help">
<b>${t("mb.colFrom")}:</b> <code>${message.from_name ? `${message.from_name} <${message.from_address}>` : message.from_address || "—"}</code> ·
<b>${t("mb.colTo")}:</b> <code>${message.to_address || "—"}</code> ·
<b>${t("dash.colWhen")}:</b> ${fmtTime(message.created_at, t.locale)} ·
<b>${fmtBytes(message.size_bytes)}</b> (${message.storage_kind})
</p>
${message.reason_detail ? html`<p class="notice ${message.folder === "Failed" ? "bad" : ""}">${t(`mb.folder.${message.folder}`)}: ${message.reason_detail}</p>` : ""}

<div class="row mt12">
${hasRaw && message.alias_address && message.folder !== "Sent" ? html`<form class="inline" method="post" action="${base}/resend"><button class="primary">${t("mb.resend")}</button></form>` : ""}
<a href="${replyHref}"><button type="button">${t("mb.reply")}</button></a>
<form class="inline" method="post" action="${base}/read"><input type="hidden" name="seen" value="${seen ? "0" : "1"}" /><button>${seen ? t("mb.markUnread") : t("mb.markRead")}</button></form>
${hasRaw ? html`<a href="${base}/raw"><button type="button">${t("mb.downloadEml")}</button></a>` : ""}
${message.folder !== "Trash"
	? html`<form class="inline" method="post" action="${base}/move"><input type="hidden" name="folder" value="Trash" /><button class="danger">${t("mb.moveTrash")}</button></form>`
	: html`<form class="inline" method="post" action="${base}/move"><input type="hidden" name="folder" value="INBOX" /><button>${t("mb.moveInbox")}</button></form>
<form class="inline" method="post" action="${base}/delete" data-confirm="${t("mb.confirmDelete")}"><button class="danger">${t("bulk.forget")}</button></form>`}
</div>
</section>

${attachments.length > 0
	? html`<section>
<h3>${t("mb.attachments")} (${attachments.length})</h3>
<ul class="results">
${attachments.map(
	(att, idx) =>
		html`<li><a href="${base}/attachment/${idx}">${att.filename || `attachment-${idx + 1}`}</a> <span class="muted">(${att.mimeType || "application/octet-stream"})</span></li>`,
)}
</ul>
</section>`
	: ""}

<section>
${parsed?.html
	? html`<iframe class="mb-frame" title="${message.subject}" src="${base}/html" sandbox="" referrerpolicy="no-referrer"></iframe>`
	: ""}
${parsed?.text
	? html`<details ${parsed?.html ? "" : "open"}><summary>${t("mb.plainText")}</summary><pre class="mono mb-pre">${parsed.text}</pre></details>`
	: !parsed?.html
		? html`<p class="muted">${message.snippet || t("mb.headersOnly")}</p>${message.raw_headers ? html`<pre class="mono mb-pre">${message.raw_headers}</pre>` : ""}`
		: ""}
</section>
</main>`,
		{ t, nav: true, current: "/mailbox", path: base },
	);
}

export function mailboxComposePage(
	t: Translate,
	input: {
		aliases: string[];
		from: string;
		to: string;
		subject: string;
		text: string;
		notice?: Notice;
	},
): Html {
	const { aliases, from, to, subject, text, notice } = input;
	return page(
		t("mb.compose"),
		html`<main>
<p class="m0"><a href="/mailbox"><span class="arrow" aria-hidden="true">←</span> ${t("mb.title")}</a></p>
${noticeBox(notice)}
<section>
<h2>${t("mb.compose")}</h2>
<form class="compose" method="post" action="/mailbox/compose">
<div><label for="composeFrom">${t("mb.colFrom")}</label>
<input id="composeFrom" name="from" type="email" value="${from}" required list="composeFromList" autocomplete="off" spellcheck="false" data-recipient-search="/mailbox/senders" />
<datalist id="composeFromList">${aliases.map((addr) => html`<option value="${addr}"></option>`)}</datalist></div>
<div><label for="composeTo">${t("mb.colTo")}</label>
<input id="composeTo" name="to" type="email" value="${to}" required placeholder="recipient@example.com" list="composeToList" autocomplete="off" data-recipient-search="/mailbox/recipients" data-focus-search data-from-select="composeFrom" />
<datalist id="composeToList"></datalist></div>
<div class="wide"><label for="composeSubject">${t("mb.colSubject")}</label>
<input id="composeSubject" name="subject" type="text" value="${subject}" maxlength="500" required /></div>
<div class="wide"><label for="composeBody">${t("mb.body")}</label>
<textarea id="composeBody" name="text" rows="10" required>${text}</textarea></div>
<p class="mt12 wide"><button class="primary">${t("mb.send")}</button></p>
</form>
</section>
</main>`,
		{ t, nav: true, current: "/mailbox", path: "/mailbox/compose" },
	);
}
