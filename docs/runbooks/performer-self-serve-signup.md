# Performer Self-Serve Signup

## Purpose

This runbook describes the self-serve performer account creation path for new Sway performers.

## Flow

1. Performer opens `/talent/signup`.
2. Performer enters performer name, unique lowercase handle, email, password, password confirmation, and accepts Terms.
3. Server creates the `users` row immediately with `password_hash`, `terms_accepted_at`, and `email_verified_at = null`.
4. Server creates the owned `performers` row immediately in a restricted inactive state.
5. Server creates a short-lived durable email verification challenge.
6. The verification email links to `/api/talent/verify-email/consume?token=...`.
7. Consuming the link marks `users.email_verified_at`, activates the performer profile, and redirects back to the performer login flow.
8. The performer can log in before verification, but Sway blocks live-room start until the email is verified.

## Guardrails

- signup verification links are single-use
- signup verification links expire after 15 minutes
- duplicate handle claims may return a clear handle-taken response
- duplicate email claims fail safely without easy enumeration
- plaintext passwords must never be persisted or logged
- external redirect URLs are ignored
- unverified performer owners must not start live rooms
