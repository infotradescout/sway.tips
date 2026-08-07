# Live Rooms Stripe test-mode production pilot — QA packet

## Run Identity

- Pilot date: 2026-08-07 (agent continuation, ~17:45–17:50 UTC)
- Environment tested: production-hosted `https://app.sway.tips`
- Build marker / commit SHA: **`1b150fc9d2122280a647a54b94816fa63f808303`** (`main`)
- Operator name: Cursor agent (automated) after Thomas “do it for me”
- Hold/go decision: **HOLD** — Stripe Connect / Accounts v2 sandbox not enabled; paid money loop cannot run

## Milestone scorecard (TEST_MODE_PILOT_MILESTONE_HOLD)

| # | Required proof | Result |
| --- | --- | --- |
| 1 | One performer account | **PASS** |
| 2 | One separate audience account | **PASS** |
| 3 | Real production-hosted room | **PASS** (free room only) |
| 4 | Stripe test-mode request, tip, boost, refund | **FAIL / blocked** |
| 5 | Duplicate and delayed webhook tests | **FAIL / blocked** |
| 6 | Room closeout | **PASS** (free room) |
| 7 | Performer earnings view | **FAIL / blocked** (no paid money; tips disabled) |
| 8 | Audience receipt and history | **FAIL / blocked** (no paid money) |
| 9 | Database reconciliation | **PARTIAL** (room + zero payments; no money rows to reconcile) |
| 10 | Exact deployed-commit evidence | **PASS** |

## Room Identity

- Room URL: `https://app.sway.tips/g/e91af57a-505d-495d-974c-3ece6e41036c`
- Room/gig ID: `e91af57a-505d-495d-974c-3ece6e41036c`
- Performer account: `sway-pilot-p2-1786124809@mailinator.com` (user `e528fa1a-d307-4744-acbb-d4c8f995e51c`, performer `bb604197-7d05-4bb5-96f9-4192e5c74b7c`, handle `pilot-perf-1786124809`)
- Audience account: `sway-pilot-a2-1786124809@mailinator.com` (user `44993bbf-bfe7-45b6-bde3-9d654c466041`, Pro Mode disabled)
- Request mode: free room (`paymentsEnabled: false`, `tipsEnabled: false`, `feeType: free`)
- Room minimum: `500` (cents) configured but money actions off
- Boost mode observed: money actions off; UI copy “Money actions are off for this room.”
- Device/browser notes: Mailinator public inboxes used for email verify; Cursor browser for patron room UI; API for performer session/start/end/closeout

## Automated preflight (executed)

### Deployed-commit evidence

Captured `2026-08-07T17:49:58Z` UTC:

- `GET https://app.sway.tips/api/build-marker` → commit `1b150fc9d2122280a647a54b94816fa63f808303`, branch `main`, `nodeEnv: production`
- `GET https://app.sway.tips/api/release-health` → same commit; **`releaseActive: true`**; `migrations.compatible: true`; `missingCount: 0`; `driftedCount: 17` (hash drift only, not blocking)
- Apex `https://sway.tips/api/*` redirects to `app.sway.tips` (same deploy)

### Live Stripe / test-mode guard

- `GET /api/payment/config` → `mode: "test"`, `liveRoomMoneyEnabled: true`, publishable key prefix `pk_test_…`
- No live keys enabled or touched this session
- Live Stripe remains **HOLD** by doctrine

## Required Evidence

### Performer Room-Settings Proof

- Evidence: performer signup → email verify (Mailinator) → login → Pro Mode activate (`handle=pilot-perf-1786124809`) → free room start via `POST /api/session/start` with `paymentsEnabled: false`
- Pass/fail: **pass** for free-room settings; paid-room settings **blocked** (Connect)
- Notes: paid start returns `409 seller_payout_not_ready`

### Performer Create-Room Proof

- Evidence: gig `e91af57a-505d-495d-974c-3ece6e41036c` created `2026-08-07T17:48:41.560Z`; status later closed
- Pass/fail: **pass** (free room)

### QR/Link Proof

- Evidence: public room URL HTTP 200; browser title `Join Pilot Performer's Sway room`; heading `Pilot Performer`
- Pass/fail: **pass**

### Patron Room-Entry Proof

- Evidence: browser open of room URL as separate audience identity path; UI shows free-request copy and “Money actions are off for this room.”
- Pass/fail: **pass**

### Request Proof

