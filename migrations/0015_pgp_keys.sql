-- PGP keys of forwarding addresses (addy.io's encrypted recipients). Encryption is off until it is
-- turned on for an address; settings.pgpRecipients lists the addresses where it is on.
CREATE TABLE IF NOT EXISTS pgp_keys (
	email TEXT PRIMARY KEY,
	public_key TEXT NOT NULL,
	fingerprint TEXT NOT NULL,
	encrypt INTEGER NOT NULL DEFAULT 0,
	hide_subject INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
