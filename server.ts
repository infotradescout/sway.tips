let state: BackendState = createEmptyBackendState();
let activeGigId: string | null = null;

function syncActiveGigRouteContext(inputState: BackendState, gigId: string | null = activeGigId) {
  inputState.activeGigId = inputState.session.status === 'active' ? (gigId ?? null) : null;
}

function prepareRoomState(inputState: BackendState, gigId: string | null) {
  syncActiveGigRouteContext(inputState, gigId);
  syncActivePerformer(inputState);
  return inputState;
}

async function persistBusinessState() {
  prepareRoomState(state, activeGigId);
  await businessStore.persistState({ state, activeGigId });
}

async function loadRoomState(gigId: string) {
  if (!businessStore.hasDurableStore) {
    if (state.activeGigId === gigId) {
      const fallbackState = prepareRoomState(state, gigId);
      return {
        state: fallbackState,
        activeGigId: fallbackState.activeGigId,
        roomStatus: fallbackState.session.status === 'closed'
          ? 'ended' as const
          : (fallbackState.session.status === 'active' || fallbackState.session.status === 'ending')
            ? 'active' as const
            : 'inactive' as const
      };
    }

    return {
      state: createEmptyBackendState(),
      activeGigId: null,
      roomStatus: 'missing' as const
    };
  }

  const snapshot = await businessStore.hydrateStateByGigId(gigId, createEmptyBackendState());
  return {
    ...snapshot,
    state: prepareRoomState(snapshot.state, snapshot.activeGigId)
  };
}

async function persistBusinessStateForRoom(roomState: BackendState, gigId: string) {
  const preparedState = prepareRoomState(roomState, gigId);

  if (!businessStore.hasDurableStore) {
    state = preparedState;
    activeGigId = preparedState.activeGigId;
    return;
  }

  await businessStore.persistState({ state: preparedState, activeGigId: gigId });

  if (activeGigId === gigId) {
    state = preparedState;
    activeGigId = preparedState.activeGigId;
  }
}

async function listReadableActiveRooms(performerId?: string): Promise<ActiveRoomSummary[]> {
  if (!businessStore.hasDurableStore) {
    await refreshBusinessState();
    return activeGigId ? [buildActiveRoomSummary(state, activeGigId)] : [];
  }

  return businessStore.listActiveRoomSummaries(performerId);
}

app.get("/api/state/:gigId", async (req, res) => {
  applyNoStoreHeaders(res);

  const requestedGigId = parseDurableGigId(req.params.gigId);
  if (!requestedGigId) {
    return res.status(404).json({
      error: ROOM_LOOKUP_UNAVAILABLE_COPY,
      message: ROOM_LOOKUP_UNAVAILABLE_COPY,
      room_lookup: 'missing'
    });
  }

  const roomSnapshot = await loadRoomState(requestedGigId);

  if (roomSnapshot.roomStatus === 'missing') {
    return res.status(404).json({
      error: ROOM_LOOKUP_UNAVAILABLE_COPY,
      message: ROOM_LOOKUP_UNAVAILABLE_COPY,
      room_lookup: 'missing'
    });
  }

  if (roomSnapshot.roomStatus === 'ended') {
    return res.status(410).json({
      error: ROOM_LOOKUP_ENDED_COPY,
      message: ROOM_LOOKUP_ENDED_COPY,
      room_lookup: 'ended'
    });
  }

  if (roomSnapshot.roomStatus !== 'active') {
    return res.status(404).json({
      error: ROOM_LOOKUP_UNAVAILABLE_COPY,
      message: ROOM_LOOKUP_UNAVAILABLE_COPY,
      room_lookup: 'missing'
    });
  }

  await recordDirectRoomDiscoveryOutcome(req, res, requestedGigId);

  const privateRoomAccess = await accessControl.requireGigMutationAccess(req, requestedGigId);
  if (privateRoomAccess.allowed) {
    return res.json({
      session: roomSnapshot.state.session,
      requests: roomSnapshot.state.requests,
      performers: roomSnapshot.state.performers,
      activeGigId: roomSnapshot.state.activeGigId,
      room_lookup: 'active'
    });
  }

  return res.json({
    ...projectPublicRoomState(roomSnapshot.state, requestedGigId),
    room_lookup: 'active'
  });
});
