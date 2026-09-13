import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { createSwayDb } from '../src/db/client';
import { performers, users, performerLibrarySources, performerLibraryTracks } from '../src/db/schema';
import { prepareSpotifyPlaylistSource, SpotifyPlaylistSourceConflict } from '../src/server/spotify-playlist-store';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof';

const proof = await startEmbeddedPostgresProof('spotify_source_replacement');
const db = createSwayDb(proof.databaseUrl);
const actorId = '11000000-0000-4000-8000-000000000171';
const nextOwnerId = '11000000-0000-4000-8000-000000000172';
const performerId = '21000000-0000-4000-8000-000000000171';
const sourceKey = 'spotify-37i9dQZF1DXcBWIGoYBM5M';
const baseTime = new Date('2026-09-13T12:00:00.123Z');
let writes = 0;
let checks = 0;

async function source(key = sourceKey) {
  const [row] = await db.select().from(performerLibrarySources).where(and(
    eq(performerLibrarySources.performerId, performerId), eq(performerLibrarySources.sourceKey, key)
  ));
  return row;
}
function expectation(row: Awaited<ReturnType<typeof source>>) {
  return { id: row.id, updatedAt: row.updatedAt.toISOString() };
}
async function tracks(key = sourceKey) {
  return db.select({ title: performerLibraryTracks.title }).from(performerLibraryTracks).where(and(
    eq(performerLibraryTracks.performerId, performerId), eq(performerLibraryTracks.sourceKey, key)
  ));
}
async function replace(expectedSource: unknown, title: string, overrides: {
  actorId?: string; sourceKey?: string; failAfterTracks?: boolean; now?: Date;
} = {}) {
  const key = overrides.sourceKey ?? sourceKey;
  return db.transaction(async (tx) => {
    const receipt = await prepareSpotifyPlaylistSource(tx, {
      actorId: overrides.actorId ?? actorId, performerId, sourceKey: key,
      sourceLabel: 'Spotify: replacement proof', expectedSource,
      generatedSyncKeyHash: createHash('sha256').update(randomUUID()).digest('hex'),
      now: overrides.now ?? baseTime
    });
    writes += 1;
    await tx.delete(performerLibraryTracks).where(and(
      eq(performerLibraryTracks.performerId, performerId), eq(performerLibraryTracks.sourceKey, key)
    ));
    await tx.insert(performerLibraryTracks).values({ performerId, sourceKey: key,
      sourceLabel: 'Spotify: replacement proof', externalTrackId: 'spotify:track-proof',
      title, artist: 'Proof Artist', searchableText: title.toLowerCase() });
    if (overrides.failAfterTracks) throw new Error('synthetic track persistence failure');
    return receipt;
  });
}
async function mustRejectBeforeTracks(run: () => Promise<unknown>, status: 403 | 409, code: string) {
  const before = writes;
  await assert.rejects(run, (error: unknown) => error instanceof SpotifyPlaylistSourceConflict
    && error.status === status && error.code === code);
  assert.equal(writes, before, 'A failed guard must reject before track mutation.');
  checks += 1;
}

