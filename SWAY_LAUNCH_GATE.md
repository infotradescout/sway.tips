# Sway Launch Gate

## App Store Readiness

- No placeholder app metadata.
- No nonfunctional public URLs.
- No fake payment claims.
- No fake public totals or performer marketplace data.
- Review account and review notes are complete.
- Production backend is available during review.

## Money Loop

- Payment intent creation is implemented.
- Request payment state is persisted.
- Denied requests are voided or refunded.
- Fulfilled requests are captured or settled according to the implemented processor flow.
- Platform fees are recorded.
- Performer ledger is visible.
- Payout records are traceable.

## Request Lifecycle

Production statuses must cover:

- `submitted`
- `payment_pending`
- `payment_authorized`
- `held_for_review`
- `approved`
- `denied`
- `voided_or_refunded`
- `fulfilled`
- `captured`
- `paid_out`
- `disputed`

## Safety And Trust

- Content filter is always active.
- Patron report path exists.
- Patron, device, or user block path exists.
- Performer hide/remove controls exist.
- Moderation audit log is persisted.
- Support/contact URL is published.
- Privacy Policy URL is published.
- Terms URL is published.
- Data deletion request path is published.
- AI moderation disclosure is published.
- Payment, refund, and payout terms are published.

## TestFlight

- 10 internal testers complete the core flow.
- 3 real performer test gigs run successfully.
- 50 or more patron scans are recorded.
- 20 or more successful test payments are recorded.
- No crash loops.
- No lost ledgers.
- No broken QR sessions.
