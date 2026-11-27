/**
 * Stateless SMTP Submission server (RFC 6409: EHLO, STARTTLS, AUTH PLAIN/LOGIN, MAIL/RCPT/DATA)
 * backed by aliasflare's Mail Gateway API (/mail-api/v1/smtp/send).
 * Never operates as an open relay: authentication with a Mail App Password is always mandatory.
 */
import net from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import { GatewayError, type GatewayCredentials, type MailGatewayClient } from "./gateway.js";
import type { BridgeTlsOptions } from "./imap.js";

export type SmtpServerOptions = {
	gateway: MailGatewayClient;
	hostname?: string;
	tls?: BridgeTlsOptions;
	allowPlaintextAuth?: boolean;
};

const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
/** Bytes a client may send without a line break before the session is closed. */
const MAX_LINE_BYTES = 64 * 1024;
/** An idle session is closed after this long (RFC 5321 4.5.3.2 suggests 5 minutes per command). */
const IDLE_TIMEOUT_MS = 10 * 60_000;

/** CRLF as bytes: DATA lines are joined with it exactly as RFC 5321 requires. */
const CRLF = Buffer.from("\r\n", "ascii");

function extractBracketedAddress(arg: string): string | null {
	const match = arg.match(/<([^<>\s]+@[^<>\s]+)>/);
	if (match) return match[1]!.trim().toLowerCase();
	const bare = arg.split(/\s+/)[0]?.trim().toLowerCase();
	return bare && bare.includes("@") ? bare : null;
}

