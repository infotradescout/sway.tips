import { useEffect, useRef, useState } from 'react';
import type { GigSession, RequestItem } from '../types';
import PerformerRoomSetup, { type PerformerRoomSetupData } from './PerformerRoomSetup';
import VictoryScreen from './VictoryScreen';

type RestartProfile = {
  money_actions_ready?: boolean;
  test_mode_platform_balance_allowed?: boolean;
} | null;

type PaymentAvailability = {
  mode: 'test' | 'live' | 'unavailable';
  testBalanceEnabled: boolean;
};

const UNAVAILABLE: PaymentAvailability = { mode: 'unavailable', testBalanceEnabled: false };

export default function PerformerRoomRestart({
  session,
  requests,
  performerName,
  performerEmailVerified,
  performerProfile,
  previewMode,
  roomActionsBlocked,
  onStartSession
}: {
  session: GigSession;
  requests: RequestItem[];
  performerName: string;
  performerEmailVerified: boolean;
  performerProfile: RestartProfile;
  previewMode: boolean;
  roomActionsBlocked: boolean;
  onStartSession: (data: PerformerRoomSetupData) => Promise<void>;
}) {
  const [showSetup, setShowSetup] = useState(false);
  const [setupOpened, setSetupOpened] = useState(false);
  const [availability, setAvailability] = useState<PaymentAvailability>(UNAVAILABLE);
  const [configError, setConfigError] = useState(false);
  const [configRevision, setConfigRevision] = useState(0);
  const [starting, setStarting] = useState(false);
  const startPending = useRef(false);
  const mounted = useRef(false);
  const viewRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (setupOpened) viewRef.current?.focus();
  }, [showSetup, setupOpened]);

  useEffect(() => {
    if (!setupOpened || previewMode) return;
    const controller = new AbortController();
    let current = true;
    setAvailability(UNAVAILABLE);
    setConfigError(false);
    const timeout = setTimeout(() => {
      if (!current) return;
      setConfigError(true);
      controller.abort();
    }, 15_000);
    void (async () => {
      try {
        const response = await fetch('/api/payment/config', { cache: 'no-store', signal: controller.signal });
        const data = await response.json();
        if (!current || controller.signal.aborted) return;
        if (!response.ok || !data || typeof data !== 'object') throw new Error('Payment availability could not be checked.');
        setAvailability({
          mode: data.liveRoomMoneyEnabled === true && (data.mode === 'test' || data.mode === 'live')
            ? data.mode : 'unavailable',
          testBalanceEnabled: data.mode === 'test' && data.testModePlatformBalanceEnabled === true
        });
      } catch {
        if (current && !controller.signal.aborted) setConfigError(true);
      } finally {
        clearTimeout(timeout);
      }
    })();
    return () => { current = false; clearTimeout(timeout); controller.abort(); };
  }, [setupOpened, previewMode, configRevision]);

  const moneyReady = !previewMode && (availability.mode === 'test'
    ? Boolean(performerProfile?.money_actions_ready)
      || (availability.testBalanceEnabled && performerProfile?.test_mode_platform_balance_allowed === true)
    : availability.mode === 'live' && Boolean(performerProfile?.money_actions_ready));
  const blocked = previewMode || roomActionsBlocked || !performerProfile;

  const startNextRoom = async (data: PerformerRoomSetupData) => {
    if (blocked) throw new Error('Reconnect to your performer account before creating a room.');
    if (!performerEmailVerified) throw new Error('Verify your email before creating a room.');
    if (data.paymentsEnabled && !moneyReady) throw new Error('Paid requests are not available. Review pricing before creating the room.');
    if (startPending.current) throw new Error('A room is already being created. Wait for its result.');
    startPending.current = true;
    setStarting(true);
    try {
      // Reuse the owner-scoped, duplicate-protected start in the performer shell.
      // Keep the completed room and its recap until that start is confirmed.
      await onStartSession(data);
    } finally {
      startPending.current = false;
      if (mounted.current) setStarting(false);
    }
  };

  return (
    <div ref={viewRef} tabIndex={-1} data-sway-room-restart="true" className="min-h-screen bg-slate-950 text-white outline-none">
      <div hidden={showSetup}>
        <VictoryScreen session={session} requests={requests} onRestart={() => {
          setSetupOpened(true);
          setShowSetup(true);
        }} />
      </div>
      {setupOpened ? (
        <div hidden={!showSetup} className="px-3 py-6 sm:px-6">
          <div className="mx-auto mb-4 w-full max-w-2xl">
            <button type="button" disabled={starting} onClick={() => setShowSetup(false)} className="min-h-11 rounded-xl border border-white/20 px-4 text-sm font-bold disabled:opacity-50">Back to night recap</button>
            <h1 className="mt-4 text-2xl font-bold">Set up your next room</h1>
            <p className="mt-2 text-sm text-slate-300">Your completed room is unchanged. Review these settings before creating another room.</p>
            {blocked ? <div role="alert" className="mt-3 rounded-xl border border-amber-500/30 p-4 text-sm">
              <p>{previewMode ? 'This preview is read-only. No room will be created.' : 'Reconnect to your performer account before creating a room.'}</p>
              {!previewMode ? <><button type="button" onClick={() => window.dispatchEvent(new Event('re-fetch-state'))} className="mt-3 min-h-11 rounded-lg border border-white/20 px-3">Retry connection</button><a href="/talent/profile" className="ml-3 underline">Open profile</a></> : null}
            </div> : null}
            {configError ? <div role="alert" className="mt-3 rounded-xl border border-amber-500/30 p-4 text-sm">
              <p>Payment availability could not be checked. Paid requests stay off until it is confirmed.</p>
              <button type="button" disabled={starting} onClick={() => setConfigRevision((revision) => revision + 1)} className="mt-3 min-h-11 rounded-lg border border-white/20 px-3 disabled:opacity-50">Retry payment availability</button>
            </div> : null}
          </div>
          <fieldset disabled={blocked} className="min-w-0">
            <PerformerRoomSetup
              performerName={performerName}
              talentRole={session.talentRole === 'DJ' ? 'DJ' : 'Performer'}
              performerEmailVerified={performerEmailVerified && !blocked}
              payoutReady={moneyReady}
              paymentMode={availability.mode}
              onStartSession={startNextRoom}
            />
          </fieldset>
        </div>
      ) : null}
    </div>
  );
}
