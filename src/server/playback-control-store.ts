import { and, asc, desc, eq, gt, inArray, lt, lte, sql } from 'drizzle-orm';
import type { SwayDb } from '../db/client';
import { playbackCommands, playbackStates } from '../db/schema';
import {
  isPlaybackStateFresh,
  normalizePlaybackStateInput,
  type PlaybackAction,
  type PlaybackCommandPayload,
  type PlaybackSourceKey
} from '../playback-control';

type DbExecutor = SwayDb | any;
const DEFAULT_COMMAND_TTL_MS = 60_000;
const DEFAULT_CLAIM_LEASE_MS = 30_000;

function safeLimit(value: number | undefined, fallback: number, maximum: number) {
  if (!Number.isFinite(value) || Number(value) <= 0) return fallback;
  return Math.min(Math.floor(Number(value)), maximum);
}

function normalizeResult(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function createPlaybackControlStore({ db }: { db: SwayDb }) {
  async function expireCommands(executor: DbExecutor, now = new Date()) {
    return executor
      .update(playbackCommands)
      .set({
        status: 'expired',
        errorText: 'Command expired before source acknowledgement.',
        failedAt: now,
        updatedAt: now
      })
      .where(and(
        inArray(playbackCommands.status, ['queued', 'claimed']),
        lte(playbackCommands.expiresAt, now)
      ))
      .returning({ id: playbackCommands.id });
  }

  return {
    async createCommand(input: {
      gigId: string;
      performerId: string;
      actorUserId: string;
      clientCommandId: string;
      sourceKey: PlaybackSourceKey;
      action: PlaybackAction;
      payload: PlaybackCommandPayload;
      ttlMs?: number;
    }) {
      const now = new Date();
      const ttlMs = Math.min(Math.max(Math.floor(input.ttlMs ?? DEFAULT_COMMAND_TTL_MS), 5_000), 120_000);
      const expiresAt = new Date(now.getTime() + ttlMs);

      const [inserted] = await db
        .insert(playbackCommands)
        .values({
          gigId: input.gigId,
          performerId: input.performerId,
          actorUserId: input.actorUserId,
          clientCommandId: input.clientCommandId,
          sourceKey: input.sourceKey,
          action: input.action,
          payload: input.payload,
          status: 'queued',
          expiresAt,
          updatedAt: now
        })
        .onConflictDoNothing({
          target: [playbackCommands.gigId, playbackCommands.clientCommandId]
        })
        .returning();

      if (inserted) return { command: inserted, replay: false };

      const [existing] = await db
        .select()
        .from(playbackCommands)
        .where(and(
          eq(playbackCommands.gigId, input.gigId),
          eq(playbackCommands.clientCommandId, input.clientCommandId)
        ))
        .limit(1);

      if (!existing) throw new Error('Playback command idempotency reservation could not be resolved.');
      const sameIntent = existing.sourceKey === input.sourceKey
        && existing.action === input.action
        && JSON.stringify(existing.payload ?? {}) === JSON.stringify(input.payload ?? {});
      if (!sameIntent) {
        const error = new Error('clientCommandId was already used for a different playback command.');
        (error as Error & { status?: number }).status = 409;
        throw error;
      }
      return { command: existing, replay: true };
    },

    async claimCommands(input: {
      gigId: string;
      sourceKey: PlaybackSourceKey;
      bridgeInstanceId: string;
      limit?: number;
      leaseMs?: number;
    }) {
      const limit = safeLimit(input.limit, 10, 25);
      const leaseMs = Math.min(Math.max(Math.floor(input.leaseMs ?? DEFAULT_CLAIM_LEASE_MS), 10_000), 60_000);
      const now = new Date();
      const claimExpiresAt = new Date(now.getTime() + leaseMs);

      return db.transaction(async (tx) => {
        await expireCommands(tx, now);
        await tx
          .update(playbackCommands)
          .set({
            status: 'queued',
            claimedBy: null,
            claimedAt: null,
            claimExpiresAt: null,
            updatedAt: now
          })
          .where(and(
            eq(playbackCommands.gigId, input.gigId),
            eq(playbackCommands.sourceKey, input.sourceKey),
            eq(playbackCommands.status, 'claimed'),
            lt(playbackCommands.claimExpiresAt, now),
            gt(playbackCommands.expiresAt, now)
          ));

        const rows = await tx
          .select()
          .from(playbackCommands)
          .where(and(
            eq(playbackCommands.gigId, input.gigId),
            eq(playbackCommands.sourceKey, input.sourceKey),
            eq(playbackCommands.status, 'queued'),
            gt(playbackCommands.expiresAt, now)
          ))
          .orderBy(asc(playbackCommands.createdAt))
          .limit(limit)
          .for('update', { skipLocked: true });

        if (!rows.length) return [];
        const ids = rows.map((row) => row.id);
        return tx
          .update(playbackCommands)
          .set({
            status: 'claimed',
            claimedBy: input.bridgeInstanceId,
            claimedAt: now,
            claimExpiresAt,
            updatedAt: now
          })
          .where(and(
            inArray(playbackCommands.id, ids),
            eq(playbackCommands.status, 'queued')
          ))
          .returning();
      });
    },

    async completeCommand(input: {
      gigId: string;
      sourceKey: PlaybackSourceKey;
      bridgeInstanceId: string;
      commandId: string;
      success: boolean;
      result?: unknown;
      errorText?: string | null;
    }) {
      const now = new Date();
      const [completed] = await db
        .update(playbackCommands)
        .set({
          status: input.success ? 'succeeded' : 'failed',
          completedAt: input.success ? now : null,
          failedAt: input.success ? null : now,
          result: normalizeResult(input.result),
          errorText: input.success ? null : String(input.errorText || 'Source rejected the command.').slice(0, 1_000),
          claimExpiresAt: null,
          updatedAt: now
        })
        .where(and(
          eq(playbackCommands.id, input.commandId),
          eq(playbackCommands.gigId, input.gigId),
          eq(playbackCommands.sourceKey, input.sourceKey),
          eq(playbackCommands.status, 'claimed'),
          eq(playbackCommands.claimedBy, input.bridgeInstanceId)
        ))
        .returning();

      if (completed) return { command: completed, replay: false };

      const [existing] = await db
        .select()
        .from(playbackCommands)
        .where(and(
          eq(playbackCommands.id, input.commandId),
          eq(playbackCommands.gigId, input.gigId),
          eq(playbackCommands.sourceKey, input.sourceKey)
        ))
        .limit(1);
      if (existing && ['succeeded', 'failed', 'expired'].includes(existing.status)) {
        return { command: existing, replay: true };
      }
      return null;
    },

    async upsertState(input: {
      gigId: string;
      performerId: string;
      state: unknown;
    }) {
      const state = normalizePlaybackStateInput(input.state);
      if (!state) return null;
      const now = new Date();
      const values = {
        gigId: input.gigId,
        performerId: input.performerId,
        sourceKey: state.sourceKey,
        transport: state.transport,
        bridgeInstanceId: state.bridgeInstanceId,
        connectionStatus: state.connectionStatus,
        deck: state.deck,
        trackTitle: state.trackTitle,
        trackArtist: state.trackArtist,
        trackPath: state.trackPath,
        externalTrackId: state.externalTrackId,
        playing: state.playing,
        positionMs: state.positionMs,
        durationMs: state.durationMs,
        bpmTimes100: state.bpmTimes100,
        observedAt: state.observedAt as Date,
        metadata: state.metadata,
        updatedAt: now
      };

      const [row] = await db
        .insert(playbackStates)
        .values(values)
        .onConflictDoUpdate({
          target: playbackStates.gigId,
          set: {
            ...values,
            revision: sql`${playbackStates.revision} + 1`
          },
          setWhere: lte(playbackStates.observedAt, state.observedAt as Date)
        })
        .returning();

      return row;
    },

    async getSnapshot(input: { gigId: string; recentCommandLimit?: number }) {
      const now = new Date();
      await expireCommands(db, now);
      const [state, commands] = await Promise.all([
        db.select().from(playbackStates).where(eq(playbackStates.gigId, input.gigId)).limit(1),
        db
          .select()
          .from(playbackCommands)
          .where(eq(playbackCommands.gigId, input.gigId))
          .orderBy(desc(playbackCommands.createdAt))
          .limit(safeLimit(input.recentCommandLimit, 12, 50))
      ]);
      const playbackState = state[0] ?? null;
      return {
        state: playbackState
          ? {
              ...playbackState,
              fresh: isPlaybackStateFresh(playbackState.observedAt, now.getTime()),
              connectionStatus: isPlaybackStateFresh(playbackState.observedAt, now.getTime())
                ? playbackState.connectionStatus
                : 'disconnected'
            }
          : null,
        commands
      };
    }
  };
}
