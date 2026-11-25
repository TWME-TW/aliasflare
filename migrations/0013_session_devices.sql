-- What the Passkeys page shows about each signed-in browser, and when its passkey was last
-- confirmed again: adding a passkey or an API key needs a confirmation from the last few minutes.
ALTER TABLE sessions ADD COLUMN user_agent TEXT;
ALTER TABLE sessions ADD COLUMN country TEXT;
ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER;
ALTER TABLE sessions ADD COLUMN verified_at INTEGER;
