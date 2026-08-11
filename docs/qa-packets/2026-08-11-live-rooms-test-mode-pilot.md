# Live Rooms Stripe Test-Mode Production Evidence Packet — 2026-08-11

## Decision

**HOLD.** The production test-money loop, separate void/refund outcomes, terminal closeout, and repaired webhook replay are evidenced. The milestone is not accepted because the historical run did not use a separately authenticated audience account, it produced only a held block request rather than a durable active block, and the corrected receipt/test-volume UI still needs an exact-deployed-build production rerun.

Passing items in this packet do not authorize live Stripe.

## Run Identity

- Environment: `https://app.sway.tips`, Stripe test mode only.
- Full money-loop date: 2026-08-09.
- Full money-loop code: `0df8580bd62a9cbc08da89b2b0f7c48fffa2c8e6` (PR #178).
- Shared-webhook repair production proof date: 2026-08-11.
- Shared-webhook repair deployed commit: `91bfe1facf58818bc4fd9e0164de8acaf6390216` (PR #182).
- Corrected receipt/test-volume/restriction candidate: this packet's containing change; exact merge SHA must be attached to the PR production-verification comment.
- Operator: repository owner with Codex-assisted browser, Stripe Dashboard, Render, and database verification.
- Room/gig ID: `825b02fc-e8a9-4ece-9957-efa4bca8ed91`.
- Room URL: `https://app.sway.tips/g/825b02fc-e8a9-4ece-9957-efa4bca8ed91`.

## Account And Browser Isolation

**FAIL for the required two-account gate.** Redacted database reconciliation found:

- Performer room owner matched the performer owner account.
- Requests: 8 total; 6 guest/unlinked; 2 authored by the performer-owner account; 0 by a separate authenticated patron account.
- Boosts: 2 total; both guest/unlinked; 0 by a separate authenticated patron account.
- The run exercised guest versus performer boundaries, but a guest identity is not a second account.
- Anonymous protected mutation denial and public-response sanitization were observed, but they do not replace the missing separate authenticated audience account.

Required rerun: performer account A and audience account B, separately authenticated in separate browser profiles, with redacted database proof that their user IDs differ.

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

**PASS at the database boundary; FAIL on the historical recap wording; correction pending production verification.**

- Payment rows: 10.
- Destination: 10/10 `sway_test_platform_balance`; 0 connected-account destinations.
- Stripe `livemode`: false on the replayed webhook evidence.
- Current outcomes: 4 `captured/not_refunded`, 2 `refunded/refunded`, 3 `voided/not_refunded`, 1 `failed/not_refunded`.
- Nonterminal payments: 0.
- The historical recap showed `$20.00` without a durable no-real-money label. That historical UI is not accepted as truthful earnings proof.
- The correction labels this as `Stripe test volume — no real money or bank payout`, derives older platform-balance rooms from durable payment destinations, and disables money-result sharing unless settlement is both live and connected-account verified.

No test amount in this packet is an earning or bank payout.

## Patron Receipt Truth

**FAIL on the historical build; correction pending production verification.**

- Historical opaque receipts preserved patron isolation and action states.
- Historical receipt projection did not independently join durable payment/refund state; a hidden/refunded action could become unavailable for the wrong reason, and a refunded boost could otherwise appear fulfilled.
- The correction adds explicit `paymentStatus`, reads the receipt's exact durable request/boost payment row, and maps void to `released`, refund pending to `refund_pending`, refund to `refunded`, and failure to `failed`.
- Refunded, released, refund-pending, and failed tips/boosts cannot remain action-fulfilled in the corrected projection.

Required rerun: capture patron-visible action plus payment labels for captured, voided, refund-pending (if available), and refunded outcomes on the exact deployed correction.

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

- Payment operations: 21 total.
- Succeeded: 20.
- Terminal failed: 1, the safely failed pre-PaymentIntent metadata-length attempt recorded in PR #178.
- Nonterminal operations: 0.
- Nonterminal payments: 0.
- Room status: `closed`.
- Registry status: `closed`, with end timestamp.

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

## Required Next Proof

1. Merge and deploy the receipt/test-volume/restricted-performer correction without using GitHub Actions.
2. Verify build marker and release health on the exact merge SHA.
3. Create/use two separately authenticated accounts in separate browser profiles.
4. Run request, tip, boost, void, refund, receipt, history, containment, and closeout on that exact build in Stripe test mode.
5. Prove active-block enforcement or keep the moderation item explicitly held with product-owner acceptance.
6. Drain and disable the test-only lane again.

## Explicit Non-Claims

- This packet does not claim App Store readiness.
- This packet does not claim live Stripe readiness or live-money behavior.
- Stripe test volume is not earnings, a payout, or transferable money.
- A guest session does not satisfy the two-account gate.
- A held block request does not prove a durable active block.
- Local tests, a deploy status, or a build marker alone do not complete the pilot.
