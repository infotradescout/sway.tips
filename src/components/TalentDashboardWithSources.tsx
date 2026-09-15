import type { ComponentProps } from 'react';
import type DashboardComponent from './TalentDashboard';
import { SourcePlayerContext } from '../source-player-context';

// Compose the shell's existing dashboard boundary rather than importing a
// second dashboard instance. Account/room ownership stays in TalentApp.
export function withSourcePlayerContext(TalentDashboard: typeof DashboardComponent) {
  return function SourcesScopedDashboard(props: ComponentProps<typeof DashboardComponent>) {
    const profile = props.performerProfile;
    const gigId = props.selectedGigId ?? props.activeGigId;
    const ready = Boolean(profile?.owner_user_id && profile.performer_id && gigId
      && props.activeGigId === gigId && props.session.status === 'active'
      && !props.previewMode && !props.roomActionsBlocked);
    // Match TalentDashboard's liveLadderQueue visibility and ordering. Sources
    // must not silently select a different request from the same live queue.
    const approvedRequests = ready ? props.requests
      .filter(request => request.status === 'approved' && !request.hidden && !request.removed)
      .sort((a, b) => b.amount - a.amount) : [];
    return (
      <SourcePlayerContext.Provider value={{
        accountId: profile?.owner_user_id ?? null,
        performerId: profile?.performer_id ?? null,
        gigId,
        ready,
        previewMode: Boolean(props.previewMode),
        rooms: props.activeRooms ?? [],
        approvedRequests,
        onSelectRoom: props.onSelectGigId
      }}>
        <TalentDashboard {...props} />
      </SourcePlayerContext.Provider>
    );
  };
}
