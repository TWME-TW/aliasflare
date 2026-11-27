-- Built-in mailbox: stores skipped/rejected, failed, local-mailbox, sent, and optional forwarded copies
-- with R2 / S3-compatible object storage priority and automatic compressed D1 fallback.

CREATE TABLE IF NOT EXISTS mailbox_messages (
	id TEXT PRIMARY KEY,
	folder TEXT NOT NULL,
	uid INTEGER NOT NULL,
	alias_address TEXT,
	forward_id TEXT,
	from_address TEXT NOT NULL DEFAULT '',
	from_name TEXT,
	to_address TEXT NOT NULL DEFAULT '',
	subject TEXT NOT NULL DEFAULT '',
	snippet TEXT NOT NULL DEFAULT '',
	reason TEXT,
	reason_detail TEXT,
	flags TEXT NOT NULL DEFAULT '[]',
	size_bytes INTEGER NOT NULL DEFAULT 0,
	storage_kind TEXT NOT NULL DEFAULT 'headers_only',
	storage_key TEXT,
	raw_headers TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE (folder, uid)
);
CREATE INDEX IF NOT EXISTS mailbox_messages_folder_idx ON mailbox_messages (folder, created_at DESC);
CREATE INDEX IF NOT EXISTS mailbox_messages_forward_idx ON mailbox_messages (forward_id);
CREATE INDEX IF NOT EXISTS mailbox_messages_alias_idx ON mailbox_messages (alias_address);
CREATE INDEX IF NOT EXISTS mailbox_messages_created_idx ON mailbox_messages (created_at);

CREATE TABLE IF NOT EXISTS mailbox_blobs (
	message_id TEXT PRIMARY KEY REFERENCES mailbox_messages(id) ON DELETE CASCADE,
	encoding TEXT NOT NULL DEFAULT 'gzip',
	raw_base64 TEXT NOT NULL,
	stored_bytes INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mailbox_uid_state (
	folder TEXT PRIMARY KEY,
	uidvalidity INTEGER NOT NULL,
	uidnext INTEGER NOT NULL DEFAULT 1
);

ALTER TABLE forwards ADD COLUMN recipient_email TEXT;
ALTER TABLE forwards ADD COLUMN email_type TEXT NOT NULL DEFAULT 'F';
ALTER TABLE forwards ADD COLUMN resent_at INTEGER;
ALTER TABLE forwards ADD COLUMN mailbox_message_id TEXT;
