# Sway DJ Control Bridge

## What it does

Sway is the room controller. The audio stays in the DJ's playback source.

The booth-side connector links a live Sway room to VirtualDJ. The primary
Windows path is a generated, no-install room file; it does not require Node,
the Sway repository, or a terminal. An advanced Node bridge additionally
provides authenticated localhost buttons for Stream Deck, Bitfocus Companion,
MIDI routers, foot pedals, and scripts. Together these paths support:

- exact-path load of a crowd pick with a completed booth-library sync; Sway
  never auto-loads a title/artist search result
- play, pause, stop, cue, next, and previous
- selected-deck title, artist, play state, and BPM feedback in Sway; booth-local
  paths stay out of browser snapshots
- request pause/resume, approve, deny, fulfill, and hide actions
- current top-request text for overlays and automation

This is not audio streaming through Sway. VirtualDJ still decodes and outputs
the audio through the DJ's normal mixer/interface.

## Supported source today

Full bidirectional source control requires:

- VirtualDJ 2023 or newer
- a VirtualDJ Pro license
- VirtualDJ's official **Network Control** extension
- a Sway booth connector running on the booth computer

Official setup and endpoint reference:
`https://virtualdj.com/wiki/NetworkControlPlugin.html`

Serato, rekordbox, Traktor, and djay currently use Sway's one-way Web MIDI
transport instead. Create a virtual MIDI port (IAC Bus on macOS or loopMIDI on
Windows), select it in Sway, then use the DJ app's MIDI Learn. That lane sends
play/pause/stop/cue/next/previous but cannot identify and load a crowd track or
return deck state.

Spotify is metadata/import/open-only. Sway does not control Spotify playback.
TIDAL does not have a direct Sway connector in this release.

## Connect VirtualDJ on Windows

1. In the Sway performer app, start or select the live room.
2. Open **Connections** and select **Create connection**.
3. Download **Sway Booth for Windows** on the computer running VirtualDJ.
4. Double-click the downloaded `.cmd` room file.
5. Follow its prompts for the Network Control port, target deck, and optional
   password. Leave the Sway Booth window open during the room.

The generated file contains a room-scoped token, expires after six hours, and
only contacts the configured Sway app origin plus VirtualDJ on
`127.0.0.1`. Keep it private and download a new file for a later room.

The connector explains where to install/enable VirtualDJ Network Control and
checks the local endpoint before it starts polling Sway. No audio file is read,
uploaded, decoded, or relayed by the connector.

## Advanced Node bridge

Use the advanced bridge when the booth needs Stream Deck, Companion, MIDI
router, foot-pedal, or script endpoints, or when VirtualDJ runs on macOS.
This path currently requires Node and a checkout of the Sway repository.

1. Create the six-hour connection in **Connections**.
2. Expand **Advanced Stream Deck / Companion setup**.
3. Run the dashboard-provided command on the booth computer:

```bash
npm run control:bridge -- \
  --gig-id YOUR_GIG_ID \
  --auth-token YOUR_ROOM_TOKEN \
  --virtualdj-url http://127.0.0.1:8088
```

Add `--virtualdj-password YOUR_PASSWORD` when the extension requires one.
Use `--deck 2` to target another deck. Both the Sway bridge listener and the
VirtualDJ endpoint are loopback-only by default.

The bridge prints two protected URLs:

- health/status
- hardware preset manifest

Those URLs contain a random local token. Treat an exported preset as a secret.

## Command delivery and acknowledgement

Dashboard and hardware actions do not fire-and-forget into the booth:

1. Sway durably queues a room-scoped command with a client idempotency key and
   binds it to the fresh bridge instance and explicit target deck.
2. Only that authenticated bridge can claim the command on its short lease.
3. The bridge executes the matching VirtualDJ action.
4. It observes the selected deck after the command. Only a matching exact
   booth path can confirm an exact load. A request without that path fails
   before VirtualDJ mutation and must be loaded manually.
5. It writes the outcome to a bounded local ledger before acknowledging Sway.
6. It retries completion delivery without repeating a locally completed action.
7. Sway keeps VirtualDJ acceptance separate from source-state confirmation and
   displays stale, failed, or uncertain outcomes explicitly.

