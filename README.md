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
- **Notes** on each alias.

**Dashboard**
- **Passkey sign-in**, with no password. Register several devices.
- **Connection settings in the dashboard.** The Mailflare URL, API key, webhook secret and reverse-alias domain are entered after you register your passkey. A deploy needs no secrets.
- **Languages:** English, 繁體中文, 简体中文 and 日本語. The language follows your browser and can be switched in the footer.
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
- **Cloudflare Email Routing** on that subdomain, with its catch-all sent to this Worker.

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

On **Connection**:

1. In Mailflare, create an **API key** with the `jmap` and `send` scopes, then paste it.
2. In Mailflare, add a **webhook** for `message.inbound` that points to the URL shown on the page (`…/webhook`). Paste its signing secret.
3. Enter your Mailflare URL and the reverse-alias domain.

Then on **Settings**, set your default forwarding address, which is your Gmail.

### 4. Cloudflare: the reverse-alias domain

1. **Email Routing** on `r.example.com`: set the **catch-all** to *Send to a Worker* → `mailflare-alias`.
2. **Email Sending**: onboard `r.example.com` and publish its DNS records.

### Environment overrides

Every connection setting can also come from a variable or secret, which then wins over the dashboard:

`MAILFLARE_URL`, `MAILFLARE_API_KEY`, `WEBHOOK_SECRET`, `REVERSE_ALIAS_DOMAIN`, `PUBLIC_URL`, `SIGNING_SECRET`, `SETUP_CODE`.

## Security model

- **Dashboard.** Sign-in uses passkeys (WebAuthn) with user verification. The first passkey can only be registered with the one-time code from the Worker's logs. Sessions are HttpOnly, Secure, SameSite=Strict cookies, every state change checks Origin, and sign-in and setup are rate limited.
- **Webhooks** must carry Mailflare's HMAC-SHA256 signature. Each message is forwarded once, even when the webhook is delivered more than once.
- **Reverse aliases** accept mail only when both of these hold:
  - the header `From` is the alias's forwarding address;
  - Cloudflare's own `Authentication-Results` reports `dmarc=pass` for that domain.

  Reverse aliases contain at least 8 random characters, so they cannot be guessed.
- **Links in forwarded mail** (unsubscribe, block, disable) are HMAC-signed and expire. `GET` only shows a confirmation, so link scanners change nothing.
- **Stored secrets.** The Mailflare API key and webhook secret are stored in D1. Use the environment overrides if you prefer Worker secrets.
- **Lost all your passkeys?** Run `npx wrangler d1 execute mailflare-alias --remote --command "DELETE FROM passkeys"` and register again with a new setup code.

## Limitations

- Replies go through Mailflare's send API, which accepts up to 10 attachments, and inline images arrive as attachments. A reply with more attachments bounces back to you with an explanation.
- An alias appears after it first receives mail.
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
