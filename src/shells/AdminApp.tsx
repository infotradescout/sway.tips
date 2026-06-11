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
  renderAdminOpsLockedFallbackMessage,
  renderAdminOpsLockedSecondaryPanel
} from './admin/AdminOpsRuntimeCompat';

export default function AdminApp() {
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
          primary={
            <div className="space-y-3">
              <p className="text-[10px] font-bold uppercase tracking-widest text-amber-200">{ADMIN_OPS_DEMO_HEADING}</p>
              {ADMIN_OPS_DEMO_SECTION_LABELS.map((label) => (
                <div key={label} className="rounded-xl border border-white/10 bg-slate-900 p-4">
                  <p className="text-sm font-bold text-white">{label}</p>
                  <p className="mt-1 text-xs text-slate-400">{ADMIN_OPS_DEMO_ITEM_BODY}</p>
                </div>
              ))}
            </div>
          }
          secondary={renderAdminOpsLockedSecondaryPanel(<>{ADMIN_OPS_LOCKED_TITLE}</>)}
        />
      </div>
    );
  }

  return renderAdminOpsLockedFallbackMessage();
}
