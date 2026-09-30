export const PLAYBACK_SOURCE_KEYS = ['virtualdj', 'generic_midi'] as const;
export const PLAYBACK_ACTIONS = ['load', 'play', 'pause', 'stop', 'cue', 'next', 'previous'] as const;
export const PLAYBACK_CONFIRMATION_STATUSES = ['exact_track_confirmed', 'source_state_confirmed', 'source_acknowledged'] as const;
export const PLAYBACK_LOAD_MATCH_MODES = ['exact_library_path'] as const;
// Allow only small ordinary clock/transport skew around the server-owned
// claim-to-completion window. Booth evidence outside it cannot confirm.
export const PLAYBACK_EVIDENCE_CLOCK_SKEW_MS = 5_000;

export type PlaybackSourceKey = (typeof PLAYBACK_SOURCE_KEYS)[number];
export type PlaybackAction = (typeof PLAYBACK_ACTIONS)[number];
export type PlaybackCommandStatus = 'queued' | 'claimed' | 'succeeded' | 'failed' | 'expired';
export type PlaybackConfirmationStatus = (typeof PLAYBACK_CONFIRMATION_STATUSES)[number];
export type PlaybackLoadMatchMode = (typeof PLAYBACK_LOAD_MATCH_MODES)[number];

export function projectPlaybackCommandReceipt(command: {
  id: string;
  clientCommandId: string;
  gigId: string;
  sourceKey: string;
  action: string;
  status: string;
  createdAt: Date | string;
  updatedAt: Date | string;
}) {
  return {
    id: command.id,
    clientCommandId: command.clientCommandId,
    gigId: command.gigId,
    sourceKey: command.sourceKey,
    action: command.action,
    status: command.status,
    createdAt: command.createdAt,
    updatedAt: command.updatedAt
  };
}

export type PlaybackTrackReference = {
  requestId?: string | null;
  sourceTrackId?: string | null;
  externalTrackId?: string | null;
  title?: string | null;
  artist?: string | null;
  path?: string | null;
};

export type PlaybackCommandPayload = {
  deck?: number | null;
  track?: PlaybackTrackReference | null;
  // Assigned by the server from a fresh observed source state. Browser input
  // is deliberately not allowed to choose or spoof a bridge instance.
  targetBridgeInstanceId?: string | null;
  // Immutable identity of normalized browser/local-button intent. Target and
  // resolved booth execution details are deliberately excluded.
  callerIntentFingerprint?: string | null;
};

export type PlaybackCompletionResult = {
  acknowledgement: 'accepted' | null;
  confirmationStatus: PlaybackConfirmationStatus;
  observedAt: string | null;
  observedDeck: number | null;
  observedTrackTitle: string | null;
  observedTrackArtist: string | null;
  observedPlaying: boolean | null;
  loadMatchMode: PlaybackLoadMatchMode | null;
};

