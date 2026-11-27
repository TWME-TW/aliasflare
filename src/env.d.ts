// Optional overrides that `wrangler types` cannot see. Every connection setting can be
// entered on the dashboard instead; a variable or secret set here wins over the stored value.
interface Env {
	MAILFLARE_URL?: string;
	MAILFLARE_API_KEY?: string;
	WEBHOOK_SECRET?: string;
	SIGNING_SECRET?: string;
	/** Public origin of this Worker for links in forwarded mail. */
	PUBLIC_URL?: string;
	/** Fixed code for registering the first passkey, instead of the one written to the logs. */
	SETUP_CODE?: string;
	/** Token for setting up Email Routing and Email Sending from the dashboard. */
	CLOUDFLARE_API_TOKEN?: string;
	/** Name of this Worker, when it is not "aliasflare". */
	WORKER_NAME?: string;
	/** What sends mail to other people: cloudflare (Email Sending, Workers Paid), resend, smtp2go, brevo, postmark, mailgun, ses, mailbaby, smtp or custom. */
	OUTBOUND_PROVIDER?: string;
	/** The provider's secret: API key, SMTP password or AWS secret access key. */
	OUTBOUND_API_KEY?: string;
	/** The provider's other settings as JSON (smtpHost, smtpPort, sesRegion, customUrl…). */
	OUTBOUND_OPTIONS?: string;
	/** "free" or "paid": the Workers plan, which sets how much one request may do. */
	WORKERS_PLAN?: string;
	/** Optional service binding to the Mailflare Worker, used instead of its public URL. */
	MAILFLARE_SERVICE?: Fetcher;
	/** Optional Cloudflare R2 bucket for storing built-in mailbox raw .eml messages. */
	MAILBOX_BUCKET?: R2Bucket;
	/** Optional S3-compatible object storage overrides (AWS S3, Backblaze B2, MinIO, R2 S3 API, Garage...). */
	MAILBOX_S3_ENDPOINT?: string;
	MAILBOX_S3_BUCKET?: string;
	MAILBOX_S3_REGION?: string;
	MAILBOX_S3_ACCESS_KEY_ID?: string;
	MAILBOX_S3_SECRET_ACCESS_KEY?: string;
	MAILBOX_S3_PATH_STYLE?: string;
	MAILBOX_S3_PREFIX?: string;
}
