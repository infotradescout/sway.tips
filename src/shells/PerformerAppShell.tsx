import { createPhase1ShellScaffold } from './phase1-scaffold';

export const SHELL_SURFACE_ID = 'PerformerAppShell' as const;

const PerformerAppShell = createPhase1ShellScaffold({
  surfaceId: SHELL_SURFACE_ID,
  title: 'Performer/DJ App',
  body: 'Phase 1 scaffold is fail-closed. Performer approvals and room controls are not enabled in this slice.'
});

export default PerformerAppShell;
