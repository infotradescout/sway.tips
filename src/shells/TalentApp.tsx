  const setSelectedGigId = useCallback((gigId: string | null) => {
    // Track intent, not just the final id: A -> B -> A still supersedes a start.
    roomSelectionRevision.current += 1;
    explicitRoomSelection.current = true;
    applySelectedGigId(gigId);
    savePerformerRoomSelection(performerIdentity, gigId);
  }, [performerIdentity]);
  const statePath = isAuthEntryRoute || !selectedGigId ? null : `/api/state/${selectedGigId}`;
  const { bState, isLoading, setBState, roomActionsBlocked, roomLookup } = useSwayState({ statePath });

  useEffect(() => {
    // A confirmed unavailable selection must not trap reloads on a deleted or
