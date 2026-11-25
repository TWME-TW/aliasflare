-- Labels group aliases (addy.io's labels); an alias can have several.
CREATE TABLE IF NOT EXISTS labels (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE COLLATE NOCASE,
	colour TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS alias_labels (
	alias_address TEXT NOT NULL,
	label_id TEXT NOT NULL,
	PRIMARY KEY (alias_address, label_id)
);
CREATE INDEX IF NOT EXISTS alias_labels_label_idx ON alias_labels (label_id);
CREATE TRIGGER IF NOT EXISTS labels_cascade AFTER DELETE ON labels BEGIN
	DELETE FROM alias_labels WHERE label_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS aliases_labels_cascade AFTER DELETE ON aliases BEGIN
	DELETE FROM alias_labels WHERE alias_address = OLD.address;
END;

-- Rules (addy.io's): conditions on the sender, subject or alias, and actions on mail that matches.
-- conditions and actions are JSON arrays; position orders them, lowest first.
CREATE TABLE IF NOT EXISTS rules (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	position INTEGER NOT NULL,
	operator TEXT NOT NULL DEFAULT 'AND',
	conditions TEXT NOT NULL,
	actions TEXT NOT NULL,
	forwards INTEGER NOT NULL DEFAULT 1,
	replies INTEGER NOT NULL DEFAULT 0,
	sends INTEGER NOT NULL DEFAULT 0,
	active INTEGER NOT NULL DEFAULT 1,
	applied INTEGER NOT NULL DEFAULT 0,
	last_applied INTEGER,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
