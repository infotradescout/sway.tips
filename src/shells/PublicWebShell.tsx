import { createPhase1ShellScaffold } from './phase1-scaffold';

export const SHELL_SURFACE_ID = 'PublicWebShell' as const;

const PublicWebShell = createPhase1ShellScaffold({
  surfaceId: SHELL_SURFACE_ID,
  title: 'Public Web Layer',
  body: 'Phase 1 scaffold is fail-closed. Public room entry behavior is not enabled in this slice.'
});

export default PublicWebShell;
