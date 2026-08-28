export const FILE_COLLABORATION_PATHS = {
  inbox: '/account/collaboration',
  connect: '/account/collaboration/connect',
  legacyConnect: '/talent/connect/files'
} as const;

const PERFORMER_WORKSPACE_PATHS = new Set([
  '/talent',
  '/talent/gigs',
  '/talent/connections',
  '/talent/shows',
  '/talent/music',
  '/talent/files',
  '/talent/profile',
  '/talent/account'
]);

const FILE_PAIRING_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CANONICAL_UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

export function normalizeSafeAccountNextPath(value: unknown, origin = 'https://app.sway.tips') {
  if (typeof value !== 'string') return '';
  const raw = value.trim();
  if (!raw || raw.length > 1_024 || !raw.startsWith('/') || raw.startsWith('//')) return '';

  try {
    const parsed = new URL(raw, origin);
    if (parsed.origin !== origin || parsed.hash) return '';
    const hasNoQuery = parsed.search === '';
    const isEventPath = new RegExp(`^/e/${UUID_PATTERN}$`, 'i').test(parsed.pathname);
    const isCanonicalEventPath = new RegExp(`^/e/${CANONICAL_UUID_PATTERN}$`, 'i').test(parsed.pathname);
    const eventPurchaseIntent = isCanonicalEventPath
      && parsed.search === '?buy=1'
      && parsed.searchParams.getAll('buy').length === 1
      && parsed.searchParams.get('buy') === '1'
      && [...parsed.searchParams.keys()].every((key) => key === 'buy')
      && !raw.includes('#');
    if (eventPurchaseIntent) return `${parsed.pathname}?buy=1`;

    const pathOnlyAllowed = isEventPath
      || parsed.pathname === '/tickets'
      || new RegExp(`^/tickets/(?:orders/${UUID_PATTERN}/return|${UUID_PATTERN})$`, 'i').test(parsed.pathname)
      || new RegExp(`^/talent/events/${UUID_PATTERN}/door$`, 'i').test(parsed.pathname)
      || parsed.pathname === FILE_COLLABORATION_PATHS.inbox
      || parsed.pathname === FILE_COLLABORATION_PATHS.connect
      || PERFORMER_WORKSPACE_PATHS.has(parsed.pathname);
    if (pathOnlyAllowed) return hasNoQuery ? parsed.pathname : '';

    const performerAccountIntent = parsed.pathname === '/account'
      && parsed.searchParams.getAll('intent').length === 1
      && parsed.searchParams.get('intent') === 'performer'
      && [...parsed.searchParams.keys()].every((key) => key === 'intent');
    return performerAccountIntent && !parsed.hash ? '/account?intent=performer' : '';
  } catch {
    return '';
  }
}

export function readFilePairingTokenFromHash(hash: string) {
  const match = /^#token=([A-Za-z0-9_-]{43})$/.exec(hash);
  const token = match?.[1] || '';
  return FILE_PAIRING_TOKEN_PATTERN.test(token) ? token : '';
}

export function buildFileConnectLoginHref(hash: string) {
  const token = readFilePairingTokenFromHash(hash);
  const params = new URLSearchParams({ next: FILE_COLLABORATION_PATHS.connect });
  return `/account/login?${params.toString()}${token ? `#token=${token}` : ''}`;
}

export function preserveFileConnectFragment(redirectPath: string, hash: string) {
  if (redirectPath !== FILE_COLLABORATION_PATHS.connect) return redirectPath;
  const token = readFilePairingTokenFromHash(hash);
  return token ? `${FILE_COLLABORATION_PATHS.connect}#token=${token}` : FILE_COLLABORATION_PATHS.connect;
}

export function resolveLegacyFileConnectTarget(hash: string) {
  const token = readFilePairingTokenFromHash(hash);
  return token ? `${FILE_COLLABORATION_PATHS.connect}#token=${token}` : FILE_COLLABORATION_PATHS.connect;
}
