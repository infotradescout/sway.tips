# Current resume point: Sway hosted validation passed without DC

## Scope and exact source

Continue Sway only, repository `infotradescout/sway.tips`, PR249, branch `implement/direct-music-control-20260916`. The owner explicitly requested execution without Desktop Commander. No DC operation was used in this continuation. No main merge, production deployment, provider activation, real playback or live-money authorization is implied.

Tested Windows-booth-recovery candidate: `564fb16899d21043709d2023a8bd2dfeb43bd1d1`.
Tested tree: `ac279a78535b505d86aca2b5d87040df690327bb`.
The commits adding this no-DC checkpoint and its evidence are documentation-only descendants. Runtime, tests and dependencies were not changed during the hosted run. Preserve the previous implementation checkpoint at `docs/process/2026-09-19-windows-booth-recovery.md` and all historical receipts.

## Completed execution

The existing isolated Render `sway-release-proof` service was reused. No new service was provisioned and the Sway production service was not modified.

- Workspace: `tea-d191jph5pdvs73drglkg`.
- Service: `srv-daesln0u01pc73fso5kg`.
- Deploy: `dep-dankp1p42hec73eqp90g`; proof deployment status `live`, completed `2026-09-20T03:11:31.815155Z`.
- Launcher branch: `audit/readiness-223-room-recovery`, exact revision `1d8c91f3bf5798be1ef700aa36775768f9e00af5`.
- Candidate validation: `2026-09-20T03:02:04.151Z` through `2026-09-20T03:11:29.513Z`.
- Result: all 16 declared stages passed, no failing stages, no stage timeout or signal. This is a stage count, not a total assertion count.

Passed stages include locked installation, existing parser/helper checks, the complete Performer Connections contract, lint, build, Chromium setup, the native-PostgreSQL launcher/finalization regressions, Sources browser persistence against a fresh owned loopback PostgreSQL instance, the complete `npm run test:contracts` chain, and room/account browser isolation. The source remained unchanged. This runner invoked lint/build/contracts separately; it did not invoke `npm run validate` or a separate payment-pricing command.

Evidence: `docs/qa-packets/windows-booth-recovery-20260920/hosted-validation.json` preserves exact source/tree, service/deploy identity, stage exit codes and durations, native database identity, conditional skips and limitations. It is an observed summary of the provider log, not an invented copy of the original full log. The existing runner did not emit a complete-log SHA256; none is claimed.

## Preserved boundaries

Two conditional skips were emitted and remain recorded:

1. Native Windows booth execution requires a Windows PowerShell runner. Linux executed the portable generator checks only. The earlier 14 native PowerShell checks and two-process crash/restart test remain separate historical evidence, not checks rerun here.
2. The conditional active-room-registry database proof lacked its explicit disposable-database approval in the contract-chain environment. The separate old Windows registry result is still unobserved. Other database stages passing does not erase this skip.

This is independent hosted validation, not recovery of the inaccessible Windows run. That run was not retrieved, canceled or restarted. Do not claim its final result. The hosted tests used actual Sway code, browser sessions and owned databases with synthetic external-provider replies; they do not prove provider approval, installed VirtualDJ, the outer downloaded CMD startup/prompt journey, physical-device behavior or audible playback.

The proof service publishes test evidence only, not the Sway application. A successful proof deployment is not a production release. PR249 remains a draft under its existing release HOLD.

## Reusable no-DC path

Use GitHub for task-branch source changes and this existing isolated Render candidate runner for applicable hosted verification. Keep the product branch distinct from the auxiliary runner branch. The verified mode configuration is:

`SWAY_SOURCE_WORKSPACE_VALIDATION=true`, `SWAY_ISOLATED_VALIDATION=true`, `SWAY_PUBLIC_RELEASE_OBSERVATION=false`, `SWAY_VALIDATION_EXPECTED_SHA=1d8c91f3bf5798be1ef700aa36775768f9e00af5`, and `SWAY_SOURCE_CANDIDATE_SHA` set to the exact intended candidate. All live-room-money, native-ticket, test/live-payout and test-platform-balance execution flags remain false. The existing runner rejects inherited provider/database credentials and creates a clean detached checkout with an allowlisted child environment.

Before a new run, check that this proof service is idle. An environment update triggers a deploy itself; do not also send a duplicate deploy request. Reuse this service instead of creating a new proof site per commit. Preserve completed receipts before replacing the public proof output. Never change the production service or treat an auxiliary runner revision as the product candidate.

## Next exact action

Continue from the tested candidate or its documentation-only descendants. The remaining exact-candidate registry supplement can be executed against a newly owned database using Sway's existing test helpers in an isolated non-DC environment; preserve the explicit guards and distinguish it from standalone concurrency proof. Native Windows startup and real original-player acceptance remain separate boundaries. Do not repeat the same full hosted gate unless a source/test/dependency change invalidates it. Do not re-audit, use DC, modify other projects, replay unknown commands, weaken tests, merge main or deploy without separate authorization.

External side effects in this continuation: GitHub documentation commits/PR updates and one deployment of the existing isolated proof service. No production application changes, real provider calls, audio playback, customer writes, money movement, new cloud service or production database migration.
