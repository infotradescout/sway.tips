# Sources safe replacement and complete external-library reads

## Objective / user job
A performer adds a Spotify playlist, safely updates its saved songs, finds songs beyond the first page in Requests, and can recover from provider/account changes without losing another source. Playback remains in the original source/player.

## Base branch/commit
- Production baseline: main a1ea2ac3613bb5410879410fdc87d6ab93ac2e95.
- Continued #248 from fe3c95a3c81e31d674ce68cc745163cbac0fcd01.
- Source-only recovered implementation: #243 at 6d37f43686087713e445d520a7e9f60346bd961b. Its payout, collaborator and migration stack was NOT merged.

## Current branch/commit
- Branch: fix/sway-spotify-import-integrity-20260916, PR #248.
- Tested and pushed runtime: 6cd434f63cb6f0cc6fd825f5ff02e2b3f4c7b0ed.
- Tested tree: 11bd4e0379833ee4eeb6561b43230f57632be6cf.
- This handoff/receipt update after that commit is documentation-only.
- Owned Windows scratch checkout: C:\Users\flavo\AppData\Local\Temp\sway-sources-flow-20260916. It is not asserted to be the user's canonical local workspace.

## Verified completed work
- Actual Spotify POST route accepts complete playlists within a 1,000-item bound, replacing the former 100-item ceiling. Oversized input is rejected explicitly, never silently truncated.
- Browser preflight verifies the current performer and saved source. Replacing a playlist requires a named confirmation and sends the exact observed source ID/version; cancellation sends no write.
- One transaction locks the performer, rechecks ownership and the expected source version, reserves or updates the correct Spotify source, then replaces tracks. Concurrent requests that saw the same version cannot both succeed. Downstream failure rolls source and track changes back together.
- All four shared source-track writers acquire the performer lock before source/track locks. Five non-Spotify source-update sites now advance their timestamp monotonically, including revoke and key rotation, even when the clock lags.
- Source list responses include performer identity and updatedAt. HTTP failures preserve typed errors and Retry-After; the browser exposes retry guidance. Uncertain writes are not automatically replayed.
- The actual browser proof exposed another bug: 251 tracks were saved but the library endpoint returned only 100, leaving later songs absent from client-side Requests search. The endpoint now pages external tracks in stable ID order with a source-version hash, checking that version before and after each page. The client assembles coherent pages and rejects mixed/partial results, malformed rows and duplicate IDs. This does not redesign the separate stored-audio catalog's existing limit.
- Account/performer/preview/unmount changes invalidate import status and stale reads. A confirmed save remains confirmed when page refresh fails, with a reload instruction.
- Existing search fallback and provider-reader safety from the preceding #248 candidate remain intact.

## Files changed in the runtime commit
server.ts; src/components/TalentDashboard.tsx; src/server/spotify-playlist-store.ts; src/spotify-playlist-import.ts; src/request-library-read.ts; scripts/sway-music-source-capability.contract.test.mjs; scripts/sway-performer-connections.contract.test.mjs; scripts/sway-spotify-current-route.behavior.test.mjs; scripts/sway-spotify-playlist-import.behavior.test.mjs; scripts/sway-spotify-playlist-store.integration.test.ts; scripts/sway-request-library-read.behavior.test.ts; scripts/sway-spotify-sources.browser.test.mjs; scripts/fixtures/spotify-source-provider.mjs; docs/qa-packets/spotify-sources-20260916/native-flow.json.

No schema, migration, package, dependency, payment, payout, collaborator or provider configuration changes.

## Tests/evidence already run
Exact candidate 6cd434f passed npm run lint, npm run build and the complete npm run test:contracts on Windows/Node 24.14.1. All three exited zero, with no signals/timeouts; source unchanged. Final run began 2026-09-16T18:00:27.548Z and completed 2026-09-16T18:13:29.428Z. Receipt: docs/qa-packets/spotify-sources-20260916/final-gates.json.

Focused suites cover 29 named existing provider/search scenarios; 11 import callback subtests; 20 browser-helper cases; 6 paged-reader subtests; and 16 reject-before-track-write checks plus success/version/rollback store assertions. Node enclosing parent tests are not additional scenarios. New workflow suites are mandatory in the existing Connections contract; original player helper/browser and broader contract tests remain in that full command.

