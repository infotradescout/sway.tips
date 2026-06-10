import { createPhase1ShellScaffold } from './phase1-scaffold';
import AdminApp from './AdminApp';

export const SHELL_SURFACE_ID = 'OperatorAppShell' as const;

const OperatorAppShellScaffold = createPhase1ShellScaffold({
  surfaceId: SHELL_SURFACE_ID,
  title: 'Operator App',
  body: 'Phase 1 scaffold is fail-closed. Operator mutation routes remain unavailable in this slice.'
});

export const LEGACY_SURFACE_DELEGATE = AdminApp;
export const FAIL_CLOSED_SCAFFOLD = OperatorAppShellScaffold;

const OperatorAppShell = LEGACY_SURFACE_DELEGATE;

export default OperatorAppShell;
