# Sway AI Sprint Issue Register

This document lists the AI-build risks that must be checked during every sprint for `sway.tips`.

The goal is to prevent AI-assisted development from producing code that looks complete but fails under production, payment, App Store, or live-event conditions.

## Decision

AI can accelerate Sway development, but AI output is not trusted by default.

Every AI-generated or AI-assisted slice must be treated as a draft until it passes product, architecture, data, payment, safety, and App Store checks.

## AI Sprint Failure Classes

### 1. Prototype leakage

Risk:

AI often leaves sandbox behavior inside production paths.

Examples:

```text
sandbox role switcher remains visible
hardcoded performer names remain in app state
fake totals appear in public UI
simulated payment success is presented as real
sample QR codes look live
mock performer directory is treated as discoverable inventory
```

Required guard:

```text
No demo fixture may be imported by production routes.
No production UI may present fake money, fake users, fake gigs, or fake requests.
A contract test must search production paths for known demo markers.
```

### 2. Non-deterministic money behavior

Risk:

AI may describe payment behavior in confident UI copy without implementing the processor lifecycle.

Examples:

```text
copy says authorized holds exist but payment intent is never created
copy says refunds happen but refund endpoint/webhook does not exist
platform fee is calculated in UI only
boosts modify request totals without payment records
fulfilled status changes without capture event
```

Required guard:

```text
Every money state must be persisted.
Every payment claim in UI must map to backend behavior.
Every payment status transition must have an audit event.
No checkout success may be simulated in production.
```

### 3. Role confusion

Risk:

AI may mix patron, performer, venue, admin, and reviewer capabilities into the same surface.

Examples:

```text
patron can access talent controls
talent can see admin controls
admin controls appear in public mobile flow
role switcher ships outside dev mode
performer impersonation is possible without explicit dev guard
```

Required guard:

```text
Production routes must be role-scoped.
Dev/sandbox controls must be behind an explicit dev-only guard.
Route access must be contract-tested.
```

### 4. Prompt drift and AI authority creep

Risk:

AI features can slowly move from assistive to authoritative without design approval.

Allowed AI uses:

```text
vibe-based song suggestions
copy drafting
moderation classification
search assistance
category suggestions
```

Forbidden AI authority:

```text
payment truth
payout truth
request status truth
identity verification truth
venue ownership truth
legal consent truth
refund eligibility truth
App Store compliance truth
```

Required guard:

```text
AI output must be labeled as suggestion/classification when applicable.
AI output cannot directly mutate money, identity, or legal state without deterministic backend validation.
```

### 5. Moderation false confidence

Risk:

AI may create a moderation function that appears safe but fails open when the model/API is unavailable.

Examples:

```text
Gemini outage allows all messages
local filter list is too weak
shadow ban hides from performer but still affects payment/request state unclearly
no report button
no block path
no moderation audit events
```

Required guard:

```text
Moderation outage behavior must be explicit.
Unsafe or uncertain content must have a deterministic path.
Users must have reporting/blocking controls.
Moderation decisions must be persisted.
```

### 6. App Store blocker blindness

Risk:

AI may optimize web UX while ignoring iOS review requirements.

Examples:

```text
missing privacy policy
missing support URL
missing terms
no data deletion path
incomplete review notes
unclear payment/refund policy
user-generated content without reporting/blocking
AI data sharing not disclosed
broken links in metadata
```

Required guard:

```text
Every sprint must identify App Store impact.
Any user-generated content feature must include reporting, blocking, and contact paths.
Any AI feature must include data handling disclosure requirements.
```

### 7. Missing persistence after visual completion

Risk:

AI often builds UI that appears functional while state is temporary.

Examples:

```text
session exists only in React state
request queue exists only in Express memory
ledger recalculates from current array instead of durable transactions
request window timers are process-local only
featured performer expiration is process-local only
```

Required guard:

```text
Any business-critical state must survive reload, server restart, and deploy.
All revenue lifecycle records must be durable.
Timers must be persisted or reconstructable.
```

### 8. Weak error and edge-state handling

Risk:

Live-event apps fail in bad network, crowded venue, payment delay, and rushed user conditions.

Examples:

```text
double submit creates duplicate charges
refresh loses checkout state
network failure shows success with no backend event
performer approves already-denied request
request window closes during checkout with unclear outcome
boost targets deleted/fulfilled request
```

