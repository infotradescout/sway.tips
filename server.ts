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
    // The public room has ended; only an authorized performer may read its recap.
    const recapAccess = await accessControl.requireGigMutationAccess(req, requestedGigId);
    if (recapAccess.allowed === true) {
      return res.json({
        session: roomSnapshot.state.session,
        requests: roomSnapshot.state.requests,
        performers: roomSnapshot.state.performers,
        activeGigId: roomSnapshot.state.activeGigId,
        room_lookup: 'ended',
        room_access: 'performer'
      });
    }
    if (req.headers['x-sway-room-view'] === 'performer') {
      return res.status(recapAccess.status).json({ error: recapAccess.reason });
    }
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
  if (privateRoomAccess.allowed === true) {
    return res.json({
      session: roomSnapshot.state.session,
      requests: roomSnapshot.state.requests,
      performers: roomSnapshot.state.performers,
      activeGigId: roomSnapshot.state.activeGigId,
      room_lookup: 'active',
      room_access: 'performer'
    });
  }

  // A performer read must never silently downgrade into a public queue response.
  if (req.headers['x-sway-room-view'] === 'performer') {
    return res.status(privateRoomAccess.status).json({ error: privateRoomAccess.reason });
  }

  return res.json({
    ...projectPublicRoomState(roomSnapshot.state, requestedGigId),
    room_lookup: 'active'
  });
});
