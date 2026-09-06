let state: BackendState = createEmptyBackendState();
let activeGigId: string | null = null;

function syncActiveGigRouteContext(inputState: BackendState, gigId: string | null = activeGigId) {
  // This response field identifies the selected room, not registry membership.
  // Ending and closed snapshots must retain it so clients can reject other rooms.
  const hasRoomIdentity = inputState.session.status === 'active'
    || inputState.session.status === 'ending'
    || inputState.session.status === 'closed';
  inputState.activeGigId = hasRoomIdentity ? (gigId ?? null) : null;
}

function prepareRoomState(inputState: BackendState, gigId: string | null) {
  syncActiveGigRouteContext(inputState, gigId);
  syncActivePerformer(inputState);
  return inputState;
}

function buildPatronRequestMutationResponse(input: {
  request: RequestItem;
  roomState: BackendState;
  gigId: string;
  receipt: string;
  reconciled?: boolean;
}) {
  return {
    success: true,
    ...(input.reconciled ? { reconciled: true } : {}),
    state: projectPublicRoomState(input.roomState, input.gigId),
    patron_status: projectPatronRequestStatus(input.request),
    patron_status_receipt: input.receipt
  };
}

function buildPatronBoostMutationResponse(input: {
  request: RequestItem;
  boost: BoostContribution;
  roomState: BackendState;
  gigId: string;
  receipt: string;
  reconciled?: boolean;
}) {
  return {
    success: true,
    ...(input.reconciled ? { reconciled: true } : {}),
    state: projectPublicRoomState(input.roomState, input.gigId),
    patron_status: projectPatronBoostStatus(input.boost, input.request),
    patron_status_receipt: input.receipt
  };
}

async function loadPatronPaymentEvidence(input: {
  gigId: string;
  requestId?: string | null;
  requestBoostId?: string | null;
  paymentId?: string | null;
}) {
  if (!businessDb) return undefined;
  const actionCondition = input.requestId
    ? eq(payments.requestId, input.requestId)
    : input.requestBoostId
      ? eq(payments.requestBoostId, input.requestBoostId)
      : null;
  if (!actionCondition) return undefined;

  const paymentCandidates = await businessDb
    .select({
      id: payments.id,
      paymentStatus: payments.paymentStatus,
      refundStatus: payments.refundStatus
    })
    .from(payments)
    .where(and(
      eq(payments.gigId, input.gigId),
      actionCondition,
      ...(input.paymentId ? [eq(payments.id, input.paymentId)] : [])
    ))
    .limit(input.paymentId ? 1 : 2);
  return selectPatronPaymentEvidence({
    runtimePaymentId: input.paymentId,
    candidates: paymentCandidates
  });
}

async function refreshBusinessState() {
  const snapshot = await businessStore.hydrateState(state);
  state = prepareRoomState(snapshot.state, snapshot.activeGigId);
  activeGigId = state.activeGigId;
  return snapshot;
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
    // Closed rows are no longer active, but this confirmed row still owns its recap.
    state: prepareRoomState(snapshot.state, snapshot.roomStatus === 'ended' ? gigId : snapshot.activeGigId)
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
