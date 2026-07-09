# Sway Control Bridge

The control bridge lets Stream Deck, Bitfocus Companion, MIDI routers, foot
pedals, browser macros, or small scripts trigger Sway cockpit actions without
tapping the phone or laptop screen.

It does not control Spotify, SoundCloud, Serato, rekordbox, or any other music
provider directly. It only controls Sway room actions and can return the top
track source URL when Sway has one.

## Direct (no local software)

Most control software (Bitfocus Companion, generic webhook/HTTP tools) can
attach a custom `Authorization` header to a button and needs nothing running
on the performer's machine. Point it straight at Sway's cloud API:

```text
POST https://app.sway.tips/api/talent/control-bridge/action/<action>
Authorization: Bearer YOUR_DASHBOARD_BRIDGE_TOKEN
Content-Type: application/json

{ "gig_id": "YOUR_GIG_ID" }
```

The performer dashboard's Hardware Controls panel issues the bridge token and
can download a ready-made preset (button URL, header, and body already filled
in) for Companion or Stream Deck import.

Actions: `toggle-requests`, `fulfill-top`, `hide-top`, `approve-pending`,
`veto-pending`, `open-top-source`, `search-top-spotify`,
`search-top-soundcloud`, `search-top-youtube`. Unlike the endpoints the
dashboard itself uses, these resolve their target automatically — you don't
need to know which request is currently "top approved" or "oldest pending",
the server figures that out.

This path doesn't work for raw Stream Deck without Companion (its native
"Website" action can't set a header) or for hardware that isn't HTTP-capable
at all (MIDI controllers, foot pedals) — use the local bridge below for those.

## Local bridge (MIDI, foot pedals, header-less tools)

```bash
npm run control:bridge -- --gig-id YOUR_GIG_ID --auth-token YOUR_DASHBOARD_BRIDGE_TOKEN
```

Defaults:

- local host: `127.0.0.1`
- local port: `4315`
- upstream Sway app: `https://app.sway.tips`

For a local Sway dev server:

```bash
npm run control:bridge -- --gig-id YOUR_GIG_ID --auth-token YOUR_DASHBOARD_BRIDGE_TOKEN --sway-url http://localhost:5173
```

The performer dashboard can issue a short-lived bridge token from Hardware
Controls. That token is preferred over copying a browser cookie. The local
bridge forwards it to Sway as the same `Authorization: Bearer` header used by
the direct path above — it's a thin translator for hardware that can't speak
HTTP with custom headers on its own, not a requirement for HTTP tools.

## Endpoints

Use HTTP `POST` buttons/macros for these URLs:

```text
http://127.0.0.1:4315/action/toggle-requests
http://127.0.0.1:4315/action/fulfill-top
http://127.0.0.1:4315/action/hide-top
http://127.0.0.1:4315/action/approve-pending
http://127.0.0.1:4315/action/veto-pending
http://127.0.0.1:4315/action/open-top-source
```

Read-only helpers:

```text
http://127.0.0.1:4315/health
http://127.0.0.1:4315/state
http://127.0.0.1:4315/preset/actions
http://127.0.0.1:4315/preset/companion
http://127.0.0.1:4315/preset/stream-deck
http://127.0.0.1:4315/top/text
http://127.0.0.1:4315/top/search
```

## Action Semantics

- `toggle-requests`: pauses or resumes inbound requests for the selected room
- `fulfill-top`: marks the current top approved/crowd-ranked request fulfilled
- `hide-top`: hides the current top approved/crowd-ranked request
- `approve-pending`: approves the oldest visible pending request
- `veto-pending`: denies the oldest visible pending request
- `open-top-source`: returns `{ action: "open_url", url }` for tools that can open a URL

Provider/search helper buttons:

```text
http://127.0.0.1:4315/action/search-top-spotify
http://127.0.0.1:4315/action/search-top-soundcloud
http://127.0.0.1:4315/action/search-top-youtube
```

These return `{ action: "open_url", url }` with a search URL for the current
top crowd pick. This matches the way many performers already work: they still
choose when and how to load/play the track, but Sway removes the typing.

Plain text helper:

```text
GET http://127.0.0.1:4315/top/text
```

Returns:

```text
Song Title - Artist
```

## Preset Exports

The bridge exposes JSON preset manifests for tools that can import or copy HTTP
button definitions:

```text
GET http://127.0.0.1:4315/preset/actions
GET http://127.0.0.1:4315/preset/companion
GET http://127.0.0.1:4315/preset/stream-deck
```

These are vendor-neutral button recipes. They do not install into Stream Deck
or Companion automatically. Use them to create HTTP Request / Open URL buttons
that call the local bridge action URLs.

## Security

The bridge token (used either as `Authorization: Bearer` directly, or via
`--auth-token` for the local bridge) acts like a short-lived signed-in performer session for protected Sway actions. Treat it like a password until
it expires (2 hours). Reissue and re-download the preset once it expires.

The local bridge binds to `127.0.0.1` by default. Do not expose it on public networks.
