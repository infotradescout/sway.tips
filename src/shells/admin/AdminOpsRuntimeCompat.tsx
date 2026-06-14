import type { ComponentType, ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { ShellMessage } from '../shared';

export const ADMIN_OPS_DEMO_SECTION_LABELS = ['Safety queue', 'Request lifecycle', 'Identity checks'] as const;
export const ADMIN_OPS_DEMO_ITEM_BODY = 'Read-only status is shown here until operator access is available.';
export const ADMIN_OPS_EMPTY_STATE_COPY = 'No operator records are available yet.';
export const ADMIN_OPS_DEMO_HEADING = 'Operations overview';
export const ADMIN_OPS_LOCKED_TITLE = 'Operator access is protected';

export function renderAdminOpsDemoEmptyState(emptyStateCopy: ReactNode) {
	return (
		<div className="rounded-xl border border-dashed border-white/10 bg-slate-900/40 p-6 text-center text-xs text-slate-400">
			{emptyStateCopy}
		</div>
	);
}

export function renderAdminOpsDemoPrimaryPanel(demoHeading: ReactNode, sectionItems: ReactNode) {
	return (
		<div className="space-y-3">
			<p className="text-[10px] font-bold uppercase tracking-widest text-amber-200">{demoHeading}</p>
			{sectionItems}
		</div>
	);
}

export function renderAdminOpsDemoSectionList(sectionLabels: readonly string[], sectionItemBody: ReactNode) {
	return sectionLabels.map((label) => (
		<div key={label} className="rounded-xl border border-white/10 bg-slate-900 p-4">
			<p className="text-sm font-bold text-white">{label}</p>
			<p className="mt-1 text-xs text-slate-400">{sectionItemBody}</p>
		</div>
	));
}

export function renderAdminOpsDemoHeadingComposition(
	demoHeading: ReactNode,
	sectionLabels: readonly string[],
	sectionItemBody: ReactNode
) {
	const sectionItems = renderAdminOpsDemoSectionList(sectionLabels, sectionItemBody);
	return renderAdminOpsDemoPrimaryPanel(demoHeading, sectionItems);
}

export function renderAdminOpsLockedSecondaryPanel(lockedTitle: ReactNode) {
	return (
		<div className="space-y-3 text-sm">
			<div className="flex h-11 w-11 items-center justify-center rounded-xl border border-fuchsia-500/25 bg-fuchsia-500/10 text-fuchsia-300">
				<Lock className="h-5 w-5" />
			</div>
			<p className="font-bold text-white">{lockedTitle}</p>
			<p className="text-xs leading-5 text-slate-400">Operator tools are separated from patron and performer routes while access controls and audit records are enforced.</p>
		</div>
	);
}

export function renderAdminOpsLockedFallbackMessage() {
	return (
		<ShellMessage
			icon={<Lock className="h-5 w-5" />}
			title="Admin"
			body="Operator tools are intentionally separated from patron and performer routes. Operator features remain unavailable until authentication, audit logs, and persistent ledgers are implemented."
		/>
	);
}

export function createAdminOpsRuntimeCompat(LegacyAdminApp: ComponentType) {
	const AdminOpsRuntimeCompat = LegacyAdminApp;
	return AdminOpsRuntimeCompat;
}
