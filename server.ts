/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from "express";
import path from "path";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { ActiveRoomSummary, BackendState, RequestItem, GigSession, BoostContribution } from "./src/types";
import { createSwayDb } from "./src/db/client";
import { activeBlocks, moderationEvents } from "./src/db/schema";
import { createAccessControl, routeFamilyGuard } from "./src/server/access-control";
import { createIdempotencyStore, type DurableActionInput } from "./src/server/idempotency-store";
import { createModerationService, type BlockScope } from "./src/server/moderation-service";
import { createBusinessStore } from "./src/server/business-store";
import { toAuditEntityUuid, writeAuditEvent } from "./src/server/audit-log";
import { createConfiguredPaymentProvider } from "./src/server/payment-provider";
import { createPaymentService } from "./src/server/payment-service";
import { createPaymentWebhookService } from "./src/server/payment-webhook";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT ?? 3000);
const isProduction = process.env.NODE_ENV === "production";
const IDEMPOTENCY_TTL_HOURS = 48;
const MAX_REQUESTS_PER_DEVICE_PER_SESSION = 8;
const MAX_CUSTOM_NOTES_PER_DEVICE_PER_SESSION = 4;
const MAX_BOOSTS_PER_DEVICE_PER_SESSION = 12;
const accessControl = createAccessControl({
  databaseUrl: process.env.DATABASE_URL,
  isProduction
});
const idempotencyStore = createIdempotencyStore(process.env.DATABASE_URL);
const moderationService = createModerationService(process.env.DATABASE_URL);
const businessStore = createBusinessStore(process.env.DATABASE_URL, createInactiveSession);
const businessDb = process.env.DATABASE_URL ? createSwayDb(process.env.DATABASE_URL) : null;
const paymentProvider = createConfiguredPaymentProvider(process.env);
const paymentService = createPaymentService({
  databaseUrl: process.env.DATABASE_URL,
  provider: paymentProvider
});
const paymentWebhookService = paymentProvider
  ? createPaymentWebhookService({ databaseUrl: process.env.DATABASE_URL, provider: paymentProvider })
  : null;

function resolveGitValue(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim() || null;
  } catch {
    return null;
  }
}

function applyNoStoreHeaders(res: express.Response) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
}

const buildMarker = {
  service: 'sway.tips',
  commit: process.env.RENDER_GIT_COMMIT
    ?? process.env.COMMIT_SHA
    ?? process.env.GIT_COMMIT
    ?? resolveGitValue(['rev-parse', 'HEAD'])
    ?? 'unknown',
  branch: process.env.RENDER_GIT_BRANCH
    ?? process.env.GITHUB_REF_NAME
    ?? process.env.VERCEL_GIT_COMMIT_REF
    ?? process.env.GIT_BRANCH
    ?? resolveGitValue(['rev-parse', '--abbrev-ref', 'HEAD'])
    ?? 'unknown',
  buildTimestamp: process.env.SWAY_BUILD_TIMESTAMP
    ?? process.env.RENDER_BUILD_CREATED_AT
    ?? process.env.BUILD_TIMESTAMP
    ?? new Date().toISOString(),
  nodeEnv: process.env.NODE_ENV ?? 'unknown'
};

const ROOM_LOOKUP_UNAVAILABLE_COPY = 'Live room unavailable. Scan the performer QR again or request a fresh room link.';
const ROOM_LOOKUP_ENDED_COPY = 'This live room session has ended. Thank you for supporting the performer!';

// Capture the raw request body so Stripe webhook signatures can be verified.
app.use(express.json({
  verify: (req, _res, buf) => {
    (req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf8');
  }
}));

app.use((_req, res, next) => {
  res.setHeader('x-sway-build', `${buildMarker.commit}:${buildMarker.buildTimestamp}`);
  res.setHeader('x-commit-sha', buildMarker.commit);
  next();
});

type SwayShell = 'public' | 'patron' | 'talent' | 'overlay' | 'admin' | 'dev-sandbox';

function normalizeHost(rawHost: string | undefined): string {
  if (!rawHost) return '';
  return rawHost.split(':')[0].trim().toLowerCase();
}

function resolveShellForRoute(urlPath: string, rawHost?: string): SwayShell {
  const host = normalizeHost(rawHost);
  const isAppSubdomain = host === 'app.sway.tips';
  const isPublicHost = host === '' || host === 'sway.tips' || host === 'www.sway.tips' || host === 'localhost' || host === '127.0.0.1';

  if (urlPath === '/' || urlPath === '/home') {
    if (isAppSubdomain) return 'patron';
    if (isPublicHost) return 'public';
    return 'patron';
  }
  if (urlPath.startsWith('/talent')) return 'talent';
  if (urlPath.startsWith('/overlay')) return 'overlay';
  if (urlPath.startsWith('/admin')) return 'admin';
  if (urlPath === '/dev/sandbox' || urlPath.startsWith('/dev-sandbox')) return 'dev-sandbox';
  if (urlPath.startsWith('/g/') || urlPath.startsWith('/p/')) return 'patron';
  return 'patron';
}

function shellHtmlRelativePath(shell: SwayShell): string {
  return `shells/${shell}.html`;
}

function isShellAllowed(shell: SwayShell): boolean {
  return !(isProduction && shell === 'dev-sandbox');
}

app.use((req, _res, next) => {
  req.headers['x-sway-shell'] = resolveShellForRoute(req.path, typeof req.headers.host === 'string' ? req.headers.host : undefined);
  next();
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/assets') || req.path.startsWith('/shells')) {
    next();
    return;
  }
  routeFamilyGuard(accessControl)(req, res, next);
});

const systemRequestPresets = [
  { id: "p-sys-15", label: "Speed Round", duration: 15, isSystem: true },
  { id: "p-sys-30", label: "Mid-Gig Rush", duration: 30, isSystem: true },
  { id: "p-sys-45", label: "Main Stage Vibe", duration: 45, isSystem: true }
];

function createInactiveSession(): GigSession {
  return {
    status: 'inactive',
    ownerActorUserId: null,
    lastMutationActorUserId: null,
    talentName: "",
    talentRole: 'DJ',
    feeType: 'patron',
    minimumTip: 5,
    endGigTimerStartedAt: null,
    isFeatured: false,
    featuredExpiresAt: null,
    featuredCost: 0,
    featuredDurationHours: 0,
    requestsOpen: true,
    requestWindowMode: 'manual',
    requestWindowExpiresAt: null,
    requestWindowDuration: null,
    requestWindowLabel: null,
    requestPresets: [...systemRequestPresets],
    operatingMode: 'manual',
    totals: {
      totalTips: 0,
      accumulatedFees: 0,
      totalCount: 0,
      topRequest: "None yet"
    }
  };
}

// Development-only state. Production must use a persistent business store.
function createEmptyBackendState(): BackendState {
  return {
    session: createInactiveSession(),
    requests: [],
    performers: [],
    activeGigId: null
  };
}

let state: BackendState = createEmptyBackendState();
let activeGigId: string | null = null;

function syncActiveGigRouteContext(inputState: BackendState, gigId: string | null = activeGigId) {
  inputState.activeGigId = inputState.session.status === 'active' ? (gigId ?? null) : null;
}

function prepareRoomState(inputState: BackendState, gigId: string | null) {
  syncActiveGigRouteContext(inputState, gigId);
  syncActivePerformer(inputState);
  return inputState;
}

async function refreshBusinessState() {
  const snapshot = await businessStore.hydrateState(state);
  state = prepareRoomState(snapshot.state, snapshot.activeGigId);
  activeGigId = state.activeGigId;
  return snapshot;
}

async function persistBusinessState() {
  prepareRoomState(state, activeGigId);
  await businessStore.persistState({ state, activeGigId });
}

async function loadRoomState(gigId: string) {
  if (!businessStore.hasDurableStore) {
    if (state.activeGigId === gigId) {
      const fallbackState = prepareRoomState(state, gigId);
      return {
        state: fallbackState,
        activeGigId: fallbackState.activeGigId,
        roomStatus: fallbackState.session.status === 'closed'
          ? 'ended' as const
          : fallbackState.session.status === 'active'
            ? 'active' as const
            : 'inactive' as const
      };
    }

    return {
      state: createEmptyBackendState(),
      activeGigId: null,
      roomStatus: 'missing' as const
    };
  }

  const snapshot = await businessStore.hydrateStateByGigId(gigId, createEmptyBackendState());
  return {
    ...snapshot,
    state: prepareRoomState(snapshot.state, snapshot.activeGigId)
  };
}

async function persistBusinessStateForRoom(roomState: BackendState, gigId: string) {
  const preparedState = prepareRoomState(roomState, gigId);

  if (!businessStore.hasDurableStore) {
    state = preparedState;
    activeGigId = preparedState.activeGigId;
    return;
  }

  await businessStore.persistState({ state: preparedState, activeGigId: gigId });

  if (activeGigId === gigId) {
    state = preparedState;
    activeGigId = preparedState.activeGigId;
  }
}

async function resolveLegacyWritableRoom(req: express.Request, res: express.Response) {
  await refreshBusinessState();

  const requestedGigId = parseDurableGigId(req.body?.gig_id);
  const targetGigId = requestedGigId ?? activeGigId;

  if (!targetGigId) {
    res.status(409).json({
      error: 'A specific live room must be selected before this action can continue.'
    });
    return null;
  }

  const roomSnapshot = await loadRoomState(targetGigId);
  if (roomSnapshot.roomStatus === 'missing') {
    res.status(404).json({ error: ROOM_LOOKUP_UNAVAILABLE_COPY });
    return null;
  }
  if (roomSnapshot.roomStatus === 'ended') {
    res.status(410).json({ error: ROOM_LOOKUP_ENDED_COPY });
    return null;
  }

  return {
    gigId: targetGigId,
    state: roomSnapshot.state
  };
}

