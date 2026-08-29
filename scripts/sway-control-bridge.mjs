import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  VirtualDjNetworkControl,
  VIRTUALDJ_NETWORK_CONTROL_REQUIREMENTS
} from './lib/virtualdj-network-control.mjs';

const HELP_TEXT = `
Sway DJ Control Bridge

Runs on the booth computer. Sway sends durable playback commands to this
bridge; the bridge controls VirtualDJ through its official Network Control
extension and returns command results plus current deck state to Sway.

Usage:
  npm run control:bridge -- \\
    --gig-id <gig-id> \\
    --auth-token <dashboard-issued-token> \\
    --virtualdj-url http://127.0.0.1:8088

Required:
  --gig-id <id>                Live room id
  --auth-token <token>         Room-scoped bridge token from Sway

VirtualDJ:
  --virtualdj-url <url>        Network Control URL (default http://127.0.0.1:8088)
  --virtualdj-password <text>  Network Control bearer password, when configured
  --deck <1-8>                 Target deck (default 1)
  --allow-remote-virtualdj     Permit a non-loopback Network Control URL

Local hardware endpoint:
  --host <host>                Listener (default 127.0.0.1)
  --port <port>                Listener (default 4315)
  --local-token <token>        Local HTTP secret (random when omitted)
  --allow-remote-listen        Permit a non-loopback listener

Cloud:
  --sway-url <url>             Defaults to https://app.sway.tips

Protected local routes are listed at GET /preset/actions and include room
triage plus load/play/pause/stop/cue/next/previous playback controls.
`;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const ROOM_ACTIONS = new Set([
  'toggle-requests',
  'fulfill-top',
  'hide-top',
  'approve-pending',
  'veto-pending',
  'open-top-source',
  'search-top-spotify',
  'search-top-soundcloud',
  'search-top-youtube'
]);
const PLAYBACK_ACTIONS = new Set(['load-top', 'play', 'pause', 'stop', 'cue', 'next', 'previous']);
const SEARCH_PROVIDERS = {
  spotify: { label: 'Spotify search', url: (query) => `spotify:search:${encodeURIComponent(query)}` },
  soundcloud: { label: 'SoundCloud search', url: (query) => `https://soundcloud.com/search/sounds?q=${encodeURIComponent(query)}` },
  youtube: { label: 'YouTube search', url: (query) => `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}` }
};

const PRESET_ACTIONS = [
  ['load-top', 'Load Crowd Pick', '/playback/load-top', '#a855f7', 'Resolve and load the top approved request into VirtualDJ.'],
  ['play', 'Play', '/playback/play', '#22c55e', 'Start the configured VirtualDJ deck.'],
  ['pause', 'Pause', '/playback/pause', '#f59e0b', 'Pause the configured VirtualDJ deck.'],
  ['cue', 'Cue', '/playback/cue', '#06b6d4', 'Return the configured VirtualDJ deck to cue.'],
  ['next', 'Next', '/playback/next', '#8b5cf6', 'Load the next VirtualDJ browser item.'],
  ['previous', 'Previous', '/playback/previous', '#6366f1', 'Load the previous VirtualDJ browser item.'],
  ['stop', 'Stop', '/playback/stop', '#ef4444', 'Stop the configured VirtualDJ deck.'],
  ['toggle-requests', 'Pause / Resume Requests', '/action/toggle-requests', '#14b8a6', 'Toggle inbound audience requests.'],
  ['fulfill-top', 'Clear Top Request', '/action/fulfill-top', '#0ea5e9', 'Mark the top approved request fulfilled.'],
  ['hide-top', 'Hide Top Request', '/action/hide-top', '#f97316', 'Hide the top approved request.'],
  ['approve-pending', 'Approve Pending', '/action/approve-pending', '#84cc16', 'Approve the oldest pending request.'],
  ['veto-pending', 'Deny Pending', '/action/veto-pending', '#f43f5e', 'Deny the oldest pending request.']
].map(([id, label, route, color, description]) => ({ id, label, route, color, description, method: 'POST' }));

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

