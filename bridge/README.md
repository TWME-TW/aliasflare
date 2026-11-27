# aliasflare Mail Bridge (IMAP / POP3 / SMTP)

Stateless companion bridge that exposes standard **IMAP / IMAPS**, **POP3 / POP3S**, and **SMTP / SMTPS** endpoints for desktop and mobile mail apps (Thunderbird, Apple Mail, K-9 Mail, FairEmail, Outlook, etc.) while keeping **zero emails and zero credentials on disk**.

Every client session authenticates directly against your deployed `aliasflare` Worker's `/mail-api/v1/*` HTTPS Gateway using scoped **Mail App Passwords** (`afm_...`).

## Why a Bridge?

Cloudflare Workers only serve HTTP/HTTPS and WebSockets (and outbound TCP via `connect()`), and cannot natively accept inbound raw TCP connections on ports 143/993/110/995/465/587. Running this lightweight Node.js bridge on localhost, a NAS, a home server, or a small VPS gives you full native IMAP/POP3/SMTP compatibility with any mail client.

## Quick Start (Docker Compose)

1. In your `aliasflare` dashboard, go to **Settings → Mail protocols** and enable the protocols you want (`IMAP`, `POP3`, `SMTP`).
2. Go to **API keys → Mail App Passwords**, create a password for your mail client, and note the **Username** and **Password (`afm_...`)**.
3. Edit `docker-compose.yml` to set `ALIASFLARE_URL` to your Worker URL (and mount TLS certs if exposing beyond localhost/VPN), then run:

```bash
cd bridge
docker compose up -d
```

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `ALIASFLARE_URL` | *(required)* | Base URL of your aliasflare Worker (e.g. `https://alias.example.com`) |
| `BIND_HOST` | `127.0.0.1` | Listen interface (`0.0.0.0` inside Docker) |
| `ENABLE_IMAP` | `true` | Start IMAP (`143`) and IMAPS (`993` when TLS is configured) |
| `ENABLE_POP3` | `false` | Start POP3 (`110`) and POP3S (`995` when TLS is configured) |
| `ENABLE_SMTP` | `true` | Start SMTP (`587`) and SMTPS (`465` when TLS is configured) |
| `TLS_CERT_FILE` | *(empty)* | Path to PEM full-chain certificate |
| `TLS_KEY_FILE` | *(empty)* | Path to PEM private key |
| `ALLOW_PLAINTEXT_AUTH` | `false` | Allow plaintext auth without TLS (**only** use on `127.0.0.1` or an encrypted VPN/Tailscale tunnel) |
| `IMAP_PORT` / `IMAPS_PORT` | `143` / `993` | IMAP / IMAPS ports |
| `POP3_PORT` / `POP3S_PORT` | `110` / `995` | POP3 / POP3S ports |
| `SMTP_PORT` / `SMTPS_PORT` | `587` / `465` | SMTP / SMTPS ports |

## Security Notes

- **Never open-relay**: SMTP always requires `AUTH PLAIN` or `AUTH LOGIN` with a password that has SMTP permission AND `smtpEnabled = true` in Settings.
- **Double-gated toggles**: Each protocol requires BOTH the global setting in `aliasflare` AND the per-password scope (`allow_imap` / `allow_pop3` / `allow_smtp`).
- **TLS by default**: Plaintext authentication is refused unless TLS is active or `ALLOW_PLAINTEXT_AUTH=true` is explicitly opted in for loopback/VPN use.
