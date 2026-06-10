import { createPhase1ShellScaffold } from './phase1-scaffold';

export const SHELL_SURFACE_ID = 'OverlayShell' as const;

const OverlayShell = createPhase1ShellScaffold({
  surfaceId: SHELL_SURFACE_ID,
  title: 'Overlay',
  body: 'Phase 1 scaffold is fail-closed. Overlay display behavior is intentionally not enabled in this slice.'
});

export default OverlayShell;
