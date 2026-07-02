import React, { useEffect, useState } from 'react';
import { Flame } from 'lucide-react';
import { isDemoModeEnabled, loadDemoBackendState } from '../demo-mode';
import { BackendState, GigSession } from '../types';

export const emptySession: GigSession = {
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
  searchScope: 'library',
  paymentsEnabled: true,
  totals: {
    totalTips: 0,
    accumulatedFees: 0,
    totalCount: 0,
    topRequest: 'None yet'
  }
};

const initialState: BackendState = {
  session: emptySession,
  requests: [],
  performers: [],
  activeGigId: null
};

export const ENDED_LIVE_ROOM_COPY = 'This live room session has ended. Thank you for supporting the performer!';

type RoomLookupStatus = 'global' | 'active' | 'missing' | 'ended' | 'error';

type RoomLookupState = {
  status: RoomLookupStatus;
  message: string | null;
};

function normalizeBackendState(data: Partial<BackendState> | null | undefined): BackendState {
  return {
    session: data?.session ?? emptySession,
    requests: Array.isArray(data?.requests) ? data.requests : [],
    performers: Array.isArray(data?.performers) ? data.performers : [],
    activeGigId: data?.activeGigId ?? null
  };
}

export function LoadingState() {
  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center">
      <div className="text-center space-y-3">
        <div className="w-10 h-10 border-2 border-fuchsia-500 border-t-transparent rounded-full animate-spin mx-auto" />
        <p className="text-xs text-slate-400 font-mono">Synchronizing Sway live ledger...</p>
      </div>
    </div>
  );
}

export function ShellMessage({
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

export function JoinLiveRoomRecovery({
  onReturnHomeClick
}: {
  onReturnHomeClick?: () => void;
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

export function EndedLiveRoomRecovery() {
  return (
    <div className="mx-auto flex w-full max-w-xl items-center px-4 py-10">
      <div className="w-full rounded-3xl border border-white/10 bg-slate-900/80 p-6 shadow-2xl">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-cyan-500/25 bg-cyan-500/10 text-cyan-300">
          <Flame className="h-5 w-5" />
        </div>
        <h1 className="font-display text-2xl font-black text-white">Live Room Ended</h1>
        <p className="mt-3 text-sm leading-6 text-slate-300">
          {ENDED_LIVE_ROOM_COPY}
        </p>
        <a
          className="mt-6 inline-flex min-h-11 items-center justify-center rounded-xl bg-fuchsia-600 px-4 py-3 text-sm font-bold text-white hover:bg-fuchsia-500"
          href="https://sway.tips/"
        >
          Return to Sway home
        </a>
      </div>
    </div>
  );
}

export function useSwayState(options?: {
  statePath?: string | null;
}) {
  const statePath = options?.statePath === undefined ? '/api/state' : options.statePath;
  const [bState, setBState] = useState<BackendState>(initialState);
  const [isLoading, setIsLoading] = useState(true);
  const [roomLookup, setRoomLookup] = useState<RoomLookupState>({
    status: statePath === '/api/state' ? 'global' : 'missing',
    message: null
  });

  const fetchState = async () => {
    if (!statePath) {
      setBState(initialState);
      setRoomLookup({ status: 'missing', message: null });
      setIsLoading(false);
      return;
    }

    if (isDemoModeEnabled()) {
      try {
        const demoState = await loadDemoBackendState();
        if (demoState) {
          setBState(demoState);
          setRoomLookup({ status: statePath === '/api/state' ? 'global' : 'active', message: null });
        }
      } catch (e) {
        console.warn('Unable to load demo fixture state:', e);
      } finally {
        setIsLoading(false);
      }
      return;
    }

    try {
      const response = statePath === '/api/state'
        ? await fetch('/api/state')
        : await fetch(statePath);
      const data = await response.json();

      if (!response.ok) {
        setBState(initialState);
        setRoomLookup({
          status: data?.room_lookup === 'ended' ? 'ended' : 'missing',
          message: typeof data?.message === 'string'
            ? data.message
            : (typeof data?.error === 'string' ? data.error : null)
        });
        return;
      }

      setBState(normalizeBackendState(data));
      setRoomLookup({
        status: data?.room_lookup === 'active' ? 'active' : 'global',
        message: typeof data?.message === 'string' ? data.message : null
      });
    } catch (e) {
      console.warn('Unable to sync server state:', e);
      setBState(initialState);
      setRoomLookup({ status: 'error', message: 'Unable to sync live room state right now.' });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchState();

    if (isDemoModeEnabled()) return;

    const interval = setInterval(fetchState, 4000);
    const handleForceSync = () => fetchState();
    window.addEventListener('re-fetch-state', handleForceSync);

    return () => {
      clearInterval(interval);
      window.removeEventListener('re-fetch-state', handleForceSync);
    };
  }, [statePath]);

  return { bState, isLoading, setBState, roomLookup };
}

export async function postJson(url: string, body?: unknown) {
  const response = await fetch(url, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json();
  if (!response.ok) {
    throw Object.assign(new Error(data?.error || 'Backend request failed.'), {
      status: response.status,
      body: data
    });
  }
  return data;
}
