# Readiness #223: performer account reads checkpoint

Date: 2026-09-06 UTC. PR #224 remains draft. **Release HOLD.**

## Decision and purpose

Save the reviewed account-read repair for continued testing. A delayed profile or active-room response could replace newer account data, restore a previous account's room selection, or interfere with recovery. The repair keeps each read and post-action refresh attached to its committed context.

- Starting commit: `7e8c9e89667affb167460ed8ae2942ee3494453c`.
- Reviewed code commit: `75beea5dc2e3cbce911533debaf645cc143a4049`.
- Exact code tree: `5ae137f61e3405041ae0c9855904bd7d7c22695c`.
- Full per-case results, command inventory, runtime versions and file hashes: [account-read-results.json](readiness-223/account-read-results.json).

The connector-created commit has the same tree as the locally tested code. This evidence-only follow-up does not change that code. No main branch, deployment, production account, database, provider setting or live-money switch was changed.

## Behavior changed

- Superseded profile and room-list reads are canceled and rejected after both response and JSON completion, even if transport cancellation is ignored.
- Room rows carry their account identity atomically. A profile and old room list resolving in the same React batch cannot select the old account's room.
- Switching accounts or losing confirmed access clears the previous account's list and selection. A same-account transient read failure preserves confirmed context.
- A room action captures its registry context before waiting. Its old completion cannot cancel a fresh read after an account, route or access-loss round trip.
- A registry denial invalidates older profile work. It does not cancel a newer profile read or erase a different account's profile update already queued in React.
- Logout invalidates pending reads immediately, suppresses repeated logout and restores refresh after failure. Profile-refresh and logout failures have visible messages.

The existing room-start browser assertion now expects the previous account's selection to clear. The existing active-room endpoint assertion now includes the fetch cancellation signal. Financial assertions and browser prerequisites were retained. The new behavior runner exits nonzero on failure and is included in `test:contracts`.

## Executed evidence

The fixture bundles the actual full `TalentApp.tsx` and the repository's locked React/ReactDOM **19.2.7**. It executes with StrictMode in Node **24.19.0** and JSDOM **26.1.0**. Child UI, `useSwayState`, helper routes and all HTTP are synthetic. Deferred responses deliberately settle after abort to exercise the component's ownership checks.

| Stage | Passed | Failed | Meaning |
| --- | ---: | ---: | --- |
| Original source, first valid 16 scenarios | 4 | 12 | Reproduced stale and cross-context behavior |
| Review expansion, 25 scenarios before correction | 22 | 3 | Reproduced co-batched account selection and expired-action refresh |
| Denial-ordering probe, 26 scenarios before correction | 25 | 1 | Reproduced old registry denial canceling newer profile work |
| Final permanent suite | 29 | 0 | All checked component-state scenarios pass |

Early fixture setup errors were corrected before the valid baseline and are not counted as product failures. The stage counts cover different scenario sets; they are not a single fixed-suite before/after claim.

Selective Intelligence Guided Council used one read-only Objector in fresh context, with Grade 1 independence (same provider/model family). Its first two material objections were sustained and corrected. The final denial-ordering review passed **8/8** independent targeted checks, including delayed JSON, a queued account-B update, and revocation of older profile work. Its three additional probes are now permanent cases in the 29-case runner. This is bounded component review, not an independent security certification.

Final reviewed source SHA-256: `ee8aab6dac07635d471428cdf215f1c77ae3a5fb9b77b948e27c4a94d6154db1`.

| Validation | Result |
| --- | --- |
| Clean `npm ci` with corrected lockfile | PASS |
| `npm run lint` | PASS, exit 0 |
| `npm run build` | PASS, exit 0 |
| `npm run test:contracts` | **FAIL, exit 1** at the missing Playwright Chromium executable; the 29 account-read cases passed before that stop |
| Supplemental execution of the contract command inventory | **124 PASS, 0 FAIL, 2 BLOCKED**; partial verification only |
| `git diff --check` | PASS |

