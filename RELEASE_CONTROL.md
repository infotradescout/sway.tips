# Release control

**Status:** `main` is the production release channel. Render auto-deploys on every push/merge to `main` **after** the exact-commit CI gate has actually executed and passed.

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

## Minimum release contract (fail-closed)

Every merge to `main` that is allowed to become production must satisfy:

| # | Gate | Where enforced |
| --- | --- | --- |
| 1 | Exact proposed commit | PR head SHA + CI run bound to that SHA |
| 2 | Clean dependency installation | CI `npm ci` |
| 3 | Type and build validation | CI `npm run lint` + `npm run build` |
| 4 | Relevant contract tests | CI `npm run test:contracts` (+ integration proofs) |
| 5 | Database compatibility proof | CI migration integration proofs + deploy `preDeployCommand: npm run db:migrate` + public `/api/release-health` migration status |
| 6 | Browser proof for changed user paths | Human evidence in PR / `docs/process/RELEASE_EVIDENCE_CHECKLIST.md` (required when user-facing paths change) |
| 7 | Health endpoint | Public `GET /api/release-health` (service, DB, commit, migration compatibility; no secrets) |
| 8 | Deployment commit marker | Public `GET /api/build-marker` + same commit fields on release-health |
| 9 | Post-deployment smoke | `Production Deploy Drift Guard` + operator smoke checklist |
| 10 | Rollback or roll-forward record | Release evidence checklist section (required before treating deploy as accepted) |
| 11 | Branch rule requiring the gate before merge | GitHub ruleset: required check `validate` (owner-controlled; zero approval counts OK) |

Empty CI jobs (billing-locked runners that finish with zero real steps) are a **blocker**, not permission to skip. Do not merge on an empty green/red shell. Fix Actions billing / runner execution first, or keep the change off `main`.

## Control plane

| Layer | Posture |
| --- | --- |
| Merge to `main` | Blocked until exact-commit CI job `validate` executes real steps and passes |
| Render auto-deploy | **On Commit** for `sway-tips-web` (deploys the merged SHA) |
| GitHub Actions | **Required merge gate** when runners execute; empty-step runs do not count as proof |
| Drift guard | Post-deploy observer of production catch-up; **not** a merge gate. Do not use Render `checksPass` with it (deadlock) |

Repo file `render.yaml` sets `autoDeployTrigger: commit` and `healthCheckPath: /api/release-health`. **Dashboard Auto-Deploy must stay On**. Prefer keeping Render on commit while GitHub blocks unverified merges.

## Operating rule

**Verified merge to `main` deploys production via Render.**
Unverified merge (no real CI execution) must not become production solely by pressing Merge.

## Human activation (required once)

### A. GitHub branch ruleset (owner click-path)

Full click-path: `docs/process/BRANCH_RULESET_ACTIVATION.md`.

1. GitHub → repository **Settings → Rules → Rulesets → New ruleset → Branch ruleset**.
2. Name: `main release gate`.
3. Target: branch `main`.
4. Enable: **Require a pull request before merging** (approval count may be **0**; owner-controlled is OK).
5. Enable: **Require status checks to pass** → add required check **`validate`** (workflow `CI Validation Gate 1`).
6. Do **not** require `verify-production-build-marker` for merge (it waits for production and would deadlock deploy-on-commit).
7. Block force pushes to `main`.
8. Save ruleset.

If Actions billing causes jobs to complete with no Checkout / npm steps, treat that as a hard stop: restore billing or runner capacity before merging release work.

### B. Render health path

1. Open production service `sway-tips-web`.
2. **Settings → Health Check Path** = `/api/release-health` (matches `render.yaml`).
3. **Settings → Build & Deploy → Auto-Deploy → On** (On Commit).
4. Confirm after deploy:
   - `GET /api/release-health` on apex / www / app returns `releaseActive: true` for the intended SHA
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

After production catch-up:

1. Drift guard (or manual) confirms `/api/build-marker` and `/api/release-health` commit == intended SHA.
2. Confirm `releaseActive: true`.
3. Run changed-path browser smoke; record in release evidence.
4. Record rollback SHA / Render rollback action **or** explicit safe roll-forward SHA before accepting the release.

## Agent rules

- Treat merge to `main` as a production release only when the minimum release contract executed for that exact SHA.
- Do not treat drift-guard success or a build marker alone as complete-product proof or live-Stripe authorization.
- See `AGENTS.md` release-control section.
