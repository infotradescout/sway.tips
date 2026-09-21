# Sway Stripe-In / PayPal-Out Go-Live Readiness

Updated: 2026-09-02

## Money boundary

- Stripe processes incoming customer card payments only.
- New charges settle to Sway's Stripe platform balance; no new performer Stripe Connect account or destination charge is created.
- Customer checkout separately discloses and recovers the configured incoming card-processing cost so performer earnings and Sway's platform fee remain intact.
- Captured performer subtotals accumulate in Sway's durable earnings ledger.
- PayPal Payouts is the only performer cash-out provider in this release.
- Performers may save PayPal or genuine Venmo recipients. Plaid, Moov, bank, debit-card, and Cash App payout choices are not offered.
- Every encrypted recipient is bound to the exact PayPal environment. A PayPal Sandbox recipient is hidden from and unusable by live credentials; the performer must save the live destination again after cutover.
- One combined cash-out carries one disclosed PayPal provider fee. Sway payout markup is $0.

## Required validation

```text
npm run lint
npm run build
npm run test:contracts
npm run db:check
```

An integration test skip is not production evidence. A live provider response, signed webhook, database reconciliation, and recipient receipt are required for the canary.

## PayPal prerequisites

PayPal requires all of the following before Sway can send real payouts:

1. A PayPal Business account with confirmed business identity, email, and linked bank account.
2. PayPal Payouts production access approved for Sway's marketplace-earnings use case.
3. A funded PayPal balance sufficient for the payout amount and provider fee.
4. A live REST application with production client ID and secret.
5. A production webhook registered for the batch and item events listed below.

Do not mark provider approval complete from a sandbox response, app creation, or a generic PayPal Business account. The approval email or enabled production Payouts scope is the evidence.

## Incoming Stripe pricing prerequisite

Before live incoming money can open, verify the exact percentage and fixed charge that apply to Sway's Stripe account and approved card mix. Set `SWAY_STRIPE_PROCESSING_FEE_BPS` and `SWAY_STRIPE_PROCESSING_FIXED_CENTS` to that reviewed pricing, obtain the required checkout/legal approval for the customer-visible processing line, then set `SWAY_STRIPE_PROCESSING_FEE_CONFIRMED=true` and `SWAY_STRIPE_PROCESSING_FEE_APPROVAL_VERSION=2026-09-02-v1`. A guessed public list price, sandbox behavior, or stale quote is not approval; live collection fails closed without the exact version.

## Required webhook events

Register the production webhook endpoint:

```text
https://app.sway.tips/api/payouts/paypal/webhook
```

Subscribe to:

```text
PAYMENT.PAYOUTSBATCH.DENIED
PAYMENT.PAYOUTSBATCH.PROCESSING
PAYMENT.PAYOUTSBATCH.SUCCESS
PAYMENT.PAYOUTS-ITEM.BLOCKED
PAYMENT.PAYOUTS-ITEM.CANCELED
PAYMENT.PAYOUTS-ITEM.DENIED
PAYMENT.PAYOUTS-ITEM.FAILED
PAYMENT.PAYOUTS-ITEM.HELD
PAYMENT.PAYOUTS-ITEM.REFUNDED
PAYMENT.PAYOUTS-ITEM.RETURNED
PAYMENT.PAYOUTS-ITEM.SUCCEEDED
PAYMENT.PAYOUTS-ITEM.UNCLAIMED
```

Sway verifies every webhook with PayPal, stores a provider-event id and payload hash for replay protection, and retrieves the latest batch item before applying money state.

## Render configuration

Set secrets directly in Render. Never paste them into chat, source control, logs, or a client-visible `VITE_` variable.

```text
SWAY_PAYPAL_PAYOUTS_MODE=live
SWAY_PAYPAL_PAYOUTS_CLIENT_ID=<live client id>
SWAY_PAYPAL_PAYOUTS_CLIENT_SECRET=<live client secret>
SWAY_PAYPAL_PAYOUTS_WEBHOOK_ID=<live webhook id>
SWAY_PAYOUT_RECIPIENT_ENCRYPTION_KEY_BASE64=<exactly 32 random bytes, standard base64>
SWAY_PAYPAL_PAYOUTS_FEE_CENTS=<confirmed current USD API payout fee in cents>
```

Back up the recipient-encryption key in the company-controlled secret store before saving any live recipient. Replacing or losing it makes existing encrypted recipients unreadable; a rotation requires a deliberate re-save under the new key while withdrawals are locked.

Keep every release switch false while installing and verifying secrets:

