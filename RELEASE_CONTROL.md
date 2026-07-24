# Release control

**Status:** `main` is the production release channel. Render auto-deploys on every push/merge to `main`.

## Control plane

| Layer | Posture |
| --- | --- |
| Render auto-deploy | **On Commit** for `sway-tips-web` |
| Production path | Merge/push to `main` → Render builds and deploys |
| GitHub Actions | CI is advisory until billing works. **Not required** for Render deploy |
| Drift guard | Observes production catch-up; not a deploy trigger. Do not use Render `checksPass` with it (deadlock) |

Repo file `render.yaml` sets `autoDeployTrigger: commit`. **Dashboard Auto-Deploy must stay On**.

## Operating rule

**Push/merge to `main` deploys production via Render. GitHub Actions is not required for that path.**

## Human checklist (Render)

1. Open production service `sway-tips-web` (sway.tips / www / app).
2. **Settings → Build & Deploy → Auto-Deploy → On** (On Commit).
3. Do not switch Auto-Deploy Off to wait for Actions.
4. Confirm with `/api/build-marker` on sway.tips, www.sway.tips, and app.sway.tips.

Why not `checksPass`? The workflow `Production Deploy Drift Guard` waits for production to serve the new SHA. Render `checksPass` waits for checks including that guard → deadlock.

## GitHub Actions / billing

When billing is locked, jobs may finish in seconds with empty steps. That does not stop Render auto-deploy. Prefer admin merge bypass while Actions cannot go green, rather than turning Auto-Deploy Off.

## Branch protection

| Check name (job) | Workflow | Role |
| --- | --- | --- |
| `validate` | `CI Validation Gate 1` (`.github/workflows/ci.yml`) | Preferred merge signal when Actions works |

`verify-production-build-marker` is a post-deploy observer, not a merge gate.

## Agent rules

- Treat merge to `main` as a production release.
- Do not treat drift-guard success or a build marker alone as complete-product proof.
- See `AGENTS.md` release-control section.
