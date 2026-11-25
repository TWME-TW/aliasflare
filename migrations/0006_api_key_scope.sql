-- What a key is for: the SimpleLogin and addy.io apps, or the MCP server. Neither works for the other.
ALTER TABLE api_keys ADD COLUMN scope TEXT NOT NULL DEFAULT 'apps';
