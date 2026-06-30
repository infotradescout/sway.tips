# Performer Email Magic Link Login

## Purpose

This is the primary performer-facing browser login flow for already-authorized performer owners.

It is intentionally narrow:

- no public self-signup
- no patron login
- no passwords
- no SMS login
- no social auth

## Required production env vars

- `DATABASE_URL`
- `SWAY_APP_BASE_URL`
- `SWAY_EMAIL_PROVIDER`
- `SWAY_EMAIL_API_KEY`
- `SWAY_EMAIL_FROM`
- `SWAY_PERFORMER_LOGIN_RATE_LIMIT_MAX` optional
- `SWAY_PERFORMER_LOGIN_RATE_LIMIT_WINDOW_MS` optional

## Access model

1. The performer already exists in the database.
2. The performer owner user already has an approved email on `users.email`.
3. `/talent/login` accepts the performer email and always returns enumeration-safe success copy.
4. If the email belongs to an authorized performer owner, the server creates a short-lived durable login challenge and delivers a secure sign-in link.
5. Consuming the link revokes older active `performer_sessions`, issues a fresh DB-backed browser session cookie, and redirects to `/talent`.

## Link contract

- link lifetime is exactly 15 minutes
- only SHA-256 token hashes are stored
- links are single-use
- older active performer sessions are revoked before the new session is issued
- redirects default to `/talent`
- external redirect URLs are ignored

## Non-production behavior

Outside production, the mailer logs the sign-in link to the server console instead of calling an external mail provider.

## Support fallback

If the performer-facing email login flow is unavailable, support may still use the bootstrap runbook:

- [performer-browser-session-bootstrap.md](./performer-browser-session-bootstrap.md)
