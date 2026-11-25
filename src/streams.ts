/**
 * Reads a body up to `max` bytes. Returns null, after cancelling the rest, when the body is
 * longer, so a large or endless body is never buffered whole.
 */
export async function readLimited(body: ReadableStream<Uint8Array> | null | undefined, max: number): Promise<Uint8Array | null> {
	if (!body) return new Uint8Array(0);
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > max) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

/** A request or response body as text, up to `max` bytes; null when it is longer or says it will be. */
export async function readTextLimited(response: { headers: Headers; body: ReadableStream<Uint8Array> | null }, max: number): Promise<string | null> {
	if (Number(response.headers.get("Content-Length") ?? 0) > max) {
		await response.body?.cancel();
		return null;
	}
	const bytes = await readLimited(response.body, max);
	return bytes ? new TextDecoder().decode(bytes) : null;
}

/** Lets go of a response whose body is not needed, so its connection is not held open. */
export async function discard(response: Response): Promise<void> {
	await response.body?.cancel().catch(() => undefined);
}
