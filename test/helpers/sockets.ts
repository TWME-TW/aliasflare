/** Stand-in for "cloudflare:sockets": tests pass their own connection to sendSmtp. */
export function connect(): never {
	throw new Error("No sockets in tests");
}
