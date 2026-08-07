# Release control

**Status:** `main` is the production release channel. Render auto-deploys on every push/merge to `main` when merge/deploy are separately authorized. **GitHub Actions is NOT USED and is NOT A GATE.**

## Corrected operating rule (owner-locked — supersedes older pre-flight)

| Field | Locked value |
| --- | --- |
| DIO Decision D | LOCKED |
| PR #165 | **MERGED** (unauthorized relative to stated HOLD) — see `docs/process/UNAUTHORIZED_MERGE_PR165_2026-08-07.md` |
| Audited head | `f0e63c0243ef2cff82355297020737983ad3b2b1` |
| Production merge commit | `c4e95655d9b0ce069d272ae8b0cfe18d5b578673` |
| Render deployment (PR #165) | **LIVE** via Auto-Deploy On Commit (not a separately authorized deploy) |
| GitHub Actions | **NOT USED — NOT A GATE** |
| Actions billing | **IRRELEVANT** |
| Required check `validate` | **NOT REQUIRED — NOT A GATE** |
| Live Stripe | **HOLD** (authorization only; not activated by PR #165) |

Prior instruction to resolve Actions billing and rerun `validate` was **wrong**. Older language treating Actions / a required `validate` check as merge or release conditions is **superseded**. Do not revive that gate. Do not treat red/empty Actions checks as release blockers or as proof.

### Meaning of HOLD (owner-locked)

**HOLD means:**

- no normal merge
- no admin merge
- no override
- no push to an auto-deploying `main` branch

Removing an obsolete gate does **not** create authorization. An admin override (`gh pr merge --admin` or equivalent) is allowed **only** after Thomas explicitly authorizes that merge **and** accepts that Render Auto-Deploy On Commit will deploy production.

`--admin` used for PR #165 was **not justified**. Do not repeat.

Do **not** roll back a successful live deploy solely to repair a process violation — that creates another production change. Record the incident, verify production, and correct configuration defects (for example Render health-check path).

## Product scope lock (HOLD)

Governing structure: `docs/SWAY_PRODUCT_STRUCTURE.md`.

- **Live Rooms** = current operating product.
- **Self-Production** = active build in progress (includes files, collaboration, releases, events/tickets, external distribution, planned Sway.DIO streaming, ownership/earnings records).
- **Sway.DIO economics** (when that lane is built): decision D staged all-three funding summarized in `docs/SWAY_PRODUCT_STRUCTURE.md` — subscriptions first (Sway Exclusives only in private beta), then advertising and sponsorships later; forever 100% attributable streaming income to qualifying Sway Exclusive artists; Sway takes $0 streaming cut; Sway Exclusive ≠ ownership. A separate DIO economic-model document is a later Self-Production artifact, not required for this release-health lane.
- Unfinished Self-Production does **not** make Live Rooms unfinished; judge lanes independently.
- Release-chain hardening does **not** authorize live Stripe.

**Next valid Live Rooms product milestone (HOLD until proven on production-hosted test mode):**

1. One performer account
2. One separate audience account
3. A real production-hosted room
4. Stripe **test-mode** request, tip, boost, and refund flows
5. Duplicate and delayed webhook tests
6. Room closeout
7. Performer earnings view
8. Audience receipt and history
9. Database reconciliation
10. Exact deployed-commit evidence

Only after that milestone is proven may Sway consider live Stripe for Live Rooms.

**Out of scope for this Live Rooms gate (later Self-Production / independent lanes):** DSP delivery, ticket sales, royalty processing, collaborator payouts. Those gaps do not redefine Live Rooms as incomplete.

Pilot hold criteria live in `docs/SWAY_LIVE_PILOT_READINESS_CHECKLIST.md` and `docs/process/TEST_MODE_PILOT_MILESTONE_HOLD.md`.

## Minimum release contract (local/optional evidence — NOT an Actions gate)

The checklist below is the **minimum release-contract concept**: useful local (or optional CI) evidence when preparing an authorized merge. It is **not** enforced by GitHub Actions, is **not** a required status check, and **Actions billing does not block** merge or release.

Every merge to `main` that is allowed to become production should have evidence covering:

| # | Evidence | Where / how |
| --- | --- | --- |
| 1 | Exact proposed commit | PR head SHA + recorded validation bound to that SHA |
| 2 | Clean dependency installation | Local (or optional CI) `npm ci` |
| 3 | Type and build validation | Local (or optional CI) `npm run lint` + `npm run build` |
| 4 | Relevant contract tests | Local (or optional CI) `npm run test:contracts` (+ integration proofs as needed) |
| 5 | Database compatibility proof | Migration integration proofs + deploy `preDeployCommand: npm run db:migrate` + public `/api/release-health` migration status |
| 6 | Browser proof for changed user paths | Human evidence in PR / `docs/process/RELEASE_EVIDENCE_CHECKLIST.md` (when user-facing paths change) |
| 7 | Health endpoint | Public `GET /api/release-health` (service, DB, commit, migration compatibility; no secrets) |
| 8 | Deployment commit marker | Public `GET /api/build-marker` + same commit fields on release-health |
| 9 | Post-deployment smoke | Operator smoke checklist (drift-guard workflow is optional observer only — **NOT A GATE**) |
| 10 | Rollback or roll-forward record | Release evidence checklist section (before treating deploy as accepted) |
| 11 | GitHub Actions / required check `validate` | **NOT A GATE** — unused; billing irrelevant; do not require or wait on `validate` |

Workflow files under `.github/workflows/` may still exist as vestigial/optional runners. Red, empty, or missing Actions runs carry **no release meaning**. Do not fix billing or rerun `validate` as a release precondition.

## Control plane

| Layer | Posture |
| --- | --- |
| Merge to `main` | **HOLD** until separately authorized — **not** blocked by Actions / `validate` |
| Render auto-deploy | **On Commit** for `sway-tips-web` when deploy is authorized (deploys the merged SHA); deploy remains **HOLD** until authorized |
| GitHub Actions | **NOT USED — NOT A GATE**; Actions billing **IRRELEVANT** |
| Required check `validate` | **NOT REQUIRED — NOT A GATE** |
| Drift guard | Optional post-deploy observer; **NOT A GATE**. Do not use Render `checksPass` with it (deadlock) |
| Live Stripe | **HOLD** until separately authorized |

Repo file `render.yaml` sets `autoDeployTrigger: commit` and `healthCheckPath: /api/release-health`. **Dashboard Auto-Deploy must stay On** when deploy is authorized. Prefer keeping Render on commit; do not invent an Actions merge gate.

## Operating rule

**Authorized merge to `main` deploys production via Render** when deploy is also authorized.
GitHub Actions success/failure is **not** the authorization signal and is **not** a release condition.

## Human notes (optional / non-blocking)

### A. GitHub branch ruleset — NOT A GATE

Older click-path docs that required status check `validate` are **superseded**. See `docs/process/BRANCH_RULESET_ACTIVATION.md`. Do **not** treat enabling a required `validate` check, fixing Actions billing, or getting a green Actions run as a merge/release condition.

If a human later chooses optional PR protection for other reasons, that is separate owner policy — it still does **not** make Actions billing or empty runners a release blocker under this doctrine.

### B. Render health path

**Defect after PR #165 auto-deploy:** repo `render.yaml` declares `healthCheckPath: /api/release-health`, but the connected Render service may still have an **empty** health-check path (deploy accepted via `/`). The release-health endpoint can be live in code while **not** acting as Render’s real deployment gate. See incident record.

1. Open production service `sway-tips-web`.
2. **Settings → Health Check Path** = `/api/release-health` (matches `render.yaml`).
3. **Settings → Build & Deploy → Auto-Deploy → On** (On Commit) — note: On Commit means **any** merge to `main` deploys; HOLD on merge is the real deploy control.
4. Confirm after an authorized deploy:
   - `GET /api/release-health` on apex / www / app returns `releaseActive: true` for the intended SHA (migration hash compatibility must also be healthy)
   - `GET /api/build-marker` returns the same `commit`

Why not Render `checksPass`? Drift guard waits for production to serve the new SHA. `checksPass` waiting on that guard deadlocks deploy.

## Public endpoints

### `GET /api/build-marker`

Deployment identity only (always JSON when the process is up):

- `service`, `commit`, `branch`, `buildTimestamp`, `nodeEnv`

### `GET /api/release-health`

Release-active health (HTTP **200** only when release is active; otherwise **503**). Fields:

- `ok`, `status` (`ok` | `degraded` | `unavailable`)
- `service`, `commit`, `branch`, `buildTimestamp`, `nodeEnv`
- `database.configured`, `database.reachable`
- `migrations.status`, `migrations.compatible`, counts, `latestExpectedTag`
- `releaseActive` (true only when DB reachable, migrations compatible with this build, and commit is known)

No secrets, connection strings, hostnames, or credential flags.

## Post-deploy smoke + rollback boundary

After an authorized production catch-up:

1. Confirm `/api/build-marker` and `/api/release-health` commit == intended SHA (manual or optional drift observer).
2. Confirm `releaseActive: true`.
3. Run changed-path browser smoke; record in release evidence.
4. Record rollback SHA / Render rollback action **or** explicit safe roll-forward SHA before accepting the release.

## Agent rules

- Do **not** require GitHub Actions, Actions billing fixes, or required check `validate` for merge or release.
- Treat merge to `main` as a production release only when separately authorized and the minimum release-contract evidence (local/optional) is recorded for that exact SHA.
- Do not treat drift-guard success or a build marker alone as complete-product proof or live-Stripe authorization.
- See `AGENTS.md` release-control section.
