import { beforeEach, describe, expect, it } from "vitest";
import { signToken } from "../src/crypto";
import { app } from "../src/index";
import { LABEL_COLOURS, createLabel, setAliasLabels } from "../src/labels";
import { createRule } from "../src/rules";
import { loadSettings, saveSettings } from "../src/settings";
import { testDb } from "./helpers/d1";
import { signIn, TEST_SECRET } from "./helpers/session";

const ORIGIN = "https://alias.test";

let db: D1Database;
let env: Env;
let cookie: string;

const getHtml = async (path: string, extraHeaders: Record<string, string> = {}) => {
	const response = await app.fetch(new Request(`${ORIGIN}${path}`, { headers: { cookie, ...extraHeaders } }), env);
	return { status: response.status, html: await response.text() };
};

beforeEach(async () => {
	db = testDb();
	env = { DB: db, SIGNING_SECRET: TEST_SECRET } as unknown as Env;
	await saveSettings(db, {
		...(await loadSettings(db)),
		aliasDomains: ["a.test"],
		defaultDestination: "me@home.test",
		simpleloginApi: true,
		mcpServer: true,
	});
	await db.prepare("INSERT INTO config (key, value) VALUES ('siteOrigin', 'https://alias.test')").run();
	cookie = await signIn(db);
});

