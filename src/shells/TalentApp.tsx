import { useEffect, useState } from 'react';
import { LogOut, Users } from 'lucide-react';
import { motion } from 'motion/react';
import SplitViewShell from '../components/SplitViewShell';
import TalentDashboard from '../components/TalentDashboard';
import type { PerformerRoomSetupData } from '../components/PerformerRoomSetup';
import TalentInviteAcceptCard from '../components/TalentInviteAcceptCard';
import PerformerRightsReviewQueue from '../components/PerformerRightsReviewQueue';
import PerformerEventDoorPage from '../components/PerformerEventDoorPage';
import VictoryScreen from '../components/VictoryScreen';
import { DemoModeBanner, isDemoModeEnabled } from '../demo-mode';
import type { ActiveRoomSummary } from '../types';
import { LoadingState, postJson, useSwayState } from './shared';
import {
  resolvePublicProfileHeroName,
  resolvePublicProfilePageKindLabel
} from '../server/public-profile';
import { LIVE_ROOM_LANGUAGE } from '../live-room-language';
import {
  buildFileConnectLoginHref,
  FILE_COLLABORATION_PATHS,
  normalizeSafeAccountNextPath,
  readFilePairingTokenFromHash,
  resolveLegacyFileConnectTarget
} from '../file-collaboration-routing';
import {
  resolveInactivePerformerWorkspace,
  resolvePerformerLoginWorkspaceRedirect,
  shouldRenderPerformerLiveRoom
} from '../performer-workspace-routing';

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

function talentEventDoorId(pathname: string) {
  const match = /^\/talent\/events\/([0-9a-f-]{36})\/door$/i.exec(pathname);
  return match?.[1] ?? null;
}

type TalentPerformerProfile = {
  performer_id: string;
  display_name: string;
  handle: string | null;
  stage_name: string | null;
  primary_role: string | null;
  roles: string[];
  specialties: string[];
  owner_user_id: string;
  email_verified_at: string | null;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  stripe_connected_account_id: string | null;
  payout_destination_kind: string | null;
  money_actions_ready: boolean;
  test_mode_platform_balance_allowed: boolean;
} | null;

