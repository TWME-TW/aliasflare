/**
 * Rules (addy.io's): conditions on the sender, subject or alias, and actions on mail that
 * matches. Rules run in order; every matching rule's actions apply, a later one overriding an
 * earlier one's value. Matching is on plain text, case-insensitively; there are no regular
 * expressions, so no rule can make a message slow to check.
 */
import { extractEmail, normalizeEmail, safeHttpsUrl } from "./format";
import { newId, now } from "./db";
import { hmacHex } from "./crypto";

export const CONDITION_TYPES = ["sender", "subject", "alias"] as const;
export const MATCHES = ["is exactly", "is not", "contains", "does not contain", "starts with", "does not start with", "ends with", "does not end with"] as const;
export const ACTION_TYPES = ["block", "subject", "displayFrom", "forwardTo", "removeAttachments", "banner", "webhook"] as const;
/** Actions that act on replies too; the others only make sense for forwarded mail. */
export const REPLY_ACTIONS: readonly ActionType[] = ["block", "subject", "removeAttachments"];

export type ConditionType = (typeof CONDITION_TYPES)[number];
export type Match = (typeof MATCHES)[number];
export type ActionType = (typeof ACTION_TYPES)[number];
export type Condition = { type: ConditionType; match: Match; values: string[] };
export type Action = { type: ActionType; value: string };

export type RuleRow = {
	id: string;
	name: string;
	position: number;
	operator: "AND" | "OR";
	conditions: string;
	actions: string;
	forwards: number;
	replies: number;
	sends: number;
	active: number;
	applied: number;
	last_applied: number | null;
	created_at: number;
	updated_at: number;
};

export type Rule = Omit<RuleRow, "conditions" | "actions"> & { conditions: Condition[]; actions: Action[] };

export type RuleInput = {
	name: string;
	operator: "AND" | "OR";
	conditions: Condition[];
	actions: Action[];
	forwards: boolean;
	replies: boolean;
	sends: boolean;
	active: boolean;
};

export const MAX_RULES = 50;
export const MAX_CONDITIONS = 10;
const MAX_ACTIONS = 10;
export const MAX_VALUES = 20;
export const MAX_VALUE_LENGTH = 200;
export const MAX_RULE_NAME = 60;
export const MAX_WEBHOOK_URL = 500;
/** Webhooks one message can call, however many rules match. */
const MAX_WEBHOOKS = 3;

export class RuleError extends Error {
	constructor(readonly reason: "invalid" | "limit" | "missing" | "forwardTo" | "webhook" | "unsupported") {
		super(reason);
	}
}

const text = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : "");

/**
 * A condition as given, or null when it has no values. Anything aliasflare cannot test as given
 * (addy.io's regular expressions, too many or too long values) refuses the whole rule: leaving
 * part of it out would make a rule match other mail than its author meant.
 */
function cleanCondition(raw: unknown): Condition | null {
	if (!raw || typeof raw !== "object") throw new RuleError("unsupported");
	const { type, match, values } = raw as Record<string, unknown>;
	// Several values: an array from the apps, one per line from the dashboard.
	const given = (Array.isArray(values) ? values : typeof values === "string" ? values.split(/\r?\n/) : [])
		.map((value) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim() : typeof value === "number" ? String(value) : ""))
		.filter(Boolean);
	if (!given.length) return null;
	if (!CONDITION_TYPES.includes(type as ConditionType) || !MATCHES.includes(match as Match)) throw new RuleError("unsupported");
	const list = [...new Set(given.map((value) => value.toLowerCase()))];
	if (list.length > MAX_VALUES || list.some((value) => value.length > MAX_VALUE_LENGTH)) throw new RuleError("unsupported");
	return { type: type as ConditionType, match: match as Match, values: list };
}

