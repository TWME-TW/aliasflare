import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests run in Node: Workers-only modules get stand-ins.
export default defineConfig({
	resolve: { alias: { "cloudflare:sockets": fileURLToPath(new URL("./test/helpers/sockets.ts", import.meta.url)), "cloudflare:email": fileURLToPath(new URL("./test/helpers/email.ts", import.meta.url)) } },
});
