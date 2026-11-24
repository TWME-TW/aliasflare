// Optional overrides that `wrangler types` cannot see. Every connection setting can be
// entered on the dashboard instead; a variable or secret set here wins over the stored value.
interface Env {
	MAILFLARE_URL?: string;
	MAILFLARE_API_KEY?: string;
	WEBHOOK_SECRET?: string;
	REVERSE_ALIAS_DOMAIN?: string;
	SIGNING_SECRET?: string;
	/** Public origin of this Worker for links in forwarded mail. */
	PUBLIC_URL?: string;
	/** Fixed code for registering the first passkey, instead of the one written to the logs. */
	SETUP_CODE?: string;
	/** Optional service binding to the Mailflare Worker, used instead of its public URL. */
	MAILFLARE_SERVICE?: Fetcher;
}
