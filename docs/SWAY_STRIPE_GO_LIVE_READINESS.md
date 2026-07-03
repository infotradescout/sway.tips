# Sway Stripe Go-Live Readiness

Stripe payment execution is allowed only when the server has all of:

```text
DATABASE_URL
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
```

New Stripe SDK clients are pinned to API version `2026-06-24.dahlia`.

## Required Validation

```text
npm run lint
npm run build
npm run test:contracts
npm run test:integration:payment-execution
```

The integration test may skip locally when the required Stripe/Postgres env vars
are missing. A skip is not go-live evidence.

## Connect Account Shape

Sway uses destination charges without `on_behalf_of`, so new performer accounts
are Stripe Accounts v2 recipient accounts with the `stripe_balance.stripe_transfers`
capability requested and Express dashboard access. Performer payout copy must
remain conditional on Stripe verification and payout capability status.

## Webhook Replay Rule

Stripe webhooks must acknowledge duplicate, same-state, concurrent, and stale
out-of-order deliveries without mutating money state. Real status transitions
still write `payments`, `payment_events`, and `audit_events` rows.