function normalizeBaseUrl(value, fallback) {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  return raw.replace(/\/+$/, '');
}

function normalizePort(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : fallback;
}

function topApprovedRequest(state) {
  const requests = Array.isArray(state?.requests) ? state.requests : [];
  return requests
    .filter((request) => !request.hidden && !request.removed && !request.shadowBanned && request.status === 'approved')
    .sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0))[0] || null;
}

function topPendingRequest(state) {
  const requests = Array.isArray(state?.requests) ? state.requests : [];
  return requests
    .filter((request) => !request.hidden && !request.removed && !request.shadowBanned && request.status === 'hold')
    .sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime())[0] || null;
}

function topRequestText(request) {
  if (!request) return null;
  return [request.title, request.subtitle]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim())
    .join(' - ') || null;
}

function topRequestPayload(request) {
  const text = topRequestText(request);
  if (!request || !text) return null;
  return {
    id: request.id,
    sourceTrackId: request.sourceTrackId || null,
    externalTrackId: request.externalTrackId || null,
    title: request.title || null,
    artist: request.subtitle || null,
    text,
    amount: request.amount || 0,
    searches: Object.fromEntries(Object.entries(SEARCH_PROVIDERS).map(([key, provider]) => [
      key,
      { label: provider.label, url: provider.url(text) }
    ]))
  };
}

