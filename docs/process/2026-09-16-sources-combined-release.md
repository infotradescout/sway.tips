# Combined Sources candidate — verified handoff

## Objective
Give performers one Sources screen for adding and safely replacing request music, finding saved songs, and reaching the correct room/player setup. Playback remains source-owned.

## Base branch/commit
Main baseline: a1ea2ac3613bb5410879410fdc87d6ab93ac2e95 (Git ref, not a new production observation). Functional continuation: #248 at 7d88edfa39445ef541b1806534524e3a404bb77a. Reviewed design source: #247 at 1f381c890219a3808018e7485360460b30a37c18.

## Current branch/commit
Branch: fix/sway-spotify-import-integrity-20260916, PR #248. Tested and pushed runtime: 7faaca0b65afb75bb1dc51444916fe070daf0127. Tested tree: 7050d3b417fb88d990f68914f2b3de70f25d2841. The evidence/handoff commit after this runtime contains only documentation and screenshots. Owned local checkout: C:\Users\flavo\AppData\Local\Temp\sway-sources-flow-20260916.

## Verified completed work
- Integrated all six #247 UI/test changes into #248 rather than leaving separate functional and visual candidates. The shared Connections contract retains all eight existing runners and now also requires the design suite. #247's original branch was not rewritten.
- Retained guarded 1,000-item Spotify imports, explicit replacement consent, source-version/ownership checks, failure preservation, retry guidance and coherent external-library paging from the previously verified functional work.
- New full-app browser coverage includes the actual TalentApp brand header, navigation, keyboard-opened import picker, native file chooser and library-first layouts at 1440/390/320px.
- Verified the full Sources-to-room path: create an actual free room, return to Sources, cancel preparation without issuing a token, confirm exactly one scoped room file, verify downloaded bytes against its server digest, and leave playback disabled with zero command POSTs when no device reports state. The downloaded launcher is never executed by this proof.
- Visual inspection exposed the active-room heading incorrectly labeling account Sources as Tonight's Live Room. Fixed only the two relevant shell visibility conditions; empty, saved and active-room Sources now assert that heading is absent.
- Spotify copy now describes the current 1,000-song limit and request-library behavior, not an internal existing-importer implementation.

## Files changed in runtime
scripts/sway-performer-connections.contract.test.mjs; scripts/sway-sources-workspace-design.browser.test.mjs; scripts/sway-spotify-sources.browser.test.mjs; src/components/PerformerSourceImportChoices.tsx; src/components/PerformerSourcePlayerSetup.tsx; src/components/TalentDashboardWithSources.tsx; src/performer-workspace.css; src/shells/TalentApp.tsx.
No server, provider adapter, schema, migration, package/lockfile, payment, payout or membership code changed in this integration commit. Earlier #248 server/library changes remain included in the branch.

## Tests/evidence already run
Exact runtime 7faaca0b65afb75bb1dc51444916fe070daf0127 passed npm run lint, npm run build and the complete npm run test:contracts. Each exited zero with no signal/timeout, and source remained unchanged. Gate finished 2026-09-16T18:53:42.741Z. Existing locked dependencies were reused; package and lockfile did not change, and a new npm ci run is not claimed.

The separate standalone PostgreSQL 18.4 run passed all 15 signed-in application checks, finishing 2026-09-16T18:40:00.666Z. It includes real account creation, HTTP/database persistence, a 251-track import and later-page Requests search, cancellation, failed page/snapshot/rate-limit recovery, concurrent 202/409 results, held stale browser preflight, two-account isolation, ownership changes during fetch, future-clock revocation, restart, actual room setup, launcher verification and offline controls. Spotify responses remain simulated: 21 fixture replies, zero real Spotify calls. No production database or provider account was used.

All five design cases at 1440/1024/768/390/320px passed in the full gate. The design fixture is now compiled with Vite before previewing built assets, rather than including dev dependency compilation in its first page navigation. All original interactions/assertions remain and the 15-second per-page deadline is unchanged. No automatic case retry or soft pass was added. This is fixture reliability evidence, not an Internet/production load-speed claim.

Evidence: docs/qa-packets/sources-combined-20260916/combined-evidence.json and final-gates.json. Immutable, visually inspected full-app desktop/mobile captures are stored beside them. They show disposable test users, not production users, and are not generated concept images or independent human design approval.

## Changed but unverified work
No unverified runtime/test edits follow the passing candidate. Production deployment, production changed-path smoke, real Spotify authorization and physical-player playback remain unperformed. A tested Sources workspace is not a claim that every provider integration or the whole Sway product is complete.

## Tests/evidence invalidated by later changes
The earlier separate #247/#248 proofs remain historical, not proof of this combined runtime. A first extended native attempt failed because a test used an exact button name while its accessible name includes descriptive text; the selectors were corrected and the complete journey rerun. An intermediate native pass preceded the visual heading fix and was superseded by the final 15-check native run above. Previous cold dev-fixture failure remains recorded in the earlier design-review packet; replacing that harness with built assets does not retroactively make the old run pass.

## Known blockers/risks
Production merge/deploy requires explicit owner authorization under RELEASE_CONTROL.md. Real provider account lifecycle and physical source feedback remain separate unfinished integration work. Broad product/paid-money activation is not authorized by this candidate. #247 must not be independently merged over the combined Sources branch; its work is already incorporated.

## External side effects and retry safety
Only #248 development commits and review metadata were written; no main push or production deploy occurred. Owned disposable databases, accounts and browser downloads were used; the native database process exited successfully. Render configuration and provider credentials were not changed. Retained temporary artifacts are not uncommitted application work. Source-of-truth evidence is now in Git, not a mutable shared proof host.

## Next exact action
Use the combined #248 candidate for review and the explicit Sources merge/deploy decision; do not repeat integration. After authorization, confirm the current main/PR heads, merge without bypassing owner restrictions, allow the configured deployment, verify exact build-marker/release-health/migration state, and perform changed-path production smoke before claiming it live. Continue native provider/player work separately without presenting metadata import or a generated launcher as successful playback.

## Rollback boundary
There are no new migrations in the Sources branch. A coordinated code revert of the authorized Sources release is the rollback path, not database deletion or resetting unrelated main commits. Saved source rows remain; older UI code can restore the former first-page limitation. Verify the exact rollback/roll-forward build and recheck source isolation after any corrective release.

## Actions that must NOT be repeated
Do not restart a repo-wide audit, combine #247 again, remove either test set, rerun this unchanged full gate just to copy receipts, merge the mixed #243 payout/collaborator stack, claim a physical player was connected, or push main without the separate production authorization.