describe("UX, tactile feel, and visual polish", () => {
	it("styles textareas, file inputs, copy confirmation, reduced motion, and RTL arrows in app.css without inline styles", async () => {
		const css = await (await app.fetch(new Request(`${ORIGIN}/assets/app.css`), env)).text();
		expect(css).toContain("textarea, select");
		expect(css).toContain("textarea:focus");
		expect(css).toContain("input[type=file]::file-selector-button");
		expect(css).toContain("button.copy[data-copied]");
		expect(css).toContain("@media (prefers-reduced-motion: no-preference)");
		expect(css).toContain("table.aliases tbody tr:has(input[data-pick]:checked)");
		expect(css).toContain('[dir="rtl"] .arrow');
		expect(css).toContain(".table-wrap");

		const js = await (await app.fetch(new Request(`${ORIGIN}/assets/app.js`), env)).text();
		expect(js).not.toContain("style.setProperty");
		expect(js).toContain("data-act-type");
		expect(js).toContain("dataset.copied");
		expect(js).toContain("event.shiftKey");
		expect(js).toContain("Intl.DateTimeFormat");
	});

	it("renders error notices with .notice.bad and role=alert, distinct from success notices", async () => {
		const err = await getHtml("/settings?notice=notice.badDestination");
		expect(err.html).toContain('<p class="notice bad" role="alert">');

		const ok = await getHtml("/settings?notice=notice.settingsSaved");
		expect(ok.html).toContain('<p class="notice" role="status">');
		expect(ok.html).not.toContain('class="notice bad"');
	});

	it("keeps deleted aliases read-only in the list and offers Restore/Delete permanently on the detail page", async () => {
		await db
			.prepare(
				"INSERT INTO aliases (address, num_id, uid, note, forward_mode, forward_enabled, deleted_at, created_at, updated_at) VALUES ('gone@a.test', 1, 'u1', 'old note', 'none', 0, 100, 1, 100)",
			)
			.run();
		await db
			.prepare(
				"INSERT INTO aliases (address, num_id, uid, note, forward_mode, forward_enabled, created_at, updated_at) VALUES ('live@a.test', 2, 'u2', 'active note', 'all', 1, 2, 2)",
			)
			.run();
		await db
			.prepare("INSERT INTO contacts (id, alias_address, email, reverse_local, created_at) VALUES ('c1', 'live@a.test', 'bob@store.test', 'rbob', 10)")
			.run();

		const deletedList = await getHtml("/?filter=deleted");
		expect(deletedList.html).toContain('data-deleted="1"');
		expect(deletedList.html).toContain("gone@a.test");
		expect(deletedList.html).not.toContain('action="/aliases/gone%40a.test/note"');

		const deletedDetail = await getHtml("/aliases/gone%40a.test");
		expect(deletedDetail.html).toContain('<span class="pill bad">Deleted</span>');
		expect(deletedDetail.html).toContain('name="action" value="restore"');
		expect(deletedDetail.html).toContain('name="action" value="forget"');
		expect(deletedDetail.html).not.toContain('action="/aliases/gone%40a.test/contacts"');
		expect(deletedDetail.html).not.toContain('action="/aliases/gone%40a.test/note"');

		// Active alias detail page autosaves destination & mode and offers copy button for reverse aliases.
		const activeDetail = await getHtml("/aliases/live%40a.test");
		expect(activeDetail.html).toMatch(/action="\/aliases\/live%40a\.test\/destination" data-autosave/);
		expect(activeDetail.html).toMatch(/action="\/aliases\/live%40a\.test\/mode" data-autosave/);
		expect(activeDetail.html).toContain('data-copy="reply+rbob@r.a.test"');
	});

	it("uses a multi-line textarea on /blocklist so pasted lines are preserved", async () => {
		const page = await getHtml("/blocklist");
		expect(page.html).toContain('<textarea name="value" rows="2"');
		expect(page.html).not.toMatch(/<style|style="/);
	});

	it("disables hidden provider fields, hides key for Cloudflare, and provides live notices on /connection", async () => {
		const page = await getHtml("/connection");
		expect(page.html).toContain('data-provider="smtp" hidden');
		expect(page.html).toMatch(/id="smtpHost"[^>]*disabled/);
		expect(page.html).toContain("data-provider-key hidden");
		expect(page.html).toContain("data-free-notice");
		expect(page.html).toContain("data-brevo-notice");
		expect(page.html).toContain('action="/connection/cloudflare" data-busy');
		expect(page.html).toContain('data-copy="https://alias.test/webhook"');
	});

	it("always renders the direct-mode note on /settings for live toggling and avoids invalid label nesting", async () => {
		const page = await getHtml("/settings");
		expect(page.html).toContain("data-direct-note hidden");
		expect(page.html).not.toMatch(/<label class="check">(?:(?!<\/label>)[\s\S])*?<p class="help">/);
	});

	it("hides and disables action value inputs for valueless rule actions and scopes datalist to forwardTo", async () => {
		const rule = await createRule(db, {
			name: "Mixed",
			operator: "AND",
			conditions: [{ type: "sender", match: "contains", values: ["news"] }],
			actions: [
				{ type: "block", value: "" },
				{ type: "subject", value: "[Tag]" },
				{ type: "forwardTo", value: "me@home.test" },
			],
			forwards: true,
			replies: false,
			sends: false,
			active: true,
		});
		const page = await getHtml(`/rules/${rule.id}`);
		expect(page.html).toMatch(/name="act_value_0"[^>]*hidden disabled/);
		expect(page.html).not.toMatch(/name="act_value_0"[^>]*list="rule-destinations"/);
		expect(page.html).toMatch(/name="act_value_1"[^>]*value="\[Tag\]"/);
		expect(page.html).not.toMatch(/name="act_value_1"[^>]*list="rule-destinations"/);
		expect(page.html).not.toMatch(/name="act_value_1"[^>]*disabled/);
		expect(page.html).toMatch(/name="act_value_2"[^>]*list="rule-destinations"/);
	});

	it("adds one-tap copy buttons on /api-keys for server URL, MCP URL, and newly created key", async () => {
		const created = await app.fetch(
			new Request(`${ORIGIN}/api-keys`, {
				method: "POST",
				headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
				body: "name=Ext&scope=apps",
			}),
			env,
		);
		const html = await created.text();
		expect(html).toContain(`data-copy="${ORIGIN}"`);
		expect(html).toContain(`data-copy="${ORIGIN}/mcp"`);
		expect(html).toMatch(/data-copy="af_[^"]+"/);
	});

	it("maps custom API label colours to palette CSS data-colour values without inline styles", async () => {
		const custom = await createLabel(db, { name: "CustomRed", colour: "#ff0000" });
		await db
			.prepare("INSERT INTO aliases (address, num_id, uid, forward_mode, forward_enabled, created_at, updated_at) VALUES ('red@a.test', 1, 'u1', 'all', 1, 1, 1)")
			.run();
		await setAliasLabels(db, ["red@a.test"], [custom.id]);

		const dash = await getHtml("/");
		const match = dash.html.match(/class="label-chip"[^>]*data-colour="(#[0-9a-f]{6})"/);
		expect(match).not.toBeNull();
		expect((LABEL_COLOURS as readonly string[]).includes(match![1]!)).toBe(true);
		expect(dash.html).not.toMatch(/<style|style="/);
	});

	it("keeps language switcher on /unsubscribe/:token and hides dead-end CTA when fallback is none", async () => {
		await saveSettings(db, {
			...(await loadSettings(db)),
			unsubscribeBehavior: "preserve_original",
			unsubscribeFallback: "none",
		});
		await db
			.prepare("INSERT INTO aliases (address, num_id, uid, forward_mode, forward_enabled, created_at, updated_at) VALUES ('news@a.test', 1, 'u1', 'all', 1, 1, 1)")
			.run();
		await db
			.prepare("INSERT INTO contacts (id, alias_address, email, reverse_local, created_at) VALUES ('c1', 'news@a.test', 'sender@shop.test', 'r1', 1)")
			.run();
		await db
			.prepare("INSERT INTO forwards (id, inbound_id, alias_address, contact_id, status, created_at, updated_at) VALUES ('fw1', 'm1', 'news@a.test', 'c1', 'sent', 1, 1)")
			.run();

		const token = await signToken(TEST_SECRET, "unsubscribe", "fw1", 600);
		const response = await app.fetch(new Request(`${ORIGIN}/unsubscribe/${token}`), env);
		const html = await response.text();
		expect(response.status).toBe(200);
		expect(html).toContain(`name="next" value="/unsubscribe/${token}"`);
		expect(html).not.toContain('<form method="post"><button class="primary">');
	});
});
