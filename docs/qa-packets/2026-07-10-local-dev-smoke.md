# Sway Live Pilot QA Packet — Local Dev Smoke (2026-07-10)

Filled from `docs/SWAY_LIVE_PILOT_QA_PACKET_TEMPLATE.md`. This is a **local development smoke run**, not a real venue pilot — no real audience, no connected Stripe account. It exists to sanity-check that the shipped product baseline is coherent to a first-time user before a real pilot is scheduled.

## Purpose

Not a claim of live-pilot readiness. Recorded to surface end-user clarity gaps in the current `main` branch (commit range through `69fdc9d`, 2026-07-09) ahead of a real pilot.

## Run Identity

- Pilot date: 2026-07-10
- Environment tested: Local dev (`npm run dev`), Postgres via Docker (`postgres:16-alpine`), `PERSISTENCE_DRIVER=postgres`
- Build marker / commit SHA: `69fdc9d` (main, HEAD at run time)
- Operator name: Claude (agent-run smoke, driven via Playwright)
- Hold/go decision: **HOLD** — not a go/no-go call on the money loop mechanics (those worked), but end-user clarity gaps found (below) should be fixed before a real pilot

## Room Identity

- Room URL: `http://localhost:3000/g/5cee3c28-439e-48e5-a820-fe73f1bcd132`
- Room/gig ID: `5cee3c28-439e-48e5-a820-fe73f1bcd132`
- Performer account: freshly signed-up test account (`pilot-dj-*@example.com`), email verified via dev mock-mail link
- Request mode: Paid
- Room minimum: $5.00
- Boost mode observed: not exercised this run (Request and queue lifecycle only)
- Device/browser notes: Chromium (Playwright), desktop viewport 1280x800 and 1600x1000

## Required Evidence

### Performer Room-Settings Proof
- Evidence: "Set Up Session" screen at `/talent` — performer name, performance type, request mode (Paid/Free toggle), platform-fee handling (pass-as-convenience-fee vs absorb), minimum-request slider, boost minimum, tip path, all shown before room creation.
- Pass/fail: **Pass**
- Notes: Clear, single screen, one obvious "Create room" CTA. No internal setup required beyond normal login.

### Performer Create-Room Proof
- Evidence: `POST /api/session/start` → 200, room created immediately, cockpit view rendered.
- Pass/fail: **Pass**

### QR/Link Proof
- Evidence: Cockpit QR panel — large QR, "SCAN TO REQUEST", room path shown, Copy Link / Open crowd view controls.
- Pass/fail: **Pass**
- Notes: Performer can understand what to show the crowd in well under 5 seconds. Minor visual bug at ~1280px viewport width: the "LIVE REQUESTS OPEN" status badge overlaps the "Up Next" label text in this panel. Resolved at 1600px width — looks like a responsive breakpoint gap, not a logic bug.

### Patron Room-Entry Proof
- Evidence: `/g/:gigId` renders "Live Room" with performer name/avatar ("Pilot Test DJ"), a live-show snapshot, and clear room context.
- Pass/fail: **Pass** for a *valid* room. **Fail** for an *invalid* room (see Known Failures — this is the more likely real-world QR failure mode: a mistyped/expired/misprinted link, not a room that legitimately ended).

### Request Proof
- Evidence: `POST /api/request/create` → 200, request created in `hold` status with clear price breakdown before submit ($5 request + $1 service fee = $6 total) via a "Confirm Request" modal, then "Request Submitted... Status: Pending" confirmation.
- Payment/provider mode: local provider unavailable (no `STRIPE_SECRET_KEY` configured); request payment held, never captured.
- Pass/fail: **Pass**
- Notes: See Known Failures for the "SWAY" vs "Request" button-label finding — the request flow itself, once entered, is clear and correctly labeled.

### Tip Proof
- Evidence: Tip tab within the same Request/Tip/Boost panel, reached via the top-level "TIP" button. Clear amount presets, name/table field, shoutout note field.
- Payment/provider mode: not submitted this run (verified UI only).
- Pass/fail: **Pass** (UI-only)

### Boost Proof
- Not exercised this run.
- Pass/fail: **Fail, then fixed** — see the 2026-07-11 Boost follow-up below. As shipped at the time of this run, boosting an approved queue item silently did nothing on a patron's first tap (stale React state), and even after a second tap, editing the boost amount before confirming was silently ignored at submit time — the originally-set (also stale) amount was charged instead.

