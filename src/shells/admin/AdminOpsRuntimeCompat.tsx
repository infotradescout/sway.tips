import type { ComponentType } from 'react';

export const ADMIN_OPS_DEMO_SECTION_LABELS = ['Moderation queue', 'Request lifecycle', 'Identity review'] as const;
export const ADMIN_OPS_DEMO_ITEM_BODY = 'Demo data only. No operator mutation route is enabled here.';
export const ADMIN_OPS_EMPTY_STATE_COPY = 'Operator demo has no records yet.';

export function createAdminOpsRuntimeCompat(LegacyAdminApp: ComponentType) {
	const AdminOpsRuntimeCompat = LegacyAdminApp;
	return AdminOpsRuntimeCompat;
}
