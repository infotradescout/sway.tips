import { useEffect, useRef, useState } from 'react';
import { Flame } from 'lucide-react';
import { motion } from 'motion/react';
import AppBackdrop from '../components/AppBackdrop';
import PatronView from '../components/PatronView';
import PerformerPublicProfilePage from '../components/PerformerPublicProfilePage';
import QrScanner from '../components/QrScanner';
import SplitViewShell from '../components/SplitViewShell';
import { DemoModeBanner, isDemoModeEnabled } from '../demo-mode';
import {
  EndedLiveRoomRecovery,
  LoadingState,
  postJson,
  useSwayState
} from './shared';
import {
  sendPatronNoSessionRecoveryViewed,
  sendPatronNoSessionReturnHomeClicked,
  sendRoomEntryViewed
} from './frictionClient';
import { captureCampaignCode } from './campaignAttribution';

type PatronRoute =
  | { name: 'patron-gig'; gigId: string }
  | { name: 'performer'; performerHandle: string };

function resolvePatronRoute(pathname: string): PatronRoute {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] === 'p' && parts[1]) return { name: 'performer', performerHandle: parts[1] };
  return { name: 'patron-gig', gigId: parts[1] || '' };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function PatronNoSessionRecovery({
  onReturnHomeClick,
  attemptedGigId
}: {
  onReturnHomeClick: () => void;
  attemptedGigId?: string;
}) {
  const [scannerOpen, setScannerOpen] = useState(false);

  return (
    <div className="relative isolate flex min-h-[calc(var(--sway-viewport-height,100vh)*0.8)] items-center justify-center overflow-hidden px-4 py-16">
      <AppBackdrop />

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.72, delay: 0.72 }}
        className="relative mx-auto grid w-full max-w-xl gap-3"
      >
        {attemptedGigId ? (
          <div className="mb-2 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-5 py-4 text-center">
            <p className="text-sm font-black uppercase tracking-wide text-rose-200">Room not found</p>
            <p className="mt-2 text-xs leading-5 text-rose-100/90">
              This link doesn&apos;t match a live room right now. Ask the performer for a fresh QR code or link,
              or scan again below.
            </p>
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => setScannerOpen(true)}
          className="glow-fuchsia inline-flex min-h-14 items-center justify-center rounded-xl bg-gradient-to-r from-fuchsia-600 to-fuchsia-500 px-5 py-3 text-base font-black uppercase tracking-wide text-white transition-colors hover:from-fuchsia-500 hover:to-fuchsia-400"
        >
          Scan
        </button>
        <a
          className="inline-flex min-h-14 items-center justify-center rounded-xl border border-white/10 bg-slate-950/60 px-5 py-3 text-base font-bold text-slate-100 backdrop-blur transition-colors hover:border-fuchsia-500/40 hover:text-white"
          href="/talent/signup"
        >
          Create account
        </a>
        <a
          className="inline-flex min-h-14 items-center justify-center rounded-xl border border-white/10 bg-slate-950/60 px-5 py-3 text-base font-bold text-slate-100 backdrop-blur transition-colors hover:border-fuchsia-500/40 hover:text-white"
          href="/talent/login"
        >
          Login
        </a>
        <a
          className="mt-4 inline-flex min-h-10 items-center justify-center text-sm font-semibold text-fuchsia-300 transition-colors hover:text-fuchsia-200"
          href="/faq"
          onClick={onReturnHomeClick}
        >
          sway to play
        </a>

      </motion.div>

      {scannerOpen ? <QrScanner onClose={() => setScannerOpen(false)} /> : null}
    </div>
  );
}

