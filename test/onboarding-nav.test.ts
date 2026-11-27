import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { detectCustomDomains, isSharedProviderDomain } from "../src/importer";
import { loadSettings, saveSettings } from "../src/settings";
import { testDb } from "./helpers/d1";
import { signIn, TEST_SECRET } from "./helpers/session";

const ORIGIN = "https://alias.test";

let db: D1Database;
let env: Env;
let cookie: string;

const getHtml = async (path: string) => {
	const response = await app.fetch(new Request(`${ORIGIN}${path}`, { headers: { cookie } }), env);
	return { status: response.status, html: await response.text() };
};

const postForm = (path: string, form: Record<string, string>, extraHeaders: Record<string, string> = {}) =>
	app.fetch(
		new Request(`${ORIGIN}${path}`, {
			method: "POST",
			headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded", ...extraHeaders },
			body: new URLSearchParams(form),
		}),
		env,
	);

beforeEach(async () => {
	db = testDb();
	env = { DB: db, SIGNING_SECRET: TEST_SECRET } as unknown as Env;
	cookie = await signIn(db);
});

afterEach(() => vi.unstubAllGlobals());

describe("Guided onboarding wizard & streamlined domain setup", () => {
	it("points /setup next URL to /onboarding and dashboard incomplete banner to /onboarding", async () => {
		const freshDb = testDb();
		const freshEnv = { DB: freshDb, SIGNING_SECRET: TEST_SECRET } as unknown as Env;
		const setupHtml = await (await app.fetch(new Request(`${ORIGIN}/setup`), freshEnv)).text();
		expect(setupHtml).toContain('data-next="/onboarding"');

		const dash = await getHtml("/");
		expect(dash.status).toBe(200);
		expect(dash.html).toContain('href="/onboarding"');
	});

	it("saves alias domains, destination, and plan in step 1 and advances to step 2 when Cloudflare token is omitted", async () => {
		const res = await postForm("/onboarding/domains", {
			aliasDomains: "a.test, b.test",
			defaultDestination: "me@home.test",
			workersPlan: "paid",
			intent: "save",
		});
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toContain("/onboarding?step=2");
		const settings = await loadSettings(db);
		expect(settings.aliasDomains).toEqual(["a.test", "b.test"]);
		expect(settings.defaultDestination).toBe("me@home.test");
	});

	it("saves domains and runs Cloudflare automatic setup in a single submit on /onboarding/domains", async () => {
		vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
			const path = new URL(url).pathname.replace("/client/v4", "");
			const method = init.method ?? "GET";
			const ok = (result: unknown) => Response.json({ success: true, result });
			if (path === "/zones") return ok([{ id: "z1", name: "a.test", account: { id: "acc1" } }]);
			if (path.endsWith("/catch_all") && method === "GET") return new Response("", { status: 404 });
			if (path.endsWith("/email/routing/rules") && method === "GET") return ok([]);
			return ok({});
		});

		const res = await postForm("/onboarding/domains", {
			aliasDomains: "a.test",
			defaultDestination: "me@home.test",
			cloudflareApiToken: "cf-tok-123",
			intent: "cloudflare",
		});
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("<code>a.test</code>");
		expect(html).toContain('href="/onboarding?step=2"');
		expect((await loadSettings(db)).aliasDomains).toEqual(["a.test"]);
		// Cloudflare API token is never persisted in D1.
		const storedTok = await db.prepare("SELECT value FROM config WHERE key = 'cloudflareApiToken'").first();
		expect(storedTok).toBeNull();
	});

	it("auto-detects custom domains during onboarding CSV import, skips shared provider domains, and adds them to aliasDomains", async () => {
		expect(isSharedProviderDomain("simplelogin.com")).toBe(true);
		expect(isSharedProviderDomain("user.anonaddy.me")).toBe(true);
		expect(isSharedProviderDomain("mycustom.test")).toBe(false);

		const detected = detectCustomDomains([
			{ email: "a@simplelogin.com" } as never,
			{ email: "b@user.anonaddy.me" } as never,
			{ email: "shop@mycustom.test" } as never,
			{ email: "reply@r.mycustom.test" } as never,
		]);
		expect(detected).toEqual(["mycustom.test"]);

		const csv = "alias,note,enabled\nshop@mycustom.test,Store,true\nfoo@simplelogin.com,Shared,true\n";
		const form = new FormData();
		form.set("domains", "");
		form.set("addDomains", "1");
		form.set("file", new File([csv], "aliases.csv", { type: "text/csv" }));

		const res = await app.fetch(
			new Request(`${ORIGIN}/onboarding/import/csv`, {
				method: "POST",
				headers: { cookie, origin: ORIGIN },
				body: form,
			}),
			env,
		);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("mycustom.test");
		expect(html).toContain("simplelogin.com");
		expect((await loadSettings(db)).aliasDomains).toEqual(["mycustom.test"]);
		const alias = await db.prepare("SELECT address FROM aliases WHERE address = 'shop@mycustom.test'").first<{ address: string }>();
		expect(alias?.address).toBe("shop@mycustom.test");
	});

	it("allows entering alias domains inline on POST /connection/cloudflare without visiting /settings first", async () => {
		vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
			const path = new URL(url).pathname.replace("/client/v4", "");
			const method = init.method ?? "GET";
			const ok = (result: unknown) => Response.json({ success: true, result });
			if (path === "/zones") return ok([{ id: "z1", name: "fresh.test", account: { id: "acc1" } }]);
			if (path.endsWith("/catch_all") && method === "GET") return new Response("", { status: 404 });
			if (path.endsWith("/email/routing/rules") && method === "GET") return ok([]);
			return ok({});
		});

		const connPage = await getHtml("/connection");
		expect(connPage.html).toContain('name="aliasDomains"');
		expect(connPage.html).not.toContain("data-stay-disabled");

		const res = await postForm("/connection/cloudflare", {
			aliasDomains: "fresh.test",
			cloudflareApiToken: "tok",
		});
		expect(res.status).toBe(200);
		expect((await loadSettings(db)).aliasDomains).toEqual(["fresh.test"]);
	});
});

