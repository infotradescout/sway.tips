import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { executeClaimedOnce, executeClaimedBatch, validateExecutionLedger } from './lib/control-bridge-execution.mjs';

const empty = () => ({ outcomes: {}, pendingCompletionIds: [] });
const command = { id: 'fixture-next', action: 'next' };

test('parseable but inconsistent ledger cannot discard pending recovery identity', () => {
  const ledger = { version: 1, bridgeInstanceId: 'fixture-bridge', ...empty() };
  assert.equal(validateExecutionLedger(ledger), ledger);
  assert.throws(() => validateExecutionLedger({ ...ledger, pendingCompletionIds: ['missing'] }), /no durable outcome/);
  for (const outcome of [null, {}, { success: true, result: {}, error: null, finishedAt: 'not a date' }]) {
    assert.throws(() => validateExecutionLedger({ ...ledger, outcomes: { broken: outcome } }), /Invalid bridge execution/);
  }
});

test('an unknown command outcome stops later commands in the claimed batch', async () => {
  const ledger = empty(); const executed = [];
  await executeClaimedBatch([command, { id: 'later-play', action: 'play' }], claimed =>
    executeClaimedOnce({ command: claimed, ledger, persist: () => {}, execute: async () => {
      executed.push(claimed.action); throw new Error('connection lost');
    } }));
  assert.deepEqual(executed, ['next']);
  assert.equal(Object.hasOwn(ledger.outcomes, 'later-play'), false);
});

test('reservation reaches durable storage before any player command', async () => {
  const ledger = empty(); let stored; let executions = 0;
  await executeClaimedOnce({ command, ledger, persist: () => { stored = structuredClone(ledger); },
    execute: async () => {
      executions += 1;
      assert.equal(stored.outcomes[command.id].result.executionStatus, 'unknown');
      assert.deepEqual(stored.pendingCompletionIds, [command.id]);
      return { executed: true };
    } });
  assert.equal(executions, 1);
  assert.equal(stored.outcomes[command.id].success, true);
});

test('failed reservation write prevents player dispatch', async () => {
  let executions = 0;
  await assert.rejects(executeClaimedOnce({ command, ledger: empty(),
    persist: () => { throw new Error('disk full'); }, execute: async () => { executions += 1; } }), /disk full/);
  assert.equal(executions, 0);
});

test('ambiguous player failure and a repeated claim never replay', async () => {
  const ledger = empty(); let executions = 0;
  const run = () => executeClaimedOnce({ command, ledger, persist: () => {},
    execute: async () => { executions += 1; throw new Error('response lost'); } });
  await run(); await run();
  assert.equal(executions, 1);
  assert.equal(ledger.outcomes[command.id].success, false);
  assert.equal(ledger.outcomes[command.id].result.executionStatus, 'unknown');
});

test('lost final write recovers the durable unknown outcome instead of redispatching', async () => {
  let stored; let writes = 0; let executions = 0;
  const ledger = empty();
  await assert.rejects(executeClaimedOnce({ command, ledger,
    persist: () => { if (++writes === 2) throw new Error('write lost'); stored = structuredClone(ledger); },
    execute: async () => { executions += 1; return { executed: true }; } }), /write lost/);
  const recovered = await executeClaimedOnce({ command, ledger: stored, persist: () => {},
    execute: async () => { executions += 1; } });
  assert.equal(executions, 1);
  assert.equal(recovered.result.executionStatus, 'unknown');
});

test('real process exit after player dispatch preserves identity across restart', { timeout: 10000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sway-restart-proof-'));
  try {
    const receipt = path.join(directory, 'ledger.json');
    const worker = path.join(directory, 'worker.mjs');
    const helper = pathToFileURL(path.resolve('scripts/lib/control-bridge-execution.mjs')).href;
    await writeFile(worker, `import { writeFileSync } from 'node:fs';
      import { executeClaimedOnce } from ${JSON.stringify(helper)};
      const ledger = { outcomes: {}, pendingCompletionIds: [] };
      await executeClaimedOnce({ command: ${JSON.stringify(command)}, ledger,
        persist: () => writeFileSync(process.argv[2], JSON.stringify(ledger)),
        execute: async () => { process.exit(23); } });`);
    const child = spawn(process.execPath, [worker, receipt], { stdio: 'ignore', windowsHide: true });
    const [code] = await once(child, 'exit');
    assert.equal(code, 23);
    const ledger = JSON.parse(await readFile(receipt, 'utf8'));
    let executions = 0;
    const result = await executeClaimedOnce({ command, ledger, persist: () => {},
      execute: async () => { executions += 1; } });
    assert.equal(executions, 0);
    assert.equal(result.success, false);
    assert.equal(result.result.executionStatus, 'unknown');
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.match(path.basename(directory), /^sway-restart-proof-/);
    await rm(directory, { recursive: true, force: true });
  }
});
