import {
  getDiscoveryEntryPath,
  getOrCreateDiscoveryJourneyId
} from './discoveryAttribution';
import { classifyBrowserTraffic } from './trafficTruthClient';

const ALLOWED_PAYLOAD_KEYS = [
  'shell',
  'surface',
  'event',
  'route_family',
  'has_route_context',
  'has_session_context',
  'build_commit',
  'attribution_channel',
  'entity_kind',
  'entity_key',
  'action_kind',
  'experiment_key',
  'visibility_eligibility',
  'search_phrase',
  'link_strength'
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
  'discovery_primary_action',
  'internal_search_zero_result'
] as const;

type ShellFrictionEvent = (typeof ALLOWED_EVENTS)[number];

type ShellFrictionPayload = {
  shell: 'patron' | 'talent';
  surface: 'recovery-view' | 'room-entry' | 'share-kit' | 'public-profile' | 'public-event' | 'public-release' | 'public-discover';
  route_family: string;
  has_route_context: boolean;
  has_session_context: boolean;
  build_commit: string;
  attribution_channel?: string;
  entity_kind?: string;
  entity_key?: string;
  action_kind?: string;
  experiment_key?: string;
  visibility_eligibility?: string;
  search_phrase?: string;
  link_strength?: string;
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
  const entityKeyOk = payload.entity_key === undefined
    || (typeof payload.entity_key === 'string' && /^[a-z0-9][a-z0-9_.:-]{0,127}$/i.test(payload.entity_key));
  const actionKindOk = payload.action_kind === undefined
    || (typeof payload.action_kind === 'string'
      && ['follow', 'room_entry', 'event_entry', 'ticket', 'tip', 'request', 'boost', 'share', 'other'].includes(payload.action_kind));
  const experimentOk = payload.experiment_key === undefined
    || (typeof payload.experiment_key === 'string' && /^[a-z0-9][a-z0-9_.:-]{0,127}$/i.test(payload.experiment_key));
  const visibilityOk = payload.visibility_eligibility === undefined
    || (typeof payload.visibility_eligibility === 'string'
      && ['eligible', 'ineligible', 'unknown'].includes(payload.visibility_eligibility));
  const searchPhraseOk = payload.search_phrase === undefined
    || (typeof payload.search_phrase === 'string'
      && payload.search_phrase.trim().length > 0
      && payload.search_phrase.length <= 160
      && !/@|https?:\/\/|www\.|\b\d{7,}\b|\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/i.test(payload.search_phrase));
  const linkStrengthOk = payload.link_strength === undefined
    || (typeof payload.link_strength === 'string'
      && ['direct_server_observed', 'client_correlated_unverified', 'unknown_unavailable'].includes(payload.link_strength));

  return (
    (payload.shell === 'patron' || payload.shell === 'talent') &&
    (payload.surface === 'recovery-view' || payload.surface === 'room-entry' || payload.surface === 'share-kit' || payload.surface === 'public-profile' || payload.surface === 'public-event' || payload.surface === 'public-release' || payload.surface === 'public-discover') &&
    typeof payload.route_family === 'string' &&
    typeof payload.has_route_context === 'boolean' &&
    typeof payload.has_session_context === 'boolean' &&
    typeof payload.build_commit === 'string' &&
    attributionOk &&
    entityOk &&
    entityKeyOk &&
    actionKindOk &&
    experimentOk &&
    visibilityOk &&
    searchPhraseOk &&
    linkStrengthOk
  );
}

export function sendFrictionEvent(event: string, payload: Record<string, unknown>) {
  try {
    if (!isAllowedEvent(event)) return;
    if (!hasOnlyAllowedPayloadKeys(payload)) return;
    if (!isValidPayload(payload)) return;

    const trafficClass = classifyBrowserTraffic();
    void fetch('/api/analytics/shell', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sway-Traffic-Class': trafficClass
      },
      body: JSON.stringify({
        event,
        shell: payload.shell,
        surface: payload.surface,
        route_family: payload.route_family,
        has_route_context: payload.has_route_context,
        has_session_context: payload.has_session_context,
        build_commit: payload.build_commit,
        journey_id: getOrCreateDiscoveryJourneyId(),
        entry_path: getDiscoveryEntryPath(),
        ...(payload.attribution_channel ? { attribution_channel: payload.attribution_channel } : {}),
        ...(payload.entity_kind ? { entity_kind: payload.entity_kind } : {}),
        ...(payload.entity_key ? { entity_key: payload.entity_key } : {}),
        ...(payload.action_kind ? { action_kind: payload.action_kind } : {}),
        ...(payload.experiment_key ? { experiment_key: payload.experiment_key } : {}),
        ...(payload.visibility_eligibility ? { visibility_eligibility: payload.visibility_eligibility } : {}),
        ...(payload.search_phrase ? { search_phrase: payload.search_phrase } : {}),
        link_strength: payload.link_strength || 'client_correlated_unverified'
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
  event:
    | 'discovery_landing'
    | 'discovery_entity_view'
    | 'discovery_primary_action'
    | 'internal_search_zero_result',
  payload: Record<string, unknown>
) {
  sendFrictionEvent(event, payload);
}