function cleanAction(raw: unknown, ownHosts: string[]): Action | null {
	if (!raw || typeof raw !== "object") throw new RuleError("unsupported");
	const { type, value } = raw as Record<string, unknown>;
	// addy.io's encryption and description changes are not done here.
	if (!ACTION_TYPES.includes(type as ActionType)) throw new RuleError("unsupported");
	const kind = type as ActionType;
	if (kind === "block" || kind === "removeAttachments") return { type: kind, value: "true" };
	// Only hiding the banner: addy.io's top and bottom places are both "shown" here.
	if (kind === "banner") return value === "off" ? { type: kind, value: "off" } : null;
	if (kind === "webhook") {
		// A public https address: never a private network, a port, credentials in the URL, or this
		// deployment's own host — a webhook back into aliasflare would have every matching message
		// call itself again, once per delivery. The other places an owner-entered address is called
		// block their own hosts the same way (see outbound.ts).
		const raw = typeof value === "string" ? value.trim() : "";
		if (!raw) return null;
		const url = raw.length <= MAX_WEBHOOK_URL ? safeHttpsUrl(raw, ownHosts) : null;
		if (!url) throw new RuleError("webhook");
		return { type: kind, value: url.href };
	}
	const cleaned = text(typeof value === "number" ? String(value) : value, kind === "displayFrom" ? 100 : MAX_VALUE_LENGTH);
	if (!cleaned) return null;
	if (kind === "forwardTo") {
		const email = extractEmail(cleaned);
		if (!email) throw new RuleError("forwardTo");
		return { type: kind, value: email };
	}
	return { type: kind, value: cleaned };
}

/** Checks a rule from a form or an app. A rule needs a name, a condition and an action. */
export function cleanRule(raw: Record<string, unknown>, ownHosts: string[] = []): RuleInput {
	const name = text(raw.name, MAX_RULE_NAME);
	const rawConditions = Array.isArray(raw.conditions) ? raw.conditions : [];
	const rawActions = Array.isArray(raw.actions) ? raw.actions : [];
	if (rawConditions.length > MAX_CONDITIONS || rawActions.length > MAX_ACTIONS) throw new RuleError("unsupported");
	const conditions = rawConditions.map(cleanCondition).filter((c): c is Condition => !!c);
	const actions = rawActions.map((action) => cleanAction(action, ownHosts)).filter((a): a is Action => !!a);
	if (!name || !conditions.length || !actions.length) throw new RuleError("invalid");
	const rawOp = raw.operator === undefined || raw.operator === null || raw.operator === "" ? "AND" : String(raw.operator).trim().toUpperCase();
	if (rawOp !== "AND" && rawOp !== "OR") throw new RuleError("invalid");
	const flag = (value: unknown, fallback: boolean) => (value === undefined ? fallback : value === true || value === 1 || value === "1" || value === "true" || value === "on");
	return {
		name,
		operator: rawOp,
		conditions,
		actions,
		forwards: flag(raw.forwards, true),
		replies: flag(raw.replies, false),
		sends: flag(raw.sends, false),
		active: flag(raw.active, true),
	};
}

