import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useSwayState } from '../../src/shells/shared';

function Fixture() {
  const [account, setAccount] = useState('A');
  const [renderCount, setRenderCount] = useState(0);
  const callbacks = useRef<Record<string, () => void>>({});
  const { bState, setBState, isLoading, roomLookup, roomActionsBlocked } = useSwayState({
    statePath: '/api/state/11111111-1111-4111-8111-111111111111',
    accessScope: account
  });
  const capture = () => {
    const state = bState;
    const owner = account;
    callbacks.current[owner] = () => setBState({
      ...state, session: { ...state.session, talentName: `STALE_${owner}` }
    });
  };
  return <main>
    <button onClick={() => setAccount('A')}>Account A</button>
    <button onClick={() => setAccount('B')}>Account B</button>
    <button onClick={capture}>Capture callback</button>
    <button onClick={() => callbacks.current.A?.()}>Apply A callback</button>
    <button onClick={() => callbacks.current.B?.()}>Apply B callback</button>
    <button onClick={() => setRenderCount(value => value + 1)}>Unrelated render</button>
    <output data-testid="scope-state">{JSON.stringify({
      account, renderCount, loading: isLoading, lookup: roomLookup.status,
      blocked: roomActionsBlocked, status: bState.session.status,
      name: bState.session.talentName, titles: bState.requests.map(request => request.title)
    })}</output>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
