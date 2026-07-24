# AI Council Agent Rules

This repository uses the AI Council operating model.

These rules are mandatory for Codex, Gemini/Objector, and Merlin/Orchestrator work in this repo.

`docs/VIBE_ENGINEERING_DOCTRINE.md` is mandatory operating law. Productivity is measured by verified outcomes delivered without increasing uncontrolled risk, not by code volume. Humans own intent, constraints, risk tolerance, architecture boundaries, and final authority. Agents own exploration, implementation, repetition, testing assistance, analysis, documentation, and continuous challenge. Systems own policy enforcement, validation gates, audit trails, observability, deployment controls, and rollback triggers.

No task is complete because an agent says it is complete. No deployment is successful merely because it deployed. Independent evidence must support the requested outcome.

## Release control (P0 — read before merging to main)

- Every merge to `main` must **not** equal production deploy. See `RELEASE_CONTROL.md`.
- Render Auto-Deploy for `sway-tips-web` must be **Off**; approved deploys are manual/hook after CI `validate` is green.
- Do not merge feature work during release-control incidents; only approved remediation/release.
- Do not use Render `checksPass` while `Production Deploy Drift Guard` exists (deadlock with production catch-up).
- GitHub Actions may fail in seconds with a billing lock; that is not a green CI gate.

## Council Roles

```text
Codex = implementer
Gemini/Objector = adversarial reviewer
Merlin/Orchestrator = final arbiter, repo governor, and build-order owner
```

No AI role may declare work complete without evidence.

## Codex Rules

Codex must implement only the assigned slice.

Codex must not:

```text
invent data
ship demo data in production paths
change product scope without approval
build UI polish before persistence
write payment behavior without durable idempotency and audit records
write middleware before schema exists
use client routing as a security boundary
claim App Store readiness without review package evidence
soft-pass failing contract tests
```

Codex must always provide this handoff:

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

## Required Codex Gates

Unless explicitly scoped as docs-only, Codex must run:

```text
npm run lint
npm run build
npm run test:contracts
```

If `test:contracts` does not exist yet, Codex must state that clearly and may not claim contract-gate completion.

`test:contracts` must exit nonzero on failure.

`audit:contracts` may soft-exit and print diagnostics.

## Gemini/Objector Rules

Gemini/Objector must challenge implementation and roadmap assumptions.

Required review areas:

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

Objector must propose a test, schema rule, route rule, or copy restriction for every accepted objection.

## Merlin/Orchestrator Rules

Merlin must verify repo state instead of trusting handoffs.

Merlin must:

```text
separate claimed facts from repo facts
accept valid objections even when inconvenient
reject weak objections with reason
convert accepted objections into docs, tests, or code requirements
protect the corrected schema-first build order
protect the ABC123 App Store roadmap
prevent brand/scope drift
```

## Corrected Sway Build Order

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

## Non-Negotiables

```text
No middleware before schema.
No payment before durable idempotency and audit tables.
No client routing as a security boundary.
No manual-only closeout.
No WebSocket-only transaction state.
No payment success before backend confirmation.
No stale offline queued charge after action TTL expires.
No Capacitor wrapper that is only a website shell.
No payout promise before KYC completion.
```
