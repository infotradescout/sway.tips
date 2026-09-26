# Multi-program native connections — developer preview

Sway keeps the music service/library and the playback application distinct. The existing Spotify account component is preserved byte-for-byte as `PerformerSpotifyConnection.tsx`; the existing Sources entry now also mounts `NativePlayerConnections`. Native targets share one capability-aware host, registry and durable dispatch mechanism. The current factory implements VLC HTTP, mpv JSON IPC and the existing VirtualDJ adapter. Mixxx stays on its existing one-way MIDI mapping. Other program names must not be advertised as working adapters.

This is a developer preview, not a customer-ready one-click installer. It requires Node 22 and a checkout on the **same computer** as the browser and player. No Desktop Commander, streaming subscription, customer developer app or CSV is involved in the native route. There is no phone-to-booth cloud relay in this addition. Spotify and VirtualDJ retain their own prerequisites and separate live acceptance requirements.

## Setup

Configure each original player using its own supported control interface. Load an authorized local track or playlist in that program; this host does not accept arbitrary track URLs or command strings. VLC HTTP must bind to numeric loopback and use a password. mpv IPC must use a local Unix socket in a private user-owned directory or an appropriately restricted Windows named pipe. Do not expose these endpoints to a LAN or Internet port. The new code has not established Windows pipe ACL or macOS acceptance.

Create a private JSON file (0600 on Unix) containing an array under `connections`. Assign a different stable UUID to each intended program/endpoint/deck. A VLC entry uses `id`, `program: "vlc"`, `baseUrl` and `password`; an mpv entry uses `id`, `program: "mpv"` and `socketPath`; a VirtualDJ entry uses `id`, `program: "virtualdj"`, `baseUrl`, optional `password` and explicit `deck`. VLC/mpv have one target, deck 1. Do not commit this private file or paste its passwords into support logs.

Run:

```sh
node scripts/sway-player-host.mjs /absolute/private/connections.json /absolute/private/player-journal.json
```

The journal directory must already exist and be private. The host binds only to `127.0.0.1:4316` and displays a fresh six-hour pairing key to the local operator. In Sway Sources on that same computer, use **Link player computer**, enter the key, grant the browser's requested local-network permission, and choose the exact target. Pairing and selection do not start playback. The key is held only in browser memory; changing account context, forgetting pairing or reloading requires pairing again. No key is sent in a URL or stored in browser local/session storage.

The host accepts only the exact `https://app.sway.tips` Origin and a valid unexpired pairing key. This local-operator authorization does not authorize cloud account/room operations. Production CSP and actual installed-browser/OS network-permission behavior remain release acceptance items; do not disable browser protections to make setup appear to work.

## Capabilities and delivery

The shared descriptions enumerate native, cloud account and MIDI connection kinds, not verified-program counts. Native actions are intersected with each implemented adapter. This host exposes Play/Pause/Stop/Next/Previous for VLC/mpv; no library browse or track loading is implied. The VirtualDJ lane adds Cue; its existing approved-library loading route remains separate. Returned metadata may be absent. An accepted command is not itself an observed playback state.

Every command is reserved durably before original-player I/O. Its identity is bound to owner, connection, revision, protocol, endpoint, program, deck and action. A duplicate returns the original outcome without dispatch. A changed payload or reused identity for another target fails. Any uncertain outcome holds later actions for that target, including another configured alias. Reconnect rotates revision but preserves unknown history. Explicit original-player review allows a genuinely new action; it never replays the old one. Browser refresh is read-only.

A single process owns the journal lock. Storage failure holds commands. A crash-left lock must not be deleted simply because it is old: verify the original process is no longer running, preserve the journal and inspect uncertainty before supervised lock recovery. Never erase a journal to bypass an unknown result. Capacity is bounded; archival requires supervision instead of silently dropping old deduplication history.

## Validation

```sh
node --test scripts/sway-native-player-adapters.test.mjs scripts/sway-native-player-host.test.mjs
node scripts/sway-native-player.browser.test.mjs
```

The existing Sources acceptance runner invokes these files; older checks are retained. Protocol/HTTP/IPC tests are not installed-player acceptance. Browser fixture tests use actual local host requests but simulated downstream players. Native tests must name the exact source, binary versions, real player observations, any fault injection, and limits such as null audio or an isolated component rather than the full signed-in app.

Official protocol references:
- https://raw.githubusercontent.com/videolan/vlc/3.0.x/share/lua/http/requests/README.txt
- https://mpv.io/manual/stable/#json-ipc
- https://developer.chrome.com/release-notes/142
