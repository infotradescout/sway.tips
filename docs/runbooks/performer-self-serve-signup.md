# Performer Self-Serve Signup

## Purpose

This runbook describes the single universal-account path for someone who intends to perform on Sway.

## Flow

1. `/talent/signup` redirects to `/account/signup?intent=performer`; there is no second performer account type.
2. The person enters their name, email, password, password confirmation, and accepts Terms.
3. The server creates one unverified `users` row with Pro Mode disabled and issues a durable verification challenge carrying `/account?intent=performer` as the safe continuation.
4. The verification email links to `/api/account/verify-email/consume?token=...`.
5. Consuming the link marks `users.email_verified_at` and returns to the universal account login while preserving performer intent.
6. Login continues to `/account?intent=performer`, where the person chooses a performer name and unique handle and activates Pro Mode.
7. Pro Mode activation creates or reuses the single owned `performers` row and redirects to `/talent`.
8. The console starts with a free-room path. Any money rehearsal is Stripe test mode only; no real money moves.

## Guardrails

- account verification links are single-use
- account verification links expire after 15 minutes
- duplicate handle claims may return a clear handle-taken response
- duplicate email claims fail safely without easy enumeration
- plaintext passwords must never be persisted or logged
- external redirect URLs are ignored
- only `/account?intent=performer`, `/talent`, and existing ticket/event continuations are accepted as account redirect targets
- `/api/talent/signup` returns `410 universal_account_required` and cannot create an account
- unverified account owners must not activate or start live rooms
- a room-start retry reuses the same `gig_id`; changed setup must use a new identity
