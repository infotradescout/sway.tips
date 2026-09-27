# Sway — actual free Mixxx transport acceptance

## Objective and current source

The owner has no paid accounts and requested that Sway's free-player connection be built and tested without Desktop Commander. The operator controls the original player; audience requests/tips/boosts never trigger playback. Base product branch: `implement/direct-music-control-20260916`, PR249, `68b6e8dc6e61cc1e3b0ca530ef11d0f0b5b93d5f`. Current product candidate is the commit containing this checkpoint.

## Actual result

PASS for the bounded real-player lab, not complete production/Windows acceptance. The existing Sway React playback component and MIDI sender controlled stock Mixxx 2.3.3. Play advanced selected deck 2 while deck 1 stayed paused. An independent JACK client captured actual non-silent Mixxx audio. Pause stopped the position and captured audio became exactly silent. Disconnect/reconnect, a response lost after a delivered Play, and browser reload did not cause an automatic replay. New deliberate Pause and Stop worked afterward. Ten native assertions passed. The final outer run, including first-run dialog handling, child/display cleanup and artifact publication, succeeded.

The MIDI cable and device notification/response-loss injection were explicitly test-only. Mixxx's executable, MIDI parser, JavaScript mapping engine, decoder and audio output were real. The exact test mapping was not allowed to fake player observations; a separate read-only observer queried Mixxx state. This is not a physical OS MIDI-driver/permission test, full signed-in application test, Windows booth CMD test, Spotify/VirtualDJ approval, or playback feedback implemented in Sway.

## Delivered source

`public/mixxx/Sway-Mixxx.js` and `.midi.xml` implement explicit Play/Pause/Stop/Cue on four decks, with no startup/reconnect actions, no Note Off replay and no arming of unloaded decks. Load/Next/Previous are deliberately not mapped. `public/mixxx/README.md` documents local routing prerequisites, installation, unsupported actions and evidence boundaries. The exact assets used by Mixxx are preserved in the product commit. Twelve mapping unit tests passed; the existing Sources acceptance runner includes them without replacing its older checks.

The React component, browser sender, server, schema, dependencies, payments, provider eligibility, existing VirtualDJ repair and shared-host GrindZone code are unchanged. No main merge or production deployment.

## Exact evidence and runner

Observed receipt: `docs/qa-packets/mixxx-free-player-20260920/observed-result.json`.
Actual UI source: `68b6e8dc6e61cc1e3b0ca530ef11d0f0b5b93d5f`; its component/sender/type blobs are recorded there.
Auxiliary native launcher: `b913047b9da66eb038e1f12c130853f7174607e2`, branch `audit/readiness-223-room-recovery`.
Existing service: `srv-daesln0u01pc73fso5kg`, workspace `tea-d191jph5pdvs73drglkg`.
Evidence deployment: `dep-daoad0btqb8s73ei05ng`, live at `2026-09-21T03:38:36.844529Z`.
Native interval: `2026-09-21T03:38:09.555Z` through `2026-09-21T03:38:30.894Z`.

The owned auxiliary runner files are `scripts/sway-mixxx-bootstrap.mjs`, `scripts/sway-mixxx-native-run.mjs`, `scripts/sway-mixxx-native-core.mjs`, `scripts/fixtures/mixxx-virtual-midi.c` and `scripts/fixtures/mixxx-capture-jack.c`. They remain on the auxiliary branch rather than becoming production code or customer dependencies. Earlier setup failures and the penultimate outer-dialog failure remain historical; only the final complete run is reported passed.

## Continuation and retry safety

The completed free-player lab is no longer blocked on buying Pro accounts or obtaining DC. Do not repeat merge reconciliation, registry verification or unchanged full hosted gates. Do not claim this installs anything on the owner's computer. The customer-side remaining work is normal local Mixxx and MIDI routing setup and real operating-system/browser device acceptance. Full feedback, automatic loading, Next/Previous and the independent Spotify/VirtualDJ lanes remain separate unverified work.

Preserve the current proof service's raw `mixxx-native.json`, `mixxx-bootstrap.json`, PNG captures and playing/paused WAV captures before another use. Its explicit Mixxx mode is still selected, with expected launcher `b913047b9da66eb038e1f12c130853f7174607e2`; do not redeploy it blindly. Prior merge/registry evidence was copied unchanged rather than rerun. Rollback is the bounded mapping/test/README addition; no data or migration rollback exists.
