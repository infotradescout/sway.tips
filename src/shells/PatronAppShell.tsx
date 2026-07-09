import { createPhase1ShellScaffold } from './phase1-scaffold';
import PatronApp from './PatronApp';

export const SHELL_SURFACE_ID = 'PatronAppShell' as const;

const PatronAppShellScaffold = createPhase1ShellScaffold({
  surfaceId: SHELL_SURFACE_ID,
  title: 'Live room',
  body: 'Phase 1 scaffold is fail-closed. Patron request and boost mutation behavior remains disabled here.'
});

export const LEGACY_SURFACE_DELEGATE = PatronApp;
export const FAIL_CLOSED_SCAFFOLD = PatronAppShellScaffold;

const PatronAppShell = LEGACY_SURFACE_DELEGATE;

export default PatronAppShell;
