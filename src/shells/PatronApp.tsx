import { Flame, Smartphone, Tv } from 'lucide-react';
import { motion } from 'motion/react';
import PatronView from '../components/PatronView';
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

  const handleCreateRequest = async (requestData: Record<string, unknown>) => {
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
    const data = await postJson('/api/pending-action/reconcile', {
      client_request_id: clientRequestId,
      idempotency_key: idempotencyKey
    });

    if (data.status === 'reconciled' && data.responseBody?.state) {
      setBState(data.responseBody.state);
    }

    return data;
  };

  if (isLoading) return <LoadingState />;

  const { session, requests } = bState;
  const overlayGigId = routeGigId || '';

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100">
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
          <a className="rounded-lg border border-white/10 p-2 text-slate-300 hover:text-white" href={`/overlay/${overlayGigId}`} title="Open overlay">
            <Tv className="h-4 w-4" />
          </a>
        </div>
      </div>

      <main className="flex-1">
        <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
          <PatronView
            session={session}
            requests={requests}
            performers={bState.performers || []}
            gigId={routeGigId}
            onCreateRequest={handleCreateRequest}
            onBoostRequest={handleBoostRequest}
            onReconcilePendingAction={handleReconcilePendingAction}
          />
        </motion.div>
      </main>
    </div>
  );
}
