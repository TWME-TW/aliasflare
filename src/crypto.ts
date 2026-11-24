const encoder = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function hmacHex(secret: string, data: string): Promise<string> {
	const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(data));
	return toHex(new Uint8Array(signature));
}

export async function hmacBase64Url(secret: string, data: string): Promise<string> {
	const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(data));
	return toBase64Url(new Uint8Array(signature));
}

export function toHex(bytes: Uint8Array): string {
	let out = "";
	for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
	return out;
}

export function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let index = 0; index < bytes.length; index += chunk) {
		binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
	}
	return btoa(binary);
}

/** Constant-time string comparison. */
export function safeEqual(left: string, right: string): boolean {
	const a = encoder.encode(left);
	const b = encoder.encode(right);
	let diff = a.length ^ b.length;
	const length = Math.max(a.length, b.length);
	for (let index = 0; index < length; index += 1) diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
	return diff === 0;
}

/**
 * Compares two secrets of any length in constant time: both are hashed first, so the time
 * taken reveals neither their contents nor their lengths.
 */
export async function digestEqual(left: string, right: string): Promise<boolean> {
	const [a, b] = await Promise.all([left, right].map((value) => crypto.subtle.digest("SHA-256", encoder.encode(value))));
	return safeEqual(toHex(new Uint8Array(a!)), toHex(new Uint8Array(b!)));
}

/** Verifies Mailflare's webhook signature: hex HMAC-SHA256 of the raw body. */
export async function verifyWebhookSignature(secret: string, body: string, signature: string | null): Promise<boolean> {
	if (!signature) return false;
	return safeEqual(await hmacHex(secret, body), signature.trim().toLowerCase());
}

/** A signed, expiring token: `<payload>.<expiry>.<mac>`. The payload must not contain dots. */
export async function signToken(secret: string, purpose: string, payload: string, ttlSeconds: number): Promise<string> {
	const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
	const mac = await hmacBase64Url(secret, `${purpose}|${payload}|${expires}`);
	return `${payload}.${expires}.${mac}`;
}

export async function verifyToken(secret: string, purpose: string, token: string): Promise<string | null> {
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	const [payload, expiresText, mac] = parts as [string, string, string];
	const expires = Number(expiresText);
	if (!Number.isInteger(expires) || expires < Math.floor(Date.now() / 1000)) return null;
	const expected = await hmacBase64Url(secret, `${purpose}|${payload}|${expires}`);
	return safeEqual(expected, mac) ? payload : null;
}
