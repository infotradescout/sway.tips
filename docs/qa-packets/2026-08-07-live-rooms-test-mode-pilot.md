# Live Rooms Stripe test-mode production pilot — QA packet

## Run Identity

- Pilot date: 2026-08-07
- Environment tested: production-hosted `https://app.sway.tips`
- Build marker / commit SHA: baseline `2da0e27f…`; post when-compat deploy `c6b8188f9c683622599c953e82a60afb504ae0c5`
- Operator name: A1 agent + Thomas (human clicks required)
- Hold/go decision: **HOLD** (human two-account money loop not completed this session)

## Room Identity

- Room URL: _pending human run_
- Room/gig ID: _pending human run_
- Performer account: _pending human signup_
- Audience account: _pending human signup_
- Request mode: _pending_
- Room minimum: _pending_
- Boost mode observed: _pending_
- Device/browser notes: agent can open public pages; cannot complete email verify / Stripe Checkout without human inboxes and test payment UI

## Automated preflight (executed)

### Deployed-commit evidence

- Baseline (pre-fix): commit `2da0e27f…`; **`releaseActive: false`** (`missingCount=17`/`driftedCount=17` hash-only false pending)
- Diagnosis: drizzle hash algorithm matches repo (`sha256` of SQL); all 30 journal `when` values present in production ledger `created_at`; 17 SQL files edited after apply (cosmetic hash drift)
- After PR #168 deploy: `GET /api/build-marker` + `/api/release-health` → commit `c6b8188f9c683622599c953e82a60afb504ae0c5`; **`releaseActive: true`**; `compatible: true`; `missingCount: 0`; `driftedCount: 17` (hash drift reported, not blocking)

### Live Stripe guard

- Live Stripe remains **HOLD** by doctrine; this packet does not enable live keys.
- No production money loop executed this session.

## Required Evidence

### Performer Room-Settings Proof

- Evidence: runbook prepared (`docs/runbooks/live-rooms-test-mode-production-pilot.md`)
- Pass/fail: **fail / blocked** — no performer session credentials in agent environment
- Notes: needs human signup + email verification

### Performer Create-Room Proof

- Evidence: none yet
- Pass/fail: **blocked**
- Notes: depends on performer login

### QR/Link Proof

- Evidence: none yet
- Pass/fail: **blocked**

### Patron Room-Entry Proof

- Evidence: none yet
- Pass/fail: **blocked**

### Request Proof

- Evidence: none yet
- Payment/provider mode: Stripe **test-mode** required
- Pass/fail: **blocked**

### Tip Proof

- Evidence: none yet
- Payment/provider mode: Stripe **test-mode** required
- Pass/fail: **blocked**

### Boost Proof

- Evidence: none yet
- Payment/provider mode: Stripe **test-mode** required
- Paid boost amount respects room minimum: _pending_
- Free request mode boost is free upvote weight 1: _pending_
- Pass/fail: **blocked**

### Queue Action Proof

- Evidence: none yet
- Pass/fail: **blocked**

### Patron Status Proof

- Pending / Approved / Playing / Up Next / Paused / Ended evidence: none yet
- Pass/fail: **blocked**

### Earnings Or End-Room Proof

- Evidence: none yet
- Pass/fail: **blocked**

### Recap Proof

- Evidence: none yet
- Pass/fail: **blocked**

### Duplicate + delayed webhook Proof

- Evidence: none yet
- Pass/fail: **blocked**
- Notes: Stripe Dashboard test-mode resend required (human)

### DB reconciliation

- Evidence: production ledger read via Render MCP for migrations only; payment/gig reconciliation pending room ID
- Pass/fail: **blocked** for money rows; migration when-coverage verified separately

## Known Failures / Blockers

| Failure | Impact | Owner | Required fix before go |
| --- | --- | --- | --- |
| No performer + audience credentials / inboxes for agent | Cannot complete two-account browser pilot | Thomas / operator | Run runbook sections A–E |
| No Stripe Dashboard session for agent | Cannot execute duplicate/delayed webhook resend | Thomas / operator | Resend from test-mode webhook UI |
| Empty Render `healthCheckPath` | Deploy health not aligned to `/api/release-health` | Thomas | Dashboard click-path (API key unavailable to agent); safe now that `releaseActive: true` returns 200 |

## Explicit Non-Claims

- This packet does not claim App Store readiness.
- This packet does not claim the test-mode pilot passed.
- This packet does not claim live Stripe authorization.
- This packet does not claim payment behavior changed.
