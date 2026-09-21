# Sway DJ Library Bridge

## Outcome

The bridge imports the tracks available on the booth computer so audience
search and Sway's room controller can resolve the requested song. It sends
metadata and local file paths; it never uploads audio.

Built-in inputs:

- rekordbox XML
- Traktor NML
- VirtualDJ database XML
- M3U / M3U8
- CSV exports with common title/artist/path columns
- folders containing MP3, WAV, AIFF, FLAC, M4A, AAC, ALAC, OGG, Opus, or WMA

## One-shot import

1. In **Music → Advanced library connections**, create a source and copy its
   sync key.
2. Export the DJ library or choose its music folder.
3. Run:

```bash
npm run library:bridge -- \
  --sync-key YOUR_SYNC_KEY \
  --import "/path/to/rekordbox.xml"
```

Folder example:

```bash
npm run library:bridge -- \
  --sync-key YOUR_SYNC_KEY \
  --import "/Volumes/DJ MUSIC"
```

The server accepts at most 1,000 tracks per source snapshot in this release.
The command reports when an import reaches that bound.

`--append-only` adds/updates rows without removing older tracks. The default is
an authoritative replace, so tracks removed from the source disappear from
audience search.

## Local adapter mode

Programs or scripts that can already produce JSON can run the bridge as a
protected localhost adapter:

```bash
npm run library:bridge -- --sync-key YOUR_SYNC_KEY
```

Defaults:

- host: `127.0.0.1`
- port: `4314`
- upstream: `https://app.sway.tips/api/library/sync`

The bridge prints a random-token health URL. Use that token as a query value,
`Authorization: Bearer`, or `x-sway-bridge-token` when posting to `/ingest`.

```json
{
  "replaceExisting": true,
  "tracks": [
    {
      "title": "Track title",
      "artist": "Artist",
      "album": "Album",
      "externalTrackId": "stable-source-id",
      "metadata": {
        "path": "C:/Music/Track title.mp3",
        "bpm": 126,
        "key": "8A"
      }
    }
  ]
}
```

## Browser import versus booth import

The performer Music page can directly read rekordbox XML, Traktor NML,
VirtualDJ XML, M3U, and CSV. That route intentionally strips local path fields.
It is useful for request/search metadata but cannot instruct the booth computer
to open a file.

The booth bridge authenticates with a source-specific sync key and is the only
import lane allowed to persist exact local paths. Those paths let the
room-scoped VirtualDJ bridge load the requested file. Generic MIDI sources
cannot accept track identity and therefore use title/artist search or manual
selection instead.

## Security

- Sync keys are stored only as hashes by Sway and can be rotated or revoked.
- The local adapter is loopback-only unless explicitly overridden.
- Every local endpoint requires a random local token.
- Browser preflight is rejected and no permissive CORS header is emitted.
- Audio bytes are never sent by this bridge.
- Local paths remain performer-owned metadata and are not returned by public
  room/library responses.
