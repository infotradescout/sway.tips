export type PerformerEventReadCallbacks = {
  onLoading: () => void;
  onEvents: (events: unknown[]) => void;
  onEventError: (message: string) => void;
  onCapability: (capability: Record<string, unknown> | null) => void;
  onCapabilityError: (message: string | null) => void;
  onAccessLost: () => void;
};

class EventReadAccessError extends Error {}

/** Independent, read-only scheduling and ticket-readiness requests. */
export function createPerformerEventReads(
  callbacks: PerformerEventReadCallbacks,
  fetcher: typeof fetch = globalThis.fetch,
  timeoutMs = 15_000
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid event read deadline.');
  let active = true;
  let revision = 0;
  const controllers = new Set<AbortController>();

  const cancelPending = () => {
    for (const controller of controllers) controller.abort();
    controllers.clear();
  };

  const readJson = async (url: string) => {
    const controller = new AbortController();
    controllers.add(controller);
    let rejectAbort: (reason: unknown) => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(controller.signal.reason ?? new Error('Read cancelled.'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const deadline = setTimeout(() => {
      controller.abort(new Error('The check took too long. Try again.'));
    }, timeoutMs);
    try {
      // The deadline covers both the response and its body. A superseded body
      // cannot commit later, even when a transport does not honor cancellation.
      return await Promise.race([
        (async () => {
          const response = await fetcher(url, { cache: 'no-store', signal: controller.signal });
          if (response.status === 401 || response.status === 403) {
            throw new EventReadAccessError('Your event access changed.');
          }
          if (!response.ok) throw new Error('The check could not be completed. Try again.');
          const data: unknown = await response.json();
          if (!data || typeof data !== 'object' || Array.isArray(data)) {
            throw new Error('The check returned an unreadable response. Try again.');
          }
          return data as Record<string, unknown>;
        })(),
        aborted
      ]);
    } finally {
      clearTimeout(deadline);
      controller.signal.removeEventListener('abort', onAbort);
      controllers.delete(controller);
    }
  };

  const load = async () => {
    if (!active) return;
    const currentRevision = ++revision;
    cancelPending();
    const current = () => active && revision === currentRevision;
    const handleAccessLoss = (error: unknown) => {
      if (!(error instanceof EventReadAccessError)) return false;
      if (current()) {
        revision += 1;
        cancelPending();
        callbacks.onAccessLost();
      }
      return true;
    };
    callbacks.onLoading();
    // Never keep a previous permission or fee quote while a new check runs.
    callbacks.onCapability(null);
    callbacks.onCapabilityError(null);

    const eventsRead = readJson('/api/talent/events').then((data) => {
      if (!current()) return;
      if (!Array.isArray(data.events)) throw new Error('Your shows could not be read. Try again.');
      callbacks.onEvents(data.events);
    }).catch((error: unknown) => {
      if (!current() || handleAccessLoss(error)) return;
      callbacks.onEventError(error instanceof Error ? error.message : 'Your shows could not be read. Try again.');
    });

    // A failed or slow ticket-sales check must not hold the schedule hostage.
    // Handle its rejection here; only the schedule controls load() completion.
    void readJson('/api/talent/events/native-ticket-capability').then((data) => {
      if (!current()) return;
      const capability = data.capability;
      if (!capability || typeof capability !== 'object' || Array.isArray(capability)) {
        throw new Error('Ticket sales could not be checked.');
      }
      callbacks.onCapability(capability as Record<string, unknown>);
    }).catch((error: unknown) => {
      if (!current() || handleAccessLoss(error)) return;
      callbacks.onCapability(null);
      callbacks.onCapabilityError('Ticket sales could not be checked. Your saved shows were not changed.');
    });
    await eventsRead;
  };

  return {
    load,
    dispose() {
      active = false;
      revision += 1;
      cancelPending();
    }
  };
}
