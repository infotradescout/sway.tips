export type InactivePerformerWorkspace =
  | 'home'
  | 'room'
  | 'shows'
  | 'library'
  | 'catalog'
  | 'profile'
  | 'account';

export const INACTIVE_PERFORMER_WORKSPACE_PATHS: Record<InactivePerformerWorkspace, string> = {
  home: '/talent',
  room: '/talent/gigs',
  shows: '/talent/shows',
  library: '/talent/music',
  catalog: '/talent/files',
  profile: '/talent/profile',
  account: '/talent/account'
};

export const LEGACY_SHOWS_WORKSPACE_HASH = '#sway-events-manager';

export function resolvePerformerLoginWorkspaceRedirect(redirectPath: string, hash: string) {
  return hash === LEGACY_SHOWS_WORKSPACE_HASH
    ? INACTIVE_PERFORMER_WORKSPACE_PATHS.shows
    : redirectPath;
}

export function resolveInactivePerformerWorkspace(pathname: string, hash = ''): InactivePerformerWorkspace {
  if (hash === LEGACY_SHOWS_WORKSPACE_HASH) return 'shows';
  const normalizedPath = pathname.replace(/\/+$/, '') || '/';
  if (normalizedPath === '/talent/shows') return 'shows';
  if (normalizedPath === '/talent/gigs') return 'room';
  if (normalizedPath === '/talent/music') return 'library';
  if (normalizedPath === '/talent/files') return 'catalog';
  if (normalizedPath === '/talent/profile') return 'profile';
  if (normalizedPath === '/talent/account') return 'account';
  return 'home';
}
