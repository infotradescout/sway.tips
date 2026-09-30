import assert from 'node:assert/strict';
import http from 'node:http';
import {
  acceptedTargetDeck,
  bridgeAuthGeneration,
  createBridgeLedger,
  isPlaybackCompletionReceipt,
  reservePlaybackSubmission,
  resolvePlaybackSubmission,
  restoreBridgeLedger,
  submitReservedPlaybackCommand
} from './lib/control-bridge-ledger.mjs';

const ids = ['bridge-generation-a', 'bridge-generation-b', 'submission-a', 'submission-b', 'submission-c'];
const createId = () => ids.shift();
const gigId = '30000000-0000-4000-8000-000000000071';
const generationA = bridgeAuthGeneration('room-token-a');
const generationB = bridgeAuthGeneration('room-token-b');
assert.notEqual(generationA, generationB);

const completionIdentity = { commandId: 'completion-a', gigId, sourceKey: 'virtualdj', success: true };
const completionReceipt = { success: true, command: { id: 'completion-a', gigId, sourceKey: 'virtualdj', status: 'succeeded' } };
assert.equal(isPlaybackCompletionReceipt(completionReceipt, completionIdentity), true);
assert.equal(isPlaybackCompletionReceipt({ ...completionReceipt, success: false }, completionIdentity), false);
for (const [field, value] of Object.entries({ id: 'other-command', gigId: 'other-room', sourceKey: 'generic_midi', status: 'claimed' })) {
  assert.equal(isPlaybackCompletionReceipt({ ...completionReceipt, command: { ...completionReceipt.command, [field]: value } }, completionIdentity), false);
}
assert.equal(isPlaybackCompletionReceipt(null, completionIdentity), false);
assert.equal(isPlaybackCompletionReceipt({ success: true }, completionIdentity), false);
assert.equal(isPlaybackCompletionReceipt({ ...completionReceipt, command: { ...completionReceipt.command, status: 'failed' } }, { ...completionIdentity, success: false }), true,
  'a failed player outcome still has a successful server receipt');
assert.equal(isPlaybackCompletionReceipt(completionReceipt, { ...completionIdentity, success: false }), false,
  'the terminal receipt must match the locally reported outcome');

const first = createBridgeLedger({ gigId, authGeneration: generationA, deck: 1, createId });
first.outcomes.commandA = { success: true };
first.pendingCompletionIds.push('commandA');
const sameTokenRestart = restoreBridgeLedger(JSON.parse(JSON.stringify(first)), {
  gigId, authGeneration: generationA, deck: 2, createId
});
assert.equal(sameTokenRestart.bridgeInstanceId, first.bridgeInstanceId);
assert.deepEqual(sameTokenRestart.pendingCompletionIds, ['commandA']);
assert.equal(sameTokenRestart.outcomes.commandA.success, true);

const replacement = restoreBridgeLedger(JSON.parse(JSON.stringify(first)), {
  gigId, authGeneration: generationB, deck: 2, createId
});
assert.notEqual(replacement.bridgeInstanceId, first.bridgeInstanceId);
assert.deepEqual(replacement.pendingCompletionIds, []);
assert.deepEqual(replacement.outcomes, {});

const intent = { sourceKey: 'virtualdj', action: 'next', payload: { deck: 2, track: null } };
const lostFirstResponse = reservePlaybackSubmission(replacement, intent, { now: 1_000, createId });
const deliberateRetry = reservePlaybackSubmission(replacement, intent, { now: 2_000, createId });
assert.equal(deliberateRetry.clientCommandId, lostFirstResponse.clientCommandId);
assert.equal(Object.keys(replacement.submissions).length, 1, 'one unresolved intent retains one cloud command id');
assert.throws(
  () => reservePlaybackSubmission(replacement, { ...intent, action: 'play' }, { now: 2_500, createId }),
  /previous playback submission is unresolved/,
  'a different action cannot pass an unresolved transport-ambiguous submission'
);
assert.throws(
  () => reservePlaybackSubmission(replacement, {
    sourceKey: 'virtualdj', action: 'load', payload: { deck: 2, track: { requestId: 'changed-top-request' } }
  }, { now: 2_500, createId }),
  /previous playback submission is unresolved/,
  'a changed top request cannot manufacture a second id while the first load is unresolved'
);
resolvePlaybackSubmission(replacement, lostFirstResponse.intentKey);
const laterResolvedAction = reservePlaybackSubmission(replacement, intent, { now: 3_000, createId });
assert.notEqual(laterResolvedAction.clientCommandId, lostFirstResponse.clientCommandId, 'a later resolved action gets a new id');
const afterLocalTtl = reservePlaybackSubmission(replacement, intent, { now: 130_000, createId });
assert.notEqual(afterLocalTtl.clientCommandId, laterResolvedAction.clientCommandId, 'an offline submission cannot remain executable beyond the local TTL');
assert.equal(acceptedTargetDeck(1, { deck: 2, observation: null }), 2,
  'an accepted command moves the next polling target even when immediate observation failed');

