-- SimpleLogin and addy.io client support.

-- SimpleLogin clients address aliases and contacts by integer id, addy.io clients by UUID.
ALTER TABLE aliases ADD COLUMN num_id INTEGER;
ALTER TABLE aliases ADD COLUMN uid TEXT;
-- Display name for replies sent from the alias (SimpleLogin "name", addy.io "from_name").
ALTER TABLE aliases ADD COLUMN name TEXT;
ALTER TABLE aliases ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
-- A deleted alias stops forwarding and is hidden; addy.io clients can restore it.
ALTER TABLE aliases ADD COLUMN deleted_at INTEGER;

UPDATE aliases SET num_id = (SELECT COUNT(*) FROM aliases AS earlier WHERE earlier.rowid <= aliases.rowid);
UPDATE aliases SET uid = lower(
	substr(hex(randomblob(4)), 1) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
	substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))
);
CREATE UNIQUE INDEX aliases_num_id_idx ON aliases (num_id);
CREATE UNIQUE INDEX aliases_uid_idx ON aliases (uid);

ALTER TABLE contacts ADD COLUMN num_id INTEGER;
UPDATE contacts SET num_id = (SELECT COUNT(*) FROM contacts AS earlier WHERE earlier.rowid <= contacts.rowid);
CREATE UNIQUE INDEX contacts_num_id_idx ON contacts (num_id);

-- API keys for SimpleLogin and addy.io clients. Only a SHA-256 hash of each key is kept.
CREATE TABLE api_keys (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	prefix TEXT NOT NULL,
	hash TEXT NOT NULL UNIQUE,
	created_at INTEGER NOT NULL,
	last_used_at INTEGER
);
