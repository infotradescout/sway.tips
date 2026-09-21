# Sway Performer Integration Truth Map

Date: 2026-08-30

## Decision

The current repo supports a real browser-based room, sharing, streaming-output,
and controller workflow. For VirtualDJ 2023+ Pro specifically, Sway can now
load a trusted exact local path (or search fallback), control transport, and
receive deck state through VirtualDJ's official Network Control extension.

The performer surface is currently:

- a standalone web console
- a room-share and QR flow
- a request/tip/boost queue manager
- branded and transparent streaming overlay routes
- persistent keyboard and WebMIDI room controls
- Stream Deck / Bitfocus Companion HTTP control presets
- a no-terminal Windows room connector for VirtualDJ

It is not yet:

- a built-in third-party audio playback engine
- native OBS scene/source automation
- a signed, installed desktop companion
- a direct deck integration for Serato, rekordbox, Traktor, or djay
- an audio/video broadcast engine

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
- transparent `/overlay/:gigId?transparent=1` Browser Source mode
- now playing card
- up-next list
- tips and boosts
- branded patron QR
- copy and direct-test actions in `/talent/connections`

Repo evidence:

- `src/shells/OverlayApp.tsx`
- `server.ts`

Verdict:

- real browser output; manual source setup

### 5. Booth controls

Implemented:

- persisted opt-in for keyboard and WebMIDI controls
- learnable keyboard and MIDI mappings
- controls stay armed across performer workspace navigation while the dashboard is open
- short-lived cloud control tokens
- downloadable Stream Deck / Bitfocus Companion HTTP button presets
- local control bridge for MIDI routers, foot pedals, and header-less tools
- downloadable, no-install Windows room connector for VirtualDJ
- durable playback command claim, local outcome ledger, acknowledgement, and
  low-rate deck state

Repo evidence:

- `src/components/TalentDashboard.tsx`
- `server.ts`
- `scripts/sway-control-bridge.mjs`
- `src/server/windows-booth-launcher.ts`
- `docs/SWAY_CONTROL_BRIDGE.md`

Verdict:

- real Sway room control and real VirtualDJ deck control; the primary Windows
  path no longer requires Node, a repository checkout, or terminal commands

## What Is Not A Native Integration

### 1. Music search / song library integration

Current truth:

- patron search can use manual entry, synced performer library rows, curated setlists, and a configured Spotify metadata catalog search
- Spotify catalog search is metadata/search only; it is not proof that Sway can play the track
- no production environment has a licensed full-track playback integration for Spotify, Apple Music, YouTube Music, TIDAL, Beatport, or SoundCloud
- VirtualDJ control is different: audio remains in the DJ's lawful local
  playback stack while Sway sends deck commands

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
- verified exact-path loading exists only when the path entered Sway through a
  trusted booth sync-key import and VirtualDJ can access that same path

### 2. Performer-side library matching

Current truth:

- performer library sources and track sync exist
- a local bridge can forward a normalized library snapshot to Sway
- request search can include performer library rows
- trusted synced paths can be sent to VirtualDJ for exact-path deck loading
- browser uploads deliberately strip executable local paths; other DJ apps do
  not yet receive exact-path loading or deck acknowledgement
- the cockpit still needs a clearer per-request deck-ready availability badge

Verdict:

- real availability and VirtualDJ loading layer; cross-app deck readiness and
  clearer operator feedback remain incomplete

### 3. OBS integration

Current truth:

- branded and transparent overlay web routes are ready for OBS/Streamlabs Browser Source
- the Connections workspace supplies exact URLs with copy and direct-test actions
- there is no OBS plugin, no OBS websocket integration, no scene/source automation, and no authenticated broadcaster workflow

Repo evidence:

- overlay exists in `src/shells/OverlayApp.tsx`
- no OBS integration identifiers were found in source

Verdict:

- real manual Browser Source workflow; no native OBS automation

### 4. DJ software integration

Current truth:

