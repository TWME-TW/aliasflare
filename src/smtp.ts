/**
 * A minimal SMTP client over a Workers TCP socket: implicit TLS (465) or STARTTLS (587),
 * AUTH PLAIN or LOGIN, one recipient. Port 25 is closed to Workers, so it is not offered.
 */
import { connect } from "cloudflare:sockets";
import { bytesToBase64 } from "./crypto";
import { OutboundError, redact } from "./outbound";

export type SmtpSecurity = "tls" | "starttls";
export type SmtpOptions = { host: string; port: number; security: SmtpSecurity; username: string; password: string };

/** Something shaped like a Workers socket, so tests can stand in for the network. */
export type SmtpSocket = {
	readable: ReadableStream<Uint8Array>;
	writable: WritableStream<Uint8Array>;
	startTls?: () => SmtpSocket;
	close: () => Promise<void>;
};
export type SmtpConnect = (address: { hostname: string; port: number }, options: { secureTransport: "on" | "starttls"; allowHalfOpen: boolean }) => SmtpSocket;

const TIMEOUT_MS = 20_000;
const MAX_REPLY_CHARS = 64 * 1024;
const MAX_REPLY_LINES = 256;
const encoder = new TextEncoder();

/** Reads SMTP replies (possibly multi-line: "250-…" then "250 …") from a socket. */
class Conversation {
	private reader!: ReadableStreamDefaultReader<Uint8Array>;
	private writer!: WritableStreamDefaultWriter<Uint8Array>;
	private buffer = "";
	private decoder = new TextDecoder();

	constructor(private socket: SmtpSocket) {
		this.attach(socket);
	}

	private attach(socket: SmtpSocket) {
		this.socket = socket;
		this.reader = socket.readable.getReader();
		this.writer = socket.writable.getWriter();
		this.buffer = "";
		this.decoder = new TextDecoder();
	}

	/** Switches to TLS after STARTTLS was accepted. */
	upgrade() {
		if (!this.socket.startTls) throw new OutboundError("This connection cannot start TLS");
		// RFC 3207: nothing may follow the 220 STARTTLS reply in cleartext (pipelined MITM injection).
		if (this.buffer.length > 0) throw new OutboundError("Unexpected data received before STARTTLS");
		this.reader.releaseLock();
		this.writer.releaseLock();
		this.attach(this.socket.startTls());
	}

	async reply(): Promise<{ code: number; text: string }> {
		const lines: string[] = [];
		let total = 0;
		for (;;) {
			const end = this.buffer.indexOf("\r\n");
			if (end < 0) {
				const { value, done } = await this.reader.read();
				if (done) throw new OutboundError("The SMTP server closed the connection");
				this.buffer += this.decoder.decode(value, { stream: true });
				if (total + this.buffer.length > MAX_REPLY_CHARS) throw new OutboundError("The SMTP server's reply is too long");
				continue;
			}
			const line = this.buffer.slice(0, end);
			this.buffer = this.buffer.slice(end + 2);
			total += line.length + 2;
			if (total > MAX_REPLY_CHARS || lines.length >= MAX_REPLY_LINES) throw new OutboundError("The SMTP server's reply is too long");
			lines.push(line);
			if (!/^\d{3}-/.test(line)) return { code: Number(line.slice(0, 3)) || 0, text: lines.join("\n") };
		}
	}

	async send(line: string): Promise<void> {
		await this.writer.write(encoder.encode(line));
	}

	/** Streams RFC 5322 DATA in chunks with CRLF normalization and dot-stuffing. */
	async sendData(data: string): Promise<void> {
		const CHUNK_TARGET = 64 * 1024;
		let out = "";
		let atLineStart = true;
		let endedWithCrlf = false;
		const flush = async () => {
			if (!out) return;
			await this.writer.write(encoder.encode(out));
			out = "";
		};
		for (let i = 0; i < data.length; ) {
			const nextCr = data.indexOf("\r", i);
			const nextLf = data.indexOf("\n", i);
			let end: number;
			let step: number;
			if (nextCr >= 0 && (nextLf < 0 || nextCr < nextLf)) {
				end = nextCr;
				step = data[nextCr + 1] === "\n" ? 2 : 1;
			} else if (nextLf >= 0) {
				end = nextLf;
				step = 1;
			} else {
				end = data.length;
				step = 0;
			}
			const line = data.slice(i, end);
			if (atLineStart && line.startsWith(".")) out += ".";
			out += line;
			if (step > 0) {
				out += "\r\n";
				atLineStart = true;
				endedWithCrlf = true;
			} else {
				atLineStart = false;
				endedWithCrlf = false;
			}
			i = end + step;
			if (out.length >= CHUNK_TARGET) await flush();
		}
		out += endedWithCrlf ? ".\r\n" : "\r\n.\r\n";
		await flush();
	}