The separately attested standalone PostgreSQL 18.4 browser run passed all 13 checks from 2026-09-16T17:56:16.820Z through 17:57:18.088Z. Actual signup, React interface, HTTP routes and database writes were exercised. It proves 251-track import and later-page Requests search, cancellation, rate-limit recovery, page/snapshot failure preservation, explicit oversized refusal, isolated replacement, concurrent 202/409 results, held stale browser preflight, two-account isolation, ownership transfer during provider fetch, future-clock revocation, process restart and 1440/390/320px layouts. Source-store tests passed against both PGlite and standalone PostgreSQL. Native receipt and exact file hashes: docs/qa-packets/spotify-sources-20260916/native-flow.json.

Spotify responses were simulated by a test-only preload. Real Spotify calls: zero. This is not provider OAuth, actual Spotify permission, or physical-player acceptance. Generated passwords/cookies/local verification links are not in the committed receipts. Test runner logs remain in the owned temporary workspace; they are not production logs or public evidence.

## Changed but unverified work
No later unverified runtime/test changes are included in this handoff. The separately scoped Sources design is not integrated into this candidate. A complete live-source connection and signed-in production journey remain unproven.

## Tests/evidence invalidated by later changes
The prior #248 proof at 942e31f was superseded by this runtime candidate, not used as proof of these new changes.
The new browser test first failed on a Windows absolute --import path, then exposed the real 100-row library limitation. The file URL bootstrap and application paging were fixed, and the strengthened browser/database proof passed; neither failed attempt was relabeled a pass.

## Separate design review / #247
Exact design candidate 1f381c890219a3808018e7485360460b30a37c18 remains unchanged. Its actual empty 1440px/mobile 390px and populated 1024px component images received visual inspection. Navigation, library-first ordering, primary add-music actions, player column and wrapping were inspected. Fixture captures omit the outer TalentApp brand header. This is not owner premium-design acceptance or review of all application screens.
A fresh Windows run hit a 15-second first-page load timeout at 1440px; its four remaining widths passed. An unchanged warm retry passed all five widths. Preserve both results; the retry does not establish cold-load reliability. The prior hosted technical acceptance is separate. Exact cold/warm records and inspected-image hashes: docs/qa-packets/spotify-sources-20260916/design-review.json.

## Known blockers/risks
- #247 and this functional branch need integrated acceptance, including the actual TalentApp shell. Both change the Connections contract; preserve every assertion and new scenario, not one file wholesale over the other.
- The design test's first cold navigation timed out locally; no timeout or gate was weakened. Account for cold startup in the combined test environment and preserve failure propagation.
- External provider account linking/permissions, provider-native playback targets and physical source feedback remain unfinished. Imports are not connected playback. The source/player owns the audio.
- Library paging is bounded to avoid infinite reads; excessively large/inconsistent reads fail explicitly instead of presenting a partial list as complete. Separate stored-audio catalog paging is not claimed fixed.
- Broader Self-Production, memberships, payments and other product work are outside this slice.

## External side effects and retry safety
Only development branch #248 was pushed. No main update, production deploy, real provider call or production database write occurred in this work. Local disposable accounts/databases and test fixtures were used. Native database process stopped. Dependencies were installed in owned temporary directories; no canonical local checkout was reset. The final docs/receipts are a fast-forward commit after the tested runtime. No Render environment was changed this turn.

## Next exact action
Combine the six reviewed #247 UI/test files with the verified #248 functional work in one integration candidate, preserving both Connections test additions. Run the actual Sources journey through the combined TalentApp shell at desktop/mobile sizes and verify import, replacement, error recovery and player setup remain accessible. Perform focused changed tests first, then one exact lint/build/contracts integration gate. The combined result remains separate from explicit production merge/deploy authorization and subsequent production verification. Continue real provider/player integrations from the source/target architecture after this Sources release slice; do not equate playlist metadata with provider playback control.

## Actions that must NOT be repeated
Do not restart a repository-wide audit, merge the mixed #243 payout/collaborator stack, rerun this unchanged runtime's full gate merely to copy receipts, recreate hosted proof infrastructure, weaken failing checks, call fixture provider replies live integration, claim the design and functionality are already combined, or push main without the release decision.
