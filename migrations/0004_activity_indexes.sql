-- Per-alias counts of blocked mail (the client APIs' stats) and the activity of one alias.
CREATE INDEX forwards_alias_status_created_idx ON forwards (alias_address, status, created_at);
CREATE INDEX events_alias_idx ON events (alias_address);
