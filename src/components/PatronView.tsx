/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
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
  Flag,
  X
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { TrackReference, RequestItem, GigSession, PerformerProfile, PatronPaymentStatus, PatronRequestStatus, type LiveRoomType } from '../types';
import { getInitialNetworkStatus, subscribeToNetworkStatus } from '../native/swayNativeBridge';
import { sendBoostStarted, sendRequestStarted } from '../shells/frictionClient';
import { LIVE_ROOM_LANGUAGE } from '../live-room-language';

const PENDING_ACTION_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_ACTION_RETRIES = 3;
const PENDING_ACTION_EXPIRED_COPY = 'Network dropped. Your request expired before confirmation was completed.';
const CAPTIVE_PORTAL_BLOCK_COPY = 'Network sign-in required. Finish Wi-Fi sign-in or switch to cellular before sending a request.';
const PAYMENT_AUTHORIZATION_REQUIRED_COPY = 'Confirm payment to send this request.';
const PAYMENT_CONFIRMATION_WAITING_COPY = 'Keep this page open while Sway confirms the request status.';
const PAYMENT_AUTHORIZATION_DISCLOSURE_COPY = 'Sway will show Pending until the performer and payment outcome are confirmed.';
const LEGACY_PENDING_ACTION_INCOMPLETE_COPY = 'Sway found an older pending action, but this browser does not have the original submission details needed to resubmit it safely. Nothing has been shown as complete.';
const LEGACY_PENDING_ACTION_TERMINAL_COPY = 'The server has a record for an older action, but this browser cannot verify its result without the original submission details and receipt. Check the room before trying again; Sway has not shown it as successful.';
const PENDING_ACTION_STORAGE_VERSION = 2 as const;
export const LEGACY_PENDING_ACTION_STORAGE_KEY = 'sway.pendingAction';

type PendingActionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

type CanonicalRequestSubmission = {
  type: 'request' | 'tip';
  targetType: 'music' | 'custom' | 'straight_tip';
  menu_item_id: string | null;
  title: string;
  subtitle: string;
  senderName: string;
  message: string;
  amount: number;
  albumArt: string | null;
  sourceProvider: string | null;
  spotifyUri: string | null;
  spotifyUrl: string | null;
  client_request_id: string;
  idempotency_key: string;
  expires_at: string;
  gig_id: string;
  payment_intent_id: string | null;
};

type CanonicalBoostSubmission = {
  requestId: string;
  patronName: string;
  boostAmount: number;
  client_request_id: string;
  idempotency_key: string;
  expires_at: string;
  gig_id: string;
  payment_intent_id: string | null;
};

type PersistedPendingAction = {
  schemaVersion: typeof PENDING_ACTION_STORAGE_VERSION;
  type: 'request';
  endpoint: '/api/request/create';
  gigId: string;
  clientRequestId: string;
  idempotencyKey: string;
  expires_at: string;
  submission: CanonicalRequestSubmission;
} | {
  schemaVersion: typeof PENDING_ACTION_STORAGE_VERSION;
  type: 'boost';
  endpoint: '/api/request/boost';
  gigId: string;
  clientRequestId: string;
  idempotencyKey: string;
  expires_at: string;
  submission: CanonicalBoostSubmission;
};

