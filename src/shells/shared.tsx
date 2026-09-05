import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Flame } from 'lucide-react';
import { isDemoModeEnabled, loadDemoBackendState } from '../demo-mode';
import { BackendState, GigSession } from '../types';
import { buildPatronRequestHeaders } from '../patron-device';
import {
  getDiscoveryEntryPath,
  getEffectiveDiscoveryChannel,
  getOrCreateDiscoveryJourneyId
} from './discoveryAttribution';

export const emptySession: GigSession = {
  status: 'inactive',
  startedAt: null,
  autoCloseoutAt: null,
  closedAt: null,
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
  tipsEnabled: false,
  settlementMode: 'unavailable',
  paymentEnvironment: 'unavailable',
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
        <p className="text-xs text-slate-400 font-mono">Opening live room...</p>
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
  // A distinct scope prevents late responses from crossing rooms, including A -> B -> A.
  const scope = useMemo(() => ({ path: statePath, sequence: 0, pending: false, controller: null as AbortController | null, discoveryRecorded: false }), [statePath]);
  const activeScope = useRef<typeof scope | null>(scope);
  useLayoutEffect(() => {
    activeScope.current = scope;
    return () => {
      if (activeScope.current === scope) activeScope.current = null;
      scope.controller?.abort();
      scope.pending = false;
    };
  }, [scope]);
  const initialLookup: RoomLookupState = { status: statePath === '/api/state' ? 'global' : 'missing', message: null };
  const [snapshot, setSnapshot] = useState({ scope, state: initialState, loading: Boolean(statePath), lookup: initialLookup });
  const current = snapshot.scope === scope ? snapshot : { scope, state: initialState, loading: Boolean(statePath), lookup: initialLookup };
  const matchesRoom = useCallback((data: BackendState) => {
    const expected = scope.path?.startsWith('/api/state/') ? scope.path.slice('/api/state/'.length) : null;
    return !expected || data.activeGigId === expected;
  }, [scope]);
  const setBState: React.Dispatch<React.SetStateAction<BackendState>> = useCallback((update) => {
    if (activeScope.current !== scope) return;
    // A confirmed mutation invalidates reads that started before its result arrived.
    scope.sequence += 1;
    scope.pending = false;
    scope.controller?.abort();
    setSnapshot(previous => {
      if (activeScope.current !== scope) return previous;
      const prior = previous.scope === scope ? previous.state : initialState;
      const next = normalizeBackendState(typeof update === 'function' ? update(prior) : update);
      if (!matchesRoom(next)) return previous;
      return { scope, state: next, loading: false, lookup: { status: next.activeGigId ? 'active' : 'global', message: null } };
    });
  }, [scope, matchesRoom]);
  useEffect(() => {
    let disposed = false;
    const stillCurrent = (sequence: number) => !disposed && activeScope.current === scope && scope.sequence === sequence;
    const clear = (status: RoomLookupStatus, message: string | null) => setSnapshot({ scope, state: initialState, loading: false, lookup: { status, message } });
    const fetchState = async (force = false) => {
      if (scope.pending && !force) return;
      if (!scope.path) { clear('missing', null); return; }
      const sequence = ++scope.sequence;
      scope.controller?.abort();
      const controller = new AbortController();
      scope.controller = controller;
      scope.pending = true;
      const deadline = window.setTimeout(() => {
        if (!stillCurrent(sequence)) return;
        controller.abort();
        scope.pending = false;
        setSnapshot(previous => ({ scope, state: previous.scope === scope ? previous.state : initialState, loading: false, lookup: { status: 'error', message: 'The connection is taking too long. Retry to reconnect.' } }));
      }, 15000);
      try {
        if (isDemoModeEnabled()) {
          const data = await loadDemoBackendState();
          if (stillCurrent(sequence)) setSnapshot({ scope, state: normalizeBackendState(data), loading: false, lookup: { status: scope.path === '/api/state' ? 'global' : 'active', message: null } });
          return;
        }
        const response = await fetch(scope.path, {
          signal: controller.signal,
          headers: scope.path === '/api/state' ? undefined : {
            ...buildPatronRequestHeaders(),
            ...(!scope.discoveryRecorded ? {
              'x-sway-discovery-journey': getOrCreateDiscoveryJourneyId(),
              'x-sway-discovery-source': getEffectiveDiscoveryChannel(),
              'x-sway-discovery-entry-path': getDiscoveryEntryPath(),
              'x-sway-discovery-entry-once': '1'
            } : {})
          }
        });
        if (!stillCurrent(sequence)) return;
        if ([401, 403, 404, 410].includes(response.status)) {
          const data = await response.json().catch(() => null);
          if (!stillCurrent(sequence)) return;
          clear(data?.room_lookup === 'ended' ? 'ended' : 'missing', response.status === 401 || response.status === 403 ? 'Your access changed. Sign in again to continue.' : 'This room is not available.');
          return;
        }
        if (!response.ok) throw new Error('Room temporarily unavailable');
        const data = await response.json();
        if (!stillCurrent(sequence)) return;
        const normalized = normalizeBackendState(data);
        if (!matchesRoom(normalized)) throw new Error('Room response did not match the selected room');
        if (data?.room_lookup === 'ended') { clear('ended', ENDED_LIVE_ROOM_COPY); return; }
        setSnapshot({ scope, state: normalized, loading: false, lookup: { status: data?.room_lookup === 'active' ? 'active' : 'global', message: null } });
        if (response.headers.get('x-sway-discovery-recorded') === '1') scope.discoveryRecorded = true;
      } catch (error) {
        if (!stillCurrent(sequence) || controller.signal.aborted) return;
        console.warn('Unable to sync server state:', error);
        setSnapshot(previous => ({ scope, state: previous.scope === scope ? previous.state : initialState, loading: false, lookup: { status: 'error', message: 'Connection interrupted. Reconnecting to your live room.' } }));
      } finally {
        window.clearTimeout(deadline);
        if (stillCurrent(sequence)) scope.pending = false;
      }
    };
    void fetchState();
    const interval = scope.path && !isDemoModeEnabled() ? setInterval(() => { void fetchState(); }, 4000) : null;
    const handleForceSync = () => { void fetchState(true); };
    window.addEventListener('re-fetch-state', handleForceSync);
    return () => {
      disposed = true;
      scope.controller?.abort();
      if (interval) clearInterval(interval);
      window.removeEventListener('re-fetch-state', handleForceSync);
    };
  }, [scope, matchesRoom]);
  return { bState: current.state, setBState, isLoading: current.loading, roomLookup: current.lookup,
    roomActionsBlocked: Boolean(statePath) && (current.loading || !['active', 'global'].includes(current.lookup.status)) };
}

export async function postJson(url: string, body?: unknown) {
  const response = await fetch(url, {
    method: 'POST',
    headers: buildPatronRequestHeaders(Boolean(body)),
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