### Queue Action Proof
- Evidence: Performer cockpit — pending "Shoutout" request from "Pilot Patron" ($5.00) appeared with one-tap green check (approve) / red X (deny) controls. Approved item moved to "Approved" column with a one-tap play button ("Mark playing") that called `POST /api/request/fulfill` → 200.
- Pass/fail: **Pass**

### Patron Status Proof
- Pending evidence: Patron-side "Request Submitted... Status: Pending" modal + persistent "Your last request is pending review" banner.
- Approved evidence: Not captured from patron side this run (performer-side "Approved" column confirmed).
- Playing evidence: Overlay "Up Next #1 Shoutout $5" before fulfill; cockpit "NOW: Shoutout" after fulfill.
- Up Next evidence: Overlay panel, confirmed.
- Paused evidence: Not exercised.
- Ended evidence: `/g/:gigId` after room end shows "Live Room Ended — This live room session has ended. Thank you for supporting the performer! [Return to Sway home]".
- Pass/fail: **Pass**
- Notes: Status language throughout is honest and matches the checklist's required vocabulary. No premature payment-success claims observed.

### Earnings Or End-Room Proof
- Evidence: "Ending room – closeout 04:58" countdown state after clicking End, then Recap became reachable.
- Pass/fail: **Pass** (flow reachable and clear)

