import { Lock } from 'lucide-react';
import SplitViewShell from '../components/SplitViewShell';
import { DemoModeBanner, isDemoModeEnabled } from '../demo-mode';
import {
  ADMIN_OPS_DEMO_HEADING,
  ADMIN_OPS_DEMO_ITEM_BODY,
  ADMIN_OPS_DEMO_SECTION_LABELS,
  ADMIN_OPS_EMPTY_STATE_COPY,
  ADMIN_OPS_LOCKED_TITLE,
  renderAdminOpsDemoEmptyState,
  renderAdminOpsDemoHeadingComposition,
  renderAdminOpsDemoPrimaryPanel,
  renderAdminOpsDemoSectionList,
  renderAdminOpsLockedFallbackMessage,
  renderAdminOpsLockedSecondaryPanel
} from './admin/AdminOpsRuntimeCompat';

export default function AdminApp() {
  const demoSectionLabels = ADMIN_OPS_DEMO_SECTION_LABELS.map((label) => (label));
  const demoHeading = <>{ADMIN_OPS_DEMO_HEADING}</>;
  const demoSectionBody = <>{ADMIN_OPS_DEMO_ITEM_BODY}</>;
  const demoSectionItems = renderAdminOpsDemoSectionList(demoSectionLabels, demoSectionBody);
  const demoPrimaryPanel = renderAdminOpsDemoHeadingComposition(demoHeading, demoSectionLabels, demoSectionBody);

  if (isDemoModeEnabled()) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100">
        <DemoModeBanner />
        <SplitViewShell
          title="Operator App"
          eyebrow="Room State"
          primaryLabel="Operator queues"
          secondaryLabel="Authority boundary"
          badge={<DemoModeBanner compact />}
          isEmpty={false}
          emptyState={renderAdminOpsDemoEmptyState(<>{ADMIN_OPS_EMPTY_STATE_COPY}</>)}
          primary={demoPrimaryPanel}
          secondary={renderAdminOpsLockedSecondaryPanel(<>{ADMIN_OPS_LOCKED_TITLE}</>)}
        />
      </div>
    );
  }

  return renderAdminOpsLockedFallbackMessage();
}
