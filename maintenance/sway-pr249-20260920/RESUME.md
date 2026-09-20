# Sway PR249 — actual continuation, September 20, 2026

## Decision

The original-player completion criterion is NOT met. A preserved, tested merge candidate exists, and its original registry database contract passed without skips. The candidate was not published because the existing proof runner's ordinary Git push had no write credentials. PR249's remote head remains `b354e1a6a842d39d8601f49323f56d2603348a1f`; GitHub still reports the draft conflicted. Do not call the PR reconciled or shipped until its ref actually changes.

## Exact completed candidate

- Candidate: `5620355f858455d5ee51c6be139c92972c8e2046`.
- Tree: `ecc87d5ace437ab390c7bae6018eacce0dd02c0a`.
- First parent: `b354e1a6a842d39d8601f49323f56d2603348a1f` (Sway task branch).
- Second parent: `e15db1518ef2b1823442d18479d71af4ee0ca95a` (main with shared-host GrindZone).
- GrindZone relay pin retained: `58ceb46de0ab10463dcdd7187985d91d8b4bf45a`.
- Changed from Sway: only `package.json`, `public/sw.js`, `scripts/grindzone-host.contract.test.mjs`, `scripts/prepare-grindzone-host.mjs`, and `server.ts`.

The merge was actually executed in a new owned worktree. Its only conflict was `server.ts`. The resolution retains the direct-music route import and adds main's two shared-host imports and listener wrapper. Reversing the shared-host additions reproduces Sway's complete server byte-for-byte. Existing Sway scripts and dependencies are retained, the preparation step is additive, and the other shared-host files match main exactly. Both parents are retained.

Executed on that exact candidate: locked dependency installation; the changed shared-host contract; merged server compilation; the existing unmodified `node scripts/sway-active-room-registry.contract.test.mjs` against a fresh, owned, native PostgreSQL 18.4 process. Registry exit 0, no signal, no timeout, zero skips. Missing/stale revisions reject without changing durable state; valid revision close passes. Source remained unchanged. Database stop and loopback-listener shutdown were verified. This is not separate-process contention or a real room test.

Registry log SHA256: `b0de61a584b63880e2b9254b99e046928ce0b976426fa1392850f128151c6d8c`.

## Publication and native boundaries

The ordinary non-force push to `implement/direct-music-control-20260916` failed, exit 128: `fatal: could not read Username for 'https://github.com': terminal prompts disabled`. No credential was discovered, changed, requested or copied. No remote ref changed. Do not repeat this unauthenticated push blindly.

The earlier scoped GitHub Actions attempt (run `35520680820`) failed before executing any steps. Windows and publication jobs were skipped. No native result was produced, and no billing cause was established. The auxiliary workflow added for that attempt was subsequently removed; its history remains. It is not an additional release gate.

No actual original-player command was issued. No new proof of the downloaded CMD startup/prompt journey, installed VirtualDJ extension, physical deck, audible playback, actual provider grant, or real-player reconnect was obtained. Earlier native/synthetic receipts remain historical and do not become exact-merged-candidate native acceptance merely because their source files were retained.

## Evidence and exact reconstruction

`observed-result.json` beside this file preserves the observed summary, source and log hashes, runtime scope, limitations, failed publication, and exact reconstruction identity. It does not pretend to be a downloaded original full log.

Existing isolated evidence service: `srv-daesln0u01pc73fso5kg`, workspace `tea-d191jph5pdvs73drglkg`. Executed launcher: `da657c98b8c43e8dce818e14884f86500a5b95e3`. Deploy `dep-dao05if40ujc73ddqn20` published evidence at `2026-09-20T15:59:54.576779Z`; it did NOT deploy the Sway application.

Runner output:
- `https://sway-release-proof.onrender.com/pr249-supplement.json`
- `https://sway-release-proof.onrender.com/merge/candidate.bundle`
- `https://sway-release-proof.onrender.com/exact-candidate-registry.log`

The runner wrote these artifacts and the provider marked their static deployment live. This chat's web/download tools could not retrieve them. Preserve the bundle and full logs before replacing that proof output. The prior `source-evidence.json` was copied byte-for-byte and retains SHA256 `b879b9fb397b919d407d2d8885e83a423a7c9e120e17439b61ee274aea2ed9a8`; it still describes the earlier candidate, not this merge.

The exact candidate is also reconstructible from public source without relying on that static bundle. Use a new owned clone/worktree, not a reset of an existing checkout. Read `maintenance/sway-pr249-20260920/reconcile.py` from exact helper commit `906cfb91a00646d9cafb0bfd70f5442a64079bf5`, SHA256 `6987738f5ad126f21a280a64ad4f2d2238cfb958f20a9d89fed008090a2a7361`. Use LF checkout and set BOTH `GIT_AUTHOR_DATE` and `GIT_COMMITTER_DATE` to `1789919974 +0000` before invoking it. It must produce tree `ecc87d5ace437ab390c7bae6018eacce0dd02c0a` and commit `5620355f858455d5ee51c6be139c92972c8e2046`. The commit object identity was independently reconstructed and SHA-1 verified locally; no remote publication is implied. Ref-advancement checks must remain enforced.

## Next exact execution

1. Import or reconstruct this exact tested candidate in an authorized write-capable Git session. Verify both parents, tree and candidate hash, and recheck current task/main refs. Publish only a non-force fast-forward to the existing task branch. Preserve newer work if either ref advanced. Do not merge main or deploy production.
2. On an authorized Windows execution target, run the actual native generated-booth checks against this exact candidate and cover the outer downloaded CMD startup/prompt journey. Keep real generated functions separate from synthetic transport limitations. Do not call a Linux source check or an empty Actions job native acceptance.
3. Use the authorized operator/booth connection to observe a deliberate command affecting the intended original player. Then verify reconnect/uncertain-delivery behavior: stable command identity, no automatic replay, no duplicate dispatch, no later command slipping through unresolved ambiguity, and explicit operator review permitting a genuinely new command without reviving the old one. Record actual player/deck identity and observed state separately from an HTTP acknowledgement.

## Do not repeat or expand

Do not repeat unchanged hosted gates, create another proof service, use Desktop Commander, re-audit unrelated projects, replace the corrected GrindZone pin, discard old receipts, replay unknown commands, weaken an assertion, activate providers/money, run production migrations, merge main, or deploy Sway production.

The existing Render service is idle after the scoped run. Its auxiliary branch is `audit/readiness-223-room-recovery`, with `SWAY_PR249_SCOPED_SUPPLEMENT=true`, `SWAY_PR249_PUBLISH_CANDIDATE=true`, and `SWAY_VALIDATION_EXPECTED_SHA=da657c98b8c43e8dce818e14884f86500a5b95e3`. Auto-deploy is off. Do not redeploy it blindly: this explicit mode would repeat the completed scoped checks. Any future authorized use must preserve its artifacts, select the needed mode and exact launcher, and avoid a duplicate manual trigger after an environment update.
