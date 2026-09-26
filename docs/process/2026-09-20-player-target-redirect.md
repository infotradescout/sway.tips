# Sway player-target redirect continuation

Objective: A deliberate operator command must address the selected original player, and uncertainty/reconnect must not replay it.
Base: `implement/direct-music-control-20260916`, PR249, `7c9f17217a38e952794b2d4c315a567aeee0dfbf`.
Current source: The commit containing this checkpoint. Tested file identities are in `docs/qa-packets/player-target-redirect-20260920/results.json`.

## Executed finding and repair

The exact fetched Node VirtualDJ adapter followed redirects. An actual loopback HTTP reproduction observed one Play invocation send `deck 2 play on` to `/execute` and then automatically resend it to `/unexpected-player`, returning `executed:true`. The full new regression suite on the old adapter exited 1: 8 passed, 9 failed. This was a protocol fixture, not installed VirtualDJ.

The existing adapter now sets `redirect: 'error'` on query and execute requests. It does not automatically move the command to another endpoint or accept redirected state as the selected player's observation. No new adapter, service, schema or recovery authority was added. Windows already used its separate zero-redirection setting and was not modified.

The expanded existing behavior file passed all 17 tests with exit 0, no skipped or cancelled cases. Six prior tests remain unchanged. New cases use real Node HTTP requests, not fetch mocks. Two cases each run two separate Node processes against actual `executeClaimedOnce`/`executeClaimedBatch` and owned fsync-written ledgers: one request before ambiguity, one total after restart, stable bridge and command identity, preserved unknown outcome, no later-batch Play. Owned listeners, child processes and temporary ledgers were closed/removed. Syntax checks passed for both changed JavaScript files.

## Scope and limitations

Testing ran on Linux Node v22.16.0 against exact GitHub-fetched files. Original blob SHA checks and the patched runtime/test blob identities are recorded. This is not full repository checkout validation, the complete application/operator route, the full booth CLI, native Windows, outer downloaded CMD startup, a real provider grant, installed VirtualDJ or audible playback. The user's overall completion criterion remains unverified. The real-player test requires an authorized connected original player, which was not exposed by the available non-DC environment.

Files changed: `scripts/lib/virtualdj-network-control.mjs`, `scripts/sway-virtualdj-network-control.behavior.test.mjs`, this checkpoint and its QA receipt. Existing `scripts/sway-music-sources.acceptance.test.mjs` invokes the expanded behavior file; no new hard-contract entry is added. The only runtime change is redirect rejection and its comment. The execution ledger module, Windows generator, dependencies, database, shared-host GrindZone code, provider eligibility and payment behavior are unchanged.

No unchanged hosted gate or registry supplement was repeated. No Desktop Commander, new service, Render deployment, production write or real player command was used. Main merge/deployment remain held. Original merge and registry receipts retain their own source identities; they do not certify this new transport change or real playback.

Next exact action: Continue actual authorized original-player/booth acceptance and native Windows outer-CMD coverage. Preserve this tested redirect repair and unknown ledgers. Do not return to merge reconstruction, rerun the completed registry proof, replay uncertain commands or replace real-player acceptance with these fixtures. Rollback: revert this bounded adapter/test commit; no migration rollback is required.
