import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Execute the real reader body with isolated HTTP, timer, and state-setter mocks.
// These are logic/source-wiring checks, not React, browser, or server proof.
const directRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
// Source overrides are for explicit baseline runs, never the imported hard gate.
const filename = (directRun ? process.env.SWAY_TALENT_SOURCE : null)
  ?? fileURLToPath(new URL('../src/shells/TalentApp.tsx', import.meta.url));
const source = readFileSync(filename, 'utf8');
function arrow(name) {
  const marker = `  const ${name} = `;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${name} must exist`);
  const end = source.indexOf('\n  };', start);
  assert.ok(end > start, `${name} body must terminate`);
  return source.slice(start + marker.length, end + '\n  }'.length);
}
const cancelBody = /function cancelPerformerRead\(context: PerformerReadContext \| null\) \{([\s\S]*?)\n\}/.exec(source)?.[1];
assert.ok(cancelBody, 'read cancellation helper must exist');
const cancelPerformerRead = new Function('context', cancelBody);
const reader = arrow('refreshActiveRooms');
const profile = { owner_user_id: 'test-owner-a', performer_id: 'test-performer-a' };
const identity = JSON.stringify([profile.owner_user_id, profile.performer_id]);
const room = { gigId: 'test-room-a', performerName: 'Test Performer', talentRole: 'DJ', routePath: '/g/test-room-a', startedAt: null, requestCount: 0 };
const message = 'Your room list could not refresh. Retry to check your rooms.';
const newContext = () => ({ active: true, revision: 0, controller: null });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(overrides = {}) {
  const state = { rooms: [room], profile: { ...profile }, error: null, calls: [], timers: new Map(), timerSequence: 0 };
  const scope = {
    roomsReadContext: { current: newContext() },
    profileReadContext: { current: newContext() },
    confirmedPerformerIdentity: { current: identity },
    logoutInFlight: { current: false },
    performerIdentity: identity,
    demoMode: false,
    isAuthEntryRoute: false,
    bState: { activeGigId: null, session: { status: 'inactive' }, requests: [] },
    cancelPerformerRead,
    AbortController,
    console: { warn() {} },
    setActiveRooms: value => { state.rooms = value; },
    setPerformerProfile: value => { state.profile = typeof value === 'function' ? value(state.profile) : value; },
    setRoomsReadErrorSnapshot: value => { state.error = value; },
    fetch: (url, options) => {
      assert.equal(url, '/api/talent/active-rooms');
      assert.equal(options.method, undefined, 'recovery must remain GET');
      const call = { ...deferred(), options };
      state.calls.push(call);
      return call.promise;
    },
    setTimeout: (callback, delay) => {
      assert.equal(delay, 15_000, 'room-read timeout must be bounded');
      const id = ++state.timerSequence;
      state.timers.set(id, callback);
      return id;
    },
    clearTimeout: id => state.timers.delete(id),
    ...overrides
  };
  const read = new Function(...Object.keys(scope), `return (${reader});`)(...Object.values(scope));
  const reply = (index, status = 200, body = { rooms: [room] }) => {
    state.calls[index].resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
  };
  const expire = () => {
    assert.equal(state.timers.size, 1, 'one active read timeout');
    for (const callback of [...state.timers.values()]) callback();
  };
  return { state, scope, read, reply, expire };
}
const cases = [];
const test = (name, run) => cases.push({ name, run });
const assertError = state => assert.deepEqual(state.error, { performerIdentity: identity, message });
for (const status of [404, 429, 500, 502, 503]) {
  test(`HTTP ${status} preserves confirmed rooms and exposes recovery`, async () => {
    const f = fixture(); const p = f.read(); f.reply(0, status); await p;
    assert.deepEqual(f.state.rooms, [room]); assertError(f.state);
    assert.equal(f.state.timers.size, 0);
  });
}
test('initial failure exposes recovery without inventing a room', async () => {
  const f = fixture(); f.state.rooms = []; const p = f.read(); f.reply(0, 503); await p;
  assert.deepEqual(f.state.rooms, []); assertError(f.state);
});
test('network rejection exposes recovery without losing rooms', async () => {
  const f = fixture(); const p = f.read(); f.state.calls[0].reject(new Error('offline')); await p;
  assert.deepEqual(f.state.rooms, [room]); assertError(f.state);
});
test('unreadable JSON exposes recovery without losing rooms', async () => {
  const f = fixture(); const p = f.read();
  f.state.calls[0].resolve({ ok: true, status: 200, json: async () => { throw new Error('invalid JSON'); } });
  await p; assert.deepEqual(f.state.rooms, [room]); assertError(f.state);
});
for (const [name, body] of [['null', null], ['missing rooms', {}], ['null rooms', { rooms: null }], ['object rooms', { rooms: {} }], ['string rooms', { rooms: 'wrong' }]]) {
  test(`${name} is not mistaken for an empty room list`, async () => {
    const f = fixture(); const p = f.read(); f.reply(0, 200, body); await p;
    assert.deepEqual(f.state.rooms, [room]); assertError(f.state);
  });
}
test('confirmed empty room list replaces old rows and clears recovery', async () => {
  const f = fixture(); f.state.error = { performerIdentity: identity, message };
  const p = f.read(); f.reply(0, 200, { rooms: [] }); await p;
  assert.deepEqual(f.state.rooms, []); assert.equal(f.state.error, null);
});
test('confirmed nonempty list replaces rows and clears recovery', async () => {
  const f = fixture(); f.state.error = { performerIdentity: identity, message };
  const rows = [{ ...room, gigId: 'test-room-b' }]; const p = f.read(); f.reply(0, 200, { rooms: rows }); await p;
  assert.deepEqual(f.state.rooms, rows); assert.equal(f.state.error, null);
  assert.equal(f.scope.roomsReadContext.current.controller, null); assert.equal(f.state.timers.size, 0);
});
test('late failure cannot overwrite a newer successful refresh', async () => {
  const f = fixture(); const a = f.read(); const b = f.read();
  assert.equal(f.state.calls[0].options.signal.aborted, true);
  f.reply(1); await b; f.reply(0, 503); await a;
  assert.equal(f.state.error, null); assert.deepEqual(f.state.rooms, [room]);
});
test('late success cannot hide a newer refresh error', async () => {
  const f = fixture(); const a = f.read(); const b = f.read(); f.reply(1, 503); await b;
  f.reply(0, 200, { rooms: [] }); await a; assertError(f.state); assert.deepEqual(f.state.rooms, [room]);
});
test('delayed JSON cannot clear a newer recovery message', async () => {
  const f = fixture(); const body = deferred(); const a = f.read();
  f.state.calls[0].resolve({ ok: true, status: 200, json: () => body.promise }); await Promise.resolve();
  const b = f.read(); f.reply(1, 503); await b; body.resolve({ rooms: [] }); await a;
  assertError(f.state); assert.deepEqual(f.state.rooms, [room]);
});
test('account change suppresses late failure and its notice', async () => {
  const f = fixture(); const p = f.read();
  f.scope.confirmedPerformerIdentity.current = 'different-account'; f.reply(0, 503); await p;
  assert.equal(f.state.error, null);
});
test('account change during JSON prevents both rows and errors crossing accounts', async () => {
  const f = fixture(); const body = deferred(); const p = f.read();
  f.state.calls[0].resolve({ ok: true, status: 200, json: () => body.promise }); await Promise.resolve();
  f.scope.confirmedPerformerIdentity.current = 'different-account'; body.resolve({}); await p;
  assert.equal(f.state.error, null); assert.deepEqual(f.state.rooms, [room]);
});
for (const status of [401, 403]) {
  test(`HTTP ${status} clears protected rows/profile rather than keeping a stale recovery`, async () => {
    const f = fixture(); f.state.error = { performerIdentity: identity, message };
    const p = f.read(); f.reply(0, status); await p;
    assert.equal(f.state.profile, null); assert.deepEqual(f.state.rooms, []); assert.equal(f.state.error, null);
  });
}
test('older denial cannot revoke a newer account already queued in state', async () => {
  const f = fixture(); const p = f.read();
  f.state.profile = { owner_user_id: 'test-owner-b', performer_id: 'test-performer-b' };
  f.reply(0, 403); await p; assert.equal(f.state.profile.owner_user_id, 'test-owner-b');
});
test('superseded context cannot launch a read', async () => {
  const f = fixture(); await f.read(newContext()); assert.equal(f.state.calls.length, 0);
});
test('logout blocks fresh reads and their timers', async () => {
  const f = fixture(); f.scope.logoutInFlight.current = true; await f.read();
  assert.equal(f.state.calls.length, 0); assert.equal(f.state.timers.size, 0);
});
test('logout cancellation suppresses a delayed error', async () => {
  const f = fixture(); const p = f.read(); f.scope.logoutInFlight.current = true;
  cancelPerformerRead(f.scope.roomsReadContext.current); f.reply(0, 503); await p;
  assert.equal(f.state.error, null);
});
test('unmounted context suppresses a late result', async () => {
  const f = fixture(); const p = f.read(); f.scope.roomsReadContext.current.active = false;
  f.reply(0, 503); await p; assert.equal(f.state.error, null); assert.equal(f.state.timers.size, 0);
});
test('a stalled read times out visibly and ignores late success', async () => {
  const f = fixture(); const p = f.read(); f.expire(); assertError(f.state);
  assert.equal(f.state.calls[0].options.signal.aborted, true);
  f.reply(0, 200, { rooms: [] }); await p; assert.deepEqual(f.state.rooms, [room]); assertError(f.state);
});
test('retry after timeout restores confirmed rooms and clears notice', async () => {
  const f = fixture(); const a = f.read(); f.expire(); const b = f.read();
  f.reply(1); await b; f.state.calls[0].reject(new Error('aborted')); await a;
  assert.equal(f.state.error, null); assert.deepEqual(f.state.rooms, [room]);
});
test('superseded timeout cannot interrupt a fresh read', async () => {
  const f = fixture(); const a = f.read(); assert.equal(f.state.timers.size, 1);
  const oldTimeout = [...f.state.timers.values()][0]; const b = f.read(); oldTimeout();
  assert.equal(f.state.calls[1].options.signal.aborted, false); assert.equal(f.state.error, null);
  f.reply(0, 503); await a; assert.equal(f.scope.roomsReadContext.current.controller?.signal, f.state.calls[1].options.signal, 'stale finally must retain the fresh controller');
  f.reply(1); await b;
});
test('demo mode never performs a real room read', async () => {
  const f = fixture({ demoMode: true }); f.state.error = { performerIdentity: identity, message };
  await f.read(); assert.equal(f.state.calls.length, 0); assert.deepEqual(f.state.rooms, []); assert.equal(f.state.error, null);
});
test('auth entry clears local room recovery without fetching', async () => {
  const f = fixture({ isAuthEntryRoute: true }); f.state.error = { performerIdentity: identity, message };
  await f.read(); assert.equal(f.state.calls.length, 0); assert.deepEqual(f.state.rooms, []); assert.equal(f.state.error, null);
});
test('unknown performer identity cannot perform a room read', async () => {
  const f = fixture({ performerIdentity: null }); await f.read(); assert.equal(f.state.calls.length, 0);
});
test('retry callback invokes only the two account read paths', () => {
  const calls = [];
  const retry = new Function('refreshPerformerProfile', 'refreshActiveRooms', `return (${arrow('retryPerformerReads')});`)(
    () => calls.push('profile'), () => calls.push('rooms'));
  retry(); assert.deepEqual(calls, ['profile', 'rooms']);
});
test('recovery notice is account scoped even before layout cleanup', () => {
  const expression = /  const roomsReadError = ([\s\S]*?);\n/.exec(source)?.[1]; assert.ok(expression);
  const evaluate = new Function('demoMode', 'isAuthEntryRoute', 'performerIdentity', 'roomsReadErrorSnapshot', `return (${expression});`);
  const snapshot = { performerIdentity: identity, message };
  assert.equal(evaluate(false, false, identity, snapshot), message);
  for (const args of [[false, false, 'other', snapshot], [false, false, null, snapshot], [true, false, identity, snapshot], [false, true, identity, snapshot]]) assert.equal(evaluate(...args), null);
});
test('closed, live and home views each expose the same guarded read-only recovery', () => {
  assert.match(source, /<button type="button" onClick=\{retryPerformerReads\}/);
  assert.match(source, /Retry profile and rooms/);
  const closedStart = source.indexOf("  if (session.status === 'closed' && shouldRenderPerformerLiveRoom");
  const liveStart = source.indexOf('  if (shouldRenderPerformerLiveRoom', closedStart + 1);
  const homeStart = source.indexOf('  return (\n    <div className="min-h-screen flex flex-col', liveStart + 1);
  assert.ok(closedStart >= 0 && liveStart > closedStart && homeStart > liveStart, 'All three room-view boundaries must exist in order.');
  for (const [name, view] of [
    ['closed', source.slice(closedStart, liveStart)],
    ['live', source.slice(liveStart, homeStart)],
    ['home', source.slice(homeStart)]
  ]) {
    assert.equal((view.match(/\{recoveryContent\}<\/div>/g) ?? []).length, 1, `${name} must render shared recovery exactly once.`);
    assert.equal((view.match(/roomActionError \|\| profileReadError \|\| roomsReadError/g) ?? []).length, 1, `${name} must retain every recovery trigger.`);
    assert.match(view, /<div role="alert"[^>]*>\{recoveryContent\}<\/div>/, `${name} recovery must remain an accessible alert.`);
  }
});
test('account-context creation and logout clear previous recovery notice', () => {
  assert.match(source, /roomsReadContext\.current = context;\s+setRoomsReadErrorSnapshot\(null\);/);
  assert.match(source, /cancelPerformerRead\(roomsReadContext\.current\);\s+setRoomsReadErrorSnapshot\(null\);/);
});
let failed = 0;
const results = [];
for (const { name, run } of cases) {
  try { await run(); results.push({ name, status: 'PASS' }); }
  catch (error) { failed += 1; results.push({ name, status: 'FAIL', error: error.message }); }
}
console.log(JSON.stringify({ proof: 'isolated actual-source logic and source wiring; not React/browser/server/production', sourceSha256: createHash('sha256').update(source).digest('hex'), passed: cases.length - failed, failed, results }, null, 2));
if (failed) process.exitCode = 1;