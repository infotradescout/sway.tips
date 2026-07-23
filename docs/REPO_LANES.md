# Sway Repo Lanes

## Repo

```text
sway.tips
```

## Repo Doctrine

Sway is a live-gig monetization product for performers, DJs, bartenders, street performers, venues, and patrons.

The first production loop is:

```text
Performer starts a gig
Patron scans QR/link
Patron submits a paid tip, request, or boost
Performer approves, denies, or fulfills
Payment lifecycle and platform fee are recorded
Performer sees a reliable ledger
```

The repo follows the AI Council model:

```text
Codex = implementer
Gemini/Objector = adversarial reviewer
Gawain = doctrine, scope, merge order, and final reconciliation
```

No lane may claim readiness without evidence. Production readiness requires served production state, not local-only proof.

## Safe Parallel Lanes

These lanes may run in parallel when they keep to their allowed files and do not share implementation surfaces.

| Lane | Purpose |
| --- | --- |
| `docs` | Repo doctrine, runbooks, operating contracts, lane documentation. |
| `contracts` | Hard contract tests, contract audits, validation scripts. |
| `deploy-verification` | Production freshness checks, deploy drift guard, read-only deployment evidence. |
| `schema` | Database schema, migrations, persistence contracts. |
| `server-routes` | Express route ownership, route guards, server entrypoint behavior. |
| `role-access` | Actor resolution, persisted authorization, role isolation. |
| `patron-surface` | Patron app UI and patron-only client behavior. |
| `talent-surface` | Talent app UI and performer-only client behavior. |
| `admin-surface` | Admin/operator shell and admin-only client behavior. |
| `overlay-surface` | Overlay display shell and overlay-only client behavior. |
| `moderation` | Reporting, blocking, hiding, removing, moderation audit behavior. |
| `payments` | Stripe/payment provider, idempotency, capture/void/refund/payout lifecycle. |
| `app-store` | TestFlight/App Store package evidence, privacy/support/compliance docs. |

## Future Product Lanes (Memo Only)

These are locked product intent. They are **not** active parallel build lanes until Gawain opens them with scope, ledger boundaries, and an evidence bar.

| Future lane | Memo | Rule |
| --- | --- | --- |
| `event-tickets` | `docs/SWAY_FUTURE_LANE_EVENT_TICKET_SALES.md` | Event ticket sales is a Sway lane. Docs/planning only until explicitly activated. Separate ledger and fee disclosure from live-room money, publishing, merch, and paid streams. Plan: `docs/SWAY_EVENT_TICKETS_AND_PUBLIC_FEED_PLAN.md` (includes public feed repair; individuals sell without venue gate). |
| `public-feed` | (same plan) | Truthful discovery for live rooms + upcoming ticketed shows. No fake inventory. May ship Phase B ahead of ticket MVP if Gawain sequences it that way. |

## Unsafe Lane Pairings

These pairings must not run in parallel unless Gawain explicitly sequences and scopes them.

| Pairing | Reason |
| --- | --- |
| `schema` + `server-routes` | Routes must not assume schema that is still moving. |
| `schema` + `payments` | Money behavior depends on durable idempotency and audit tables. |
| `payments` + `patron-surface` | Client payment copy/flows can misrepresent backend payment state. |
| `payments` + `talent-surface` | Capture, closeout, and ledger surfaces must match backend truth. |
| `role-access` + any surface lane | UI access assumptions must not outrun persisted guards. |
| `admin-surface` + `moderation` | Admin controls and moderation effects share authority boundaries. |
| `deploy-verification` + product lanes | Production freshness must be verified before stacking feature claims. |
| `contracts` + same behavior lane | Contract edits and behavior edits may race unless one lane owns both. |
| any lane + broad cleanup | Cleanup hides product and safety diffs. |

## Branch Naming Convention

Use:

```text
codex/sway/<lane>/<short-slice>
```

Examples:

```text
codex/sway/docs/parallel-execution
codex/sway/deploy/build-marker-freshness
codex/sway/contracts/payment-idempotency
```

## Lane-Specific Allowed Files

### `docs`

Allowed:

```text
docs/**
README.md
AGENTS.md
```

Only touch README or AGENTS when the assigned docs lane explicitly requires it.

### `contracts`

Allowed:

```text
scripts/*.contract.test.mjs
scripts/contract-check.mjs
scripts/contract-audit.mjs
package.json
docs/** when documenting the contract
```

### `deploy-verification`

Allowed:

```text
.github/workflows/**
render.yaml
scripts/*deploy*.mjs
scripts/*smoke*.mjs
docs/** deploy runbooks
```

Read-only live verification should not edit files.

### `schema`

Allowed:

```text
src/db/**
drizzle.config.*
drizzle/**
migrations/**
scripts/*schema*.mjs
scripts/*database*.mjs
docs/** schema contracts
```

### `server-routes`

Allowed:

```text
server.ts
src/server/**
shells/*.html when route entrypoints require it
scripts/*route*.mjs
docs/** route contracts
```

### `role-access`

Allowed:

```text
src/server/access-control.ts
src/server/**authorization**
scripts/*role*.mjs
scripts/*identity*.mjs
docs/** role/access contracts
```

### Surface Lanes

Allowed:

```text
src/shells/<Surface>App.tsx
src/components/** only when owned by that surface
src/entries/**
shells/<surface>.html
scripts/*surface*.mjs
docs/** surface contracts
```

Surface names:

```text
patron-surface
talent-surface
admin-surface
overlay-surface
```

### `moderation`

Allowed:

```text
src/server/moderation-service.ts
server.ts moderation routes only
src/components/** moderation controls only
scripts/*moderation*.mjs
docs/** moderation contracts
```

### `payments`

Allowed:

```text
src/server/payment-*.ts
server.ts payment routes only
src/server/idempotency-store.ts
scripts/*payment*.mjs
scripts/*idempotency*.mjs
docs/** payment contracts
```

### `app-store`

Allowed:

```text
docs/** app store, privacy, support, review evidence
public/** required policy/support assets
capacitor/config files if assigned
scripts/*native*.mjs
```

## Lane-Specific Banned Files

Unless explicitly assigned, all lanes must avoid:

```text
package-lock.json churn
renaming existing files
bulk formatting unrelated files
cross-brand docs or imports
unassigned product copy changes
unassigned UI polish
unassigned payment behavior
unassigned schema changes
```

Docs lanes must not change:

```text
server.ts
src/**
scripts/**
shells/**
package.json
package-lock.json
```

Deploy verification lanes must not change product behavior.

Payment lanes must not proceed before durable idempotency and audit requirements are satisfied.

Middleware/role lanes must not proceed before the required persisted schema exists.

## Validation Expectations

Codex must inspect `package.json` and repo docs before choosing validation.

Default non-doc gates:

```text
npm run lint
npm run build
npm run test:contracts
```

Docs-only lane minimum when known:

```text
npm run lint
```

Deploy verification lane:

```text
live build-marker fetches
live route header fetches
live forbidden-string checks when assigned
```

If a required validation command does not exist or cannot run, report it directly.

## Return Format

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

For Sway council compatibility, include this handoff when the lane touches product, routes, schema, money, persistence, role/access, AI, moderation, or App Store readiness:

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