const responseStatuses = new Map();
const receivedIds = new Map();
const fakeSway = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
  const key = requestUrl.pathname.slice(1);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const idsForCase = receivedIds.get(key) ?? [];
  idsForCase.push(body.clientCommandId);
  receivedIds.set(key, idsForCase);
  const status = responseStatuses.get(key) ?? 200;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(status >= 200 && status < 300
    ? { success: true, command: {
      id: '40000000-0000-4000-8000-000000000071', clientCommandId: body.clientCommandId,
      gigId: body.gigId, sourceKey: intent.sourceKey, action: intent.action, status: 'queued'
    } }
    : { error: `synthetic ${status}` }));
});
await new Promise((resolve) => fakeSway.listen(0, '127.0.0.1', resolve));
const address = fakeSway.address();
assert.ok(address && typeof address === 'object');

try {
  for (const failureStatus of [400, 500, 502]) {
    const key = `http-${failureStatus}`;
    let sequence = 0;
    const makeId = () => `${key}-${sequence++}`;
    let activeLedger = createBridgeLedger({
      gigId: `${gigId}-${failureStatus}`,
      authGeneration: generationA,
      deck: 2,
      createId: makeId
    });
    let durableLedger = null;
    const persist = () => {
      durableLedger = JSON.parse(JSON.stringify(activeLedger));
    };
    const post = async (clientCommandId) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/${key}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientCommandId, gigId: activeLedger.gigId })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      return data;
    };
    responseStatuses.set(key, failureStatus);
    await assert.rejects(
      submitReservedPlaybackCommand({ ledger: activeLedger, intent, persist, submit: post }),
      new RegExp(String(failureStatus))
    );
    const firstId = receivedIds.get(key)[0];
    assert.equal(Object.keys(activeLedger.submissions).length, 1);
    assert.equal(Object.keys(durableLedger.submissions).length, 1, 'the failed HTTP receipt leaves the durable reservation intact');

    activeLedger = restoreBridgeLedger(durableLedger, {
      gigId: activeLedger.gigId, authGeneration: generationA, deck: 2, createId: makeId
    });
    await assert.rejects(
      submitReservedPlaybackCommand({ ledger: activeLedger, intent: { ...intent, action: 'play' }, persist, submit: post }),
      /previous playback submission is unresolved/
    );
    await assert.rejects(
      submitReservedPlaybackCommand({ ledger: activeLedger, intent, persist, submit: post }),
      new RegExp(String(failureStatus))
    );
    assert.deepEqual(new Set(receivedIds.get(key)), new Set([firstId]),
      `${failureStatus} retries must expose exactly one cloud command identity`);
    assert.equal(Object.keys(activeLedger.submissions).length, 1);

    responseStatuses.set(key, 200);
    await submitReservedPlaybackCommand({ ledger: activeLedger, intent, persist, submit: post });
    assert.equal(new Set(receivedIds.get(key)).size, 1, 'the successful replay uses the original id');
    assert.equal(Object.keys(activeLedger.submissions).length, 0, 'only a positive replay receipt clears memory');
    assert.equal(Object.keys(durableLedger.submissions).length, 0, 'only a positive replay receipt clears disk state');
  }

  const clearFailureKey = 'clear-persist-failure';
  let sequence = 0;
  const makeId = () => `${clearFailureKey}-${sequence++}`;
  let clearFailureLedger = createBridgeLedger({ gigId: `${gigId}-clear`, authGeneration: generationA, deck: 2, createId: makeId });
  let durableLedger = null;
  let persistCalls = 0;
  const persistWithOneClearFailure = () => {
    persistCalls += 1;
    if (persistCalls === 2) throw new Error('synthetic cleared-ledger persistence failure');
    durableLedger = JSON.parse(JSON.stringify(clearFailureLedger));
  };
  const post = async (clientCommandId) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/${clearFailureKey}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientCommandId, gigId: clearFailureLedger.gigId })
    });
    return response.json();
  };
  await assert.rejects(
    submitReservedPlaybackCommand({ ledger: clearFailureLedger, intent, persist: persistWithOneClearFailure, submit: post }),
    /cleared-ledger persistence failure/
  );
  const retainedId = receivedIds.get(clearFailureKey)[0];
  assert.equal(Object.values(clearFailureLedger.submissions)[0].clientCommandId, retainedId,
    'a failed clear save restores the reservation in memory');
  assert.equal(Object.values(durableLedger.submissions)[0].clientCommandId, retainedId,
    'the prior durable reservation remains recoverable');
  clearFailureLedger = restoreBridgeLedger(durableLedger, {
    gigId: clearFailureLedger.gigId, authGeneration: generationA, deck: 2, createId: makeId
  });
  await submitReservedPlaybackCommand({
    ledger: clearFailureLedger,
    intent,
    persist: () => { durableLedger = JSON.parse(JSON.stringify(clearFailureLedger)); },
    submit: post
  });
  assert.deepEqual(new Set(receivedIds.get(clearFailureKey)), new Set([retainedId]));
  assert.equal(Object.keys(durableLedger.submissions).length, 0);
} finally {
  await new Promise((resolve, reject) => fakeSway.close((error) => error ? reject(error) : resolve()));
}

