/**
 * Sets up Cloudflare for the reverse-alias domain from the dashboard, so nobody has to click
 * through Email Routing and Email Sending by hand:
 *
 * 1. find the zone the domain belongs to;
 * 2. enable Email Routing on the domain (MX and SPF records);
 * 3. turn on subaddressing, so reply+<anything>@domain matches the rule for reply@domain;
 * 4. route reply@domain to this Worker (one rule covers every reverse alias);
 * 5. onboard the domain for Email Sending, which forwarded copies are sent with.
 *
 * Catch-all rules only exist on apex domains, and a subdomain allows 200 literal rules, which is
 * why reverse aliases use plus addressing instead of one rule each.
 *
 * Token permissions, for the zone: Zone: Read, Zone Settings: Edit, Email Routing Rules: Edit and
 * Email Sending: Edit.
 */
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

export type SetupStep = { step: "zone" | "routing" | "subaddress" | "rule" | "sending"; ok: boolean; detail: string };

type Rule = { id: string; enabled: boolean; matchers: { type: string; field?: string; value?: string }[]; actions: { type: string; value?: string[] }[] };

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
		const rules = await cf<Rule[]>(token, `/zones/${zoneId}/email/routing/rules?page=${page}&per_page=50`);
		const match = rules.find((rule) => rule.matchers.some((m) => m.type === "literal" && m.value?.toLowerCase() === address));
		if (match) return match;
		if (rules.length < 50) return null;
	}
	return null;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const alreadyDone = (error: unknown) => /already|exist/i.test(message(error));

export async function setUpCloudflare(input: { token: string; reverseDomain: string; workerName: string }): Promise<SetupStep[]> {
	const { token, reverseDomain, workerName } = input;
	const steps: SetupStep[] = [];

	let zone: { id: string; name: string } | null = null;
	try {
		zone = await findZone(token, reverseDomain);
		steps.push(zone ? { step: "zone", ok: true, detail: zone.name } : { step: "zone", ok: false, detail: `No zone found for ${reverseDomain} with this token.` });
	} catch (error) {
		steps.push({ step: "zone", ok: false, detail: message(error) });
	}
	if (!zone) return steps;

	try {
		const isApex = zone.name === reverseDomain;
		await cf(token, `/zones/${zone.id}/email/routing/dns`, { method: "POST", ...(isApex ? {} : { body: JSON.stringify({ name: reverseDomain }) }) });
		steps.push({ step: "routing", ok: true, detail: reverseDomain });
	} catch (error) {
		steps.push({ step: "routing", ok: alreadyDone(error), detail: alreadyDone(error) ? reverseDomain : message(error) });
	}

	try {
		await cf(token, `/zones/${zone.id}/email/routing`, { method: "PATCH", body: JSON.stringify({ support_subaddress: true }) });
		steps.push({ step: "subaddress", ok: true, detail: zone.name });
	} catch (error) {
		steps.push({ step: "subaddress", ok: false, detail: message(error) });
	}

	const address = `${REVERSE_BASE}@${reverseDomain}`;
	try {
		const rule = {
			actions: [{ type: "worker", value: [workerName] }],
			matchers: [{ type: "literal", field: "to", value: address }],
			enabled: true,
			name: `mailflare-alias reverse aliases (${address})`,
		};
		const existing = await findRule(token, zone.id, address);
		if (existing) {
			await cf(token, `/zones/${zone.id}/email/routing/rules/${existing.id}`, { method: "PUT", body: JSON.stringify(rule) });
		} else {
			await cf(token, `/zones/${zone.id}/email/routing/rules`, { method: "POST", body: JSON.stringify(rule) });
		}
		steps.push({ step: "rule", ok: true, detail: `${address} → ${workerName}` });
	} catch (error) {
		steps.push({ step: "rule", ok: false, detail: message(error) });
	}

	try {
		// Creating also re-enables an existing sending domain, so it is safe to repeat.
		await cf(token, `/zones/${zone.id}/email/sending/subdomains`, { method: "POST", body: JSON.stringify({ name: reverseDomain }) });
		steps.push({ step: "sending", ok: true, detail: reverseDomain });
	} catch (error) {
		steps.push({ step: "sending", ok: alreadyDone(error), detail: alreadyDone(error) ? reverseDomain : message(error) });
	}
	return steps;
}
