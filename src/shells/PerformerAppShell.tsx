import { createPhase1ShellScaffold } from './phase1-scaffold';
import TalentApp from './TalentApp';

export const SHELL_SURFACE_ID = 'PerformerAppShell' as const;

const PerformerAppShellScaffold = createPhase1ShellScaffold({
  surfaceId: SHELL_SURFACE_ID,
  title: 'Performer/DJ App',
  body: 'Phase 1 scaffold is fail-closed. Performer approvals and room controls are not enabled in this slice.'
});

export const LEGACY_SURFACE_DELEGATE = TalentApp;
export const FAIL_CLOSED_SCAFFOLD = PerformerAppShellScaffold;

const PerformerAppShell = LEGACY_SURFACE_DELEGATE;

export default PerformerAppShell;
