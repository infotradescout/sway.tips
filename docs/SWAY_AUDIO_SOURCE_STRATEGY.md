# Sway Audio Source Strategy

Updated: 2026-09-12

## Governing decision for Sources and live playback control

Thomas's current direction is: "We need full integrations where possible, remember playback happens through whatever source but sway is the external controller."

Sway is the external controller. The selected source/player authenticates its own playback entitlement, obtains and decodes audio, manages its device/output, and performs playback. Sway connects the performer's request/queue workflow to that player through a supported control interface and displays the player's confirmed state.

The intended loop is:

`Connect source/account -> select playback app/device -> browse or sync available music -> approve a request -> send the supported source command -> observe source acknowledgement and actual playback state -> update Sway's display.`

File import and deep links are fallback capabilities, NOT completed provider integrations. A provider logo, exported CSV, successful command POST, OAuth login alone, or green test suite does not prove a full working source connection.

This current instruction supersedes earlier advice to defer all deep integrations and the proposal to turn this Sources lane into a paid Sway audio console. It does not remove Self-Production, owned-audio work, or the separate Sway.DIO product defined in `SWAY_PRODUCT_STRUCTURE.md`. Request, Tip, Boost, payment/refund history, memberships and provider payout decisions are unchanged.

## Keep music origin separate from playback target

A song's music service is not necessarily the application receiving the command.

Example: a TIDAL track available through VirtualDJ is controlled through VirtualDJ's supported interface. TIDAL authentication/subscription and playback remain in that approved playback stack. This is not direct control of the standalone TIDAL app, not a new Sway streaming entitlement, and not a reason to fetch or relay TIDAL audio.

The connection model must distinguish:

- music origin and immutable external track identifier;
- playback application/device and target deck where applicable;
- account/performer ownership and authorized room;
- connection identity, granted capabilities and their expiry;
- queued command, source acceptance, source-observed result and observation time.

Do not infer playback ability from a generic `local_library` flag or a provider name. A device accepting MIDI has different capabilities from a native API adapter reporting exact loaded-track identity.

## Full integration acceptance

Implement the maximum supported capability for each integration, explicitly marking unsupported operations rather than pretending every player has DJ-style decks.

1. Connection: actual OAuth/account authorization, native application permission or paired companion connection; protected credentials, expiry/refresh and disconnect/revocation.
2. Music access: real authorized library/playlist browsing or synchronization; stable track IDs, paging, unavailable/private/removed tracks and useful recovery.
3. Target selection: explicit player/device/deck; never silently redirect a command to another active device.
4. Control: supported play, pause, resume, stop, cue, seek, next/previous, queue or track-loading operations. `Load` must not secretly play a song and then pause it when the source lacks a paused-load operation.
5. Feedback: actual source status, current track, play/pause and position where the interface provides them; stale/offline state is visible and cannot be reported as confirmed playback.
6. Operational proof: connect a real account/player, choose a track, execute from Sway, observe the original source performing playback, reload/reconnect, and repeat without duplicate or misdirected commands.

A control request being accepted is not proof of playback. An exact-track match is not established by blindly loading the first title-search result. A source confirmation must not automatically fulfill or charge an audience request unless the separately approved room/payment semantics explicitly require that transition.

## Integration routes and evidence

The following distinguishes current repository behavior from primary-documentation research checked on 2026-09-12. A technically available interface is not evidence that Sway has implemented, obtained approval for, or production-verified that interface.

| Source / target | Integration route | Current boundary |
| --- | --- | --- |
| VirtualDJ | Official Network Control HTTP extension; exact-track load, transport and source-state feedback | Adapter and room-scoped bridge exist in Sway. Requires VirtualDJ 2023+ Pro and Network Control. Real booth verification remains distinct from simulated tests. |
| Serato, rekordbox, Traktor, djay | Supported app/controller mappings; pursue native/partner interfaces where available | Sway currently has one-way generic Web MIDI transport, not verified exact-track load or bidirectional state for these apps. Do not label MIDI dispatch as confirmed playback. |
| Apple Music | Native `SystemMusicPlayer` controls the Music app on supported Apple platforms; separately investigate desktop companion automation | Apple documents the native control route. It is not a browser API for remotely controlling an arbitrary Mac, iPhone or speaker. Sway does not yet have a complete native Apple Music connector. |
| Spotify | OAuth plus Player API / Spotify Connect device selection and remote controls | The remote-control API exists and requires Premium for playback. Sway currently uses catalog/metadata paths. Spotify's commercial/business-use restrictions must be resolved for the intended Sway use; moving audio out of the browser does not by itself resolve those restrictions. No universal venue-control claim. |
| TIDAL | Authorized library/account integration plus control of a supported DJ playback target; direct Connect requires its partner route | TIDAL documents Connect integrations for device partners. Do not claim an unrestricted public API controlling arbitrary TIDAL apps or hardware. |
| SoundCloud | Authorized OAuth/library integration plus supported DJ playback target; provider player interfaces only within their supported context | OAuth, libraries and widget playback/control are documented. A widget API is not proof of remote control over the standalone SoundCloud app. Sway's commercial use needs the appropriate provider permission. |
| YouTube / YouTube Music | Investigate supported account/catalog and player/partner interfaces, retaining the original player as playback owner | Do not substitute an embedded YouTube player and call it full remote control of YouTube Music. No direct Sway integration is established here. |
| Amazon Music, Deezer, Bandcamp, Engine DJ and other sources | Investigate documented native/partner control routes; preserve source ownership; export/deep-link fallback only where necessary | No direct integration is established by this document or by the export importer. Lack of current implementation is not a claim of technical impossibility. |
| Local / USB music | Existing DJ app or another explicitly paired supported player; metadata sync and source-owned playback | Imports do not upload or copy the audio. Exact private locations stay in the authorized booth path, not public audience payloads. |

