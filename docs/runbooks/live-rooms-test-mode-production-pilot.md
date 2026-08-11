# Live Rooms Stripe test-mode production pilot runbook

**Status:** Operator-executable. Live Stripe remains HOLD.  
**Authority docs:** `docs/process/TEST_MODE_PILOT_MILESTONE_HOLD.md`, `docs/SWAY_LIVE_PILOT_READINESS_CHECKLIST.md`  
**Evidence packet:** copy `docs/SWAY_LIVE_PILOT_QA_PACKET_TEMPLATE.md` → `docs/qa-packets/YYYY-MM-DD-live-rooms-test-mode-pilot.md`

## Hard rules

1. Use **Stripe test mode only** (`sk_test_…` / test cards). Never enable live keys.
2. Use **two separate accounts**: one performer, one audience (different emails/browsers/profiles).
3. Run against **production-hosted** Sway (`https://app.sway.tips`), not localhost.
4. Record exact deploy identity before and after the run.
5. Treat every amount as **test payment volume**, never earnings or a bank payout.

Two test settlement lanes are valid, but the operator must record which one ran:

- `connected_account`: a Stripe test connected account receives the destination charge.
- `platform_test_balance`: the explicit allowlisted rehearsal lane; no connected account or bank payout exists. This lane is test-only and must be disabled and cleared during shutdown.

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
5. If using `connected_account`, complete Stripe Connect in test mode. If using the explicitly allowlisted `platform_test_balance` lane, record that Connect is intentionally absent.
6. Set room money settings (paid requests, room minimum).
7. Create room → note **gig ID**, room URL (`/g/:gigId`), QR visible.
8. Keep this browser on the performer console (queue + payment-volume recap).

### B. Audience account

1. Browser profile **B** (separate).
2. Open `https://app.sway.tips/account/signup` (no performer intent) and create the separate audience account. A guest browser can be useful extra coverage, but it does **not** satisfy the two-account gate.
3. Open the performer room URL from step A.
4. Confirm correct room context (performer name / live room).

### C. Money loop (Stripe test cards)

Use Stripe test card `4242 4242 4242 4242`, any future expiry, any CVC, any ZIP.

| Action | Pass |
| --- | --- |
| Request (paid) | Stripe Payment Element confirms the PaymentIntent authorization; queue shows pending only after backend confirmation |
| Tip | Test PaymentIntent succeeds; payment-volume recap/payment row updates |
| Boost | Boost succeeds at/above room minimum (or free upvote if free-request mode) |
| Refund / deny-void path | Denied/refunded item shows truthful patron status; payment refund/void reflected |

Capture screenshots or short clips for each.

### D. Webhook duplicate + delayed

1. From Stripe Dashboard (test mode) → Developers → Webhooks → the Sway endpoint.
2. Open a successful `payment_intent.*` (or room payment) event from this pilot.
3. **Duplicate:** Resend the same event twice. Expect HTTP 2xx and one inbox row (no second transition, capture, refund, or queue credit).
4. **Distinct stale first delivery:** choose an older event whose original delivery never completed, then deliver it after the payment is already terminal. Expect HTTP 2xx and terminal `ignored`/safe no-op behavior, not a retry loop or state regression.
5. **Terminal-aligned late delivery:** resend an older event that agrees with the terminal payment state. Expect HTTP 2xx, one processed inbox row, and no duplicate transition.
6. Record Stripe event IDs + Sway responses / DB rows in the QA packet. Do not describe a duplicate of an already-processed event as proof of distinct stale first delivery.

### E. Closeout + receipts

1. Performer: complete/approve queue items as needed → **End room** / closeout.
2. Performer: open the recap/history; test amounts are explicitly labeled **test volume — no real money**, with sharing disabled.
3. Audience: open the opaque receipt status for the tip/request/boost and verify action state plus payment/refund state agree.
4. DB reconciliation (operator with Render Postgres read access or `DATABASE_URL`):

```sql
-- Replace :gig_id
SELECT id, action_type, payment_status, refund_status, amount_total,
       destination_account_id, processor_payment_intent_id
FROM payments
WHERE gig_id = :'gig_id'
ORDER BY created_at;

SELECT e.processor_event_id, e.event_type, e.status, e.attempt_count,
       e.livemode, e.last_error, e.received_at
FROM live_room_processor_events e
JOIN payments p ON p.id = e.payment_id
WHERE p.gig_id = :'gig_id'
ORDER BY e.received_at;

SELECT status, count(*)
FROM live_room_payment_operations
WHERE gig_id = :'gig_id'
GROUP BY status
ORDER BY status;
```

Pass when payment rows, processor events, payment-volume UI, and audience receipts agree; refunded and voided outcomes are reported separately; no `livemode=true` rows exist; and no payment, operation, or webhook row remains nonterminal.

## Required shutdown and drain

1. Close the room and verify the room registry is `closed` with an end timestamp.
2. Verify zero payments in `created`, `payment_pending`, or `authorized`.
3. Verify zero payment operations outside `succeeded` or intentionally evidenced `terminal_failed`.
4. Verify zero webhook inbox rows in `pending`, `processing`, or `retryable_failed` after at least three worker cycles.
5. If the platform-balance lane was enabled, set the switch to false and clear the performer allowlist in the confirmed Render workspace; wait for the resulting deploy and recheck runtime configuration.
6. Revoke pilot sessions or credentials that should not remain active.
7. Recheck that the pilot performer/profile/room is absent from public discovery and that no active or closing pilot rooms remain.

## Automations available in-repo

| Automation | Command / artifact | Notes |
| --- | --- | --- |
| Readiness docs contract | `npm run test:sway-live-pilot-readiness` | Docs presence only |
| Evidence template contract | `npm run test:sway-live-pilot-evidence` | Template completeness |
| Disposable Stripe test payment proof | `scripts/sway-payment-execution.integration.test.mjs` | Needs disposable DB + test keys; **not** production |
| Release identity | `/api/build-marker`, `/api/release-health` | Required commit evidence |

Browser automation may assist, but the packet must still prove two independently authenticated accounts, email verification where required, Stripe Payment Element confirmation, and Stripe Dashboard event delivery. Automation does not relax those boundaries.

## Blockers to record honestly

- Missing second email inbox / second browser profile
- Performer cannot complete the selected settlement lane (`connected_account` Connect or explicit platform-balance allowlist)
- `releaseActive: false` or commit mismatch
- Live Stripe keys present (STOP — do not continue)
- Cannot access Stripe Dashboard test webhook resend
- Cannot read production DB for reconciliation or prove the shutdown drain

## Exit

Fill the QA packet. Decision is **HOLD** until every required proof in `TEST_MODE_PILOT_MILESTONE_HOLD.md` is evidenced on the corrected deployed build. Passing this pilot does **not** authorize live Stripe or make test volume payable.
