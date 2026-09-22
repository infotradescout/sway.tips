# VLC/mpv acceptance continuation — September 22, 2026

Product code under test: `ab21803ee2c735a211411f0e80402cea33b6ad12`, PR #249, `implement/direct-music-control-20260916`. This documentation-only continuation does not change that tested-code target. Installed VLC/mpv/browser acceptance has NOT executed or passed during this continuation.

Published a narrow runner on the existing `audit/readiness-223-room-recovery` branch, exact launcher `6f535891a66ae5a1fac5877e9a32801007525d67`:

- `scripts/sway-vlc-mpv-native-proof.mjs`
- `scripts/sway-vlc-mpv-native-runtime.mjs`
- An additive first-priority mode in `scripts/sway-release-validation.mjs`; all existing modes remain intact.

The runner binds both launcher and candidate identities, preserves cached/current published evidence without deleting `.validation-public`, fetches an isolated exact candidate, obtains Debian-signed package metadata and verifies extracted stock VLC/mpv package bytes, then runs the existing actual React native-player panel/browser test. Independent read-only observations require playback-position advancement for Play. The lost VLC Next response is dropped only after the real VLC endpoint replies; the runner requires exactly one downstream Next despite reconnect/reload. It uses generated audio and null outputs, not physical speakers. It does not repeat old registry/Mixxx/full hosted gates or use production databases/accounts.

Local `node --check` ran on the prepared modules. This is syntax validation, NOT browser/player acceptance. The published runtime and its launcher have not been executed together. Do not label their planned assertions as passed tests.

## Launch attempt and exact next action

Existing service was read successfully: `sway-release-proof`, `srv-daesln0u01pc73fso5kg`, static site, auto-deploy disabled, branch `audit/readiness-223-room-recovery`. Last observed live deployment: `dep-dap0f3btqb8s73esmtvg` at launcher `404dca9d62218493d8fab7d3e2ba8d735eb102a1`.

Attempted `Render.update_environment_variables` with the three native-mode variables below. Render rejected the write with `no workspace selected`. No environment update or deployment was confirmed. Listing workspaces returned `My Workspace`, ID `tea-d191jph5pdvs73drglkg`; explicit user confirmation is still required by the connector. The earlier Sway `YES` concerned Desktop Commander, not this workspace; do not reinterpret it.

After explicit confirmation of My Workspace, use that workspace ID on the existing service and merge (not replace) these variables:

- `SWAY_VLC_MPV_NATIVE_PROOF=true`
- `SWAY_NATIVE_PLAYER_CANDIDATE=ab21803ee2c735a211411f0e80402cea33b6ad12`
- `SWAY_NATIVE_PLAYER_LAUNCHER=6f535891a66ae5a1fac5877e9a32801007525d67`

Check that the audit branch has not advanced; the launcher intentionally fails on a mismatch. Because auto-deploy is disabled, explicitly trigger the existing service only after the environment update succeeds. Inspect the actual run and fix failures without weakening its assertions. On success, evidence is namespaced under `native-players/<candidate>/`; the old index is preserved and `native-players.html` points to the new packet. After the bounded run, set only the new mode flag false so older modes are no longer shadowed. Do not clear other mode variables or provision another service.

## Scope still open

Even a passing run would prove only the stated isolated Linux browser/native-player path. Physical Windows/macOS/browser permission acceptance, customer onboarding/installer, full signed-in production application, mpv-specific lost-ack browser acceptance, paid-provider lanes, and other program integrations remain separate. The existing browser scenario injects loss for VLC only. No new production readiness claim, main merge or production release is authorized by this receipt.

Side effects of this continuation: three commits to the existing audit runner branch, plus this documentation checkpoint on the existing product branch. No Desktop Commander, new service, production deployment, production database operation, paid-account activation or shared-host GrindZone modification. PR #249 was still draft/unmerged and reported non-mergeable when read; do not overwrite shared-host changes to resolve it.
