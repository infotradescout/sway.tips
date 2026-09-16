> Superseded for continuation by docs/process/2026-09-16-sources-combined-release.md at runtime 7faaca0. This earlier packet is historical; the Sources design and functionality are now combined.

# Spotify import integrity — verified continuation checkpoint

## Objective

Prevent incomplete Spotify playlist metadata from replacing saved music, preserve useful search recovery, and keep playback source-owned. Preserve the independent Sources design work and do not import the unrelated payout/collaboration stack.

## Base branch/commit

main / a1ea2ac3613bb5410879410fdc87d6ab93ac2e95.

## Current branch/commit

Branch: fix/sway-spotify-import-integrity-20260916. Draft PR: #248.
Final tested candidate: 942e31f7cb670d945cf8118688c3b0a9eb75ca9d.
Final tested tree: 64b1152a91abb59d8491e9370b3e5cb7bc1b7f1b.
The final checkpoint update after that candidate changes only this document. It is not a new runtime candidate.

## Verified completed work

The Spotify reader follows every page within the caller's requested bound, validates offsets/totals and the playlist snapshot, deduplicates stable track IDs, rejects unsafe next-page URLs and redirects, bounds requests/operations, and refreshes a rejected token once. Incomplete, inconsistent or failed reads return no replacement batch. Removed, local and episode entries are handled separately from malformed data.

The current server.ts import callback was extracted with the TypeScript AST and executed against the actual reader. Eight scenarios prove access/ownership rejection, deceptive URL rejection, incomplete first-page rejection, later-page failure rejection, changed snapshot rejection, refusal above the existing HTTP ceiling, and exactly one successful deduplicated replacement. Failure scenarios never enter the replacement transaction or call track/source writers. Provider, access and persistence boundaries in this suite are synthetic; this is not authenticated HTTP or native PostgreSQL proof of the Spotify endpoint.

The existing search caller uses configured as an availability/fallback switch. A small entry adapter now preserves the performer-library fallback for rejected credentials, rate limits and invalid provider responses. A genuinely successful empty catalog remains an empty success. Actual credential configuration remains available separately through isCatalogSearchConfigured; the typed provider reader preserves configuration truth and is exported as searchSpotifyCatalog. Three new compatibility scenarios cover this distinction.

Both Spotify suites run inside the existing mandatory Connections contract, retaining its original assertions and player helper/browser cases. The capability contract now checks the relocated provider implementation and the stable entrypoint wiring separately; all former assertions remain, and forbidden token-storage/playback-claim checks cover both modules.

## Changed but unverified work

No unverified runtime or test edits remain after the final candidate's passing run. This is nevertheless a bounded import/recovery slice, not completed Spotify account integration or verified external playback. Signed-in production use, real Spotify accounts, physical playback targets, and human visual acceptance were not exercised.

## Files changed

- src/server/spotify-catalog-provider.ts
- src/server/spotify-catalog.ts
- src/spotify-playlist-reference.ts
- scripts/sway-spotify-catalog.behavior.test.ts
- scripts/sway-spotify-current-route.behavior.test.mjs
- scripts/sway-performer-connections.contract.test.mjs
- scripts/sway-music-source-capability.contract.test.mjs
- docs/process/2026-09-16-spotify-import-integrity.md

No server.ts, UI, schema, migration, package, dependency, payment, payout or collaboration changes are included.

## Provenance

Recovered the provider implementation unchanged from mixed PR #243 head 6d37f43686087713e445d520a7e9f60346bd961b. Its original spotify-catalog.ts blob b2f60490406d4d537dbe8aeea0ba3ff3e98232fc now resides at src/server/spotify-catalog-provider.ts. The playlist reference blob remains 2acffc5c5378bb3d58eaa81af1c7dd55fce96f68. The original 26 provider subtests came from blob 67736f8e6adaa3a4a886aab6d9ca75fb8baef7b4; their assertions remain, with the typed-search import updated and three compatibility scenarios added. The rest of #243 was not merged.

## Tests/evidence already run

Final isolated Render deploy: dep-dalckhijnfac73940nug.
Existing proof service: srv-daesln0u01pc73fso5kg.
Unchanged launcher: 1d8c91f3bf5798be1ef700aa36775768f9e00af5.
Report started: 2026-09-16T16:57:04.310Z.
Report finished: 2026-09-16T17:02:54.364Z.
Result: passed=true, trackedSourceUnchanged=true, productionMutations=false, providerTransactions=false.

All 16 setup/validation phases passed with exit code 0, no interruption and no timeout:

