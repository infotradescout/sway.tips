import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import process from 'node:process';
import { importDjLibraryPath } from './lib/dj-library-importers.mjs';

const HELP_TEXT = `
Sway DJ Library Bridge

Imports the booth computer's library into Sway. Exact local paths remain
private performer metadata and let Sway ask a local playback bridge to load the
right file; audio never uploads through this tool.

One-shot import:
  npm run library:bridge -- --sync-key <key> --import <file-or-folder>

Supported input:
  rekordbox XML, Traktor NML, VirtualDJ XML, M3U/M3U8, CSV, or an audio folder

Local adapter mode:
  npm run library:bridge -- --sync-key <key> [--port 4314]
  POST protected JSON snapshots to /ingest as { "tracks": [ ... ] }

Options:
  --sync-key <key>       Required source key from the performer dashboard
  --sync-url <url>       Defaults to https://app.sway.tips/api/library/sync
  --import <path>        Parse, sync, report, and exit
  --host <host>          Defaults to 127.0.0.1
  --port <port>          Defaults to 4314
  --local-token <token>  Local HTTP secret (random when omitted)
  --allow-remote-listen  Permit a non-loopback listener
  --source-label <text>  Optional label in local status output
  --replace-existing     Replace the source snapshot (default)
  --append-only          Add/update tracks without removing older rows
`;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) result[key] = true;
    else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

function normalizeTrack(input) {
  if (!input || typeof input !== 'object') return null;
  const title = typeof input.title === 'string' ? input.title.trim().slice(0, 160) : '';
  if (!title) return null;
  const artist = typeof input.artist === 'string' && input.artist.trim()
    ? input.artist.trim().slice(0, 160)
    : 'Unknown artist';
  return {
    title,
    artist,
    album: typeof input.album === 'string' && input.album.trim() ? input.album.trim().slice(0, 160) : undefined,
    artworkUrl: typeof input.artworkUrl === 'string' && input.artworkUrl.trim() ? input.artworkUrl.trim().slice(0, 512) : undefined,
    externalTrackId: typeof input.externalTrackId === 'string' && input.externalTrackId.trim() ? input.externalTrackId.trim().slice(0, 256) : undefined,
    metadata: input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
      ? input.metadata
      : undefined
  };
}

function normalizePort(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : fallback;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff'
  });
  res.end(JSON.stringify(payload, null, 2));
}

