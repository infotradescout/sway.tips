# Sway Day-1 Build Contract

This document is the operating contract for building `sway.tips` correctly from the first production slice.

The purpose is to prevent prototype drift, undocumented behavior, fake-data leakage, role confusion, fragile payment handling, and App Store blockers.

## Product Decision

Sway is a live-gig monetization product for performers, DJs, bartenders, street performers, and event acts.

The first production product loop is:

```text
Performer starts a gig
→ Sway generates a live QR/link
→ Patron submits a paid tip, request, or boost
→ Performer approves, denies, or fulfills
→ Payment lifecycle and platform fee are recorded
→ Performer sees a reliable ledger
```

The first App Store version is not a full marketplace, not a social network, and not a generic AI music app.

## Non-Negotiable Build Rules

### 1. No demo data in production paths

Demo data may exist only in explicit dev/demo fixtures.

Production routes must not ship with hardcoded performers, fake totals, fake requests, fake payments, fake venues, fake review data, or fake discovery inventory.

Allowed:

```text
src/dev/*
server/dev/*
fixtures/*
seed/dev-only/*
```

Not allowed in production runtime:

```text
DJ Shadow
fake tips
fake platform revenue
fake performers
sample QR codes presented as live
simulated payment success presented as real
```

### 2. No in-memory business state

In-memory state is acceptable only for local dev mocks.

Production state must persist for:

```text
users
performers
gig_sessions
requests
request_boosts
payments
payouts
moderation_events
audit_events
```

Every revenue-related action must survive server restart and redeploy.

### 3. Role surfaces must be separated

The production app must not use a sandbox role switcher as the primary UX.

Required role separation:

```text
/talent/login
/talent/gigs
/talent/gigs/:gigId
/g/:gigId
/p/:performerHandle
/overlay/:gigId
/admin
```

Patrons should not see performer controls.
Performers should not impersonate patrons through the production UI.
Admin controls must not be mixed into public or performer flows.

### 4. Money flow must be explicit and auditable

No request, boost, tip, payout, platform fee, refund, void, or capture may be represented only in UI state.

Required payment lifecycle fields:

```text
payment_status
processor
processor_payment_intent_id
processor_charge_id
amount_subtotal
platform_fee
amount_total
currency
capture_mode
refund_status
payout_status
created_at
updated_at
```

Allowed lifecycle statuses:

```text
created
payment_pending
authorized
captured
voided
refunded
failed
disputed
paid_out
```

UI copy must match actual payment behavior. Do not claim authorized holds, delayed capture, automatic refunds, or payouts unless the processor flow implements it.

### 5. Request lifecycle must be deterministic

Requests and boosts must move through a finite lifecycle.

Allowed request statuses:

```text
submitted
payment_pending
payment_authorized
held_for_review
approved
denied
voided_or_refunded
fulfilled
captured
paid_out
disputed
```

Every status change must create an audit event.

Audit event minimum fields:

```text
event_id
actor_type
actor_id
entity_type
entity_id
event_type
previous_status
next_status
metadata
created_at
```

### 6. Moderation must fail safe

The app can use AI moderation, local moderation, or processor/third-party moderation, but production cannot silently allow everything when the AI service is unavailable.

Required controls:

```text
local blocked-term baseline
AI moderation when configured
manual hide/remove
patron report button
performer block/report controls
moderation_events persistence
support/contact path
```

AI outage behavior must be explicit:

```text
allow_with_local_filter
hold_for_review
block_submission
```

The selected behavior must be documented in the environment contract.

### 7. App Store readiness is a build requirement, not a final cleanup task

Every feature must be evaluated for App Store impact before implementation.

Required before submission:

```text
Privacy Policy URL
Terms URL
Support URL
Data deletion path
TestFlight build
review demo account
review notes
working backend
accurate screenshots
accurate privacy labels
no placeholder metadata
no broken links
```

### 8. Mobile-first means real mobile-first

Sway is QR-driven. Most users will hit the app on phones in noisy, crowded environments.

Required UI constraints:

```text
one-handed primary actions
large tap targets
no hidden checkout math
clear request/tip minimum
clear performer identity
clear gig/session state
fast retry on bad network
no tiny dense admin-style controls on patron flow
```

### 9. No AI-generated facts as product truth

AI can assist with search, vibe suggestions, moderation classification, copy drafts, or categorization.

AI cannot be the source of truth for:

```text
payments
payouts
request status
performer identity
venue authority
legal terms
user consent
transaction history
```

### 10. Tests are mandatory for business rules

Every production slice touching money, roles, lifecycle, moderation, or App Store-sensitive behavior must include a contract test.

Required test categories:

```text
role separation
public route access
request lifecycle transitions
payment lifecycle mapping
ledger persistence
moderation fallback
no demo data in production routes
App Store metadata readiness
mobile critical-path rendering
```

A slice is not complete unless:

```text
npm run lint passes
npm run build passes
contract tests pass
changed routes are documented
no unrelated brand assets are introduced
```

## Build Sequence

### Slice 0 — Repository normalization

Deliver:

```text
rename package from react-example to sway-tips
replace AI Studio README with Sway README
add docs index
add environment contract
add launch gate
add contract test folder
```

Exit gate:

```text
repo has real product identity
build scripts work
no generic AI Studio handoff remains as primary documentation
```

### Slice 1 — Route separation

Deliver:

