/**
 * Sets up Cloudflare for each alias domain from the dashboard, so nobody has to click through
 * Email Routing and Email Sending by hand. For an alias domain a.com:
 *
 * 1. find the zone a.com belongs to;
 * 2. enable Email Routing on a.com and send its catch-all to this Worker, so mail to any
 *    address there arrives here (an existing catch-all that goes elsewhere is left alone);
 * 3. enable Email Routing on r.a.com, the reverse-alias domain of a.com;
 * 4. turn on subaddressing, so reply+<anything>@r.a.com matches the rule for reply@r.a.com;
 * 5. route reply@r.a.com to this Worker (one rule covers every reverse alias of the domain);
 * 6. onboard r.a.com and a.com for Email Sending: forwarded copies come from r.a.com, replies
 *    from the alias itself.
 *
 * Catch-all rules only exist on a zone's apex, and a subdomain allows 200 literal rules, which
 * is why reverse aliases use plus addressing and alias domains must be a zone apex here. An
 * alias domain on a subdomain can still be received by Mailflare instead.
 *
 * Token permissions, for each zone: Zone: Read, Zone Settings: Edit, Email Routing Rules: Edit
 * and Email Sending: Edit.
 */
import { reverseDomainFor } from "./domains";
import { REVERSE_BASE } from "./format";

const API = "https://api.cloudflare.com/client/v4";

type CfEnvelope<T> = { success: boolean; errors?: { code: number; message: string }[]; result: T };

export class CloudflareError extends Error {
	constructor(
		message: string,
		readonly codes: number[],
	) {
		super(message);
	}
}

async function cf<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
	const response = await fetch(`${API}${path}`, {
		...init,
		redirect: "manual",
		signal: AbortSignal.timeout(15_000),
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
	});
	let body: CfEnvelope<T> | null = null;
	try {
		body = (await response.json()) as CfEnvelope<T>;
	} catch {
		// Not JSON; reported below.
	}
	if (!response.ok || !body?.success) {
		const errors = body?.errors ?? [];
		const message = errors.map((error) => `${error.message} (${error.code})`).join("; ") || `HTTP ${response.status}`;
		throw new CloudflareError(message, errors.map((error) => error.code));
	}
	return body.result;
}

export type SetupStepName = "zone" | "catchall" | "routing" | "subaddress" | "rule" | "sending";
export type SetupStep = { step: SetupStepName; ok: boolean; detail: string };
export type DomainSetup = { domain: string; steps: SetupStep[] };

type Action = { type: string; value?: string[] };
type Rule = { id: string; enabled: boolean; matchers: { type: string; field?: string; value?: string }[]; actions: Action[] };

/** The domain and its parents, longest first: r.mail.example.com, mail.example.com, example.com. */
export function zoneCandidates(domain: string): string[] {
	const labels = domain.split(".");
	const out: string[] = [];
	for (let i = 0; i <= labels.length - 2; i += 1) out.push(labels.slice(i).join("."));
	return out;
}

async function findZone(token: string, domain: string): Promise<{ id: string; name: string } | null> {
	for (const name of zoneCandidates(domain)) {
		const zones = await cf<{ id: string; name: string }[]>(token, `/zones?name=${encodeURIComponent(name)}`);
		if (zones[0]) return zones[0];
	}
	return null;
}