async function findRoomStateByRequestId(requestId: string) {
  if (!businessStore.hasDurableStore) {
    const request = state.requests.find((item) => item.id === requestId);
    if (!request) return null;
    return {
      gigId: request.gigId ?? activeGigId,
      state,
      request
    };
  }

  const trackedGigIds = await businessStore.listTrackedGigIds();
  const seenGigIds = new Set<string>();

  for (const gigId of trackedGigIds) {
    if (seenGigIds.has(gigId)) continue;
    seenGigIds.add(gigId);

    const roomSnapshot = await loadRoomState(gigId);
    const request = roomSnapshot.state.requests.find((item) => item.id === requestId);
    if (request) {
      return {
        gigId,
        state: roomSnapshot.state,
        request
      };
    }
  }

  return null;
}

function buildActiveRoomSummary(roomState: BackendState, gigId: string, startedAt: string | null = null): ActiveRoomSummary {
  return {
    gigId,
    performerName: roomState.session.talentName || 'Unassigned performer',
    talentRole: roomState.session.talentRole,
    routePath: `/g/${gigId}`,
    startedAt,
    requestCount: roomState.requests.filter((request) => !request.hidden && !request.removed).length
  };
}

async function listReadableActiveRooms(): Promise<ActiveRoomSummary[]> {
  if (!businessStore.hasDurableStore) {
    await refreshBusinessState();
    return activeGigId ? [buildActiveRoomSummary(state, activeGigId)] : [];
  }

  return businessStore.listActiveRoomSummaries();
}

function requirePersistentBusinessStore(res: express.Response): boolean {
  if (!isProduction || businessStore.hasDurableStore) return true;
  res.status(503).json({
    error: "Persistent business store is not configured. Production routes cannot use in-memory gig, request, or ledger state."
  });
  return false;
}

function hashPayload(payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(payload ?? {}))
    .digest('hex');
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseDurableGigId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return UUID_PATTERN.test(trimmed) ? trimmed : null;
}

function canonicalJson(input: Record<string, string | number>): string {
  const orderedInput = {
    v: Number(input.v),
    idempotency_key: String(input.idempotency_key),
    patron_device_id_hash: String(input.patron_device_id_hash),
    gig_id: String(input.gig_id),
    action_type: String(input.action_type),
    target_entity_id: String(input.target_entity_id),
    amount_cents: Math.trunc(Number(input.amount_cents)),
    currency: String(input.currency).toUpperCase(),
    payload_hash: String(input.payload_hash)
  };

  return JSON.stringify(orderedInput);
}

function createIdempotencyFingerprint(input: {
  idempotency_key: string;
  patron_device_id_hash: string;
  gig_id: string;
  action_type: string;
  target_entity_id: string;
  amount_cents: number;
  currency: string;
  payload_hash: string;
}): string {
  const canonicalInput = canonicalJson({
    v: 1,
    idempotency_key: input.idempotency_key,
    patron_device_id_hash: input.patron_device_id_hash,
    gig_id: input.gig_id,
    action_type: input.action_type,
    target_entity_id: input.target_entity_id,
    amount_cents: Math.trunc(Number(input.amount_cents)),
    currency: input.currency.toUpperCase(),
    payload_hash: input.payload_hash
  });

  return createHash('sha256')
    .update(canonicalInput, 'utf8')
    .digest('hex');
}

function syncActivePerformer(inputState: BackendState) {
  if (inputState.session.status === 'inactive' || !inputState.session.talentName) {
    inputState.performers = [];
    return;
  }

  const activePerformer = {
    id: "p-active",
    name: inputState.session.talentName,
    role: inputState.session.talentRole,
    venueName: "Current gig",
    isFeatured: inputState.session.isFeatured,
    featuredExpiresAt: inputState.session.featuredExpiresAt,
    minimumTip: inputState.session.minimumTip,
    avatarUrl: ""
  };

  const existingIndex = inputState.performers.findIndex(p => p.id === activePerformer.id);
  if (existingIndex >= 0) {
    inputState.performers[existingIndex] = activePerformer;
  } else {
    inputState.performers = [activePerformer];
  }
}

function resolveActorUserId(req: express.Request): string | null {
  return accessControl.resolveServerActor(req).actorId;
}

type ProtectedMutationActor = {
  actorId: string;
  actorType: string;
};

async function resolveProtectedMutationActor(req: express.Request, res: express.Response, gigId?: string | null): Promise<ProtectedMutationActor | null> {
  if (!requirePersistentBusinessStore(res)) {
    return null;
  }

  if (gigId) {
    const result = await accessControl.requireGigMutationAccess(req, gigId);
    if (result.allowed === false) {
      res.status(result.status).json({ error: result.reason });
      return null;
    }

    if (!result.actor.actorId) {
      res.status(401).json({ error: 'Sway actor resolution required.' });
      return null;
    }

    return {
      actorId: result.actor.actorId,
      actorType: result.role ?? 'unknown'
    };
  }

  const talentResult = await accessControl.requireTalentAccess(req);
  if (talentResult.allowed) {
    if (!talentResult.actor.actorId) {
      res.status(401).json({ error: 'Sway actor resolution required.' });
      return null;
    }

    return {
      actorId: talentResult.actor.actorId,
      actorType: talentResult.role ?? 'performer'
    };
  }

  const privilegedResult = await accessControl.requireAdminOrSupportAccess(req);
  if (privilegedResult.allowed === false) {
    res.status(privilegedResult.status).json({ error: privilegedResult.reason });
    return null;
  }

  if (!privilegedResult.actor.actorId) {
    res.status(401).json({ error: 'Sway actor resolution required.' });
    return null;
  }

  return {
    actorId: privilegedResult.actor.actorId,
    actorType: privilegedResult.role ?? 'unknown'
  };
}

