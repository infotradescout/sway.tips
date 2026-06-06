/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from "express";
import path from "path";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { BackendState, RequestItem, GigSession } from "./src/types";
import { createAccessControl, routeFamilyGuard } from "./src/server/access-control";
import { createIdempotencyStore, type DurableActionInput } from "./src/server/idempotency-store";
import { createModerationService, type BlockScope } from "./src/server/moderation-service";
import { createBusinessStore } from "./src/server/business-store";

dotenv.config();

const app = express();
const PORT = 3000;
const isProduction = process.env.NODE_ENV === "production";
const IDEMPOTENCY_TTL_HOURS = 48;
const accessControl = createAccessControl({
  databaseUrl: process.env.DATABASE_URL,
  isProduction
});
const idempotencyStore = createIdempotencyStore(process.env.DATABASE_URL);
const moderationService = createModerationService(process.env.DATABASE_URL);
const businessStore = createBusinessStore(process.env.DATABASE_URL, createInactiveSession);

app.use(express.json());

type SwayShell = 'patron' | 'talent' | 'overlay' | 'admin' | 'dev-sandbox';

function resolveShellForRoute(urlPath: string): SwayShell {
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
  req.headers['x-sway-shell'] = resolveShellForRoute(req.path);
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
    totals: {
      totalTips: 0,
      accumulatedFees: 0,
      totalCount: 0,
      topRequest: "None yet"
    }
  };
}

// Development-only state. Production must use a persistent business store.
let state: BackendState = {
  session: createInactiveSession(),
  requests: [],
  performers: []
};
let activeGigId: string | null = null;

async function refreshBusinessState() {
  const snapshot = await businessStore.hydrateState(state);
  state = snapshot.state;
  activeGigId = snapshot.activeGigId;
  syncActivePerformer(state);
  return snapshot;
}

async function persistBusinessState() {
  syncActivePerformer(state);
  await businessStore.persistState({ state, activeGigId });
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
  const value = req.headers['x-sway-resolved-actor-id'];
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  return null;
}

