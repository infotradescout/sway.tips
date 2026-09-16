# Spotify import integrity — isolated continuation

## Resume checkpoint

Objective: prevent incomplete Spotify playlist metadata from replacing saved music while keeping playback source-owned and preserving the independent Sources design work.

Base branch/commit: main / a1ea2ac3613bb5410879410fdc87d6ab93ac2e95.
Current branch: fix/sway-spotify-import-integrity-20260916.
Runtime candidate: 946f6da156a3738581045d8a45b3cb0ab4fd68ae.
Runtime tree: faf224a41be23126293de1cf254f10d2c835f972.

## Implementation and provenance

Recovered these exact blobs from the mixed PR #243 head 6d37f43686087713e445d520a7e9f60346bd961b, not that branch or its server/schema changes:

- src/server/spotify-catalog.ts — b2f60490406d4d537dbe8aeea0ba3ff3e98232fc.
- src/spotify-playlist-reference.ts — 2acffc5c5378bb3d58eaa81af1c7dd55fce96f68.
- scripts/sway-spotify-catalog.behavior.test.ts — 67736f8e6adaa3a4a886aab6d9ca75fb8baef7b4.

The reader follows all pages within the requested bound, checks totals/offsets and the playlist snapshot, deduplicates stable track IDs, distinguishes unavailable/local/episode entries from malformed responses, validates playlist and next-page identities, refuses credential-bearing redirects, bounds requests/operations, refreshes a rejected token once, and returns no import batch on an incomplete fetch.

Added scripts/sway-spotify-current-route.behavior.test.mjs. It extracts the actual Spotify POST callback from server.ts using the TypeScript AST and invokes it with the real imported reader and synthetic provider/access/persistence boundaries. Eight scenarios prove access/ownership rejection, deceptive URL rejection, first-page truncation rejection, later-page failure rejection, changed snapshot rejection, refusal above the current route ceiling, and exactly one deduplicated successful replacement. This is callback-boundary proof, NOT authenticated HTTP or native PostgreSQL proof for this endpoint.

Registered both Spotify suites inside the existing scripts/sway-performer-connections.contract.test.mjs subprocess list. Original assertions, player helper tests and player browser cases remain. No package, dependency, schema, migration, server.ts, UI, payout or collaboration changes.

## Verified completed work at this checkpoint

Existing isolated Render service srv-daesln0u01pc73fso5kg was idle before reuse. Environment update started deploy dep-dalcdurm8hqs73933r10 on 2026-09-16 at 16:42:35 UTC; do not issue a second trigger for that update.

Launcher: 1d8c91f3bf5798be1ef700aa36775768f9e00af5. The original Sources launcher and all its phases were not modified.

Logs through 16:43:38 UTC show the candidate Connections contract passed:

- 26 named provider-boundary subtests passed (Node reports 27 including the enclosing test).
- 8 current-route subtests passed (Node reports 9 including the enclosing test).
- 24 retained player helper cases passed.
- 27 retained player-browser cases passed at 1440, 390 and 320 px.

Changed but unverified work: this checkpoint precedes completion of the remaining launcher phases. Read the exact deploy and source-evidence receipt before asserting full lint/build/contracts/native-browser success. No signed-in production, real Spotify account, real external player or screenshot acceptance was performed here.

Tests/evidence invalidated by later changes: none at this checkpoint; this file is documentation-only. Any later runtime/test edits require a new exact candidate identity and relevant revalidation.

## Important remaining caller work — release hold

This is a staged integrity slice, not a release-ready full Spotify integration.

1. server.ts still passes limit: 100. The helper supports a maximum of 1,000 but the current HTTP route refuses playlists above 100 rather than truncating them. Do NOT claim the user-facing route imports 1,000 tracks.
2. server.ts still ignores the reader's typed provider status. Import errors currently use the existing generic 422 response; Retry-After is not forwarded. The existing catalog-search caller also ignores typed errors and can report an empty open-catalog result instead of a useful recovery state. In particular, the new reader preserves configured=true on rejected credentials, whereas the legacy token-failure path could fall back to the library. This caller compatibility must be resolved before release; successful library tests do not establish correct search failure UX.
3. Source/account expectation receipts, transactional prepareSpotifyPlaylistSource, shared writer lock ordering, source updatedAt projection, and client confirmation from PR #243 remain unported. Failed fetches are blocked, but stale-tab/concurrent source replacement is not solved by this slice.
4. No provider OAuth/account lifecycle, Spotify remote playback/device selection, Apple Music/TIDAL/SoundCloud native integration, or physical source acknowledgement is added. Imports remain metadata and open-in-source actions.
5. PR #247's design branch design/sway-performer-sources-premium-20260916 at 1f381c890219a3808018e7485360460b30a37c18 remains untouched. Its separate visual review and release decision are not completed by this run. Both branches touch the Connections contract; preserve both sets of assertions when integrating, do not overwrite the design changes with this main-based file.

## External side effects and retry safety

Only a new development branch and the existing isolated static proof service were written. No production deploy, main update, provider transaction or live money action was triggered. No production database or provider credentials were attached. Updating proof service environment variables triggered its deployment automatically. Its public evidence URL is mutable: always check the candidate SHA, not merely a green page.

## Next exact action

Read deploy dep-dalcdurm8hqs73933r10 and its final source-evidence receipt; record each phase result. Then isolate the Spotify HTTP/client/source-store portion from PR #243 against the current main and the independent design branch, preserving the shared source writer lock order and ownership checks. Address catalog search error/fallback compatibility before a release candidate. Use focused provider, client and persistence checks during that work, then the mandatory lint/build/contracts gate at integration. Do not merge or deploy production without the separate release decision.

## Actions that must NOT be repeated

Do not merge all of PR #243, recreate a proof service, rerun a whole-repository audit, recount Node parent tests as extra scenarios, call this source playback integration, treat this proof as screenshot acceptance, or release this staged reader while its caller compatibility work remains open.