async function persistStateWithAudit(input: {
  roomState: BackendState;
  gigId: string;
  actor: ProtectedMutationActor;
  entityType: string;
  entityId: string;
  eventType: string;
  previousStatus?: string | null;
  nextStatus?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const preparedState = prepareRoomState(input.roomState, input.gigId);

  if (!businessDb) {
    await persistBusinessStateForRoom(preparedState, input.gigId);
    return;
  }

  await businessDb.transaction(async (tx) => {
    await businessStore.persistState({ state: preparedState, activeGigId: input.gigId }, { executor: tx as any });
    await writeAuditEvent(tx, {
      actorId: input.actor.actorId,
      actorType: input.actor.actorType,
      entityType: input.entityType,
      entityId: input.entityId,
      eventType: input.eventType,
      previousStatus: input.previousStatus,
      nextStatus: input.nextStatus,
      metadata: input.metadata
    });
  });

  if (activeGigId === input.gigId) {
    state = preparedState;
    activeGigId = preparedState.activeGigId;
  }
}

// 5-Minute Timer Closeout Routine Worker
setInterval(async () => {
  if (!businessStore.hasDurableStore) {
    await refreshBusinessState();

    let changed = false;

    if (state.session.status === 'ending' && state.session.endGigTimerStartedAt) {
      const startTimeStamp = new Date(state.session.endGigTimerStartedAt).getTime();
      const elapsedTime = Date.now() - startTimeStamp;

      if (elapsedTime >= 300000) {
        console.log("Post-gig timer expired. Releasing pending requests.");
        executeAutoNuke(state);
        changed = true;
      }
    }

    if (state.session.isFeatured && state.session.featuredExpiresAt) {
      if (Date.now() > new Date(state.session.featuredExpiresAt).getTime()) {
        console.log("Featured Performer status has expired!");
        state.session.isFeatured = false;
        state.session.featuredExpiresAt = null;
        state.session.featuredCost = 0;
        state.session.featuredDurationHours = 0;
        changed = true;
      }
    }

    if (state.session.requestsOpen && state.session.requestWindowMode === 'preset' && state.session.requestWindowExpiresAt) {
      if (Date.now() > new Date(state.session.requestWindowExpiresAt).getTime()) {
        console.log("Request custom window expired! Closing requests automatically.");
        state.session.requestsOpen = false;
        state.session.requestWindowExpiresAt = null;
        state.session.requestWindowDuration = null;
        state.session.requestWindowLabel = null;
        changed = true;
      }
    }

    syncActivePerformer(state);
    if (changed) {
      await persistBusinessState();
    }
    return;
  }

  const trackedGigIds = await businessStore.listTrackedGigIds();

  for (const trackedGigId of trackedGigIds) {
    const roomSnapshot = await loadRoomState(trackedGigId);
    const roomState = roomSnapshot.state;
    let changed = false;

    if (roomState.session.status === 'ending' && roomState.session.endGigTimerStartedAt) {
      const startTimeStamp = new Date(roomState.session.endGigTimerStartedAt).getTime();
      const elapsedTime = Date.now() - startTimeStamp;

      if (elapsedTime >= 300000) {
        console.log("Post-gig timer expired. Releasing pending requests.");
        executeAutoNuke(roomState);
        changed = true;
      }
    }

    if (roomState.session.isFeatured && roomState.session.featuredExpiresAt) {
      if (Date.now() > new Date(roomState.session.featuredExpiresAt).getTime()) {
        console.log("Featured Performer status has expired!");
        roomState.session.isFeatured = false;
        roomState.session.featuredExpiresAt = null;
        roomState.session.featuredCost = 0;
        roomState.session.featuredDurationHours = 0;
        changed = true;
      }
    }

    if (roomState.session.requestsOpen && roomState.session.requestWindowMode === 'preset' && roomState.session.requestWindowExpiresAt) {
      if (Date.now() > new Date(roomState.session.requestWindowExpiresAt).getTime()) {
        console.log("Request custom window expired! Closing requests automatically.");
        roomState.session.requestsOpen = false;
        roomState.session.requestWindowExpiresAt = null;
        roomState.session.requestWindowDuration = null;
        roomState.session.requestWindowLabel = null;
        changed = true;
      }
    }

    if (changed) {
      await persistBusinessStateForRoom(roomState, trackedGigId);
    }
  }

  await refreshBusinessState();
}, 10000); // Check every 10 seconds for tighter precision

function executeAutoNuke(inputState: BackendState) {
  inputState.requests = inputState.requests.map(req => {
    if (req.status === 'hold') {
      return { ...req, status: 'denied' };
    }
    return req;
  });
  inputState.session.status = 'closed';
  inputState.session.endGigTimerStartedAt = null;

  // Compute final totals
  recalculateTotals(inputState);
}

function recalculateTotals(inputState: BackendState) {
  const fulfilledItems = inputState.requests.filter(r => r.status === 'fulfilled');
  const totalTips = fulfilledItems.reduce((acc, curr) => acc + curr.amount, 0);
  const totalCount = fulfilledItems.length;
  const accumulatedFees = (inputState.requests.filter(r => r.status !== 'denied').reduce((acc, curr) => acc + curr.sponsorCount, 0)) * 1.0;

  // Find top requested item
  const counts: Record<string, number> = {};
  fulfilledItems.forEach(r => {
    if (r.type === 'request') {
      counts[r.title] = (counts[r.title] || 0) + r.amount;
    }
  });
  let topRequest = "No requests fulfilled yet";
  let maxAmount = 0;
  for (const [title, amt] of Object.entries(counts)) {
    if (amt > maxAmount) {
      maxAmount = amt;
      topRequest = title;
    }
  }

  inputState.session.totals = {
    totalTips,
    accumulatedFees,
    totalCount,
    topRequest
  };
}

// API Routes
app.get("/api/health/network-probe", (_req, res) => {
  res.status(204).end();
});

app.get("/api/build-marker", (_req, res) => {
  applyNoStoreHeaders(res);
  res.json(buildMarker);
});

const shellTelemetryAllowedEvents = new Set([
  'telemetry_friction_patron_no_session_recovery_viewed',
  'telemetry_friction_patron_no_session_return_home_clicked',
  'room_entry_viewed',
  'room_entry_recovery_viewed',
  'share_link_copied',
  'request_started',
  'boost_started'
]);

const shellTelemetryAllowedKeys = new Set([
  'shell',
  'surface',
  'event',
  'route_family',
  'has_route_context',
  'has_session_context',
  'build_commit'
]);

const shellTelemetrySensitiveKeys = new Set([
  'card',
  'cvc',
  'cvv',
  'pan',
  'token',
  'secret',
  'cookie',
  'authorization',
  'session',
  'jwt',
  'email',
  'phone',
  'name',
  'message',
  'note',
  'request',
  'query',
  'url',
  'headers',
  'device',
  'location',
  'latitude',
  'longitude',
  'amount',
  'payment',
  'stripe'
]);

type ShellTelemetryPayload = {
  shell: 'patron' | 'talent';
  surface: 'recovery-view' | 'room-entry' | 'share-kit';
  event: string;
  route_family: string;
  has_route_context: boolean;
  has_session_context: boolean;
  build_commit: string;
};

function validateShellTelemetryPayload(body: unknown): { ok: true; payload: ShellTelemetryPayload } | { ok: false; status: number; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'Shell telemetry payload must be a JSON object.' };
  }

  const payload = body as Record<string, unknown>;
  const keys = Object.keys(payload);

  for (const key of keys) {
    if (shellTelemetrySensitiveKeys.has(key)) {
      return { ok: false, status: 400, error: `Sensitive telemetry field rejected: ${key}` };
    }
    if (!shellTelemetryAllowedKeys.has(key)) {
      return { ok: false, status: 400, error: `Unexpected telemetry field rejected: ${key}` };
    }
  }

  for (const key of shellTelemetryAllowedKeys) {
    if (!(key in payload)) {
      return { ok: false, status: 400, error: `Missing telemetry field: ${key}` };
    }
  }

  if (payload.shell !== 'patron' && payload.shell !== 'talent') {
    return { ok: false, status: 400, error: 'Shell telemetry requires shell=patron or shell=talent.' };
  }
  if (payload.surface !== 'recovery-view' && payload.surface !== 'room-entry' && payload.surface !== 'share-kit') {
    return { ok: false, status: 400, error: 'Shell telemetry requires a supported funnel surface.' };
  }
  if (typeof payload.event !== 'string' || !shellTelemetryAllowedEvents.has(payload.event)) {
    return { ok: false, status: 400, error: 'Unknown shell telemetry event.' };
  }
  if (typeof payload.route_family !== 'string' || payload.route_family.length === 0 || /[?&=#]/.test(payload.route_family)) {
    return { ok: false, status: 400, error: 'route_family must be a coarse, query-free string.' };
  }
  if (typeof payload.has_route_context !== 'boolean' || typeof payload.has_session_context !== 'boolean') {
    return { ok: false, status: 400, error: 'Shell telemetry context flags must be boolean.' };
  }
  if (typeof payload.build_commit !== 'string' || payload.build_commit.length === 0 || payload.build_commit.length > 128) {
    return { ok: false, status: 400, error: 'build_commit must be a non-empty string.' };
  }

  return {
    ok: true,
    payload: {
      shell: payload.shell,
      surface: payload.surface,
      event: payload.event,
      route_family: payload.route_family,
      has_route_context: payload.has_route_context,
      has_session_context: payload.has_session_context,
      build_commit: payload.build_commit
    }
  };
}

app.post("/api/analytics/shell", async (req, res) => {
  if (!req.is('application/json')) {
    return res.status(415).json({ error: 'Shell telemetry requires application/json.' });
  }

  const validation = validateShellTelemetryPayload(req.body);
  if (validation.ok === false) {
    return res.status(validation.status).json({ error: validation.error });
  }

  if (!businessDb) {
    return res.status(503).json({ error: 'Audit store unavailable for shell telemetry.' });
  }

  const { payload } = validation;

  try {
    await businessDb.transaction(async (tx) => {
      await writeAuditEvent(tx, {
        actorId: null,
        actorType: 'system',
        entityType: 'shell_friction',
        entityId: `${payload.shell}:${payload.surface}:${payload.event}:${payload.route_family}`,
        eventType: payload.event,
        metadata: payload
      });
    });
    return res.status(202).json({ accepted: true });
  } catch {
    return res.status(500).json({ error: 'Unable to capture shell telemetry event.' });
  }
});

// Stripe webhook ingestion. Signature verification is mandatory and the payment
// is resolved from the verified PaymentIntent id, never from request input.
app.post("/api/payment/webhook", async (req, res) => {
  if (!paymentWebhookService) {
    return res.status(503).json({ error: "Payment provider is not configured." });
  }
  const rawBody = (req as express.Request & { rawBody?: string }).rawBody;
  if (typeof rawBody !== 'string') {
    return res.status(400).json({ error: "Raw request body unavailable for signature verification." });
  }
  const signatureHeader = req.header('stripe-signature') ?? null;
  try {
    const result = await paymentWebhookService.ingestWebhook({ rawBody, signatureHeader });
    return res.json({ received: true, result });
  } catch (error) {
    return res.status(400).json({
      error: error instanceof Error ? error.message : 'Webhook processing failed.'
    });
  }
});

app.get("/api/state", async (req, res) => {
  await refreshBusinessState();
  const talentAccess = await accessControl.requireTalentAccess(req);
  applyNoStoreHeaders(res);
  res.json({
    session: state.session,
    requests: state.requests,
    performers: state.performers,
    activeGigId: talentAccess.allowed ? state.activeGigId : null
  });
});

app.get("/api/state/:gigId", async (req, res) => {
  applyNoStoreHeaders(res);

  const requestedGigId = parseDurableGigId(req.params.gigId);
  if (!requestedGigId) {
    return res.status(404).json({
      error: ROOM_LOOKUP_UNAVAILABLE_COPY,
      message: ROOM_LOOKUP_UNAVAILABLE_COPY,
      room_lookup: 'missing'
    });
  }

  const roomSnapshot = await loadRoomState(requestedGigId);

  if (roomSnapshot.roomStatus === 'missing') {
    return res.status(404).json({
      error: ROOM_LOOKUP_UNAVAILABLE_COPY,
      message: ROOM_LOOKUP_UNAVAILABLE_COPY,
      room_lookup: 'missing'
    });
  }

  if (roomSnapshot.roomStatus === 'ended') {
    return res.status(410).json({
      error: ROOM_LOOKUP_ENDED_COPY,
      message: ROOM_LOOKUP_ENDED_COPY,
      room_lookup: 'ended'
    });
  }

  if (roomSnapshot.roomStatus !== 'active') {
    return res.status(404).json({
      error: ROOM_LOOKUP_UNAVAILABLE_COPY,
      message: ROOM_LOOKUP_UNAVAILABLE_COPY,
      room_lookup: 'missing'
    });
  }

  return res.json({
    session: roomSnapshot.state.session,
    requests: roomSnapshot.state.requests,
    performers: roomSnapshot.state.performers,
    activeGigId: roomSnapshot.state.activeGigId,
    room_lookup: 'active'
  });
});

