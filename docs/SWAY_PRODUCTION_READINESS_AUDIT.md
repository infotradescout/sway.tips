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

### Not resolved, and moved the wrong way

- **P1-1 (forbidden terminology).** Rescanned `src/` and `shells/`: `checkout` 44 to 87 matches, `preview` 36 to 101. Two caveats before treating that as regression — the original scan's exact scope is not recorded here, so the counts may not be like-for-like; and the audit conditioned this risk on *"if production copy contract forbids these terms."* Sway has since shipped genuine checkout surfaces (Stripe-backed native GA ticket sales, `origin/main` #144 through #146), so `checkout` may no longer be forbidden vocabulary at all. This needs a lexicon policy decision first, then a rescan. Do not treat the raw count as a defect until the contract is restated.

### Could not be verified from this workstation

- **P0-1 (demo leakage in demo-off smoke).** `node scripts/demo-preview-smoke.mjs` was re-run on 2026-07-26 and aborted during server startup: `ECONNREFUSED` against Postgres on `127.0.0.1:5432`. The script spawns a local server and drives Playwright against it, so it needs a local database; none is running and the repo ships no compose file or documented local DB setup. The run produced no surface checks. **This failure is closed, not counted as evidence in either direction** — it neither confirms nor clears the blocker.
- **P0-2 (live routes serving demo/preview content) and P1-2 (admin live truth).** Both are live-production assertions and were not re-checked. Demo machinery is still present in the tree (`src/demo-mode.tsx` plus demo strings in `PatronView.tsx`, `TalentDashboard.tsx`, `PatronApp.tsx`, `TalentApp.tsx`, `OverlayApp.tsx`), but code presence is not proof of production leakage, and its absence would not be proof of a clean route either.
- The five unchecked boxes under **Manual Smoke Checklist** are all live or production checks and remain unchecked.

### Staleness warning

The June 11 findings describe a surface set that the July product rebuild changed substantially — the restore to the customer-performer live room (`0b37ea8`), catalog and release preparation (`9ad0aa1`, `5d9c2ff`), release control (#141), public event listings (#143), and native GA ticket sales (#144 through #146). File paths cited as evidence still exist, but the flows around them do not match this audit. Treat the specifics below as a June snapshot. A clean readiness verdict needs a fresh audit against current production, not a line-by-line rebuttal of this one.

### To close this audit

1. Stand up a local Postgres (or document the intended local DB path) and re-run `scripts/demo-preview-smoke.mjs` to a full demo-off pass.
2. Restate the forbidden-term contract now that checkout is a real product surface, then rescan.
3. Re-verify P0-2, P1-2, and the manual checklist from an environment with production access.

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
