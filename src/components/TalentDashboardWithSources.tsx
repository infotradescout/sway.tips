import type { ComponentProps } from 'react';
import type DashboardComponent from './TalentDashboard';
import { SourcePlayerContext } from '../source-player-context';

// The existing shell remains the sole owner of account and room selection.
export function withSourcePlayerContext(TalentDashboard: typeof DashboardComponent) {
  function SourcesScopedDashboard(props: ComponentProps<typeof DashboardComponent>) {
    const profile = props.performerProfile;
    const gigId = props.selectedGigId ?? props.activeGigId;
    const ready = Boolean(profile?.owner_user_id && profile.performer_id && gigId
      && props.activeGigId === gigId && props.session.status === 'active'
      && !props.previewMode && !props.roomActionsBlocked);
    const approvedRequests = ready ? props.requests
      .filter(request => request.status === 'approved' && !request.hidden && !request.removed)
      .sort((a, b) => b.amount - a.amount) : [];
    return (
      <SourcePlayerContext.Provider value={{
        accountId: profile?.owner_user_id ?? null,
        performerId: profile?.performer_id ?? null,
        gigId, ready, previewMode: Boolean(props.previewMode),
        rooms: props.activeRooms ?? [], approvedRequests,
        onSelectRoom: props.onSelectGigId
      }}>
        <div className="sway-performer-workspace">
          <TalentDashboard {...props} />
        </div>
      </SourcePlayerContext.Provider>
    );
  }
  return function AccountScopedDashboard(props: ComponentProps<typeof DashboardComponent>) {
    // A delayed library read must never populate a different account's screen.
    // Name/profile edits and room selection keep the same account instance.
    const identity = JSON.stringify([props.performerProfile?.owner_user_id ?? null,
      props.performerProfile?.performer_id ?? null, Boolean(props.previewMode)]);
    return <SourcesScopedDashboard key={identity} {...props} />;
  };
}
