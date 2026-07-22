import { useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import { motion } from 'motion/react';
import SplitViewShell from '../components/SplitViewShell';
import TalentDashboard from '../components/TalentDashboard';
import type { PerformerRoomSetupData } from '../components/PerformerRoomSetup';
import TalentLoginCard from '../components/TalentLoginCard';
import TalentSignupCard from '../components/TalentSignupCard';
import TalentInviteAcceptCard from '../components/TalentInviteAcceptCard';
import TalentFileConnectCard from '../components/TalentFileConnectCard';
import PerformerRightsReviewQueue from '../components/PerformerRightsReviewQueue';
import VictoryScreen from '../components/VictoryScreen';
import { DemoModeBanner, isDemoModeEnabled } from '../demo-mode';
import type { ActiveRoomSummary } from '../types';
import { LoadingState, postJson, useSwayState } from './shared';

function isTalentLogin(pathname: string) {
  return pathname === '/talent/login';
}

function isTalentSignup(pathname: string) {
  return pathname === '/talent/signup';
}

function isTalentInvite(pathname: string) {
  return pathname === '/talent/invite';
}

function isTalentClaim(pathname: string) {
  return pathname === '/talent/claim';
}

function isTalentFileConnect(pathname: string) {
  return pathname === '/talent/connect/files';
}

function isTalentRightsReview(pathname: string) {
  return pathname === '/talent/releases/review';
}

type TalentPerformerProfile = {
  performer_id: string;
  display_name: string;
  handle: string | null;
  owner_user_id: string;
  email_verified_at: string | null;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  stripe_connected_account_id: string | null;
} | null;

export default function TalentApp() {
  const pathname = typeof window === 'undefined' ? '/talent' : window.location.pathname;
  const isAuthEntryRoute = isTalentLogin(pathname)
    || isTalentSignup(pathname)
    || isTalentInvite(pathname)
    || isTalentClaim(pathname)
    || isTalentFileConnect(pathname)
    || isTalentRightsReview(pathname);
  const demoMode = isDemoModeEnabled();
  const [activeRooms, setActiveRooms] = useState<ActiveRoomSummary[]>([]);
  const [selectedGigId, setSelectedGigId] = useState<string | null>(null);
  const [performerProfile, setPerformerProfile] = useState<TalentPerformerProfile>(null);
  const statePath = isAuthEntryRoute ? null : (selectedGigId ? `/api/state/${selectedGigId}` : '/api/state');
  const { bState, isLoading, setBState } = useSwayState({ statePath });

  const refreshPerformerProfile = async () => {
    if (isAuthEntryRoute) {
      setPerformerProfile(null);
      return;
    }

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
    if (isAuthEntryRoute) {
      setActiveRooms([]);
      return;
    }

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
  }, [demoMode, isAuthEntryRoute, bState.activeGigId, bState.requests.length, bState.session.status]);

  useEffect(() => {
    void refreshPerformerProfile();
  }, [demoMode, isAuthEntryRoute]);

  useEffect(() => {
    // Only auto-pick a gig when nothing is selected yet. Once selected, it
    // must stay sticky: activeRooms only lists 'active' registry rooms, and
    // the global /api/state's activeGigId is an unrelated legacy singleton,
    // so either one can transiently disagree with the gig actually being
    // worked on -- e.g. a session that just ended moves to 'ending' for its
    // 5-minute post-gig sweep and drops out of activeRooms entirely. Auto-
    // clearing selectedGigId in that window makes statePath fall back to the
    // global endpoint, which then loses activeGigId and 409s the closeout
    // request. The user (or handleStartSession) is the only thing that
    // should change an existing selection.
    if (selectedGigId) return;
    if (bState.activeGigId) {
      setSelectedGigId(bState.activeGigId);
      return;
    }
    setSelectedGigId(activeRooms[0]?.gigId ?? null);
  }, [activeRooms, bState.activeGigId, selectedGigId]);

  const rejectDemoMutation = async () => {
    throw new Error('Demo data is read-only. No backend mutation was sent.');
  };

  const handleStartSession = async (setupData: PerformerRoomSetupData) => {
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
      minimumTip: 5,
      paymentsEnabled: true,
      searchScope: 'library'
    });
  };

  if (isTalentLogin(pathname)) {
    return <TalentLoginCard />;
  }

  if (isTalentSignup(pathname)) {
    return <TalentSignupCard />;
  }

  if (isTalentInvite(pathname)) {
    return <TalentInviteAcceptCard />;
  }

  if (isTalentClaim(pathname)) {
    const params = typeof window === 'undefined' ? '' : window.location.search;
    const target = `/talent/signup${params || ''}`;
    if (typeof window !== 'undefined') {
      window.location.replace(target);
    }
    return <LoadingState />;
  }

  if (isTalentFileConnect(pathname)) {
    return <TalentFileConnectCard />;
  }

  if (isTalentRightsReview(pathname)) {
    return <PerformerRightsReviewQueue />;
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
  const selectedRoomRoute = selectedGigId ?? activeGigId;
  const selectedRoomSummary = selectedRoomRoute
    ? activeRooms.find((room) => room.gigId === selectedRoomRoute)
    : null;
  const scopeLabel = session.searchScope === 'setlist'
    ? 'Setlist source'
    : session.searchScope === 'catalog'
      ? 'Open Catalog'
      : 'My Library';

  const performerEmailVerified = Boolean(performerProfile?.email_verified_at);

  if (session.status === 'closed') {
    return <VictoryScreen session={session} requests={requests} onRestart={resetInactiveSession} />;
  }

  if (session.status !== 'inactive') {
    return (
      <div className="h-[var(--sway-viewport-height,100vh)] overflow-hidden bg-slate-950 text-slate-100">
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
          performerEmailVerified={performerEmailVerified}
        />
      </div>
    );
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
              <span className="font-display text-xs font-black uppercase tracking-widest text-white">Performer Console</span>
              <p className="text-[9px] text-slate-400">Start, share, earn, and run the queue</p>
            </div>
          </div>
          <DemoModeBanner compact />
        </div>
      </div>

      <main className="flex-1">
        <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
          <SplitViewShell
            title={session.status === 'inactive' ? 'Performer console' : "Tonight's room"}
            eyebrow={session.status === 'inactive' ? `Welcome, ${performerIdentityName}` : 'Live room'}
            primaryLabel={session.status === 'inactive'
              ? 'Choose one workspace at a time'
              : 'Queue, QR, earnings, and room controls'}
            secondaryLabel={session.status === 'inactive' ? 'Account status' : 'Room status'}
            showHeader={session.status !== 'inactive'}
            isEmpty={false}
            emptyState={
              <div className="rounded-2xl border border-dashed border-white/10 bg-slate-900/40 p-8 text-center">
                <p className="text-sm font-bold text-white">Live room setup</p>
                <p className="mt-2 text-xs text-slate-400">Set room settings, then create the room link and QR.</p>
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
                performerEmailVerified={performerEmailVerified}
              />
            }
            secondary={
              <div className="space-y-4 text-sm">
                <div className="rounded-xl border border-white/10 bg-slate-950 p-3">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Session</p>
                  <p className="mt-1 font-bold text-white">{session.status === 'inactive' ? performerIdentityName : (session.talentName || performerIdentityName)}</p>
                  <p className="text-xs text-slate-400">
                    {session.status === 'inactive'
                      ? `Ready to start live room${performerProfile?.handle ? ` @${performerProfile.handle}` : ''}`
                      : `${session.status} / ${session.talentRole}`}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-lg border border-white/10 bg-slate-950 p-3">
                    <p className="text-slate-500">Pending</p>
                    <p className="mt-1 font-mono text-lg font-black text-amber-300">{pendingCount}</p>
                  </div>
                  <div className="rounded-lg border border-white/10 bg-slate-950 p-3">
                    <p className="text-slate-500">Approved</p>
                    <p className="mt-1 font-mono text-lg font-black text-cyan-300">{approvedCount}</p>
                  </div>
                </div>
                <div className="rounded-lg border border-white/10 bg-slate-950 p-3">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Window</p>
                  <p className={`mt-2 font-bold ${session.requestsOpen ? 'text-emerald-300' : 'text-rose-300'}`}>{session.requestsOpen ? 'Open' : 'Closed'}</p>
                  <p className="text-xs text-slate-400">{session.requestWindowLabel || 'Manual request window'}</p>
                </div>
                <div className="rounded-lg border border-white/10 bg-slate-950 p-3">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Crowd route</p>
                  <p className="mt-2 break-all font-mono text-xs font-bold text-white">
                    {selectedRoomRoute ? `/g/${selectedRoomRoute}` : 'Generated after room start'}
                  </p>
                  {selectedRoomSummary ? (
                    <p className="mt-2 text-xs text-slate-400">{selectedRoomSummary.requestCount} live item{selectedRoomSummary.requestCount === 1 ? '' : 's'} on this route.</p>
                  ) : null}
                </div>
                <div className="rounded-lg border border-white/10 bg-slate-950 p-3">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Request scope</p>
                  <p className="mt-2 font-bold text-white">{scopeLabel}</p>
                  <p className="text-xs text-slate-400">Crowd can request; performer approves what moves forward.</p>
                </div>
              </div>
            }
          />
        </motion.div>
      </main>
    </div>
  );
}
