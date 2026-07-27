# Sway Production Readiness Audit

Date: 2026-06-11
Revisited: 2026-07-26

## Decision

NOT READY

Revisit 2026-07-26: **verdict unchanged.** One of three P0 blockers is verifiably fixed. The other two were neither disproven nor re-proven — they cannot be exercised from a workstation without production or local database access. Readiness requires positive proof, so unverified blockers hold the verdict at `NOT READY`. This is a fail-closed result, not a finding that the app is broken.

## Revisit 2026-07-26

Scope note: this pass verified repository state only. No live production route was checked and no production claim below is new.

### Verifiably resolved

- **P0-3 (deployment freshness) and P2-1 (build marker).** `server.ts:271-272` sets `x-sway-build` and `x-commit-sha` on responses; `server.ts:2697` serves `GET /api/build-marker`. Corroborated independently by `docs/SWAY_PRODUCTION_SURFACE_MAP.md`, which on 2026-06-14 observed both headers and marker JSON returning a commit SHA and build timestamp on the apex, `www`, `app`, and Render origin endpoints. Fixed between 2026-06-11 and 2026-06-14.

### P1-1 (forbidden terminology) is resolved — the finding was a grep artifact

This does not need a policy decision. The policy already exists and is enforced: `scripts/sway-surface-terminology.contract.test.mjs` bans the standalone *visible* words `checkout` / `check out` / `check-out`, and `preview` on the Public Entry surface. **It passes.**

The June finding counted raw `grep` hits, which is not what the contract measures. The contract uses word-boundary anchors specifically so code identifiers do not trip it — `checkoutPayload` and `initiateCheckout` are explicitly called out as allowed in its own header comment. Of 377 raw `checkout` matches across `src/` and `shells/` on current `main`, 244 are code identifiers. The remainder are not visible copy violations, or the contract would fail.

An earlier draft of this revisit reported "44 to 87" and called it movement in the wrong direction. That comparison was invalid: the 87 was measured on `feat/dsp-delivery-job-engine`, 23 commits behind `main`, before the native ticket lane landed. Raw counts across different trees say nothing. Treat the contract, not a grep, as the answer.

### Not verified: CI has not actually run since 2026-07-23

Every `validate` run since **2026-07-23T23:33** completes in roughly 2 seconds with `runner_name: ""` and **zero steps executed**. The job is never assigned a runner. This is an infrastructure or quota condition, not a test failure — Actions is enabled on the repo with `allowed_actions: all`, and the billing endpoints need scopes unavailable here, so the precise cause is unconfirmed.

For contrast, the 2026-07-22 failure ran 23 steps on a real runner for 132 seconds and failed legitimately at "Audio File Collaboration Integration Proof". The last genuinely verified run was 2026-07-23T21:21 on `main`.