app.get("/api/talent/active-rooms", async (req, res) => {
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) {
    return res.status(talentAccess.status).json({ error: talentAccess.reason });
  }

  applyNoStoreHeaders(res);
  return res.json({ rooms: await listReadableActiveRooms() });
});

app.get("/api/admin/active-rooms", async (req, res) => {
  const adminAccess = await accessControl.requireAdminOrSupportAccess(req);
  if (adminAccess.allowed === false) {
    return res.status(adminAccess.status).json({ error: adminAccess.reason });
  }

  applyNoStoreHeaders(res);
  return res.json({ rooms: await listReadableActiveRooms() });
});

app.post("/api/pending-action/reconcile", async (req, res) => {
  const { client_request_id, idempotency_key } = req.body;
  if (!client_request_id || !idempotency_key) {
    return res.status(400).json({ error: "client_request_id and idempotency_key are required." });
  }

  const result = await idempotencyStore.reconcilePendingAction({
    clientRequestId: client_request_id,
    idempotencyKey: idempotency_key
  });

  if (result.status === 'unavailable') {
    return res.status(503).json({ error: "Durable pending action reconciliation is not configured." });
  }
  if (result.status === 'expired') {
    return res.status(410).json({ error: "Pending action expired before backend confirmation." });
  }

  return res.json(result);
});

app.post("/api/session/start", async (req, res) => {
  const actor = await resolveProtectedMutationActor(req, res);
  if (!actor) return;
  await refreshBusinessState();
  const { talentName, talentRole, feeType, minimumTip, gig_id } = req.body;

  const requestedGigId = parseDurableGigId(gig_id);
  const roomGigId = requestedGigId ?? businessStore.createGigId();
  const roomState = createEmptyBackendState();

  roomState.session = {
    status: 'active',
    ownerActorUserId: actor.actorId,
    lastMutationActorUserId: actor.actorId,
    talentName: talentName || "DJ Pro",
    talentRole: talentRole || 'DJ',
    feeType: feeType || 'patron',
    minimumTip: Number(minimumTip) || 5,
    endGigTimerStartedAt: null,
    isFeatured: false,
    featuredExpiresAt: null,
    featuredCost: 0,
    featuredDurationHours: 0,
    requestsOpen: true,
    requestWindowMode: 'manual',
    requestWindowExpiresAt: null,
    requestWindowDuration: null,
    requestWindowLabel: null,
    requestPresets: [...systemRequestPresets],
    operatingMode: 'manual',
    totals: {
      totalTips: 0,
      accumulatedFees: 0,
      totalCount: 0,
      topRequest: "None yet"
    }
  };
  roomState.requests = [];
  activeGigId = roomGigId;
  state = prepareRoomState(roomState, roomGigId);
  await persistStateWithAudit({
    roomState,
    gigId: roomGigId,
    actor,
    entityType: 'gig_session',
    entityId: roomGigId,
    eventType: 'session.start',
    previousStatus: null,
    nextStatus: roomState.session.status,
    metadata: {
      talentName: roomState.session.talentName,
      talentRole: roomState.session.talentRole,
      feeType: roomState.session.feeType,
      minimumTip: roomState.session.minimumTip
    }
  });
  res.json({ success: true, state: prepareRoomState(roomState, roomGigId) });
});

app.post("/api/session/feature", async (req, res) => {
  const roomContext = await resolveLegacyWritableRoom(req, res);
  if (!roomContext) return;
  const actor = await resolveProtectedMutationActor(req, res, roomContext.gigId);
  if (!actor) return;
  const { hours, cost, activate } = req.body;
  const roomState = roomContext.state;
  const wasFeatured = roomState.session.isFeatured;
  
  if (activate) {
    roomState.session.isFeatured = true;
    roomState.session.featuredExpiresAt = new Date(Date.now() + Number(hours) * 3600000).toISOString();
    roomState.session.featuredCost = Number(cost) || 0;
    roomState.session.featuredDurationHours = Number(hours) || 1;
  } else {
    roomState.session.isFeatured = false;
    roomState.session.featuredExpiresAt = null;
    roomState.session.featuredCost = 0;
    roomState.session.featuredDurationHours = 0;
  }
  roomState.session.lastMutationActorUserId = actor.actorId;

  await persistStateWithAudit({
    roomState,
    gigId: roomContext.gigId,
    actor,
    entityType: 'gig_session',
    entityId: roomContext.gigId,
    eventType: activate ? 'session.feature.enable' : 'session.feature.disable',
    previousStatus: wasFeatured ? 'featured' : 'not_featured',
    nextStatus: roomState.session.isFeatured ? 'featured' : 'not_featured',
    metadata: {
      featuredDurationHours: roomState.session.featuredDurationHours,
      featuredCost: roomState.session.featuredCost,
      featuredExpiresAt: roomState.session.featuredExpiresAt
    }
  });
  res.json({ success: true, state: prepareRoomState(roomState, roomContext.gigId) });
});

app.post("/api/session/end", async (req, res) => {
  const roomContext = await resolveLegacyWritableRoom(req, res);
  if (!roomContext) return;
  const actor = await resolveProtectedMutationActor(req, res, roomContext.gigId);
  if (!actor) return;
  const roomState = roomContext.state;
  if (roomState.session.status !== 'active') {
    return res.status(400).json({ error: "No active session to end." });
  }
  const previousStatus = roomState.session.status;
  roomState.session.status = 'ending';
  roomState.session.endGigTimerStartedAt = new Date().toISOString();
  roomState.session.lastMutationActorUserId = actor.actorId;
  await persistStateWithAudit({
    roomState,
    gigId: roomContext.gigId,
    actor,
    entityType: 'gig_session',
    entityId: roomContext.gigId,
    eventType: 'session.end',
    previousStatus,
    nextStatus: roomState.session.status,
    metadata: {
      endGigTimerStartedAt: roomState.session.endGigTimerStartedAt
    }
  });
  res.json({ success: true, state: prepareRoomState(roomState, roomContext.gigId) });
});

app.post("/api/session/closeout", async (req, res) => {
  const roomContext = await resolveLegacyWritableRoom(req, res);
  if (!roomContext) return;
  const actor = await resolveProtectedMutationActor(req, res, roomContext.gigId);
  if (!actor) return;
  const roomState = roomContext.state;
  const previousStatus = roomState.session.status;
  executeAutoNuke(roomState);
  roomState.session.lastMutationActorUserId = actor.actorId;

  // Closeout totals are sourced from captured payment records in the database,
  // never from runtime arrays. Disabled provider mode reports zero captured funds.
  let closeoutTotals: Awaited<ReturnType<typeof paymentService.aggregateCapturedTotals>> | null = null;
  if (paymentService.hasDurableStore) {
    closeoutTotals = await paymentService.aggregateCapturedTotals(roomContext.gigId);
    roomState.session.totals.totalTips = closeoutTotals.capturedSubtotalCents / 100;
    roomState.session.totals.accumulatedFees = closeoutTotals.platformFeeCents / 100;
    roomState.session.totals.totalCount = closeoutTotals.capturedCount;
  }

  await persistStateWithAudit({
    roomState,
    gigId: roomContext.gigId,
    actor,
    entityType: 'gig_session',
    entityId: roomContext.gigId,
    eventType: 'session.closeout',
    previousStatus,
    nextStatus: roomState.session.status,
    metadata: {
      autoNukeApplied: true,
      closeoutTotalsSource: closeoutTotals ? closeoutTotals.source : 'provider_disabled',
      capturedTotalCents: closeoutTotals ? closeoutTotals.capturedTotalCents : 0
    }
  });
  res.json({ success: true, state: prepareRoomState(roomState, roomContext.gigId), closeoutTotals });
});

// REQUEST WINDOW MANAGERS & PRESETS ENDPOINTS

// Toggle overall requests status (Manual Mode)
app.post("/api/session/window/toggle", async (req, res) => {
  const roomContext = await resolveLegacyWritableRoom(req, res);
  if (!roomContext) return;
  const actor = await resolveProtectedMutationActor(req, res, roomContext.gigId);
  if (!actor) return;
  const { open } = req.body;
  const roomState = roomContext.state;
  const previousStatus = roomState.session.requestsOpen ? 'open' : 'closed';
  
  roomState.session.requestsOpen = !!open;
  roomState.session.requestWindowMode = 'manual';
  roomState.session.requestWindowExpiresAt = null;
  roomState.session.requestWindowDuration = null;
  roomState.session.requestWindowLabel = null;
  roomState.session.lastMutationActorUserId = actor.actorId;
  
  await persistStateWithAudit({
    roomState,
    gigId: roomContext.gigId,
    actor,
    entityType: 'gig_session',
    entityId: roomContext.gigId,
    eventType: 'session.window.toggle',
    previousStatus,
    nextStatus: roomState.session.requestsOpen ? 'open' : 'closed',
    metadata: {
      requestWindowMode: roomState.session.requestWindowMode
    }
  });
  res.json({ success: true, state: prepareRoomState(roomState, roomContext.gigId) });
});

