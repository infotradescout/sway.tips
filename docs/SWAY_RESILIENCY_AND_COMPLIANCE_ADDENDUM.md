# Sway Resiliency And Compliance Addendum

This addendum captures launch-killer risks found during roadmap critique and turns them into build requirements.

These requirements are not optional polish. They protect the first paid loop from operational failure, payment abandonment, KYC drop-off, bad cellular conditions, and App Store review surprises.

## Decision

Sway must assume live-gig conditions are messy:

```text
performers are distracted
venues have poor signal
patrons are impatient
payments can be delayed
phones die
manual closeout can be missed
KYC creates onboarding friction
```

The product must succeed under those conditions, not only in a clean demo.

## 1. Server-Side Gig Expiration And Hard Closeout

### Problem

A performer may forget to close out a gig, lose signal, leave the venue, or have a dead phone after the event.

If unresolved requests remain in held or approved states, patrons may see pending card authorizations or unclear payment outcomes. This creates support load, disputes, and trust loss.

### Required Model Fields

`gig_sessions` must include:

```text
status
started_at
scheduled_end_at
last_activity_at
manual_closeout_started_at
manual_closeout_completed_at
auto_closeout_at
auto_closeout_reason
closeout_policy
```

### Required Closeout Policy

Each active gig must have a server-side expiration timestamp.

Default policy:

```text
auto_closeout_at = max(started_at + 4 hours, scheduled_end_at + 30 minutes when scheduled_end_at exists)
```

If no performer activity, no payment activity, and no request lifecycle activity occurs before `auto_closeout_at`, the backend must execute hard closeout.

### Hard Closeout Behavior

On hard closeout:

```text
set gig status to closed
void/refund unresolved payment authorizations where supported
transition held_for_review requests to voided_or_refunded
transition payment_authorized requests to voided_or_refunded unless fulfilled/captured
leave fulfilled/captured requests unchanged
create audit events for every transition
record auto_closeout_reason
notify performer when notification channels exist
```

### Required Tests

```text
scripts/sway-auto-closeout.contract.test.mjs
```

The test must prove:

```text
active gig has auto_closeout_at
stale gig cannot remain open forever
unresolved requests transition to voided_or_refunded
fulfilled/captured requests are not reversed
closeout creates audit events
```

## 2. Deferred KYC / Payout Friction Control

### Problem

Stripe Connect and similar payout systems require performer identity verification. Forcing full KYC before a performer sees product value may crush onboarding conversion.

### Product Rule

Sway should let a performer experience the product before completing payout verification, but must not create a noncompliant stored-value system or promise payouts before processor requirements are satisfied.

### Required Onboarding States

`performers` must include:

```text
onboarding_status
payment_account_status
kyc_status
payouts_enabled
charges_enabled
lifetime_gross_volume
payout_hold_reason
verification_required_at_amount
```

Allowed onboarding statuses:

```text
created
profile_started
gig_ready
payments_limited
verification_required
verified
payouts_enabled
restricted
suspended
```

### Deferred Verification Threshold

Initial product threshold:

```text
verification_required_at_amount = 10000 cents lifetime gross volume
```

This is a product gating threshold, not a promise that all processors allow all payment flows before verification.

Implementation must follow the selected payment processor's current Connect/account requirements.

### UX Rule

Before verification:

```text
performer can create profile
performer can create gig
performer can generate QR/link
performer can see pending/earned dashboard balance when legally/processor-supported
payouts remain locked until verification is complete
UI must clearly say verification is required before payout
```

Forbidden copy:

```text
instant payout guaranteed
withdraw anytime before verification
money is yours with no verification
bank transfer ready before KYC
```

### Required Tests

```text
scripts/sway-deferred-kyc.contract.test.mjs
```

The test must prove:

```text
performer can reach gig_ready before payout verification
payout route is blocked until payouts_enabled is true
$100 threshold is configured centrally
UI copy does not promise unverified payouts
status transitions are explicit
```

