/**
 * Stateless POP3 server (RFC 1939 + STLS/UIDL/TOP/CAPA)
 * backed by aliasflare's Mail Gateway API (/mail-api/v1/pop3/*).
 */
import net from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import { GatewayError, type GatewayCredentials, type MailGatewayClient, type Pop3MessageSummary } from "./gateway.js";
import type { BridgeTlsOptions } from "./imap.js";

export type Pop3ServerOptions = {
	gateway: MailGatewayClient;
	tls?: BridgeTlsOptions;
	allowPlaintextAuth?: boolean;
};

function dotStuff(raw: Buffer): Buffer {
	const text = raw.toString("latin1").replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
	const ended = text.endsWith("\r\n") ? text : `${text}\r\n`;
	return Buffer.from(`${ended}.\r\n`, "latin1");
}

function topSlice(raw: Buffer, bodyLines: number): Buffer {
	const normalized = raw.toString("latin1").replace(/\r?\n/g, "\r\n");
	const split = normalized.indexOf("\r\n\r\n");
	if (split < 0) return raw;
	const headers = normalized.slice(0, split + 4);
	const body = normalized.slice(split + 4).split("\r\n").slice(0, Math.max(0, bodyLines)).join("\r\n");
	return Buffer.from(`${headers}${body}`, "latin1");
}