// Operator selects the room-layer operating posture. Only the two usable runtime
// postures are accepted; any other value is rejected as defensive validation.
app.post("/api/session/mode", async (req, res) => {
  const roomContext = await resolveLegacyWritableRoom(req, res);
  if (!roomContext) return;
  const actor = await resolveProtectedMutationActor(req, res, roomContext.gigId);
  if (!actor) return;
  const { mode } = req.body;
  const roomState = roomContext.state;

  if (mode !== 'manual' && mode !== 'open_call') {
    return res.status(400).json({ error: "mode must be 'manual' or 'open_call'." });
  }

  const previousMode = roomState.session.operatingMode;
  roomState.session.operatingMode = mode;
  roomState.session.lastMutationActorUserId = actor.actorId;

  await persistStateWithAudit({
    roomState,
    gigId: roomContext.gigId,
    actor,
    entityType: 'gig_session',
    entityId: roomContext.gigId,
    eventType: 'session.mode',
    previousStatus: previousMode,
    nextStatus: mode,
    metadata: { operatingMode: mode }
  });
  res.json({ success: true, state: prepareRoomState(roomState, roomContext.gigId) });
});

// Activate standard/custom preset time window
app.post("/api/session/window/preset/activate", async (req, res) => {
  const roomContext = await resolveLegacyWritableRoom(req, res);
  if (!roomContext) return;
  const actor = await resolveProtectedMutationActor(req, res, roomContext.gigId);
  if (!actor) return;
  const { durationMinutes, label } = req.body;
  const roomState = roomContext.state;
  
  const duration = Number(durationMinutes);
  if (isNaN(duration) || duration <= 0) {
    return res.status(400).json({ error: "Invalid duration, must be minutes greater than zero." });
  }
  
  roomState.session.requestsOpen = true;
  roomState.session.requestWindowMode = 'preset';
  roomState.session.requestWindowExpiresAt = new Date(Date.now() + duration * 60 * 1000).toISOString();
  roomState.session.requestWindowDuration = duration;
  roomState.session.requestWindowLabel = label || "Active Window";
  roomState.session.lastMutationActorUserId = actor.actorId;
  
  await persistStateWithAudit({
    roomState,
    gigId: roomContext.gigId,
    actor,
    entityType: 'gig_session',
    entityId: roomContext.gigId,
    eventType: 'session.window.preset.activate',
    previousStatus: 'manual',
    nextStatus: 'preset',
    metadata: {
      requestWindowDuration: roomState.session.requestWindowDuration,
      requestWindowLabel: roomState.session.requestWindowLabel,
      requestWindowExpiresAt: roomState.session.requestWindowExpiresAt
    }
  });
  res.json({ success: true, state: prepareRoomState(roomState, roomContext.gigId) });
});

// Create/Build beautiful custom preset
app.post("/api/session/window/preset/create", async (req, res) => {
  const roomContext = await resolveLegacyWritableRoom(req, res);
  if (!roomContext) return;
  const actor = await resolveProtectedMutationActor(req, res, roomContext.gigId);
  if (!actor) return;
  const { label, durationMinutes } = req.body;
  const roomState = roomContext.state;
  
  const duration = Number(durationMinutes);
  if (!label || isNaN(duration) || duration <= 0) {
    return res.status(400).json({ error: "Preset requires a title and valid duration in minutes." });
  }
  
  const newPreset = {
    id: "p-custom-" + Math.random().toString(36).substring(2, 9),
    label: String(label).trim(),
    duration: duration,
    isSystem: false
  };
  
  roomState.session.requestPresets.push(newPreset);
  roomState.session.lastMutationActorUserId = actor.actorId;
  await persistStateWithAudit({
    roomState,
    gigId: roomContext.gigId,
    actor,
    entityType: 'gig_session',
    entityId: roomContext.gigId,
    eventType: 'session.window.preset.create',
    previousStatus: null,
    nextStatus: null,
    metadata: {
      presetId: newPreset.id,
      label: newPreset.label,
      duration: newPreset.duration
    }
  });
  res.json({ success: true, state: prepareRoomState(roomState, roomContext.gigId) });
});

// Delete custom preset
app.post("/api/session/window/preset/delete", async (req, res) => {
  const roomContext = await resolveLegacyWritableRoom(req, res);
  if (!roomContext) return;
  const actor = await resolveProtectedMutationActor(req, res, roomContext.gigId);
  if (!actor) return;
  const { presetId } = req.body;
  const roomState = roomContext.state;
  
  roomState.session.requestPresets = roomState.session.requestPresets.filter(p => p.id !== presetId);
  roomState.session.lastMutationActorUserId = actor.actorId;
  await persistStateWithAudit({
    roomState,
    gigId: roomContext.gigId,
    actor,
    entityType: 'gig_session',
    entityId: roomContext.gigId,
    eventType: 'session.window.preset.delete',
    previousStatus: null,
    nextStatus: null,
    metadata: {
      presetId
    }
  });
  res.json({ success: true, state: prepareRoomState(roomState, roomContext.gigId) });
});