Primary documentation:

- VirtualDJ Network Control: https://virtualdj.com/wiki/NetworkControlPlugin
- VirtualDJ scripting: https://virtualdj.com/wiki/VDJScript
- Apple SystemMusicPlayer: https://developer.apple.com/documentation/musickit/systemmusicplayer
- Spotify Start/Resume Playback: https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback
- Spotify Get Playback State: https://developer.spotify.com/documentation/web-api/reference/get-information-about-the-users-current-playback
- Spotify Developer Policy: https://developer.spotify.com/policy
- Spotify public/commercial use: https://support.spotify.com/us/article/spotify-public-commercial-use/
- TIDAL authorization: https://developer.tidal.com/documentation/api-sdk/api-sdk-authorization
- TIDAL Connect: https://developer.tidal.com/documentation/connect
- SoundCloud API guide: https://developers.soundcloud.com/docs
- SoundCloud public API usage: https://help.soundcloud.com/hc/en-us/articles/115003446727-SoundCloud-public-APIs

## Reuse the existing execution and persistence owners

The current code already has:

- reusable library sources, sync keys and `/api/library/sync`;
- parsers and a booth-side library bridge;
- `src/playback-control.ts` command and state contracts;
- durable `playback_commands` and `playback_states`;
- `src/server/playback-control-store.ts`;
- authenticated room-scoped playback and bridge endpoints;
- `scripts/sway-control-bridge.mjs` with local command outcomes;
- `scripts/lib/virtualdj-network-control.mjs`;
- `src/components/PerformerPlaybackController.tsx` with stale-state and room/source isolation;
- generic browser MIDI transport;
- a Windows VirtualDJ room connector plus the advanced Node bridge.

Extend these owners rather than starting parallel queues, a second performer dashboard, or a new audio-relay service. New source adapters must fit the source/target separation and supported action model; do not funnel every app through an assumed VirtualDJ-only contract.

## UX requirements

The Sources workspace should expose named choices and distinguish actions:

- `Connect account` or `Connect player` only for actual implemented connection flows;
- `Choose playback device` for selectable targets;
- `Control source` for available authorized controls;
- `Import file` for exported metadata;
- `Open in source` for a link, not remote control.

Show account connection and playback-device readiness separately. Each connection should show its supported controls and current condition: connected, device offline, authorization expired, source unavailable, mapping only, file import only, or provider setup required. No green Connected badge derived merely from stored song rows.

The live dashboard should show Now playing, Up next, the approved queue, the selected source/player and confirmed status. Audience screens should not show provider credentials, private library locations or setup complexity.

## Security and failure requirements

- No third-party audio proxy, DRM bypass, hidden embedded player, or source substitution in this lane.
- OAuth grants belong to the performer; encrypt stored provider credentials, request minimal scopes, and implement refresh/disconnect and deletion semantics.
- Native/booth permissions are explicit; no arbitrary script execution supplied by an audience request.
- Bind commands and acknowledgements to the correct room, performer, source connection and target. Switching targets or revoking a connection invalidates old pending work.
- Protect against expired commands, duplicate delivery, uncertain source responses and lost acknowledgements. Do not blindly replay a non-idempotent next/previous/queue command after a timeout.
- No optimistic claim that the track played. Keep queued, accepted, confirmed and uncertain outcomes distinct.
- Preserve source-specific restrictions and show the actual limiting condition; do not invent internal approval hurdles for work that is permitted.
- Do not grant new payment, payout, licensing or publication authority from this integration request.

## Current task status

`feat/music-sources-20260912` contains added file parsers and a source-import chooser. The chooser has not yet been wired into the existing Sources workspace, and those imports are not full account/player integrations. They remain useful fallback work, not the acceptance target.

This strategy update records the corrected product requirement and researched routes. It does not claim a new runtime adapter, account connection, release, provider authorization, or real-device test.
