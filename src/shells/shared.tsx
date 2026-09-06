export function useSwayState(options?: {
  statePath?: string | null;
  privateRoomView?: boolean;
  accessScope?: string | null;
}) {
  const statePath = options?.statePath === undefined ? '/api/state' : options.statePath;
  const privateRoomView = options?.privateRoomView === true;
  const accessScope = options?.accessScope ?? null;
  // A distinct scope prevents late responses from crossing rooms, including A -> B -> A.
  const scope = useMemo(() => ({ path: statePath, privateRoomView, accessScope, sequence: 0, revision: 0, pending: false, controller: null as AbortController | null, discoveryRecorded: false }), [statePath, privateRoomView, accessScope]);
  const activeScope = useRef<typeof scope | null>(scope);
  useLayoutEffect(() => {
    activeScope.current = scope;
    return () => {
      if (activeScope.current === scope) activeScope.current = null;
      scope.controller?.abort();
      scope.pending = false;
    };
  }, [scope]);
  const initialLookup: RoomLookupState = { status: statePath === '/api/state' ? 'global' : 'missing', message: null };
  type RoomSnapshot = {
    scope: typeof scope;
    revision: number;
    state: BackendState;
    loading: boolean;
    lookup: RoomLookupState;
  };
  const [snapshot, setSnapshot] = useState<RoomSnapshot>({ scope, revision: 0, state: initialState, loading: Boolean(statePath), lookup: initialLookup });
  const current = snapshot.scope === scope ? snapshot : { scope, revision: 0, state: initialState, loading: Boolean(statePath), lookup: initialLookup };
  const matchesRoom = useCallback((data: BackendState) => {
    const expected = scope.path?.startsWith('/api/state/') ? scope.path.slice('/api/state/'.length) : null;
    return !expected || data.activeGigId === expected;
  }, [scope]);
  const setBState: React.Dispatch<React.SetStateAction<BackendState>> = useCallback((update) => {
    if (activeScope.current !== scope) return;
    // The callback belongs to the observation visible when its action started.
    // A later read/error/revocation outranks that action's delayed snapshot.
    if (scope.revision !== current.revision
      || (scope.path && (current.loading || !['active', 'global'].includes(current.lookup.status)))) {
      if (!scope.pending) window.dispatchEvent(new Event('re-fetch-state'));
      return;
    }
    const next = normalizeBackendState(typeof update === 'function' ? update(current.state) : update);
    // Reject another room before invalidating this room's outstanding read.
    if (!matchesRoom(next)) return;
    scope.sequence += 1;
    scope.pending = false;
    scope.controller?.abort();
    const revision = ++scope.revision;
    setSnapshot(previous => {
      if (activeScope.current !== scope || scope.revision !== revision) return previous;
      return { scope, revision, state: next, loading: false, lookup: {
        status: next.session.status === 'closed' ? 'ended' : next.activeGigId ? 'active' : 'global',
        message: null
      } };
    });
  }, [scope, matchesRoom, current.revision, current.loading, current.lookup.status, current.state]);
  useEffect(() => {
    let disposed = false;
    const stillCurrent = (sequence: number) => !disposed && activeScope.current === scope && scope.sequence === sequence;
    const publish = (update: Omit<RoomSnapshot, 'revision'> | ((previous: RoomSnapshot) => Omit<RoomSnapshot, 'revision'>)) => {
      const revision = ++scope.revision;
      setSnapshot(previous => {
        if (disposed || activeScope.current !== scope || scope.revision !== revision) return previous;
        return { ...(typeof update === 'function' ? update(previous) : update), revision };
      });
    };
    const clear = (status: RoomLookupStatus, message: string | null) => publish({ scope, state: initialState, loading: false, lookup: { status, message } });
    const fetchState = async (force = false) => {
      if (scope.pending && !force) return;
      if (!scope.path) { clear('missing', null); return; }
      const sequence = ++scope.sequence;
      scope.controller?.abort();
      const controller = new AbortController();
      scope.controller = controller;
      scope.pending = true;
      const deadline = window.setTimeout(() => {
        if (!stillCurrent(sequence)) return;
        scope.sequence += 1;
        controller.abort();
        scope.pending = false;
        publish(previous => ({ scope, state: previous.scope === scope ? previous.state : initialState, loading: false, lookup: { status: 'error', message: 'The connection is taking too long. Retry to reconnect.' } }));
      }, 15000);
      try {
        if (isDemoModeEnabled()) {
          const data = await loadDemoBackendState();
          if (stillCurrent(sequence)) publish({ scope, state: normalizeBackendState(data), loading: false, lookup: { status: scope.path === '/api/state' ? 'global' : 'active', message: null } });
          return;
        }
        const response = await fetch(scope.path, {
          signal: controller.signal,
          headers: scope.path === '/api/state' ? undefined : {
            ...buildPatronRequestHeaders(),
            ...(scope.privateRoomView ? { 'x-sway-room-view': 'performer' } : {}),
            ...(!scope.discoveryRecorded ? {
              'x-sway-discovery-journey': getOrCreateDiscoveryJourneyId(),
              'x-sway-discovery-source': getEffectiveDiscoveryChannel(),
              'x-sway-discovery-entry-path': getDiscoveryEntryPath(),
              'x-sway-discovery-entry-once': '1'
            } : {})
          }
        });
        if (!stillCurrent(sequence)) return;
        if ([401, 403, 404, 410].includes(response.status)) {
          // Access loss must clear private state as soon as headers arrive.
          clear(response.status === 410 ? 'ended' : 'missing', response.status === 401 || response.status === 403 ? 'Your access changed. Sign in again to continue.' : 'This room is not available.');
          if (response.status !== 404) {
            controller.abort();
            return;
          }
          const data = await response.json().catch(() => null);
          if (!stillCurrent(sequence)) return;
          clear(data?.room_lookup === 'ended' ? 'ended' : 'missing', 'This room is not available.');
          return;
        }
        if (!response.ok) throw new Error('Room temporarily unavailable');
        const data = await response.json();
        if (!stillCurrent(sequence)) return;
        if (scope.privateRoomView && data?.room_access !== 'performer') {
          clear('missing', 'Your room access could not be confirmed. Reload your performer account.');
          return;
        }
        const normalized = normalizeBackendState(data);
        if (!matchesRoom(normalized)) throw new Error('Room response did not match the selected room');
        if (data?.room_lookup === 'ended') {
          if (scope.privateRoomView && normalized.session.status === 'closed') {
            publish({ scope, state: normalized, loading: false, lookup: { status: 'ended', message: null } });
          } else {
            clear('ended', ENDED_LIVE_ROOM_COPY);
          }
          return;
        }
        publish({ scope, state: normalized, loading: false, lookup: { status: data?.room_lookup === 'active' ? 'active' : 'global', message: null } });
        if (response.headers.get('x-sway-discovery-recorded') === '1') scope.discoveryRecorded = true;
      } catch (error) {
        if (!stillCurrent(sequence) || controller.signal.aborted) return;
        console.warn('Unable to sync server state:', error);
        publish(previous => ({ scope, state: previous.scope === scope ? previous.state : initialState, loading: false, lookup: { status: 'error', message: 'Connection interrupted. Reconnecting to your live room.' } }));
      } finally {
        window.clearTimeout(deadline);
        if (stillCurrent(sequence)) scope.pending = false;
      }
    };
    void fetchState();
    const interval = scope.path && !isDemoModeEnabled() ? setInterval(() => { void fetchState(); }, 4000) : null;
    const handleForceSync = () => { void fetchState(true); };
    window.addEventListener('re-fetch-state', handleForceSync);
    return () => {
      disposed = true;
      scope.controller?.abort();
      if (interval) clearInterval(interval);
      window.removeEventListener('re-fetch-state', handleForceSync);
    };
  }, [scope, matchesRoom]);
  return { bState: current.state, setBState, isLoading: current.loading, roomLookup: current.lookup,
    roomActionsBlocked: Boolean(statePath) && (current.loading || !['active', 'global'].includes(current.lookup.status)) };
}
