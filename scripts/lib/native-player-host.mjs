import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export async function startNativePlayerHost({ hub, token, expiresAt, port = 4316, allowedOrigin = 'https://app.sway.tips', now = Date.now }) {
  if (typeof token !== 'string' || !/^[a-zA-Z0-9_-]{32,128}$/.test(token)) throw new Error('A strong private pairing key is required.');
  if (!Number.isFinite(expiresAt) || expiresAt <= now() || expiresAt > now() + 6 * 60 * 60 * 1000) throw new Error('A bounded pairing lifetime is required.');
  const origin = new URL(allowedOrigin);
  if (origin.origin !== allowedOrigin || origin.protocol !== 'https:' || origin.hostname !== 'app.sway.tips') {
    throw new Error('Native pairing is restricted to the Sway application origin.');
  }
  const expected = Buffer.from('Bearer ' + token);
  let closing = false;
  const reply = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    const address = server.address();
    if (closing || typeof address !== 'object' || req.headers.host !== `127.0.0.1:${address.port}`
      || req.headers.origin !== allowedOrigin) return reply(res, 403, { error: 'Pair this computer from the Sway application.' });
    res.setHeader('access-control-allow-origin', allowedOrigin); res.setHeader('vary', 'Origin');
    if (req.method === 'OPTIONS') {
      const method = req.headers['access-control-request-method'];
      const headers = String(req.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(part => part.trim()).filter(Boolean);
      if (!['GET', 'POST'].includes(method) || headers.some(header => !['authorization', 'content-type'].includes(header))) {
        return reply(res, 403, { error: 'Unsupported player access request.' });
      }
      res.setHeader('access-control-allow-methods', 'GET, POST');
      res.setHeader('access-control-allow-headers', 'Authorization, Content-Type');
      res.setHeader('access-control-allow-private-network', 'true');
      return reply(res, 204, {});
    }
    const received = Buffer.from(String(req.headers.authorization ?? ''));
    if (received.length !== expected.length || !timingSafeEqual(received, expected) || now() >= expiresAt) {
      return reply(res, 401, { error: 'Player pairing is missing or expired. Pair explicitly again.' });
    }
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/v1/connections' && !url.search) {
        return reply(res, 200, { connections: hub.list(), expiresAt: new Date(expiresAt).toISOString() });
      }
      if (req.method === 'GET' && url.pathname === '/v1/state') {
        if (url.searchParams.size !== 2 || url.searchParams.getAll('connectionId').length !== 1 || url.searchParams.getAll('revision').length !== 1) {
          return reply(res, 422, { error: 'Choose one exact player and revision.' });
        }
        return reply(res, 200, { state: await hub.readState(url.searchParams.get('connectionId'), url.searchParams.get('revision')) });
      }
      if (req.method !== 'POST' || !['/v1/command', '/v1/reconnect', '/v1/review'].includes(url.pathname) || url.search) {
        return reply(res, 404, { error: 'Unsupported native player operation.' });
      }
      if (String(req.headers['content-type']).split(';')[0].trim().toLowerCase() !== 'application/json'
        || Number(req.headers['content-length'] ?? 0) > 8192) return reply(res, 415, { error: 'Player actions require bounded JSON.' });
      const chunks = []; let length = 0;
      for await (const chunk of req) { length += chunk.length; if (length > 8192) return reply(res, 413, { error: 'Player action too large.' }); chunks.push(chunk); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(res, 422, { error: 'Invalid player action.' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(res, 422, { error: 'Choose an explicit player action.' });
      if (url.pathname === '/v1/command') return reply(res, 200, { receipt: await hub.execute(body.connectionId, body) });
      if (url.pathname === '/v1/reconnect') return reply(res, 200, { connection: hub.reconnect(body.connectionId, body.revision) });
      return reply(res, 200, { review: hub.reviewUnknown(body.connectionId, body) });
    } catch (error) {
      // Adapter errors are bounded, contain no provider bodies or credentials,
      // and never turn into an automatic command retry.
      if (!res.headersSent) reply(res, 409, { error: error instanceof Error ? error.message : 'Player action could not be confirmed.' });
      else res.destroy();
    }
  });
  server.requestTimeout = 10000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { port: server.address().port, close: async () => {
    closing = true;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
