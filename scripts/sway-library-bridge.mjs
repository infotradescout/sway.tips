import http from 'node:http';
import process from 'node:process';

const HELP_TEXT = `
Sway Library Bridge

Starts a local HTTP bridge so any DJ app, library manager, script, or companion
tool can push a performer's available tracks into Sway.

Usage:
  npm run library:bridge -- --sync-key <sync-key>

Options:
  --sync-key <key>       Required Sway sync key from the performer dashboard
  --sync-url <url>       Defaults to https://app.sway.tips/api/library/sync
  --host <host>          Defaults to 127.0.0.1
  --port <port>          Defaults to 4314
  --source-label <text>  Optional local label shown in bridge responses
  --replace-existing     Replace the previous source snapshot in Sway (default)
  --append-only          Keep prior tracks and only add/update incoming tracks
`;

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}

function normalizeTrack(input) {
  if (!input || typeof input !== 'object') return null;
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) return null;
  const artist = typeof input.artist === 'string' && input.artist.trim()
    ? input.artist.trim()
    : 'Unknown artist';

  return {
    title,
    artist,
    album: typeof input.album === 'string' && input.album.trim() ? input.album.trim() : undefined,
    artworkUrl: typeof input.artworkUrl === 'string' && input.artworkUrl.trim() ? input.artworkUrl.trim() : undefined,
    externalTrackId: typeof input.externalTrackId === 'string' && input.externalTrackId.trim() ? input.externalTrackId.trim() : undefined,
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : undefined
  };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString('utf8');
      if (body.length > 5_000_000) {
        reject(new Error('Bridge payload too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON body.'));
      }
    });
    req.on('error', reject);
  });
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  console.log(HELP_TEXT.trim());
  process.exit(0);
}

const syncKey = typeof args['sync-key'] === 'string' ? args['sync-key'] : process.env.SWAY_SYNC_KEY;
if (!syncKey) {
  console.error('Missing required sync key. Pass --sync-key or set SWAY_SYNC_KEY.');
  console.error('');
  console.error(HELP_TEXT.trim());
  process.exit(1);
}

const syncUrl = typeof args['sync-url'] === 'string'
  ? args['sync-url']
  : process.env.SWAY_SYNC_URL || 'https://app.sway.tips/api/library/sync';
const listenHost = typeof args.host === 'string'
  ? args.host
  : process.env.SWAY_LIBRARY_BRIDGE_HOST || '127.0.0.1';
const listenPort = Number(
  typeof args.port === 'string'
    ? args.port
    : process.env.SWAY_LIBRARY_BRIDGE_PORT || '4314'
);
const sourceLabel = typeof args['source-label'] === 'string'
  ? args['source-label']
  : process.env.SWAY_LIBRARY_SOURCE_LABEL || null;
const defaultReplaceExisting = args['append-only'] ? false : true;

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, {
      ok: true,
      bridge: 'sway-library-bridge',
      syncUrl,
      sourceLabel,
      defaultReplaceExisting
    });
  }

  if (req.method === 'POST' && req.url === '/ingest') {
    try {
      const body = await readJsonBody(req);
      const rawTracks = Array.isArray(body?.tracks) ? body.tracks : [];
      const tracks = rawTracks.map(normalizeTrack).filter(Boolean);
      const replaceExisting = typeof body?.replaceExisting === 'boolean'
        ? body.replaceExisting
        : defaultReplaceExisting;

      if (!tracks.length) {
        return sendJson(res, 422, { error: 'Bridge ingest requires at least one valid track title.' });
      }

      const upstreamResponse = await fetch(syncUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-sway-library-key': syncKey
        },
        body: JSON.stringify({
          tracks,
          replaceExisting
        })
      });

      const upstreamJson = await upstreamResponse.json().catch(() => null);
      return sendJson(res, upstreamResponse.status, {
        ok: upstreamResponse.ok,
        bridgeAcceptedCount: tracks.length,
        replaceExisting,
        sourceLabel,
        upstream: upstreamJson
      });
    } catch (error) {
      return sendJson(res, 400, {
        error: error instanceof Error ? error.message : 'Bridge ingest failed.'
      });
    }
  }

  return sendJson(res, 404, {
    error: 'Route not found. Use GET /health or POST /ingest.'
  });
});

server.listen(listenPort, listenHost, () => {
  console.log(`Sway Library Bridge listening at http://${listenHost}:${listenPort}`);
  console.log(`Forwarding performer availability to ${syncUrl}`);
  console.log('POST track snapshots to /ingest with JSON { "tracks": [ ... ] }');
  console.log(`Snapshot mode: ${defaultReplaceExisting ? 'replace-existing' : 'append-only'}`);
});
