# Performer Browser Session Bootstrap

## Purpose

This runbook is the operator/support fallback path for an already-authorized performer or room operator to reach `/talent` in a normal browser without manual header injection.

It is intentionally narrow:

- no public registration
- no patron login
- no password flow
- no fallback headers as browser auth
- no replacement for the performer-facing email magic-link login flow

## Required production env vars

- `DATABASE_URL`
- `SWAY_PERFORMER_BOOTSTRAP_SECRET`
- `SWAY_PERFORMER_SESSION_TTL_HOURS` optional

`SWAY_PERFORMER_SESSION_TTL_HOURS` defaults to `12`.

## Access model

1. The performer/operator already exists in the database and already passes persisted performer ownership, membership, or gig-access authorization.
2. An operator or support teammate generates a short-lived bootstrap link.
3. The bootstrap endpoint verifies the signed token, issues a DB-backed `performer_sessions` row, sets the `HttpOnly` browser cookie, and redirects to `/talent`.
4. `/talent` and protected performer mutations resolve actor context from that cookie.

## Generate a bootstrap link

PowerShell example:

```powershell
$env:SWAY_PERFORMER_BOOTSTRAP_SECRET = 'REPLACE_WITH_SECRET'
npm run performer:access:link -- --actor-user-id REPLACE_WITH_PERFORMER_USER_UUID --base-url https://app.sway.tips --ttl-minutes 15
```

The script prints:

- actor user ID
- expiry timestamp
- the signed bootstrap URL

## Use the bootstrap link

1. Open the generated `/api/talent/session/bootstrap?token=...` URL in the target browser.
2. The server sets the `sway_performer_session` cookie and redirects to `/talent`.
3. Confirm `/talent` now loads instead of the protected `401` recovery page.
4. Start the live room and use the existing room-specific share kit.

## Cookie contract

The performer browser cookie is:

- `HttpOnly`
- `Secure` in production
- `SameSite=Lax`
- `Path=/`
- expiration aligned to the DB `performer_sessions.expires_at`

The raw session token is never stored in the database.
Only `token_hash` is persisted.

## Revocation

Current-session revocation:

- `POST /api/talent/session/logout`

Administrative/manual revocation:

```sql
UPDATE performer_sessions
SET revoked_at = now()
WHERE actor_user_id = 'REPLACE_WITH_USER_UUID'
  AND revoked_at IS NULL;
```

## What `401` means

`401` means the browser did not present a valid performer session cookie.

Common causes:

- no bootstrap link was used
- bootstrap link expired before use
- cookie expired
- session was revoked
- session token was tampered with

## Verification

Use this lane’s verification after the browser session is established:

1. Open `/talent`.
2. Start a room.
3. Confirm the share kit shows the room-specific `/g/:activeGigId` link.
4. Confirm the QR is black on white with quiet-zone padding.
5. Scan and print-test the QR as required by the performer share lane.

## Do not do this

- Do not treat fallback headers as production browser login.
- Do not present bootstrap links as the primary public performer sign-in experience.
- Do not pass `x-sway-actor-id` manually in the browser.
- Do not share long-lived bootstrap links.
