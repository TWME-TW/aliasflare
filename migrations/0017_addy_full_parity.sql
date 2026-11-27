-- addy.io full feature parity & client settings:
-- first-class recipients (with PGP options), multi-recipient aliases, per-domain settings,
-- send-from stats, and blocklist last_blocked_at.

CREATE TABLE IF NOT EXISTS recipients (
	id TEXT PRIMARY KEY,
	email TEXT NOT NULL UNIQUE,
	description TEXT,
	can_reply_send INTEGER NOT NULL DEFAULT 1,
	should_encrypt INTEGER NOT NULL DEFAULT 0,
	inline_encryption INTEGER NOT NULL DEFAULT 0,
	protected_headers INTEGER NOT NULL DEFAULT 0,
	remove_pgp_keys INTEGER NOT NULL DEFAULT 0,
	remove_pgp_signatures INTEGER NOT NULL DEFAULT 0,
	active INTEGER NOT NULL DEFAULT 1,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alias_recipients (
	alias_address TEXT NOT NULL REFERENCES aliases(address) ON DELETE CASCADE,
	recipient_email TEXT NOT NULL,
	position INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (alias_address, recipient_email)
);
CREATE INDEX IF NOT EXISTS alias_recipients_email_idx ON alias_recipients (recipient_email);

CREATE TABLE IF NOT EXISTS domains (
	domain TEXT PRIMARY KEY,
	description TEXT,
	from_name TEXT,
	default_recipient TEXT,
	active INTEGER NOT NULL DEFAULT 1,
	default_attached_recipients_only INTEGER NOT NULL DEFAULT 0,
	auto_create_regex TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

ALTER TABLE aliases ADD COLUMN attached_recipients_only INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contacts ADD COLUMN sent_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contacts ADD COLUMN last_sent_at INTEGER;
ALTER TABLE blocklist ADD COLUMN last_blocked_at INTEGER;
ALTER TABLE pgp_keys ADD COLUMN inline_encryption INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pgp_keys ADD COLUMN remove_pgp_keys INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pgp_keys ADD COLUMN remove_pgp_signatures INTEGER NOT NULL DEFAULT 0;
