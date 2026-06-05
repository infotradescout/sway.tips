/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from "express";
import path from "path";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import { BackendState, RequestItem, GigSession } from "./src/types";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

// In-memory Database State
let state: BackendState = {
  session: {
    status: 'active',
    talentName: "DJ Shadow",
    talentRole: 'DJ',
    feeType: 'patron', // patron pays $1 platform fee
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
    requestPresets: [
      { id: "p-sys-15", label: "🔥 Speed Round", duration: 15, isSystem: true },
      { id: "p-sys-30", label: "🌟 Mid-Gig Rush", duration: 30, isSystem: true },
      { id: "p-sys-45", label: "🥁 Main Stage Vibe", duration: 45, isSystem: true }
    ],
    totals: {
      totalTips: 85,
      accumulatedFees: 12,
      totalCount: 4,
      topRequest: "Mr. Brightside"
    }
  },
  requests: [
    {
      id: "demo-1",
      type: "request",
      targetType: "music",
      title: "Mr. Brightside",
      subtitle: "The Killers",
      albumArt: "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=150&h=150&fit=crop",
      senderName: "Bachelorette Sarah",
      message: "OMG play this for my girls, we are screaming!!!",
      amount: 45,
      holdAmount: 20,
      platformFee: 3,
      sponsorCount: 3,
      status: "approved",
      shadowBanned: false,
      createdAt: new Date(Date.now() - 3600000).toISOString(),
      boosts: [
        { id: "b1", patronName: "Sarah's Maid of Honor", amount: 15, timestamp: new Date(Date.now() - 1800000).toISOString() },
        { id: "b2", patronName: "Anonymous Giver", amount: 10, timestamp: new Date(Date.now() - 900000).toISOString() }
      ]
    },
    {
      id: "demo-2",
      type: "request",
      targetType: "music",
      title: "Bohemian Rhapsody",
      subtitle: "Queen",
      albumArt: "https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=150&h=150&fit=crop",
      senderName: "Karaoke Guy Mike",
      message: "Please let me sing along on the mic!! Bold move, I know.",
      amount: 25,
      holdAmount: 25,
      platformFee: 1,
      sponsorCount: 1,
      status: "hold", // Starts in private triage queue
      shadowBanned: false,
      createdAt: new Date(Date.now() - 1200000).toISOString(),
      boosts: []
    },
    {
      id: "demo-3",
      type: "request",
      targetType: "music",
      title: "Dancing Queen",
      subtitle: "ABBA",
      albumArt: "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150&h=150&fit=crop",
      senderName: "Dancing Queen Emma",
      message: "Tipping $15 to get this on next! Absolute tune",
      amount: 15,
      holdAmount: 15,
      platformFee: 1,
      sponsorCount: 1,
      status: "approved",
      shadowBanned: false,
      createdAt: new Date(Date.now() - 600000).toISOString(),
      boosts: []
    },
    {
      id: "demo-4",
      type: "tip",
      targetType: "straight_tip",
      title: "Straight Tip",
      subtitle: "Supported the artist directly!",
      senderName: "Gentleman Carl",
      message: "Outstanding mixing tonight, seriously good selections.",
      amount: 20,
      holdAmount: 20,
      platformFee: 1,
      sponsorCount: 1,
      status: "fulfilled", // Direct tips are instantly fulfilled/captured
      shadowBanned: false,
      createdAt: new Date(Date.now() - 2400000).toISOString(),
      boosts: []
    }
  ],
  performers: [
    {
      id: "p-1",
      name: "DJ Shadow",
      role: 'DJ',
      venueName: "The Underground Club",
      isFeatured: false,
      featuredExpiresAt: null,
      minimumTip: 5,
      avatarUrl: "https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=100&h=100&fit=crop"
    },
    {
      id: "p-2",
      name: "The Velvet Voice",
      role: 'Performer',
      venueName: "Jazz & Blues Bistro",
      isFeatured: true,
      featuredExpiresAt: new Date(Date.now() + 7200000).toISOString(), // 2 hours
      minimumTip: 10,
      avatarUrl: "https://images.unsplash.com/photo-1511192336575-5a79af67a629?w=100&h=100&fit=crop"
    },
    {
      id: "p-3",
      name: "Neon Mixer",
      role: 'Bartender',
      venueName: "Atomic Lounge Bar",
      isFeatured: true,
      featuredExpiresAt: new Date(Date.now() + 3600000).toISOString(), // 1 hour
      minimumTip: 5,
      avatarUrl: "https://images.unsplash.com/photo-1574096079513-d8259312b785?w=100&h=100&fit=crop"
    },
    {
      id: "p-4",
      name: "Beatbox Champ Mike",
      role: 'Performer',
      venueName: "Subway Street Corner",
      isFeatured: false,
      featuredExpiresAt: null,
      minimumTip: 3,
      avatarUrl: "https://images.unsplash.com/photo-1498038432885-c6f3f1b912ee?w=100&h=100&fit=crop"
    }
  ]
};

