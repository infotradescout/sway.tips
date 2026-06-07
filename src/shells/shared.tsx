import React, { useEffect, useState } from 'react';
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
  performers: []
};

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

export function useSwayState() {
  const [bState, setBState] = useState<BackendState>(initialState);
  const [isLoading, setIsLoading] = useState(true);

  const fetchState = async () => {
    if (isDemoModeEnabled()) {
      try {
        const demoState = await loadDemoBackendState();
        if (demoState) setBState(demoState);
      } catch (e) {
        console.warn('Unable to load demo fixture state:', e);
      } finally {
        setIsLoading(false);
      }
      return;
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
    fetchState();

    if (isDemoModeEnabled()) return;

    const interval = setInterval(fetchState, 4000);
    const handleForceSync = () => fetchState();
    window.addEventListener('re-fetch-state', handleForceSync);

    return () => {
      clearInterval(interval);
      window.removeEventListener('re-fetch-state', handleForceSync);
    };
  }, []);

  return { bState, isLoading, setBState };
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
