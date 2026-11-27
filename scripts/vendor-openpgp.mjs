// Copies the browser build of OpenPGP.js (LGPL-3.0) into public/vendor, where Cloudflare serves it
// as a static file. The dashboard loads it only to make a key pair in the browser. Wrangler runs
// this before every deploy and dev session (the "build" command in wrangler.jsonc).
import { copyFileSync, mkdirSync } from "node:fs";

const source = new URL("../node_modules/openpgp/", import.meta.url);
const target = new URL("../public/vendor/", import.meta.url);
mkdirSync(target, { recursive: true });
copyFileSync(new URL("dist/openpgp.min.mjs", source), new URL("openpgp.min.mjs", target));
copyFileSync(new URL("LICENSE", source), new URL("openpgp.LICENSE.txt", target));
