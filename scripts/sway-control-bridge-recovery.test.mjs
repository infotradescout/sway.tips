import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { restoreBridgeLedger, bridgeAuthGeneration, acceptedTargetDeck, isPlaybackCompletionReceipt, submitReservedPlaybackCommand } from './lib/control-bridge-ledger.mjs';
import { VirtualDjNetworkControl } from './lib/virtualdj-network-control.mjs';

// Execute the real bridge functions without its listener, tokens or cloud/player.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'scripts/sway-control-bridge.mjs'), 'utf8');
const functions = source.slice(source.indexOf('function loadLedger('), source.indexOf('const args = parseArgs('));
assert.ok(functions.includes('async function bridgeTick()'));
const authGeneration = bridgeAuthGeneration('synthetic-recovery-generation');
const gigId = 'synthetic-recovery-room';
function fixture(directory, overrides = {}) {
  const ledgerPath = path.join(directory, 'ledger.json');
  const context = {
    ...fs, path, process, console, Date, restoreBridgeLedger, acceptedTargetDeck, isPlaybackCompletionReceipt,
    gigId, ledgerPath, activeDeck: 1, lastCloudError: null, lastVirtualDjError: null,
    lastStatePushAt: 0, tickRunning: false, ...overrides
  };
  vm.createContext(context);
  vm.runInContext(functions, context);
  context.ledger = context.loadLedger(ledgerPath, { gigId, authGeneration, deck: 1 });
  context.activeDeck = context.ledger.targetDeck;
  return context;
}
const receiptFor = (body) => ({ success: true, command: {
  id: body.commandId, gigId: body.gig_id, sourceKey: body.sourceKey,
  status: body.success ? 'succeeded' : 'failed'
} });
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sway-bridge-recovery-'));

