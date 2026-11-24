// Usage: node scripts/check-locale.mjs <code> [<code> ...]
// Checks src/locales/<code>.ts against src/locales/en.ts: same keys, same {placeholders},
// the same number of `backticks`, and no string left in English by mistake.
import { readFileSync } from "node:fs";

function load(code) {
	const text = readFileSync(new URL(`../src/locales/${code}.ts`, import.meta.url), "utf8");
	const start = text.search(/= \{\r?\n/) + 2;
	const end = text.lastIndexOf("};");
	// The dictionary bodies are plain object literals of string literals.
	return Function(`"use strict"; return (${text.slice(start, end + 1)});`)();
}

const en = load("en");
let failed = false;
for (const code of process.argv.slice(2)) {
	const dict = load(code);
	const problems = [];
	for (const key of Object.keys(en)) if (!(key in dict)) problems.push(`missing ${key}`);
	for (const key of Object.keys(dict)) if (!(key in en)) problems.push(`extra ${key}`);
	const placeholders = (s) => (s.match(/\{\w+\}/g) ?? []).sort().join(",");
	const ticks = (s) => (s.match(/`/g) ?? []).length;
	const same = [];
	for (const [key, value] of Object.entries(en)) {
		const v = dict[key];
		if (typeof v !== "string") continue;
		if (placeholders(v) !== placeholders(value)) problems.push(`placeholders differ in ${key}: ${placeholders(value)} vs ${placeholders(v)}`);
		if (ticks(v) !== ticks(value)) problems.push(`backticks differ in ${key}`);
		if (!v.trim()) problems.push(`empty ${key}`);
		if (code !== "en" && v === value && /[a-z]{4,}/i.test(value)) same.push(key);
	}
	console.log(`${code}: ${problems.length ? "FAIL" : "ok"}`);
	for (const p of problems) console.log("  " + p);
	if (same.length) console.log(`  identical to English (fine only for names and codes): ${same.join(", ")}`);
	if (problems.length) failed = true;
}
process.exit(failed ? 1 : 0);