// Create request + check profanity
app.post("/api/request/create", async (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
  const resolvedActor = accessControl.resolveServerActor(req);
  const {
    type,
    targetType,
    title,
    subtitle,
    senderName,
    message,
    amount,
    albumArt,
    client_request_id,
    idempotency_key,
    patron_device_id_hash = "anonymous-device",
    gig_id,
    currency = "USD",
    expires_at,
    payment_method
  } = req.body;

  if (!client_request_id || !idempotency_key) {
    return res.status(400).json({ error: "client_request_id and idempotency_key are required." });
  }

  const durableGigId = parseDurableGigId(gig_id);
  if (!durableGigId) {
    return res.status(422).json({ error: "A valid route gig_id is required for durable request submission." });
  }

  const roomSnapshot = await loadRoomState(durableGigId);
  if (roomSnapshot.roomStatus !== 'active') {
    return res.status(404).json({ error: ROOM_LOOKUP_UNAVAILABLE_COPY });
  }
  const roomState = roomSnapshot.state;

  const amount_cents = Math.round(Math.max(Number(amount) || 0, roomState.session.minimumTip) * 100);
  const payload_hash = hashPayload({ type, targetType, title, subtitle, senderName, message, albumArt });
  const idempotencyFingerprint = createIdempotencyFingerprint({
    idempotency_key,
    patron_device_id_hash,
    gig_id: durableGigId,
    action_type: targetType === 'straight_tip' || type === 'tip' ? 'tip' : 'request',
    target_entity_id: title || 'request',
    amount_cents,
    currency: String(currency).toUpperCase(),
    payload_hash
  });

  const durableInput: DurableActionInput = {
    clientRequestId: client_request_id,
    idempotencyKey: idempotency_key,
    patronDeviceIdHash: patron_device_id_hash,
    gigId: durableGigId,
    actionType: targetType === 'straight_tip' || type === 'tip' ? 'tip' : 'request',
    amountCents: amount_cents,
    currency: String(currency).toUpperCase(),
    targetEntityType: targetType || 'music',
    targetEntityId: title || 'request',
    payloadHash: payload_hash,
    intentFingerprint: idempotencyFingerprint,
    expiresAt: expires_at
  };

  const durableReplay = await idempotencyStore.reservePendingAction(durableInput);
  if (durableReplay.kind === 'expired') {
    return res.status(410).json({ error: "Pending action expired before request creation." });
  }
  if (durableReplay.kind === 'misuse') {
    return res.status(409).json({ error: "idempotency misuse: same key submitted with a different fingerprint." });
  }
  if (durableReplay.kind === 'replay') {
    return res.status(durableReplay.status).json(durableReplay.body);
  }

  const existingRequest = roomState.requests.find(r => r.idempotencyKey === idempotency_key);
  if (existingRequest) {
    if (existingRequest.idempotencyFingerprint !== idempotencyFingerprint) {
      return res.status(409).json({ error: "idempotency misuse: same key submitted with a different fingerprint." });
    }
    const responseBody = { success: true, request: existingRequest, state: roomState, reconciled: true };
    await idempotencyStore.completePendingAction({
      clientRequestId: client_request_id,
      idempotencyKey: idempotency_key,
      status: 200,
      body: responseBody
    });
    return res.json(responseBody);
  }

  const tipAmount = Math.max(Number(amount) || 0, roomState.session.minimumTip);
  const holdAmount = tipAmount;
  const platformFee = 1.0; 

  const isStraightTip = targetType === 'straight_tip' || type === 'tip';

  // Troll-control: durable server-side gate blocking requests when paused/ending/closed.
  if (!isStraightTip && (!roomState.session.requestsOpen || roomState.session.status !== 'active')) {
    return res.status(400).json({ error: "Request submissions are currently closed by the host." });
  }

  if (!isStraightTip) {
    const sameDeviceSessionRequests = roomState.requests.filter((item) =>
      item.gigId === durableGigId
      && item.patronDeviceIdHash === patron_device_id_hash
      && item.type === 'request'
    );

    if (sameDeviceSessionRequests.length >= MAX_REQUESTS_PER_DEVICE_PER_SESSION) {
      return res.status(429).json({
        error: "You've reached the request limit for this session. Try again shortly as the queue moves."
      });
    }

    const noteRequests = sameDeviceSessionRequests.filter((item) => typeof item.message === 'string' && item.message.trim().length > 0);
    if ((message || '').trim().length > 0 && noteRequests.length >= MAX_CUSTOM_NOTES_PER_DEVICE_PER_SESSION) {
      return res.status(429).json({
        error: "You've reached the custom-note limit for this session. Try a preset request next."
      });
    }
  }

  const moderationOutcome = await moderationService.evaluateSubmission({
    senderName: senderName || "Patron",
    text: message || "",
    patronUserId: resolvedActor.actorId,
    patronDeviceIdHash: resolvedActor.patronDeviceIdHash ?? (typeof patron_device_id_hash === 'string' ? patron_device_id_hash : null)
  });

  if (moderationOutcome.decision === 'block_submission') {
    await moderationService.recordPatronReport({
      requestId: client_request_id,
      reason: moderationOutcome.reason,
      actorUserId: resolveActorUserId(req),
      patronDeviceIdHash: patron_device_id_hash
    });
    return res.status(403).json({
      error: moderationOutcome.reason,
      outage_behavior: 'block_submission'
    });
  }

  const shadowBanned = moderationOutcome.decision === 'hold_for_review';

  const newItem: RequestItem = {
    id: `req-${String(client_request_id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)}`,
    type: isStraightTip ? 'tip' : 'request',
    targetType: targetType || 'music',
    title: isStraightTip ? 'Straight Tip' : (title || 'Request'),
    subtitle: isStraightTip ? 'Supported the talent directly!' : (subtitle || ''),
    albumArt: albumArt || (targetType === 'music' ? "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=150&h=150&fit=crop" : undefined),
    senderName: senderName || "Anonymous Patron",
    message: message || "",
    amount: tipAmount,
    holdAmount: holdAmount,
    platformFee: platformFee,
    sponsorCount: 1,
    status: shadowBanned ? 'hold' : (isStraightTip ? 'fulfilled' : 'hold'),
    shadowBanned: shadowBanned,
    actorUserId: resolvedActor.actorId,
    lastMutationActorUserId: resolvedActor.actorId,
    createdAt: new Date().toISOString(),
    clientRequestId: client_request_id,
    idempotencyKey: idempotency_key,
    idempotencyFingerprint,
    idempotencyExpiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_HOURS * 3600000).toISOString(),
    patronDeviceIdHash: patron_device_id_hash,
    gigId: durableGigId,
    payloadHash: payload_hash,
    amountCents: amount_cents,
    currency: String(currency).toUpperCase(),
    boosts: []
  };

  // Provider-backed authorization/hold. A paid request/tip must NOT enter app
  // state or Private Triage until the provider confirms a real hold
  // (PaymentIntent requires_capture). Fail safe / fail closed otherwise.
  if (paymentService.isEnabled()) {
    const platformFeeCents = roomState.session.feeType === 'patron' ? 100 : 0;
    const authorization = await paymentService.authorizeAction({
      gigId: durableGigId,
      actionType: isStraightTip ? 'tip' : 'request',
      amountSubtotalCents: amount_cents,
      platformFeeCents,
      currency: String(currency).toUpperCase(),
      idempotencyKey: idempotency_key,
      runtimeRequestId: newItem.id,
      clientRequestId: client_request_id,
      paymentMethod: payment_method,
      confirm: typeof payment_method === 'string' && payment_method.length > 0
    });
    if (authorization.status === 'failed') {
      return res.status(402).json({
        error: "Payment authorization failed. Your card was not charged and no request was created.",
        payment_status: 'failed'
      });
    }
    if (authorization.status === 'requires_confirmation') {
      // No hold yet: do NOT create the request. Return the client_secret so the
      // patron can confirm their card; the request is created only after the
      // PaymentIntent reaches requires_capture.
      return res.status(402).json({
        error: "Payment confirmation is required before your request is submitted.",
        payment_status: 'requires_confirmation',
        payment_intent_id: authorization.processorPaymentIntentId,
        client_secret: authorization.clientSecret
      });
    }
    // status === 'authorized': a real hold exists. Only now may the request enter
    // app state / Private Triage.
    if (authorization.status === 'authorized') {
      newItem.paymentId = authorization.paymentId;
      newItem.paymentIntentId = authorization.processorPaymentIntentId;
      newItem.paymentStatus = 'authorized';
      // A straight tip is not gated by Private Triage, so capture its authorized
      // hold immediately.
      if (isStraightTip) {
        const capture = await paymentService.captureAuthorization(authorization.paymentId);
        if (capture.status === 'captured') {
          newItem.paymentStatus = 'captured';
        }
      }
    }
  } else if (isProduction) {
    // Fail closed: a visible money action must never silently create no-money
    // request state in production. If the payment provider is not configured,
    // the action is rejected rather than processed for free.
    return res.status(503).json({
      error: "Payments are temporarily unavailable. Your request was not submitted and you were not charged.",
      payment_status: 'provider_unavailable'
    });
  }

  roomState.requests.push(newItem);
  recalculateTotals(roomState);
  await persistBusinessStateForRoom(roomState, durableGigId);

  const responseBody = {
    success: true, 
    request: newItem,
    state: roomState,
    moderation: {
      outage_behavior: moderationOutcome.decision,
      ai_assistive_only: true
    },
    shadowBannedFeedback: shadowBanned ? "Request received and queued for performer review." : null
  };
  await idempotencyStore.completePendingAction({
    clientRequestId: client_request_id,
    idempotencyKey: idempotency_key,
    status: 200,
    body: responseBody
  });
  res.json(responseBody);
});

// Boost an existing request
app.post("/api/request/boost", async (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
  const resolvedActor = accessControl.resolveServerActor(req);
  const {
    requestId,
    patronName,
    boostAmount,
    client_request_id,
    idempotency_key,
    patron_device_id_hash = "anonymous-device",
    gig_id,
    currency = "USD",
    expires_at,
    payment_method
  } = req.body;
  const amt = Math.max(Number(boostAmount) || 0, 1); // Minimum boost of $1
  if (!client_request_id || !idempotency_key) {
    return res.status(400).json({ error: "client_request_id and idempotency_key are required." });
  }

  const durableGigId = parseDurableGigId(gig_id);
  if (!durableGigId) {
    return res.status(422).json({ error: "A valid route gig_id is required for durable boost submission." });
  }

  const roomSnapshot = await loadRoomState(durableGigId);
  if (roomSnapshot.roomStatus !== 'active') {
    return res.status(404).json({ error: ROOM_LOOKUP_UNAVAILABLE_COPY });
  }
  const roomState = roomSnapshot.state;

  const request = roomState.requests.find(r => r.id === requestId);
  if (!request) {
    return res.status(404).json({ error: "Request not found" });
  }

  // Gate #9.2: Paid boosts must never bypass private triage or moderation.
  // A boost is an ordering action that may only touch content that has already
  // cleared the Private Triage Desk. Allowlist approved, non-shadowbanned,
  // visible requests only; everything else (hold/denied/fulfilled/hidden/removed)
  // is rejected so money can never grant display or approval authority.
  const isBoostEligible =
    request.status === 'approved'
    && !request.shadowBanned
    && !request.hidden
    && !request.removed;

  if (!isBoostEligible) {
    return res.status(409).json({
      error: "This request cannot be boosted right now. Boosts are only allowed on approved queue items."
    });
  }

  const sameActorBoostCount = resolvedActor.actorId
    ? roomState.requests.reduce((count, current) => {
        if (current.gigId !== durableGigId) return count;
        return count + current.boosts.filter((boost) => boost.actorUserId === resolvedActor.actorId).length;
      }, 0)
    : 0;

  if (sameActorBoostCount >= MAX_BOOSTS_PER_DEVICE_PER_SESSION) {
    return res.status(429).json({
      error: "You've reached the boost limit for this session. Try again later."
    });
  }

  const amount_cents = Math.round(amt * 100);
  const payload_hash = hashPayload({ requestId, patronName, boostAmount });
  const idempotencyFingerprint = createIdempotencyFingerprint({
    idempotency_key,
    patron_device_id_hash,
    gig_id: durableGigId,
    action_type: 'boost',
    target_entity_id: requestId,
    amount_cents,
    currency,
    payload_hash
  });

  const durableInput: DurableActionInput = {
    clientRequestId: client_request_id,
    idempotencyKey: idempotency_key,
    patronDeviceIdHash: patron_device_id_hash,
    gigId: durableGigId,
    actionType: 'boost',
    amountCents: amount_cents,
    currency: String(currency).toUpperCase(),
    targetEntityType: 'request',
    targetEntityId: requestId,
    payloadHash: payload_hash,
    intentFingerprint: idempotencyFingerprint,
    expiresAt: expires_at
  };

  const durableReplay = await idempotencyStore.reservePendingAction(durableInput);
  if (durableReplay.kind === 'expired') {
    return res.status(410).json({ error: "Pending action expired before boost creation." });
  }
  if (durableReplay.kind === 'misuse') {
    return res.status(409).json({ error: "idempotency misuse: same key submitted with a different fingerprint." });
  }
  if (durableReplay.kind === 'replay') {
    return res.status(durableReplay.status).json(durableReplay.body);
  }

  const existingBoost = request.boosts.find(b => b.idempotencyKey === idempotency_key);
  if (existingBoost) {
    if (existingBoost.idempotencyFingerprint !== idempotencyFingerprint) {
      return res.status(409).json({ error: "idempotency misuse: same key submitted with a different fingerprint." });
    }
    const responseBody = { success: true, request, boost: existingBoost, state: roomState, reconciled: true };
    await idempotencyStore.completePendingAction({
      clientRequestId: client_request_id,
      idempotencyKey: idempotency_key,
      status: 200,
      body: responseBody
    });
    return res.json(responseBody);
  }

  const moderationOutcome = await moderationService.evaluateSubmission({
    senderName: patronName || "Patron",
    text: '',
    patronUserId: resolvedActor.actorId,
    patronDeviceIdHash: resolvedActor.patronDeviceIdHash ?? (typeof patron_device_id_hash === 'string' ? patron_device_id_hash : null)
  });

  if (moderationOutcome.decision === 'block_submission') {
    await moderationService.recordPatronReport({
      requestId,
      reason: moderationOutcome.reason,
      actorUserId: resolveActorUserId(req),
      patronDeviceIdHash: patron_device_id_hash
    });
    return res.status(403).json({
      error: moderationOutcome.reason,
      outage_behavior: 'block_submission'
    });
  }

  const isBackerShadowed = moderationOutcome.decision === 'hold_for_review';

  const newBoost: BoostContribution = {
    id: `boost-${String(client_request_id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)}`,
    patronName: patronName || "Co-Sponsor",
    amount: amt,
    actorUserId: resolvedActor.actorId,
    timestamp: new Date().toISOString(),
    clientRequestId: client_request_id,
    idempotencyKey: idempotency_key,
    idempotencyFingerprint,
    idempotencyExpiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_HOURS * 3600000).toISOString()
  };

  // Provider-backed authorization/hold for the boost. The booster only reaches
  // this point because the target request already cleared Private Triage, so the
  // boost never grants approval authority. Fail safe on provider rejection.
  if (paymentService.isEnabled()) {
    const authorization = await paymentService.authorizeAction({
      gigId: durableGigId,
      actionType: 'boost',
      amountSubtotalCents: amount_cents,
      platformFeeCents: 100,
      currency: String(currency).toUpperCase(),
      idempotencyKey: idempotency_key,
      runtimeRequestId: request.id,
      clientRequestId: client_request_id,
      paymentMethod: payment_method,
      confirm: typeof payment_method === 'string' && payment_method.length > 0
    });
    if (authorization.status === 'failed') {
      return res.status(402).json({
        error: "Boost authorization failed. Your card was not charged.",
        payment_status: 'failed'
      });
    }
    if (authorization.status === 'requires_confirmation') {
      // No hold yet: do NOT create the boost. Return the client_secret so the
      // patron can confirm; the boost is created only after requires_capture.
      return res.status(402).json({
        error: "Payment confirmation is required before your boost is applied.",
        payment_status: 'requires_confirmation',
        payment_intent_id: authorization.processorPaymentIntentId,
        client_secret: authorization.clientSecret
      });
    }
    // status === 'authorized': a real hold exists. The target request already
    // cleared Private Triage, so the approved boost is captured immediately.
    if (authorization.status === 'authorized') {
      newBoost.paymentId = authorization.paymentId;
      newBoost.paymentIntentId = authorization.processorPaymentIntentId;
      newBoost.paymentStatus = 'authorized';
      const capture = await paymentService.captureAuthorization(authorization.paymentId);
      if (capture.status === 'captured') {
        newBoost.paymentStatus = 'captured';
      }
    }
  } else if (isProduction) {
    // Fail closed: a visible money action must never silently create no-money
    // boost state in production when the payment provider is unavailable.
    return res.status(503).json({
      error: "Payments are temporarily unavailable. Your boost was not applied and you were not charged.",
      payment_status: 'provider_unavailable'
    });
  }

  request.boosts.push(newBoost);
  request.amount += amt; // Pool funds!
  request.platformFee += 1.0; // Flat platform fee grows by $1 per boost
  request.sponsorCount += 1;

  if (isBackerShadowed) {
    request.shadowBanned = true; // Cascade shadow ban if the booster is vulgar
  }

  recalculateTotals(roomState);
  await persistBusinessStateForRoom(roomState, durableGigId);
  const responseBody = { success: true, request, state: roomState };
  await idempotencyStore.completePendingAction({
    clientRequestId: client_request_id,
    idempotencyKey: idempotency_key,
    status: 200,
    body: responseBody
  });
  res.json(responseBody);
});

