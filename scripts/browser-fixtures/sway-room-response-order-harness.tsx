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
  useEffect(() => {
    // Vite compiles these functions together with their helpers. Serializing a
    // nested function from the Node/tsx test left an undefined __name helper in
    // the page, making a network error look like a failed access-denial test.
    const originalFetch = window.fetch;
    const bodyListeners = new Set<EventListener>();
    const installProbe = (event: Event) => {
      const kind = (event as CustomEvent<{ kind: string }>).detail.kind;
      if (kind !== 'access-headers-before-body' && kind !== 'expired-body-response') {
        throw new Error('Unsupported synthetic response probe.');
      }
      const counters = document.documentElement.dataset;
      counters.responseOrderKind = kind;
      counters.responseOrderFetches = '0';
      counters.responseOrderBodies = '0';
      counters.responseOrderStatusReads = '0';
      window.fetch = async () => {
        counters.responseOrderFetches = String(Number(counters.responseOrderFetches) + 1);
        return {
          ok: kind !== 'access-headers-before-body',
          get status() {
            counters.responseOrderStatusReads = String(Number(counters.responseOrderStatusReads) + 1);
            return kind === 'access-headers-before-body' ? 403 : 200;
          },
          headers: new Headers(),
          json: () => {
            counters.responseOrderBodies = String(Number(counters.responseOrderBodies) + 1);
            // Ignore abort deliberately: the hook itself must reject a late body.
            return new Promise(resolve => {
              const receive: EventListener = (bodyEvent) => {
                bodyListeners.delete(receive);
                resolve((bodyEvent as CustomEvent).detail);
              };
              bodyListeners.add(receive);
              window.addEventListener('sway:test:body', receive, { once: true });
            });
          }
        } as Response;
      };
      window.dispatchEvent(new Event('re-fetch-state'));
    };
    window.addEventListener('sway:test:fetch-probe', installProbe);
    return () => {
      window.removeEventListener('sway:test:fetch-probe', installProbe);
      window.fetch = originalFetch;
      for (const listener of bodyListeners) window.removeEventListener('sway:test:body', listener);
      bodyListeners.clear();
    };
  }, []);
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
