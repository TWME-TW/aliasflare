import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiKey } from "../src/apikeys";
import worker, { app } from "../src/index";
import { cleanupMailbox, LOCAL_MAILBOX_ADDRESS, readMailboxRaw } from "../src/mailbox";
import { loadSettings, saveSettings } from "../src/settings";
import { signS3Request, testS3Connection } from "../src/storage";
import { testDb } from "./helpers/d1";
import { signIn, TEST_SECRET } from "./helpers/session";

let db: D1Database;
let env: Env;
let key: string;
let sent: unknown[];
let failSend = false;

const ORIGIN = "https://alias.test";

const apiCall = async (path: string, method = "GET", body?: unknown) => {
	const response = await app.fetch(
		new Request(`${ORIGIN}/api${path}`, {
			method,
			headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
		env,
	);
	return { status: response.status, response, json: response.headers.get("content-type")?.includes("json") ? ((await response.json()) as any) : null };
};

async function deliver(to: string, opts: { from?: string; subject?: string; text?: string; html?: string; extraHeaders?: string[] } = {}) {
	const from = opts.from ?? "bob@store.test";
	const raw = [
		`From: Bob <${from}>`,
		`To: ${to}`,
		`Subject: ${opts.subject ?? "Hello"}`,
		`Message-ID: <${crypto.randomUUID()}@x>`,
		...(opts.extraHeaders ?? []),
		"MIME-Version: 1.0",
		...(opts.html
			? ["Content-Type: text/html; charset=UTF-8", "", opts.html]
			: ["Content-Type: text/plain; charset=UTF-8", "", opts.text ?? "Sample body text"]),
	].join("\r\n");
	let rejected: string | null = null;
	try {
		await worker.email!(
			{
				to,
				from,
				headers: new Headers({ From: from, To: to, Subject: opts.subject ?? "Hello" }),
				raw: new Response(raw).body,
				rawSize: raw.length,
				setReject: (why: string) => void (rejected = why),
				forward: async () => undefined,
			} as never,
			env,
		);
	} catch {
		// Expected when forwarding fails (500 retry throw).
	}
	return rejected;
}

beforeEach(async () => {
	db = testDb();
	sent = [];
	failSend = false;
	env = {
		DB: db,
		SIGNING_SECRET: TEST_SECRET,
		EMAIL: {
			send: async (message: unknown) => {
				if (failSend) throw new Error("upstream mailbox full");
				sent.push(message);
				return { messageId: `<s${sent.length}@test>` };
			},
		},
	} as unknown as Env;
	await saveSettings(db, { ...(await loadSettings(db)), addyApi: true, aliasDomains: ["a.test"], defaultDestination: "me@home.test" });
	await db.prepare("INSERT INTO config (key, value) VALUES ('siteOrigin', ?)").bind(ORIGIN).run();
	({ key } = await createApiKey(db, "addy-app", "apps"));
});

afterEach(() => vi.unstubAllGlobals());

describe("built-in mailbox default capture of skipped and failed messages", () => {
	it("captures skipped (alias off, promotions, blocklist, rule block) and failed deliveries by default", async () => {
		// 1. Disabled alias -> stored in Skipped
		await db
			.prepare("INSERT INTO aliases (address, num_id, uid, forward_mode, forward_enabled, created_at, updated_at) VALUES ('off@a.test', 1, 'u1', 'none', 0, 1, 1)")
			.run();
		await deliver("off@a.test", { subject: "When off" });

		// 2. Promotional email on no_promotions alias -> stored in Skipped
		await db
			.prepare("INSERT INTO aliases (address, num_id, uid, forward_mode, forward_enabled, created_at, updated_at) VALUES ('promo@a.test', 2, 'u2', 'no_promotions', 1, 1, 1)")
			.run();
		await deliver("promo@a.test", { subject: "Sale!", extraHeaders: ["List-Unsubscribe: <https://x.test/u>"] });

		// 3. Blocklisted sender -> stored in Skipped
		await db.prepare("INSERT INTO blocklist (id, kind, value, created_at) VALUES ('bl_1', 'domain', 'spam.test', 1)").run();
		await deliver("shop@a.test", { from: "bad@spam.test", subject: "Spam offer" });

		// 4. Failed delivery -> stored in Failed and downloadable / resendable via addy.io API
		failSend = true;
		await deliver("shop@a.test", { subject: "Important receipt", text: "Receipt #99" });

		const skipped = await db.prepare("SELECT subject, reason, storage_kind FROM mailbox_messages WHERE folder = 'Skipped' ORDER BY uid ASC").all();
		expect(skipped.results).toHaveLength(3);
		expect(skipped.results.map((r: any) => r.reason)).toEqual(["alias_off", "promotions", "blocked_sender"]);
		expect(skipped.results.every((r: any) => r.storage_kind === "d1")).toBe(true);

		const failedList = await apiCall("/v1/failed-deliveries");
		expect(failedList.status).toBe(200);
		expect(failedList.json.data).toHaveLength(1);
		const failedId = failedList.json.data[0].id;
		expect(failedList.json.data[0]).toMatchObject({ is_stored: true, resent: false, recipient_email: "me@home.test" });

		// Download .eml from addy.io API
		const dl = await apiCall(`/v1/failed-deliveries/${failedId}/download`);
		expect(dl.status).toBe(200);
		expect(dl.response.headers.get("content-type")).toBe("message/rfc822");
		expect(await dl.response.text()).toContain("Receipt #99");

		// Fix upstream and resend via addy.io API
		failSend = false;
		const resent = await apiCall(`/v1/failed-deliveries/${failedId}/resend`, "POST");
		expect(resent.status).toBe(200);
		expect(sent).toHaveLength(1);
		expect((await apiCall(`/v1/failed-deliveries/${failedId}`)).json.data.resent).toBe(true);
	});

	it("stores direct local-mailbox aliases and rule store/quarantine actions without external forwarding", async () => {
		await db
			.prepare("INSERT INTO aliases (address, num_id, uid, forward_mode, forward_enabled, destination, created_at, updated_at) VALUES ('local@a.test', 10, 'u10', 'all', 1, ?, 1, 1)")
			.bind(LOCAL_MAILBOX_ADDRESS)
			.run();
		await deliver("local@a.test", { subject: "Direct local inbox" });
		expect(sent).toHaveLength(0);

		await apiCall("/v1/rules", "POST", {
			name: "Quarantine ads",
			conditions: [{ type: "subject", match: "contains", values: ["newsletter"] }],
			actions: [{ type: "quarantine" }],
		});
		await deliver("shop@a.test", { subject: "Weekly newsletter" });
		expect(sent).toHaveLength(0);

		const inbox = await db.prepare("SELECT subject, folder FROM mailbox_messages ORDER BY folder").all();
		expect(inbox.results).toEqual([
			{ subject: "Direct local inbox", folder: "INBOX" },
			{ subject: "Weekly newsletter", folder: "Skipped" },
		]);
	});
});

describe("R2, S3-compatible object storage, and D1 fallback", () => {
	it("prefers R2 binding when present and deletes blobs on cleanup", async () => {
		const r2Store = new Map<string, Uint8Array>();
		(env as any).MAILBOX_BUCKET = {
			put: async (k: string, v: Uint8Array) => void r2Store.set(k, v),
			get: async (k: string) => (r2Store.has(k) ? { arrayBuffer: async () => r2Store.get(k)!.slice().buffer } : null),
			delete: async (k: string) => void r2Store.delete(k),
		};
		await db
			.prepare("INSERT INTO aliases (address, num_id, uid, forward_mode, forward_enabled, created_at, updated_at) VALUES ('off@a.test', 1, 'u1', 'none', 0, 1, 1)")
			.run();
		await deliver("off@a.test", { subject: "Stored in R2", text: "Hello R2" });
		expect(r2Store.size).toBe(1);
		const row = (await db.prepare("SELECT * FROM mailbox_messages").first()) as any;
		expect(row.storage_kind).toBe("r2");
		const raw = await readMailboxRaw(env, { mailboxS3: { endpoint: "", bucket: "", region: "auto", accessKeyId: "", secretAccessKey: "", pathStyle: true, prefix: "" } } as any, row);
		expect(new TextDecoder().decode(raw!)).toContain("Hello R2");

		// Retention cleanup deletes both DB row and R2 object.
		const settings = await loadSettings(db);
		const removed = await cleanupMailbox(env, { mailboxS3: { endpoint: "", bucket: "", region: "auto", accessKeyId: "", secretAccessKey: "", pathStyle: true, prefix: "" } } as any, settings, row.created_at + 40 * 86400);
		expect(removed).toBe(1);
		expect(r2Store.size).toBe(0);
	});

	it("signs and round-trips S3-compatible requests (B2 / S3 / MinIO / R2 S3 API)", async () => {
		const s3Store = new Map<string, Uint8Array>();
		vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			if (method === "PUT") {
				s3Store.set(url, new Uint8Array(init?.body as Uint8Array));
				return new Response(null, { status: 200 });
			}
			if (method === "GET") {
				const found = s3Store.get(url);
				return found ? new Response(found as BodyInit, { status: 200 }) : new Response("Not Found", { status: 404 });
			}
			if (method === "DELETE") {
				s3Store.delete(url);
				return new Response(null, { status: 204 });
			}
			return new Response("bad", { status: 405 });
		});

		const s3 = {
			endpoint: "https://s3.us-west-004.backblazeb2.com",
			bucket: "my-mail",
			region: "us-west-004",
			accessKeyId: "AKIAEXAMPLE",
			secretAccessKey: "SECRETKEYEXAMPLE",
			pathStyle: true,
			prefix: "aliasflare/",
		};
		const signed = await signS3Request({ method: "PUT", s3, key: "aliasflare/raw/test.eml", body: new TextEncoder().encode("hi") });
		expect(signed.url).toBe("https://s3.us-west-004.backblazeb2.com/my-mail/aliasflare/raw/test.eml");
		expect(signed.headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/us-west-004\/s3\/aws4_request/);

		const probe = await testS3Connection(s3);
		expect(probe.ok).toBe(true);

		// Configure S3 on config table and verify mailbox stores & reads via S3.
		await db.batch([
			db.prepare("INSERT INTO config (key, value) VALUES ('mailboxS3Endpoint', ?)").bind(s3.endpoint),
			db.prepare("INSERT INTO config (key, value) VALUES ('mailboxS3Bucket', ?)").bind(s3.bucket),
			db.prepare("INSERT INTO config (key, value) VALUES ('mailboxS3Region', ?)").bind(s3.region),
			db.prepare("INSERT INTO config (key, value) VALUES ('mailboxS3AccessKeyId', ?)").bind(s3.accessKeyId),
			db.prepare("INSERT INTO config (key, value) VALUES ('mailboxS3SecretAccessKey', ?)").bind(s3.secretAccessKey),
		]);
		await db
			.prepare("INSERT INTO aliases (address, num_id, uid, forward_mode, forward_enabled, created_at, updated_at) VALUES ('off@a.test', 1, 'u1', 'none', 0, 1, 1)")
			.run();
		await deliver("off@a.test", { subject: "Stored in B2", text: "Hello S3" });
		const row = (await db.prepare("SELECT storage_kind, storage_key FROM mailbox_messages").first()) as any;
		expect(row.storage_kind).toBe("s3");
		expect(row.storage_key).toMatch(/^aliasflare\/raw\/mb_/);
		expect(s3Store.size).toBe(1);
	});
});

