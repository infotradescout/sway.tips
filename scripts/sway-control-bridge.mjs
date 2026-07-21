import http from 'node:http';
import process from 'node:process';

const HELP_TEXT = `
Sway Control Bridge

Starts a local HTTP bridge so Stream Deck, Companion, MIDI routers, foot pedals,
or small scripts can trigger performer cockpit actions without screen tapping.

Usage:
  npm run control:bridge -- --gig-id <gig-id> --auth-token <dashboard-issued-token>

Options:
  --gig-id <id>          Required live room/gig id
  --auth-token <text>    Preferred short-lived bridge token from the performer dashboard
  --auth-cookie <text>   Legacy Cookie header fallback for local development
  --sway-url <url>       Defaults to https://app.sway.tips
  --host <host>          Defaults to 127.0.0.1
  --port <port>          Defaults to 4315

HTTP actions:
  GET  /health
  GET  /state
  GET  /preset/actions
  GET  /preset/companion
  GET  /preset/stream-deck
  GET  /top/text
  GET  /top/search
  POST /action/toggle-requests
  POST /action/fulfill-top
  POST /action/hide-top
  POST /action/approve-pending
  POST /action/veto-pending
  POST /action/open-top-source
  POST /action/search-top-spotify
  POST /action/search-top-soundcloud
  POST /action/search-top-youtube
`;

const ACTIONS = new Set([
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

const SEARCH_PROVIDERS = {
  spotify: {
    label: 'Spotify search',
    url: (query) => `spotify:search:${encodeURIComponent(query)}`
  },
  soundcloud: {
    label: 'SoundCloud search',
    url: (query) => `https://soundcloud.com/search/sounds?q=${encodeURIComponent(query)}`
  },
  youtube: {
    label: 'YouTube search',
    url: (query) => `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
  }
};

const PRESET_ACTIONS = [
  {
    id: 'toggle-requests',
    label: 'Pause / Resume',
    method: 'POST',
    path: '/action/toggle-requests',
    color: '#22c55e',
    description: 'Toggle inbound audience requests for the live room.'
  },
  {
    id: 'fulfill-top',
    label: 'Clear Top',
    method: 'POST',
    path: '/action/fulfill-top',
    color: '#06b6d4',
    description: 'Mark the current top approved/crowd-ranked request fulfilled.'
  },
  {
    id: 'hide-top',
    label: 'Hide Top',
    method: 'POST',
    path: '/action/hide-top',
    color: '#f59e0b',
    description: 'Hide the current top approved/crowd-ranked request.'
  },
  {
    id: 'search-top-spotify',
    label: 'Spotify Search',
    method: 'POST',
    path: '/action/search-top-spotify',
    color: '#1db954',
    description: 'Return a Spotify search deep link for the top crowd pick.'
  },
  {
    id: 'search-top-soundcloud',
    label: 'SoundCloud Search',
    method: 'POST',
    path: '/action/search-top-soundcloud',
    color: '#ff5500',
    description: 'Return a SoundCloud search URL for the top crowd pick.'
  },
  {
    id: 'search-top-youtube',
    label: 'YouTube Search',
    method: 'POST',
    path: '/action/search-top-youtube',
    color: '#ef4444',
    description: 'Return a YouTube search URL for the top crowd pick.'
  },
  {
    id: 'approve-pending',
    label: 'Approve Pending',
    method: 'POST',
    path: '/action/approve-pending',
    color: '#84cc16',
    description: 'Approve the oldest visible pending request.'
  },
  {
    id: 'veto-pending',
    label: 'Veto Pending',
    method: 'POST',
    path: '/action/veto-pending',
    color: '#f43f5e',
    description: 'Deny the oldest visible pending request.'
  }
];

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

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'content-type': 'application/json; charset=utf-8'
  });
  res.end(JSON.stringify(payload, null, 2));
}

function normalizeBaseUrl(value) {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : 'https://app.sway.tips';
  return raw.replace(/\/+$/, '');
}

function localBridgeUrl(path) {
  return `http://${listenHost}:${listenPort}${path}`;
}

function buildActionPreset(format) {
  const actions = PRESET_ACTIONS.map((action, index) => ({
    ...action,
    slot: index + 1,
    url: localBridgeUrl(action.path)
  }));

  return {
    schema: 'sway-control-bridge-preset.v1',
    format,
    bridge: {
      host: listenHost,
      port: listenPort,
      healthUrl: localBridgeUrl('/health'),
      stateUrl: localBridgeUrl('/state'),
      topTextUrl: localBridgeUrl('/top/text'),
      topSearchUrl: localBridgeUrl('/top/search')
    },
    actions,
    companion: {
      module: 'Generic HTTP Request',
      importMode: 'create one POST button per action URL',
      buttons: actions.map((action) => ({
        page: 1,
        row: Math.floor((action.slot - 1) / 4) + 1,
        column: ((action.slot - 1) % 4) + 1,
        text: action.label,
        request: {
          method: action.method,
          url: action.url
        },
        color: action.color
      }))
    },
    streamDeck: {
      importMode: 'map each item to a Website/Open URL or HTTP Request action',
      buttons: actions.map((action) => ({
        slot: action.slot,
        title: action.label,
        url: action.url,
        method: action.method,
        color: action.color
      }))
    }
  };
}

async function readUpstreamJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function fetchRoomState({ swayUrl, gigId, authHeaders }) {
  const response = await fetch(`${swayUrl}/api/state/${encodeURIComponent(gigId)}`, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      ...authHeaders
    }
  });
  const data = await readUpstreamJson(response);
  if (!response.ok) {
    throw new Error(typeof data?.error === 'string' ? data.error : `State request failed with ${response.status}.`);
  }
  return data;
}

function visibleRequests(state) {
  const requests = Array.isArray(state?.requests) ? state.requests : [];
  return requests.filter((request) => !request.hidden && !request.removed && !request.shadowBanned);
}

function topApprovedRequest(state) {
  return visibleRequests(state)
    .filter((request) => request.status === 'approved')
    .sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0))[0] || null;
}

