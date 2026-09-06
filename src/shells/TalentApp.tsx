import PerformerEventDoorPage from '../components/PerformerEventDoorPage';
import PerformerRoomRestart from '../components/PerformerRoomRestart';
import { readPerformerRoomSelection, savePerformerRoomSelection } from '../performer-room-selection';
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
        savePerformerRoomSelection(previousIdentity, null);
      }
      const restoredRoom = !demoMode && !isAuthEntryRoute
        ? readPerformerRoomSelection(performerIdentity) : null;
      if (restoredRoom) {
        roomSelectionRevision.current += 1;
        explicitRoomSelection.current = true;
        applySelectedGigId(restoredRoom);
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
    savePerformerRoomSelection(performerIdentity, gigId);
  }, [performerIdentity]);
  const statePath = isAuthEntryRoute || !selectedGigId ? null : `/api/state/${selectedGigId}`;
  const { bState, isLoading, setBState, roomActionsBlocked, roomLookup } = useSwayState({ statePath });
  const [roomActionError, setRoomActionError] = useState<string | null>(null);
  const [profileReadError, setProfileReadError] = useState<string | null>(null);

  useEffect(() => {
    // A confirmed unavailable selection must not trap reloads on a deleted or
    // no-longer-readable room. Ordinary connection errors retain the selection.
    if (!selectedGigId || isLoading || !performerIdentity) return;
    if (roomLookup.status !== 'missing'
      && !(roomLookup.status === 'ended' && bState.session.status !== 'closed')) return;
    savePerformerRoomSelection(performerIdentity, null);
    roomSelectionRevision.current += 1;
    explicitRoomSelection.current = false;
    applySelectedGigId(null);
  }, [selectedGigId, isLoading, performerIdentity, roomLookup.status, bState.session.status]);

    if (selectedGigId || explicitRoomSelection.current || roomStartInFlight.current) return;
    const firstRoomId = activeRooms[0]?.gigId;
    if (firstRoomId) {
      roomSelectionRevision.current += 1;
      applySelectedGigId(firstRoomId);
      savePerformerRoomSelection(performerIdentity, firstRoomId);
    }
  }, [activeRooms, selectedGigId, performerIdentity]);

    try {
      await postJson('/api/account/logout', {});
      savePerformerRoomSelection(performerIdentity, null);
      if (context?.active && profileReadContext.current === context) window.location.assign('/');
    } catch {
      failed = true;
      if (context?.active && profileReadContext.current === context) setRoomActionError('Log out failed. Try again.');