function syncActivePerformer() {
  const activeP = state.performers.find(p => p.id === 'p-1');
  if (activeP) {
    activeP.name = state.session.talentName;
    activeP.role = state.session.talentRole;
    activeP.isFeatured = state.session.isFeatured;
    activeP.featuredExpiresAt = state.session.featuredExpiresAt;
    activeP.minimumTip = state.session.minimumTip;
  }
}

// Lazy Gemini Initialization
let aiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI | null {
  if (!aiClient) {
    const key = process.env.GEMINI_API_KEY;
    if (key && key !== "" && key !== "MY_GEMINI_API_KEY") {
      aiClient = new GoogleGenAI({
        apiKey: key,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });
      console.log("Gemini client successfully initialized.");
    }
  }
  return aiClient;
}

// Global profanity checker using Gemini with structural local fallback
async function checkContentAppropriate(sender: string, text: string): Promise<{ isAllowed: boolean; reason?: string }> {
  const localProfanityWords = ["fudge", "spam", "troll", "abuse", "vulgarword", "asshole", "bitch", "bastard"];
  const contentString = `${sender} ${text}`.toLowerCase();
  
  // Quick regex check
  for (const word of localProfanityWords) {
    if (contentString.includes(word)) {
      console.log(`Local moderation check caught profanity in message: "${contentString}"`);
      return { isAllowed: false, reason: "Inappropriate language filtered." };
    }
  }

  const ai = getGeminiClient();
  if (!ai) {
    return { isAllowed: true }; // No AI configured, fallback default approves
  }

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: `Perform moderation on a crowd requested song tip or patron message.
Context: Mobile live party request app. Patron submits a sender name and a message.
Name: "${sender}"
Message: "${text}"

We must filter out hate speech, racial slurs, heavy harassment, spam, and severe explicit language. Friendly banter, slang, and standard adult expressions are perfectly acceptable in a club/bar atmosphere. Under NO circumstances allow aggressive slurs, explicit sexual solicitations, or threats of violence.

Respond in exact strict JSON format:
{
  "isInappropriate": boolean,
  "reason": string
}`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            isInappropriate: { type: Type.BOOLEAN },
            reason: { type: Type.STRING }
          },
          required: ["isInappropriate", "reason"]
        }
      }
    });

    const body = JSON.parse(response.text?.trim() || "{}");
    if (body.isInappropriate) {
      console.log(`Gemini moderation vetoed message. Reason: ${body.reason}`);
      return { isAllowed: false, reason: body.reason };
    }
    return { isAllowed: true };
  } catch (err) {
    console.warn("Gemini moderation call fell back gracefully:", err);
    return { isAllowed: true };
  }
}

