-- Dashboard sessions. The cookie holds a signed id; signing out or removing the passkey
-- deletes the row, which ends the session at once.
CREATE TABLE sessions (
	id TEXT PRIMARY KEY,
	passkey_id TEXT NOT NULL REFERENCES passkeys(id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_passkey_idx ON sessions (passkey_id);

-- Signed links in forwarded mail (block, turn off, unsubscribe) that were already used:
-- each works once.
CREATE TABLE used_links (
	token_hash TEXT PRIMARY KEY,
	used_at INTEGER NOT NULL
);

-- Delivery attempts of a forward, so a message that keeps failing stops being retried.
ALTER TABLE forwards ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
