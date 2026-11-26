import type { AliasRow } from "./db";

/**
 * The aliases as CSV, in the column names aliasflare's own import reads (and addy.io's export
 * uses where they overlap), so a file exported here can be imported again here or elsewhere.
 * Deleted aliases are included with their deletion date, so they come back deleted.
 */
export const EXPORT_COLUMNS = ["email", "description", "from_name", "active", "forward_mode", "pinned", "recipients", "labels", "created_at", "last_used_at", "deleted_at"] as const;

/** Separates label names in the labels column. */
export const LABEL_SEPARATOR = ";";

type ExportRow = Pick<AliasRow, "address" | "note" | "name" | "forward_mode" | "pinned" | "destination" | "created_at" | "last_used_at" | "deleted_at">;

const date = (seconds: number | null | undefined) => (seconds ? new Date(seconds * 1000).toISOString().slice(0, 19).replace("T", " ") : "");

/**
 * One CSV cell. A cell a spreadsheet would read as a formula (=, +, -, @, tab, return) gets a
 * leading apostrophe, so a note cannot run anything when the file is opened.
 */
export function csvCell(value: string): string {
	const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
	return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function aliasesCsv(aliases: ExportRow[], labels: Map<string, string[]>): string {
	const lines = [EXPORT_COLUMNS.join(",")];
	for (const alias of aliases) {
		lines.push(
			[
				alias.address,
				alias.note ?? "",
				alias.name ?? "",
				alias.forward_mode === "none" ? "false" : "true",
				alias.forward_mode,
				alias.pinned ? "true" : "false",
				alias.destination ?? "",
				(labels.get(alias.address) ?? []).join(LABEL_SEPARATOR),
				date(alias.created_at),
				date(alias.last_used_at),
				date(alias.deleted_at),
			]
				.map(csvCell)
				.join(","),
		);
	}
	return `${lines.join("\r\n")}\r\n`;
}

/** Every alias, deleted ones too, with label names: two queries, whatever the number of aliases. */
export async function exportAliases(db: D1Database): Promise<string> {
	const [aliases, labels] = await db.batch([
		db.prepare("SELECT address, note, name, forward_mode, pinned, destination, created_at, last_used_at, deleted_at FROM aliases ORDER BY created_at, address"),
		db.prepare("SELECT al.alias_address AS address, l.name AS name FROM alias_labels al JOIN labels l ON l.id = al.label_id ORDER BY l.name"),
	]);
	const byAlias = new Map<string, string[]>();
	for (const row of (labels?.results ?? []) as { address: string; name: string }[]) {
		byAlias.set(row.address, [...(byAlias.get(row.address) ?? []), row.name]);
	}
	return aliasesCsv((aliases?.results ?? []) as ExportRow[], byAlias);
}
