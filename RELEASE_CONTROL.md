# Release control (P0 posture)

**Status:** Production must not deploy on every merge to `main`.

Billing exposed a deeper control-plane failure: when GitHub Actions cannot run, merges to `main` still reach production because Render was configured with `autoDeployTrigger: commit`. Restoring billing alone is not enough.

## Current control plane (intended)

| Layer | Required posture |
| --- | --- |
| Render auto-deploy | **Off** for `sway-tips-web` |
| GitHub Actions | CI `validate` must be green before any approved deploy; no push-to-main deploy workflow |
| Drift guard | Observes production catch-up; it is **not** a deploy trigger and must not be used with Render `checksPass` (deadlock) |
| Branch protection | PRs required; required check `validate`; no direct pushes to `main` |
| Merge policy (human) | Only approved release/remediation merges during this period |

Repo file `render.yaml` sets `autoDeployTrigger: "off"`. **Blueprint sync / Dashboard must match** or Render will keep deploying on commit.

## Human P0 checklist (Render — required)

1. Open production service `sway-tips-web` (sway.tips / www / app).
2. **Settings → Build & Deploy → Auto-Deploy → Off** (or sync Blueprint so `autoDeployTrigger: "off"` is live).
3. Confirm the previous **On Commit** setting is gone.
4. Deploy only via Dashboard **Manual Deploy** of an approved SHA (or a controlled deploy hook) after `validate` is green.
5. Confirm with `/api/build-marker` on sway.tips, www.sway.tips, and app.sway.tips.

Why not `checksPass`? The workflow `Production Deploy Drift Guard` waits for production to serve the new SHA. Render `checksPass` waits for all checks including that guard → deadlock.

## GitHub Actions / billing evidence (observed)

Annotation on failed jobs:

> The job was not started because your account is locked due to a billing issue.

- Healthy baseline (2026-07-23 ~21:21Z): `CI Validation Gate 1` success in ~2m41s.
- After lock (2026-07-23 ~23:36Z onward): failures in ~3–4s, empty steps.

Until billing is unlocked, required checks cannot go green. That does **not** stop Render if Auto-Deploy is still On Commit.

## Branch protection vs check names

| Required check name (job) | Workflow |
| --- | --- |
| `validate` | `CI Validation Gate 1` (`.github/workflows/ci.yml`) |

`verify-production-build-marker` is a post-deploy observer, not a merge gate.

## Agent rules during this period

- Do not merge unrelated features to `main`.
- Do not treat drift-guard success or a build marker alone as complete-product proof.
- See `AGENTS.md` release-control section.