```text
SWAY_PAYPAL_PAYOUTS_CONFIRMED=false
SWAY_PAYPAL_VENMO_PAYOUTS_CONFIRMED=false
SWAY_PAYPAL_PAYOUTS_TEST_EXECUTION_ENABLED=false
SWAY_PAYPAL_PAYOUTS_LIVE_EXECUTION_ENABLED=false
SWAY_PAYPAL_PAYOUTS_LIVE_APPROVAL_VERSION=
SWAY_PAYPAL_VENMO_PAYOUTS_LIVE_APPROVAL_VERSION=
SWAY_PAYPAL_PAYOUTS_LIVE_FUNDING_CONFIRMED=false
SWAY_PAYPAL_PAYOUTS_LIVE_FUNDING_VERSION=
SWAY_PAYPAL_PAYOUTS_LIVE_FEE_CONFIRMED=false
SWAY_PAYPAL_PAYOUTS_LIVE_FEE_VERSION=
SWAY_PERFORMER_KYC_PROCESS_APPROVAL_VERSION=
SWAY_PAYPAL_PAYOUTS_LIVE_CANARY_PERFORMER_ID=
SWAY_PAYPAL_PAYOUTS_LIVE_CANARY_VERSION=
SWAY_LIVE_ROOM_LIVE_MONEY_ENABLED=false
```

## Sandbox proof

Before a live canary:

1. Use PayPal Sandbox business credentials and a sandbox webhook.
2. Save a sandbox PayPal recipient and prove encryption, masked display, and destination-change fencing.
3. Accumulate multiple Stripe test captures into one test performer balance.
4. Submit one combined PayPal sandbox payout and prove stable request identity across a forced retry.
5. Confirm a signed success webhook marks the withdrawal paid exactly once.
6. Repeat with a Venmo sandbox handle or email and verify `recipient_wallet: Venmo`. PayPal Sandbox does not support the phone recipient type.
7. Prove failed, held, unclaimed, returned, duplicate, altered-replay, refund-deficit, and mode-mismatch paths.
8. Disable the sandbox execution switch after evidence is captured.

## Live canary release order

Only after PayPal approval and sandbox proof:

1. Record the approval evidence, production app identity, webhook id, current fee, and funded-balance evidence.
2. Set `SWAY_PAYPAL_PAYOUTS_CONFIRMED=true`; set `SWAY_PAYPAL_VENMO_PAYOUTS_CONFIRMED=true` only when Venmo is included in PayPal's approval.
3. Confirm the incoming Stripe pricing and customer disclosure flags described above; do not enable live collection while they are false.
4. Set both PayPal and Venmo approval versions to `2026-09-02-v1`; do not set the Venmo version unless PayPal explicitly approved Venmo payouts.
5. Confirm the funded payout balance and set the funding flag/version to `true` / `2026-09-02-v1`.
6. Confirm the current USD fee and set the fee flag plus exact version `2026-09-02-v1:USD:fee_cents=<fee>`.
7. Approve the current KYC process by setting `SWAY_PERFORMER_KYC_PROCESS_APPROVAL_VERSION=2026-09-02-v1`, then record the performer's completed review through the admin route. Identity documents never enter Sway.
8. Set the EdgeWize performer UUID as the only value in both `SWAY_LIVE_ROOM_LIVE_MONEY_PERFORMER_IDS` and `SWAY_PAYPAL_PAYOUTS_LIVE_CANARY_PERFORMER_ID`.
9. Set `SWAY_PAYPAL_PAYOUTS_LIVE_CANARY_VERSION=2026-09-02-v1:performer=<uuid>:gross_cents=1000`.
10. Set `SWAY_PAYPAL_PAYOUTS_LIVE_EXECUTION_ENABLED=true`; keep the incoming-money performer allowlist limited to EdgeWize.
11. Separately authorize and briefly set `SWAY_LIVE_ROOM_LIVE_MONEY_ENABLED=true` for one customer payment whose performer subtotal is exactly `$10.00`. Confirm Stripe capture and the `$10.00` available performer balance.
12. Set `SWAY_LIVE_ROOM_LIVE_MONEY_ENABLED=false` again before starting the cash-out, so no additional live charge can enter during payout verification.
13. Execute one and only one exact `$10.00` owner-authorized live payout to the re-entered live recipient.
14. Confirm provider status, signed webhook, ledger debit, actual fee, PayPal/Venmo receipt, and audit trail.
15. Keep incoming money locked after the canary. Any continued or widened live collection requires a separate authorization; do not widen the performer allowlist in the same release.

## Immediate rollback

Set these to false without changing stored ledger history:

```text
SWAY_PAYPAL_PAYOUTS_LIVE_EXECUTION_ENABLED=false
SWAY_LIVE_ROOM_LIVE_MONEY_ENABLED=false
```

Pending and uncertain payouts remain reserved and continue reconciliation. Never free an uncertain balance or issue a replacement payout under a new idempotency key until PayPal's provider truth is known.
