/**
 * Stateless IMAP4rev1 server (RFC 3501 + UIDPLUS/MOVE/SPECIAL-USE/IDLE/STARTTLS)
 * backed by aliasflare's Mail Gateway API (/mail-api/v1/imap/*).
 */
import net from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import { GatewayError, type GatewayCredentials, type ImapMessageSummary, type MailGatewayClient } from "./gateway.js";

export type BridgeTlsOptions = {
	cert: Buffer;
	key: Buffer;
};

export type ImapServerOptions = {
	gateway: MailGatewayClient;
	tls?: BridgeTlsOptions;
	allowPlaintextAuth?: boolean;
	/** Milliseconds between lightweight folder-status checks during IMAP IDLE (default 60s, min 15s). */
	idlePollMs?: number;
};

const MAX_IMAP_BUFFER_BYTES = 10 * 1024 * 1024 + 64 * 1024;
const MAX_PENDING_IMAP_COMMANDS = 128;

function quoteImap(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n\0]/g, " ")}"`;
}

function formatImapDate(epochSec: number): string {
	const d = new Date(epochSec * 1000);
	const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	const day = String(d.getUTCDate()).padStart(2, " ");
	const mon = months[d.getUTCMonth()];
	const yr = d.getUTCFullYear();
	const hh = String(d.getUTCHours()).padStart(2, "0");
	const mm = String(d.getUTCMinutes()).padStart(2, "0");
	const ss = String(d.getUTCSeconds()).padStart(2, "0");
	return `"${day}-${mon}-${yr} ${hh}:${mm}:${ss} +0000"`;
}

function parseAddressTuple(address: string, name?: string | null): string {
	const clean = address.trim();
	const at = clean.indexOf("@");
	const local = at >= 0 ? clean.slice(0, at) : clean;
	const domain = at >= 0 ? clean.slice(at + 1) : "invalid";
	return `((${name ? quoteImap(name) : "NIL"} NIL ${quoteImap(local || "unknown")} ${quoteImap(domain || "invalid")}))`;
}

function buildEnvelope(msg: ImapMessageSummary): string {
	const dateStr = quoteImap(new Date(msg.createdAt * 1000).toUTCString());
	const subject = quoteImap(msg.subject || "");
	const from = parseAddressTuple(msg.from || "unknown@invalid", msg.fromName);
	const to = parseAddressTuple(msg.to || msg.alias || "unknown@invalid");
	const msgId = quoteImap(`<${msg.id}@aliasflare.local>`);
	return `(${dateStr} ${subject} ${from} ${from} ${from} ${to} NIL NIL NIL ${msgId})`;
}

/** Parses an IMAP sequence set like "1,3:5,10:*" against available sequence numbers or UIDs. */
export function matchSequenceSet<T extends { seq: number; uid: number }>(setStr: string, items: T[], isUid: boolean): T[] {
	if (!items.length) return [];
	const maxVal = isUid ? items[items.length - 1]!.uid : items.length;
	const ranges = setStr.split(",").map((part) => part.trim()).filter(Boolean);
	const matched = new Set<number>();
	for (const range of ranges) {
		const [rawStart, rawEnd] = range.split(":");
		const parseVal = (v: string) => (v === "*" ? maxVal : Number.parseInt(v, 10));
		const start = parseVal(rawStart!);
		const end = rawEnd !== undefined ? parseVal(rawEnd) : start;
		if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
		const lo = Math.min(start, end);
		const hi = Math.max(start, end);
		for (const item of items) {
			const v = isUid ? item.uid : item.seq;
			if (v >= lo && v <= hi) matched.add(item.uid);
		}
	}
	return items.filter((item) => matched.has(item.uid));
}

