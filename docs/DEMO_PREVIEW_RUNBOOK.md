# Demo Preview Runbook

## Purpose

This runbook is the stakeholder demo checklist for the Sway preview architecture. It explains what can be shown, what must be described as demo-only, how to turn demo fixtures on and off, and which commands prove the preview remains isolated from production paths.

Use this for controlled demos of the current public/app shell split and Split View preview surfaces. Do not use it to claim launch readiness, live payment execution, live moderation enforcement, live admin authority, or App Store readiness.

## What Is Real

- Host-aware routing keeps `sway.tips` and `www.sway.tips` on the public shell while `app.sway.tips` resolves the app-facing shell.
- Public and app shells are separated so the public landing surface does not leak protected app shell behavior.
- `SplitViewShell` is reusable UI architecture, not demo-only code.
- Patron, talent, admin, and overlay shells can render empty or protected states without fixture data.
- Protected preview shells remain shell-only. Demo mode does not grant backend API, mutation, payment, moderation, persistence, or admin authority.
- Default production builds remain demo-free because demo fixtures are only published when `VITE_SWAY_DEMO_MODE === 'true'`.

## What Is Demo-Only

- Fixture records in `fixtures/demo/sway-demo-fixtures.json`.
- Preview queue items, preview totals, fixture users, fixture events, and role scenarios.
- Any visible "Demo preview data", "Preview only", or preview-total text.
- Talent and admin preview scenarios shown without real actor authorization.
- Overlay ladder entries shown from fixtures while demo mode is enabled.

Fixture records must remain clearly marked with:

- `demo_` id prefix.
- `demo: true`.
- `fixtureSource: "demo-fixture-harness"`.

## Enable Demo Mode

Run local development with demo fixtures explicitly enabled:

```bash
VITE_SWAY_DEMO_MODE=true npm run dev
```

On Windows PowerShell:

```powershell
$env:VITE_SWAY_DEMO_MODE='true'; npm run dev
```

## Disable Demo Mode

Unset the flag or set it to false:

```bash
unset VITE_SWAY_DEMO_MODE
npm run dev
```

```bash
VITE_SWAY_DEMO_MODE=false npm run dev
```

On Windows PowerShell:

```powershell
Remove-Item Env:VITE_SWAY_DEMO_MODE -ErrorAction SilentlyContinue
npm run dev
```

## Kill Switch

The kill switch is to remove or unset `VITE_SWAY_DEMO_MODE`, or set it to any value other than `true`.

After the kill switch is applied:

- The default production build must not publish `sway-demo-fixtures.json`.
- Public and app shells must still render their real empty/protected states.
- Demo mode must not create backend API, mutation, payment, moderation, persistence, or admin authority.
- Protected preview shells must return to their normal guard behavior unless real access credentials and persisted authorization exist.

## Demo Surfaces

- Public landing: `http://sway.tips:3000/`
- App home: `http://app.sway.tips:3000/home`
- Patron Split View: `http://app.sway.tips:3000/g/00000000-0000-4000-8000-000000000001`
- Talent Split View: `http://app.sway.tips:3000/talent/gigs`
- Admin preview Split View: `http://app.sway.tips:3000/admin`
- Overlay ladder: `http://app.sway.tips:3000/overlay/00000000-0000-4000-8000-000000000001`

If local DNS does not resolve those hosts, add temporary local host entries for `sway.tips`, `www.sway.tips`, and `app.sway.tips` pointing to `127.0.0.1`, or use the smoke script.

## Validation Checklist

Run these before a stakeholder demo:

```bash
npm run lint
npm run build
npm run test:contracts
VITE_SWAY_DEMO_MODE=true npm run build
node scripts/demo-preview-smoke.mjs
```

On Windows PowerShell, use:

```powershell
$env:VITE_SWAY_DEMO_MODE='true'; npm run build
node scripts/demo-preview-smoke.mjs
Remove-Item Env:VITE_SWAY_DEMO_MODE -ErrorAction SilentlyContinue
```

The smoke script writes local evidence under `artifacts/demo-preview-smoke/<timestamp>/`. These artifacts are ignored by git and are for local review only.

## What Not To Claim

- Do not claim live payment execution, checkout capture, tipping settlement, payout readiness, or KYC completion.
- Do not claim live admin authority or real operator permissions.
- Do not claim live moderation enforcement, reporting enforcement, blocking enforcement, or durable moderation queues.
- Do not present fixture users, fixture requests, fixture events, fixture totals, or fixture venue scenarios as real production data.
- Do not claim App Store or TestFlight readiness from this preview.
- Do not imply demo mode is a security boundary. Server-side authorization, persistence, ledgers, and audit rules remain separate requirements.

## Safety Boundaries

- Demo mode defaults off.
- Demo fixtures are only exposed when `VITE_SWAY_DEMO_MODE === 'true'`.
- The default dist must exclude fixture payload.
- Backend server, database, payment, auth/identity, mutation, moderation, reporting, and blocking logic must not import demo fixtures.
- `SplitViewShell` must not import fixtures directly.
- Talent/admin demo previews are shell-only GET previews. They do not unlock API routes or mutation authority.
- Patron and talent demo mutation handlers reject with "No backend mutation was sent."

## Evidence

Use `node scripts/demo-preview-smoke.mjs` for visual smoke evidence. Review the generated files under:

```text
artifacts/demo-preview-smoke/<timestamp>/
```

Expected evidence includes demo-off empty/protected states and demo-on labeled preview states for public, patron, talent, admin, and overlay surfaces.

## Troubleshooting

- If demo data appears with the flag unset or false, stop and fix the default-off contract before demoing.
- If `dist/sway-demo-fixtures.json` exists after a normal `npm run build`, stop and fix fixture publication before demoing.
- If talent or admin preview sends or enables a backend mutation in demo mode, stop and fix the shell boundary before demoing.
- If admin copy implies real authority, payment copy implies real capture, or moderation copy implies real enforcement, stop and tighten labels/copy before demoing.
- If smoke evidence is missing, blank, or cannot find expected labels, rerun after checking local hosts, port `3000`, and demo mode environment.
- If any validation command fails, do not present the preview as ready.
