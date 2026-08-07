# Branch ruleset activation (human click-path)

Owner-controlled is OK. Zero required approval counts is OK. The gate must **execute** with real CI steps.

This is a dashboard action. Agents must not ask for tokens or CLI secrets to complete it.

## GitHub ruleset

1. Open the Sway GitHub repository → **Settings → Rules → Rulesets**.
2. **New ruleset → Branch ruleset**.
3. Name: `main release gate`.
4. Target branches: include `main`.
5. Enable **Require a pull request before merging**.
   - Required approvals: **0** is allowed (owner-controlled).
6. Enable **Require status checks to pass**.
   - Add required check: **`validate`** (job from workflow `CI Validation Gate 1` / `.github/workflows/ci.yml`).
7. Do **not** add `verify-production-build-marker` as a required merge check (post-deploy observer; deadlocks Render `checksPass` / delays merges unnecessarily).
8. Enable **Block force pushes**.
9. Save the ruleset.

## Render (paired settings)

1. Service `sway-tips-web` → Auto-Deploy **On** (On Commit).
2. Health Check Path: `/api/release-health`.
3. Do not switch Auto-Deploy to `checksPass` while the drift guard observes production catch-up.

## Actions billing blocker

If a `validate` run finishes in seconds with no Checkout / `npm ci` / lint / build / contract steps, that run is **not** proof. Restore GitHub Actions billing or runner execution before merging to `main`.

## Product HOLD reminder

Completing this ruleset does not authorize live Stripe. Live Rooms is the current operating product; Self-Production is a separate lane. See `docs/SWAY_PRODUCT_STRUCTURE.md` and `docs/process/TEST_MODE_PILOT_MILESTONE_HOLD.md`.
