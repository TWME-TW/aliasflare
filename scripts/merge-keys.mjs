// Usage: node scripts/merge-keys.mjs <keys.json>
// keys.json maps a locale code to { key: value }. Existing keys are replaced in place (also when
// the value was wrapped onto its own line); new keys are appended at the end of the dictionary,
// in the order given.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const CODE = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;
const KEY = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+$/;
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
for (const [code, entries] of Object.entries(input)) {
	if (!CODE.test(code)) throw new Error(`Not a locale code: ${code}`);
	const file = new URL(`../src/locales/${code}.ts`, import.meta.url);
	if (!existsSync(file)) throw new Error(`No locale file for ${code}`);
	let text = readFileSync(file, "utf8");
	const added = [];
	for (const [key, value] of Object.entries(entries)) {
		if (!KEY.test(key) || typeof value !== "string") throw new Error(`${code}: bad entry ${key}`);
		const line = `\t${JSON.stringify(key)}: ${JSON.stringify(value)},`;
		const pattern = new RegExp(`^\\t${escape(JSON.stringify(key))}:[ \\t]*(?:\\r?\\n\\t+)?.*,\\r?$`, "m");
		if (pattern.test(text)) text = text.replace(pattern, () => line);
		else added.push(line);
	}
	if (added.length) {
		const end = text.lastIndexOf("\n};");
		if (end === -1) throw new Error(`${code}: could not find the end of the dictionary`);
		text = `${text.slice(0, end)}\n${added.join("\n")}${text.slice(end)}`;
	}
	writeFileSync(file, text);
	console.log(`${code}: ${Object.keys(entries).length - added.length} replaced, ${added.length} added`);
}
