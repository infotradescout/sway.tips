import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { transpileModule, ScriptTarget, ModuleKind } from 'typescript';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import type { SwayDb } from '../src/db/client';
import * as schema from '../src/db/schema';
import { createPlaybackControlStore } from '../src/server/playback-control-store';
import { playbackCallerIntentText, projectPlaybackCommandReceipt, validatePlaybackCommandInput, type PlaybackCommandPayload } from '../src/playback-control';
import { createPerformerSessionStore } from '../src/server/performer-session-store';
import { VirtualDjNetworkControl } from './lib/virtualdj-network-control.mjs';

const root = process.cwd();
const migrationDirectory = join(root, 'drizzle');
const migrationFiles = readdirSync(migrationDirectory)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();

async function applyAllMigrations(database: PGlite) {
  for (const migrationFile of migrationFiles) {
    const statements = readFileSync(join(migrationDirectory, migrationFile), 'utf8')
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter(Boolean);
    await database.exec('BEGIN');
    try {
      for (const [index, statement] of statements.entries()) {
        try {
          await database.exec(statement);
        } catch (error) {
          throw new Error(`Migration failed: ${migrationFile}, statement ${index + 1}`, { cause: error });
        }
      }
      await database.exec('COMMIT');
    } catch (error) {
      await database.exec('ROLLBACK');
      throw error;
    }
  }
}

const ids = {
  owner: '10000000-0000-4000-8000-000000000071',
  performer: '20000000-0000-4000-8000-000000000071',
  gig: '30000000-0000-4000-8000-000000000071'
} as const;

