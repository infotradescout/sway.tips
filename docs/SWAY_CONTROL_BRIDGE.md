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
npm run control:bridge -- --gig-id YOUR_GIG_ID --auth-cookie "YOUR_PERFORMER_COOKIE"
```

Defaults:

- local host: `127.0.0.1`
- local port: `4315`
- upstream Sway app: `https://app.sway.tips`

For a local Sway dev server:

```bash
npm run control:bridge -- --gig-id YOUR_GIG_ID --auth-cookie "YOUR_PERFORMER_COOKIE" --sway-url http://localhost:5173
```

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
```

## Action Semantics

- `toggle-requests`: pauses or resumes inbound requests for the selected room
- `fulfill-top`: marks the current top approved/crowd-ranked request fulfilled
- `hide-top`: hides the current top approved/crowd-ranked request
- `approve-pending`: approves the oldest visible pending request
- `veto-pending`: denies the oldest visible pending request
- `open-top-source`: returns `{ action: "open_url", url }` for tools that can open a URL

## Security

The bridge binds to `127.0.0.1` by default. Do not expose it on public networks.
The `--auth-cookie` value acts like the signed-in performer browser session for
protected Sway actions.
