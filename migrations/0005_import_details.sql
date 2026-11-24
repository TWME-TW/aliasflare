-- History carried over when an alias is imported from SimpleLogin or addy.io. The counts and
-- dates describe activity there; they are added to the activity recorded here.
ALTER TABLE aliases ADD COLUMN imported_from TEXT;
ALTER TABLE aliases ADD COLUMN imported_at INTEGER;
ALTER TABLE aliases ADD COLUMN imported_forwarded INTEGER NOT NULL DEFAULT 0;
ALTER TABLE aliases ADD COLUMN imported_blocked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE aliases ADD COLUMN imported_replied INTEGER NOT NULL DEFAULT 0;
ALTER TABLE aliases ADD COLUMN imported_sent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE aliases ADD COLUMN imported_last_forward_at INTEGER;
ALTER TABLE aliases ADD COLUMN imported_last_block_at INTEGER;
ALTER TABLE aliases ADD COLUMN imported_last_reply_at INTEGER;
ALTER TABLE aliases ADD COLUMN imported_last_sent_at INTEGER;
-- JSON with everything else the source knew: further mailboxes or recipients, PGP, latest activity, ids.
ALTER TABLE aliases ADD COLUMN imported_details TEXT;
