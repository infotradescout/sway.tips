/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from "express";
import path from "path";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { BackendState, RequestItem, GigSession } from "./src/types";

dotenv.config();

const app = express();
const PORT = 3000;
const isProduction = process.env.NODE_ENV === "production";

app.use(express.json());

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

function requirePersistentBusinessStore(res: express.Response): boolean {
  if (!isProduction) return true;
  res.status(503).json({
    error: "Persistent business store is not configured. Production routes cannot use in-memory gig, request, or ledger state."
  });
  return false;
}

function syncActivePerformer() {
  if (state.session.status === 'inactive' || !state.session.talentName) {
    state.performers = [];
    return;
  }

  const activePerformer = {
    id: "p-active",
    name: state.session.talentName,
    role: state.session.talentRole,
    venueName: "Current gig",
    isFeatured: state.session.isFeatured,
    featuredExpiresAt: state.session.featuredExpiresAt,
    minimumTip: state.session.minimumTip,
    avatarUrl: ""
  };

  const existingIndex = state.performers.findIndex(p => p.id === activePerformer.id);
  if (existingIndex >= 0) {
    state.performers[existingIndex] = activePerformer;
  } else {
    state.performers = [activePerformer];
  }
}

// Deterministic moderation must stay active even when external AI services are absent.
function checkContentAppropriate(sender: string, text: string): { isAllowed: boolean; reason?: string } {
  const localProfanityWords = ["fudge", "spam", "abuse", "vulgarword", "asshole", "bitch", "bastard"];
  const blockedPatterns = [
    /\b(?:kill|hurt|attack)\s+(?:you|him|her|them|everyone)\b/i,
    /\b(?:https?:\/\/|www\.)\S+/i
  ];
  const contentString = `${sender} ${text}`.toLowerCase();

  for (const word of localProfanityWords) {
    if (contentString.includes(word)) {
      console.log(`Local moderation check caught profanity in message: "${contentString}"`);
      return { isAllowed: false, reason: "Inappropriate language filtered." };
    }
  }

  for (const pattern of blockedPatterns) {
    if (pattern.test(`${sender} ${text}`)) {
      console.log(`Local moderation check caught blocked pattern in message: "${contentString}"`);
      return { isAllowed: false, reason: "Message requires review before public display." };
    }
  }

  return { isAllowed: true };
}

// 5-Minute Timer Closeout Routine Worker
setInterval(() => {
  if (state.session.status === 'ending' && state.session.endGigTimerStartedAt) {
    const startTimeStamp = new Date(state.session.endGigTimerStartedAt).getTime();
    const elapsedTime = Date.now() - startTimeStamp;
    
    // 5 minutes is 300,000 ms. For easier testing, let's keep the real 5 minutes but allow talent to dismiss.
    if (elapsedTime >= 300000) {
      console.log("Post-gig timer expired. Releasing pending requests.");
      executeAutoNuke();
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
    }
  }

  syncActivePerformer();
}, 10000); // Check every 10 seconds for tighter precision

function executeAutoNuke() {
  state.requests = state.requests.map(req => {
    if (req.status === 'hold') {
      return { ...req, status: 'denied' };
    }
    return req;
  });
  state.session.status = 'closed';
  state.session.endGigTimerStartedAt = null;

  // Compute final totals
  recalculateTotals();
}

function recalculateTotals() {
  const fulfilledItems = state.requests.filter(r => r.status === 'fulfilled');
  const totalTips = fulfilledItems.reduce((acc, curr) => acc + curr.amount, 0);
  const totalCount = fulfilledItems.length;
  const accumulatedFees = (state.requests.filter(r => r.status !== 'denied').reduce((acc, curr) => acc + curr.sponsorCount, 0)) * 1.0;

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

  state.session.totals = {
    totalTips,
    accumulatedFees,
    totalCount,
    topRequest
  };
}

// API Routes
app.get("/api/state", (req, res) => {
  res.json(state);
});

app.post("/api/session/start", (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
  const { talentName, talentRole, feeType, minimumTip } = req.body;
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
  syncActivePerformer();
  res.json({ success: true, state });
});

app.post("/api/session/feature", (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
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
  
  syncActivePerformer();
  res.json({ success: true, state });
});

app.post("/api/session/end", (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
  if (state.session.status !== 'active') {
    return res.status(400).json({ error: "No active session to end." });
  }
  state.session.status = 'ending';
  state.session.endGigTimerStartedAt = new Date().toISOString();
  res.json({ success: true, state });
});

app.post("/api/session/closeout", (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
  executeAutoNuke();
  res.json({ success: true, state });
});

// REQUEST WINDOW MANAGERS & PRESETS ENDPOINTS