function tokenizeArgs(rest: string): string[] {
	const tokens: string[] = [];
	let i = 0;
	while (i < rest.length) {
		while (i < rest.length && rest[i] === " ") i += 1;
		if (i >= rest.length) break;
		if (rest[i] === '"') {
			i += 1;
			let val = "";
			while (i < rest.length && rest[i] !== '"') {
				if (rest[i] === "\\" && i + 1 < rest.length) {
					i += 1;
					val += rest[i];
				} else {
					val += rest[i];
				}
				i += 1;
			}
			i += 1; // closing quote
			tokens.push(val);
		} else if (rest[i] === "(") {
			let depth = 0;
			const start = i;
			while (i < rest.length) {
				if (rest[i] === "(") depth += 1;
				else if (rest[i] === ")") {
					depth -= 1;
					if (depth === 0) {
						i += 1;
						break;
					}
				}
				i += 1;
			}
			tokens.push(rest.slice(start, i));
		} else {
			const start = i;
			while (i < rest.length && rest[i] !== " ") i += 1;
			tokens.push(rest.slice(start, i));
		}
	}
	return tokens;
}

function splitHeadersAndBody(raw: Buffer): { headers: Buffer; body: Buffer } {
	const crlfIdx = raw.indexOf("\r\n\r\n");
	if (crlfIdx >= 0) {
		return { headers: raw.subarray(0, crlfIdx + 4), body: raw.subarray(crlfIdx + 4) };
	}
	const lfIdx = raw.indexOf("\n\n");
	if (lfIdx >= 0) {
		return { headers: raw.subarray(0, lfIdx + 2), body: raw.subarray(lfIdx + 2) };
	}
	return { headers: raw, body: Buffer.alloc(0) };
}

function filterHeaderFields(headersBuf: Buffer, wanted: string[]): Buffer {
	const set = new Set(wanted.map((h) => h.toLowerCase()));
	const lines = headersBuf.toString("utf8").split(/\r?\n/);
	const out: string[] = [];
	let keep = false;
	for (const line of lines) {
		if (line === "") break;
		if (/^[ \t]/.test(line)) {
			if (keep) out.push(line);
			continue;
		}
		const colon = line.indexOf(":");
		if (colon > 0) {
			const name = line.slice(0, colon).trim().toLowerCase();
			keep = set.has(name);
			if (keep) out.push(line);
		} else {
			keep = false;
		}
	}
	return Buffer.from(`${out.join("\r\n")}\r\n\r\n`, "utf8");
}

function resolveFolderName(raw: string): string {
	const clean = raw.trim();
	if (clean.toUpperCase() === "INBOX") return "INBOX";
	const canonical = ["INBOX", "Skipped", "Failed", "Sent", "Trash"];
	return canonical.find((f) => f.toLowerCase() === clean.toLowerCase()) ?? clean;
}

