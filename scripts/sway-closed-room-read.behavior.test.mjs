import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const ts = createRequire(import.meta.url)('typescript');
const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const routes = parsed.statements.filter(node => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(parsed) === 'app.get'
  && node.expression.arguments[0]?.text === '/api/state/:gigId');
assert.equal(routes.length, 1, 'Exercise exactly the registered production scoped-read handler.');
const compile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const handlerCode = compile(`(${routes[0].expression.arguments[1].getText(parsed)})`);
const registry = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'listReadableActiveRooms');
assert.equal(registry.length, 1);
const roomId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const makeState = (status = 'closed', id = roomId) => ({
  session: { status, talentName: 'Authorized performer', totals: { totalCount: 1 } },
  requests: [{ id: 'private-history', title: 'Retained request', status: 'fulfilled' }],
  performers: [], activeGigId: id
});
async function read({ kind = 'ended', allowed = true, status = 'closed', id = roomId, requested = roomId } = {}) {
  const state = makeState(status, id);
  const calls = { lookup: [], access: [], discovery: 0, public: 0, noStore: 0 };
  const context = {
    applyNoStoreHeaders: () => { calls.noStore += 1; },
    parseDurableGigId: value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null,
    loadRoomState: async value => { calls.lookup.push(value); return { state, roomStatus: kind }; },
    accessControl: { requireGigMutationAccess: async (_request, value) => { calls.access.push(value); return { allowed, status: 403 }; } },
    recordDirectRoomDiscoveryOutcome: async () => { calls.discovery += 1; },
    projectPublicRoomState: () => { calls.public += 1; return { publicOnly: true, activeGigId: roomId }; },
    ROOM_LOOKUP_UNAVAILABLE_COPY: 'Unavailable', ROOM_LOOKUP_ENDED_COPY: 'Ended'
  };
  const response = { code: 200, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await runInNewContext(handlerCode, context)({ params: { gigId: requested } }, response);
  assert.equal(calls.noStore, 1, 'Private or negative reads must never become cached public state.');
  return { response, calls, state };
}
let passed = 0;
let failed = 0;
async function test(name, action) {
  try { await action(); passed += 1; console.log(`CLOSED_ROOM_READ_PASS ${name}`); }
  catch (error) { failed += 1; console.error(`CLOSED_ROOM_READ_FAIL ${name}: ${error.message}`); }
}
await test('authorized closed read retains the exact room and its read-only history', async () => {
  const { response, calls, state } = await read();
  assert.equal(response.code, 200);
  assert.equal(response.body.room_lookup, 'ended');
  assert.equal(response.body.room_read_only, true);
  assert.equal(response.body.activeGigId, roomId);
  assert.strictEqual(response.body.session, state.session);
  assert.strictEqual(response.body.requests, state.requests);
  assert.deepEqual(calls.access, [roomId]);
  assert.equal(calls.discovery, 0);
  assert.equal(calls.public, 0);
});
await test('unprivileged or revoked access cannot read a closed history', async () => {
  const { response, calls } = await read({ allowed: false });
  assert.equal(response.code, 410);
  assert.equal(response.body.room_lookup, 'ended');
  for (const field of ['session', 'requests', 'performers', 'activeGigId', 'room_read_only']) assert.equal(field in response.body, false);
  assert.deepEqual(calls.access, [roomId]);
  assert.equal(calls.discovery, 0);
  assert.equal(calls.public, 0);
});
for (const mismatch of [{ status: 'active' }, { id: otherId }, { id: null }]) {
  await test(`inconsistent closed snapshot is unavailable: ${JSON.stringify(mismatch)}`, async () => {
    const { response } = await read(mismatch);
    assert.equal(response.code, 503);
    assert.equal('session' in response.body, false);
    assert.equal('requests' in response.body, false);
  });
}
for (const input of [{ kind: 'missing' }, { kind: 'inactive' }, { requested: 'not-a-room' }]) {
  await test(`invalid or missing rooms remain unavailable: ${JSON.stringify(input)}`, async () => {
    const { response, calls } = await read(input);
    assert.equal(response.code, 404);
    assert.equal('requests' in response.body, false);
    assert.equal(calls.access.length, 0);
    assert.equal(calls.discovery, 0);
  });
}
await test('active authorized reads retain existing private behavior', async () => {
  const { response, state } = await read({ kind: 'active', status: 'active' });
  assert.equal(response.code, 200);
  assert.equal(response.body.room_lookup, 'active');
  assert.strictEqual(response.body.requests, state.requests);
  assert.equal(response.body.room_read_only, undefined);
});
await test('active public reads still use only the public projection', async () => {
  const { response, calls } = await read({ kind: 'active', status: 'active', allowed: false });
  assert.equal(response.code, 200);
  assert.equal(response.body.publicOnly, true);
  assert.equal('requests' in response.body, false);
  assert.equal(calls.public, 1);
});
for (const status of ['active', 'ending', 'closed', 'inactive', 'unknown']) {
  await test(`development registry does not confuse ${status} identity with membership`, async () => {
    const load = runInNewContext(`${compile(registry[0].getText(parsed))}\nlistReadableActiveRooms;`, {
      state: makeState(status), activeGigId: roomId,
      refreshBusinessState: async () => {},
      buildActiveRoomSummary: (_state, id) => ({ gigId: id }),
      businessStore: { hasDurableStore: false }
    });
    const rows = await load();
    assert.equal(rows.length, ['active', 'ending'].includes(status) ? 1 : 0);
  });
}
console.log(`CLOSED_ROOM_READ_SUMMARY ${JSON.stringify({ passed, failed })}`);
assert.equal(failed, 0, 'Closed-room read and registry behavior failed.');