1. clone
2. fetch
3. checkout
4. install
5. parsers
6. confirmed-import-helper
7. existing-dj-importers
8. connections-contract
9. lint (npm run lint)
10. build (npm run build)
11. chromium
12. native-postgres-install
13. native-launcher-failure-regressions
14. sources-browser-native-persistence
15. contracts (npm run test:contracts)
16. room-account-scope-browser

The Connections phase includes 29 named provider/search scenarios (26 retained plus 3 compatibility cases), 8 actual-route callback scenarios, 24 retained player helper cases and 27 retained player-browser cases at 1440, 390 and 320 px. Node reports 30 and 9 tests for the Spotify suites because each includes an enclosing parent; do not count parents as additional independent scenarios.

The 13 native Sources browser checks used owned loopback PostgreSQL 18.4 on port 25439. They verify actual file-import API persistence, isolated sources, replacement cancellation, multiple export formats, path privacy, reload/restart survival, cross-performer isolation, and desktop/mobile viewport bounds. They made zero provider calls and do not establish native Spotify endpoint/account proof. Screenshots were generated but not visually reviewed.

## Tests/evidence invalidated by later changes

The first candidate 946f6da156a3738581045d8a45b3cb0ab4fd68ae passed all 16 phases in dep-dalcdurm8hqs73933r10, but was superseded by the search compatibility work.

Candidate 55661874cbbf464e41c7bafc4d458e7f0d371095 passed 15/16 phases in dep-dalch865vjqs73et6eb0. Full contracts correctly failed because the existing capability contract still searched the entrypoint for implementation text after that implementation moved to the provider module. Candidate 942e31f corrected that file target, added explicit entrypoint wiring assertions and expanded safety checks without weakening the old requirements. Its complete passing rerun is the current evidence. The failed attempt is not a pass and is not hidden by the earlier receipt.

A later runtime/test edit invalidates this exact candidate's proof for that changed area. This final documentation-only update does not change runtime or test files.

## Known blockers/risks and remaining implementation

1. The unchanged HTTP import route still passes limit: 100. The helper supports at most 1,000, but the user-facing route currently refuses an oversized playlist rather than truncating it. Do not claim user-facing 1,000-track import.
2. Typed import error/retry information still needs HTTP/client wiring; the current import route uses its existing generic errors and does not forward Retry-After. The search fallback regression is fixed by the adapter, not left open. When migrating the search HTTP caller to typed outcomes, use searchSpotifyCatalog rather than assuming legacy searchCatalog exposes status.
3. Source/account expectation receipts, source updatedAt projection, prepareSpotifyPlaylistSource transaction guards, shared source-writer lock ordering and explicit client replacement confirmation from #243 remain unported. Failed-fetch protection does not solve stale-tab or concurrent successful replacement races.
4. No OAuth/account lifecycle, Spotify Connect/device controls, Apple Music/TIDAL/SoundCloud native connector, or physical source acknowledgement is added. Playlist imports remain metadata and open-in-source actions.
5. PR #247's design branch design/sway-performer-sources-premium-20260916 at 1f381c890219a3808018e7485360460b30a37c18 was not changed. Its visual review and release decision remain separate. Both PRs touch the Connections contract; preserve both sets of assertions when integrating rather than overwriting design checks with the main-based file here.

## External side effects and retry safety

Only this development branch/PR and the existing isolated static proof service were written. No main update, production deployment, production database mutation, provider transaction or live-money action was triggered. No production database or provider credentials were attached. No new infrastructure was created. Environment updates automatically triggered their proof deployment; do not issue a duplicate trigger.

The proof service's public source-evidence.json and screenshot paths are mutable when that shared service is reused. Check candidate SHA and deploy identity, not a green page alone. Earlier #247 artifacts on the shared host are not guaranteed to remain available. The current proof is not a release authorization.

## Next exact action

Continue from #248's verified branch, not a new audit. Isolate the source-only HTTP/client/source-store portion from #243: migrate source receipts and ownership/version guards together, preserve performer -> source/track lock order across writers, and wire clear retryable errors and explicit replacement confirmation. Update the public import ceiling only alongside those validated caller changes. Use focused provider/client/persistence checks while implementing, then mandatory lint/build/contracts at the integration checkpoint. Reconcile #247's Sources assertions without removing either test set. Release remains separate from this development proof.

## Actions that must NOT be repeated

Do not merge all of #243, recreate a proof service, restart a whole-repository audit, rewrite the unchanged validation launcher, count enclosing tests as scenarios, claim metadata import is external playback control, claim generated screenshots were visually approved, reuse an older green receipt for a new candidate, or deploy production from this staged continuation without the release decision.
