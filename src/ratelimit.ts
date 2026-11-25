/**
 * The key a request is rate limited by: its IPv4 address, or the /64 network of an IPv6
 * address. One IPv6 host usually has a whole /64 to itself, so a key per /128 address could
 * be dodged by changing address on every request.
 */
export function clientKey(ip: string | null | undefined): string {
	const value = (ip ?? "").trim().toLowerCase();
	if (!value.includes(":")) return value || "unknown";
	const [head = "", tail = ""] = value.split("::");
	const left = head ? head.split(":") : [];
	const right = value.includes("::") ? (tail ? tail.split(":") : []) : [];
	const groups = value.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
	return `${groups
		.slice(0, 4)
		.map((group) => (group || "0").replace(/^0+(?=.)/, ""))
		.join(":")}::/64`;
}
