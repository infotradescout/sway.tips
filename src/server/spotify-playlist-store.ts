import { and, eq } from 'drizzle-orm';
import type { SwayDb } from '../db/client';
import { performerLibrarySources, performers } from '../db/schema';

type Transaction = Pick<SwayDb, 'select' | 'insert' | 'update'>;
export type SpotifySourceExpectation = { id: string; updatedAt: string } | null;

export class SpotifyPlaylistSourceConflict extends Error {
  constructor(readonly status: 403 | 409, readonly code: string, message: string) {
    super(message);
    this.name = 'SpotifyPlaylistSourceConflict';
  }
}

function conflict(code: string, message: string): never {
  throw new SpotifyPlaylistSourceConflict(409, code, message);
}

function parseExpectation(value: unknown): SpotifySourceExpectation {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return conflict('spotify_source_invalid_expectation', 'Refresh Sources before importing this playlist.');
  }
  const expected = value as Record<string, unknown>;
  const id = expected.id;
  const updatedAt = expected.updatedAt;
  if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)
    || typeof updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(updatedAt)
    || !Number.isFinite(Date.parse(updatedAt)) || new Date(updatedAt).toISOString() !== updatedAt) {
    return conflict('spotify_source_invalid_expectation', 'Refresh Sources before importing this playlist.');
  }
  return { id, updatedAt };
}

/**
 * Call inside the same transaction as track replacement. Ownership and source
 * identity are locked before any tracks are written; a later write failure
 * must roll back this source reservation/update together with the tracks.
 */
export async function prepareSpotifyPlaylistSource(tx: Transaction, input: {
  actorId: string;
  performerId: string;
  sourceKey: string;
  sourceLabel: string;
  expectedSource: unknown;
  generatedSyncKeyHash: string;
  now?: Date;
}): Promise<{ id: string; updatedAt: Date }> {
  const expected = parseExpectation(input.expectedSource);
  const playlistId = /^spotify-([A-Za-z0-9]{22})$/.exec(input.sourceKey)?.[1];
  if (!playlistId) return conflict('spotify_source_invalid_identity', 'The playlist identity could not be confirmed.');

  const [performer] = await tx.select({ ownerUserId: performers.ownerUserId })
    .from(performers).where(eq(performers.id, input.performerId)).for('update').limit(1);
  if (!performer || performer.ownerUserId !== input.actorId) {
    throw new SpotifyPlaylistSourceConflict(403, 'spotify_performer_owner_changed',
      'Only the current performer owner can import this playlist. Refresh your account.');
  }

  const now = input.now ?? new Date();
  const metadata = { sourceProvider: 'spotify', playlistId, importMode: 'metadata_only' };
  if (expected === null) {
    // Reserve the unique identity before any track writes. A second importer
    // that also saw no source must not turn its insert conflict into replacement.
    const [created] = await tx.insert(performerLibrarySources).values({
      performerId: input.performerId,
      sourceKey: input.sourceKey,
      sourceLabel: input.sourceLabel,
      syncKeyHash: input.generatedSyncKeyHash,
      syncKeyPreview: 'spotify-import',
      connectionStatus: 'active',
      lastSyncedAt: now,
      metadata,
      updatedAt: now
    }).onConflictDoNothing({
      target: [performerLibrarySources.performerId, performerLibrarySources.sourceKey]
    }).returning({ id: performerLibrarySources.id, updatedAt: performerLibrarySources.updatedAt });
    if (!created) return conflict('spotify_source_changed', 'This source was added while Spotify was loading. Refresh Sources before replacing it.');
    return created;
  }

  const [source] = await tx.select().from(performerLibrarySources).where(and(
    eq(performerLibrarySources.performerId, input.performerId),
    eq(performerLibrarySources.sourceKey, input.sourceKey)
  )).for('update').limit(1);
  if (!source || source.id !== expected.id || source.updatedAt.getTime() !== Date.parse(expected.updatedAt)) {
    return conflict('spotify_source_changed', 'This source changed while Spotify was loading. Refresh Sources before replacing it.');
  }
  const existingMetadata = source.metadata && typeof source.metadata === 'object' && !Array.isArray(source.metadata)
    ? source.metadata as Record<string, unknown> : null;
  if (source.syncKeyPreview !== 'spotify-import' || existingMetadata?.sourceProvider !== 'spotify') {
    return conflict('spotify_source_identity_conflict', 'This playlist identity belongs to another source. Your saved source was not changed.');
  }

  // A millisecond version is the exact value projected to the browser. Advance
  // it even when two replacements occur in the same millisecond or clocks lag.
  const updatedAt = new Date(Math.max(now.getTime(), source.updatedAt.getTime() + 1));
  const [updated] = await tx.update(performerLibrarySources).set({
    sourceLabel: input.sourceLabel,
    connectionStatus: 'active',
    lastSyncedAt: updatedAt,
    metadata: { ...existingMetadata, ...metadata },
    updatedAt
  }).where(eq(performerLibrarySources.id, source.id))
    .returning({ id: performerLibrarySources.id, updatedAt: performerLibrarySources.updatedAt });
  return updated;
}
