# Sway Release Evidence Checklist

Release evidence must use real command outputs only.

No simulated validation is allowed. Simulated validation, invented command output, or soft-pass language is release-blocking.

Release-chain evidence does **not** authorize live Stripe. The Live Rooms two-account Stripe test-mode production pilot is PASS, while live Stripe remains a separate owner-authorized release gate — see `docs/process/TEST_MODE_PILOT_MILESTONE_HOLD.md`. Dual-lane product truth: `docs/SWAY_PRODUCT_STRUCTURE.md`.

## Minimum release contract checklist

- Exact proposed commit SHA:
- Clean dependency installation (`npm ci`) evidence:
- Type and build validation (`npm run lint`, `npm run build`) evidence:
- Relevant contract tests (`npm run test:contracts` local/optional) evidence:
- Database compatibility proof (migration proofs + `/api/release-health` migrations.compatible):
- Browser proof for changed user paths (device/browser, routes, pass/fail):
- Health endpoint (`GET /api/release-health`, `releaseActive`):
- Deployment commit marker (`GET /api/build-marker` commit match):
- Post-deployment smoke result:
- Rollback or safe roll-forward record:
- GitHub Actions / required check `validate`: **NOT A GATE** (unused; billing irrelevant; do not wait on or require):

Actions red/empty/missing checks are **not** release-blocking. Do not resolve Actions billing or rerun `validate` as a release precondition. Merge/deploy/live-Stripe holds are authorization-only.


## Requested Outcome

- Human intent:
- Constraints:
- Risk tolerance:
- Architecture boundaries:
- Acceptance criteria:

## Independent Evidence

- Implementer:
- Independent verifier or enforcing system:
- Environment:
- Evidence source:
- Observed result:
- Why this evidence supports the requested outcome:
- What remains unproven:

## Local Validation Command List

- `npm run audit:contracts --if-present`
- `npm run lint --if-present`
- `npm run build`
- `npm run test:contracts --if-present`
- `git diff --check`

Record exact output or attach the log location.

## Production Marker Evidence When Deploying

- Intended production commit:
- Observed production commit (`/api/build-marker`):
- Observed release-health commit (`/api/release-health`):
- `releaseActive`:
- `database.reachable`:
- `migrations.compatible` / `migrations.status`:
- Observed timestamp:
- Apex marker result:
- `www` marker result:
- App subdomain marker result:
- Render origin marker result:
- Marker confirms deployed identity only; customer outcome verified separately:

## Browser Proof For Changed User Paths

- Changed routes/paths:
- Device/browser:
- Steps exercised:
- Pass/fail:
- Screenshots or notes location:

## Route Smoke Evidence

- Public landing route:
- App root route:
- Patron route:
- Talent route:
- Admin/operator route:
- Overlay route:
- Error route:

## Role/Access Smoke Evidence

- Unauthenticated:
- Patron:
- Performer:
- Admin/operator:
- Support:
- Denied:

## Demo Fixture Boundary Evidence

- Production does not show demo fixture data:
- Forced demo env cannot override production boundary:
- Dev/demo mode remains explicit and labeled:
- Public links do not route to hardcoded demo UUID state:

## Rollback Path

Rollback or safe roll-forward record (required before accepting the deploy):

- Decision: rollback / roll-forward:
- Rollback commit (previous known-good SHA):
- Roll-forward commit (if fixing forward):
- Rollback command or Render deploy action:
- Routes to verify after boundary action:
- Automatic rollback trigger:
- Observability signal that activates the trigger:
- Signal notes (`/api/release-health` not releaseActive, commit mismatch, smoke fail):

## Complete-Product Readiness

- Whole-product ledger decision (`npm run readiness:report`):
- `npm run readiness:assert` result:
- DistroKid-replacement pillar evidence:
- Original-Sway pillar evidence:
- Note: DistroKid-replacement pillar = Self-Production external-distribution outlet evidence (not Sway’s identity). Original-Sway pillar = Live Rooms / shared account evidence.
- Cohesive one-account journey evidence:
- Note: complete-product readiness is separate from iterative deploy approval, from Live Rooms operating-product status, and from live-Stripe authorization.

## Known Risks

- Risk:
- Severity:
- Owner decision:
- Follow-up:

## Owner Approval Field

- Owner:
- Decision:
- Date:
- Conditions:
