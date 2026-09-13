# AI Council Agent Rules

This repository uses the AI Council operating model.

These rules are mandatory for Codex, Gemini/Objector, and Merlin/Orchestrator work in this repo.

`docs/VIBE_ENGINEERING_DOCTRINE.md` is mandatory operating law. Productivity is measured by verified outcomes delivered without increasing uncontrolled risk, not by code volume. Humans own intent, constraints, risk tolerance, architecture boundaries, and final authority. Agents own exploration, implementation, repetition, testing assistance, analysis, documentation, and continuous challenge. Systems own policy enforcement, validation gates, audit trails, observability, deployment controls, and rollback triggers.

No task is complete because an agent says it is complete. No deployment is successful merely because it deployed. Independent evidence must support the requested outcome.

## Selective Intelligence execution law

Every run must optimize for verified forward progress per unit of context, reasoning, tool use, and validation cost.

Before inspecting broadly, planning from scratch, or rerunning repository-wide validation, the agent must first locate and load the latest authoritative handoff/checkpoint, current branch/commit, and only the evidence needed for the assigned slice. An interrupted or resumed task continues from the first unproven state transition; it does not restart the audit, roadmap, repository map, or already-proven work.

Rules:

- Resume before rediscovering. Do not rebuild project understanding that is already present in authoritative checkpoints, governing docs, or verified handoffs.
- Inspect the smallest relevant surface first. Expand only when the current evidence shows a dependency, ambiguity, or shared-owner impact.
- Do not repeat a deep dive merely because a new session, agent, model, or Work task started.
- Do not reread large files when exact relevant ranges, diffs, searches, or prior evidence are sufficient.
- Do not rerun expensive repository-wide checks after every small edit. During implementation, run the narrowest tests that prove the changed behavior. Run the full required gate set at integration, merge/release readiness, or when a shared contract change invalidates broader evidence.
- Parallelize independent slices only when ownership and integration boundaries are explicit; share authoritative project state instead of making each lane rediscover it.
- If usage/capacity becomes constrained, preserve active implementation lanes and defer non-blocking audits, prose, duplicate reviews, and broad exploratory passes.
- A run that is interrupted must leave a resumable checkpoint before yielding whenever repository write access remains available.

Every resumable checkpoint/handoff must include:

```text
Objective:
Base branch/commit:
Current branch/commit:
Verified completed work:
Changed but unverified work:
Files changed:
Tests/evidence already run:
Tests/evidence invalidated by later changes:
Known blockers/risks:
External side effects and retry safety:
Next exact action:
Actions that must NOT be repeated:
```

The next agent must treat this checkpoint as the starting index into evidence, not as permission to trust claims blindly. Verify only the minimum state necessary to continue safely.

## Release control (read before merging to main)

- Authorized merge/push to `main` **is** the production release path when merge/deploy are separately authorized. See `RELEASE_CONTROL.md` minimum release contract (local/optional evidence).
- **GitHub Actions is NOT USED — NOT A GATE.** Actions billing is **IRRELEVANT**. Required check `validate` is **NOT REQUIRED**. Do not resolve billing or rerun `validate` as a release precondition. Older docs that said otherwise are superseded.
- Live Stripe remains **HOLD** for authorization reasons only — **not** because of Actions. PR #165 was merged/deployed without justified authorization — see `docs/process/UNAUTHORIZED_MERGE_PR165_2026-08-07.md`.
- Render Auto-Deploy for `sway-tips-web` must stay **On** (On Commit) when deploy is authorized — not turned Off to compensate for unused Actions.
- Do not use Render `checksPass` while `Production Deploy Drift Guard` exists (deadlock with production catch-up). Drift guard is **NOT A GATE**.
- Public release health is `GET /api/release-health`; deploy identity marker remains `GET /api/build-marker`.

## Product scope lock (HOLD)

- Public discovery: `docs/PUBLIC_DISCOVERY_CONTRACT_V1.md` - JW Stone is the behavior reference fixture; Sway Live Rooms and Self-Production are separate discovery lanes; no fake entities; no merge/deploy of discovery work without separate authorization. Phase 1 matrix: `docs/process/PUBLIC_DISCOVERY_PHASE1_AUDIT_MATRIX.md`. Query matrix: `docs/process/PUBLIC_DISCOVERY_QUERY_MATRIX_V1.md`. Canonical host for HTML canonical, robots Sitemap, and sitemap locs is `https://app.sway.tips`.
- **HOLD** means no merge, no admin merge, no override, no push to auto-deploying `main` unless Thomas explicitly authorizes that action. Removing an obsolete gate does not authorize merge. See `docs/process/UNAUTHORIZED_MERGE_PR165_2026-08-07.md`.
- Governing product structure: `docs/SWAY_PRODUCT_STRUCTURE.md` — Live Rooms (current) and Self-Production (in progress) are separate lanes; Sway.DIO is inside Self-Production; external distribution is one outlet, not Sway’s identity.
- Governing Sway.DIO economics (summary): `docs/SWAY_PRODUCT_STRUCTURE.md` — decision D staged all-three funding (subscriptions → advertising → sponsorships); private beta / first earnable streams are subscription-funded Sway Exclusives only; forever 100% attributable streaming income to qualifying Sway Exclusive artists; Sway takes $0 streaming cut; Sway Exclusive ≠ ownership (artist keeps the master). Binding lock is this structure doc only; a separate DIO economic-model document is a later Self-Production artifact, not required for this lane.
- Release-chain hardening does **not** authorize live Stripe or live money.
- Next **Live Rooms** product proof gate is the two-account **Stripe test-mode** production pilot (performer + audience, real hosted room, request/tip/boost/refund, webhook dup/delay, closeout, earnings, receipt/history, DB reconciliation, exact commit evidence). HOLD until proven — see `docs/process/TEST_MODE_PILOT_MILESTONE_HOLD.md`.
- Do not implement or ungate DSP delivery, ticket sales, royalty processing, or collaborator payouts in the Live Rooms lane; those are later Self-Production / independent lanes.
- Do not treat unfinished Self-Production as proof that Live Rooms is incomplete. Unfinished Self-Production does not make Live Rooms unfinished.

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

During implementation, Codex must run the narrowest available validation that directly covers the changed behavior. Full-suite repetition after every bounded edit is prohibited unless the edit changes a shared contract or invalidates broad evidence.

Before integration/merge/release readiness for non-docs-only work, Codex must run:

```text
npm run lint
npm run build
npm run test:contracts
```

If `test:contracts` does not exist yet, Codex must state that clearly and may not claim contract-gate completion.

`test:contracts` must exit nonzero on failure.

`audit:contracts` may soft-exit and print diagnostics.

A previously passing full gate does not need to be rerun during the same slice unless later changes could invalidate it. Record the exact command and commit/worktree state it proves.

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

Merlin must verify only the evidence necessary to arbitrate the current slice. It must not repeat the implementer's entire repository audit or test matrix when scoped evidence remains valid.

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