The supplemental run executes the commands from `package.json` independently and explicitly marks `sway-payment-closeout-db-backed.contract.test.mjs` and `sway-payment-modal-viewport.contract.test.mjs` as browser-blocked. It does not replace or pass the full gate. The full gate was also repaired for its required literal nonzero-exit convention and updated abortable-fetch assertion before the final execution. No failed product assertion was suppressed.

JSDOM is a new exact development dependency. Its 36 new lock entries are development-only. Existing nonroot lock entries, versions, integrity values and platform filters are unchanged; runtime dependencies are unchanged. Clean installation and build succeeded.

## Proof limits and next work

The owner's PC remains unavailable. Cloud Browser explicitly rejected isolated fixture navigation, and no alternate browser/navigation workaround was attempted. Node component execution is a distinct nonbrowser check.

These results do not establish browser layout, the full application with the real room-state hook, Windows or physical-device behavior, server authorization, real account switching, durable persistence, or provider/payout correctness. Error-message layout remains unverified. The exact-dependency 13-case room-start and 13-case response-order browser suites, and the complete 49-case readiness browser suite, remain unrun for this change. Historical browser counts are not current-change evidence.

Continue with actual application/browser integration and separate-actor hosted account/room proof, then the remaining release gates. `RELEASE_CONTROL.md` records an earlier test-mode pilot; that historical record does not establish fresh hosted proof for this change. This checkpoint does not resolve conflicting historical readiness wording by asserting a new pilot pass.

Profile image/video/album/song backgrounds remain an in-app requirement. Flat 20% non-exclusive pricing still needs its separate approved reconciliation; no Exclusive rate or calculation was guessed here.

## Required handoff

- **Decision:** Continue the draft; do not merge, deploy, enable money or claim production readiness from this partial proof.
- **Business goal:** Keep performers in the correct account and room during slow reads, account changes and recovery.
- **Files inspected:** Root `AGENTS.md`, `RELEASE_CONTROL.md`, `docs/VIBE_ENGINEERING_DOCTRINE.md`, performer shell, room-start test, live-room readiness contract, new account-read runner, package manifests and prior checkpoint evidence.
- **Files changed:** `src/shells/TalentApp.tsx`; `scripts/sway-performer-account-reads.behavior.test.mjs`; `scripts/sway-performer-room-start.browser.test.mjs`; `scripts/sway-live-room-readiness.contract.test.mjs`; `package.json`; `package-lock.json`; this checkpoint and its linked JSON evidence.
- **Routes touched:** Existing performer-shell reads of `/api/state` and `/api/talent/active-rooms`, logout handling and context checks around existing room-action refreshes. No endpoint or server handler added or changed.
- **Schema touched:** None.
- **Money behavior touched:** No pricing, charge, refund, payout, entitlement or provider logic changed.
- **Persistence behavior touched:** No durable write or storage change; no automatic write retries added.
- **Role/access behavior touched:** Client ownership and access-loss handling tightened. Server authorization unchanged and still requires integration proof.
- **AI behavior touched:** None.
- **Moderation behavior touched:** Existing action completion refreshes capture account context; moderation policy and server mutations unchanged.
- **App Store impact:** None claimed; no store-readiness proof.
- **Validation commands:** `npm ci --cache /workspace/scratch/6393ad485b8c/npm-cache --no-audit --no-fund`, `npm run lint`, `npm run build`, `npm run test:contracts`, supplemental independent execution of the exact command inventory, and `git diff --check`. See the result table and JSON for failures and limits.
- **Known risks:** Browser/integration/device and hosted account/provider proof remain open; the full contract gate fails on unavailable browser execution. Mocked children and room-state hook limit this evidence.
- **Rollback path:** Revert code commit `75beea5dc2e3cbce911533debaf645cc143a4049` on the draft if rejected. This checkpoint changed no production state.
- **Next required slice:** Run actual application and browser recovery/account-switch checks on this code, then complete hosted and release proof. Keep product-background and pricing work separately scoped.
- **Commit SHA:** Reviewed code `75beea5dc2e3cbce911533debaf645cc143a4049`; the commit containing this document is its evidence-only child.
- **Working tree status:** Clean after the code checkpoint was saved; only the two evidence files comprise this follow-up. The final remote/tree comparison verifies the saved evidence checkpoint.
