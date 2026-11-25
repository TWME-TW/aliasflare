# aliasflare

SimpleLogin-style **email aliases with reverse aliases**, on one Cloudflare Worker with Cloudflare Email Routing and Email Sending.

Give every site its own address on your domains. aliasflare forwards their mail to the inbox you already use, like Gmail. When you reply there, the reply goes out from the alias, so the other side never sees your real address.

[繁體中文說明](README.zh-TW.md)

## Features

**Aliases and replies**
- **Any number of alias domains.** Mail to any address on them arrives (an Email Routing catch-all), and you can create aliases ahead of time on the alias page or from the apps.
- **Forward to your real inbox.** Every alias forwards to a default address, or to its own.
- **Reply through reverse aliases.** Each correspondent gets a private address. Mail you send to it goes out from the alias.
- **One reverse-alias domain per alias domain.** Correspondents of `shop@a.com` write to `reply+…@r.a.com`, those of `me@b.net` to `reply+…@r.b.net`. Nothing a correspondent sees ties your domains together, and a reverse alias only works on its own domain.
- **Write to someone new.** Create a reverse alias for any address and start the conversation from your real inbox.
- **Threading.** Message-IDs are mapped both ways, so conversations stay threaded on both sides.

**SimpleLogin-style settings**
- **Sender address format.** How the original sender appears on forwarded mail: `John Wick - john at wick.com`, `John Wick - john(a)wick.com`, `John Wick`, `john at wick.com`, or no name.
- **Reverse alias replacement.** In your replies, reverse aliases in the body become the real address, and your real address becomes the alias.
- **Include sender address in reverse alias.** New reverse aliases can read `john_at_wick_com_x7k2p9@…` instead of a random string.
- **One-click unsubscribe** (RFC 8058). Your mail client's Unsubscribe button disables the alias, blocks that sender, or runs the sender's own unsubscribe on your behalf.

**Privacy and control** (ideas from addy.io, Firefox Relay, DuckDuckGo Email Protection and SimpleLogin)
- **Tracker removal.** Drops tracking pixels and strips tracking parameters (`utm_*`, `fbclid`, `mc_eid`, …) from links.
- **Forwarding banner** with the alias, the sender, how many trackers were removed, one-click **Block sender** and **Disable alias**, and a warning (also in the subject) when the sender failed DMARC.
- **Forwarding modes per alias.** *Forward everything*, *Block promotions* (list mail) or *Forward nothing*.
- **Blocklist** of addresses, or domains with their subdomains, across all aliases.
- **Search and batch editing** of the alias list, and **notes** edited in place.

**Apps and browser extensions**
- **SimpleLogin and addy.io clients.** Turn on either API in Settings, create an API key, and point the official SimpleLogin or addy.io app or browser extension at your Worker.
- **Import from SimpleLogin or addy.io**, with their API key or alias export (CSV), including SimpleLogin contacts.

**Dashboard**
- **Passkey sign-in**, with no password.
- **Cloudflare set up from the dashboard.** With an API token, one button sets up every alias domain: catch-all, reverse-alias domain, routing rule and Email Sending.
- **35 languages**, right to left where needed, in light and dark mode, on phones and desktops.