describe("dashboard Webmail UI, sandboxed HTML preview & compose", () => {
	it("renders mailbox list, structured search, sandboxed HTML iframe, and composes from alias", async () => {
		const cookie = await signIn(db);
		await db
			.prepare("INSERT INTO aliases (address, num_id, uid, forward_mode, forward_enabled, created_at, updated_at) VALUES ('off@a.test', 1, 'u1', 'none', 0, 1, 1), ('shop@a.test', 2, 'u2', 'all', 1, 1, 1)")
			.run();
		await deliver("off@a.test", { subject: "HTML Test", html: "<p>Hello</p><script>alert(1)</script>" });

		const listRes = await app.fetch(new Request(`${ORIGIN}/mailbox?folder=Skipped&q=subject:HTML+is:unread`, { headers: { cookie } }), env);
		expect(listRes.status).toBe(200);
		expect(await listRes.text()).toContain("HTML Test");

		const msg = (await db.prepare("SELECT id FROM mailbox_messages").first<{ id: string }>())!;
		const detailRes = await app.fetch(new Request(`${ORIGIN}/mailbox/${msg.id}`, { headers: { cookie } }), env);
		const detailHtml = await detailRes.text();
		expect(detailHtml).toContain(`src="/mailbox/${msg.id}/html"`);
		expect(detailHtml).toContain('sandbox=""');

		const iframeRes = await app.fetch(new Request(`${ORIGIN}/mailbox/${msg.id}/html`, { headers: { cookie } }), env);
		expect(iframeRes.headers.get("content-security-policy")).toContain("default-src 'none'");

		// Compose & send from alias -> stored in Sent.
		const composeRes = await app.fetch(
			new Request(`${ORIGIN}/mailbox/compose`, {
				method: "POST",
				headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ from: "shop@a.test", to: "friend@outside.test", subject: "Hi from webmail", text: "Body here" }),
			}),
			env,
		);
		expect(composeRes.status).toBe(302);
		expect(sent).toHaveLength(1);
		const sentRow = await db.prepare("SELECT folder, subject FROM mailbox_messages WHERE folder = 'Sent'").first();
		expect(sentRow).toEqual({ folder: "Sent", subject: "Hi from webmail" });
	});
});
