# Branch ruleset notes (NOT A GATE)

**GitHub Actions is NOT USED — NOT A GATE.** Actions billing is **IRRELEVANT**. Required check `validate` is **NOT REQUIRED**.

This file remains only so agents do not revive older click-path language that treated a GitHub ruleset + `validate` status check as a merge or release condition. That doctrine is **superseded** by `RELEASE_CONTROL.md` (corrected operating rule).

## Corrected rule

- Do **not** block merge or release on Actions green/red/empty runs.
- Do **not** fix Actions billing or rerun `validate` as a release precondition.
- Merge / deploy / live Stripe holds are **authorization-only**, not Actions-related.
- Local (or optional CI) evidence under the minimum release-contract concept in `RELEASE_CONTROL.md` may still be recorded when preparing an authorized merge — that evidence is **not** an Actions gate.

## Optional human PR protection (non-blocking doctrine)

If an owner later chooses repository rules for other reasons, that is separate policy. Under Sway release doctrine it still must **not** reintroduce Actions billing or required check `validate` as a release gate.

Historical (superseded) pattern that must **not** be treated as current law:

1. Ruleset named `main release gate` targeting `main`
2. Require a pull request before merging
3. Require status checks to pass → required check `validate`
4. Block force pushes

Do **not** add `verify-production-build-marker` as a required merge check (post-deploy observer; deadlocks Render `checksPass`).

## Render (paired settings — when deploy is authorized)

1. Service `sway-tips-web` → Auto-Deploy **On** (On Commit).
2. Health Check Path: `/api/release-health`.
3. Do not switch Auto-Deploy to `checksPass` while the drift guard observes production catch-up.

## Product HOLD reminder

Completing or skipping any GitHub ruleset does not authorize live Stripe. Live Rooms is the current operating product; Self-Production is a separate lane. See `docs/SWAY_PRODUCT_STRUCTURE.md` and `docs/process/TEST_MODE_PILOT_MILESTONE_HOLD.md`.
