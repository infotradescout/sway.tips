import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import type { ActiveRoomSummary, BackendState, RequestItem, BoostContribution, GigSession, PerformerProfile } from '../types';
import { createSwayDb, type SwayDb } from '../db/client';
import type { FeeAttribution } from './fee-policy';
import type { PendingActionOwner } from './idempotency-store';
import {
  activeBlocks,
  activeRoomRegistry,
  clientPendingActions,
  gigSessions,
  requestBoosts,
  requests,
  users,
  performers,
  promotionCampaigns,
  requestStatusEnum
} from '../db/schema';
import { lockModerationBlockIdentities, moderationBlockIdentities } from './moderation-block-lock';

const PENDING_ACTION_TTL_MS = 5 * 60 * 1000;

export type BusinessStoreRoomStatus = 'missing' | 'active' | 'inactive' | 'ended' | 'legacy_safe_empty';

type DurableSnapshot = {
  state: BackendState;
  activeGigId: string | null;
  roomStatus: BusinessStoreRoomStatus;
};

type PersistInput = {
  state: BackendState;
  activeGigId: string | null;
};

type PersistOptions = {
  executor?: SwayDb;
};

type PersistedSessionRow = {
  id: string;
  runtimeSessionState: unknown;
  status: string;
  startedAt: Date | null;
  autoCloseoutAt: Date;
  manualCloseoutCompletedAt: Date | null;
  stateRevision: number;
  updatedAt: Date;
};

export type ReservedLiveRoomAction = {
  durableId: string;
  created: boolean;
  activated: boolean;
};

export type RequestReservationCaps = {
  maxRequestsPerDevicePerGig: number;
  maxCustomNotesPerDevicePerGig: number;
};

export type BoostReservationCaps = {
  maxBoostsPerDevicePerGig: number;
};

const RUNTIME_USER_ID = '00000000-0000-4000-8000-000000000111';
const LEGACY_FALLBACK_ACTIVE_STATUSES = ['active', 'ending'] as const;
const TRACKED_ROOM_STATUSES = ['active', 'ending'] as const;
// Must include 'ending' (the 5-minute post-gig sweep) alongside 'active',
// matching LEGACY_FALLBACK_ACTIVE_STATUSES/TRACKED_ROOM_STATUSES/
// hasLiveRoomContext above -- otherwise a room mid-sweep silently vanishes
// from the performer's own room selector, admin oversight roster, and the
// public feed until it's fully closed out.
const READABLE_ACTIVE_ROOM_STATUSES = ['active', 'ending'] as const;

const STATUS_MAP: Record<RequestItem['status'], (typeof requestStatusEnum.enumValues)[number]> = {
  hold: 'held_for_review',
  approved: 'approved',
  denied: 'denied',
  fulfilled: 'fulfilled'
};

const REVERSE_STATUS_MAP: Record<(typeof requestStatusEnum.enumValues)[number], RequestItem['status']> = {
  submitted: 'hold',
  payment_pending: 'hold',
  payment_authorized: 'hold',
  held_for_review: 'hold',
  approved: 'approved',
  denied: 'denied',
  voided_or_refunded: 'denied',
  fulfilled: 'fulfilled',
  captured: 'fulfilled',
  paid_out: 'fulfilled',
  disputed: 'hold'
};

function coerceRequestStatus(value: unknown): RequestItem['status'] {
  if (typeof value === 'string' && ['hold', 'approved', 'denied', 'fulfilled'].includes(value)) {
    return value as RequestItem['status'];
  }
  return 'hold';
}

function coerceGigSession(raw: unknown, fallback: GigSession): GigSession {
  if (!raw || typeof raw !== 'object') return fallback;
  const input = raw as Partial<GigSession>;
  return {
    status: input.status ?? fallback.status,
    startedAt: input.startedAt ?? fallback.startedAt ?? null,
    autoCloseoutAt: input.autoCloseoutAt ?? fallback.autoCloseoutAt ?? null,
    closedAt: input.closedAt ?? fallback.closedAt ?? null,
    ownerActorUserId: input.ownerActorUserId ?? fallback.ownerActorUserId ?? null,
    lastMutationActorUserId: input.lastMutationActorUserId ?? fallback.lastMutationActorUserId ?? null,
    talentName: input.talentName ?? fallback.talentName,
    talentRole: input.talentRole ?? fallback.talentRole,
    feeType: input.feeType ?? fallback.feeType,
    minimumTip: Number(input.minimumTip ?? fallback.minimumTip),
    endGigTimerStartedAt: input.endGigTimerStartedAt ?? fallback.endGigTimerStartedAt,
    isFeatured: Boolean(input.isFeatured ?? fallback.isFeatured),
    featuredExpiresAt: input.featuredExpiresAt ?? fallback.featuredExpiresAt,
    featuredCost: Number(input.featuredCost ?? fallback.featuredCost),
    featuredDurationHours: Number(input.featuredDurationHours ?? fallback.featuredDurationHours),
    requestsOpen: Boolean(input.requestsOpen ?? fallback.requestsOpen),
    requestWindowMode: input.requestWindowMode ?? fallback.requestWindowMode,
    requestWindowExpiresAt: input.requestWindowExpiresAt ?? fallback.requestWindowExpiresAt,
    requestWindowDuration: input.requestWindowDuration ?? fallback.requestWindowDuration,
    requestWindowLabel: input.requestWindowLabel ?? fallback.requestWindowLabel,
    requestPresets: Array.isArray(input.requestPresets) ? input.requestPresets : fallback.requestPresets,
    operatingMode: input.operatingMode === 'open_call' || input.operatingMode === 'crowd_autopilot'
      ? input.operatingMode
      : (fallback.operatingMode ?? 'manual'),
    searchScope: input.searchScope === 'catalog' || input.searchScope === 'setlist'
      ? input.searchScope
      : (fallback.searchScope ?? 'library'),
    paymentsEnabled: typeof input.paymentsEnabled === 'boolean'
      ? input.paymentsEnabled
      : (fallback.paymentsEnabled ?? true),
    tipsEnabled: typeof input.tipsEnabled === 'boolean'
      ? input.tipsEnabled
      : (fallback.tipsEnabled ?? false),
    settlementMode: input.settlementMode === 'connected_account' || input.settlementMode === 'platform_test_balance'
      ? input.settlementMode
      : (fallback.settlementMode ?? 'unavailable'),
    paymentEnvironment: input.paymentEnvironment === 'test' || input.paymentEnvironment === 'live'
      ? input.paymentEnvironment
      : (fallback.paymentEnvironment ?? 'unavailable'),
    totals: input.totals ?? fallback.totals
  };
}

function coerceBoost(raw: unknown): BoostContribution | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Partial<BoostContribution>;
  if (!input.id) return null;
  return {
    id: input.id,
    durableBoostId: input.durableBoostId,
    stateRevision: input.stateRevision,
    patronName: input.patronName ?? 'Co-Sponsor',
    amount: Number(input.amount ?? 0),
    platformFee: Number(input.platformFee ?? 0),
    timestamp: input.timestamp ?? new Date().toISOString(),
    actorUserId: input.actorUserId ?? null,
    patronDeviceIdHash: input.patronDeviceIdHash ?? null,
    clientRequestId: input.clientRequestId,
    idempotencyKey: input.idempotencyKey,
    idempotencyFingerprint: input.idempotencyFingerprint,
    idempotencyExpiresAt: input.idempotencyExpiresAt,
    paymentId: input.paymentId ?? null,
    paymentIntentId: input.paymentIntentId ?? null,
    paymentStatus: input.paymentStatus ?? null,
    patronStatusReceiptHash: input.patronStatusReceiptHash
  };
}