- VirtualDJ 2023+ Pro has bidirectional control through its official Network
  Control extension and Sway's booth bridge
- Sway can resolve an approved request to a trusted synced path, load it in
  VirtualDJ, control play/pause/stop/cue/next/previous, and display low-rate
  deck state plus command acknowledgement
- Serato, rekordbox, Traktor, and djay can receive one-way mapped Web MIDI
  transport through a virtual MIDI port; this lane cannot identify/load the
  requested track and receives no deck acknowledgement
- Stream Deck / Companion can use the authenticated local bridge for playback
  and room actions; header-capable tools can call cloud room actions directly
- rekordbox XML, Traktor NML, VirtualDJ XML, M3U, CSV, and audio folders have
  built-in booth import support
- Spotify remains metadata/import/open-only; TIDAL has no direct connector
- audio stays in the DJ source and mixer; Sway controls it but does not relay it

Verdict:

- real VirtualDJ source control is available; generic MIDI expands transport
  reach while deeper Serato/rekordbox/Traktor/djay adapters remain future work

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
- branded and transparent overlay/browser display
- persistent keyboard/WebMIDI room controls
- Stream Deck/Companion room-control preset
- one-click Windows VirtualDJ room connector
- real production music search or clearly manual request entry
- truthful performer copy about what is and is not integrated

### Needs real integration soon

- licensed or verifiable song search/catalog
- performer-side request-to-library workflow
- native OBS automation if demand justifies it
- first-party library exporters for specific DJ applications where lawful and technically supportable
- lawful audio playback strategy for owned/licensed/provider-approved tracks

### Can stay manual temporarily

- copy/paste room link
- print QR sign
- browser-based overlay opened manually in OBS browser source
- manual “now playing” management through queue actions
- opening matched tracks in the performer's existing music app

### Not present and should not be implied

- native OBS scene/source automation
- native DJ deck sync outside VirtualDJ
- signed desktop installers or automatic software updates
- automatic deck loading outside VirtualDJ
- native push-to-stream scene triggers
- Spotify/SoundCloud/third-party catalog playback from Sway

## Blunt Gap Summary

The repo is currently strongest at:

- payment/request lifecycle foundations
- performer auth
- room routing
- QR entry
- queue management
- manual OBS/Streamlabs browser outputs
- keyboard, MIDI, Stream Deck, and Companion control of Sway room actions
- synced library metadata and DJ export/audio-folder import
- exact-path VirtualDJ loading, transport, command acknowledgement, and deck state

The repo is currently weakest at:

- music ecosystem integration
- lawful audio playback
- native deck software integration beyond VirtualDJ
- stream/broadcast integration
- “this fits into a real DJ set” tooling

## Recommended Build Order For Performer Reality

1. Lock the performer MVP story in product copy:
   audience joins room, pays request/tip, performer manages queue, overlay can be opened in browser or OBS browser source manually
2. Prove the first real music source with booth users:
   harden the Windows VirtualDJ connector, then ship a signed/updatable desktop
   package if usage justifies it
3. Make “can I actually play this?” obvious per request:
   exact-path ready, search fallback, unavailable, and manual fallback
4. Strengthen overlay workflow for broadcast use:
   browser-source guidance, cleaner now-playing/up-next states, display-safe controls
5. Define the lawful audio source strategy:
   owned uploads, local files, approved provider playback, and prohibited provider claims
6. Expand only where the provider supports it:
   deeper Serato/rekordbox/Traktor/djay adapters and OBS automation

## Immediate Repo Truth

Do not claim the current app has:

- third-party music playback integrations
- OBS integration
- universal DJ software integration
- direct Serato, rekordbox, Traktor, or djay track loading/state
- built-in audio console playback

Do claim the current app has:

- performer login
- performer room creation
- performer queue management
- room QR/link sharing
- browser overlay route
- performer library metadata sync
- VirtualDJ 2023+ Pro control through the official Network Control extension
- no-terminal Windows VirtualDJ booth connection
