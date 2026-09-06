import assert from 'node:assert/strict';
import { createPerformerEventReads } from '../src/performer-event-reads.ts';
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function response(data, status = 200) { return { status, ok: status >= 200 && status < 300, json: async () => data }; }
function fixture(timeout = 200) {
  const calls = [], trace = [];
  const state = { events: [{ id: 'confirmed' }], status: 'ready', error: null, capability: { salesAvailable: true }, capabilityError: null, denied: false };
  const reader = createPerformerEventReads({
    onLoading() { trace.push('loading'); state.status = 'loading'; state.error = null; },
    onEvents(events) { trace.push('events'); state.events = events; state.status = 'ready'; state.denied = false; },
    onEventError(message) { trace.push('event-error'); state.error = message; state.status = 'error'; },
    onCapability(value) { trace.push('capability'); state.capability = value; },
    onCapabilityError(value) { trace.push('capability-error'); state.capabilityError = value; },
    onAccessLost() { trace.push('denied'); state.events = []; state.capability = null; state.denied = true; state.status = 'error'; }
  }, (url, init) => { const pending = deferred(); calls.push({ url, init, ...pending }); return pending.promise; }, timeout);
  return { reader, calls, trace, state };
}
let pass = 0;
async function test(name, check) {
  const fixtures = [];
  try { await check((...args) => { const f = fixture(...args); fixtures.push(f); return f; }); pass++; console.log(`PASS ${name}`); }
  finally { fixtures.forEach((f) => f.reader.dispose()); }
}
await test('both reads start independently and list resolves without ticket readiness', async (make) => {
  const f = make(); const loaded = f.reader.load(); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].url, '/api/talent/events'); assert.equal(f.calls[1].url, '/api/talent/events/native-ticket-capability');
  f.calls[0].resolve(response({ events: [{ id: 'show-a' }] })); await loaded;
  assert.deepEqual(f.state.events, [{ id: 'show-a' }]); assert.equal(f.state.status, 'ready'); assert.equal(f.state.capability, null);
});
await test('ticket network failure does not hide a valid schedule', async (make) => {
  const f = make(); const loaded = f.reader.load(); f.calls[1].reject(new Error('network'));
  f.calls[0].resolve(response({ events: [{ id: 'show-b' }] })); await loaded; await tick();
  assert.equal(f.state.events[0].id, 'show-b'); assert.equal(f.state.status, 'ready'); assert.match(f.state.capabilityError, /Ticket sales could not be checked/);
});
await test('schedule failure preserves confirmed shows', async (make) => {
  const f = make(); const loaded = f.reader.load(); f.calls[0].reject(new Error('network')); f.calls[1].resolve(response({ capability: { salesAvailable: false } }));
  await loaded; assert.equal(f.state.status, 'error'); assert.equal(f.state.events[0].id, 'confirmed');
});
for (const [label, data] of [['missing', {}], ['null', { events: null }], ['object', { events: {} }], ['string', { events: '[]' }]]) {
  await test(`${label} schedule does not masquerade as empty`, async (make) => {
    const f = make(); const loaded = f.reader.load(); f.calls[0].resolve(response(data)); await loaded;
    assert.equal(f.state.status, 'error'); assert.equal(f.state.events[0].id, 'confirmed');
  });
}
await test('confirmed empty list clears previous shows', async (make) => {
  const f = make(); const loaded = f.reader.load(); f.calls[0].resolve(response({ events: [] })); await loaded;
  assert.deepEqual(f.state.events, []); assert.equal(f.state.status, 'ready');
});
for (const endpoint of [0, 1]) {
  for (const status of [401, 403]) {
    await test(`${status} on endpoint ${endpoint} clears private state and prevents late repopulation`, async (make) => {
      const f = make(); const loaded = f.reader.load(); f.calls[endpoint].resolve(response({}, status)); await tick();
      assert.equal(f.state.denied, true); assert.deepEqual(f.state.events, []); assert.equal(f.state.capability, null);
      assert.equal(f.calls[1 - endpoint].init.signal.aborted, true);
      f.calls[1 - endpoint].resolve(response(endpoint === 0 ? { capability: { salesAvailable: true } } : { events: [{ id: 'forbidden' }] })); await loaded; await tick();
      assert.deepEqual(f.state.events, []); assert.equal(f.state.capability, null);
    });
  }
}
await test('ticket denial after schedule success still revokes private state', async (make) => {
  const f = make(); const loaded = f.reader.load(); f.calls[0].resolve(response({ events: [{ id: 'show' }] })); await loaded;
  f.calls[1].resolve(response({}, 403)); await tick(); assert.equal(f.state.denied, true); assert.deepEqual(f.state.events, []);
});
await test('superseding refresh cancels both old reads and ignores stale bodies', async (make) => {
  const f = make(); const oldBody = deferred(); const first = f.reader.load();
  f.calls[0].resolve({ status: 200, ok: true, json: () => oldBody.promise }); await tick();
  const second = f.reader.load(); assert.equal(f.calls[0].init.signal.aborted, true); assert.equal(f.calls[1].init.signal.aborted, true);
  f.calls[2].resolve(response({ events: [{ id: 'new' }] })); f.calls[3].resolve(response({ capability: { salesAvailable: false } })); await second;
  oldBody.resolve({ events: [{ id: 'old' }] }); f.calls[1].resolve(response({ capability: { salesAvailable: true } })); await first; await tick();
  assert.equal(f.state.events[0].id, 'new'); assert.equal(f.state.capability.salesAvailable, false);
});
await test('old access denial cannot revoke a newer successful refresh', async (make) => {
  const f = make(); const first = f.reader.load(); const second = f.reader.load();
  f.calls[2].resolve(response({ events: [{ id: 'new' }] })); f.calls[3].resolve(response({ capability: { salesAvailable: true } })); await second;
  f.calls[0].resolve(response({}, 403)); f.calls[1].resolve(response({}, 401)); await first; await tick();
  assert.equal(f.state.denied, false); assert.equal(f.state.events[0].id, 'new'); assert.equal(f.state.capability.salesAvailable, true);
});
for (const endpoint of [0, 1]) {
  for (const stalledBody of [false, true]) {
    await test(`deadline bounds endpoint ${endpoint} ${stalledBody ? 'body' : 'transport'} and late completion`, async (make) => {
      const f = make(20); const body = deferred(); const loaded = f.reader.load();
      if (stalledBody) f.calls[endpoint].resolve({ status: 200, ok: true, json: () => body.promise });
      f.calls[1 - endpoint].resolve(response(endpoint === 0 ? { capability: { salesAvailable: false } } : { events: [{ id: 'show' }] }));
      await delay(40); await loaded;
      assert.equal(f.calls[endpoint].init.signal.aborted, true);
      if (endpoint === 0) { assert.equal(f.state.status, 'error'); assert.equal(f.state.events[0].id, 'confirmed'); }
      else { assert.equal(f.state.status, 'ready'); assert.equal(f.state.events[0].id, 'show'); assert.equal(f.state.capability, null); assert.ok(f.state.capabilityError); }
      const before = JSON.stringify(f.state); const late = endpoint === 0 ? { events: [{ id: 'too-late' }] } : { capability: { salesAvailable: true } };
      if (stalledBody) body.resolve(late); else f.calls[endpoint].resolve(response(late));
      await tick(); assert.equal(JSON.stringify(f.state), before);
    });
  }
}
await test('disposal cancels all reads and suppresses all later callbacks', async (make) => {
  const f = make(); const loaded = f.reader.load(); f.reader.dispose(); const before = f.trace.length;
  for (const c of f.calls) { assert.equal(c.init.signal.aborted, true); c.resolve(response({ events: [], capability: { salesAvailable: true } })); }
  await loaded; await tick(); assert.equal(f.trace.length, before); await f.reader.load(); assert.equal(f.calls.length, 2);
});
await test('refresh removes previous permission and quotes immediately', async (make) => {
  const f = make(); const first = f.reader.load(); f.calls[0].resolve(response({ events: [] })); f.calls[1].resolve(response({ capability: { salesAvailable: true, feeBps: 1000 } })); await first; await tick();
  assert.equal(f.state.capability.salesAvailable, true); const second = f.reader.load(); assert.equal(f.state.capability, null);
  f.calls[2].resolve(response({ events: [] })); f.calls[3].resolve(response({ capability: null })); await second; await tick(); assert.equal(f.state.capability, null); assert.ok(f.state.capabilityError);
});
await test('explicit recovery after denied access can reload without automatic mutation', async (make) => {
  const f = make(); const first = f.reader.load(); f.calls[0].resolve(response({}, 401)); await first;
  assert.equal(f.state.denied, true); const second = f.reader.load(); f.calls[2].resolve(response({ events: [{ id: 'returned' }] })); f.calls[3].resolve(response({ capability: { salesAvailable: false } })); await second; await tick();
  assert.equal(f.state.denied, false); assert.equal(f.state.events[0].id, 'returned');
  for (const call of f.calls) { assert.equal(call.init.method, undefined); assert.equal(call.init.cache, 'no-store'); assert.equal(call.init.body, undefined); assert.ok(call.init.signal); }
});
for (const endpoint of [0, 1]) {
  await test(`unreadable JSON on endpoint ${endpoint} is handled without an unhandled rejection`, async (make) => {
    const f = make(); const loaded = f.reader.load(); f.calls[endpoint].resolve({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad body'); } });
    f.calls[1 - endpoint].resolve(response(endpoint === 0 ? { capability: { salesAvailable: false } } : { events: [] })); await loaded; await tick();
    assert.ok(endpoint === 0 ? f.state.error : f.state.capabilityError);
  });
}
console.log(`EVENT_READ_TOTAL ${pass} PASS ${pass} FAIL 0`);
