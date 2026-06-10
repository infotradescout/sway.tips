import { Flame, Smartphone, Tv } from 'lucide-react';
import { motion } from 'motion/react';
import PatronView from '../components/PatronView';
import SplitViewShell from '../components/SplitViewShell';
import { DemoModeBanner, isDemoModeEnabled } from '../demo-mode';
import { LoadingState, postJson, useSwayState } from './shared';

type PatronRoute =
  | { name: 'patron-gig'; gigId: string }
  | { name: 'performer'; performerHandle: string };

function resolvePatronRoute(pathname: string): PatronRoute {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] === 'p' && parts[1]) return { name: 'performer', performerHandle: parts[1] };
  return { name: 'patron-gig', gigId: parts[1] || '' };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default function PatronApp() {
  const route = resolvePatronRoute(window.location.pathname);
  const { bState, isLoading, setBState } = useSwayState();
  const routeGigId = route.name === 'patron-gig' && UUID_PATTERN.test(route.gigId) ? route.gigId : undefined;
  const demoMode = isDemoModeEnabled();

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
      throw Object.assign(new Error(data?.error || 'Support placeholder failed.'), {
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

  if (isLoading) return <LoadingState />;

  const { session, requests } = bState;
  const overlayGigId = routeGigId || '';
  const topRequest = requests
    .filter((request) => request.status === 'approved')
    .sort((a, b) => b.amount - a.amount)[0];

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
                {route.name === 'performer' ? `Performer link: ${route.performerHandle}` : `Gig route: ${route.gigId}`}
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
          <SplitViewShell
            title="Patron App"
            eyebrow="Live Room"
            primaryLabel="Now Playing, Search, Fast Actions, Queue, and History"
            secondaryLabel="Selected gig inspector"
            badge={<DemoModeBanner compact />}
            isEmpty={requests.length === 0 && (bState.performers || []).length === 0}
            emptyState={
              <div className="rounded-2xl border border-dashed border-white/10 bg-slate-900/40 p-8 text-center">
                <p className="text-sm font-bold text-white">No live records yet</p>
                <p className="mt-2 text-xs text-slate-400">The same Split View shell stays available for real data, demo data, and empty states.</p>
              </div>
            }
            primary={
              <PatronView
                session={session}
                requests={requests}
                performers={bState.performers || []}
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
                    <p className="mt-1 font-mono text-lg font-black text-white">{(bState.performers || []).length}</p>
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
        </motion.div>
      </main>
    </div>
  );
}
