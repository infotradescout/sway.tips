# Sway Live Pilot QA Packet Template

## Purpose

This packet records evidence from a real live-night pilot or manual QA run. It defines the proof required before Sway can claim live-pilot readiness around the core money loop:

Room settings -> Create room -> Show QR/link -> Request/Tip/Boost -> Queue action -> Patron status -> Earnings -> End room -> Recap.

This template does not claim that a pilot has passed. It does not automate payments, fake payment proof, mutate production, change runtime behavior, or create an App Store readiness claim.

## Run Identity

- Pilot date:
- Environment tested:
- Build marker / commit SHA:
- Operator name:
- Hold/go decision:

## Room Identity

- Room URL:
- Room/gig ID:
- Performer account:
- Audience account (must be distinct):
- Account-isolation proof (different authenticated user IDs, redacted):
- Separate browser/profile proof:
- Request mode: Paid / Free requests
- Room minimum:
- Boost mode observed: Paid room minimum / Free upvote weight 1
- Device/browser notes:

## Required Evidence

Each item must include pass/fail, evidence link or screenshot/video reference, and operator notes.

### Performer Room-Settings Proof

- Evidence:
- Pass/fail:
- Notes:

### Performer Create-Room Proof

- Evidence:
- Pass/fail:
- Notes:

### QR/Link Proof

- Evidence:
- Pass/fail:
- Notes:

### Patron Room-Entry Proof

- Evidence:
- Pass/fail:
- Notes:

### Two-Account Isolation Proof

- Performer authenticated identity (redacted reference):
- Audience authenticated identity (redacted reference):
- Proof they differ:
- Protected performer mutation denied to audience:
- Public patron response contains no private actor/device/idempotency/payment/receipt fields:
- Pass/fail:
- Notes:

### Request Proof

- Evidence:
- Payment/provider mode:
- Pass/fail:
- Notes:

### Tip Proof

- Evidence:
- Payment/provider mode:
- Pass/fail:
- Notes:

### Boost Proof

- Evidence:
- Payment/provider mode:
- Paid boost amount respects room minimum:
- Free request mode boost is free upvote weight 1:
- Pass/fail:
- Notes:

### Queue Action Proof

Capture approve, deny, complete, and Up Next behavior where applicable.

- Evidence:
- Pass/fail:
- Notes:

### Patron Status Proof

Capture patron-visible status using Pending, Approved, Playing, Up Next, Paused, and Ended where applicable.

- Pending evidence:
- Approved evidence:
- Playing evidence:
- Up Next evidence:
- Paused evidence:
- Ended evidence:
- Pass/fail:
- Notes:

### Payment, Void, And Refund Truth Proof

- Authorized/captured evidence:
- Denial void evidence (`voided`, not described as refunded):
- Captured reversal evidence (`refunded/refunded`, not described as voided):
- Patron action status agrees with payment/refund status:
- Pass/fail:
- Notes:

### Payment-Volume Or End-Room Proof

- Evidence:
- Test volume is labeled no real money / no bank payout:
- Test-volume social sharing is disabled:
- Pass/fail:
- Notes:

### Recap Proof

- Evidence:
- Pass/fail:
- Notes:

### Webhook Duplicate And Stale-Delivery Proof

- Exact duplicate event ID and two HTTP responses:
- One inbox row / unchanged attempt count:
- Distinct stale first-delivery event ID and terminal ignored result:
- Terminal-aligned late event ID and processed no-op result:
- Payment transition row counts before/after:
- Pass/fail:
- Notes:

### Database Reconciliation Proof

- Payment status/refund status counts:
- Test versus live destination evidence:
- Nonterminal payment count:
- Payment operation counts and nonterminal count:
- Webhook inbox nonterminal count after three worker cycles:
- Room/registry closeout state:
- Pass/fail:
- Notes:

### Public Containment Proof

- Performer visibility state:
- Public profile/feed result:
- Closed room public route result:
- Report evidence:
- Durable block evidence (a held block request is not an active block):
- Privileged actor role and separately authenticated blocked audience identity (redacted):
- Pre-block benign request baseline and cleanup:
- Active block row plus moderation/audit event evidence:
- Blocked benign submission (HTTP 403 `block_submission`, no queue item, no payment):
- Revocation response and repeated-revoke idempotency:
- Revocation row plus `moderation.block.revoke` audit evidence:
- Post-revocation benign submission and cleanup:
- Zero unrevoked proof blocks after cleanup:
- Pass/fail:
- Notes:

### Shutdown And Drain Proof

- Room closed:
- Pilot switch disabled:
- Pilot allowlist cleared:
- Pilot sessions/temporary credentials revoked:
- Zero active or closing pilot rooms:
- Zero nonterminal payments/operations/webhooks:
- Exact final deployed commit rechecked:
- Pass/fail:
- Notes:

## Known Failures

- Failure:
- Impact:
- Owner:
- Required fix before go:

## Explicit Non-Claims

- This packet does not claim App Store readiness.
- This packet does not claim payment behavior changed.
- This packet does not claim real-provider payment proof unless Stripe, staging, or provider-backed validation evidence is attached.
- Stripe test volume is not earnings, a bank payout, or live-money proof.
- A guest session does not satisfy the two-account isolation gate.
- A held `patron_block_request` does not prove a durable active block.
- This packet does not change routes, schema, persistence, role/access behavior, AI behavior, moderation behavior, overlay runtime, or control-bridge status.
- PR #44 was merged by owner override; this packet does not claim live hardware/control proof unless a real room/token smoke is attached.
