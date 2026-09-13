# Private candidate return implementation — 2026-09-13

Decision: implemented a bounded private return and owner review workflow for review. Deployment and capability activation remain off. This is not a claim that all Self-Production features, or Sway as a whole, are complete.

Business goal: a creator selects one immutable source file, requests one revision from an existing connected account, receives technically verified private bytes, and explicitly accepts, rejects or blocks that candidate. Acceptance adds a new private working version while retaining the original and collaborator provenance. It does not select a recording master, publish a release or establish rights clearance.

## Integration provenance

The worktree branch is `implement/sway-collaborator-revisions-20260913`, based on `4dceb0110ddc9186ad0372fa977bc96b89eeaa18`. It selectively applies candidate intake and provider durability from PR203 commits `d5041c5` and `5fb6cd9`; it does not merge the divergent PR203 branch. The current source-listening route, catalog recovery controls, release creation disclosures and release reports are retained. Root checkpoint `cf5373dfd89faad32dd64d640b4f6e34af0a3000` supplies the unchanged `0052` snapshot, completion-progress evidence, hard-gate normalizer, disposable database guard and direct command chain.

The added owner decision, administrative capability enrollment, private candidate range response, preflight and incremental client hashing extend the older candidate intake implementation. Unrelated capability/profile/discovery waves were not imported.

## Persistence and authority

| Migration | Purpose |
| --- | --- |
| `0053_audio_collaboration_capability` | Minimal immutable performer capability decisions and persisted actor validation; no automatic grants. |
| `0054_audio_candidate_revisions` | Exact-source candidate and purpose-bound upload/grant records. |
| `0055_audio_object_cleanup_receipts` | Durable object cleanup receipts. |
| `0056_audio_candidate_authority_hardening` | Creator byte ceilings, current issuer authority and legacy authority revocation. |
| `0057_audio_provider_operation_durability` | Immutable provider intent, attempts, recovery, leases and fencing. |
| `0058_audio_candidate_owner_decisions` | Terminal owner decisions, exact acceptance/version binding and candidate moderation protection. |

All previously deployed SQL migrations remain unchanged. New metadata snapshots follow the current schema; generation after `0058` produces no additional migration statements. The deferred acceptance foreign key and trigger enforcement remain SQL-owned.

The collaborator needs the active connection, exact selected-file upload grant, current issuing authority and current performer collaboration capability. The upload grant gives no ordinary download, review, release, project upload or master replacement authority. The creator approves a byte ceiling and finite upload period. Each provider mutation uses a persisted intent; ambiguous completion remains pending until durable evidence is available.

Only the current performer owner with active project management and upload authority can decide a candidate. Acceptance also requires current collaboration capability and no current moderation hold or block. The database binds the accepted decision to the exact candidate digest, bytes, object, source, session and new version. Rejected and blocked decisions are terminal. A block applies to that candidate, not to an entire account. Only persisted administrators can clear candidate moderation holds.

Administrative enrollment uses the existing persisted administrator guard and records an explicit grant/revoke reason and idempotency key. It cannot activate the deployment flag. `SWAY_AUDIO_COLLABORATOR_REVISION_UPLOAD_ENABLED` defaults to `false`; no environment, live provider or production capability was activated during this work.

## Routes and user behavior

The changes add or extend:

- Creator candidate request under `/api/talent/audio/pairing/connections/:connectionId/candidate-revision-grants`.
- Read-only preflight, initiation, bounded multipart parts and completion under `/api/talent/audio/file-grants/:grantId/candidate-uploads`.
- Private candidate content under `/api/talent/audio/file-grants/:grantId/candidates/:candidateId/content`.
- Owner disposition at `/api/talent/audio/candidates/:candidateId/decision`.
- Administrative capability decisions at `/api/admin/performers/:performerId/private-collaboration-capability`.

Binary-part authority is checked before body parsing and again during the durable write. Preflight checks scope, MIME, byte ceiling and storage before hashing; initiation independently checks and reserves the actual hashed intent. Client hashing reads at most 1 MiB per chunk, yields, reports progress and supports cancellation. Responses reporting HTTP 202 are shown as pending rather than sealed success.

Private inbox requests may supply `X-Sway-Expected-Account-Id`; a mismatch with the authenticated actor fails before service use. Client operations validate account context before and after response reads, bound waiting through JSON parsing, ignore late abort-insensitive responses and clear private state on access loss. Creator request controls require the selected project to be in the server-returned enrolled project list; recipient upload availability is separate.

Candidate listening supports exact byte ranges and seeking. It rechecks access and moderation after storage opens, owns stream failures, closes streams on aborted responses, and sends private, non-cacheable responses. Source listening retains its existing selected-version download permission boundary. An accepted candidate and its new private version share one preserved object and consume storage quota once. Later candidate holds also deny ordinary owner reads, selected shares, listening, token downloads and release use through the immutable acceptance binding. Post-open moderation failures destroy the opened stream. Connection revocation can persist pending cleanup receipts and respond even when no object-store client is configured; it never claims provider cleanup completed in that condition.

## Validation evidence

The following focused commands passed in the implementation environment:

