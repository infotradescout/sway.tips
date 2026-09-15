# Sources player setup — 2026-09-15

## Authoritative resumption checkpoint

Objective: Make the existing player setup and playback controller reachable from Sources, preserving saved-library imports and the external player's ownership of audio. This is a bounded repair, not completion of the full provider-integration requirement.

Base branch/commit: `implement/sway-collaborator-revisions-20260913`, `e60382d0797311aacdb1dbaa645618a4b0f78b84` (PR #244).

Current branch/commit: `implement/sway-sources-player-setup-20260915`, draft PR #245. Exact accepted runtime/test candidate: `b88ba3ac452ad28e4618b8034df8e0c8103afdce`. Complete tested tree: `4ae95b4bc3859618e4be419bc6d925f0519d9db5`. This later documentation-only update does not change the tested application or test files.

Verified completed work:
- Sources mounts the existing VirtualDJ connection preparation route and existing playback controller; it no longer requires finding setup in Room Tools.
- Account and selected-room context come from TalentApp through composition of the original dashboard. No second account/room store or polling loop was added.
- Preparing a connection requires a confirmed active room and explicit confirmation that any existing booth connection will be replaced.
- File checks enforce exact room/filename/MIME, bounded base64, expiry and SHA-256 before a user-triggered Windows download.
- Prepared credentials remain in component memory. Account, performer, room, readiness and preview changes abort and discard obsolete responses. Deadlines cover response bodies, including abort-insensitive transport behavior.
- Sources selects the same visible, approved, amount-ordered queue as the live dashboard. Browser assertions prove that Load top excludes pending/hidden/removed entries, preserves exact request and track identities, and addresses the explicitly selected deck.
- Existing imports, Spotify playlist metadata, Sway uploads and one-way MIDI behavior remain intact. A prepared file is not labeled a connected player.

Changed but unverified work: No unverified runtime or test edits remain after the exact isolated acceptance below. Independent review, visual screenshot review, real VirtualDJ/plugin/device behavior, additional provider/native connectors and production release remain unproven. The new connection/controller browser responses are synthetic, not evidence that audio played on a physical device.

Files changed:
- `src/components/PerformerSourceImportChoices.tsx`
- `src/components/PerformerSourcePlayerSetup.tsx`
- `src/components/TalentDashboardWithSources.tsx`
- `src/source-player-context.tsx`
- `src/source-player-setup.ts`
- `src/shells/TalentApp.tsx`
- `scripts/sway-source-player-setup.behavior.test.ts`
- `scripts/sway-source-player-setup.browser.test.mjs`
- `scripts/sway-performer-connections.contract.test.mjs`
- `scripts/sway-role-route-separation.contract.test.mjs`
- This checkpoint.

Tests/evidence already run: Isolated Render deployment `dep-dakso8bm8hqs73ei3hp0` tested exact candidate `b88ba3ac452ad28e4618b8034df8e0c8103afdce` on Node `v24.14.1`. Verification finished `2026-09-15T23:00:25.655Z`; the static evidence deployment finished successfully at `2026-09-15T23:00:29.759913Z`.

| Required phase | Result |
| --- | --- |
| Clean locked dependency installation | PASS |
| Pinned Chromium installation/availability | PASS |
| `npm run lint` | PASS |
| `npm run build` | PASS |
| Complete `npm run test:contracts` | PASS; exit 0, no timeout or signal |
| Final source identity and file-hygiene checks | PASS |

The mandatory Sources gate includes 24 helper behavior cases and 27 actual React/Chromium scenarios at 1440, 390 and 320 pixels, including the final exact-request/deck assertions. The unchanged 29-case account-read suite and existing database-backed Sources browser/import/restart checks also ran in the complete mandatory chain. No case or gate was converted to a soft pass. The mandatory phase output SHA-256 is `ffa790e06c238b1ff9c083ac1b8c4357121de6bd26024a583d6fd5a3cf30e135`.

Evidence locations:
- `https://sway-sources-player-proof-20260915.onrender.com/summary.json`
- `https://sway-sources-player-proof-20260915.onrender.com/sources-player/results.json`
- Synthetic browser screenshots accompany the Sources report. Their generation and overflow assertions passed, but this session could not fetch them for a separate visual review.

Tests/evidence invalidated by later changes: None after the accepted `b88ba3ac` runtime/test candidate. This checkpoint is documentation-only. Earlier `7fb1ddcf3127ad71631c440aa06f16e9934107ab` also passed the complete gate, but was superseded by the queue-parity repair and stronger Load top assertions; use the final receipt above instead.

Known blockers/risks: This slice adds no new Spotify, Apple Music, TIDAL or SoundCloud authorization/native adapter. The Windows launcher remains the existing room-scoped connector; the Node path is explicitly advanced, not a one-click Mac installer. Its existing server issuer replaces a room bridge credential, so ambiguous preparation must not be retried automatically. A prepared file or accepted POST does not prove a connected player or audible playback. This branch is stacked on #244 and must not be presented as permission to release the entire unrelated collaborator dependency stack.

External side effects and retry safety: Only a draft GitHub branch/PR and the dedicated isolated static proof service were created/updated. No production service, customer data, real provider credential, source subscription, customer payment or payout was changed. Proof service `srv-daks4lajnfac73fofkr0` is in authorized `My Workspace` (`tea-d191jph5pdvs73drglkg`), auto-deploy off, without an application runtime, database or provider credentials. Updating its expected-SHA environment value automatically starts a build; do not also trigger a duplicate deploy. The application sends one token-preparation POST only after explicit confirmation; cancellation sends none and uncertain results are not automatically retried.

Next exact action: Resume from final candidate `b88ba3ac` and PR #245, not from an older failed run. Complete the bounded independent/visual review and determine the Sources-only integration/release delta against current main rather than blindly merging #244. Continue the actual source/player requirement: account authorization, authorized library synchronization, explicit playback target, supported controls, observed source feedback and reconnect behavior, with real provider/device proof. Full integrations remain the objective; do not redirect this work to collaborator uploads or count exports as provider integrations.

Actions that must NOT be repeated: Do not restart the repository/feature audit; rerun full gates only for meaningful invalidating code changes or the final integration candidate, not this documentation update. Do not retry the unavailable local network clone, offline desktop or blocked proof-image fetch. Do not create another proof service. Do not change the original isolated full-gate launcher or weaken its self-test. Do not claim production, physical-device, provider-permission or whole-product completion from this receipt. Do not merge to main, deploy production or activate providers/money without the required separate authorization.

## Resolved validation failures

- The initial helper denial mock used an invalid TypeScript cast; it now uses a native Response.
- An unnecessary standalone contract was rejected by the normalizer; it was deleted and its checks run directly inside the existing registered Sources contract. The normalizer was not weakened.
- Changing the shell's dashboard import path bypassed the existing account-test boundary. Composition now retains the original imported dashboard, and all 29 existing account-read cases passed unchanged.
- An attempted preflight extension conflicted with the isolated runner's self-test. The runner was restored byte-for-byte to parent blob `30a118ef8eb6f9b5f5c975307d50fe10a478bd8b`.
- The role-separation contract hard-coded the old local import alias. It now verifies the same original component import plus explicit composition and prop/room-guard forwarding; all other route and ownership assertions remain.
- Sources queue derivation was aligned with the canonical live queue and the browser proof strengthened to exercise Load top and explicit deck selection.

Rollback: Revert this coordinated runtime/test slice. No schema migration or production data rollback is introduced by it. Previously downloaded room files remain subject to the existing server token expiry/rotation behavior; deleting client code is not token revocation.
