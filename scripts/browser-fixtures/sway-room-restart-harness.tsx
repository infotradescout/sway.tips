import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import PerformerRoomRestart from '../../src/components/PerformerRoomRestart';
import { emptySession, postJson, useSwayState } from '../../src/shells/shared';
import '../../src/index.css';

// Synthetic browser fixture. The actual room-state hook, recap and setup are
// rendered; loopback HTTP replies are controlled by the browser test.
function RestartHarness() {
  const view = useSwayState({ statePath: '/api/state/restart-fixture' });
  const [created, setCreated] = useState(false);
  if (created) return <h1>New room confirmed</h1>;
  const restartBlocked = view.roomActionsBlocked && view.roomLookup.status !== 'ended';
  return <>
    <output data-testid="restart-state">{JSON.stringify({
      status: view.roomLookup.status, closed: view.bState.session.status === 'closed',
      oldRoomBlocked: view.roomActionsBlocked, restartBlocked
    })}</output>
    {view.bState.session.status !== 'closed' ? <button type="button" disabled={view.isLoading} onClick={() => view.setBState({
      ...view.bState, session: { ...emptySession, ...view.bState.session, status: 'closed', closedAt: '2026-09-06T00:00:00.000Z' }
    })}>Confirm fixture closeout</button> : <PerformerRoomRestart
      session={view.bState.session}
      requests={view.bState.requests}
      performerName="@restart-fixture"
      performerEmailVerified={true}
      performerProfile={{ money_actions_ready: false, test_mode_platform_balance_allowed: false }}
      previewMode={false}
      roomActionsBlocked={restartBlocked}
      onStartSession={async data => {
        const response = await postJson('/api/session/start', data);
        if (response?.state?.activeGigId !== data.gig_id) throw new Error('Created room could not be confirmed.');
        setCreated(true);
      }}
    />}
  </>;
}
createRoot(document.getElementById('root')!).render(<RestartHarness />);
