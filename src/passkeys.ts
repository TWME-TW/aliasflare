import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticationResponseJSON,
	type AuthenticatorTransport,
	type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { safeEqual } from "./crypto";
import { newId, now } from "./db";
import { randomToken } from "./format";

const CHALLENGE_TTL_SECONDS = 5 * 60;
const SETUP_CODE_TTL_SECONDS = 60 * 60;
const RP_NAME = "mailflare-alias";

export type PasskeyRow = {
	id: string;
	public_key: string;
	counter: number;
	transports: string | null;
	name: string;
	created_at: number;
	last_used_at: number | null;
};

export type RelyingParty = { rpID: string; origin: string };

export function relyingParty(requestUrl: string): RelyingParty {
	const url = new URL(requestUrl);
	return { rpID: url.hostname, origin: url.origin };
}

export async function listPasskeys(db: D1Database): Promise<PasskeyRow[]> {
	const { results } = await db.prepare("SELECT * FROM passkeys ORDER BY created_at").all<PasskeyRow>();
	return results;
}

export async function hasPasskeys(db: D1Database): Promise<boolean> {
	return (await db.prepare("SELECT 1 AS one FROM passkeys LIMIT 1").first()) !== null;
}

function transportsOf(row: PasskeyRow): AuthenticatorTransport[] | undefined {
	if (!row.transports) return undefined;
	try {
		return JSON.parse(row.transports) as AuthenticatorTransport[];
	} catch {
		return undefined;
	}
}

async function storeChallenge(db: D1Database, purpose: string, challenge: string): Promise<string> {
	const id = newId("ch");
	await db.batch([
		db.prepare("DELETE FROM auth_challenges WHERE expires_at < ?").bind(now()),
		db.prepare("INSERT INTO auth_challenges (id, purpose, challenge, expires_at) VALUES (?, ?, ?, ?)").bind(
			id,
			purpose,
			challenge,
			now() + CHALLENGE_TTL_SECONDS,
		),
	]);
	return id;
}

/** Returns the challenge once; it is deleted whether or not it is still valid. */
async function takeChallenge(db: D1Database, id: string | undefined, purpose: string): Promise<string | null> {
	if (!id) return null;
	const row = await db
		.prepare("DELETE FROM auth_challenges WHERE id = ? AND purpose = ? RETURNING challenge, expires_at")
		.bind(id, purpose)
		.first<{ challenge: string; expires_at: number }>();
	return row && row.expires_at >= now() ? row.challenge : null;
}

/**
 * The one-time code that authorizes registering the first passkey. It is written to the
 * Worker's logs, so only someone with access to the Cloudflare account can read it.
 */
export async function issueSetupCode(db: D1Database): Promise<{ created: boolean; expiresAt: number }> {
	const existing = await db
		.prepare("SELECT challenge, expires_at FROM auth_challenges WHERE purpose = 'setup' AND expires_at >= ? LIMIT 1")
		.bind(now())
		.first<{ challenge: string; expires_at: number }>();
	if (existing) {
		// Log it again on every visit, so it can be found by whoever starts watching the logs now.
		const minutes = Math.max(1, Math.round((existing.expires_at - now()) / 60));
		console.log(`[mailflare-alias] Setup code: ${existing.challenge} (valid for ${minutes} more minutes)`);
		return { created: false, expiresAt: existing.expires_at };
	}
	const code = randomToken(10).toUpperCase();
	const expiresAt = now() + SETUP_CODE_TTL_SECONDS;
	await db.batch([
		db.prepare("DELETE FROM auth_challenges WHERE purpose = 'setup'"),
		db.prepare("INSERT INTO auth_challenges (id, purpose, challenge, expires_at) VALUES (?, 'setup', ?, ?)").bind(newId("ch"), code, expiresAt),
	]);
	console.log(`[mailflare-alias] Setup code: ${code} (valid for 60 minutes)`);
	return { created: true, expiresAt };
}

export async function checkSetupCode(env: Env, code: string): Promise<boolean> {
	const entered = code.trim().toUpperCase();
	if (!entered) return false;
	if (env.SETUP_CODE && safeEqual(entered, env.SETUP_CODE.trim().toUpperCase())) return true;
	const row = await env.DB.prepare("SELECT challenge FROM auth_challenges WHERE purpose = 'setup' AND expires_at >= ? LIMIT 1")
		.bind(now())
		.first<{ challenge: string }>();
	return !!row && safeEqual(entered, row.challenge);
}

export async function registrationOptions(db: D1Database, rp: RelyingParty) {
	const existing = await listPasskeys(db);
	const options = await generateRegistrationOptions({
		rpName: RP_NAME,
		rpID: rp.rpID,
		userName: "admin",
		userDisplayName: "mailflare-alias admin",
		attestationType: "none",
		excludeCredentials: existing.map((row) => ({ id: row.id, transports: transportsOf(row) })),
		authenticatorSelection: { residentKey: "required", userVerification: "required" },
	});
	const challengeId = await storeChallenge(db, "register", options.challenge);
	return { options, challengeId };
}

export async function completeRegistration(
	db: D1Database,
	rp: RelyingParty,
	challengeId: string | undefined,
	response: RegistrationResponseJSON,
	name: string,
): Promise<PasskeyRow | null> {
	const expectedChallenge = await takeChallenge(db, challengeId, "register");
	if (!expectedChallenge) return null;
	const verification = await verifyRegistrationResponse({
		response,
		expectedChallenge,
		expectedOrigin: rp.origin,
		expectedRPID: rp.rpID,
		requireUserVerification: true,
	});
	if (!verification.verified || !verification.registrationInfo) return null;
	const { credential } = verification.registrationInfo;
	const row: PasskeyRow = {
		id: credential.id,
		public_key: isoBase64URL.fromBuffer(credential.publicKey),
		counter: credential.counter,
		transports: credential.transports ? JSON.stringify(credential.transports) : null,
		name: name.trim().slice(0, 60) || "Passkey",
		created_at: now(),
		last_used_at: null,
	};
	await db
		.prepare("INSERT INTO passkeys (id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?)")
		.bind(row.id, row.public_key, row.counter, row.transports, row.name, row.created_at)
		.run();
	return row;
}

export async function authenticationOptions(db: D1Database, rp: RelyingParty) {
	const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: "required" });
	const challengeId = await storeChallenge(db, "login", options.challenge);
	return { options, challengeId };
}

export async function completeAuthentication(
	db: D1Database,
	rp: RelyingParty,
	challengeId: string | undefined,
	response: AuthenticationResponseJSON,
): Promise<PasskeyRow | null> {
	const expectedChallenge = await takeChallenge(db, challengeId, "login");
	if (!expectedChallenge) return null;
	const row = await db.prepare("SELECT * FROM passkeys WHERE id = ?").bind(response.id).first<PasskeyRow>();
	if (!row) return null;
	const verification = await verifyAuthenticationResponse({
		response,
		expectedChallenge,
		expectedOrigin: rp.origin,
		expectedRPID: rp.rpID,
		requireUserVerification: true,
		credential: {
			id: row.id,
			publicKey: isoBase64URL.toBuffer(row.public_key),
			counter: row.counter,
			transports: transportsOf(row),
		},
	});
	if (!verification.verified) return null;
	await db
		.prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?")
		.bind(verification.authenticationInfo.newCounter, now(), row.id)
		.run();
	return row;
}
