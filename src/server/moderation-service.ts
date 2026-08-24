import { createHash } from 'crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { createSwayDb } from '../db/client';
import { activeBlocks, moderationEvents } from '../db/schema';
import { lockModerationBlockIdentities } from './moderation-block-lock';

export type ModerationOutageBehavior =
  | 'allow_with_local_filter'
  | 'hold_for_review'
  | 'block_submission';

export type BlockScope = 'patron_user_id' | 'patron_device_id_hash' | 'sender_name';

type LocalSignal = 'allow' | 'review' | 'block';

type AiAssistiveSignal = 'allow' | 'review' | 'block' | 'unavailable';

type BlockRule = {
  id?: string;
  scope: BlockScope;
  value: string;
  reason: string;
};

type BlockLookupResult = {
  match: BlockRule | null;
  outage: boolean;
};

const BLOCK_LOOKUP_UNAVAILABLE_REASON = 'Moderation block store is unavailable; submission held for review.';

type ModerationServiceOverrides = {
  database?: ReturnType<typeof createSwayDb> | null;
  hasDurableStore?: boolean;
  findMatchingBlock?: (input: {
    patronUserId?: string | null;
    patronDeviceIdHash?: string | null;
    senderName?: string | null;
  }) => Promise<BlockLookupResult>;
  upsertActiveBlock?: (input: {
    scope: BlockScope;
    normalizedValue: string;
    reason: string;
    actorUserId?: string | null;
  }) => Promise<void>;
  writeModerationEvent?: (input: {
    actorUserId?: string | null;
    entityType: string;
    entityId: string;
    status: 'allowed' | 'held_for_review' | 'blocked';
    reason?: string;
    metadata?: Record<string, unknown>;
    dedupeKey?: string | null;
  }) => Promise<{ status: 'written' | 'unavailable' }>;
};

const localReviewTerms = ['spam', 'abuse', 'vulgarword', 'asshole', 'bitch', 'bastard', 'fuck'];
const localBlockTerms = ['kill you', 'hurt you', 'attack everyone', 'hate crime'];
const localReviewPatterns = [/\b(?:https?:\/\/|www\.)\S+/i, /\b(?:nude|sexual)\b/i];
const localBlockPatterns = [/\b(?:kill|hurt|attack)\s+(?:you|him|her|them|everyone)\b/i];
const REPORT_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const DEFAULT_ROOM_MENU_REPORT_SUBJECT_LIMIT = 8;
const DEFAULT_ROOM_MENU_REPORT_IP_LIMIT = 32;
const DEFAULT_ROOM_MENU_REPORT_ENTITY_LIMIT = 256;
const DEFAULT_ROOM_MENU_REPORT_RETENTION_DAYS = 180;
const DEFAULT_ROOM_MENU_REPORT_PRUNE_BATCH_SIZE = 500;
const DEFAULT_ROOM_MENU_REPORT_PRUNE_MAX_BATCHES = 20;
const DEFAULT_ROOM_MENU_REPORT_PRUNE_MAX_RUNTIME_MS = 5_000;

