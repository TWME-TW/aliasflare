/**
 * The key a request is rate limited by: its IPv4 address, or the /64 network of an IPv6
 * address. One IPv6 host usually has a whole /64 to itself, so a key per /128 address could
 * be dodged by changing address on every request.
 */
export function clientKey(ip: string | null | undefined): string {
	const value = (ip ?? "").trim().toLowerCase();
	if (!value.includes(":")) return value || "unknown";
	// Expand IPv6 groups (including any embedded dotted IPv4 tail) so every IPv4-mapped form
	// (::ffff:1.2.3.4, 0:0::ffff:1.2.3.4, ::ffff:0102:0304) buckets per IPv4 host instead of one /64.
	const ipv4Tail = value.match(/:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	let normalized = value;
	if (ipv4Tail) {
		const octets = ipv4Tail.slice(1).map(Number);
		if (octets.every((n) => n >= 0 && n <= 255)) {
			const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
			const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
			normalized = `${value.slice(0, value.length - ipv4Tail[0]!.length)}:${hi}:${lo}`;
		}
	}
	const [head = "", tail = ""] = normalized.split("::");
	const left = head ? head.split(":") : [];
	const right = normalized.includes("::") ? (tail ? tail.split(":") : []) : [];
	const groups = (normalized.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left).map((group) =>
		(group || "0").replace(/^0+(?=.)/, ""),
	);
	if (groups.length === 8 && groups.slice(0, 5).every((g) => g === "0") && groups[5] === "ffff") {
		const hi = parseInt(groups[6]!, 16);
		const lo = parseInt(groups[7]!, 16);
		if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
			return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
		}
	}
	return `${groups.slice(0, 4).join(":")}::/64`;
}
