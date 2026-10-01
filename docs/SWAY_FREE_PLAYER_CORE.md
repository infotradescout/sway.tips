# Free-player execution core

This source slice extracts VLC HTTP and mpv JSON IPC from draft PR #249 at
`943c90e63080cfa9b86014aa7b89c6c117632e67` onto released main
`bf23a3e40113c24169810a664220c96a45be66f1`. It does not bring the draft's Spotify
authorization, provider routes or database migration. The next slice adds the
existing native browser host/client and mounts its panel in the real Sources chooser.
It preserves the released controller and GrindZone host files.

The canonical native registry constructs the existing VLC/mpv adapters and reuses
the released VirtualDJ adapter. Its native-only capability descriptions do not
advertise cloud-account or MIDI adapters. VLC and mpv support explicit transport
for their single target (deck 1); library browsing and exact-track loading remain
outside this lane. No paid music-service account is required for the free players.

The shared journal reserves each command synchronously before player I/O and binds
its ID to owner, connection, revision, target and action. Duplicate IDs recover
their stored outcome without executing again. Unknown outcomes hold later actions
for the same target, including aliases. Reconnect changes the revision and preserves
that hold; explicitly reviewing the original player permits a new command, never
a replay. Storage failure prevents dispatch or leaves a conservative durable unknown.
The journal has an exclusive process lock and a bounded capacity; preserve it during
restart and supervised recovery.

Native receipts accept only a matching program/action/deck acknowledgement.
The VirtualDJ compatibility wrapper projects the delivered adapter's strict result
into that shape without duplicating its transport code or forwarding scripts/private
file observations. Native state projections omit booth-local file paths. Corrupt
or incompatible journal acknowledgements fail closed rather than becoming replayable.
This local OS-user journal is separate from cloud booth claims and completion echoes;
the released room-scoped receipt/expiry/target fences remain unchanged.

`scripts/sway-native-player-session.mjs` provides a non-network JSON-lines entry for
an authorized local operator and private configuration/journal. Importing the core,
listing connections, reading state or reconnecting does not implicitly start playback.
Do not run it against a player until that player's installation, interface and safe
output have explicit authority. No player or product-host listener was started while
extracting this source.

The hard contract chain includes `scripts/sway-native-player-adapters.test.mjs`.
Its HTTP/IPC servers simulate downstream protocols. On Windows it uses a synthetic
named pipe and actual child Node processes to test journal restart, target isolation,
strict acknowledgements and no replay. This is software proof, not an installed
VLC/mpv, Windows pipe ACL, physical audio, browser-consent or OS-reboot claim.

The Sources panel uses the existing account/performer/room context. Changes to that
scope, readiness or preview abort pending browser requests and forget pairing. It
never chooses an output automatically. A current observation must match the selected
connection, revision and immutable target before controls become available. Lost
confirmation stays held; refresh, reconnect and browser reload never retry it.

`npm run player:host -- PRIVATE_CONFIG.json ABSOLUTE_JOURNAL.json` starts the existing
local helper only after the operator has authorized player control. It listens on
numeric loopback, requires the exact Sway app origin and a fresh six-hour pairing key,
and exposes only allowlisted transport operations. The browser stores the key only
in memory; private player endpoints and credentials stay in the local config. Host
responses whitelist fields, strip path-like metadata and hide internal errors.
See [local setup](runbooks/native-player-connections.md).

Host/client tests and the real Sources chooser browser test use simulated downstream
players and an ephemeral browser permission grant. They do not prove normal user
consent, installation, Windows pipe ACLs, physical audio or an OS reboot. Actual
free-player acceptance still requires installation/control authority and normal local
network consent; these source changes do not bypass those decisions.
