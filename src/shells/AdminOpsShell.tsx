import { createPhase1ShellScaffold } from './phase1-scaffold';
import AdminOpsRuntime from './AdminOpsRuntime';

export const SHELL_SURFACE_ID = 'AdminOpsShell' as const;

const AdminOpsShellScaffold = createPhase1ShellScaffold({
  surfaceId: SHELL_SURFACE_ID,
  title: 'Admin/Ops',
  body: 'Phase 1 scaffold is fail-closed. Admin diagnostics and provider-state controls remain disabled in this slice.'
});

export const LEGACY_SURFACE_DELEGATE = AdminOpsRuntime;
export const FAIL_CLOSED_SCAFFOLD = AdminOpsShellScaffold;

const AdminOpsShell = LEGACY_SURFACE_DELEGATE;

export default AdminOpsShell;
