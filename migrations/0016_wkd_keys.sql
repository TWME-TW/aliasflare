-- Public keys published by Web Key Directory, one per alias that has WKD on. The key is kept in
-- binary (base64), as WKD serves it; hash is the z-base-32 SHA-1 of the alias's local part.
CREATE TABLE IF NOT EXISTS wkd_keys (
	alias_address TEXT PRIMARY KEY,
	domain TEXT NOT NULL,
	hash TEXT NOT NULL,
	fingerprint TEXT NOT NULL,
	key_binary TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS wkd_keys_lookup ON wkd_keys (domain, hash);
