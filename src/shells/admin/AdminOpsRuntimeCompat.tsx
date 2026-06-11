import type { ComponentType, ReactNode } from 'react';
import { Lock } from 'lucide-react';

export const ADMIN_OPS_DEMO_SECTION_LABELS = ['Moderation queue', 'Request lifecycle', 'Identity review'] as const;
export const ADMIN_OPS_DEMO_ITEM_BODY = 'Demo data only. No operator mutation route is enabled here.';
export const ADMIN_OPS_EMPTY_STATE_COPY = 'Operator demo has no records yet.';
export const ADMIN_OPS_DEMO_HEADING = 'Demo data';
export const ADMIN_OPS_LOCKED_TITLE = 'Admin authority remains locked';

export function renderAdminOpsLockedSecondaryPanel(lockedTitle: ReactNode) {
	return (
		<div className="space-y-3 text-sm">
			<div className="flex h-11 w-11 items-center justify-center rounded-xl border border-fuchsia-500/25 bg-fuchsia-500/10 text-fuchsia-300">
				<Lock className="h-5 w-5" />
			</div>
			<p className="font-bold text-white">{lockedTitle}</p>
			<p className="text-xs leading-5 text-slate-400">This Split View is reusable layout architecture. Demo fixtures can be removed without removing the admin shell boundary.</p>
		</div>
	);
}

export function createAdminOpsRuntimeCompat(LegacyAdminApp: ComponentType) {
	const AdminOpsRuntimeCompat = LegacyAdminApp;
	return AdminOpsRuntimeCompat;
}
