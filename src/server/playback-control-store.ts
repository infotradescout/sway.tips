import { and, asc, desc, eq, gt, inArray, lt, lte, sql } from 'drizzle-orm';
import type { SwayDb } from '../db/client';
import { playbackCommands, playbackStates } from '../db/schema';
import {
  isPlaybackStateFresh,
  normalizePlaybackCompletionResult,
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

function publicPlaybackErrorText(value: unknown) {
  const text = String(value ?? '');
  return /outcome is uncertain|response was lost|command response timed out|command may have reached/i.test(text)
    ? 'Source acknowledgement was lost; playback outcome is uncertain. Check the selected deck before sending another command.'
    : 'Source could not complete the command.';
}

function commandPayload(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as PlaybackCommandPayload
    : {};
}

function differentIntentError() {
  const error = new Error('clientCommandId was already used for a different playback command.');
  (error as Error & { status?: number }).status = 409;
  return error;
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
    async getCurrentTarget(input: { gigId: string; sourceKey: PlaybackSourceKey }) {
      const [state] = await db
        .select({
          sourceKey: playbackStates.sourceKey,
          transport: playbackStates.transport,
          bridgeInstanceId: playbackStates.bridgeInstanceId,
          connectionStatus: playbackStates.connectionStatus,
          deck: playbackStates.deck,
          observedAt: playbackStates.observedAt
        })
        .from(playbackStates)
        .where(eq(playbackStates.gigId, input.gigId))
        .limit(1);
      if (!state || state.sourceKey !== input.sourceKey || state.connectionStatus !== 'connected'
        || !isPlaybackStateFresh(state.observedAt)) return null;
      return state;
    },

    async requireCommandTarget(input: {
      gigId: string;
      sourceKey: PlaybackSourceKey;
      expectedBridgeInstanceId: unknown;
    }) {
      const target = await this.getCurrentTarget(input);
      // The caller's observed identity is only a precondition. The persisted,
      // fresh state remains the authority for the execution target.
      if (typeof input.expectedBridgeInstanceId !== 'string' || !input.expectedBridgeInstanceId
        || !target?.bridgeInstanceId || target.bridgeInstanceId !== input.expectedBridgeInstanceId) {
        const error = new Error('Player connection changed. Refresh playback status and check the selected player before sending another command.');
        Object.assign(error, { status: 409, code: 'playback_connection_changed' });
        throw error;
      }
      return target;
    },

    async createCommand(input: {
      gigId: string;
      performerId: string;
      actorUserId: string;
      clientCommandId: string;
      sourceKey: PlaybackSourceKey;
      action: PlaybackAction;
      payload: PlaybackCommandPayload;
      callerIntentFingerprint: string;
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
          payload: { ...input.payload, callerIntentFingerprint: input.callerIntentFingerprint },
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
        && commandPayload(existing.payload).callerIntentFingerprint === input.callerIntentFingerprint;
      if (!sameIntent) throw differentIntentError();
      return { command: existing, replay: true };
    },

    async getCommandReplay(input: {
      gigId: string;
      clientCommandId: string;
      sourceKey: PlaybackSourceKey;
      action: PlaybackAction;
      callerIntentFingerprint: string;
    }) {
      const [existing] = await db
        .select()
        .from(playbackCommands)
        .where(and(
          eq(playbackCommands.gigId, input.gigId),
          eq(playbackCommands.clientCommandId, input.clientCommandId)
        ))
        .limit(1);
      if (!existing) return null;
      if (existing.sourceKey !== input.sourceKey || existing.action !== input.action
        || commandPayload(existing.payload).callerIntentFingerprint !== input.callerIntentFingerprint) {
        throw differentIntentError();
      }
      return existing;
    },

    async replaceConnectionGeneration(input: {
      gigId: string;
      sourceKey: PlaybackSourceKey;
      executor?: DbExecutor;
    }) {
      const executor = input.executor ?? db;
      const now = new Date();
      const disconnected = await executor
        .update(playbackStates)
        .set({ connectionStatus: 'disconnected', observedAt: now, updatedAt: now })
        .where(and(
          eq(playbackStates.gigId, input.gigId),
          eq(playbackStates.sourceKey, input.sourceKey)
        ))
        .returning({ gigId: playbackStates.gigId });
      const queued = await executor
        .update(playbackCommands)
        .set({
          status: 'expired',
          errorText: 'Command was not sent because the playback connection was replaced.',
          failedAt: now,
          updatedAt: now
        })
        .where(and(
          eq(playbackCommands.gigId, input.gigId),
          eq(playbackCommands.sourceKey, input.sourceKey),
          eq(playbackCommands.status, 'queued')
        ))
        .returning({ id: playbackCommands.id });
      const claimed = await executor
        .update(playbackCommands)
        .set({
          status: 'expired',
          errorText: 'Source acknowledgement was lost during connection replacement; playback outcome is uncertain. Check the selected deck before sending another command.',
          failedAt: now,
          updatedAt: now
        })
        .where(and(
          eq(playbackCommands.gigId, input.gigId),
          eq(playbackCommands.sourceKey, input.sourceKey),
          eq(playbackCommands.status, 'claimed')
        ))
        .returning({ id: playbackCommands.id });
      return { disconnected: disconnected.length, queued: queued.length, claimed: claimed.length };
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
        // A claimed transport command has an uncertain outcome when its lease
        // expires. Requeueing can make a different bridge repeat load/next/
        // previous after the first booth already executed it. Fail closed and
        // require the performer to inspect the source before another command.
        await tx
          .update(playbackCommands)
          .set({
            status: 'expired',
            errorText: 'Source acknowledgement was lost; playback outcome is uncertain. Check the selected deck before sending another command.',
            failedAt: now,
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
            sql`${playbackCommands.payload}->>'targetBridgeInstanceId' = ${input.bridgeInstanceId}`,
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
      return db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(playbackCommands)
          .where(and(
            eq(playbackCommands.id, input.commandId),
            eq(playbackCommands.gigId, input.gigId),
            eq(playbackCommands.sourceKey, input.sourceKey)
          ))
          .limit(1)
          .for('update');
        if (existing && ['succeeded', 'failed'].includes(existing.status)) {
          return { command: existing, replay: true };
        }
        if (!existing || !['claimed', 'expired'].includes(existing.status)
          || existing.claimedBy !== input.bridgeInstanceId) return null;
        const payload = commandPayload(existing.payload);
        const result = normalizePlaybackCompletionResult(input.result, {
          action: existing.action as PlaybackAction,
          targetDeck: typeof payload.deck === 'number' ? payload.deck : null,
          claimedAt: existing.claimedAt,
          completionReceivedAt: input.success ? now : null
        });
        const [completed] = await tx
          .update(playbackCommands)
          .set({
            status: input.success ? 'succeeded' : 'failed',
            completedAt: input.success ? now : null,
            failedAt: input.success ? null : now,
            result,
            // Bridge errors are untrusted and may include an echoed VirtualDJ
            // script or booth-local file path. Persist only a public category.
            errorText: input.success ? null : publicPlaybackErrorText(input.errorText),
            claimExpiresAt: null,
            updatedAt: now
          })
          .where(eq(playbackCommands.id, existing.id))
          .returning();
        return completed ? { command: completed, replay: false } : null;
      });
    },

    async upsertState(input: {
      gigId: string;
      performerId: string;
      state: unknown;
    }) {
      const state = normalizePlaybackStateInput(input.state);
      if (!state) return null;
      const now = new Date();
      const reportedObservedAt = state.observedAt as Date;
      const stateMetadata = { ...(state.metadata ?? {}) };
      delete stateMetadata.reportedObservedAt;
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
        // Server receipt time owns row ordering and freshness. A bridge clock
        // can be wrong or hostile without pinning a future state forever.
        observedAt: now,
        metadata: {
          ...stateMetadata,
          ...(Math.abs(reportedObservedAt.getTime() - now.getTime()) <= 86_400_000
            ? { reportedObservedAt: reportedObservedAt.toISOString() }
            : {})
        },
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
          }
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
              gigId: playbackState.gigId,
              sourceKey: playbackState.sourceKey,
              transport: playbackState.transport,
              bridgeInstanceId: playbackState.bridgeInstanceId,
              deck: playbackState.deck,
              trackTitle: playbackState.trackTitle,
              trackArtist: playbackState.trackArtist,
              externalTrackId: playbackState.externalTrackId,
              playing: playbackState.playing,
              positionMs: playbackState.positionMs,
              durationMs: playbackState.durationMs,
              bpmTimes100: playbackState.bpmTimes100,
              revision: playbackState.revision,
              observedAt: playbackState.observedAt,
              fresh: isPlaybackStateFresh(playbackState.observedAt, now.getTime()),
              connectionStatus: isPlaybackStateFresh(playbackState.observedAt, now.getTime())
                ? playbackState.connectionStatus
                : 'disconnected'
            }
          : null,
        commands: commands.map((command) => {
          const payload = commandPayload(command.payload);
          const result = normalizePlaybackCompletionResult(command.result, {
            action: command.action as PlaybackAction,
            targetDeck: typeof payload.deck === 'number' ? payload.deck : null,
            claimedAt: command.claimedAt,
            // Historical confirmations are evaluated against the immutable
            // server receipt boundary, never re-aged against this snapshot.
            completionReceivedAt: command.completedAt
          });
          return {
            id: command.id,
            gigId: command.gigId,
            sourceKey: command.sourceKey,
            action: command.action,
            status: command.status,
            errorText: command.errorText,
            createdAt: command.createdAt,
            updatedAt: command.updatedAt,
            result: {
              acknowledgement: result.acknowledgement ?? null,
              confirmationStatus: result.confirmationStatus ?? null,
              observedAt: result.observedAt ?? null,
              observedDeck: result.observedDeck ?? null,
              observedTrackTitle: result.observedTrackTitle ?? null,
              observedTrackArtist: result.observedTrackArtist ?? null,
              observedPlaying: result.observedPlaying ?? null,
              loadMatchMode: result.loadMatchMode ?? null
            }
          };
        })
      };
    }
  };
}
