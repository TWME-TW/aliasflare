/** Labels: names with a colour that group aliases (addy.io's labels). An alias can have several. */
import { newId, now } from "./db";

export type LabelRow = { id: string; name: string; colour: string; created_at: number; updated_at: number };
export type LabelWithCount = LabelRow & { aliases: number };

export const MAX_LABEL_NAME = 40;
export const MAX_LABELS = 100;
/**
 * Colours offered in the dashboard (indigo, sky, teal, emerald, lime, amber, orange, rose, pink,
 * violet, slate); the apps may send any #rrggbb.
 */
export const LABEL_COLOURS = ["#6366f1", "#0ea5e9", "#14b8a6", "#10b981", "#84cc16", "#f59e0b", "#f97316", "#f43f5e", "#ec4899", "#8b5cf6", "#64748b"] as const;

export class LabelError extends Error {
	constructor(readonly reason: "name" | "colour" | "taken" | "limit" | "missing") {
		super(reason);
	}
}

export function cleanLabelName(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const name = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_NAME);
	return name || null;
}

export function cleanColour(value: unknown): string | null {
	if (value === undefined || value === null || value === "") return LABEL_COLOURS[0];
	return typeof value === "string" && /^#?[0-9a-f]{6}$/i.test(value.trim()) ? `#${value.trim().replace(/^#/, "").toLowerCase()}` : null;
}

export async function listLabels(db: D1Database): Promise<LabelWithCount[]> {
	const { results } = await db
		.prepare(
			`SELECT l.*, (SELECT COUNT(*) FROM alias_labels al JOIN aliases a ON a.address = al.alias_address WHERE al.label_id = l.id AND a.deleted_at IS NULL) AS aliases
			 FROM labels l ORDER BY l.name COLLATE NOCASE`,
		)
		.all<LabelWithCount>();
	return results.map((row) => ({ ...row, aliases: Number(row.aliases) }));
}

export async function getLabel(db: D1Database, id: string): Promise<LabelRow | null> {
	return db.prepare("SELECT * FROM labels WHERE id = ?").bind(id).first<LabelRow>();
}

export async function createLabel(db: D1Database, input: { name: unknown; colour?: unknown }): Promise<LabelRow> {
	const name = cleanLabelName(input.name);
	if (!name) throw new LabelError("name");
	const colour = cleanColour(input.colour);
	if (!colour) throw new LabelError("colour");
	const count = await db.prepare("SELECT COUNT(*) AS n FROM labels").first<{ n: number }>();
	if (Number(count?.n ?? 0) >= MAX_LABELS) throw new LabelError("limit");
	const row: LabelRow = { id: newId("lb"), name, colour, created_at: now(), updated_at: now() };
	const result = await db
		.prepare("INSERT INTO labels (id, name, colour, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (name) DO NOTHING")
		.bind(row.id, row.name, row.colour, row.created_at, row.updated_at)
		.run();
	if (!result.meta.changes) throw new LabelError("taken");
	return row;
}

export async function updateLabel(db: D1Database, id: string, input: { name?: unknown; colour?: unknown }): Promise<LabelRow> {
	const label = await getLabel(db, id);
	if (!label) throw new LabelError("missing");
	const name = input.name === undefined ? label.name : cleanLabelName(input.name);
	if (!name) throw new LabelError("name");
	const colour = input.colour === undefined ? label.colour : cleanColour(input.colour);
	if (!colour) throw new LabelError("colour");
	const clash = await db.prepare("SELECT id FROM labels WHERE name = ? AND id != ?").bind(name, id).first();
	if (clash) throw new LabelError("taken");
	await db.prepare("UPDATE labels SET name = ?, colour = ?, updated_at = ? WHERE id = ?").bind(name, colour, now(), id).run();
	return { ...label, name, colour, updated_at: now() };
}

export async function deleteLabel(db: D1Database, id: string): Promise<boolean> {
	const result = await db.prepare("DELETE FROM labels WHERE id = ?").bind(id).run();
	return (result.meta.changes ?? 0) > 0;
}

/** Only the ids of labels that exist, without repeats. */
async function knownLabelIds(db: D1Database, ids: unknown[]): Promise<string[]> {
	const wanted = [...new Set(ids.filter((id): id is string => typeof id === "string"))].slice(0, MAX_LABELS);
	if (!wanted.length) return [];
	const { results } = await db.prepare(`SELECT id FROM labels WHERE id IN (${wanted.map(() => "?").join(", ")})`).bind(...wanted).all<{ id: string }>();
	const known = new Set(results.map((row) => row.id));
	return wanted.filter((id) => known.has(id));
}

/** Gives each alias exactly these labels (unknown ids are left out). */
export async function setAliasLabels(db: D1Database, addresses: string[], labelIds: unknown[]): Promise<void> {
	if (!addresses.length) return;
	const ids = await knownLabelIds(db, labelIds);
	const statements = addresses.flatMap((address) => [
		db.prepare("DELETE FROM alias_labels WHERE alias_address = ?").bind(address),
		...ids.map((id) => db.prepare("INSERT OR IGNORE INTO alias_labels (alias_address, label_id) VALUES (?, ?)").bind(address, id)),
	]);
	for (let i = 0; i < statements.length; i += 100) await db.batch(statements.slice(i, i + 100));
}

/** Adds (or removes) one label on each alias, leaving their other labels. */
export async function toggleAliasLabel(db: D1Database, addresses: string[], labelId: string, add: boolean): Promise<number> {
	const statements = addresses.map((address) =>
		add
			? db.prepare("INSERT OR IGNORE INTO alias_labels (alias_address, label_id) SELECT ?, id FROM labels WHERE id = ?").bind(address, labelId)
			: db.prepare("DELETE FROM alias_labels WHERE alias_address = ? AND label_id = ?").bind(address, labelId),
	);
	let changed = 0;
	for (let i = 0; i < statements.length; i += 100) {
		for (const result of await db.batch(statements.slice(i, i + 100))) changed += result.meta.changes ?? 0;
	}
	return changed;
}

/** The labels of each alias, by address. */
export async function labelsOf(db: D1Database, addresses: string[]): Promise<Map<string, LabelRow[]>> {
	const out = new Map<string, LabelRow[]>();
	const unique = [...new Set(addresses)];
	for (let i = 0; i < unique.length; i += 90) {
		const chunk = unique.slice(i, i + 90);
		const { results } = await db
			.prepare(
				`SELECT al.alias_address, l.* FROM alias_labels al JOIN labels l ON l.id = al.label_id
				 WHERE al.alias_address IN (${chunk.map(() => "?").join(", ")}) ORDER BY l.name COLLATE NOCASE`,
			)
			.bind(...chunk)
			.all<LabelRow & { alias_address: string }>();
		for (const { alias_address, ...label } of results) out.set(alias_address, [...(out.get(alias_address) ?? []), label]);
	}
	return out;
}