const database = new PGlite();
try {
  await applyAllMigrations(database);
  const db = drizzle(database, { schema }) as unknown as SwayDb;
  const store = createPlaybackControlStore({ db });

  await db.insert(schema.users).values({
    id: ids.owner,
    email: 'playback-owner@example.test',
    displayName: 'Playback Owner',
    role: 'performer',
    proModeStatus: 'active'
  });
  await db.insert(schema.performers).values({
    id: ids.performer,
    ownerUserId: ids.owner,
    displayName: 'Playback Performer',
    handle: 'playback-performer',
    isActive: true,
    onboardingStatus: 'gig_ready'
  });
  await db.insert(schema.gigSessions).values({
    id: ids.gig,
    performerId: ids.performer,
    ownerActorUserId: ids.owner,
    lastMutationActorUserId: ids.owner,
    status: 'active',
    startedAt: new Date(),
    autoCloseoutAt: new Date(Date.now() + 4 * 60 * 60 * 1_000)
  });

  const sessionStore = createPerformerSessionStore({ dbOverride: db, sessionTtlHours: 12 });
  await assert.rejects(
    () => sessionStore.issueSession({ actorUserId: ids.owner, sessionType: 'control_bridge' }),
    /require an explicit gig scope/
  );
  const browserSession = await sessionStore.issueSession({ actorUserId: ids.owner });
  const bridgeSession = await sessionStore.issueSession({
    actorUserId: ids.owner,
    sessionType: 'control_bridge',
    gigId: ids.gig,
    ttlHours: 6
  });
  const resolvedBridge = await sessionStore.resolveSessionFromToken(bridgeSession.token);
  assert.equal(resolvedBridge?.sessionType, 'control_bridge');
  assert.equal(resolvedBridge?.gigId, ids.gig);
  await sessionStore.revokeActiveSessionsForActorUser({
    actorUserId: ids.owner,
    sessionType: 'control_bridge',
    gigId: ids.gig
  });
  assert.equal(await sessionStore.resolveSessionFromToken(bridgeSession.token), null);
  assert.equal((await sessionStore.resolveSessionFromToken(browserSession.token))?.sessionType, 'browser');

  const input = {
    gigId: ids.gig,
    performerId: ids.performer,
    actorUserId: ids.owner,
    clientCommandId: 'client-command-concurrent-1',
    sourceKey: 'virtualdj' as const,
    action: 'play' as const,
    payload: { deck: 1, targetBridgeInstanceId: 'bridge-a' },
    callerIntentFingerprint: 'intent-play-deck-1'
  };
  const receipt = projectPlaybackCommandReceipt({
    id: '40000000-0000-4000-8000-000000000071',
    ...input,
    status: 'queued',
    createdAt: new Date(),
    updatedAt: new Date()
  });
  assert.equal((receipt as Record<string, unknown>).payload, undefined, 'POST receipts must omit resolved booth payloads');
  assert.equal(receipt.clientCommandId, input.clientCommandId, 'POST receipts correlate the caller identity without exposing booth payloads');
  const concurrent = await Promise.all([
    store.createCommand(input),
    store.createCommand(input)
  ]);
  assert.equal(concurrent.filter((result) => result.replay === false).length, 1);
  assert.equal(concurrent.filter((result) => result.replay === true).length, 1);
  assert.equal(new Set(concurrent.map((result) => result.command.id)).size, 1);
  const recovered = await store.getCommandReplay({
    gigId: ids.gig,
    clientCommandId: input.clientCommandId,
    sourceKey: 'virtualdj',
    action: 'play',
    callerIntentFingerprint: input.callerIntentFingerprint
  });
  assert.equal(recovered?.id, concurrent[0].command.id, 'same intent recovers independently of current target state');
  await assert.rejects(
    () => store.getCommandReplay({
      gigId: ids.gig,
      clientCommandId: input.clientCommandId,
      sourceKey: 'virtualdj',
      action: 'play',
      callerIntentFingerprint: 'changed-deck-or-track-intent'
    }),
    /different playback command/
  );
  assert.equal((await db.select().from(schema.playbackCommands).where(eq(schema.playbackCommands.clientCommandId, input.clientCommandId))).length, 1);

  await assert.rejects(
    () => store.createCommand({ ...input, action: 'pause' }),
    /already used for a different playback command/
  );

  const claimedA = await store.claimCommands({
    gigId: ids.gig,
    sourceKey: 'virtualdj',
    bridgeInstanceId: 'bridge-a'
  });
  assert.equal(claimedA.length, 1);
  const claimedB = await store.claimCommands({
    gigId: ids.gig,
    sourceKey: 'virtualdj',
    bridgeInstanceId: 'bridge-b'
  });
  assert.equal(claimedB.length, 0, 'an active lease must fence a second bridge');

  const wrongBridge = await store.completeCommand({
    gigId: ids.gig,
    sourceKey: 'virtualdj',
    bridgeInstanceId: 'bridge-b',
    commandId: claimedA[0].id,
    success: true
  });
  assert.equal(wrongBridge, null);
  const completed = await store.completeCommand({
    gigId: ids.gig,
    sourceKey: 'virtualdj',
    bridgeInstanceId: 'bridge-a',
    commandId: claimedA[0].id,
    success: true,
    result: { executedAt: new Date().toISOString() }
  });
  assert.equal(completed?.command.status, 'succeeded');
  assert.equal(completed?.replay, false);
  const completionReplay = await store.completeCommand({
    gigId: ids.gig,
    sourceKey: 'virtualdj',
    bridgeInstanceId: 'bridge-a',
    commandId: claimedA[0].id,
    success: true
  });
  assert.equal(completionReplay?.replay, true);

  const uncertain = await store.createCommand({
    ...input,
    clientCommandId: 'client-command-uncertain-1',
    action: 'next'
  });
  const [uncertainClaim] = await store.claimCommands({
    gigId: ids.gig,
    sourceKey: 'virtualdj',
    bridgeInstanceId: 'bridge-a'
  });
  assert.equal(uncertainClaim.id, uncertain.command.id);
  await db
    .update(schema.playbackCommands)
    .set({ claimExpiresAt: new Date(Date.now() - 1_000) })
    .where(eq(schema.playbackCommands.id, uncertain.command.id));
  assert.equal((await store.claimCommands({
    gigId: ids.gig,
    sourceKey: 'virtualdj',
    bridgeInstanceId: 'bridge-b'
  })).length, 0, 'a different bridge must never replay a command after acknowledgement was lost');
  assert.equal((await store.claimCommands({
    gigId: ids.gig,
    sourceKey: 'virtualdj',
    bridgeInstanceId: 'bridge-a'
  })).length, 0, 'the same bridge must use its ledger completion rather than execute again');
  let uncertainSnapshot = await store.getSnapshot({ gigId: ids.gig });
  const uncertainRow = uncertainSnapshot.commands.find((command) => command.id === uncertain.command.id);
  assert.equal(uncertainRow?.status, 'expired');
  assert.match(uncertainRow?.errorText || '', /outcome is uncertain/i);

  const late = await store.createCommand({
    ...input,
    clientCommandId: 'client-command-late-1',
    action: 'cue'
  });
  const [lateClaim] = await store.claimCommands({
    gigId: ids.gig,
    sourceKey: 'virtualdj',
    bridgeInstanceId: 'bridge-a'
  });
  assert.equal(lateClaim.id, late.command.id);
  await db
    .update(schema.playbackCommands)
    .set({ expiresAt: new Date(Date.now() - 1_000) })
    .where(eq(schema.playbackCommands.id, late.command.id));
  let snapshot = await store.getSnapshot({ gigId: ids.gig });
  assert.equal(snapshot.commands.find((command) => command.id === late.command.id)?.status, 'expired');
  const lateCompletion = await store.completeCommand({
    gigId: ids.gig,
    sourceKey: 'virtualdj',
    bridgeInstanceId: 'bridge-a',
    commandId: late.command.id,
    success: true,
    result: { executedAt: new Date().toISOString(), delivery: 'late_ack' }
  });
  assert.equal(lateCompletion?.command.status, 'succeeded', 'a locally executed command must survive a delayed cloud acknowledgement');

  const privatePath = 'C:/Users/performer/private-library/secret-track.mp3';
  const rejected = await store.createCommand({
    ...input,
    clientCommandId: 'client-command-rejected-1',
    action: 'load',
    payload: {
      deck: 1,
      targetBridgeInstanceId: 'bridge-a',
      track: { path: privatePath, title: 'Secret Track' }
    },
    callerIntentFingerprint: 'intent-load-secret-track-deck-1'
  });
  const [rejectedClaim] = await store.claimCommands({
    gigId: ids.gig,
    sourceKey: 'virtualdj',
    bridgeInstanceId: 'bridge-a'
  });
  assert.equal(rejectedClaim.id, rejected.command.id);
  await store.completeCommand({
    gigId: ids.gig,
    sourceKey: 'virtualdj',
    bridgeInstanceId: 'bridge-a',
    commandId: rejected.command.id,
    success: false,
    errorText: `VirtualDJ rejected: deck 1 load "${privatePath}"`
  });
  const rejectedSnapshot = await store.getSnapshot({ gigId: ids.gig });
  const publicRejected = rejectedSnapshot.commands.find((command) => command.id === rejected.command.id);
  assert.equal(publicRejected?.errorText, 'Source could not complete the command.');
  assert.equal(JSON.stringify(publicRejected).includes(privatePath), false, 'bridge errors must not expose booth-local paths');

  const timedOut = await store.createCommand({
    ...input,
    clientCommandId: 'client-command-adapter-timeout',
    action: 'load',
    payload: { deck: 1, targetBridgeInstanceId: 'bridge-a', track: { path: privatePath } },
    callerIntentFingerprint: 'intent-load-adapter-timeout'
  });
  const [timedOutClaim] = await store.claimCommands({
    gigId: ids.gig, sourceKey: 'virtualdj', bridgeInstanceId: 'bridge-a'
  });
  assert.equal(timedOutClaim.id, timedOut.command.id);
  let timeoutRequests = 0;
  const privateBridgePassword = 'synthetic-private-bridge-password';
  const timeoutAdapter = new VirtualDjNetworkControl({
    requestTimeoutMs: 1_000,
    password: privateBridgePassword,
    fetchImpl: () => { timeoutRequests += 1; return new Promise<Response>(() => {}); }
  });
  const timeoutError = await timeoutAdapter.executeCommand(timedOutClaim).then(
    () => { throw new Error('Expected the unresolved adapter request to time out.'); },
    (error: unknown) => { assert.ok(error instanceof Error); return error; }
  );
  assert.equal(timeoutError.message,
    'VirtualDJ command response timed out. The command may have reached your deck. Check playback before sending another command.');
  assert.equal(timeoutRequests, 1, 'a hard timeout does not retry the mutating request');
  const timeoutCompletion = await store.completeCommand({
    gigId: ids.gig, sourceKey: 'virtualdj', bridgeInstanceId: 'bridge-a',
    commandId: timedOutClaim.id, success: false, errorText: timeoutError.message
  });
  const safeTimeoutWarning = 'Source acknowledgement was lost; playback outcome is uncertain. Check the selected deck before sending another command.';
  assert.equal(timeoutCompletion?.command.status, 'failed');
  const [persistedTimeout] = await db.select().from(schema.playbackCommands)
    .where(eq(schema.playbackCommands.id, timedOutClaim.id));
  assert.equal(persistedTimeout.errorText, safeTimeoutWarning, 'actual adapter timeout persists a safe uncertain outcome');
  const publicTimeout = (await store.getSnapshot({ gigId: ids.gig })).commands.find(command => command.id === timedOutClaim.id);
  assert.equal(publicTimeout?.errorText, safeTimeoutWarning, 'the operator snapshot retains the check-selected-deck guidance');
  for (const privateDetail of [privatePath, privateBridgePassword, `deck 1 load "${privatePath}"`]) {
    assert.equal(JSON.stringify(publicTimeout).includes(privateDetail), false, 'public timeout receipt cannot expose booth paths, tokens or scripts');
  }

  const staleObservedAt = new Date(Date.now() - 60_000);
  await store.upsertState({
    gigId: ids.gig,
    performerId: ids.performer,
    state: {
      sourceKey: 'virtualdj',
      transport: 'virtualdj_network_control_http',
      bridgeInstanceId: 'bridge-a',
      connectionStatus: 'connected',
      deck: 1,
      trackTitle: 'Stale Track',
      observedAt: staleObservedAt
    }
  });
  snapshot = await store.getSnapshot({ gigId: ids.gig });
  assert.equal(snapshot.state?.connectionStatus, 'connected');
  assert.equal(snapshot.state?.fresh, true, 'freshness follows server receipt rather than the bridge clock');

  const currentObservedAt = new Date('2099-01-01T00:00:00.000Z');
  const currentState = await store.upsertState({
    gigId: ids.gig,
    performerId: ids.performer,
    state: {
      sourceKey: 'virtualdj',
      transport: 'virtualdj_network_control_http',
      bridgeInstanceId: 'bridge-a',
      connectionStatus: 'connected',
      deck: 1,
      trackTitle: 'Future Clock Track',
      playing: true,
      bpmTimes100: 12800,
      observedAt: currentObservedAt
    }
  });
  assert.equal(currentState?.revision, 1);
  assert.ok(Math.abs((currentState?.observedAt?.getTime() ?? 0) - Date.now()) < 5_000, 'server receipt time owns freshness');
  const takeover = await store.upsertState({
    gigId: ids.gig,
    performerId: ids.performer,
    state: {
      sourceKey: 'virtualdj',
      transport: 'virtualdj_network_control_http',
      bridgeInstanceId: 'bridge-b',
      connectionStatus: 'disconnected',
      deck: 2,
      trackTitle: null,
      observedAt: new Date()
    }
  });
  assert.equal(takeover?.revision, 2, 'a later server receipt must replace a future bridge clock');
  snapshot = await store.getSnapshot({ gigId: ids.gig });
  assert.equal(snapshot.state?.bridgeInstanceId, 'bridge-b');
  assert.equal(snapshot.state?.connectionStatus, 'disconnected');
  assert.equal(snapshot.state?.revision, 2);
  assert.equal((snapshot.state as Record<string, unknown>).trackPath, undefined, 'booth-local paths must not reach browser snapshots');
  assert.equal((snapshot.state as Record<string, unknown>).metadata, undefined, 'bridge connection details must not reach browser snapshots');
  assert.equal((snapshot.commands[0] as Record<string, unknown>).payload, undefined, 'resolved command paths must not reach browser snapshots');
  assert.equal(await store.getCurrentTarget({ gigId: ids.gig, sourceKey: 'virtualdj' }), null);

  await store.upsertState({
    gigId: ids.gig,
    performerId: ids.performer,
    state: {
      sourceKey: 'virtualdj', transport: 'virtualdj_network_control_http', bridgeInstanceId: 'bridge-c',
      connectionStatus: 'connected', deck: 2, observedAt: new Date()
    }
  });
  const claimedAcrossReplacement = await store.createCommand({
    ...input, clientCommandId: 'replacement-claimed-next', action: 'next',
    payload: { deck: 2, targetBridgeInstanceId: 'bridge-c' }, callerIntentFingerprint: 'intent-next-deck-2'
  });
  const [replacementClaim] = await store.claimCommands({ gigId: ids.gig, sourceKey: 'virtualdj', bridgeInstanceId: 'bridge-c', limit: 1 });
  assert.equal(replacementClaim.id, claimedAcrossReplacement.command.id);
  const queuedAcrossReplacement = await store.createCommand({
    ...input, clientCommandId: 'replacement-queued-next', action: 'next',
    payload: { deck: 2, targetBridgeInstanceId: 'bridge-c' }, callerIntentFingerprint: 'intent-next-deck-2-later'
  });
  const invalidated = await db.transaction((tx) => store.replaceConnectionGeneration({
    gigId: ids.gig, sourceKey: 'virtualdj', executor: tx
  }));
  assert.deepEqual(invalidated, { disconnected: 1, queued: 1, claimed: 1 });
  const replacementSnapshot = await store.getSnapshot({ gigId: ids.gig });
  assert.equal(replacementSnapshot.state?.connectionStatus, 'disconnected');
  assert.match(replacementSnapshot.commands.find(row => row.id === replacementClaim.id)?.errorText ?? '', /outcome is uncertain/i);
  assert.match(replacementSnapshot.commands.find(row => row.id === queuedAcrossReplacement.command.id)?.errorText ?? '', /not sent/i);
  assert.equal((await store.claimCommands({ gigId: ids.gig, sourceKey: 'virtualdj', bridgeInstanceId: 'bridge-new' })).length, 0);

  const wrongDeck = await store.createCommand({
    ...input, clientCommandId: 'wrong-deck-exact-load', action: 'load',
    payload: { deck: 2, targetBridgeInstanceId: 'bridge-new', track: { path: 'C:/Music/Exact.mp3' } },
    callerIntentFingerprint: 'intent-exact-load-deck-2'
  });
  const [wrongDeckClaim] = await store.claimCommands({ gigId: ids.gig, sourceKey: 'virtualdj', bridgeInstanceId: 'bridge-new' });
  assert.equal(wrongDeckClaim.id, wrongDeck.command.id);
  await store.completeCommand({
    gigId: ids.gig, sourceKey: 'virtualdj', bridgeInstanceId: 'bridge-new', commandId: wrongDeck.command.id, success: true,
    result: {
      acknowledgement: 'accepted', confirmationStatus: 'exact_track_confirmed', loadMatchMode: 'exact_library_path',
      observedDeck: 1, observedPlaying: 'not-a-boolean', observedAt: '2099-01-01T00:00:00.000Z',
      observedTrackTitle: { malformed: true }
    }
  });
  const wrongDeckSnapshot = await store.getSnapshot({ gigId: ids.gig });
  const wrongDeckResult = wrongDeckSnapshot.commands.find(row => row.id === wrongDeck.command.id)?.result;
  assert.equal(wrongDeckResult?.confirmationStatus, 'source_acknowledged', 'wrong-deck evidence cannot confirm a command');
  assert.equal(wrongDeckResult?.observedAt, null, 'future evidence time is discarded safely');
  assert.equal(wrongDeckResult?.observedTrackTitle, null, 'malformed evidence fields become null');

  for (const [action, expected] of [['stop', 'source_acknowledged'], ['pause', 'source_state_confirmed']] as const) {
    const created = await store.createCommand({
      ...input, clientCommandId: `truth-${action}`, action,
      payload: { deck: 2, targetBridgeInstanceId: 'bridge-new' }, callerIntentFingerprint: `intent-${action}-deck-2`
    });
    const [claimed] = await store.claimCommands({ gigId: ids.gig, sourceKey: 'virtualdj', bridgeInstanceId: 'bridge-new', limit: 1 });
    assert.equal(claimed.id, created.command.id);
    await store.completeCommand({
      gigId: ids.gig, sourceKey: 'virtualdj', bridgeInstanceId: 'bridge-new', commandId: created.command.id, success: true,
      result: {
        acknowledgement: 'accepted', confirmationStatus: 'source_state_confirmed', observedDeck: 2,
        observedPlaying: false, observedAt: new Date().toISOString()
      }
    });
    const command = (await store.getSnapshot({ gigId: ids.gig })).commands.find(row => row.id === created.command.id);
    assert.equal(command?.result.confirmationStatus, expected, `${action} evidence must use the closed action-specific truth rule`);
  }

  for (const [suffix, result] of [
    ['missing-acknowledgement', {
      acknowledgement: 'not-accepted', confirmationStatus: 'source_state_confirmed', observedDeck: 2,
      observedPlaying: true, observedAt: new Date().toISOString()
    }],
    ['invalid-observation-time', {
      acknowledgement: 'accepted', confirmationStatus: 'source_state_confirmed', observedDeck: 2,
      observedPlaying: true, observedAt: '2099-01-01T00:00:00.000Z'
    }]
  ] as const) {
    const created = await store.createCommand({
      ...input, clientCommandId: `truth-play-${suffix}`, action: 'play',
      payload: { deck: 2, targetBridgeInstanceId: 'bridge-new' }, callerIntentFingerprint: `intent-play-${suffix}`
    });
    const [claimed] = await store.claimCommands({
      gigId: ids.gig, sourceKey: 'virtualdj', bridgeInstanceId: 'bridge-new', limit: 1
    });
    assert.equal(claimed.id, created.command.id);
    await store.completeCommand({
      gigId: ids.gig, sourceKey: 'virtualdj', bridgeInstanceId: 'bridge-new', commandId: created.command.id,
      success: true, result
    });
    const command = (await store.getSnapshot({ gigId: ids.gig })).commands.find(row => row.id === created.command.id);
    assert.equal(command?.result.confirmationStatus, 'source_acknowledged',
      'unaccepted or unbounded evidence cannot promote a command to source-state confirmation');
  }

  const evidenceCases = [
    { action: 'load', staleMs: 5 * 60_000, confirmed: 'exact_track_confirmed', playing: null, loadMatchMode: 'exact_library_path' },
    { action: 'play', staleMs: 60 * 60_000, confirmed: 'source_state_confirmed', playing: true, loadMatchMode: null },
    { action: 'pause', staleMs: 23 * 60 * 60_000, confirmed: 'source_state_confirmed', playing: false, loadMatchMode: null }
  ] as const;
  for (const evidenceCase of evidenceCases) {
    const stale = await store.createCommand({
      ...input, clientCommandId: `stale-before-claim-${evidenceCase.action}`, action: evidenceCase.action,
      payload: {
        deck: 2, targetBridgeInstanceId: 'bridge-new',
        ...(evidenceCase.action === 'load' ? { track: { path: 'C:/Music/Exact.mp3' } } : {})
      },
      callerIntentFingerprint: `intent-stale-before-claim-${evidenceCase.action}`
    });
    const [staleClaim] = await store.claimCommands({
      gigId: ids.gig, sourceKey: 'virtualdj', bridgeInstanceId: 'bridge-new', limit: 1
    });
    assert.equal(staleClaim.id, stale.command.id);
    const staleObservedAt = new Date(staleClaim.claimedAt.getTime() - evidenceCase.staleMs).toISOString();
    await store.completeCommand({
      gigId: ids.gig, sourceKey: 'virtualdj', bridgeInstanceId: 'bridge-new', commandId: stale.command.id,
      success: true,
      result: {
        acknowledgement: 'accepted', confirmationStatus: evidenceCase.confirmed, observedDeck: 2,
        observedPlaying: evidenceCase.playing, observedAt: staleObservedAt, loadMatchMode: evidenceCase.loadMatchMode
      }
    });
    const staleResult = (await store.getSnapshot({ gigId: ids.gig })).commands.find(row => row.id === stale.command.id)?.result;
    assert.equal(staleResult?.confirmationStatus, 'source_acknowledged',
      `${evidenceCase.action} evidence from before the server claim cannot confirm the new command`);
    assert.equal(staleResult?.observedAt, null);

    const current = await store.createCommand({
      ...input, clientCommandId: `current-evidence-${evidenceCase.action}`, action: evidenceCase.action,
      payload: {
        deck: 2, targetBridgeInstanceId: 'bridge-new',
        ...(evidenceCase.action === 'load' ? { track: { path: 'C:/Music/Exact.mp3' } } : {})
      },
      callerIntentFingerprint: `intent-current-evidence-${evidenceCase.action}`
    });
    const [currentClaim] = await store.claimCommands({
      gigId: ids.gig, sourceKey: 'virtualdj', bridgeInstanceId: 'bridge-new', limit: 1
    });
    assert.equal(currentClaim.id, current.command.id);
    await store.completeCommand({
      gigId: ids.gig, sourceKey: 'virtualdj', bridgeInstanceId: 'bridge-new', commandId: current.command.id,
      success: true,
      result: {
        acknowledgement: 'accepted', confirmationStatus: evidenceCase.confirmed, observedDeck: 2,
        observedPlaying: evidenceCase.playing, observedAt: currentClaim.claimedAt.toISOString(),
        loadMatchMode: evidenceCase.loadMatchMode
      }
    });
    const currentResult = (await store.getSnapshot({ gigId: ids.gig })).commands.find(row => row.id === current.command.id)?.result;
    assert.equal(currentResult?.confirmationStatus, evidenceCase.confirmed,
      `current matching ${evidenceCase.action} evidence confirms within the server-owned window`);
  }

  const future = await store.createCommand({
    ...input, clientCommandId: 'future-after-completion-play', action: 'play',
    payload: { deck: 2, targetBridgeInstanceId: 'bridge-new' }, callerIntentFingerprint: 'intent-future-play'
  });
  const [futureClaim] = await store.claimCommands({
    gigId: ids.gig, sourceKey: 'virtualdj', bridgeInstanceId: 'bridge-new', limit: 1
  });
  assert.equal(futureClaim.id, future.command.id);
  await store.completeCommand({
    gigId: ids.gig, sourceKey: 'virtualdj', bridgeInstanceId: 'bridge-new', commandId: future.command.id,
    success: true,
    result: {
      acknowledgement: 'accepted', confirmationStatus: 'source_state_confirmed', observedDeck: 2,
      observedPlaying: true, observedAt: new Date(Date.now() + 10_000).toISOString()
    }
  });
  const futureResult = (await store.getSnapshot({ gigId: ids.gig })).commands.find(row => row.id === future.command.id)?.result;
  assert.equal(futureResult?.confirmationStatus, 'source_acknowledged', 'evidence over five seconds past receipt cannot confirm');
  assert.equal(futureResult?.observedAt, null);

  const delayed = await store.createCommand({
    ...input, clientCommandId: 'delayed-restart-pause', action: 'pause',
    payload: { deck: 2, targetBridgeInstanceId: 'bridge-new' }, callerIntentFingerprint: 'intent-delayed-restart-pause'
  });
  const [delayedClaim] = await store.claimCommands({
    gigId: ids.gig, sourceKey: 'virtualdj', bridgeInstanceId: 'bridge-new', limit: 1
  });
  assert.equal(delayedClaim.id, delayed.command.id);
  const recoveredClaimAt = new Date(Date.now() - 26 * 60 * 60_000);
  const recoveredObservationAt = new Date(Date.now() - 25 * 60 * 60_000);
  await db.update(schema.playbackCommands).set({ claimedAt: recoveredClaimAt }).where(eq(schema.playbackCommands.id, delayed.command.id));
  await store.completeCommand({
    gigId: ids.gig, sourceKey: 'virtualdj', bridgeInstanceId: 'bridge-new', commandId: delayed.command.id,
    success: true,
    result: {
      acknowledgement: 'accepted', confirmationStatus: 'source_state_confirmed', observedDeck: 2,
      observedPlaying: false, observedAt: recoveredObservationAt.toISOString()
    }
  });
  const delayedCompletion = (await store.getSnapshot({ gigId: ids.gig })).commands.find(row => row.id === delayed.command.id)?.result;
  assert.equal(delayedCompletion?.confirmationStatus, 'source_state_confirmed',
    'a restart-delayed completion remains valid when its observation followed the claim');
  const laterSnapshot = await store.getSnapshot({ gigId: ids.gig });
  assert.equal(laterSnapshot.commands.find(row => row.id === delayed.command.id)?.result.confirmationStatus, 'source_state_confirmed',
    'historical confirmation is retained against its persisted completion boundary, not re-aged against wall time');

  // Execute the production POST handler against the migrated database. Only
  // authentication, audit writing and unrelated load resolution are fixtures.
  const serverSource = readFileSync(join(root, 'server.ts'), 'utf8');
  const commandRouteSource = serverSource.slice(
    serverSource.indexOf("app.post('/api/talent/playback/commands'"),
    serverSource.indexOf("app.get('/api/talent/playback/snapshot/:gigId'")
  );
  assert.ok(commandRouteSource.length > 0);
  let commandHandler: (req: any, res: any) => Promise<unknown>;
  let mutationChecks = 0;
  const dependencies = {
    app: { post(path: string, handler: typeof commandHandler) {
      assert.equal(path, '/api/talent/playback/commands'); commandHandler = handler;
    } },
    applyNoStoreHeaders: () => {},
    parseDurableGigId: (value: unknown) => value === ids.gig ? value : null,
    businessDb: db,
    playbackControlStore: store,
    accessControl: { async requireGigMutationAccess(_req: unknown, gigId: string, options: unknown) {
      mutationChecks += 1;
      assert.equal(gigId, ids.gig);
      assert.deepEqual(options, { allowControlBridge: true });
      return { allowed: true, role: 'performer', actor: { actorId: ids.owner, sessionType: 'browser' } };
    } },
    validatePlaybackCommandInput, gigSessions: schema.gigSessions, eq,
    createHash, playbackCallerIntentText, projectPlaybackCommandReceipt,
    resolvePlaybackCommandPayload: async ({ payload }: { payload: unknown }) => payload,
    writeAuditEvent: async () => {}
  };
  const compiled = transpileModule(commandRouteSource, {
    compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.None }
  }).outputText;
  new Function(...Object.keys(dependencies), compiled)(...Object.values(dependencies));
  async function submit(body: Record<string, unknown>) {
    let status = 200;
    let result: any;
    const res = { status(value: number) { status = value; return this; }, json(value: unknown) { result = value; return this; } };
    await commandHandler!({ body: { gig_id: ids.gig, sourceKey: 'virtualdj', action: 'play', payload: { deck: 1 }, ...body } }, res);
    return { status, body: result };
  }
  const connect = (bridgeInstanceId: string) => store.upsertState({
    gigId: ids.gig, performerId: ids.performer,
    state: { sourceKey: 'virtualdj', transport: 'virtualdj_network_control_http', bridgeInstanceId,
      connectionStatus: 'connected', deck: 1, observedAt: new Date() }
  });
  await connect('observed-player-a');
  const acceptedOriginal = await submit({
    clientCommandId: 'observed-original-play', expectedBridgeInstanceId: 'observed-player-a',
    payload: { deck: 1, targetBridgeInstanceId: 'caller-selected-player' }
  });
  assert.equal(acceptedOriginal.status, 202, 'the observed current connection permits a new command');
  const [originalPersisted] = await db.select().from(schema.playbackCommands)
    .where(eq(schema.playbackCommands.clientCommandId, 'observed-original-play'));
  const originalPayload = originalPersisted.payload as PlaybackCommandPayload;
  assert.equal(originalPayload.targetBridgeInstanceId, 'observed-player-a',
    'caller payload cannot override the authoritative current player');
  const countBeforeRejected = (await db.select().from(schema.playbackCommands)).length;
  await connect('replacement-player-b');
  for (const [suffix, expectedBridgeInstanceId] of [
    ['stale', 'observed-player-a'], ['missing', undefined], ['blank', ''],
    ['object', { bridgeInstanceId: 'replacement-player-b' }], ['untrusted-device', 'caller-selected-player']
  ] as const) {
    const rejectedNew = await submit({ clientCommandId: `observed-rejected-${suffix}`, expectedBridgeInstanceId,
      payload: { deck: 1, targetBridgeInstanceId: 'replacement-player-b' } });
    assert.equal(rejectedNew.status, 409, `${suffix} connection precondition rejects a new command`);
    assert.equal(rejectedNew.body.code, 'playback_connection_changed');
    assert.match(rejectedNew.body.error, /Player connection changed\. Refresh playback status/);
    assert.equal((await db.select().from(schema.playbackCommands)).length, countBeforeRejected,
      'a rejected request must queue zero new commands');
  }
  for (const expectedBridgeInstanceId of ['observed-player-a', 'replacement-player-b', undefined]) {
    const originalReplay = await submit({ clientCommandId: 'observed-original-play', expectedBridgeInstanceId });
    assert.equal(originalReplay.status, 200);
    assert.equal(originalReplay.body.replay, true);
    assert.deepEqual(originalReplay.body.command, acceptedOriginal.body.command,
      'same-id replay returns only the original receipt after replacement');
    assert.equal(originalReplay.body.command.payload, undefined);
  }
  const conflictingReplay = await submit({ clientCommandId: 'observed-original-play', expectedBridgeInstanceId: 'replacement-player-b', payload: { deck: 2 } });
  assert.equal(conflictingReplay.status, 409, 'reusing an identity for a different intent cannot create or retarget a command');
  assert.match(conflictingReplay.body.error, /different playback command/);
  await db.update(schema.playbackStates).set({ observedAt: new Date(Date.now() - 60_000) }).where(eq(schema.playbackStates.gigId, ids.gig));
  assert.equal((await submit({ clientCommandId: 'stale-authoritative-state', expectedBridgeInstanceId: 'replacement-player-b' })).status, 409,
    'a matching identity still requires fresh authoritative source state');
  await connect('replacement-player-b');
  await db.update(schema.playbackStates).set({ bridgeInstanceId: '' }).where(eq(schema.playbackStates.gigId, ids.gig));
  assert.equal((await submit({ clientCommandId: 'missing-authoritative-identity', expectedBridgeInstanceId: 'replacement-player-b' })).status, 409,
    'new commands fail closed if the authoritative state has no identity');
  await db.update(schema.playbackStates).set({ connectionStatus: 'disconnected' }).where(eq(schema.playbackStates.gigId, ids.gig));
  const offlineReplay = await submit({ clientCommandId: 'observed-original-play' });
  assert.equal(offlineReplay.status, 200, 'original receipt recovery does not require any current player');
  assert.deepEqual(offlineReplay.body.command, acceptedOriginal.body.command);
  assert.equal((await db.select().from(schema.playbackCommands)).length, countBeforeRejected);
  const [replayedPersisted] = await db.select().from(schema.playbackCommands)
    .where(eq(schema.playbackCommands.clientCommandId, 'observed-original-play'));
  const replayedPayload = replayedPersisted.payload as PlaybackCommandPayload;
  assert.equal(replayedPayload.targetBridgeInstanceId, 'observed-player-a',
    'replay never retargets the original command');
  assert.equal(mutationChecks, 13, 'all POST attempts still pass through the mutation access guard');

  console.log('Sway playback control store integration tests passed, including production POST connection preconditions and original receipt replay.');
} finally {
  await database.close();
}
