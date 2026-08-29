import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import type { SwayDb } from '../src/db/client';
import * as schema from '../src/db/schema';
import { createPlaybackControlStore } from '../src/server/playback-control-store';
import { createPerformerSessionStore } from '../src/server/performer-session-store';

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
    for (const [index, statement] of statements.entries()) {
      try {
        await database.exec(statement);
      } catch (error) {
        throw new Error(`Migration failed: ${migrationFile}, statement ${index + 1}`, { cause: error });
      }
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
    payload: { deck: 1 }
  };
  const concurrent = await Promise.all([
    store.createCommand(input),
    store.createCommand(input)
  ]);
  assert.equal(concurrent.filter((result) => result.replay === false).length, 1);
  assert.equal(concurrent.filter((result) => result.replay === true).length, 1);
  assert.equal(new Set(concurrent.map((result) => result.command.id)).size, 1);

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
  assert.equal(snapshot.state?.connectionStatus, 'disconnected');
  assert.equal(snapshot.state?.fresh, false);

  const currentObservedAt = new Date();
  const currentState = await store.upsertState({
    gigId: ids.gig,
    performerId: ids.performer,
    state: {
      sourceKey: 'virtualdj',
      transport: 'virtualdj_network_control_http',
      bridgeInstanceId: 'bridge-a',
      connectionStatus: 'connected',
      deck: 1,
      trackTitle: 'Current Track',
      playing: true,
      bpmTimes100: 12800,
      observedAt: currentObservedAt
    }
  });
  assert.equal(currentState?.revision, 1);
  const outOfOrder = await store.upsertState({
    gigId: ids.gig,
    performerId: ids.performer,
    state: {
      sourceKey: 'virtualdj',
      transport: 'virtualdj_network_control_http',
      bridgeInstanceId: 'bridge-a',
      connectionStatus: 'connected',
      deck: 1,
      trackTitle: 'Out Of Order Track',
      observedAt: new Date(currentObservedAt.getTime() - 1_000)
    }
  });
  assert.equal(outOfOrder, undefined);
  snapshot = await store.getSnapshot({ gigId: ids.gig });
  assert.equal(snapshot.state?.trackTitle, 'Current Track');
  assert.equal(snapshot.state?.playing, true);
  assert.equal(snapshot.state?.revision, 1);

  console.log('Sway playback control store integration tests passed.');
} finally {
  await database.close();
}