try {
  await db.insert(users).values([
    { id: actorId, email: 'spotify-source-owner@example.test', displayName: 'Source Owner' },
    { id: nextOwnerId, email: 'spotify-source-next-owner@example.test', displayName: 'Next Owner' }
  ]);
  await db.insert(performers).values({ id: performerId, ownerUserId: actorId,
    displayName: 'Source Performer', handle: 'spotify-source-proof' });

  const first = await replace(null, 'Original saved song');
  const initial = await source();
  assert.equal(first.id, initial.id);
  assert.equal(initial.updatedAt.toISOString(), baseTime.toISOString());
  assert.deepEqual(initial.metadata, { sourceProvider: 'spotify', playlistId: sourceKey.slice(8), importMode: 'metadata_only' });
  assert.equal(initial.syncKeyPreview, 'spotify-import');
  const initialExpectation = expectation(initial);

  // A second request that also observed absence must conflict, not replace.
  await mustRejectBeforeTracks(() => replace(null, 'Competing new import'), 409, 'spotify_source_changed');
  assert.deepEqual(await tracks(), [{ title: 'Original saved song' }]);

  await replace(initialExpectation, 'Updated saved song');
  const updated = await source();
  assert.equal(updated.id, initial.id);
  assert.equal(updated.updatedAt.getTime(), initial.updatedAt.getTime() + 1,
    'Same-millisecond replacement must still advance its browser-visible version.');
  assert.equal(updated.syncKeyHash, initial.syncKeyHash, 'Replacement preserves the existing source credential.');
  await mustRejectBeforeTracks(() => replace(initialExpectation, 'Stale overwrite'), 409, 'spotify_source_changed');
  assert.deepEqual(await tracks(), [{ title: 'Updated saved song' }]);

  for (const malformed of [undefined, {}, [], 'absent', { id: 'not-a-uuid', updatedAt: baseTime.toISOString() },
    { id: updated.id, updatedAt: 'invalid-date' }, { id: updated.id, updatedAt: '2026-02-30T12:00:00.000Z' },
    { id: updated.id }, { updatedAt: baseTime.toISOString() }]) {
    await mustRejectBeforeTracks(() => replace(malformed, 'Malformed overwrite'), 409, 'spotify_source_invalid_expectation');
  }
  await mustRejectBeforeTracks(() => replace({ id: randomUUID(), updatedAt: updated.updatedAt.toISOString() }, 'Different source identity'),
    409, 'spotify_source_changed');

  // A downstream failure rolls back both source version and track replacement.
  await assert.rejects(replace(expectation(updated), 'Rolled-back song', { failAfterTracks: true }), /synthetic track persistence failure/);
  assert.equal((await source()).updatedAt.toISOString(), updated.updatedAt.toISOString());
  assert.deepEqual(await tracks(), [{ title: 'Updated saved song' }]);

  const collisionKey = 'spotify-7qiZfU4dY1lWllzX7mPBI3';
  await replace(null, 'Original other-source song', { sourceKey: collisionKey });
  await db.update(performerLibrarySources).set({ syncKeyPreview: 'sync-helper', metadata: { sourceProvider: 'spotify' } })
    .where(eq(performerLibrarySources.sourceKey, collisionKey));
  const collision = await source(collisionKey);
  await mustRejectBeforeTracks(() => replace(expectation(collision), 'Collision overwrite', { sourceKey: collisionKey }), 409, 'spotify_source_identity_conflict');

  await db.update(performerLibrarySources).set({ syncKeyPreview: 'spotify-import', metadata: { sourceProvider: 'external' } })
    .where(eq(performerLibrarySources.sourceKey, collisionKey));
  const mislabeled = await source(collisionKey);
  await mustRejectBeforeTracks(() => replace(expectation(mislabeled), 'Metadata collision overwrite', { sourceKey: collisionKey }), 409, 'spotify_source_identity_conflict');
  assert.deepEqual(await tracks(collisionKey), [{ title: 'Original other-source song' }]);

  // Ownership changes while provider pages load: the captured old owner must
  // fail inside the write transaction, even with an otherwise current source.
  const beforeHandoff = await source();
  await db.update(performers).set({ ownerUserId: nextOwnerId }).where(eq(performers.id, performerId));
  await mustRejectBeforeTracks(() => replace(expectation(beforeHandoff), 'Former owner overwrite'), 403, 'spotify_performer_owner_changed');
  assert.deepEqual(await tracks(), [{ title: 'Updated saved song' }]);
  await replace(expectation(beforeHandoff), 'New owner song', { actorId: nextOwnerId });
  assert.deepEqual(await tracks(), [{ title: 'New owner song' }]);

  const beforeDeletion = await source();
  await db.delete(performerLibrarySources).where(eq(performerLibrarySources.id, beforeDeletion.id));
  await mustRejectBeforeTracks(() => replace(expectation(beforeDeletion), 'Resurrected stale import', { actorId: nextOwnerId }), 409, 'spotify_source_changed');
  assert.equal(await source(), undefined);
  assert.deepEqual(await tracks(), [{ title: 'New owner song' }]);
  console.log(JSON.stringify({ passed: true, rejectedBeforeTrackMutation: checks,
    database: proof.kind, scope: 'Source ownership, absent identity reservation, replacement version, source kind, and rollback; standalone concurrency not claimed.' }));
} finally {
  await proof.close();
}
