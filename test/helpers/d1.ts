/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

type Value = string | number | bigint | null | Uint8Array;

/**
 * A D1Database backed by Node's built-in SQLite, with the real migrations applied, so
 * route tests run the same SQL the Worker does.
 */
export function testDb(): D1Database {
	const sqlite = new DatabaseSync(":memory:");
	const dir = join(__dirname, "..", "..", "migrations");
	for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) sqlite.exec(readFileSync(join(dir, file), "utf8"));

	const statement = (sql: string, params: Value[] = []) => {
		const run = () => {
			const prepared = sqlite.prepare(sql);
			return prepared;
		};
		const self = {
			bind: (...values: unknown[]) => statement(sql, values.map((value) => (value === undefined ? null : typeof value === "boolean" ? Number(value) : value)) as Value[]),
			all: async <T>() => ({ results: run().all(...params) as T[], success: true, meta: {} }),
			first: async <T>(column?: string) => {
				const row = run().get(...params) as Record<string, unknown> | undefined;
				if (!row) return null;
				return (column ? row[column] : { ...row }) as T;
			},
			run: async () => {
				const prepared = run();
				if (/\bRETURNING\b/i.test(sql)) {
					const results = prepared.all(...params);
					return { results, success: true, meta: { changes: results.length } };
				}
				const result = prepared.run(...params);
				return { results: [], success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
			},
			raw: async () => run().all(...params).map((row) => Object.values(row as object)),
		};
		return self;
	};
	return {
		prepare: (sql: string) => statement(sql),
		batch: async (statements: { run: () => Promise<unknown> }[]) => {
			sqlite.exec("BEGIN");
			try {
				const results = [];
				for (const item of statements) results.push(await item.run());
				sqlite.exec("COMMIT");
				return results;
			} catch (error) {
				sqlite.exec("ROLLBACK");
				throw error;
			}
		},
		exec: async (sql: string) => {
			sqlite.exec(sql);
			return { count: 0, duration: 0 };
		},
		dump: async () => new ArrayBuffer(0),
	} as unknown as D1Database;
}
