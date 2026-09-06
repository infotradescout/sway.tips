import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LogOut, Users } from 'lucide-react';
import { motion } from 'motion/react';
import SplitViewShell from '../components/SplitViewShell';
import TalentDashboard from '../components/TalentDashboard';
import type { PerformerRoomSetupData } from '../components/PerformerRoomSetup';
import TalentInviteAcceptCard from '../components/TalentInviteAcceptCard';
import PerformerRightsReviewQueue from '../components/PerformerRightsReviewQueue';
import PerformerEventDoorPage from '../components/PerformerEventDoorPage';
import PerformerRoomRestart from '../components/PerformerRoomRestart';
import { DemoModeBanner, isDemoModeEnabled } from '../demo-mode';
import type { ActiveRoomSummary } from '../types';
import { LoadingState, postJson, useSwayState } from './shared';
import {
  resolvePublicProfileHeroName,
  resolvePublicProfilePageKindLabel
} from '../server/public-profile';
import { LIVE_ROOM_LANGUAGE } from '../live-room-language';
import { readPerformerRoomSelection, writePerformerRoomSelection } from '../performer-room-selection';
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

type PerformerReadContext = {
  active: boolean;
  revision: number;
  controller: AbortController | null;
};

function cancelPerformerRead(context: PerformerReadContext | null) {
  if (!context) return;
  context.revision += 1;
  context.controller?.abort();
  context.controller = null;
}

const EMPTY_ACTIVE_ROOMS: ActiveRoomSummary[] = [];

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
  const [activeRoomsSnapshot, setActiveRoomsSnapshot] = useState<{
    performerIdentity: string | null;
    rooms: ActiveRoomSummary[];
  }>({ performerIdentity: null, rooms: [] });
  const [roomsReadErrorSnapshot, setRoomsReadErrorSnapshot] = useState<{
    performerIdentity: string;
    message: string;
  } | null>(null);
  const [selectedGigId, applySelectedGigId] = useState<string | null>(() => (
    !demoMode && !isAuthEntryRoute && typeof window !== 'undefined'
      && (requestedWorkspace === 'home' || requestedWorkspace === 'room')
      ? readPerformerRoomSelection(window.location.search) : null
  ));
  const [performerProfile, setPerformerProfile] = useState<TalentPerformerProfile>(null);
  const roomSelectionRevision = useRef(0);
  const explicitRoomSelection = useRef(Boolean(selectedGigId));
  const roomStartInFlight = useRef(false);
  const roomStartContext = useRef<{ active: boolean } | null>(null);
  const profileReadContext = useRef<PerformerReadContext | null>(null);
  const roomsReadContext = useRef<PerformerReadContext | null>(null);
  const confirmedPerformerIdentity = useRef<string | null>(null);
  const logoutInFlight = useRef(false);
  const performerIdentity = performerProfile?.owner_user_id && performerProfile?.performer_id
    ? JSON.stringify([performerProfile.owner_user_id, performerProfile.performer_id])
    : null;
  // Keep rows and ownership atomic. A profile and room read can settle in the
  // same React batch, before the account-change layout cleanup runs.
  const activeRooms = activeRoomsSnapshot.performerIdentity === performerIdentity
    ? activeRoomsSnapshot.rooms : EMPTY_ACTIVE_ROOMS;
  const roomsReadError = !demoMode && !isAuthEntryRoute && performerIdentity
    && roomsReadErrorSnapshot?.performerIdentity === performerIdentity
    ? roomsReadErrorSnapshot.message : null;
  const setActiveRooms = (rooms: ActiveRoomSummary[]) => {
    setActiveRoomsSnapshot({ performerIdentity, rooms });
  };

  useLayoutEffect(() => {
    // Pending room creation belongs to this committed account/route context.
    const context = { active: true };
    roomStartContext.current = context;
    return () => {
      context.active = false;
      if (roomStartContext.current === context) roomStartContext.current = null;
    };
  }, [demoMode, isAuthEntryRoute, performerProfile?.owner_user_id, performerProfile?.performer_id]);

  useLayoutEffect(() => {
    const context: PerformerReadContext = { active: true, revision: 0, controller: null };
    profileReadContext.current = context;
    return () => {
      context.active = false;
      cancelPerformerRead(context);
      if (profileReadContext.current === context) profileReadContext.current = null;
    };
  }, [demoMode, isAuthEntryRoute]);

  useLayoutEffect(() => {
    const context: PerformerReadContext = { active: true, revision: 0, controller: null };
    roomsReadContext.current = context;
    setRoomsReadErrorSnapshot(null);
    const previousIdentity = confirmedPerformerIdentity.current;
    confirmedPerformerIdentity.current = performerIdentity;
    if (previousIdentity !== performerIdentity) {
      setActiveRooms([]);
      if (previousIdentity !== null) {
        // A sticky ending-room selection belongs to its account, not the next one.
        roomSelectionRevision.current += 1;
        explicitRoomSelection.current = false;
        applySelectedGigId(null);
      }
    }
    return () => {
      context.active = false;
      cancelPerformerRead(context);
      if (roomsReadContext.current === context) roomsReadContext.current = null;
    };
  }, [demoMode, isAuthEntryRoute, performerIdentity]);

  const setSelectedGigId = useCallback((gigId: string | null) => {
    // Track intent, not just the final id: A -> B -> A still supersedes a start.
    roomSelectionRevision.current += 1;
    explicitRoomSelection.current = true;
    applySelectedGigId(gigId);
  }, []);
  const statePath = isAuthEntryRoute || !selectedGigId || !performerIdentity ? null : `/api/state/${selectedGigId}`;
  const { bState, isLoading, setBState, roomActionsBlocked, roomLookup } = useSwayState({ statePath, privateRoomView: true, accessScope: performerIdentity });
  const [roomActionError, setRoomActionError] = useState<string | null>(null);
  const [profileReadError, setProfileReadError] = useState<string | null>(null);

  useEffect(() => {
    if (demoMode || isAuthEntryRoute || (requestedWorkspace !== 'home' && requestedWorkspace !== 'room')) return;
    writePerformerRoomSelection(selectedGigId);
  }, [demoMode, isAuthEntryRoute, requestedWorkspace, selectedGigId]);

  useEffect(() => {
    if (demoMode || isAuthEntryRoute || (requestedWorkspace !== 'home' && requestedWorkspace !== 'room')) return;
    const restoreAddressSelection = () => setSelectedGigId(readPerformerRoomSelection(window.location.search));
    window.addEventListener('popstate', restoreAddressSelection);
    return () => window.removeEventListener('popstate', restoreAddressSelection);
  }, [demoMode, isAuthEntryRoute, requestedWorkspace, setSelectedGigId]);

  const refreshPerformerProfile = async () => {
    if (logoutInFlight.current) return;
    if (isAuthEntryRoute) {
      setPerformerProfile(null);
      return;
    }

    if (demoMode) {
      setPerformerProfile(null);
      return;
    }
