/**
 * Raw email blob storage for the built-in mailbox:
 * Priority: Cloudflare R2 binding (MAILBOX_BUCKET) > S3-compatible object storage (AWS S3, B2, MinIO, R2 S3 API, Garage) > D1 gzip fallback.
 *
 * S3 signing uses pure Web Crypto AWS SigV4 with zero third-party dependencies.
 */
import type { AppConfig } from "./config";
import { bytesToBase64 } from "./crypto";
import { safeHttpsUrl } from "./format";

function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
	return out;
}

export type StorageBackend = "auto" | "r2" | "s3" | "d1";
export type ResolvedStorageKind = "r2" | "s3" | "d1" | "headers_only";

export const STORAGE_BACKENDS: StorageBackend[] = ["auto", "r2", "s3", "d1"];
export function isStorageBackend(value: unknown): value is StorageBackend {
	return STORAGE_BACKENDS.includes(value as StorageBackend);
}

export type S3Options = {
	endpoint: string;
	bucket: string;
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
	pathStyle: boolean;
	prefix: string;
};

export const DEFAULT_S3_OPTIONS: S3Options = {
	endpoint: "",
	bucket: "",
	region: "auto",
	accessKeyId: "",
	secretAccessKey: "",
	pathStyle: true,
	prefix: "aliasflare/",
};

export function s3Ready(s3: S3Options | undefined | null): s3 is S3Options {
	return !!(s3 && s3.endpoint && s3.bucket && s3.accessKeyId && s3.secretAccessKey);
}

export function normalizeS3Prefix(prefix: string): string {
	const cleaned = prefix.trim().replace(/^\/+/, "").replace(/[^a-zA-Z0-9._/-]/g, "").slice(0, 120);
	if (!cleaned) return "";
	return cleaned.endsWith("/") ? cleaned : `${cleaned}/`;
}

/** Validates an S3 endpoint URL (public https, optional port for self-hosted MinIO/Garage, never own hosts). */
export function validS3Endpoint(value: string, blockedHosts: string[] = []): string | null {
	const trimmed = value.trim().replace(/\/+$/, "");
	if (!trimmed) return "";
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || url.username || url.password) return null;
	const hostCheck = new URL(url.href);
	hostCheck.port = "";
	if (!safeHttpsUrl(hostCheck.href, blockedHosts)) return null;
	return url.origin;
}

const encoder = new TextEncoder();
const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sha256HexBytes(data: Uint8Array): Promise<string> {
	return hex(await crypto.subtle.digest("SHA-256", data as BufferSource));
}

async function hmacSha256(key: ArrayBuffer | Uint8Array, text: string): Promise<ArrayBuffer> {
	const imported = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return crypto.subtle.sign("HMAC", imported, encoder.encode(text));
}

function encodeS3Path(path: string): string {
	return path
		.split("/")
		.map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
		.join("/");
}

