import { Lock } from 'lucide-react';
import { ShellMessage } from './shared';

export type Phase1ShellSurfaceId =
  | 'PublicWebShell'
  | 'PatronAppShell'
  | 'PerformerAppShell'
  | 'OperatorAppShell'
  | 'OverlayShell'
  | 'AdminOpsShell';

export type Phase1ShellScaffoldConfig = Readonly<{
  surfaceId: Phase1ShellSurfaceId;
  title: string;
  body: string;
}>;

export function createPhase1ShellScaffold(config: Phase1ShellScaffoldConfig) {
  function Phase1ShellScaffold() {
    return (
      <ShellMessage
        icon={<Lock className="h-5 w-5" />}
        title={config.title}
        body={config.body}
      />
    );
  }

  Phase1ShellScaffold.displayName = `${config.surfaceId}Phase1Scaffold`;
  return Phase1ShellScaffold;
}
