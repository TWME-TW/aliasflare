# mailflare-alias

SimpleLogin-style **reverse aliases** for [Mailflare](https://github.com/hieunc229/mailflare), running on a single Cloudflare Worker.

Mailflare keeps your mail. mailflare-alias forwards a copy to the inbox you already use, like Gmail. When you reply there, the reply goes out from the alias, so the other side never sees your real address.

[繁體中文說明](README.zh-TW.md)

## Features

**Aliases and replies**
- **Forward to your real inbox.** Every alias forwards to a default address, or to its own.
- **Reply through reverse aliases.** Each correspondent gets a private address on your reverse-alias domain. Mail you send to it goes out from the alias, and Mailflare files it in Sent.
- **Write to someone new.** Create a reverse alias for any address and start the conversation from your real inbox.
- **Threading.** Message-IDs are mapped both ways, so conversations stay threaded on both sides.

**SimpleLogin-style settings**
- **Sender address format.** Choose how the original sender appears on forwarded mail: `John Wick - john at wick.com`, `John Wick - john(a)wick.com`, `John Wick`, `john at wick.com`, or no name.
- **Reverse alias replacement.** In your replies, reverse aliases in the body become the real address, and your real address becomes the alias.
- **Include sender address in reverse alias.** New reverse aliases can read `john_at_wick_com_x7k2p9@…` instead of a random string.
- **One-click unsubscribe** (RFC 8058). Your mail client's Unsubscribe button does one of three things:
  - disables the alias,
  - blocks that sender,
  - or runs the sender's own unsubscribe on your behalf.

**Privacy and control** (ideas from addy.io, Firefox Relay, DuckDuckGo Email Protection and SimpleLogin)
- **Tracker removal.** Drops tracking pixels and strips tracking parameters (`utm_*`, `fbclid`, `mc_eid`, …) from links.
- **Forwarding banner.** A short note above each message shows:
  - the alias it was sent to and who sent it;
  - how many trackers were removed;
  - one-click **Block sender** and **Disable alias** links;
  - a warning when the sender failed DMARC, so it may be spoofed.
- **Forwarding modes per alias.** *Forward everything*, *Block promotions* (list mail) or *Forward nothing*.
- **Blocklist.** Block an address, or a domain with its subdomains, across all aliases.
- **Search and batch editing.** Search the alias list by address, note, name or forwarding address, filter it (forwarding, not forwarding, pinned, deleted), then tick aliases to change their forwarding mode, pin them, set a note or forwarding address, delete, restore or permanently delete them in one go.
- **Create aliases on the alias page.** Pick a name and one of your alias domains, optionally with a random suffix, a note and a forwarding address, or leave the name empty for a random alias. An alias exists from the moment you create it, before it receives any mail.
- **Notes** on each alias, edited right in the alias list. Aliases that appear because mail arrived for them are noted *Created by catchall option*, as in SimpleLogin.

**Apps and browser extensions**
- **SimpleLogin and addy.io clients.** Turn on either API in Settings, create an API key, and point the official SimpleLogin or addy.io app or browser extension at your Worker. From there you can list, search, create, pin, enable, disable and delete aliases, change their notes and destinations, and manage reverse aliases (SimpleLogin contacts).
- **Import from SimpleLogin or addy.io**, with their API key or alias export (CSV). Notes, display names, on/off state, pins and forwarding addresses come along. Only aliases on domains you choose are imported, and importing again is safe.
- **New aliases from the apps** go on your *alias domains*. Formats are words (`maple.otter42`), random characters or a UUID, or a custom prefix.

**Dashboard**
- **Passkey sign-in**, with no password. Register several devices.
- **Cloudflare set up from the dashboard.** With an API token, one button enables Email Routing and Email Sending on the reverse-alias domain and creates its routing rule.
- **Connection settings in the dashboard.** The Mailflare URL, API key, webhook secret and reverse-alias domain are entered after you register your passkey. A deploy needs no secrets.
- **35 languages**: the same as Mailflare, plus Traditional Chinese. Arabic, Persian and Urdu are laid out right to left. The language follows your browser and can be changed from the menu.
- **Looks like Mailflare**, in light and dark mode.
- **Works on phones, tablets and desktops.** On small screens, tables become cards.

## How it works

```
                 ┌──────────── Mailflare (mail.example.com) ────────────┐
 sender ──mail──▶│ stores the message, fires the message.inbound webhook │
                 └───────────────────────┬───────────────────────────────┘
                                         │ webhook (HMAC-signed)
                                         ▼
                 ┌──────────────── mailflare-alias Worker ────────────────┐
                 │ reads the raw message over Mailflare's JMAP API         │
                 │ removes trackers, adds the banner                       │
                 │ sends it from ra_x7k2…@r.example.com to your inbox      │──▶ you@gmail.com
                 └────────────────────────────────────────────────────────┘
                                         ▲
 you@gmail.com ──reply to ra_x7k2…@r.example.com (Email Routing catch-all)
                                         │ checks: sender is you, and Cloudflare's DMARC verdict is pass
                                         ▼
                 Mailflare /api/v1/send ──from alias@mail.example.com──▶ sender
```

mailflare-alias does not change Mailflare, so Mailflare's built-in updater keeps working.

## Requirements

- A working Mailflare install that can send mail.
- A **subdomain that Mailflare does not route**, for example `r.example.com`. Reverse aliases live there.
- **Cloudflare Email Sending** on that subdomain, which needs Workers Paid.
- **Cloudflare Email Routing** on that subdomain, with subaddressing on and a rule that sends `reply@` that subdomain to this Worker. The dashboard can set both up for you.

## Setup

### 1. Deploy

```bash
git clone https://github.com/TWME-TW/mailflare-alias.git
cd mailflare-alias
npm install
npx wrangler d1 create mailflare-alias      # copy the database_id into wrangler.jsonc (or a git-ignored wrangler.local.jsonc)
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy
```

Optional: if Mailflare runs on the same Cloudflare account, enable the `MAILFLARE_SERVICE` service binding in `wrangler.jsonc`. Requests to Mailflare then stay inside Cloudflare.

### 2. Register your passkey

1. Open `https://mailflare-alias.<you>.workers.dev/`. You land on the setup page.
2. Get the **one-time setup code** from the Worker's logs. Either:
   - open the Cloudflare dashboard → Workers & Pages → mailflare-alias → Observability → Logs; or
   - run `npx wrangler tail mailflare-alias` and reload the page.

   The code is valid for 60 minutes. Only people with access to your Cloudflare account can read the logs. To use your own code instead, set a `SETUP_CODE` secret.
3. Enter the code and register a passkey.

### 3. Connect Mailflare

Mailflare has two kinds of API key, and mailflare-alias needs the **personal** one:

| | Personal API key | Admin API key |
|---|---|---|
| Where in Mailflare | **Settings → API keys** | Admin → API keys |
| Permissions | `send`, `read`, `jmap`, `calendar:*` | `domains`, `accounts`, `mailboxes`, `storage` |
| Limited to | the mailboxes you select (up to 30) | the whole installation |
| Used by mailflare-alias | **Yes**: `send` + `jmap` | No |

An Admin API key cannot read or send mail, so it does not work here.

On **Connection**:

1. **API key.** In Mailflare, go to **Settings → API keys** and create a key:
   - select the `send` and `jmap` permissions;
   - select **every mailbox whose aliases you want to forward**.

   Paste the key. Mail to a mailbox the key does not include is not forwarded. When you add a mailbox later, create a new key that includes it.
2. **Webhook.** Sign in to Mailflare as the **primary admin**; only that account can manage webhooks. Go to **Admin → Webhooks** and add a webhook:
   - event: `message.inbound`;
   - URL: the one shown on the page (`…/webhook`).

   Paste its signing secret. A webhook fires only for mailboxes owned by the account that created it, so it covers the primary admin's mailboxes.
3. Enter your Mailflare URL and the reverse-alias domain.

Then on **Settings**, set your default forwarding address, which is your Gmail.

### 4. Cloudflare: the reverse-alias domain

Reverse aliases look like `reply+ra_x7k2…@r.example.com`. Cloudflare only allows catch-all rules on apex domains, and a subdomain allows at most 200 rules, so instead **one rule** for `reply@r.example.com` with **subaddressing** turned on covers every reverse alias.

**Automatically.** On **Connection → Cloudflare**, paste an API token and click **Set up automatically**. Create the token under *My Profile → API Tokens* with these permissions for the zone:
- Zone → Zone → Read
- Zone → Zone Settings → Edit
- Zone → Email Routing Rules → Edit
- Zone → Email Sending → Edit

The page shows what each step did. Running it again is safe.

**By hand.** In the Cloudflare dashboard:
1. **Email Routing** for `r.example.com`: enable it, turn on **subaddressing** in Email Routing settings, and add the custom address `reply@r.example.com` with *Send to a Worker* → `mailflare-alias`.
2. **Email Sending**: onboard `r.example.com`.

### 5. Optional: SimpleLogin and addy.io apps

1. In **Settings → Apps and browser extensions**, turn on *Support SimpleLogin clients*, *Support addy.io clients*, or both.
2. Add your **alias domains**: the domains new aliases can be created on. In Mailflare, give each of them a **catch-all**, so Mailflare accepts mail to addresses that did not exist before.
3. On **API keys**, create one key per app or browser extension.
4. In the app or extension, choose the self-hosted option and enter the server URL shown on the API keys page (your Worker's URL) and the key:
   - **SimpleLogin**: *API URL*.
   - **addy.io**: *Instance URL*.

Keys can manage aliases. With *Let apps change settings* on (the default), apps can also change what their own settings screens show:
- **SimpleLogin**: alias format, suffix of custom aliases, default alias domain, sender address format, and the default mailbox (your default forwarding address);
- **addy.io**: the blocklist.

Connection, API and key settings can only be changed in the dashboard. Only a hash of each key is stored.

### 6. Optional: import from SimpleLogin or addy.io

On **Import**, list the domains to bring over, then either paste a SimpleLogin or addy.io API key or upload their alias export (CSV). The key is used once and not saved.

Only aliases on your own domains are worth importing. Aliases on SimpleLogin's or addy.io's domains keep receiving mail there, so leave those domains out. Before mail to an imported alias can arrive, move its domain's MX to Cloudflare, add the domain to Mailflare and give it a catch-all.

### Environment overrides

Every connection setting can also come from a variable or secret, which then wins over the dashboard:

`MAILFLARE_URL`, `MAILFLARE_API_KEY`, `WEBHOOK_SECRET`, `REVERSE_ALIAS_DOMAIN`, `PUBLIC_URL`, `SIGNING_SECRET`, `SETUP_CODE`, `CLOUDFLARE_API_TOKEN`, `WORKER_NAME`.

## Security model

- **Dashboard.** Sign-in uses passkeys (WebAuthn) with user verification. The first passkey can only be registered with the one-time code from the Worker's logs. Sessions are HttpOnly, Secure, SameSite=Strict cookies, every state change checks Origin, and sign-in and setup are rate limited.
- **Webhooks** must carry Mailflare's HMAC-SHA256 signature. Each message is forwarded once, even when the webhook is delivered more than once.
- **Reverse aliases** accept mail only when both of these hold:
  - the header `From` is the alias's forwarding address;
  - Cloudflare's own `Authentication-Results` reports `dmarc=pass` for that domain.

  Reverse aliases contain at least 8 random characters, so they cannot be guessed.
- **Links in forwarded mail** (unsubscribe, block, disable) are HMAC-signed and expire. `GET` only shows a confirmation, so link scanners change nothing.
- **App API keys** are random 238-bit values; only their SHA-256 hash is stored. Both client APIs are off by default. Failed key attempts are rate limited, and the APIs never accept the dashboard cookie, so allowing cross-origin requests does not expose the dashboard.
- **Stored secrets.** The Mailflare API key, webhook secret and Cloudflare API token are stored in D1. Use the environment overrides if you prefer Worker secrets.
- **Lost all your passkeys?** Run `npx wrangler d1 execute mailflare-alias --remote --command "DELETE FROM passkeys"` and register again with a new setup code.

## Limitations

- Replies go through Mailflare's send API, which accepts up to 10 attachments, and inline images arrive as attachments. A reply with more attachments bounces back to you with an explanation.
- An alias appears after it first receives mail, unless an app creates it or it is imported.
- Import does not bring over contacts or reverse aliases, PGP keys, or more than the first forwarding address of an alias.
- Through the apps, PGP, labels, usernames, custom domains and account settings are not available. Deleting an alias stops forwarding; Mailflare still receives its mail.
- Forwarded copies need Cloudflare Email Sending. Resend and SES are not supported yet.

## Roadmap

- PGP encryption of forwarded mail, as SimpleLogin and addy.io offer.
- Sending from an alias by email address alone, with no dashboard, as addy.io offers.
- Multiple destinations per alias.

## Development

```bash
npm install
npm run typecheck
npm test
cp .dev.vars.example .dev.vars && npm run db:migrate:local && npm run dev
```

Translations live in `src/i18n.ts`. A test fails if any language misses a key or a placeholder.

## License

MIT