function coerceRequest(raw: unknown): RequestItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Partial<RequestItem>;
  if (!input.id) return null;

  const boosts = Array.isArray(input.boosts)
    ? input.boosts.map((boost) => coerceBoost(boost)).filter((boost): boost is BoostContribution => Boolean(boost))
    : [];

  return {
    id: input.id,
    durableRequestId: input.durableRequestId,
    stateRevision: input.stateRevision,
    type: input.type ?? 'request',
    targetType: input.targetType ?? 'music',
    title: input.title ?? 'Request',
    subtitle: input.subtitle ?? '',
    albumArt: input.albumArt,
    senderName: input.senderName ?? 'Anonymous Patron',
    message: input.message ?? '',
    amount: Number(input.amount ?? 0),
    holdAmount: Number(input.holdAmount ?? 0),
    platformFee: Number(input.platformFee ?? 0),
    sponsorCount: Number(input.sponsorCount ?? 1),
    status: coerceRequestStatus(input.status),
    shadowBanned: Boolean(input.shadowBanned),
    hidden: Boolean(input.hidden),
    removed: Boolean(input.removed),
    actorUserId: input.actorUserId ?? null,
    lastMutationActorUserId: input.lastMutationActorUserId ?? null,
    createdAt: input.createdAt ?? new Date().toISOString(),
    clientRequestId: input.clientRequestId,
    idempotencyKey: input.idempotencyKey,
    idempotencyFingerprint: input.idempotencyFingerprint,
    idempotencyExpiresAt: input.idempotencyExpiresAt,
    patronDeviceIdHash: input.patronDeviceIdHash,
    gigId: input.gigId,
    payloadHash: input.payloadHash,
    amountCents: input.amountCents,
    currency: input.currency,
    paymentId: input.paymentId ?? null,
    paymentIntentId: input.paymentIntentId ?? null,
    paymentStatus: input.paymentStatus ?? null,
    patronStatusReceiptHash: input.patronStatusReceiptHash,
    boosts
  };
}

function deriveRequestType(request: RequestItem): string {
  if (request.type === 'tip') return 'tip';
  return request.targetType || 'music';
}

function deriveRequestStatus(request: RequestItem): (typeof requestStatusEnum.enumValues)[number] {
  return STATUS_MAP[request.status] ?? 'held_for_review';
}

function deriveSessionStatus(status: GigSession['status']): 'draft' | 'active' | 'closeout_pending' | 'closed' {
  if (status === 'active') return 'active';
  if (status === 'ending') return 'closeout_pending';
  if (status === 'closed') return 'closed';
  return 'draft';
}

function deriveRegistryStatus(status: GigSession['status']): 'active' | 'ending' | 'closed' {
  if (status === 'active') return 'active';
  if (status === 'ending') return 'ending';
  return 'closed';
}

function hasLiveRoomContext(status: GigSession['status']) {
  return status === 'active' || status === 'ending';
}

function restoreDurableSessionStatus(status: string): GigSession['status'] {
  if (status === 'active') return 'active';
  if (status === 'closeout_pending') return 'ending';
  if (status === 'closed' || status === 'expired' || status === 'canceled') return 'closed';
  return 'inactive';
}

function derivePerformersFromSession(session: GigSession): PerformerProfile[] {
  if (session.status === 'inactive' || !session.talentName) {
    return [];
  }

  return [{
    id: 'p-active',
    name: session.talentName,
    role: session.talentRole,
    venueName: 'Current gig',
    isFeatured: session.isFeatured,
    featuredExpiresAt: session.featuredExpiresAt,
    minimumTip: session.minimumTip,
    avatarUrl: ''
  }];
}

function createEmptyState(createInactiveSession: () => GigSession): BackendState {
  return {
    session: createInactiveSession(),
    requests: [],
    performers: [],
    activeGigId: null
  };
}

function normalizeState(input: BackendState, gigId: string | null): BackendState {
  return {
    session: input.session,
    requests: input.requests,
    performers: derivePerformersFromSession(input.session),
    activeGigId: hasLiveRoomContext(input.session.status) ? gigId : null
  };
}