```text
npm run db:check
node scripts/sway-database-schema.contract.test.mjs
node scripts/sway-contract-gate-normalization.contract.test.mjs
node scripts/sway-disposable-database-guard.contract.mjs
npm run lint
npm run build
node --import tsx scripts/sway-audio-upload-client.behavior.test.ts
node --import tsx scripts/sway-audio-listening.behavior.test.ts
node --import tsx scripts/sway-audio-candidate-revisions.integration.test.mjs --embedded-postgres
node --import tsx scripts/sway-audio-candidate-decisions.integration.test.mjs --embedded-postgres
node scripts/sway-audio-candidate-decision-proof-mode.contract.test.mjs
node --import tsx scripts/sway-audio-collaboration-capability.integration.test.ts
node scripts/sway-audio-candidate-migration-upgrade.integration.test.mjs
node --import tsx scripts/sway-audio-candidate-grant-concurrency.integration.test.mjs --embedded-postgres
node --import tsx scripts/sway-audio-provider-operation-durability.integration.test.mjs
node --import tsx scripts/sway-audio-provider-process-kill.integration.test.mjs
node --import tsx scripts/sway-collaborator-revision-http.integration.test.mjs
node --import tsx scripts/sway-audio-file-collaboration.integration.test.mjs
node --import tsx scripts/sway-audio-storage-policy.integration.test.mjs
node scripts/sway-audio-durable-storage.integration.test.mjs
node scripts/sway-candidate-inbox.behavior.test.mjs
node scripts/sway-collaborator-inbox.contract.test.mjs
node scripts/sway-audio-file-collaboration.contract.test.mjs
node scripts/sway-audio-storage-policy.contract.test.mjs
node scripts/sway-audio-publishing-foundation.contract.test.mjs
```

Disposable database commands ran with the test guards required by each script. The migration-upgrade proof applies the current populated baseline through all 59 migrations and checks preserved source identities, authority and cleanup receipts. Candidate and decision proofs exercise forged writes, wrong actors/scopes, revoked authority, exact immutable bytes, replay conflicts, moderation, no project grants and unchanged physical storage usage. The HTTP test runs the actual Express server and compares exact candidate range bytes. The process-kill proof terminates and restarts separate application processes around provider initiation, part and assembly boundaries using local storage.

The first default `npm run test:contracts` attempt exposed a decision-test invocation bug: its internally owned fixture still required ambient `SWAY_DISPOSABLE_MIGRATION_PROOF=1`. The registered command now explicitly selects `--embedded-postgres` and rejects generic or real database URLs and strict PostgreSQL selection before fixture setup. The normalizer permits this exact reviewed flag only for this script; shell prefixes, aliases and arbitrary arguments remain denied. Pure negative fixture-intent checks and the unchanged disposable-target guard pass. Standalone PostgreSQL still requires its original opt-in, reset approval, target guards and server attestation. The repaired full command ran without added environment settings and passed every new candidate gate plus the existing non-browser gates preceding the first browser test. It exited 1 at `sway-profile-payout-options.browser.test.ts` because Playwright's default Chromium executable was absent; later gates were not reached. The default invocation bug is repaired, while the full gate remains blocked.

Embedded PostgreSQL serializes database clients; its competing-call checks do not prove standalone PostgreSQL lock contention. The R2 adapter suite uses deterministic provider responses. No live R2, production migration, two-account browser journey or deployed activation is claimed. Earlier attempts with the separately installed pinned Chromium binary failed with SIGTRAP in this environment; it was not soft-passed or repeatedly relaunched. The complete `test:contracts` chain therefore has no all-green claim. Candidate commands are registered directly in that hard chain, preserving nonzero failure behavior.

Independent bounded review found no concrete blocker in the owner acceptance binding, admin capability authorization/replay, preflight versus reservation, binary-parser boundary, candidate range authorization or stream handoff. Root review additionally identified stale inbox account results, missing request deadlines, guaranteed-denial creator controls, database-only revocation and post-acceptance moderation aliases. The coordinated repairs bind requests to the selected account, use deadlines covering response bodies, reject malformed list data, derive creator request availability from enrolled project IDs, preserve database-only revocation with pending cleanup receipts, and propagate candidate holds through accepted-version reads and release use. The final focused UI suite passes 38 actual React/JSDOM checks, including account changes, abort-insensitive late results, body deadlines, malformed lists and project-scoped request availability. Focused regressions cover the backend boundaries; final integrated validation is recorded in the parent handoff.

Money behavior and AI authority: unchanged. Public release reads and readiness now suppress a release that uses a promoted candidate master while a later candidate moderation hold or block is active. This is a scoped enforcement change; it activates no publication or distribution capability. App Store readiness: no new claim. Moderation changes are limited to private candidate decisions and holds/blocks.

Rollback: retain additive schema and immutable evidence, keep the feature disabled, and revert coordinated runtime/client changes if necessary. Do not delete accepted version or candidate records as a rollback. Next external proof: authorized standalone PostgreSQL contention and migration test, real two-account browser workflow, and scoped private R2 recovery verification. These do not authorize a merge, deployment or money activation.

Commit SHA: none created by this slice. Root owns the reviewed commit and any remote publication. Working tree contains staged implementation and proof changes pending final root integration.