// 5-Minute Timer Closeout Routine Worker
setInterval(() => {
  if (state.session.status === 'ending' && state.session.endGigTimerStartedAt) {
    const startTimeStamp = new Date(state.session.endGigTimerStartedAt).getTime();
    const elapsedTime = Date.now() - startTimeStamp;
    
    // 5 minutes is 300,000 ms. For easier testing, let's keep the real 5 minutes but allow talent to dismiss.
    if (elapsedTime >= 300000) {
      console.log("Post-Gig timer expired! Auto-nuking active holds.");
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
      return { ...req, status: 'denied' }; // Released
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
    requestPresets: [
      { id: "p-sys-15", label: "🔥 Speed Round", duration: 15, isSystem: true },
      { id: "p-sys-30", label: "🌟 Mid-Gig Rush", duration: 30, isSystem: true },
      { id: "p-sys-45", label: "🥁 Main Stage Vibe", duration: 45, isSystem: true }
    ],
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
  if (state.session.status !== 'active') {
    return res.status(400).json({ error: "No active session to end." });
  }
  state.session.status = 'ending';
  state.session.endGigTimerStartedAt = new Date().toISOString();
  res.json({ success: true, state });
});

app.post("/api/session/closeout", (req, res) => {
  executeAutoNuke();
  res.json({ success: true, state });
});

// REQUEST WINDOW MANAGERS & PRESETS ENDPOINTS

// Toggle overall requests status (Manual Mode)
app.post("/api/session/window/toggle", (req, res) => {
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
  const { presetId } = req.body;
  
  state.session.requestPresets = state.session.requestPresets.filter(p => p.id !== presetId);
  res.json({ success: true, state });
});

// Create request + check profanity
app.post("/api/request/create", async (req, res) => {
  const { type, targetType, title, subtitle, senderName, message, amount, albumArt } = req.body;

  const tipAmount = Math.max(Number(amount) || 0, state.session.minimumTip);
  const holdAmount = tipAmount;
  const platformFee = 1.0; 

  const isStraightTip = targetType === 'straight_tip' || type === 'tip';

  // If request mode (not a straight tip) and requests are closed, block!
  if (!isStraightTip && !state.session.requestsOpen) {
    return res.status(400).json({ error: "Request submissions are currently closed by the host." });
  }

  // AI shadow ban filter check
  const modResult = await checkContentAppropriate(senderName || "Patron", message || "");
  const shadowBanned = !modResult.isAllowed;

  const newItem: RequestItem = {
    id: "req-" + Math.random().toString(36).substring(2, 11),
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
    boosts: []
  };

  state.requests.push(newItem);
  recalculateTotals();

  res.json({ 
    success: true, 
    request: newItem,
    state,
    shadowBannedFeedback: shadowBanned ? "Check processed successfully. Authorized hold placed." : null 
  });
});

// Boost an existing request
app.post("/api/request/boost", async (req, res) => {
  const { requestId, patronName, boostAmount } = req.body;
  const amt = Math.max(Number(boostAmount) || 0, 1); // Minimum boost of $1

  const request = state.requests.find(r => r.id === requestId);
  if (!request) {
    return res.status(404).json({ error: "Request not found" });
  }

  // Shadow moderate backer's name
  const modResult = await checkContentAppropriate(patronName || "Patron", "");
  const isBackerShadowed = !modResult.isAllowed;

  const newBoost = {
    id: "boost-" + Math.random().toString(36).substring(2, 11),
    patronName: patronName || "Co-Sponsor",
    amount: amt,
    timestamp: new Date().toISOString()
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
  const { requestId, action } = req.body; // action: 'approve' | 'deny'
  const request = state.requests.find(r => r.id === requestId);
  if (!request) {
    return res.status(404).json({ error: "Request not found" });
  }

  if (action === 'approve') {
    request.status = 'approved';
  } else {
    request.status = 'denied'; // Vecto, hold instantly voided
  }

  recalculateTotals();
  res.json({ success: true, request, state });
});

// Fulfillment Queue Action (Fulfill)
app.post("/api/request/fulfill", (req, res) => {
  const { requestId } = req.body;
  const request = state.requests.find(r => r.id === requestId);
  if (!request) {
    return res.status(404).json({ error: "Request not found (could be deleted)" });
  }

  request.status = 'fulfilled'; // Handled, cash captured!
  recalculateTotals();

  res.json({ success: true, request, state });
});

// Standard & Gemini search integration
app.post("/api/music/search", async (req, res) => {
  const { query, isVoiceOrMood } = req.body;
  
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

  // Check if AI is configured and client explicitly requested mood-based or AI suggestion
  const ai = getGeminiClient();
  if (isVoiceOrMood && ai) {
    try {
      const prompt = `A user at a bar or club requests a song recommendation matching their query or vibe description.
User Vibe: "${query}"
We want to return a realistic matching song from Spotify with a cool artist, title, genre and brief descriptive reasoning.
Return exactly 3 song recommendation options in STRICT JSON list format:
[
  {
    "title": "Song Title",
    "artist": "Artist name",
    "genre": "Genre name",
    "reason": "Cute brief sentence explanation of why this fits their vibe"
  }
]`;

      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                artist: { type: Type.STRING },
                genre: { type: Type.STRING },
                reason: { type: Type.STRING }
              },
              required: ["title", "artist", "genre", "reason"]
            }
          }
        }
      });

      const parsed: any[] = JSON.parse(response.text?.trim() || "[]");
      const results = parsed.map((item, idx) => ({
        id: "ai-" + idx + "-" + Math.random().toString(36).substring(2, 6),
        title: item.title,
        artist: item.artist,
        albumArt: [
          "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=150&h=150&fit=crop",
          "https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=150&h=150&fit=crop",
          "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=150&h=150&fit=crop"
        ][idx % 3],
        description: item.reason,
        genre: item.genre
      }));

      return res.json({ results, generatedByAI: true });
    } catch (e) {
      console.warn("AI music selection query failed, falling back to basic matching:", e);
    }
  }

  // Local matching fallback
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
