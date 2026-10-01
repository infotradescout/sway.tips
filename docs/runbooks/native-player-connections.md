# Connect an existing local player

Open Sources in your performer account on the computer running the player. An
active room must be confirmed before the local controls become available. VLC and
mpv use their supported local interfaces and need no paid music account or CSV.
Load an isolated test track in the original player yourself before testing playback.

This version uses the existing Node helper. It is not a one-click desktop installer.
Install or enable a player interface only with the computer owner's permission.
Use VLC's password-protected HTTP interface restricted to numeric loopback, or mpv's
private user IPC socket. A Windows mpv pipe needs separately verified user-only
access; the implementation's simulated pipe tests do not establish that permission.
VirtualDJ retains its existing supported interface and license requirements.

Keep a private JSON config on the player computer with stable connection IDs:

```json
{"connections":[{"id":"11111111-1111-4111-8111-111111111111","program":"vlc","baseUrl":"http://127.0.0.1:8080","password":"USE_YOUR_EXISTING_LOCAL_INTERFACE_PASSWORD"}]}
```

An mpv connection uses `program: "mpv"` and `socketPath` instead of `baseUrl` and
`password`. Use a private absolute Unix socket path or an authorized Windows named
pipe. Private config is never uploaded to Sway. Do not put passwords in command-line
arguments. There is no automatic player discovery or arbitrary URL control.

From this source checkout, use the already-installed Node runtime:

```text
npm run player:host -- PRIVATE_CONFIG.json ABSOLUTE_JOURNAL.json
```

The journal path must be absolute. Preserve this journal through restart: it owns
command history and uncertainty holds. An exclusive lock prevents concurrent owners;
after a crash, verify the old process has ended before supervised lock recovery.
Never delete history to clear an uncertain command.

Windows mpv pipe names are case-insensitive. This helper gives differently cased
names for the same local pipe one target identity, so aliases share uncertainty
and in-flight holds. Unix socket paths keep their case-sensitive identities.
New journals record the canonical Windows pipe identity format. An older journal
without that provenance cannot open a Windows mpv connection, including one with
a new connection ID. Preserve it for supervised migration; do not delete history
or add the format marker by hand. Migration must account for every original target
and unresolved outcome. Existing VLC/VirtualDJ and Unix mpv journals remain usable.
This source protection does not verify the Windows pipe's access-control list.

The helper listens only on `127.0.0.1:4316`, accepts only `https://app.sway.tips`, and
prints a private random pairing key valid for up to six hours. Keep its window open.
In Sources, enter that key under **Link player computer**. Allow local-network access
through the browser's normal prompt if requested. Do not disable browser security or
open firewall access. Pairing, listing, selecting, refreshing and reconnecting do not
start playback.

Choose the intended configured player explicitly. Controls appear only after a
current observation from that exact player. Press Play or Pause deliberately; audio
stays in the original program. An acknowledgement and observed playback are shown
separately. Transport controls do not browse libraries or load paths from the browser.

If delivery is uncertain, check the original player. Refresh and reconnect do not
resend the command. The uncertainty remains held on that target, including aliases,
until you explicitly save your review. Review permits a new button press with a new
identity; it never replays the old command. Changing account, room, readiness or
preview forgets browser authority. Reloading or forgetting pairing keeps the local
journal and does not stop/restart the player.

Release proof must distinguish simulated protocol/browser checks from actual player
identity, playback observation, normal consent, private IPC permissions and OS reboot.