// Toggle overall requests status (Manual Mode)
app.post("/api/session/window/toggle", (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
  const { open } = req.body;
  
  state.session.requestsOpen = !!open;
  state.session.requestWindowMode = 'manual';
  state.session.requestWindowExpiresAt = null;
  state.session.requestWindowDuration = null;
  state.session.requestWindowLabel = null;
  
  res.json({ success: true, state });
});

// Activate standard/custom preset time window
app.post("/api/session/window/preset/activate", (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
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
  
  res.json({ success: true, state });
});

// Create/Build beautiful custom preset
app.post("/api/session/window/preset/create", (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
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
  res.json({ success: true, state });
});

// Delete custom preset
app.post("/api/session/window/preset/delete", (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
  const { presetId } = req.body;
  
  state.session.requestPresets = state.session.requestPresets.filter(p => p.id !== presetId);
  res.json({ success: true, state });
});

// Create request + check profanity
app.post("/api/request/create", (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
  const { type, targetType, title, subtitle, senderName, message, amount, albumArt, client_request_id, idempotency_key } = req.body;

  if (!client_request_id || !idempotency_key) {
    return res.status(400).json({ error: "client_request_id and idempotency_key are required." });
  }

  const existingRequest = state.requests.find(r => r.idempotencyKey === idempotency_key);
  if (existingRequest) {
    return res.json({ success: true, request: existingRequest, state, reconciled: true });
  }

  const tipAmount = Math.max(Number(amount) || 0, state.session.minimumTip);
  const holdAmount = tipAmount;
  const platformFee = 1.0; 

  const isStraightTip = targetType === 'straight_tip' || type === 'tip';

  // If request mode (not a straight tip) and requests are closed, block!
  if (!isStraightTip && !state.session.requestsOpen) {
    return res.status(400).json({ error: "Request submissions are currently closed by the host." });
  }

  // AI shadow ban filter check
  const modResult = checkContentAppropriate(senderName || "Patron", message || "");
  const shadowBanned = !modResult.isAllowed;

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
    status: isStraightTip ? 'fulfilled' : 'hold', // straight tips are accepted instantly
    shadowBanned: shadowBanned,
    createdAt: new Date().toISOString(),
    clientRequestId: client_request_id,
    idempotencyKey: idempotency_key,
    boosts: []
  };

  state.requests.push(newItem);
  recalculateTotals();

  res.json({ 
    success: true, 
    request: newItem,
    state,
    shadowBannedFeedback: shadowBanned ? "Request received and queued for performer review." : null
  });
});

// Boost an existing request
app.post("/api/request/boost", (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
  const { requestId, patronName, boostAmount, client_request_id, idempotency_key } = req.body;
  const amt = Math.max(Number(boostAmount) || 0, 1); // Minimum boost of $1

  if (!client_request_id || !idempotency_key) {
    return res.status(400).json({ error: "client_request_id and idempotency_key are required." });
  }

  const request = state.requests.find(r => r.id === requestId);
  if (!request) {
    return res.status(404).json({ error: "Request not found" });
  }

  const existingBoost = request.boosts.find(b => b.idempotencyKey === idempotency_key);
  if (existingBoost) {
    return res.json({ success: true, request, boost: existingBoost, state, reconciled: true });
  }

  // Shadow moderate backer's name
  const modResult = checkContentAppropriate(patronName || "Patron", "");
  const isBackerShadowed = !modResult.isAllowed;

  const newBoost = {
    id: `boost-${String(client_request_id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)}`,
    patronName: patronName || "Co-Sponsor",
    amount: amt,
    timestamp: new Date().toISOString(),
    clientRequestId: client_request_id,
    idempotencyKey: idempotency_key
  };

  request.boosts.push(newBoost);
  request.amount += amt; // Pool funds!
  request.platformFee += 1.0; // Flat platform fee grows by $1 per boost
  request.sponsorCount += 1;

  if (isBackerShadowed) {
    request.shadowBanned = true; // Cascade shadow ban if the booster is vulgar
  }

  recalculateTotals();
  res.json({ success: true, request, state });
});

// Triage Queue Action (Accept / Deny)
app.post("/api/request/triage", (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
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

  recalculateTotals();
  res.json({ success: true, request, state });
});

// Fulfillment Queue Action (Fulfill)
app.post("/api/request/fulfill", (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
  const { requestId } = req.body;
  const request = state.requests.find(r => r.id === requestId);
  if (!request) {
    return res.status(404).json({ error: "Request not found (could be deleted)" });
  }

  request.status = 'fulfilled';
  recalculateTotals();

  res.json({ success: true, request, state });
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
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

startServer();
