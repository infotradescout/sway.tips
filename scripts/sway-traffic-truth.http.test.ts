import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import express from 'express';
import { createAccessControl, routeFamilyGuard } from '../src/server/access-control';

// Keep current main authorization intact. The bounded additions classify only
// analytics requests and reject document scanner paths; they grant no access.
const source = readFileSync('src/server/access-control.ts', 'utf8');
const addedImport = "import { applyTrafficTruthToTelemetryRequest, shouldHard404ScannerRequest } from './traffic-truth-request';\n";
const addedHydration = `    // server.ts runs hydration after JSON parsing for every request, including
    // APIs that intentionally bypass the document-only routeFamilyGuard.
    applyTrafficTruthToTelemetryRequest(req);
`;
const addedBlock = `    // Traffic classification is analytics-only; original authorization follows unchanged.
    applyTrafficTruthToTelemetryRequest(req);
    if (shouldHard404ScannerRequest(req)) {
      res.status(404).set({
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex, nofollow'
      }).send('Not found.');
      return;
    }
`;
assert.equal(source.split(addedImport).length, 2, 'One traffic import only');
assert.equal(source.split(addedHydration).length, 2, 'One global hydration addition only');
assert.equal(source.split(addedBlock).length, 2, 'One document guard addition only');
const original = source.replace(addedImport, '').replace(addedHydration, '').replace(addedBlock, '');
function blob(value: string) {
  const bytes = Buffer.from(value);
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}
assert.ok([original, original.replace(/\n$/, '')].some(text => blob(text) === 'eb4d58e74ff555b4ccaa2f2bb2c01064695cf96a'), 'Current main authorization must remain exact apart from a final newline');

// The real server intentionally bypasses routeFamilyGuard for /api. A fixture
// that routed analytics through that document guard alone would give false proof.
const serverSource = readFileSync('server.ts', 'utf8');
const jsonIndex = serverSource.indexOf('app.use(express.json(');
const hydrationIndex = serverSource.indexOf('await accessControl.hydrateRequestActor(req);');
const analyticsIndex = serverSource.indexOf('app.post("/api/analytics/shell"');
assert.ok(jsonIndex >= 0 && hydrationIndex > jsonIndex && analyticsIndex > hydrationIndex, 'Real JSON parsing and global hydration must precede analytics registration');
assert.match(serverSource, /if \(req\.path\.startsWith\('\/api'\) \|\| req\.path\.startsWith\('\/assets'\) \|\| req\.path\.startsWith\('\/shells'\)\) \{\s*next\(\);\s*return;\s*\}\s*routeFamilyGuard\(accessControl\)\(req, res, next\)/);

const app = express();
const access = createAccessControl({ isProduction: true });
app.use(express.json());
app.use(async (req, _res, next) => {
  try { await access.hydrateRequestActor(req); next(); }
  catch (error) { next(error); }
});
app.use((req, _res, next) => {
  req.headers['x-sway-shell'] = req.path.startsWith('/admin') ? 'admin' : req.path.startsWith('/talent') ? 'talent' : 'patron';
  next();
});
let analyticsDocumentGuardCalls = 0;
app.use((req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/assets') || req.path.startsWith('/shells')) return next();
  if (req.path === '/api/analytics/shell') analyticsDocumentGuardCalls++;
  void routeFamilyGuard(access)(req, res, next).catch(next);
});
app.post('/api/analytics/shell', (req, res) => res.json(req.body));
app.post('/api/rooms/example/action', (req, res) => res.json(req.body));
app.get('*', (_req, res) => res.type('text').send('downstream public fixture'));
const server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
  const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  listening.once('error', reject);
});
const address = server.address();
assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1';
let cases = 0;
async function request(path: string, init: RequestInit = {}) {
  return fetch(base + path, { ...init, redirect: 'manual', signal: AbortSignal.timeout(5000) });
}
try {
  for (const path of ['/.env', '/.git/config', '/package.json', '/wp-login.php', '/src/server/access-control.ts']) {
    const response = await request(path, { headers: { 'user-agent': ua } });
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal(await response.text(), 'Not found.'); cases++;
  }
  for (const path of ['/', '/p/fixture', '/g/fixture', '/discover', '/robots.txt', '/sitemap.xml', '/llms.txt', '/.well-known/apple-app-site-association', '/grindzone']) {
    const response = await request(path, { headers: { 'user-agent': 'OAI-SearchBot/1.3' } });
    assert.equal(response.status, 200, path);
    assert.equal(await response.text(), 'downstream public fixture'); cases++;
  }
  for (const [userAgent, hint, expected] of [
    [ua, 'human_candidate', 'human_candidate:google'],
    ['Googlebot/2.1', 'human_candidate', 'known_bot:google'],
    [ua, 'qa_automation', 'qa_automation:google'],
    ['curl/8.7.1', 'human_candidate', 'qa_automation:google'],
  ]) {
    const response = await request('/api/analytics/shell', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': userAgent, 'x-sway-traffic-class': hint }, body: JSON.stringify({ attribution_channel: 'human_candidate:google', event: 'discovery_landing', journey_id: 'local-fixture' }) });
    assert.equal(response.status, 200);
    const body = await response.json(); assert.equal(body.attribution_channel, expected);
    assert.equal(body.journey_id, 'local-fixture'); assert.equal(body.event, 'discovery_landing'); cases++;
  }
  assert.equal(analyticsDocumentGuardCalls, 0, 'Analytics classification must not depend on the bypassed document guard');
  const denied = await request('/admin', { headers: { accept: 'application/json', 'x-sway-traffic-class': 'human_candidate', 'user-agent': ua } });
  assert.equal(denied.status, 401); cases++;
  const talent = await request('/talent/dashboard', { headers: { accept: 'text/html', 'user-agent': ua } });
  assert.equal(talent.status, 302); assert.equal(talent.headers.get('location'), '/talent/login?redirect=%2Ftalent%2Fdashboard'); cases++;
  const login = await request('/talent/login', { headers: { accept: 'text/html', 'user-agent': ua } });
  assert.equal(login.status, 200); cases++;
  const payload = { attribution_channel: 'original', untouched: true };
  const unrelated = await request('/api/rooms/example/action', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Googlebot/2.1' }, body: JSON.stringify(payload) });
  assert.deepEqual(await unrelated.json(), payload); cases++;
  console.log(`Sway traffic-truth HTTP integration passed: ${cases} cases; current authorization parity and production middleware ordering verified. Synthetic loopback requests only; no database/provider mutation or production traffic claim.`);
} finally {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
