# Current resume point: Sway reconnect local validation passed

Objective: Complete the direct-music reconnect repair on Sway only; preserve performer-controlled playback through the original source.
Base branch/commit: `implement/direct-music-control-20260916` at `988a7f44cde9b95e69898fa82f6e2646c09bbb76`.
Current tested source: `58a6fc0dc984176427c6261490732b16ca1544f0` (PR249). The commit adding this header changes only evidence/checkpoint documentation; runtime, tests and dependency hashes must remain equal to the tested candidate.
Verified completed work: Corrected the corrupted test label without changing its assertion. Reconnect state isolation and late old-authorization responses pass; all 18 complete direct-music browser checkpoints passed, including disconnect and approval-off cases. The full unchanged `npm run validate` passed all 128 top-level contract commands, lint, build and payment-pricing, 2026-09-19T22:42:30.179Z through 2026-09-19T22:58:42.966Z.
Conditional proof: The full gate retains its explicit active-room-registry database skip. The same-source registry supplement passed separately with zero skips, no timeout, no cleanup errors, and confirmed database/listener shutdown.
Files changed in the final checkpoint: this document, the QA README and `docs/qa-packets/direct-music-reconnect-20260919/full-validation.json`. The preceding test-label commit and focused browser receipt remain preserved.
Tests/evidence: `full-validation.json` is authoritative for the current local gate. It includes exact source/tree, runtime/test/dependency and log hashes, browser results and registry supplement. Historical failed `results.json` remains untouched.
Changed but unverified: No remaining failing local gate for this reconnect candidate. Genuine provider approval/grant, physical device/audio behavior, standalone database contention and production acceptance remain unproved.
External side effects: task branch push and PR evidence only. All execution used local synthetic accounts/providers and owned embedded databases. No other-project edits, cloud provisioning, real provider requests, actual audio, customer writes, live money, production migration, main merge or deployment. Existing generated proof folders were copied before the full gate and retained under the continuation evidence directory.
Next exact action: Continue the existing direct-account/original-player acceptance boundary when an approved real provider/account/device is available; preserve the separate merge/deploy HOLD. Do not restart the audit or rerun the same expensive full gate without invalidating changes. There is no remaining blocked label correction.
Rollback: Revert only the runtime/test slice if needed; no production schema rollback is involved. Evidence-only checkpoints do not alter execution.

---

# Earlier continuation history

# Latest continuation: reconnect browser suite completed

Objective and scope: Sway only, existing PR249 branch `implement/direct-music-control-20260916`. Resume base `988a7f44cde9b95e69898fa82f6e2646c09bbb76`; no other-project work.
The exact corrupted fixture label has been corrected using the existing Unicode escape spelling. No assertion was removed or relaxed. The earlier tool block and failed attempts remain recorded below.
Executed: the complete direct-music browser suite passed all 18 named checkpoints with exit 0, including late old-authorization HTTP409 handling, reconnect snapshot isolation, disconnect cleanup and approval-off behavior. The run used actual local Sway sessions and embedded PostgreSQL with simulated provider consent/API responses; not a real provider or physical-audio test.
Exact proof: `docs/qa-packets/direct-music-reconnect-20260919/browser-completed.json`; started 2026-09-19T22:38:59.917Z, finished 2026-09-19T22:41:12.182Z. Runtime and test hashes are verified against this worktree. The original `results.json` below is historical failed evidence, not the current browser outcome.
Files changed in this continuation: one test-label correction, the new browser receipt, and this resumption update. Runtime is unchanged from the previous repair.
Next exact action: run the unchanged `npm run validate` against the commit containing this update, with an isolated environment and separate evidence output. Preserve prior untracked proof folders before generated checks. Do not re-audit or substitute older full-gate receipts.
Release posture: draft; no merge, deploy, provider activation, real playback, production database changes or money movement. Real provider approval/account/device acceptance remains separate.

---

# Historical checkpoint retained verbatim

# Sway direct-music reconnect continuation

