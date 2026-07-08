# Sway Control Bridge

The control bridge is a local HTTP adapter for performer hardware workflows.
It lets Stream Deck, Bitfocus Companion, MIDI routers, foot pedals, browser
macros, or small scripts trigger Sway cockpit actions without tapping the phone
or laptop screen.

It does not control Spotify, SoundCloud, Serato, rekordbox, or any other music
provider directly. It only controls Sway room actions and can return the top
track source URL when Sway has one.

## Start

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
Controls. That token is preferred over copying a browser cookie.

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

The bridge binds to `127.0.0.1` by default. Do not expose it on public networks.
The `--auth-token` value acts like a short-lived signed-in performer session for
protected Sway actions. Treat it like a password until it expires.