## 3. Bad-Network Client Resilience

### Problem

Sway will be used in clubs, festivals, basements, bars, and crowded venues where cellular and Wi-Fi can drop.

A patron should not lose transaction clarity because a WebSocket, fetch call, or page refresh fails.

### Required Client Behavior

For request, tip, and boost submission:

```text
create client_request_id before network call
persist pending action to local storage
show pending/offline indicator when network is degraded
retry with exponential backoff for safe pre-payment actions
use idempotency key for all payment/request creation
reconcile local pending state with server result
never show payment success until backend confirms payment state
never create duplicate charges on retry
```

### Optimistic UI Boundary

Allowed optimistic UI:

```text
visual pending card
spinner/progress state
local pending badge
retrying indicator
```

Forbidden optimistic UI:

```text
payment succeeded
request approved
boost applied to live ladder
funds captured
performer paid
```

Those require server confirmation.

### Required Local Pending Record

Client pending action minimum fields:

```text
client_request_id
idempotency_key
gig_id
action_type
payload_hash
created_at
last_attempt_at
attempt_count
status
last_error
```

### Required Tests

```text
scripts/sway-offline-client-resilience.contract.test.mjs
scripts/sway-idempotent-submit.contract.test.mjs
```

The tests must prove:

```text
client generates idempotency key
pending action is persisted before network submission
retry logic exists for recoverable failures
payment success copy requires backend-confirmed state
duplicate submit path is guarded
```

## 4. WebSocket Is Enhancement, Not Source Of Truth

### Rule

WebSocket/live updates may improve the experience, but must not be required for transaction correctness.

Source of truth:

```text
server database
payment processor events/webhooks
request lifecycle audit log
```

WebSocket may broadcast:

```text
ladder changes
request status changes
gig state changes
performer activity heartbeat
```

If WebSocket fails:

```text
client falls back to polling
critical actions still use HTTP endpoints with idempotency keys
UI shows degraded live state when needed
```

## 5. Performer Activity Heartbeat

### Required Behavior

Performer dashboard must emit activity heartbeats while open.

Minimum heartbeat fields:

```text
gig_id
performer_id
client_session_id
sent_at
last_visible_at
network_status
```

The backend updates:

```text
gig_sessions.last_activity_at
```

Heartbeat is not used to decide payment truth. It only informs session freshness and closeout automation.

## 6. Sprint Placement

These changes must be inserted into the build sequence:

### Slice 1 Additions

```text
client-side pending action contract
idempotency key contract
WebSocket fallback/polling doctrine
network degraded UI states
```

### Slice 2 Additions

```text
gig_sessions auto_closeout_at
last_activity_at
server-side hard closeout worker contract
performer onboarding/KYC status fields
central $100 verification threshold config
```

### Slice 3 Additions

```text
processor-backed idempotency
payment state reconciliation
refund/void on auto-closeout
payout lock until verified
```

## 7. Revised KPI Stack

Add operational resilience KPIs:

```text
pending_action_recovered_count
idempotent_duplicate_prevented_count
auto_closeout_executed_count
unresolved_payment_after_closeout_count
kyc_wall_viewed_count
kyc_completed_after_balance_view_count
offline_retry_success_count
payment_state_reconciled_count
```

## 8. Definition Of Done Additions

A slice touching live gig, request, boost, tip, payment, or payout behavior is not complete unless:

```text
idempotency is addressed
offline/degraded behavior is defined
auto-closeout impact is handled
KYC/payout state is explicit where relevant
server database remains source of truth
UI does not overclaim payment success
```

## 9. Anti-Patterns Added

Explicitly prohibited:

```text
manual-only closeout
payment success before backend confirmation
WebSocket-only transaction state
retry without idempotency
payout promise before KYC completion
stored-value wallet behavior without legal/payment processor support
losing pending client actions on refresh
leaving authorized payments unresolved after stale gig expiration
```
