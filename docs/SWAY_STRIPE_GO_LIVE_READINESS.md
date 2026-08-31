# Sway Stripe Go-Live Readiness

Stripe payment execution is allowed only when the server has all of:

```text
DATABASE_URL
STRIPE_PUBLISHABLE_KEY
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

## Payout Destination Certification

Payout setup fails closed until an operator verifies the matching Stripe
Dashboard controls for hosted Connect onboarding:

```text
SWAY_STRIPE_CONNECT_EXTERNAL_ACCOUNT_COLLECTION_CONFIRMED=true
SWAY_STRIPE_CONNECT_DEBIT_CARD_COLLECTION_CONFIRMED=true  # only when enabled; US accounts only
SWAY_CASH_APP_DIRECT_DEPOSIT_CONFIRMED=true                # only after Cash App eligibility proof
SWAY_VENMO_DIRECT_DEPOSIT_CONFIRMED=true                   # only after Venmo eligibility proof
```

Before setting the first flag, confirm external payout-account collection is
enabled for the platform-responsible hosted onboarding configuration. Before
setting the debit flag, also confirm Stripe's separate debit-card collection
setting. Sway exposes debit-card destinations only for `US`; Cash App and Venmo
direct-deposit preferences are also restricted to `US` and require their own
explicit operator attestations. A generic external-account confirmation enables
bank accounts only; it does not prove either wallet path is eligible. Leaving a
flag unset or false keeps the corresponding choice disabled in both the API and
UI. Wallet preferences refer only to routing/account details supplied by an
eligible Direct Deposit feature, never a username, phone number, handle, or
$cashtag.

## Webhook Replay Rule

Stripe webhooks must acknowledge duplicate, same-state, concurrent, and stale
out-of-order deliveries without mutating money state. Real status transitions
still write `payments`, `payment_events`, and `audit_events` rows.