function topPendingRequest(state) {
  return visibleRequests(state)
    .filter((request) => request.status === 'hold')
    .sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime())[0] || null;
}

function topRequestText(request) {
  if (!request) return null;
  const title = typeof request.title === 'string' ? request.title.trim() : '';
  const subtitle = typeof request.subtitle === 'string' ? request.subtitle.trim() : '';
  return [title, subtitle].filter(Boolean).join(' - ');
}

function topRequestPayload(request) {
  const text = topRequestText(request);
  if (!request || !text) return null;
  const searches = Object.fromEntries(
    Object.entries(SEARCH_PROVIDERS).map(([key, provider]) => [key, {
      label: provider.label,
      url: provider.url(text)
    }])
  );
  return {
    id: request.id,
    title: request.title,
    subtitle: request.subtitle,
    text,
    spotifyUrl: request.spotifyUrl || null,
    searches
  };
}

function resolveAuthHeaders({ authToken, authCookie }) {
  if (authToken) return { authorization: `Bearer ${authToken}` };
  if (authCookie) return { cookie: authCookie };
  return {};
}

// The cloud endpoint resolves the target request (top approved / oldest
// pending) itself, so this is a thin forwarder rather than a translator.
async function runAction({ action, swayUrl, authHeaders, gigId }) {
  const response = await fetch(`${swayUrl}/api/talent/control-bridge/action/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...authHeaders
    },
    body: JSON.stringify({ gig_id: gigId })
  });
  const data = await readUpstreamJson(response);
  return {
    ok: response.ok,
    status: response.status,
    upstream: data
  };
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  console.log(HELP_TEXT.trim());
  process.exit(0);
}

const gigId = typeof args['gig-id'] === 'string' ? args['gig-id'] : process.env.SWAY_CONTROL_GIG_ID;
const authToken = typeof args['auth-token'] === 'string' ? args['auth-token'] : process.env.SWAY_CONTROL_AUTH_TOKEN;
const legacyAuthCookie = typeof args['auth-cookie'] === 'string' ? args['auth-cookie'] : process.env.SWAY_CONTROL_AUTH_COOKIE;
const authHeaders = resolveAuthHeaders({ authToken, authCookie: legacyAuthCookie });
const swayUrl = normalizeBaseUrl(typeof args['sway-url'] === 'string' ? args['sway-url'] : process.env.SWAY_CONTROL_SWAY_URL);
const listenHost = typeof args.host === 'string' ? args.host : process.env.SWAY_CONTROL_BRIDGE_HOST || '127.0.0.1';
const listenPort = Number(typeof args.port === 'string' ? args.port : process.env.SWAY_CONTROL_BRIDGE_PORT || '4315');

if (!gigId || (!authToken && !legacyAuthCookie)) {
  console.error('Missing required gig id or auth token. Pass --gig-id and --auth-token, or set SWAY_CONTROL_GIG_ID and SWAY_CONTROL_AUTH_TOKEN.');
  console.error('');
  console.error(HELP_TEXT.trim());
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return sendJson(res, 204, {});

  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, {
      ok: true,
      bridge: 'sway-control-bridge',
      swayUrl,
      gigId,
      actions: [...ACTIONS]
    });
  }

  if (req.method === 'GET' && req.url === '/state') {
    try {
      const state = await fetchRoomState({ swayUrl, gigId, authHeaders });
      const approved = topApprovedRequest(state);
      const pending = topPendingRequest(state);
      return sendJson(res, 200, {
        ok: true,
        session: state.session,
        topApproved: approved ? { ...topRequestPayload(approved), amount: approved.amount } : null,
        topPending: pending ? { id: pending.id, title: pending.title, subtitle: pending.subtitle, amount: pending.amount } : null
      });
    } catch (error) {
      return sendJson(res, 502, { ok: false, error: error instanceof Error ? error.message : 'Unable to read room state.' });
    }
  }

  if (req.method === 'GET' && req.url === '/preset/actions') {
    return sendJson(res, 200, buildActionPreset('generic-http-actions'));
  }

  if (req.method === 'GET' && req.url === '/preset/companion') {
    return sendJson(res, 200, buildActionPreset('bitfocus-companion-generic-http'));
  }

  if (req.method === 'GET' && req.url === '/preset/stream-deck') {
    return sendJson(res, 200, buildActionPreset('stream-deck-url-actions'));
  }

  if (req.method === 'GET' && req.url === '/top/text') {
    try {
      const state = await fetchRoomState({ swayUrl, gigId, authHeaders });
      const approved = topApprovedRequest(state);
      const text = topRequestText(approved);
      if (!text) return sendJson(res, 409, { ok: false, error: 'No approved request is available.' });
      res.writeHead(200, {
        'access-control-allow-origin': '*',
        'content-type': 'text/plain; charset=utf-8'
      });
      return res.end(text);
    } catch (error) {
      return sendJson(res, 502, { ok: false, error: error instanceof Error ? error.message : 'Unable to read top request.' });
    }
  }

  if (req.method === 'GET' && req.url === '/top/search') {
    try {
      const state = await fetchRoomState({ swayUrl, gigId, authHeaders });
      const approved = topApprovedRequest(state);
      const payload = topRequestPayload(approved);
      if (!payload) return sendJson(res, 409, { ok: false, error: 'No approved request is available.' });
      return sendJson(res, 200, { ok: true, top: payload });
    } catch (error) {
      return sendJson(res, 502, { ok: false, error: error instanceof Error ? error.message : 'Unable to read top request.' });
    }
  }

  const actionMatch = req.method === 'POST' && typeof req.url === 'string'
    ? req.url.match(/^\/action\/([a-z-]+)$/)
    : null;
  if (actionMatch) {
    const action = actionMatch[1];
    if (!ACTIONS.has(action)) return sendJson(res, 404, { ok: false, error: 'Unknown action.' });
    try {
      const result = await runAction({ action, swayUrl, authHeaders, gigId });
      return sendJson(res, result.status, {
        ok: result.ok,
        action,
        upstream: result.upstream
      });
    } catch (error) {
      return sendJson(res, 502, { ok: false, action, error: error instanceof Error ? error.message : 'Bridge action failed.' });
    }
  }

  return sendJson(res, 404, {
    ok: false,
    error: 'Route not found. Use GET /health, GET /state, or POST /action/<name>.'
  });
});

server.listen(listenPort, listenHost, () => {
  console.log(`Sway Control Bridge listening at http://${listenHost}:${listenPort}`);
  console.log(`Forwarding performer controls to ${swayUrl} for gig ${gigId}`);
  console.log('POST button triggers to /action/toggle-requests, /action/fulfill-top, /action/hide-top, /action/approve-pending, /action/veto-pending, /action/open-top-source, or /action/search-top-spotify|soundcloud|youtube');
  console.log('Read the current crowd pick at GET /top/text or GET /top/search');
  console.log('Download button presets at GET /preset/actions, /preset/companion, or /preset/stream-deck');
});
