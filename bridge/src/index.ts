/**
 * Entry point for the stateless aliasflare IMAP / POP3 / SMTP Bridge.
 * Zero local state: every protocol session authenticates against the Worker's /mail-api/v1.
 */
import fs from "node:fs";
import type net from "node:net";
import { MailGatewayClient } from "./gateway.js";
import { createImapServer, type BridgeTlsOptions } from "./imap.js";
import { createPop3Server } from "./pop3.js";
import { createSmtpServer } from "./smtp.js";

function envBool(name: string, fallback: boolean): boolean {
	const raw = process.env[name]?.trim().toLowerCase();
	if (raw === "1" || raw === "true" || raw === "yes") return true;
	if (raw === "0" || raw === "false" || raw === "no") return false;
	return fallback;
}

function envPort(name: string, fallback: number): number {
	const parsed = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
}

const workerUrl = process.env.ALIASFLARE_URL?.trim();
if (!workerUrl) {
	console.error("ALIASFLARE_URL is required (e.g. https://alias.example.com)");
	process.exit(1);
}

const bindHost = process.env.BIND_HOST?.trim() || "127.0.0.1";
const allowPlaintextAuth = envBool("ALLOW_PLAINTEXT_AUTH", false);
const enableImap = envBool("ENABLE_IMAP", true);
const enablePop3 = envBool("ENABLE_POP3", false);
const enableSmtp = envBool("ENABLE_SMTP", true);
const rawIdlePoll = Number.parseInt(process.env.IMAP_IDLE_POLL_MS ?? "", 10);
const idlePollMs = Number.isInteger(rawIdlePoll) && rawIdlePoll >= 15_000 ? rawIdlePoll : 60_000;

let tlsOptions: BridgeTlsOptions | undefined;
const certFile = process.env.TLS_CERT_FILE?.trim();
const keyFile = process.env.TLS_KEY_FILE?.trim();
if (certFile && keyFile) {
	tlsOptions = {
		cert: fs.readFileSync(certFile),
		key: fs.readFileSync(keyFile),
	};
}

if (!tlsOptions && !allowPlaintextAuth) {
	console.warn("Warning: No TLS_CERT_FILE/TLS_KEY_FILE provided and ALLOW_PLAINTEXT_AUTH=false — clients will not be able to authenticate until TLS is configured or ALLOW_PLAINTEXT_AUTH=true is set for localhost/VPN.");
}

const gateway = new MailGatewayClient(workerUrl);
const servers: net.Server[] = [];

function start(name: string, server: net.Server, port: number) {
	server.listen(port, bindHost, () => {
		console.log(`[aliasflare-bridge] ${name} listening on ${bindHost}:${port}`);
	});
	servers.push(server);
}

if (enableImap) {
	start("IMAP (STARTTLS)", createImapServer({ gateway, tls: tlsOptions, allowPlaintextAuth, idlePollMs }, false), envPort("IMAP_PORT", 143));
	if (tlsOptions) {
		start("IMAPS (TLS)", createImapServer({ gateway, tls: tlsOptions, allowPlaintextAuth, idlePollMs }, true), envPort("IMAPS_PORT", 993));
	}
}
if (enablePop3) {
	start("POP3 (STARTTLS)", createPop3Server({ gateway, tls: tlsOptions, allowPlaintextAuth }, false), envPort("POP3_PORT", 110));
	if (tlsOptions) {
		start("POP3S (TLS)", createPop3Server({ gateway, tls: tlsOptions, allowPlaintextAuth }, true), envPort("POP3S_PORT", 995));
	}
}
if (enableSmtp) {
	start("SMTP (STARTTLS)", createSmtpServer({ gateway, tls: tlsOptions, allowPlaintextAuth }, false), envPort("SMTP_PORT", 587));
	if (tlsOptions) {
		start("SMTPS (TLS)", createSmtpServer({ gateway, tls: tlsOptions, allowPlaintextAuth }, true), envPort("SMTPS_PORT", 465));
	}
}

const shutdown = () => {
	console.log("[aliasflare-bridge] Shutting down...");
	for (const s of servers) s.close();
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
