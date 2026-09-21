# Sway readiness 223: mobile and queue repair checkpoint

Date: 2026-09-05. Related draft: PR #224. Issue #223 remains open.

## Decision

Save the repair as a draft. Browser verification is blocked; this checkpoint is not a release approval or a production-readiness claim. Keep the existing no-merge, no-deploy and no-live-money hold.

Code commit: `b841151fac41d05b0904ca3a10df49ef943cc8db`.
Code tree: `b7a8132d203d853fdd0e3ccf373b0d1a3c66cf27`, identical to the locally validated application/test tree.
Starting draft commit: `57a43a255d3a170ef335e705e666220d82c72e01`.
Production/base source inspected this session: `54c96cc9eb4d88df2e9358d7525854a054dbdf36`.
Branch: `audit/readiness-223-room-recovery`.

## Business goal

Performers need access to every queued request and to the sharing, playback and room controls on a small screen. A failed copy must offer recovery instead of showing success. These changes implement the next repair slice; actual rendered behavior still requires verification.

## Changes

- Replace duplicated desktop/mobile queues with one responsive renderer. Each queue has five rows per page, previous/next controls, direct page selection, a total count, independent pagination, page clamping and a scrollable request list. Reaching later requests no longer requires processing earlier requests. Queue and playback state reset when the room changes.
- Use the Requests, Share Room and Controls choices on compact displays. Desktop layout requires both adequate width and height. Very short viewports allow the workspace itself to scroll so fixed controls cannot consume all available content height.
- Keep the sharing panel at its natural height within a scrollable workspace. Preserve the QR size and show complete selectable room links, with wrapping and accessible unavailable-link states.
- Report clipboard failures in the sharing panel and main room controls. The shared fallback now checks the copy result and always removes its temporary textarea. Room changes clear sharing feedback.
- Make the room background inert while a removal confirmation is open. Existing confirmation and server action handlers remain in place.
- Correct the importer test's native-path expectations without changing the importer. Add assertions for drive-qualified and network file URLs. Windows execution remains unverified in this checkpoint.
- Align source-shape checks with the shared renderer and stronger existing action guards. The rendered refund-confirmation gate remains mandatory; it was not removed or converted to a passing source-only check.
- Extend the readiness browser suite from 37 to 49 scenarios. New scenarios check clipped descendants and individual control reachability, short screens, the last of 1001 queued requests, confirmation background isolation, and clipboard failure. The 49-scenario suite has not run successfully on this source.

## Validation commands and results

Environment: Linux, Node 24.19.0. Dependencies installed from the existing lockfile; product dependencies and lockfile are unchanged.

| Command / evidence | Result | Limit |
| --- | --- | --- |
| `npm run lint` | PASS | Repository command runs `tsc --noEmit`. |
| `npm run build` | PASS | Client and server bundles built; no deployment. |
| `git diff --check` | PASS | Whitespace verification only. |
| `node --import tsx scripts/sway-dj-library-importers.test.mjs` | PASS | Linux execution, not Windows execution. |
| `node --check scripts/sway-readiness-223.browser.test.mjs` | PASS | Syntax only, not browser execution. |
| `npm run test:contracts` | FAIL / BLOCKED | Exits 1 at the rendered refund-confirmation prerequisite because the Playwright browser executable is unavailable. The full gate is not passing. |
| Individual non-browser commands from `test:contracts` | 123 PASS, 0 FAIL | Supplemental partial run only; two browser-dependent commands explicitly remain BLOCKED. |
| `npm run test:browser:readiness-223` | BLOCKED before scenarios | The connected PC is unavailable. The local test browser cannot launch; no new rendered scenario passed. |

The partial run enumerated the existing `test:contracts` command list and executed every command except `sway-payment-closeout-db-backed.contract.test.mjs` and `sway-payment-modal-viewport.contract.test.mjs`, recording those two as BLOCKED. It did not modify `package.json`, bypass browser checks in the repository, or establish a passing full gate. Named results and source SHA-256 values are in `readiness-223/mobile-queue-checks.json`.

