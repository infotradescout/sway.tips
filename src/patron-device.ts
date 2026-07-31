const PATRON_DEVICE_STORAGE_KEY = 'sway.patron.device-hash.v1';
const PATRON_DEVICE_HASH_PATTERN = /^[0-9a-f]{64}$/;

function createOpaqueDeviceHash() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

export function getPatronDeviceIdHash(): string | null {
  if (typeof window === 'undefined' || !globalThis.crypto?.getRandomValues) return null;

  try {
    const stored = window.localStorage.getItem(PATRON_DEVICE_STORAGE_KEY)?.trim().toLowerCase() ?? '';
    if (PATRON_DEVICE_HASH_PATTERN.test(stored)) return stored;

    const created = createOpaqueDeviceHash();
    window.localStorage.setItem(PATRON_DEVICE_STORAGE_KEY, created);
    return created;
  } catch {
    // Privacy modes can deny storage. Keep the request safe and let the server
    // reject identity-dependent mutations instead of sharing a global fallback.
    return null;
  }
}

export function buildPatronRequestHeaders(includeJson = false): Record<string, string> {
  const deviceIdHash = getPatronDeviceIdHash();
  return {
    ...(includeJson ? { 'Content-Type': 'application/json' } : {}),
    ...(deviceIdHash ? { 'x-sway-device-id-hash': deviceIdHash } : {})
  };
}
