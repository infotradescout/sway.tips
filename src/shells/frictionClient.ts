const ALLOWED_PAYLOAD_KEYS = [
  'shell',
  'surface',
  'event',
  'route_family',
  'has_route_context',
  'has_session_context',
  'build_commit'
] as const;

const ALLOWED_EVENTS = [
  'telemetry_friction_patron_no_session_recovery_viewed',
  'telemetry_friction_patron_no_session_return_home_clicked'
] as const;

type ShellFrictionEvent = (typeof ALLOWED_EVENTS)[number];

type ShellFrictionPayload = {
  shell: 'patron';
  surface: 'recovery-view';
  route_family: string;
  has_route_context: boolean;
  has_session_context: boolean;
  build_commit: string;
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
  return (
    payload.shell === 'patron' &&
    payload.surface === 'recovery-view' &&
    typeof payload.route_family === 'string' &&
    typeof payload.has_route_context === 'boolean' &&
    typeof payload.has_session_context === 'boolean' &&
    typeof payload.build_commit === 'string'
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
        build_commit: payload.build_commit
      })
    }).catch(() => {});
  } catch {
    // Friction capture must never interrupt the patron recovery flow.
  }
}

export function sendPatronNoSessionRecoveryViewed(payload: Record<string, unknown>) {
  sendFrictionEvent('telemetry_friction_patron_no_session_recovery_viewed', payload);
}

export function sendPatronNoSessionReturnHomeClicked(payload: Record<string, unknown>) {
  sendFrictionEvent('telemetry_friction_patron_no_session_return_home_clicked', payload);
}