console.log('Sway control bridge generation and submission ledger tests passed.');

{
  const { mkdtempSync, readFileSync, renameSync, writeFileSync } = await import('node:fs');
  const { default: os } = await import('node:os');
  const { default: path } = await import('node:path');
  const { default: test } = await import('node:test');
// Disposable disk ledger and injected submission transport only. No listener,
// player, cloud command, credentials, or customer data are used.
const gigId = '30000000-0000-4000-8000-000000000071';
const authGeneration = 'synthetic-token-generation';
const intent = { sourceKey: 'virtualdj', action: 'next', payload: { deck: 2, track: null } };
const serverId = '40000000-0000-4000-8000-000000000071';
const validReceipt = (clientCommandId, status = 'queued') => ({
  success: true,
  replay: false,
  command: { id: serverId, clientCommandId, gigId, sourceKey: 'virtualdj', action: 'next', status }
});

function fixture() {
  let sequence = 0;
  const createId = () => `synthetic-${sequence++}`;
  const options = { gigId, authGeneration, deck: 2, createId };
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sway-receipt-regression-'));
  const ledgerPath = path.join(directory, 'ledger.json');
  let ledger = createBridgeLedger(options);
  const persist = () => {
    writeFileSync(`${ledgerPath}.tmp`, JSON.stringify(ledger));
    renameSync(`${ledgerPath}.tmp`, ledgerPath);
  };
  return {
    get ledger() { return ledger; },
    persist,
    restart() { ledger = restoreBridgeLedger(JSON.parse(readFileSync(ledgerPath, 'utf8')), options); },
    durable() { return JSON.parse(readFileSync(ledgerPath, 'utf8')); },
    reserveOptions: { now: 1_000, createId }
  };
}

const malformed = [
  ['empty 2xx', () => null],
  ['HTML 2xx', () => ({ raw: '<html>upstream unavailable</html>' })],
  ['error-shaped 2xx', () => ({ success: false, error: 'synthetic' })],
  ['missing command', () => ({ success: true })],
  ['wrong client identity', (id) => ({ ...validReceipt(id), command: { ...validReceipt(id).command, clientCommandId: 'other-client' } })],
  ['wrong room', (id) => ({ ...validReceipt(id), command: { ...validReceipt(id).command, gigId: 'other-room' } })],
  ['wrong source', (id) => ({ ...validReceipt(id), command: { ...validReceipt(id).command, sourceKey: 'generic_midi' } })],
  ['wrong action', (id) => ({ ...validReceipt(id), command: { ...validReceipt(id).command, action: 'play' } })],
  ['unknown status', (id) => ({ ...validReceipt(id), command: { ...validReceipt(id).command, status: 'maybe' } })],
  ['missing server identity', (id) => ({ ...validReceipt(id), command: { ...validReceipt(id).command, id: '' } })]
];

for (const [label, response] of malformed) {
  test(`${label} retains command identity through restart and deliberate retry`, async () => {
    const state = fixture();
    const receivedIds = [];
    let observedError;
    try {
      await submitReservedPlaybackCommand({
        ledger: state.ledger, intent, persist: state.persist, reserveOptions: state.reserveOptions,
        submit: async (id) => { receivedIds.push(id); return response(id); }
      });
    } catch (error) { observedError = error; }
    state.restart();
    await submitReservedPlaybackCommand({
      ledger: state.ledger, intent, persist: state.persist, reserveOptions: state.reserveOptions,
      submit: async (id) => { receivedIds.push(id); return validReceipt(id); }
    });
    assert.equal(new Set(receivedIds).size, 1, `${label} must never manufacture a second client identity`);
    assert.match(observedError?.message ?? '', /receipt.*identity/i);
    assert.deepEqual(state.durable().submissions, {});
  });
}

test('late same-intent receipt cannot clear a newer ambiguous reservation', async () => {
  const state = fixture();
  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
    return { promise, resolve, reject };
  };
  const first = deferred(), late = deferred(), newer = deferred();
  const received = [];
  const run = (pending) => submitReservedPlaybackCommand({
    ledger: state.ledger, intent, persist: state.persist, reserveOptions: state.reserveOptions,
    submit: (id) => { received.push(id); return pending.promise; }
  });
  const a = run(first), b = run(late);
  await Promise.resolve();
  assert.equal(received.length, 2);
  first.resolve(validReceipt(received[0]));
  await a;
  const c = run(newer);
  await Promise.resolve();
  assert.notEqual(received[2], received[0]);
  late.resolve(validReceipt(received[1]));
  await b;
  newer.reject(new Error('synthetic delivery ambiguity'));
  await assert.rejects(c, /delivery ambiguity/);
  state.restart();
  await submitReservedPlaybackCommand({
    ledger: state.ledger, intent, persist: state.persist, reserveOptions: state.reserveOptions,
    submit: async (id) => { received.push(id); return validReceipt(id); }
  });
  assert.equal(received[3], received[2], 'the newer command must retain its original identity after restart');
});