/** Builds the S3 object URL and AWS SigV4 signed headers for PUT / GET / DELETE / HEAD. */
export async function signS3Request(input: {
	method: "GET" | "PUT" | "DELETE" | "HEAD";
	s3: S3Options;
	key: string;
	body?: Uint8Array;
	contentType?: string;
	date?: Date;
}): Promise<{ url: string; headers: Record<string, string> }> {
	const base = new URL(input.s3.endpoint);
	const cleanKey = input.key.replace(/^\/+/, "");
	let host = base.host;
	let canonicalUri: string;
	if (input.s3.pathStyle) {
		canonicalUri = `/${encodeS3Path(input.s3.bucket)}/${encodeS3Path(cleanKey)}`;
	} else {
		host = `${input.s3.bucket}.${base.host}`;
		canonicalUri = `/${encodeS3Path(cleanKey)}`;
	}
	const url = `${base.protocol}//${host}${canonicalUri}`;
	const date = input.date ?? new Date();
	const amzDate = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
	const day = amzDate.slice(0, 8);
	const region = input.s3.region.trim() || "auto";
	const payloadHash = await sha256HexBytes(input.body ?? new Uint8Array(0));

	const headerEntries: [string, string][] = [
		["host", host],
		["x-amz-content-sha256", payloadHash],
		["x-amz-date", amzDate],
	];
	if (input.contentType) headerEntries.push(["content-type", input.contentType]);
	headerEntries.sort(([a], [b]) => a.localeCompare(b));

	const canonicalHeaders = headerEntries.map(([k, v]) => `${k}:${v}\n`).join("");
	const signedHeaders = headerEntries.map(([k]) => k).join(";");
	const canonicalRequest = [input.method, canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
	const scope = `${day}/${region}/s3/aws4_request`;
	const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256HexBytes(encoder.encode(canonicalRequest))].join("\n");

	let signingKey = await hmacSha256(encoder.encode(`AWS4${input.s3.secretAccessKey}`), day);
	for (const part of [region, "s3", "aws4_request"]) signingKey = await hmacSha256(signingKey, part);
	const signature = hex(await hmacSha256(signingKey, stringToSign));

	const headers: Record<string, string> = {
		"X-Amz-Date": amzDate,
		"X-Amz-Content-Sha256": payloadHash,
		Authorization: `AWS4-HMAC-SHA256 Credential=${input.s3.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
	};
	if (input.contentType) headers["Content-Type"] = input.contentType;
	return { url, headers };
}

/** Gzip-compresses bytes using Web CompressionStream (falls back to raw if unavailable). */
async function compressBytes(raw: Uint8Array): Promise<{ encoding: "gzip" | "raw"; bytes: Uint8Array }> {
	if (typeof CompressionStream === "undefined") return { encoding: "raw", bytes: raw };
	try {
		const stream = new Response(raw as BodyInit).body!.pipeThrough(new CompressionStream("gzip"));
		const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
		return compressed.length < raw.length ? { encoding: "gzip", bytes: compressed } : { encoding: "raw", bytes: raw };
	} catch {
		return { encoding: "raw", bytes: raw };
	}
}

async function decompressBytes(bytes: Uint8Array, encoding: string): Promise<Uint8Array> {
	if (encoding !== "gzip" || typeof DecompressionStream === "undefined") return bytes;
	const stream = new Response(bytes as BodyInit).body!.pipeThrough(new DecompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Picks which backend is actually active given settings, R2 binding, and S3 config. */
export function resolveStorageBackend(env: Env, config: AppConfig, preferred: StorageBackend): "r2" | "s3" | "d1" {
	if (preferred === "r2") return env.MAILBOX_BUCKET ? "r2" : "d1";
	if (preferred === "s3") return s3Ready(config.mailboxS3) ? "s3" : "d1";
	if (preferred === "d1") return "d1";
	if (env.MAILBOX_BUCKET) return "r2";
	if (s3Ready(config.mailboxS3)) return "s3";
	return "d1";
}

/** Stores raw email bytes into R2, S3, or compressed D1. */
export async function putRawBlob(
	env: Env,
	config: AppConfig,
	preferred: StorageBackend,
	messageId: string,
	raw: Uint8Array,
): Promise<{ storageKind: "r2" | "s3" | "d1"; storageKey: string | null; storedBytes: number }> {
	const backend = resolveStorageBackend(env, config, preferred);
	if (backend === "r2" && env.MAILBOX_BUCKET) {
		const key = `raw/${messageId}.eml`;
		await env.MAILBOX_BUCKET.put(key, raw, { httpMetadata: { contentType: "message/rfc822" } });
		return { storageKind: "r2", storageKey: key, storedBytes: raw.byteLength };
	}
	if (backend === "s3" && s3Ready(config.mailboxS3)) {
		const prefix = normalizeS3Prefix(config.mailboxS3.prefix);
		const key = `${prefix}raw/${messageId}.eml`;
		const { url, headers } = await signS3Request({
			method: "PUT",
			s3: config.mailboxS3,
			key,
			body: raw,
			contentType: "message/rfc822",
		});
		const response = await fetch(url, { method: "PUT", headers, body: raw as BodyInit, redirect: "manual", signal: AbortSignal.timeout(15_000) });
		await response.body?.cancel().catch(() => undefined);
		if (!response.ok) throw new Error(`S3 PUT failed: HTTP ${response.status}`);
		return { storageKind: "s3", storageKey: key, storedBytes: raw.byteLength };
	}
	const { encoding, bytes } = await compressBytes(raw);
	const b64 = bytesToBase64(bytes);
	await env.DB.prepare(
		"INSERT INTO mailbox_blobs (message_id, encoding, raw_base64, stored_bytes) VALUES (?, ?, ?, ?) ON CONFLICT (message_id) DO UPDATE SET encoding = excluded.encoding, raw_base64 = excluded.raw_base64, stored_bytes = excluded.stored_bytes",
	)
		.bind(messageId, encoding, b64, bytes.byteLength)
		.run();
	return { storageKind: "d1", storageKey: null, storedBytes: bytes.byteLength };
}

/** Reads raw email bytes back from R2, S3, or D1. Returns null if headers_only or missing. */
export async function getRawBlob(
	env: Env,
	config: AppConfig,
	record: { id: string; storage_kind: string; storage_key: string | null },
): Promise<Uint8Array | null> {
	if (record.storage_kind === "r2" && record.storage_key && env.MAILBOX_BUCKET) {
		const obj = await env.MAILBOX_BUCKET.get(record.storage_key);
		return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
	}
	if (record.storage_kind === "s3" && record.storage_key && s3Ready(config.mailboxS3)) {
		const { url, headers } = await signS3Request({ method: "GET", s3: config.mailboxS3, key: record.storage_key });
		const response = await fetch(url, { method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(15_000) });
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			return null;
		}
		return new Uint8Array(await response.arrayBuffer());
	}
	if (record.storage_kind === "d1") {
		const row = await env.DB.prepare("SELECT encoding, raw_base64 FROM mailbox_blobs WHERE message_id = ?")
			.bind(record.id)
			.first<{ encoding: string; raw_base64: string }>();
		if (!row) return null;
		return decompressBytes(base64ToBytes(row.raw_base64), row.encoding);
	}
	return null;
}

/** Removes raw email bytes from R2, S3, or D1 (best-effort for external object stores). */
export async function deleteRawBlob(
	env: Env,
	config: AppConfig,
	record: { id: string; storage_kind: string; storage_key: string | null },
): Promise<void> {
	if (record.storage_kind === "r2" && record.storage_key && env.MAILBOX_BUCKET) {
		await env.MAILBOX_BUCKET.delete(record.storage_key).catch(() => undefined);
		return;
	}
	if (record.storage_kind === "s3" && record.storage_key && s3Ready(config.mailboxS3)) {
		const { url, headers } = await signS3Request({ method: "DELETE", s3: config.mailboxS3, key: record.storage_key });
		const response = await fetch(url, { method: "DELETE", headers, redirect: "manual", signal: AbortSignal.timeout(10_000) }).catch(() => null);
		await response?.body?.cancel().catch(() => undefined);
		return;
	}
	if (record.storage_kind === "d1") {
		await env.DB.prepare("DELETE FROM mailbox_blobs WHERE message_id = ?").bind(record.id).run();
	}
}

/** Tests connectivity and write/delete permissions against an S3-compatible bucket. */
export async function testS3Connection(s3: S3Options): Promise<{ ok: boolean; detail: string }> {
	if (!s3Ready(s3)) return { ok: false, detail: "S3 configuration is incomplete" };
	const probeKey = `${normalizeS3Prefix(s3.prefix)}.aliasflare-probe-${crypto.randomUUID()}`;
	const body = encoder.encode("aliasflare");
	try {
		const put = await signS3Request({ method: "PUT", s3, key: probeKey, body, contentType: "text/plain" });
		const putRes = await fetch(put.url, { method: "PUT", headers: put.headers, body, redirect: "manual", signal: AbortSignal.timeout(10_000) });
		await putRes.body?.cancel().catch(() => undefined);
		if (!putRes.ok) return { ok: false, detail: `PUT failed: HTTP ${putRes.status}` };
		const del = await signS3Request({ method: "DELETE", s3, key: probeKey });
		const delRes = await fetch(del.url, { method: "DELETE", headers: del.headers, redirect: "manual", signal: AbortSignal.timeout(10_000) });
		await delRes.body?.cancel().catch(() => undefined);
		return { ok: true, detail: "Connected (PUT & DELETE succeeded)" };
	} catch (error) {
		return { ok: false, detail: error instanceof Error ? error.message : String(error) };
	}
}
