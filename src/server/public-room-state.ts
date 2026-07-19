import type {
  BackendState,
  BoostContribution,
  PatronRequestStatus,
  RequestItem
} from '../types';

export type PublicRoomRequest = Pick<
  RequestItem,
  | 'id'
  | 'type'
  | 'targetType'
  | 'title'
  | 'subtitle'
  | 'albumArt'
  | 'senderName'
  | 'amount'
  | 'sponsorCount'
  | 'status'
  | 'createdAt'
> & {
  boosts: Array<Pick<BoostContribution, 'id' | 'patronName' | 'amount' | 'timestamp'>>;
};

export type PublicRoomState = {
  session: {
    status: BackendState['session']['status'];
    talentName: string;
    talentRole: BackendState['session']['talentRole'];
    feeType: BackendState['session']['feeType'];
    minimumTip: number;
    requestsOpen: boolean;
    requestWindowMode: BackendState['session']['requestWindowMode'];
    requestWindowExpiresAt: string | null;
    operatingMode: BackendState['session']['operatingMode'];
    searchScope: BackendState['session']['searchScope'];
    paymentsEnabled: boolean;
  };
  requests: PublicRoomRequest[];
  performers: Array<{
    id: string;
    name: string;
    role: BackendState['performers'][number]['role'];
    venueName: string;
    isFeatured: boolean;
    featuredExpiresAt: string | null;
    minimumTip: number;
    avatarUrl: string;
  }>;
  activeGigId: null;
};

function projectSafeBoost(boost: BoostContribution) {
  return {
    id: boost.id,
    patronName: boost.patronName,
    amount: boost.amount,
    timestamp: boost.timestamp
  };
}

function projectSafeRequest(request: RequestItem): PublicRoomRequest {
  return {
    id: request.id,
    type: request.type,
    targetType: request.targetType,
    title: request.title,
    subtitle: request.subtitle,
    ...(request.albumArt ? { albumArt: request.albumArt } : {}),
    senderName: request.senderName,
    amount: request.amount,
    sponsorCount: request.sponsorCount,
    status: request.status,
    createdAt: request.createdAt,
    boosts: request.boosts.map(projectSafeBoost)
  };
}

export function isPublicRoomRequest(request: RequestItem) {
  return (request.status === 'approved' || request.status === 'fulfilled')
    && !request.shadowBanned
    && !request.hidden
    && !request.removed;
}

export function projectPublicRoomRequest(request: RequestItem) {
  return isPublicRoomRequest(request) ? projectSafeRequest(request) : null;
}

export function projectPatronRequestStatus(request: RequestItem): PatronRequestStatus {
  if (request.hidden || request.removed || request.status === 'denied') {
    return { requestId: request.id, status: 'not_approved' };
  }
  if (request.status === 'fulfilled') {
    return { requestId: request.id, status: 'fulfilled' };
  }
  if (request.status === 'approved' && !request.shadowBanned) {
    return { requestId: request.id, status: 'approved' };
  }
  return { requestId: request.id, status: 'pending' };
}

export function projectPublicRoomState(input: BackendState): PublicRoomState {
  return {
    session: {
      status: input.session.status,
      talentName: input.session.talentName,
      talentRole: input.session.talentRole,
      feeType: input.session.feeType,
      minimumTip: input.session.minimumTip,
      requestsOpen: input.session.requestsOpen,
      requestWindowMode: input.session.requestWindowMode,
      requestWindowExpiresAt: input.session.requestWindowExpiresAt,
      operatingMode: input.session.operatingMode,
      searchScope: input.session.searchScope,
      paymentsEnabled: input.session.paymentsEnabled
    },
    requests: input.requests.flatMap((request) => {
      const projected = projectPublicRoomRequest(request);
      return projected ? [projected] : [];
    }),
    performers: input.performers.map((performer) => ({
      id: performer.id,
      name: performer.name,
      role: performer.role,
      venueName: performer.venueName,
      isFeatured: performer.isFeatured,
      featuredExpiresAt: performer.featuredExpiresAt,
      minimumTip: performer.minimumTip,
      avatarUrl: performer.avatarUrl
    })),
    activeGigId: null
  };
}

export function projectOperatorRoomState(input: BackendState): BackendState {
  return {
    ...input,
    requests: input.requests.map(({ patronStatusReceipts: _receiptHashes, ...request }) => request)
  };
}

export function projectPatronActionResponse(input: {
  success?: unknown;
  reconciled?: unknown;
  request?: RequestItem | null;
  state: BackendState;
}) {
  return {
    success: input.success === true,
    ...(input.reconciled === true ? { reconciled: true } : {}),
    ...(input.request ? { request: projectPatronRequestStatus(input.request) } : {}),
    state: projectPublicRoomState(input.state)
  };
}

export function projectStoredPatronActionResponse(input: unknown) {
  if (!input || typeof input !== 'object') return null;
  const candidate = input as {
    success?: unknown;
    reconciled?: unknown;
    request?: RequestItem | PatronRequestStatus;
    state?: BackendState;
  };
  if (!candidate.state?.session || !Array.isArray(candidate.state.requests)) return null;
  const alreadyProjectedRequest = candidate.request
    && 'requestId' in candidate.request
    && (candidate.request.status === 'pending'
      || candidate.request.status === 'approved'
      || candidate.request.status === 'not_approved'
      || candidate.request.status === 'fulfilled')
    ? candidate.request
    : null;
  const rawRequest = candidate.request && 'id' in candidate.request
    ? candidate.request
    : null;

  return {
    success: candidate.success === true,
    ...(candidate.reconciled === true ? { reconciled: true } : {}),
    ...(alreadyProjectedRequest
      ? { request: alreadyProjectedRequest }
      : rawRequest
        ? { request: projectPatronRequestStatus(rawRequest) }
        : {}),
    state: projectPublicRoomState(candidate.state)
  };
}
