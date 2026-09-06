let state: BackendState = createEmptyBackendState();
let activeGigId: string | null = null;

function syncActiveGigRouteContext(inputState: BackendState, gigId: string | null = activeGigId) {
  inputState.activeGigId = (inputState.session.status === 'active' || inputState.session.status === 'ending')
    ? (gigId ?? null)
    : null;
}

function prepareRoomState(inputState: BackendState, gigId: string | null) {
  syncActiveGigRouteContext(inputState, gigId);
  syncActivePerformer(inputState);
  return inputState;
}
