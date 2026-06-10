import { createPhase1ShellScaffold } from './phase1-scaffold';

export const SHELL_SURFACE_ID = 'PatronAppShell' as const;

const PatronAppShell = createPhase1ShellScaffold({
  surfaceId: SHELL_SURFACE_ID,
  title: 'Patron App',
  body: 'Phase 1 scaffold is fail-closed. Patron request and boost mutation behavior remains disabled here.'
});

export default PatronAppShell;
