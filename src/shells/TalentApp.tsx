import { useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import { motion } from 'motion/react';
import SplitViewShell from '../components/SplitViewShell';
import TalentDashboard from '../components/TalentDashboard';
import TalentLoginCard from '../components/TalentLoginCard';
import VictoryScreen from '../components/VictoryScreen';
import { DemoModeBanner, isDemoModeEnabled } from '../demo-mode';
import type { ActiveRoomSummary } from '../types';
import { LoadingState, postJson, useSwayState } from './shared';

function isTalentLogin(pathname: string) {
  return pathname === '/talent/login';
}

type TalentPerformerProfile = {
  performer_id: string;
  display_name: string;
  handle: string;
  owner_user_id: string;
} | null;

export default function TalentApp() {
  const demoMode = isDemoModeEnabled();
  const [activeRooms, setActiveRooms] = useState<ActiveRoomSummary[]>([]);
  const [selectedGigId, setSelectedGigId] = useState<string | null>(null);
  const [performerProfile, setPerformerProfile] = useState<TalentPerformerProfile>(null);
  const statePath = selectedGigId ? `/api/state/${selectedGigId}` : '/api/state';
  const { bState, isLoading, setBState } = useSwayState({ statePath });

  const refreshPerformerProfile = async () => {
    if (demoMode) {
      setPerformerProfile(null);
      return;
    }

    try {
      const response = await fetch('/api/state');
      if (!response.ok) {
        setPerformerProfile(null);
        return;
      }
      const data = await response.json();
      setPerformerProfile(data?.performerProfile ?? null);
    } catch (error) {
      console.warn('Unable to load performer profile:', error);
      setPerformerProfile(null);
    }
  };

  const refreshActiveRooms = async () => {
    if (demoMode) {
      const demoRooms = bState.activeGigId && bState.session.status === 'active'
        ? [{
            gigId: bState.activeGigId,
            performerName: bState.session.talentName || 'Sway Performer',
            talentRole: bState.session.talentRole,
            routePath: `/g/${bState.activeGigId}`,
            startedAt: null,
            requestCount: bState.requests.filter((request) => !request.hidden && !request.removed).length
          }]
        : [];
      setActiveRooms(demoRooms);
      return;
    }

    try {
      const response = await fetch('/api/talent/active-rooms');
      if (!response.ok) return;
      const data = await response.json();
      setActiveRooms(Array.isArray(data.rooms) ? data.rooms : []);
    } catch (error) {
      console.warn('Unable to load active room summaries:', error);
    }
  };

  useEffect(() => {
    void refreshActiveRooms();
  }, [demoMode, bState.activeGigId, bState.requests.length, bState.session.status]);

  useEffect(() => {
    void refreshPerformerProfile();
  }, [demoMode]);

  useEffect(() => {
    if (selectedGigId && activeRooms.some((room) => room.gigId === selectedGigId)) return;
    if (bState.activeGigId && activeRooms.some((room) => room.gigId === bState.activeGigId)) {
      setSelectedGigId(bState.activeGigId);
      return;
    }
    setSelectedGigId(activeRooms[0]?.gigId ?? null);
  }, [activeRooms, bState.activeGigId, selectedGigId]);

  const rejectDemoMutation = async () => {
    throw new Error('Demo data is read-only. No backend mutation was sent.');
  };

  const handleStartSession = async (setupData: {
    talentName: string;
    talentRole: 'DJ' | 'Bartender' | 'Performer';
    feeType: 'talent' | 'patron';
    minimumTip: number;
  }) => {
    if (demoMode) return rejectDemoMutation();
    try {
      const performerIdentityName =
        performerProfile?.display_name?.trim()
        || performerProfile?.handle?.trim()
        || '';
      const data = await postJson('/api/session/start', {
        ...setupData,
        talentName: setupData.talentName.trim() || performerIdentityName
      });
      setBState(data.state);
      setSelectedGigId(data.state?.activeGigId ?? null);
      await refreshActiveRooms();
    } catch (e) {
      console.error(e);
    }
  };

  const handleEndSession = async () => {
    if (demoMode) return rejectDemoMutation();
    try {
      const data = await postJson('/api/session/end', { gig_id: selectedGigId ?? bState.activeGigId });
      setBState(data.state);
      await refreshActiveRooms();
    } catch (e) {
      console.error(e);
    }
  };

  const handleCloseout = async () => {
    if (demoMode) return rejectDemoMutation();
    try {
      const data = await postJson('/api/session/closeout', { gig_id: selectedGigId ?? bState.activeGigId });
      setBState(data.state);
      await refreshActiveRooms();
    } catch (e) {
      console.error(e);
    }
  };

  const handleTriageRequest = async (requestId: string, action: 'approve' | 'deny') => {
    if (demoMode) return rejectDemoMutation();
    try {
      const data = await postJson('/api/request/triage', { requestId, action });
      setBState(data.state);
      await refreshActiveRooms();
    } catch (e) {
      console.error(e);
    }
  };

  const handleFulfillRequest = async (requestId: string) => {
    if (demoMode) return rejectDemoMutation();
    try {
      const data = await postJson('/api/request/fulfill', { requestId });
      setBState(data.state);
      await refreshActiveRooms();
    } catch (e) {
      console.error(e);
    }
  };

  const handleHideRequest = async (requestId: string) => {
    if (demoMode) return rejectDemoMutation();
    try {
      const data = await postJson('/api/moderation/hide', {
        requestId,
        reason: 'Performer hid this request from the live queue.'
      });
      setBState(data.state);
      await refreshActiveRooms();
    } catch (e) {
      console.error(e);
    }
  };

  const handleRemoveRequest = async (requestId: string) => {
    if (demoMode) return rejectDemoMutation();
    try {
      const data = await postJson('/api/moderation/remove', {
        requestId,
        reason: 'Performer removed this request from the live queue.'
      });
      setBState(data.state);
      await refreshActiveRooms();
    } catch (e) {
      console.error(e);
    }
  };

  const resetInactiveSession = () => {
    handleStartSession({
      talentName: 'Sway Performer',
      talentRole: 'DJ',
      feeType: 'patron',
      minimumTip: 5
    });
  };

  if (isTalentLogin(window.location.pathname)) {
    return <TalentLoginCard />;
  }

  if (isLoading) return <LoadingState />;

  const { session, requests } = bState;
  const { activeGigId } = bState;
  const performerIdentityName =
    performerProfile?.display_name?.trim()
    || performerProfile?.handle?.trim()
    || session.talentName
    || 'Unassigned performer';
  const pendingCount = requests.filter((request) => request.status === 'hold' && !request.hidden && !request.removed).length;
  const approvedCount = requests.filter((request) => request.status === 'approved' && !request.hidden && !request.removed).length;

  if (session.status === 'closed') {
    return <VictoryScreen session={session} onRestart={resetInactiveSession} />;
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100">
      <DemoModeBanner />
      <div className="border-b border-white/10 bg-slate-900 px-4 py-3">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="rounded bg-fuchsia-500/10 p-1 text-fuchsia-400">
              <Users className="h-4 w-4" />
            </div>
            <div>
              <span className="font-display text-xs font-black uppercase tracking-widest text-white">Sway Talent</span>
              <p className="text-[9px] text-slate-400">Manage Pending, Approved, and Playing requests</p>
            </div>
          </div>
          <DemoModeBanner compact />
        </div>
      </div>

      <main className="flex-1">
        <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
          <SplitViewShell
            title={session.status === 'inactive' ? 'Sway to Play' : 'Performer Console'}
            eyebrow={session.status === 'inactive' ? `Welcome, ${performerIdentityName}` : 'Live room'}
            primaryLabel={session.status === 'inactive'
              ? 'Start a live room and let the crowd send Requests, Tips, and Boosts'
              : 'Now Playing, Pending Requests, Approved Queue, and Controls'}
            secondaryLabel={session.status === 'inactive' ? 'Performer profile' : 'Room State'}
            isEmpty={false}
            emptyState={
              <div className="rounded-2xl border border-dashed border-white/10 bg-slate-900/40 p-8 text-center">
                <p className="text-sm font-bold text-white">Sway to Play</p>
                <p className="mt-2 text-xs text-slate-400">Start a live room and let the crowd send Requests, Tips, and Boosts.</p>
              </div>
            }
            primary={
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
                activeGigId={activeGigId}
                activeRooms={activeRooms}
                selectedGigId={selectedGigId}
                onSelectGigId={setSelectedGigId}
                previewMode={demoMode}
                performerProfile={performerProfile}
              />
            }
            secondary={
              <div className="space-y-4 text-sm">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Session</p>
                  <p className="mt-1 font-bold text-white">{session.status === 'inactive' ? performerIdentityName : (session.talentName || performerIdentityName)}</p>
                  <p className="text-xs text-slate-400">
                    {session.status === 'inactive'
                      ? `Ready to start live room${performerProfile?.handle ? ` @${performerProfile.handle}` : ''}`
                      : `${session.status} / ${session.talentRole}`}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-lg bg-slate-950 p-3">
                    <p className="text-slate-500">Pending</p>
                    <p className="mt-1 font-mono text-lg font-black text-amber-300">{pendingCount}</p>
                  </div>
                  <div className="rounded-lg bg-slate-950 p-3">
                    <p className="text-slate-500">Approved</p>
                    <p className="mt-1 font-mono text-lg font-black text-cyan-300">{approvedCount}</p>
                  </div>
                </div>
                <div className="rounded-lg border border-white/10 bg-slate-950 p-3">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Window</p>
                  <p className="mt-2 font-bold text-white">{session.requestsOpen ? 'Open' : 'Closed'}</p>
                  <p className="text-xs text-slate-400">{session.requestWindowLabel || 'Manual request window'}</p>
                </div>
              </div>
            }
          />
        </motion.div>
      </main>
    </div>
  );
}
