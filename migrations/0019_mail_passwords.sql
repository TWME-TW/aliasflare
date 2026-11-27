-- App passwords dedicated to IMAP / POP3 / SMTP access via the Mail Gateway API and Bridge.
-- Only the SHA-256 hash is stored; each password can be scoped per protocol.
CREATE TABLE IF NOT EXISTS mail_passwords (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	username TEXT NOT NULL,
	prefix TEXT NOT NULL,
	hash TEXT NOT NULL UNIQUE,
	allow_imap INTEGER NOT NULL DEFAULT 1,
	allow_pop3 INTEGER NOT NULL DEFAULT 0,
	allow_smtp INTEGER NOT NULL DEFAULT 1,
	created_at INTEGER NOT NULL,
	last_used_at INTEGER,
	last_country TEXT
);

CREATE INDEX IF NOT EXISTS mail_passwords_username_idx ON mail_passwords (username);