export default function TalentApp() {
  const pathname = typeof window === 'undefined' ? '/talent' : window.location.pathname;
  const requestedWorkspace = resolveInactivePerformerWorkspace(pathname, typeof window === 'undefined' ? '' : window.location.hash);
  const eventDoorId = talentEventDoorId(pathname);
  const isAuthEntryRoute = isTalentLogin(pathname)
    || isTalentSignup(pathname)
    || isTalentInvite(pathname)
    || isTalentClaim(pathname)
    || isTalentFileConnect(pathname)
    || isTalentRightsReview(pathname)
    || Boolean(eventDoorId);
  const demoMode = isDemoModeEnabled();
  const [activeRooms, setActiveRooms] = useState<ActiveRoomSummary[]>([]);
  const [selectedGigId, setSelectedGigId] = useState<string | null>(null);
  const [performerProfile, setPerformerProfile] = useState<TalentPerformerProfile>(null);
  const statePath = isAuthEntryRoute || !selectedGigId ? null : `/api/state/${selectedGigId}`;
  const { bState, isLoading, setBState, roomActionsBlocked } = useSwayState({ statePath });
  const [roomActionError, setRoomActionError] = useState<string | null>(null);

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
    const refreshAfterProfileSave = () => { void refreshPerformerProfile(); };
    window.addEventListener('sway:performer-profile-updated', refreshAfterProfileSave);
    return () => window.removeEventListener('sway:performer-profile-updated', refreshAfterProfileSave);
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
    setSelectedGigId(activeRooms[0]?.gigId ?? null);
  }, [activeRooms, selectedGigId]);

  const rejectDemoMutation = async () => {
    throw new Error('Demo data is read-only. No backend mutation was sent.');
  };

  const applyDurableMutationState = (data: any) => {
    if (data?.state) {
      setBState(data.state);
      return;
    }
    if (data?.pending) window.dispatchEvent(new Event('re-fetch-state'));
  };

  const handleStartSession = async (setupData: PerformerRoomSetupData) => {
    if (demoMode) return rejectDemoMutation();
    const performerIdentityName = performerProfile
      ? resolvePublicProfileHeroName({
          handle: performerProfile.handle,
          stageName: performerProfile.stage_name,
          displayName: performerProfile.display_name
        })
      : '';
    const data = await postJson('/api/session/start', {
      ...setupData,
      talentName: setupData.talentName.trim() || performerIdentityName
    });
    setBState(data.state);
    setSelectedGigId(data.state?.activeGigId ?? null);
    await refreshActiveRooms();
  };

  const handleEndSession = async () => {
    if (demoMode) return rejectDemoMutation();
    if (roomActionsBlocked) { setRoomActionError('Reconnect before ending or closing this room.'); return; }
    setRoomActionError(null);
    try {
      const data = await postJson('/api/session/end', { gig_id: selectedGigId ?? bState.activeGigId });
      setBState(data.state);
      await refreshActiveRooms();
    } catch (e) {
      console.error(e);
      setRoomActionError('That room action failed. Reconnect and try again.');
    }
  };

  const handleCloseout = async () => {
    if (demoMode) return rejectDemoMutation();
    if (roomActionsBlocked) { setRoomActionError('Reconnect before ending or closing this room.'); return; }
    setRoomActionError(null);
    try {
      const data = await postJson('/api/session/closeout', { gig_id: selectedGigId ?? bState.activeGigId });
      setBState(data.state);
      await refreshActiveRooms();
    } catch (e) {
      console.error(e);
      setRoomActionError('That room action failed. Reconnect and try again.');
    }
  };

  const handleTriageRequest = async (requestId: string, action: 'approve' | 'deny') => {
    if (demoMode) return rejectDemoMutation();
    if (roomActionsBlocked) throw new Error('Reconnect to the live room before changing requests.');
    try {
      const data = await postJson('/api/request/triage', { requestId, action });
      applyDurableMutationState(data);
      await refreshActiveRooms();
    } catch (e) {
      console.error(e);
      throw e;
    }
  };

  const handleFulfillRequest = async (requestId: string) => {
    if (demoMode) return rejectDemoMutation();
    if (roomActionsBlocked) throw new Error('Reconnect to the live room before changing requests.');
    try {
      const data = await postJson('/api/request/fulfill', { requestId });
      applyDurableMutationState(data);
      await refreshActiveRooms();
    } catch (e) {
      console.error(e);
      throw e;
    }
  };

  const handleHideRequest = async (requestId: string) => {
    if (demoMode) return rejectDemoMutation();
    if (roomActionsBlocked) throw new Error('Reconnect to the live room before changing requests.');
    try {
      const data = await postJson('/api/moderation/hide', {
        requestId,
        reason: 'Performer hid this request from the live queue.'
      });
      applyDurableMutationState(data);
      await refreshActiveRooms();
    } catch (e) {
      console.error(e);
      throw e;
    }
  };

  const handleRemoveRequest = async (requestId: string) => {
    if (demoMode) return rejectDemoMutation();
    if (roomActionsBlocked) throw new Error('Reconnect to the live room before changing requests.');
    try {
      const data = await postJson('/api/moderation/remove', {
        requestId,
        reason: 'Performer removed this request from the live queue.'
      });
      setBState(data.state);
      await refreshActiveRooms();
    } catch (e) {
      console.error(e);
      throw e;
    }
  };

  const resetInactiveSession = () => {
    void handleStartSession({
      gig_id: globalThis.crypto.randomUUID(),
      talentName: 'Sway Performer',
      talentRole: 'DJ',
      feeType: 'patron',
      minimumTip: 5,
      paymentsEnabled: false,
      searchScope: 'library'
    });
  };

  const handleLogout = async () => {
    if (demoMode) return;
    await postJson('/api/account/logout', {});
    window.location.assign('/');
  };

  if (isTalentLogin(pathname)) {
    const sourceParams = typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search);
    const legacyRedirectValues = sourceParams.getAll('redirect');
    const legacyRedirect = legacyRedirectValues.length === 1 ? legacyRedirectValues[0] : '';
    const outerHash = typeof window === 'undefined' ? '' : window.location.hash;
    if (legacyRedirect === FILE_COLLABORATION_PATHS.legacyConnect && readFilePairingTokenFromHash(outerHash)) {
      if (typeof window !== 'undefined') window.location.replace(buildFileConnectLoginHref(outerHash));
      return <LoadingState />;
    }
    const targetParams = new URLSearchParams({ intent: 'performer' });
    const safeNext = normalizeSafeAccountNextPath(
      resolvePerformerLoginWorkspaceRedirect(legacyRedirect, outerHash),
      typeof window === 'undefined' ? 'https://app.sway.tips' : window.location.origin
    );
    if (safeNext) targetParams.set('next', safeNext);
    if (sourceParams.getAll('status').length === 1 && sourceParams.get('status') === 'verified') {
      targetParams.set('verified', '1');
    }
    if (typeof window !== 'undefined') window.location.replace(`/account/login?${targetParams.toString()}`);
    return <LoadingState />;
  }

  if (isTalentSignup(pathname)) {
    const sourceParams = typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search);
    const targetParams = new URLSearchParams({ intent: 'performer' });
    const claim = sourceParams.get('claim') || sourceParams.get('code');
    const email = sourceParams.get('email');
    if (claim) targetParams.set('claim', claim);
    if (email) targetParams.set('email', email);
    if (typeof window !== 'undefined') window.location.replace(`/account/signup?${targetParams.toString()}`);
    return <LoadingState />;
  }

  if (isTalentInvite(pathname)) {
    return <TalentInviteAcceptCard />;
  }

  if (isTalentClaim(pathname)) {
    const params = typeof window === 'undefined' ? '' : window.location.search;
    const sourceParams = new URLSearchParams(params);
    const targetParams = new URLSearchParams({ intent: 'performer' });
    const claim = sourceParams.get('claim') || sourceParams.get('code');
    if (claim) targetParams.set('claim', claim);
    const target = `/account/signup?${targetParams.toString()}`;
    if (typeof window !== 'undefined') {
      window.location.replace(target);
    }
    return <LoadingState />;
  }

  if (isTalentFileConnect(pathname)) {
    if (typeof window !== 'undefined') {
      window.location.replace(resolveLegacyFileConnectTarget(window.location.hash));
    }
    return <LoadingState />;
  }

  if (isTalentRightsReview(pathname)) {
    return <PerformerRightsReviewQueue />;
  }

  if (eventDoorId) {
    return <PerformerEventDoorPage eventId={eventDoorId} />;
  }

  if (isLoading) return <LoadingState />;

  const { session, requests } = bState;
  const { activeGigId } = bState;
  const performerIdentityName = performerProfile
    ? resolvePublicProfileHeroName({
        handle: performerProfile.handle,
        stageName: performerProfile.stage_name,
        displayName: performerProfile.display_name
      })
    : session.talentName || 'Sway account';
  const performerRoleLabel = resolvePublicProfilePageKindLabel({
    primaryRole: performerProfile?.primary_role,
    roles: performerProfile?.roles,
    specialties: performerProfile?.specialties
  });
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

  if (session.status === 'closed' && shouldRenderPerformerLiveRoom(session.status, requestedWorkspace)) {
    return <VictoryScreen session={session} requests={requests} onRestart={resetInactiveSession} />;
  }

  if (shouldRenderPerformerLiveRoom(session.status, requestedWorkspace)) {
    return (
      <div className="relative h-[var(--sway-viewport-height,100vh)] overflow-hidden bg-slate-950 text-slate-100">
        {!demoMode ? <button type="button" onClick={() => { void handleLogout(); }} className="absolute right-3 top-3 z-50 inline-flex min-h-10 items-center gap-2 rounded-xl border border-white/10 bg-slate-950/90 px-3 text-xs font-bold text-slate-200 shadow-xl"><LogOut className="h-4 w-4" /> Log out</button> : null}
        {roomActionsBlocked ? <div role="alert" className="absolute inset-x-3 top-14 z-50 rounded-xl border border-white/20 bg-slate-950 p-4 text-sm text-white"><p>Connection interrupted. Showing the last confirmed queue. Room actions are paused until we reconnect.</p><button type="button" className="mt-3 min-h-11 rounded-lg bg-fuchsia-600 px-4 font-bold" onClick={() => window.dispatchEvent(new Event('re-fetch-state'))}>Retry connection</button><a className="ml-4 underline" href="/talent/profile">Open profile</a></div> : null}
        {roomActionError ? <div role="alert" className="absolute inset-x-3 bottom-3 z-50 rounded-xl bg-slate-950 p-4 text-sm text-white">{roomActionError}</div> : null}
        <div inert={roomActionsBlocked} className="h-full">
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
          roomActionsBlocked={roomActionsBlocked}
        />
        </div>
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
              <span className="font-display text-xs font-black uppercase tracking-widest text-white">Sway Performer</span>
              <p className="text-[9px] text-slate-400">Live Rooms, music, files, and account</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <DemoModeBanner compact />
            {!demoMode ? <button type="button" onClick={() => { void handleLogout(); }} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-white/10 bg-slate-950 px-3 text-xs font-bold text-slate-200"><LogOut className="h-4 w-4" /> Log out</button> : null}
          </div>
        </div>
      </div>

      <main className="flex-1">
        <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
          <SplitViewShell
            primaryOnly
            title={session.status === 'inactive' ? 'Performer home' : "Tonight's Live Room"}
            eyebrow={session.status === 'inactive' ? `Welcome, ${performerIdentityName}` : LIVE_ROOM_LANGUAGE.liveRoom}
            primaryLabel={session.status === 'inactive'
              ? 'Choose what you want to manage'
              : 'Requests, room link, earnings, and controls'}
            secondaryLabel={LIVE_ROOM_LANGUAGE.roomStatus}
            showHeader={session.status !== 'inactive'}
            showPrimaryLabel={session.status !== 'inactive'}
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
          roomActionsBlocked={roomActionsBlocked}
              />
            }
            secondary={
              <div className="space-y-4 text-sm">
                <div className="rounded-xl border border-white/10 bg-slate-950 p-3">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{LIVE_ROOM_LANGUAGE.liveRoom}</p>
                  <p className="mt-1 font-bold text-white">{performerIdentityName}</p>
                  <p className="text-xs text-slate-400">
                    {session.status === 'inactive'
                      ? `Ready to start a live room · ${performerRoleLabel}`
                      : `${session.status} / ${session.talentRole}`}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-lg border border-white/10 bg-slate-950 p-3">
                    <p className="text-slate-500">{LIVE_ROOM_LANGUAGE.pending}</p>
                    <p className="mt-1 font-mono text-lg font-black text-amber-300">{pendingCount}</p>
                  </div>
                  <div className="rounded-lg border border-white/10 bg-slate-950 p-3">
                    <p className="text-slate-500">{LIVE_ROOM_LANGUAGE.approved}</p>
                    <p className="mt-1 font-mono text-lg font-black text-cyan-300">{approvedCount}</p>
                  </div>
                </div>
                <div className="rounded-lg border border-white/10 bg-slate-950 p-3">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Request window</p>
                  <p className={`mt-2 font-bold ${session.requestsOpen ? 'text-emerald-300' : 'text-rose-300'}`}>{session.requestsOpen ? 'Open' : 'Closed'}</p>
                  <p className="text-xs text-slate-400">{session.requestWindowLabel || 'Manual request window'}</p>
                </div>
                <div className="rounded-lg border border-white/10 bg-slate-950 p-3">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Room link</p>
                  <p className="mt-2 break-all font-mono text-xs font-bold text-white">
                    {selectedRoomRoute ? `/g/${selectedRoomRoute}` : 'Available after the room starts'}
                  </p>
                  {selectedRoomSummary ? (
                    <p className="mt-2 text-xs text-slate-400">{selectedRoomSummary.requestCount} request{selectedRoomSummary.requestCount === 1 ? '' : 's'} in this room.</p>
                  ) : null}
                </div>
                <div className="rounded-lg border border-white/10 bg-slate-950 p-3">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{LIVE_ROOM_LANGUAGE.requestSource}</p>
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
