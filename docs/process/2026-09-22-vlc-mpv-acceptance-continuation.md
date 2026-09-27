# VLC/mpv acceptance continuation — September 22, 2026

## Latest actual outcome

The owner directed continued execution after the workspace question. The existing Render workspace/service was used successfully; the earlier workspace block is resolved for this continuation. This is no longer an unexecuted runner checkpoint.

Exact product code tested: `4cde5a5afd68a5e9ab91d5eeb09bd76bdaaf145f`, PR #249, `implement/direct-music-control-20260916`.
Exact existing-runner launcher: `e7aac9ca48fab66b9643b1c03f18c9caa33c13c6`, branch `audit/readiness-223-room-recovery`.
Existing service: `sway-release-proof`, `srv-daesln0u01pc73fso5kg`.
Workspace: `My Workspace`, `tea-d191jph5pdvs73drglkg`.
Successful deployment: `dep-dapek7jm8hqs739hh2lg`, confirmed live at `2026-09-22T20:53:12.375623Z`.
Acceptance finished: `2026-09-22T20:53:09.096Z`.

Result: 35 focused native-host/adapter tests passed, zero failed or skipped. Seven browser scenario checks passed with actual VLC 3.0.23 and mpv 0.35.1. Independent read-only observers required actual playback-position advancement, not merely successful HTTP responses. Explicit VLC Play/Pause affected VLC only; separate mpv Play/Pause affected mpv only. Pairing and target switching sent no playback commands.

One VLC Next acknowledgement was deliberately lost after the original player replied. Exactly one downstream Next was recorded. Reconnect and browser reload preserved the exact uncertain command ID without repeating it. Explicit original-player review did not replay it, and a genuinely new deliberate Pause had a new ID. Owner remount and preview behavior also passed. Browser credentials did not enter local/session storage.

The run ended with the tracked source unchanged, no pending uncertainty after deliberate review, and the owned browser, players, host, journal lock and temporary workspace cleaned up. The runner preserved 29 earlier publication artifacts. No completed Mixxx, previous exact registry, old merge proof or unchanged full hosted gate was rerun.

## Actual defects repaired

1. `02d9b1d60e1f678d93c8f4f4a45e045895ce463f`: the published native-player registry lacked its closing function brace and could not import. The exact old blob was also reproduced locally: Node syntax check failed before the repair and passed after it.
2. `087f4d9e445e3d96a6e9c33f6ac18a97eb9580e0`: actual Chromium pairing failed with `Failed to execute 'fetch' on 'Window': Illegal invocation`. The default native browser fetch is now bound to its global receiver. Origin, authentication, deadlines, target binding, redirects and no-retry protections were not relaxed.
3. `4cde5a5afd68a5e9ab91d5eeb09bd76bdaaf145f`: repaired a published host-test assertion's missing parenthesis and added a default fetch-receiver regression. The successful run executed these exact committed tests.

`15499d3eb373876f1b3962815d17e63358834d03` added redacted browser diagnostics, a read-only host probe, and success/failure screenshots without removing earlier assertions. Three prior failed deployments remain recorded as failures in the receipt; their planned checks are not counted as passed. Earlier locally reported tests are not evidence that the broken published registry/test bytes passed.

## Evidence and boundaries

Committed observed summary: `docs/qa-packets/native-players-20260922/observed-result.json`.
Hosted packet: `https://sway-release-proof.onrender.com/native-players/4cde5a5afd68a5e9ab91d5eeb09bd76bdaaf145f/`.
Real-player/browser log SHA256: `800fd3ef09bdba9d665354d3b3bade8008edcda59c82970e9988465dff8d9e6e`.

Evidence was observed through connected Render logs and its deployment API. Raw hosted packet bytes and screenshots were not downloaded or visually inspected in this continuation; attempted retrieval failed. The committed JSON is explicitly an observed summary, not a byte-for-byte copy of the hosted receipt.

This proves the exact Sources native-player React panel, Chromium 148.0.7778.96, authenticated local host and stock Linux players with generated WAVs and dummy/null audio outputs. The browser test served the exact panel at the Sway origin through route interception, not through a signed-in production room. Local-network permission was granted by browser automation; no added network-security bypass flags were used. It does not prove physical speakers, Windows/macOS setup, manual permission prompting, customer installation, or a full signed-in application flow. Downstream lost-response injection covers VLC only; do not generalize it to mpv-specific browser acceptance or other providers.

## Existing service configuration after the run

The static site still has repository auto-deploy disabled. The connector's environment-update operation nevertheless triggered each deployment automatically. Do NOT manually trigger a duplicate deployment after a successful environment update.

Only these native-mode variables were merged; existing variables were not replaced:

- `SWAY_VLC_MPV_NATIVE_PROOF=true`
- `SWAY_NATIVE_PLAYER_CANDIDATE=4cde5a5afd68a5e9ab91d5eeb09bd76bdaaf145f`
- `SWAY_NATIVE_PLAYER_LAUNCHER=e7aac9ca48fab66b9643b1c03f18c9caa33c13c6`

These remain pinned to the completed run. No further run is scheduled by this checkpoint. Do not blindly turn the flag off through the environment tool: that write itself triggers deployment and can select older retained-history/full validation modes. Switch modes only as part of the next deliberate existing-service operation, preserve existing artifacts, and bind any new launcher explicitly. The launcher fails rather than silently testing a different source.

## Continue from here, not from the old workspace hold

The user-facing gap is now normal customer delivery: complete player onboarding/installer and the full signed-in Sources/performer-room flow, then observe physical supported-platform and browser-consent behavior. Finish mpv-specific lost-ack browser coverage and remaining advertised controls separately. Keep unsupported programs and capability limitations explicit; do not replace real integrations with a logo list or represent transport controls as library browsing.

Product changes remain on PR #249's draft branch. This continuation did not merge main or deploy production Sway, touch production databases/payments, activate paid accounts, provision services, use Desktop Commander, or alter the shared-host GrindZone files. Preserve earlier Mixxx/VirtualDJ/Spotify implementation and its own evidence boundaries. A passing isolated result does not close customer readiness or authorize a production release.
