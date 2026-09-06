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
