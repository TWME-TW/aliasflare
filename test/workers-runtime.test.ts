/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Things Node accepts but the Workers runtime refuses, which the other tests cannot catch. */
describe("Workers runtime", () => {
	it("never asks fetch to refuse redirects with redirect: 'error'", () => {
		const dir = join(__dirname, "..", "src");
		const files = readdirSync(dir, { recursive: true }).map(String).filter((name) => name.endsWith(".ts"));
		const offenders = files.filter((name) => /redirect:\s*["']error["']/.test(readFileSync(join(dir, name), "utf8")));
		expect(offenders).toEqual([]);
	});
});