function roomMenuReportUtcWindowStart() {
  return sql`date_trunc('day', transaction_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function toModerationEntityUuid(input: string): string {
  const digest = createHash('sha256').update(input).digest('hex').slice(0, 32);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function pickStricterSignal(a: LocalSignal, b: AiAssistiveSignal): LocalSignal {
  const severityRank: Record<LocalSignal | AiAssistiveSignal, number> = {
    allow: 0,
    unavailable: 0,
    review: 1,
    block: 2
  };

  if (severityRank[b] > severityRank[a]) {
    return b as LocalSignal;
  }

  return a;
}

export function createModerationService(databaseUrl?: string, overrides?: ModerationServiceOverrides) {
  const db = overrides?.database ?? (databaseUrl ? createSwayDb(databaseUrl) : null);

  function evaluateLocalSignal(input: { senderName: string; text: string }): { signal: LocalSignal; reason?: string } {
    const haystack = `${input.senderName} ${input.text}`.toLowerCase();

    for (const term of localBlockTerms) {
      if (haystack.includes(term)) {
        return { signal: 'block', reason: 'Deterministic local moderation blocked this submission.' };
      }
    }

    for (const pattern of localBlockPatterns) {
      if (pattern.test(haystack)) {
        return { signal: 'block', reason: 'Deterministic local moderation blocked this submission.' };
      }
    }

    for (const term of localReviewTerms) {
      if (haystack.includes(term)) {
        return { signal: 'review', reason: 'Submission held for review by deterministic local moderation.' };
      }
    }

    for (const pattern of localReviewPatterns) {
      if (pattern.test(haystack)) {
        return { signal: 'review', reason: 'Submission held for review by deterministic local moderation.' };
      }
    }

    return { signal: 'allow' };
  }

  async function findMatchingBlock(input: {
    patronUserId?: string | null;
    patronDeviceIdHash?: string | null;
    senderName?: string | null;
  }): Promise<BlockLookupResult> {
    if (!db) {
      return { match: null, outage: false };
    }

    const candidates: Array<[BlockScope, string | null | undefined]> = [
      ['patron_user_id', input.patronUserId],
      ['patron_device_id_hash', input.patronDeviceIdHash],
      ['sender_name', input.senderName]
    ];

    try {
      for (const [scope, rawValue] of candidates) {
        if (!rawValue) continue;
        const normalizedValue = normalizeKey(rawValue);
        const [existing] = await db
          .select({ id: activeBlocks.id, scope: activeBlocks.scope, normalizedValue: activeBlocks.normalizedValue, reason: activeBlocks.reason })
          .from(activeBlocks)
          .where(and(
            eq(activeBlocks.scope, scope),
            eq(activeBlocks.normalizedValue, normalizedValue),
            eq(activeBlocks.status, 'active'),
            isNull(activeBlocks.revokedAt)
          ))
          .limit(1);

        if (existing) {
          return {
            match: {
              id: existing.id,
              scope,
              value: existing.normalizedValue,
              reason: existing.reason
            },
            outage: false
          };
        }
      }
    } catch {
      return { match: null, outage: true };
    }

    return { match: null, outage: false };
  }

  async function writeModerationEvent(input: {
    actorUserId?: string | null;
    entityType: string;
    entityId: string;
    status: 'allowed' | 'held_for_review' | 'blocked';
    reason?: string;
    metadata?: Record<string, unknown>;
    dedupeKey?: string | null;
  }) {
    if (overrides?.writeModerationEvent) {
      return overrides.writeModerationEvent(input);
    }

    if (!db) {
      return { status: 'unavailable' as const };
    }

    await db.insert(moderationEvents).values({
      dedupeKey: input.dedupeKey ?? null,
      actorUserId: input.actorUserId ?? null,
      entityType: input.entityType,
      entityId: toModerationEntityUuid(input.entityId),
      status: input.status,
      reason: input.reason ?? null,
      metadata: input.metadata ?? {}
    }).onConflictDoNothing();

    return { status: 'written' as const };
  }

  async function evaluateSubmission(input: {
    senderName: string;
    text: string;
    patronUserId?: string | null;
    patronDeviceIdHash?: string | null;
    aiAssistiveModeration?: () => Promise<AiAssistiveSignal>;
  }) {
    const blockLookup = await (overrides?.findMatchingBlock?.({
      patronUserId: input.patronUserId,
      patronDeviceIdHash: input.patronDeviceIdHash,
      senderName: input.senderName
    }) ?? findMatchingBlock({
      patronUserId: input.patronUserId,
      patronDeviceIdHash: input.patronDeviceIdHash,
      senderName: input.senderName
    }));

    if (blockLookup.outage) {
      return {
        decision: 'hold_for_review' as ModerationOutageBehavior,
        reason: BLOCK_LOOKUP_UNAVAILABLE_REASON,
        blockStoreAvailable: false,
        aiAssistiveUsed: false,
        aiAvailable: false
      };
    }

    if (blockLookup.match) {
      return {
        decision: 'block_submission' as ModerationOutageBehavior,
        reason: `Blocked by ${blockLookup.match.scope} rule: ${blockLookup.match.reason}`,
        blockId: blockLookup.match.id ?? null,
        blockStoreAvailable: true,
        aiAssistiveUsed: false,
        aiAvailable: false
      };
    }

    const localSignal = evaluateLocalSignal({ senderName: input.senderName, text: input.text });
    let aiAssistiveUsed = false;
    let aiAvailable = false;
    let mergedSignal = localSignal.signal;

    if (input.aiAssistiveModeration) {
      aiAssistiveUsed = true;
      try {
        const aiSignal = await input.aiAssistiveModeration();
        aiAvailable = aiSignal !== 'unavailable';
        // AI moderation remains assistive only: it can tighten but never bypass local checks.
        mergedSignal = pickStricterSignal(localSignal.signal, aiSignal);
      } catch {
        aiAvailable = false;
      }
    }

    if (mergedSignal === 'block') {
      return {
        decision: 'block_submission' as ModerationOutageBehavior,
      reason: localSignal.reason ?? 'Submission blocked by moderation policy.',
      blockStoreAvailable: true,
        aiAssistiveUsed,
        aiAvailable
      };
    }

    if (mergedSignal === 'review') {
      return {
        decision: 'hold_for_review' as ModerationOutageBehavior,
      reason: localSignal.reason ?? 'Submission held for review by moderation policy.',
      blockStoreAvailable: true,
        aiAssistiveUsed,
        aiAvailable
      };
    }

    return {
      decision: 'allow_with_local_filter' as ModerationOutageBehavior,
      reason: 'Submission allowed after deterministic local filter.',
      blockStoreAvailable: true,
      aiAssistiveUsed,
      aiAvailable
    };
  }

  async function addBlockRule(input: {
    scope: BlockScope;
    value: string;
    reason: string;
    actorUserId?: string | null;
  }) {
    const normalizedValue = normalizeKey(input.value);
    const rule: BlockRule = {
      scope: input.scope,
      value: normalizedValue,
      reason: input.reason
    };

    if (overrides?.upsertActiveBlock) {
      await overrides.upsertActiveBlock({
        scope: input.scope,
        normalizedValue,
        reason: input.reason,
        actorUserId: input.actorUserId ?? null
      });
    } else if (db) {
      await db.transaction(async (tx) => {
        await lockModerationBlockIdentities(tx, [{ scope: input.scope, normalizedValue }]);
        const existingRows = await tx
          .select({ id: activeBlocks.id, status: activeBlocks.status })
          .from(activeBlocks)
          .where(and(
            eq(activeBlocks.scope, input.scope),
            eq(activeBlocks.normalizedValue, normalizedValue)
          ))
          .for('update');
        const existing = existingRows.find((row) => row.status === 'active') ?? existingRows[0];
        if (existingRows.length > 1 && existing) {
          for (const duplicate of existingRows.filter((row) => row.id !== existing.id)) {
            await tx.delete(activeBlocks).where(eq(activeBlocks.id, duplicate.id));
          }
        }
        if (existing) {
          await tx
            .update(activeBlocks)
            .set({
              reason: input.reason,
              actorUserId: input.actorUserId ?? null,
              status: 'active',
              revokedAt: null,
              metadata: { source: 'moderation.block' },
              updatedAt: new Date()
            })
            .where(eq(activeBlocks.id, existing.id));
        } else {
          await tx.insert(activeBlocks).values({
            scope: input.scope,
            normalizedValue,
            reason: input.reason,
            actorUserId: input.actorUserId ?? null,
            status: 'active',
            revokedAt: null,
            metadata: { source: 'moderation.block' }
          });
        }
      });
    }

    await writeModerationEvent({
      actorUserId: input.actorUserId ?? null,
      entityType: 'block_rule',
      entityId: `${input.scope}:${normalizedValue}`,
      status: 'blocked',
      reason: input.reason,
      metadata: {
        scope: input.scope,
        value: rule.value,
        source: 'moderation.block'
      }
    });

    return { status: 'blocked' as const };
  }

  async function recordPatronReport(input: {
    requestId: string;
    reason: string;
    details?: string;
    actorUserId?: string | null;
    patronDeviceIdHash?: string | null;
  }) {
    return writeModerationEvent({
      actorUserId: input.actorUserId ?? null,
      entityType: 'request_report',
      entityId: input.requestId,
      status: 'held_for_review',
      reason: input.reason,
      metadata: {
        details: input.details ?? null,
        patronDeviceIdHash: input.patronDeviceIdHash ?? null,
        source: 'moderation.report'
      }
    });
  }

  async function recordRoomMenuReview(input: {
    gigId: string;
    menuItemId: string;
    performerId: string;
    actorUserId: string;
    status: 'allowed' | 'held_for_review' | 'blocked';
    reason?: string;
    title: string;
    description: string;
  }) {
    const dedupeKey = createHash('sha256')
      .update(JSON.stringify({
        v: 1,
        gigId: input.gigId,
        menuItemId: input.menuItemId,
        performerId: input.performerId,
        status: input.status,
        reason: input.reason,
        title: input.title,
        description: input.description
      }))
      .digest('hex');
    return writeModerationEvent({
      dedupeKey,
      actorUserId: input.actorUserId,
      entityType: 'room_menu_item',
      entityId: `${input.gigId}:${input.menuItemId}`,
      status: input.status,
      reason: input.reason,
      metadata: {
        gigId: input.gigId,
        menuItemId: input.menuItemId,
        performerId: input.performerId,
        title: input.title,
        description: input.description,
        source: 'moderation.room_menu.start'
      }
    });
  }

  async function recordPerformerEventPublicationReview(input: {
    eventId: string;
    performerId: string;
    actorUserId: string;
    status: 'allowed' | 'held_for_review' | 'blocked';
    reason?: string;
    title: string;
    description?: string | null;
    locationName?: string | null;
    locationAddress?: string | null;
    city?: string | null;
  }) {
    const reviewedContent = {
      title: input.title.trim(),
      description: input.description?.trim() || null,
      locationName: input.locationName?.trim() || null,
      locationAddress: input.locationAddress?.trim() || null,
      city: input.city?.trim() || null
    };
    const contentFingerprint = createHash('sha256')
      .update(JSON.stringify({ v: 1, ...reviewedContent }))
      .digest('hex');
    const dedupeKey = createHash('sha256')
      .update(JSON.stringify({
        v: 1,
        eventId: input.eventId,
        performerId: input.performerId,
        status: input.status,
        reason: input.reason ?? null,
        contentFingerprint
      }))
      .digest('hex');
    return writeModerationEvent({
      dedupeKey,
      actorUserId: input.actorUserId,
      entityType: 'performer_event_publication',
      entityId: input.eventId,
      status: input.status,
      reason: input.reason,
      metadata: {
        eventId: input.eventId,
        performerId: input.performerId,
        contentFingerprint,
        reviewedContent,
        source: 'moderation.performer_event.publication'
      }
    });
  }

  async function recordRoomMenuReport(input: {
    gigId: string;
    menuItemId: string;
    reason: string;
    details?: string;
    actorUserId?: string | null;
    patronDeviceIdHash?: string | null;
    reporterFingerprint: string;
    requesterIpHash: string;
    subjectLimit?: number;
    ipLimit?: number;
    entityLimit?: number;
    retentionDays?: number;
  }) {
    if (
      !db
      || !REPORT_FINGERPRINT_PATTERN.test(input.reporterFingerprint)
      || !REPORT_FINGERPRINT_PATTERN.test(input.requesterIpHash)
    ) {
      return { status: 'unavailable' as const };
    }

    const subjectLimit = Math.min(
      DEFAULT_ROOM_MENU_REPORT_SUBJECT_LIMIT,
      Math.max(1, Math.trunc(input.subjectLimit ?? DEFAULT_ROOM_MENU_REPORT_SUBJECT_LIMIT))
    );
    const ipLimit = Math.min(
      DEFAULT_ROOM_MENU_REPORT_IP_LIMIT,
      Math.max(1, Math.trunc(input.ipLimit ?? DEFAULT_ROOM_MENU_REPORT_IP_LIMIT))
    );
    const entityLimit = Math.min(
      DEFAULT_ROOM_MENU_REPORT_ENTITY_LIMIT,
      Math.max(1, Math.trunc(input.entityLimit ?? DEFAULT_ROOM_MENU_REPORT_ENTITY_LIMIT))
    );
    const retentionDays = Math.min(
      DEFAULT_ROOM_MENU_REPORT_RETENTION_DAYS,
      Math.max(1, Math.trunc(input.retentionDays ?? DEFAULT_ROOM_MENU_REPORT_RETENTION_DAYS))
    );
    const entityId = toModerationEntityUuid(`${input.gigId}:${input.menuItemId}`);
    const lockScopes = [
      `room-menu-report:entity:${entityId}`,
      `room-menu-report:ip:${input.requesterIpHash}`,
      `room-menu-report:subject:${input.reporterFingerprint}`
    ].sort();

    try {
      return await db.transaction(async (tx) => {
        // Serialize both durable counters. Sorting prevents deadlocks when an
        // authenticated subject and an IP scope are shared by concurrent calls.
        for (const lockScope of lockScopes) {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockScope}))`);
        }

        await tx.execute(sql`
          with expired as (
            select ${moderationEvents.id}
            from ${moderationEvents}
            where ${moderationEvents.entityType} = 'room_menu_item_report'
              and ${moderationEvents.retentionExpiresAt} <= transaction_timestamp()
            order by ${moderationEvents.retentionExpiresAt}, ${moderationEvents.id}
            limit 500
            for update skip locked
          )
          delete from ${moderationEvents}
          using expired
          where ${moderationEvents.id} = expired.id
        `);

        const [duplicate] = await tx
          .select({ id: moderationEvents.id })
          .from(moderationEvents)
          .where(and(
            eq(moderationEvents.entityType, 'room_menu_item_report'),
            eq(moderationEvents.entityId, entityId),
            eq(moderationEvents.reporterFingerprint, input.reporterFingerprint),
            sql`${moderationEvents.reportWindowStartedAt} = ${roomMenuReportUtcWindowStart()}`
          ))
          .limit(1);
        if (duplicate) {
          return { status: 'duplicate' as const };
        }

        const [counts] = await tx
          .select({
            subjectCount: sql<number>`count(*) filter (where ${moderationEvents.reporterFingerprint} = ${input.reporterFingerprint})`,
            ipCount: sql<number>`count(*) filter (where ${moderationEvents.requesterIpHash} = ${input.requesterIpHash})`,
            entityCount: sql<number>`count(*) filter (where ${moderationEvents.entityId} = ${entityId})`
          })
          .from(moderationEvents)
          .where(and(
            eq(moderationEvents.entityType, 'room_menu_item_report'),
            sql`${moderationEvents.reportWindowStartedAt} = ${roomMenuReportUtcWindowStart()}`
          ));
        if (
          Number(counts?.subjectCount ?? 0) >= subjectLimit
          || Number(counts?.ipCount ?? 0) >= ipLimit
          || Number(counts?.entityCount ?? 0) >= entityLimit
        ) {
          return {
            status: 'rate_limited' as const,
            retryAfterSeconds: 86_400
          };
        }

        const inserted = await tx.insert(moderationEvents).values({
          dedupeKey: null,
          reporterFingerprint: input.reporterFingerprint,
          requesterIpHash: input.requesterIpHash,
          reportWindowStartedAt: roomMenuReportUtcWindowStart(),
          retentionExpiresAt: sql`transaction_timestamp() + (${retentionDays} * interval '1 day')`,
          actorUserId: input.actorUserId ?? null,
          entityType: 'room_menu_item_report',
          entityId,
          status: 'held_for_review',
          reason: input.reason.trim().slice(0, 500),
          metadata: {
            gigId: input.gigId,
            menuItemId: input.menuItemId,
            details: input.details?.trim().slice(0, 2_000) || null,
            patronDeviceIdHash: input.patronDeviceIdHash ?? null,
            source: 'moderation.room_menu.report'
          }
        }).onConflictDoNothing().returning({ id: moderationEvents.id });

        if (!inserted.length) {
          return { status: 'duplicate' as const };
        }

        return { status: 'written' as const };
      });
    } catch {
      return { status: 'unavailable' as const };
    }
  }

  async function pruneExpiredRoomMenuReports(input: {
    limit?: number;
    maxBatches?: number;
    maxRuntimeMs?: number;
  } = {}) {
    if (!db) {
      return {
        deleted: 0,
        batches: 0,
        remainingExpired: 0,
        oldestExpiredAt: null,
        oldestExpiredAgeMs: null,
        continuationRequired: false,
        stopReason: 'unavailable' as const
      };
    }

    const limit = Math.max(1, Math.min(
      DEFAULT_ROOM_MENU_REPORT_PRUNE_BATCH_SIZE,
      Math.trunc(input.limit ?? DEFAULT_ROOM_MENU_REPORT_PRUNE_BATCH_SIZE)
    ));
    const maxBatches = Math.max(1, Math.min(
      100,
      Math.trunc(input.maxBatches ?? DEFAULT_ROOM_MENU_REPORT_PRUNE_MAX_BATCHES)
    ));
    const maxRuntimeMs = Math.max(10, Math.min(
      30_000,
      Math.trunc(input.maxRuntimeMs ?? DEFAULT_ROOM_MENU_REPORT_PRUNE_MAX_RUNTIME_MS)
    ));
    const startedAt = Date.now();
    let deleted = 0;
    let batches = 0;
    let stopReason: 'drained' | 'batch_limit' | 'runtime_limit' = 'drained';

    while (batches < maxBatches) {
      const result = await db.execute(sql`
        with expired as (
          select ${moderationEvents.id}
          from ${moderationEvents}
          where ${moderationEvents.entityType} = 'room_menu_item_report'
            and ${moderationEvents.retentionExpiresAt} <= clock_timestamp()
          order by ${moderationEvents.retentionExpiresAt}, ${moderationEvents.id}
          limit ${limit}
          for update skip locked
        ), deleted as (
          delete from ${moderationEvents}
          using expired
          where ${moderationEvents.id} = expired.id
          returning ${moderationEvents.id}
        )
        select count(*)::integer as deleted from deleted
      `);
      const rows = 'rows' in result ? result.rows as Array<{ deleted?: number }> : [];
      const batchDeleted = Number(rows[0]?.deleted ?? 0);
      deleted += batchDeleted;
      batches += 1;

      if (batchDeleted < limit) {
        stopReason = 'drained';
        break;
      }
      if (batches >= maxBatches) {
        stopReason = 'batch_limit';
        break;
      }
      if (Date.now() - startedAt >= maxRuntimeMs) {
        stopReason = 'runtime_limit';
        break;
      }
    }

    const backlogResult = await db.execute(sql`
      select
        count(*)::integer as remaining_expired,
        min(${moderationEvents.retentionExpiresAt}) as oldest_expired_at,
        floor(extract(epoch from (clock_timestamp() - min(${moderationEvents.retentionExpiresAt}))) * 1000)::bigint
          as oldest_expired_age_ms
      from ${moderationEvents}
      where ${moderationEvents.entityType} = 'room_menu_item_report'
        and ${moderationEvents.retentionExpiresAt} <= clock_timestamp()
    `);
    const backlogRows = 'rows' in backlogResult
      ? backlogResult.rows as Array<{
          remaining_expired?: number;
          oldest_expired_at?: Date | string | null;
          oldest_expired_age_ms?: number | string | null;
        }>
      : [];
    const backlog = backlogRows[0];
    const remainingExpired = Number(backlog?.remaining_expired ?? 0);
    const oldestExpiredDate = backlog?.oldest_expired_at
      ? new Date(backlog.oldest_expired_at)
      : null;
    const oldestExpiredAt = oldestExpiredDate && Number.isFinite(oldestExpiredDate.getTime())
      ? oldestExpiredDate.toISOString()
      : null;
    const parsedOldestAge = backlog?.oldest_expired_age_ms == null
      ? null
      : Number(backlog.oldest_expired_age_ms);
    const oldestExpiredAgeMs = parsedOldestAge != null && Number.isFinite(parsedOldestAge)
      ? Math.max(0, parsedOldestAge)
      : null;

    return {
      deleted,
      batches,
      remainingExpired,
      oldestExpiredAt,
      oldestExpiredAgeMs,
      continuationRequired: remainingExpired > 0,
      stopReason: remainingExpired === 0 ? 'drained' as const : stopReason
    };
  }

  async function recordBlockEnforcement(input: {
    entityId: string;
    actorUserId?: string | null;
    blockId?: string | null;
  }) {
    return writeModerationEvent({
      actorUserId: input.actorUserId ?? null,
      entityType: 'block_enforcement',
      entityId: input.entityId,
      status: 'blocked',
      reason: 'Submission denied by an active moderation rule.',
      metadata: {
        blockId: input.blockId ?? null,
        source: 'moderation.block.enforcement'
      }
    });
  }

  async function recordPatronBlockRequest(input: {
    scope: Extract<BlockScope, 'patron_device_id_hash' | 'sender_name'>;
    value: string;
    reason: string;
    actorUserId?: string | null;
    patronDeviceIdHash?: string | null;
  }) {
    return writeModerationEvent({
      actorUserId: input.actorUserId ?? null,
      entityType: 'patron_block_request',
      entityId: `${input.scope}:${input.value}:${Date.now()}`,
      status: 'held_for_review',
      reason: input.reason,
      metadata: {
        scope: input.scope,
        value: input.value,
        patronDeviceIdHash: input.patronDeviceIdHash ?? null,
        source: 'moderation.patron_block'
      }
    });
  }

  async function hideRequest(input: {
    requestId: string;
    reason: string;
    actorUserId?: string | null;
  }) {
    return writeModerationEvent({
      actorUserId: input.actorUserId ?? null,
      entityType: 'request_visibility',
      entityId: input.requestId,
      status: 'held_for_review',
      reason: input.reason,
      metadata: { action: 'hide', source: 'moderation.hide' }
    });
  }

  async function removeRequest(input: {
    requestId: string;
    reason: string;
    actorUserId?: string | null;
  }) {
    return writeModerationEvent({
      actorUserId: input.actorUserId ?? null,
      entityType: 'request_visibility',
      entityId: input.requestId,
      status: 'blocked',
      reason: input.reason,
      metadata: { action: 'remove', source: 'moderation.remove' }
    });
  }

  function getAppStoreUgcControlPlaceholders() {
    return {
      report: '/api/moderation/report',
      block: '/api/moderation/patron-block',
      privilegedBlock: '/api/moderation/block',
      removeHide: ['/api/moderation/hide', '/api/moderation/remove'],
      supportContact: '/api/support/contact',
      dataDeletionPlaceholder: '/api/privacy/data-deletion-placeholder'
    };
  }

  return {
    hasDurableStore: overrides?.hasDurableStore ?? Boolean(db),
    evaluateSubmission,
    addBlockRule,
    recordPatronReport,
    recordRoomMenuReview,
    recordPerformerEventPublicationReview,
    recordRoomMenuReport,
    pruneExpiredRoomMenuReports,
    recordBlockEnforcement,
    recordPatronBlockRequest,
    hideRequest,
    removeRequest,
    getAppStoreUgcControlPlaceholders
  };
}
