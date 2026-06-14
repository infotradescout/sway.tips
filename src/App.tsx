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
  operatingMode: 'manual',
  totals: {
    totalTips: 0,
    accumulatedFees: 0,
    totalCount: 0,
    topRequest: 'None yet'
  }
};

const routeSpine = ['/talent/login', '/talent/gigs', '/g/', '/p/', '/overlay/', '/admin'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATA_MODE_STORAGE_KEY = 'sway.dataMode';

type DataMode = 'demo' | 'live';

type DemoFixturePayload = {
  state?: {
    session?: GigSession;
  };
  surfaces?: {
    requests?: RequestItem[];
    profiles?: BackendState['performers'];
  };
};

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
  const operatorControlsEnabled = useMemo(() => new URLSearchParams(window.location.search).get('ops') === '1', []);
  const [dataMode, setDataMode] = useState<DataMode>(() => {
    const saved = window.localStorage.getItem(DATA_MODE_STORAGE_KEY);
    return saved === 'live' ? 'live' : 'demo';
  });
  const [homeView, setHomeView] = useState<'guest' | 'dj'>('guest');
  const [bState, setBState] = useState<BackendState>({
    session: emptySession,
    requests: [],
    performers: []
  });
  const [isLoading, setIsLoading] = useState(true);

  const isDemoMode = dataMode === 'demo';

  const loadDemoState = async (): Promise<boolean> => {
    try {
      const response = await fetch('/sway-demo-fixtures.json', { cache: 'no-store' });
      if (!response.ok) return false;
      const payload = await response.json() as DemoFixturePayload;

      if (!payload?.state?.session) return false;

      setBState({
        session: payload.state.session,
        requests: payload.surfaces?.requests || [],
        performers: payload.surfaces?.profiles || []
      });

      return true;
    } catch {
      return false;
    }
  };

  const fetchState = async () => {
    if (isDemoMode) {
      const loadedDemo = await loadDemoState();
      if (loadedDemo) {
        setIsLoading(false);
        return;
      }
    }

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
    window.localStorage.setItem(DATA_MODE_STORAGE_KEY, dataMode);
    fetchState();

    const interval = setInterval(fetchState, 4000);
    const handleForceSync = () => fetchState();
    window.addEventListener('re-fetch-state', handleForceSync);

    return () => {
      clearInterval(interval);
      window.removeEventListener('re-fetch-state', handleForceSync);
    };
  }, [dataMode]);

  const handleStartSession = async (setupData: {
    talentName: string;
    talentRole: 'DJ' | 'Bartender' | 'Performer';
    feeType: 'talent' | 'patron';
    minimumTip: number;
  }) => {
    if (isDemoMode) return;
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
    if (isDemoMode) return;
    try {
      const response = await fetch('/api/session/end', { method: 'POST' });
      const data = await response.json();
      setBState(data.state);
    } catch (e) {
      console.error(e);
    }
  };

  const handleCloseout = async () => {
    if (isDemoMode) return;
    try {
      const response = await fetch('/api/session/closeout', { method: 'POST' });
      const data = await response.json();
      setBState(data.state);
    } catch (e) {
      console.error(e);
    }
  };

  const handleCreateRequest = async (requestData: any) => {
    if (isDemoMode) {
      throw new Error('Demo mode is read-only right now.');
    }
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
    if (isDemoMode) {
      throw new Error('Demo mode is read-only right now.');
    }
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
    if (isDemoMode) {
      return { status: 'pending' };
    }
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
    if (isDemoMode) return;
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
    if (isDemoMode) return;
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

  const handleReportContent = async (requestId: string, reason: string, details?: string) => {
    if (isDemoMode) {
      throw new Error('Demo mode is read-only right now.');
    }
    const response = await fetch('/api/moderation/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, reason, details })
    });
    const data = await response.json();
    if (!response.ok) {
      throw Object.assign(new Error(data?.error || 'Moderation report failed.'), {
        status: response.status,
        body: data
      });
    }
    return data;
  };

  const handleBlockFoundation = async (
    scope: 'patron_user_id' | 'patron_device_id_hash' | 'sender_name',
    value: string,
    reason: string
  ) => {
    if (isDemoMode) {
      throw new Error('Demo mode is read-only right now.');
    }
    const response = await fetch('/api/moderation/block', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, value, reason })
    });
    const data = await response.json();
    if (!response.ok) {
      throw Object.assign(new Error(data?.error || 'Moderation block failed.'), {
        status: response.status,
        body: data
      });
    }
    return data;
  };

  const handleHideRequest = async (requestId: string) => {
    if (isDemoMode) {
      throw new Error('Demo mode is read-only right now.');
    }
    const response = await fetch('/api/moderation/hide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, reason: 'Performer hid this request from the live queue.' })
    });
    const data = await response.json();
    if (!response.ok) {
      throw Object.assign(new Error(data?.error || 'Moderation hide failed.'), {
        status: response.status,
        body: data
      });
    }
    setBState(data.state);
    return data;
  };

  const handleRemoveRequest = async (requestId: string) => {
    if (isDemoMode) {
      throw new Error('Demo mode is read-only right now.');
    }
    const response = await fetch('/api/moderation/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, reason: 'Performer removed this request from the live queue.' })
    });
    const data = await response.json();
    if (!response.ok) {
      throw Object.assign(new Error(data?.error || 'Moderation remove failed.'), {
        status: response.status,
        body: data
      });
    }
    setBState(data.state);
    return data;
  };

  const handleSupportContact = async () => {
    if (isDemoMode) {
      throw new Error('Demo mode is read-only right now.');
    }
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
    if (isDemoMode) {
      throw new Error('Demo mode is read-only right now.');
    }
    const response = await fetch('/api/privacy/data-deletion-placeholder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'patron_ui_placeholder' })
    });
    const data = await response.json();
    if (!response.ok) {
      throw Object.assign(new Error(data?.error || 'Data deletion request failed.'), {
        status: response.status,
        body: data
      });
    }
    return data;
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
    const upNextQueue = requests
      .filter((r: RequestItem) => r.status === 'approved')
      .sort((a, b) => b.amount - a.amount);
    const nowPlaying = requests
      .filter((r: RequestItem) => r.status === 'fulfilled' && r.type !== 'tip' && !r.hidden && !r.removed)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] ?? null;

    return (
      <div className="absolute inset-0 bg-transparent text-white p-4 overflow-hidden select-none">
        <div className="flex items-center justify-between border-b border-fuchsia-500/30 pb-2 mb-3">
          <span className="font-display text-xs font-black tracking-widest text-fuchsia-400">
            SWAY LIVE ROOM
          </span>
          <span className="text-[9px] font-mono text-cyan-400 mr-1 animate-pulse">LIVE GIG FEED</span>
        </div>

        {nowPlaying && (
          <div className="mb-3 p-2.5 rounded-lg bg-slate-950/90 border border-cyan-500/40">
            <div className="text-[9px] font-mono tracking-widest text-cyan-400 uppercase">Now Playing</div>
            <div className="text-sm font-black text-white truncate">{nowPlaying.title}</div>
          </div>
        )}

        <div className="space-y-2.5">
          {upNextQueue.slice(0, 5).map((req, idx) => (
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
          {upNextQueue.length === 0 && (
            <div className="text-center py-4 bg-slate-950/40 rounded border border-white/5 text-[10px] text-slate-500 font-mono">
              Waiting for gig requests...
            </div>
          )}
        </div>
      </div>
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
        body="Operator tools are intentionally separated from patron and performer routes. Operator features remain unavailable until authentication, audit logs, and persistent ledgers are implemented."
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
                <p className="text-[9px] text-slate-400">Now Playing, Pending Requests, Approved Queue, Controls, and Room State</p>
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
              onHide={handleHideRequest}
              onRemove={handleRemoveRequest}
              previewMode={isDemoMode}
            />
          </motion.div>
        </main>
      </div>
    );
  }

  if (route.name === 'home') {
    return (
      <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100">
        <div className="border-b border-white/10 bg-slate-900 px-4 py-3">
          <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="rounded bg-fuchsia-500/10 p-1 text-fuchsia-400">
                <Flame className="h-4 w-4" />
              </div>
              <div>
                <span className="font-display text-xs font-black uppercase tracking-widest text-white">Sway Live Room</span>
                <p className="text-[10px] text-slate-400">Choose the perspective: DJ booth or guest phone.</p>
              </div>
            </div>
            <div className="flex rounded-xl border border-white/10 bg-slate-950 p-1">
              <button
                type="button"
                onClick={() => setHomeView('guest')}
                className={`rounded-lg px-3 py-1.5 text-xs font-bold ${homeView === 'guest' ? 'bg-fuchsia-600 text-white' : 'text-slate-300 hover:text-white'}`}
              >
                Guest
              </button>
              <button
                type="button"
                onClick={() => setHomeView('dj')}
                className={`rounded-lg px-3 py-1.5 text-xs font-bold ${homeView === 'dj' ? 'bg-fuchsia-600 text-white' : 'text-slate-300 hover:text-white'}`}
              >
                DJ
              </button>
            </div>
          </div>
        </div>

        <main className="flex-1">
          {homeView === 'dj' ? (
            <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
              <TalentDashboard
                session={session}
                requests={requests}
                onStartSession={handleStartSession}
                onEndSession={handleEndSession}
                onCloseout={handleCloseout}
                onTriage={handleTriageRequest}
                onFulfill={handleFulfillRequest}
                onHide={handleHideRequest}
                onRemove={handleRemoveRequest}
                previewMode={isDemoMode}
              />
            </motion.div>
          ) : (
            <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
              <PatronView
                session={session}
                requests={requests}
                performers={bState.performers || []}
                gigId={routeGigId || 'local-demo'}
                onCreateRequest={handleCreateRequest}
                onBoostRequest={handleBoostRequest}
                onReconcilePendingAction={handleReconcilePendingAction}
                onReportContent={handleReportContent}
                onBlockFoundation={handleBlockFoundation}
                onSupportContact={handleSupportContact}
                onDataDeletionPlaceholder={handleDataDeletionPlaceholder}
                previewMode={isDemoMode}
              />
            </motion.div>
          )}
        </main>

        {operatorControlsEnabled && (
          <div className="fixed bottom-4 right-4 z-50">
            <button
              type="button"
              onClick={() => setDataMode((mode) => mode === 'demo' ? 'live' : 'demo')}
              className="rounded-full border border-white/15 bg-slate-900/95 px-4 py-2 text-xs font-bold text-white shadow-xl"
              title="Switch data source"
            >
              {isDemoMode ? 'Demo Data On' : 'Live Data On'}
            </button>
          </div>
        )}
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
            onReportContent={handleReportContent}
            onBlockFoundation={handleBlockFoundation}
            onSupportContact={handleSupportContact}
            onDataDeletionPlaceholder={handleDataDeletionPlaceholder}
            previewMode={isDemoMode}
          />
        </motion.div>
      </main>
    </div>
  );
}
