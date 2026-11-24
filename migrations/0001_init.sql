-- Settings edited on the dashboard. Values are JSON.
CREATE TABLE settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

-- A Mailflare address (mailbox or alias) whose mail is forwarded out.
CREATE TABLE aliases (
	address TEXT PRIMARY KEY,
	mailbox_id TEXT NOT NULL,
	forward_enabled INTEGER NOT NULL DEFAULT 1,
	destination TEXT,
	note TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

-- One external correspondent of one alias, with the reverse alias that stands in for them.
CREATE TABLE contacts (
	id TEXT PRIMARY KEY,
	alias_address TEXT NOT NULL REFERENCES aliases(address) ON DELETE CASCADE,
	email TEXT NOT NULL,
	name TEXT,
	reverse_local TEXT NOT NULL UNIQUE,
	blocked INTEGER NOT NULL DEFAULT 0,
	forward_count INTEGER NOT NULL DEFAULT 0,
	reply_count INTEGER NOT NULL DEFAULT 0,
	last_forward_at INTEGER,
	last_reply_at INTEGER,
	created_at INTEGER NOT NULL,
	UNIQUE (alias_address, email)
);
CREATE INDEX contacts_alias_idx ON contacts (alias_address);

-- Forwarded messages: de-duplicates webhook deliveries, maps Message-IDs for threading,
-- and keeps what the one-click unsubscribe link needs.
CREATE TABLE forwards (
	id TEXT PRIMARY KEY,
	mailflare_message_id TEXT NOT NULL UNIQUE,
	alias_address TEXT NOT NULL,
	contact_id TEXT,
	original_message_id TEXT,
	forwarded_message_id TEXT,
	original_unsubscribe TEXT,
	original_unsubscribe_post INTEGER NOT NULL DEFAULT 0,
	subject TEXT,
	status TEXT NOT NULL,
	error TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX forwards_forwarded_mid_idx ON forwards (forwarded_message_id);
CREATE INDEX forwards_original_mid_idx ON forwards (original_message_id);
CREATE INDEX forwards_created_idx ON forwards (created_at);

-- Replies and unsubscribes, for the activity log.
CREATE TABLE events (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	contact_id TEXT,
	alias_address TEXT,
	status TEXT NOT NULL,
	detail TEXT,
	created_at INTEGER NOT NULL
);
CREATE INDEX events_created_idx ON events (created_at);