Initial source-shape failures were corrected to require the shared queue's accessible actions, removal-confirmation isolation and the existing stale-room hardware guard. All 123 non-browser commands then passed. After that run, the only additional application edit was the short-viewport scroll fallback in `src/index.css`; the affected live-cockpit contract, lint and build were rerun and passed.

Browser recovery attempts did not produce evidence: downloading the standard browser timed out; a test-only packaged browser outside the repository exited with SIGTRAP. No product browser dependency, assertion or application behavior was replaced to claim a pass. The authenticated cloud browser could not access the local preview. Stop at this access limit rather than relabeling syntax or source checks as rendered proof.

The previous 37/37 Chrome results and screenshots remain historical evidence for the earlier source hashes in `readiness-223/browser-results.json`. They do not verify this commit. Mocked browser fixtures and disposable database simulations also do not prove production authentication, concurrent production writes, real payment-provider behavior or settlement.

## Required handoff

- **Files inspected:** `AGENTS.md`, `RELEASE_CONTROL.md`, `docs/VIBE_ENGINEERING_DOCTRINE.md`, `package.json`, the earlier readiness packet, the changed files below, and the existing performer room/playback surfaces and browser fixtures.
- **Files changed:** `src/components/TalentDashboard.tsx`, `src/components/PerformerRoomShare.tsx`, `src/components/PerformerShareKit.tsx`, `src/index.css`; `scripts/sway-app-unification.contract.test.mjs`, `scripts/sway-dj-library-importers.test.mjs`, `scripts/sway-payment-closeout-db-backed.contract.test.mjs`, `scripts/sway-performer-connections.contract.test.mjs`, `scripts/sway-performer-hardware-mapping.contract.test.mjs`, `scripts/sway-performer-live-cockpit.contract.test.mjs`, `scripts/sway-readiness-223.browser.test.mjs`; this packet, its JSON evidence, and a historical-evidence note in the prior packet.
- **Routes touched:** Existing performer Live Room and sharing surfaces only; no new URL, server endpoint or routing contract.
- **Schema touched:** None.
- **Money behavior touched:** Presentation of the existing confirmed remove/reversal action is shared across viewport sizes. No calculation, pricing term, ledger, provider call, feature flag or settlement behavior changed.
- **Persistence behavior touched:** None in this slice. Pagination and feedback are temporary UI state; earlier draft recovery safeguards are retained.
- **Role/access behavior touched:** Background controls are inert during confirmation. No server authorization, ownership or role policy changed.
- **AI behavior touched:** None.
- **Moderation behavior touched:** No server moderation behavior changed; existing queue actions retain their handlers.
- **App Store impact:** No native package or submission changed; no readiness claim.
- **Known risks:** New layout and keyboard/clipboard interactions have not been rendered in a working browser. Desktop QR density, short screens, zoom, actual devices, Back/Forward, unsaved forms, scroll restoration, and combined journeys still need review. The importer correction needs Windows execution. Pricing reconciliation, provider/payout proof, full-backend pilot, restore and rollback proof remain separate open work. Unfinished Self-Production is not a prerequisite for Live Rooms.
- **Rollback path:** Revert the code commit on this draft branch before any release. Production was not changed and does not require a rollback from this checkpoint.
- **Next required slice:** Reconnect the available Windows PC, run all 49 readiness scenarios and both blocked browser-dependent contract gates against this source, inspect screenshots, then run the full contract gate on Windows and address any failures. Continue the separate-actor hosted test-mode pilot and broader issue #223 work after local proof. Merge, deployment and live money remain separately authorized actions under the repository release rules.
- **Commit SHA:** Application and test changes are `b841151fac41d05b0904ca3a10df49ef943cc8db`; this evidence accompanies them in a subsequent documentation commit. The final remote head is recorded in PR #224.
- **Working tree status:** Application/test changes committed. The final clean-tree and remote-head verification is recorded in the PR checkpoint after the evidence commit is pushed.