function safeTokenEqual(candidate, expected) {
  if (typeof candidate !== 'string' || !candidate || candidate.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
}

function requestAuthorized(req, requestUrl) {
  const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || null;
  const headerToken = typeof req.headers['x-sway-bridge-token'] === 'string' ? req.headers['x-sway-bridge-token'] : null;
  return safeTokenEqual(requestUrl.searchParams.get('token') || bearer || headerToken, localToken);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString('utf8');
      if (body.length > 10_000_000) {
        reject(new Error('Bridge payload exceeds 10 MB.'));
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

async function syncTracks(rawTracks, replaceExisting) {
  const tracks = rawTracks.slice(0, 1_000).map(normalizeTrack).filter(Boolean);
  if (!tracks.length) throw new Error('Import requires at least one valid track title.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(syncUrl, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-sway-library-key': syncKey
      },
      body: JSON.stringify({ tracks, replaceExisting }),
      signal: controller.signal
    });
    const text = await response.text();
    let upstream = null;
    try {
      upstream = text ? JSON.parse(text) : null;
    } catch {
      upstream = { raw: text };
    }
    if (!response.ok) {
      throw new Error(typeof upstream?.error === 'string' ? upstream.error : `Sway rejected the library snapshot (${response.status}).`);
    }
    return { tracks, upstream };
  } finally {
    clearTimeout(timeout);
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  console.log(HELP_TEXT.trim());
  process.exit(0);
}

const syncKey = typeof args['sync-key'] === 'string' ? args['sync-key'] : process.env.SWAY_SYNC_KEY;
const syncUrl = typeof args['sync-url'] === 'string'
  ? args['sync-url']
  : process.env.SWAY_SYNC_URL || 'https://app.sway.tips/api/library/sync';
const listenHost = typeof args.host === 'string' ? args.host : process.env.SWAY_LIBRARY_BRIDGE_HOST || '127.0.0.1';
const listenPort = normalizePort(typeof args.port === 'string' ? args.port : process.env.SWAY_LIBRARY_BRIDGE_PORT, 4314);
const localToken = typeof args['local-token'] === 'string'
  ? args['local-token']
  : process.env.SWAY_LIBRARY_LOCAL_TOKEN || randomBytes(24).toString('base64url');
const sourceLabel = typeof args['source-label'] === 'string' ? args['source-label'] : process.env.SWAY_LIBRARY_SOURCE_LABEL || null;
const replaceExisting = !args['append-only'];
const importPath = typeof args.import === 'string' ? args.import : null;

if (!syncKey) {
  console.error('Missing --sync-key. Create a linked library source in the performer dashboard first.');
  console.error(HELP_TEXT.trim());
  process.exit(1);
}

if (importPath) {
  try {
    const imported = await importDjLibraryPath(importPath);
    if (!imported.tracks.length) throw new Error('No supported tracks were found at that path.');
    const result = await syncTracks(imported.tracks, replaceExisting);
    console.log(JSON.stringify({
      success: true,
      format: imported.format,
      inputPath: imported.inputPath,
      parsedCount: imported.tracks.length,
      syncedCount: result.tracks.length,
      truncated: imported.truncated,
      replaceExisting,
      upstream: result.upstream
    }, null, 2));
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Library import failed.');
    process.exit(1);
  }
}

if (!LOOPBACK_HOSTS.has(listenHost) && !args['allow-remote-listen']) {
  console.error('The library bridge binds only to loopback unless --allow-remote-listen is explicit.');
  process.exit(1);
}

function localUrl(route) {
  const hostname = listenHost === '::1' ? '[::1]' : listenHost;
  const url = new URL(`http://${hostname}:${listenPort}${route}`);
  url.searchParams.set('token', localToken);
  return url.toString();
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${listenHost}:${listenPort}`);
  if (req.method === 'OPTIONS') return sendJson(res, 405, { ok: false, error: 'Browser cross-origin requests are disabled.' });
  if (!requestAuthorized(req, requestUrl)) return sendJson(res, 401, { ok: false, error: 'Local bridge token required.' });

  if (req.method === 'GET' && requestUrl.pathname === '/health') {
    return sendJson(res, 200, {
      ok: true,
      bridge: 'sway-dj-library-bridge',
      syncUrl,
      sourceLabel,
      replaceExisting,
      supportedInput: ['rekordbox XML', 'Traktor NML', 'VirtualDJ XML', 'M3U/M3U8', 'CSV', 'audio folder']
    });
  }

  if (req.method === 'POST' && requestUrl.pathname === '/ingest') {
    try {
      const body = await readJsonBody(req);
      const bodyReplaceExisting = typeof body?.replaceExisting === 'boolean' ? body.replaceExisting : replaceExisting;
      const result = await syncTracks(Array.isArray(body?.tracks) ? body.tracks : [], bodyReplaceExisting);
      return sendJson(res, 202, {
        ok: true,
        bridgeAcceptedCount: result.tracks.length,
        replaceExisting: bodyReplaceExisting,
        sourceLabel,
        upstream: result.upstream
      });
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : 'Bridge ingest failed.' });
    }
  }

  return sendJson(res, 404, { ok: false, error: 'Route not found. Use GET /health or POST /ingest.' });
});

server.listen(listenPort, listenHost, () => {
  console.log(`Sway DJ Library Bridge: ${localUrl('/health')}`);
  console.log(`Forwarding track availability and local paths to ${syncUrl}`);
  console.log(`Snapshot mode: ${replaceExisting ? 'replace-existing' : 'append-only'}`);
  console.log('The health URL contains the local-only token; treat it as a secret.');
});
