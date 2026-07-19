import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import type { ActiveRoomSummary, BackendState, RequestItem, BoostContribution, GigSession, PerformerProfile } from '../types';
import { createSwayDb, type SwayDb } from '../db/client';
import { normalizePatronStatusReceiptRecords } from './patron-status-receipt';
import {
  activeRoomRegistry,
  gigSessions,
  requestBoosts,
  requests,
  users,
  performers,
  requestStatusEnum
} from '../db/schema';

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
  updatedAt: Date;
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
    totals: input.totals ?? fallback.totals
  };
}

function coerceBoost(raw: unknown): BoostContribution | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Partial<BoostContribution>;
  if (!input.id) return null;
  return {
    id: input.id,
    patronName: input.patronName ?? 'Co-Sponsor',
    amount: Number(input.amount ?? 0),
    timestamp: input.timestamp ?? new Date().toISOString(),
    actorUserId: input.actorUserId ?? null,
    clientRequestId: input.clientRequestId,
    idempotencyKey: input.idempotencyKey,
    idempotencyFingerprint: input.idempotencyFingerprint,
    idempotencyExpiresAt: input.idempotencyExpiresAt,
    paymentId: input.paymentId ?? null,
    paymentIntentId: input.paymentIntentId ?? null,
    paymentStatus: input.paymentStatus ?? null
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
    patronStatusReceipts: normalizePatronStatusReceiptRecords(input.patronStatusReceipts),
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
        createdAt: requests.createdAt
      })
      .from(requests)
      .where(eq(requests.gigId, sessionRow.id))
      .orderBy(asc(requests.createdAt));

    const boostRows = await db
      .select({
        requestId: requestBoosts.requestId,
        runtimeBoostState: requestBoosts.runtimeBoostState,
        createdAt: requestBoosts.createdAt
      })
      .from(requestBoosts)
      .where(eq(requestBoosts.gigId, sessionRow.id))
      .orderBy(asc(requestBoosts.createdAt));

    const boostsByRequestId = new Map<string, BoostContribution[]>();
    for (const row of boostRows) {
      const boost = coerceBoost(row.runtimeBoostState);
      if (!boost) continue;
      const bucket = boostsByRequestId.get(row.requestId) ?? [];
      bucket.push(boost);
      boostsByRequestId.set(row.requestId, bucket);
    }

    const restoredRequests: RequestItem[] = requestRows
      .map((row) => {
        const request = coerceRequest(row.runtimeRequestState);
        if (!request) return null;
        request.status = REVERSE_STATUS_MAP[row.status] ?? request.status;
        request.boosts = boostsByRequestId.get(row.id) ?? request.boosts;
        request.gigId = request.gigId ?? sessionRow.id;
        return request;
      })
      .filter((request): request is RequestItem => Boolean(request));

    const restoredSession = coerceGigSession(sessionRow.runtimeSessionState, createInactiveSession());
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

  async function persistState(input: PersistInput, options?: PersistOptions) {
    const executor = options?.executor ?? db;
    if (!executor || !input.activeGigId) return;

    await ensureRuntimeUserRow(executor);

    const now = new Date();
    const session = input.state.session;
    const runtimePerformerId = await ensurePerformerForActor(executor, null);
    const performerId = (await ensurePerformerForActor(executor, session.ownerActorUserId ?? null)) ?? runtimePerformerId;
    const registryStatus = deriveRegistryStatus(session.status);
    const routePath = `/g/${input.activeGigId}`;

    await executor.insert(gigSessions).values({
      id: input.activeGigId,
      performerId,
      ownerActorUserId: session.ownerActorUserId ?? null,
      lastMutationActorUserId: session.lastMutationActorUserId ?? null,
      status: deriveSessionStatus(session.status),
      title: `runtime_room:${input.activeGigId}`,
      venueName: 'runtime',
      runtimeSessionState: session,
      startedAt: session.status === 'active' || session.status === 'ending' || session.status === 'closed' ? now : null,
      scheduledEndAt: null,
      lastActivityAt: now,
      manualCloseoutStartedAt: session.status === 'ending' ? now : null,
      manualCloseoutCompletedAt: session.status === 'closed' ? now : null,
      autoCloseoutAt: new Date(now.getTime() + 4 * 60 * 60 * 1000),
      autoCloseoutReason: null,
      closeoutPolicy: 'max_started_at_4h_or_scheduled_end_at_30m',
      updatedAt: now
    }).onConflictDoUpdate({
      target: gigSessions.id,
      set: {
        performerId,
        ownerActorUserId: session.ownerActorUserId ?? null,
        lastMutationActorUserId: session.lastMutationActorUserId ?? null,
        status: deriveSessionStatus(session.status),
        title: `runtime_room:${input.activeGigId}`,
        venueName: 'runtime',
        runtimeSessionState: session,
        startedAt: session.status === 'active' || session.status === 'ending' || session.status === 'closed' ? now : null,
        lastActivityAt: now,
        manualCloseoutStartedAt: session.status === 'ending' ? now : null,
        manualCloseoutCompletedAt: session.status === 'closed' ? now : null,
        autoCloseoutAt: new Date(now.getTime() + 4 * 60 * 60 * 1000),
        updatedAt: now
      }
    });

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

    await executor.delete(requestBoosts).where(eq(requestBoosts.gigId, input.activeGigId));
    await executor.delete(requests).where(eq(requests.gigId, input.activeGigId));

    const requestIdMap = new Map<string, string>();

    for (const request of input.state.requests) {
      const [insertedRequest] = await executor.insert(requests).values({
        gigId: input.activeGigId,
        patronUserId: request.actorUserId ?? null,
        lastMutationActorUserId: request.lastMutationActorUserId ?? request.actorUserId ?? null,
        clientRequestId: request.clientRequestId ?? `legacy-${request.id}`,
        status: deriveRequestStatus(request),
        requestType: deriveRequestType(request),
        amountCents: request.amountCents ?? Math.round(Number(request.amount ?? 0) * 100),
        currency: request.currency ?? 'USD',
        message: request.message ?? null,
        runtimeRequestState: request,
        updatedAt: now
      }).returning({ id: requests.id });

      requestIdMap.set(request.id, insertedRequest.id);
    }

    for (const request of input.state.requests) {
      const persistedRequestId = requestIdMap.get(request.id);
      if (!persistedRequestId) continue;

      for (const boost of request.boosts) {
        await executor.insert(requestBoosts).values({
          requestId: persistedRequestId,
          gigId: input.activeGigId,
          patronUserId: boost.actorUserId ?? request.actorUserId ?? null,
          actorUserId: boost.actorUserId ?? request.actorUserId ?? null,
          status: deriveRequestStatus(request),
          amountCents: Math.round(Number(boost.amount ?? 0) * 100),
          currency: request.currency ?? 'USD',
          runtimeBoostState: boost,
          updatedAt: now
        });
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
    createGigId: () => randomUUID()
  };
}