An expired claim lease is never requeued for another booth execution. If the
completion acknowledgement is lost, Sway marks the outcome uncertain until the
original bridge supplies its ledger result or the performer checks the deck.

The bridge also pushes low-rate deck state every two seconds. Sway uses server
receipt time—not the booth clock—to order those updates and determine
freshness. Stale state is shown as disconnected rather than pretending the
source is still online.

Play can be source-state confirmed only from `playing=true`; pause can be
confirmed only from `playing=false`. Stop and cue remain acknowledged rather
than confirmed because the current Network Control evidence does not
distinguish those outcomes from an already-paused deck. Confirmation evidence
must also fall within the server-owned claim-to-completion interval, with at
most five seconds of clock/transport skew on either boundary. Older deck state
cannot confirm a newly claimed command, while a valid saved completion remains
confirmed on later reads because Sway retains its server completion boundary.

## Local protected endpoints

Defaults:

- host: `127.0.0.1`
- port: `4315`
- Sway: `https://app.sway.tips`

Every endpoint requires the random local token printed by the bridge. The JSON
preset includes it in each localhost URL.

Read endpoints:

```text
GET /health
GET /state
GET /top/text
GET /preset/actions
GET /preset/companion
GET /preset/stream-deck
```

Playback endpoints:

```text
POST /playback/load-top
POST /playback/play
POST /playback/pause
POST /playback/stop
POST /playback/cue
POST /playback/next
POST /playback/previous
```

Room endpoints:

```text
POST /action/toggle-requests
POST /action/fulfill-top
POST /action/hide-top
POST /action/approve-pending
POST /action/veto-pending
POST /action/open-top-source
POST /action/search-top-spotify
POST /action/search-top-soundcloud
POST /action/search-top-youtube
```

Preset files are vendor-neutral HTTP button recipes; they do not install
themselves into Stream Deck or Companion.

## Direct cloud room actions

Companion or another tool that supports custom headers can call room actions
without local software:

```text
POST https://app.sway.tips/api/talent/control-bridge/action/<action>
Authorization: Bearer YOUR_ROOM_TOKEN
Content-Type: application/json

{ "gig_id": "YOUR_GIG_ID" }
```

Playback control still requires the booth bridge because Sway cannot reach a
loopback VirtualDJ process from the cloud.

## Security boundaries

- Cloud bridge tokens expire after 6 hours and are scoped to one room.
- Issuing another bridge token revokes the previous active bridge token for the
  same account and room, disconnects its state, expires unsent commands, and
  marks already-claimed work uncertain without replay.
- Local ledgers bind their restart-stable claimant identity to a non-secret
  fingerprint of that token generation. A same-token restart can deliver a
  saved completion; a replacement token rotates the identity and clears the
  unreachable prior generation locally.
- Bridge tokens are rejected by general performer, account, admin, and overlay
  routes.
- Playback claim, completion, and state routes require that exact room scope.
- The local listener binds to loopback and requires a separate random token.
- The local server does not emit CORS permission and rejects browser preflight.
- Remote listening or remote VirtualDJ URLs require explicit unsafe-network
  flags; do not use them on public venue networks.
- Browser library imports cannot persist executable local paths. Exact paths
  enter Sway only through a source-specific booth sync key.
- The downloadable Windows file embeds its expiring room token, sends it only
  to Sway's server-configured app origin, and never accepts a caller-selected
  remote VirtualDJ host.

## Failure behavior

- Bridge offline: controller shows disconnected and does not queue a command.
- VirtualDJ rejects a verb: command becomes failed with a safe public error;
  booth scripts, paths, and raw response bodies are not returned.
- Crowd pick has no exact synced booth path: Sway sends no VirtualDJ execute
  request and asks the performer to load it manually.
- Cloud response lost after execution: local outcome is retried, not re-run.
- Any failed or non-2xx cloud command submission retains its local command id;
  only a positive Sway receipt clears it, and different actions fail closed
  until that replay succeeds or the two-minute local safety window expires.
- Claim lease lost before completion: the command is not executed again; Sway
  reports an uncertain outcome and asks the performer to check the selected deck.
- VirtualDJ accepts a command but the follow-up state read fails: Sway reports
  accepted but unconfirmed, never confirmed playback.
- Command never claimed: it expires after the bounded command window.
- State stops arriving: Sway projects the source as disconnected after 15
  seconds.
