# Live Rooms Stripe test-mode production pilot runbook

**Status:** Operator-executable. Live Stripe remains HOLD.  
**Authority docs:** `docs/process/TEST_MODE_PILOT_MILESTONE_HOLD.md`, `docs/SWAY_LIVE_PILOT_READINESS_CHECKLIST.md`  
**Evidence packet:** copy `docs/SWAY_LIVE_PILOT_QA_PACKET_TEMPLATE.md` → `docs/qa-packets/YYYY-MM-DD-live-rooms-test-mode-pilot.md`

## Hard rules

1. Use **Stripe test mode only** (`sk_test_…` / test cards). Never enable live keys.
2. Use **two separate accounts**: one performer, one audience (different emails/browsers/profiles).
3. Run against **production-hosted** Sway (`https://app.sway.tips`), not localhost.
4. Record exact deploy identity before and after the run.

## Preflight (automatable)

```bash
curl -sS -L https://app.sway.tips/api/build-marker
curl -sS -L -w "\nHTTP %{http_code}\n" https://app.sway.tips/api/release-health
```

Required before GO:

| Check | Pass criteria |
| --- | --- |
| Build marker | HTTP 200; `commit` is the intended SHA |
| Release health | HTTP 200; same `commit`; `releaseActive: true`; `migrations.compatible: true` |
| Stripe mode | UI/money path shows test-mode only; no live-money claims |

If `releaseActive` is false, **stop money steps** and repair release-health first.

## Human steps (exact click path)

### A. Performer account

1. Browser profile **A** (clean or logged-out).
2. Open `https://app.sway.tips/account/signup?intent=performer`.
3. Sign up with performer email; verify email from inbox.
4. Complete performer activation / Pro Mode → land on `/talent`.
5. Confirm Stripe Connect (test mode) if the console requires it for paid rooms.
6. Set room money settings (paid requests, room minimum).
7. Create room → note **gig ID**, room URL (`/g/:gigId`), QR visible.
8. Keep this browser on the performer console (queue + earnings).

### B. Audience account

1. Browser profile **B** (separate).
2. Open `https://app.sway.tips/account/signup` (no performer intent) **or** enter room as guest if product allows paid actions without account — record which path was used.
3. Open the performer room URL from step A.
4. Confirm correct room context (performer name / live room).

### C. Money loop (Stripe test cards)

Use Stripe test card `4242 4242 4242 4242`, any future expiry, any CVC, any ZIP.

| Action | Pass |
| --- | --- |
| Request (paid) | Checkout/test payment succeeds; queue shows pending |
| Tip | Tip payment succeeds; earnings/payment row updates |
| Boost | Boost succeeds at/above room minimum (or free upvote if free-request mode) |
| Refund / deny-void path | Denied/refunded item shows truthful patron status; payment refund/void reflected |

Capture screenshots or short clips for each.

### D. Webhook duplicate + delayed

1. From Stripe Dashboard (test mode) → Developers → Webhooks → the Sway endpoint.
2. Open a successful `payment_intent.*` (or room payment) event from this pilot.
3. **Duplicate:** Resend the same event twice. Expect idempotent ack (no double capture / no double queue credit).
4. **Delayed:** Resend an older already-processed event. Expect safe no-op / idempotent handling, not corruption.
5. Record Stripe event IDs + Sway responses / DB rows in the QA packet.

### E. Closeout + receipts

1. Performer: complete/approve queue items as needed → **End room** / closeout.
2. Performer: open **Earnings** / recap; amounts match paid test actions.
3. Audience: open receipt / payment history for the tip/request/boost.
4. DB reconciliation (operator with Render Postgres read access or `DATABASE_URL`):

```sql
-- Replace :gig_id
SELECT id, action_type, payment_status, refund_status, amount_total, processor_payment_intent_id
FROM payments
WHERE gig_id = :gig_id
ORDER BY created_at;

SELECT id, event_type, processing_status, provider_event_id
FROM live_room_processor_events
WHERE gig_id = :gig_id
ORDER BY created_at;
```

Pass when payment rows, processor events, earnings UI, and audience receipt agree; no live-mode rows.

## Automations available in-repo

| Automation | Command / artifact | Notes |
| --- | --- | --- |
| Readiness docs contract | `npm run test:sway-live-pilot-readiness` | Docs presence only |
| Evidence template contract | `npm run test:sway-live-pilot-evidence` | Template completeness |
| Disposable Stripe test payment proof | `scripts/sway-payment-execution.integration.test.mjs` | Needs disposable DB + test keys; **not** production |
| Release identity | `/api/build-marker`, `/api/release-health` | Required commit evidence |

There is **no** fully unattended production two-account browser pilot. Human signup, email verify, Stripe Checkout, and Dashboard webhook resend remain required.

## Blockers to record honestly

- Missing second email inbox / second browser profile
- Performer cannot complete Stripe Connect in test mode
- `releaseActive: false` or commit mismatch
- Live Stripe keys present (STOP — do not continue)
- Cannot access Stripe Dashboard test webhook resend
- Cannot read production DB for reconciliation

## Exit

Fill the QA packet. Decision is **HOLD** until every required proof in `TEST_MODE_PILOT_MILESTONE_HOLD.md` is evidenced. Passing this pilot does **not** authorize live Stripe.
