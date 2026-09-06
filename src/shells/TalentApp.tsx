import PerformerEventDoorPage from '../components/PerformerEventDoorPage';
import PerformerRoomRestart from '../components/PerformerRoomRestart';
import { DemoModeBanner, isDemoModeEnabled } from '../demo-mode';

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
  const statePath = isAuthEntryRoute || !selectedGigId ? null : `/api/state/${selectedGigId}`;
  const { bState, isLoading, setBState, roomActionsBlocked, roomLookup } = useSwayState({ statePath });
  const [roomActionError, setRoomActionError] = useState<string | null>(null);
  const [profileReadError, setProfileReadError] = useState<string | null>(null);

    if (selectedGigId || explicitRoomSelection.current || roomStartInFlight.current) return;
    const firstRoomId = activeRooms[0]?.gigId;
    if (firstRoomId) {
      roomSelectionRevision.current += 1;
      applySelectedGigId(firstRoomId);
    }
  }, [activeRooms, selectedGigId]);

    try {
      await postJson('/api/account/logout', {});
      if (context?.active && profileReadContext.current === context) window.location.assign('/');
    } catch {
      failed = true;
      if (context?.active && profileReadContext.current === context) setRoomActionError('Log out failed. Try again.');
