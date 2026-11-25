/**
 * A minimal SMTP client over a Workers TCP socket: implicit TLS (465) or STARTTLS (587),
 * AUTH PLAIN or LOGIN, one recipient. Port 25 is closed to Workers, so it is not offered.
 */
import { connect } from "cloudflare:sockets";
import { OutboundError } from "./outbound";

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
	}

	/** Switches to TLS after STARTTLS was accepted. */
	upgrade() {
		if (!this.socket.startTls) throw new OutboundError("This connection cannot start TLS");
		this.reader.releaseLock();
		this.writer.releaseLock();
		this.attach(this.socket.startTls());
	}

	async reply(): Promise<{ code: number; text: string }> {
		const lines: string[] = [];
		for (;;) {
			const end = this.buffer.indexOf("\r\n");
			if (end < 0) {
				const { value, done } = await this.reader.read();
				if (done) throw new OutboundError("The SMTP server closed the connection");
				this.buffer += this.decoder.decode(value, { stream: true });
				if (this.buffer.length > 64 * 1024) throw new OutboundError("The SMTP server's reply is too long");
				continue;
			}
			const line = this.buffer.slice(0, end);
			this.buffer = this.buffer.slice(end + 2);
			lines.push(line);
			if (!/^\d{3}-/.test(line)) return { code: Number(line.slice(0, 3)) || 0, text: lines.join("\n") };
		}
	}

	async send(line: string): Promise<void> {
		await this.writer.write(encoder.encode(line));
	}

	/** Sends a command and expects one of the codes. Secrets are never put in the error. */
	async command(line: string, expect: number[], what = line.split(" ")[0]): Promise<string> {
		await this.send(`${line}\r\n`);
		return this.expect(expect, what ?? "");
	}

	async expect(codes: number[], what: string): Promise<string> {
		const { code, text } = await this.reply();
		if (!codes.includes(code)) throw new OutboundError(`SMTP ${what} failed: ${text.slice(0, 300)}`);
		return text;
	}

	async close() {
		await this.socket.close().catch(() => undefined);
	}
}

/** The message's lines with leading dots doubled, ending in the lone dot. */
export function dotStuff(data: string): string {
	const normalized = data.replace(/\r?\n/g, "\r\n");
	return `${normalized.replace(/^\./gm, "..")}${normalized.endsWith("\r\n") ? "" : "\r\n"}.\r\n`;
}

const b64 = (text: string) => btoa(String.fromCharCode(...encoder.encode(text)));

export async function sendSmtp(options: SmtpOptions, envelope: { from: string; to: string }, data: string, open: SmtpConnect = connect as unknown as SmtpConnect): Promise<void> {
	if (options.port === 25) throw new OutboundError("Workers cannot connect to port 25: use 465 or 587");
	const socket = open({ hostname: options.host, port: options.port }, { secureTransport: options.security === "tls" ? "on" : "starttls", allowHalfOpen: false });
	const smtp = new Conversation(socket);
	const timer = setTimeout(() => void smtp.close(), TIMEOUT_MS);
	try {
		await smtp.expect([220], "greeting");
		const helo = "EHLO aliasflare";
		let features = await smtp.command(helo, [250], "EHLO");
		if (options.security === "starttls") {
			if (!/STARTTLS/i.test(features)) throw new OutboundError("The SMTP server does not offer STARTTLS");
			await smtp.command("STARTTLS", [220]);
			smtp.upgrade();
			features = await smtp.command(helo, [250], "EHLO");
		}
		if (options.username) {
			const auth = features.match(/AUTH[ =]([^\n]*)/i)?.[1]?.toUpperCase() ?? "";
			if (auth.includes("PLAIN") || !auth.includes("LOGIN")) {
				await smtp.command(`AUTH PLAIN ${b64(`\0${options.username}\0${options.password}`)}`, [235], "AUTH");
			} else {
				await smtp.command("AUTH LOGIN", [334], "AUTH");
				await smtp.command(b64(options.username), [334], "AUTH");
				await smtp.command(b64(options.password), [235], "AUTH");
			}
		}
		await smtp.command(`MAIL FROM:<${envelope.from}>`, [250], "MAIL FROM");
		await smtp.command(`RCPT TO:<${envelope.to}>`, [250, 251], "RCPT TO");
		await smtp.command("DATA", [354]);
		await smtp.send(dotStuff(data));
		await smtp.expect([250], "DATA");
		await smtp.command("QUIT", [221]).catch(() => undefined);
	} finally {
		clearTimeout(timer);
		await smtp.close();
	}
}