// 5-Minute Timer Closeout Routine Worker
setInterval(async () => {
  await refreshBusinessState();

  let changed = false;

  if (state.session.status === 'ending' && state.session.endGigTimerStartedAt) {
    const startTimeStamp = new Date(state.session.endGigTimerStartedAt).getTime();
    const elapsedTime = Date.now() - startTimeStamp;
    
    // 5 minutes is 300,000 ms. For easier testing, let's keep the real 5 minutes but allow talent to dismiss.
    if (elapsedTime >= 300000) {
      console.log("Post-gig timer expired. Releasing pending requests.");
      executeAutoNuke(state);
      changed = true;
    }
  }

  // Check if featured status has expired
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

  // Check if request open window preset has expired
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

app.get("/api/state", async (req, res) => {
  await refreshBusinessState();
  res.json(state);
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
  if (!requirePersistentBusinessStore(res)) return;
  await refreshBusinessState();
  const { talentName, talentRole, feeType, minimumTip, gig_id } = req.body;

  const requestedGigId = parseDurableGigId(gig_id);
  activeGigId = requestedGigId ?? activeGigId ?? businessStore.createGigId();

  state.session = {
    status: 'active',
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
    totals: {
      totalTips: 0,
      accumulatedFees: 0,
      totalCount: 0,
      topRequest: "None yet"
    }
  };
  state.requests = []; // Clear current requests for a fresh session!
  syncActivePerformer(state);
  await persistBusinessState();
  res.json({ success: true, state });
});

app.post("/api/session/feature", async (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
  await refreshBusinessState();
  const { hours, cost, activate } = req.body;
  
  if (activate) {
    state.session.isFeatured = true;
    state.session.featuredExpiresAt = new Date(Date.now() + Number(hours) * 3600000).toISOString();
    state.session.featuredCost = Number(cost) || 0;
    state.session.featuredDurationHours = Number(hours) || 1;
  } else {
    state.session.isFeatured = false;
    state.session.featuredExpiresAt = null;
    state.session.featuredCost = 0;
    state.session.featuredDurationHours = 0;
  }
  
  syncActivePerformer(state);
  await persistBusinessState();
  res.json({ success: true, state });
});

app.post("/api/session/end", async (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
  await refreshBusinessState();
  if (state.session.status !== 'active') {
    return res.status(400).json({ error: "No active session to end." });
  }
  state.session.status = 'ending';
  state.session.endGigTimerStartedAt = new Date().toISOString();
  await persistBusinessState();
  res.json({ success: true, state });
});

app.post("/api/session/closeout", async (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
  await refreshBusinessState();
  executeAutoNuke(state);
  await persistBusinessState();
  res.json({ success: true, state });
});

// REQUEST WINDOW MANAGERS & PRESETS ENDPOINTS

// Toggle overall requests status (Manual Mode)
app.post("/api/session/window/toggle", async (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
  await refreshBusinessState();
  const { open } = req.body;
  
  state.session.requestsOpen = !!open;
  state.session.requestWindowMode = 'manual';
  state.session.requestWindowExpiresAt = null;
  state.session.requestWindowDuration = null;
  state.session.requestWindowLabel = null;
  
  await persistBusinessState();
  res.json({ success: true, state });
});

// Activate standard/custom preset time window
app.post("/api/session/window/preset/activate", async (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
  await refreshBusinessState();
  const { durationMinutes, label } = req.body;
  
  const duration = Number(durationMinutes);
  if (isNaN(duration) || duration <= 0) {
    return res.status(400).json({ error: "Invalid duration, must be minutes greater than zero." });
  }
  
  state.session.requestsOpen = true;
  state.session.requestWindowMode = 'preset';
  state.session.requestWindowExpiresAt = new Date(Date.now() + duration * 60 * 1000).toISOString();
  state.session.requestWindowDuration = duration;
  state.session.requestWindowLabel = label || "Active Window";
  
  await persistBusinessState();
  res.json({ success: true, state });
});

// Create/Build beautiful custom preset
app.post("/api/session/window/preset/create", async (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
  await refreshBusinessState();
  const { label, durationMinutes } = req.body;
  
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
  
  state.session.requestPresets.push(newPreset);
  await persistBusinessState();
  res.json({ success: true, state });
});

// Delete custom preset
app.post("/api/session/window/preset/delete", async (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
  await refreshBusinessState();
  const { presetId } = req.body;
  
  state.session.requestPresets = state.session.requestPresets.filter(p => p.id !== presetId);
  await persistBusinessState();
  res.json({ success: true, state });
});

// Create request + check profanity
app.post("/api/request/create", async (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
  await refreshBusinessState();
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
    patron_user_id,
    gig_id,
    currency = "USD",
    expires_at
  } = req.body;

  if (!client_request_id || !idempotency_key) {
    return res.status(400).json({ error: "client_request_id and idempotency_key are required." });
  }

  const durableGigId = parseDurableGigId(gig_id);
  if (!durableGigId) {
    return res.status(422).json({ error: "A valid route gig_id is required for durable request submission." });
  }

  if (!activeGigId || activeGigId !== durableGigId) {
    activeGigId = durableGigId;
  }

  const amount_cents = Math.round(Math.max(Number(amount) || 0, state.session.minimumTip) * 100);
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

  const existingRequest = state.requests.find(r => r.idempotencyKey === idempotency_key);
  if (existingRequest) {
    if (existingRequest.idempotencyFingerprint !== idempotencyFingerprint) {
      return res.status(409).json({ error: "idempotency misuse: same key submitted with a different fingerprint." });
    }
    const responseBody = { success: true, request: existingRequest, state, reconciled: true };
    await idempotencyStore.completePendingAction({
      clientRequestId: client_request_id,
      idempotencyKey: idempotency_key,
      status: 200,
      body: responseBody
    });
    return res.json(responseBody);
  }

  const tipAmount = Math.max(Number(amount) || 0, state.session.minimumTip);
  const holdAmount = tipAmount;
  const platformFee = 1.0; 

  const isStraightTip = targetType === 'straight_tip' || type === 'tip';

  // If request mode (not a straight tip) and requests are closed, block!
  if (!isStraightTip && !state.session.requestsOpen) {
    return res.status(400).json({ error: "Request submissions are currently closed by the host." });
  }

  const moderationOutcome = await moderationService.evaluateSubmission({
    senderName: senderName || "Patron",
    text: message || "",
    patronUserId: typeof patron_user_id === 'string' ? patron_user_id : null,
    patronDeviceIdHash: typeof patron_device_id_hash === 'string' ? patron_device_id_hash : null
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

  state.requests.push(newItem);
  recalculateTotals(state);
  await persistBusinessState();

  const responseBody = {
    success: true, 
    request: newItem,
    state,
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
  await refreshBusinessState();
  const {
    requestId,
    patronName,
    boostAmount,
    client_request_id,
    idempotency_key,
    patron_device_id_hash = "anonymous-device",
    gig_id,
    currency = "USD",
    expires_at
  } = req.body;
  const amt = Math.max(Number(boostAmount) || 0, 1); // Minimum boost of $1

  if (!client_request_id || !idempotency_key) {
    return res.status(400).json({ error: "client_request_id and idempotency_key are required." });
  }

  const durableGigId = parseDurableGigId(gig_id);
  if (!durableGigId) {
    return res.status(422).json({ error: "A valid route gig_id is required for durable boost submission." });
  }

  if (!activeGigId || activeGigId !== durableGigId) {
    activeGigId = durableGigId;
  }

  const request = state.requests.find(r => r.id === requestId);
  if (!request) {
    return res.status(404).json({ error: "Request not found" });
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
    const responseBody = { success: true, request, boost: existingBoost, state, reconciled: true };
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
    patronDeviceIdHash: typeof patron_device_id_hash === 'string' ? patron_device_id_hash : null
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

  const newBoost = {
    id: `boost-${String(client_request_id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)}`,
    patronName: patronName || "Co-Sponsor",
    amount: amt,
    timestamp: new Date().toISOString(),
    clientRequestId: client_request_id,
    idempotencyKey: idempotency_key,
    idempotencyFingerprint,
    idempotencyExpiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_HOURS * 3600000).toISOString()
  };

  request.boosts.push(newBoost);
  request.amount += amt; // Pool funds!
  request.platformFee += 1.0; // Flat platform fee grows by $1 per boost
  request.sponsorCount += 1;

  if (isBackerShadowed) {
    request.shadowBanned = true; // Cascade shadow ban if the booster is vulgar
  }

  recalculateTotals(state);
  await persistBusinessState();
  const responseBody = { success: true, request, state };
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
  await refreshBusinessState();
  const { requestId, action } = req.body; // action: 'approve' | 'deny'
  const request = state.requests.find(r => r.id === requestId);
  if (!request) {
    return res.status(404).json({ error: "Request not found" });
  }

  if (action === 'approve') {
    request.status = 'approved';
  } else {
    request.status = 'denied';
  }

  recalculateTotals(state);
  await persistBusinessState();
  res.json({ success: true, request, state });
});

// Fulfillment Queue Action (Fulfill)
app.post("/api/request/fulfill", async (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
  await refreshBusinessState();
  const { requestId } = req.body;
  const request = state.requests.find(r => r.id === requestId);
  if (!request) {
    return res.status(404).json({ error: "Request not found (could be deleted)" });
  }

  request.status = 'fulfilled';
  recalculateTotals(state);
  await persistBusinessState();

  res.json({ success: true, request, state });
});

app.post("/api/moderation/report", async (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;

  const { requestId, reason, details, patron_device_id_hash, patron_user_id } = req.body;
  if (!requestId || !reason) {
    return res.status(400).json({ error: "requestId and reason are required." });
  }

  await moderationService.recordPatronReport({
    requestId: String(requestId),
    reason: String(reason),
    details: typeof details === 'string' ? details : undefined,
    actorUserId: typeof patron_user_id === 'string' ? patron_user_id : resolveActorUserId(req),
    patronDeviceIdHash: typeof patron_device_id_hash === 'string' ? patron_device_id_hash : null
  });

  return res.json({ success: true, moderation_action: 'report_submitted' });
});

app.post("/api/moderation/block", async (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;

  const { scope, value, reason, actor_user_id } = req.body;
  const allowedScopes: BlockScope[] = ['patron_user_id', 'patron_device_id_hash', 'sender_name'];

  if (!allowedScopes.includes(scope) || !value || !reason) {
    return res.status(400).json({
      error: "scope, value, and reason are required. scope must be patron_user_id, patron_device_id_hash, or sender_name."
    });
  }

  await moderationService.addBlockRule({
    scope,
    value: String(value),
    reason: String(reason),
    actorUserId: typeof actor_user_id === 'string' ? actor_user_id : resolveActorUserId(req)
  });

  return res.json({ success: true, moderation_action: 'block_added' });
});

app.post("/api/moderation/hide", async (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
  await refreshBusinessState();

  const { requestId, reason, actor_user_id } = req.body;
  if (!requestId || !reason) {
    return res.status(400).json({ error: "requestId and reason are required." });
  }

  const request = state.requests.find((item) => item.id === requestId);
  if (!request) {
    return res.status(404).json({ error: "Request not found" });
  }

  request.hidden = true;
  await persistBusinessState();

  await moderationService.hideRequest({
    requestId: String(requestId),
    reason: String(reason),
    actorUserId: typeof actor_user_id === 'string' ? actor_user_id : resolveActorUserId(req)
  });

  return res.json({ success: true, moderation_action: 'hidden', request, state });
});

app.post("/api/moderation/remove", async (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
  await refreshBusinessState();

  const { requestId, reason, actor_user_id } = req.body;
  if (!requestId || !reason) {
    return res.status(400).json({ error: "requestId and reason are required." });
  }

  const request = state.requests.find((item) => item.id === requestId);
  if (!request) {
    return res.status(404).json({ error: "Request not found" });
  }

  request.removed = true;
  request.status = 'denied';
  recalculateTotals(state);
  await persistBusinessState();

  await moderationService.removeRequest({
    requestId: String(requestId),
    reason: String(reason),
    actorUserId: typeof actor_user_id === 'string' ? actor_user_id : resolveActorUserId(req)
  });

  return res.json({ success: true, moderation_action: 'removed', request, state });
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
    placeholder: 'Support/contact flow placeholder. In-app support routing lands before App Store/TestFlight package.'
  });
});

app.post('/api/privacy/data-deletion-placeholder', (_req, res) => {
  return res.json({
    success: true,
    placeholder: 'Data deletion request placeholder captured. Verified deletion workflow will be added before launch gates.'
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

// Vite Middleware & Front-End Serving Config
async function startServer() {
  await refreshBusinessState();

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "custom",
    });
    app.use(vite.middlewares);
    app.get('*', async (req, res, next) => {
      try {
        const shell = resolveShellForRoute(req.path);
        const templatePath = path.join(process.cwd(), shellHtmlRelativePath(shell));
        const template = readFileSync(templatePath, 'utf8');
        const html = await vite.transformIndexHtml(req.originalUrl, template);
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
      const shell = resolveShellForRoute(req.path);
      if (!isShellAllowed(shell)) {
        res.status(404).send('Not found');
        return;
      }
      res.sendFile(path.join(distPath, shellHtmlRelativePath(shell)));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

startServer();
