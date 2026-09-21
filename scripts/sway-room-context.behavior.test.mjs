import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = ['syncActiveGigRouteContext', 'prepareRoomState', 'loadRoomState'];
const functions = names.map(name => {
  const matches = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.equal(matches.length, 1, `Expected exactly one production ${name} function.`);
  return matches[0].getText(parsed);
});
const executable = ts.transpile(functions.join('\n'), {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None
});
const roomA = '11111111-1111-4111-8111-111111111111';
const roomB = '22222222-2222-4222-8222-222222222222';
function fixture(status, id = null) {
  return {
    session: { status, talentName: 'Room owner', totals: { totalCount: 1, totalTips: 0 } },
    requests: [{ id: 'fulfilled-request', status: 'fulfilled' }],
    performers: [],
    activeGigId: id
  };
}
function runtime({ snapshot, memory = fixture('inactive'), durable = true } = {}) {
  const reads = [];
  const context = {
    state: memory,
    activeGigId: roomB,
    syncActivePerformer: () => {},
    createEmptyBackendState: () => ({ ...fixture('inactive'), requests: [] }),
    businessStore: {
      hasDurableStore: durable,
      hydrateStateByGigId: async id => { reads.push(id); return snapshot; }
    }
  };
  return {
    ...runInNewContext(`${executable}\n({syncActiveGigRouteContext, prepareRoomState, loadRoomState})`, context),
    reads
  };
}
let passed = 0;
let failed = 0;
async function test(name, run) {
  try { await run(); passed += 1; console.log(`ROOM_CONTEXT_PASS ${name}`); }
  catch (error) { failed += 1; console.error(`ROOM_CONTEXT_FAIL ${name}: ${error.message}`); }
}
for (const status of ['active', 'ending', 'closed']) {
  await test(`${status} keeps the explicitly selected room identity without changing its state`, () => {
    const state = fixture(status, roomB);
    const session = state.session;
    const requests = state.requests;
    runtime().syncActiveGigRouteContext(state, roomA);
    assert.equal(state.activeGigId, roomA);
    assert.strictEqual(state.session, session);
    assert.strictEqual(state.requests, requests);
    assert.equal(state.session.status, status);
  });
}
for (const status of ['inactive', 'unknown']) {
  await test(`${status} cannot claim a room identity`, () => {
    const state = fixture(status, roomB);
    runtime().syncActiveGigRouteContext(state, roomA);
    assert.equal(state.activeGigId, null);
  });
}
for (const status of ['active', 'ending', 'closed']) {
  await test(`${status} with explicit null never borrows the global room`, () => {
    const state = fixture(status, roomB);
    runtime().syncActiveGigRouteContext(state, null);
    assert.equal(state.activeGigId, null);
  });
}
for (const status of ['active', 'ending']) {
  await test(`durable ${status} read preserves the selected room and history`, async () => {
    const state = fixture(status, roomA);
    const api = runtime({ snapshot: { state, activeGigId: roomA, roomStatus: 'active' } });
    const result = await api.loadRoomState(roomA);
    assert.deepEqual(api.reads, [roomA]);
    assert.equal(result.state.activeGigId, roomA);
    assert.equal(result.state.session.status, status);
    assert.strictEqual(result.state.requests, state.requests);
  });
}
for (const snapshotId of [null, roomB]) {
  await test(`durable closed read binds to its confirmed row rather than ${snapshotId ? 'another active room' : 'an absent active room'}`, async () => {
    const state = fixture('closed');
    const totals = state.session.totals;
    const api = runtime({ snapshot: { state, activeGigId: snapshotId, roomStatus: 'ended' } });
    const result = await api.loadRoomState(roomA);
    assert.deepEqual(api.reads, [roomA]);
    assert.equal(result.state.activeGigId, roomA);
    assert.equal(result.state.session.status, 'closed');
    assert.equal(result.roomStatus, 'ended');
    assert.strictEqual(result.state.session.totals, totals);
    assert.strictEqual(result.state.requests, state.requests);
    assert.equal(result.state.requests[0].status, 'fulfilled');
  });
}
await test('a missing durable room cannot inherit the requested or global identity', async () => {
  const api = runtime({ snapshot: { state: fixture('inactive'), activeGigId: null, roomStatus: 'missing' } });
  const result = await api.loadRoomState(roomA);
  assert.equal(result.state.activeGigId, null);
  assert.equal(result.roomStatus, 'missing');
});
await test('an inconsistent live snapshot is not relabeled as the requested room', async () => {
  const api = runtime({ snapshot: { state: fixture('active', roomB), activeGigId: roomB, roomStatus: 'active' } });
  const result = await api.loadRoomState(roomA);
  assert.equal(result.state.activeGigId, roomB);
  assert.notEqual(result.state.activeGigId, roomA);
});
for (const status of ['active', 'ending', 'closed']) {
  await test(`development-only ${status} read preserves its exact room`, async () => {
    const state = fixture(status, roomA);
    const api = runtime({ memory: state, durable: false });
    const result = await api.loadRoomState(roomA);
    assert.equal(result.state.activeGigId, roomA);
    assert.equal(result.roomStatus, status === 'closed' ? 'ended' : 'active');
    assert.strictEqual(result.state.requests, state.requests);
    assert.deepEqual(api.reads, []);
  });
}
await test('development-only reads never borrow a different room', async () => {
  const api = runtime({ memory: fixture('closed', roomB), durable: false });
  const result = await api.loadRoomState(roomA);
  assert.equal(result.roomStatus, 'missing');
  assert.equal(result.state.activeGigId, null);
  assert.equal(result.state.requests.length, 0);
});
console.log(`ROOM_CONTEXT_SUMMARY ${JSON.stringify({ passed, failed })}`);
if (failed) process.exitCode = 1;
