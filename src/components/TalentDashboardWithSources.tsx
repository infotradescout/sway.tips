import type { ComponentProps } from 'react';
import TalentDashboard from './TalentDashboard';
import { SourcePlayerContext } from '../source-player-context';

export default function TalentDashboardWithSources(props: ComponentProps<typeof TalentDashboard>) {
  const profile = props.performerProfile;
  const gigId = props.selectedGigId ?? props.activeGigId;
  const ready = Boolean(profile?.owner_user_id && profile.performer_id && gigId
    && props.activeGigId === gigId && props.session.status === 'active'
    && !props.previewMode && !props.roomActionsBlocked);
  return (
    <SourcePlayerContext.Provider value={{
      accountId: profile?.owner_user_id ?? null,
      performerId: profile?.performer_id ?? null,
      gigId,
      ready,
      previewMode: Boolean(props.previewMode),
      rooms: props.activeRooms ?? [],
      approvedRequests: ready ? props.requests.filter(request => request.status === 'approved'
        && !request.hidden && !request.removed && !request.shadowBanned).sort((a, b) => b.amount - a.amount) : [],
      onSelectRoom: props.onSelectGigId
    }}>
      <TalentDashboard {...props} />
    </SourcePlayerContext.Provider>
  );
}
