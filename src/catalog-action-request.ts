/** A timed-out write may have reached the server. Never retry it automatically. */
export class CatalogActionUnconfirmedError extends Error {
  constructor(message = 'The result could not be confirmed. Refresh Catalog and check your saved work before trying again.') {
    super(message);
    this.name = 'CatalogActionUnconfirmedError';
  }
}

export class CatalogActionAccessError extends Error {
  constructor() {
    super('Your access changed. Reload Catalog to continue.');
    this.name = 'CatalogActionAccessError';
  }
}

type Options = {
  fetcher?: typeof fetch;
  timeoutMs?: number;
  onAccessDenied?: () => void;
};

/** Bounds one explicit write, including its response body, without repeating it.
 * Abort stops waiting locally; it does not promise that a server write was undone.
 */
export async function requestCatalogAction(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  fallback: string,
  { fetcher = fetch, timeoutMs = 60_000, onAccessDenied }: Options = {}
): Promise<Record<string, any>> {
  if (signal.aborted) throw new CatalogActionUnconfirmedError('Stopped waiting. The action may already have completed. Refresh Catalog to check.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('A positive Catalog action deadline is required.');
  const transport = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => {};
  const interrupted = () => signal.aborted || transport.signal.aborted;
  const boundary = new Promise<never>((_, reject) => {
    cancel = () => {
      transport.abort();
      reject(new CatalogActionUnconfirmedError('Stopped waiting. The action may already have completed. Refresh Catalog to check.'));
    };
    signal.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => {
      transport.abort();
      reject(new CatalogActionUnconfirmedError('This action is taking too long to confirm. Refresh Catalog and check your saved work before trying again.'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([boundary, (async () => {
      let response: Response;
      try {
        response = await fetcher(url, { ...init, signal: transport.signal, redirect: 'error' });
      } catch {
        throw new CatalogActionUnconfirmedError();
      }
      if (interrupted()) throw new CatalogActionUnconfirmedError();
      // Access denial takes effect at headers, even if the body never arrives.
      if (response.status === 401 || response.status === 403) {
        onAccessDenied?.();
        throw new CatalogActionAccessError();
      }
      let data: unknown;
      try { data = await response.json(); }
      catch { throw new CatalogActionUnconfirmedError(); }
      if (interrupted()) throw new CatalogActionUnconfirmedError();
      if (!response.ok) {
        if (response.status >= 500) throw new CatalogActionUnconfirmedError();
        const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
          ? data.error : fallback;
        throw new Error(message);
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new CatalogActionUnconfirmedError();
      return data as Record<string, any>;
    })()]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    transport.abort();
  }
}
