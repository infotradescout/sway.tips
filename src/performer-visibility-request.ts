import type { PerformerVisibilityState } from './server/public-profile';

export class VisibilityRequestError extends Error {
  constructor(readonly kind: 'access' | 'unconfirmed' | 'rejected' | 'cancelled', message: string) {
    super(message);
    this.name = 'VisibilityRequestError';
  }
}

export function isVisibilityState(value: unknown): value is PerformerVisibilityState {
  return value === 'draft' || value === 'unlisted' || value === 'public';
}

type Options = {
  signal: AbortSignal;
  value?: PerformerVisibilityState;
  fetcher?: typeof fetch;
  timeoutMs?: number;
};

/** One owner-scoped read or explicit publication change. No automatic writes or retries.
 * A lost acknowledgement is not evidence that the saved setting stayed unchanged.
 */
export async function requestPerformerVisibility({ signal, value, fetcher = fetch, timeoutMs = 15_000 }: Options): Promise<PerformerVisibilityState> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('A positive visibility deadline is required.');
  if (value !== undefined && !isVisibilityState(value)) throw new Error('Invalid visibility choice.');
  const writing = value !== undefined;
  const unconfirmed = () => new VisibilityRequestError('unconfirmed', writing
    ? 'The saved visibility could not be confirmed. Check the saved setting before trying again.'
    : 'Your saved visibility could not be loaded. Check the saved setting to try again.');
  const cancelled = () => new VisibilityRequestError('cancelled', writing
    ? 'Stopped waiting. The change may already have been saved. Check the saved setting before trying again.'
    : 'Stopped checking visibility. Load the saved setting before making a change.');
  if (signal.aborted) throw cancelled();
  const transport = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  const interrupted = () => signal.aborted || transport.signal.aborted;
  const boundary = new Promise<never>((_resolve, reject) => {
    onAbort = () => { transport.abort(); reject(cancelled()); };
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => { transport.abort(); reject(unconfirmed()); }, timeoutMs);
  });
  try {
    return await Promise.race([boundary, (async () => {
      let response: Response;
      try {
        response = await fetcher(writing ? '/api/talent/profile/visibility' : '/api/talent/profile/public', {
          method: writing ? 'POST' : 'GET', credentials: 'include', cache: 'no-store', redirect: 'error',
          signal: transport.signal,
          ...(writing ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visibilityState: value }) } : {})
        });
      } catch { throw unconfirmed(); }
      if (interrupted()) throw unconfirmed();
      // An access denial must clear the controls even when its response body stalls.
      if (response.status === 401 || response.status === 403) {
        throw new VisibilityRequestError('access', 'Your access changed. Reload your profile before changing visibility.');
      }
      let body: unknown;
      try { body = await response.json(); } catch { throw unconfirmed(); }
      if (interrupted()) throw unconfirmed();
      if (!response.ok) {
        if (response.status >= 500) throw unconfirmed();
        const error = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
          ? body.error.slice(0, 400) : 'Visibility could not be updated. Check the saved setting before trying again.';
        throw new VisibilityRequestError('rejected', error);
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw unconfirmed();
      const data = body as Record<string, unknown>;
      if (data.success === false || typeof data.error === 'string') throw unconfirmed();
      const profile = data.profile;
      const saved = writing ? data.visibilityState
        : profile && typeof profile === 'object' && !Array.isArray(profile) && 'visibilityState' in profile ? profile.visibilityState : null;
      // Never turn a missing or unknown setting into an apparently saved Draft.
      if (!isVisibilityState(saved) || (writing && saved !== value)) throw unconfirmed();
      return saved;
    })()]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    transport.abort();
  }
}
