# sway.tips readiness 223: late-action response safety

Date: 2026-09-05. Draft PR #224; issue #223 remains open.

## Decision and resume point

Continue from the actual remote head `2b71605690cf58eec2823cb82d1802bffbfcad2e`, not the older chat checkpoint. Preserve its mobile queue, sharing, importer-test and menu changes. This is another draft repair, not merge/deploy/payment authorization.

The Windows device is offline. The execution container cannot download a complete checkout, and browser navigation to its local HTTP server is blocked. No browser policy or networking restriction was changed. A separate, entirely in-memory browser probe was possible; its limited evidence is described below.

## Defects reproduced in the current draft

The existing read-response sequence guard did not cover delayed action snapshots. In the isolated probe:

- A captured action callback could replace a newer same-room read with older request data.
- The same callback could repopulate a cleared queue and re-enable UI actions after 401, 403, 404 or 410, or override the stale/read-only state after a network failure or 503.
- Recovering the connection before the old callback returned did not prevent its stale overwrite.
- A wrong-room mutation snapshot was rejected only after it had canceled the correct room's outstanding read.
- A confirmed closed-session snapshot was marked active by the client update path.
- Access denial waited for the response body before clearing private state.
- A body reader that finished despite abort could revive a timed-out response because timeout had not invalidated its sequence.

These are client-state observations. They are not proof of a server authorization bypass, a wrong charge, actual exposure to another account, or a production incident.

## Repair

Add a per-room observation revision. An action callback remains bound to the observation visible when it was created. A later read, error or access decision invalidates that callback's snapshot. An obsolete response requests a fresh read when none is pending instead of applying stale data. No write or payment is retried.

Reject a different room before canceling the current room's read. Keep accepted closed-session data available to its consumer but mark the room ended so that it cannot enable live actions. Clear private room state immediately on denial/end headers, without waiting on a 401/403/410 body. Invalidate timed-out sequences as well as aborting their transport.

Only the shared client-state module changes application behavior in this checkpoint. No server, schema, fee, legal text, payout, storage, provider switch, original master or production account changes.

## Evidence and exact limits

The fetched original shared module was verified against its Git blob SHA `9ab2c83ea8a4c467974b94f48508d0cce618e97d` before editing.

An isolated in-memory browser probe compiled that exact TypeScript source and rendered its hook with synthetic API responses. Result: **original 1 PASS / 12 FAIL; repaired 13 PASS / 0 FAIL**. The 13 cases are recorded in `readiness-223/response-order-isolated-results.json` with source hashes.

Environment: Linux, system Chromium 144.0.7559.96. React 19.1.1 came from the already-installed Playwright trace-viewer bundle. Imports for discovery, demo mode and request headers were mocked. This is **not the project's lockfile/runtime, complete app, real HTTP service, Windows browser, production authentication or payment-provider proof**. No external connection was used by the probe. The isolated runtime was not added to product dependencies.

An initial probe-dispatch mistake was caught by repeating the unchanged baseline: three newly named cases had been routed through the ordinary-success branch. That probe was corrected; only the corrected before/after results above are evidence. No earlier mislabeled result is counted as a pass.

The same scenarios are now expressed in a repository-native browser fixture and test using the project's React and Playwright. Their TypeScript syntax was checked, but **that native suite has not run here**. The existing full contract command now invokes it after the existing refund-confirmation browser prerequisite; neither browser gate can be replaced by source-only checks.

## Validation status at this checkpoint

- Isolated exact-hook browser probe: 13/13 PASS, within the limits above.
- Original baseline comparison: 1/13 PASS, 12/13 FAIL in the same probe.
- TypeScript transpilation/syntax of changed source and new test/fixture: PASS. Not whole-project type checking.
- JavaScript syntax of changed contract wrapper: PASS.
- Full-project lint/build/contracts: UNRUN on this new source because a full local checkout and exact dependencies are unavailable.
- Existing 49-scenario layout/flow suite: remains BLOCKED/UNVERIFIED on current source.
- New repository-native 13-scenario response-order suite: BLOCKED/UNRUN.
- Windows importer execution, real phone keyboard/zoom, full-server separate-actor flows and payment/payout proof: still outstanding.

The earlier 37/37 Chrome results and 123-command partial source run remain historical. They are not current-head verification and do not establish a passing full gate.

## Required next checks

On the connected test PC, fetch the current draft into an isolated checkout, install the unchanged lockfile, run the new response-order browser test, all 49 readiness scenarios, profile/payout, refund and payment-dialog suites, lint, build and the full contract command. Inspect real screenshots rather than relying only on document-width assertions.

Continue room creation while changing rooms, closeout/recap persistence, account/session expiry, multi-tab actions, Back/Forward, unsaved forms, scroll restoration, provider reconciliation, restore and rollback tests. The owner's image/video/album/song profile background requirement remains an in-app feature requirement; it has not been replaced by image generation or implemented by this safety patch.

Preserve the separate 20% non-exclusive pricing reconciliation and already accepted entitlements. Do not merge, deploy, enable money or declare readiness from this checkpoint. Production is unchanged, so this checkpoint requires no production rollback; revert its draft commit to undo the code change.