export function createBusinessStore(databaseUrl: string | undefined, createInactiveSession: () => GigSession) {
  const db = databaseUrl ? createSwayDb(databaseUrl) : null;

  async function ensureRuntimeUserRow(executor: SwayDb) {
    await executor.insert(users).values({
      id: RUNTIME_USER_ID,
      email: null,
      displayName: 'Runtime Owner',
      role: 'performer'
    }).onConflictDoNothing();
  }

  async function ensurePerformerForActor(executor: SwayDb, actorUserId: string | null | undefined) {
    const ownerUserId = actorUserId ?? RUNTIME_USER_ID;
    await ensureRuntimeUserRow(executor);

    const [existingPerformer] = await executor
      .select({ id: performers.id })
      .from(performers)
      .where(eq(performers.ownerUserId, ownerUserId))
      .limit(1);

    if (existingPerformer) {
      return existingPerformer.id;
    }

    const idSuffix = ownerUserId.slice(0, 8).replace(/[^a-z0-9]/gi, '').toLowerCase() || 'runtime';
    const [inserted] = await executor.insert(performers).values({
      ownerUserId,
      handle: `runtime-${idSuffix}`,
      displayName: `Runtime ${idSuffix}`,
      bio: null
    }).returning({ id: performers.id });

    return inserted.id;
  }

  async function restoreSnapshotForGig(sessionRow: PersistedSessionRow): Promise<DurableSnapshot> {
    if (!db) {
      return {
        state: createEmptyState(createInactiveSession),
        activeGigId: null,
        roomStatus: 'missing'
      };
    }

    const requestRows = await db
      .select({
        id: requests.id,
        status: requests.status,
        runtimeRequestState: requests.runtimeRequestState,
        activatedAt: requests.activatedAt,
        stateRevision: requests.stateRevision,
        createdAt: requests.createdAt
      })
      .from(requests)
      .where(eq(requests.gigId, sessionRow.id))
      .orderBy(asc(requests.createdAt));

    const boostRows = await db
      .select({
        id: requestBoosts.id,
        requestId: requestBoosts.requestId,
        runtimeBoostState: requestBoosts.runtimeBoostState,
        activatedAt: requestBoosts.activatedAt,
        stateRevision: requestBoosts.stateRevision,
        createdAt: requestBoosts.createdAt
      })
      .from(requestBoosts)
      .where(eq(requestBoosts.gigId, sessionRow.id))
      .orderBy(asc(requestBoosts.createdAt));

    const boostsByRequestId = new Map<string, BoostContribution[]>();
    for (const row of boostRows) {
      if (!row.activatedAt) continue;
      const boost = coerceBoost(row.runtimeBoostState);
      if (!boost) continue;
      boost.durableBoostId = row.id;
      boost.stateRevision = row.stateRevision;
      const bucket = boostsByRequestId.get(row.requestId) ?? [];
      bucket.push(boost);
      boostsByRequestId.set(row.requestId, bucket);
    }

    const restoredRequests: RequestItem[] = requestRows
      .map((row) => {
        if (!row.activatedAt) return null;
        const request = coerceRequest(row.runtimeRequestState);
        if (!request) return null;
        request.durableRequestId = row.id;
        request.stateRevision = row.stateRevision;
        request.status = REVERSE_STATUS_MAP[row.status] ?? request.status;
        request.boosts = boostsByRequestId.get(row.id) ?? request.boosts;
        if (typeof request.amountCents === 'number') {
          request.amount = (request.amountCents / 100) + request.boosts.reduce((total, boost) => total + Number(boost.amount || 0), 0);
          request.platformFee = Number(request.platformFee || 0)
            + request.boosts.reduce((total, boost) => total + Number(boost.platformFee || 0), 0);
          request.sponsorCount = 1 + request.boosts.length;
        }
        request.gigId = request.gigId ?? sessionRow.id;
        return request;
      })
      .filter((request): request is RequestItem => Boolean(request));

    const durableFallback = createInactiveSession();
    durableFallback.status = restoreDurableSessionStatus(sessionRow.status);
    durableFallback.startedAt = sessionRow.startedAt?.toISOString() ?? null;
    durableFallback.autoCloseoutAt = sessionRow.autoCloseoutAt.toISOString();
    durableFallback.closedAt = sessionRow.manualCloseoutCompletedAt?.toISOString() ?? null;

    const restoredSession = coerceGigSession(sessionRow.runtimeSessionState, durableFallback);
    // Relational session columns are the durable source of truth. Older room
    // snapshots predate these JSON fields, and a stale JSON status or missing
    // deadline must never keep an expired room publicly active forever.
    restoredSession.status = durableFallback.status;
    restoredSession.startedAt = durableFallback.startedAt;
    restoredSession.autoCloseoutAt = durableFallback.autoCloseoutAt;
    restoredSession.closedAt = durableFallback.closedAt;
    restoredSession.stateRevision = sessionRow.stateRevision;
    // 'ending' (the 5-minute post-gig sweep) must still resolve as a live,
    // readable room -- both the performer's own dashboard and the patron
    // view keep polling this gig-scoped state throughout the sweep window.
    // Falling through to 'inactive' here made every /api/state/:gigId call
    // 404 as soon as a session ended, breaking closeout and the sweep UI.
    const roomStatus: BusinessStoreRoomStatus =
      restoredSession.status === 'closed'
        ? 'ended'
        : hasLiveRoomContext(restoredSession.status)
          ? 'active'
          : 'inactive';

    const state = normalizeState({
      session: restoredSession,
      requests: restoredRequests,
      performers: [],
      activeGigId: null
    }, sessionRow.id);

    return {
      state,
      activeGigId: state.activeGigId,
      roomStatus
    };
  }

  async function hydrateState(fallbackState: BackendState): Promise<DurableSnapshot> {
    if (!db) {
      return {
        state: normalizeState(fallbackState, fallbackState.activeGigId ?? null),
        activeGigId: hasLiveRoomContext(fallbackState.session.status) ? (fallbackState.activeGigId ?? null) : null,
        roomStatus: fallbackState.session.status === 'closed'
          ? 'ended'
          : hasLiveRoomContext(fallbackState.session.status)
            ? 'active'
            : 'inactive'
      };
    }

    const activeRoomRows = await db
      .select({ gigId: activeRoomRegistry.gigId })
      .from(activeRoomRegistry)
      .where(inArray(activeRoomRegistry.registryStatus, [...LEGACY_FALLBACK_ACTIVE_STATUSES]))
      .orderBy(desc(activeRoomRegistry.lastActivityAt), desc(activeRoomRegistry.updatedAt));

    if (activeRoomRows.length !== 1) {
      return {
        state: createEmptyState(createInactiveSession),
        activeGigId: null,
        roomStatus: 'legacy_safe_empty'
      };
    }

    return hydrateStateByGigId(activeRoomRows[0].gigId, fallbackState);
  }

  async function hydrateStateByGigId(gigId: string, fallbackState: BackendState): Promise<DurableSnapshot> {
    if (!db) {
      if (fallbackState.activeGigId === gigId) {
        return {
          state: normalizeState(fallbackState, gigId),
          activeGigId: hasLiveRoomContext(fallbackState.session.status) ? gigId : null,
          roomStatus: fallbackState.session.status === 'closed'
            ? 'ended'
            : hasLiveRoomContext(fallbackState.session.status)
              ? 'active'
              : 'inactive'
        };
      }

      return {
        state: createEmptyState(createInactiveSession),
        activeGigId: null,
        roomStatus: 'missing'
      };
    }

    const [sessionRow] = await db
      .select({
        id: gigSessions.id,
        runtimeSessionState: gigSessions.runtimeSessionState,
        status: gigSessions.status,
        startedAt: gigSessions.startedAt,
        autoCloseoutAt: gigSessions.autoCloseoutAt,
        manualCloseoutCompletedAt: gigSessions.manualCloseoutCompletedAt,
        stateRevision: gigSessions.stateRevision,
        updatedAt: gigSessions.updatedAt
      })
      .from(gigSessions)
      .where(eq(gigSessions.id, gigId))
      .limit(1);

    if (!sessionRow) {
      return {
        state: createEmptyState(createInactiveSession),
        activeGigId: null,
        roomStatus: 'missing'
      };
    }

    return restoreSnapshotForGig(sessionRow);
  }

  // Server-side authority on attribution: a client can supply a campaign code, but
  // it only counts as sway_promoted when it resolves to a real, active campaign tied
  // to the specific performer running this gig. No code, no match, wrong performer,
  // or an inactive/expired campaign all fall back to creator_direct.
  async function resolveCampaignAttribution(gigId: string, campaignCode: string | null | undefined): Promise<FeeAttribution> {
    if (!db || !campaignCode) return { kind: 'creator_direct' };

    const [row] = await db
      .select({
        campaignId: promotionCampaigns.id,
        commissionBps: promotionCampaigns.commissionBps
      })
      .from(promotionCampaigns)
      .innerJoin(gigSessions, eq(gigSessions.performerId, promotionCampaigns.performerId))
      .where(and(
        eq(gigSessions.id, gigId),
        eq(promotionCampaigns.campaignCode, campaignCode),
        eq(promotionCampaigns.status, 'active'),
        or(isNull(promotionCampaigns.expiresAt), gt(promotionCampaigns.expiresAt, new Date()))
      ))
      .limit(1);

    if (!row) return { kind: 'creator_direct' };

    return { kind: 'sway_promoted', campaignId: row.campaignId, commissionBps: row.commissionBps };
  }

  async function listTrackedGigIds(): Promise<string[]> {
    if (!db) return [];

    const rows = await db
      .select({ gigId: activeRoomRegistry.gigId })
      .from(activeRoomRegistry)
      .where(inArray(activeRoomRegistry.registryStatus, [...TRACKED_ROOM_STATUSES]))
      .orderBy(desc(activeRoomRegistry.lastActivityAt), desc(activeRoomRegistry.updatedAt));

    return rows.map((row) => row.gigId);
  }

  async function listActiveRoomSummaries(performerId?: string): Promise<ActiveRoomSummary[]> {
    if (!db) return [];

    const statusFilter = inArray(activeRoomRegistry.registryStatus, [...READABLE_ACTIVE_ROOM_STATUSES]);
    const rows = await db
      .select({
        gigId: activeRoomRegistry.gigId,
        performerName: activeRoomRegistry.talentName,
        talentRole: activeRoomRegistry.talentRole,
        routePath: activeRoomRegistry.routePath,
        startedAt: activeRoomRegistry.startedAt
      })
      .from(activeRoomRegistry)
      .where(performerId ? and(statusFilter, eq(activeRoomRegistry.performerId, performerId)) : statusFilter)
      .orderBy(desc(activeRoomRegistry.lastActivityAt), desc(activeRoomRegistry.updatedAt));

    const summaries = await Promise.all(rows.map(async (row) => {
      const snapshot = await hydrateStateByGigId(row.gigId, createEmptyState(createInactiveSession));
      const requestCount = snapshot.state.requests.filter((request) => !request.hidden && !request.removed).length;

      return {
        gigId: row.gigId,
        performerName: row.performerName || 'Unassigned performer',
        talentRole: row.talentRole as ActiveRoomSummary['talentRole'],
        routePath: row.routePath,
        startedAt: row.startedAt ? row.startedAt.toISOString() : null,
        requestCount
      };
    }));

    return summaries;
  }

  async function reserveRequestAction(
    gigId: string,
    request: RequestItem,
    caps: RequestReservationCaps
  ): Promise<ReservedLiveRoomAction> {
    if (!db) throw new Error('durable_business_store_unavailable');
    if (!request.clientRequestId || !request.idempotencyKey || !request.idempotencyFingerprint) {
      throw new Error('durable_request_identity_required');
    }

    return db.transaction(async (tx) => {
      const [room] = await tx
        .select({
          status: gigSessions.status,
          runtimeSessionState: gigSessions.runtimeSessionState
        })
        .from(gigSessions)
        .where(eq(gigSessions.id, gigId))
        .for('update')
        .limit(1);

      const [existing] = await tx
        .select({
          id: requests.id,
          gigId: requests.gigId,
          clientRequestId: requests.clientRequestId,
          idempotencyKey: requests.idempotencyKey,
          intentFingerprint: requests.intentFingerprint,
          activatedAt: requests.activatedAt,
          stateRevision: requests.stateRevision
        })
        .from(requests)
        .where(or(
          eq(requests.clientRequestId, request.clientRequestId),
          eq(requests.idempotencyKey, request.idempotencyKey)
        ))
        .for('update')
        .limit(1);

      if (existing) {
        if (
          existing.gigId !== gigId
          || existing.clientRequestId !== request.clientRequestId
          || existing.idempotencyKey !== request.idempotencyKey
          || existing.intentFingerprint !== request.idempotencyFingerprint
        ) {
          throw new Error('durable_request_identity_conflict');
        }

        request.durableRequestId = existing.id;
        request.stateRevision = existing.stateRevision;
        // Admission gates govern new/invisible work. Once this exact immutable
        // action is visible, a later room close must not reinterpret success as
        // a conflict and reverse its payment.
        if (existing.activatedAt) {
          return { durableId: existing.id, created: false, activated: true };
        }
        if (!room || room.status !== 'active') throw new Error('room_not_accepting_money');
        return { durableId: existing.id, created: false, activated: false };
      }

      if (!room || room.status !== 'active') throw new Error('room_not_accepting_money');
      const lockedSession = coerceGigSession(room.runtimeSessionState, createInactiveSession());
      if (request.type !== 'tip' && !lockedSession.requestsOpen) {
        throw new Error('room_not_accepting_requests');
      }

      if (request.type !== 'tip' && request.patronDeviceIdHash) {
        const sameDeviceRequests = await tx
          .select({
            requestType: requests.requestType,
            message: requests.message,
            status: requests.status,
            activatedAt: requests.activatedAt
          })
          .from(requests)
          .where(and(
            eq(requests.gigId, gigId),
            eq(requests.patronDeviceIdHash, request.patronDeviceIdHash)
          ));
        const durableRequests = sameDeviceRequests.filter((row) => (
          row.requestType !== 'tip'
          && !(!row.activatedAt && ['denied', 'voided_or_refunded'].includes(row.status))
        ));
        if (durableRequests.length >= caps.maxRequestsPerDevicePerGig) {
          throw new Error('request_device_per_gig_cap_reached');
        }
        if (
          request.message?.trim()
          && durableRequests.filter((row) => Boolean(row.message?.trim())).length >= caps.maxCustomNotesPerDevicePerGig
        ) {
          throw new Error('request_custom_note_device_per_gig_cap_reached');
        }
      }

      const [created] = await tx
        .insert(requests)
        .values({
          gigId,
          patronUserId: request.actorUserId ?? null,
          lastMutationActorUserId: request.lastMutationActorUserId ?? request.actorUserId ?? null,
          clientRequestId: request.clientRequestId,
          idempotencyKey: request.idempotencyKey,
          intentFingerprint: request.idempotencyFingerprint,
          patronDeviceIdHash: request.patronDeviceIdHash ?? null,
          status: 'payment_pending',
          requestType: deriveRequestType(request),
          amountCents: request.amountCents ?? Math.round(Number(request.amount ?? 0) * 100),
          currency: request.currency ?? 'USD',
          message: request.message ?? null,
          runtimeRequestState: request,
          activatedAt: null
        })
        .onConflictDoNothing()
        .returning({ id: requests.id, activatedAt: requests.activatedAt, stateRevision: requests.stateRevision });

      const [row] = created
        ? [created]
        : await tx
            .select({
              id: requests.id,
              gigId: requests.gigId,
              clientRequestId: requests.clientRequestId,
              idempotencyKey: requests.idempotencyKey,
              intentFingerprint: requests.intentFingerprint,
              activatedAt: requests.activatedAt,
              stateRevision: requests.stateRevision
            })
            .from(requests)
            .where(or(
              eq(requests.clientRequestId, request.clientRequestId),
              eq(requests.idempotencyKey, request.idempotencyKey)
            ))
            .for('update')
            .limit(1);

      if (
        !row
        || ('gigId' in row && row.gigId !== gigId)
        || ('clientRequestId' in row && row.clientRequestId !== request.clientRequestId)
        || ('idempotencyKey' in row && row.idempotencyKey !== request.idempotencyKey)
        || ('intentFingerprint' in row && row.intentFingerprint !== request.idempotencyFingerprint)
      ) {
        throw new Error('durable_request_identity_conflict');
      }

      request.durableRequestId = row.id;
      request.stateRevision = row.stateRevision;
      return { durableId: row.id, created: Boolean(created), activated: Boolean(row.activatedAt) };
    });
  }

  async function reserveBoostAction(
    gigId: string,
    request: RequestItem,
    boost: BoostContribution,
    caps: BoostReservationCaps
  ): Promise<ReservedLiveRoomAction> {
    if (!db) throw new Error('durable_business_store_unavailable');
    if (!boost.clientRequestId || !boost.idempotencyKey || !boost.idempotencyFingerprint) {
      throw new Error('durable_boost_identity_required');
    }

    return db.transaction(async (tx) => {
      const [room] = await tx
        .select({ status: gigSessions.status })
        .from(gigSessions)
        .where(eq(gigSessions.id, gigId))
        .for('update')
        .limit(1);

      const [parent] = await tx
        .select({
          id: requests.id,
          gigId: requests.gigId,
          status: requests.status,
          activatedAt: requests.activatedAt,
          runtimeRequestState: requests.runtimeRequestState
        })
        .from(requests)
        .where(request.durableRequestId
          ? eq(requests.id, request.durableRequestId)
          : sql`${requests.runtimeRequestState}->>'id' = ${request.id}`)
        .for('update')
        .limit(1);
      const parentRuntime = parent ? coerceRequest(parent.runtimeRequestState) : null;

      const [existing] = await tx
        .select({
          id: requestBoosts.id,
          requestId: requestBoosts.requestId,
          gigId: requestBoosts.gigId,
          clientRequestId: requestBoosts.clientRequestId,
          idempotencyKey: requestBoosts.idempotencyKey,
          intentFingerprint: requestBoosts.intentFingerprint,
          activatedAt: requestBoosts.activatedAt,
          stateRevision: requestBoosts.stateRevision
        })
        .from(requestBoosts)
        .where(or(
          eq(requestBoosts.clientRequestId, boost.clientRequestId),
          eq(requestBoosts.idempotencyKey, boost.idempotencyKey)
        ))
        .for('update')
        .limit(1);

      if (existing) {
        if (
          !parent
          || existing.requestId !== parent.id
          || existing.gigId !== gigId
          || existing.clientRequestId !== boost.clientRequestId
          || existing.idempotencyKey !== boost.idempotencyKey
          || existing.intentFingerprint !== boost.idempotencyFingerprint
        ) {
          throw new Error('durable_boost_identity_conflict');
        }

        request.durableRequestId = parent.id;
        boost.durableBoostId = existing.id;
        boost.stateRevision = existing.stateRevision;
        // Parent eligibility and room admission apply before first visibility.
        // They must not turn an exact already-visible boost into a refund.
        if (existing.activatedAt) {
          return { durableId: existing.id, created: false, activated: true };
        }
        if (!room || room.status !== 'active') throw new Error('room_not_accepting_money');
        if (
          !parent.activatedAt
          || parent.status !== 'approved'
          || parentRuntime?.hidden
          || parentRuntime?.removed
          || parentRuntime?.shadowBanned
        ) {
          throw new Error('boost_target_not_eligible');
        }
        return { durableId: existing.id, created: false, activated: false };
      }

      if (!room || room.status !== 'active') throw new Error('room_not_accepting_money');
      if (
        !parent
        || parent.gigId !== gigId
        || !parent.activatedAt
        || parent.status !== 'approved'
        || parentRuntime?.hidden
        || parentRuntime?.removed
        || parentRuntime?.shadowBanned
      ) {
        throw new Error('boost_target_not_eligible');
      }
      request.durableRequestId = parent.id;

      if (boost.patronDeviceIdHash) {
        const sameDeviceBoosts = await tx
          .select({ id: requestBoosts.id, status: requestBoosts.status, activatedAt: requestBoosts.activatedAt })
          .from(requestBoosts)
          .where(and(
            eq(requestBoosts.gigId, gigId),
            eq(requestBoosts.patronDeviceIdHash, boost.patronDeviceIdHash)
          ));
        const activeDeviceBoosts = sameDeviceBoosts.filter((row) => !(
          !row.activatedAt && ['denied', 'voided_or_refunded'].includes(row.status)
        ));
        if (activeDeviceBoosts.length >= caps.maxBoostsPerDevicePerGig) {
          throw new Error('boost_device_per_gig_cap_reached');
        }
      }

      const [created] = await tx
        .insert(requestBoosts)
        .values({
          requestId: parent.id,
          gigId,
          patronUserId: boost.actorUserId ?? request.actorUserId ?? null,
          actorUserId: boost.actorUserId ?? request.actorUserId ?? null,
          clientRequestId: boost.clientRequestId,
          idempotencyKey: boost.idempotencyKey,
          intentFingerprint: boost.idempotencyFingerprint,
          patronDeviceIdHash: boost.patronDeviceIdHash ?? null,
          status: 'payment_pending',
          amountCents: Math.round(Number(boost.amount ?? 0) * 100),
          currency: request.currency ?? 'USD',
          runtimeBoostState: boost,
          activatedAt: null
        })
        .onConflictDoNothing()
        .returning({ id: requestBoosts.id, activatedAt: requestBoosts.activatedAt, stateRevision: requestBoosts.stateRevision });

      const [row] = created
        ? [created]
        : await tx
            .select({
              id: requestBoosts.id,
              requestId: requestBoosts.requestId,
              gigId: requestBoosts.gigId,
              clientRequestId: requestBoosts.clientRequestId,
              idempotencyKey: requestBoosts.idempotencyKey,
              intentFingerprint: requestBoosts.intentFingerprint,
              activatedAt: requestBoosts.activatedAt,
              stateRevision: requestBoosts.stateRevision
            })
            .from(requestBoosts)
            .where(or(
              eq(requestBoosts.clientRequestId, boost.clientRequestId),
              eq(requestBoosts.idempotencyKey, boost.idempotencyKey)
            ))
            .for('update')
            .limit(1);

      if (
        !row
        || ('gigId' in row && row.gigId !== gigId)
        || ('requestId' in row && row.requestId !== parent.id)
        || ('clientRequestId' in row && row.clientRequestId !== boost.clientRequestId)
        || ('idempotencyKey' in row && row.idempotencyKey !== boost.idempotencyKey)
        || ('intentFingerprint' in row && row.intentFingerprint !== boost.idempotencyFingerprint)
      ) {
        throw new Error('durable_boost_identity_conflict');
      }

      boost.durableBoostId = row.id;
      boost.stateRevision = row.stateRevision;
      return { durableId: row.id, created: Boolean(created), activated: Boolean(row.activatedAt) };
    });
  }

  async function shadowRequestForBoostModeration(gigId: string, request: RequestItem) {
    if (!db || !request.durableRequestId) throw new Error('durable_request_identity_required');

    return db.transaction(async (tx) => {
      const [room] = await tx
        .select({ status: gigSessions.status })
        .from(gigSessions)
        .where(eq(gigSessions.id, gigId))
        .for('update')
        .limit(1);
      if (!room || room.status !== 'active') throw new Error('room_not_accepting_money');

      const [parent] = await tx
        .select({
          activatedAt: requests.activatedAt,
          stateRevision: requests.stateRevision,
          runtimeRequestState: requests.runtimeRequestState
        })
        .from(requests)
        .where(and(
          eq(requests.id, request.durableRequestId),
          eq(requests.gigId, gigId)
        ))
        .for('update')
        .limit(1);
      if (!parent?.activatedAt) throw new Error('boost_target_not_eligible');

      const persistedRuntime = coerceRequest(parent.runtimeRequestState);
      if (!persistedRuntime) throw new Error('durable_request_runtime_missing');
      if (persistedRuntime.shadowBanned) {
        request.shadowBanned = true;
        request.stateRevision = parent.stateRevision;
        return { updated: false, stateRevision: parent.stateRevision };
      }

      const [updated] = await tx
        .update(requests)
        .set({
          runtimeRequestState: {
            ...persistedRuntime,
            shadowBanned: true
          },
          stateRevision: sql`${requests.stateRevision} + 1`,
          updatedAt: new Date()
        })
        .where(and(
          eq(requests.id, request.durableRequestId),
          eq(requests.gigId, gigId),
          eq(requests.stateRevision, parent.stateRevision),
          isNotNull(requests.activatedAt)
        ))
        .returning({ stateRevision: requests.stateRevision });
      if (!updated) throw new Error('request_state_revision_conflict');

      request.shadowBanned = true;
      request.stateRevision = updated.stateRevision;
      return { updated: true, stateRevision: updated.stateRevision };
    });
  }

  async function activateRequestAction(gigId: string, request: RequestItem, owner?: PendingActionOwner) {
    if (!db || !request.durableRequestId || !request.idempotencyKey || !request.idempotencyFingerprint) {
      throw new Error('durable_request_activation_identity_required');
    }
    return db.transaction(async (tx) => {
      const requestBlockIdentities = moderationBlockIdentities({
        patronUserId: request.actorUserId,
        patronDeviceIdHash: request.patronDeviceIdHash,
        senderName: request.senderName
      });
      await lockModerationBlockIdentities(tx, requestBlockIdentities);
      const [activeBlock] = requestBlockIdentities.length
        ? await tx
          .select({ id: activeBlocks.id })
          .from(activeBlocks)
          .where(and(
            eq(activeBlocks.status, 'active'),
            isNull(activeBlocks.revokedAt),
            or(...requestBlockIdentities.map((identity) => and(
              eq(activeBlocks.scope, identity.scope),
              eq(activeBlocks.normalizedValue, identity.normalizedValue)
            )))
          ))
          .limit(1)
        : [];
      if (activeBlock) throw new Error('active_moderation_block');
      const [room] = await tx
        .select({ status: gigSessions.status })
        .from(gigSessions)
        .where(eq(gigSessions.id, gigId))
        .for('update')
        .limit(1);
      const [pending] = await tx
        .select({
          status: clientPendingActions.status,
          expiresAt: clientPendingActions.expiresAt,
          createdAt: clientPendingActions.createdAt,
          ownerToken: clientPendingActions.ownerToken,
          ownerGeneration: clientPendingActions.ownerGeneration,
          ownerLeaseExpiresAt: clientPendingActions.ownerLeaseExpiresAt
        })
        .from(clientPendingActions)
        .where(and(
          eq(clientPendingActions.clientRequestId, request.clientRequestId),
          eq(clientPendingActions.idempotencyKey, request.idempotencyKey),
          eq(clientPendingActions.gigId, gigId)
        ))
        .for('update')
        .limit(1);
      const [reserved] = await tx
        .select({
          idempotencyKey: requests.idempotencyKey,
          intentFingerprint: requests.intentFingerprint,
          status: requests.status,
          activatedAt: requests.activatedAt,
          stateRevision: requests.stateRevision
        })
        .from(requests)
        .where(and(eq(requests.id, request.durableRequestId), eq(requests.gigId, gigId)))
        .for('update')
        .limit(1);
      if (
        !reserved
        || reserved.idempotencyKey !== request.idempotencyKey
        || reserved.intentFingerprint !== request.idempotencyFingerprint
      ) throw new Error('durable_request_activation_identity_conflict');
      if (
        owner
        && (
          pending?.ownerToken !== owner.token
          || pending.ownerGeneration !== owner.generation
          || !pending.ownerLeaseExpiresAt
          || pending.ownerLeaseExpiresAt.getTime() <= Date.now()
        )
      ) throw new Error('pending_action_owner_fenced');
      // Reconciliation and the original HTTP request can race after Stripe
      // confirms. The same immutable action becoming visible first is success,
      // not a reason to reverse its payment.
      if (reserved.activatedAt) {
        request.stateRevision = reserved.stateRevision;
        return;
      }
      if (
        !pending
        || !['pending', 'retrying'].includes(pending.status)
        || Math.min(pending.expiresAt.getTime(), pending.createdAt.getTime() + PENDING_ACTION_TTL_MS) <= Date.now()
      ) throw new Error('pending_action_expired');
      if (reserved.status !== 'payment_pending') throw new Error('durable_request_activation_terminal');
      if (room?.status !== 'active') throw new Error('room_not_accepting_money');
      const now = new Date();
      const [activated] = await tx
        .update(requests)
        .set({
          patronUserId: request.actorUserId ?? null,
          lastMutationActorUserId: request.lastMutationActorUserId ?? request.actorUserId ?? null,
          status: deriveRequestStatus(request),
          requestType: deriveRequestType(request),
          amountCents: request.amountCents ?? Math.round(Number(request.amount ?? 0) * 100),
          currency: request.currency ?? 'USD',
          message: request.message ?? null,
          runtimeRequestState: request,
          activatedAt: now,
          stateRevision: sql`${requests.stateRevision} + 1`,
          updatedAt: now
        })
        .where(and(
          eq(requests.id, request.durableRequestId),
          eq(requests.gigId, gigId),
          eq(requests.idempotencyKey, request.idempotencyKey),
          eq(requests.intentFingerprint, request.idempotencyFingerprint),
          eq(requests.status, 'payment_pending'),
          isNull(requests.activatedAt)
        ))
        .returning({ stateRevision: requests.stateRevision });
      if (!activated) throw new Error('durable_request_activation_conflict');
      request.stateRevision = activated.stateRevision;
    });
  }

  async function activateBoostAction(gigId: string, request: RequestItem, boost: BoostContribution, owner?: PendingActionOwner) {
    if (!db || !request.durableRequestId || !boost.durableBoostId || !boost.idempotencyKey || !boost.idempotencyFingerprint) {
      throw new Error('durable_boost_activation_identity_required');
    }
    return db.transaction(async (tx) => {
      const boostBlockIdentities = moderationBlockIdentities({
        patronUserId: boost.actorUserId ?? request.actorUserId,
        patronDeviceIdHash: boost.patronDeviceIdHash,
        senderName: boost.patronName
      });
      await lockModerationBlockIdentities(tx, boostBlockIdentities);
      const [activeBlock] = boostBlockIdentities.length
        ? await tx
          .select({ id: activeBlocks.id })
          .from(activeBlocks)
          .where(and(
            eq(activeBlocks.status, 'active'),
            isNull(activeBlocks.revokedAt),
            or(...boostBlockIdentities.map((identity) => and(
              eq(activeBlocks.scope, identity.scope),
              eq(activeBlocks.normalizedValue, identity.normalizedValue)
            )))
          ))
          .limit(1)
        : [];
      if (activeBlock) throw new Error('active_moderation_block');
      const [room] = await tx
        .select({ status: gigSessions.status })
        .from(gigSessions)
        .where(eq(gigSessions.id, gigId))
        .for('update')
        .limit(1);
      const [pending] = await tx
        .select({
          status: clientPendingActions.status,
          expiresAt: clientPendingActions.expiresAt,
          createdAt: clientPendingActions.createdAt,
          ownerToken: clientPendingActions.ownerToken,
          ownerGeneration: clientPendingActions.ownerGeneration,
          ownerLeaseExpiresAt: clientPendingActions.ownerLeaseExpiresAt
        })
        .from(clientPendingActions)
        .where(and(
          eq(clientPendingActions.clientRequestId, boost.clientRequestId),
          eq(clientPendingActions.idempotencyKey, boost.idempotencyKey),
          eq(clientPendingActions.gigId, gigId)
        ))
        .for('update')
        .limit(1);
      const [reserved] = await tx
        .select({
          requestId: requestBoosts.requestId,
          idempotencyKey: requestBoosts.idempotencyKey,
          intentFingerprint: requestBoosts.intentFingerprint,
          status: requestBoosts.status,
          activatedAt: requestBoosts.activatedAt,
          stateRevision: requestBoosts.stateRevision
        })
        .from(requestBoosts)
        .where(and(eq(requestBoosts.id, boost.durableBoostId), eq(requestBoosts.gigId, gigId)))
        .for('update')
        .limit(1);
      if (
        !reserved
        || reserved.requestId !== request.durableRequestId
        || reserved.idempotencyKey !== boost.idempotencyKey
        || reserved.intentFingerprint !== boost.idempotencyFingerprint
      ) throw new Error('durable_boost_activation_identity_conflict');
      if (
        owner
        && (
          pending?.ownerToken !== owner.token
          || pending.ownerGeneration !== owner.generation
          || !pending.ownerLeaseExpiresAt
          || pending.ownerLeaseExpiresAt.getTime() <= Date.now()
        )
      ) throw new Error('pending_action_owner_fenced');
      // A worker or the patron reconciliation poll may have committed this
      // exact boost already. Do not reinterpret that success as a stale-target
      // conflict and refund a valid captured payment.
      if (reserved.activatedAt) {
        boost.stateRevision = reserved.stateRevision;
        return;
      }
      if (
        !pending
        || !['pending', 'retrying'].includes(pending.status)
        || Math.min(pending.expiresAt.getTime(), pending.createdAt.getTime() + PENDING_ACTION_TTL_MS) <= Date.now()
      ) throw new Error('pending_action_expired');
      if (reserved.status !== 'payment_pending') throw new Error('durable_boost_activation_terminal');
      if (room?.status !== 'active') throw new Error('room_not_accepting_money');
      const [parent] = await tx
        .select({
          status: requests.status,
          activatedAt: requests.activatedAt,
          runtimeRequestState: requests.runtimeRequestState
        })
        .from(requests)
        .where(and(eq(requests.id, request.durableRequestId), eq(requests.gigId, gigId)))
        .for('update')
        .limit(1);
      const parentRuntime = parent ? coerceRequest(parent.runtimeRequestState) : null;
      if (
        !parent?.activatedAt
        || parent.status !== 'approved'
        || parentRuntime?.hidden
        || parentRuntime?.removed
        || parentRuntime?.shadowBanned
      ) throw new Error('boost_target_not_eligible');
      const now = new Date();
      const [activated] = await tx
        .update(requestBoosts)
        .set({
          patronUserId: boost.actorUserId ?? request.actorUserId ?? null,
          actorUserId: boost.actorUserId ?? request.actorUserId ?? null,
          status: 'approved',
          amountCents: Math.round(Number(boost.amount ?? 0) * 100),
          currency: request.currency ?? 'USD',
          runtimeBoostState: boost,
          activatedAt: now,
          stateRevision: sql`${requestBoosts.stateRevision} + 1`,
          updatedAt: now
        })
        .where(and(
          eq(requestBoosts.id, boost.durableBoostId),
          eq(requestBoosts.requestId, request.durableRequestId),
          eq(requestBoosts.gigId, gigId),
          eq(requestBoosts.idempotencyKey, boost.idempotencyKey),
          eq(requestBoosts.intentFingerprint, boost.idempotencyFingerprint),
          eq(requestBoosts.status, 'payment_pending'),
          isNull(requestBoosts.activatedAt)
        ))
        .returning({ stateRevision: requestBoosts.stateRevision });
      if (!activated) throw new Error('durable_boost_activation_conflict');
      boost.stateRevision = activated.stateRevision;
    });
  }

  async function beginRoomCloseout(gigId: string) {
    if (!db) return { status: 'unavailable' as const };
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          status: gigSessions.status,
          runtimeSessionState: gigSessions.runtimeSessionState,
          stateRevision: gigSessions.stateRevision
        })
        .from(gigSessions)
        .where(eq(gigSessions.id, gigId))
        .for('update')
        .limit(1);
      if (!row) return { status: 'missing' as const };
      if (row.status === 'closed') return { status: 'closed' as const, stateRevision: row.stateRevision };
      if (row.status === 'closeout_pending') {
        return { status: 'already_pending' as const, stateRevision: row.stateRevision };
      }
      if (!['active', 'closeout_pending'].includes(row.status)) {
        return { status: 'not_closeable' as const };
      }

      const now = new Date();
      const runtimeSession = coerceGigSession(row.runtimeSessionState, createInactiveSession());
      runtimeSession.status = 'ending';
      runtimeSession.requestsOpen = false;
      runtimeSession.endGigTimerStartedAt = runtimeSession.endGigTimerStartedAt ?? now.toISOString();

      const [updated] = await tx
        .update(gigSessions)
        .set({
          status: 'closeout_pending',
          runtimeSessionState: runtimeSession,
          manualCloseoutStartedAt: sql`coalesce(${gigSessions.manualCloseoutStartedAt}, ${now})`,
          lastActivityAt: now,
          stateRevision: sql`${gigSessions.stateRevision} + 1`,
          updatedAt: now
        })
        .where(and(eq(gigSessions.id, gigId), eq(gigSessions.stateRevision, row.stateRevision)))
        .returning({ stateRevision: gigSessions.stateRevision });
      if (!updated) throw new Error('gig_session_state_revision_conflict');
      await tx
        .update(activeRoomRegistry)
        .set({
          registryStatus: 'ending',
          lastActivityAt: now,
          updatedAt: now
        })
        .where(eq(activeRoomRegistry.gigId, gigId));

      return { status: 'started' as const, stateRevision: updated.stateRevision };
    });
  }

  async function persistState(input: PersistInput, options?: PersistOptions) {
    if (!options?.executor && db) {
      return db.transaction(async (tx) => persistState(input, { executor: tx as unknown as SwayDb }));
    }
    const executor = options?.executor ?? db;
    if (!executor || !input.activeGigId) return;

    await ensureRuntimeUserRow(executor);

    const now = new Date();
    const session = input.state.session;
    const runtimePerformerId = await ensurePerformerForActor(executor, null);
    const performerId = (await ensurePerformerForActor(executor, session.ownerActorUserId ?? null)) ?? runtimePerformerId;
    const registryStatus = deriveRegistryStatus(session.status);
    const routePath = `/g/${input.activeGigId}`;

    const sessionValues = {
      performerId,
      ownerActorUserId: session.ownerActorUserId ?? null,
      lastMutationActorUserId: session.lastMutationActorUserId ?? null,
      status: deriveSessionStatus(session.status),
      title: `runtime_room:${input.activeGigId}`,
      venueName: 'runtime',
      runtimeSessionState: session,
      startedAt: session.startedAt ? new Date(session.startedAt) : now,
      scheduledEndAt: null,
      lastActivityAt: now,
      manualCloseoutStartedAt: session.status === 'ending' ? now : null,
      manualCloseoutCompletedAt: session.status === 'closed' ? now : null,
      autoCloseoutAt: session.autoCloseoutAt ? new Date(session.autoCloseoutAt) : new Date(now.getTime() + 4 * 60 * 60 * 1000),
      autoCloseoutReason: null,
      closeoutPolicy: 'max_started_at_4h_or_scheduled_end_at_30m',
      updatedAt: now
    };
    const expectedSessionRevision = session.stateRevision;
    const [persistedSession] = typeof expectedSessionRevision === 'number'
      ? await executor
          .update(gigSessions)
          .set({ ...sessionValues, stateRevision: sql`${gigSessions.stateRevision} + 1` })
          .where(and(
            eq(gigSessions.id, input.activeGigId),
            eq(gigSessions.stateRevision, expectedSessionRevision)
          ))
          .returning({ stateRevision: gigSessions.stateRevision })
      : await executor
          .insert(gigSessions)
          .values({ id: input.activeGigId, ...sessionValues, stateRevision: 0 })
          .onConflictDoNothing()
          .returning({ stateRevision: gigSessions.stateRevision });
    if (!persistedSession) throw new Error('gig_session_state_revision_conflict');
    session.stateRevision = persistedSession.stateRevision;

    await executor.insert(activeRoomRegistry).values({
      gigId: input.activeGigId,
      performerId,
      ownerActorUserId: session.ownerActorUserId ?? null,
      talentName: session.talentName || '',
      talentRole: session.talentRole,
      routePath,
      registryStatus,
      startedAt: session.status === 'active' || session.status === 'ending' || session.status === 'closed' ? now : null,
      endedAt: session.status === 'closed' ? now : null,
      lastActivityAt: now,
      updatedAt: now
    }).onConflictDoUpdate({
      target: activeRoomRegistry.gigId,
      set: {
        performerId,
        ownerActorUserId: session.ownerActorUserId ?? null,
        talentName: session.talentName || '',
        talentRole: session.talentRole,
        routePath,
        registryStatus,
        endedAt: session.status === 'closed' ? now : null,
        lastActivityAt: now,
        updatedAt: now
      }
    });

    const requestIdMap = new Map<string, string>();

    for (const request of input.state.requests) {
      const clientRequestId = request.clientRequestId ?? `legacy-${request.id}`;
      const requestValues = {
        patronUserId: request.actorUserId ?? null,
        lastMutationActorUserId: request.lastMutationActorUserId ?? request.actorUserId ?? null,
        idempotencyKey: request.idempotencyKey ?? null,
        intentFingerprint: request.idempotencyFingerprint ?? null,
        patronDeviceIdHash: request.patronDeviceIdHash ?? null,
        status: deriveRequestStatus(request),
        requestType: deriveRequestType(request),
        amountCents: request.amountCents ?? Math.round(Number(request.amount ?? 0) * 100),
        currency: request.currency ?? 'USD',
        message: request.message ?? null,
        runtimeRequestState: request,
        updatedAt: now
      };
      const [persistedRequest] = request.durableRequestId && typeof request.stateRevision === 'number'
        ? await executor
            .update(requests)
            .set({
              ...requestValues,
              activatedAt: sql`coalesce(${requests.activatedAt}, ${now})`,
              stateRevision: sql`${requests.stateRevision} + 1`
            })
            .where(and(
              eq(requests.id, request.durableRequestId),
              eq(requests.gigId, input.activeGigId),
              eq(requests.stateRevision, request.stateRevision)
            ))
            .returning({ id: requests.id, stateRevision: requests.stateRevision })
        : !request.durableRequestId
          ? await executor
              .insert(requests)
              .values({
                gigId: input.activeGigId,
                clientRequestId,
                ...requestValues,
                activatedAt: now,
                stateRevision: 0
              })
              .onConflictDoNothing()
              .returning({ id: requests.id, stateRevision: requests.stateRevision })
          : [];

      if (!persistedRequest) throw new Error('request_state_revision_conflict');
      request.durableRequestId = persistedRequest.id;
      request.stateRevision = persistedRequest.stateRevision;
      requestIdMap.set(request.id, persistedRequest.id);
    }

    for (const request of input.state.requests) {
      const persistedRequestId = requestIdMap.get(request.id);
      if (!persistedRequestId) continue;

      for (const boost of request.boosts) {
        const clientRequestId = boost.clientRequestId ?? `legacy-${boost.id}`;
        const boostValues = {
          patronUserId: boost.actorUserId ?? request.actorUserId ?? null,
          actorUserId: boost.actorUserId ?? request.actorUserId ?? null,
          idempotencyKey: boost.idempotencyKey ?? null,
          intentFingerprint: boost.idempotencyFingerprint ?? null,
          patronDeviceIdHash: boost.patronDeviceIdHash ?? null,
          status: deriveRequestStatus(request),
          amountCents: Math.round(Number(boost.amount ?? 0) * 100),
          currency: request.currency ?? 'USD',
          runtimeBoostState: boost,
          updatedAt: now
        };
        const [persistedBoost] = boost.durableBoostId && typeof boost.stateRevision === 'number'
          ? await executor
              .update(requestBoosts)
              .set({
                ...boostValues,
                activatedAt: sql`coalesce(${requestBoosts.activatedAt}, ${now})`,
                stateRevision: sql`${requestBoosts.stateRevision} + 1`
              })
              .where(and(
                eq(requestBoosts.id, boost.durableBoostId),
                eq(requestBoosts.requestId, persistedRequestId),
                eq(requestBoosts.gigId, input.activeGigId),
                eq(requestBoosts.stateRevision, boost.stateRevision)
              ))
              .returning({ id: requestBoosts.id, stateRevision: requestBoosts.stateRevision })
          : !boost.durableBoostId
            ? await executor
                .insert(requestBoosts)
                .values({
                  requestId: persistedRequestId,
                  gigId: input.activeGigId,
                  clientRequestId,
                  ...boostValues,
                  activatedAt: now,
                  stateRevision: 0
                })
                .onConflictDoNothing()
                .returning({ id: requestBoosts.id, stateRevision: requestBoosts.stateRevision })
            : [];
        if (!persistedBoost) throw new Error('request_boost_state_revision_conflict');
        boost.durableBoostId = persistedBoost.id;
        boost.stateRevision = persistedBoost.stateRevision;
      }
    }
  }

  return {
    hasDurableStore: Boolean(db),
    hydrateState,
    hydrateStateByGigId,
    listActiveRoomSummaries,
    listTrackedGigIds,
    persistState,
    reserveRequestAction,
    reserveBoostAction,
    shadowRequestForBoostModeration,
    activateRequestAction,
    activateBoostAction,
    beginRoomCloseout,
    resolveCampaignAttribution,
    createGigId: () => randomUUID()
  };
}
