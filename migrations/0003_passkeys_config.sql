-- Connection settings entered on the dashboard (Mailflare URL, API key, webhook secret, ...).
CREATE TABLE config (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
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
