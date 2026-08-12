# Live Rooms Stripe Test-Mode Production Evidence Packet — 2026-08-11

## Decision

**HOLD.** The production test-money loop, separate void/refund outcomes, terminal closeout, repaired webhook replay, corrected patron refund receipt, truthful zero-captured recap, and exact-deployed payment-dialog correction are evidenced. The milestone is not accepted because neither production run used a separately authenticated audience account and production still lacks an authorized durable active-block enforcement proof.

Passing items in this packet do not authorize live Stripe.

## Run Identity

- Environment: `https://app.sway.tips`, Stripe test mode only.
- Full money-loop date: 2026-08-09.
- Full money-loop code: `0df8580bd62a9cbc08da89b2b0f7c48fffa2c8e6` (PR #178).
- Shared-webhook repair production proof date: 2026-08-11.
- Shared-webhook repair deployed commit: `91bfe1facf58818bc4fd9e0164de8acaf6390216` (PR #182).
- Corrected receipt/test-volume/restriction production rerun: `787b76ca4e18ed5133fb90750a142530bd7430e8` (PR #190).
- Payment-dialog visual-viewport and authorization-state hardening: `746ba8ef7b133e74d8e241db8e9fe01166c94eda` (PR #191), deployed by Render as `dep-d9tt8k49v7es73cca6rg`.
- Exact-build health observed 2026-08-11 America/Chicago (2026-08-12 UTC): `/api/build-marker` and `/api/release-health` both reported `746ba8ef7b133e74d8e241db8e9fe01166c94eda`; the database was reachable, all 34 expected migrations were applied, and `releaseActive` was `true`.
- Operator: repository owner with Codex-assisted browser, Stripe Dashboard, Render, and database verification.
- Room/gig ID: `825b02fc-e8a9-4ece-9957-efa4bca8ed91`.
- Room URL: `https://app.sway.tips/g/825b02fc-e8a9-4ece-9957-efa4bca8ed91`.
- Corrected-build rerun room/gig ID: `abe0ed62-3e37-4128-a486-a8eded1fb6e3`.

## Account And Browser Isolation

**FAIL for the required two-account gate.** Redacted database reconciliation found:

- Performer room owner matched the performer owner account.
- Requests: 8 total; 6 guest/unlinked; 2 authored by the performer-owner account; 0 by a separate authenticated patron account.
- Boosts: 2 total; both guest/unlinked; 0 by a separate authenticated patron account.
- The run exercised guest versus performer boundaries, but a guest identity is not a second account.
- Anonymous protected mutation denial and public-response sanitization were observed, but they do not replace the missing separate authenticated audience account.

Required rerun: performer account A and audience account B, separately authenticated in separate browser profiles, with redacted database proof that their user IDs differ.

The 2026-08-11 corrected-build rerun did use separate performer and audience browser identities/sessions. The audience remained receipt-based rather than separately authenticated, so that useful isolation evidence does not satisfy this gate.

## Room, Request, Tip, Boost, And Queue

**PASS on the historical Stripe test run, pending exact-current-build rerun.** [PR #178 production evidence](https://github.com/infotradescout/sway.tips/pull/178#issuecomment-5233456391) records:

- paid request authorization, performer approval/capture, and fulfillment;
- paid boost capture against an approved request and parent fulfillment;
- straight-tip capture and fulfillment;
- denied authorization terminally voided;
- captured request and boost terminally refunded after hide/removal;
- pause rejection before request/payment creation and successful resume;
- idempotent duplicate/reconciliation convergence;
- room closeout and recap.

The room and registry are currently `closed`, with registry end evidence and no active public room.

## Test-Money And Settlement Truth

**PASS at the database boundary; historical wording failed; corrected-build rerun passed.**

- Historical room payment rows: 10.
- Historical room destination: 10/10 `sway_test_platform_balance`; 0 connected-account destinations.
- Stripe `livemode`: false on the replayed webhook evidence.
- Current outcomes: 4 `captured/not_refunded`, 2 `refunded/refunded`, 3 `voided/not_refunded`, 1 `failed/not_refunded`.
- Nonterminal payments: 0.
- The historical recap showed `$20.00` without a durable no-real-money label. That historical UI is not accepted as truthful earnings proof.
- The correction labels this as `Stripe test volume — no real money or bank payout`, derives older platform-balance rooms from durable payment destinations, and disables money-result sharing unless settlement is both live and connected-account verified.
- The corrected-build rerun ended with both captured payments refunded. The performer recap truthfully showed `$0` captured and `0` completed actions; no test amount was presented as earnings or payout.

No test amount in this packet is an earning or bank payout.

## Patron Receipt Truth

**FAIL on the historical build; PASS for the captured-to-refunded path on the corrected production build.**

- Historical opaque receipts preserved patron isolation and action states.
- Historical receipt projection did not independently join durable payment/refund state; a hidden/refunded action could become unavailable for the wrong reason, and a refunded boost could otherwise appear fulfilled.
- The correction adds explicit `paymentStatus`, reads the receipt's exact durable request/boost payment row, and maps void to `released`, refund pending to `refund_pending`, refund to `refunded`, and failure to `failed`.
- Refunded, released, refund-pending, and failed tips/boosts cannot remain action-fulfilled in the corrected projection.
- The corrected production rerun created two fresh `$5` Stripe test-mode requests (each `$5` subtotal, `$1` fee, `$6` total), captured each exactly once, refunded each exactly once, and showed the audience receipt as `Payment refunded` with the explicit refund message.
- The second reversal exercised the in-page confirmation dialog: Cancel, keyboard containment, Escape, focus restoration, and confirmation were observed before the queue returned empty.

Remaining UI matrix gap: voided and refund-pending patron labels were not re-observed on the corrected production build. Durable void/refund separation remains evidenced below, and contract/browser coverage protects the corrected projection, but this packet does not promote those unobserved production UI states to PASS.

## Void Versus Refund

**PASS at the durable database boundary.**

- Denial/release evidence: 3 payments are `voided/not_refunded`.
- Captured reversal evidence: 2 payments are `refunded/refunded`.
- These are separate outcomes and are not conflated in this packet.

## Webhook Duplicate, Distinct Stale Delivery, And Late Terminal Delivery

**PASS on deployed commit `91bfe1facf58818bc4fd9e0164de8acaf6390216`.**

Stripe Dashboard showed the original 503 deliveries and two later HTTP 200 deliveries for each selected event after the shared-route repair.

| Event | Meaning | Inbox result | Attempts | Transition rows | Payment remained |
| --- | --- | --- | ---: | ---: | --- |
| `evt_3U2cIYRxOvti613D0JI0f3LF` | Distinct stale first successful delivery of `payment_intent.amount_capturable_updated`, then exact duplicate | `ignored`, no error | 1 | 0 | `voided/not_refunded` |
| `evt_3U2cGrRxOvti613D1dvM83Cy` | Terminal-aligned late `charge.refunded`, then exact duplicate | `processed`, no error | 1 | 0 | `refunded/refunded` |

After more than three worker cycles, webhook nonterminal count was 0 and neither payment regressed or duplicated a transition.

## Payment Operations And Closeout

**PASS.**

- Historical room payment operations: 21 total.
- Historical room succeeded operations: 20.
- Historical room terminal failed operations: 1, the safely failed pre-PaymentIntent metadata-length attempt recorded in PR #178.
- Historical room nonterminal operations: 0.
- Historical room nonterminal payments: 0.
- Historical room status: `closed`.
- Historical room registry status: `closed`, with end timestamp.
- Corrected-build room state revision: 11; room and registry are closed, closeout is complete, and the registry has an end timestamp.
- Corrected-build room payments: 2, both `refunded/refunded`; payouts remain `not_started`; subtotal `$10`, fees `$2`, total test charges `$12`.
- Corrected-build room operations: 2 authorize, 2 capture, and 2 reverse, all succeeded; maximum one reverse per payment; zero nonterminal or terminal-failed operations.
- Corrected-build room processor events: 8 processed test events, including 2 `charge.refunded`; zero errors, live-mode events, or nonterminal events.

## Public Containment

**PASS for room/profile discovery containment.**

- Performer visibility: `draft`.
- Performer active/onboarding: active, `gig_ready`.
- Active preview: absent.
- Public profile row: absent.
- Room registry: closed.
- The closed room is not an active public live room.

## Moderation, Report, And Block

**PARTIAL / HOLD.**

- The pilot window contains three held-for-review moderation events: request visibility, request report, and patron block request.
- The report path returned evidence.
- The patron block request was held for review; no durable `active_blocks` row was created during the pilot window.
- A held block request is not active blocking proof.
- The durable active-block database path is implemented and independently passed its disposable-PostgreSQL enforcement proof after PR #188. That is implementation evidence, not production evidence.
- Production activation requires an authorized administrator. The available pilot identities do not carry that authority, and no account was impersonated, reset, or elevated to manufacture proof.

Required rerun: prove either the intended held-for-review product contract explicitly, or complete an authorized durable block and verify enforcement from a separate audience account. Do not call the existing evidence an active block.

## Shutdown And Drain

**PASS for the historical pilot.**

- Room and registry closed.
- Platform-balance pilot switch reported false after the run.
- Pilot performer allowlist was cleared.
- Pilot performer session was revoked.
- Zero active/closing pilot rooms were reported.
- Zero nonterminal payments, operations, and selected webhook events remain.
- Synthetic performer/profile remains contained from public discovery.

**PASS for the corrected-build rerun.** The second room and active-room registry are closed, closeout is complete, the queue is empty, all two captured payments are refunded, all authorize/capture/reverse operations are terminal with one reverse per payment, selected processor events are processed without errors, and the audience saw `Live Room Ended`.

## Payment Dialog Exact-Build Evidence

**PASS for implementation and exact deployment; no compact-device production screenshot is claimed.**

- PR #191 added rendered browser coverage for compact portrait, short landscape, visual-viewport keyboard shrink, nonzero viewport offsets, all dialog edges, scrolling, Cancel reachability, keyboard containment across a simulated provider-iframe focus boundary, Escape and focus restoration, delayed Stripe authorization, stale reconciliation success, and close/reopen timer races.
- `npm run test:browser:payment-modal-viewport`, the focused source contract, lint, build, and the hard contract suite passed before merge.
- Render deployed the exact merge commit `746ba8ef7b133e74d8e241db8e9fe01166c94eda`, and both production build endpoints matched it with release health active.
- The earlier corrected production rerun exercised the refund confirmation dialog on PR #190. The visual-viewport hardening itself is bound to exact deployed source plus rendered browser proof; this packet does not pretend that local rendered coverage is a production-device observation.

## Required Next Proof

1. Create/use a separately authenticated audience account alongside the performer in separate browser profiles.
2. Re-observe the remaining patron UI matrix (tip, boost, void, and refund-pending if safely available) on the exact current build in Stripe test mode.
3. Prove production active-block enforcement with an authorized administrator, or obtain product-owner acceptance that the production outcome remains held-for-review.
4. Reconcile the database, closeout, and drain again after that bounded proof run.

## Explicit Non-Claims

- This packet does not claim App Store readiness.
- This packet does not claim live Stripe readiness or live-money behavior.
- Stripe test volume is not earnings, a payout, or transferable money.
- A separate anonymous/receipt-based browser session does not satisfy the two-account gate.
- A held block request does not prove a durable active block.
- Local tests, a deploy status, or a build marker alone do not complete the pilot.
- The rendered visual-viewport test does not claim a production-device screenshot.
