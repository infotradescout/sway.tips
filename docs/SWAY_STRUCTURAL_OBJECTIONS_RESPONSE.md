# Sway Structural Objections Response

This document records the architectural objections raised against the current Sway build order and locks the corrected execution path.

## Decision

The objections are accepted.

The original sequence created a real risk of throwaway middleware, weak role isolation, and client-only security assumptions. The corrected build order moves the database schema and transaction-state model ahead of route middleware so production guards can query real persisted state from day one.

## Accepted Objection 1: Schema Before Middleware

### Problem

Role isolation cannot be safely implemented before persistent users, performers, gigs, sessions, and access relationships exist.

Middleware that checks role access needs to answer real questions:

```text
Who is this authenticated actor?
Which performer profile do they control?
Does the requested gig exist?
Is the gig active, closed, or expired?
Does the actor have access to this gig?
Is this request public, performer-only, admin-only, or overlay-only?
```

Without a database schema, middleware will be forced into mock checks or route-only assumptions.

### Correction

Move schema initialization before role middleware.

Corrected sequence:

```text
1. Guardrail contract tests
2. Normalize repo identity
3. Database schema init
4. Route split and server-side decoupling
5. Server-side middleware guards
```

## Accepted Objection 2: Client Routing Is Not Security

### Problem

A React SPA route split does not equal role isolation.

If one production bundle contains patron, performer, overlay, and admin controls, users may still inspect or load client code that should not be available in their flow. Client checks are useful for UX, but they are not security boundaries.

### Correction

Server-side route decoupling is required.

Production route classes:

```text
public patron route: /g/:gigId
performer route: /talent/*
overlay route: /overlay/:gigId
admin route: /admin/*
dev sandbox route: /dev/sandbox only when dev mode is explicitly enabled
```

The server must be the authority for which shell/bundle is served.

### Vite Bundling Direction

Configure separate production entry points instead of one universal production shell:

```text
src/entries/patron.tsx
src/entries/talent.tsx
src/entries/overlay.tsx
src/entries/admin.tsx
src/entries/dev-sandbox.tsx
```

Production builds must not serve `dev-sandbox` unless an explicit development guard is active.

## Accepted Objection 3: WebSocket Is Enhancement Only

### Problem

The current prototype is visually real-time but does not yet define fallback state for bad cellular, WebSocket failure, or polling recovery.

### Correction

Patron and performer clients require a degraded-connection state machine.

Required client states:

```text
live
reconnecting
degraded_polling
offline_pending
reconciled
failed_recoverable
failed_terminal
```

Fallback policy:

```text
on heartbeat miss: enter reconnecting
on repeated heartbeat miss: enter degraded_polling
poll interval: min(2^attempt * 1000ms, 30000ms)
critical actions remain HTTP + idempotency based
payment success requires backend confirmation
```

WebSocket messages may update live UI, but the database and payment processor events remain source of truth.

## Accepted Objection 4: No Real Cash Against In-Memory State

### Problem

The current prototype stores session/request state in Express process memory. This cannot support TestFlight, payment authorization, request fulfillment, payout ledgers, or dispute handling.

### Correction

Before any real payment flow, Sway must use durable persistence.

Required minimum persisted models:

```text
users
performers
performer_memberships
gig_sessions
gig_access_grants
requests
request_boosts
payments
payment_events
payouts
moderation_events
audit_events
idempotency_keys
client_pending_actions
```

No Stripe authorization, capture, refund, or payout may depend on process-local arrays.

## Accepted Objection 5: Idempotency Scope Must Include Intent Fingerprint

### Problem

A bare `client_request_id` is not enough. It prevents some retries, but it does not fully distinguish duplicate retries from distinct user intent.

### Correction

Sway will store an idempotency record with both a client key and a server-computed intent fingerprint.

Required record fields:

