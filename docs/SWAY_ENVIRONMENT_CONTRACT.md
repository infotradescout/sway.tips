# Sway Environment Contract

## Required By Environment

Development:

- `APP_URL`
- `PERSISTENCE_DRIVER=memory`

Production:

- `APP_URL`
- `PERSISTENCE_DRIVER` backed by a real database
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