Required guard:

```text
Use idempotency keys for payment/request creation.
Use server-side status validation before every lifecycle transition.
Return clear error states for patron and performer.
Add contract tests for duplicate submit and stale transition attempts.
```

### 9. Overbuilt marketplace before first transaction loop

Risk:

AI may add discovery, featured performers, venues, and marketplace surfaces before one performer loop works.

Examples:

```text
Discover Stage grows before live gig flow works
featured performer monetization ships before payouts work
venue directory ships before performer profiles are verified
social feed appears before request/payment loop is stable
```

Required guard:

```text
No marketplace expansion until one live gig transaction loop is complete.
Primary KPI remains QR scan → checkout → request → performer action → ledger.
```

### 10. Generated copy that creates legal/payment liability

Risk:

AI may write persuasive copy that promises more than the system, processor, or terms support.

Danger phrases unless implemented:

```text
authorized cards only capture once fulfilled
automatic refund
secure escrow
guaranteed payout
instant payout
verified performer
nearby live performers
real Spotify search
Apple Wallet pass
```

Required guard:

```text
Copy must be tied to implemented behavior.
Payment, refund, payout, verification, and location claims require backend support and legal/terms alignment.
```

### 11. Dependency and model version drift

Risk:

AI may use unstable, outdated, or incorrect SDK/model names without verification.

Examples:

```text
wrong Gemini model string
unsupported package API
framework major version mismatch
Capacitor/plugin mismatch
React/Vite config generated without validation
```

Required guard:

```text
All new SDK/API usage must be checked against official docs before implementation.
npm run lint and npm run build must pass.
External model names must be defined in environment config, not scattered through code.
```

### 12. No reviewable sprint artifact

Risk:

AI may make scattered changes without leaving a clear handoff.

Required guard:

Every AI sprint must produce a review artifact with:

```text
files inspected
files changed
business rule touched
routes touched
new env vars
new data model changes
new payment behavior
new App Store impact
validation commands
known risks
rollback path
```

## AI Sprint Gate Checklist

Before any AI-built slice is accepted, answer all items:

```text
1. Does this touch money, identity, moderation, App Store, roles, or persistence?
2. If yes, is there a contract test?
3. Does any UI copy claim behavior not implemented in backend?
4. Does any production path import demo data?
5. Can the action survive reload/server restart/deploy?
6. Are route permissions explicit?
7. Are AI outputs suggestions instead of source-of-truth decisions?
8. Is moderation fail-open/fail-closed behavior documented?
9. Are payment transitions auditable?
10. Are App Store review requirements affected?
11. Are external SDK/model names verified and centralized?
12. Is there a rollback path?
```

## Required Contract Tests

Minimum test files to add as implementation begins:

```text
scripts/sway-no-demo-data-production.contract.test.mjs
scripts/sway-role-route-separation.contract.test.mjs
scripts/sway-payment-copy-truth.contract.test.mjs
scripts/sway-request-lifecycle.contract.test.mjs
scripts/sway-moderation-fallback.contract.test.mjs
scripts/sway-appstore-readiness.contract.test.mjs
scripts/sway-ai-authority-boundary.contract.test.mjs
scripts/sway-idempotent-submit.contract.test.mjs
```

## Sprint Review Template

Use this template for every AI sprint handoff:

```text
Decision:

Business goal:

Files inspected:

Files changed:

Routes touched:

Money behavior touched:

Persistence behavior touched:

Role/access behavior touched:

AI behavior touched:

Moderation behavior touched:

App Store impact:

Validation:

Known risks:

Rollback path:

Next required slice:
```

## Current Repo AI-Sprint Issues Already Known

These issues exist in the current prototype and must be handled before production/App Store:

```text
AI Studio README still presents generic app handoff
package name is react-example
server state is in memory
checkout is simulated
role switcher is sandbox-first
hardcoded DJ Shadow/demo requests/demo totals exist
performer directory is hardcoded
Gemini moderation can fail open
model name is embedded in code
payment copy implies behavior not yet implemented
no auth
no persistent DB
no payment provider webhooks
no privacy/terms/support/data deletion paths
no App Store review package
no contract tests
```

## Operating Rule

For Sway, an AI sprint is not done when the screen works.

It is done when the screen works, the state is durable, the role boundary is correct, the money behavior is auditable, the copy is truthful, and App Store review would not be surprised by it.