describe("Simplified 5-item sidebar, sub-tabs, and reordered settings", () => {
	it("renders 5 top-level sidebar links and contextual sub-tabs with zero inline styles", async () => {
		const dash = await getHtml("/");
		const sidebar = dash.html.slice(dash.html.indexOf('<nav class="sidebar"'), dash.html.indexOf("</nav>", dash.html.indexOf('<nav class="sidebar"')));
		const links = [...sidebar.matchAll(/<a href="(\/[^"]*)"/g)].map((m) => m[1]);
		expect(links).toEqual(["/", "/mailbox", "/activity", "/rules", "/settings"]);

		// Filters & labels subnav appears on /rules, /labels, /blocklist
		for (const path of ["/rules", "/labels", "/blocklist"]) {
			const page = await getHtml(path);
			expect(page.status).toBe(200);
			expect(page.html).toContain('<nav class="subnav"');
			expect(page.html).toContain('href="/rules"');
			expect(page.html).toContain('href="/labels"');
			expect(page.html).toContain('href="/blocklist"');
			expect(page.html).not.toMatch(/<style|style="/);
		}

		// Settings 6-tab subnav appears across all Settings subpages
		for (const path of ["/settings", "/connection", "/settings/mailbox", "/api-keys", "/encryption", "/passkeys", "/import"]) {
			const page = await getHtml(path);
			expect(page.status).toBe(200);
			expect(page.html).toContain('<nav class="subnav"');
			expect(page.html).toContain('href="/settings/mailbox"');
			expect(page.html).not.toMatch(/<style|style="/);
		}

		// Security & encryption pages include secondary PGP / Passkeys switcher
		const enc = await getHtml("/encryption");
		expect(enc.html).toContain('class="subnav-secondary"');
		expect(enc.html).toContain('href="/passkeys"');
		const pk = await getHtml("/passkeys");
		expect(pk.html).toContain('class="subnav-secondary"');
		expect(pk.html).toContain('href="/encryption"');
	});

	it("orders /settings with Domains & destination first and Display & language last", async () => {
		const { html } = await getHtml("/settings");
		const domainsPos = html.indexOf('<section id="domains">');
		const forwardingPos = html.indexOf('<section id="forwarding">');
		const unsubPos = html.indexOf('<section id="unsubscribe">');
		const clientsPos = html.indexOf('<section id="clients">');
		const langPos = html.indexOf('<section id="language-settings">');
		expect(domainsPos).toBeGreaterThan(-1);
		expect(domainsPos).toBeLessThan(forwardingPos);
		expect(forwardingPos).toBeLessThan(unsubPos);
		expect(unsubPos).toBeLessThan(clientsPos);
		expect(clientsPos).toBeLessThan(langPos);
	});

	it("saves mailbox & protocol settings on /settings/mailbox without clobbering general settings, and vice versa", async () => {
		await saveSettings(db, {
			...(await loadSettings(db)),
			aliasDomains: ["a.test"],
			defaultDestination: "me@home.test",
			imapEnabled: false,
		});

		// Enable IMAP & change retention via /settings/mailbox autosave
		const mbSave = await postForm(
			"/settings/mailbox",
			{
				mailboxSettingsShown: "1",
				mailboxEnabled: "1",
				storeFailed: "1",
				storeSkippedAliasOff: "1",
				storeSkippedPromotions: "1",
				storeSkippedRuleBlock: "1",
				storeSkippedBlockedSender: "1",
				storeSentCopy: "1",
				mailboxRetentionDays: "45",
				mailboxMaxMessageKb: "1024",
				mailboxQuotaMb: "200",
				mailboxQuotaPolicy: "evict_oldest",
				mailboxStorageBackend: "auto",
				imapEnabled: "1",
				"pop3Folder:INBOX": "1",
				pop3DeleteAction: "trash",
				smtpFromPolicy: "existing_aliases",
				smtpRateLimitPerHour: "60",
			},
			{ "X-Autosave": "1" },
		);
		expect(mbSave.status).toBe(200);
		let s = await loadSettings(db);
		expect(s.imapEnabled).toBe(true);
		expect(s.mailboxRetentionDays).toBe(45);
		expect(s.aliasDomains).toEqual(["a.test"]);
		expect(s.defaultDestination).toBe("me@home.test");

		// Save general settings on /settings without mailboxSettingsShown → IMAP stays enabled!
		const genSave = await postForm(
			"/settings",
			{
				aliasDomains: "a.test",
				defaultDestination: "me@home.test",
				forwardMethod: "rewrite",
				senderFormat: "AT",
				bannerLocation: "top",
				spamWarningBehaviour: "both",
				unsubscribeBehavior: "disable_alias",
				unsubscribeFallback: "block_contact",
				randomAliasFormat: "random_words",
				aliasSeparator: ".",
				language: "en",
			},
			{ "X-Autosave": "1" },
		);
		expect(genSave.status).toBe(200);
		s = await loadSettings(db);
		expect(s.imapEnabled).toBe(true);
		expect(s.mailboxRetentionDays).toBe(45);
	});
});