	/** Sends a command and expects one of the codes. Secrets are never put in the error. */
	async command(line: string, expect: number[], what = line.split(" ")[0], secrets: string[] = []): Promise<string> {
		await this.send(`${line}\r\n`);
		return this.expect(expect, what ?? "", secrets);
	}

	async expect(codes: number[], what: string, secrets: string[] = []): Promise<string> {
		const { code, text } = await this.reply();
		if (!codes.includes(code)) throw new OutboundError(`SMTP ${what} failed: ${redact(text, secrets).slice(0, 300)}`);
		return text;
	}

	async close() {
		await Promise.allSettled([
			this.socket.close().catch(() => undefined),
			this.reader.cancel().catch(() => undefined),
			this.writer.abort().catch(() => undefined),
		]);
		try {
			this.reader.releaseLock();
		} catch {
			// Already released or locked by an active read.
		}
		try {
			this.writer.releaseLock();
		} catch {
			// Already released or writing.
		}
	}
}

/** The message's lines with leading dots doubled, ending in the lone dot. */
export function dotStuff(data: string): string {
	const normalized = data.replace(/\r\n|\r|\n/g, "\r\n");
	return `${normalized.replace(/^\./gm, "..")}${normalized.endsWith("\r\n") ? "" : "\r\n"}.\r\n`;
}

const b64 = (text: string) => bytesToBase64(encoder.encode(text));

export async function sendSmtp(options: SmtpOptions, envelope: { from: string; to: string }, data: string, open: SmtpConnect = connect as unknown as SmtpConnect): Promise<void> {
	if (options.port === 25) throw new OutboundError("Workers cannot connect to port 25: use 465 or 587");
	if (!Number.isInteger(options.port) || options.port <= 0 || options.port >= 65536) throw new OutboundError("Invalid SMTP port");
	if (!envelope.from || !envelope.to || /[\u0000-\u001f\u007f\s<>]/.test(envelope.from) || /[\u0000-\u001f\u007f\s<>]/.test(envelope.to)) {
		throw new OutboundError("Invalid SMTP envelope address");
	}
	if (/[\u0000\r\n]/.test(options.username) || /[\u0000\r\n]/.test(options.password)) {
		throw new OutboundError("Invalid SMTP credentials");
	}
	const socket = open({ hostname: options.host, port: options.port }, { secureTransport: options.security === "tls" ? "on" : "starttls", allowHalfOpen: false });
	const smtp = new Conversation(socket);
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		void smtp.close();
	}, TIMEOUT_MS);
	try {
		await smtp.expect([220], "greeting");
		const helo = "EHLO aliasflare";
		let features = await smtp.command(helo, [250], "EHLO");
		if (options.security === "starttls") {
			if (!/^250[ -]STARTTLS\b/im.test(features)) throw new OutboundError("The SMTP server does not offer STARTTLS");
			await smtp.command("STARTTLS", [220]);
			smtp.upgrade();
			features = await smtp.command(helo, [250], "EHLO");
		}
		if (options.username) {
			const mechanisms = new Set<string>();
			for (const match of features.matchAll(/^250[ -]AUTH[ =]([^\r\n]*)/gim)) {
				for (const item of (match[1] ?? "").toUpperCase().split(/\s+/)) if (item) mechanisms.add(item);
			}
			const authSecrets = [options.password, b64(options.password), b64(`\0${options.username}\0${options.password}`)];
			if (mechanisms.has("PLAIN")) {
				await smtp.command(`AUTH PLAIN ${b64(`\0${options.username}\0${options.password}`)}`, [235], "AUTH", authSecrets);
			} else if (mechanisms.has("LOGIN")) {
				await smtp.command("AUTH LOGIN", [334], "AUTH", authSecrets);
				await smtp.command(b64(options.username), [334], "AUTH", authSecrets);
				await smtp.command(b64(options.password), [235], "AUTH", authSecrets);
			} else {
				throw new OutboundError("SMTP server does not support AUTH PLAIN or AUTH LOGIN");
			}
		}
		await smtp.command(`MAIL FROM:<${envelope.from}>`, [250], "MAIL FROM");
		await smtp.command(`RCPT TO:<${envelope.to}>`, [250, 251], "RCPT TO");
		await smtp.command("DATA", [354]);
		await smtp.sendData(data);
		await smtp.expect([250], "DATA");
		await smtp.command("QUIT", [221]).catch(() => undefined);
	} catch (error) {
		if (timedOut) throw new OutboundError("SMTP connection timed out");
		throw error;
	} finally {
		clearTimeout(timer);
		await smtp.close();
	}
}
