// Usage: node scripts/check-locale.mjs <code> [<code> ...]
// Checks src/locales/<code>.ts against src/locales/en.ts: same keys, same {placeholders},
// the same number of `backticks`, and no string left in English by mistake.
import { readFileSync } from "node:fs";
import ts from "typescript";

const CODE = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;

/** Reads a locale file with the TypeScript parser: string literals only, nothing is executed. */
function load(code) {
	if (!CODE.test(code)) throw new Error(`Not a locale code: ${code}`);
	const path = new URL(`../src/locales/${code}.ts`, import.meta.url);
	const source = ts.createSourceFile(`${code}.ts`, readFileSync(path, "utf8"), ts.ScriptTarget.ES2022, true);
	let literal = null;
	const visit = (node) => {
		if (!literal && ts.isVariableDeclaration(node) && node.initializer) {
			let init = node.initializer;
			while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
			if (ts.isObjectLiteralExpression(init)) literal = init;
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	if (!literal) throw new Error(`${code}: no dictionary found`);
	const dict = {};
	for (const property of literal.properties) {
		if (!ts.isPropertyAssignment(property)) throw new Error(`${code}: unexpected entry`);
		const name = property.name;
		const key = ts.isStringLiteral(name) || ts.isIdentifier(name) ? name.text : null;
		const value = property.initializer;
		if (!key || !(ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))) throw new Error(`${code}: ${key ?? "?"} is not a plain string`);
		dict[key] = value.text;
	}
	return dict;
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
