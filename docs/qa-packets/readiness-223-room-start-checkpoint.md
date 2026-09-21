# sway.tips — room creation and selection checkpoint

Date: September 5, 2026

## Decision

Draft repair saved remotely. NOT release-ready. No merge, deployment, money activation, or production mutation is authorized or performed by this checkpoint.

Starting branch head: `071b4621a5dbdd98a25e497e73bf5484d32bddda`.
Runtime repair: `8e27db7867e89d2cbf6d8ba755c2a2feaad4d999`.
Repository-native test: `fed8e051183db5dbdd22d2b35df8cadc5aed02a6`.
Full-contract integration: `05fc8b93a62aa516e72b0a9454f2bd53cf8e96de`.

## The user problem

A performer could start creating a room, choose a different room while waiting, and then be pulled back by the delayed creation result. The shared room-state response guard did not protect the separate selected-room setter. Repeated calls to the start handler also had no synchronous in-flight guard at that boundary.

These are reproduced client-side scenarios, not evidence of a production incident, duplicated durable rooms, unauthorized server access, or incorrect charges.

## Repair

The performer shell now preserves selection intent, including A -> B -> A. A pending start belongs to its committed performer/account context. Completion from an obsolete context, unmounted shell, or superseded selection cannot select the returned room or apply its snapshot.

Repeated Start calls are rejected while one start is in progress. The caller's existing room identifier is captured before waiting and retained for explicit retries. A missing or mismatched returned identifier produces an error instead of selecting an unconfirmed room.

Successful ordinary creation selects the confirmed new identifier, allowing the shared state hook to read that room normally. It no longer injects a newly created room snapshot into the old room's state scope. Starting logout also invalidates an earlier automatic room selection.

Initial automatic selection will not compete with a pending creation or an explicit room choice. This is a client navigation guard, not a replacement for server authorization or durable idempotency.

Moving away does not cancel or delete a room already created by the server. This patch suppresses an obsolete UI handoff; it does not roll back accepted business actions or automatically retry writes.

## Executed proof

The complete fetched performer-shell source was reproduced locally and its Git blob identity verified before modification. It was TypeScript-transpiled and rendered in an in-memory browser page using actual React hooks, with stubbed child components, room-state hook and HTTP. React StrictMode was enabled. No real account, server, database, or payment provider participated.

Environment: Node 22.16.0; Linux Chromium 144.0.7559.96; React 19.1.1 from the installed Playwright trace-viewer bundle. This differs from the application's exact locked dependency environment.

An initial localhost-navigation attempt was blocked by browser policy and is not counted as product-test evidence. No browser/network policy was changed. The successful probe used an in-memory document and blocked all network requests.

| Scenario | Starting source | Repaired source |
| --- | --- | --- |
| Ordinary creation selects the new room | PASS | PASS |
| Creation does not inject a new room into old state | FAIL | PASS |
| Choose another room while creation is pending | FAIL | PASS |
| Change A -> B -> A while creation is pending | FAIL | PASS |
| Repeated Start calls submit only once | FAIL | PASS |
| Mismatched response cannot select a different room | FAIL | PASS |
| Missing response identifier shows failure | FAIL | PASS |
| Explicit retry preserves the same room identifier | PASS | PASS |
| Failure does not automatically repeat a write | PASS | PASS |
| Changed account invalidates earlier creation handoff | FAIL | PASS |
| Logout intent invalidates earlier creation handoff | FAIL | PASS |
| Unmounted shell ignores late creation completion | FAIL | PASS |
| Same-account profile refresh preserves valid creation | PASS | PASS |

Totals: starting source **4 PASS / 9 FAIL**; repaired source **13 PASS / 0 FAIL**. The final source was rerun after capturing the requested identifier before the asynchronous wait.

Runtime file SHA-256: `efa029c1086f81ce8036c34cac4c7ca11b6e684d9d8a46cc05492041b41f3303`.
Runtime Git blob: `0c06ebac04af85d4cd1d18e74952bb7f20b63f54`.
Repository-native test Git blob: `296ea5a3f58b899b07f1b61c23416db2e596aedd`.
The remotely written runtime blob and test blob match the local files.

## Repeatable repository test

Run `node scripts/sway-performer-room-start.browser.test.mjs` in the repository with its installed dependencies and Playwright browser.

That runner bundles the real performer shell using the repository's esbuild and React dependencies, stubs its child components/state/HTTP, and executes the same 13 scenario categories. It records the tested source hash and dependency/browser versions. It remains **UNRUN in the exact repository dependency environment** in this checkpoint. Its JavaScript syntax was checked; that is not execution proof.

The full contracts invoke it after the existing rendered refund-confirmation and room-response-order prerequisites. Those prerequisites and all existing financial assertions were retained. This isolated test does not replace the 49-case readiness suite, complete application rendering, or a hosted test-mode pilot.

## Current-head proof still required

- Exact-dependency lint, build, full contracts, new room-start runner, existing response-order runner, 49-case readiness suite, refund, payment-dialog and profile/payout suites.
- Full application room creation with real disposable backend persistence, separate authorized actors, delayed room-list refresh, failed-start recovery, and integration with the scoped room-state hook.
- Actual mobile/Windows browser behavior, navigation history, unsaved forms, keyboard/zoom, and long-scroll interactions.
- Complete account-resource isolation: profile and active-room-list refreshes have their own asynchronous lifecycle and still require ordering/ownership review. Passing the mocked account-change scenario does not establish system-wide account isolation.
- Closeout/restart error presentation, provider settlement, pricing reconciliation, backup restoration, and rollback proof remain open under issue #223.

The unavailable PC blocks its exact Windows/device environment, not all repository work. Cloud connector reads/writes and isolated in-memory checks continued without the owner's computer.

## Preservation

No main-branch change, production deploy, real login, account mutation, database access, payment, payout, provider credential, pricing calculation, legal policy, schema, original master, or live switch was changed. The owner's offline working copy was not accessed or overwritten.

The requested in-app image/video/album/song profile-background feature remains separate and is not represented as implemented here. The flat 20% non-exclusive pricing direction also remains a separate money-safe alignment task; no guessed Exclusive rate was introduced.

Rollback: revert these draft-branch commits if rejected. Production was unchanged, so no production rollback was needed.