type PendingActionIdentity = {
  type: 'request' | 'boost';
  gigId: string;
  clientRequestId: string;
  idempotencyKey: string;
  expires_at: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function pendingActionIdentity(value: unknown): PendingActionIdentity | null {
  if (!isRecord(value)) return null;
  if (
    (value.type !== 'request' && value.type !== 'boost')
    || typeof value.gigId !== 'string'
    || typeof value.clientRequestId !== 'string'
    || typeof value.idempotencyKey !== 'string'
  ) return null;

  return {
    type: value.type,
    gigId: value.gigId,
    clientRequestId: value.clientRequestId,
    idempotencyKey: value.idempotencyKey,
    expires_at: typeof value.expires_at === 'string' ? value.expires_at : null
  };
}

function isCompletePersistedPendingAction(value: unknown): value is PersistedPendingAction {
  const identity = pendingActionIdentity(value);
  if (!identity || !isRecord(value) || value.schemaVersion !== PENDING_ACTION_STORAGE_VERSION) return false;
  if (!isRecord(value.submission)) return false;

  const submission = value.submission;
  const commonMatches = submission.client_request_id === identity.clientRequestId
    && submission.idempotency_key === identity.idempotencyKey
    && submission.gig_id === identity.gigId
    && submission.expires_at === identity.expires_at
    && isNullableString(submission.payment_intent_id);
  if (!commonMatches) return false;

  if (identity.type === 'request') {
    return value.endpoint === '/api/request/create'
      && (submission.type === 'request' || submission.type === 'tip')
      && (submission.targetType === 'music' || submission.targetType === 'custom' || submission.targetType === 'straight_tip')
      && isNullableString(submission.menu_item_id)
      && typeof submission.title === 'string'
      && typeof submission.subtitle === 'string'
      && typeof submission.senderName === 'string'
      && typeof submission.message === 'string'
      && typeof submission.amount === 'number'
      && Number.isFinite(submission.amount)
      && isNullableString(submission.albumArt)
      && isNullableString(submission.sourceProvider)
      && isNullableString(submission.spotifyUri)
      && isNullableString(submission.spotifyUrl);
  }

  return value.endpoint === '/api/request/boost'
    && typeof submission.requestId === 'string'
    && typeof submission.patronName === 'string'
    && typeof submission.boostAmount === 'number'
    && Number.isFinite(submission.boostAmount);
}

function readPendingAction(storage: PendingActionStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writePendingAction(storage: PendingActionStorage, key: string, value: string): boolean {
  try {
    storage.setItem(key, value);
    return storage.getItem(key) === value;
  } catch {
    return false;
  }
}

function removePendingAction(storage: PendingActionStorage, key: string) {
  try {
    storage.removeItem(key);
  } catch {
    // Storage can be disabled or unavailable; the in-memory lock still prevents
    // this mounted client from claiming an unverified action as complete.
  }
}

export function pendingActionStorageKeyForRoom(gigId?: string) {
  return `sway.pendingAction:${gigId ?? 'missing-room'}`;
}

export function migrateLegacyPendingActionForRoom(
  storage: PendingActionStorage,
  gigId?: string
): string | null {
  try {
    const roomKey = pendingActionStorageKeyForRoom(gigId);
    const roomScopedAction = storage.getItem(roomKey);
    if (roomScopedAction !== null) return roomScopedAction;
    if (!gigId) return null;

    const legacyAction = storage.getItem(LEGACY_PENDING_ACTION_STORAGE_KEY);
    if (!legacyAction) return null;

    const parsed = JSON.parse(legacyAction) as {
      gigId?: unknown;
      clientRequestId?: unknown;
      idempotencyKey?: unknown;
    };
    if (
      parsed?.gigId !== gigId
      || typeof parsed.clientRequestId !== 'string'
      || !parsed.clientRequestId
      || typeof parsed.idempotencyKey !== 'string'
      || !parsed.idempotencyKey
    ) {
      return null;
    }

    storage.setItem(roomKey, legacyAction);
    if (storage.getItem(roomKey) !== legacyAction) return null;

    // The legacy key is removed only when the exact action was copied into its
    // matching room key. A legacy action for another room remains untouched.
    if (storage.getItem(LEGACY_PENDING_ACTION_STORAGE_KEY) === legacyAction) {
      storage.removeItem(LEGACY_PENDING_ACTION_STORAGE_KEY);
    }
    return legacyAction;
  } catch {
    return null;
  }
}

export type PatronRoomLanguage = {
  hostNoun: string;
  hostTitle: string;
  hostPluralTitle: string;
  requestMenuLabel: string;
  requestMenuBody: string;
  directoryHeading: string;
  directoryBody: string;
  directoryPlaceholder: string;
  directoryEmpty: string;
  activeHostLabel: string;
  roomLinkPrompt: string;
  queueApprovalCopy: string;
  directSupportDescription: string;
  tipNotePlaceholder: string;
};

const PATRON_ROOM_LANGUAGE: Record<LiveRoomType, PatronRoomLanguage> = {
  music: {
    hostNoun: 'performer',
    hostTitle: 'Performer',
    hostPluralTitle: 'Performers',
    requestMenuLabel: 'Host menu',
    requestMenuBody: '',
    directoryHeading: 'Browse Live Performers',
    directoryBody: 'Browse active performers and DJs, then jump into the live room link they are currently using.',
    directoryPlaceholder: 'Search by performer, role, or live room...',
    directoryEmpty: 'No performers found',
    activeHostLabel: 'ACTIVE PERFORMER',
    roomLinkPrompt: 'Ask the performer for a live room link.',
    queueApprovalCopy: 'Wait for performer approvals or submit your own request above.',
    directSupportDescription: 'A tip supporting the performer directly.',
    tipNotePlaceholder: 'e.g. Best dj set in years!! Keep it rocking.'
  },
  comedy: {
    hostNoun: 'comedian',
    hostTitle: 'Comedian',
    hostPluralTitle: 'Comedians',
    requestMenuLabel: 'Comedy request menu',
    requestMenuBody: 'Choose a host-defined prompt or type a respectful request. The comedian decides what enters the live queue.',
    directoryHeading: 'Browse Live Comedians',
    directoryBody: 'Browse active comedians and comedy hosts, then join the live room they are using.',
    directoryPlaceholder: 'Search by comedian, venue, or live room...',
    directoryEmpty: 'No comedians found',
    activeHostLabel: 'ACTIVE COMEDIAN',
    roomLinkPrompt: 'Ask the comedian or room host for a fresh live room link.',
    queueApprovalCopy: 'Wait for the comedian to approve requests or submit your own request above.',
    directSupportDescription: 'A tip supporting the comedian directly.',
    tipNotePlaceholder: 'e.g. That crowdwork made our night.'
  },
  service: {
    hostNoun: 'service professional',
    hostTitle: 'Service professional',
    hostPluralTitle: 'Service professionals',
    requestMenuLabel: 'Service request menu',
    requestMenuBody: 'Choose a host-defined service option or type a respectful request. The service professional decides what enters the live queue.',
    directoryHeading: 'Browse Live Service Professionals',
    directoryBody: 'Browse active service professionals, then join the live room they are using.',
    directoryPlaceholder: 'Search by service professional, venue, or live room...',
    directoryEmpty: 'No service professionals found',
    activeHostLabel: 'ACTIVE SERVICE PROFESSIONAL',
    roomLinkPrompt: 'Ask the service professional or room host for a fresh live room link.',
    queueApprovalCopy: 'Wait for the service professional to approve requests or submit your own request above.',
    directSupportDescription: 'A tip supporting the service professional directly.',
    tipNotePlaceholder: 'e.g. Thank you for taking great care of our group.'
  },
  general: {
    hostNoun: 'professional',
    hostTitle: 'Professional',
    hostPluralTitle: 'Professionals',
    requestMenuLabel: 'Professional request menu',
    requestMenuBody: 'Choose a host-defined option or type a respectful request. The professional decides what enters the live queue.',
    directoryHeading: 'Browse Live Professionals',
    directoryBody: 'Browse active professionals and hosts, then join the live room they are using.',
    directoryPlaceholder: 'Search by professional, role, or live room...',
    directoryEmpty: 'No professionals found',
    activeHostLabel: 'ACTIVE PROFESSIONAL',
    roomLinkPrompt: 'Ask the professional or room host for a fresh live room link.',
    queueApprovalCopy: 'Wait for the professional to approve requests or submit your own request above.',
    directSupportDescription: 'A tip supporting the professional directly.',
    tipNotePlaceholder: 'e.g. Thanks for making this event memorable.'
  }
};

export function patronRoomLanguageFor(roomType: LiveRoomType): PatronRoomLanguage {
  return PATRON_ROOM_LANGUAGE[roomType];
}

export function patronPaymentStatusLabel(status: PatronPaymentStatus) {
  switch (status) {
    case 'not_applicable': return 'No payment required';
    case 'processing': return 'Payment processing';
    case 'authorized': return 'Card hold confirmed';
    case 'captured': return 'Payment captured';
    case 'released': return 'Payment authorization released';
    case 'refund_pending': return 'Refund pending';
    case 'refunded': return 'Payment refunded';
    case 'failed': return 'Payment failed';
    case 'disputed': return 'Payment disputed';
    case 'paid_out': return 'Payment settled';
    default: return 'Payment status unavailable';
  }
}

export function resolvePausedRequestToast(tipsEnabled: boolean) {
  return tipsEnabled
    ? 'Requests are paused by the host. You can still send a Direct Tip.'
    : 'Requests are paused by the host. Try again when requests reopen.';
}

// Preview only -- mirrors the creator-direct tier (20% below $5, flat $1 at $5+).
// The server is authoritative: a Sway-promoted room's true fee is resolved there
// (campaign rate isn't known to the client), so this is just the common-case estimate.
function estimatePlatformFee(amountDollars: number): number {
  return amountDollars < 5 ? Math.round(amountDollars * 0.20 * 100) / 100 : 1.0;
}

interface PatronViewProps {
  session: GigSession;
  requests: RequestItem[];
  performers: PerformerProfile[];
  gigId?: string;
  patronRequestStatus?: PatronRequestStatus | null;
  patronActivity?: PatronRequestStatus[];
  onCreateRequest: (data: CanonicalRequestSubmission) => Promise<any>;
  onBoostRequest: (requestId: string, patronName: string, amount: number, clientRequestId?: string, idempotencyKey?: string, expiresAt?: string, gigId?: string, paymentIntentId?: string) => Promise<any>;
  onReconcilePendingAction: (clientRequestId: string, idempotencyKey: string, gigId: string) => Promise<any>;
  onReportContent: (requestId: string, reason: string, details?: string) => Promise<any>;
  onReportMenuItem?: (gigId: string, menuItemId: string, reason: string, details?: string) => Promise<any>;
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
  category?: 'sway_catalog' | 'external_request_music';
  spotifyUri?: string;
  spotifyUrl?: string;
  targetType?: 'music' | 'custom';
  menuItemId?: string;
};

type CheckoutPayload = {
  open: boolean;
  type: 'request' | 'boost';
  title: string;
  artist?: string;
  amount: number;
  fee: number;
  total: number;
  targetId?: string;
  trackArt?: string;
  targetType?: 'music' | 'custom' | 'straight_tip';
  menuItemId?: string;
  senderName: string;
  message: string;
  sourceProvider: string | null;
  spotifyUri: string | null;
  spotifyUrl: string | null;
  boostPatronName: string | null;
  clientRequestId: string;
  idempotencyKey: string;
  expires_at: string;
  gigId: string;
  isTip?: boolean;
  clientSecret?: string;
  paymentIntentId?: string;
};

type RequestMenuPreset = {
  id: string;
  label: string;
  subtitle: string;
  amount: number;
  targetType: 'music' | 'custom';
  menuItemId: string;
};

function HostMenuItemCard({
  preset,
  selected,
  density,
  isReporting,
  onSelect,
  onReport
}: {
  preset: RequestMenuPreset;
  selected: boolean;
  density: 'compact' | 'comfortable';
  isReporting: boolean;
  onSelect: () => void;
  onReport?: () => void;
}) {
  const isCompact = density === 'compact';
  return (
    <div
      className={`overflow-hidden rounded-xl border transition-colors ${
        selected
          ? 'border-fuchsia-400 bg-fuchsia-500/15'
          : 'border-white/10 bg-slate-950 hover:border-fuchsia-500/40'
      }`}
    >
      <button
        type="button"
        data-sway-select-menu-item={preset.id}
        aria-pressed={selected}
        onClick={onSelect}
        className={`min-h-11 w-full scroll-my-2 text-left cursor-pointer ${isCompact ? 'px-3 py-2' : 'p-4'}`}
      >
        <span className={`block font-bold text-white ${isCompact ? 'text-xs' : 'text-sm'}`}>{preset.label}</span>
        <span className={`mt-1 block text-slate-400 ${isCompact ? 'text-[10px]' : 'text-xs leading-5'}`}>{preset.subtitle}</span>
      </button>
      {onReport ? (
        <div className="border-t border-white/5 px-3 py-2">
          <button
            type="button"
            data-sway-report-menu-item={preset.id}
            aria-label={`Report menu item: ${preset.label}`}
            onClick={onReport}
            disabled={isReporting}
            className="inline-flex min-h-11 min-w-11 scroll-my-2 items-center gap-1.5 rounded-lg px-2 text-[10px] font-bold text-slate-400 transition-colors hover:bg-rose-500/10 hover:text-rose-200 disabled:cursor-wait disabled:opacity-60"
          >
            <Flag className="h-3 w-3" aria-hidden="true" />
            {isReporting ? 'Reporting…' : 'Report item'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

const REQUEST_ART_PLACEHOLDER = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22240%22 height=%22240%22 viewBox=%220 0 240 240%22%3E%3Crect width=%22240%22 height=%22240%22 fill=%22%230f172a%22/%3E%3Cpath d=%22M45 135h18V105H45zm33 28h18V77H78zm33-10h18V87h-18zm33 25h18V62h-18zm33-43h18v-30h-18z%22 fill=%22%23d946ef%22/%3E%3C/svg%3E';
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
  onCancel,
  cancelRef,
  onAuthorizationStateChange
}: {
  disabled: boolean;
  onAuthorized: (paymentIntentId: string) => Promise<void>;
  onError: (message: string) => void;
  onCancel: () => void;
  cancelRef?: React.Ref<HTMLButtonElement>;
  onAuthorizationStateChange: (isAuthorizing: boolean) => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [localMessage, setLocalMessage] = useState<string | null>(null);
  const [isAuthorizing, setIsAuthorizing] = useState(false);

  const handleAuthorize = async () => {
    if (!stripe || !elements || disabled || isAuthorizing) return;
    setIsAuthorizing(true);
    onAuthorizationStateChange(true);
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
      onAuthorizationStateChange(false);
    }
  };

  return (
    <div data-sway-payment-form-body="true" className="space-y-3 text-left">
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
        ref={cancelRef}
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
  patronRequestStatus = null,
  patronActivity = [],
  onCreateRequest,
  onBoostRequest,
  onReconcilePendingAction,
  onReportContent,
  onReportMenuItem,
  onBlockFoundation,
  onSupportContact,
  onDataDeletionPlaceholder,
  previewMode = false
}: PatronViewProps) {
  const pendingActionStorageKey = pendingActionStorageKeyForRoom(gigId);
  const roomLanguage = patronRoomLanguageFor(session.roomType);
  const isMusicRoom = session.roomType === 'music';
  const paymentAuthorizationDisclosureCopy = isMusicRoom
    ? PAYMENT_AUTHORIZATION_DISCLOSURE_COPY
    : 'Sway will show Pending until the request outcome is confirmed.';
  const incompleteRoomCopy = `This room link is incomplete. ${roomLanguage.roomLinkPrompt}`;
  const requestPresets = useMemo<RequestMenuPreset[]>(() => session.requestMenu.map((item) => ({
    id: item.id,
    label: item.title,
    subtitle: item.description,
    amount: session.paymentsEnabled === false ? 0 : session.minimumTip,
    targetType: item.targetType,
    menuItemId: item.id
  })), [session.minimumTip, session.paymentsEnabled, session.requestMenu]);
  const reconcilePendingActionRef = useRef(onReconcilePendingAction);
  const createRequestRef = useRef(onCreateRequest);
  const boostRequestRef = useRef(onBoostRequest);

  useEffect(() => {
    reconcilePendingActionRef.current = onReconcilePendingAction;
    createRequestRef.current = onCreateRequest;
    boostRequestRef.current = onBoostRequest;
  }, [onBoostRequest, onCreateRequest, onReconcilePendingAction]);

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
  const [checkoutPayload, setCheckoutPayload] = useState<CheckoutPayload | null>(null);

  const [backendConfirmed, setBackendConfirmed] = useState(false);
  const [isPaying, setIsPaying] = useState(false);
  const [isStripeAuthorizing, setIsStripeAuthorizing] = useState(false);
  const [paymentConfirmationState, setPaymentConfirmationState] = useState<PaymentConfirmationState | null>(null);
  const [stripePublishableKey, setStripePublishableKey] = useState<string | null>(null);
  const [stripePaymentMode, setStripePaymentMode] = useState<'test' | 'live' | null>(null);
  const [stripeConfigError, setStripeConfigError] = useState<string | null>(null);
  const [degraded, setDegraded] = useState(() => !getInitialNetworkStatus().connected);
  const [pendingAction, setPendingAction] = useState<string | null>(() => readPendingAction(localStorage, pendingActionStorageKey));
  const [pendingActionMessage, setPendingActionMessage] = useState('');
  const [networkPreflightStatus, setNetworkPreflightStatus] = useState<'unknown' | 'ready' | 'blocked'>('unknown');
  const [formToast, setFormToast] = useState<string | null>(null);
  const [reportingMenuItemId, setReportingMenuItemId] = useState<string | null>(null);
  const formToastTimeoutRef = useRef<number | null>(null);
  const checkoutDialogRef = useRef<HTMLDivElement | null>(null);
  const checkoutCancelRef = useRef<HTMLButtonElement | null>(null);
  const checkoutTriggerRef = useRef<HTMLElement | null>(null);
  const checkoutWasOpenRef = useRef(false);
  const checkoutSuccessTimeoutRef = useRef<number | null>(null);
  const stripeAuthorizationInFlightRef = useRef(false);
  const checkoutPayloadRef = useRef(checkoutPayload);
  checkoutPayloadRef.current = checkoutPayload;
  const showFormToast = (message: string) => {
    setFormToast(message);
    if (formToastTimeoutRef.current) window.clearTimeout(formToastTimeoutRef.current);
    formToastTimeoutRef.current = window.setTimeout(() => setFormToast(null), 4000);
  };
  const isPaymentConfirmationPending = paymentConfirmationState?.phase === 'PAYMENT_PENDING_CONFIRMATION';
  const isDurableActionPending = Boolean(pendingAction);
  const isSubmitLocked = isPaying || isStripeAuthorizing || isPaymentConfirmationPending || isDurableActionPending;
  const stripePromise = useMemo(() => stripePublishableKey ? loadStripe(stripePublishableKey) : null, [stripePublishableKey]);
  const stripeElementsOptions = useMemo(() => checkoutPayload?.clientSecret
    ? {
        clientSecret: checkoutPayload.clientSecret,
        appearance: { theme: 'night' as const }
      }
    : null, [checkoutPayload?.clientSecret]);

  const closeCheckout = useCallback((expectedClientRequestId?: string) => {
    if (stripeAuthorizationInFlightRef.current) return;
    if (expectedClientRequestId && checkoutPayloadRef.current?.clientRequestId !== expectedClientRequestId) return;
    const trigger = checkoutTriggerRef.current;
    if (checkoutSuccessTimeoutRef.current !== null) {
      window.clearTimeout(checkoutSuccessTimeoutRef.current);
      checkoutSuccessTimeoutRef.current = null;
    }
    setCheckoutPayload(null);
    setBackendConfirmed(false);
    setIsStripeAuthorizing(false);
    setBoostingItem(null);
    setPaymentConfirmationState(null);
    setStripeConfigError(null);
    window.requestAnimationFrame(() => trigger?.focus());
  }, []);

  const setStripeAuthorizationState = useCallback((next: boolean) => {
    stripeAuthorizationInFlightRef.current = next;
    setIsStripeAuthorizing(next);
  }, []);

  useEffect(() => () => {
    if (checkoutSuccessTimeoutRef.current !== null) {
      window.clearTimeout(checkoutSuccessTimeoutRef.current);
    }
  }, []);

  useEffect(() => {
    if (!checkoutPayload) {
      checkoutWasOpenRef.current = false;
      return;
    }

    if (!checkoutWasOpenRef.current) {
      checkoutTriggerRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      checkoutWasOpenRef.current = true;
    }

    const focusFrame = window.requestAnimationFrame(() => {
      const initialFocus = checkoutCancelRef.current ?? checkoutDialogRef.current;
      initialFocus?.focus();
    });

    return () => window.cancelAnimationFrame(focusFrame);
  }, [checkoutPayload?.clientRequestId, checkoutPayload?.clientSecret]);

  useEffect(() => {
    if (!checkoutPayload) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isPaying || isStripeAuthorizing || isDurableActionPending) return;
      event.preventDefault();
      closeCheckout();
    };

    document.addEventListener('keydown', handleEscape, true);
    return () => document.removeEventListener('keydown', handleEscape, true);
  }, [checkoutPayload?.clientRequestId, closeCheckout, isDurableActionPending, isPaying, isStripeAuthorizing]);

  const handleCheckoutDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;

    const candidates = event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])'
    );
    const focusable: HTMLElement[] = [];
    candidates.forEach((element) => {
      if (element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true') {
        focusable.push(element);
      }
    });

    if (focusable.length === 0) {
      event.preventDefault();
      checkoutDialogRef.current?.focus();
      return;
    }

    const interactive = focusable.filter((element) => (
      element.dataset.swayPaymentFocusStart !== 'true'
      && element.dataset.swayPaymentFocusEnd !== 'true'
    ));
    const first = interactive[0] ?? focusable[0];
    const last = interactive[interactive.length - 1] ?? focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const focusCheckoutFirst = () => {
    const first = checkoutDialogRef.current?.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe'
    );
    (first ?? checkoutDialogRef.current)?.focus();
  };

  const createPersistedPendingAction = (
    payload: CheckoutPayload,
    paymentIntentId = payload.paymentIntentId ?? null
  ): PersistedPendingAction | null => {
    if (payload.type === 'request') {
      const submission: CanonicalRequestSubmission = {
        type: payload.isTip ? 'tip' : 'request',
        targetType: payload.isTip
          ? 'straight_tip'
          : (payload.targetType ?? (isMusicRoom ? 'music' : 'custom')),
        menu_item_id: payload.isTip ? null : (payload.menuItemId ?? null),
        title: payload.title,
        subtitle: payload.artist ?? '',
        senderName: payload.senderName,
        message: payload.message,
        amount: payload.amount,
        albumArt: payload.trackArt ?? null,
        sourceProvider: payload.sourceProvider,
        spotifyUri: payload.spotifyUri,
        spotifyUrl: payload.spotifyUrl,
        client_request_id: payload.clientRequestId,
        idempotency_key: payload.idempotencyKey,
        expires_at: payload.expires_at,
        gig_id: payload.gigId,
        payment_intent_id: paymentIntentId
      };
      return {
        schemaVersion: PENDING_ACTION_STORAGE_VERSION,
        type: 'request',
        endpoint: '/api/request/create',
        gigId: payload.gigId,
        clientRequestId: payload.clientRequestId,
        idempotencyKey: payload.idempotencyKey,
        expires_at: payload.expires_at,
        submission
      };
    }

    if (!payload.targetId || payload.boostPatronName === null) return null;
    const submission: CanonicalBoostSubmission = {
      requestId: payload.targetId,
      patronName: payload.boostPatronName,
      boostAmount: payload.amount,
      client_request_id: payload.clientRequestId,
      idempotency_key: payload.idempotencyKey,
      expires_at: payload.expires_at,
      gig_id: payload.gigId,
      payment_intent_id: paymentIntentId
    };
    return {
      schemaVersion: PENDING_ACTION_STORAGE_VERSION,
      type: 'boost',
      endpoint: '/api/request/boost',
      gigId: payload.gigId,
      clientRequestId: payload.clientRequestId,
      idempotencyKey: payload.idempotencyKey,
      expires_at: payload.expires_at,
      submission
    };
  };

  const resubmitPersistedPendingAction = async (action: PersistedPendingAction) => {
    if (action.endpoint === '/api/request/create') {
      return createRequestRef.current(action.submission);
    }

    const submission = action.submission;
    return boostRequestRef.current(
      submission.requestId,
      submission.patronName,
      submission.boostAmount,
      submission.client_request_id,
      submission.idempotency_key,
      submission.expires_at,
      submission.gig_id,
      submission.payment_intent_id ?? undefined
    );
  };

  const completeCheckoutSuccess = (
    completedActionType: 'request' | 'boost',
    completedClientRequestId = checkoutPayload?.clientRequestId
  ) => {
    if (!completedClientRequestId) return;
    const matchingCheckoutIsOpen = checkoutPayloadRef.current?.clientRequestId === completedClientRequestId;
    setBackendConfirmed(matchingCheckoutIsOpen);
    setPaymentConfirmationState(null);
    setStripeConfigError(null);
    setDegraded(false);
    setPendingAction(null);
    setPendingActionMessage('');
    removePendingAction(localStorage, pendingActionStorageKey);
    if (!matchingCheckoutIsOpen) {
      setSelectedTrack(null);
      setCommentMessage('');
      setSenderName('');
      setBoostPatronName('');
      setTipAmount(session.minimumTip);
      setActiveTab(completedActionType === 'boost' ? 'queue' : 'request');
      return;
    }
    window.requestAnimationFrame(() => checkoutDialogRef.current?.focus());
    if (checkoutSuccessTimeoutRef.current !== null) {
      window.clearTimeout(checkoutSuccessTimeoutRef.current);
    }
    checkoutSuccessTimeoutRef.current = window.setTimeout(() => {
      checkoutSuccessTimeoutRef.current = null;
      if (checkoutPayloadRef.current?.clientRequestId !== completedClientRequestId) return;
      closeCheckout(completedClientRequestId);
      setSelectedTrack(null);
      setCommentMessage('');
      setSenderName('');
      setBoostPatronName('');
      setTipAmount(session.minimumTip);
      setActiveTab(completedActionType === 'boost' ? 'queue' : 'request');
    }, 2000);
  };

  // A personalized status is rendered only when the browser holds the opaque
  // receipt returned for its own submission. Public queue order is never used
  // as a proxy for patron ownership.
  const latestRequestStatusMessage: { text: string; tone: 'fuchsia' | 'cyan' | 'slate' | 'rose' } | null = (() => {
    if (session.status === 'closed') return { text: `${LIVE_ROOM_LANGUAGE.ended}: this room is no longer accepting requests.`, tone: 'slate' };
    if (!session.requestsOpen || session.status === 'ending') return { text: `Requests are ${LIVE_ROOM_LANGUAGE.paused.toLowerCase()} right now.`, tone: 'slate' };
    if (degraded || pendingAction) return { text: 'Syncing your last action...', tone: 'cyan' };
    if (!patronRequestStatus) return null;
    if (patronRequestStatus.paymentStatus === 'refunded') {
      return { text: 'Your payment was refunded. This action is no longer fulfilled.', tone: 'slate' };
    }
    if (patronRequestStatus.paymentStatus === 'refund_pending') {
      return { text: 'Your refund is pending provider confirmation.', tone: 'slate' };
    }
    if (patronRequestStatus.paymentStatus === 'released') {
      return { text: 'Your payment authorization was released. This action was not charged.', tone: 'slate' };
    }
    if (patronRequestStatus.paymentStatus === 'failed') {
      return { text: 'Payment failed, so this action was not completed.', tone: 'rose' };
    }
    if (patronRequestStatus.status === 'unavailable') {
      return { text: 'Your last action is no longer available in this room.', tone: 'slate' };
    }
    if (patronRequestStatus.actionType === 'tip') {
      if (patronRequestStatus.status === 'fulfilled') return { text: 'Your tip submission was received.', tone: 'cyan' };
      if (patronRequestStatus.status === 'denied') return { text: "Your tip wasn't completed.", tone: 'rose' };
      return { text: 'Your tip submission is pending confirmation.', tone: 'fuchsia' };
    }
    if (patronRequestStatus.actionType === 'boost') {
      return { text: `Your boost for ${patronRequestStatus.title} is confirmed.`, tone: 'cyan' };
    }
    if (patronRequestStatus.status === 'fulfilled') return { text: 'Your last request was played!', tone: 'cyan' };
    if (patronRequestStatus.status === 'approved') return { text: 'Your last request was approved and is in the queue.', tone: 'fuchsia' };
    if (patronRequestStatus.status === 'denied') return { text: "Your last request wasn't approved this time.", tone: 'rose' };
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
    const roomScopedAction = migrateLegacyPendingActionForRoom(localStorage, gigId);
    setPendingAction(roomScopedAction);
    setPendingActionMessage('');
  }, [gigId, pendingActionStorageKey]);

  useEffect(() => {
    const storedPendingAction = readPendingAction(localStorage, pendingActionStorageKey);
    if (!storedPendingAction) return;
    let cancelled = false;
    let retryTimer: number | null = null;

    try {
      const parsed: unknown = JSON.parse(storedPendingAction);
      const identity = pendingActionIdentity(parsed);
      if (!identity || identity.gigId !== gigId) {
        removePendingAction(localStorage, pendingActionStorageKey);
        setPendingAction(null);
        setDegraded(true);
        setPendingActionMessage('Sway could not safely match the saved action to this room. Nothing was shown as complete.');
        return;
      }

      const expiresAtMs = identity.expires_at ? new Date(identity.expires_at).getTime() : Number.NaN;
      if (!Number.isFinite(expiresAtMs)) {
        removePendingAction(localStorage, pendingActionStorageKey);
        setPendingAction(null);
        setDegraded(true);
        setPendingActionMessage(LEGACY_PENDING_ACTION_INCOMPLETE_COPY);
        return;
      }
      if (Date.now() > expiresAtMs) {
        removePendingAction(localStorage, pendingActionStorageKey);
        setPendingAction(null);
        setPendingActionMessage(PENDING_ACTION_EXPIRED_COPY);
        return;
      }

      const persistedAction = isCompletePersistedPendingAction(parsed) ? parsed : null;
      setDegraded(true);
      setPendingAction(storedPendingAction);
      setPendingActionMessage(
        persistedAction
          ? 'Reconnecting to verify and safely resubmit your pending action.'
          : LEGACY_PENDING_ACTION_INCOMPLETE_COPY
      );

      const reconcile = async () => {
        if (cancelled) return;
        if (Date.now() > expiresAtMs) {
          removePendingAction(localStorage, pendingActionStorageKey);
          setPendingAction(null);
          setPendingActionMessage(PENDING_ACTION_EXPIRED_COPY);
          return;
        }
        try {
          const result = await reconcilePendingActionRef.current(
            identity.clientRequestId,
            identity.idempotencyKey,
            identity.gigId
          );
          if (cancelled) return;

          if (result?.recovery !== 'resubmit_original_action') {
            setDegraded(true);
            setPendingActionMessage('Sway could not verify a safe recovery route yet. Nothing was shown as complete.');
          } else if (!persistedAction) {
            if (result?.status === 'pending' || result?.status === 'retrying') {
              setPendingActionMessage(`${LEGACY_PENDING_ACTION_INCOMPLETE_COPY} The server still reports it as pending.`);
            } else {
              removePendingAction(localStorage, pendingActionStorageKey);
              setPendingAction(null);
              setPendingActionMessage(
                result?.status === 'reconciled'
                  ? LEGACY_PENDING_ACTION_TERMINAL_COPY
                  : LEGACY_PENDING_ACTION_INCOMPLETE_COPY
              );
              return;
            }
          } else {
            setPendingActionMessage('Server status checked. Resubmitting the original action for full verification.');
            const response = await resubmitPersistedPendingAction(persistedAction);
            if (cancelled) return;
            if (response?.success || response?.reconciled) {
              window.dispatchEvent(new Event('re-fetch-state'));
              completeCheckoutSuccess(persistedAction.type, persistedAction.clientRequestId);
              return;
            }
            if (response?.pending) {
              setPendingActionMessage('The original action was resubmitted and is still awaiting backend confirmation.');
            } else {
              setPendingActionMessage('The original action was resubmitted, but the server has not confirmed a final result.');
            }
          }
        } catch (error: any) {
          if (cancelled) return;
          setDegraded(true);
          const status = error?.status;
          const backendMessage = error?.body?.error;
          if (error?.body?.terminal === true && error?.body?.pending === false) {
            removePendingAction(localStorage, pendingActionStorageKey);
            setPendingAction(null);
            setPaymentConfirmationState(null);
            setCheckoutPayload(null);
            setPendingActionMessage(backendMessage || 'The action did not complete, and its payment was safely released.');
            return;
          }
          if (status === 410) {
            removePendingAction(localStorage, pendingActionStorageKey);
            setPendingAction(null);
            setPendingActionMessage(PENDING_ACTION_EXPIRED_COPY);
            return;
          }
          if (status === 402 && error?.body?.payment_status === 'requires_confirmation') {
            removePendingAction(localStorage, pendingActionStorageKey);
            setPendingAction(null);
            setPaymentConfirmationState(null);
            setPendingActionMessage('Payment authorization is still required. This recovered action was not shown as complete; reopen it from the room to continue.');
            return;
          }
          if ([400, 403, 409, 422, 429].includes(status)) {
            removePendingAction(localStorage, pendingActionStorageKey);
            setPendingAction(null);
            setPaymentConfirmationState(null);
            setPendingActionMessage(`${backendMessage || 'The recovered action could not be verified.'} Nothing was shown as complete.`);
            return;
          }
          setPendingActionMessage('Connection degraded. Sway will retry status verification and the original action when the network is available.');
        }
        if (!cancelled) retryTimer = window.setTimeout(reconcile, 2000);
      };
      void reconcile();
    } catch {
      removePendingAction(localStorage, pendingActionStorageKey);
      setPendingAction(null);
      setDegraded(true);
      setPendingActionMessage('Sway could not read the saved action safely. Nothing was shown as complete.');
    }

    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [gigId, pendingAction, pendingActionStorageKey]);

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

  const ensureStripePublishableKey = async () => {
    if (stripePublishableKey) return stripePublishableKey;
    setStripeConfigError(null);
    const response = await fetch('/api/payment/config', { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    const publishableKeyOk = typeof data.publishableKey === 'string'
      && (
        (data?.mode === 'test' && data.publishableKey.startsWith('pk_test_'))
        || (data?.mode === 'live' && data.publishableKey.startsWith('pk_live_'))
      );
    if (
      !response.ok
      || (data?.mode !== 'test' && data?.mode !== 'live')
      || data?.liveRoomMoneyEnabled !== true
      || !publishableKeyOk
    ) {
      throw new Error(data?.error || 'Payment form is not configured.');
    }
    setStripePublishableKey(data.publishableKey);
    setStripePaymentMode(data.mode === 'live' ? 'live' : 'test');
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
        if (response?.pending) {
          throw Object.assign(new Error('The backend is still reconciling this action.'), {
            status: 202,
            body: response
          });
        }
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
        title: firstPreset.label,
        artist: firstPreset.subtitle,
        description: firstPreset.subtitle,
        albumArt: firstPreset.targetType === 'music' ? REQUEST_ART_PLACEHOLDER : undefined,
        basePrice: firstPreset.amount,
        targetType: firstPreset.targetType,
        menuItemId: firstPreset.menuItemId,
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

    if (previewMode && session.roomType === 'music') {
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
    const openSongOption: SearchTrack | null = (session.roomType === 'music' && trimmed)
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

  const renderSearchResult = (song: SearchTrack) => (
    <button key={song.id} type="button" onClick={() => handleSelectTrack(song)} className="w-full p-2.5 bg-slate-900/40 hover:bg-slate-900 border border-white/5 hover:border-white/10 rounded-lg flex items-center gap-3 text-left transition-colors cursor-pointer">
      <img src={song.albumArt} alt={`${song.title} album art`} referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.src = REQUEST_ART_PLACEHOLDER; }} className="w-10 h-10 rounded shrink-0 object-cover border border-white/5" />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-bold text-white truncate">{song.title}</div>
        <p className="text-[10px] text-slate-400 truncate mt-0.5">{song.artist}</p>
        {song.source ? <p className="text-[9px] text-fuchsia-300 mt-1 font-bold uppercase tracking-wider">{song.source}</p> : null}
        {song.description ? <p className="text-[9px] text-cyan-400 italic font-mono mt-1 line-clamp-1">{song.description}</p> : null}
      </div>
    </button>
  );

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
      setDegraded(true);
      setPendingActionMessage(incompleteRoomCopy);
      return;
    }

    if (type === 'request' && activeTab === 'request' && !session.requestsOpen) {
      showFormToast(resolvePausedRequestToast(session.tipsEnabled));
      return;
    }

    let title = '';
    let artist = '';
    let trackArt = '';
    let amt = 0;
    let resolvedBoostPatronName: string | null = null;

    const paymentsEnabledForRoom = session.paymentsEnabled !== false;

    if (type === 'request') {
      if (!senderName) {
        showFormToast(isMusicRoom
          ? 'Please enter a Patron Name so the Performer knows who tipped!'
          : `Please enter your name so the ${roomLanguage.hostNoun} knows who sent the request.`);
        return;
      }
      if (paymentsEnabledForRoom && tipAmount < session.minimumTip) {
        showFormToast(`Minimum tip required is $${session.minimumTip}`);
        return;
      }

      if (session.roomType === 'music') {
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
        artist = selectedTrack.description ?? selectedTrack.artist;
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
      resolvedBoostPatronName = boostPatronName || senderName;
      if (paymentsEnabledForRoom && targetBoostAmount < session.minimumTip) {
        showFormToast(`Minimum boost is $${session.minimumTip}`);
        return;
      }
      title = targetItem.title;
      artist = targetItem.subtitle;
      amt = paymentsEnabledForRoom ? targetBoostAmount : 1;
    }

    const platformFee = paymentsEnabledForRoom && session.feeType === 'patron' ? estimatePlatformFee(amt) : 0;
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
      targetType: type === 'request'
        ? (selectedTrack?.targetType ?? (isMusicRoom ? 'music' : 'custom'))
        : undefined,
      menuItemId: type === 'request' ? selectedTrack?.menuItemId : undefined,
      senderName: type === 'request' ? senderName : '',
      message: type === 'request' ? commentMessage : '',
      sourceProvider: type === 'request' ? (selectedTrack?.sourceProvider ?? null) : null,
      spotifyUri: type === 'request' ? (selectedTrack?.spotifyUri ?? null) : null,
      spotifyUrl: type === 'request' ? (selectedTrack?.spotifyUrl ?? null) : null,
      boostPatronName: type === 'boost' ? resolvedBoostPatronName : null,
      gigId,
      ...createClientActionIds()
    });
  };

  const submitCheckoutPayload = async (action: PersistedPendingAction) => {
    await submitWithBoundedRetry(
      () => resubmitPersistedPendingAction(action),
      action.expires_at
    );
  };

  const handleCheckoutError = async (e: unknown) => {
    console.error(e);
    const status = (e as any)?.status;
    const body = (e as any)?.body;
    const backendMessage = body?.error;
    const paymentStatus = body?.payment_status;

    if (status === 202 || body?.pending) {
      setDegraded(true);
      setPendingActionMessage(
        paymentStatus === 'reversal_pending'
          ? 'Your payment release is still being confirmed. Sway will keep checking safely.'
          : 'Sway is still confirming this action. It has not been shown as complete yet.'
      );
      return;
    }

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
      removePendingAction(localStorage, pendingActionStorageKey);

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
      removePendingAction(localStorage, pendingActionStorageKey);
    } else if (status === 403) {
      setDegraded(true);
      setPaymentConfirmationState(null);
      setPendingActionMessage(backendMessage || `Request blocked for this session. Try a different option or ask the ${roomLanguage.hostNoun} for help.`);
      setPendingAction(null);
      setCheckoutPayload(null);
      removePendingAction(localStorage, pendingActionStorageKey);
    } else if (status === 429) {
      setDegraded(true);
      setPaymentConfirmationState(null);
      setPendingActionMessage(backendMessage || "You've reached the request limit for this session. Try again later as the queue moves.");
      setPendingAction(null);
      setCheckoutPayload(null);
      removePendingAction(localStorage, pendingActionStorageKey);
    } else if (status === 409 || status === 400) {
      setDegraded(true);
      setPaymentConfirmationState(null);
      setPendingActionMessage(backendMessage || 'This action is not available right now.');
      setPendingAction(null);
      setCheckoutPayload(null);
      removePendingAction(localStorage, pendingActionStorageKey);
    } else if (typeof status === 'number') {
      // A real backend/payment failure (e.g. a 5xx), not a network drop -- don't
      // claim the action was "saved locally", tell the patron it actually failed.
      setDegraded(true);
      setPaymentConfirmationState(null);
      setPendingActionMessage(backendMessage || 'Something went wrong processing that. Please try again.');
      setPendingAction(null);
      setCheckoutPayload(null);
      removePendingAction(localStorage, pendingActionStorageKey);
    } else {
      setDegraded(true);
    }
  };

  const beginPendingSubmit = (
    payload = checkoutPayload,
    paymentIntentId = payload?.paymentIntentId ?? null
  ): PersistedPendingAction | null => {
    if (!payload) return null;
    const action = createPersistedPendingAction(payload, paymentIntentId);
    if (!action) return null;
    const serializedPendingAction = JSON.stringify(action);
    if (!writePendingAction(localStorage, pendingActionStorageKey, serializedPendingAction)) {
      setDegraded(true);
      setPendingActionMessage('Sway could not save the crash-recovery record in this browser, so the action was not sent.');
      return null;
    }
    setPendingAction(serializedPendingAction);
    return action;
  };

  // Create the pending PaymentIntent or complete a no-payment action.
  const completePayment = async () => {
    if (!checkoutPayload || isSubmitLocked) return;

    if (checkoutPayload.type === 'boost' && !checkoutPayload.boostPatronName?.trim()) {
      showFormToast('Enter your name above to send this boost.');
      return;
    }

    if (Date.now() > new Date(checkoutPayload.expires_at).getTime()) {
      setCheckoutPayload(null);
      setPendingAction(null);
      setPendingActionMessage(PENDING_ACTION_EXPIRED_COPY);
      removePendingAction(localStorage, pendingActionStorageKey);
      return;
    }

    setIsPaying(true);
    const pendingSubmission = beginPendingSubmit();
    if (!pendingSubmission) {
      setIsPaying(false);
      return;
    }

    try {
      await submitCheckoutPayload(pendingSubmission);
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
    const pendingSubmission = beginPendingSubmit(payloadWithIntent, paymentIntentId);
    if (!pendingSubmission) {
      setIsPaying(false);
      return;
    }

    try {
      await submitCheckoutPayload(pendingSubmission);
      completeCheckoutSuccess(checkoutPayload.type);
    } catch (e) {
      await handleCheckoutError(e);
    } finally {
      setIsPaying(false);
    }
  };

  // Direct tipping logic bypass
  const handleStraightTipSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!session.tipsEnabled) {
      showFormToast(`Tips are unavailable until this ${roomLanguage.hostNoun} completes payout setup.`);
      return;
    }
    if (isSubmitLocked) return;

    if (networkPreflightStatus !== 'ready') {
      setDegraded(true);
      setPendingActionMessage(CAPTIVE_PORTAL_BLOCK_COPY);
      alert(CAPTIVE_PORTAL_BLOCK_COPY);
      return;
    }

    if (!gigId) {
      setDegraded(true);
      setPendingActionMessage(incompleteRoomCopy);
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

    const platformFee = session.feeType === 'patron' ? estimatePlatformFee(tipAmount) : 0;
    sendRequestStarted(funnelTelemetryPayload);
    setPaymentConfirmationState(null);
    setCheckoutPayload({
      open: true,
      type: 'request',
      isTip: true,
      title: LIVE_ROOM_LANGUAGE.directTip,
      artist: roomLanguage.directSupportDescription,
      amount: tipAmount,
      fee: platformFee,
      total: tipAmount + platformFee,
      targetType: 'straight_tip',
      senderName,
      message: commentMessage,
      sourceProvider: null,
      spotifyUri: null,
      spotifyUrl: null,
      boostPatronName: null,
      gigId,
      ...createClientActionIds()
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
    if (!isMusicRoom) {
      return {
        label: roomLanguage.requestMenuLabel,
        body: roomLanguage.requestMenuBody
      };
    }
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
  const checkoutSummaryLabel = checkoutPayload?.type === 'boost' && !isMusicRoom
    ? 'UPVOTE SUMMARY'
    : (checkoutCopy?.summaryLabel ?? 'REQUEST SUMMARY');

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

  const reportHostMenuItem = async (preset: RequestMenuPreset) => {
    if (!onReportMenuItem) {
      showFormToast('Menu-item reporting is unavailable in this room.');
      return;
    }
    if (!gigId) {
      showFormToast(incompleteRoomCopy);
      return;
    }
    if (reportingMenuItemId) return;

    setReportingMenuItemId(preset.menuItemId);
    try {
      await onReportMenuItem(
        gigId,
        preset.menuItemId,
        'Host menu item safety report',
        'Patron requested safety review of a host-authored room menu item.'
      );
      showFormToast('Menu item report sent to the safety team.');
    } catch (error) {
      console.error(error);
      showFormToast('Menu item report failed. Try again in a few moments.');
    } finally {
      setReportingMenuItemId(null);
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

      {/* 1. Live room snapshot */}
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
          <p className="text-[10px] font-mono uppercase tracking-[0.28em] text-cyan-300">
            {isMusicRoom ? 'Live show snapshot' : 'Live room snapshot'}
          </p>
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
                : !isMusicRoom
                  ? `Send a free request or upvote an approved queue item. The ${roomLanguage.hostNoun} decides what enters the live queue. Money actions are off for this room.`
                : session.paymentsEnabled === false
                  ? session.tipsEnabled
                    ? `Send a free request, upvote an approved queue item, or tip ${session.talentName || 'this performer'}. Requests and boosts are free for this event.`
                    : 'Send a free request or upvote an approved queue item. Money actions are off for this room.'
                  : isCrowdAutopilot
                    ? `Request songs or actions, send a direct tip, or boost the crowd-ranked queue for ${session.talentName || 'this performer'}. Clean requests can move into up next automatically.`
                    : `Request songs or actions, send a direct tip, or boost an approved queue item for ${session.talentName || 'this performer'}. Confirm payment to send your action for performer approval.`}
            </p>
            <div className={`grid w-full max-w-md gap-2 pt-2 ${session.tipsEnabled ? 'grid-cols-2' : 'grid-cols-1'}`}>
              {session.tipsEnabled ? <button
                type="button"
                onClick={() => {
                  setActiveTab('tip');
                  setSelectedTrack({ title: LIVE_ROOM_LANGUAGE.directTip, description: roomLanguage.directSupportDescription, basePrice: session.minimumTip });
                }}
                className="min-h-14 rounded-xl border border-emerald-500/30 bg-emerald-500 px-2 py-3 text-center text-xs font-black uppercase tracking-wide text-slate-950 shadow-lg transition-all active:scale-[0.99] min-[360px]:px-4 min-[360px]:text-sm"
              >
                <span className="inline-flex items-center justify-center gap-1 min-[360px]:gap-2"><Coins className="h-4 w-4" /> Tip</span>
              </button> : null}
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
                  <p className="text-[9px] font-mono uppercase tracking-widest text-cyan-300">{LIVE_ROOM_LANGUAGE.requestSource}</p>
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
                {nowPlaying ? (isMusicRoom ? 'Now Playing' : 'In Progress') : 'Live Now'}
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
                      {isMusicRoom
                        ? <Music className="w-5 h-5 text-cyan-300" />
                        : <Layers className="w-5 h-5 text-cyan-300" />}
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
            <div className="font-bold">Live Room Locked</div>
            <p className="mt-0.5 text-slate-400 leading-relaxed font-sans">
              {isMusicRoom
                ? 'New song checks and item submissions have been locked. Holds are being auto-released inside the final 5-minute safety sweep.'
                : 'New requests are locked while the host finishes this room and resolves pending request outcomes.'}
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
              () => onBlockFoundation('patron_device_id_hash', '', 'Patron requested a safety block.'),
              'Block request sent for safety review.'
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
            {session.roomType === 'music' ? <Music className="w-4 h-4" /> : <Layers className="w-4 h-4" />}
            Request
          </button>

          {session.tipsEnabled ? <button
            onClick={() => { setActiveTab('tip'); setSelectedTrack({ title: LIVE_ROOM_LANGUAGE.directTip, description: roomLanguage.directSupportDescription, basePrice: session.minimumTip }); }}
            className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
              activeTab === 'tip'
                ? 'bg-fuchsia-600 text-white shadow-lg glow-fuchsia'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Coins className="w-4 h-4" /> Tip
          </button> : null}

          <button
            onClick={() => setActiveTab('queue')}
            className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
              activeTab === 'queue'
                ? 'bg-fuchsia-600 text-white shadow-lg glow-fuchsia'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Activity className="w-4 h-4" /> {isMusicRoom ? LIVE_ROOM_LANGUAGE.boost : 'Upvote'}
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
          <p className="mt-2">{paymentAuthorizationDisclosureCopy}</p>
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
          {patronRequestStatus ? (
            <p className="mt-1 text-[10px] font-semibold opacity-80">
              {patronPaymentStatusLabel(patronRequestStatus.paymentStatus)}
            </p>
          ) : null}
        </div>
      )}

      {patronActivity.length > 1 ? (
        <details className="rounded-xl border border-white/10 bg-slate-900/70 px-4 py-3">
          <summary className="cursor-pointer text-xs font-black uppercase tracking-wide text-slate-200">Your room activity ({patronActivity.length})</summary>
          <div className="mt-3 space-y-2">
            {patronActivity.map((activity, index) => (
              <div key={`${activity.submittedAt}-${index}`} className="flex items-center justify-between gap-3 rounded-lg bg-slate-950 px-3 py-2 text-xs">
                <div className="min-w-0">
                  <p className="truncate font-bold text-white">{activity.title}</p>
                  <p className="text-[10px] uppercase tracking-wide text-slate-500">{activity.actionType}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="font-bold text-cyan-200">{activity.status === 'hold' ? 'Pending' : activity.status}</p>
                  <p className="mt-0.5 text-[9px] font-semibold text-slate-400">{patronPaymentStatusLabel(activity.paymentStatus)}</p>
                </div>
              </div>
            ))}
          </div>
        </details>
      ) : null}

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
                    {isMusicRoom
                      ? `${session.talentName} has temporarily paused new track requests to catch up with the approved queue.`
                      : `${session.talentName} has temporarily paused new requests to catch up with the live queue.`}
                  </p>
                </div>
                
                <div className="p-3 bg-slate-950 border border-white/5 rounded-xl font-mono text-2xs space-y-1.5 min-w-0">
                  <span className="text-fuchsia-400 font-bold block select-none">💡 WHAT YOU CAN STILL DO:</span>
                  <div className="text-slate-400 space-y-1 font-sans text-xs">
                    {session.tipsEnabled ? <p>• Send a <strong className="text-emerald-400">{LIVE_ROOM_LANGUAGE.directTip}</strong> to show love</p> : null}
                    <p>• <strong className="text-cyan-400">{isMusicRoom ? 'Boost existing requests' : 'Upvote existing requests'}</strong> in the live queue to move them up</p>
                    <p>• Watch the live queue and try again when requests reopen</p>
                  </div>
                </div>

                <div className="flex gap-2">
                  {session.tipsEnabled ? <button
                    onClick={() => {
                      setActiveTab('tip');
                      setSelectedTrack({ title: LIVE_ROOM_LANGUAGE.directTip, description: roomLanguage.directSupportDescription, basePrice: session.minimumTip });
                    }}
                    className="flex-1 py-2.5 bg-fuchsia-600 hover:bg-fuchsia-500 text-white text-xs font-bold rounded-xl shadow-lg transition-colors cursor-pointer"
                  >
                    💖 Support {roomLanguage.hostTitle} Directly
                  </button> : null}
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
            {session.roomType === 'music' && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <div className="text-xs font-mono font-bold text-slate-500 uppercase tracking-widest select-none">
                    Host menu
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {requestPresets.map((preset) => (
                      <React.Fragment key={preset.id}>
                        <HostMenuItemCard
                          preset={preset}
                          selected={selectedPresetId === preset.id}
                          density="compact"
                          isReporting={reportingMenuItemId === preset.menuItemId}
                          onSelect={() => {
                            setSelectedPresetId(preset.id);
                            setSelectedTrack({
                              id: preset.id,
                              title: preset.label,
                              artist: preset.subtitle,
                              description: preset.subtitle,
                              albumArt: preset.targetType === 'music' ? REQUEST_ART_PLACEHOLDER : undefined,
                              basePrice: preset.amount,
                              targetType: preset.targetType,
                              menuItemId: preset.menuItemId,
                              source: PRESET_REQUEST_SOURCE
                            });
                            setTipAmount(Math.max(session.minimumTip, preset.amount));
                          }}
                          onReport={onReportMenuItem ? () => { void reportHostMenuItem(preset); } : undefined}
                        />
                      </React.Fragment>
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
                    {searchResults.some((song) => song.category === 'sway_catalog') ? (
                      <div className="space-y-2 rounded-xl border border-fuchsia-500/20 bg-fuchsia-500/5 p-2">
                        <p className="px-1 text-[10px] font-black uppercase tracking-wider text-fuchsia-200">Catalog audio · stored in Sway</p>
                        {searchResults.filter((song) => song.category === 'sway_catalog').map(renderSearchResult)}
                      </div>
                    ) : null}
                    {searchResults.some((song) => song.category !== 'sway_catalog') ? (
                      <div className="space-y-2 rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-2">
                        <div className="px-1"><p className="text-[10px] font-black uppercase tracking-wider text-cyan-200">External request music</p><p className="mt-0.5 text-[9px] text-slate-500">The performer plays this from Spotify, DJ software, or another external source.</p></div>
                        {searchResults.filter((song) => song.category !== 'sway_catalog').map(renderSearchResult)}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            )}

            {session.roomType !== 'music' && (
              <div className="space-y-4 font-sans">
                {requestPresets.length ? (
                  <div className="space-y-2">
                    <div className="text-xs font-mono font-bold text-slate-500 uppercase tracking-widest select-none">
                      Host menu
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {requestPresets.map((preset) => (
                        <React.Fragment key={preset.id}>
                          <HostMenuItemCard
                            preset={preset}
                            selected={selectedPresetId === preset.id}
                            density="comfortable"
                            isReporting={reportingMenuItemId === preset.menuItemId}
                            onSelect={() => {
                              setSelectedPresetId(preset.id);
                              setSearchQuery('');
                              setSelectedTrack({
                                id: preset.id,
                                title: preset.label,
                                artist: preset.subtitle,
                                description: preset.subtitle,
                                basePrice: 0,
                                targetType: 'custom',
                                menuItemId: preset.menuItemId,
                                source: PRESET_REQUEST_SOURCE
                              });
                              setTipAmount(0);
                            }}
                            onReport={onReportMenuItem ? () => { void reportHostMenuItem(preset); } : undefined}
                          />
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                ) : null}

                <label className="block space-y-2">
                  <span className="text-xs font-mono font-bold uppercase tracking-widest text-slate-500">Or type a request</span>
                  <input
                    type="text"
                    maxLength={160}
                    value={selectedPresetId ? '' : searchQuery}
                    onChange={(event) => {
                      const value = event.target.value;
                      const normalized = value.trim();
                      setSearchQuery(value);
                      setSelectedPresetId(null);
                      setSelectedTrack(normalized ? {
                        id: `manual-${normalized.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48)}`,
                        title: normalized,
                        artist: 'Manual audience request',
                        description: 'Manual audience request',
                        basePrice: 0,
                        targetType: 'custom',
                        source: MANUAL_REQUEST_SOURCE
                      } : null);
                      setTipAmount(0);
                    }}
                    placeholder="Enter a respectful request for the host"
                    className="min-h-12 w-full rounded-xl border border-white/10 bg-slate-950 px-4 text-sm text-white outline-none placeholder:text-slate-600 focus:border-fuchsia-400"
                  />
                </label>
                <p className="text-[11px] leading-5 text-slate-500">Requests are suggestions, not guaranteed fulfillment. The host approves, denies, or closes requests.</p>
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
                  <label htmlFor="sway-patron-sender-name" className="text-[10px] text-slate-400 uppercase font-mono tracking-wider font-bold">Your Name / Group</label>
                  <input
                    id="sway-patron-sender-name"
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
                  <label htmlFor="sway-patron-custom-note" className="text-[10px] text-slate-400 uppercase font-mono tracking-wider font-bold">Custom Note / Shoutout (Profanity Filtered)</label>
                  <input
                    id="sway-patron-custom-note"
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
                      ? `Confirm payment to send this request. ${paymentAuthorizationDisclosureCopy}`
                      : `No payment needed for this request. ${paymentAuthorizationDisclosureCopy}`}
                  </p>
                </div>

              </motion.div>
            )}
              </>
            )}
          </div>
        )}

              {/* TAB B: Direct tip options */}
        {activeTab === 'tip' && session.status === 'active' && session.tipsEnabled && (
          <motion.form 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            onSubmit={handleStraightTipSubmit} 
            className="bg-slate-900 border border-white/10 rounded-xl p-5 space-y-4 shadow-lg font-sans"
          >
            <div className="text-center pb-2 select-none">
              <Coins className="w-10 h-10 text-fuchsia-500 mx-auto animate-bounce mb-2" />
              <h3 className="font-display text-sm font-bold text-white uppercase tracking-wider">{LIVE_ROOM_LANGUAGE.directTip}</h3>
              <p className="text-xs text-slate-400 mt-1 leading-relaxed">Send a direct tip for {session.talentName}. Confirm payment to send it; a successful tip is captured immediately.</p>
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
                placeholder={roomLanguage.tipNotePlaceholder}
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
                  <p className="text-[10px] text-slate-500">{roomLanguage.queueApprovalCopy}</p>
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
                                {isMusicRoom ? 'Boost' : 'Upvote'}
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
                <Sparkles className="w-4 h-4 text-amber-400 animate-pulse" /> {roomLanguage.directoryHeading}
              </h3>
              <p className="text-xs text-slate-400 leading-relaxed font-sans">
                {roomLanguage.directoryBody}
              </p>
            </div>

            {/* Directory search input */}
            <div className="relative font-sans border-none sm:border-solid">
              <Search className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={directorySearch}
                onChange={(e) => setDirectorySearch(e.target.value)}
                placeholder={roomLanguage.directoryPlaceholder}
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
                      <div className="text-xs text-slate-400 font-bold">{roomLanguage.directoryEmpty}</div>
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
                          <span>{roomLanguage.activeHostLabel}</span>
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
                            title={roomLanguage.roomLinkPrompt}
                          >
                            Room link
                          </div>

                          {/* Quick Tip action */}
                          {session.tipsEnabled ? <button
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
                          </button> : null}
                        </div>
                      </div>

                      {/* Display inline tip drawer if selected */}
                      {session.tipsEnabled && selectedDirectoryPerformer?.id === p.id && (
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
                                setDegraded(true);
                                setPendingActionMessage(incompleteRoomCopy);
                                return;
                              }
                              // Open confirmation
                              const platformFee = session.feeType === 'patron' ? estimatePlatformFee(tipAmount) : 0;
                              sendRequestStarted(funnelTelemetryPayload);
                              setPaymentConfirmationState(null);
                              setCheckoutPayload({
                                open: true,
                                type: 'request',
                                title: `Directory Tip to ${p.name}`,
                                artist: `A direct tip supporting ${p.name} in this Live Room`,
                                amount: tipAmount,
                                fee: platformFee,
                                total: tipAmount + platformFee,
                                targetType: isMusicRoom ? 'music' : 'custom',
                                senderName,
                                message: commentMessage,
                                sourceProvider: null,
                                spotifyUri: null,
                                spotifyUrl: null,
                                boostPatronName: null,
                                gigId,
                                ...createClientActionIds()
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
          <div
            data-sway-payment-overlay="true"
            className="fixed z-50 flex items-start justify-center overflow-y-auto overscroll-contain bg-black/80 p-4 backdrop-blur-sm sm:items-center"
            style={{
              left: 'var(--sway-viewport-offset-left, 0px)',
              top: 'var(--sway-viewport-offset-top, 0px)',
              width: 'var(--sway-viewport-width, 100vw)',
              height: 'var(--sway-viewport-height, 100vh)',
              maxHeight: 'var(--sway-viewport-height, 100vh)'
            }}
          >
            <motion.div
              ref={checkoutDialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="sway-payment-dialog-title"
              aria-describedby="sway-payment-dialog-description"
              aria-busy={isPaying || isStripeAuthorizing || isDurableActionPending}
              tabIndex={-1}
              data-sway-payment-dialog="true"
              onKeyDown={handleCheckoutDialogKeyDown}
              initial={{ scale: 0.95, y: 15, opacity: 0 }}
              animate={{ scale: 1, y: 0, opacity: 1 }}
              exit={{ scale: 0.95, y: 15, opacity: 0 }}
              className="w-full max-w-sm overflow-y-auto overscroll-contain rounded-2xl border border-white/10 bg-slate-900 text-center font-sans shadow-2xl glass-panel"
              style={{ maxHeight: 'calc(var(--sway-viewport-height, 100vh) - 2rem)' }}
            >
              <span
                tabIndex={0}
                data-sway-payment-focus-start="true"
                className="sr-only"
                onFocus={() => checkoutCancelRef.current?.focus()}
              />
              
              {/* Request processing and success cards */}
              {backendConfirmed ? (
                <div className="p-8 space-y-4">
                  <div className="w-16 h-16 bg-cyan-500/20 border border-cyan-500/30 text-cyan-400 flex items-center justify-center rounded-full mx-auto animate-bounce">
                    <Check className="w-8 h-8 text-cyan-400" />
                  </div>
                  <h3 id="sway-payment-dialog-title" className="font-sans text-lg font-bold text-white">
                    {checkoutPayload.type === 'boost'
                      ? `${isMusicRoom ? LIVE_ROOM_LANGUAGE.boost : 'Upvote'} Submitted`
                      : checkoutPayload.isTip
                        ? `${LIVE_ROOM_LANGUAGE.tip} Submitted`
                        : `${LIVE_ROOM_LANGUAGE.request} Submitted`}
                  </h3>
                  <p id="sway-payment-dialog-description" className="text-xs text-slate-300 leading-relaxed max-w-xs mx-auto font-sans">
                    Sent. Status: {LIVE_ROOM_LANGUAGE.pending}. {paymentAuthorizationDisclosureCopy}
                  </p>
                </div>
              ) : (
                /* Temporary confirmation fields */
                <div className="p-6 space-y-6">
                  
                  {/* Title and meta */}
                  <div className="space-y-1">
                    <span className="text-[9px] font-mono font-bold text-slate-500 uppercase tracking-widest">{checkoutSummaryLabel}</span>
                    <h3 id="sway-payment-dialog-title" className="font-sans text-base font-bold text-white">
                      {previewMode
                        ? 'Demo Only'
                        : isDurableActionPending
                          ? 'Confirmation pending'
                          : isPaymentConfirmationPending
                            ? 'Payment authorization required'
                            : checkoutPayload.type === 'request'
                              ? 'Confirm Request'
                              : (isMusicRoom ? 'Confirm Boost' : 'Confirm Upvote')}
                    </h3>
                    {previewMode && (
                      <p id="sway-payment-dialog-description" className="text-[10px] text-amber-200 font-bold uppercase tracking-widest">
                        Demo data. No payment or request will be recorded.
                      </p>
                    )}
                    {!previewMode && (
                      <p id="sway-payment-dialog-description" className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">
                        {isDurableActionPending
                          ? (pendingActionMessage || PAYMENT_CONFIRMATION_WAITING_COPY)
                          : isPaymentConfirmationPending
                            ? PAYMENT_CONFIRMATION_WAITING_COPY
                            : paymentAuthorizationDisclosureCopy}
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
                        <span className="text-slate-500">Estimated Sway fee:</span>
                        <span className="text-fuchsia-400 font-bold">
                          {checkoutPayload.fee > 0 ? getFormat(checkoutPayload.fee) : `Absorbed by ${roomLanguage.hostTitle}`}
                        </span>
                      </div>

                      <div className="border-t border-white/10 pt-2.5 flex justify-between text-xs font-mono font-black">
                        <span className="text-slate-400">Estimated {checkoutCopy?.totalLabel?.toLowerCase() ?? 'request total:'}</span>
                        <span className="text-cyan-400 font-bold">${checkoutPayload.total}.00</span>
                      </div>
                      <p className="text-[10px] text-slate-500 font-sans">The payment provider confirms the final amount before submission.</p>
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
                        <label className="text-[10px] text-slate-400 uppercase font-mono tracking-wider font-bold">
                          {isMusicRoom ? 'BOOSTER / SPONSOR NAME' : 'YOUR NAME / GROUP'}
                        </label>
                        <input
                          type="text"
                          value={boostPatronName}
                          onChange={(e) => {
                            const nextName = e.target.value;
                            setBoostPatronName(nextName);
                            setCheckoutPayload((current) => current?.type === 'boost'
                              ? { ...current, boostPatronName: nextName }
                              : current);
                          }}
                          disabled={isPaymentConfirmationPending}
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
                            disabled={isPaymentConfirmationPending}
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
                  <div data-sway-payment-actions="true" className="space-y-2">
                    {(checkoutPayload.isTip || session.paymentsEnabled !== false) ? (
                      <p role="status" className="rounded-lg border border-cyan-500/25 bg-cyan-500/10 px-3 py-2 text-[10px] font-bold leading-4 text-cyan-100">
                        {stripePaymentMode === 'live'
                          ? 'Stripe live mode — real charges. Use a real card.'
                          : 'Stripe test mode — use a test card. No real money moves.'}
                      </p>
                    ) : null}
                    {checkoutPayload.clientSecret && stripePromise && stripeElementsOptions ? (
                      <Elements stripe={stripePromise} options={stripeElementsOptions} key={checkoutPayload.clientSecret}>
                        <StripeAuthorizationForm
                          disabled={isPaying || isDurableActionPending || previewMode}
                          cancelRef={checkoutCancelRef}
                          onAuthorized={finalizeStripeAuthorization}
                          onAuthorizationStateChange={setStripeAuthorizationState}
                          onError={(message) => {
                            setStripeConfigError(message);
                            setPendingActionMessage(message);
                          }}
                          onCancel={() => closeCheckout()}
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
                              : isDurableActionPending
                                ? 'Confirmation pending'
                                : !checkoutPayload.isTip && session.paymentsEnabled === false
                                  ? (checkoutPayload.type === 'boost' ? 'Confirm Upvote' : 'Confirm Request')
                                  : "Confirm Payment"}
                        </button>

                        <button
                          ref={checkoutCancelRef}
                          type="button"
                          onClick={() => closeCheckout()}
                          disabled={isPaying || isDurableActionPending}
                          className="w-full py-2 hover:bg-slate-800 text-slate-400 hover:text-white rounded-xl text-xs font-bold transition-colors cursor-pointer"
                        >
                          Cancel
                        </button>
                      </>
                    )}
                  </div>

                </div>
              )}

              <span
                tabIndex={0}
                data-sway-payment-focus-end="true"
                className="sr-only"
                onFocus={focusCheckoutFirst}
              />

            </motion.div>
          </div>
        )}
      </AnimatePresence>

    </div>
  );
}
