import { afterEach, describe, expect, it, vi } from "vitest";
import { setUpDomain } from "../src/cloudflare";

/** A Cloudflare API whose catch-all for a.test already goes to the Worker "mailflare". */
function stubApi(workerDomains: { id: string; hostname: string; service: string }[] = []) {
	const writes: { method: string; path: string; body: unknown }[] = [];
	vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
		const path = new URL(url).pathname.replace("/client/v4", "");
		const hostname = new URL(url).searchParams.get("hostname");
		const method = init.method ?? "GET";
		if (method !== "GET") writes.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : null });
		const ok = (result: unknown) => Response.json({ success: true, result });
		if (path === "/zones") return ok([{ id: "z1", name: "a.test", account: { id: "acc1" } }]);
		if (path === "/accounts/acc1/workers/domains" && method === "GET") return ok(workerDomains.filter((entry) => entry.hostname === hostname));
		if (path.endsWith("/catch_all") && method === "GET") return ok({ id: "ca", enabled: true, matchers: [{ type: "all" }], actions: [{ type: "worker", value: ["mailflare"] }] });
		if (path.endsWith("/email/routing/rules") && method === "GET") return ok([]);
		return ok({});
	});
	return writes;
}

afterEach(() => vi.unstubAllGlobals());

describe("Cloudflare setup", () => {
	it("leaves a catch-all that goes elsewhere alone, but still sets up the reverse-alias domain", async () => {
		const writes = stubApi();
		const { steps } = await setUpDomain({ token: "t", domain: "a.test", workerName: "aliasflare" });
		expect(steps.find((step) => step.step === "catchall")).toMatchObject({ ok: false });
		expect(writes.some((write) => write.path.endsWith("/catch_all"))).toBe(false);
		expect(steps.filter((step) => step.step !== "catchall").every((step) => step.ok)).toBe(true);
	});

	it("points the catch-all at this Worker when asked to replace it", async () => {
		const writes = stubApi();
		const { steps } = await setUpDomain({ token: "t", domain: "a.test", workerName: "aliasflare", replaceCatchAll: true });
		expect(steps.find((step) => step.step === "catchall")).toMatchObject({ ok: true });
		const put = writes.find((write) => write.path.endsWith("/catch_all"));
		expect(put?.body).toMatchObject({ enabled: true, actions: [{ type: "worker", value: ["aliasflare"] }] });
	});

	it("attaches openpgpkey.<domain> only when asked, and leaves one on another Worker alone", async () => {
		let writes = stubApi();
		let { steps } = await setUpDomain({ token: "t", domain: "a.test", workerName: "aliasflare" });
		expect(steps.some((step) => step.step === "wkd")).toBe(false);
		expect(writes.some((write) => write.path.includes("/workers/domains"))).toBe(false);

		({ steps } = await setUpDomain({ token: "t", domain: "a.test", workerName: "aliasflare", wkdHost: true }));
		expect(steps.find((step) => step.step === "wkd")).toMatchObject({ ok: true, detail: "openpgpkey.a.test → aliasflare" });
		expect(writes.find((write) => write.path === "/accounts/acc1/workers/domains")).toMatchObject({ method: "PUT", body: { hostname: "openpgpkey.a.test", service: "aliasflare", zone_id: "z1" } });

		// Already on this Worker: nothing to change. On another Worker: refused, unchanged.
		writes = stubApi([{ id: "d1", hostname: "openpgpkey.a.test", service: "aliasflare" }]);
		({ steps } = await setUpDomain({ token: "t", domain: "a.test", workerName: "aliasflare", wkdHost: true }));
		expect(steps.find((step) => step.step === "wkd")).toMatchObject({ ok: true });
		expect(writes.some((write) => write.path.includes("/workers/domains"))).toBe(false);
		writes = stubApi([{ id: "d1", hostname: "openpgpkey.a.test", service: "website" }]);
		({ steps } = await setUpDomain({ token: "t", domain: "a.test", workerName: "aliasflare", wkdHost: true }));
		expect(steps.find((step) => step.step === "wkd")).toMatchObject({ ok: false });
		expect(writes.some((write) => write.path.includes("/workers/domains"))).toBe(false);
	});
});
