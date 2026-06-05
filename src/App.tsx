import React, { useEffect, useMemo, useState } from 'react';
import { CalendarDays, Flame, Lock, Smartphone, Tv, Users } from 'lucide-react';
import { motion } from 'motion/react';
import { BackendState, GigSession, RequestItem } from './types';
import TalentDashboard from './components/TalentDashboard';
import PatronView from './components/PatronView';
import VictoryScreen from './components/VictoryScreen';

const emptySession: GigSession = {
  status: 'inactive',
  talentName: '',
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
  requestPresets: [],
  totals: {
    totalTips: 0,
    accumulatedFees: 0,
    totalCount: 0,
    topRequest: 'None yet'
  }
};

const routeSpine = ['/talent/login', '/talent/gigs', '/g/', '/p/', '/overlay/', '/admin'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type AppRoute =
  | { name: 'talent-login' }
  | { name: 'talent-gigs'; gigId?: string }
  | { name: 'patron-gig'; gigId: string }
  | { name: 'performer'; performerHandle: string }
  | { name: 'overlay'; gigId: string }
  | { name: 'admin' }
  | { name: 'home' }
  | { name: 'not-found' };

function resolveRoute(pathname: string): AppRoute {
  const parts = pathname.split('/').filter(Boolean);

  if (parts.length === 0) return { name: 'home' };
  if (parts[0] === 'talent' && parts[1] === 'login' && parts.length === 2) return { name: 'talent-login' };
  if (parts[0] === 'talent' && parts[1] === 'gigs') return { name: 'talent-gigs', gigId: parts[2] };
  if (parts[0] === 'g' && parts[1]) return { name: 'patron-gig', gigId: parts[1] };
  if (parts[0] === 'p' && parts[1]) return { name: 'performer', performerHandle: parts[1] };
  if (parts[0] === 'overlay' && parts[1]) return { name: 'overlay', gigId: parts[1] };
  if (parts[0] === 'admin') return { name: 'admin' };

  return { name: 'not-found' };
}

function ShellMessage({
  icon,
  title,
  body,
  actions
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center px-4">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-slate-900 p-6 shadow-2xl">
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-fuchsia-500/25 bg-fuchsia-500/10 text-fuchsia-300">
          {icon}
        </div>
        <h1 className="font-display text-xl font-black uppercase tracking-wide text-white">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-slate-400">{body}</p>
        {actions && <div className="mt-5 flex flex-col gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export default function App() {
  const route = useMemo(() => resolveRoute(window.location.pathname), []);
  const routeGigId = route.name === 'patron-gig' && UUID_PATTERN.test(route.gigId) ? route.gigId : undefined;
  const [bState, setBState] = useState<BackendState>({
    session: emptySession,
    requests: [],
    performers: []
  });
  const [isLoading, setIsLoading] = useState(true);

  const fetchState = async () => {
    try {
      const response = await fetch('/api/state');
      const data = await response.json();
      setBState(data);
    } catch (e) {
      console.warn('Unable to sync server state:', e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchState();

    const interval = setInterval(fetchState, 4000);
    const handleForceSync = () => fetchState();
    window.addEventListener('re-fetch-state', handleForceSync);

    return () => {
      clearInterval(interval);
      window.removeEventListener('re-fetch-state', handleForceSync);
    };
  }, []);

  const handleStartSession = async (setupData: {
    talentName: string;
    talentRole: 'DJ' | 'Bartender' | 'Performer';
    feeType: 'talent' | 'patron';
    minimumTip: number;
  }) => {
    try {
      const response = await fetch('/api/session/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(setupData)
      });
      const data = await response.json();
      setBState(data.state);
    } catch (e) {
      console.error(e);
    }
  };

  const handleEndSession = async () => {
    try {
      const response = await fetch('/api/session/end', { method: 'POST' });
      const data = await response.json();
      setBState(data.state);
    } catch (e) {
      console.error(e);
    }
  };

  const handleCloseout = async () => {
    try {
      const response = await fetch('/api/session/closeout', { method: 'POST' });
      const data = await response.json();
      setBState(data.state);
    } catch (e) {
      console.error(e);
    }
  };

  const handleCreateRequest = async (requestData: any) => {
    try {
      const response = await fetch('/api/request/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestData)
      });
      const data = await response.json();
      if (!response.ok) {
        throw Object.assign(new Error(data?.error || 'Backend request failed.'), {
          status: response.status,
          body: data
        });
      }
      setBState(data.state);
      return data;
    } catch (e) {
      console.error(e);
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
      const response = await fetch('/api/request/boost', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId,
          patronName,
          boostAmount: amount,
          client_request_id: clientRequestId,
          idempotency_key: idempotencyKey,
          expires_at: expiresAt,
          gig_id: gigId
        })
      });
      const data = await response.json();
      if (!response.ok) {
        throw Object.assign(new Error(data?.error || 'Backend request failed.'), {
          status: response.status,
          body: data
        });
      }
      setBState(data.state);
      return data;
    } catch (e) {
      console.error(e);
    }
  };

  const handleReconcilePendingAction = async (clientRequestId: string, idempotencyKey: string) => {
    const response = await fetch('/api/pending-action/reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_request_id: clientRequestId,
        idempotency_key: idempotencyKey
      })
    });
    const data = await response.json();
    if (!response.ok) {
      throw Object.assign(new Error(data?.error || 'Backend request failed.'), {
        status: response.status,
        body: data
      });
    }
    if (data.status === 'reconciled' && data.responseBody?.state) {
      setBState(data.responseBody.state);
    }
    return data;
  };

  const handleTriageRequest = async (requestId: string, action: 'approve' | 'deny') => {
    try {
      const response = await fetch('/api/request/triage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, action })
      });
      const data = await response.json();
      setBState(data.state);
    } catch (e) {
      console.error(e);
    }
  };

  const handleFulfillRequest = async (requestId: string) => {
    try {
      const response = await fetch('/api/request/fulfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId })
      });
      const data = await response.json();
      setBState(data.state);
    } catch (e) {
      console.error(e);
    }
  };

  const resetInactiveSession = () => {
    handleStartSession({
      talentName: 'Sway Performer',
      talentRole: 'DJ',
      feeType: 'patron',
      minimumTip: 5
    });
  };

  const { session, requests } = bState;

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="w-10 h-10 border-2 border-fuchsia-500 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-xs text-slate-400 font-mono">Synchronizing Sway live ledger...</p>
        </div>
      </div>
    );
  }

  if (route.name === 'overlay') {
    const liveLadder = requests
      .filter((r: RequestItem) => r.status === 'approved')
      .sort((a, b) => b.amount - a.amount);

    return (
      <div className="absolute inset-0 bg-transparent text-white p-4 overflow-hidden select-none">
        <div className="flex items-center justify-between border-b border-fuchsia-500/30 pb-2 mb-3">
          <span className="font-display text-xs font-black tracking-widest text-fuchsia-400">
            SWAY LIVE LADDER
          </span>
          <span className="text-[9px] font-mono text-cyan-400 mr-1 animate-pulse">LIVE GIG FEED</span>
        </div>

        <div className="space-y-2.5">
          {liveLadder.slice(0, 5).map((req, idx) => (
            <div
              key={req.id}
              className={`flex items-center justify-between p-2 rounded-lg border text-xs transition-transform ${
                idx === 0
                  ? 'bg-slate-950/90 border-fuchsia-500/50 glow-fuchsia text-white'
                  : 'bg-slate-900/80 border-white/5'
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className={`font-mono font-bold text-[10px] px-1 py-0.5 rounded ${idx === 0 ? 'bg-fuchsia-500/20 text-fuchsia-300' : 'bg-slate-800 text-slate-400'}`}>
                  #{idx + 1}
                </span>
                <span className="font-bold truncate">{req.title}</span>
              </div>
              <span className="font-mono text-cyan-400 font-bold ml-2">${req.amount}</span>
            </div>
          ))}
          {liveLadder.length === 0 && (
            <div className="text-center py-4 bg-slate-950/40 rounded border border-white/5 text-[10px] text-slate-500 font-mono">
              Waiting for gig requests...
            </div>
          )}
        </div>
      </div>
    );
  }

  if (route.name === 'home') {
    return (
      <ShellMessage
        icon={<Flame className="h-5 w-5" />}
        title="Sway"
        body="Sway lets live performers, DJs, bartenders, and event acts accept paid tips, requests, and audience boosts through a QR-powered live ladder."
        actions={
          <>
            <a className="rounded-xl bg-fuchsia-600 px-4 py-2 text-center text-sm font-bold text-white hover:bg-fuchsia-500" href="/talent/login">
              Talent login
            </a>
            <a className="rounded-xl border border-white/10 bg-slate-950 px-4 py-2 text-center text-sm font-bold text-slate-200 hover:text-white" href="/g/local">
              Open patron gig route
            </a>
          </>
        }
      />
    );
  }

  if (route.name === 'talent-login') {
    return (
      <ShellMessage
        icon={<Lock className="h-5 w-5" />}
        title="Talent Login"
        body="Account authentication is the next production milestone. This route is separated now so talent-only screens are no longer reachable through the patron surface."
        actions={
          <a className="rounded-xl bg-fuchsia-600 px-4 py-2 text-center text-sm font-bold text-white hover:bg-fuchsia-500" href="/talent/gigs">
            Continue to gigs
          </a>
        }
      />
    );
  }

  if (route.name === 'not-found') {
    return (
      <ShellMessage
        icon={<CalendarDays className="h-5 w-5" />}
        title="Route Not Found"
        body={`Use ${routeSpine.join(', ')} or their documented parameterized variants.`}
      />
    );
  }

  if (route.name === 'admin') {
    return (
      <ShellMessage
        icon={<Lock className="h-5 w-5" />}
        title="Admin"
        body="Admin tools are intentionally separated from patron and talent routes. Operator features remain unavailable until authentication, audit logs, and persistent ledgers are implemented."
      />
    );
  }

  if (route.name === 'talent-gigs') {
    if (session.status === 'closed') {
      return <VictoryScreen session={session} onRestart={resetInactiveSession} />;
    }

    return (
      <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100">
        <div className="border-b border-white/10 bg-slate-900 px-4 py-3">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="rounded bg-fuchsia-500/10 p-1 text-fuchsia-400">
                <Users className="h-4 w-4" />
              </div>
              <div>
                <span className="font-display text-xs font-black uppercase tracking-widest text-white">
                  Sway Talent
                </span>
                <p className="text-[9px] text-slate-400">Gig setup, queue triage, fulfillment, and closeout</p>
              </div>
            </div>
          </div>
        </div>

        <main className="flex-1">
          <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
            <TalentDashboard
              session={session}
              requests={requests}
              onStartSession={handleStartSession}
              onEndSession={handleEndSession}
              onCloseout={handleCloseout}
              onTriage={handleTriageRequest}
              onFulfill={handleFulfillRequest}
            />
          </motion.div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100">
      <div className="border-b border-white/10 bg-slate-900 px-4 py-3">
        <div className="mx-auto flex max-w-xl items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="rounded bg-fuchsia-500/10 p-1 text-fuchsia-400">
              {route.name === 'performer' ? <Smartphone className="h-4 w-4" /> : <Flame className="h-4 w-4" />}
            </div>
            <div>
              <span className="font-display text-xs font-black uppercase tracking-widest text-white">
                Sway Patron
              </span>
              <p className="text-[9px] text-slate-400">
                {route.name === 'performer' ? `Performer link: ${route.performerHandle}` : `Gig route: ${route.gigId}`}
              </p>
            </div>
          </div>
          <a className="rounded-lg border border-white/10 p-2 text-slate-300 hover:text-white" href={`/overlay/${route.name === 'patron-gig' ? route.gigId : 'local'}`} title="Open overlay">
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