**Consequence:** every merge to `main` since 2026-07-23 landed with no CI verification — release control (#141), public event listings (#143), and the native GA ticket sales lane (#144 through #146), which is payment-touching. A red check on any PR since that date carries no information about that PR. This should be treated as a live gap in the evidence chain, not a stale CI annoyance.

### P0-1: the smoke harness is stale, and the recorded failures no longer reproduce

Corrects the first pass, which reported P0-1 as blocked on a missing local Postgres. That was only the first error, not the blocker. The server has a no-DB path (`server.ts:152` sets `businessDb` to `null` when `DATABASE_URL` is unset), and `dotenv` is loaded with `override: false`, so running the smoke with `DATABASE_URL=""` gets past startup. A database is not required to exercise these surfaces — the demo fixtures are client-side (`src/demo-mode.tsx`), not database rows.

**The actual blocker is a routing mismatch.** `scripts/demo-preview-smoke.mjs` drives the apex host (`http://sway.tips:3000/`) expecting the public landing shell. `server.ts:324` now redirects `sway.tips` and `www.sway.tips` with a 308 to a hardcoded `https://app.sway.tips` (`CANONICAL_APP_ORIGIN`, no port, no environment gate), so Chromium leaves the local test server for the production HTTPS origin and fails with `ERR_CONNECTION_REFUSED`. The canonical host moved to `app.sway.tips`; the smoke script still encodes the pre-redirect model and cannot pass as written in any local environment.

**Measured directly instead**, using the June audit's own method — Playwright rendered text, not raw HTML, since these are SPA shells — against a demo-off server (`VITE_SWAY_DEMO_MODE=false`) on the canonical host:

| Surface | Status | Rendered result |
| --- | ---: | --- |
| `/` | 200 | Real landing copy. Clean. |
| `/home` | 200 | `SCAN / sway to play`. Clean. |
| `/g/00000000-...` | 200 | `ROOM NOT FOUND`. Clean. |
| `/talent/gigs` | 401 | `Session needed`. Proves nothing. |
| `/admin` | 401 | `Session needed`. Proves nothing. |
| `/overlay/00000000-...` | 401 | `Session needed`. Proves nothing. |

Zero of six surfaces showed `Demo data`, `preview-only data`, `demo preview state`, `DEMO PREVIEW DATA`, or `Preview data only`. **Both of the specific failures this audit recorded under P0-1 — demo-off `/home` and the demo-off patron gig route — now render clean.**

Scope limits, stated plainly: this was local, not production, so it says nothing about P0-2. The three protected surfaces returned 401 and were never rendered, so they are untested rather than clean. And the smoke harness itself remains unrunnable until it is realigned to the canonical host, so this is a manual measurement, not a restored automated gate.

**The harness is stale in three separate ways, not one.** Re-tested 2026-07-27 against a real Postgres 16 (Docker, all 28 `drizzle/` migrations applied, 69 tables) as well as with no database at all. Both runs render identically, which is what confirms the demo fixtures are client-side and the database is irrelevant to these surfaces:

1. **Apex routing.** The first check drives `sway.tips` and dies on the 308, so no later check ever executes. This alone makes the whole script a no-op.
2. **Stale content expectations.** `/home` expects `Live room` and `No live records yet`; it renders `SCAN / sway to play`. The patron gig route expects the same plus `Room status`; it renders `ROOM NOT FOUND`. The July rebuild changed these empty states. The talent, admin, and overlay expectations (`Sway actor resolution required`, `Session needed`, `Sign in to continue`) still match exactly.
3. **The demo-on half cannot pass.** With `VITE_SWAY_DEMO_MODE=true`, every surface renders identically to demo-off — no `Demo data`, no `Aria Neon`, no `Midnight City`.

### Why demo mode is inert (root-caused 2026-07-27)

The flag and the fixtures both work. Importing the module through Vite's own module graph, `isDemoModeEnabled()` returns `true` and `loadDemoBackendState()` returns a populated object (`session`, `requests`, `performers`). The fixture file exists and the server serves it `200`. Demo mode is still imported by all five shells; nothing was deleted.

It cannot reach a screen for two independent reasons:

1. **Guard ordering in `src/shells/shared.tsx:163`.** `useSwayState` early-returns on `if (!statePath)` *before* the `isDemoModeEnabled()` branch at line 170. `PatronApp.tsx:192` sets `statePath = routeGigId ? ... : null`, and `OverlayApp.tsx:81` does the same, so every non-gig route — `/home` and the overlay included — returns at line 167 and never reaches demo loading.
2. **`src/demo-mode.tsx:79` hardcodes `activeGigId: null`.** The patron gig route is the one surface that does reach the demo branch, because a valid UUID gives it a `statePath`. But the demo state it loads carries no active gig, so it cannot match `routeGigId` and the route renders `ROOM NOT FOUND`. The fixture reinforces this: its session id is `demo_session_001`, while every demo route and the smoke script use `00000000-0000-4000-8000-000000000001`.

Together these make demo data unreachable on every surface, which is exactly the measured result.

**This is very likely the desired state, not a defect.** The June P0 was "production app routes expose demo data as the primary app experience." Demo data can no longer render anywhere. So P0-1 and P0-2 look **obsolete rather than fixed** — the failure mode was removed by making the fixture path unreachable, and `demo-preview-smoke.mjs` was simply left behind as an artifact of the era when it worked.

That framing needs an owner decision, because the two options are opposites: either **formally retire** demo mode and delete or rewrite the smoke script that exists to test it, or **repair** the two defects above and restore a working demo-on/demo-off comparison. Repairing it would reintroduce renderable demo data, which is what the original P0 objected to. Nothing here should be treated as closed until that call is made.

**To actually close P0-1:** diagnose why demo mode no longer activates; realign the apex checks to assert the 308 to `CANONICAL_APP_ORIGIN` instead of expecting landing content; update the `/home` and patron-gig expectations to the current empty states; and re-run with an authenticated session so the talent, admin, and overlay surfaces are genuinely exercised rather than passing on a 401 wall.
- **P0-2 (live routes serving demo/preview content) and P1-2 (admin live truth).** Both are live-production assertions and were not re-checked. Demo machinery is still present in the tree (`src/demo-mode.tsx` plus demo strings in `PatronView.tsx`, `TalentDashboard.tsx`, `PatronApp.tsx`, `TalentApp.tsx`, `OverlayApp.tsx`), but code presence is not proof of production leakage, and its absence would not be proof of a clean route either.
- The five unchecked boxes under **Manual Smoke Checklist** are all live or production checks and remain unchecked.

### Staleness warning

The June 11 findings describe a surface set that the July product rebuild changed substantially — the restore to the customer-performer live room (`0b37ea8`), catalog and release preparation (`9ad0aa1`, `5d9c2ff`), release control (#141), public event listings (#143), and native GA ticket sales (#144 through #146). File paths cited as evidence still exist, but the flows around them do not match this audit. Treat the specifics below as a June snapshot. A clean readiness verdict needs a fresh audit against current production, not a line-by-line rebuttal of this one.

### To close this audit

1. Realign `scripts/demo-preview-smoke.mjs` to the canonical `app.sway.tips` host and re-run it to a full demo-off pass, with a session so the protected surfaces actually render. No Postgres is needed — run it with `DATABASE_URL=""`.
2. Decide whether the unconditional apex redirect at `server.ts:324` is intended for every environment. It hardcodes a production origin with no environment gate, which is what makes local apex routing untestable.
3. Restate the forbidden-term contract now that checkout is a real product surface, then rescan.
4. Re-verify P0-2, P1-2, and the manual checklist from an environment with production access.

## Executive Summary (2026-06-11)

Contract and build gates are green, but launch-readiness fails on user-visible truth.

A critical-path smoke run failed in demo-off mode, and live domains currently render demo/preview surfaces (including preview/check-out language) on core routes.

This means current production behavior does not meet the readiness standard:

- one real end-to-end request flow working in production,
- no stale deployment mismatch,
- no dead/confusing critical-path UX.

## P0 Blockers (Launch Blocking)

1. Demo leakage in non-demo smoke path (critical path broken)
- Evidence: `node scripts/demo-preview-smoke.mjs` failed.
- Failed checks:
  - demo-off app shell home (`/home` on `app.sway.tips`) showed unexpected `Demo data`.
  - demo-off patron route (`/g/00000000-0000-4000-8000-000000000001` on `app.sway.tips`) showed unexpected `Demo data`.
- Artifact: `artifacts/demo-live-room-smoke/2026-06-11T14-10-40-195Z/report.json`.

2. Live production routes are currently serving demo/preview content
- Live route evidence (`fetch_webpage` + `Invoke-WebRequest`) shows `DEMO PREVIEW DATA`/`Preview data only` content on:
  - `https://app.sway.tips/home`
  - `https://sway.tips/g/00000000-0000-4000-8000-000000000001`
  - `https://sway.tips/talent/gigs`
  - `https://sway.tips/admin`
  - `https://sway.tips/overlay/00000000-0000-4000-8000-000000000001`
- This blocks a production-truth claim for requester/operator/overlay flow.

3. Deployment freshness cannot be proven and appears stale
- Local HEAD: `43f09087774b2e8da6a4e62b641c42ea8aefb780` at `2026-06-11T09:06:25-05:00`.
- Live headers for core routes show `last-modified: Tue, 09 Jun 2026 18:36:07 GMT`.
- No explicit build/commit header present (`x-sway-build`, `x-commit-sha` absent).
- `https://sway.tips/metadata.json` returns route HTML content instead of a machine-verifiable build marker.

## P1 Risks (Usable but Risky/Confusing)

1. Forbidden launch terminology is still present on user-facing requester/performer surfaces
- Forbidden-term scan found:
  - `checkout`: 44 matches (notably in `src/components/PatronView.tsx`).
  - `preview`: 36 matches (in `src/components/PatronView.tsx`, `src/components/TalentDashboard.tsx`, `src/shells/PatronApp.tsx`, `src/shells/TalentApp.tsx`, and landing/index artifacts).
- If production copy contract forbids these terms, this is a release risk.

2. Admin/Ops production role truth remains unclear on live
- Live `/admin` currently shows demo preview/operator compatibility copy rather than clearly non-demo operational state.

## P2 Polish (Non-Blocking)

1. Add explicit production build marker endpoint/header
- Example: return commit SHA/build timestamp from `/metadata.json` and/or response headers.

2. Tighten terminology consistency on all surfaces
- Keep only approved user-facing lexicon where policy requires it.

## Verified Flows

1. Repo validation gates pass
- `npm run lint`: pass
- `npm run build`: pass
- `npm run test:contracts`: pass

2. Public landing route loads and CTA copy is present
- `https://sway.tips/` and `https://www.sway.tips/` returned expected landing content and links.

3. Local smoke checks partly pass
- `node scripts/demo-preview-smoke.mjs`:
  - PASS: public landing (demo-off)
  - PASS: talent/admin protected guard (demo-off)
  - PASS: overlay empty state (demo-off)
  - PASS: all demo-on surface checks

## Failed Flows

1. Local demo-off patron critical path consistency
- FAIL: app home and patron route include unexpected `Demo data`.

2. Live production-truth path
- Requester, performer, admin, and overlay routes currently show demo/preview content.
- A real production E2E path (requester submit -> operator triage/state transition -> overlay reflection) is not proven under non-demo live conditions.

## Routes Tested

- `https://sway.tips/`
- `https://www.sway.tips/`
- `https://app.sway.tips/`
- `https://app.sway.tips/home`
- `https://sway.tips/g/00000000-0000-4000-8000-000000000001`
- `https://sway.tips/talent/gigs`
- `https://sway.tips/admin`
- `https://sway.tips/overlay/test`
- `https://sway.tips/overlay/00000000-0000-4000-8000-000000000001`
- `https://sway.tips/metadata.json`

## Files Involved (Primary Evidence)

- `scripts/demo-preview-smoke.mjs`
- `artifacts/demo-live-room-smoke/2026-06-11T14-10-40-195Z/report.json`
- `server.ts`
- `metadata.json`
- `src/components/PatronView.tsx`
- `src/components/TalentDashboard.tsx`
- `src/shells/PatronApp.tsx`
- `src/shells/TalentApp.tsx`
- `src/shells/OverlayApp.tsx`
- `src/shells/admin/AdminOpsRuntimeCompat.tsx`

## Commands Run

- `git status --short`
- `git restore src/shells/AdminApp.tsx src/shells/admin/AdminOpsRuntimeCompat.tsx`
- `npm run lint`
- `npm run build`
- `npm run test:contracts`
- `node scripts/demo-preview-smoke.mjs`
- `git log -1 --format="%H %cI %s"`
- `Invoke-WebRequest` checks for live route status/headers
- `fetch_webpage` checks for live route content snapshots
- local terminology scans via PowerShell `Select-String`

## Manual Smoke Checklist

- [x] Public landing opens.
- [x] Landing CTA links are present.
- [ ] Requester production path verified end-to-end without demo/preview state.
- [ ] Performer/operator production triage-to-play lifecycle verified live.
- [ ] Overlay verified against non-demo live state transitions.
- [ ] Mobile requester flow manually verified in production.
- [ ] Production build freshness verified against HEAD via explicit build marker.

## Required Fixes Before Launch

1. Remove demo/preview leakage from production routes (or gate demo to explicit non-production environments only).
2. Re-run `scripts/demo-preview-smoke.mjs` and achieve full pass for demo-off surfaces.
3. Add deployment freshness marker (header and/or metadata endpoint) tied to commit SHA.
4. Verify one full non-demo E2E path in production:
   - requester submit -> operator sees pending -> approves -> up next -> playing -> ended -> overlay reflects each transition.
5. Resolve forbidden term exposure (`checkout`, `preview`) on user-facing production surfaces if those terms are contractually blocked.