function safeTokenEqual(candidate, expected) {
  if (typeof candidate !== 'string' || !candidate || candidate.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
}

function localRequestAuthorized(req, requestUrl) {
  const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || null;
  const headerToken = typeof req.headers['x-sway-bridge-token'] === 'string' ? req.headers['x-sway-bridge-token'] : null;
  return safeTokenEqual(requestUrl.searchParams.get('token') || bearer || headerToken, localToken);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff'
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendText(res, statusCode, value) {
  res.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
    'x-content-type-options': 'nosniff'
  });
  res.end(value);
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function cloudRequest(route, { method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${swayUrl}${route}`, {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${authToken}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal
    });
    const data = await readJson(response);
    if (!response.ok) {
      const error = new Error(typeof data?.error === 'string' ? data.error : `Sway returned ${response.status}.`);
      error.status = response.status;
      error.payload = data;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function fetchRoomState() {
  return cloudRequest(`/api/talent/control-bridge/state/${encodeURIComponent(gigId)}`);
}

function runRoomAction(action) {
  return cloudRequest(`/api/talent/control-bridge/action/${action}`, {
    method: 'POST',
    body: { gig_id: gigId }
  });
}

async function queuePlaybackAction(action) {
  let track = null;
  let cloudAction = action;
  if (action === 'load-top') {
    const state = await fetchRoomState();
    const top = topApprovedRequest(state);
    if (!top) throw new Error('No approved request is available to load.');
    cloudAction = 'load';
    track = {
      requestId: top.id,
      sourceTrackId: top.sourceTrackId || null,
      externalTrackId: top.externalTrackId || null,
      title: top.title || null,
      artist: top.subtitle || null
    };
  }
  return cloudRequest('/api/talent/playback/commands', {
    method: 'POST',
    body: {
      gig_id: gigId,
      clientCommandId: randomUUID(),
      sourceKey: 'virtualdj',
      action: cloudAction,
      payload: { deck, track }
    }
  });
}

function localBridgeUrl(route) {
  const hostname = listenHost === '::1' ? '[::1]' : listenHost;
  const url = new URL(`http://${hostname}:${listenPort}${route}`);
  url.searchParams.set('token', localToken);
  return url.toString();
}

function buildPreset(format) {
  const actions = PRESET_ACTIONS.map((action, index) => ({
    ...action,
    slot: index + 1,
    url: localBridgeUrl(action.route)
  }));
  return {
    schema: 'sway-control-bridge-preset.v2',
    format,
    bridge: {
      healthUrl: localBridgeUrl('/health'),
      stateUrl: localBridgeUrl('/state'),
      topTextUrl: localBridgeUrl('/top/text'),
      security: 'loopback-only token; no browser CORS'
    },
    actions,
    companion: {
      module: 'Generic HTTP Request',
      buttons: actions.map((action) => ({
        page: Math.floor((action.slot - 1) / 8) + 1,
        row: Math.floor(((action.slot - 1) % 8) / 4) + 1,
        column: ((action.slot - 1) % 4) + 1,
        text: action.label,
        color: action.color,
        request: { method: action.method, url: action.url }
      }))
    },
    streamDeck: {
      importMode: 'map each item to an HTTP Request action',
      buttons: actions.map((action) => ({
        slot: action.slot,
        title: action.label,
        color: action.color,
        method: action.method,
        url: action.url
      }))
    }
  };
}

function loadLedger(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (parsed?.gigId !== gigId || parsed?.sourceKey !== 'virtualdj') return null;
    return {
      version: 1,
      gigId,
      sourceKey: 'virtualdj',
      bridgeInstanceId: typeof parsed.bridgeInstanceId === 'string' ? parsed.bridgeInstanceId : randomUUID(),
      outcomes: parsed.outcomes && typeof parsed.outcomes === 'object' ? parsed.outcomes : {},
      pendingCompletionIds: Array.isArray(parsed.pendingCompletionIds) ? parsed.pendingCompletionIds : []
    };
  } catch (error) {
    console.warn(`Ignoring unreadable bridge ledger: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function saveLedger() {
  const outcomeEntries = Object.entries(ledger.outcomes)
    .sort(([, a], [, b]) => String(b.finishedAt).localeCompare(String(a.finishedAt)))
    .slice(0, 200);
  ledger.outcomes = Object.fromEntries(outcomeEntries);
  ledger.pendingCompletionIds = [...new Set(ledger.pendingCompletionIds)].filter((id) => ledger.outcomes[id]);
  mkdirSync(path.dirname(ledgerPath), { recursive: true, mode: 0o700 });
  const tempPath = `${ledgerPath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tempPath, ledgerPath);
}

async function flushCompletions() {
  for (const commandId of [...ledger.pendingCompletionIds]) {
    const outcome = ledger.outcomes[commandId];
    if (!outcome) continue;
    try {
      await cloudRequest('/api/talent/playback/bridge/complete', {
        method: 'POST',
        body: {
          gig_id: gigId,
          sourceKey: 'virtualdj',
          bridgeInstanceId: ledger.bridgeInstanceId,
          commandId,
          success: outcome.success,
          result: outcome.result || {},
          error: outcome.error || null
        }
      });
      ledger.pendingCompletionIds = ledger.pendingCompletionIds.filter((id) => id !== commandId);
      saveLedger();
    } catch (error) {
      lastCloudError = error instanceof Error ? error.message : String(error);
      break;
    }
  }
}

async function executeClaimedCommand(command) {
  if (!ledger.outcomes[command.id]) {
    let outcome;
    try {
      const result = await virtualDj.executeCommand(command);
      outcome = { success: true, result, error: null, finishedAt: new Date().toISOString() };
    } catch (error) {
      outcome = {
        success: false,
        result: {},
        error: error instanceof Error ? error.message : String(error),
        finishedAt: new Date().toISOString()
      };
    }
    // Persist the local execution outcome before acknowledging the cloud.
    // A lost network response therefore cannot turn a completed command into
    // a second booth-side execution after restart.
    ledger.outcomes[command.id] = outcome;
    ledger.pendingCompletionIds.push(command.id);
    saveLedger();
  } else if (!ledger.pendingCompletionIds.includes(command.id)) {
    ledger.pendingCompletionIds.push(command.id);
    saveLedger();
  }
}

async function pushDeckState() {
  let state;
  try {
    state = await virtualDj.readState(deck);
    lastVirtualDjError = null;
  } catch (error) {
    lastVirtualDjError = error instanceof Error ? error.message : String(error);
    state = {
      sourceKey: 'virtualdj',
      transport: 'virtualdj_network_control_http',
      connectionStatus: 'disconnected',
      deck,
      observedAt: new Date().toISOString(),
      metadata: { error: lastVirtualDjError }
    };
  }
  await cloudRequest('/api/talent/playback/bridge/state', {
    method: 'POST',
    body: {
      gig_id: gigId,
      state: { ...state, bridgeInstanceId: ledger.bridgeInstanceId }
    }
  });
  lastStatePushAt = Date.now();
}

async function bridgeTick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    await flushCompletions();
    const claimed = await cloudRequest('/api/talent/playback/bridge/claim', {
      method: 'POST',
      body: {
        gig_id: gigId,
        sourceKey: 'virtualdj',
        bridgeInstanceId: ledger.bridgeInstanceId
      }
    });
    for (const command of Array.isArray(claimed?.commands) ? claimed.commands : []) {
      await executeClaimedCommand(command);
    }
    await flushCompletions();
    if (Date.now() - lastStatePushAt >= 2_000) await pushDeckState();
    lastCloudError = null;
  } catch (error) {
    lastCloudError = error instanceof Error ? error.message : String(error);
  } finally {
    tickRunning = false;
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  console.log(HELP_TEXT.trim());
  process.exit(0);
}

const gigId = typeof args['gig-id'] === 'string' ? args['gig-id'] : process.env.SWAY_CONTROL_GIG_ID;
const authToken = typeof args['auth-token'] === 'string' ? args['auth-token'] : process.env.SWAY_CONTROL_AUTH_TOKEN;
const swayUrl = normalizeBaseUrl(typeof args['sway-url'] === 'string' ? args['sway-url'] : process.env.SWAY_CONTROL_SWAY_URL, 'https://app.sway.tips');
const listenHost = typeof args.host === 'string' ? args.host : process.env.SWAY_CONTROL_BRIDGE_HOST || '127.0.0.1';
const listenPort = normalizePort(typeof args.port === 'string' ? args.port : process.env.SWAY_CONTROL_BRIDGE_PORT, 4315);
const localToken = typeof args['local-token'] === 'string'
  ? args['local-token']
  : process.env.SWAY_CONTROL_LOCAL_TOKEN || randomBytes(24).toString('base64url');
const deck = Math.min(8, Math.max(1, Number.parseInt(String(args.deck || process.env.SWAY_CONTROL_DECK || '1'), 10) || 1));
const virtualDjUrl = normalizeBaseUrl(typeof args['virtualdj-url'] === 'string' ? args['virtualdj-url'] : process.env.SWAY_VIRTUALDJ_URL, 'http://127.0.0.1:8088');
const virtualDjPassword = typeof args['virtualdj-password'] === 'string' ? args['virtualdj-password'] : process.env.SWAY_VIRTUALDJ_PASSWORD;

if (!gigId || !authToken) {
  console.error('Missing --gig-id or --auth-token. Both are required.');
  console.error(HELP_TEXT.trim());
  process.exit(1);
}
if (!LOOPBACK_HOSTS.has(listenHost) && !args['allow-remote-listen']) {
  console.error('The local bridge binds only to loopback unless --allow-remote-listen is explicit.');
  process.exit(1);
}

const ledgerPath = path.join(homedir(), '.sway', `control-bridge-${gigId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
const ledger = loadLedger(ledgerPath) || {
  version: 1,
  gigId,
  sourceKey: 'virtualdj',
  bridgeInstanceId: randomUUID(),
  outcomes: {},
  pendingCompletionIds: []
};
saveLedger();

const virtualDj = new VirtualDjNetworkControl({
  baseUrl: virtualDjUrl,
  password: virtualDjPassword,
  deck,
  allowRemote: Boolean(args['allow-remote-virtualdj'])
});
let lastCloudError = null;
let lastVirtualDjError = null;
let lastStatePushAt = 0;
let tickRunning = false;

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${listenHost}:${listenPort}`);
  if (req.method === 'OPTIONS') return sendJson(res, 405, { ok: false, error: 'Browser cross-origin requests are disabled.' });
  if (!localRequestAuthorized(req, requestUrl)) return sendJson(res, 401, { ok: false, error: 'Local bridge token required.' });

  if (req.method === 'GET' && requestUrl.pathname === '/health') {
    return sendJson(res, 200, {
      ok: !lastCloudError && !lastVirtualDjError,
      bridge: 'sway-dj-control-bridge',
      gigId,
      sourceKey: 'virtualdj',
      bridgeInstanceId: ledger.bridgeInstanceId,
      pendingCompletions: ledger.pendingCompletionIds.length,
      cloudError: lastCloudError,
      sourceError: lastVirtualDjError,
      requirements: VIRTUALDJ_NETWORK_CONTROL_REQUIREMENTS
    });
  }

  if (req.method === 'GET' && requestUrl.pathname === '/state') {
    try {
      const state = await fetchRoomState();
      return sendJson(res, 200, {
        ok: true,
        session: state.session,
        playback: state.playback,
        topApproved: topRequestPayload(topApprovedRequest(state)),
        topPending: topRequestPayload(topPendingRequest(state))
      });
    } catch (error) {
      return sendJson(res, 502, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (req.method === 'GET' && requestUrl.pathname === '/top/text') {
    try {
      const text = topRequestText(topApprovedRequest(await fetchRoomState()));
      return text ? sendText(res, 200, text) : sendJson(res, 409, { ok: false, error: 'No approved request is available.' });
    } catch (error) {
      return sendJson(res, 502, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (req.method === 'GET' && ['/preset/actions', '/preset/companion', '/preset/stream-deck'].includes(requestUrl.pathname)) {
    return sendJson(res, 200, buildPreset(requestUrl.pathname.split('/').at(-1)));
  }

  const roomMatch = req.method === 'POST' ? requestUrl.pathname.match(/^\/action\/([a-z-]+)$/) : null;
  if (roomMatch) {
    const action = roomMatch[1];
    if (!ROOM_ACTIONS.has(action)) return sendJson(res, 404, { ok: false, error: 'Unknown room action.' });
    try {
      return sendJson(res, 200, { ok: true, action, upstream: await runRoomAction(action) });
    } catch (error) {
      return sendJson(res, Number(error?.status) || 502, { ok: false, action, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const playbackMatch = req.method === 'POST' ? requestUrl.pathname.match(/^\/playback\/([a-z-]+)$/) : null;
  if (playbackMatch) {
    const action = playbackMatch[1];
    if (!PLAYBACK_ACTIONS.has(action)) return sendJson(res, 404, { ok: false, error: 'Unknown playback action.' });
    try {
      return sendJson(res, 202, { ok: true, action, upstream: await queuePlaybackAction(action) });
    } catch (error) {
      return sendJson(res, Number(error?.status) || 502, { ok: false, action, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return sendJson(res, 404, { ok: false, error: 'Route not found.' });
});

const interval = setInterval(bridgeTick, 1_000);
interval.unref();
server.listen(listenPort, listenHost, () => {
  console.log(`Sway DJ Control Bridge: ${localBridgeUrl('/health')}`);
  console.log(`Room ${gigId} -> ${swayUrl}`);
  console.log(`VirtualDJ deck ${deck} -> ${virtualDjUrl}`);
  console.log(`Hardware presets: ${localBridgeUrl('/preset/actions')}`);
  console.log('The URLs contain the local-only bridge token; treat exported presets as secrets.');
  void bridgeTick();
});

function shutdown() {
  clearInterval(interval);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