// Triage Queue Action (Accept / Deny)
app.post("/api/request/triage", async (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
  const { requestId, action } = req.body; // action: 'approve' | 'deny'
  const roomContext = await findRoomStateByRequestId(requestId);
  if (!roomContext || !roomContext.gigId) {
    return res.status(404).json({ error: "Request not found" });
  }
  const roomState = roomContext.state;
  const request = roomContext.request;

  const actor = await resolveProtectedMutationActor(req, res, roomContext.gigId);
  if (!actor) return;
  const previousStatus = request.status;

  if (action === 'approve') {
    request.status = 'approved';
  } else {
    request.status = 'denied';
  }
  request.lastMutationActorUserId = actor.actorId;
  roomState.session.lastMutationActorUserId = actor.actorId;

  // Settle the provider-backed hold according to the triage decision.
  if (paymentService.isEnabled()) {
    const paymentIds = [
      request.paymentId,
      ...request.boosts.map((boost) => boost.paymentId)
    ].filter((id): id is string => Boolean(id));

    if (action === 'approve') {
      for (const paymentId of paymentIds) {
        const capture = await paymentService.captureAuthorization(paymentId);
        if (capture.status === 'captured' && paymentId === request.paymentId) {
          request.paymentStatus = 'captured';
        }
      }
    } else {
      await paymentService.voidOrRefundMany(paymentIds);
      request.paymentStatus = 'voided_or_refunded';
    }
  }

  recalculateTotals(roomState);
  await persistStateWithAudit({
    roomState,
    gigId: roomContext.gigId,
    actor,
    entityType: 'request',
    entityId: request.id,
    eventType: `request.triage.${action === 'approve' ? 'approve' : 'deny'}`,
    previousStatus,
    nextStatus: request.status,
    metadata: {
      requestId: request.id,
      gigId: roomContext.gigId
    }
  });
  res.json({ success: true, request, state: prepareRoomState(roomState, roomContext.gigId) });
});

// Fulfillment Queue Action (Fulfill)
app.post("/api/request/fulfill", async (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
  const { requestId } = req.body;
  const roomContext = await findRoomStateByRequestId(requestId);
  if (!roomContext || !roomContext.gigId) {
    return res.status(404).json({ error: "Request not found (could be deleted)" });
  }
  const roomState = roomContext.state;
  const request = roomContext.request;

  const actor = await resolveProtectedMutationActor(req, res, roomContext.gigId);
  if (!actor) return;
  const previousStatus = request.status;

  request.status = 'fulfilled';
  request.lastMutationActorUserId = actor.actorId;
  roomState.session.lastMutationActorUserId = actor.actorId;

  // Capture any still-authorized holds for the fulfilled request (idempotent:
  // already-captured holds are a no-op).
  if (paymentService.isEnabled()) {
    const paymentIds = [
      request.paymentId,
      ...request.boosts.map((boost) => boost.paymentId)
    ].filter((id): id is string => Boolean(id));
    for (const paymentId of paymentIds) {
      const capture = await paymentService.captureAuthorization(paymentId);
      if (capture.status === 'captured' && paymentId === request.paymentId) {
        request.paymentStatus = 'captured';
      }
    }
  }

  recalculateTotals(roomState);
  await persistStateWithAudit({
    roomState,
    gigId: roomContext.gigId,
    actor,
    entityType: 'request',
    entityId: request.id,
    eventType: 'request.fulfill',
    previousStatus,
    nextStatus: request.status,
    metadata: {
      requestId: request.id,
      gigId: roomContext.gigId
    }
  });

  res.json({ success: true, request, state: prepareRoomState(roomState, roomContext.gigId) });
});

app.post("/api/moderation/report", async (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
  const resolvedActor = accessControl.resolveServerActor(req);

  const { requestId, reason, details, patron_device_id_hash } = req.body;
  if (!requestId || !reason) {
    return res.status(400).json({ error: "requestId and reason are required." });
  }

  await moderationService.recordPatronReport({
    requestId: String(requestId),
    reason: String(reason),
    details: typeof details === 'string' ? details : undefined,
    actorUserId: resolvedActor.actorId,
    patronDeviceIdHash: resolvedActor.patronDeviceIdHash ?? (typeof patron_device_id_hash === 'string' ? patron_device_id_hash : null)
  });

  return res.json({ success: true, moderation_action: 'report_submitted' });
});

