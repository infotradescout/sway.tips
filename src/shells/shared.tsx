export function useSwayState(options?: {
  statePath?: string | null;
  accessScope?: string | null;
}) {
  const statePath = options?.statePath === undefined ? '/api/state' : options.statePath;
  const accessScope = options?.accessScope ?? null;
  // Account changes invalidate observations even when both accounts select the same room.
  const scope = useMemo(() => ({ path: statePath, accessScope, sequence: 0, revision: 0, pending: false, controller: null as AbortController | null, discoveryRecorded: false }), [statePath, accessScope]);
  const activeScope = useRef<typeof scope | null>(scope);
  useLayoutEffect(() => {
    activeScope.current = scope;
    return () => {
      if (activeScope.current === scope) activeScope.current = null;
      scope.controller?.abort();
      scope.pending = false;
    };
  }, [scope]);
