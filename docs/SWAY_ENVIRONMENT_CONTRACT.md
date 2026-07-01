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
- `SWAY_EMAIL_PROVIDER`
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
- published Privacy Policy URL
- published Terms URL
- published Support URL
- data deletion request URL
- `MUSIC_CATALOG_PROVIDER` backed by a licensed/verifiable catalog

## Hard Rules

- Production business routes must not mutate in-memory state.
- Production payment routes must not use simulated checkout state.
- Production catalog routes must not return AI-generated or hardcoded song facts.
- Moderation must remain deterministic and active when external services are unavailable.
- Missing production infrastructure must fail closed with a clear server error.
- Performer browser access must use DB-backed `performer_sessions` cookies, not fallback actor headers.
- Public performer browser login must support email+password as the primary flow, with enumeration-safe magic-link recovery kept secondary.
- Public performer signup must require terms acceptance, password hashing, durable user/profile creation, and short-lived email verification links before live-room start is allowed.