export function attachSmtpSession(socket: Duplex, opts: SmtpServerOptions, initialSecure = false): void {
	const host = opts.hostname || "aliasflare-bridge";
	let activeSocket: Duplex = socket;
	let isSecure = initialSecure;
	let creds: GatewayCredentials | null = null;
	let authStage: "plain" | "login_user" | "login_pass" | null = null;
	let loginUser = "";
	let mailFrom: string | null = null;
	let rcptTo: string[] = [];
	let inData = false;
	let dataParts: Buffer[] = [];
	let dataBytes = 0;
	// Set when DATA exceeds the size limit: the message is refused at ".", never sent truncated.
	let dataOverflow = false;
	let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	let processing = Promise.resolve();
	let pendingLines = 0;
	let paused = false;
	// Raised by STARTTLS: lines that arrived in the clear behind it are dropped, not run under TLS.
	let generation = 0;
	if (socket instanceof net.Socket) socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());

	const write = (text: string) => {
		if (!activeSocket.destroyed && activeSocket.writable) activeSocket.write(text);
	};

	const resetEnvelope = () => {
		mailFrom = null;
		rcptTo = [];
		inData = false;
		dataParts = [];
		dataBytes = 0;
		dataOverflow = false;
	};

	const verifyAuth = async (username: string, password: string) => {
		try {
			const candidate = { username, password };
			const status = await opts.gateway.status(candidate);
			if (!status.protocols.smtp) {
				write("535 5.7.8 SMTP submission is disabled for this account or password\r\n");
				return;
			}
			creds = candidate;
			write("235 2.7.0 Authentication successful\r\n");
		} catch (error) {
			// Distinguish temporary gateway failures from bad credentials so clients can back off
			// instead of retry-storming the Worker or assuming the password is wrong.
			if (error instanceof GatewayError && error.status === 429) {
				write("451 4.7.1 Too many requests, try again later\r\n");
			} else if (error instanceof GatewayError && error.status >= 500) {
				write("451 4.3.0 Temporary failure, try again later\r\n");
			} else {
				write("535 5.7.8 Authentication credentials invalid\r\n");
			}
		}
	};

	/** Accumulates one DATA line as raw bytes (8BITMIME-safe), unstuffing the leading dot. */
	const handleDataLine = (line: Buffer) => {
		const unstuffed = line.length >= 2 && line[0] === 0x2e && line[1] === 0x2e ? line.subarray(1) : line;
		dataBytes += unstuffed.byteLength + 2;
		if (dataOverflow) return;
		if (dataBytes > MAX_MESSAGE_BYTES) {
			// Over the limit: stop buffering and remember to refuse the message at ".".
			dataOverflow = true;
			dataParts = [];
			return;
		}
		dataParts.push(unstuffed);
	};

	const handleLine = async (line: string) => {
		if (line === "." && inData) {
			// End of DATA: reset the envelope first, but remember whether the message was over the
			// size limit — an oversized message is refused, never sent truncated.
			const overflow = dataOverflow;
			const parts = dataParts;
			const from = mailFrom!;
			const rcpts = [...rcptTo];
			resetEnvelope();
			if (overflow) {
				write("552 5.3.4 Message exceeds fixed maximum message size\r\n");
				return;
			}
			const raw = Buffer.concat(parts.flatMap((part) => [part, CRLF]));
			try {
				const result = await opts.gateway.smtpSend(creds!, from, rcpts, raw);
				write(`250 2.0.0 Queued (${result.messageIds[0] ?? "ok"})\r\n`);
			} catch (error) {
				if (error instanceof GatewayError && error.status === 429) {
					write(`451 4.7.1 ${error.message}\r\n`);
				} else if (error instanceof GatewayError && error.status >= 400 && error.status < 500) {
					write(`550 5.7.1 ${error.message}\r\n`);
				} else {
					write(`451 4.3.0 ${error instanceof Error ? error.message : "Temporary failure"}\r\n`);
				}
			}
			return;
		}

		if (authStage === "plain") {
			authStage = null;
			const decoded = Buffer.from(line.trim(), "base64").toString("utf8");
			const parts = decoded.split("\0");
			await verifyAuth(parts[1] ?? "", parts[2] ?? "");
			return;
		}
		if (authStage === "login_user") {
			loginUser = Buffer.from(line.trim(), "base64").toString("utf8");
			authStage = "login_pass";
			write("334 UGFzc3dvcmQ6\r\n"); // Password:
			return;
		}
		if (authStage === "login_pass") {
			authStage = null;
			const pass = Buffer.from(line.trim(), "base64").toString("utf8");
			await verifyAuth(loginUser, pass);
			return;
		}

		const upper = line.toUpperCase();
		if (upper.startsWith("EHLO")) {
			const caps = [`250-${host}`, `250-SIZE ${MAX_MESSAGE_BYTES}`, "250-8BITMIME", "250-SMTPUTF8"];
			if (!isSecure && opts.tls) caps.push("250-STARTTLS");
			if (isSecure || opts.allowPlaintextAuth) caps.push("250 AUTH PLAIN LOGIN");
			else caps[caps.length - 1] = caps[caps.length - 1]!.replace(/^250-/, "250 ");
			write(`${caps.join("\r\n")}\r\n`);
			return;
		}
		if (upper.startsWith("HELO")) {
			write(`250 ${host}\r\n`);
			return;
		}
		if (upper === "STARTTLS") {
			if (isSecure || !opts.tls || !(activeSocket instanceof net.Socket)) {
				write("454 TLS not available\r\n");
				return;
			}
			write("220 2.0.0 Ready to start TLS\r\n");
			const rawSock = activeSocket;
			rawSock.removeAllListeners("data");
			generation += 1;
			buffer = Buffer.alloc(0);
			const tlsSock = new tls.TLSSocket(rawSock, { isServer: true, cert: opts.tls.cert, key: opts.tls.key });
			activeSocket = tlsSock;
			isSecure = true;
			resetEnvelope();
			bindSocketEvents(tlsSock);
			return;
		}
		if (upper.startsWith("AUTH ")) {
			if (!isSecure && !opts.allowPlaintextAuth) {
				write("538 5.7.11 Encryption required for requested authentication mechanism\r\n");
				return;
			}
			const parts = line.trim().split(/\s+/);
			const mech = (parts[1] ?? "").toUpperCase();
			if (mech === "PLAIN") {
				if (parts[2]) {
					const decoded = Buffer.from(parts[2], "base64").toString("utf8");
					const fields = decoded.split("\0");
					await verifyAuth(fields[1] ?? "", fields[2] ?? "");
				} else {
					authStage = "plain";
					write("334 \r\n");
				}
				return;
			}
			if (mech === "LOGIN") {
				authStage = "login_user";
				write("334 VXNlcm5hbWU6\r\n"); // Username:
				return;
			}
			write("504 5.5.4 Unrecognized authentication type\r\n");
			return;
		}
		if (upper === "NOOP") {
			write("250 2.0.0 OK\r\n");
			return;
		}
		if (upper === "RSET") {
			resetEnvelope();
			write("250 2.0.0 Reset\r\n");
			return;
		}
		if (upper === "QUIT") {
			write("221 2.0.0 Bye\r\n");
			activeSocket.end();
			return;
		}
		if (!creds) {
			write("530 5.7.0 Authentication required\r\n");
			return;
		}
		if (upper.startsWith("MAIL FROM:")) {
			const addr = extractBracketedAddress(line.slice(10));
			if (!addr) {
				write("501 5.1.7 Bad sender address syntax\r\n");
				return;
			}
			resetEnvelope();
			mailFrom = addr;
			write("250 2.1.0 OK\r\n");
			return;
		}
		if (upper.startsWith("RCPT TO:")) {
			if (!mailFrom) {
				write("503 5.5.1 Need MAIL command first\r\n");
				return;
			}
			const addr = extractBracketedAddress(line.slice(8));
			if (!addr) {
				write("501 5.1.3 Bad recipient address syntax\r\n");
				return;
			}
			if (rcptTo.length >= 20) {
				write("452 4.5.3 Too many recipients\r\n");
				return;
			}
			rcptTo.push(addr);
			write("250 2.1.5 OK\r\n");
			return;
		}
		if (upper === "DATA") {
			if (!mailFrom || !rcptTo.length) {
				write("503 5.5.1 Need MAIL and RCPT first\r\n");
				return;
			}
			inData = true;
			dataParts = [];
			dataOverflow = false;
			dataBytes = 0;
			write("354 End data with <CR><LF>.<CR><LF>\r\n");
			return;
		}
		write("500 5.5.2 Command unrecognized\r\n");
	};

	const bindSocketEvents = (sock: Duplex) => {
		sock.on("data", (chunk: Buffer | string) => {
			const incoming = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
			buffer = buffer.length ? Buffer.concat([buffer, incoming]) : incoming;
			let nl: number;
			// Lines are kept as raw bytes; commands are decoded only when they run, so DATA bodies
			// (which may hold arbitrary 8BITMIME bytes) pass through unmodified.
			while ((nl = buffer.indexOf(0x0a)) >= 0) {
				let line = buffer.subarray(0, nl);
				buffer = buffer.subarray(nl + 1);
				if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
				const gen = generation;
				pendingLines += 1;
				if (!paused && pendingLines >= 512 && typeof sock.pause === "function") {
					paused = true;
					sock.pause();
				}
				processing = processing
					.then(() => {
						if (gen !== generation) return;
						if (inData) {
							if (line.length === 1 && line[0] === 0x2e) return handleLine(".");
							return handleDataLine(line);
						}
						return handleLine(line.toString("utf8"));
					})
					.catch(() => undefined)
					.then(() => {
						pendingLines = Math.max(0, pendingLines - 1);
						if (paused && pendingLines < 128 && typeof sock.resume === "function") {
							paused = false;
							sock.resume();
						}
					});
			}
			if (buffer.byteLength > MAX_LINE_BYTES) {
				write("500 5.5.6 Line too long\r\n");
				sock.destroy();
			}
		});
		// Without a listener, one reset connection would crash the whole bridge.
		sock.on("error", () => sock.destroy());
	};

	bindSocketEvents(activeSocket);
	write(`220 ${host} ESMTP aliasflare Bridge ready\r\n`);
}

export function createSmtpServer(opts: SmtpServerOptions, implicitTls = false): net.Server {
	if (implicitTls && opts.tls) {
		return tls.createServer({ cert: opts.tls.cert, key: opts.tls.key }, (sock) => attachSmtpSession(sock, opts, true));
	}
	return net.createServer((sock) => attachSmtpSession(sock, opts, false));
}
