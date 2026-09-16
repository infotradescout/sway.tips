# Independent Sources integration — accepted test candidate

## Resumption index

Objective: Let performers add requestable libraries and reach existing external-player setup and controls without waiting for unrelated collaborator or payout work. The music player continues to own audio. Imports remain fallback capabilities, not full provider integrations.

Base branch/commit: `main`, `e2c6a49b301f26237b83e8a403b4dae72bdbd621`.
Current branch: `implement/sway-sources-release-20260916`, PR #246, directly against main.
Exact tested candidate: `d1cf90aab06b31fea8cfc7b8a270e9f961a7e5cf`.
Exact tested tree: `103ef8e643dc15a10d2816bdf5dcb9c13e56f5e1`.
This subsequent checkpoint update is documentation-only.

Verified completed work:
- Expanded named library/setlist imports, original app-plus-export identity, explicit replacement consent and correct performer/source counts.
- Existing VirtualDJ setup and controller are reachable from Sources; room-file identity, SHA-256, expiry and room ownership are checked before download.
- Player setup retains explicit room/deck selection, approved-request ordering, cancellation and late-result rejection. No prepared file or MIDI dispatch is presented as confirmed playback.
- The original performer shell owns account and room selection. The outer account/performer/preview key clears obsolete dashboard instances without clearing same-account edits when switching rooms.
- The independent diff contains no collaborator revision implementation, migrations, payout logic, dependency updates, account-access rewrite or production settings. Main and PR #245 remain unchanged.
- Required library acceptance now executes its actual import, source-count, missing-browser failure propagation, VirtualDJ adapter and browser persistence checks. They are not merely unexecuted test files.

Changed but unverified work: No runtime/test change followed the exact acceptance below. Independent reviewer sign-off, separate visual inspection of generated screenshots, physical VirtualDJ/plugin proof, remaining provider/native connectors and production delivery are not established by this result.

Files changed: 27 paths. Runtime owners are `server.ts` (only the seven-line source-count join repair), `src/components/TalentDashboard.tsx` (only Sources/import/count UI and handler), `PerformerSourceImportChoices.tsx`, `PerformerSourcePlayerSetup.tsx`, `TalentDashboardWithSources.tsx`, `src/shells/TalentApp.tsx`, `src/source-player-context.tsx`, `src/source-player-setup.ts`, the existing DJ parser plus extracted legacy parser, music list/import helpers, and `scripts/lib/virtualdj-network-control.mjs`. The other changes are the Sources/role/library contracts, required parser/import/count/player/browser/failure tests, source strategy and this checkpoint. Exact PR file list is authoritative.

## Acceptance evidence

Existing isolated proof service: `srv-daesln0u01pc73fso5kg` (`sway-release-proof`).
Workspace: `tea-d191jph5pdvs73drglkg`.
Unchanged validation launcher: `8a9cd5a43f1b290447bd6e9fd621721ab7697592` on `audit/readiness-223-room-recovery`.
Deployment: `dep-dal3kv0ae00c73fer3sg`.
Validation finished: `2026-09-16T06:49:17.399Z`.
Static evidence deployment finished successfully: `2026-09-16T06:49:18.439255Z`.

All 16 launcher phases passed with exit code zero, no signal and no timeout:
1. Clone, exact fetch, checkout and clean locked dependency installation.
2. Expanded parsers, confirmed import helper and existing DJ importer regressions.
3. Sources connection contract, including 24 validation/recovery helper cases and all 27 React/Chromium setup/controller scenarios at 1440, 390 and 320 pixels.
4. `npm run lint` and `npm run build`.
5. Pinned Chromium and standalone PostgreSQL installation; seven finalization/failure subprocess cases.
6. Real authenticated Sources browser journey on standalone PostgreSQL 18.4, loopback port 25439: all 13 checks passed, including real account creation, separate exports, replacement/cancel, invalid-file preservation, second-account isolation, reload/search, server restart and responsive layout bounds.
7. Complete `npm run test:contracts`, including the required Sources acceptance and corresponding embedded-backend browser journey. Its newly required coverage includes the source-count endpoint and six actual VirtualDJ adapter behavior cases with synthetic transport.
8. Room/account-scope Chromium proof: 18/18 passed. The existing account-read cases also remain in the mandatory chain.

Final report: `passed: true`, `trackedSourceUnchanged: true`, `productionMutations: false`, `providerTransactions: false`.
Receipt: `https://sway-release-proof.onrender.com/source-evidence.json`.
Native and embedded browser evidence: `music-sources-proof/native/` and `music-sources-proof/embedded/` under the proof site.

Tests/evidence invalidated by later changes: None after tested candidate d1cf90aa; this handoff is documentation-only. Prior stacked PR #245 evidence was not used as acceptance of the extracted tree. Initial candidate 3ed1ba23 passed lint/build/full contracts but its additional standalone browser check failed on a competing navigation during server restart. That failure remained a failure. The corrected test parks the existing authenticated contexts on blank documents before restart and then explicitly re-enters Sources; it does not claim open-tab outage reconnection. No assertion was removed and the launcher was not modified.

The transport/device responses in player-controller tests are synthetic. PostgreSQL-backed imports are real application/database interactions against disposable local accounts, not connected commercial-provider accounts or production. Screenshots were generated and viewport assertions passed; public artifact retrieval was unavailable here, so separate visual inspection is still open.

## Release and remaining work

Known blockers/risks: This branch does not add new Spotify, Apple Music, TIDAL or SoundCloud account authorization or native adapters. The mixed-owner Spotify pagination/snapshot recovery from PR #243 is not silently included. Complete that as a subsequent source-specific integration, not by releasing unrelated collaborator/payout changes. Physical source playback, source permission/entitlement and production user-flow evidence remain distinct.

External side effects and retry safety: Only the independent GitHub branch/PR and the existing isolated proof service were updated. No production, customer, provider, schema or money settings changed. The proof service is auto-deploy off and accepts an exact candidate SHA; updating `SWAY_SOURCE_CANDIDATE_SHA` automatically starts its next validation. Do not also trigger a duplicate deploy. Production service `srv-d8iarnldt1ts73f4ia6g` was read only: it still uses main with commit-triggered auto-deploy and `/api/release-health` as its health check.

Next exact action: Review PR #246's independent Sources diff. Obtain Thomas's explicit authorization to merge this PR and accept the resulting Render production auto-deploy under RELEASE_CONTROL.md. After authorization, merge normally without an admin override; verify `/api/build-marker` and `/api/release-health` against the actual merged SHA and then perform authenticated Sources smoke. Preserve all provider/payment settings. Continue the remaining real provider/native connection work; do not divert to collaborator uploads.

Rollback/roll-forward: Current production/main base is e2c6a49b301f26237b83e8a403b4dae72bdbd621. This slice adds no migrations. Record the approved revert/rollback action if a production regression is detected; do not perform an unrequested rollback or treat reverting UI as revocation of issued credentials.

Actions that must NOT be repeated: Do not audit the whole product again, recreate a proof service, modify the validation launcher, release the collaborator dependency stack, or rerun full gates for this documentation-only checkpoint. Do not revive GitHub Actions as a gate. Do not retry the offline desktop or unavailable public artifact fetch. Do not claim whole-Sources completion, independent approval, live deployment, physical playback or new provider authorization from the passing isolated receipt.