```text
remove sandbox switcher from production path
create explicit patron route
create explicit talent route
create overlay route
preserve dev sandbox only under dev-only guard
```

Exit gate:

```text
patron cannot see talent controls
talent cannot use public patron role switcher
production route map is documented
```

### Slice 2 — Persistent gig model

Deliver:

```text
database schema
gig session creation
performer profile model
public gig route by id
request creation tied to gig id
```

Exit gate:

```text
request survives reload and server restart
session survives reload and server restart
```

### Slice 3 — Real payment lifecycle

Deliver:

```text
payment provider integration
payment intent creation
request/boost payment mapping
refund/void/capture handling
platform fee ledger
webhook handling
```

Exit gate:

```text
one test payment creates a durable payment record
one denied request creates the correct void/refund state
one fulfilled request creates the correct capture/ledger state
```

### Slice 4 — Moderation and reporting

Deliver:

```text
local moderation baseline
AI moderation config
report button
hide/remove controls
block path
moderation event ledger
```

Exit gate:

```text
unsafe content is not publicly shown without a reviewable decision path
AI outage behavior is deterministic
```

### Slice 5 — App wrapper and TestFlight

Deliver:

```text
Capacitor iOS wrapper
app icon
launch screen
bundle id
TestFlight build
review demo account
privacy/terms/support links
```

Exit gate:

```text
TestFlight install works
critical QR-to-payment path works on device
review package is complete
```

## KPI Stack

Primary KPI chain:

```text
QR scans
→ patron session starts
→ request/tip form opened
→ checkout started
→ payment authorized/captured
→ performer action taken
→ request fulfilled or refunded
→ performer ledger viewed
```

Do not optimize cosmetic surfaces until this chain is instrumented and reliable.

## Definition of Done

A Sway slice is complete only when all are true:

```text
feature is production-routed or explicitly dev-gated
state persists if business-critical
money behavior is auditable
role access is correct
mobile path works
contract tests exist
README/docs updated
no fake data leaks into production UX
npm run lint passes
npm run build passes
```

## Anti-Pattern List

These are explicitly prohibited:

```text
building UI polish before persistence
shipping sandbox role switching as product UX
storing revenue events only in frontend state
using AI output as transaction truth
claiming payment behavior that is not implemented
adding marketplace/discovery before one live gig loop works
mixing admin controls into public screens
leaving generic generated-app docs as the repo handoff
adding sample data without dev-only guardrails
```

## Current Repo Risk Snapshot

The current repo begins as a useful prototype, but not a launchable product. The immediate risks are:

```text
in-memory backend state
simulated checkout
hardcoded demo performers and requests
sandbox role switcher
no real auth
no database
no real payment processor integration
no durable ledger
no App Store review package
```

The correction is to build the product spine before expanding scope.

## Addendum: Auto-Closeout

Manual-only closeout is prohibited. Gig sessions must support server-side stale-gig expiration with:

- `auto_closeout_at`
- `last_activity_at`
- `auto_closeout_reason`
- `closeout_policy`
- hard closeout worker
- void/refund unresolved holds
- audit events for every transition

Default policy:

`auto_closeout_at = max(started_at + 4 hours, scheduled_end_at + 30 minutes when scheduled_end_at exists)`

## Addendum: Deferred KYC

Deferred KYC is a product rule, not a fake wallet or payout promise.

Initial threshold:

`verification_required_at_amount = 10000` cents lifetime gross volume

Rules:

- Performer can reach `gig_ready` before payout verification.
- Payout route is blocked until `payouts_enabled` is true.
- UI copy cannot promise unverified payouts.
- Stripe Connect verification requirements vary by country, capability, business type, risk, and other factors.
- Incremental onboarding may collect more information as the account earns more revenue.

## Addendum: Offline Client Resilience

Basement club and bad-network flows must preserve patron intent without creating duplicate money events.

Requirements:

- `client_request_id`
- `idempotency_key`
- local pending action record
- offline/degraded indicator
- exponential retry
- server reconciliation
- no duplicate charges
- no payment success before backend confirmation

WebSocket is enhancement only. The source of truth must remain:

- database state
- payment processor events/webhooks
- request lifecycle audit log

## Additional Prohibited Patterns

- manual-only closeout
- payment success before backend confirmation
- WebSocket-only transaction state
- retry without idempotency
- payout promise before KYC completion
- stored-value wallet behavior without legal/payment processor support
- losing pending client actions on refresh
- leaving authorized payments unresolved after stale gig expiration

## Addendum: Structural Objections

- Corrected build order is guardrail contract tests, normalize repo identity, database schema init, route split and server-side decoupling, then server-side middleware guards.
- Use PostgreSQL + Drizzle ORM + explicit SQL-friendly schema files.
- Server must select separate shells and bundles for patron, talent, overlay, admin, and dev-sandbox entry points.
- React routing is not a security boundary.
- Idempotency records must live for 48 hours initially, with 24 hours as the minimum acceptable TTL.
- Idempotency fingerprint must be `SHA256(idempotency_key + patron_device_id_hash + gig_id + action_type + target_entity_id + amount_cents + currency + payload_hash)`.
- Same idempotency key and same fingerprint returns the original result.
- Same idempotency key and different fingerprint is rejected as misuse.
- New idempotency key and different fingerprint is a distinct intent.
- No production role middleware may be accepted until it queries real persisted schema.
- No production payment route may be accepted until idempotency records and audit events are durable.
- No production patron route may depend on client-only role isolation.