export type PlaybackStateInput = {
  sourceKey: PlaybackSourceKey;
  transport: string;
  bridgeInstanceId: string;
  connectionStatus: 'connected' | 'degraded' | 'disconnected';
  deck?: number | null;
  trackTitle?: string | null;
  trackArtist?: string | null;
  trackPath?: string | null;
  externalTrackId?: string | null;
  playing?: boolean | null;
  positionMs?: number | null;
  durationMs?: number | null;
  bpmTimes100?: number | null;
  observedAt?: string | Date | null;
  metadata?: Record<string, unknown> | null;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TEXT_LENGTH = 512;

function normalizeText(value: unknown, maxLength = MAX_TEXT_LENGTH) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

export function playbackCallerIntentText(input: {
  sourceKey: PlaybackSourceKey;
  action: PlaybackAction;
  payload: PlaybackCommandPayload;
}) {
  const payload = normalizePlaybackCommandPayload(input.payload);
  return JSON.stringify({
    sourceKey: input.sourceKey,
    action: input.action,
    deck: payload.deck ?? null,
    track: payload.track ? {
      requestId: payload.track.requestId ?? null,
      sourceTrackId: payload.track.sourceTrackId ?? null,
      externalTrackId: payload.track.externalTrackId ?? null,
      title: payload.track.title ?? null,
      artist: payload.track.artist ?? null,
      path: payload.track.path ?? null
    } : null
  });
}

export function normalizePlaybackCompletionResult(value: unknown, context: {
  action: PlaybackAction;
  targetDeck: number | null;
  claimedAt: Date | string | number | null;
  completionReceivedAt: Date | string | number | null;
}): PlaybackCompletionResult {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const observedDeck = normalizePlaybackDeck(input.observedDeck);
  const observedPlaying = typeof input.observedPlaying === 'boolean' ? input.observedPlaying : null;
  const targetMatches = context.targetDeck !== null && observedDeck === context.targetDeck;
  const rawObservedAt = typeof input.observedAt === 'string' ? input.observedAt : null;
  const observedAtMs = rawObservedAt ? Date.parse(rawObservedAt) : NaN;
  const claimedAtMs = context.claimedAt instanceof Date
    ? context.claimedAt.getTime()
    : typeof context.claimedAt === 'number'
      ? context.claimedAt
      : Date.parse(String(context.claimedAt ?? ''));
  const completionReceivedAtMs = context.completionReceivedAt instanceof Date
    ? context.completionReceivedAt.getTime()
    : typeof context.completionReceivedAt === 'number'
      ? context.completionReceivedAt
      : Date.parse(String(context.completionReceivedAt ?? ''));
  const observedAt = Number.isFinite(observedAtMs)
    && Number.isFinite(claimedAtMs)
    && Number.isFinite(completionReceivedAtMs)
    && observedAtMs >= claimedAtMs - PLAYBACK_EVIDENCE_CLOCK_SKEW_MS
    && observedAtMs <= completionReceivedAtMs + PLAYBACK_EVIDENCE_CLOCK_SKEW_MS
    ? new Date(observedAtMs).toISOString()
    : null;
  const loadMatchMode = PLAYBACK_LOAD_MATCH_MODES.includes(input.loadMatchMode as PlaybackLoadMatchMode)
    ? input.loadMatchMode as PlaybackLoadMatchMode
    : null;
  const acknowledgement = input.acknowledgement === 'accepted' ? 'accepted' : null;
  const canConfirm = acknowledgement === 'accepted' && observedAt !== null && targetMatches;
  let confirmationStatus: PlaybackConfirmationStatus = 'source_acknowledged';
  if (canConfirm && context.action === 'load' && loadMatchMode === 'exact_library_path'
    && input.confirmationStatus === 'exact_track_confirmed') {
    confirmationStatus = 'exact_track_confirmed';
  } else if (canConfirm && context.action === 'play' && observedPlaying === true
    && input.confirmationStatus === 'source_state_confirmed') {
    confirmationStatus = 'source_state_confirmed';
  } else if (canConfirm && context.action === 'pause' && observedPlaying === false
    && input.confirmationStatus === 'source_state_confirmed') {
    confirmationStatus = 'source_state_confirmed';
  }
  return {
    acknowledgement,
    confirmationStatus,
    observedAt,
    observedDeck,
    observedTrackTitle: normalizeText(input.observedTrackTitle, 200),
    observedTrackArtist: normalizeText(input.observedTrackArtist, 200),
    observedPlaying,
    loadMatchMode
  };
}

function normalizeNonNegativeInteger(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.min(Math.floor(parsed), 2_147_483_647);
}

export function isPlaybackSourceKey(value: unknown): value is PlaybackSourceKey {
  return typeof value === 'string' && PLAYBACK_SOURCE_KEYS.includes(value as PlaybackSourceKey);
}

export function isPlaybackAction(value: unknown): value is PlaybackAction {
  return typeof value === 'string' && PLAYBACK_ACTIONS.includes(value as PlaybackAction);
}

export function normalizePlaybackDeck(value: unknown) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 8) return null;
  return parsed;
}

