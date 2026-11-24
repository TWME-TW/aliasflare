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
	/** Token for setting up Email Routing and Email Sending from the dashboard. */
	CLOUDFLARE_API_TOKEN?: string;
	/** Name of this Worker, when it is not "mailflare-alias". */
	WORKER_NAME?: string;
	/** Optional service binding to the Mailflare Worker, used instead of its public URL. */
	MAILFLARE_SERVICE?: Fetcher;
}