async function findRule(token: string, zoneId: string, address: string): Promise<Rule | null> {
	for (let page = 1; page <= 10; page += 1) {
		const rules = await cf<Rule[]>(token, `/zones/${encodeURIComponent(zoneId)}/email/routing/rules?page=${page}&per_page=50`);
		const match = rules.find((rule) => rule.matchers.some((m) => m.type === "literal" && m.value?.toLowerCase() === address));
		if (match) return match;
		if (rules.length < 50) return null;
	}
	return null;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
// Only "already exists / enabled / configured" counts as done, not any message with "exist" in it.
const alreadyDone = (error: unknown) => /\balready (exists?|enabled|configured|added|in use)\b|\bduplicate\b/i.test(message(error));
const toWorker = (actions: Action[], workerName: string) => actions.some((action) => action.type === "worker" && action.value?.includes(workerName));

/** Enables Email Routing for a domain: the zone apex, or a subdomain of it. */
async function enableRouting(token: string, zone: { id: string; name: string }, domain: string): Promise<void> {
	try {
		await cf(token, `/zones/${encodeURIComponent(zone.id)}/email/routing/dns`, {
			method: "POST",
			...(zone.name === domain ? {} : { body: JSON.stringify({ name: domain }) }),
		});
	} catch (error) {
		if (!alreadyDone(error)) throw error;
	}
}

async function enableSending(token: string, zoneId: string, domain: string): Promise<void> {
	try {
		// Creating also re-enables an existing sending domain, so it is safe to repeat.
		await cf(token, `/zones/${encodeURIComponent(zoneId)}/email/sending/subdomains`, { method: "POST", body: JSON.stringify({ name: domain }) });
	} catch (error) {
		if (!alreadyDone(error)) throw error;
	}
}

export async function setUpDomain(input: { token: string; domain: string; workerName: string; replaceCatchAll?: boolean }): Promise<DomainSetup> {
	const { token, domain, workerName } = input;
	const reverseDomain = reverseDomainFor(domain);
	const steps: SetupStep[] = [];
	const attempt = async (step: SetupStepName, run: () => Promise<string>) => {
		try {
			steps.push({ step, ok: true, detail: await run() });
		} catch (error) {
			steps.push({ step, ok: false, detail: message(error) });
		}
	};

	let zone: { id: string; name: string } | null = null;
	try {
		zone = await findZone(token, domain);
		steps.push(zone ? { step: "zone", ok: true, detail: zone.name } : { step: "zone", ok: false, detail: `No zone found for ${domain} with this token.` });
	} catch (error) {
		steps.push({ step: "zone", ok: false, detail: message(error) });
	}
	if (!zone) return { domain, steps };
	const zonePath = `/zones/${encodeURIComponent(zone.id)}`;
	const found = zone;

	await attempt("catchall", async () => {
		if (found.name !== domain) {
			throw new Error(`Catch-all rules only exist on a zone's apex (${found.name}). Use the apex as the alias domain, or let Mailflare receive ${domain}.`);
		}
		await enableRouting(token, found, domain);
		const current = await cf<Rule>(token, `${zonePath}/email/routing/rules/catch_all`).catch(() => null);
		if (current?.enabled && !toWorker(current.actions, workerName) && !input.replaceCatchAll) {
			const where = current.actions.map((action) => [action.type, ...(action.value ?? [])].join(" ")).join(", ");
			throw new Error(`The catch-all of ${domain} already sends mail elsewhere (${where}); it was left unchanged. If this domain is only for aliases, tick “Replace existing catch-alls” and run the setup again.`);
		}
		await cf(token, `${zonePath}/email/routing/rules/catch_all`, {
			method: "PUT",
			body: JSON.stringify({ actions: [{ type: "worker", value: [workerName] }], matchers: [{ type: "all" }], enabled: true, name: "aliasflare aliases" }),
		});
		return `*@${domain} → ${workerName}`;
	});

	await attempt("routing", async () => {
		await enableRouting(token, found, reverseDomain);
		return reverseDomain;
	});

	await attempt("subaddress", async () => {
		await cf(token, `${zonePath}/email/routing`, { method: "PATCH", body: JSON.stringify({ support_subaddress: true }) });
		return found.name;
	});

	const address = `${REVERSE_BASE}@${reverseDomain}`;
	await attempt("rule", async () => {
		const rule = {
			actions: [{ type: "worker", value: [workerName] }],
			matchers: [{ type: "literal", field: "to", value: address }],
			enabled: true,
			name: `aliasflare reverse aliases (${address})`,
		};
		const existing = await findRule(token, found.id, address);
		if (existing) await cf(token, `${zonePath}/email/routing/rules/${encodeURIComponent(existing.id)}`, { method: "PUT", body: JSON.stringify(rule) });
		else await cf(token, `${zonePath}/email/routing/rules`, { method: "POST", body: JSON.stringify(rule) });
		return `${address} → ${workerName}`;
	});

	await attempt("sending", async () => {
		await enableSending(token, found.id, reverseDomain);
		await enableSending(token, found.id, domain);
		return `${reverseDomain}, ${domain}`;
	});
	return { domain, steps };
}

export async function setUpCloudflare(input: { token: string; domains: string[]; workerName: string; replaceCatchAll?: boolean }): Promise<DomainSetup[]> {
	const results: DomainSetup[] = [];
	for (const domain of input.domains) results.push(await setUpDomain({ token: input.token, domain, workerName: input.workerName, replaceCatchAll: input.replaceCatchAll }));
	return results;
}