```text
idempotency_key
patron_device_id_hash
actor_id
session_id
gig_id
action_type
amount_cents
currency
target_entity_type
target_entity_id
payload_hash
intent_fingerprint
first_response_status
first_response_body_hash
expires_at
created_at
updated_at
```

Intent fingerprint:

```text
SHA256(idempotency_key + patron_device_id_hash + gig_id + action_type + target_entity_id + amount_cents + currency + payload_hash)
```

Rules:

```text
same idempotency key + same fingerprint = return original result
same idempotency key + different fingerprint = reject as idempotency misuse
new idempotency key + different fingerprint = allow as distinct intent
```

Sensitive personal data must not be placed directly inside idempotency keys or fingerprints. Use hashed stable identifiers where required.

## Architectural Answers

### DB Choice

Use PostgreSQL as the transaction and audit source of truth.

Use a migration-capable ORM/query layer. Preferred direction for this repo:

```text
PostgreSQL + Drizzle ORM + explicit SQL-friendly schema files
```

Reason:

```text
Sway needs auditable relational state, explicit lifecycle enums, transaction-safe transitions, and direct control over indexes/constraints.
```

### Asset Bundling

Yes. Configure separate Vite entry points for patron, talent, overlay, admin, and dev sandbox.

Goal:

```text
public patron route does not receive performer/admin/dev controls as its primary production shell
```

This is not the only security layer. Server-side authorization still decides access.

### Idempotency TTL

Internal Sway idempotency records should be retained for at least:

```text
minimum: 24 hours
recommended initial production TTL: 48 hours
payment/audit records: retained according to payment, accounting, and dispute policy
```

Stripe documents that idempotency keys can be pruned after they are at least 24 hours old and that reused keys after pruning generate a new request. Sway keeps 48 hours initially to cover weak venue networks, next-day support events, and patron retry confusion.

## Corrected Build Order

### Slice 0 — Guardrails And Repo Identity

Deliver:

```text
contract tests created
package renamed
README normalized
AI Studio default handoff removed
docs index added
```

### Slice 1 — Database Schema Init

Deliver:

```text
PostgreSQL config
migration setup
core schema files
lifecycle enums
idempotency_keys table
client_pending_actions table
audit_events table
```

Exit gate:

```text
schema compiles
migration runs locally
contract tests detect required tables/fields/enums
```

### Slice 2 — Server-Side Route Decoupling

Deliver:

```text
separate server route shells
separate Vite entry points
patron/talent/overlay/admin/dev-sandbox shells
production dev-sandbox disabled by default
```

Exit gate:

```text
/g/:gigId serves patron shell
/talent/* serves talent shell only after server-side auth gate
/overlay/:gigId serves overlay shell
/admin/* does not share public shell
```

### Slice 3 — Middleware Guards Query Real State

Deliver:

```text
auth actor resolution
performer membership lookup
gig ownership/access lookup
gig active/closed checks
admin guard
public gig guard
```

Exit gate:

```text
middleware queries persisted schema
no mock role checks
no client-only role assumptions
```

### Slice 4 — Degraded Network And Idempotent Actions

Deliver:

```text
client pending action queue
idempotency key creation
server intent fingerprint validation
HTTP polling fallback
connection state machine
safe retry rules
```

Exit gate:

```text
retry does not duplicate charge/request
payment success requires backend confirmation
offline pending survives refresh
WebSocket failure falls back to polling
```

## New Contract Tests Required

```text
scripts/sway-schema-before-middleware.contract.test.mjs
scripts/sway-server-route-decoupling.contract.test.mjs
scripts/sway-separate-vite-entrypoints.contract.test.mjs
scripts/sway-idempotency-fingerprint.contract.test.mjs
scripts/sway-degraded-connection-state.contract.test.mjs
```

## Non-Negotiable Rule Added

No production role middleware may be accepted until it queries real persisted schema.

No production payment route may be accepted until idempotency records and audit events are durable.

No production patron route may depend on client-only role isolation.