Objective: Continue Sway only; prevent a replaced provider authorization from inheriting the old account's playback, devices or library. Sway remains the performer's external controller, not an audience jukebox.
Base branch/commit: PR249, `implement/direct-music-control-20260916`, `b4eea99596269023848e8e231143372973ac42fa`; production base is `80127f127bc1ec1b3ea7a32b89eea244f5953a1f`.
Current branch/commit: Same task branch; the commit containing this note. Exact tested file hashes and outcomes are in `docs/qa-packets/direct-music-reconnect-20260919/results.json`.

Implemented: Refresh retires old connection-scoped state when identity, revision, status or availability changes. Old library views/search text are cleared. Playback, device, library and mutation callbacks check current identity before changing the screen. An obsolete library failure cannot revoke a replacement connection. Disconnect retires pending reads. Playback still requires a deliberate permitted operator action.
Server authority, provider eligibility, routes, schema, payments, fees, memberships, source adapters and production settings were not changed. Client checks do not replace server authorization.

Verified: The new signed-in two-tab browser regression failed against the unchanged runtime because old playback remained visible after reconnect. After the runtime repair, that same regression passed: old playback/library/devices disappeared while new reads were delayed, controls stayed unavailable, fresh reads recovered, and reconnect/target selection sent no playback command.
Verified: The direct-music browser run completed 15 named checkpoints, including the new reconnect scenario, with the actual local app, real account sessions and embedded PostgreSQL. Provider consent and API responses were simulated. These are checkpoints, not 15 independent user journeys.
Verified: All 23 direct-music boundary tests passed. `node node_modules/typescript/bin/tsc --noEmit` passed, and `npm.cmd run build` passed. No complete-product or release acceptance is claimed.
Visual inspection: The 320px reconnect-waiting screenshot shows no old library or Playing claim, disabled player controls and loading/current-state feedback.

Changed but unverified: The browser suite as a whole still FAILS in the added late-old-search regression. The server correctly rejects the old revision with HTTP409; captured UI still shows the connected replacement account and its playlist. The assertion's expected label contains a question mark instead of the rendered middle dot. The attempted character correction was blocked by a tool safety check and was not rerouted. This is not a passing late-response test or a passing full suite. The later disconnect/approval cases were not reached in this run.
Earlier failed attempts remain preserved: initial new-test teardown caused an unhandled route error; teardown was corrected to await running handlers. PowerShell refused npm.ps1, so that attempt is not lint evidence; the native TypeScript command above is the executed proof. The optional formatter was not run because its requested executable was absent.

Files changed: `src/components/PerformerDirectMusicConnection.tsx`, `scripts/sway-direct-music.browser.test.mjs`, this checkpoint and its results manifest.
Tests/evidence already run: Adjacent continuation directory `../sway-reconnect-20260919/` retains red.log, red-confirmed/results.json, green/results.json (failed overall despite its directory name), screenshots, boundary log, TypeScript log and build log. Existing tmp proof folders were preserved.
Tests/evidence invalidated by later changes: Historical full-gate receipts remain valid only for their own revisions. They do not certify this changed candidate. The unchanged hard contract chain still includes the direct-music browser suite; no assertion or gate was disabled.
Known blockers/risks: The blocked assertion correction and a fully passing browser/required integration gate remain. Genuine provider approval/grant, physical device and audible playback remain unproved. This continuation does not authorize provider activation or production release.
External side effects and retry safety: Only task-local synthetic accounts/databases/player replies were used. No real provider requests, playback, emails, customer writes, payments, migrations on production or other-project changes were performed. No cloud validation service was provisioned. The two-tab regression verifies zero extra playback commands.
Next exact action: Resolve the blocked assertion correction through the permitted tool boundary; rerun the direct-music browser suite with a new evidence output path, then complete required integration gates. Do not infer a release from a build.
Actions that must NOT be repeated: Do not restart discovery, re-audit other projects, overwrite prior receipts, replay unknown player commands, weaken tests, merge main or deploy without separate authorization.
Release posture: Draft only; no merge or deployment. Rollback is to revert the task-owned UI/test slice; no database rollback is necessary.
