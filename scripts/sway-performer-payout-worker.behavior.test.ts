import assert from 'node:assert/strict';
import { createPerformerPayoutReconciliationTick } from '../src/server/performer-payout-worker';

for (const executionEnabled of [false, true]) {
  const calls: Array<{ limit: number; allowSubmissions: boolean }> = [];
  const tick = createPerformerPayoutReconciliationTick({
    executionEnabled,
    service: {
      async reconcilePending(limit, options) {
        calls.push({ limit, allowSubmissions: options.allowSubmissions });
        return [];
      }
    },
    onError: (error) => { throw error; }
  });
  await tick();
  assert.deepEqual(calls, [{ limit: 25, allowSubmissions: executionEnabled }],
    'A paused worker must still reconcile, while carrying the submission fence into the service.');
}

let finishRead: () => void;
const pendingRead = new Promise<void>((resolve) => { finishRead = resolve; });
let reads = 0;
const serializedTick = createPerformerPayoutReconciliationTick({
  executionEnabled: false,
  service: {
    async reconcilePending() {
      reads += 1;
      await pendingRead;
      return [];
    }
  },
  onError: (error) => { throw error; }
});
const firstRead = serializedTick();
await serializedTick();
await serializedTick();
assert.equal(reads, 1, 'A slow provider read must not overlap another tick.');
finishRead();
await firstRead;
await serializedTick();
assert.equal(reads, 2, 'The next tick must run after the prior read settles.');

let attempts = 0;
const errors: unknown[] = [];
const failure = new Error('synthetic database outage');
const retryTick = createPerformerPayoutReconciliationTick({
  executionEnabled: false,
  service: {
    async reconcilePending(_limit, options) {
      assert.equal(options.allowSubmissions, false, 'Recovery must preserve the paused-send fence.');
      if (++attempts === 1) throw failure;
      return [];
    }
  },
  onError: (error) => { errors.push(error); }
});
await retryTick();
await retryTick();
assert.equal(attempts, 2, 'A failed reconciliation must not permanently lock the worker.');
assert.deepEqual(errors, [failure]);

console.log('Performer payout worker behavior passed: paused readback, send fence, no overlap, and failure retry.');
