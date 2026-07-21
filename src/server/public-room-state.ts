import type {
  BackendState,
  PublicBoostContribution,
  PublicRequestItem,
  PublicRoomState,
  RequestItem
} from '../types';
import { isPatronStatusReceipt, sanitizePatronRequestStatus } from './patron-status-receipt';

const PUBLIC_REQUEST_STATUSES = new Set<RequestItem['status']>(['approved', 'fulfilled']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function projectPublicBoost(boost: RequestItem['boosts'][number]): PublicBoostContribution {
  return {
    id: boost.id,
    patronName: boost.patronName,
    amount: Number(boost.amount) || 0,
    timestamp: boost.timestamp
  };
}

export function projectPublicRequest(request: RequestItem): PublicRequestItem | null {
  if (request.hidden || request.removed || request.shadowBanned) return null;
  if (!PUBLIC_REQUEST_STATUSES.has(request.status)) return null;

  return {
    id: request.id,
    type: request.type,
    targetType: request.targetType,
    title: request.title,
    subtitle: request.subtitle,
    ...(request.albumArt ? { albumArt: request.albumArt } : {}),
    senderName: request.senderName,
    amount: Number(request.amount) || 0,
    sponsorCount: Number(request.sponsorCount) || 0,
    status: request.status as PublicRequestItem['status'],
    createdAt: request.createdAt,
    boosts: request.boosts.map(projectPublicBoost)
  };
}

export function projectPublicRoomState(
  inputState: BackendState,
  publicGigId: string | null = inputState.activeGigId
): PublicRoomState {
  return {
    session: {
      status: inputState.session.status,
      talentName: inputState.session.talentName,
      talentRole: inputState.session.talentRole,
      feeType: inputState.session.feeType,
      minimumTip: Number(inputState.session.minimumTip) || 0,
      requestsOpen: Boolean(inputState.session.requestsOpen),
      requestWindowMode: inputState.session.requestWindowMode,
      requestWindowExpiresAt: inputState.session.requestWindowExpiresAt,
      requestWindowDuration: inputState.session.requestWindowDuration,
      requestWindowLabel: inputState.session.requestWindowLabel,
      operatingMode: inputState.session.operatingMode,
      searchScope: inputState.session.searchScope,
      paymentsEnabled: inputState.session.paymentsEnabled !== false
    },
    requests: inputState.requests
      .map(projectPublicRequest)
      .filter((request): request is PublicRequestItem => Boolean(request)),
    performers: inputState.performers.map((performer) => ({
      id: performer.id,
      name: performer.name,
      role: performer.role,
      venueName: performer.venueName,
      isFeatured: performer.isFeatured,
      featuredExpiresAt: performer.featuredExpiresAt,
      minimumTip: Number(performer.minimumTip) || 0,
      avatarUrl: performer.avatarUrl
    })),
    activeGigId: publicGigId
  };
}

export function sanitizePatronMutationResponseBody(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) {
    return { success: false, error: 'Stored patron response was unavailable.' };
  }

  const sanitized: Record<string, unknown> = {};
  if (typeof body.success === 'boolean') sanitized.success = body.success;
  if (typeof body.reconciled === 'boolean') sanitized.reconciled = body.reconciled;
  if (typeof body.error === 'string') sanitized.error = body.error;

  if (isRecord(body.state)
    && isRecord(body.state.session)
    && Array.isArray(body.state.requests)
    && Array.isArray(body.state.performers)) {
    const publicGigId = typeof body.state.activeGigId === 'string' ? body.state.activeGigId : null;
    sanitized.state = projectPublicRoomState(body.state as unknown as BackendState, publicGigId);
  }

  const patronStatus = sanitizePatronRequestStatus(body.patron_status);
  if (patronStatus) sanitized.patron_status = patronStatus;
  if (isPatronStatusReceipt(body.patron_status_receipt)) {
    sanitized.patron_status_receipt = body.patron_status_receipt;
  }

  return sanitized;
}
