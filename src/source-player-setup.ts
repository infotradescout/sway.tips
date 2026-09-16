// Browser-only validation for the existing room-scoped booth connection route.
export type BoothDownload = {
  filename: string;
  contentType: 'application/x-msdos-program';
  bytes: Uint8Array<ArrayBuffer>;
  expiresAt: string;
  command: string | null;
};
export class SourcePlayerAccessError extends Error {}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export async function validateBoothDownload(value: unknown, gigId: string, now = Date.now()): Promise<BoothDownload> {
  if (!UUID.test(gigId) || !record(value) || value.gigId !== gigId || !record(value.windowsLauncher)) {
    throw new Error('The room connection could not be verified. No file was downloaded.');
  }
  const file = value.windowsLauncher;
  if (file.filename !== `sway-booth-${gigId.slice(0, 8)}.cmd`
    || file.contentType !== 'application/x-msdos-program'
    || typeof file.contentBase64 !== 'string' || !file.contentBase64.length || file.contentBase64.length > 1_000_000
    || file.contentBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(file.contentBase64)
    || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)
    || typeof file.expiresAt !== 'string' || !Number.isFinite(Date.parse(file.expiresAt))
    || Date.parse(file.expiresAt) <= now || Date.parse(file.expiresAt) > now + 7 * 60 * 60 * 1_000) {
    throw new Error('The room file is invalid or expired. Prepare a new connection.');
  }
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.from(atob(file.contentBase64), char => char.charCodeAt(0));
  } catch {
    throw new Error('The room file could not be read. No file was downloaded.');
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== file.sha256) throw new Error('The room file did not pass its integrity check. No file was downloaded.');
  return { filename: file.filename, contentType: file.contentType, bytes, expiresAt: file.expiresAt,
    command: typeof value.command === 'string' && value.command.length <= 10_000 ? value.command : null };
}

// Race the complete read, not just fetch: stalled bodies and abort-insensitive
// transports must not keep a credential-producing operation alive in the UI.
export async function prepareSourcePlayer(gigId: string, controller: AbortController, timeoutMs = 15_000): Promise<BoothDownload> {
  if (!UUID.test(gigId)) throw new Error('Select a live room before connecting your player.');
  let rejectAbort: (error: Error) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(new Error('Connection preparation was interrupted. It may have replaced the previous connection. Check your booth before preparing another.'));
  controller.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (controller.signal.aborted) throw new Error('Connection preparation was cancelled.');
    return await Promise.race([aborted, (async () => {
      const response = await fetch('/api/talent/control-bridge/token', {
        method: 'POST', cache: 'no-store', signal: controller.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ gig_id: gigId })
      });
      if (response.status === 401 || response.status === 403) throw new SourcePlayerAccessError('Your room access changed. Refresh your account before connecting a player.');
      if (!response.ok) throw new Error('The connection could not be confirmed. Check your booth before preparing another.');
      return validateBoothDownload(await response.json(), gigId);
    })()]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
  }
}
