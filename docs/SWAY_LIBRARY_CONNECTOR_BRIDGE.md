# Sway Library Connector Bridge

## Purpose

This bridge is the first-party adapter for the "link any program" performer workflow.

It runs locally on the performer's machine and accepts simple HTTP `POST` requests from any DJ app, library manager, automation script, or companion tool that can emit JSON. The bridge forwards the normalized library snapshot to Sway using the performer's source-specific sync key.

## Start The Bridge

```bash
npm run library:bridge -- --sync-key YOUR_SYNC_KEY
```

Defaults:

- local bridge host: `127.0.0.1`
- local bridge port: `4314`
- upstream sync URL: `https://app.sway.tips/api/library/sync`
- snapshot mode: replace existing tracks for that linked source

## Local Endpoints

### `GET /health`

Returns bridge status and configured upstream target.

### `POST /ingest`

Accepts a performer-availability snapshot:

```json
{
  "replaceExisting": true,
  "tracks": [
    {
      "title": "Levels",
      "artist": "Avicii",
      "album": "Levels",
      "externalTrackId": "serato:crate-a:levels",
      "artworkUrl": "https://example.com/levels.jpg",
      "metadata": {
        "sourceApp": "serato"
      }
    }
  ]
}
```

Rules:

- `title` is required.
- `artist` falls back to `Unknown artist`.
- `replaceExisting: true` makes the sync authoritative for that source, removing tracks that were previously available but are not in the new snapshot.
- `replaceExisting: false` behaves as append/update only.

## Why Replace-Existing Matters

Performers need patron search to reflect what is actually available right now, not a stale pile of old imports. The default bridge behavior is an authoritative snapshot so removed songs disappear from search results for that linked source.

## Integration Pattern

Any local program can integrate if it can do one of these:

1. Send an HTTP `POST` to `http://127.0.0.1:4314/ingest`
2. Run a small companion script that sends the same JSON payload
3. Export track metadata into a tool you control, then forward it to the bridge

This keeps Sway generic instead of pretending there is only one supported DJ stack.
