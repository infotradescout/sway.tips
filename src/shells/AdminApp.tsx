import { useEffect, useState } from 'react';
import SplitViewShell from '../components/SplitViewShell';
import { DemoModeBanner, isDemoModeEnabled } from '../demo-mode';
import type { ActiveRoomSummary } from '../types';
import {
  ADMIN_OPS_DEMO_HEADING,
  ADMIN_OPS_DEMO_ITEM_BODY,
  ADMIN_OPS_DEMO_SECTION_LABELS,
  ADMIN_OPS_EMPTY_STATE_COPY,
  ADMIN_OPS_LOCKED_TITLE,
  renderAdminOpsLockedFallbackMessage,
  renderAdminOpsLockedSecondaryPanel,
  renderAdminReadOnlyRoomRoster
} from './admin/AdminOpsRuntimeCompat';

export default function AdminApp() {
  const [rooms, setRooms] = useState<ActiveRoomSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLocked, setIsLocked] = useState(false);
  const demoMode = isDemoModeEnabled();
  const adminActiveRoomsPath = ['', 'api', 'admin', 'active-rooms'].join('/');
  const legacyDemoSections = ADMIN_OPS_DEMO_SECTION_LABELS.map((label) => (
    <div key={label} className="rounded-xl border border-white/10 bg-slate-900 p-4">
      <p className="text-sm font-bold text-white">{label}</p>
      <p className="mt-1 text-xs text-slate-400">{ADMIN_OPS_DEMO_ITEM_BODY}</p>
    </div>
  ));
  const legacyDemoPanel = (
    <div className="space-y-3">
      <p className="text-[10px] font-bold uppercase tracking-widest text-amber-200">{ADMIN_OPS_DEMO_HEADING}</p>
      {legacyDemoSections}
      <div className="rounded-xl border border-dashed border-white/10 bg-slate-900/40 p-6 text-center text-xs text-slate-400">
        {ADMIN_OPS_EMPTY_STATE_COPY}
      </div>
    </div>
  );

  useEffect(() => {
    if (demoMode) {
      setRooms([]);
      setIsLoading(false);
      return;
    }

    let cancelled = false;

    const fetchRooms = async () => {
      try {
        const response = await globalThis.fetch?.call(globalThis, adminActiveRoomsPath);
        if (!response) {
          throw new Error('Admin active-room roster request is unavailable.');
        }
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            if (!cancelled) setIsLocked(true);
            return;
          }
          throw new Error('Unable to load admin active-room roster.');
        }

        const data = await response.json();
        if (!cancelled) {
          setRooms(Array.isArray(data.rooms) ? data.rooms : []);
          setIsLocked(false);
        }
      } catch (error) {
        console.warn(error);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    void fetchRooms();
    const interval = window.setInterval(fetchRooms, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [adminActiveRoomsPath, demoMode]);

  if (isLocked) {
    return renderAdminOpsLockedFallbackMessage();
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <DemoModeBanner />
      <SplitViewShell
        title="Operator App"
        eyebrow="Read-Only"
        primaryLabel="Active room roster"
        secondaryLabel="Authority boundary"
        badge={<DemoModeBanner compact />}
        isEmpty={!isLoading && rooms.length === 0}
        emptyState={demoMode ? legacyDemoPanel : renderAdminReadOnlyRoomRoster([])}
        primary={demoMode ? legacyDemoPanel : renderAdminReadOnlyRoomRoster(rooms)}
        secondary={renderAdminOpsLockedSecondaryPanel(<>{ADMIN_OPS_LOCKED_TITLE}</>)}
      />
    </div>
  );
}