export function attachPop3Session(socket: Duplex, opts: Pop3ServerOptions, initialSecure = false): void {
	let activeSocket: Duplex = socket;
	let isSecure = initialSecure;
	let pendingUser: string | null = null;
	let creds: GatewayCredentials | null = null;
	let messages: Pop3MessageSummary[] = [];
	const deleted = new Set<number>();
	let buffer = "";
	let processing = Promise.resolve();

	const write = (text: string | Buffer) => {
		if (!activeSocket.destroyed && activeSocket.writable) activeSocket.write(text);
	};

	const handleLine = async (line: string) => {
		const sp = line.indexOf(" ");
		const cmd = (sp < 0 ? line : line.slice(0, sp)).trim().toUpperCase();
		const arg = sp < 0 ? "" : line.slice(sp + 1).trim();

		try {
			if (cmd === "CAPA") {
				const lines = ["+OK Capability list follows", "TOP", "UIDL", "USER"];
				if (!isSecure && opts.tls) lines.push("STLS");
				lines.push("IMPLEMENTATION aliasflare-bridge", ".");
				write(`${lines.join("\r\n")}\r\n`);
				return;
			}
			if (cmd === "STLS") {
				if (isSecure || !opts.tls || !(activeSocket instanceof net.Socket)) {
					write("-ERR STLS unavailable\r\n");
					return;
				}
				write("+OK Begin TLS negotiation\r\n");
				const rawSock = activeSocket;
				rawSock.removeAllListeners("data");
				const tlsSock = new tls.TLSSocket(rawSock, { isServer: true, cert: opts.tls.cert, key: opts.tls.key });
				activeSocket = tlsSock;
				isSecure = true;
				bindSocketEvents(tlsSock);
				return;
			}
			if (cmd === "NOOP") {
				write("+OK\r\n");
				return;
			}
			if (cmd === "QUIT") {
				if (creds && deleted.size > 0) {
					for (const idx of deleted) {
						const msg = messages[idx];
						if (msg) await opts.gateway.pop3Delete(creds, msg.id).catch(() => undefined);
					}
				}
				write("+OK aliasflare POP3 signing off\r\n");
				activeSocket.end();
				return;
			}
			if (!creds) {
				if (cmd === "USER") {
					if (!isSecure && !opts.allowPlaintextAuth) {
						write("-ERR TLS required before USER\r\n");
						return;
					}
					pendingUser = arg;
					write("+OK User accepted\r\n");
					return;
				}
				if (cmd === "PASS") {
					if (!pendingUser) {
						write("-ERR Send USER first\r\n");
						return;
					}
					const candidate = { username: pendingUser, password: arg };
					const status = await opts.gateway.status(candidate);
					if (!status.protocols.pop3) {
						write("-ERR POP3 is disabled for this account or password\r\n");
						return;
					}
					messages = await opts.gateway.pop3Messages(candidate);
					creds = candidate;
					write(`+OK Logged in, ${messages.length} messages\r\n`);
					return;
				}
				write("-ERR Authenticate first\r\n");
				return;
			}

			if (cmd === "STAT") {
				let count = 0;
				let octets = 0;
				messages.forEach((m, i) => {
					if (!deleted.has(i)) {
						count += 1;
						octets += m.size;
					}
				});
				write(`+OK ${count} ${octets}\r\n`);
				return;
			}
			if (cmd === "LIST") {
				if (arg) {
					const idx = Number.parseInt(arg, 10) - 1;
					const msg = messages[idx];
					if (!msg || deleted.has(idx)) write("-ERR No such message\r\n");
					else write(`+OK ${idx + 1} ${msg.size}\r\n`);
					return;
				}
				const lines = ["+OK scan listing follows"];
				messages.forEach((m, i) => {
					if (!deleted.has(i)) lines.push(`${i + 1} ${m.size}`);
				});
				lines.push(".");
				write(`${lines.join("\r\n")}\r\n`);
				return;
			}
			if (cmd === "UIDL") {
				if (arg) {
					const idx = Number.parseInt(arg, 10) - 1;
					const msg = messages[idx];
					if (!msg || deleted.has(idx)) write("-ERR No such message\r\n");
					else write(`+OK ${idx + 1} ${msg.uidl}\r\n`);
					return;
				}
				const lines = ["+OK unique-id listing follows"];
				messages.forEach((m, i) => {
					if (!deleted.has(i)) lines.push(`${i + 1} ${m.uidl}`);
				});
				lines.push(".");
				write(`${lines.join("\r\n")}\r\n`);
				return;
			}
			if (cmd === "RETR") {
				const idx = Number.parseInt(arg, 10) - 1;
				const msg = messages[idx];
				if (!msg || deleted.has(idx)) {
					write("-ERR No such message\r\n");
					return;
				}
				const raw = await opts.gateway.pop3Raw(creds, msg.id);
				write(`+OK ${raw.byteLength} octets\r\n`);
				write(dotStuff(raw));
				return;
			}
			if (cmd === "TOP") {
				const [numStr, linesStr] = arg.split(/\s+/);
				const idx = Number.parseInt(numStr ?? "", 10) - 1;
				const n = Number.parseInt(linesStr ?? "0", 10);
				const msg = messages[idx];
				if (!msg || deleted.has(idx) || !Number.isFinite(n) || n < 0) {
					write("-ERR Invalid arguments\r\n");
					return;
				}
				const raw = await opts.gateway.pop3Raw(creds, msg.id);
				write("+OK top of message follows\r\n");
				write(dotStuff(topSlice(raw, n)));
				return;
			}
			if (cmd === "DELE") {
				const idx = Number.parseInt(arg, 10) - 1;
				if (!messages[idx] || deleted.has(idx)) {
					write("-ERR No such message\r\n");
					return;
				}
				deleted.add(idx);
				write(`+OK message ${idx + 1} marked for deletion\r\n`);
				return;
			}
			if (cmd === "RSET") {
				deleted.clear();
				write("+OK\r\n");
				return;
			}
			write("-ERR Unknown command\r\n");
		} catch (error) {
			const msg = error instanceof GatewayError ? error.message : "Server error";
			write(`-ERR ${msg}\r\n`);
		}
	};

	const bindSocketEvents = (sock: Duplex) => {
		sock.on("data", (chunk: Buffer | string) => {
			buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			let nl: number;
			while ((nl = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, nl).replace(/\r$/, "");
				buffer = buffer.slice(nl + 1);
				processing = processing.then(() => handleLine(line));
			}
		});
	};

	bindSocketEvents(activeSocket);
	write("+OK aliasflare POP3 Bridge ready\r\n");
}

export function createPop3Server(opts: Pop3ServerOptions, implicitTls = false): net.Server {
	if (implicitTls && opts.tls) {
		return tls.createServer({ cert: opts.tls.cert, key: opts.tls.key }, (sock) => attachPop3Session(sock, opts, true));
	}
	return net.createServer((sock) => attachPop3Session(sock, opts, false));
}
