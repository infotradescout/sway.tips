import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import TalentApp from '../../src/shells/TalentApp';
import { useSwayState } from '../../src/shells/shared';
function HookHarness() {
  const [room, setRoom] = useState('room-A');
  const state = useSwayState({ statePath: room ? '/api/state/' + room : null });
  return <main>
    <button onClick={() => setRoom('room-A')}>Room A</button>
    <button onClick={() => setRoom('room-B')}>Room B</button>
    <button onClick={() => setRoom('')}>Clear room</button>
    <button onClick={() => window.dispatchEvent(new Event('re-fetch-state'))}>Refresh</button>
    <output data-testid="room-state">{JSON.stringify({ selected: room, shown: state.bState.activeGigId, status: state.roomLookup.status, requests: state.bState.requests, loading: state.isLoading })}</output>
  </main>;
}
const mode = new URLSearchParams(window.location.search).get('mode') || 'hook';
if (mode !== 'hook') window.history.replaceState({}, '', mode === 'library' ? '/talent/music' : '/talent/gigs');
createRoot(document.getElementById('root')!).render(mode === 'hook' ? <HookHarness /> : <TalentApp />);