if (process.argv[2] === '--child') {
  const [directory, scenario, phase] = process.argv.slice(3);
  const playerPath = path.join(directory, 'injected-player.json');
  const readPlayer = () => fs.existsSync(playerPath) ? JSON.parse(fs.readFileSync(playerPath, 'utf8')) : { mutations: 0, stateDecks: [] };
  const savePlayer = (state) => fs.writeFileSync(playerPath, JSON.stringify(state));
  const command = { id: 'synthetic-command', action: 'pause', payload: { deck: 4 }, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const adapter = new VirtualDjNetworkControl({ deck: 1, fetchImpl: async (url, options) => {
    const player = readPlayer();
    if (url.endsWith('/execute')) {
      const durable = JSON.parse(fs.readFileSync(path.join(directory, 'ledger.json'), 'utf8'));
      assert.equal(durable.targetDeck, 4, 'intended deck is durable before the player receives a command');
      player.mutations += 1;
      savePlayer(player);
      if (scenario === 'lost-execute' && phase === 'first') throw new Error('synthetic lost execute response');
      return { ok: true, text: async () => 'true' };
    }
    player.stateDecks.push(Number(options.body.match(/^deck (\d+)/)?.[1]));
    savePlayer(player);
    const answer = options.body.endsWith('get_title') ? 'Synthetic fixture' : options.body.endsWith('get_artist') ? 'Test only'
      : options.body.endsWith('get_filepath') ? '' : options.body.endsWith('get_bpm') ? '120' : 'false';
    return { ok: true, text: async () => answer };
  } });
  const context = fixture(directory, { virtualDj: adapter, cloudRequest: async (route, { body }) => {
    if (route.endsWith('/state')) return { success: true };
    if (route.endsWith('/claim')) return { commands: [command] }; // Adversarial duplicate exercises local dedup beyond the server fence.
    if (route.endsWith('/complete')) {
      if (phase === 'first') throw new Error('synthetic lost completion response');
      return receiptFor(body);
    }
    throw new Error('unexpected injected route');
  } });
  await context.bridgeTick();
  const player = readPlayer();
  process.stdout.write(JSON.stringify({ pid: process.pid, platform: process.platform, mutations: player.mutations,
    targetDeck: context.ledger.targetDeck, pending: context.ledger.pendingCompletionIds.length,
    success: context.ledger.outcomes[command.id]?.success, error: context.ledger.outcomes[command.id]?.error,
    stateDecks: player.stateDecks, bridgeInstanceId: context.ledger.bridgeInstanceId }));
} else {
  for (const scenario of ['lost-execute', 'lost-completion']) {
    test(`${scenario}: native process restart observes intended deck and never repeats injected mutation`, () => {
      const directory = scratch();
      const runs = ['first', 'restart'].map((phase) => {
        const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', directory, scenario, phase], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout);
      });
      assert.notEqual(runs[0].pid, runs[1].pid);
      assert.equal(runs[0].bridgeInstanceId, runs[1].bridgeInstanceId);
      assert.equal(runs[0].mutations, 1);
      assert.equal(runs[1].mutations, 1);
      assert.equal(runs[0].pending, 1);
      assert.equal(runs[1].pending, 0);
      assert.equal(runs[0].targetDeck, 4);
      assert.equal(runs[1].targetDeck, 4);
      assert.ok(runs[1].stateDecks.slice(runs[0].stateDecks.length).every((deck) => deck === 4));
      assert.equal(runs[1].success, scenario === 'lost-completion');
      if (scenario === 'lost-execute') assert.match(runs[1].error, /uncertain/);
      console.log(`RECOVERY_PROOF ${JSON.stringify({ scenario, ...runs[1], directory })}`);
    });
  }
  for (const mutation of [
    { name: 'unsuccessful top-level response', change: (value) => ({ ...value, success: false }) },
    { name: 'missing command', change: () => ({ success: true }) },
    { name: 'wrong command', change: (value) => ({ ...value, command: { ...value.command, id: 'other-command' } }) },
    { name: 'wrong room', change: (value) => ({ ...value, command: { ...value.command, gigId: 'other-room' } }) },
    { name: 'wrong source', change: (value) => ({ ...value, command: { ...value.command, sourceKey: 'generic_midi' } }) },
    { name: 'nonterminal command', change: (value) => ({ ...value, command: { ...value.command, status: 'claimed' } }) },
    { name: 'mismatched terminal outcome', change: (value) => ({ ...value, command: { ...value.command, status: 'failed' } }) }
  ]) {
    test(`${mutation.name}: completion stays durable until matching receipt, without player execution`, async () => {
      const context = fixture(scratch(), { cloudRequest: async (_route, { body }) => mutation.change(receiptFor(body)) });
      context.ledger.outcomes.command = { success: true, result: {}, finishedAt: new Date().toISOString() };
      context.ledger.pendingCompletionIds = ['command'];
      context.saveLedger();
      await context.flushCompletions();
      assert.equal(context.ledger.pendingCompletionIds.length, 1);
      assert.equal(JSON.parse(fs.readFileSync(context.ledgerPath, 'utf8')).pendingCompletionIds.length, 1);
      context.cloudRequest = async (_route, { body }) => receiptFor(body);
      await context.flushCompletions();
      assert.equal(context.ledger.pendingCompletionIds.length, 0);
      assert.ok(context.ledger.outcomes.command);
    });
  }
  test('matching failed terminal receipt clears retry while preserving uncertain outcome', async () => {
    const context = fixture(scratch(), { cloudRequest: async (_route, { body }) => receiptFor(body) });
    context.ledger.outcomes.command = { success: false, result: {}, error: 'Uncertain outcome', finishedAt: new Date().toISOString() };
    context.ledger.pendingCompletionIds = ['command'];
    context.saveLedger();
    await context.flushCompletions();
    assert.equal(context.ledger.pendingCompletionIds.length, 0);
    assert.equal(context.ledger.outcomes.command.error, 'Uncertain outcome');
  });
  test('invalid target never executes a player command or changes saved selection', async () => {
    let executions = 0;
    const context = fixture(scratch(), { virtualDj: { executeCommand: async () => { executions++; } } });
    await context.executeClaimedCommand({ id: 'invalid-target', action: 'pause', payload: { deck: 9 }, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    assert.equal(executions, 0);
    assert.equal(context.ledger.targetDeck, 1);
    assert.equal(context.ledger.outcomes['invalid-target'].success, false);
  });
  test('failed durable target write prevents player execution', async () => {
    let executions = 0;
    const context = fixture(scratch(), { virtualDj: { executeCommand: async () => { executions++; } } });
    context.writeFileSync = () => { throw new Error('synthetic disk write failure'); };
    await assert.rejects(context.executeClaimedCommand({ id: 'write-failed', action: 'pause', payload: { deck: 4 }, expiresAt: new Date(Date.now() + 60_000).toISOString() }), /disk write failure/);
    assert.equal(executions, 0);
  });
  test('a deadline crossed during target persistence prevents the late first execution', async () => {
    let executions = 0;
    let currentTime = Date.now();
    const expiresAt = new Date(currentTime + 1_000).toISOString();
    const context = fixture(scratch(), { virtualDj: { executeCommand: async () => { executions++; } } });
    context.Date = class extends Date { static now() { return currentTime; } };
    context.writeFileSync = (...args) => { fs.writeFileSync(...args); currentTime += 2_000; };
    await context.executeClaimedCommand({ id: 'expired-during-save', action: 'pause', payload: { deck: 4 }, expiresAt });
    assert.equal(executions, 0);
    assert.equal(context.ledger.outcomes['expired-during-save'].success, false);
    assert.match(context.ledger.outcomes['expired-during-save'].error, /expired/);
  });
  test('local performer button carries recovered selection and original bridge precondition', async () => {
    let sent;
    const context = fixture(scratch(), { submitReservedPlaybackCommand, cloudRequest: async (_route, { body }) => {
      sent = body;
      return { success: true, command: { id: 'synthetic-server-command', clientCommandId: body.clientCommandId,
        gigId, sourceKey: body.sourceKey, action: body.action, status: 'queued' } };
    } });
    context.activeDeck = context.ledger.targetDeck = 4;
    const start = source.indexOf('async function queuePlaybackAction(');
    vm.runInContext(source.slice(start, source.indexOf('\n}\n', start) + 3), context);
    await context.queuePlaybackAction('pause');
    assert.equal(sent.expectedBridgeInstanceId, context.ledger.bridgeInstanceId);
    assert.equal(sent.payload.deck, 4);
    assert.equal(sent.action, 'pause');
  });
  for (const expiresAt of [undefined, 'not-a-date', new Date(0).toISOString()]) {
    test(`invalid or expired claim (${String(expiresAt)}) never executes or changes the selected deck`, async () => {
      let executions = 0;
      const context = fixture(scratch(), { virtualDj: { executeCommand: async () => { executions++; } } });
      await context.executeClaimedCommand({ id: 'expired-command', action: 'pause', payload: { deck: 4 }, expiresAt });
      assert.equal(executions, 0);
      assert.equal(context.ledger.targetDeck, 1);
      assert.equal(context.ledger.outcomes['expired-command'].success, false);
      assert.match(context.ledger.outcomes['expired-command'].error, /expired/);
    });
  }
}
