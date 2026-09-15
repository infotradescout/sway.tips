# Sources player setup — 2026-09-15

## Resumption index

Objective: A performer can reach the existing VirtualDJ connection setup and playback controller from Sources while retaining the expanded saved-library imports. Playback remains owned by the external player. This bounded change does not complete the wider source integration requirement.

Base branch/commit: `implement/sway-collaborator-revisions-20260913`, `e60382d0797311aacdb1dbaa645618a4b0f78b84` (PR #244).

Current branch/commit: `implement/sway-sources-player-setup-20260915`, runtime/test candidate `28eaf26e1145f96f2e89666d5d328e384b3d07da`, complete tree `3d9e6d9986f793298d8c1cf367f60a2a8e15e9ec`; draft PR #245. This document is a later documentation-only checkpoint.

Verified completed work: The actual Sources chooser mounts the player setup. Its context is derived from TalentApp's existing account and selected-room ownership, through a small higher-order component that preserves the original dashboard import boundary. The current runtime and tests passed focused hosted acceptance: 24 file-validation/recovery checks, 27 React/Chromium scenarios at 1440/390/320px, and the unchanged 29 performer account-read cases. Hosted lint and production build also passed. New browser API/device responses are synthetic; this is not physical-player evidence.

Changed but unverified work: The exact current candidate's complete mandatory gate is running in isolated Render deployment `dep-daksg28ae00c73au0ljg`. No full-gate pass, independent review, real-device acceptance, or production release is claimed at this checkpoint.

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
- This checkpoint.

Tests/evidence already run: On `e6694f86df4468c258444fa63f139554ebef0b26`, deployment `dep-dakseq67bikc738hfrsg` passed clean locked installation, pinned Chromium installation, `npm run lint`, the registered Sources contract including all 24 helper and 27 browser cases, `node scripts/sway-performer-account-reads.behavior.test.mjs` (29/29), and `npm run build`. Runtime and behavioral/browser tests are identical in current candidate `28eaf26`; only the isolated runner was restored to the parent's exact original blob `30a118ef8eb6f9b5f5c975307d50fe10a478bd8b`.

Tests/evidence invalidated by later changes: No application or behavioral/browser-test changes followed focused acceptance. The full isolated-runner result remains pending. Earlier failed runs must not be represented as passing full acceptance.

Known blockers/risks: New provider authorization/native adapters and real VirtualDJ/plugin/device execution are not implemented or proven by this slice. The Windows connector is an existing room-scoped launcher, not an installed cross-platform service. Node setup is explicitly advanced, not a one-click Mac installer. The server's existing token issuer replaces the room bridge credential; ambiguous issuance cannot be blindly retried. A fresh file is not evidence that its bridge has connected. Source status still comes from the existing controller's freshness and room/source validation. The branch remains stacked on #244; do not merge its entire dependency stack as an implied Sources-only release.

External side effects and retry safety: GitHub draft-branch/PR writes and one dedicated static proof service were created. No production service, customer account, real provider credential, source subscription, payment, or database was changed. Proof service `srv-daks4lajnfac73fofkr0` in the previously authorized `My Workspace` (`tea-d191jph5pdvs73drglkg`) is auto-deploy off, contains no application runtime, and rejects inherited provider/database credentials. Updating its expected-SHA environment variable automatically triggers a build; do not trigger a second deploy. Application token preparation requires explicit user confirmation before its one POST; cancel is read-only, and errors do not automatically retry.

Next exact action: Read the final result of `dep-daksg28ae00c73au0ljg` using this proof service's logs (Render labels these as `app`, not `build`). If the full gate passes, inspect the published synthetic screenshots/receipt, append exact final acceptance here and to PR #245. If it fails, resume at the first concrete failed test without re-auditing Sources. After bounded acceptance, continue the source integration requirement, including actual backend/player connection and device proof and additional supported provider/native adapters. Do not redirect to collaborator uploads.

Actions that must NOT be repeated: Do not restart the repository/feature audit; do not retry the unavailable local network clone or offline desktop; do not rerun already-passing focused suites without invalidating changes; do not create another proof service; do not change the full-gate launcher or weaken its self-test. Do not call file imports, prepared connection files, simulated acknowledgements, or passing tests completed provider integrations. Do not merge to main or deploy production without the required separate authorization.

## User behavior and safety

Sources keeps existing account-owned imports, Spotify playlist metadata and Sway uploads. The added player section offers room selection, VirtualDJ setup requirements, explicit replacement confirmation, a Windows room-file download, the existing advanced Node command, and access to the existing controller. MIDI is labeled one-way and cannot identify/load an exact track through that route.

Prepared files are checked for the exact requested room, expected filename and MIME, bounded valid base64, expiry and SHA-256. They and the optional private command stay in component memory, not local/session storage. Account, performer, room, preview or readiness changes remount the bounded setup session, abort pending reads and discard obsolete results. Deadlines cover response bodies and digest validation. Download checks expiry again at click time. A denial disables setup and requests the existing account refresh. No new server, schema, room lifecycle, payment, payout, moderation or publishing semantics are introduced.

The actual TalentApp change is its original dashboard import plus higher-order composition; it does not replace room selection or account reads. The 29 existing account-read tests remain unchanged and now run through that composition. The chooser's existing import controls remain intact. The Sources contract directly invokes all new behavior/browser checks and is still part of the original mandatory command chain.

## Failed attempts retained for traceability

- `5e064c3`, `dep-daks4lqjnfac73fofmbg`: production build passed; lint failed on a fake Response type assertion and the full gate rejected an unregistered new standalone contract. Fixed with a native Response fixture and direct integration of the checks into the already-registered Sources contract. No gate normalizer change.
- `610ae797`, `dep-daks84ajnfac73fovel0`: lint/build passed; existing account-read tests failed because the changed shell import bypassed their established dashboard boundary. Fixed by composing the original imported dashboard; no account-read assertions were changed.
- `e6694f86`, `dep-dakseq67bikc738hfrsg`: focused 24/27/29 checks and lint/build passed. The full chain rejected the new preflight runner behavior in its existing isolated-runner self-test. Restored the original runner byte-for-byte rather than rewriting or relaxing that self-test.

Rollback: Revert this coordinated runtime/test slice. No migration or production data rollback is required. Previously downloaded room files are governed by the existing server token expiry/rotation rules, not by deleting client code.
