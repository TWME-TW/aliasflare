/**
 * HTTPS client for aliasflare's Worker Mail Gateway API (/mail-api/v1).
 * The Bridge stores zero credentials and zero emails on disk; every protocol command proxies
 * directly to the Worker authenticated with the user's Mail App Password.
 */

export type GatewayCredentials = {
	username: string;
	password: string;
};

export type GatewayStatus = {
	ok: boolean;
	username: string;
	mailboxEnabled: boolean;
	protocols: { imap: boolean; pop3: boolean; smtp: boolean };
	pop3Folders: string[];
	pop3DeleteAction: "trash" | "archive" | "expunge";
	smtpFromPolicy: "existing_aliases" | "auto_create";
	smtpRateLimitPerHour: number;
};

export type ImapFolderInfo = {
	name: string;
	specialUse: string | null;
	uidvalidity: number;
	uidnext: number;
	exists: number;
	unseen: number;
};

export type ImapMessageSummary = {
	id: string;
	uid: number;
	flags: string[];
	size: number;
	internalDate: string;
	createdAt: number;
	subject: string;
	from: string;
	fromName: string | null;
	to: string;
	alias: string | null;
	snippet: string;
	reason: string | null;
};

export type Pop3MessageSummary = {
	id: string;
	uidl: string;
	folder: string;
	size: number;
	createdAt: number;
};

export class GatewayError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export class MailGatewayClient {
	private readonly baseUrl: string;
	private readonly fetcher: typeof fetch;

	constructor(baseUrl: string, fetcher: typeof fetch = fetch) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.fetcher = fetcher;
	}

	private authHeader(creds: GatewayCredentials): string {
		const token = Buffer.from(`${creds.username}:${creds.password}`, "utf8").toString("base64");
		return `Basic ${token}`;
	}

	private async requestJson<T>(creds: GatewayCredentials, path: string, init: RequestInit = {}): Promise<T> {
		const res = await this.fetcher(`${this.baseUrl}/mail-api/v1${path}`, {
			...init,
			headers: {
				Authorization: this.authHeader(creds),
				Accept: "application/json",
				...(init.body ? { "Content-Type": "application/json" } : {}),
				...(init.headers ?? {}),
			},
			signal: AbortSignal.timeout(25_000),
		});
		if (!res.ok) {
			const data = (await res.json().catch(() => null)) as { error?: string } | null;
			throw new GatewayError(res.status, data?.error || `Gateway HTTP ${res.status}`);
		}
		return (await res.json()) as T;
	}

	private async requestBytes(creds: GatewayCredentials, path: string): Promise<Buffer> {
		const res = await this.fetcher(`${this.baseUrl}/mail-api/v1${path}`, {
			method: "GET",
			headers: { Authorization: this.authHeader(creds) },
			signal: AbortSignal.timeout(30_000),
		});
		if (!res.ok) {
			throw new GatewayError(res.status, `Gateway HTTP ${res.status}`);
		}
		return Buffer.from(await res.arrayBuffer());
	}

	async status(creds: GatewayCredentials): Promise<GatewayStatus> {
		return this.requestJson<GatewayStatus>(creds, "/status");
	}

	async imapFolders(creds: GatewayCredentials): Promise<ImapFolderInfo[]> {
		const res = await this.requestJson<{ folders: ImapFolderInfo[] }>(creds, "/imap/folders");
		return res.folders;
	}

	async imapMessages(
		creds: GatewayCredentials,
		folder: string,
		sinceUid = 0,
	): Promise<{ folder: string; uidvalidity: number; uidnext: number; messages: ImapMessageSummary[] }> {
		const q = sinceUid > 0 ? `?sinceUid=${sinceUid}` : "";
		return this.requestJson(creds, `/imap/folders/${encodeURIComponent(folder)}/messages${q}`);
	}

	async imapRaw(creds: GatewayCredentials, id: string): Promise<Buffer> {
		return this.requestBytes(creds, `/imap/messages/${encodeURIComponent(id)}/raw`);
	}

	async imapFlags(creds: GatewayCredentials, id: string, body: { add?: string[]; remove?: string[]; set?: string[] }): Promise<string[]> {
		const res = await this.requestJson<{ flags: string[] }>(creds, `/imap/messages/${encodeURIComponent(id)}/flags`, {
			method: "PATCH",
			body: JSON.stringify(body),
		});
		return res.flags;
	}

	async imapMove(creds: GatewayCredentials, id: string, folder: string): Promise<{ id: string; folder: string; uid: number }> {
		return this.requestJson(creds, `/imap/messages/${encodeURIComponent(id)}/move`, {
			method: "POST",
			body: JSON.stringify({ folder }),
		});
	}

	async imapCopy(creds: GatewayCredentials, id: string, folder: string): Promise<{ id: string; folder: string; uid: number }> {
		return this.requestJson(creds, `/imap/messages/${encodeURIComponent(id)}/copy`, {
			method: "POST",
			body: JSON.stringify({ folder }),
		});
	}

	async imapExpunge(creds: GatewayCredentials, folder: string): Promise<number[]> {
		const res = await this.requestJson<{ expunged: number[] }>(creds, `/imap/folders/${encodeURIComponent(folder)}/expunge`, {
			method: "POST",
		});
		return res.expunged;
	}

	async imapAppend(creds: GatewayCredentials, folder: string, raw: Buffer, flags: string[] = []): Promise<{ id: string; uid: number }> {
		return this.requestJson(creds, `/imap/folders/${encodeURIComponent(folder)}/append`, {
			method: "POST",
			body: JSON.stringify({ raw: raw.toString("base64"), flags }),
		});
	}

	async pop3Messages(creds: GatewayCredentials): Promise<Pop3MessageSummary[]> {
		const res = await this.requestJson<{ messages: Pop3MessageSummary[] }>(creds, "/pop3/messages");
		return res.messages;
	}

	async pop3Raw(creds: GatewayCredentials, id: string): Promise<Buffer> {
		return this.requestBytes(creds, `/pop3/messages/${encodeURIComponent(id)}/raw`);
	}

	async pop3Delete(creds: GatewayCredentials, id: string): Promise<void> {
		await this.requestJson(creds, `/pop3/messages/${encodeURIComponent(id)}`, { method: "DELETE" });
	}

	async smtpSend(creds: GatewayCredentials, mailFrom: string, rcptTo: string[], raw: Buffer): Promise<{ ok: boolean; messageIds: string[] }> {
		return this.requestJson(creds, "/smtp/send", {
			method: "POST",
			body: JSON.stringify({ mailFrom, rcptTo, raw: raw.toString("base64") }),
		});
	}
}