export function normalizePlaybackCommandPayload(value: unknown): PlaybackCommandPayload {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const rawTrack = input.track && typeof input.track === 'object'
    ? input.track as Record<string, unknown>
    : null;
  const track = rawTrack
    ? {
        requestId: normalizeText(rawTrack.requestId, 128),
        sourceTrackId: normalizeText(rawTrack.sourceTrackId, 128),
        externalTrackId: normalizeText(rawTrack.externalTrackId, 256),
        title: normalizeText(rawTrack.title, 200),
        artist: normalizeText(rawTrack.artist, 200),
        path: normalizeText(rawTrack.path, 2_048)
      }
    : null;

  return {
    deck: normalizePlaybackDeck(input.deck),
    track: track && Object.values(track).some(Boolean) ? track : null
  };
}

export function validatePlaybackCommandInput(input: {
  clientCommandId: unknown;
  sourceKey: unknown;
  action: unknown;
  payload: unknown;
}) {
  const clientCommandId = normalizeText(input.clientCommandId, 128);
  if (!clientCommandId) return { ok: false as const, error: 'clientCommandId is required.' };
  if (!isPlaybackSourceKey(input.sourceKey)) return { ok: false as const, error: 'Unsupported playback source.' };
  if (!isPlaybackAction(input.action)) return { ok: false as const, error: 'Unsupported playback action.' };

  const payload = normalizePlaybackCommandPayload(input.payload);
  if (input.action === 'load' && !payload.track?.requestId && !payload.track?.sourceTrackId && !payload.track?.path && !payload.track?.title) {
    return { ok: false as const, error: 'Load requires a room request or track reference.' };
  }

  return {
    ok: true as const,
    command: {
      clientCommandId,
      sourceKey: input.sourceKey,
      action: input.action,
      payload
    }
  };
}

export function normalizePlaybackStateInput(value: unknown): PlaybackStateInput | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  if (!isPlaybackSourceKey(input.sourceKey)) return null;
  const transport = normalizeText(input.transport, 80);
  const bridgeInstanceId = normalizeText(input.bridgeInstanceId, 128);
  const connectionStatus = input.connectionStatus;
  if (!transport || !bridgeInstanceId || !['connected', 'degraded', 'disconnected'].includes(String(connectionStatus))) {
    return null;
  }

  const observedAt = input.observedAt instanceof Date
    ? input.observedAt
    : typeof input.observedAt === 'string'
      ? new Date(input.observedAt)
      : new Date();
  if (!Number.isFinite(observedAt.getTime())) return null;

  return {
    sourceKey: input.sourceKey,
    transport,
    bridgeInstanceId,
    connectionStatus: connectionStatus as PlaybackStateInput['connectionStatus'],
    deck: normalizePlaybackDeck(input.deck),
    trackTitle: normalizeText(input.trackTitle, 200),
    trackArtist: normalizeText(input.trackArtist, 200),
    trackPath: normalizeText(input.trackPath, 2_048),
    externalTrackId: normalizeText(input.externalTrackId, 256),
    playing: typeof input.playing === 'boolean' ? input.playing : null,
    positionMs: normalizeNonNegativeInteger(input.positionMs),
    durationMs: normalizeNonNegativeInteger(input.durationMs),
    bpmTimes100: normalizeNonNegativeInteger(input.bpmTimes100),
    observedAt,
    metadata: input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
      ? input.metadata as Record<string, unknown>
      : null
  };
}

export function isPlaybackStateFresh(observedAt: string | Date | null | undefined, now = Date.now(), maxAgeMs = 15_000) {
  const timestamp = observedAt instanceof Date ? observedAt.getTime() : Date.parse(String(observedAt ?? ''));
  return Number.isFinite(timestamp) && now - timestamp <= maxAgeMs && timestamp <= now + 5_000;
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
