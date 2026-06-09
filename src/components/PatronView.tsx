/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { 
  CreditCard, 
  Search, 
  Coins, 
  Sparkles, 
  ArrowUp, 
  TrendingUp, 
  Check, 
  AlertCircle, 
  Lock, 
  Smartphone, 
  DollarSign, 
  Music, 
  Layers, 
  Flame, 
  Activity,
  Award,
  QrCode
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { TrackReference, RequestItem, GigSession, CustomMenuItem, PerformerProfile } from '../types';

const PENDING_ACTION_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_ACTION_RETRIES = 3;
const PENDING_ACTION_EXPIRED_COPY = 'Network dropped. Your request expired and you were not charged.';
const CAPTIVE_PORTAL_BLOCK_COPY = 'Network sign-in required. Connect to the venue Wi-Fi or switch to cellular before sending a request. You were not charged.';

interface PatronViewProps {
  session: GigSession;
  requests: RequestItem[];
  performers: PerformerProfile[];
  gigId?: string;
  onCreateRequest: (data: {
    type: 'request' | 'tip';
    targetType: 'music' | 'custom' | 'straight_tip';
    title: string;
    subtitle: string;
    senderName: string;
    message?: string;
    amount: number;
    albumArt?: string;
    client_request_id?: string;
    idempotency_key?: string;
    expires_at?: string;
    gig_id?: string;
  }) => Promise<any>;
  onBoostRequest: (requestId: string, patronName: string, amount: number, clientRequestId?: string, idempotencyKey?: string, expiresAt?: string, gigId?: string) => Promise<any>;
  onReconcilePendingAction: (clientRequestId: string, idempotencyKey: string) => Promise<any>;
  onReportContent: (requestId: string, reason: string, details?: string) => Promise<any>;
  onBlockFoundation: (scope: 'patron_user_id' | 'patron_device_id_hash' | 'sender_name', value: string, reason: string) => Promise<any>;
  onSupportContact: () => Promise<any>;
  onDataDeletionPlaceholder: () => Promise<any>;
  previewMode?: boolean;
}

type SearchTrack = {
  id: string;
  title: string;
  artist: string;
  albumArt?: string;
  basePrice?: number;
  description?: string;
  source?: string;
  targetType?: 'music' | 'custom';
};

const previewCatalog: SearchTrack[] = [
  {
    id: 'spotify-1',
    title: 'Levitating',
    artist: 'Dua Lipa',
    albumArt: 'https://images.unsplash.com/photo-1511379938547-c1f69419868d?auto=format&fit=crop&w=240&q=80',
    basePrice: 8,
    source: 'Spotify'
  },
  {
    id: 'apple-1',
    title: 'Blinding Lights',
    artist: 'The Weeknd',
    albumArt: 'https://images.unsplash.com/photo-1518976024611-28bf4b48222e?auto=format&fit=crop&w=240&q=80',
    basePrice: 8,
    source: 'Apple Music'
  },
  {
    id: 'youtube-1',
    title: 'Titanium',
    artist: 'David Guetta ft. Sia',
    albumArt: 'https://images.unsplash.com/photo-1516280440614-37939bbacd81?auto=format&fit=crop&w=240&q=80',
    basePrice: 8,
    source: 'YouTube Music'
  },
  {
    id: 'tidal-1',
    title: 'About Damn Time',
    artist: 'Lizzo',
    albumArt: 'https://images.unsplash.com/photo-1461783436728-0a9217714694?auto=format&fit=crop&w=240&q=80',
    basePrice: 8,
    source: 'TIDAL'
  }
];

export default function PatronView({
  session,
  requests,
  performers,
  gigId,
  onCreateRequest,
  onBoostRequest,
  onReconcilePendingAction,
  onReportContent,
  onBlockFoundation,
  onSupportContact,
  onDataDeletionPlaceholder,
  previewMode = false
}: PatronViewProps) {
  const requestPresets: Array<{ id: string; label: string; subtitle: string; amount: number; targetType: 'music' | 'custom' }> = session.talentRole === 'DJ'
    ? [
        { id: 'preset-shoutout', label: '$5 Shoutout', subtitle: 'Quick crowd shoutout', amount: 5, targetType: 'custom' },
        { id: 'preset-bump', label: '$10 Bump the Queue', subtitle: 'Push your moment higher', amount: 10, targetType: 'custom' },
        { id: 'preset-vip-song', label: '$20 VIP Song Request', subtitle: 'Priority song request', amount: 20, targetType: 'music' }
      ]
    : [
        { id: 'preset-shoutout', label: '$5 Shoutout', subtitle: 'Quick audience shoutout', amount: 5, targetType: 'custom' },
        { id: 'preset-bump', label: '$10 Bump the Queue', subtitle: 'Prioritize your request', amount: 10, targetType: 'custom' },
        { id: 'preset-vip', label: '$20 VIP Request', subtitle: 'Premium priority action', amount: 20, targetType: 'custom' }
      ];

  // Navigation Tabs
  const [activeTab, setActiveTab] = useState<'request' | 'tip' | 'ladder' | 'discover'>('request');
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);

  // Search Venue Directory States
  const [directorySearch, setDirectorySearch] = useState('');
  const [selectedDirectoryPerformer, setSelectedDirectoryPerformer] = useState<PerformerProfile | null>(null);
  const [showDirQrCodeModal, setShowDirQrCodeModal] = useState<PerformerProfile | null>(null);
  
  // Search parameters
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchTrack[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  
  // Selected search target
  const [selectedTrack, setSelectedTrack] = useState<SearchTrack | null>(null);

  // Input states
  const [senderName, setSenderName] = useState('');
  const [commentMessage, setCommentMessage] = useState('');
  const [tipAmount, setTipAmount] = useState<number>(session.minimumTip);
  
  // Boost Modal State
  const [boostingItem, setBoostingItem] = useState<RequestItem | null>(null);
  const [boostPatronName, setBoostPatronName] = useState('');
  const [boostAmount, setBoostAmount] = useState<number>(5);

  // Temporary checkout overlay until the real payment processor flow is implemented.
  const [checkoutPayload, setCheckoutPayload] = useState<{
    open: boolean;
    type: 'request' | 'boost';
    title: string;
    artist?: string;
    amount: number;
    fee: number;
    total: number;
    targetId?: string; // used for boost routing
    trackArt?: string;
    clientRequestId: string;
    idempotencyKey: string;
    expires_at: string;
    gigId: string;
  } | null>(null);

  const [backendConfirmed, setBackendConfirmed] = useState(false);
  const [isPaying, setIsPaying] = useState(false);
  const [degraded, setDegraded] = useState(!navigator.onLine);
  const [pendingAction, setPendingAction] = useState<string | null>(() => localStorage.getItem('sway.pendingAction'));
  const [pendingActionMessage, setPendingActionMessage] = useState('');
  const [networkPreflightStatus, setNetworkPreflightStatus] = useState<'unknown' | 'ready' | 'blocked'>('unknown');

  const latestRequest = [...requests]
    .filter((item) => !item.hidden && !item.removed)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

  const activePatronStatus: 'Pending network' | 'Received' | 'Approved' | 'Session paused' | 'Session ended' =
    session.status === 'closed'
      ? 'Session ended'
      : (!session.requestsOpen || session.status === 'ending')
        ? 'Session paused'
        : (degraded || !!pendingAction)
          ? 'Pending network'
          : latestRequest?.status === 'approved' || latestRequest?.status === 'fulfilled'
            ? 'Approved'
            : 'Received';

  const moderationStatusLabel: 'pending_review' | 'approved' | 'declined' | 'hidden' | 'blocked' | 'played/completed' =
    latestRequest?.hidden || latestRequest?.removed
      ? 'hidden'
      : latestRequest?.shadowBanned
        ? 'pending_review'
        : latestRequest?.status === 'approved'
          ? 'approved'
          : latestRequest?.status === 'denied'
            ? 'declined'
            : latestRequest?.status === 'fulfilled'
              ? 'played/completed'
              : latestRequest?.status === 'hold'
                ? 'pending_review'
                : 'pending_review';

  useEffect(() => {
    const updateConnectionState = () => setDegraded(!navigator.onLine);
    window.addEventListener('online', updateConnectionState);
    window.addEventListener('offline', updateConnectionState);
    return () => {
      window.removeEventListener('online', updateConnectionState);
      window.removeEventListener('offline', updateConnectionState);
    };
  }, []);

  useEffect(() => {
    const storedPendingAction = localStorage.getItem('sway.pendingAction');
    if (!storedPendingAction) return;
    let cancelled = false;

    try {
      const parsed = JSON.parse(storedPendingAction);
      if (parsed.expires_at && Date.now() > new Date(parsed.expires_at).getTime()) {
        localStorage.removeItem('sway.pendingAction');
        setPendingAction(null);
        setPendingActionMessage(PENDING_ACTION_EXPIRED_COPY);
        return;
      }

      if (!parsed.clientRequestId || !parsed.idempotencyKey) {
        localStorage.removeItem('sway.pendingAction');
        setPendingAction(null);
        return;
      }

      setDegraded(true);
      setPendingAction(storedPendingAction);
      setPendingActionMessage('Reconnecting to confirm your pending action.');

      onReconcilePendingAction(parsed.clientRequestId, parsed.idempotencyKey)
        .then((result) => {
          if (cancelled) return;
          if (result?.status === 'reconciled') {
            localStorage.removeItem('sway.pendingAction');
            setPendingAction(null);
            setPendingActionMessage('');
            window.dispatchEvent(new Event('re-fetch-state'));
            return;
          }
          if (result?.status === 'pending') {
            setDegraded(true);
            setPendingActionMessage('Connection degraded. Your pending action is still awaiting backend confirmation.');
          }
        })
        .catch((error: any) => {
          if (cancelled) return;
          setDegraded(true);
          if (error?.status === 410) {
            localStorage.removeItem('sway.pendingAction');
            setPendingAction(null);
            setPendingActionMessage(PENDING_ACTION_EXPIRED_COPY);
            return;
          }
          setPendingActionMessage('Connection degraded. Sway will retry reconciliation when the network is available.');
        });
    } catch {
      localStorage.removeItem('sway.pendingAction');
      setPendingAction(null);
    }

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 3000);

    fetch('/api/health/network-probe', {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      signal: controller.signal
    })
      .then((response) => {
        const contentType = response.headers.get('content-type') || '';
        setNetworkPreflightStatus(response.status === 204 && !contentType.includes('text/html') ? 'ready' : 'blocked');
      })
      .catch(() => setNetworkPreflightStatus('blocked'))
      .finally(() => window.clearTimeout(timeout));

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, []);

  const createClientActionIds = () => {
    const id = globalThis.crypto?.randomUUID?.() || `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return {
      clientRequestId: id,
      idempotencyKey: `sway:${id}`,
      expires_at: new Date(Date.now() + PENDING_ACTION_TTL_MS).toISOString()
    };
  };

  const waitForRetryBackoff = (attempt: number) =>
    new Promise((resolve) => window.setTimeout(resolve, Math.min(2 ** attempt * 500, 3000)));

  const submitWithBoundedRetry = async (submitAction: () => Promise<any>, expiresAt: string) => {
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_PENDING_ACTION_RETRIES; attempt += 1) {
      if (Date.now() > new Date(expiresAt).getTime()) {
        throw Object.assign(new Error(PENDING_ACTION_EXPIRED_COPY), { status: 410 });
      }

      try {
        const response = await submitAction();
        if (response?.success || response?.reconciled) return response;
        throw new Error('Backend did not confirm the action.');
      } catch (error: any) {
        lastError = error;
        if (error?.status === 409 || error?.status === 410 || error?.status === 400 || error?.status === 403 || error?.status === 429) throw error;
        setDegraded(true);
        setPendingActionMessage('Connection degraded. Retrying safely with the same idempotency key.');
        if (attempt < MAX_PENDING_ACTION_RETRIES - 1) {
          await waitForRetryBackoff(attempt);
        }
      }
    }

    throw lastError;
  };

  // Pre-built customizable menus for bartenders / street performers
  const customItems: CustomMenuItem[] = session.talentRole === 'Bartender' ? [
    { id: "c1", title: "Skip the Line Cocktail", description: "Veto checkout crowds. Bartender mixes your drink immediately.", basePrice: 10, iconName: "🍹" },
    { id: "c2", title: "Special Shot Round", description: "Bartender generates a custom premium fire shot selection.", basePrice: 15, iconName: "🔥" },
    { id: "c3", title: "Buy the Bartender a Pint", description: "Show some absolute love to the crew behind the bar.", basePrice: 8, iconName: "🍺" }
  ] : [
    { id: "p1", title: "Card in Shoe Mind-Melter", description: "Street performer slips signed deck card into your shoe.", basePrice: 15, iconName: "🃏" },
    { id: "p2", title: "Custom Balloon Crown", description: "Instant customized structural balloon crown manufactured.", basePrice: 10, iconName: "🎈" },
    { id: "p3", title: "Dedicate Next Stunt", description: "Performer dedicates a highly risky physical fire act to you.", basePrice: 20, iconName: "🎪" }
  ];

  // Load Initial Standard Suggestions
  useEffect(() => {
    handleSearch('');
  }, []);

  useEffect(() => {
    if (activeTab !== 'request') return;
    if (selectedTrack || requestPresets.length === 0) return;

    const firstPreset = requestPresets[0];
    setSelectedPresetId(firstPreset.id);
    setSelectedTrack({
      id: firstPreset.id,
      title: firstPreset.label.replace(/^\$\d+\s*/, ''),
      artist: firstPreset.subtitle,
      albumArt: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=240&q=80',
      basePrice: firstPreset.amount,
      targetType: firstPreset.targetType,
      source: 'Sway Preset'
    });
    setTipAmount(Math.max(session.minimumTip, firstPreset.amount));
  }, [activeTab, selectedTrack, requestPresets, session.minimumTip]);

  // Live request window countdown for patron
  const [patronsWindowTimeLeft, setPatronsWindowTimeLeft] = useState<string>('');

  useEffect(() => {
    if (!session.requestsOpen || session.requestWindowMode !== 'preset' || !session.requestWindowExpiresAt) {
      setPatronsWindowTimeLeft('');
      return;
    }

    const updateTimer = () => {
      const expireMs = new Date(session.requestWindowExpiresAt!).getTime();
      const diff = expireMs - Date.now();

      if (diff <= 0) {
        setPatronsWindowTimeLeft('');
      } else {
        const mins = Math.floor(diff / 60000);
        const secs = Math.floor((diff % 60000) / 1000);
        const sString = secs < 10 ? `0${secs}` : secs;
        setPatronsWindowTimeLeft(`${mins}:${sString}`);
      }
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [session.requestsOpen, session.requestWindowMode, session.requestWindowExpiresAt]);

  const handleSearch = async (val: string) => {
    setSearchQuery(val);
    setIsSearching(true);

    if (previewMode && session.talentRole === 'DJ') {
      const query = val.trim().toLowerCase();
      const filtered = previewCatalog.filter((song) => {
        if (!query) return true;
        return song.title.toLowerCase().includes(query)
          || song.artist.toLowerCase().includes(query)
          || (song.source || '').toLowerCase().includes(query);
      });

      const anySongOption: SearchTrack | null = query
        ? {
            id: `any-${query.replace(/\s+/g, '-')}`,
            title: val.trim(),
            artist: 'Any source accepted',
            albumArt: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=240&q=80',
            basePrice: session.minimumTip,
            description: 'Open request across linked music apps',
            source: 'Any Library'
          }
        : null;

      setSearchResults(anySongOption ? [anySongOption, ...filtered] : filtered);
      setIsSearching(false);
      return;
    }

    try {
      const response = await fetch('/api/music/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: val })
      });
      const data = await response.json();
      setSearchResults(data.results || []);
    } catch (e) {
      console.warn("Search endpoint errored out:", e);
    } finally {
      setIsSearching(false);
    }
  };

  const triggerSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleSearch(searchQuery);
  };

  const handleSelectTrack = (track: any) => {
    setSelectedTrack(track);
    // Auto populate minimum or baseline price
    setTipAmount(Math.max(session.minimumTip, track.basePrice || session.minimumTip));
  };

  // Open test checkout
  const initiateCheckout = (type: 'request' | 'boost') => {
    if (session.status === 'closed') return;

    if (networkPreflightStatus !== 'ready') {
      setDegraded(true);
      setPendingActionMessage(CAPTIVE_PORTAL_BLOCK_COPY);
      alert(CAPTIVE_PORTAL_BLOCK_COPY);
      return;
    }

    if (!gigId) {
      const routeCopy = 'This QR route is missing a valid gig ID. Scan the performer gig QR again.';
      setDegraded(true);
      setPendingActionMessage(routeCopy);
      alert(routeCopy);
      return;
    }

    if (type === 'request' && activeTab === 'request' && !session.requestsOpen) {
      alert("Request submissions are temporarily closed or locked by the host. Feel free to support via 'Direct cash tip' instead!");
      return;
    }
    
    let title = '';
    let artist = '';
    let trackArt = '';
    let amt = 0;

    if (type === 'request') {
      if (!senderName) {
        alert("Please enter a Patron Name so the Performer knows who tipped!");
        return;
      }
      if (tipAmount < session.minimumTip) {
        alert(`Minimum tip required is $${session.minimumTip}`);
        return;
      }

      if (session.talentRole === 'DJ') {
        if (!selectedTrack) {
          alert("Please search and select a song request first!");
          return;
        }
        title = selectedTrack.title;
        artist = selectedTrack.artist;
        trackArt = selectedTrack.albumArt;
      } else {
        // Custom menus
        if (!selectedTrack) {
          alert("Please select an item from the menu!");
          return;
        }
        title = selectedTrack.title;
        artist = selectedTrack.description;
        trackArt = '';
      }
      amt = tipAmount;
    } else {
      // Boost check
      if (!boostingItem) return;
      if (!boostPatronName) {
        alert("Please enter your sponsor name for the boost leaderboard!");
        return;
      }
      if (boostAmount < 1) {
        alert("Minimum boost is $1");
        return;
      }
      title = boostingItem.title;
      artist = boostingItem.subtitle;
      amt = boostAmount;
    }

    const platformFee = session.feeType === 'patron' ? 1.0 : 0;
    const total = amt + platformFee;

    setCheckoutPayload({
      open: true,
      type,
      title,
      artist,
      amount: amt,
      fee: platformFee,
      total,
      targetId: boostingItem?.id,
      trackArt,
      gigId,
      ...createClientActionIds()
    });
  };

  // Process optimistic success payment
  const completePayment = async () => {
    if (!checkoutPayload) return;

    if (Date.now() > new Date(checkoutPayload.expires_at).getTime()) {
      setCheckoutPayload(null);
      setPendingAction(null);
      setPendingActionMessage(PENDING_ACTION_EXPIRED_COPY);
      localStorage.removeItem('sway.pendingAction');
      alert(PENDING_ACTION_EXPIRED_COPY);
      return;
    }

    setIsPaying(true);
    const serializedPendingAction = JSON.stringify(checkoutPayload);
    setPendingAction(serializedPendingAction);
    localStorage.setItem('sway.pendingAction', serializedPendingAction);

    try {
      if (checkoutPayload.type === 'request') {
        const isCustom = session.talentRole !== 'DJ';
        await submitWithBoundedRetry(() => onCreateRequest({
          type: 'request',
          targetType: selectedTrack?.targetType || (isCustom ? 'custom' : 'music'),
          title: checkoutPayload.title,
          subtitle: checkoutPayload.artist || '',
          senderName: senderName,
          message: commentMessage,
          amount: checkoutPayload.amount,
          albumArt: checkoutPayload.trackArt,
          client_request_id: checkoutPayload.clientRequestId,
          idempotency_key: checkoutPayload.idempotencyKey,
          expires_at: checkoutPayload.expires_at,
          gig_id: checkoutPayload.gigId
        }), checkoutPayload.expires_at);
      } else {
        // Boost routing!
        if (checkoutPayload.targetId) {
          await submitWithBoundedRetry(() => onBoostRequest(
            checkoutPayload.targetId,
            boostPatronName,
            checkoutPayload.amount,
            checkoutPayload.clientRequestId,
            checkoutPayload.idempotencyKey,
            checkoutPayload.expires_at,
            checkoutPayload.gigId
          ), checkoutPayload.expires_at);
        }
      }

      // Show high impact check animation
      setBackendConfirmed(true);
      setPendingAction(null);
      localStorage.removeItem('sway.pendingAction');
      setTimeout(() => {
        // Reset inputs
        setBackendConfirmed(false);
        setCheckoutPayload(null);
        setBoostingItem(null);
        setSelectedTrack(null);
        setCommentMessage('');
        setSenderName('');
        setBoostPatronName('');
        setTipAmount(session.minimumTip);
        setActiveTab('ladder'); // Go check their position on the ladder!
      }, 2000);

    } catch (e) {
      console.error(e);
      setDegraded(true);
      const status = (e as any)?.status;
      const backendMessage = (e as any)?.body?.error;

      if (status === 410) {
        setPendingActionMessage(PENDING_ACTION_EXPIRED_COPY);
        setPendingAction(null);
        setCheckoutPayload(null);
        localStorage.removeItem('sway.pendingAction');
      } else if (status === 403) {
        setPendingActionMessage(backendMessage || 'Request blocked for this session. Try a different preset or ask venue staff for help.');
        setPendingAction(null);
        setCheckoutPayload(null);
        localStorage.removeItem('sway.pendingAction');
      } else if (status === 429) {
        setPendingActionMessage(backendMessage || "You've reached the request limit for this session. Try again later as the queue moves.");
        setPendingAction(null);
        setCheckoutPayload(null);
        localStorage.removeItem('sway.pendingAction');
      } else if (status === 409 || status === 400) {
        setPendingActionMessage(backendMessage || 'This action is not available right now.');
        setPendingAction(null);
        setCheckoutPayload(null);
        localStorage.removeItem('sway.pendingAction');
      }
    } finally {
      setIsPaying(false);
    }
  };

  // Straight classic tipping logic bypass
  const handleStraightTipSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (networkPreflightStatus !== 'ready') {
      setDegraded(true);
      setPendingActionMessage(CAPTIVE_PORTAL_BLOCK_COPY);
      alert(CAPTIVE_PORTAL_BLOCK_COPY);
      return;
    }

    if (!gigId) {
      const routeCopy = 'This QR route is missing a valid gig ID. Scan the performer gig QR again.';
      setDegraded(true);
      setPendingActionMessage(routeCopy);
      alert(routeCopy);
      return;
    }

    if (!senderName) {
      alert("Please enter a Patron Name!");
      return;
    }
    if (tipAmount < session.minimumTip) {
      alert(`Minimum tip is $${session.minimumTip}`);
      return;
    }

    const platformFee = session.feeType === 'patron' ? 1.0 : 0;
    setCheckoutPayload({
      open: true,
      type: 'request',
      title: 'Classic Tip',
      artist: 'Straight tip supporting the performer directly!',
      amount: tipAmount,
      fee: platformFee,
      total: tipAmount + platformFee,
      gigId,
      ...createClientActionIds()
    });
  };

  const getFormat = (val: number) => {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val);
  };

  const approvedLadder = requests
    .filter(r => (r.status === 'approved' || r.status === 'fulfilled') && !r.hidden && !r.removed)
    .sort((a, b) => b.amount - a.amount);

  const newestModeratableRequest = requests.find((item) => !item.removed);

  const runSafetyAction = async (action: () => Promise<any>, successCopy: string) => {
    try {
      await action();
      alert(successCopy);
      window.dispatchEvent(new Event('re-fetch-state'));
    } catch (error) {
      console.error(error);
      alert('Safety action failed. Try again in a few moments.');
    }
  };

  return (
    <div id="patron_crowd_screen" className="max-w-xl mx-auto py-4 px-4 pb-20 space-y-6">
      
      {/* 1. Performer branding hero banner */}
      <div className="bg-gradient-to-br from-fuchsia-950/40 via-slate-904 via-slate-900 to-slate-950 border border-white/10 rounded-2xl p-6 relative overflow-hidden select-none glow-fuchsia">
        <div className="absolute top-0 right-0 p-3">
          <span className="flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-cyan-500"></span>
          </span>
        </div>
        <div className="relative z-10 flex flex-col items-center text-center space-y-2">
          <div className="w-12 h-12 rounded-full bg-gradient-to-tr from-fuchsia-600 to-blue-600 border border-white/10 flex items-center justify-center font-display text-white font-extrabold text-lg animate-pulse shadow-md">
            {session.talentName.charAt(0)}
          </div>
          <h1 className="font-display text-lg font-black text-white tracking-wider uppercase">
            SWAY ME: {session.talentName}
          </h1>
          {patronsWindowTimeLeft && (
            <div className="bg-cyan-950/40 border border-cyan-500/30 px-3 py-1 rounded-full flex items-center gap-1.5 text-[10px] font-mono text-cyan-400 select-none shadow shadow-cyan-500/15 animate-pulse-subtle">
              <span className="w-1.5 h-1.5 bg-cyan-400 rounded-full animate-ping" />
              <span>REQUESTS EXPIRE IN: {patronsWindowTimeLeft}</span>
            </div>
          )}
          <p className="text-xs text-slate-300 max-w-sm leading-relaxed font-sans">
            {previewMode
              ? 'Preview data only. No checkout/payment/moderation action will be sent.'
              : `Sway ${session.talentName || 'this performer'} on stage through the live ladder. Payment processing is not yet enabled in this build.`}
          </p>
        </div>
      </div>

      {/* Room Layer: Now Playing / Up Next + honest operating mode */}
      {(() => {
        const visible = requests.filter(r => !r.hidden && !r.removed && !r.shadowBanned);
        const nowPlaying = visible
          .filter(r => r.status === 'fulfilled' && r.type !== 'tip')
          .slice()
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] ?? null;
        const upNext = visible
          .filter(r => r.status === 'approved')
          .slice()
          .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0))
          .slice(0, 3);
        const isOpenCall = session.operatingMode === 'open_call';
        const modeLabel = isOpenCall ? 'Open Call' : 'Manual';
        const modeHint = isOpenCall
          ? 'No catalog — send an open request'
          : 'Host is driving the room live';
        return (
          <div className="bg-slate-900/70 border border-white/10 rounded-2xl p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-bold tracking-widest uppercase text-slate-400">
                {nowPlaying ? 'Current Moment' : 'Live Now'}
              </span>
              <span
                className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-950 border border-white/10 text-cyan-300"
                title={modeHint}
              >
                {modeLabel}
              </span>
            </div>

            {nowPlaying ? (
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-xl bg-gradient-to-tr from-fuchsia-600/30 to-blue-600/30 border border-white/10 flex items-center justify-center shrink-0">
                  <Music className="w-5 h-5 text-cyan-300" />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-bold text-white truncate">{nowPlaying.title}</div>
                  {nowPlaying.subtitle && (
                    <div className="text-[11px] text-slate-400 truncate">{nowPlaying.subtitle}</div>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-[11px] text-slate-400">{modeHint}.</p>
            )}

            {upNext.length > 0 && (
              <div className="pt-1 border-t border-white/5 space-y-1.5">
                <div className="text-[10px] font-bold tracking-widest uppercase text-slate-500">Up Next</div>
                {upNext.map((r, i) => (
                  <div key={r.id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate text-slate-200">
                      <span className="text-slate-500 mr-1.5">{i + 1}.</span>{r.title}
                    </span>
                    <span className="font-mono text-cyan-300 shrink-0">${r.amount}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {/* Mode Lock Warning (If gig closed/ending) */}
      {session.status !== 'active' && session.status !== 'ending' && (
        <div className="bg-fuchsia-950/25 border border-fuchsia-900/30 rounded-xl p-4 flex gap-3 text-fuchsia-300">
          <AlertCircle className="w-5 h-5 shrink-0 mt-0.5 animate-bounce" />
          <div className="text-xs font-sans">
            <div className="font-bold">Gig Workspace Locked</div>
            <p className="mt-0.5 text-slate-400 leading-relaxed font-sans">
              New song checks and item submissions have been locked. Holds are being auto-released inside the final 5-minute safety sweep.
            </p>
          </div>
        </div>
      )}

      <div className="bg-slate-900/70 border border-white/10 rounded-xl p-4 space-y-3">
        <div>
          <h3 className="text-xs font-bold tracking-wider uppercase text-slate-200">Safety Controls</h3>
          <p className="text-[11px] text-slate-400 mt-1">App Store UGC placeholders: report, block, remove/hide, support/contact, and data deletion intake.</p>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => {
              if (!newestModeratableRequest) {
                alert('No request is available to report yet.');
                return;
              }
              runSafetyAction(
                () => onReportContent(newestModeratableRequest.id, 'Patron report placeholder', 'User-reported content check requested.'),
                'Report submitted for moderator review.'
              );
            }}
            className="px-3 py-2 rounded-lg text-xs font-bold bg-slate-950 border border-white/10 text-slate-200 hover:border-fuchsia-500/40 cursor-pointer"
          >
            Report
          </button>

          <button
            type="button"
            onClick={() => runSafetyAction(
              () => onBlockFoundation('patron_device_id_hash', 'anonymous-device', 'Patron device block placeholder requested.'),
              'Device block placeholder recorded.'
            )}
            className="px-3 py-2 rounded-lg text-xs font-bold bg-slate-950 border border-white/10 text-slate-200 hover:border-fuchsia-500/40 cursor-pointer"
          >
            Block
          </button>

          <button
            type="button"
            onClick={() => runSafetyAction(onSupportContact, 'Support/contact placeholder opened.')}
            className="px-3 py-2 rounded-lg text-xs font-bold bg-slate-950 border border-white/10 text-slate-200 hover:border-fuchsia-500/40 cursor-pointer"
          >
            Support / Contact
          </button>

          <button
            type="button"
            onClick={() => runSafetyAction(onDataDeletionPlaceholder, 'Data deletion placeholder submitted.')}
            className="px-3 py-2 rounded-lg text-xs font-bold bg-slate-950 border border-white/10 text-slate-200 hover:border-fuchsia-500/40 cursor-pointer"
          >
            Data Deletion Placeholder
          </button>
        </div>
      </div>

      {/* 2. Primary Tabs Selector */}
      {session.status === 'active' && (
        <div className="flex bg-slate-900 border border-white/10 p-1.5 rounded-xl">
          <button
            onClick={() => { setActiveTab('request'); setSelectedTrack(null); }}
            className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
              activeTab === 'request'
                ? 'bg-fuchsia-600 text-white shadow-lg glow-fuchsia'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            {session.talentRole === 'DJ' ? <Music className="w-4 h-4" /> : <Layers className="w-4 h-4" />}
            {session.talentRole === 'DJ' ? "Request Track" : "Action Menu"}
          </button>

          <button
            onClick={() => { setActiveTab('tip'); setSelectedTrack({ title: 'Classic Tip', description: 'Straight tip supporting the performer directly!', basePrice: session.minimumTip }); }}
            className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
              activeTab === 'tip'
                ? 'bg-fuchsia-600 text-white shadow-lg glow-fuchsia'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Coins className="w-4 h-4" /> Just the Tip
          </button>

          <button
            onClick={() => setActiveTab('ladder')}
            className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
              activeTab === 'ladder'
                ? 'bg-fuchsia-600 text-white shadow-lg glow-fuchsia'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Activity className="w-4 h-4" /> Leaderboard
          </button>

          <button
            onClick={() => { setActiveTab('discover'); setSelectedDirectoryPerformer(null); }}
            className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
              activeTab === 'discover'
                ? 'bg-fuchsia-600 text-white shadow-lg glow-fuchsia'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Sparkles className="w-4 h-4" /> Discover Stage
          </button>
        </div>
      )}

      {/* 3. Core Action Panels */}
      {(degraded || pendingAction) && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-3 text-xs text-amber-200">
          {pendingActionMessage || 'Connection degraded. Sway saved your pending action locally and will reconcile with the server before showing confirmation.'}
        </div>
      )}

      <div className="bg-slate-900/70 border border-white/10 rounded-xl p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-xs font-bold tracking-wider uppercase text-slate-200">Request status</h3>
          <span className="text-[10px] font-mono text-fuchsia-300 uppercase tracking-widest">Current: {activePatronStatus}</span>
        </div>
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-5 gap-2 text-[10px]">
          {['Pending network', 'Received', 'Approved', 'Session paused', 'Session ended'].map((status) => (
            <div
              key={status}
              className={`rounded-lg border px-2 py-2 text-center font-bold ${activePatronStatus === status ? 'border-fuchsia-400 bg-fuchsia-500/15 text-fuchsia-200' : 'border-white/10 bg-slate-950 text-slate-400'}`}
            >
              {status}
            </div>
          ))}
        </div>

        <div className="mt-3 border-t border-white/10 pt-3">
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Moderation state</h4>
            <span className="text-[10px] font-mono uppercase tracking-widest text-cyan-300">{moderationStatusLabel}</span>
          </div>
          <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-2 text-[10px]">
            {['pending_review', 'approved', 'declined', 'hidden', 'blocked', 'played/completed'].map((state) => (
              <div
                key={state}
                className={`rounded-lg border px-2 py-2 text-center font-bold ${moderationStatusLabel === state ? 'border-cyan-400 bg-cyan-500/15 text-cyan-100' : 'border-white/10 bg-slate-950 text-slate-500'}`}
              >
                {state}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div id="patron_action_panel">
        
        {/* TAB A: Dynamic Search & Selection (Music / Custom Menu) */}
        {activeTab === 'request' && session.status === 'active' && (
          <div className="space-y-5">
            {!session.requestsOpen ? (
              <motion.div 
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                className="bg-slate-900 border border-fuchsia-500/20 p-6 rounded-2xl text-center space-y-4 select-none relative overflow-hidden"
              >
                <div className="absolute -top-10 -right-10 w-24 h-24 bg-rose-500/10 rounded-full blur-2xl"></div>
                <div className="mx-auto w-12 h-12 rounded-full bg-rose-950/40 border border-rose-500/20 flex items-center justify-center text-rose-400">
                  <Lock className="w-6 h-6 animate-pulse" />
                </div>
                <div className="space-y-1">
                  <h3 className="font-display font-extrabold text-white text-base tracking-wide uppercase">
                    Queue Temporarily Closed
                  </h3>
                  <p className="text-xs text-slate-400 max-w-sm mx-auto leading-relaxed font-sans">
                    {session.talentName} has temporarily paused new track requests to catch up with the active ladder.
                  </p>
                </div>
                
                <div className="p-3 bg-slate-950 border border-white/5 rounded-xl font-mono text-2xs space-y-1.5 min-w-0">
                  <span className="text-fuchsia-400 font-bold block select-none">💡 WHAT YOU CAN STILL DO:</span>
                  <div className="text-slate-400 space-y-1 font-sans text-xs">
                    <p>• Send a <strong className="text-emerald-400">Direct Cash Tip</strong> to show love</p>
                    <p>• <strong className="text-cyan-400">Boost existing requests</strong> on the leaderboard to push them up</p>
                    <p>• Discover other live performers near you</p>
                  </div>
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setActiveTab('tip');
                      setSelectedTrack({ title: 'Classic Tip', description: 'Straight tip supporting the performer directly!', basePrice: session.minimumTip });
                    }}
                    className="flex-1 py-2.5 bg-fuchsia-600 hover:bg-fuchsia-500 text-white text-xs font-bold rounded-xl shadow-lg transition-colors cursor-pointer"
                  >
                    💖 Support Performer Directly
                  </button>
                  <button
                    onClick={() => setActiveTab('ladder')}
                    className="flex-1 py-2.5 bg-slate-950 border border-white/5 text-slate-300 hover:text-white text-xs font-bold rounded-xl transition-colors cursor-pointer"
                  >
                    📊 View Leaderboard
                  </button>
                </div>
              </motion.div>
            ) : (
              <>
            
            {/* If DJ Role: Search verified catalog */}
            {session.talentRole === 'DJ' && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <div className="text-xs font-mono font-bold text-slate-500 uppercase tracking-widest select-none">
                    Quick presets
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {requestPresets.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => {
                          setSelectedPresetId(preset.id);
                          setSelectedTrack({
                            id: preset.id,
                            title: preset.label.replace(/^\$\d+\s*/, ''),
                            artist: preset.subtitle,
                            albumArt: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=240&q=80',
                            basePrice: preset.amount,
                            targetType: preset.targetType,
                            source: 'Sway Preset'
                          });
                          setTipAmount(Math.max(session.minimumTip, preset.amount));
                        }}
                        className={`rounded-lg border px-3 py-2 text-left transition-colors cursor-pointer ${selectedPresetId === preset.id ? 'border-fuchsia-400 bg-fuchsia-500/15' : 'border-white/10 bg-slate-950 hover:border-fuchsia-500/40'}`}
                      >
                        <div className="text-xs font-bold text-white">{preset.label}</div>
                        <div className="mt-1 text-[10px] text-slate-400">{preset.subtitle}</div>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex justify-between items-center select-none">
                  <span className="text-xs font-mono font-bold text-slate-500 uppercase tracking-widest">
                    Music library (optional)
                  </span>
                </div>
                 {/* Form input fields */}
                <form onSubmit={triggerSearchSubmit} className="flex gap-2">
                  <div className="relative flex-1">
                    <Search className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search tracks across linked libraries..."
                      className="w-full bg-slate-900 border border-white/10 px-4 py-3 pl-10 rounded-xl text-xs text-white focus:border-fuchsia-500 focus:ring-1 focus:ring-fuchsia-500 outline-none"
                    />
                  </div>
                  <button 
                    type="submit"
                    disabled={isSearching}
                    className="px-4 py-2 bg-slate-800 border border-white/10 hover:bg-slate-700 font-semibold text-xs text-white rounded-xl transition-colors disabled:opacity-50 cursor-pointer"
                  >
                    {isSearching ? "..." : "Find"}
                  </button>
                </form>

                {/* Query Results */}
                {selectedTrack && (
                  <motion.div 
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="p-4 bg-fuchsia-500/5 border border-fuchsia-500/25 rounded-xl flex items-center justify-between gap-3 glow-fuchsia animate-fade-in"
                  >
                    <div className="flex items-center gap-3">
                      <img 
                        src={selectedTrack.albumArt} 
                        alt="track_art" 
                        referrerPolicy="no-referrer"
                        className="w-12 h-12 rounded bg-slate-800 object-cover border border-white/10" 
                      />
                      <div>
                        <div className="text-sm font-bold text-white">{selectedTrack.title}</div>
                        <p className="text-xs text-slate-400 font-sans">{selectedTrack.artist}</p>
                        {selectedTrack.source && <p className="text-[10px] text-fuchsia-300 mt-1 uppercase tracking-wider">{selectedTrack.source}</p>}
                      </div>
                    </div>
                    <button 
                      type="button"
                      onClick={() => setSelectedTrack(null)}
                      className="text-xs text-fuchsia-400 font-semibold hover:underline cursor-pointer"
                    >
                      Change
                    </button>
                  </motion.div>
                )}
                {!selectedTrack && (
                  <div className="space-y-2 max-h-56 overflow-y-auto">
                    {searchResults.map((song) => (
                      <button
                        key={song.id}
                        type="button"
                        onClick={() => handleSelectTrack(song)}
                        className="w-full p-2.5 bg-slate-900/40 hover:bg-slate-900 border border-white/5 hover:border-white/10 rounded-lg flex items-center gap-3 text-left transition-colors cursor-pointer"
                      >
                        <img 
                          src={song.albumArt} 
                          alt="art" 
                          referrerPolicy="no-referrer"
                          className="w-10 h-10 rounded shrink-0 object-cover border border-white/5" 
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-bold text-white truncate">{song.title}</div>
                          <p className="text-[10px] text-slate-400 truncate mt-0.5">{song.artist}</p>
                          {song.source && (
                            <p className="text-[9px] text-fuchsia-300 mt-1 font-bold uppercase tracking-wider">{song.source}</p>
                          )}
                          {song.description && (
                            <p className="text-[9px] text-cyan-400 italic font-mono mt-1 line-clamp-1">{song.description}</p>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {session.talentRole !== 'DJ' && (
              /* If Bartender / Magician custom menu selection: Path B */
              <div className="space-y-4 font-sans">
                <div className="space-y-2">
                  <div className="text-xs font-mono font-bold text-slate-500 uppercase tracking-widest select-none">
                    Quick presets
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {requestPresets.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => {
                          setSelectedPresetId(preset.id);
                          setSelectedTrack({
                            id: preset.id,
                            title: preset.label.replace(/^\$\d+\s*/, ''),
                            artist: preset.subtitle,
                            basePrice: preset.amount,
                            targetType: preset.targetType,
                            source: 'Sway Preset'
                          });
                          setTipAmount(Math.max(session.minimumTip, preset.amount));
                        }}
                        className={`rounded-lg border px-3 py-2 text-left transition-colors cursor-pointer ${selectedPresetId === preset.id ? 'border-fuchsia-400 bg-fuchsia-500/15' : 'border-white/10 bg-slate-950 hover:border-fuchsia-500/40'}`}
                      >
                        <div className="text-xs font-bold text-white">{preset.label}</div>
                        <div className="mt-1 text-[10px] text-slate-400">{preset.subtitle}</div>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="text-xs font-mono font-bold text-slate-500 uppercase tracking-widest select-none">
                  PATH B: Interactive Custom Action List
                </div>

                <div className="grid gap-3.5">
                  {customItems.map((item) => {
                    const isSelected = selectedTrack?.title === item.title;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => handleSelectTrack({ title: item.title, artist: item.description, basePrice: item.basePrice })}
                        className={`w-full p-4 rounded-xl border text-left flex items-start gap-3.5 transition-all cursor-pointer ${
                          isSelected 
                            ? 'bg-fuchsia-500/5 border-fuchsia-500 text-fuchsia-400 glow-fuchsia' 
                            : 'bg-slate-900/40 border-white/5 hover:border-white/10'
                        }`}
                      >
                        <span className="text-2xl mt-0.5 shrink-0">{item.iconName}</span>
                        <div className="min-w-0 flex-1">
                          <div className="flex justify-between items-baseline gap-2">
                            <h4 className="text-xs font-bold text-white truncate">{item.title}</h4>
                            <span className="font-mono text-xs text-fuchsia-400 shrink-0">${item.basePrice}.00+</span>
                          </div>
                          <p className="text-[11px] text-slate-400 mt-1 leading-relaxed font-sans">{item.description}</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Common checkout inputs: Sponsor credentials, notes & cash value limits */}
            {selectedTrack && (
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-slate-900 border border-white/10 rounded-xl p-5 space-y-4 shadow-lg"
              >
                {/* Visual slider or pricing */}
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs font-semibold font-sans">
                    <span className="text-slate-400 font-sans">Bid / Tipping Amount</span>
                    <span className="text-fuchsia-400 font-mono font-bold">${tipAmount}.00</span>
                  </div>
                  
                  <div className="flex gap-2 p-1.5 bg-slate-950 rounded-lg border border-white/5">
                    {[session.minimumTip, session.minimumTip + 5, session.minimumTip + 15].map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => setTipAmount(preset)}
                        className={`flex-1 py-1 text-xs font-mono font-bold rounded cursor-pointer ${
                          tipAmount === preset 
                            ? 'bg-fuchsia-600 text-white shadow' 
                            : 'text-slate-400 hover:text-white hover:bg-slate-805'
                        }`}
                      >
                        ${preset}
                      </button>
                    ))}
                  </div>

                  <input
                    type="range"
                    min={session.minimumTip}
                    max={100}
                    step={5}
                    value={tipAmount}
                    onChange={(e) => setTipAmount(Number(e.target.value))}
                    className="w-full accent-fuchsia-500 mt-2 cursor-pointer"
                  />
                  <p className="text-[10px] text-slate-500 leading-relaxed font-sans">
                    Tip higher to secure #1 fuchsia spot. High bids command the fastest talent attention!
                  </p>
                </div>

                {/* Senders vital name */}
                <div className="space-y-1.5">
                  <label className="text-[10px] text-slate-400 uppercase font-mono tracking-wider font-bold">Your Name / Group</label>
                  <input
                    type="text"
                    value={senderName}
                    onChange={(e) => setSenderName(e.target.value)}
                    required
                    maxLength={30}
                    placeholder="e.g. VIP Sarah, Table 4 Crew"
                    className="w-full bg-slate-950 border border-white/10 px-4 py-2 text-xs rounded-xl text-white focus:border-fuchsia-500 focus:ring-1 focus:ring-fuchsia-500 outline-none font-sans"
                  />
                </div>

                {/* Custom sentiment comment note */}
                <div className="space-y-1.5">
                  <label className="text-[10px] text-slate-400 uppercase font-mono tracking-wider font-bold">Custom Note / Shoutout (Profanity Filtered)</label>
                  <input
                    type="text"
                    value={commentMessage}
                    onChange={(e) => setCommentMessage(e.target.value)}
                    maxLength={100}
                    placeholder="e.g. Play this next! Love from London!"
                    className="w-full bg-slate-950 border border-white/10 px-4 py-2 text-xs rounded-xl text-white focus:border-fuchsia-500 focus:ring-1 focus:ring-fuchsia-500 outline-none font-sans"
                  />
                </div>

                {/* Submit request */}
                <div className="pt-2 font-sans">
                  <button
                    type="button"
                    onClick={() => initiateCheckout('request')}
                    className="w-full flex items-center justify-center gap-1.5 py-3 auction-gradient rounded-xl text-xs font-bold text-white transition-all transform active:scale-95 glow-fuchsia cursor-pointer"
                  >
                    <CreditCard className="w-4 h-4" /> Continue To Test Checkout ({getFormat(tipAmount)})
                  </button>
                  <p className="text-[9px] text-slate-500 text-center mt-2.5 leading-relaxed font-sans">
                    Test checkout only. Real payment authorization and capture will be enabled in the payments sprint.
                  </p>
                </div>

              </motion.div>
            )}
              </>
            )}
          </div>
        )}

              {/* TAB B: Straight Classic Tip Options */}
        {activeTab === 'tip' && session.status === 'active' && (
          <motion.form 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            onSubmit={handleStraightTipSubmit} 
            className="bg-slate-900 border border-white/10 rounded-xl p-5 space-y-4 shadow-lg font-sans"
          >
            <div className="text-center pb-2 select-none">
              <Coins className="w-10 h-10 text-fuchsia-500 mx-auto animate-bounce mb-2" />
              <h3 className="font-display text-sm font-bold text-white uppercase tracking-wider">Classic Straight Tip</h3>
              <p className="text-xs text-slate-400 mt-1 leading-relaxed">No requests, no action ladder—just straightforward appreciation for {session.talentName}. Approved and captured instantly.</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] text-slate-400 font-mono tracking-wider font-bold">YOUR NAME / TABLE</label>
              <input
                type="text"
                value={senderName}
                onChange={(e) => setSenderName(e.target.value)}
                required
                placeholder="e.g. Anonymous regular"
                className="w-full bg-slate-950 border border-white/10 px-4 py-3 text-xs rounded-xl text-white focus:border-fuchsia-500 focus:ring-1 focus:ring-fuchsia-500 outline-none"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] text-slate-400 font-mono tracking-wider font-bold">TIPPING VALUE</label>
              <div className="flex gap-2">
                {[5, 10, 20, 50].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setTipAmount(preset)}
                    className={`flex-1 py-2 text-xs font-mono font-bold rounded-lg border transition-all cursor-pointer ${
                      tipAmount === preset 
                        ? 'bg-fuchsia-600 text-white border-fuchsia-600' 
                        : 'bg-slate-950 text-slate-400 border-white/5 hover:text-white'
                    }`}
                  >
                    ${preset}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] text-slate-400 font-mono tracking-wider font-bold">SHOUTOUT NOTE</label>
              <input
                type="text"
                value={commentMessage}
                placeholder="e.g. Best dj set in years!! Keep it rocking."
                onChange={(e) => setCommentMessage(e.target.value)}
                className="w-full bg-slate-950 border border-white/10 px-4 py-3 text-xs rounded-xl text-white focus:border-fuchsia-500 focus:ring-1 focus:ring-fuchsia-500 outline-none"
              />
            </div>

            <button
              type="submit"
              className="w-full flex items-center justify-center gap-1.5 py-3 auction-gradient hover:opacity-90 text-white text-xs font-bold rounded-xl transition-all glow-fuchsia cursor-pointer"
            >
              <CreditCard className="w-4 h-4" /> Send Tip ({getFormat(tipAmount)})
            </button>
          </motion.form>
        )}

        {/* TAB C: The Live Leaderboard / Rank Status List & "Boost" Actions */}
        {(activeTab === 'ladder' || session.status === 'ending') && (
          <div className="space-y-4 font-sans">
            <div className="flex justify-between items-center select-none animate-fade-in">
              <h3 className="font-display text-sm font-bold text-white flex items-center gap-1.5 uppercase tracking-wider">
                <TrendingUp className="w-4 h-4 text-fuchsia-500 animate-pulse" /> Live Action Ladder
              </h3>
              <span className="text-[9px] text-cyan-400 font-mono uppercase bg-cyan-950/40 px-2.5 py-1 rounded-full border border-cyan-500/20 shadow-sm animate-pulse flex items-center gap-1">
                <span className="w-1.5 h-1.5 bg-cyan-400 rounded-full animate-ping"></span> Live Feed
              </span>
            </div>

            <div className="space-y-3">
              {approvedLadder.length === 0 ? (
                <div className="text-center p-8 bg-slate-900/10 border border-dashed border-white/10 rounded-2xl select-none">
                  <Smartphone className="w-6 h-6 text-slate-600 mx-auto animate-bounce" />
                  <div className="text-xs font-semibold text-slate-400 mt-1">Ladder is currently vacant</div>
                  <p className="text-[10px] text-slate-500">Wait for performer approvals or submit your own request above.</p>
                </div>
              ) : (
                approvedLadder.map((req, idx) => {
                  const isTopOne = idx === 0;
                  const isFulfilled = req.status === 'fulfilled';
                  return (
                    <motion.div
                      key={req.id}
                      layoutId={`patron-ladder-${req.id}`}
                      className={`ladder-row p-1 rounded-2xl flex flex-col transition-all overflow-hidden ${
                        isTopOne 
                          ? 'bg-slate-950 glow-fuchsia border border-fuchsia-500/25' 
                          : 'bg-slate-900/60 border border-white/5'
                      }`}
                    >
                      <div className={`flex items-center justify-between gap-4 p-3.5 rounded-xl ${isTopOne ? 'bg-slate-900/70 border border-white/5' : ''}`}>
                        <div className="flex items-center gap-3 min-w-0">
                          {/* Spot standing index rank */}
                          <div className="flex flex-col items-center justify-center font-display font-black text-center pr-1 shrink-0 select-none">
                            <span className={`text-base ${isTopOne ? 'text-fuchsia-400 font-black italic' : 'text-slate-500 font-bold'}`}>
                              {idx < 9 ? `0${idx + 1}` : idx + 1}
                            </span>
                          </div>

                          {req.albumArt ? (
                            <img 
                              src={req.albumArt} 
                              alt="art" 
                              referrerPolicy="no-referrer"
                              className="w-10 h-10 rounded shrink-0 object-cover border border-white/15 shadow-sm" 
                            />
                          ) : (
                            <div className="w-10 h-10 rounded bg-slate-800 flex items-center justify-center font-bold text-xs shrink-0 select-none text-fuchsia-400">
                              ⚡
                            </div>
                          )}

                          <div className="min-w-0">
                            <div className="flex items-baseline gap-1 font-sans text-xs font-bold text-white truncate">
                              <span>{req.title}</span>
                            </div>
                            <p className="text-[10px] text-slate-400 truncate mt-0.5 font-medium">{req.subtitle}</p>
                            
                            <div className="text-[9px] font-mono font-bold text-cyan-400 mt-1 bg-cyan-950/55 border border-cyan-500/10 px-1.5 py-0.5 rounded inline-block">
                              Requested by {req.senderName}
                            </div>
                          </div>
                        </div>

                        {/* Boost Action */}
                        <div className="text-right flex flex-col items-end gap-1.5">
                          <div className={`text-sm font-mono font-black ${isTopOne ? 'text-fuchsia-400 text-lg' : 'text-slate-300'}`}>
                            {getFormat(req.amount)}
                          </div>
                          
                          {isFulfilled ? (
                            <span className="text-[9px] font-mono font-bold text-cyan-400 bg-cyan-950/40 border border-cyan-500/25 px-2 py-1 rounded inline-flex items-center gap-1">
                              <Check className="w-3 h-3 text-cyan-300" /> FULFILLED
                            </span>
                          ) : (
                            session.status === 'active' && (
                              <button
                                type="button"
                                onClick={() => {
                                  setBoostingItem(req);
                                  setBoostAmount(10);
                                  initiateCheckout('boost');
                                }}
                                className={`px-4 py-1.5 rounded-full text-[10px] font-black uppercase tracking-wider transition-all cursor-pointer ${
                                  isTopOne
                                    ? 'bg-fuchsia-600/20 border border-fuchsia-500/40 text-fuchsia-400 hover:bg-fuchsia-600/30 glow-fuchsia shadow-sm'
                                    : 'bg-slate-800 border border-white/10 text-slate-400 hover:text-white hover:border-white/20'
                                }`}
                              >
                                Boost +$10
                              </button>
                            )
                          )}
                        </div>
                      </div>
                    </motion.div>
                  );
                })
              )}
            </div>
          </div>
        )}        

        {/* TAB D: Performer & Venue Discover Directory */}
        {activeTab === 'discover' && (
          <div className="space-y-5">
            <div className="flex flex-col space-y-2 select-none animate-fade-in font-sans">
              <h3 className="font-display text-sm font-bold text-white flex items-center gap-1.5 uppercase tracking-wider">
                <Sparkles className="w-4 h-4 text-amber-400 animate-pulse" /> Discover Artists &amp; Venues
              </h3>
              <p className="text-xs text-slate-400 leading-relaxed font-sans">
                Browse on-duty mixers, acoustic performers, and craft bartenders at this venue. Featured listings rise to the top with priority placements!
              </p>
            </div>

            {/* Directory search input */}
            <div className="relative font-sans border-none sm:border-solid">
              <Search className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={directorySearch}
                onChange={(e) => setDirectorySearch(e.target.value)}
                placeholder="Search by artist, category, or venue stage..."
                className="w-full bg-slate-900 border border-white/10 px-4 py-3 pl-10 rounded-xl text-xs text-white focus:border-fuchsia-500 outline-none font-sans"
              />
            </div>

            {/* Sorted Performers List */}
            <div className="space-y-4 font-sans">
              {(() => {
                const sorted = [...performers].sort((a, b) => (b.isFeatured ? 1 : 0) - (a.isFeatured ? 1 : 0));
                const filtered = sorted.filter(p =>
                  p.name.toLowerCase().includes(directorySearch.toLowerCase()) ||
                  p.venueName.toLowerCase().includes(directorySearch.toLowerCase()) ||
                  p.role.toLowerCase().includes(directorySearch.toLowerCase())
                );

                if (filtered.length === 0) {
                  return (
                    <div className="text-center py-10 bg-slate-900/10 border border-dashed border-white/5 rounded-2xl select-none">
                      <Search className="w-6 h-6 text-slate-500 mx-auto mb-1 animate-bounce" />
                      <div className="text-xs text-slate-400 font-bold">No performers found</div>
                      <p className="text-[10px] text-slate-500 font-sans mt-0.5">Refine search criteria to match active venue desk sessions</p>
                    </div>
                  );
                }

                return filtered.map((p) => {
                  return (
                    <div
                      key={p.id}
                      className={`p-1.5 rounded-2xl flex flex-col transition-all relative overflow-hidden ${
                        p.isFeatured 
                          ? 'border border-amber-500/30 bg-gradient-to-br from-amber-950/20 via-slate-900/40 to-slate-950/40 glow-fuchsia animate-fade-in' 
                          : 'border border-white/5 bg-slate-900/40'
                      }`}
                    >
                      {/* Distinct Featured holographic stamp overlay */}
                      {p.isFeatured && (
                        <div className="absolute top-0 right-0 bg-amber-500 text-slate-950 text-[7px] font-black uppercase tracking-widest px-2.5 py-0.5 rounded-bl-lg select-none animate-pulse font-mono z-10 flex items-center gap-1">
                          <span>🌟 PRESERVED PLACEMENT</span>
                        </div>
                      )}

                      <div className="flex items-center justify-between gap-4 p-3 rounded-xl">
                        <div className="flex items-center gap-3.5 min-w-0">
                          <div className="relative">
                            <img
                              src={p.avatarUrl}
                              alt={p.name}
                              referrerPolicy="no-referrer"
                              className={`w-12 h-12 rounded-xl object-cover shrink-0 select-none ${
                                p.isFeatured ? 'border-2 border-amber-400 shadow shadow-amber-500/10' : 'border border-white/10'
                              }`}
                            />
                            {p.isFeatured && (
                              <span className="absolute -bottom-1 -right-1 bg-amber-500 text-slate-950 p-0.5 rounded-full border border-slate-900 flex items-center justify-center animate-bounce">
                                <Sparkles className="w-2.5 h-2.5 text-slate-950" />
                              </span>
                            )}
                          </div>

                          <div className="min-w-0">
                            <div className="flex items-baseline gap-1.5 font-sans justify-between">
                              <h4 className="text-sm font-bold text-white truncate">{p.name}</h4>
                            </div>
                            <p className="text-[10px] text-slate-400 truncate font-semibold mt-0.5 flex items-center gap-1 font-sans">
                              📍 Stage: {p.venueName}
                            </p>
                            
                            <div className="flex items-center gap-2 mt-2">
                              <span className="text-[8px] font-mono font-bold text-fuchsia-400 bg-fuchsia-950/20 border border-fuchsia-500/10 px-1.5 py-0.5 rounded">
                                {p.role} MODALITY
                              </span>
                              <span className="text-[8px] font-mono text-slate-500">
                                Min Tips: ${p.minimumTip}
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* QR Code section & Quick checkout actions */}
                        <div className="flex items-center gap-3 shrink-0">
                          {/* Distinct QR Code with custom indicators if Featured */}
                          <button
                            type="button"
                            onClick={() => setShowDirQrCodeModal(p)}
                            className={`p-2 rounded-xl transition-all cursor-pointer relative ${
                              p.isFeatured
                                ? 'bg-amber-500/10 border border-amber-400/40 hover:bg-amber-500/20 shadow'
                                : 'bg-slate-955 bg-slate-950 border border-white/5 hover:border-white/10'
                            }`}
                            title="Open Distinct QR Flyer"
                          >
                            <QrCode className={`w-5 h-5 ${p.isFeatured ? 'text-amber-400 animate-pulse' : 'text-slate-450 text-slate-400'}`} />
                            {p.isFeatured && (
                              <span className="absolute -top-1 -right-1 w-2 h-2 bg-amber-400 rounded-full animate-ping font-sans"></span>
                            )}
                          </button>

                          {/* Quick Tip action */}
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedDirectoryPerformer(p);
                              setTipAmount(p.minimumTip);
                              setSenderName('');
                              setCommentMessage('');
                            }}
                            className={`px-3 py-1.5 rounded-xl text-[10px] font-black uppercase text-center transition-all cursor-pointer font-sans ${
                              p.isFeatured
                                ? 'bg-amber-500 hover:bg-amber-400 text-slate-950 shadow-md shadow-amber-500/10'
                                : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-white/5'
                            }`}
                          >
                            Tip
                          </button>
                        </div>
                      </div>

                      {/* Display inline tip drawer if selected */}
                      {selectedDirectoryPerformer?.id === p.id && (
                        <div className="mx-3 mb-3 p-3.5 bg-slate-950 border border-white/5 rounded-xl space-y-4 animate-slide-in font-sans">
                          <div className="flex justify-between items-center pb-2 border-b border-white/5 font-sans">
                            <span className="text-[9px] font-mono font-bold text-slate-400 uppercase">INLINE DIRECTORY LOCK</span>
                            <button
                              type="button"
                              onClick={() => setSelectedDirectoryPerformer(null)}
                              className="text-[10px] font-bold text-slate-500 hover:text-white"
                            >
                              Close
                            </button>
                          </div>

                          <div className="space-y-1.5 font-sans">
                            <div className="flex justify-between text-[10px] font-sans">
                              <span className="text-slate-400">Bid / Tip Value</span>
                              <span className="text-fuchsia-400 font-mono font-bold">${tipAmount}.00</span>
                            </div>
                            <input
                              type="range"
                              min={p.minimumTip}
                              max={100}
                              step={5}
                              value={tipAmount}
                              onChange={(e) => setTipAmount(Number(e.target.value))}
                              className="w-full accent-fuchsia-500 cursor-pointer"
                            />
                          </div>

                          <div className="grid sm:grid-cols-2 gap-3.5 font-sans">
                            <div className="space-y-1 font-sans">
                              <label className="text-[8px] text-slate-500 uppercase font-mono tracking-wider font-bold">YOUR NAME</label>
                              <input
                                type="text"
                                value={senderName}
                                onChange={(e) => setSenderName(e.target.value)}
                                maxLength={30}
                                placeholder="Dave, VIP Table 5"
                                className="w-full bg-slate-900 border border-white/5 px-3 py-1.5 text-xs rounded-lg text-white focus:border-fuchsia-500 outline-none font-sans"
                              />
                            </div>
                            <div className="space-y-1 font-sans">
                              <label className="text-[8px] text-slate-500 uppercase font-mono tracking-wider font-bold">CUSTOM NOTE</label>
                              <input
                                type="text"
                                value={commentMessage}
                                onChange={(e) => setCommentMessage(e.target.value)}
                                maxLength={100}
                                placeholder="Rock the set! Amazing songs"
                                className="w-full bg-slate-900 border border-white/5 px-3 py-1.5 text-xs rounded-lg text-white focus:border-fuchsia-500 outline-none font-sans"
                              />
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={() => {
                              if (!senderName) {
                                alert("Please enter your name!");
                                return;
                              }
                              if (tipAmount < p.minimumTip) {
                                alert(`Minimum tip is $${p.minimumTip}`);
                                return;
                              }
                              if (!gigId) {
                                const routeCopy = 'This QR route is missing a valid gig ID. Scan the performer gig QR again.';
                                setDegraded(true);
                                setPendingActionMessage(routeCopy);
                                alert(routeCopy);
                                return;
                              }
                              // Open checkout
                              const platformFee = session.feeType === 'patron' ? 1.0 : 0;
                              setCheckoutPayload({
                                open: true,
                                type: 'request',
                                title: `Directory Tip to ${p.name}`,
                                artist: `Straight tip supporting ${p.name} at ${p.venueName}`,
                                amount: tipAmount,
                                fee: platformFee,
                                total: tipAmount + platformFee,
                                gigId,
                                ...createClientActionIds()
                              });
                            }}
                            className="w-full py-2 bg-gradient-to-r from-fuchsia-600 to-blue-600 text-white font-black text-xs rounded-lg shadow-md cursor-pointer font-sans text-center"
                          >
                            Continue To Test Checkout (${tipAmount}.00)
                          </button>
                        </div>
                      )}
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        )}        </div>
       {/* 4. TEMPORARY CHECKOUT MODAL OVERLAY */}
      <AnimatePresence>
        {checkoutPayload && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <motion.div
              initial={{ scale: 0.95, y: 15, opacity: 0 }}
              animate={{ scale: 1, y: 0, opacity: 1 }}
              exit={{ scale: 0.95, y: 15, opacity: 0 }}
              className="w-full max-w-sm bg-slate-900 border border-white/10 rounded-2xl overflow-hidden shadow-2xl glass-panel text-center font-sans"
            >
              
              {/* Payment Processing and Success Cards */}
              {backendConfirmed ? (
                <div className="p-8 space-y-4">
                  <div className="w-16 h-16 bg-cyan-500/20 border border-cyan-500/30 text-cyan-400 flex items-center justify-center rounded-full mx-auto animate-bounce">
                    <Check className="w-8 h-8 text-cyan-400" />
                  </div>
                  <h3 className="font-sans text-lg font-bold text-white">Request Submitted</h3>
                  <p className="text-xs text-slate-300 leading-relaxed max-w-xs mx-auto font-sans">
                    ${checkoutPayload.amount}.00 test checkout recorded. The performer has been notified in real time.
                  </p>
                </div>
              ) : (
                /* Temporary checkout fields */
                <div className="p-6 space-y-6">
                  
                  {/* Title and meta */}
                  <div className="space-y-1">
                    <span className="text-[9px] font-mono font-bold text-slate-500 uppercase tracking-widest">CHECKOUT INVOICE</span>
                    <h3 className="font-sans text-base font-bold text-white">
                      {previewMode ? 'Preview Checkout Only' : checkoutPayload.type === 'request' ? 'Live Desk Board Request' : `Boost Standing Index`}
                    </h3>
                    {previewMode && (
                      <p className="text-[10px] text-amber-200 font-bold uppercase tracking-widest">
                        Demo data. No payment or request will be recorded.
                      </p>
                    )}
                  </div>

                  {/* Pricing detail sheets */}
                  <div className="bg-slate-950 p-4 rounded-xl border border-white/5 space-y-2.5 text-left font-mono">
                    <div className="flex justify-between text-xs font-semibold">
                      <span className="text-slate-550 text-slate-500">Target Option Item:</span>
                      <span className="text-white font-sans max-w-[150px] truncate">{checkoutPayload.title}</span>
                    </div>

                    <div className="flex justify-between text-xs">
                      <span className="text-slate-500 mt-0.5">Hold Bid:</span>
                      <span className="text-white">${checkoutPayload.amount}.00</span>
                    </div>

                    <div className="flex justify-between text-xs font-sans">
                      <span className="text-slate-500">Platform Handling Cost:</span>
                      <span className="text-fuchsia-400 font-bold">
                        {checkoutPayload.fee > 0 ? getFormat(checkoutPayload.fee) : 'Absorbed by Performer'}
                      </span>
                    </div>

                    <div className="border-t border-white/10 pt-2.5 flex justify-between text-xs font-mono font-black">
                      <span className="text-slate-400">{previewMode ? 'Preview Checkout Total:' : 'Test Checkout Total:'}</span>
                      <span className="text-cyan-400 font-bold">${checkoutPayload.total}.00</span>
                    </div>
                  </div>

                  {/* Quick boost credentials if boosting item */}
                  {checkoutPayload.type === 'boost' && (
                    <div className="space-y-3 pt-1 text-left">
                      <div className="space-y-1">
                        <label className="text-[10px] text-slate-400 uppercase font-mono tracking-wider font-bold">BOOSTER / SPONSOR NAME</label>
                        <input
                          type="text"
                          value={boostPatronName}
                          onChange={(e) => setBoostPatronName(e.target.value)}
                          maxLength={30}
                          placeholder="e.g. Table 5 Crew"
                          className="w-full bg-slate-950 border border-white/10 px-4 py-2 text-xs rounded-xl text-white focus:border-fuchsia-500 outline-none"
                        />
                      </div>
                      
                      <div className="space-y-1">
                        <label className="text-[10px] text-slate-400 uppercase font-mono tracking-wider font-bold">BOOST STACK AMOUNT</label>
                        <input
                          type="number"
                          min={1}
                          max={50}
                          value={boostAmount}
                          onChange={(e) => setBoostAmount(Number(e.target.value))}
                          className="w-full bg-slate-950 border border-white/10 px-4 py-2 text-xs rounded-xl text-white focus:border-fuchsia-500 outline-none"
                        />
                      </div>
                    </div>
                  )}

                  {/* Payment option tools */}
                  <div className="space-y-2">
                    
                    {/* Temporary test payment action */}
                    <button
                      type="button"
                      onClick={completePayment}
                      disabled={isPaying || previewMode}
                      className="w-full flex items-center justify-center gap-2 py-3 bg-black hover:bg-slate-900 border border-white/10 text-white rounded-xl text-xs font-bold transition-all shadow-md cursor-pointer"
                    >
                      <Lock className="w-3.5 h-3.5 text-fuchsia-500" /> {previewMode ? 'Preview only: checkout disabled' : isPaying ? "Recording..." : "Record test checkout"}
                    </button>

                    {/* Temporary alternate test action */}
                    <button
                      type="button"
                      onClick={completePayment}
                      disabled={isPaying || previewMode}
                      className="w-full flex items-center justify-center gap-2 py-3 bg-white hover:bg-slate-100 text-slate-950 rounded-xl text-xs font-bold transition-all shadow-md cursor-pointer"
                    >
                      <Lock className="w-3.5 h-3.5 text-fuchsia-500 font-bold" /> {previewMode ? 'Preview only: no alternate checkout' : isPaying ? "Recording..." : "Record alternate test checkout"}
                    </button>

                    <button
                      type="button"
                      onClick={() => { setCheckoutPayload(null); setBoostingItem(null); }}
                      disabled={isPaying}
                      className="w-full py-2 hover:bg-slate-800 text-slate-400 hover:text-white rounded-xl text-xs font-bold transition-colors cursor-pointer"
                    >
                      Cancel checkout
                    </button>
                  </div>

                </div>
              )}

            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* 🌟 DISTINCT QR Code Modal Overlay for Featured Performer */}
      <AnimatePresence>
        {showDirQrCodeModal && (
          <div className="fixed inset-0 z-55 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <motion.div
              initial={{ scale: 0.95, y: 15, opacity: 0 }}
              animate={{ scale: 1, y: 0, opacity: 1 }}
              exit={{ scale: 0.95, y: 15, opacity: 0 }}
              className={`w-full max-w-xs p-6 text-center font-sans rounded-3xl border relative overflow-hidden shadow-2xl ${
                showDirQrCodeModal.isFeatured
                  ? 'bg-gradient-to-b from-amber-950 via-slate-900 to-slate-950 border-amber-400/40'
                  : 'bg-slate-900 border-white/10'
              }`}
            >
              {showDirQrCodeModal.isFeatured && (
                <div className="absolute top-0 right-0 w-32 h-32 bg-amber-500/5 rounded-full blur-2xl -mr-8 -mt-8 animate-pulse"></div>
              )}

              {/* Header Indicator */}
              <div className="space-y-1 mb-5">
                {showDirQrCodeModal.isFeatured ? (
                  <span className="text-[8px] font-black tracking-widest bg-amber-500 text-slate-950 px-2.5 py-1 rounded-full font-mono inline-block animate-bounce shadow">
                    🌟 PRESTIGE FEATURED STATUS ACTIVE 🌟
                  </span>
                ) : (
                  <span className="text-[8px] font-black tracking-widest bg-slate-950 text-slate-400 px-2.5 py-1 rounded-full font-mono inline-block">
                    STANDARD VENUE LISTING
                  </span>
                )}
                <h3 className="text-base font-black text-white mt-1 uppercase tracking-wide">{showDirQrCodeModal.name}</h3>
                <p className="text-[10px] text-fuchsia-400 font-semibold">{showDirQrCodeModal.role} MODALITY</p>
                <p className="text-[9px] text-slate-400 mt-1">📍 Venue: {showDirQrCodeModal.venueName}</p>
              </div>

              {/* Distinct QR Visual Core Code wrapper */}
              <div className="flex justify-center my-6 select-none relative">
                {showDirQrCodeModal.isFeatured ? (
                  /* PREMIUM AMBER/GOLD REVOLVING RING */
                  <div className="bg-gradient-to-r from-amber-400 via-fuchsia-500 to-amber-400 p-2 rounded-2xl relative shadow-lg shadow-amber-500/25">
                    <div className="bg-slate-900 p-3 rounded-xl">
                      <QrCode className="w-28 h-28 text-amber-400 animate-pulse" />
                    </div>
                  </div>
                ) : (
                  /* STANDARD QR CODE CARD */
                  <div className="bg-slate-950 border border-white/5 p-4 rounded-xl">
                    <QrCode className="w-28 h-28 text-white" />
                  </div>
                )}
              </div>

              {/* Subtext info */}
              <p className={`text-[10px] leading-relaxed max-w-xs mx-auto mb-4 font-sans ${showDirQrCodeModal.isFeatured ? 'text-amber-250 text-amber-200' : 'text-slate-400'}`}>
                {showDirQrCodeModal.isFeatured
                  ? 'Featured placement for this performer. Real payment processing is not enabled in this build.'
                  : 'Standard direct tipping desk for supporting local performers at the venue stage.'}
              </p>

              <button
                type="button"
                onClick={() => setShowDirQrCodeModal(null)}
                className="w-full py-2 bg-slate-950 text-slate-300 hover:text-white border border-white/5 hover:border-white/10 rounded-xl text-xs font-bold transition-all cursor-pointer font-sans"
              >
                Close Flyer View
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

    </div>
  );
}
