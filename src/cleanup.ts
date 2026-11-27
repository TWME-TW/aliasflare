import type { AppConfig } from "./config";
import { now } from "./db";
import { cleanupMailbox } from "./mailbox";
import type { Settings } from "./settings";
import { LINK_TTL_SECONDS } from "./unsubscribe";

/** Forwards and other activity are kept for a year. */
export const ACTIVITY_RETENTION_SECONDS = 365 * 86400;
/** Rows removed per table and run, so one run stays well inside D1's limits. */
const PER_RUN = 5000;

/**
 * Daily: removes activity older than ACTIVITY_RETENTION_SECONDS, forgets expired unsubscribe links,
 * and cleans up expired built-in mailbox messages (including R2/S3 blobs).
 */
export async function cleanUp(db: D1Database, at = now(), extra?: { env: Env; config: AppConfig; settings: Settings }): Promise<void> {
	const expired = at - ACTIVITY_RETENTION_SECONDS;
	const linkCutoff = at - LINK_TTL_SECONDS - 86400;
	await db.batch([
		db.prepare("DELETE FROM forwards WHERE id IN (SELECT id FROM forwards WHERE created_at < ? LIMIT ?)").bind(expired, PER_RUN),
		db.prepare("DELETE FROM events WHERE id IN (SELECT id FROM events WHERE created_at < ? LIMIT ?)").bind(expired, PER_RUN),
		db
			.prepare(
				"UPDATE forwards SET original_unsubscribe = NULL, original_unsubscribe_post = 0 WHERE id IN (SELECT id FROM forwards WHERE created_at < ? AND original_unsubscribe IS NOT NULL LIMIT ?)",
			)
			.bind(linkCutoff, PER_RUN),
		db.prepare("DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE expires_at < ? LIMIT ?)").bind(at, PER_RUN),
		db.prepare("DELETE FROM auth_challenges WHERE id IN (SELECT id FROM auth_challenges WHERE expires_at < ? LIMIT ?)").bind(at, PER_RUN),
		db.prepare("DELETE FROM used_links WHERE token_hash IN (SELECT token_hash FROM used_links WHERE used_at < ? LIMIT ?)").bind(linkCutoff, PER_RUN),
	]);
	if (extra?.settings.mailboxEnabled) {
		await cleanupMailbox(extra.env, extra.config, extra.settings, at);
	}
}