app.post("/api/moderation/block", async (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
  const privilegedActor = await accessControl.requireAdminOrSupportAccess(req);
  if (privilegedActor.allowed === false) {
    return res.status(privilegedActor.status).json({ error: privilegedActor.reason });
  }

  if (!privilegedActor.actor.actorId) {
    return res.status(401).json({ error: 'Sway actor resolution required.' });
  }

  const { scope, value, reason, actor_user_id } = req.body;
  const allowedScopes: BlockScope[] = ['patron_user_id', 'patron_device_id_hash', 'sender_name'];

  if (!allowedScopes.includes(scope) || !value || !reason) {
    return res.status(400).json({
      error: "scope, value, and reason are required. scope must be patron_user_id, patron_device_id_hash, or sender_name."
    });
  }

  const normalizedValue = String(value).trim().toLowerCase();
  const actorId = typeof actor_user_id === 'string' ? actor_user_id : privilegedActor.actor.actorId;

  if (!businessDb) {
    await moderationService.addBlockRule({
      scope,
      value: String(value),
      reason: String(reason),
      actorUserId: actorId
    });
  } else {
    await businessDb.transaction(async (tx) => {
      await tx
        .insert(activeBlocks)
        .values({
          scope,
          normalizedValue,
          reason: String(reason),
          actorUserId: actorId,
          status: 'active',
          revokedAt: null,
          metadata: { source: 'moderation.block' }
        })
        .onConflictDoUpdate({
          target: [activeBlocks.scope, activeBlocks.normalizedValue, activeBlocks.status],
          set: {
            reason: String(reason),
            actorUserId: actorId,
            revokedAt: null,
            metadata: { source: 'moderation.block' },
            updatedAt: new Date()
          }
        });

      await tx.insert(moderationEvents).values({
        actorUserId: actorId,
        entityType: 'block_rule',
        entityId: toAuditEntityUuid(`${scope}:${normalizedValue}`),
        status: 'blocked',
        reason: String(reason),
        metadata: {
          scope,
          value: normalizedValue,
          source: 'moderation.block'
        }
      });

      await writeAuditEvent(tx, {
        actorId,
        actorType: privilegedActor.role ?? 'unknown',
        entityType: 'moderation_block',
        entityId: `${scope}:${normalizedValue}`,
        eventType: 'moderation.block',
        previousStatus: null,
        nextStatus: 'blocked',
        metadata: {
          scope,
          value: normalizedValue,
          reason: String(reason)
        }
      });
    });
  }

  return res.json({ success: true, moderation_action: 'block_added' });
});

app.post("/api/moderation/hide", async (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;

  const { requestId, reason, actor_user_id } = req.body;
  if (!requestId || !reason) {
    return res.status(400).json({ error: "requestId and reason are required." });
  }

  const roomContext = await findRoomStateByRequestId(String(requestId));
  if (!roomContext || !roomContext.gigId) {
    return res.status(404).json({ error: "Request not found" });
  }
  const roomState = roomContext.state;
  const request = roomContext.request;

  const actor = await resolveProtectedMutationActor(req, res, roomContext.gigId);
  if (!actor) return;

  const previousStatus = request.hidden ? 'hidden' : 'visible';
  request.hidden = true;
  request.lastMutationActorUserId = actor.actorId;
  roomState.session.lastMutationActorUserId = actor.actorId;

  // A hidden request is never publicly eligible, so release its funds.
  if (paymentService.isEnabled()) {
    const paymentIds = [
      request.paymentId,
      ...request.boosts.map((boost) => boost.paymentId)
    ].filter((id): id is string => Boolean(id));
    if (paymentIds.length) {
      await paymentService.voidOrRefundMany(paymentIds);
      request.paymentStatus = 'voided_or_refunded';
    }
  }
  await persistStateWithAudit({
    roomState,
    gigId: roomContext.gigId,
    actor,
    entityType: 'request',
    entityId: request.id,
    eventType: 'moderation.hide',
    previousStatus,
    nextStatus: request.hidden ? 'hidden' : 'visible',
    metadata: {
      requestId: request.id,
      reason: String(reason)
    }
  });

  await moderationService.hideRequest({
    requestId: String(requestId),
    reason: String(reason),
    actorUserId: typeof actor_user_id === 'string' ? actor_user_id : actor.actorId
  });

  return res.json({ success: true, moderation_action: 'hidden', request, state: prepareRoomState(roomState, roomContext.gigId) });
});

app.post("/api/moderation/remove", async (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;

  const { requestId, reason, actor_user_id } = req.body;
  if (!requestId || !reason) {
    return res.status(400).json({ error: "requestId and reason are required." });
  }

  const roomContext = await findRoomStateByRequestId(String(requestId));
  if (!roomContext || !roomContext.gigId) {
    return res.status(404).json({ error: "Request not found" });
  }
  const roomState = roomContext.state;
  const request = roomContext.request;

  const actor = await resolveProtectedMutationActor(req, res, roomContext.gigId);
  if (!actor) return;

  const previousStatus = request.status;
  request.removed = true;
  request.status = 'denied';
  request.lastMutationActorUserId = actor.actorId;
  roomState.session.lastMutationActorUserId = actor.actorId;

  // A removed request is never publicly eligible, so release its funds.
  if (paymentService.isEnabled()) {
    const paymentIds = [
      request.paymentId,
      ...request.boosts.map((boost) => boost.paymentId)
    ].filter((id): id is string => Boolean(id));
    if (paymentIds.length) {
      await paymentService.voidOrRefundMany(paymentIds);
      request.paymentStatus = 'voided_or_refunded';
    }
  }
  recalculateTotals(roomState);
  await persistStateWithAudit({
    roomState,
    gigId: roomContext.gigId,
    actor,
    entityType: 'request',
    entityId: request.id,
    eventType: 'moderation.remove',
    previousStatus,
    nextStatus: request.status,
    metadata: {
      requestId: request.id,
      removed: true,
      reason: String(reason)
    }
  });

  await moderationService.removeRequest({
    requestId: String(requestId),
    reason: String(reason),
    actorUserId: typeof actor_user_id === 'string' ? actor_user_id : actor.actorId
  });

  return res.json({ success: true, moderation_action: 'removed', request, state: prepareRoomState(roomState, roomContext.gigId) });
});

app.get('/api/moderation/placeholders', (_req, res) => {
  return res.json({
    success: true,
    app_store_ugc_controls: moderationService.getAppStoreUgcControlPlaceholders()
  });
});

app.get('/api/support/contact', (_req, res) => {
  return res.json({
    success: true,
    message: 'Support options are available through the in-app safety controls.'
  });
});

app.post('/api/privacy/data-deletion-placeholder', (_req, res) => {
  return res.json({
    success: true,
    message: 'Data deletion request received.'
  });
});

// Development catalog only. Production must use a licensed/verifiable catalog integration.
app.post("/api/music/search", (req, res) => {
  if (isProduction) {
    return res.status(503).json({
      error: "Music catalog integration is not configured for production.",
      results: []
    });
  }

  const { query } = req.body;
  const songs = [
    { id: "s1", title: "Mr. Brightside", artist: "The Killers", albumArt: "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=150&h=150&fit=crop", genre: "Rock" },
    { id: "s2", title: "Dancing Queen", artist: "ABBA", albumArt: "https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=150&h=150&fit=crop", genre: "Pop" },
    { id: "s3", title: "Bohemian Rhapsody", artist: "Queen", albumArt: "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150&h=150&fit=crop", genre: "Classic Rock" },
    { id: "s4", title: "Blinding Lights", artist: "The Weeknd", albumArt: "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150&h=150&fit=crop", genre: "Synthpop" },
    { id: "s5", title: "September", artist: "Earth, Wind & Fire", albumArt: "https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=150&h=150&fit=crop", genre: "Funk" },
    { id: "s6", title: "Billie Jean", artist: "Michael Jackson", albumArt: "https://images.unsplash.com/photo-1498038432885-c6f3f1b912ee?w=150&h=150&fit=crop", genre: "Pop" },
    { id: "s7", title: "Don't Stop Believin'", artist: "Journey", albumArt: "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=150&h=150&fit=crop", genre: "Rock" },
    { id: "s8", title: "Flowers", artist: "Miley Cyrus", albumArt: "https://images.unsplash.com/photo-1487180142328-054b783fc471?w=150&h=150&fit=crop", genre: "Pop" },
    { id: "s9", title: "Stayin' Alive", artist: "Bee Gees", albumArt: "https://images.unsplash.com/photo-1508700115892-45ecd05ae2ad?w=150&h=150&fit=crop", genre: "Disco" }
  ];

  if (!query) {
    return res.json({ results: songs.slice(0, 5) });
  }

  const normalizedQuery = query.toLowerCase();
  const matched = songs.filter(s => 
    s.title.toLowerCase().includes(normalizedQuery) || 
    s.artist.toLowerCase().includes(normalizedQuery) ||
    (s.genre && s.genre.toLowerCase().includes(normalizedQuery))
  );

  return res.json({ results: matched.length ? matched : songs.slice(0, 3) });
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API route not found.' });
});

// Vite Middleware & Front-End Serving Config
async function startServer() {
  await refreshBusinessState();

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: ['sway.tips', 'www.sway.tips', 'app.sway.tips']
      },
      appType: "custom",
    });
    app.use(vite.middlewares);
    app.get('*', async (req, res, next) => {
      try {
        const shell = resolveShellForRoute(req.path, typeof req.headers.host === 'string' ? req.headers.host : undefined);
        const templatePath = path.join(process.cwd(), shellHtmlRelativePath(shell));
        const template = readFileSync(templatePath, 'utf8');
        const html = await vite.transformIndexHtml(req.originalUrl, template);
        applyNoStoreHeaders(res);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
      } catch (error) {
        next(error);
      }
    });
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.get('/shells/dev-sandbox.html', (_req, res) => {
      res.status(404).send('Not found');
    });
    app.get(/^\/assets\/dev-sandbox-.*\.js$/, (_req, res) => {
      res.status(404).send('Not found');
    });
    app.use(express.static(distPath, { index: false }));
    app.get('*', (req, res) => {
      const shell = resolveShellForRoute(req.path, typeof req.headers.host === 'string' ? req.headers.host : undefined);
      if (!isShellAllowed(shell)) {
        res.status(404).send('Not found');
        return;
      }
      applyNoStoreHeaders(res);
      res.sendFile(path.join(distPath, shellHtmlRelativePath(shell)));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

startServer();
