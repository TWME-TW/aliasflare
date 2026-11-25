# Security policy

aliasflare handles other people's mail, sign-in with passkeys and API keys for apps, so
security reports are very welcome.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately instead:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability** (GitHub private vulnerability reporting).
3. Describe the issue, how to reproduce it, and what an attacker could do with it.

You should get a first answer within a week. Fixes are released as soon as they are ready,
and the report is credited in the advisory unless you would rather stay anonymous.

## Supported versions

Only the latest commit on `main` is supported. Deploy updates as they come out: a fix is
not backported.

## Scope

In scope: this repository's code, its D1 migrations and its default Wrangler configuration.

Out of scope: Cloudflare itself (Workers, Email Routing, Email Sending), Mailflare, the
sending providers (Resend, SMTP2GO, Brevo, Postmark, Mailgun, Amazon SES, your SMTP server or
custom endpoint), and problems that need someone to already have
access to your Cloudflare account or your passkey.

When testing, use your own deployment and your own addresses. Do not send mail to or test
against other people's deployments.
