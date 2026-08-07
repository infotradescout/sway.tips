const ALLOWED_PAYLOAD_KEYS = [
  'shell',
  'surface',
  'event',
  'route_family',
  'has_route_context',
  'has_session_context',
  'build_commit',
  'attribution_channel',
  'entity_kind'
] as const;

const ALLOWED_EVENTS = [
  'telemetry_friction_patron_no_session_recovery_viewed',
  'telemetry_friction_patron_no_session_return_home_clicked',
  'room_entry_viewed',
  'room_entry_recovery_viewed',
  'share_link_copied',
  'request_started',
  'boost_started',
  'performer_profile_claim_started',
  'guest_to_performer_started',
  'public_profile_shared',
  'public_event_shared',
  'public_release_shared',
  'discovery_landing',
  'discovery_entity_view',
  'discovery_primary_action'
] as const;

type ShellFrictionEvent = (typeof ALLOWED_EVENTS)[number];

type ShellFrictionPayload = {
  shell: 'patron' | 'talent';
  surface: 'recovery-view' | 'room-entry' | 'share-kit' | 'public-profile' | 'public-event' | 'public-release';
  route_family: string;
  has_route_context: boolean;
  has_session_context: boolean;
  build_commit: string;
  attribution_channel?: string;
  entity_kind?: string;
};

function isAllowedEvent(event: string): event is ShellFrictionEvent {
  return ALLOWED_EVENTS.includes(event as ShellFrictionEvent);
}

function hasOnlyAllowedPayloadKeys(payload: Record<string, unknown>) {
  return Object.keys(payload).every((key) =>
    ALLOWED_PAYLOAD_KEYS.includes(key as (typeof ALLOWED_PAYLOAD_KEYS)[number])
  );
}

function isValidPayload(payload: Record<string, unknown>): payload is ShellFrictionPayload {
  const attributionOk = payload.attribution_channel === undefined
    || (typeof payload.attribution_channel === 'string'
      && payload.attribution_channel.length > 0
      && payload.attribution_channel.length <= 64
      && !/[?&=#]/.test(payload.attribution_channel));
  const entityOk = payload.entity_kind === undefined
    || (typeof payload.entity_kind === 'string'
      && ['performer', 'event', 'release', 'live_room'].includes(payload.entity_kind));

  return (
    (payload.shell === 'patron' || payload.shell === 'talent') &&
    (payload.surface === 'recovery-view' || payload.surface === 'room-entry' || payload.surface === 'share-kit' || payload.surface === 'public-profile' || payload.surface === 'public-event' || payload.surface === 'public-release') &&
    typeof payload.route_family === 'string' &&
    typeof payload.has_route_context === 'boolean' &&
    typeof payload.has_session_context === 'boolean' &&
    typeof payload.build_commit === 'string' &&
    attributionOk &&
    entityOk
  );
}

export function sendFrictionEvent(event: string, payload: Record<string, unknown>) {
  try {
    if (!isAllowedEvent(event)) return;
    if (!hasOnlyAllowedPayloadKeys(payload)) return;
    if (!isValidPayload(payload)) return;

    void fetch('/api/analytics/shell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event,
        shell: payload.shell,
        surface: payload.surface,
        route_family: payload.route_family,
        has_route_context: payload.has_route_context,
        has_session_context: payload.has_session_context,
        build_commit: payload.build_commit,
        ...(payload.attribution_channel ? { attribution_channel: payload.attribution_channel } : {}),
        ...(payload.entity_kind ? { entity_kind: payload.entity_kind } : {})
      })
    }).catch(() => {});
  } catch {
    // Friction capture must never interrupt the patron recovery flow.
  }
}

export function sendPatronNoSessionRecoveryViewed(payload: Record<string, unknown>) {
  sendFrictionEvent('room_entry_recovery_viewed', payload);
}

export function sendPatronNoSessionReturnHomeClicked(payload: Record<string, unknown>) {
  sendFrictionEvent('telemetry_friction_patron_no_session_return_home_clicked', payload);
}

export function sendRoomEntryViewed(payload: Record<string, unknown>) {
  sendFrictionEvent('room_entry_viewed', payload);
}

export function sendRoomEntryRecoveryViewed(payload: Record<string, unknown>) {
  sendFrictionEvent('room_entry_recovery_viewed', payload);
}

export function sendShareLinkCopied(payload: Record<string, unknown>) {
  sendFrictionEvent('share_link_copied', payload);
}

export function sendRequestStarted(payload: Record<string, unknown>) {
  sendFrictionEvent('request_started', payload);
}

export function sendBoostStarted(payload: Record<string, unknown>) {
  sendFrictionEvent('boost_started', payload);
}

export function sendAcquisitionEvent(
  event: 'performer_profile_claim_started' | 'guest_to_performer_started' | 'public_profile_shared' | 'public_event_shared' | 'public_release_shared',
  payload: Record<string, unknown>
) {
  sendFrictionEvent(event, payload);
}

export function sendDiscoveryEvent(
  event: 'discovery_landing' | 'discovery_entity_view' | 'discovery_primary_action',
  payload: Record<string, unknown>
) {
  sendFrictionEvent(event, payload);
}
