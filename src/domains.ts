/**
 * Each alias domain has its own reverse-alias domain: r.<alias domain>. A correspondent of
 * shop@a.com writes to reply+…@r.a.com and one of x@b.net to reply+…@r.b.net, so nothing a
 * correspondent sees ties two alias domains together.
 */
import { domainOf, reverseAddress } from "./format";

export const REVERSE_LABEL = "r";

export function reverseDomainFor(aliasDomain: string): string {
	return `${REVERSE_LABEL}.${aliasDomain}`;
}

/** The alias domain a reverse-alias domain belongs to: r.a.com → a.com. Null for any other domain. */
export function aliasDomainOfReverse(domain: string): string | null {
	const lower = domain.toLowerCase();
	const prefix = `${REVERSE_LABEL}.`;
	return lower.startsWith(prefix) && lower.slice(prefix.length).includes(".") ? lower.slice(prefix.length) : null;
}

/** The reverse alias that stands in for a contact of an alias. */
export function contactReverseAddress(contact: { reverse_local: string; alias_address: string }): string {
	return reverseAddress(contact.reverse_local, reverseDomainFor(domainOf(contact.alias_address)));
}

/** True when the domain is the reverse-alias domain of one of these alias domains. */
export function isReverseDomainOf(domain: string, aliasDomains: string[]): boolean {
	const owner = aliasDomainOfReverse(domain);
	return owner !== null && aliasDomains.includes(owner);
}

/**
 * True for an address mail must never be forwarded or sent to: one on an alias domain or on
 * its reverse-alias domain, which would come straight back here.
 */
export function isOwnAddress(email: string, aliasDomains: string[]): boolean {
	const domain = domainOf(email);
	return aliasDomains.includes(domain) || isReverseDomainOf(domain, aliasDomains);
}

/** A domain that cannot be an alias domain: the reverse-alias domain of another alias domain, or one whose own would be. */
export function clashingDomain(domains: string[]): string | null {
	const set = new Set(domains);
	return domains.find((domain) => set.has(reverseDomainFor(domain)) || (aliasDomainOfReverse(domain) !== null && set.has(aliasDomainOfReverse(domain)!))) ?? null;
}
