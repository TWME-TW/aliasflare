-- Per-alias forwarding mode: all, no_promotions or none. Replaces forward_enabled.
ALTER TABLE aliases ADD COLUMN forward_mode TEXT NOT NULL DEFAULT 'all';
UPDATE aliases SET forward_mode = 'none' WHERE forward_enabled = 0;

-- Senders blocked across every alias: an exact address, or a domain and its subdomains.
CREATE TABLE blocklist (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL CHECK (kind IN ('address', 'domain')),
	value TEXT NOT NULL UNIQUE,
	hits INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL
);

ALTER TABLE forwards ADD COLUMN trackers_removed INTEGER NOT NULL DEFAULT 0;