**Optional: Mailflare.** If you run [Mailflare](https://github.com/hieunc229/mailflare), it can receive some domains instead and keep a copy of every message; aliasflare then forwards from its webhook and sends replies through Mailflare, so they appear in its Sent folder.

## How it works

```
                        ┌───────────────── aliasflare Worker ─────────────────┐
 sender ──▶ shop@a.com ─┤ Email Routing catch-all of a.com                     │
                        │ removes trackers, adds the banner                    │
                        │ sends it from reply+x7k2…@r.a.com (Email Sending)    ├──▶ you@gmail.com
                        └──────────────────────────────────────────────────────┘
 you@gmail.com ──reply to reply+x7k2…@r.a.com (Email Routing rule reply@r.a.com)
                        │ checks: sender is you, and Cloudflare's DMARC verdict is pass
                        ▼
                 Email Sending ──from shop@a.com──▶ sender
```

## Requirements

- A Cloudflare account. The **Workers Free** plan works: forwards to your own mailbox use Cloudflare Email Sending, which delivers to verified destination addresses on any plan. Mail to other people (replies through reverse aliases, senders' mailto unsubscribe) needs either **Workers Paid** for Email Sending or a free account with **Resend** (3,000 a month, 100 a day) **SMTP2GO** (1,000 a month) or **Brevo** (300 a day), with each alias domain verified there.
- One or more **alias domains** on Cloudflare. Each one must be a **zone apex** (`a.com`, not `mail.a.com`), because Email Routing has catch-all rules only on the apex, and it should receive no other mail: Email Routing takes over its MX records.

## Setup

### 1. Deploy

```bash
git clone https://github.com/TWME-TW/aliasflare.git
cd aliasflare
npm install
npx wrangler d1 create aliasflare      # copy the database_id into wrangler.jsonc (or a git-ignored wrangler.local.jsonc)
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy
```

### 2. Register your passkey

1. Open `https://aliasflare.<you>.workers.dev/`. You land on the setup page.
2. Get the **one-time setup code**: run `npx wrangler tail aliasflare` and press *Write a new code to the logs* on the setup page; the code appears in the terminal. (It is also in the Worker's logs in the Cloudflare dashboard, under the Worker's *Observability* tab.) To use your own code instead, set a `SETUP_CODE` secret.
3. Enter the code and register a passkey.

### 3. Settings

- **Forwarding address**: your real inbox.
- **Alias domains**: `a.com, b.net`. Each gets the reverse-alias domain `r.a.com`, `r.b.net`.

### 4. Cloudflare

**Automatically.** On **Connection**, tick the domains, paste an API token and click **Set up automatically**. Create the token under *My Profile → API Tokens* with these permissions for the zones:
- Zone → Zone → Read
- Zone → Zone Settings → Edit
- Zone → DNS → Edit
- Zone → Email Routing Rules → Edit
- **Account** → Email Sending → Edit

The first four are **zone** permissions: under *Zone Resources*, choose *Include → Specific zone* and add each alias domain's zone, so the token can change no other domain. Email Sending is an **account** permission: under *Account Resources*, include your account.

For each domain this enables Email Routing and points the catch-all at the Worker, enables Email Routing on `r.<domain>` with subaddressing and a rule for `reply@r.<domain>`, and onboards both for Email Sending. A catch-all that already sends mail somewhere else is left unchanged. Running it again is safe. The token is used once and not stored.

**By hand**, for each alias domain `a.com`:
1. Email Routing on `a.com`: enable it; set the catch-all to *Send to a Worker* → `aliasflare`.
2. Email Routing on `r.a.com`: enable it, turn on **subaddressing**, and add the custom address `reply@r.a.com` with *Send to a Worker* → `aliasflare`.
3. Email Sending: onboard `r.a.com` and `a.com`.

A subdomain allows at most 200 routing rules, which is why one rule for `reply@` with subaddressing covers every reverse alias.

### 5. Optional: SimpleLogin and addy.io apps

1. In **Settings → Apps and browser extensions**, turn on *Support SimpleLogin clients*, *Support addy.io clients*, or both.
2. On **API keys**, create one key per app or extension.
3. In the app or extension, choose the self-hosted option and enter the URL shown on the API keys page and the key (SimpleLogin: *API URL*; addy.io: *Instance URL*).

### 6. Optional: import from SimpleLogin or addy.io

On **Import**, list the domains to bring over, then paste a SimpleLogin or addy.io API key or upload their alias export (CSV). Aliases on SimpleLogin's or addy.io's own domains keep receiving mail there, so leave those out; for your own domains, move them to Cloudflare and add them as alias domains.

### 7. Optional: Mailflare

On **Connection → Mailflare**, enter the Mailflare URL, a **personal** API key (*Settings → API keys*, with `send` and `jmap`, for every mailbox to forward) and the signing secret of a `message.inbound` webhook to the URL shown there (*Admin → Webhooks*, as the primary admin). Domains Mailflare receives need no catch-all in Email Routing, but their reverse-alias domain does need step 4's routing rule. If Mailflare runs on the same account, the `MAILFLARE_SERVICE` service binding keeps requests inside Cloudflare.

### 8. Workers plan and sending provider

On **Connection → Sending mail**, choose your Workers plan (Free is assumed) and what sends replies: Cloudflare Email Sending, Resend, SMTP2GO or Brevo, with the provider's API key. On the Free plan, with 10 ms of CPU and 50 subrequests per request:

- messages larger than 512 KB are forwarded unchanged with Email Routing's own forward (no tracker removal, and replies to them do not go through the alias);
- replies larger than 512 KB are refused with a bounce that says why;
- an API import may make at most 25 requests, so import a large account from a CSV export;
- Cloudflare setup handles at most 3 domains per run.

### Environment overrides

These variables or secrets win over the dashboard: `PUBLIC_URL`, `SIGNING_SECRET`, `SETUP_CODE`, `CLOUDFLARE_API_TOKEN`, `WORKER_NAME`, `MAILFLARE_URL`, `MAILFLARE_API_KEY`, `WEBHOOK_SECRET`, `OUTBOUND_PROVIDER` (`cloudflare`, `resend`, `smtp2go` or `brevo`), `OUTBOUND_API_KEY`, `WORKERS_PLAN` (`free` or `paid`).

## Security model

- **Dashboard.** Passkey (WebAuthn) sign-in with user verification. The first passkey needs the one-time setup code. Sessions are stored server-side, end on sign-out or when their passkey is removed, and use `__Host-` cookies; every change checks the origin, and sign-in is rate limited.
- **Reverse aliases** accept mail only from the alias's forwarding address with Cloudflare's own `dmarc=pass`, and only on the alias's own reverse-alias domain. They contain at least 8 random characters.
- **Links in forwarded mail** (unsubscribe, block, disable) are signed, work once and expire after 90 days. `GET` only shows a confirmation. Replies never carry the banner or these links to the correspondent.
- **App API keys** are random 238-bit values; only their SHA-256 hash is stored. Both client APIs are off by default and rate limited.
- **Secrets.** The Cloudflare token is never stored. The optional Mailflare API key and webhook secret are stored in D1 unless set as secrets.
- **Lost all your passkeys?** Run `npx wrangler d1 execute aliasflare --remote --command "DELETE FROM passkeys"` and register again with a new setup code.

## Limitations

- Alias domains must be zone apexes for Email Routing. A subdomain can still be received by Mailflare.
- Mail that is skipped (blocked, forwarding off) is dropped, since Email Routing keeps no copy. With Mailflare, it stays in Mailflare.
- Through the apps, PGP, labels, usernames and account settings are not available.

## Development

```bash
npm install
npm run check
cp .dev.vars.example .dev.vars && npm run db:migrate:local && npm run dev
```

Translations live in `src/locales/`. A test fails if any language misses a key or a placeholder.

## License

MIT
