# AI Parallel Execution

This document defines how parallel AI work is allowed to run in the Sway repository.

The goal is to let multiple AI-assisted lanes move without creating false progress, hidden merge conflicts, cross-brand drift, or unverified claims.

## Operating Authority

Gawain defines doctrine, slice scope, and merge order.

Codex implements one assigned lane per session.

Gemini reviews and criticizes implementation, roadmap, and risk assumptions.

Gawain reconciles Gemini criticism and issues corrected prompts.

Gemini criticism is not optional. Accepted objections become docs, tests, route rules, schema rules, copy restrictions, or explicit rejected objections with reasons.

## One Lane Per Codex Session

Each Codex session must choose exactly one assigned lane.

Codex must not combine unrelated lanes in one session, even when the edits look small.

Examples:

```text
Allowed:
docs/parallel-execution lane only

Not allowed:
docs/parallel-execution plus UI polish
deploy verification plus terminology cleanup
schema contracts plus Stripe behavior
```

## One Branch Per Lane

Each lane must use one branch.

Branch names must identify the repo, lane, and slice:

```text
codex/sway/<lane>/<short-slice>
```

Examples:

```text
codex/sway/docs/parallel-execution
codex/sway/contracts/build-marker
codex/sway/deploy/freshness-verification
```

Do not stack unrelated work on the same branch.

Do not reuse a dirty branch for a new lane unless Gawain explicitly assigns that branch.

## Inspect First

Codex must inspect the existing repo state before editing.

Minimum inspection:

```text
git status --short --branch
relevant docs
relevant scripts
relevant source files inside the assigned lane
package scripts or project validation docs
```

If the working tree is dirty, Codex must distinguish user changes from lane changes and must not revert user work.

## Smallest Safe Slice

Each lane must implement the smallest slice that satisfies the assigned objective.

Codex must not broaden scope because adjacent cleanup is visible.

Codex must not perform UI polish, product copy changes, AdminApp extraction, payment work, or schema changes unless the assigned lane explicitly requires them.

## Contracts Before Behavior

When possible, add or update contracts before changing behavior.

Contracts must be meaningful gates:

```text
test:contracts must exit nonzero on failure
audit:contracts may soft-exit and print diagnostics
```

Do not present soft audits, screenshots, or local observations as contract-gate completion.

## Truth Rules

Codex must never report fake status.

Codex must never report fake commits.

Codex must never report fake test results.

Codex must never claim production readiness from local-only evidence.

Codex must report blockers exactly when served production state fails the stated acceptance test.

## Brand And Boundary Rules

Do not import doctrine, copy, assets, schema assumptions, or product behavior from another brand or repo.

Do not create cross-brand imports.

Do not touch files outside the assigned lane unless the handoff explicitly reports the reason, risk, and files touched.

## Validation Before Commit

Codex must discover validation from repo scripts or docs.

For non-doc product slices, run the required repo gates unless Gawain explicitly scopes otherwise:

```text
npm run lint
npm run build
npm run test:contracts
```

For docs-only slices, run the normal lightweight repo check when known, usually:

```text
npm run lint
```

If validation cannot run, Codex must report the exact reason and must not claim it passed.

## Gemini Review Required

Every lane requires Gemini/Objector review before Gawain accepts it.

Codex handoff must be complete enough for Gemini to challenge:

```text
changed files
behavior touched
routes touched
schema touched
money touched
validation evidence
known risks
rollback path
```

## Merge Order

Gawain controls merge order.

Parallel lanes may finish out of order, but they merge only in the order Gawain approves.

If two lanes conflict, Gawain decides whether to rebase, split, reject, or reissue the prompt.

## Global Codex Lane Return Format

Every Codex lane must return:

```text
repo:
lane chosen:
branch:
baseline SHA:
files inspected:
files changed:
tests run:
test results:
commit SHA if committed:
PR link if opened:
final git status:
risks / follow-up needed:
```

Sway's AI Council handoff remains required when applicable:

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
