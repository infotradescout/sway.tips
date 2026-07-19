/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe } from '@stripe/stripe-js';
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
  Sliders,
  X
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { TrackReference, RequestItem, GigSession, CustomMenuItem, PerformerProfile, PatronRequestStatusCode } from '../types';
import { getInitialNetworkStatus, subscribeToNetworkStatus } from '../native/swayNativeBridge';
import { sendBoostStarted, sendRequestStarted } from '../shells/frictionClient';

const PENDING_ACTION_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_ACTION_RETRIES = 3;
const PENDING_ACTION_EXPIRED_COPY = 'Network dropped. Your request expired before confirmation was completed.';
const CAPTIVE_PORTAL_BLOCK_COPY = 'Network sign-in required. Finish Wi-Fi sign-in or switch to cellular before sending a request.';
const PAYMENT_AUTHORIZATION_REQUIRED_COPY = 'Confirm payment to send this request.';
const PAYMENT_CONFIRMATION_WAITING_COPY = 'Keep this page open while Sway confirms the request status.';
const PAYMENT_AUTHORIZATION_DISCLOSURE_COPY = 'Sway will show Pending until the performer and payment outcome are confirmed.';
const PATRON_REQUEST_STATUS_STORAGE_KEY = 'sway.patronRequestStatus';
const PATRON_REQUEST_STATUS_TTL_MS = 48 * 60 * 60 * 1000;

type StoredPatronRequestStatus = {
  gigId: string;
  requestId: string;
  receipt: string;
  status: PatronRequestStatusCode;
  expiresAt: string;
};

function createSecurePatronStatusReceipt() {
  if (!globalThis.crypto?.getRandomValues) return undefined;
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function isPatronRequestStatusCode(value: unknown): value is PatronRequestStatusCode {
  return value === 'pending' || value === 'approved' || value === 'not_approved' || value === 'fulfilled';
}

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
    sourceProvider?: string;
    spotifyUri?: string;
    spotifyUrl?: string;
    client_request_id?: string;
    idempotency_key?: string;
    patron_status_receipt?: string;
    expires_at?: string;
    gig_id?: string;
    payment_intent_id?: string;
  }) => Promise<any>;
  onBoostRequest: (requestId: string, patronName: string, amount: number, clientRequestId?: string, idempotencyKey?: string, expiresAt?: string, gigId?: string, paymentIntentId?: string) => Promise<any>;
  onReconcilePendingAction: (clientRequestId: string, idempotencyKey: string) => Promise<any>;
  onGetPatronRequestStatus: (gigId: string, requestId: string, receipt: string) => Promise<any>;
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
  sourceProvider?: string;
  spotifyUri?: string;
  spotifyUrl?: string;
  targetType?: 'music' | 'custom';
};

const REQUEST_ART_PLACEHOLDER = 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=240&q=80';
const MANUAL_REQUEST_SOURCE = 'Manual request';
const PRESET_REQUEST_SOURCE = 'Preset';

type PaymentConfirmationState = {
  phase: 'PAYMENT_PENDING_CONFIRMATION';
  actionType: 'request' | 'boost';
  message: string;
};

const previewCatalog: SearchTrack[] = [
  {
    id: 'manual-1',
    title: 'High-energy opener',
    artist: 'Example request',
    albumArt: REQUEST_ART_PLACEHOLDER,
    basePrice: 8,
    source: MANUAL_REQUEST_SOURCE
  },
  {
    id: 'manual-2',
    title: 'Big sing-along anthem',
    artist: 'Example request',
    albumArt: REQUEST_ART_PLACEHOLDER,
    basePrice: 8,
    source: MANUAL_REQUEST_SOURCE
  },
  {
    id: 'manual-3',
    title: 'Late-night dance track',
    artist: 'Example request',
    albumArt: REQUEST_ART_PLACEHOLDER,
    basePrice: 8,
    source: MANUAL_REQUEST_SOURCE
  },
  {
    id: 'manual-4',
    title: 'Crowd-favorite closer',
    artist: 'Example request',
    albumArt: REQUEST_ART_PLACEHOLDER,
    basePrice: 8,
    source: MANUAL_REQUEST_SOURCE
  }
];

