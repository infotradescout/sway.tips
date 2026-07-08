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

async function readUpstreamJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function fetchRoomState({ swayUrl, gigId }) {
  const response = await fetch(`${swayUrl}/api/state/${encodeURIComponent(gigId)}`, {
    method: 'GET',
    headers: { accept: 'application/json' }
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

function resolveAuthCookie({ authToken, authCookie }) {
  if (authToken) return `sway_performer_session=${encodeURIComponent(authToken)}`;
  return authCookie;
}

async function postSwayAction({ swayUrl, authCookie, path, body }) {
  const response = await fetch(`${swayUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: authCookie
    },
    body: JSON.stringify(body)
  });
  const data = await readUpstreamJson(response);
  return {
    ok: response.ok,
    status: response.status,
    upstream: data
  };
}

async function runAction({ action, swayUrl, authCookie, gigId }) {
  const state = await fetchRoomState({ swayUrl, gigId });
  const session = state?.session || {};
  const approved = topApprovedRequest(state);
  const pending = topPendingRequest(state);

  if (action === 'toggle-requests') {
    return postSwayAction({
      swayUrl,
      authCookie,
      path: '/api/session/window/toggle',
      body: { gig_id: gigId, open: !session.requestsOpen }
    });
  }

  if (action === 'fulfill-top') {
    if (!approved?.id) return { ok: false, status: 409, upstream: { error: 'No approved request is available.' } };
    return postSwayAction({
      swayUrl,
      authCookie,
      path: '/api/request/fulfill',
      body: { gig_id: gigId, requestId: approved.id }
    });
  }

  if (action === 'hide-top') {
    if (!approved?.id) return { ok: false, status: 409, upstream: { error: 'No approved request is available.' } };
    return postSwayAction({
      swayUrl,
      authCookie,
      path: '/api/moderation/hide',
      body: { gig_id: gigId, requestId: approved.id, reason: 'local_control_bridge' }
    });
  }

  if (action === 'approve-pending') {
    if (!pending?.id) return { ok: false, status: 409, upstream: { error: 'No pending request is available.' } };
    return postSwayAction({
      swayUrl,
      authCookie,
      path: '/api/request/triage',
      body: { gig_id: gigId, requestId: pending.id, action: 'approve' }
    });
  }

  if (action === 'veto-pending') {
    if (!pending?.id) return { ok: false, status: 409, upstream: { error: 'No pending request is available.' } };
    return postSwayAction({
      swayUrl,
      authCookie,
      path: '/api/request/triage',
      body: { gig_id: gigId, requestId: pending.id, action: 'deny' }
    });
  }

  if (action === 'open-top-source') {
    if (!approved?.spotifyUrl) return { ok: false, status: 409, upstream: { error: 'Top request has no source URL.' } };
    return {
      ok: true,
      status: 200,
      upstream: {
        action: 'open_url',
        url: approved.spotifyUrl,
        title: approved.title,
        subtitle: approved.subtitle
      }
    };
  }

  const searchAction = action.match(/^search-top-(spotify|soundcloud|youtube)$/);
  if (searchAction) {
    const providerKey = searchAction[1];
    const payload = topRequestPayload(approved);
    if (!payload) return { ok: false, status: 409, upstream: { error: 'No approved request is available.' } };
    return {
      ok: true,
      status: 200,
      upstream: {
        action: 'open_url',
        provider: providerKey,
        title: payload.title,
        subtitle: payload.subtitle,
        text: payload.text,
        url: payload.searches[providerKey].url
      }
    };
  }

  return { ok: false, status: 404, upstream: { error: 'Unknown action.' } };
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  console.log(HELP_TEXT.trim());
  process.exit(0);
}

const gigId = typeof args['gig-id'] === 'string' ? args['gig-id'] : process.env.SWAY_CONTROL_GIG_ID;
const authToken = typeof args['auth-token'] === 'string' ? args['auth-token'] : process.env.SWAY_CONTROL_AUTH_TOKEN;
const legacyAuthCookie = typeof args['auth-cookie'] === 'string' ? args['auth-cookie'] : process.env.SWAY_CONTROL_AUTH_COOKIE;
const authCookie = resolveAuthCookie({ authToken, authCookie: legacyAuthCookie });
const swayUrl = normalizeBaseUrl(typeof args['sway-url'] === 'string' ? args['sway-url'] : process.env.SWAY_CONTROL_SWAY_URL);
const listenHost = typeof args.host === 'string' ? args.host : process.env.SWAY_CONTROL_BRIDGE_HOST || '127.0.0.1';
const listenPort = Number(typeof args.port === 'string' ? args.port : process.env.SWAY_CONTROL_BRIDGE_PORT || '4315');

if (!gigId || !authCookie) {
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
      const state = await fetchRoomState({ swayUrl, gigId });
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

  if (req.method === 'GET' && req.url === '/top/text') {
    try {
      const state = await fetchRoomState({ swayUrl, gigId });
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
      const state = await fetchRoomState({ swayUrl, gigId });
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
      const result = await runAction({ action, swayUrl, authCookie, gigId });
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
});