export default function PatronApp() {
  const route = resolvePatronRoute(window.location.pathname);
  const routeGigId = route.name === 'patron-gig' && UUID_PATTERN.test(route.gigId) ? route.gigId : undefined;
  const attemptedGigId = route.name === 'patron-gig' && route.gigId ? route.gigId : undefined;
  const statePath = routeGigId ? `/api/state/${routeGigId}` : null;
  const { bState, isLoading, setBState, roomLookup } = useSwayState({ statePath });
  const demoMode = isDemoModeEnabled();
  const roomEntryEventKeyRef = useRef<string | null>(null);
  const recoveryEventKeyRef = useRef<string | null>(null);

  const campaignCode = captureCampaignCode();

  const rejectDemoMutation = async () => {
    throw new Error('Demo data is read-only. No backend mutation was sent.');
  };

  const handleCreateRequest = async (requestData: Record<string, unknown>) => {
    if (demoMode) return rejectDemoMutation();
    try {
      const data = await postJson('/api/request/create', { ...requestData, campaign_code: campaignCode });
      setBState(data.state);
      return data;
    } catch (e) {
      console.error(e);
      throw e;
    }
  };

  const handleBoostRequest = async (
    requestId: string,
    patronName: string,
    amount: number,
    clientRequestId?: string,
    idempotencyKey?: string,
    expiresAt?: string,
    gigId?: string,
    paymentIntentId?: string
  ) => {
    if (demoMode) return rejectDemoMutation();
    try {
      const data = await postJson('/api/request/boost', {
        requestId,
        patronName,
        boostAmount: amount,
        client_request_id: clientRequestId,
        idempotency_key: idempotencyKey,
        expires_at: expiresAt,
        gig_id: gigId,
        payment_intent_id: paymentIntentId,
        campaign_code: campaignCode
      });
      setBState(data.state);
      return data;
    } catch (e) {
      console.error(e);
      throw e;
    }
  };

  const handleReconcilePendingAction = async (clientRequestId: string, idempotencyKey: string) => {
    if (demoMode) return rejectDemoMutation();
    const data = await postJson('/api/pending-action/reconcile', {
      client_request_id: clientRequestId,
      idempotency_key: idempotencyKey
    });

    if (data.status === 'reconciled' && data.responseBody?.state) {
      setBState(data.responseBody.state);
    }

    return data;
  };

  const handleReportContent = async (requestId: string, reason: string, details?: string) => {
    if (demoMode) return rejectDemoMutation();
    return postJson('/api/moderation/report', { requestId, reason, details });
  };

  const handleBlockFoundation = async (
    scope: 'patron_user_id' | 'patron_device_id_hash' | 'sender_name',
    value: string,
    reason: string
  ) => {
    if (demoMode) return rejectDemoMutation();
    return postJson('/api/moderation/patron-block', { scope, value, reason });
  };

  const handleSupportContact = async () => {
    if (demoMode) return rejectDemoMutation();
    const response = await fetch('/api/support/contact');
    const data = await response.json();
    if (!response.ok) {
      throw Object.assign(new Error(data?.error || 'Support request failed.'), {
        status: response.status,
        body: data
      });
    }
    if (typeof data?.supportPath === 'string' && typeof window !== 'undefined') {
      window.open(data.supportPath, '_blank', 'noopener,noreferrer');
    }
    return data;
  };

  const handleDataDeletionPlaceholder = async () => {
    if (demoMode) return rejectDemoMutation();
    const data = await postJson('/api/privacy/data-deletion', { source: 'patron_shell_placeholder' });
    if (typeof data?.dataDeletionInfoPath === 'string' && typeof window !== 'undefined') {
      window.open(data.dataDeletionInfoPath, '_blank', 'noopener,noreferrer');
    }
    return data;
  };

  const { session, requests } = bState;
  const performers = bState.performers || [];
  const hasPatronRouteContext = Boolean(routeGigId);
  const hasSessionContext =
    session.status !== 'inactive' ||
    Boolean(session.talentName) ||
    requests.length > 0 ||
    performers.length > 0;
  const shouldShowEndedRoomRecovery = roomLookup.status === 'ended';
  const shouldShowNoSessionRecovery =
    roomLookup.status === 'missing' ||
    roomLookup.status === 'error' ||
    (!hasPatronRouteContext && !hasSessionContext);
  const routeFamily = routeGigId ? 'patron-gig' : 'patron-root';
  const patronTopbarSubtitle = shouldShowNoSessionRecovery
    ? 'Open a room link or sign in as the performer'
    : 'Request, Tip, and Boost live';
  const topRequest = requests
    .filter((request) => request.status === 'approved')
    .sort((a, b) => b.amount - a.amount)[0];

  useEffect(() => {
    if (route.name === 'performer') return;
    if (isLoading || !shouldShowNoSessionRecovery) return;
    const eventKey = `${routeFamily}:${hasPatronRouteContext}:${hasSessionContext}:recovery`;
    if (recoveryEventKeyRef.current === eventKey) return;
    recoveryEventKeyRef.current = eventKey;
    sendPatronNoSessionRecoveryViewed({
      shell: 'patron',
      surface: 'recovery-view',
      route_family: routeFamily,
      has_route_context: hasPatronRouteContext,
      has_session_context: hasSessionContext,
      build_commit: 'unknown'
    });
  }, [hasPatronRouteContext, hasSessionContext, isLoading, route.name, routeFamily, shouldShowNoSessionRecovery]);

  useEffect(() => {
    if (route.name === 'performer') return;
    if (isLoading || shouldShowNoSessionRecovery || shouldShowEndedRoomRecovery || !hasPatronRouteContext) return;
    const eventKey = `${routeFamily}:${routeGigId ?? 'none'}:entry`;
    if (roomEntryEventKeyRef.current === eventKey) return;
    roomEntryEventKeyRef.current = eventKey;
    sendRoomEntryViewed({
      shell: 'patron',
      surface: 'room-entry',
      route_family: routeFamily,
      has_route_context: hasPatronRouteContext,
      has_session_context: hasSessionContext,
      build_commit: 'unknown'
    });
  }, [hasPatronRouteContext, hasSessionContext, isLoading, route.name, routeFamily, routeGigId, shouldShowEndedRoomRecovery, shouldShowNoSessionRecovery]);

  const handleReturnHomeClick = () => {
    sendPatronNoSessionReturnHomeClicked({
      shell: 'patron',
      surface: 'recovery-view',
      route_family: routeFamily,
      has_route_context: hasPatronRouteContext,
      has_session_context: hasSessionContext,
      build_commit: 'unknown'
    });
  };

  if (route.name === 'performer') {
    return <PerformerPublicProfilePage performerHandle={route.performerHandle} />;
  }

  if (isLoading) return <LoadingState />;

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100">
      {shouldShowNoSessionRecovery ? null : <DemoModeBanner />}
      {shouldShowNoSessionRecovery ? null : (
        <div className="border-b border-white/10 bg-slate-900 px-4 py-3">
          <div className="mx-auto flex max-w-xl items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="rounded bg-fuchsia-500/10 p-1 text-fuchsia-400">
                <Flame className="h-4 w-4" />
              </div>
              <div>
                <span className="font-display text-xs font-black uppercase tracking-widest text-white">Live Room</span>
                <p className="text-[9px] text-slate-400">
                  {patronTopbarSubtitle}
                </p>
              </div>
            </div>
            <DemoModeBanner compact />
          </div>
        </div>
      )}

      <main className="flex-1">
        <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
          {shouldShowEndedRoomRecovery ? (
            <EndedLiveRoomRecovery />
          ) : shouldShowNoSessionRecovery ? (
            <PatronNoSessionRecovery
              onReturnHomeClick={handleReturnHomeClick}
              attemptedGigId={attemptedGigId}
            />
          ) : (
            <SplitViewShell
              title="Live room"
              eyebrow="Live Room"
              showHeader={false}
              primaryLabel="Request, Tip, Boost, and see status"
              secondaryLabel="Room status"
              isEmpty={requests.length === 0 && performers.length === 0}
              emptyState={
                <div className="rounded-2xl border border-dashed border-white/10 bg-slate-900/40 p-8 text-center">
                  <p className="text-sm font-bold text-white">No live records yet</p>
                  <p className="mt-2 text-xs text-slate-400">The live room shell is ready for the first active session, request, or performer record.</p>
                </div>
              }
              primary={
                <PatronView
                  session={session}
                  requests={requests}
                  performers={performers}
                  gigId={routeGigId}
                  onCreateRequest={handleCreateRequest}
                  onBoostRequest={handleBoostRequest}
                  onReconcilePendingAction={handleReconcilePendingAction}
                  onReportContent={handleReportContent}
                  onBlockFoundation={handleBlockFoundation}
                  onSupportContact={handleSupportContact}
                  onDataDeletionPlaceholder={handleDataDeletionPlaceholder}
                  previewMode={demoMode}
                />
              }
              secondary={
                <div className="hidden space-y-4 text-sm lg:block">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Performer</p>
                    <p className="mt-1 font-bold text-white">{session.talentName || 'No active performer'}</p>
                    <p className="text-xs text-slate-400">{session.talentRole} surface</p>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded-lg bg-slate-950 p-3">
                      <p className="text-slate-500">Requests</p>
                      <p className="mt-1 font-mono text-lg font-black text-white">{requests.length}</p>
                    </div>
                    <div className="rounded-lg bg-slate-950 p-3">
                      <p className="text-slate-500">Performers</p>
                      <p className="mt-1 font-mono text-lg font-black text-white">{performers.length}</p>
                    </div>
                  </div>
                  <div className="rounded-lg border border-white/10 bg-slate-950 p-3">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Top approved request</p>
                    <p className="mt-2 font-bold text-white">{topRequest?.title || 'Nothing approved yet'}</p>
                    <p className="text-xs text-slate-400">
                      {topRequest
                        ? (session.paymentsEnabled !== false ? `$${topRequest.amount} request value` : '')
                        : 'Empty-state inspector remains visible.'}
                    </p>
                  </div>
                </div>
              }
            />
          )}
        </motion.div>
      </main>
    </div>
  );
}
