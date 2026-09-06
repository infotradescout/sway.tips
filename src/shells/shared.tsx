export function useSwayState(options?: {
  statePath?: string | null;
}) {
  const statePath = options?.statePath === undefined ? '/api/state' : options.statePath;
  // A distinct scope prevents late responses from crossing rooms, including A -> B -> A.
  const scope = useMemo(() => ({ path: statePath, sequence: 0, revision: 0, pending: false, controller: null as AbortController | null, discoveryRecorded: false }), [statePath]);
  const activeScope = useRef<typeof scope | null>(scope);
  useLayoutEffect(() => {
    activeScope.current = scope;
    return () => {
      if (activeScope.current === scope) activeScope.current = null;
      scope.controller?.abort();
      scope.pending = false;
    };
  }, [scope]);
