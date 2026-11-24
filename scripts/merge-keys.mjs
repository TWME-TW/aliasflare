// Usage: node scripts/merge-keys.mjs <keys.json>
// keys.json maps a locale code to { key: value }. Existing keys are replaced in place; new keys are
// appended at the end of the dictionary, in the order given.
import { readFileSync, writeFileSync } from "node:fs";

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
for (const [code, entries] of Object.entries(input)) {
	const file = new URL(`../src/locales/${code}.ts`, import.meta.url);
	let text = readFileSync(file, "utf8");
	const added = [];
	for (const [key, value] of Object.entries(entries)) {
		const line = `\t${JSON.stringify(key)}: ${JSON.stringify(value)},`;
		const pattern = new RegExp(`^\\t${escape(JSON.stringify(key))}: .*,\\r?$`, "m");
		if (pattern.test(text)) text = text.replace(pattern, () => line);
		else added.push(line);
	}
	if (added.length) {
		const end = text.lastIndexOf("\n};");
		text = `${text.slice(0, end)}\n${added.join("\n")}${text.slice(end)}`;
	}
	writeFileSync(file, text);
	console.log(`${code}: ${Object.keys(entries).length - added.length} replaced, ${added.length} added`);
}
