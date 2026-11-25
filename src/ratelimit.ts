/**
 * The key a request is rate limited by: its IPv4 address, or the /64 network of an IPv6
 * address. One IPv6 host usually has a whole /64 to itself, so a key per /128 address could
 * be dodged by changing address on every request.
 */
export function clientKey(ip: string | null | undefined): string {
	const value = (ip ?? "").trim().toLowerCase();
	if (!value.includes(":")) return value || "unknown";
	// IPv4-mapped IPv6 addresses (::ffff:1.2.3.4 or ::ffff:0102:0304) must bucket per IPv4 host, not one /64.
	const mappedDotted = value.match(/^(?:::|(?:0+:){5})ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
	if (mappedDotted) return mappedDotted[1]!;
	const mappedHex = value.match(/^(?:::|(?:0+:){5})ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
	if (mappedHex) {
		const hi = parseInt(mappedHex[1]!, 16);
		const lo = parseInt(mappedHex[2]!, 16);
		return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
	}
	const [head = "", tail = ""] = value.split("::");
	const left = head ? head.split(":") : [];
	const right = value.includes("::") ? (tail ? tail.split(":") : []) : [];
	const groups = value.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
	return `${groups
		.slice(0, 4)
		.map((group) => (group || "0").replace(/^0+(?=.)/, ""))
		.join(":")}::/64`;
}