export function attachImapSession(socket: Duplex, opts: ImapServerOptions, initialSecure = false): void {
	let activeSocket: Duplex = socket;
	let isSecure = initialSecure;
	let creds: GatewayCredentials | null = null;
	let selectedFolder: string | null = null;
	let selectedUidNext = 0;
	let readOnly = false;
	let cachedMessages: (ImapMessageSummary & { seq: number })[] = [];
	let idleTag: string | null = null;
	let idleTimer: ReturnType<typeof setInterval> | null = null;
	let idleInFlight = false;
	let pendingAuthPlainTag: string | null = null;
	let pendingAppend: { tag: string; folder: string; flags: string[]; remaining: number; chunks: Buffer[] } | null = null;
	let buffer = Buffer.alloc(0);
	let processing = Promise.resolve();
	let pendingCommands = 0;
	// Raised by STARTTLS: lines that arrived in the clear behind it are dropped, not run under TLS.
	let generation = 0;
	// Set while a line that announced a literal waits for its handler.
	let awaitingLiteral = false;
	const idlePollMs = Math.max(15_000, opts.idlePollMs ?? 60_000);
	// RFC 3501 5.4: an autologout timer of at least 30 minutes (IDLE clients re-issue within 29).
	if (socket instanceof net.Socket) socket.setTimeout(31 * 60_000, () => socket.destroy());

	const write = (text: string | Buffer) => {
		if (!activeSocket.destroyed && activeSocket.writable) activeSocket.write(text);
	};

	const stopIdle = () => {
		if (idleTimer) {
			clearInterval(idleTimer);
			idleTimer = null;
		}
		idleInFlight = false;
		idleTag = null;
	};

	const capabilities = () => {
		const caps = ["IMAP4rev1", "UIDPLUS", "MOVE", "SPECIAL-USE", "IDLE", "LITERAL+"];
		if (!isSecure && opts.tls) caps.push("STARTTLS");
		if (isSecure || opts.allowPlaintextAuth) caps.push("AUTH=PLAIN");
		else caps.push("LOGINDISABLED");
		return caps.join(" ");
	};

	const refreshSelected = async () => {
		if (!creds || !selectedFolder) return null;
		const data = await opts.gateway.imapMessages(creds, selectedFolder);
		cachedMessages = data.messages.map((m, i) => ({ ...m, seq: i + 1 }));
		selectedUidNext = data.uidnext;
		return data;
	};

	/** Checks lightweight folder counters before fetching the full message list. */
	const syncSelectedIfChanged = async (): Promise<boolean> => {
		if (!creds || !selectedFolder) return false;
		const folders = await opts.gateway.imapFolders(creds);
		const info = folders.find((f) => f.name === selectedFolder);
		if (!info) return false;
		if (info.exists === cachedMessages.length && info.uidnext === selectedUidNext) return false;
		await refreshSelected();
		return true;
	};

	const handleLine = async (line: string) => {
		if (idleTag) {
			if (line.trim().toUpperCase() === "DONE") {
				const t = idleTag;
				stopIdle();
				write(`${t} OK IDLE terminated\r\n`);
			}
			return;
		}

		if (pendingAuthPlainTag) {
			const tag = pendingAuthPlainTag;
			pendingAuthPlainTag = null;
			await completeAuthPlain(tag, line.trim());
			return;
		}

		const firstSpace = line.indexOf(" ");
		if (firstSpace <= 0) return;
		const tag = line.slice(0, firstSpace);
		const remainder = line.slice(firstSpace + 1).trim();
		const cmdSpace = remainder.indexOf(" ");
		const cmd = (cmdSpace < 0 ? remainder : remainder.slice(0, cmdSpace)).toUpperCase();
		const argStr = cmdSpace < 0 ? "" : remainder.slice(cmdSpace + 1).trim();

		try {
			if (cmd === "CAPABILITY") {
				write(`* CAPABILITY ${capabilities()}\r\n${tag} OK CAPABILITY completed\r\n`);
				return;
			}
			if (cmd === "NOOP") {
				if (creds && selectedFolder) {
					const prevCount = cachedMessages.length;
					// An explicit NOOP refreshes fully, so flag changes made elsewhere reach the client;
					// only the IDLE timer uses the lighter counter check.
					await refreshSelected();
					if (cachedMessages.length !== prevCount) write(`* ${cachedMessages.length} EXISTS\r\n`);
				}
				write(`${tag} OK NOOP completed\r\n`);
				return;
			}
			if (cmd === "LOGOUT") {
				stopIdle();
				write(`* BYE aliasflare IMAP closing\r\n${tag} OK LOGOUT completed\r\n`);
				activeSocket.end();
				return;
			}
			if (cmd === "STARTTLS") {
				if (isSecure || !opts.tls || !(activeSocket instanceof net.Socket)) {
					write(`${tag} BAD STARTTLS unavailable\r\n`);
					return;
				}
				write(`${tag} OK Begin TLS negotiation now\r\n`);
				const rawSock = activeSocket;
				rawSock.removeAllListeners("data");
				generation += 1;
				buffer = Buffer.alloc(0);
				const tlsSock = new tls.TLSSocket(rawSock, { isServer: true, cert: opts.tls.cert, key: opts.tls.key });
				activeSocket = tlsSock;
				isSecure = true;
				bindSocketEvents(tlsSock);
				return;
			}
			if (cmd === "LOGIN") {
				if (!isSecure && !opts.allowPlaintextAuth) {
					write(`${tag} NO [PRIVACYREQUIRED] TLS required for LOGIN\r\n`);
					return;
				}
				const [username, password] = tokenizeArgs(argStr);
				if (!username || !password) {
					write(`${tag} BAD Missing username or password\r\n`);
					return;
				}
				await verifyAndLogin(tag, username, password);
				return;
			}
			if (cmd === "AUTHENTICATE") {
				const args = tokenizeArgs(argStr);
				if ((args[0] ?? "").toUpperCase() !== "PLAIN") {
					write(`${tag} NO Unsupported auth mechanism\r\n`);
					return;
				}
				if (!isSecure && !opts.allowPlaintextAuth) {
					write(`${tag} NO [PRIVACYREQUIRED] TLS required\r\n`);
					return;
				}
				if (args[1]) {
					await completeAuthPlain(tag, args[1]);
				} else {
					pendingAuthPlainTag = tag;
					write("+ \r\n");
				}
				return;
			}

			if (!creds) {
				write(`${tag} NO Authentication required\r\n`);
				return;
			}

			if (cmd === "LIST" || cmd === "LSUB") {
				const [, pattern = "*"] = tokenizeArgs(argStr);
				if (pattern === "") {
					write(`* ${cmd} (\\Noselect) "/" ""\r\n${tag} OK ${cmd} completed\r\n`);
					return;
				}
				const folders = await opts.gateway.imapFolders(creds);
				for (const f of folders) {
					if (pattern !== "*" && pattern !== "%" && f.name.toLowerCase() !== pattern.toLowerCase()) continue;
					const attrs = ["\\HasNoChildren"];
					if (f.specialUse) attrs.push(f.specialUse);
					write(`* ${cmd} (${attrs.join(" ")}) "/" ${quoteImap(f.name)}\r\n`);
				}
				write(`${tag} OK ${cmd} completed\r\n`);
				return;
			}

			if (cmd === "STATUS") {
				const args = tokenizeArgs(argStr);
				const folderName = resolveFolderName(args[0] ?? "");
				const wanted = (args[1] ?? "(MESSAGES UNSEEN UIDNEXT UIDVALIDITY)").replace(/[()]/g, "").toUpperCase().split(/\s+/);
				const folders = await opts.gateway.imapFolders(creds);
				const info = folders.find((f) => f.name === folderName);
				if (!info) {
					write(`${tag} NO Folder does not exist\r\n`);
					return;
				}
				const pairs: string[] = [];
				for (const item of wanted) {
					if (item === "MESSAGES") pairs.push(`MESSAGES ${info.exists}`);
					else if (item === "UNSEEN") pairs.push(`UNSEEN ${info.unseen}`);
					else if (item === "UIDNEXT") pairs.push(`UIDNEXT ${info.uidnext}`);
					else if (item === "UIDVALIDITY") pairs.push(`UIDVALIDITY ${info.uidvalidity}`);
					else if (item === "RECENT") pairs.push("RECENT 0");
				}
				write(`* STATUS ${quoteImap(info.name)} (${pairs.join(" ")})\r\n${tag} OK STATUS completed\r\n`);
				return;
			}

			if (cmd === "SELECT" || cmd === "EXAMINE") {
				const [rawFolder] = tokenizeArgs(argStr);
				const folderName = resolveFolderName(rawFolder ?? "");
				selectedFolder = folderName;
				readOnly = cmd === "EXAMINE";
				const data = await refreshSelected();
				if (!data) {
					write(`${tag} NO Unable to open folder\r\n`);
					return;
				}
				const firstUnseen = cachedMessages.find((m) => !m.flags.includes("\\Seen"));
				write(`* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)\r\n`);
				write(`* OK [PERMANENTFLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft \\*)] Flags permitted\r\n`);
				write(`* ${cachedMessages.length} EXISTS\r\n`);
				write(`* 0 RECENT\r\n`);
				if (firstUnseen) write(`* OK [UNSEEN ${firstUnseen.seq}] First unseen\r\n`);
				write(`* OK [UIDVALIDITY ${data.uidvalidity}] UIDs valid\r\n`);
				write(`* OK [UIDNEXT ${data.uidnext}] Predicted next UID\r\n`);
				write(`${tag} OK [${readOnly ? "READ-ONLY" : "READ-WRITE"}] ${cmd} completed\r\n`);
				return;
			}

			if (cmd === "CLOSE") {
				if (selectedFolder && !readOnly) {
					await opts.gateway.imapExpunge(creds, selectedFolder);
				}
				selectedFolder = null;
				cachedMessages = [];
				write(`${tag} OK CLOSE completed\r\n`);
				return;
			}

			if (cmd === "EXPUNGE") {
				if (!selectedFolder) {
					write(`${tag} BAD No folder selected\r\n`);
					return;
				}
				if (readOnly) {
					write(`${tag} NO Folder is read-only\r\n`);
					return;
				}
				const expungedUids = await opts.gateway.imapExpunge(creds, selectedFolder);
				const expungedSet = new Set(expungedUids);
				let removedSoFar = 0;
				for (const msg of cachedMessages) {
					if (expungedSet.has(msg.uid)) {
						write(`* ${msg.seq - removedSoFar} EXPUNGE\r\n`);
						removedSoFar += 1;
					}
				}
				await refreshSelected();
				write(`${tag} OK EXPUNGE completed\r\n`);
				return;
			}

			if (cmd === "IDLE") {
				idleTag = tag;
				write("+ idling\r\n");
				idleTimer = setInterval(async () => {
					if (!creds || !selectedFolder || !idleTag || idleInFlight) return;
					idleInFlight = true;
					try {
						const prev = cachedMessages.length;
						const changed = await syncSelectedIfChanged();
						if (changed && cachedMessages.length !== prev) {
							write(`* ${cachedMessages.length} EXISTS\r\n`);
						}
					} catch {
						// Ignore transient polling errors during IDLE.
					} finally {
						idleInFlight = false;
					}
				}, idlePollMs);
				return;
			}

			if (cmd === "APPEND") {
				const litMatch = argStr.match(/\{(\d+)\+?\}$/);
				if (!litMatch) {
					write(`${tag} BAD Expected literal size\r\n`);
					return;
				}
				const size = Number.parseInt(litMatch[1]!, 10);
				if (!Number.isFinite(size) || size <= 0 || size > 10 * 1024 * 1024) {
					write(`${tag} NO Message size invalid or too large\r\n`);
					return;
				}
				const prefix = argStr.slice(0, litMatch.index).trim();
				const tokens = tokenizeArgs(prefix);
				const folder = resolveFolderName(tokens[0] ?? "Sent");
				const flagTok = tokens.find((t) => t.startsWith("(") && t.endsWith(")"));
				const flags = flagTok ? flagTok.slice(1, -1).trim().split(/\s+/).filter(Boolean) : [];
				pendingAppend = { tag, folder, flags, remaining: size, chunks: [] };
				if (!argStr.endsWith("+}")) write("+ Ready for literal data\r\n");
				return;
			}

			// Commands that support both direct and `UID <cmd>` forms.
			let isUid = false;
			let subCmd = cmd;
			let subArgs = argStr;
			if (cmd === "UID") {
				isUid = true;
				const sp = argStr.indexOf(" ");
				subCmd = (sp < 0 ? argStr : argStr.slice(0, sp)).toUpperCase();
				subArgs = sp < 0 ? "" : argStr.slice(sp + 1).trim();
			}

			if (!selectedFolder) {
				write(`${tag} BAD Select a mailbox first\r\n`);
				return;
			}

			if (subCmd === "SEARCH") {
				const terms = subArgs.toUpperCase().split(/\s+/).filter(Boolean);
				const matches = cachedMessages.filter((m) => {
					for (let i = 0; i < terms.length; i += 1) {
						const t = terms[i]!;
						if (t === "UNSEEN" && m.flags.includes("\\Seen")) return false;
						if (t === "SEEN" && !m.flags.includes("\\Seen")) return false;
						if (t === "FLAGGED" && !m.flags.includes("\\Flagged")) return false;
						if (t === "DELETED" && !m.flags.includes("\\Deleted")) return false;
						if (t === "UID" && terms[i + 1]) {
							const setMatches = matchSequenceSet(terms[i + 1]!, [m], true);
							if (!setMatches.length) return false;
							i += 1;
						}
					}
					return true;
				});
				const ids = matches.map((m) => (isUid ? m.uid : m.seq)).join(" ");
				write(`* SEARCH${ids ? ` ${ids}` : ""}\r\n${tag} OK SEARCH completed\r\n`);
				return;
			}

			if (subCmd === "FETCH") {
				const sp = subArgs.indexOf(" ");
				const setStr = sp < 0 ? subArgs : subArgs.slice(0, sp);
				const itemsRaw = (sp < 0 ? "ALL" : subArgs.slice(sp + 1)).trim();
				const targets = matchSequenceSet(setStr, cachedMessages, isUid);
				const upper = itemsRaw.toUpperCase();
				const wantsFlags = upper.includes("FLAGS") || upper.includes("FAST") || upper.includes("ALL") || upper.includes("FULL");
				const wantsUid = isUid || upper.includes("UID");
				const wantsSize = upper.includes("RFC822.SIZE") || upper.includes("FAST") || upper.includes("ALL") || upper.includes("FULL");
				const wantsInternalDate = upper.includes("INTERNALDATE") || upper.includes("FAST") || upper.includes("ALL") || upper.includes("FULL");
				const wantsEnvelope = upper.includes("ENVELOPE") || upper.includes("ALL") || upper.includes("FULL");
				const wantsFullBody =
					/\bRFC822\b(?!\.SIZE)/.test(upper) || /\bBODY(?:\.PEEK)?\[\]/.test(upper);
				const wantsHeader = /\bBODY(?:\.PEEK)?\[HEADER\]/.test(upper);
				const headerFieldsMatch = itemsRaw.match(/BODY(?:\.PEEK)?\[HEADER\.FIELDS \(([^)]+)\)\]/i);
				const wantsText = /\bBODY(?:\.PEEK)?\[TEXT\]/.test(upper);
				const isPeek = upper.includes("BODY.PEEK");

				for (const msg of targets) {
					const parts: (string | Buffer)[] = [];
					if (wantsUid) parts.push(`UID ${msg.uid}`);
					if (wantsFlags) parts.push(`FLAGS (${msg.flags.join(" ")})`);
					if (wantsSize) parts.push(`RFC822.SIZE ${msg.size}`);
					if (wantsInternalDate) parts.push(`INTERNALDATE ${formatImapDate(msg.createdAt)}`);
					if (wantsEnvelope) parts.push(`ENVELOPE ${buildEnvelope(msg)}`);

					if (wantsFullBody || wantsHeader || headerFieldsMatch || wantsText) {
						const raw = await opts.gateway.imapRaw(creds, msg.id);
						if (!isPeek && !readOnly && !msg.flags.includes("\\Seen")) {
							msg.flags = await opts.gateway.imapFlags(creds, msg.id, { add: ["\\Seen"] });
						}
						const { headers, body } = splitHeadersAndBody(raw);
						if (wantsFullBody) {
							const label = /\bRFC822\b(?!\.SIZE)/.test(upper) ? "RFC822" : "BODY[]";
							parts.push(Buffer.concat([Buffer.from(`${label} {${raw.byteLength}}\r\n`), raw]));
						}
						if (wantsHeader) {
							parts.push(Buffer.concat([Buffer.from(`BODY[HEADER] {${headers.byteLength}}\r\n`), headers]));
						}
						if (headerFieldsMatch) {
							const fieldNames = headerFieldsMatch[1]!.trim().split(/\s+/);
							const filtered = filterHeaderFields(headers, fieldNames);
							const label = `BODY[HEADER.FIELDS (${headerFieldsMatch[1]})]`;
							parts.push(Buffer.concat([Buffer.from(`${label} {${filtered.byteLength}}\r\n`), filtered]));
						}
						if (wantsText) {
							parts.push(Buffer.concat([Buffer.from(`BODY[TEXT] {${body.byteLength}}\r\n`), body]));
						}
					}

					write(`* ${msg.seq} FETCH (`);
					for (let i = 0; i < parts.length; i += 1) {
						if (i > 0) write(" ");
						write(parts[i]!);
					}
					write(")\r\n");
				}
				write(`${tag} OK FETCH completed\r\n`);
				return;
			}

			if (subCmd === "STORE") {
				if (readOnly) {
					write(`${tag} NO Folder is read-only\r\n`);
					return;
				}
				const tokens = tokenizeArgs(subArgs);
				const setStr = tokens[0] ?? "";
				const action = (tokens[1] ?? "").toUpperCase();
				const flagTok = (tokens[2] ?? "").replace(/[()]/g, "").trim();
				const flags = flagTok ? flagTok.split(/\s+/).filter(Boolean) : [];
				const silent = action.includes(".SILENT");
				const targets = matchSequenceSet(setStr, cachedMessages, isUid);
				for (const msg of targets) {
					const payload = action.startsWith("+") ? { add: flags } : action.startsWith("-") ? { remove: flags } : { set: flags };
					msg.flags = await opts.gateway.imapFlags(creds, msg.id, payload);
					if (!silent) {
						write(`* ${msg.seq} FETCH (UID ${msg.uid} FLAGS (${msg.flags.join(" ")}))\r\n`);
					}
				}
				write(`${tag} OK STORE completed\r\n`);
				return;
			}

			if (subCmd === "COPY" || subCmd === "MOVE") {
				if (subCmd === "MOVE" && readOnly) {
					write(`${tag} NO Folder is read-only\r\n`);
					return;
				}
				const tokens = tokenizeArgs(subArgs);
				const setStr = tokens[0] ?? "";
				const dest = resolveFolderName(tokens[1] ?? "");
				const targets = matchSequenceSet(setStr, cachedMessages, isUid);
				for (const msg of targets) {
					if (subCmd === "MOVE") await opts.gateway.imapMove(creds, msg.id, dest);
					else await opts.gateway.imapCopy(creds, msg.id, dest);
				}
				if (subCmd === "MOVE") await refreshSelected();
				write(`${tag} OK ${subCmd} completed\r\n`);
				return;
			}

			write(`${tag} BAD Unknown command ${cmd}\r\n`);
		} catch (error) {
			const msg = error instanceof GatewayError ? error.message : "Server error";
			write(`${tag} NO ${msg}\r\n`);
		}
	};

	const verifyAndLogin = async (tag: string, username: string, password: string) => {
		const candidate = { username, password };
		const status = await opts.gateway.status(candidate);
		if (!status.protocols.imap) {
			write(`${tag} NO IMAP is disabled for this account or password\r\n`);
			return;
		}
		creds = candidate;
		write(`${tag} OK [CAPABILITY ${capabilities()}] LOGIN completed\r\n`);
	};

	const completeAuthPlain = async (tag: string, b64: string) => {
		const decoded = Buffer.from(b64, "base64").toString("utf8");
		const parts = decoded.split("\0");
		const username = parts[1] ?? "";
		const password = parts[2] ?? "";
		if (!username || !password) {
			write(`${tag} NO Invalid AUTHENTICATE PLAIN payload\r\n`);
			return;
		}
		await verifyAndLogin(tag, username, password);
	};

	const pump = () => {
		while (buffer.length > 0 && !awaitingLiteral) {
			if (pendingAppend) {
				const take = Math.min(pendingAppend.remaining, buffer.length);
				pendingAppend.chunks.push(buffer.subarray(0, take));
				buffer = buffer.subarray(take);
				pendingAppend.remaining -= take;
				if (pendingAppend.remaining === 0) {
					const job = pendingAppend;
					pendingAppend = null;
					// Consume optional trailing CRLF after literal.
					if (buffer.length >= 2 && buffer[0] === 13 && buffer[1] === 10) buffer = buffer.subarray(2);
					else if (buffer.length >= 1 && buffer[0] === 10) buffer = buffer.subarray(1);
					processing = processing.then(async () => {
						if (!creds) {
							write(`${job.tag} NO Authentication required\r\n`);
							return;
						}
						try {
							const raw = Buffer.concat(job.chunks);
							await opts.gateway.imapAppend(creds, job.folder, raw, job.flags);
							write(`${job.tag} OK APPEND completed\r\n`);
						} catch (error) {
							write(`${job.tag} NO ${error instanceof Error ? error.message : "APPEND failed"}\r\n`);
						}
					});
				}
				continue;
			}
			const nl = buffer.indexOf(10);
			if (nl < 0) break;
			if (pendingCommands >= MAX_PENDING_IMAP_COMMANDS) {
				write("* BYE Too many queued commands\r\n");
				activeSocket.destroy();
				return;
			}
			const line = buffer.subarray(0, nl).toString("utf8").replace(/\r$/, "");
			buffer = buffer.subarray(nl + 1);
			const gen = generation;
			// A line announcing a literal ({N}, or LITERAL+ {N+}) is handled before more bytes are read
			// as lines: its handler decides whether those bytes are the literal.
			const literalAhead = /\{\d+\+?\}$/.test(line);
			if (literalAhead) awaitingLiteral = true;
			pendingCommands += 1;
			processing = processing
				.then(() => (gen === generation ? handleLine(line) : undefined))
				.catch(() => undefined)
				.then(() => {
					pendingCommands = Math.max(0, pendingCommands - 1);
					if (!literalAhead) return;
					awaitingLiteral = false;
					pump();
				});
			if (literalAhead) break;
		}
		// Cap buffer unconditionally (even while awaiting a literal) so pipelined floods cannot OOM the bridge.
		if (buffer.length > MAX_IMAP_BUFFER_BYTES) {
			write("* BYE Buffer limit exceeded\r\n");
			activeSocket.destroy();
			return;
		}
		// A command line (literals aside, which are counted above) is never this long.
		if (!pendingAppend && !awaitingLiteral && buffer.length > 64 * 1024) {
			write("* BYE Line too long\r\n");
			activeSocket.destroy();
		}
	};

	const bindSocketEvents = (sock: Duplex) => {
		sock.on("data", (chunk: Buffer | string) => {
			buffer = Buffer.concat([buffer, typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk]);
			pump();
		});
		sock.on("close", stopIdle);
		sock.on("error", () => {
			stopIdle();
			sock.destroy();
		});
	};

	bindSocketEvents(activeSocket);
	write(`* OK [CAPABILITY ${capabilities()}] aliasflare IMAP Bridge ready\r\n`);
}

export function createImapServer(opts: ImapServerOptions, implicitTls = false): net.Server {
	if (implicitTls && opts.tls) {
		return tls.createServer({ cert: opts.tls.cert, key: opts.tls.key }, (sock) => attachImapSession(sock, opts, true));
	}
	return net.createServer((sock) => attachImapSession(sock, opts, false));
}
