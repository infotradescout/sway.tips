# Sway AI Council Protocol

This document defines how AI-assisted development is governed for `sway.tips`.

The goal is to prevent prototype drift, false confidence, architectural shortcuts, and AI-generated work that looks complete but fails production, payment, compliance, or App Store review.

## Decision

Sway uses a three-role AI council:

```text
Codex = implementer
Gemini/Objector = adversarial technical reviewer
Merlin/Orchestrator = final arbiter, planner, and repo governor
```

No AI-generated sprint is accepted because it compiles, looks good, or produces a confident handoff.

A sprint is accepted only when the council loop closes:

```text
Codex implements
→ Objector challenges
→ Orchestrator adjudicates
→ accepted objections become docs/tests/code requirements
→ Codex patches
→ gates prove the result
```

## Role 1 — Codex / Implementer

Codex is responsible for producing code, migrations, tests, and direct implementation work.

Codex must provide every handoff in this format:

```text
Decision:
Business goal:
Files inspected:
Files changed:
Routes touched:
Schema touched:
Money behavior touched:
Persistence behavior touched:
Role/access behavior touched:
AI behavior touched:
Moderation behavior touched:
App Store impact:
Validation commands:
Known risks:
Rollback path:
Next required slice:
Commit SHA:
Working tree status:
```

Codex is not allowed to declare production readiness without passing the required gates.

## Role 2 — Gemini / Objector

The Objector is responsible for finding structural weakness, hidden coupling, compliance exposure, edge-case failure, and misleading completion claims.

Objector review must challenge at least these areas:

```text
payment correctness
idempotency
schema and persistence
role isolation
client/server trust boundaries
bad-network behavior
manual-process dependency
App Store review risk
KYC and payout friction
moderation/reporting/blocking
AI authority creep
copy claims versus implemented behavior
```

Objector findings must be classified:

```text
critical_blocker
major_refactor_risk
compliance_risk
security_risk
operational_risk
copy_truth_risk
future_cleanup
rejected_objection
```

## Role 3 — Merlin / Orchestrator

The Orchestrator decides what becomes repo law.

The Orchestrator must:

```text
verify repo state instead of trusting handoffs
separate implementation facts from claimed facts
accept valid objections even when inconvenient
reject weak objections with reason
convert accepted objections into docs, tests, or code requirements
keep the build order aligned with architecture
protect the ABC123 App Store roadmap
prevent brand/scope drift
```

The Orchestrator has final say on whether a slice is accepted, rejected, or sent back.

## Council Loop

Every production slice must follow this loop:

```text
1. Slice objective is defined.
2. Codex implements on a branch or commit.
3. Codex provides handoff.
4. Orchestrator verifies repo state.
5. Objector reviews the approach and implementation.
6. Orchestrator classifies objections.
7. Accepted objections become contract tests, docs, or code fixes.
8. Codex patches.
9. Required gates run.
10. Orchestrator accepts or rejects the slice.
```

## Evidence Rules

Claims are not enough.

Accepted evidence includes:

```text
commit SHA
file diff
specific changed files
contract test output
lint/build output
schema/migration files
route map
payment state transition table
App Store readiness checklist
```

Rejected evidence includes:

```text
"done" without commit verification
local-only claims not visible on remote
screenshots without code state
mock tests presented as implementation tests
soft-exit contract tests presented as gates
```

## Contract Test Rules

A test is a gate only if it fails the process when the contract is broken.

```text
test:contracts must exit nonzero on failure
audit:contracts may soft-exit and print diagnostics
```

Mock-only tests are allowed only as early design diagnostics. They cannot be used to prove production implementation.

## Objector-to-Test Conversion

When the Objector finds a valid issue, the Orchestrator must map it to one of these outcomes:

```text
new contract test
existing contract test update
schema requirement
route requirement
copy restriction
App Store checklist item
payment lifecycle rule
rejected with reason
```

Examples:

```text
Manual-only closeout objection
→ auto_closeout_at schema field
→ hard closeout worker requirement
→ sway-auto-closeout.contract.test.mjs

Client-only routing objection
→ separate server route shells
→ separate Vite entrypoints
→ sway-server-route-decoupling.contract.test.mjs

Idempotency concatenation objection
→ canonical serialization rule
→ sway-idempotency-fingerprint.contract.test.mjs
```

## ABC123 Roadmap Protection

Council work must stay aligned to the ABC123 path:

```text
A = app foundation and route/product identity
B = backend, persistence, money loop, ledger
C = safety, compliance, App Store readiness
1 = repo cleanup and guardrails
2 = production MVP
3 = App Store/TestFlight package
```

No marketplace expansion, design polish, discovery growth, or AI novelty work can jump ahead of:

```text
persistent gig/session model
server-side route decoupling
payment lifecycle auditability
idempotency
moderation/reporting
App Store compliance basics
```

## Acceptance Rule

A slice is accepted only when all are true:

```text
repo state verifies the claim
contract tests are present and meaningful
failing contracts fail the gate
implementation matches the accepted architecture
Objector critical blockers are resolved or explicitly rejected with reason
README/docs reflect the current build order
money/role/persistence behavior is not simulated in production path
```

## Current Council Finding

The council loop is now closed for the first planning phase.

Validated conclusions:

- Sway is the active commissioned product.
- The first value loop is live-gig monetization through QR-driven paid tips/requests/boosts.
- The current repo is still a prototype.
- The ABC123 roadmap is correct only after the schema-first correction and the split between repo truth normalization and hard contract gates.
- The first implementation priority is not UI polish.
- The accepted build order is:

```text
0A. Repo truth normalization
0B. Hard contract gates
1. Database schema init
2. Server route decoupling and separate entrypoints
3. Middleware guards backed by persisted schema
4. Degraded network and idempotent action handling
5. Payment lifecycle and processor webhooks
6. Moderation/reporting/blocking
7. App Store/TestFlight package
```

## Immediate Next Council Assignment

Codex should not start payment or marketplace work.

Next Codex assignment:

```text
Slice 0B — Hard Contract Gates

1. Verify every script in test:contracts exits nonzero on failure.
2. Verify audit:contracts is the only soft diagnostic path.
3. Flag mock-only contract tests as diagnostics instead of implementation proof.
4. Map every current contract to a repo file, doc rule, or explicit Slice 0A stub.
5. Align docs on the accepted build order.
6. Keep route decoupling marked pending while entrypoints are Slice 0A stubs.
7. Ensure wild-card risks are represented in hard tests.
8. Ensure npm run test:contracts, audit:contracts, lint, and build pass.

Do not implement middleware before schema.
Do not implement payment before durable idempotency and audit tables.
Do not use client routing as a security boundary.
```
