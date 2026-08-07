# Vibe Engineering Doctrine

We do not measure agent productivity by code produced.

We measure it by verified outcomes delivered without increasing uncontrolled risk.

## Ownership

Humans own:

- Intent
- Constraints
- Risk tolerance
- Architecture boundaries
- Final authority

Agents own:

- Exploration
- Implementation
- Repetition
- Testing assistance
- Analysis
- Documentation
- Continuous challenge

Systems own:

- Policy enforcement
- Validation gates
- Audit trails
- Observability
- Deployment controls
- Rollback triggers

## Evidence Law

No generated output is trusted because it is plausible.

No task is complete because an agent says it is complete.

No deployment is successful merely because it deployed.

The work advances only when independent evidence supports the requested outcome.

The objective is not maximum automation.

The objective is maximum verified throughput per unit of human attention.

## Sway Production-Readiness Law

Sway is **two connected products on different timelines**. See `docs/SWAY_PRODUCT_STRUCTURE.md`.

| Lane | Status |
| --- | --- |
| Live Rooms | Current operating product |
| Self-Production | Active build in progress |
| Sway.DIO | Planned native streaming layer within Self-Production |
| External distribution | One Self-Production capability, not Sway’s identity |
| Live payment activation | Separate release gate for Live Rooms |

Sway.DIO economics (planned): zero-take, listener-directed streaming — per-listener monthly creator pool; Sway keeps $0 from the streaming pool; no fixed per-stream penny promise. Canonical lock: `docs/SWAY_DIO_ECONOMIC_MODEL.md`. That lock does not authorize Sway.DIO launch.

Unfinished Self-Production does **not** make Live Rooms unfinished. Future audits must judge Live Rooms and Self-Production independently, with separate readiness judgments, roadmaps, and release gates.

A whole-product “complete-product launch” claim still requires both lanes to be independently verified in production:

1. Sway replaces the core DistroKid workflow **as one Self-Production outlet** (external distribution): durable masters, release metadata and identifiers, DSP delivery, delivery lifecycle, royalty statements, collaborator splits and payouts, promotion, and safe catalog transfer. DistroKid-class distribution is not Sway’s identity and is not the definition of Self-Production.
2. Sway retains its original product (**Live Rooms** and shared account surfaces): one-account access, public profiles, live rooms, room QR and sharing, requests, tips, boosts, moderation, queue control, overlays, earnings, and closeout.

Both lanes should eventually form one cohesive customer journey under one account. Schema, code, contracts, a merged pull request, a build marker, or a deployment is not sufficient evidence by itself. Until every required capability in the readiness ledger is production verified, the complete-product readiness decision is `HOLD`.

That HOLD does not redefine Live Rooms as a future idea. Live Rooms is the current operating product; Stripe live money remains a separate Live Rooms release gate after the test-mode production pilot is proven.

Iterative deployments may continue to build and repair either lane. They must not be described as complete-product launch approval or as live-Stripe authorization. `npm run readiness:assert` is the fail-closed whole-product launch assertion; `npm run readiness:report` is the non-approving diagnostic report.
