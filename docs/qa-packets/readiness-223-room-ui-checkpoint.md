# sway.tips production-readiness checkpoint — issue 223

This is historical evidence for draft commit `57a43a255d3a170ef335e705e666220d82c72e01`. See [the subsequent mobile/queue checkpoint](readiness-223-mobile-queue-checkpoint.md) for current status. The browser passes below do not verify later source changes.

## Decision

Draft repair only. NOT ready to merge, deploy, activate money, or close issue 223.

Baseline source: 54c96cc9eb4d88df2e9358d7525854a054dbdf36.
Branch: audit/readiness-223-room-recovery.
Environment: Windows, Node 24.14.1, installed Google Chrome 152.0.7977.76.

## User outcome

A performer must keep the correct room and confirmed queue during bad connectivity, receive visible action failures, reach the complete request library, and enter/leave Room Tools without losing keyboard focus.

## Changes

- Room-scoped, committed-render ownership and cancellation reject late responses after room changes or room clearing.
- Newer refresh results are not replaced by older outstanding refreshes.
- Periodic polling avoids overlapping a slow request; a timeout remains bounded and recoverable.
- Temporary failures retain same-room confirmed state, visibly stale and read-only. Access denial or missing room clears private queue data.
- Performer queue-action errors propagate to the existing visible error handler. End/closeout failures have a visible message.
- Stale live controls become inert; keyboard/MIDI and session-action entry points receive an explicit blocked-state guard.
- Request library gains search across song/artist/album/source, matching counts, pagination, no-result state, and page clamping.
- Mobile removal confirmation now returns focus to a visible status element.
- Room Tools focus trapping excludes controls inside collapsed details. Closing restores focus to the actual opener, not the hidden Copy Link button.
- Two ambiguous browser-test selectors now identify the intended textbox and exact heading. Assertions were retained.
- Three source-shape contracts were aligned with the new actual polling implementation; role, route, demo, and no-room boundaries were retained.

## Browser evidence

37 focused cases PASS, 0 FAIL. See browser-results.json for named cases and source-file SHA-256 values.

The original, unchanged baseline was separately exercised with the same initial 13 regression scenarios: 3 PASS / 10 FAIL. The repaired source passes those 13 plus 18 library/viewport combinations and 6 Room Tools combinations.

Library counts: 0, 1, 30, 31, 200, and 1001 per source group. Viewports: 320x568, 844x390, and 1366x768. Separate room-recovery checks use 390x844.

Additional browser suites PASS: refund confirmation; payment-dialog viewport; profile/payout options (including role selection and room tools).

Browser evidence uses REAL rendered React components in Chrome, but SYNTHETIC accounts and MOCKED API responses. It is not production sign-in, a real backend, physical-device testing, real provider settlement, or end-to-end authorization proof. External browser requests are blocked in the new suite.

## Build and contracts

- npm run lint: PASS.
- npm run build: PASS.
- Performer profile, demo fixture, gig-scoped room truth, control no-op guards, and live cockpit contracts: PASS.
- npm run test:contracts: FAIL at existing Windows DJ-library path expectation. The identical failure was reproduced on unchanged baseline source.
- Failure: importer test expects /Music/Sets/night-drive.flac but receives Windows backslashes, at scripts/sway-dj-library-importers.test.mjs:38.
- Earlier new-hook source-shape assertion failures were fixed; the full suite is NOT reported as passing or waived.

## Explicit remaining work

- Fix or correctly characterize the Windows import/path contract without breaking actual DJ software paths.
- Full-server, separate-actor authentication/authorization and durable-state journeys, including mutation-versus-poll and account/room changes under concurrent writes.
- Cross-browser, actual mobile keyboard, 200% zoom, old/new-client compatibility, Back/Forward, unsaved forms, scroll restoration, and longer combined workflows.
- Visual review still shows crowded/clipped QR/share content in the compact live cockpit at 320px. Passing document-width checks does not prove every child is visible. This remains a layout finding, not a pass.
- Large libraries are now searchable/paged; overall page density and compact navigation still require further usability work.
- Reconcile the owner's non-exclusive 20% policy with quotes, receipts, balances, refunds, Exclusive terms and existing accepted entitlements in a separate money-safe lane. No pricing change is included here.
- Provider sandbox reconciliation, refunds versus withdrawals, live-payout readiness, backup restoration, migration safety, deployment rollback, and approved production canary.

## Preservation and rollback

The owner's active checkout contains unrelated County Map work and was not modified. This repair was created in an independent clone from the upstream baseline. No private .env file or credential was copied. No production server, production database, payout service, or charge endpoint was started or changed.

No schema, payment calculation, provider configuration, production account, public terms, original master, or live feature switch was edited.

Rollback for this unmerged patch is to keep production on the unchanged baseline; no production rollback operation is required. Do not apply this statement to future migrations or deployments.

The new test command is npm run test:browser:readiness-223. Local screenshots and detailed logs are under artifacts/readiness-223. Historical failed runs remain there; they are not overwritten into a false pass.
