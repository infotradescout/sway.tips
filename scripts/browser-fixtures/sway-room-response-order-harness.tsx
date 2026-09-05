import React, { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { useSwayState } from '../../src/shells/shared';
import type { BackendState } from '../../src/types';

function RoomResponseOrderHarness() {
  const view = useSwayState({ statePath: '/api/state/room-A' });
  const delayed = useRef<typeof view.setBState | null>(null);
  useEffect(() => {
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<{ state: BackendState; delayed: boolean }>).detail;
      if (detail.delayed) delayed.current?.(detail.state);
      else view.setBState(detail.state);
    };
    window.addEventListener('sway:test:response', receive);
    return () => window.removeEventListener('sway:test:response', receive);
  }, [view.setBState]);
  return <main>
    <h1>Room response order test</h1>
    <p>Synthetic data only. This is not the public application.</p>
    <button onClick={() => { delayed.current = view.setBState; }}>Start delayed action</button>
    <button onClick={() => window.dispatchEvent(new Event('re-fetch-state'))}>Refresh</button>
    <output data-testid="response-view">{JSON.stringify({
      shown: view.bState.activeGigId,
      title: view.bState.requests[0]?.title,
      status: view.roomLookup.status,
      session: view.bState.session.status,
      blocked: view.roomActionsBlocked,
      loading: view.isLoading
    })}</output>
  </main>;
}

createRoot(document.getElementById('root')!).render(<RoomResponseOrderHarness />);
