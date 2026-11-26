/** Stand-in for "cloudflare:email": a raw message as Email Sending takes it. */
export class EmailMessage {
	constructor(
		readonly from: string,
		readonly to: string,
		readonly raw: string | ReadableStream,
	) {}
}