function StripeAuthorizationForm({
  disabled,
  onAuthorized,
  onError,
  onCancel
}: {
  disabled: boolean;
  onAuthorized: (paymentIntentId: string) => Promise<void>;
  onError: (message: string) => void;
  onCancel: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [localMessage, setLocalMessage] = useState<string | null>(null);
  const [isAuthorizing, setIsAuthorizing] = useState(false);

  const handleAuthorize = async () => {
    if (!stripe || !elements || disabled || isAuthorizing) return;
    setIsAuthorizing(true);
    setLocalMessage(null);

    try {
      const result = await stripe.confirmPayment({
        elements,
        redirect: 'if_required'
      });

      if (result.error) {
        const message = result.error.message || 'Payment authorization failed.';
        setLocalMessage(message);
        onError(message);
        return;
      }

      if (result.paymentIntent?.status === 'processing') {
        // Some payment methods (e.g. bank debits) confirm asynchronously. This
        // isn't a failure -- don't surface it as a top-level error banner.
        setLocalMessage('Your payment is still confirming with your bank. This can take a moment; please wait before trying again.');
        return;
      }

      if (result.paymentIntent?.status !== 'requires_capture') {
        const message = `Payment authorization did not reach capturable status (${result.paymentIntent?.status ?? 'unknown'}).`;
        setLocalMessage(message);
        onError(message);
        return;
      }

      await onAuthorized(result.paymentIntent.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Payment authorization failed.';
      setLocalMessage(message);
      onError(message);
    } finally {
      setIsAuthorizing(false);
    }
  };

  return (
    <div className="space-y-3 text-left">
      <div className="rounded-xl border border-white/10 bg-slate-950 p-3">
        <PaymentElement />
      </div>
      {localMessage && (
        <p className="text-[10px] font-bold text-rose-300">{localMessage}</p>
      )}
      <button
        type="button"
        onClick={handleAuthorize}
        disabled={!stripe || !elements || disabled || isAuthorizing}
        className="w-full flex items-center justify-center gap-2 py-3 auction-gradient text-white rounded-xl text-xs font-bold transition-all shadow-md cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
      >
        <Lock className="w-3.5 h-3.5 text-white" />
        {isAuthorizing || disabled ? 'Authorizing...' : 'Authorize Payment'}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={disabled || isAuthorizing}
        className="w-full py-2 hover:bg-slate-800 text-slate-400 hover:text-white rounded-xl text-xs font-bold transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
      >
        Cancel
      </button>
    </div>
  );
}

export default function PatronView({
  session,
  requests,
  performers,
  gigId,
  onCreateRequest,
  onBoostRequest,
  onReconcilePendingAction,
  onGetPatronRequestStatus,
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
  const [activeTab, setActiveTab] = useState<'home' | 'request' | 'tip' | 'queue' | 'discover'>('home');
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);

  // Search Venue Directory States
  const [directorySearch, setDirectorySearch] = useState('');
  const [selectedDirectoryPerformer, setSelectedDirectoryPerformer] = useState<PerformerProfile | null>(null);
  
  // Search parameters
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchTrack[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);

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

  // Temporary confirmation overlay until the real payment processor flow is implemented.
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
    patronStatusReceipt?: string;
    expires_at: string;
    gigId: string;
    // A straight tip always goes through real payment, regardless of the room's
    // free/paid toggle -- only song requests and boosts are room-specific.
    isTip?: boolean;
    clientSecret?: string;
    paymentIntentId?: string;
  } | null>(null);

  const [backendConfirmed, setBackendConfirmed] = useState(false);
  const [isPaying, setIsPaying] = useState(false);
  const [paymentConfirmationState, setPaymentConfirmationState] = useState<PaymentConfirmationState | null>(null);
  const [stripePublishableKey, setStripePublishableKey] = useState<string | null>(null);
  const [stripeConfigError, setStripeConfigError] = useState<string | null>(null);
  const [degraded, setDegraded] = useState(() => !getInitialNetworkStatus().connected);
  const [pendingAction, setPendingAction] = useState<string | null>(() => localStorage.getItem('sway.pendingAction'));
  const [patronRequestStatus, setPatronRequestStatus] = useState<StoredPatronRequestStatus | null>(() => {
    try {
      const raw = localStorage.getItem(PATRON_REQUEST_STATUS_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as StoredPatronRequestStatus;
      if (parsed.gigId !== gigId || Date.now() >= new Date(parsed.expiresAt).getTime()) return null;
      if (!parsed.requestId || !parsed.receipt || !isPatronRequestStatusCode(parsed.status)) return null;
      return parsed;
    } catch {
      return null;
    }
  });
  const [pendingActionMessage, setPendingActionMessage] = useState('');
  const [networkPreflightStatus, setNetworkPreflightStatus] = useState<'unknown' | 'ready' | 'blocked'>('unknown');
  const [formToast, setFormToast] = useState<string | null>(null);
  const formToastTimeoutRef = useRef<number | null>(null);
  const showFormToast = (message: string) => {
    setFormToast(message);
    if (formToastTimeoutRef.current) window.clearTimeout(formToastTimeoutRef.current);
    formToastTimeoutRef.current = window.setTimeout(() => setFormToast(null), 4000);
  };
  const isPaymentConfirmationPending = paymentConfirmationState?.phase === 'PAYMENT_PENDING_CONFIRMATION';
  const isSubmitLocked = isPaying || isPaymentConfirmationPending;
  const stripePromise = useMemo(() => stripePublishableKey ? loadStripe(stripePublishableKey) : null, [stripePublishableKey]);
  const stripeElementsOptions = useMemo(() => checkoutPayload?.clientSecret
    ? {
        clientSecret: checkoutPayload.clientSecret,
        appearance: { theme: 'night' as const }
      }
    : null, [checkoutPayload?.clientSecret]);

  const rememberPatronRequestStatus = (
    result: any,
    payload: { gigId?: string; patronStatusReceipt?: string; isTip?: boolean }
  ) => {
    if (payload.isTip || !payload.gigId || !payload.patronStatusReceipt) return;
    const requestId = typeof result?.request?.requestId === 'string' ? result.request.requestId : null;
    const status = result?.request?.status;
    if (!requestId || !isPatronRequestStatusCode(status)) return;

    const record: StoredPatronRequestStatus = {
      gigId: payload.gigId,
      requestId,
      receipt: payload.patronStatusReceipt,
      status,
      expiresAt: new Date(Date.now() + PATRON_REQUEST_STATUS_TTL_MS).toISOString()
    };
    localStorage.setItem(PATRON_REQUEST_STATUS_STORAGE_KEY, JSON.stringify(record));
    setPatronRequestStatus(record);
  };

  const forgetPatronRequestStatus = () => {
    localStorage.removeItem(PATRON_REQUEST_STATUS_STORAGE_KEY);
    setPatronRequestStatus(null);
  };

  // A plain-language status for the patron's most recent request, if any.
  // Only surfaced when there's something to report -- a brand-new patron
  // with no requests yet has nothing to show here.
  const latestRequestStatusMessage: { text: string; tone: 'fuchsia' | 'cyan' | 'slate' | 'rose' } | null = (() => {
    if (session.status === 'closed') return { text: 'Ended: this room is no longer accepting requests.', tone: 'slate' };
    if (!session.requestsOpen || session.status === 'ending') return { text: 'Requests are paused right now.', tone: 'slate' };
    if (degraded || pendingAction) return { text: 'Syncing your last action...', tone: 'cyan' };
    if (!patronRequestStatus) return null;
    if (patronRequestStatus.status === 'fulfilled') return { text: 'Your last request was played!', tone: 'cyan' };
    if (patronRequestStatus.status === 'approved') return { text: 'Your last request was approved and is in the queue.', tone: 'fuchsia' };
    if (patronRequestStatus.status === 'not_approved') return { text: "Your last request wasn't approved this time.", tone: 'rose' };
    return { text: 'Your last request is pending review.', tone: 'fuchsia' };
  })();

  const nowPlayingRequest = requests
    .filter((item) => !item.hidden && !item.removed && !item.shadowBanned)
    .filter((item) => item.status === 'fulfilled' && item.type !== 'tip')
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] ?? null;

  const funnelTelemetryPayload = {
    shell: 'patron' as const,
    surface: 'room-entry' as const,
    route_family: gigId ? 'patron-gig' : 'patron-root',
    has_route_context: Boolean(gigId),
    has_session_context: session.status !== 'inactive' || requests.length > 0 || performers.length > 0,
    build_commit: 'unknown'
  };

  useEffect(() => {
    return subscribeToNetworkStatus((status) => {
      setDegraded(!status.connected);
    });
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(PATRON_REQUEST_STATUS_STORAGE_KEY);
      if (!raw) {
        setPatronRequestStatus(null);
        return;
      }
      const parsed = JSON.parse(raw) as StoredPatronRequestStatus;
      if (Date.now() >= new Date(parsed.expiresAt).getTime()) {
        forgetPatronRequestStatus();
        return;
      }
      setPatronRequestStatus(parsed.gigId === gigId ? parsed : null);
    } catch {
      forgetPatronRequestStatus();
    }
  }, [gigId]);

  useEffect(() => {
    if (!patronRequestStatus || patronRequestStatus.gigId !== gigId) return;
    let cancelled = false;

    const refreshOwnedRequestStatus = async () => {
      try {
        const result = await onGetPatronRequestStatus(
          patronRequestStatus.gigId,
          patronRequestStatus.requestId,
          patronRequestStatus.receipt
        );
        if (cancelled || !isPatronRequestStatusCode(result?.status)) return;
        setPatronRequestStatus((current) => {
          if (!current || current.requestId !== patronRequestStatus.requestId) return current;
          const next = { ...current, status: result.status };
          localStorage.setItem(PATRON_REQUEST_STATUS_STORAGE_KEY, JSON.stringify(next));
          return next;
        });
      } catch (error: any) {
        if (!cancelled && error?.status === 404) forgetPatronRequestStatus();
      }
    };

    void refreshOwnedRequestStatus();
    const interval = window.setInterval(refreshOwnedRequestStatus, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [gigId, patronRequestStatus?.gigId, patronRequestStatus?.requestId, patronRequestStatus?.receipt]);

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
            rememberPatronRequestStatus(result.responseBody, parsed);
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

  const createClientActionIds = (includePatronStatusReceipt: boolean) => {
    const id = globalThis.crypto?.randomUUID?.() || `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return {
      clientRequestId: id,
      idempotencyKey: `sway:${id}`,
      ...(includePatronStatusReceipt ? { patronStatusReceipt: createSecurePatronStatusReceipt() } : {}),
      expires_at: new Date(Date.now() + PENDING_ACTION_TTL_MS).toISOString()
    };
  };

  const ensureStripePublishableKey = async () => {
    if (stripePublishableKey) return stripePublishableKey;
    setStripeConfigError(null);
    const response = await fetch('/api/payment/config', { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || typeof data.publishableKey !== 'string' || !data.publishableKey.startsWith('pk_')) {
      throw new Error(data?.error || 'Payment form is not configured.');
    }
    setStripePublishableKey(data.publishableKey);
    return data.publishableKey;
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
        if (error?.status === 402 || error?.status === 409 || error?.status === 410 || error?.status === 400 || error?.status === 403 || error?.status === 429) throw error;
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
    { id: "c1", title: "Skip the Line Cocktail", description: "Skip the crowd. Bartender mixes your drink immediately.", basePrice: 10, iconName: "🍹" },
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
    if (searchQuery.trim()) return;

    const firstPreset = requestPresets[0];
    setSelectedPresetId(firstPreset.id);
      setSelectedTrack({
        id: firstPreset.id,
        title: firstPreset.label.replace(/^\$\d+\s*/, ''),
        artist: firstPreset.subtitle,
        albumArt: REQUEST_ART_PLACEHOLDER,
        basePrice: firstPreset.amount,
        targetType: firstPreset.targetType,
        source: PRESET_REQUEST_SOURCE
      });
    setTipAmount(Math.max(session.minimumTip, firstPreset.amount));
  }, [activeTab, selectedTrack, requestPresets, searchQuery, session.minimumTip]);

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
    if (val.trim()) {
      setSelectedTrack(null);
      setSelectedPresetId(null);
    }

    if (previewMode && session.talentRole === 'DJ') {
      const query = val.trim().toLowerCase();
      const filtered = previewCatalog.filter((song) => {
        if (!query) return true;
        return song.title.toLowerCase().includes(query)
          || song.artist.toLowerCase().includes(query);
      });

      const anySongOption: SearchTrack | null = query
        ? {
            id: `any-${query.replace(/\s+/g, '-')}`,
            title: val.trim(),
            artist: 'Manual song request',
            albumArt: REQUEST_ART_PLACEHOLDER,
            basePrice: session.minimumTip,
            description: 'Send this as an open request',
            source: MANUAL_REQUEST_SOURCE
          }
        : null;

      setSearchResults(anySongOption ? [anySongOption, ...filtered] : filtered);
      setIsSearching(false);
      return;
    }

    const trimmed = val.trim();
    const openSongOption: SearchTrack | null = (session.talentRole === 'DJ' && trimmed)
      ? {
        id: `open-song-${trimmed.toLowerCase().replace(/\s+/g, '-')}`,
        title: trimmed,
        artist: 'Manual song request',
        albumArt: REQUEST_ART_PLACEHOLDER,
        basePrice: session.minimumTip,
        targetType: 'music',
        source: MANUAL_REQUEST_SOURCE
      }
      : null;

    try {
      const response = await fetch('/api/music/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: val, gig_id: gigId })
      });
      if (!response.ok) {
        throw new Error(`Search request failed with status ${response.status}`);
      }
      const data = await response.json();
      const results: SearchTrack[] = Array.isArray(data.results) ? data.results : [];
      setSearchResults(openSongOption ? [openSongOption, ...results] : results);
      setSearchError(false);
    } catch (e) {
      console.warn("Search endpoint errored out:", e);
      setSearchResults(openSongOption ? [openSongOption] : []);
      setSearchError(true);
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
    setSearchQuery('');
    // Auto populate minimum or baseline price
    setTipAmount(Math.max(session.minimumTip, track.basePrice || session.minimumTip));
  };

  // Open confirmation. boostTarget/boostAmountOverride are passed explicitly
  // for boosts rather than relying on boostingItem/boostAmount state set
  // moments earlier in the same click handler -- React state updates are not
  // visible until the next render, so reading that state here would silently
  // see the previous (often null/stale) value on a patron's first boost tap.
  const initiateCheckout = (type: 'request' | 'boost', boostTarget?: RequestItem, boostAmountOverride?: number) => {
    if (session.status === 'closed' || isSubmitLocked) return;

    if (networkPreflightStatus !== 'ready') {
      setDegraded(true);
      setPendingActionMessage(CAPTIVE_PORTAL_BLOCK_COPY);
      alert(CAPTIVE_PORTAL_BLOCK_COPY);
      return;
    }

    if (!gigId) {
      const routeCopy = 'This QR route is missing a valid gig ID. Ask the performer for the latest room link.';
      setDegraded(true);
      setPendingActionMessage(routeCopy);
      return;
    }

    if (type === 'request' && activeTab === 'request' && !session.requestsOpen) {
      showFormToast("Request submissions are temporarily closed or locked by the host. Feel free to support via 'Direct cash tip' instead!");
      return;
    }

    let title = '';
    let artist = '';
    let trackArt = '';
    let amt = 0;

    const paymentsEnabledForRoom = session.paymentsEnabled !== false;

    if (type === 'request') {
      if (!senderName) {
        showFormToast("Please enter a Patron Name so the Performer knows who tipped!");
        return;
      }
      if (paymentsEnabledForRoom && tipAmount < session.minimumTip) {
        showFormToast(`Minimum tip required is $${session.minimumTip}`);
        return;
      }

      if (session.talentRole === 'DJ') {
        if (!selectedTrack) {
          showFormToast("Please search and select a song request first!");
          return;
        }
        title = selectedTrack.title;
        artist = selectedTrack.artist;
        trackArt = selectedTrack.albumArt;
      } else {
        // Custom menus
        if (!selectedTrack) {
          showFormToast("Please select an item from the menu!");
          return;
        }
        title = selectedTrack.title;
        artist = selectedTrack.description;
        trackArt = '';
      }
      amt = paymentsEnabledForRoom ? tipAmount : 0;
    } else {
      // Boost check
      const targetItem = boostTarget ?? boostingItem;
      if (!targetItem) return;
      const targetBoostAmount = boostAmountOverride ?? boostAmount;
      // The boost modal has its own "Booster / Sponsor Name" field, so the name
      // doesn't need to exist before the modal opens -- prefill it from
      // Request/Tip if the patron already entered one there, but otherwise let
      // them type it directly in the modal. completePayment() requires it
      // non-empty before actually submitting.
      if (!boostPatronName && senderName) {
        setBoostPatronName(senderName);
      }
      if (paymentsEnabledForRoom && targetBoostAmount < session.minimumTip) {
        showFormToast(`Minimum boost is $${session.minimumTip}`);
        return;
      }
      title = targetItem.title;
      artist = targetItem.subtitle;
      amt = paymentsEnabledForRoom ? targetBoostAmount : 1;
    }

    const platformFee = paymentsEnabledForRoom && session.feeType === 'patron' ? 1.0 : 0;
    const total = amt + platformFee;

    if (type === 'request') {
      sendRequestStarted(funnelTelemetryPayload);
    } else {
      sendBoostStarted(funnelTelemetryPayload);
    }

    setPaymentConfirmationState(null);
    setCheckoutPayload({
      open: true,
      type,
      title,
      artist,
      amount: amt,
      fee: platformFee,
      total,
      targetId: type === 'boost' ? (boostTarget ?? boostingItem)?.id : undefined,
      trackArt,
      gigId,
      ...createClientActionIds(type === 'request')
    });
  };

  const submitCheckoutPayload = async (paymentIntentId?: string) => {
    if (!checkoutPayload) return;

    if (checkoutPayload.type === 'request') {
      const isCustom = session.talentRole !== 'DJ';
      return submitWithBoundedRetry(() => onCreateRequest({
        type: checkoutPayload.isTip ? 'tip' : 'request',
        targetType: checkoutPayload.isTip ? 'straight_tip' : (selectedTrack?.targetType || (isCustom ? 'custom' : 'music')),
        title: checkoutPayload.title,
        subtitle: checkoutPayload.artist || '',
        senderName: senderName,
        message: commentMessage,
        amount: checkoutPayload.amount,
        albumArt: checkoutPayload.trackArt,
        sourceProvider: selectedTrack?.sourceProvider,
        spotifyUri: selectedTrack?.spotifyUri,
        spotifyUrl: selectedTrack?.spotifyUrl,
        client_request_id: checkoutPayload.clientRequestId,
        idempotency_key: checkoutPayload.idempotencyKey,
        patron_status_receipt: checkoutPayload.patronStatusReceipt,
        expires_at: checkoutPayload.expires_at,
        gig_id: checkoutPayload.gigId,
        payment_intent_id: paymentIntentId
      }), checkoutPayload.expires_at);
    }

    if (checkoutPayload.targetId) {
      return submitWithBoundedRetry(() => onBoostRequest(
        checkoutPayload.targetId,
        boostPatronName,
        checkoutPayload.amount,
        checkoutPayload.clientRequestId,
        checkoutPayload.idempotencyKey,
        checkoutPayload.expires_at,
        checkoutPayload.gigId,
        paymentIntentId
      ), checkoutPayload.expires_at);
    }
  };

  const completeCheckoutSuccess = (completedActionType: 'request' | 'boost') => {
    setBackendConfirmed(true);
    setPaymentConfirmationState(null);
    setStripeConfigError(null);
    setPendingAction(null);
    localStorage.removeItem('sway.pendingAction');
    setTimeout(() => {
      setBackendConfirmed(false);
      setCheckoutPayload(null);
      setBoostingItem(null);
      setSelectedTrack(null);
      setCommentMessage('');
      setSenderName('');
      setBoostPatronName('');
      setTipAmount(session.minimumTip);
      setActiveTab(completedActionType === 'boost' ? 'queue' : 'request');
    }, 2000);
  };

  const handleCheckoutError = async (e: unknown) => {
    console.error(e);
    const status = (e as any)?.status;
    const body = (e as any)?.body;
    const backendMessage = body?.error;
    const paymentStatus = body?.payment_status;

    if (status === 402 && paymentStatus === 'requires_confirmation') {
      setDegraded(false);
      setPaymentConfirmationState({
        phase: 'PAYMENT_PENDING_CONFIRMATION',
        actionType: checkoutPayload?.type ?? 'request',
        message: backendMessage || PAYMENT_AUTHORIZATION_REQUIRED_COPY
      });
      setCheckoutPayload((current) => current ? {
        ...current,
        clientSecret: typeof body?.client_secret === 'string' ? body.client_secret : current.clientSecret,
        paymentIntentId: typeof body?.payment_intent_id === 'string' ? body.payment_intent_id : current.paymentIntentId
      } : current);
      setPendingAction(null);
      setPendingActionMessage(PAYMENT_CONFIRMATION_WAITING_COPY);
      localStorage.removeItem('sway.pendingAction');

      try {
        await ensureStripePublishableKey();
      } catch (configError) {
        const message = configError instanceof Error ? configError.message : 'Payment form is not configured.';
        setStripeConfigError(message);
      }
      return;
    }

    if (status === 410) {
      setDegraded(true);
      setPaymentConfirmationState(null);
      setPendingActionMessage(PENDING_ACTION_EXPIRED_COPY);
      setPendingAction(null);
      setCheckoutPayload(null);
      localStorage.removeItem('sway.pendingAction');
    } else if (status === 403) {
      setDegraded(true);
      setPaymentConfirmationState(null);
      setPendingActionMessage(backendMessage || 'Request blocked for this session. Try a different preset or ask the performer for help.');
      setPendingAction(null);
      setCheckoutPayload(null);
      localStorage.removeItem('sway.pendingAction');
    } else if (status === 429) {
      setDegraded(true);
      setPaymentConfirmationState(null);
      setPendingActionMessage(backendMessage || "You've reached the request limit for this session. Try again later as the queue moves.");
      setPendingAction(null);
      setCheckoutPayload(null);
      localStorage.removeItem('sway.pendingAction');
    } else if (status === 409 || status === 400) {
      setDegraded(true);
      setPaymentConfirmationState(null);
      setPendingActionMessage(backendMessage || 'This action is not available right now.');
      setPendingAction(null);
      setCheckoutPayload(null);
      localStorage.removeItem('sway.pendingAction');
    } else if (typeof status === 'number') {
      // A real backend/payment failure (e.g. a 5xx), not a network drop -- don't
      // claim the action was "saved locally", tell the patron it actually failed.
      setDegraded(true);
      setPaymentConfirmationState(null);
      setPendingActionMessage(backendMessage || 'Something went wrong processing that. Please try again.');
      setPendingAction(null);
      setCheckoutPayload(null);
      localStorage.removeItem('sway.pendingAction');
    } else {
      setDegraded(true);
    }
  };

  const beginPendingSubmit = (payload = checkoutPayload) => {
    if (!payload) return;
    const serializedPendingAction = JSON.stringify(payload);
    setPendingAction(serializedPendingAction);
    localStorage.setItem('sway.pendingAction', serializedPendingAction);
  };

  // Create the pending PaymentIntent or complete a no-payment action.
  const completePayment = async () => {
    if (!checkoutPayload || isSubmitLocked) return;

    if (checkoutPayload.type === 'boost' && !boostPatronName.trim()) {
      showFormToast('Enter your name above to send this boost.');
      return;
    }

    if (Date.now() > new Date(checkoutPayload.expires_at).getTime()) {
      setCheckoutPayload(null);
      setPendingAction(null);
      setPendingActionMessage(PENDING_ACTION_EXPIRED_COPY);
      localStorage.removeItem('sway.pendingAction');
      return;
    }

    setIsPaying(true);
    beginPendingSubmit();

    try {
      const result = await submitCheckoutPayload();
      rememberPatronRequestStatus(result, checkoutPayload);
      completeCheckoutSuccess(checkoutPayload.type);
    } catch (e) {
      await handleCheckoutError(e);
    } finally {
      setIsPaying(false);
    }
  };

  const finalizeStripeAuthorization = async (paymentIntentId: string) => {
    if (!checkoutPayload || isPaying) return;
    const payloadWithIntent = { ...checkoutPayload, paymentIntentId };
    setCheckoutPayload(payloadWithIntent);
    setIsPaying(true);
    beginPendingSubmit(payloadWithIntent);

    try {
      const result = await submitCheckoutPayload(paymentIntentId);
      rememberPatronRequestStatus(result, payloadWithIntent);
      completeCheckoutSuccess(checkoutPayload.type);
    } catch (e) {
      await handleCheckoutError(e);
    } finally {
      setIsPaying(false);
    }
  };

  // Straight classic tipping logic bypass
  const handleStraightTipSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitLocked) return;

    if (networkPreflightStatus !== 'ready') {
      setDegraded(true);
      setPendingActionMessage(CAPTIVE_PORTAL_BLOCK_COPY);
      alert(CAPTIVE_PORTAL_BLOCK_COPY);
      return;
    }

    if (!gigId) {
      const routeCopy = 'This QR route is missing a valid gig ID. Ask the performer for the latest room link.';
      setDegraded(true);
      setPendingActionMessage(routeCopy);
      return;
    }

    if (!senderName) {
      showFormToast("Please enter a Patron Name!");
      return;
    }
    if (tipAmount < session.minimumTip) {
      showFormToast(`Minimum tip is $${session.minimumTip}`);
      return;
    }

    const platformFee = session.feeType === 'patron' ? 1.0 : 0;
    sendRequestStarted(funnelTelemetryPayload);
    setPaymentConfirmationState(null);
    setCheckoutPayload({
      open: true,
      type: 'request',
      isTip: true,
      title: 'Classic Tip',
      artist: 'Straight tip supporting the performer directly!',
      amount: tipAmount,
      fee: platformFee,
      total: tipAmount + platformFee,
      gigId,
      ...createClientActionIds(false)
    });
  };

  const getFormat = (val: number) => {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val);
  };

  const approvedQueue = requests
    .filter(r => (r.status === 'approved' || r.status === 'fulfilled') && !r.hidden && !r.removed)
    .sort((a, b) => b.amount - a.amount);

  const newestModeratableRequest = requests.find((item) => !item.removed);
  const isCrowdAutopilot = session.operatingMode === 'crowd_autopilot';
  const requestScopeCopy = (() => {
    if (session.searchScope === 'setlist') {
      return {
        label: 'Setlist song requests',
        body: isCrowdAutopilot
          ? "Pick from this room's setlist. Clean requests can move into the separate crowd-ranked request queue."
          : "Pick from this room's setlist or send a manual request. The DJ decides what enters the separate request queue."
      };
    }
    if (session.searchScope === 'catalog') {
      return {
        label: 'Open request lane',
        body: isCrowdAutopilot
          ? 'Search broadly or type a manual request. Clean requests can move straight into the crowd-ranked queue.'
          : 'Search broadly or type a manual request. The DJ decides what is approved and played.'
      };
    }
    return {
      label: 'DJ library requests',
      body: isCrowdAutopilot
        ? "Search the DJ's synced library when available. Clean requests can move straight into the crowd-ranked queue."
        : "Search the DJ's synced library when available, or send a manual request if the song is not listed. The DJ decides what is approved and played."
    };
  })();

  const checkoutCopy = checkoutPayload
    ? checkoutPayload.type === 'boost'
      ? {
          summaryLabel: 'BOOST SUMMARY',
          itemLabel: session.paymentsEnabled === false ? 'Upvote:' : 'Boost:',
          amountLabel: session.paymentsEnabled === false ? 'Upvote weight:' : 'Boost amount:',
          totalLabel: session.paymentsEnabled === false ? 'Upvote total:' : 'Total boost charge:'
        }
      : checkoutPayload.isTip
        ? {
            summaryLabel: 'TIP SUMMARY',
            itemLabel: 'Tip:',
            amountLabel: 'Tip amount:',
            totalLabel: 'Total tip charge:'
          }
        : {
            summaryLabel: 'REQUEST SUMMARY',
            itemLabel: 'Request:',
            amountLabel: 'Request amount:',
            totalLabel: 'Request total:'
          }
    : null;

  const runSafetyAction = async (action: () => Promise<any>, successCopy: string) => {
    try {
      await action();
      showFormToast(successCopy);
      window.dispatchEvent(new Event('re-fetch-state'));
    } catch (error) {
      console.error(error);
      showFormToast('Safety action failed. Try again in a few moments.');
    }
  };

  return (
    <div id="patron_crowd_screen" className="max-w-xl mx-auto py-4 px-4 pb-20 space-y-6">

      <AnimatePresence>
        {formToast && (
          <motion.div
            initial={{ opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            className="fixed left-1/2 top-4 z-[60] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2"
          >
            <div className="flex items-start justify-between gap-3 rounded-2xl border border-fuchsia-500/30 bg-slate-950/95 px-4 py-3 shadow-2xl backdrop-blur">
              <p className="text-xs font-bold text-white">{formToast}</p>
              <button
                type="button"
                onClick={() => setFormToast(null)}
                className="shrink-0 text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 1. Performer live show snapshot */}
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
          <p className="text-[10px] font-mono uppercase tracking-[0.28em] text-cyan-300">Live show snapshot</p>
          <h1 className="font-display text-lg font-black text-white tracking-wider uppercase">{session.talentName}</h1>
          {patronsWindowTimeLeft && (
            <div className="bg-cyan-950/40 border border-cyan-500/30 px-3 py-1 rounded-full flex items-center gap-1.5 text-[10px] font-mono text-cyan-400 select-none shadow shadow-cyan-500/15 animate-pulse-subtle">
              <span className="w-1.5 h-1.5 bg-cyan-400 rounded-full animate-ping" />
              <span>REQUESTS EXPIRE IN: {patronsWindowTimeLeft}</span>
            </div>
          )}
            <p className="text-xs text-slate-300 max-w-sm leading-relaxed font-sans">
              {previewMode
                ? 'Demo data only. No payment or moderation action will be sent.'
                : session.paymentsEnabled === false
                  ? `Send a free request, upvote an approved queue item, or send a direct tip for ${session.talentName || 'this performer'}. Song requests and boosts are free for this event; tips always go through payment.`
                  : isCrowdAutopilot
                    ? `Request songs or actions, send a direct tip, or boost the crowd-ranked queue for ${session.talentName || 'this performer'}. Clean requests can move into up next automatically.`
                    : `Request songs or actions, send a direct tip, or boost an approved queue item for ${session.talentName || 'this performer'}. Confirm payment to send your action for performer approval.`}
            </p>
            <div className="grid w-full max-w-md grid-cols-2 gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  setActiveTab('tip');
                  setSelectedTrack({ title: 'Classic Tip', description: 'Straight tip supporting the performer directly!', basePrice: session.minimumTip });
                }}
                className="min-h-14 rounded-xl border border-emerald-500/30 bg-emerald-500 px-2 py-3 text-center text-xs font-black uppercase tracking-wide text-slate-950 shadow-lg transition-all active:scale-[0.99] min-[360px]:px-4 min-[360px]:text-sm"
              >
                <span className="inline-flex items-center justify-center gap-1 min-[360px]:gap-2"><Coins className="h-4 w-4" /> Tip</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveTab('request');
                  setSelectedTrack(null);
                }}
                className="min-h-14 rounded-xl border border-fuchsia-500/40 bg-fuchsia-600 px-2 py-3 text-center text-xs font-black uppercase tracking-wide text-white shadow-lg transition-all active:scale-[0.99] min-[360px]:px-4 min-[360px]:text-sm"
              >
                <span className="inline-flex items-center justify-center gap-1 min-[360px]:gap-2"><Sparkles className="h-4 w-4" /> Request</span>
              </button>
            </div>
            <div className="w-full max-w-md rounded-xl border border-cyan-500/20 bg-slate-950/70 px-4 py-3 text-left">
              <div className="flex items-start gap-2">
                <Sliders className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
                <div>
                  <p className="text-[9px] font-mono uppercase tracking-widest text-cyan-300">Request scope</p>
                  <p className="mt-1 text-xs font-bold text-white">{requestScopeCopy.label}</p>
                  <p className="mt-1 text-[10px] leading-relaxed text-slate-400">{requestScopeCopy.body}</p>
                </div>
              </div>
            </div>
          </div>
        </div>

      {/* Room Layer: Now Playing / Up Next + honest operating mode */}
      {(() => {
        const visible = requests.filter(r => !r.hidden && !r.removed && !r.shadowBanned);
        const nowPlaying = nowPlayingRequest;
        const upNext = visible
          .filter(r => r.status === 'approved')
          .slice()
          .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0))
          .slice(0, 3);
        const isOpenCall = session.operatingMode === 'open_call';
        const isAutopilot = session.operatingMode === 'crowd_autopilot';
        const modeLabel = isAutopilot ? 'Crowd Autopilot' : isOpenCall ? 'Open Call' : 'Manual';
        const modeHint = isAutopilot
          ? 'Crowd-ranked requests can move straight to up next'
          : isOpenCall
            ? 'No catalog - send an open request'
            : 'Host is driving the room live';
        return (
          <div className="bg-slate-900/70 border border-white/10 rounded-2xl p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-bold tracking-widest uppercase text-slate-400">
                {nowPlaying ? 'Now Playing' : 'Live Now'}
              </span>
              <span
                className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-950 border border-white/10 text-cyan-300"
                title={modeHint}
              >
                {modeLabel}
              </span>
            </div>

            {nowPlaying ? (
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  {nowPlaying.albumArt ? (
                    <img
                      src={nowPlaying.albumArt}
                      alt=""
                      className="w-11 h-11 rounded-xl border border-white/10 object-cover shrink-0"
                    />
                  ) : (
                    <div className="w-11 h-11 rounded-xl bg-gradient-to-tr from-fuchsia-600/30 to-blue-600/30 border border-white/10 flex items-center justify-center shrink-0">
                      <Music className="w-5 h-5 text-cyan-300" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-bold text-white truncate">{nowPlaying.title}</div>
                    {nowPlaying.subtitle && (
                      <div className="text-[11px] text-slate-400 truncate">{nowPlaying.subtitle}</div>
                    )}
                  </div>
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
                    {session.paymentsEnabled !== false && (
                      <span className="font-mono text-cyan-300 shrink-0">${r.amount}</span>
                    )}
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

      {activeTab !== 'home' && (
      <details className="bg-slate-900/70 border border-white/10 rounded-xl p-4 space-y-3">
        <summary className="cursor-pointer list-none">
          <h3 className="text-xs font-bold tracking-wider uppercase text-slate-200">Safety Controls</h3>
          <p className="text-[11px] text-slate-400 mt-1">Use these controls to report a request, block future interactions, contact support, or start a data deletion request.</p>
        </summary>

        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => {
              if (!newestModeratableRequest) {
                showFormToast('No request is available to report yet.');
                return;
              }
              runSafetyAction(
                () => onReportContent(newestModeratableRequest.id, 'Patron safety report', 'User-reported content check requested.'),
                'Report sent to the safety team.'
              );
            }}
            className="px-3 py-2 rounded-lg text-xs font-bold bg-slate-950 border border-white/10 text-slate-200 hover:border-fuchsia-500/40 cursor-pointer"
          >
            Report
          </button>

          <button
            type="button"
            onClick={() => runSafetyAction(
              () => onBlockFoundation('patron_device_id_hash', 'anonymous-device', 'Patron requested a device block.'),
              'Device block recorded.'
            )}
            className="px-3 py-2 rounded-lg text-xs font-bold bg-slate-950 border border-white/10 text-slate-200 hover:border-fuchsia-500/40 cursor-pointer"
          >
            Block
          </button>

          <button
            type="button"
            onClick={() => runSafetyAction(onSupportContact, 'Support options opened.')}
            className="px-3 py-2 rounded-lg text-xs font-bold bg-slate-950 border border-white/10 text-slate-200 hover:border-fuchsia-500/40 cursor-pointer"
          >
            Support / Contact
          </button>

          <button
            type="button"
            onClick={() => runSafetyAction(onDataDeletionPlaceholder, 'Data deletion request started.')}
            className="px-3 py-2 rounded-lg text-xs font-bold bg-slate-950 border border-white/10 text-slate-200 hover:border-fuchsia-500/40 cursor-pointer"
          >
            Data Deletion Request
          </button>
        </div>
      </details>
      )}

      {/* 2. Primary Tabs Selector */}
      {session.status === 'active' && activeTab !== 'home' && (
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
            {session.talentRole === 'DJ' ? "Request" : "Request"}
          </button>

          <button
            onClick={() => { setActiveTab('tip'); setSelectedTrack({ title: 'Classic Tip', description: 'Straight tip supporting the performer directly!', basePrice: session.minimumTip }); }}
            className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
              activeTab === 'tip'
                ? 'bg-fuchsia-600 text-white shadow-lg glow-fuchsia'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Coins className="w-4 h-4" /> Tip
          </button>

          <button
            onClick={() => setActiveTab('queue')}
            className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
              activeTab === 'queue'
                ? 'bg-fuchsia-600 text-white shadow-lg glow-fuchsia'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Activity className="w-4 h-4" /> Boost Queue
          </button>

        </div>
      )}

      {/* 3. Core Action Panels */}
      {(degraded || pendingAction) && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-3 text-xs text-amber-200">
          {pendingActionMessage || 'Connection degraded. Sway saved your pending action locally and will reconcile with the server before showing confirmation.'}
        </div>
      )}

      {isPaymentConfirmationPending && (
        <div className="rounded-xl border border-cyan-500/30 bg-cyan-950/20 p-3 text-xs text-cyan-100">
          <p className="font-bold uppercase tracking-wide text-cyan-300">Payment authorization required</p>
          <p className="mt-2">{paymentConfirmationState?.message || PAYMENT_AUTHORIZATION_REQUIRED_COPY}</p>
          <p className="mt-2">{PAYMENT_AUTHORIZATION_DISCLOSURE_COPY}</p>
          <p className="mt-2">{PAYMENT_CONFIRMATION_WAITING_COPY}</p>
        </div>
      )}

      {latestRequestStatusMessage && (
        <div
          className={`rounded-xl border px-4 py-3 text-xs font-bold ${
            latestRequestStatusMessage.tone === 'fuchsia'
              ? 'border-fuchsia-500/30 bg-fuchsia-950/20 text-fuchsia-200'
              : latestRequestStatusMessage.tone === 'cyan'
                ? 'border-cyan-500/30 bg-cyan-950/20 text-cyan-100'
                : latestRequestStatusMessage.tone === 'rose'
                  ? 'border-rose-500/30 bg-rose-950/20 text-rose-200'
                  : 'border-white/10 bg-slate-900/70 text-slate-300'
          }`}
        >
          {latestRequestStatusMessage.text}
        </div>
      )}

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
                    {session.talentName} has temporarily paused new track requests to catch up with the approved queue.
                  </p>
                </div>
                
                <div className="p-3 bg-slate-950 border border-white/5 rounded-xl font-mono text-2xs space-y-1.5 min-w-0">
                  <span className="text-fuchsia-400 font-bold block select-none">💡 WHAT YOU CAN STILL DO:</span>
                  <div className="text-slate-400 space-y-1 font-sans text-xs">
                    <p>• Send a <strong className="text-emerald-400">Direct Cash Tip</strong> to show love</p>
                    <p>• <strong className="text-cyan-400">Boost existing requests</strong> in the live queue to push them up</p>
                    <p>• Watch the live queue and try again when requests reopen</p>
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
                    onClick={() => setActiveTab('queue')}
                    className="flex-1 py-2.5 bg-slate-950 border border-white/5 text-slate-300 hover:text-white text-xs font-bold rounded-xl transition-colors cursor-pointer"
                  >
                    View Live Queue
                  </button>
                </div>
              </motion.div>
            ) : (
              <>
            
            {/* If DJ Role: Manual request entry */}
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
                            albumArt: REQUEST_ART_PLACEHOLDER,
                            basePrice: preset.amount,
                            targetType: preset.targetType,
                            source: PRESET_REQUEST_SOURCE
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
                    Request by song or artist
                  </span>
                </div>
                <p className="text-[11px] leading-relaxed text-slate-400">
                  Enter the song or artist you want. Sway records the request for performer review, but it does not verify streaming-platform or DJ-library availability yet.
                </p>
                 {/* Form input fields */}
                <form onSubmit={triggerSearchSubmit} className="flex gap-2">
                  <div className="relative flex-1">
                    <Search className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Type the song or artist you want..."
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
                {selectedTrack && !searchQuery.trim() && (
                  <motion.div 
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="p-4 bg-fuchsia-500/5 border border-fuchsia-500/25 rounded-xl flex items-center justify-between gap-3 glow-fuchsia animate-fade-in"
                  >
                    <div className="flex items-center gap-3">
                      <img
                        src={selectedTrack.albumArt}
                        alt={`${selectedTrack.title} album art`}
                        referrerPolicy="no-referrer"
                        onError={(e) => { e.currentTarget.src = REQUEST_ART_PLACEHOLDER; }}
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
                      className="min-h-8 rounded-lg px-2 text-xs font-semibold text-fuchsia-400 hover:bg-fuchsia-500/10 hover:underline cursor-pointer"
                    >
                      Change
                    </button>
                  </motion.div>
                )}
                {(!selectedTrack || searchQuery.trim()) && (
                  <div className="space-y-2 max-h-56 overflow-y-auto">
                    {searchError && (
                      <p className="text-xs text-rose-300 font-sans px-1">Search is temporarily unavailable. Try again.</p>
                    )}
                    {!searchError && !isSearching && searchQuery.trim() && searchResults.length === 0 && (
                      <p className="text-xs text-slate-400 font-sans px-1">No matches found.</p>
                    )}
                    {searchResults.map((song) => (
                      <button
                        key={song.id}
                        type="button"
                        onClick={() => handleSelectTrack(song)}
                        className="w-full p-2.5 bg-slate-900/40 hover:bg-slate-900 border border-white/5 hover:border-white/10 rounded-lg flex items-center gap-3 text-left transition-colors cursor-pointer"
                      >
                        <img
                          src={song.albumArt}
                          alt={`${song.title} album art`}
                          referrerPolicy="no-referrer"
                          onError={(e) => { e.currentTarget.src = REQUEST_ART_PLACEHOLDER; }}
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
                            source: PRESET_REQUEST_SOURCE
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

            {/* Common request inputs: sender credentials, notes, and tip value limits */}
            {selectedTrack && (
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-slate-900 border border-white/10 rounded-xl p-5 space-y-4 shadow-lg"
              >
                {/* Visual slider or pricing -- not shown at all when requests are free in this room */}
                {session.paymentsEnabled !== false && (
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-xs font-semibold font-sans">
                      <span className="text-slate-400 font-sans">Tip Amount</span>
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
                      className="mt-2 min-h-6 w-full cursor-pointer accent-fuchsia-500"
                    />
                    <p className="text-[10px] text-slate-500 leading-relaxed font-sans">
                      Tip higher to boost your request toward Up Next.
                    </p>
                  </div>
                )}

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
                    disabled={isSubmitLocked}
                    className="w-full flex items-center justify-center gap-1.5 py-3 auction-gradient rounded-xl text-xs font-bold text-white transition-all transform active:scale-95 glow-fuchsia cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {session.paymentsEnabled !== false && <CreditCard className="w-4 h-4" />}
                    {isSubmitLocked
                      ? 'Payment confirmation pending'
                      : session.paymentsEnabled !== false
                        ? `Send Request • ${getFormat(tipAmount)}`
                        : 'Send Free Request'}
                  </button>
                  <p className="text-[9px] text-slate-500 text-center mt-2.5 leading-relaxed font-sans">
                    {session.paymentsEnabled !== false
                      ? `Confirm payment to send this request. ${PAYMENT_AUTHORIZATION_DISCLOSURE_COPY}`
                      : `No payment needed for this request. ${PAYMENT_AUTHORIZATION_DISCLOSURE_COPY}`}
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
              <p className="text-xs text-slate-400 mt-1 leading-relaxed">Send a direct tip for {session.talentName}. Confirm payment to finalize it, and your payment method may be charged when the action is approved.</p>
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
              disabled={isSubmitLocked}
              className="w-full flex items-center justify-center gap-1.5 py-3 auction-gradient hover:opacity-90 text-white text-xs font-bold rounded-xl transition-all glow-fuchsia cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
            >
              <CreditCard className="w-4 h-4" /> {isSubmitLocked ? 'Payment confirmation pending' : `Send Tip (${getFormat(tipAmount)})`}
            </button>
          </motion.form>
        )}

        {/* TAB C: The Live Leaderboard / Rank Status List & "Boost" Actions */}
        {(activeTab === 'queue' || session.status === 'ending') && (
          <div className="space-y-4 font-sans">
            <div className="flex justify-between items-center select-none animate-fade-in">
              <h3 className="font-display text-sm font-bold text-white flex items-center gap-1.5 uppercase tracking-wider">
                <TrendingUp className="w-4 h-4 text-fuchsia-500 animate-pulse" /> Live Queue
              </h3>
              <span className="text-[9px] text-cyan-400 font-mono uppercase bg-cyan-950/40 px-2.5 py-1 rounded-full border border-cyan-500/20 shadow-sm animate-pulse flex items-center gap-1">
                <span className="w-1.5 h-1.5 bg-cyan-400 rounded-full animate-ping"></span> Live Feed
              </span>
            </div>

            <div className="space-y-3">
              {approvedQueue.length === 0 ? (
                <div className="text-center p-8 bg-slate-900/10 border border-dashed border-white/10 rounded-2xl select-none">
                  <Smartphone className="w-6 h-6 text-slate-600 mx-auto animate-bounce" />
                  <div className="text-xs font-semibold text-slate-400 mt-1">No approved requests yet</div>
                  <p className="text-[10px] text-slate-500">Wait for performer approvals or submit your own request above.</p>
                </div>
              ) : (
                approvedQueue.map((req, idx) => {
                  const isTopOne = idx === 0;
                  const isFulfilled = req.status === 'fulfilled';
                  return (
                    <motion.div
                      key={req.id}
                      layoutId={`patron-queue-${req.id}`}
                      className={`ladder-row p-1 rounded-2xl flex flex-col transition-all overflow-hidden ${
                        isTopOne 
                          ? 'bg-slate-950 glow-fuchsia border border-fuchsia-500/25' 
                          : 'bg-slate-900/60 border border-white/5'
                      }`}
                    >
                      <div className={`flex items-center justify-between gap-4 p-3.5 rounded-xl ${isTopOne ? 'bg-slate-900/70 border border-white/5' : ''}`}>
                        <div className="flex items-center gap-3 min-w-0">
                          {/* Ranking position */}
                          <div className="flex flex-col items-center justify-center font-display font-black text-center pr-1 shrink-0 select-none">
                            <span className={`text-base ${isTopOne ? 'text-fuchsia-400 font-black italic' : 'text-slate-500 font-bold'}`}>
                              {idx < 9 ? `0${idx + 1}` : idx + 1}
                            </span>
                          </div>

                          {req.albumArt ? (
                            <img
                              src={req.albumArt}
                              alt={`${req.title} album art`}
                              referrerPolicy="no-referrer"
                              onError={(e) => { e.currentTarget.src = REQUEST_ART_PLACEHOLDER; }}
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
                          {session.paymentsEnabled !== false && (
                            <div className={`text-sm font-mono font-black ${isTopOne ? 'text-fuchsia-400 text-lg' : 'text-slate-300'}`}>
                              {getFormat(req.amount)}
                            </div>
                          )}

                          {isFulfilled ? (
                            <span className="text-[9px] font-mono font-bold text-cyan-400 bg-cyan-950/40 border border-cyan-500/25 px-2 py-1 rounded inline-flex items-center gap-1">
                              <Check className="w-3 h-3 text-cyan-300" /> FULFILLED
                            </span>
                          ) : (
                            session.status === 'active' && (
                              <button
                                type="button"
                                onClick={() => {
                                  if (isSubmitLocked) return;
                                  const presetAmount = Math.max(session.minimumTip, 10);
                                  setBoostingItem(req);
                                  setBoostAmount(presetAmount);
                                  initiateCheckout('boost', req, presetAmount);
                                }}
                                disabled={isSubmitLocked}
                                className={`px-4 py-1.5 rounded-full text-[10px] font-black uppercase tracking-wider transition-all cursor-pointer ${
                                  isTopOne
                                    ? 'bg-fuchsia-600/20 border border-fuchsia-500/40 text-fuchsia-400 hover:bg-fuchsia-600/30 glow-fuchsia shadow-sm'
                                    : 'bg-slate-800 border border-white/10 text-slate-400 hover:text-white hover:border-white/20'
                                } disabled:cursor-not-allowed disabled:opacity-60`}
                              >
                                Boost
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
                <Sparkles className="w-4 h-4 text-amber-400 animate-pulse" /> Browse Live Performers
              </h3>
              <p className="text-xs text-slate-400 leading-relaxed font-sans">
                Browse active performers and DJs, then jump into the live room link they are currently using.
              </p>
            </div>

            {/* Directory search input */}
            <div className="relative font-sans border-none sm:border-solid">
              <Search className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={directorySearch}
                onChange={(e) => setDirectorySearch(e.target.value)}
                placeholder="Search by performer, role, or live room..."
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
                      <p className="text-[10px] text-slate-500 font-sans mt-0.5">Refine search criteria to match active live rooms</p>
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
                          <span>ACTIVE PERFORMER</span>
                        </div>
                      )}

                      <div className="flex items-center justify-between gap-4 p-3 rounded-xl">
                        <div className="flex items-center gap-3.5 min-w-0">
                          <div className="relative">
                            <img
                              src={p.avatarUrl || REQUEST_ART_PLACEHOLDER}
                              alt={p.name}
                              referrerPolicy="no-referrer"
                              onError={(e) => { e.currentTarget.src = REQUEST_ART_PLACEHOLDER; }}
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
                              Live room: {p.venueName}
                            </p>
                            
                            <div className="flex items-center gap-2 mt-2">
                              <span className="text-[8px] font-mono font-bold text-fuchsia-400 bg-fuchsia-950/20 border border-fuchsia-500/10 px-1.5 py-0.5 rounded">
                                {p.role}
                              </span>
                              <span className="text-[8px] font-mono text-slate-500">
                                Min Tips: ${p.minimumTip}
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* Link truth + quick tip actions */}
                        <div className="flex items-center gap-3 shrink-0">
                          <div
                            className={`rounded-xl border px-2.5 py-2 text-[9px] font-mono font-bold uppercase tracking-widest ${
                              p.isFeatured
                                ? 'border-amber-400/40 bg-amber-500/10 text-amber-300'
                                : 'border-white/10 bg-slate-950 text-slate-400'
                            }`}
                            title="Ask the performer for a live room link."
                          >
                            Room link
                          </div>

                          {/* Quick Tip action */}
                          <button
                            type="button"
                            onClick={() => {
                              if (isSubmitLocked) return;
                              setSelectedDirectoryPerformer(p);
                              setTipAmount(p.minimumTip);
                              setSenderName('');
                              setCommentMessage('');
                            }}
                            disabled={isSubmitLocked}
                            className={`px-3 py-1.5 rounded-xl text-[10px] font-black uppercase text-center transition-all cursor-pointer font-sans ${
                              p.isFeatured
                                ? 'bg-amber-500 hover:bg-amber-400 text-slate-950 shadow-md shadow-amber-500/10'
                                : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-white/5'
                            } disabled:cursor-not-allowed disabled:opacity-60`}
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
                              <span className="text-slate-400">Tip Value</span>
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
                              if (isSubmitLocked) return;
                              if (!senderName) {
                                showFormToast("Please enter your name!");
                                return;
                              }
                              if (tipAmount < p.minimumTip) {
                                showFormToast(`Minimum tip is $${p.minimumTip}`);
                                return;
                              }
                              if (!gigId) {
                                const routeCopy = 'This QR route is missing a valid gig ID. Ask the performer for the latest room link.';
                                setDegraded(true);
                                setPendingActionMessage(routeCopy);
                                return;
                              }
                              // Open confirmation
                              const platformFee = session.feeType === 'patron' ? 1.0 : 0;
                              sendRequestStarted(funnelTelemetryPayload);
                              setPaymentConfirmationState(null);
                              setCheckoutPayload({
                                open: true,
                                type: 'request',
                                title: `Directory Tip to ${p.name}`,
                                artist: `Straight tip supporting ${p.name} in this live room`,
                                amount: tipAmount,
                                fee: platformFee,
                                total: tipAmount + platformFee,
                                gigId,
                                ...createClientActionIds(true)
                              });
                            }}
                            disabled={isSubmitLocked}
                            className="w-full py-2 bg-gradient-to-r from-fuchsia-600 to-blue-600 text-white font-black text-xs rounded-lg shadow-md cursor-pointer font-sans text-center disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {isSubmitLocked ? 'Payment confirmation pending' : `Send Tip • $${tipAmount}.00`}
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
       {/* 4. TEMPORARY CONFIRMATION MODAL OVERLAY */}
      <AnimatePresence>
        {checkoutPayload && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <motion.div
              initial={{ scale: 0.95, y: 15, opacity: 0 }}
              animate={{ scale: 1, y: 0, opacity: 1 }}
              exit={{ scale: 0.95, y: 15, opacity: 0 }}
              className="w-full max-w-sm bg-slate-900 border border-white/10 rounded-2xl overflow-hidden shadow-2xl glass-panel text-center font-sans"
            >
              
              {/* Request processing and success cards */}
              {backendConfirmed ? (
                <div className="p-8 space-y-4">
                  <div className="w-16 h-16 bg-cyan-500/20 border border-cyan-500/30 text-cyan-400 flex items-center justify-center rounded-full mx-auto animate-bounce">
                    <Check className="w-8 h-8 text-cyan-400" />
                  </div>
                  <h3 className="font-sans text-lg font-bold text-white">Request Submitted</h3>
                  <p className="text-xs text-slate-300 leading-relaxed max-w-xs mx-auto font-sans">
                    Sent. Status: Pending. {PAYMENT_AUTHORIZATION_DISCLOSURE_COPY}
                  </p>
                </div>
              ) : (
                /* Temporary confirmation fields */
                <div className="p-6 space-y-6">
                  
                  {/* Title and meta */}
                  <div className="space-y-1">
                    <span className="text-[9px] font-mono font-bold text-slate-500 uppercase tracking-widest">{checkoutCopy?.summaryLabel ?? 'REQUEST SUMMARY'}</span>
                    <h3 className="font-sans text-base font-bold text-white">
                      {previewMode
                        ? 'Demo Only'
                        : isPaymentConfirmationPending
                          ? 'Payment authorization required'
                          : checkoutPayload.type === 'request'
                            ? 'Confirm Request'
                            : 'Confirm Boost'}
                    </h3>
                    {previewMode && (
                      <p className="text-[10px] text-amber-200 font-bold uppercase tracking-widest">
                        Demo data. No payment or request will be recorded.
                      </p>
                    )}
                    {!previewMode && (
                      <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                        {isPaymentConfirmationPending ? PAYMENT_CONFIRMATION_WAITING_COPY : PAYMENT_AUTHORIZATION_DISCLOSURE_COPY}
                      </p>
                    )}
                  </div>

                  {/* Pricing detail sheets */}
                  {checkoutPayload.isTip || session.paymentsEnabled !== false ? (
                    <div className="bg-slate-950 p-4 rounded-xl border border-white/5 space-y-2.5 text-left font-mono">
                      <div className="flex justify-between text-xs font-semibold">
                        <span className="text-slate-550 text-slate-500">{checkoutCopy?.itemLabel ?? 'Request:'}</span>
                        <span className="text-white font-sans max-w-[150px] truncate">{checkoutPayload.title}</span>
                      </div>

                      <div className="flex justify-between text-xs">
                        <span className="text-slate-500 mt-0.5">{checkoutCopy?.amountLabel ?? 'Request amount:'}</span>
                        <span className="text-white">${checkoutPayload.amount}.00</span>
                      </div>

                      <div className="flex justify-between text-xs font-sans">
                        <span className="text-slate-500">Service Fee:</span>
                        <span className="text-fuchsia-400 font-bold">
                          {checkoutPayload.fee > 0 ? getFormat(checkoutPayload.fee) : 'Absorbed by Performer'}
                        </span>
                      </div>

                      <div className="border-t border-white/10 pt-2.5 flex justify-between text-xs font-mono font-black">
                        <span className="text-slate-400">{checkoutCopy?.totalLabel ?? 'Request total:'}</span>
                        <span className="text-cyan-400 font-bold">${checkoutPayload.total}.00</span>
                      </div>
                    </div>
                  ) : (
                    <div className="bg-slate-950 p-4 rounded-xl border border-white/5 space-y-1.5 text-left font-mono">
                      <div className="flex justify-between text-xs font-semibold">
                        <span className="text-slate-550 text-slate-500">
                          {checkoutPayload.type === 'boost' ? 'Upvote:' : 'Request:'}
                        </span>
                        <span className="text-white font-sans max-w-[150px] truncate">{checkoutPayload.title}</span>
                      </div>
                      <p className="text-[10px] text-emerald-300 font-sans">Free event — no payment required.</p>
                    </div>
                  )}

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
                      
                      {session.paymentsEnabled !== false && (
                        <div className="space-y-1">
                          <label className="text-[10px] text-slate-400 uppercase font-mono tracking-wider font-bold">BOOST STACK AMOUNT</label>
                          <input
                            type="number"
                            min={session.minimumTip}
                            max={50}
                            value={boostAmount}
                            onChange={(e) => {
                              const nextAmount = Number(e.target.value);
                              setBoostAmount(nextAmount);
                              // The summary above and the actual submitted charge both read
                              // from checkoutPayload, not live boostAmount -- keep them in
                              // sync as the patron edits, or their edit here would be
                              // silently ignored at submit time.
                              setCheckoutPayload((prev) => (prev
                                ? { ...prev, amount: nextAmount, total: nextAmount + prev.fee }
                                : prev));
                            }}
                            className="w-full bg-slate-950 border border-white/10 px-4 py-2 text-xs rounded-xl text-white focus:border-fuchsia-500 outline-none"
                          />
                        </div>
                      )}
                    </div>
                  )}

                  {/* Submit action */}
                  <div className="space-y-2">
                    {checkoutPayload.clientSecret && stripePromise && stripeElementsOptions ? (
                      <Elements stripe={stripePromise} options={stripeElementsOptions} key={checkoutPayload.clientSecret}>
                        <StripeAuthorizationForm
                          disabled={isPaying || previewMode}
                          onAuthorized={finalizeStripeAuthorization}
                          onError={(message) => {
                            setStripeConfigError(message);
                            setPendingActionMessage(message);
                          }}
                          onCancel={() => {
                            setCheckoutPayload(null);
                            setBoostingItem(null);
                            setPaymentConfirmationState(null);
                            setStripeConfigError(null);
                          }}
                        />
                      </Elements>
                    ) : (
                      <>
                        {stripeConfigError && (
                          <p className="text-[10px] font-bold text-rose-300">{stripeConfigError}</p>
                        )}
                        <button
                          type="button"
                          onClick={completePayment}
                          disabled={isSubmitLocked || previewMode}
                          className="w-full flex items-center justify-center gap-2 py-3 auction-gradient text-white rounded-xl text-xs font-bold transition-all shadow-md cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {(checkoutPayload.isTip || session.paymentsEnabled !== false) && <Lock className="w-3.5 h-3.5 text-white" />}
                          {previewMode
                            ? 'Demo only: sending disabled'
                            : isPaying
                              ? "Sending..."
                              : !checkoutPayload.isTip && session.paymentsEnabled === false
                                ? (checkoutPayload.type === 'boost' ? 'Confirm Upvote' : 'Confirm Request')
                                : "Confirm Payment"}
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setCheckoutPayload(null);
                            setBoostingItem(null);
                            setPaymentConfirmationState(null);
                            setStripeConfigError(null);
                          }}
                          disabled={isPaying}
                          className="w-full py-2 hover:bg-slate-800 text-slate-400 hover:text-white rounded-xl text-xs font-bold transition-colors cursor-pointer"
                        >
                          Cancel
                        </button>
                      </>
                    )}
                  </div>

                </div>
              )}

            </motion.div>
          </div>
        )}
      </AnimatePresence>

    </div>
  );
}