### Recap Proof
- Evidence: "Night recap" screen with a shareable social-card design, Total Tips, Fulfilled Requests, Backers, Platform Fee tiles, and "Top requested item of the night."
- Pass/fail: **Conditional pass** — see Known Failures. Totals correctly show $0.00 because no payment was ever captured (no Stripe key locally) — this is the financially correct behavior (it doesn't fabricate earnings from an authorized-but-uncaptured hold) — but the screen doesn't explain *why* it's $0 despite a real request having gone through the full queue lifecycle, which could read as broken to a performer dry-running the product without Stripe connected.

## Known Failures

1. **Failure:** Primary patron CTA on room entry is labeled "SWAY" rather than "Request." The venue-facing QR sign correctly reads "REQUEST / TIP / BOOST," but the patron's own phone screen shows "TIP" and "SWAY" as the two top-level buttons — a first-time patron has to infer that "SWAY" is the request action.
   - Impact: Room-entry friction / confusing copy at the exact moment (checklist §3–4) the pilot is meant to protect against. Low-to-moderate severity — the sub-tab inside is correctly labeled "Request" once the patron taps in.
   - Owner: unassigned
   - Required fix before go: rename or add a plain-language "Request" affordance to the first-screen CTA.

2. **Failure:** An invalid `/g/:gigId` (garbage UUID, never-existed room, or malformed path) silently falls back to the generic public marketing splash page (the "S" brand animation with SCAN / Create account / Login) with no "room not found" messaging at all — no explanation, no recovery path specific to a broken link.
   - Impact: This is exactly the hold criterion in checklist §8 ("Invalid rooms look like live rooms" / "no-session recovery creates venue confusion"). It's also the *more likely* real failure mode at an actual venue (mistyped/misprinted/expired QR) than a legitimately-ended room, which — by contrast — **is** handled well ("Live Room Ended... Return to Sway home").
   - Owner: unassigned
   - Required fix before go: give invalid/never-existed rooms their own clear "this room doesn't exist" message and recovery action, distinct from both the ended-room state and the generic marketing splash.

3. **Failure:** Recap/earnings totals show $0.00 with no disclosure that this is because Stripe isn't connected/no capture occurred, even after a real request completed the full queue lifecycle.
   - Impact: Lower severity — financially correct, not misleading in a way that risks real money, but could make a performer think the product is broken during a Stripe-less dry run.
   - Owner: unassigned
   - Required fix before go: not blocking for a real pilot (Stripe will be connected by then), but worth a "payments not connected" banner for anyone testing without it.

4. **Failure:** Minor responsive layout bug — the "LIVE REQUESTS OPEN" status badge overlaps "Up Next" label text in the cockpit's QR panel at ~1280px viewport width.
   - Impact: Cosmetic only.
   - Owner: unassigned
   - Required fix before go: not blocking.

## Follow-Up: Fixes Applied and Re-Verified (2026-07-11)

All four Known Failures above were fixed and re-verified by re-running the affected flows in a browser (not just re-reading source):

1. **"SWAY" vs "Request" label** — fixed in `src/components/PatronView.tsx`. The patron's first-screen CTA now reads "Request," matching the QR-sign copy. Re-verified: fresh room, patron entry screen shows "TIP" / "REQUEST".
2. **Invalid room silent fallback** — fixed in `src/shells/PatronApp.tsx`. An invalid/never-existed `/g/:gigId` now shows a "Room not found" banner with a clear next step, instead of the bare marketing splash. Re-verified against a syntactically-valid-but-nonexistent room ID.
3. **Recap $0 with no disclosure** — fixed in `src/components/VictoryScreen.tsx`. When fulfilled paid requests exist but captured totals are $0 (no payment provider connected), the recap now shows an explicit "Payments weren't connected this session" notice. Re-verified end-to-end: fresh room → request → approve → fulfill → end → recap.
4. **QR panel overlap at ~1280px** — fixed in `src/components/TalentDashboard.tsx` (`overflow-hidden` added to the audience-screen panel's content column). Re-verified at 1280x800 viewport: no overlap.

Two contract tests (`scripts/sway-mission-fit.contract.test.mjs`, `scripts/sway-live-night-spine.contract.test.mjs`) asserted the literal old `"Sway"` button text and were updated to match the new "Request" label. Full `npm run lint` (tsc) and `npm run test:contracts` (90+ scripts) pass after these changes.

Hold/go decision updated: the four clarity gaps that justified **HOLD** are resolved. This local-dev smoke still does not replace a real human-operator pilot run per `SWAY_LIVE_PILOT_QA_PACKET_TEMPLATE.md`, and Boost was still not exercised as of this point.

## Follow-Up: Boost Flow Exercised, Two Real Bugs Found and Fixed (2026-07-11)

Boost was the one checklist item never actually driven in a browser during the original run. Doing so surfaced two genuine functional bugs in `src/components/PatronView.tsx`, both stemming from the same anti-pattern: `initiateCheckout('boost')` was called synchronously right after `setBoostingItem(req)` / `setBoostAmount(...)` in the same click handler, but React state updates are not visible until the next render — so the function was reading the *previous* render's stale values, not the ones just set.

1. **First tap on "Boost" did nothing, with zero user-visible feedback.** `initiateCheckout` read `boostingItem` as `null` (the value from before the click), hit `if (!boostingItem) return;`, and silently exited — no modal, no toast, no console error. A patron tapping "Boost" for the first time in a session would see nothing happen at all. Confirmed via direct instrumentation: `boostingItemId` was `null` on the first click and only correctly populated on a second click (once a render had actually occurred in between).
   - Fix: `initiateCheckout` now accepts the target request as an explicit parameter (`initiateCheckout('boost', req)`) instead of relying on state set moments earlier in the same handler.

2. **Even after the modal opened, editing the "Boost Stack Amount" field before confirming was silently ignored.** The confirmation summary (`Boost amount` / `Total boost charge`) and the amount actually submitted to the server were both frozen into `checkoutPayload` at the moment the modal opened (from the same stale-state bug affecting the default $10 preset — the modal would initially show a stale amount that didn't match the input field either). If the patron then changed the amount input, neither the on-screen total nor the real charge reflected their edit.
   - Fix: the target boost amount is now also passed explicitly into `initiateCheckout`, and the amount input's `onChange` now keeps `checkoutPayload.amount/total` in sync live, so the displayed summary and the actual submitted charge always match what's in the field.

Both fixes were verified end-to-end in a browser against a real request: single first-click now reliably opens "Confirm Boost"; editing the amount to $25 updated the summary to "$25.00 / $26.00 total" live, and the server recorded the correct stacked total ($5 original request + $25 boost = $30). `npm run lint` and the full `npm run test:contracts` suite (90+ scripts) pass.

Boost Proof (checklist §Required Evidence) is now **Pass** rather than untested.

## Explicit Non-Claims

- This packet does not claim App Store readiness.
- This packet does not claim payment behavior changed.
- This packet does not claim real-provider payment proof — Stripe was not configured; the request payment was authorized (`hold`) but never captured.
- This packet does not change routes, schema, persistence, role/access behavior, AI behavior, moderation behavior, overlay runtime, or control-bridge status.
- This packet does not claim live hardware/control-bridge proof.
- This is a local-dev smoke run by an agent, not a real venue pilot with a real audience — it does not replace a human-operator run of `SWAY_LIVE_PILOT_QA_PACKET_TEMPLATE.md` before a real pilot night.
