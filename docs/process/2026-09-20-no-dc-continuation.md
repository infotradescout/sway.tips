# Sway continuation without Desktop Commander

## Scope and source

Continue Sway only, repository `infotradescout/sway.tips`, PR249, branch `implement/direct-music-control-20260916`. The owner explicitly requested execution without Desktop Commander. Do not use or depend on that connection for this workflow. No main merge, production deployment, provider activation, real playback or live-money authorization is implied.

The Windows booth recovery candidate being independently validated is `564fb16899d21043709d2023a8bd2dfeb43bd1d1`. The commit adding this checkpoint changes documentation only. Preserve the previous implementation checkpoint at `docs/process/2026-09-19-windows-booth-recovery.md` and all historical receipts.

## Actual no-DC execution

The existing isolated Render proof service was reused. No new service was provisioned and the Sway production service was not modified.

- Workspace: `tea-d191jph5pdvs73drglkg`.
- Service: `sway-release-proof`, `srv-daesln0u01pc73fso5kg`.
- Deploy: `dep-dankp1p42hec73eqp90g`, started `2026-09-20T03:01:27.054293Z`.
- Existing launcher branch: `audit/readiness-223-room-recovery`.
- Exact launcher: `1d8c91f3bf5798be1ef700aa36775768f9e00af5`.
- Existing candidate mode: `SWAY_SOURCE_WORKSPACE_VALIDATION=true`.
- Pinned candidate: `SWAY_SOURCE_CANDIDATE_SHA=564fb16899d21043709d2023a8bd2dfeb43bd1d1`.
- Launcher identity guard: `SWAY_VALIDATION_EXPECTED_SHA=1d8c91f3bf5798be1ef700aa36775768f9e00af5`.
- Public observation mode is false. Isolated-validation mode is true. Live room money, native tickets, test/live payouts and test platform-balance execution flags are false.

The existing runner creates a separate clean detached checkout, uses locked dependencies, rejects inherited provider/database credentials and gives its child commands an allowlisted test environment. It creates owned loopback databases for applicable tests. Synthetic provider replies are not real-provider approval or audible-playback proof.

The environment update itself started the deploy; no duplicate trigger was sent. Observed logs confirmed exact candidate checkout, installation, parser/helper checks and the complete Performer Connections suite passed. Lint, build, Chromium installation and the owned native-PostgreSQL stages subsequently advanced to the complete contract chain. The final result was not yet available when this checkpoint was written.

## Evidence boundaries

This hosted run is independent of the Windows run that became inaccessible. It does not retrieve, cancel, restart or certify that run. Its terminal result and the separate old registry result remain unknown unless their original receipts are later retrieved through an authorized non-DC path.

The generated Windows functions and two-process interruption test had focused native Windows evidence recorded before this continuation. A Linux run only executes the portable Windows-generator checks and explicitly skips native Windows runtime execution. Do not relabel that skip as a native pass. The existing conditional active-room-registry database skip must also remain visible if emitted.

The proof service publishes test evidence only, not the Sway application. A successful proof deploy is not a production release. Original failed attempts and previously committed receipts remain historical evidence for their exact revisions.

## Resume without rediscovery

Read the named deploy's final `SWAY_SOURCE_SUMMARY` and status first. Do not schedule another run while it is active. On completion, preserve exact launcher/candidate/tree, executed stage outcomes, skips and limitations in the task branch, then update PR249. Never substitute the previous reconnect gate at `58a6fc0` for the Windows candidate's result.

For future authorized Sway task-branch edits, use GitHub reads/writes and this existing isolated candidate runner. Reuse the service and pin the candidate; do not provision a new proof site for each commit. Keep auto-deploy and all production settings unchanged. Inspect only files required by the next failing transition. Do not touch other projects or treat the audit-runner branch as the product implementation branch.
