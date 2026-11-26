-- Where each API key was last used from (the country Cloudflare reports), shown on the API keys
-- page so a key used from somewhere unexpected stands out.
ALTER TABLE api_keys ADD COLUMN last_used_country TEXT;
