-- When mail last went through an alias, either way (forwarded to the owner or replied through
-- it). Kept on the alias itself so the alias list can sort by it from an index instead of
-- looking through every alias's contacts on each page load.
ALTER TABLE aliases ADD COLUMN last_used_at INTEGER;

UPDATE aliases SET last_used_at = (
	SELECT NULLIF(MAX(MAX(COALESCE(c.last_forward_at, 0), COALESCE(c.last_reply_at, 0))), 0)
	FROM contacts c WHERE c.alias_address = aliases.address
);

-- The alias list order: pinned first, then the newest or most recently used.
CREATE INDEX aliases_list_order_idx ON aliases (pinned DESC, MAX(created_at, COALESCE(last_used_at, 0)) DESC, num_id DESC);

-- The cleanup of expired one-time link records runs on every link use.
CREATE INDEX used_links_used_at_idx ON used_links (used_at);
