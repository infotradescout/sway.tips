# Direct music account connection and player control

## Product acceptance target
A performer connects a third-party account, browses its authorized music without an export/upload, chooses the playback destination, sends Play or another supported action, and sees the provider/player's separately reported state. Sway does not host, proxy, decode, or mix the audio in this implementation. A request approval does not automatically start music.

This candidate implements one direct provider adapter: Spotify. Existing manual imports are retained for compatibility below the direct connection panel and do not count as direct integrations. Apple Music, TIDAL, SoundCloud and other services are not implemented by this candidate.

## Operator prerequisites — never a customer setup chore
Before enabling real use, establish provider acceptance of Sway's exact commercial/live-event use, confirm required account eligibility and devices, and complete the corresponding data/privacy review. An application key, a Premium subscription, a user checkbox, or a synthetic OAuth test is not that approval.

Register the canonical redirect `https://app.sway.tips/api/talent/direct-music/spotify/callback` in the authorized Spotify application. The client ID is read from the existing `SWAY_SPOTIFY_CLIENT_ID`; Authorization Code with PKCE is used. Sway generates each verifier and state; users only authorize their account on Spotify.

`SWAY_MUSIC_TOKEN_KEY` is an independent, canonical base64-encoded 32-byte key from the operator's secret store. Tokens and PKCE verifiers use authenticated encryption scoped to the Sway actor, performer, connection, and generation. Keep the key out of source, browser storage, logs and evidence. Losing or rotating it makes existing credentials unusable; disconnect remains available without decrypting credentials, and users reconnect explicitly.

`SWAY_SPOTIFY_DIRECT_USE_APPROVED` defaults to false. `SWAY_SPOTIFY_DIRECT_APPROVAL_REFERENCE` must refer to actual reviewed authorization for the intended use, not an invented approval or a development test. A reference string records approval; it does not create it. The test fixture's reference is explicitly synthetic and must never be used as production configuration. No real approval or credentials were configured in this work.

Migration 0052 adds isolated authorization attempts, encrypted credentials, and command receipts. No previous migration or membership/payment table is changed. Apply migrations through the normal authorized deployment path; do not use a disposable-test database reset against production.

## Runtime behavior
The same authorized Sway account can reuse its music connection across rooms and after application restart. Direct browsing is read from Spotify; it does not replace stored request lists. Library views refresh while open. Device selection is persisted but does not start playback; commands explicitly name the target. A current device response rejects a removed/restricted device.

Supported commands are Play, Resume, Pause, Next, Previous, Queue and explicit non-autoplay transfer. An accepted command is reported as accepted, not as completed playback. Only a separate provider state read updates Playing/Paused and track information. Missing, old or failed state disables controls. Provider rate limits persist a cooldown; revoked authorization requires reconnect.

A command ID and payload hash are durably reserved before a non-idempotent provider operation. The same command cannot silently replay after response loss or process failure. An uncertain result requires a deliberate state check; there is no automatic resend. Disconnect removes this direct connection's stored credentials and command records, while leaving independently saved manual lists alone. It does not stop music already playing in another application.

## Verification boundaries
Provider/client tests use injected responses. Store/router tests use the real database access layer. Full-app browser tests use actual Sway account signup/sign-in, React, HTTP routes and persisted records; only the provider's authorization consent and API responses are simulated. Standalone PostgreSQL proof is separate from PGlite. Neither environment proves real Spotify permissions, actual device compatibility, audible playback or production behavior.

The three new suites are mandatory in the existing Sources/Connections contract. Original Sources, player and design assertions remain. The presentation-only design fixture explicitly supplies its new read-only overview, rather than suppressing unexpected network checks.

## Safe rollout and rollback
Keep direct use disabled until an approved provider route, live operator configuration, privacy handling and an actual-device acceptance test exist. Separately authorize migration/deploy and bind verification to that exact revision. Existing Sources production must not be described as having this adapter before release.

To withdraw direct use, turn approval off while retaining the disconnect route so users can remove authorization. Do not silently roll back to code that cannot disconnect newly created credentials. Prefer a coherent roll-forward or an explicit offboarding/rollback plan. Do not destructively drop stored tables or reset customer data.

## Primary provider references
- Policy: https://developer.spotify.com/policy
- Player API: https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback
- PKCE: https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow
- Current API migration: https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide

## September 17 continuation
Verification and resume checkpoint: `docs/process/2026-09-17-direct-music-continuation.md`. Exact-runtime receipts: `docs/qa-packets/direct-music-20260917/`. Spotify account linking now requires immutable `/me.account_id`, introduced in May 2026; public `id` is never a fallback, and display name is presentation-only. This pre-release fix does not migrate production data. Primary source: https://developer.spotify.com/documentation/web-api/reference/get-current-users-profile .
