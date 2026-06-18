import { useEffect, useRef } from 'react';
import { Flame, Smartphone, Tv } from 'lucide-react';
import { motion } from 'motion/react';
import PatronView from '../components/PatronView';
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
  onReturnHomeClick
}: {
  onReturnHomeClick: () => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-xl items-center px-4 py-10">
      <div className="w-full rounded-3xl border border-white/10 bg-slate-900/80 p-6 shadow-2xl">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-fuchsia-500/25 bg-fuchsia-500/10 text-fuchsia-300">
          <Flame className="h-5 w-5" />
        </div>
        <h1 className="font-display text-2xl font-black text-white">Join a Live Room</h1>
        <p className="mt-3 text-sm leading-6 text-slate-300">
          Sway helps you request songs, send tips, and boost queue placement. Scan a live room&apos;s QR code,
          tap a performer&apos;s link, or return to our homepage to explore.
        </p>
        <p className="mt-3 text-sm leading-6 text-slate-400">
          Use a Sway room link or performer&apos;s link to join a live session.
        </p>
        <a
          className="mt-6 inline-flex min-h-11 items-center justify-center rounded-xl bg-fuchsia-600 px-4 py-3 text-sm font-bold text-white hover:bg-fuchsia-500"
          href="https://sway.tips/"
          onClick={onReturnHomeClick}
        >
          Return to Sway home
        </a>
      </div>
    </div>
  );
}

export default function PatronApp() {
  const route = resolvePatronRoute(window.location.pathname);
  const routeGigId = route.name === 'patron-gig' && UUID_PATTERN.test(route.gigId) ? route.gigId : undefined;
  const statePath = routeGigId ? `/api/state/${routeGigId}` : null;
  const { bState, isLoading, setBState, roomLookup } = useSwayState({ statePath });
  const demoMode = isDemoModeEnabled();
  const roomEntryEventKeyRef = useRef<string | null>(null);
  const recoveryEventKeyRef = useRef<string | null>(null);

  const rejectDemoMutation = async () => {
    throw new Error('Demo data is read-only. No backend mutation was sent.');
  };

  const handleCreateRequest = async (requestData: Record<string, unknown>) => {
    if (demoMode) return rejectDemoMutation();
    try {
      const data = await postJson('/api/request/create', requestData);
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
    gigId?: string
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
        gig_id: gigId
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
    return postJson('/api/moderation/block', { scope, value, reason });
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
    return data;
  };

  const handleDataDeletionPlaceholder = async () => {
    if (demoMode) return rejectDemoMutation();
    return postJson('/api/privacy/data-deletion-placeholder', { source: 'patron_shell_placeholder' });
  };

  const { session, requests } = bState;
  const performers = bState.performers || [];
  const overlayGigId = routeGigId || '';
  const hasPatronRouteContext = route.name === 'performer' || Boolean(routeGigId);
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
  const topRequest = requests
    .filter((request) => request.status === 'approved')
    .sort((a, b) => b.amount - a.amount)[0];

  useEffect(() => {
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
  }, [hasPatronRouteContext, hasSessionContext, isLoading, routeFamily, shouldShowNoSessionRecovery]);

  useEffect(() => {
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
  }, [hasPatronRouteContext, hasSessionContext, isLoading, routeFamily, routeGigId, shouldShowEndedRoomRecovery, shouldShowNoSessionRecovery]);

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

  if (isLoading) return <LoadingState />;

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100">
      <DemoModeBanner />
      <div className="border-b border-white/10 bg-slate-900 px-4 py-3">
        <div className="mx-auto flex max-w-xl items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="rounded bg-fuchsia-500/10 p-1 text-fuchsia-400">
              {route.name === 'performer' ? <Smartphone className="h-4 w-4" /> : <Flame className="h-4 w-4" />}
            </div>
            <div>
              <span className="font-display text-xs font-black uppercase tracking-widest text-white">Sway Patron</span>
              <p className="text-[9px] text-slate-400">
                {route.name === 'performer' ? `Performer: ${route.performerHandle}` : 'Request, Tip, and Boost live'}
              </p>
            </div>
          </div>
          <DemoModeBanner compact />
          <a className="rounded-lg border border-white/10 p-2 text-slate-300 hover:text-white" href={`/overlay/${overlayGigId}`} title="Open overlay">
            <Tv className="h-4 w-4" />
          </a>
        </div>
      </div>

      <main className="flex-1">
        <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
          {shouldShowEndedRoomRecovery ? (
            <EndedLiveRoomRecovery />
          ) : shouldShowNoSessionRecovery ? (
            <PatronNoSessionRecovery onReturnHomeClick={handleReturnHomeClick} />
          ) : (
            <SplitViewShell
              title="Patron App"
              eyebrow="Live Room"
              primaryLabel="Now Playing, Search, Fast Actions, Queue, and History"
              secondaryLabel="Selected gig inspector"
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
                <div className="space-y-4 text-sm">
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
                    <p className="text-xs text-slate-400">{topRequest ? `$${topRequest.amount} request value` : 'Empty-state inspector remains visible.'}</p>
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
