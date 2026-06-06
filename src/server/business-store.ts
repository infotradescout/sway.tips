import { asc, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import type { BackendState, RequestItem, BoostContribution, GigSession } from '../types';
import { createSwayDb } from '../db/client';
import { gigSessions, requestBoosts, requests, users, performers, requestStatusEnum } from '../db/schema';

type DurableSnapshot = {
  state: BackendState;
  activeGigId: string | null;
};

type PersistInput = {
  state: BackendState;
  activeGigId: string | null;
};

const RUNTIME_USER_ID = '00000000-0000-4000-8000-000000000111';

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
    clientRequestId: input.clientRequestId,
    idempotencyKey: input.idempotencyKey,
    idempotencyFingerprint: input.idempotencyFingerprint,
    idempotencyExpiresAt: input.idempotencyExpiresAt
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

export function createBusinessStore(databaseUrl: string | undefined, createInactiveSession: () => GigSession) {
  const db = databaseUrl ? createSwayDb(databaseUrl) : null;

  async function ensureRuntimeUserRow() {
    if (!db) return;

    await db.insert(users).values({
      id: RUNTIME_USER_ID,
      email: null,
      displayName: 'Runtime Owner',
      role: 'performer'
    }).onConflictDoNothing();

  }

  async function ensurePerformerForActor(actorUserId: string | null | undefined) {
    if (!db) return null;

    const ownerUserId = actorUserId ?? RUNTIME_USER_ID;
    await ensureRuntimeUserRow();

    const [existingPerformer] = await db
      .select({ id: performers.id })
      .from(performers)
      .where(eq(performers.ownerUserId, ownerUserId))
      .limit(1);

    if (existingPerformer) {
      return existingPerformer.id;
    }

    const idSuffix = ownerUserId.slice(0, 8).replace(/[^a-z0-9]/gi, '').toLowerCase() || 'runtime';
    const [inserted] = await db.insert(performers).values({
      ownerUserId,
      handle: `runtime-${idSuffix}`,
      displayName: `Runtime ${idSuffix}`,
      bio: null
    }).returning({ id: performers.id });

    return inserted.id;
  }

  async function hydrateState(fallbackState: BackendState): Promise<DurableSnapshot> {
    if (!db) {
      return { state: fallbackState, activeGigId: null };
    }

    const [activeSession] = await db
      .select({
        id: gigSessions.id,
        runtimeSessionState: gigSessions.runtimeSessionState,
        status: gigSessions.status,
        updatedAt: gigSessions.updatedAt
      })
      .from(gigSessions)
      .where(eq(gigSessions.title, 'runtime_active_session'))
      .orderBy(desc(gigSessions.updatedAt))
      .limit(1);

    if (!activeSession) {
      return {
        state: {
          ...fallbackState,
          session: createInactiveSession(),
          requests: [],
          performers: []
        },
        activeGigId: null
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
      .where(eq(requests.gigId, activeSession.id))
      .orderBy(asc(requests.createdAt));

    const boostRows = await db
      .select({
        requestId: requestBoosts.requestId,
        runtimeBoostState: requestBoosts.runtimeBoostState,
        createdAt: requestBoosts.createdAt
      })
      .from(requestBoosts)
      .where(eq(requestBoosts.gigId, activeSession.id))
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
        return request;
      })
      .filter((request): request is RequestItem => Boolean(request));

    const restoredSession = coerceGigSession(activeSession.runtimeSessionState, createInactiveSession());

    return {
      state: {
        session: restoredSession,
        requests: restoredRequests,
        performers: fallbackState.performers
      },
      activeGigId: activeSession.id
    };
  }

  async function persistState(input: PersistInput) {
    if (!db || !input.activeGigId) return;

    await ensureRuntimeUserRow();

    const now = new Date();
    const session = input.state.session;
    const runtimePerformerId = await ensurePerformerForActor(null);
    const performerId = (await ensurePerformerForActor(session.ownerActorUserId ?? null)) ?? runtimePerformerId;

    await db.insert(gigSessions).values({
      id: input.activeGigId,
      performerId,
      ownerActorUserId: session.ownerActorUserId ?? null,
      lastMutationActorUserId: session.lastMutationActorUserId ?? null,
      status: deriveSessionStatus(session.status),
      title: 'runtime_active_session',
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
        title: 'runtime_active_session',
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

    await db.delete(requestBoosts).where(eq(requestBoosts.gigId, input.activeGigId));
    await db.delete(requests).where(eq(requests.gigId, input.activeGigId));

    const requestIdMap = new Map<string, string>();

    for (const request of input.state.requests) {
      const [insertedRequest] = await db.insert(requests).values({
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
        await db.insert(requestBoosts).values({
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
    persistState,
    createGigId: () => randomUUID()
  };
}
