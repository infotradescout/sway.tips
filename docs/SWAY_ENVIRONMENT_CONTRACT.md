# Sway Environment Contract

## Required By Environment

Development:

- `APP_URL`
- `PERSISTENCE_DRIVER=memory`

Production:

- `APP_URL`
- `SWAY_APP_BASE_URL`
- `PERSISTENCE_DRIVER` backed by a real database
- `SWAY_PERFORMER_BOOTSTRAP_SECRET`
- `SWAY_PERFORMER_SESSION_TTL_HOURS` optional
- `SWAY_EMAIL_PROVIDER` (production currently uses Brevo, not Resend; the API key must be valid and the sending IP range/allowlist on the Brevo account must not block Render's egress, or signup verification email delivery fails silently from the app's point of view)
- `SWAY_EMAIL_API_KEY`
- `SWAY_EMAIL_FROM`
- `SWAY_PERFORMER_LOGIN_RATE_LIMIT_MAX` optional
- `SWAY_PERFORMER_LOGIN_RATE_LIMIT_WINDOW_MS` optional
- `SWAY_PERFORMER_SIGNUP_RATE_LIMIT_MAX` optional
- `SWAY_PERFORMER_SIGNUP_RATE_LIMIT_WINDOW_MS` optional
- `SWAY_PERFORMER_PASSWORD_LOGIN_RATE_LIMIT_MAX` optional
- `SWAY_PERFORMER_PASSWORD_LOGIN_RATE_LIMIT_WINDOW_MS` optional
- payment processor keys
- payout processor or connected-account configuration
- `SWAY_TEST_MODE_PLATFORM_BALANCE_ENABLED=true` only for an authorized Stripe
  test-mode rehearsal that must run before connected-account onboarding; the
  switch is ignored with live keys and proves no performer bank payout
- `SWAY_TEST_MODE_PLATFORM_BALANCE_PERFORMER_IDS` must contain only the exact
  comma-separated performer UUIDs approved for that rehearsal; an empty or
  invalid allowlist keeps the lane disabled
- published Privacy Policy URL
- published Terms URL
- published Support URL
- data deletion request URL
- `MUSIC_CATALOG_PROVIDER` backed by a licensed/verifiable catalog

## Hard Rules

- Production business routes must not mutate in-memory state.
- Production payment routes must not use simulated checkout state.
- The platform test-balance lane may use real Stripe test PaymentIntents only.
  It must stay behind `SWAY_TEST_MODE_PLATFORM_BALANCE_ENABLED=true`, must
  require the performer in `SWAY_TEST_MODE_PLATFORM_BALANCE_PERFORMER_IDS`, must
  identify its durable destination as `sway_test_platform_balance`, must omit
  Connect transfer instructions, and must never activate under live keys.
- Production catalog routes must not return AI-generated or hardcoded song facts.
- Moderation must remain deterministic and active when external services are unavailable.
- Missing production infrastructure must fail closed with a clear server error.
- Performer browser access must use DB-backed `performer_sessions` cookies, not fallback actor headers.
- Public performer browser login must support email+password as the primary flow, with enumeration-safe magic-link recovery kept secondary.
- Public performer signup must require terms acceptance, password hashing, durable user/profile creation, and short-lived email verification links before live-room start is allowed.
- The deploy pipeline (`render.yaml` `preDeployCommand`) must run `npm run db:migrate` before the new application version takes traffic. A schema-changing deploy that skips this step can ship code against an unmigrated production database; this happened once (Phase 2 Slice 1A) and the fix is this rule, not a one-off remediation.
- Production exact-original audio storage requires `SWAY_AUDIO_STORAGE_PROVIDER=r2` plus bucket-scoped `SWAY_AUDIO_R2_ACCOUNT_ID`, `SWAY_AUDIO_R2_ACCESS_KEY_ID`, `SWAY_AUDIO_R2_SECRET_ACCESS_KEY`, and `SWAY_AUDIO_R2_BUCKET`. Startup must successfully inspect the private bucket before accepting traffic. Local filesystem storage is development-only. See `docs/runbooks/audio-master-vault.md`.
- `SWAY_AUDIO_WORKSPACE_LIMIT_BYTES` sets the server-enforced per-performer working-storage pool and defaults to `5368709120` (5 GiB). It must be a positive safe integer. Release count remains unlimited; changing this value must not add a release-count gate or delete sealed originals.
- `SWAY_AUDIO_WORKING_OBJECT_LIMIT` caps active upload reservations plus sealed working-file records and defaults to `10000`. It prevents tiny-object/database abuse; it must not count exact versions in immutable validated release-package manifests and is not a release-count limit. Mutable release or delivery status must not affect this calculation.
- Public room-state reads must never return unfiltered internal request/session objects. Any unauthenticated or patron-scoped read of room state must go through the sanitized projection (`src/server/public-room-state.ts`); adding a new field to the internal room/request model does not automatically make it public.
