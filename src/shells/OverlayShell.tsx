import { createPhase1ShellScaffold } from './phase1-scaffold';
import OverlayApp from './OverlayApp';

export const SHELL_SURFACE_ID = 'OverlayShell' as const;

const OverlayShellScaffold = createPhase1ShellScaffold({
  surfaceId: SHELL_SURFACE_ID,
  title: 'Overlay',
  body: 'Phase 1 scaffold is fail-closed. Overlay display behavior is intentionally not enabled in this slice.'
});

export const LEGACY_SURFACE_DELEGATE = OverlayApp;
export const FAIL_CLOSED_SCAFFOLD = OverlayShellScaffold;

const OverlayShell = LEGACY_SURFACE_DELEGATE;

export default OverlayShell;
