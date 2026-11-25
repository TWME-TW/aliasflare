-- Activity brought in by an import (SimpleLogin's or addy.io's last forward, reply or send)
-- counts as use too, so an imported alias shows when it was last used and sorts by it.
UPDATE aliases SET last_used_at = NULLIF(MAX(
	COALESCE(last_used_at, 0),
	COALESCE(imported_last_forward_at, 0),
	COALESCE(imported_last_reply_at, 0),
	COALESCE(imported_last_sent_at, 0)
), 0)
WHERE imported_last_forward_at IS NOT NULL OR imported_last_reply_at IS NOT NULL OR imported_last_sent_at IS NOT NULL;

-- The activity list reads forwards newest first by their last change.
CREATE INDEX forwards_updated_idx ON forwards (updated_at);
