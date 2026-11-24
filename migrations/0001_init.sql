-- aliasflare schema.

-- Settings edited on the dashboard. Values are JSON.
CREATE TABLE settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

-- Connection values (signing key, optional Mailflare details, public URL, ...).
CREATE TABLE config (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

-- An alias whose mail is forwarded out. mailbox_id is the Mailflare mailbox for aliases that
-- Mailflare receives, and empty for aliases that Cloudflare Email Routing delivers here.
CREATE TABLE aliases (
	address TEXT PRIMARY KEY,
	mailbox_id TEXT NOT NULL DEFAULT '',
	forward_enabled INTEGER NOT NULL DEFAULT 1,
	-- all, no_promotions or none
	forward_mode TEXT NOT NULL DEFAULT 'all',
	destination TEXT,
	note TEXT,
	-- SimpleLogin clients address aliases by integer id, addy.io clients by UUID.
	num_id INTEGER,
	uid TEXT,
	-- Display name for replies sent from the alias.
	name TEXT,
	pinned INTEGER NOT NULL DEFAULT 0,
	-- A deleted alias stops forwarding and is hidden; it can be restored.
	deleted_at INTEGER,
	-- History carried over from SimpleLogin or addy.io, added to the activity recorded here.
	imported_from TEXT,
	imported_at INTEGER,
	imported_forwarded INTEGER NOT NULL DEFAULT 0,
	imported_blocked INTEGER NOT NULL DEFAULT 0,
	imported_replied INTEGER NOT NULL DEFAULT 0,
	imported_sent INTEGER NOT NULL DEFAULT 0,
	imported_last_forward_at INTEGER,
	imported_last_block_at INTEGER,
	imported_last_reply_at INTEGER,
	imported_last_sent_at INTEGER,
	-- JSON with everything else the source knew.
	imported_details TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX aliases_num_id_idx ON aliases (num_id);
CREATE UNIQUE INDEX aliases_uid_idx ON aliases (uid);

-- One external correspondent of one alias, with the reverse alias that stands in for them:
-- reply+<reverse_local>@r.<the alias's domain>.
CREATE TABLE contacts (
	id TEXT PRIMARY KEY,
	num_id INTEGER,
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
CREATE UNIQUE INDEX contacts_num_id_idx ON contacts (num_id);

-- Forwarded messages: de-duplicates deliveries, maps Message-IDs for threading, and keeps what
-- the one-click unsubscribe link needs. inbound_id is Mailflare's message id, or a hash of the
-- Message-ID and recipient for mail Email Routing delivers.
CREATE TABLE forwards (
	id TEXT PRIMARY KEY,
	inbound_id TEXT NOT NULL UNIQUE,
	alias_address TEXT NOT NULL,
	contact_id TEXT,
	original_message_id TEXT,
	forwarded_message_id TEXT,
	original_unsubscribe TEXT,
	original_unsubscribe_post INTEGER NOT NULL DEFAULT 0,
	subject TEXT,
	status TEXT NOT NULL,
	error TEXT,
	trackers_removed INTEGER NOT NULL DEFAULT 0,
	-- Delivery attempts, so a message that keeps failing stops being retried.
	attempts INTEGER NOT NULL DEFAULT 0,
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

-- Senders blocked across every alias: an exact address, or a domain and its subdomains.
CREATE TABLE blocklist (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL CHECK (kind IN ('address', 'domain')),
	value TEXT NOT NULL UNIQUE,
	hits INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL
);

-- WebAuthn credentials that may sign in to the dashboard.
CREATE TABLE passkeys (
	id TEXT PRIMARY KEY,              -- credential id, base64url
	public_key TEXT NOT NULL,         -- COSE public key, base64url
	counter INTEGER NOT NULL DEFAULT 0,
	transports TEXT,                  -- JSON array
	name TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	last_used_at INTEGER
);

-- Short-lived WebAuthn challenges and the one-time setup code.
CREATE TABLE auth_challenges (
	id TEXT PRIMARY KEY,
	purpose TEXT NOT NULL,
	challenge TEXT NOT NULL,
	expires_at INTEGER NOT NULL
);

-- Dashboard sessions. The cookie holds a signed id; signing out or removing the passkey
-- deletes the row, which ends the session at once.
CREATE TABLE sessions (
	id TEXT PRIMARY KEY,
	passkey_id TEXT NOT NULL REFERENCES passkeys(id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_passkey_idx ON sessions (passkey_id);

-- Signed links in forwarded mail (block, turn off, unsubscribe) that were already used.
CREATE TABLE used_links (
	token_hash TEXT PRIMARY KEY,
	used_at INTEGER NOT NULL
);

-- API keys for SimpleLogin and addy.io clients. Only a SHA-256 hash of each key is kept.
CREATE TABLE api_keys (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	prefix TEXT NOT NULL,
	hash TEXT NOT NULL UNIQUE,
	created_at INTEGER NOT NULL,
	last_used_at INTEGER
);