- Evidence: free-request UI flow reached “Your last request is pending review.” / “Free event — no payment required.” Paid request path not available without Connect.
- Payment/provider mode: Stripe test-mode configured globally, but room money off
- Pass/fail: **partial** (free UI only); **fail** for paid Stripe test request

### Tip Proof

- Evidence: paid tip blocked — `tipsEnabled: false` without seller payout readiness; Connect onboard `502`
- Pass/fail: **fail / blocked**

### Boost Proof

- Evidence: money actions off; no paid boost executed
- Pass/fail: **fail / blocked**

### Queue Action Proof

- Evidence: not completed for approve/deny/fulfill after free-request UI pending state; money queue path blocked
- Pass/fail: **fail / blocked**

### Patron Status Proof

- Pending UI observed for free request; Approved / Playing / Up Next / refunded not proven
- Pass/fail: **partial / blocked** for full status set

### Earnings Or End-Room Proof

- Evidence: `POST /api/session/end` → `ending`; `POST /api/session/closeout` → `closed` at `2026-08-07T17:49:29.342Z`; DB `manual_closeout_completed_at` set; earnings empty (`totalTips: 0`)
- Pass/fail: **pass** for closeout; **fail** for earnings content (no paid events)

### Recap Proof

- Evidence: closeout totals remain zero; no paid recap amounts
- Pass/fail: **fail / blocked** for paid recap

### Duplicate + delayed webhook Proof

- Evidence: none — no successful Stripe payment events to resend; no Stripe Dashboard session for agent
- Pass/fail: **fail / blocked**

### DB reconciliation

- Evidence (Render Postgres `sway-production-db`):
  - `gig_sessions`: id `e91af57a-…`, status `closed`, `payments_enabled=false`, `tips_enabled=false`, performer `pilot-perf-1786124809`, `payment_account_status=not_started`, `has_stripe=false`
  - `payments` for gig: **0 rows**
  - No live-mode payment rows introduced
- Pass/fail: **pass** for free-room reconciliation; **blocked** for money-loop reconciliation (no money rows)

## Stripe Connect blocker (exact)

`POST /api/talent/connect/onboard` → HTTP 502. Render app log:

> Accounts v2 is not enabled for your sandbox merchant `acct_1TvifDRxOvti613D`. Please visit https://docs.stripe.com/accounts-v2/use-accounts-as-customers to enable Accounts v2. If you would like to alternatively onboard onto Connect, please visit https://dashboard.stripe.com/acct_1TvifDRxOvti613D/settings/connect/platform-setup.

Paid room start without Connect:

> `409` `seller_payout_not_ready` — “Complete Stripe identity, charge, and payout setup before starting a paid room.”

## Known Failures / Blockers

| Failure | Impact | Owner | Required fix before go |
| --- | --- | --- | --- |
| Stripe sandbox Accounts v2 / Connect platform setup not enabled | Cannot create recipient Connect account; paid rooms/tips/boosts stay off | Thomas | Enable Accounts v2 and/or complete Connect platform setup on `acct_1TvifDRxOvti613D` (test mode) |
| Performer Stripe Connect onboarding incomplete | `seller_payout_not_ready` | Thomas or agent after Connect enabled | Complete test-mode Connect onboarding for pilot performer |
| No Stripe Dashboard session for agent | Cannot resend webhooks for dup/delay proof | Thomas | After a real test payment, resend same event twice + one delayed older event from test-mode Webhooks UI |
| Render `healthCheckPath` previously empty | Deploy health alignment | Thomas | Confirmed now set to `/api/release-health` on `sway.tips` service |

## Minimum Thomas actions to unblock the rest

1. In Stripe **test** Dashboard for `acct_1TvifDRxOvti613D`: enable Accounts v2 and/or finish Connect platform setup (link in error above).
2. Log into performer `sway-pilot-p2-1786124809@mailinator.com` (or create a fresh performer) → complete Stripe Connect test onboarding until charges + payouts enabled.
3. Re-run paid request / tip / boost / refund with test card `4242 4242 4242 4242`.
4. In Stripe test Webhooks: resend one successful event twice (duplicate) and one older event (delayed); record event IDs.
5. Confirm earnings + audience receipt/history, then re-run DB payment/event SQL from the runbook.

No live Stripe keys. Do not flip to live mode.

## Explicit Non-Claims

- This packet does not claim App Store readiness.
- This packet does not claim the Stripe test-mode money-loop pilot passed.
- This packet does not claim live Stripe authorization.
- This packet does not claim payment behavior changed.
- Free-room closeout does **not** satisfy milestone items 4, 5, 7, or 8.