test('delayed cleared-ledger failure cannot restore over a newer reservation', async () => {
  const state = fixture();
  let failClear;
  const clearFailure = new Promise((_, reject) => { failClear = reject; });
  let clearStarted;
  const started = new Promise((resolve) => { clearStarted = resolve; });
  let calls = 0;
  const a = submitReservedPlaybackCommand({
    ledger: state.ledger, intent, reserveOptions: state.reserveOptions,
    persist: () => {
      calls += 1;
      if (calls === 2) { clearStarted(); return clearFailure; }
      state.persist();
    },
    submit: async (id) => validReceipt(id)
  });
  const rejectedA = assert.rejects(a, /synthetic clear failure/);
  await started;
  let newerId;
  const newerError = new Error('synthetic newer delivery ambiguity');
  await assert.rejects(submitReservedPlaybackCommand({
    ledger: state.ledger, intent, persist: state.persist, reserveOptions: state.reserveOptions,
    submit: async (id) => { newerId = id; throw newerError; }
  }), /newer delivery ambiguity/);
  failClear(new Error('synthetic clear failure'));
  await rejectedA;
  assert.equal(Object.values(state.ledger.submissions)[0].clientCommandId, newerId);
  state.restart();
  assert.equal(Object.values(state.ledger.submissions)[0].clientCommandId, newerId);
});

for (const status of ['queued', 'claimed', 'succeeded', 'failed', 'expired']) {
  test(`matching ${status} receipt resolves a persisted reservation`, async () => {
    const state = fixture();
    await submitReservedPlaybackCommand({
      ledger: state.ledger, intent, persist: state.persist, reserveOptions: state.reserveOptions,
      submit: async (id) => validReceipt(id, status)
    });
    assert.deepEqual(state.durable().submissions, {});
  });
}

}