function parse(row: RuleRow): Rule {
	const json = <T>(value: string): T[] => {
		try {
			const parsed = JSON.parse(value);
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	};
	return { ...row, conditions: json<Condition>(row.conditions), actions: json<Action>(row.actions) };
}

export async function listRules(db: D1Database): Promise<Rule[]> {
	const { results } = await db.prepare("SELECT * FROM rules ORDER BY position, created_at").all<RuleRow>();
	return results.map(parse);
}

export async function getRule(db: D1Database, id: string): Promise<Rule | null> {
	const row = await db.prepare("SELECT * FROM rules WHERE id = ?").bind(id).first<RuleRow>();
	return row ? parse(row) : null;
}

export async function createRule(db: D1Database, input: RuleInput): Promise<Rule> {
	const id = newId("rl");
	const timestamp = now();
	// Enforce MAX_RULES and compute the next position atomically inside the INSERT.
	const result = await db
		.prepare(
			`INSERT INTO rules (id, name, position, operator, conditions, actions, forwards, replies, sends, active, created_at, updated_at)
			 SELECT ?, ?, COALESCE(MAX(position), -1) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?
			 FROM rules
			 HAVING COUNT(*) < ?`,
		)
		.bind(
			id,
			input.name,
			input.operator,
			JSON.stringify(input.conditions),
			JSON.stringify(input.actions),
			+input.forwards,
			+input.replies,
			+input.sends,
			+input.active,
			timestamp,
			timestamp,
			MAX_RULES,
		)
		.run();
	if (!result.meta.changes) throw new RuleError("limit");
	return (await getRule(db, id))!;
}

/**
 * Adds rules after the existing ones, in two queries whatever their number (an import may run on
 * the Workers Free plan's 50). Stops at MAX_RULES; returns how many were added.
 */
export async function insertRules(db: D1Database, inputs: RuleInput[]): Promise<number> {
	if (!inputs.length) return 0;
	const count = await db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(position), -1) AS top FROM rules").first<{ n: number; top: number }>();
	const room = Math.max(0, MAX_RULES - Number(count?.n ?? 0));
	const timestamp = now();
	const statements = inputs.slice(0, room).map((input, index) =>
		db
			.prepare(
				"INSERT INTO rules (id, name, position, operator, conditions, actions, forwards, replies, sends, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.bind(newId("rl"), input.name, Number(count?.top ?? -1) + 1 + index, input.operator, JSON.stringify(input.conditions), JSON.stringify(input.actions), +input.forwards, +input.replies, +input.sends, +input.active, timestamp, timestamp),
	);
	if (statements.length) await db.batch(statements);
	return statements.length;
}

export async function updateRule(db: D1Database, id: string, input: RuleInput): Promise<Rule> {
	const result = await db
		.prepare("UPDATE rules SET name = ?, operator = ?, conditions = ?, actions = ?, forwards = ?, replies = ?, sends = ?, active = ?, updated_at = ? WHERE id = ?")
		.bind(input.name, input.operator, JSON.stringify(input.conditions), JSON.stringify(input.actions), +input.forwards, +input.replies, +input.sends, +input.active, now(), id)
		.run();
	if (!result.meta.changes) throw new RuleError("missing");
	return (await getRule(db, id))!;
}

export async function setRuleActive(db: D1Database, id: string, active: boolean): Promise<boolean> {
	const result = await db.prepare("UPDATE rules SET active = ?, updated_at = ? WHERE id = ?").bind(+active, now(), id).run();
	return (result.meta.changes ?? 0) > 0;
}

export async function deleteRule(db: D1Database, id: string): Promise<boolean> {
	const result = await db.prepare("DELETE FROM rules WHERE id = ?").bind(id).run();
	return (result.meta.changes ?? 0) > 0;
}

/** Puts the rules in this order; rules left out keep their place after them. */
export async function reorderRules(db: D1Database, ids: string[]): Promise<void> {
	const rules = await listRules(db);
	const known = new Set(rules.map((rule) => rule.id));
	const first = [...new Set(ids)].filter((id) => known.has(id));
	const order = [...first, ...rules.map((rule) => rule.id).filter((id) => !first.includes(id))];
	if (order.length) await db.batch(order.map((id, position) => db.prepare("UPDATE rules SET position = ? WHERE id = ?").bind(position, id)));
}

/** Moves a rule one place up (-1) or down (+1). */
export async function moveRule(db: D1Database, id: string, step: -1 | 1): Promise<void> {
	const ids = (await listRules(db)).map((rule) => rule.id);
	const at = ids.indexOf(id);
	const to = at + step;
	if (at < 0 || to < 0 || to >= ids.length) return;
	[ids[at], ids[to]] = [ids[to]!, ids[at]!];
	await reorderRules(db, ids);
}

function test(match: Match, subject: string, value: string): boolean {
	switch (match) {
		case "is exactly":
			return subject === value;
		case "is not":
			return subject !== value;
		case "contains":
			return subject.includes(value);
		case "does not contain":
			return !subject.includes(value);
		case "starts with":
			return subject.startsWith(value);
		case "does not start with":
			return !subject.startsWith(value);
		case "ends with":
			return subject.endsWith(value);
		case "does not end with":
			return !subject.endsWith(value);
	}
}

export type RuleMessage = { sender: string; senders?: string[]; envelopeSender?: string | null; spoofed?: boolean; subject: string; alias: string };

const MAX_RULE_SUBJECT_LENGTH = 8192;

type NormalizedMessage = { sender: string; alias: string; subject: string };

function normalizeSubject(subject: string): string {
	return subject.slice(0, MAX_RULE_SUBJECT_LENGTH).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().toLowerCase();
}

function normalizeMessage(message: RuleMessage): NormalizedMessage {
	return {
		sender: normalizeEmail(message.sender),
		alias: normalizeEmail(message.alias),
		subject: normalizeSubject(message.subject),
	};
}

/** Whether the message meets the condition: any of its values for a positive match, all of them for a negative one ("is not a or b"). */
function meets(condition: Condition, message: NormalizedMessage): boolean {
	const field = condition.type === "sender" ? message.sender : condition.type === "alias" ? message.alias : message.subject;
	const negative = condition.match.startsWith("is not") || condition.match.startsWith("does not");
	return negative ? condition.values.every((value) => test(condition.match, field, value)) : condition.values.some((value) => test(condition.match, field, value));
}

function ruleMatchesNormalized(rule: Rule, message: NormalizedMessage): boolean {
	if (!rule.conditions.length) return false;
	return rule.operator === "OR" ? rule.conditions.some((c) => meets(c, message)) : rule.conditions.every((c) => meets(c, message));
}

export function ruleMatches(rule: Rule, message: RuleMessage): boolean {
	return ruleMatchesNormalized(rule, normalizeMessage(message));
}

/** The addresses active rules forward to: the owner's mailboxes, so replies from them are the owner's too. */
export async function ruleForwardAddresses(db: D1Database): Promise<string[]> {
	const { results } = await db.prepare("SELECT * FROM rules WHERE active = 1 AND forwards = 1 AND actions LIKE '%forwardTo%'").all<RuleRow>();
	return [...new Set(results.flatMap((row) => parse(row).actions.filter((action) => action.type === "forwardTo").map((action) => action.value)))];
}

export type RuleOutcome = {
	block?: string;
	subject?: string;
	displayFrom?: string;
	forwardTo?: string;
	removeAttachments?: boolean;
	hideBanner?: boolean;
	/** Webhooks to call, with the name of the rule that asked. */
	webhooks?: { rule: string; url: string }[];
	applied: string[];
};

/** Evaluates a block rule condition-by-condition across candidate senders.
 * Positive sender conditions match if any candidate matches (envelope or From, so spoofing From
 * cannot evade a block). Negative sender conditions ("does not end with @work.test") must hold
 * for every non-spoofed candidate; when the From header is spoofed, it is excluded so a forged
 * From cannot exempt a message from a negative-sender block rule.
 */
function blockRuleMatches(rule: Rule, message: NormalizedMessage, candidates: string[], negativeCandidates: string[]): boolean {
	if (!rule.conditions.length) return false;
	const check = (condition: Condition) => {
		if (condition.type !== "sender") return meets(condition, message);
		const negative = condition.match.startsWith("is not") || condition.match.startsWith("does not");
		if (negative) {
			return negativeCandidates.length === 0 || negativeCandidates.every((sender) => meets(condition, { ...message, sender }));
		}
		return candidates.some((sender) => meets(condition, { ...message, sender }));
	};
	return rule.operator === "OR" ? rule.conditions.some(check) : rule.conditions.every(check);
}

/** The combined actions of every active rule that matches, for forwarded mail or for replies. */
export async function runRules(db: D1Database, kind: "forwards" | "replies", message: RuleMessage): Promise<RuleOutcome> {
	const { results } = await db
		.prepare(`SELECT * FROM rules WHERE active = 1 AND ${kind === "forwards" ? "forwards = 1" : "(replies = 1 OR sends = 1)"} ORDER BY position, created_at`)
		.all<RuleRow>();
	const outcome: RuleOutcome = { applied: [] };
	const normalized = normalizeMessage(message);
	const candidates = [...new Set([message.sender, ...(message.senders ?? [])].filter(Boolean).map(normalizeEmail))];
	// When From is spoofed (DMARC fail / missing / multiple From), only the envelope sender (if any)
	// may participate in negative-sender checks so a forged From cannot bypass "does not end with ...".
	const negativeCandidates = message.spoofed ? (message.envelopeSender ? [normalizeEmail(message.envelopeSender)] : []) : candidates;
	for (const rule of results.map(parse)) {
		const actions = kind === "replies" ? rule.actions.filter((action) => REPLY_ACTIONS.includes(action.type)) : rule.actions;
		if (!actions.length) continue;
		const hasBlock = actions.some((action) => action.type === "block");
		const blockMatched = hasBlock && blockRuleMatches(rule, normalized, candidates, negativeCandidates);
		// A spoofed From address must not trigger positive sender rules (forwardTo, displayFrom, subject, banner).
		const hasSenderCondition = rule.conditions.some((condition) => condition.type === "sender");
		const normalMatched = !(message.spoofed && hasSenderCondition) && ruleMatchesNormalized(rule, normalized);
		if (!blockMatched && !normalMatched) continue;
		let applied = false;
		for (const action of actions) {
			if (action.type === "block") {
				if (blockMatched) {
					outcome.block ??= rule.name;
					applied = true;
				}
				continue;
			}
			if (!normalMatched) continue;
			applied = true;
			if (action.type === "subject") outcome.subject = action.value;
			else if (action.type === "displayFrom") outcome.displayFrom = action.value;
			else if (action.type === "forwardTo") outcome.forwardTo = action.value;
			else if (action.type === "removeAttachments") outcome.removeAttachments = true;
			else if (action.type === "banner") outcome.hideBanner = true;
			else if (action.type === "webhook" && (outcome.webhooks ??= []).length < MAX_WEBHOOKS) outcome.webhooks.push({ rule: rule.name, url: action.value });
		}
		if (applied) outcome.applied.push(rule.id);
		if (outcome.block) break;
	}
	if (outcome.applied.length) {
		const timestamp = now();
		await db.batch(outcome.applied.map((id) => db.prepare("UPDATE rules SET applied = applied + 1, last_applied = ? WHERE id = ?").bind(timestamp, id)));
	}
	return outcome;
}

/** The key webhook requests are signed with, shown on the Rules page so the receiver can check them. */
export function webhookKey(signingSecret: string): Promise<string> {
	return hmacHex(signingSecret, "aliasflare rule webhook");
}

/**
 * Calls the webhooks of the rules that matched: a JSON POST about the message (never its body),
 * signed in X-Aliasflare-Signature (HMAC-SHA256 of the body with the key on the Rules page, hex).
 * A slow or failing receiver never holds up or fails the message: each call gets 5 seconds, and
 * the outcome is only logged.
 */
export async function callWebhooks(
	signingSecret: string,
	webhooks: RuleOutcome["webhooks"],
	message: { alias: string; sender: string; subject: string },
	blockedHosts: string[] = [],
): Promise<void> {
	if (!webhooks?.length) return;
	const key = await webhookKey(signingSecret);
	await Promise.all(
		webhooks.map(async ({ rule, url }) => {
			const safe = safeHttpsUrl(url, blockedHosts);
			if (!safe) {
				console.warn(JSON.stringify({ event: "webhook", rule, error: "disallowed url" }));
				return;
			}
			const body = JSON.stringify({ event: "rule.matched", rule, alias: message.alias, sender: message.sender, subject: message.subject, received_at: new Date().toISOString() });
			try {
				const response = await fetch(safe.href, {
					method: "POST",
					headers: { "Content-Type": "application/json", "User-Agent": "aliasflare", "X-Aliasflare-Signature": await hmacHex(key, body) },
					body,
					redirect: "manual",
					signal: AbortSignal.timeout(5000),
				});
				await response.body?.cancel();
				if (!response.ok) console.warn(JSON.stringify({ event: "webhook", rule, status: response.status }));
			} catch (error) {
				console.warn(JSON.stringify({ event: "webhook", rule, error: error instanceof Error ? error.message : String(error) }));
			}
		}),
	);
}
