# Sway Performer Integration Truth Map

Date: 2026-07-01

## Decision

The current repo supports a basic performer room and queue console, but it does not yet support the real performer toolchain a working DJ or live performer needs.

The performer surface is currently:

- a standalone web console
- a room-share and QR flow
- a request/tip/boost queue manager
- a basic overlay route

It is not yet:

- a built-in third-party audio playback engine
- an OBS-integrated streaming workflow
- a DJ software companion
- a real-time broadcast/control hub

## Product Reality

If Sway is meant for real performers and DJs, the performer-side MVP is not only money plus queue.

It also needs to support the performer operating environment:

- finding songs quickly
- matching requests to real catalog/library availability
- displaying queue/now-playing cleanly on stream or in-room screens
- fitting into an active performance setup without slowing the performer down

## What Exists Now

### 1. Performer account and room ownership

Implemented:

- performer signup with email/password
- performer session issuance and revocation
- performer room start/end/closeout routes
- performer-specific active room summaries

Repo evidence:

- `server.ts`
- `src/server/performer-login.ts`
- `src/server/performer-password-auth.ts`
- `src/server/performer-session-store.ts`
- `src/shells/TalentApp.tsx`

Verdict:

- real foundation

### 2. Performer queue console

Implemented:

- start live room
- pause/resume requests
- switch operating mode
- approve/deny requests
- fulfill requests
- hide/remove requests
- request window presets

Repo evidence:

- `src/components/TalentDashboard.tsx`
- `src/shells/TalentApp.tsx`
- `server.ts`

Verdict:

- real but web-console-only

### 3. Room-share flow

Implemented:

- room link generation
- QR code generation
- copy room link
- open patron room
- download QR sign
- print QR sign

Repo evidence:

- `src/components/PerformerShareKit.tsx`

Verdict:

- real and useful

### 4. Overlay / display output

Implemented:

- separate `/overlay/:gigId` surface
- now playing card
- up-next list
- empty-state overlay

Repo evidence:

- `src/shells/OverlayApp.tsx`
- `server.ts`

Verdict:

- real but minimal

## What Is Fake, Preview-Only, Or Not Production-Ready

### 1. Music search / song library integration

Current truth:

- patron search can use manual entry, synced performer library rows, curated setlists, and a configured Spotify metadata catalog search
- Spotify catalog search is metadata/search only; it is not proof that Sway can play the track
- no production environment has a licensed full-track playback integration for Spotify, Apple Music, YouTube Music, TIDAL, Beatport, or SoundCloud

Repo evidence:

- `src/components/PatronView.tsx`
- `server.ts` route `POST /api/music/search`
- `src/server/spotify-catalog.ts`
- `docs/SWAY_AUDIO_SOURCE_STRATEGY.md`

Verdict:

- useful for request matching, not production audio playback

Impact:

- no Spotify playback from Sway
- no Apple Music playback from Sway
- no YouTube Music playback from Sway
- no TIDAL playback from Sway
- no SoundCloud playback from Sway
- no Beatport playback from Sway
- no verified local library match flow

### 2. Performer-side library matching

Current truth:

- performer library sources and track sync exist
- a local bridge can forward a normalized library snapshot to Sway
- request search can include performer library rows
- this is metadata/availability sync, not audio playback or deck loading
- no deck-ready availability indicator

Verdict:

- real first layer, still missing playback and deck integration

### 3. OBS integration

Current truth:

- there is an overlay web route
- there is no OBS plugin, no OBS websocket integration, no scene/source automation, and no authenticated broadcaster workflow

Repo evidence:

- overlay exists in `src/shells/OverlayApp.tsx`
- no OBS integration identifiers were found in source

Verdict:

- no real OBS integration

### 4. DJ software integration

Current truth:

- no Serato integration
- no Rekordbox integration
- no Traktor integration
- no VirtualDJ integration
- no djay integration
- no MIDI/controller integration

Verdict:

- missing entirely

### 5. Real-time performer notifications beyond polling

Current truth:

- the app is intentionally designed so WebSocket is enhancement-only
- current performer/patron surfaces rely on fetch/polling patterns
- no live broadcast transport implementation was found

Repo evidence:

- docs explicitly forbid WebSocket-only truth
- no websocket implementation found in app runtime

Verdict:

- safe architecture direction, but no richer real-time integration layer exists yet

## Must-Have Integration Matrix

### Must have now for a credible performer MVP

- room QR and share flow
- performer login/account ownership
- performer queue actions
- clean overlay/browser display
- real production music search or clearly manual request entry
- truthful performer copy about what is and is not integrated

### Needs real integration soon

- licensed or verifiable song search/catalog
- performer-side request-to-library workflow
- stream/display workflow stronger than a bare browser overlay
- lawful audio playback strategy for owned/licensed/provider-approved tracks

### Can stay manual temporarily

- copy/paste room link
- print QR sign
- browser-based overlay opened manually in OBS browser source
- manual “now playing” management through queue actions
- opening matched tracks in the performer's existing music app

### Not present and should not be implied

- native OBS automation
- DJ deck software sync
- playlist/crate import
- automatic library match
- automatic song loading to deck
- native push-to-stream scene triggers
- Spotify/SoundCloud/third-party catalog playback from Sway

## Blunt Gap Summary

The repo is currently strongest at:

- payment/request lifecycle foundations
- performer auth
- room routing
- QR entry
- queue management
- synced library metadata

The repo is currently weakest at:

- music ecosystem integration
- lawful audio playback
- performer workflow integration
- stream/broadcast integration
- “this fits into a real DJ set” tooling

## Recommended Build Order For Performer Reality

1. Lock the performer MVP story in product copy:
   audience joins room, pays request/tip, performer manages queue, overlay can be opened in browser or OBS browser source manually
2. Decide the first real music source:
   one production connector with a clear capability matrix, or explicit manual-entry-only mode
3. Add performer-side “can I actually play this?” workflow:
   available, not available, manual fallback
4. Strengthen overlay workflow for broadcast use:
   browser-source guidance, cleaner now-playing/up-next states, display-safe controls
5. Define the lawful audio source strategy:
   owned uploads, local files, approved provider playback, and prohibited provider claims
6. Only then consider deeper integrations:
   OBS automation, DJ software sync, library import

## Immediate Repo Truth

Do not claim the current app has:

- third-party music playback integrations
- OBS integration
- DJ software integrations
- built-in audio console playback

Do claim the current app has:

- performer login
- performer room creation
- performer queue management
- room QR/link sharing
- browser overlay route
- performer library metadata sync
