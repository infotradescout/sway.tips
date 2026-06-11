# Sway Production Readiness Audit

Date: 2026-06-11

## Decision

NOT READY

## Executive Summary

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
