# Sway Live Pilot Readiness Checklist

## Purpose

This checklist verifies whether Sway is ready for a real live-night pilot around the shipped product baseline:

Performer sets room settings -> creates room -> shares QR/link -> patron sends Request, Tip, or Boost -> performer manages queue/status -> night closes with clear operational proof.

This lane is docs and contract governance only. It does not change routes, schema, payment behavior, request/tip/boost runtime behavior, persistence, role/access behavior, overlay behavior, AI/moderation behavior, or App Store readiness.

The required evidence package for a real pilot or manual QA run is `docs/SWAY_LIVE_PILOT_QA_PACKET_TEMPLATE.md`. The readiness checklist defines the hold criteria; the QA packet records proof, known failures, and the hold/go decision after the operator actually runs the pilot path.

## Pilot Scope

The pilot proves the live room money loop, not future platform expansion.

Before this checklist passes, PR #44 remains parked. Hardware controls, control bridge work, lyrics, marketplace/browse expansion, operator/admin expansion, DJ software integrations, and new infrastructure must not resume unless the owner explicitly reorders the lane.

## 1. Performer Can Create A Room Before Going Live

- Performer can reach the authenticated performer surface.
- Performer can see the primary Create room action after the room settings.
- Performer can set or confirm money settings before the room link and QR are generated.
- Performer can create a room without needing manual setup beyond normal login.
- Pilot evidence records the test environment, performer account, room URL, and room/gig ID.

Hold if:
- Create room is missing, disabled, unclear, or requires internal setup.
- The room can go live without a clear performer identity or money settings.

## 2. Performer Can Share QR/Link

- QR appears immediately after the room is created.
- Copy link is visible and works.
- The copied link opens the same live room on another browser/device.
- The performer can understand what to show the crowd in under five seconds.

Hold if:
- QR or link is missing.
- The QR/link opens the wrong room or a no-session recovery path.

## 3. Patron Can Enter The Correct Room

- Patron opens `/g/:gigId` from the QR/link.
- Patron sees enough performer/room context to know they are in the correct live room.
- Room-entry friction is measured: load time, confusing copy, login pressure, or no-session recovery.
- No-session recovery is tested separately and must be clear without pretending a room is live.

Hold if:
- Patron cannot distinguish the intended room.
- Patron sees internal language, login-first friction, or dead-end no-session recovery.

## 4. Patron Can Send Request, Tip, Or Boost

- Request is visible as a primary action.
- Tip is visible as a primary action.
- Boost is visible when a boostable queue item exists.
- Patron can submit without account friction unless the payment provider requires confirmation.
- Payment behavior unchanged: pilot smoke may verify UI and status expectations, but must not claim new payment behavior or bypass existing processor rules.

Hold if:
- Request, Tip, or Boost is hidden behind browse, lyrics, marketplace, or internal surfaces.
- Payment copy claims behavior that the backend/provider state does not prove.

## 5. Patron Sees Clear Status

Patron-facing status language must be clear and truthful:

- Pending
- Approved
- Playing
- Up Next
- Paused
- Ended

The pilot operator must capture the status shown after each relevant state transition.

Hold if:
- Status copy implies payment success before backend/provider confirmation.
- Denied, refunded, voided, or ended states use unsafe claims such as unverified card language.

## 6. Performer Can Review And Manage The Queue

- Performer sees pending Request items.
- Performer can approve in one tap.
- Performer can deny in one tap.
- Performer can complete or mark Playing/fulfilled in one tap.
- Performer can see what is Up Next.
- Performer can see whether intake is Paused or open.
- Performer can see Earnings during the night.

Hold if:
- Pending items do not appear.
- Queue actions are missing, confusing, or require an internal console.
- Earnings are absent or misleading.

## 7. Money-Loop Smoke Expectations

Money-loop smoke must verify the product path without changing money behavior:

- Request submission path reaches the existing request/payment state.
- Tip submission path reaches the existing tip/payment state.
- Boost submission path reaches the existing boost/payment state.
- Approve, deny, complete, and recap use existing backend behavior.
- Smoke notes the payment provider mode: local provider unavailable, Stripe test, staging, or production.

Do not claim real-provider payment proof unless Stripe/staging/provider-backed validation actually ran.

Hold if:
- The pilot requires code changes to money behavior.
- Smoke bypasses existing payment, idempotency, persistence, or audit boundaries.

## 8. No-Session And Room-Entry Friction

- Invalid or expired `/g/:gigId` links show understandable no-session recovery.
- Overlay no-session recovery is understandable and display-safe.
- Patron room entry does not expose internal-console language.
- Pilot notes any confusing first-screen text or missing next step.

Hold if:
- Invalid rooms look like live rooms.
- Recovery copy tells patrons to do something impossible at the venue.

## 9. Live Pilot Operator Steps

Before first live night, the pilot operator verifies:

- Environment and build marker.
- Performer account can log in.
- Performer can start live room.
- QR/link opens correct room on a second device.
- Patron Request, Tip, and Boost UI loads.
- Performer queue, QR, and Earnings UI loads.
- Patron status transitions are visible and truthful.
- End room and recap are reachable.
- No unsafe payment copy appears.
- No App Store readiness claim is made from this pilot.

The operator records:

- Date/time.
- Environment.
- Build marker or commit.
- Room/gig ID.
- Performer account used.
- URLs tested.
- Pass/fail per checklist section.
- Screenshots or short video when possible.
- Known limitations.
- Completed QA packet with hold/go decision.

## 10. Hold Criteria Before PR #44 Resumes

PR #44 remains parked until this checklist lands and the live pilot readiness review passes.

Hold PR #44 and all new feature work if any of these remain unresolved:

- Performer cannot set room settings and create a room.
- Performer cannot share QR/link.
- Patron cannot enter the correct live room.
- Patron cannot find Request, Tip, or Boost.
- Patron status language is unclear or unsafe.
- Performer cannot manage the queue.
- Earnings or recap are absent or misleading.
- No-session recovery creates venue confusion.
- Money-loop smoke would require changing money behavior.
- Pilot evidence is missing environment, room/gig ID, URLs, and pass/fail results.

## Explicit Non-Claims

- No runtime behavior changed.
- Payment behavior unchanged.
- No route changes.
- No schema changes.
- No persistence changes.
- No role/access changes.
- No overlay behavior changes.
- No AI/moderation changes.
- No App Store readiness claim.
