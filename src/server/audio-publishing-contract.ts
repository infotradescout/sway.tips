export const CATALOG_TRANSFER_STATES = [
  'intake',
  'source_snapshot',
  'rights_review',
  'artist_identity_mapped',
  'parity_locked',
  'new_delivery_staged',
  'store_processing',
  'overlap_live',
  'store_match_verified',
  'artist_cutover_approved',
  'old_provider_takedown',
  'cutover_monitoring',
  'tail_royalty_reconciliation',
  'complete',
  'rights_blocked',
  'parity_failed',
  'mapping_failed',
  'track_link_failed',
  'content_id_conflict',
  'revenue_gap',
  'canceled'
] as const;

export type CatalogTransferState = (typeof CATALOG_TRANSFER_STATES)[number];

export const CATALOG_TRANSFER_HOLD_STATES = [
  'rights_blocked',
  'parity_failed',
  'mapping_failed',
  'track_link_failed',
  'content_id_conflict',
  'revenue_gap'
] as const satisfies readonly CatalogTransferState[];

export const CATALOG_TRANSFER_PRESERVATION_FIELDS = [
  'original master bytes and SHA-256 checksum',
  'ISRC per recording',
  'UPC/EAN/JAN per release',
  'source distributor release and recording identifiers',
  'DSP artist, release, recording, and playlist identifiers',
  'exact titles, versions, spelling, casing, ordering, credits, and explicit flags',
  'release dates, P/C lines, territories, label, genre, and language',
  'artwork, lyrics, timed lyrics, video, spatial assets, and their checksums',
  'master, composition, sample, beat, cover, artwork, performer, and AI rights evidence',
  'collaborator split, invitation, approval, recoupment, and dispute history',
  'baseline store presence, play counts, saves, playlists, and known limitations',
  'royalty statements, withdrawals, pending balances, and tail-revenue evidence'
] as const;

export const CATALOG_TRANSFER_PROMISE =
  'Sway preserves everything the stores allow us to preserve, verifies continuity before takedown, and tells the artist exactly what cannot transfer.';

export const CATALOG_CUTOVER_EXECUTION_ENABLED = false;

export const CATALOG_CUTOVER_DISABLED_STATES = [
  'old_provider_takedown',
  'cutover_monitoring',
  'tail_royalty_reconciliation',
  'complete'
] as const satisfies readonly CatalogTransferState[];

const TRANSITIONS: Record<CatalogTransferState, readonly CatalogTransferState[]> = {
  intake: ['source_snapshot', 'canceled'],
  source_snapshot: ['rights_review', 'parity_failed', 'canceled'],
  rights_review: ['artist_identity_mapped', 'rights_blocked', 'canceled'],
  artist_identity_mapped: ['parity_locked', 'mapping_failed', 'parity_failed', 'canceled'],
  parity_locked: ['new_delivery_staged', 'parity_failed', 'rights_blocked', 'canceled'],
  new_delivery_staged: ['store_processing', 'parity_failed', 'content_id_conflict', 'canceled'],
  store_processing: ['overlap_live', 'track_link_failed', 'content_id_conflict', 'canceled'],
  overlap_live: ['store_match_verified', 'track_link_failed', 'content_id_conflict', 'canceled'],
  store_match_verified: ['artist_cutover_approved', 'track_link_failed', 'revenue_gap', 'canceled'],
  artist_cutover_approved: ['old_provider_takedown', 'track_link_failed', 'content_id_conflict', 'revenue_gap', 'canceled'],
  old_provider_takedown: ['cutover_monitoring', 'revenue_gap'],
  cutover_monitoring: ['tail_royalty_reconciliation', 'track_link_failed', 'content_id_conflict', 'revenue_gap'],
  tail_royalty_reconciliation: ['complete', 'revenue_gap'],
  complete: [],
  rights_blocked: ['rights_review', 'canceled'],
  parity_failed: ['source_snapshot', 'rights_review', 'canceled'],
  mapping_failed: ['rights_review', 'artist_identity_mapped', 'canceled'],
  track_link_failed: ['store_processing', 'overlap_live', 'cutover_monitoring', 'canceled'],
  content_id_conflict: ['store_processing', 'overlap_live', 'cutover_monitoring', 'canceled'],
  revenue_gap: ['cutover_monitoring', 'tail_royalty_reconciliation', 'canceled'],
  canceled: []
};

export type CatalogTransferEvidence = {
  sourceSnapshotCaptured?: boolean;
  rightsCleared?: boolean;
  artistIdentityMapped?: boolean;
  allItemsParityMatched?: boolean;
  newDeliveryAccepted?: boolean;
  overlapLiveVerified?: boolean;
  allRequiredStoresMatched?: boolean;
  knownLimitationsDisclosed?: boolean;
  artistCutoverApprovedAt?: string | Date | null;
  artistCutoverApprovalFingerprint?: string | null;
  oldProviderTakedownRequestedAt?: string | Date | null;
  cutoverMonitoringComplete?: boolean;
  tailRoyaltiesReconciled?: boolean;
  unresolvedHoldCount?: number;
  resolvedHoldState?: CatalogTransferState;
  holdResolutionEvidenceFingerprint?: string | null;
  expectedReleaseCount?: number;
  continuityVerifiedReleaseCount?: number;
  expectedRecordingCount?: number;
  continuityVerifiedRecordingCount?: number;
};

function requireEvidence(condition: boolean | undefined, message: string): void {
  if (!condition) throw new Error(message);
}

export function assertCatalogTransferTransition(
  current: CatalogTransferState,
  next: CatalogTransferState,
  evidence: CatalogTransferEvidence = {}
): void {
  if (!TRANSITIONS[current].includes(next)) {
    throw new Error(`Catalog transfer cannot move from ${current} to ${next}.`);
  }

  if ((CATALOG_CUTOVER_DISABLED_STATES as readonly CatalogTransferState[]).includes(next)) {
    requireEvidence(
      CATALOG_CUTOVER_EXECUTION_ENABLED,
      'Catalog cutover execution is disabled until continuity is bound to immutable provider delivery evidence.'
    );
  }

  if ((CATALOG_TRANSFER_HOLD_STATES as readonly CatalogTransferState[]).includes(current) && next !== 'canceled') {
    requireEvidence(evidence.resolvedHoldState === current, `The ${current} hold must be explicitly resolved before resuming.`);
    requireEvidence(
      Boolean(evidence.holdResolutionEvidenceFingerprint?.match(/^[0-9a-f]{64}$/)),
      'Hold resolution must be bound to a SHA-256 evidence fingerprint.'
    );
  }

  if (next === 'parity_locked') {
    requireEvidence(evidence.sourceSnapshotCaptured, 'A source snapshot is required before parity can be locked.');
    requireEvidence(evidence.rightsCleared, 'Rights review must be clear before parity can be locked.');
    requireEvidence(evidence.artistIdentityMapped, 'Artist identities must be mapped before parity can be locked.');
    requireEvidence(evidence.allItemsParityMatched, 'Every transfer item must match before parity can be locked.');
  }

  if (next === 'store_processing') {
    requireEvidence(evidence.newDeliveryAccepted, 'The replacement delivery must be accepted before store processing.');
  }

  if (next === 'store_match_verified') {
    requireEvidence(evidence.overlapLiveVerified, 'The old and replacement releases must overlap live before store matching.');
    requireEvidence(evidence.allRequiredStoresMatched, 'Every required store match must be verified or explicitly held.');
    requireEvidence(evidence.knownLimitationsDisclosed, 'Known store limitations must be disclosed before verification.');
  }

  if (next === 'artist_cutover_approved') {
    requireEvidence(Boolean(evidence.artistCutoverApprovedAt), 'The artist must explicitly approve cutover.');
    requireEvidence(
      Boolean(evidence.artistCutoverApprovalFingerprint?.match(/^[0-9a-f]{64}$/)),
      'Artist cutover approval must be bound to the exact continuity evidence.'
    );
  }

  if (next === 'old_provider_takedown') {
    requireEvidence(current === 'artist_cutover_approved', 'Old-provider takedown is only allowed after artist cutover approval.');
    requireEvidence(evidence.overlapLiveVerified, 'Verified live overlap is required before old-provider takedown.');
    requireEvidence(evidence.allRequiredStoresMatched, 'Required store matches must be verified before old-provider takedown.');
    requireEvidence(Boolean(evidence.artistCutoverApprovedAt), 'Recorded artist approval is required before old-provider takedown.');
    requireEvidence(
      Boolean(evidence.artistCutoverApprovalFingerprint?.match(/^[0-9a-f]{64}$/)),
      'The exact artist-approved continuity evidence is required before old-provider takedown.'
    );
    requireEvidence(evidence.unresolvedHoldCount === 0, 'A zero unresolved-hold count is required before old-provider takedown.');
    requireEvidence(
      Number.isInteger(evidence.expectedReleaseCount) && (evidence.expectedReleaseCount ?? 0) > 0,
      'A non-empty expected release manifest is required before old-provider takedown.'
    );
    requireEvidence(
      evidence.continuityVerifiedReleaseCount === evidence.expectedReleaseCount,
      'Every expected release must have verified continuity before old-provider takedown.'
    );
    requireEvidence(
      Number.isInteger(evidence.expectedRecordingCount) && (evidence.expectedRecordingCount ?? 0) > 0,
      'A non-empty expected recording manifest is required before old-provider takedown.'
    );
    requireEvidence(
      evidence.continuityVerifiedRecordingCount === evidence.expectedRecordingCount,
      'Every expected recording must have verified continuity before old-provider takedown.'
    );
    requireEvidence(
      Boolean(evidence.oldProviderTakedownRequestedAt),
      'The old-provider takedown request must be recorded atomically with this transition.'
    );
  }

  if (next === 'cutover_monitoring') {
    requireEvidence(Boolean(evidence.oldProviderTakedownRequestedAt), 'A recorded old-provider takedown request is required before monitoring.');
  }

  if (next === 'tail_royalty_reconciliation') {
    requireEvidence(evidence.cutoverMonitoringComplete, 'Cutover monitoring must finish before tail-royalty reconciliation.');
  }

  if (next === 'complete') {
    requireEvidence(evidence.tailRoyaltiesReconciled, 'Tail royalties must be reconciled before transfer completion.');
    requireEvidence(evidence.unresolvedHoldCount === 0, 'A zero unresolved-hold count is required before transfer completion.');
  }
}

export function normalizeIsrc(value: string): string {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(normalized)) {
    throw new Error('ISRC must contain a two-letter country code, three-character registrant code, and seven digits.');
  }
  return normalized;
}

export const SWAY_DISTRIBUTION_RIGHTS_POLICY = {
  brandOwner: 'FlavorGood Marketing',
  distributor: 'Sway',
  swayAcquiresMasterOwnership: false,
  swayAcquiresCompositionOwnership: false,
  creatorDealsRemainBetweenCreators: true,
  distributionAuthority: 'limited_non_exclusive_contractual_license',
  distributionFeeCreatesCopyrightOwnership: false
} as const;

export const SWAY_DISTRIBUTION_SALE_FEE_POLICY = {
  currency: 'USD',
  thresholdCents: 500,
  flatFeeCents: 100,
  belowThresholdBasisPoints: 2_000,
  rounding: 'down_to_cent_in_creator_favor',
  appliesPer: 'paid_audio_line_item',
  taxIncludedInFeeBase: false,
  refundsRequireFeeReversal: true,
  excludedRevenueLanes: [
    'live_room_tip',
    'live_room_request',
    'live_room_boost',
    'merch_fulfillment',
    'ticketed_show',
    'paid_stream'
  ],
  crossLaneFeeStackingAllowed: false,
  separateLaneTermsAndDisclosureRequired: true
} as const;

export function calculateSwayDistributionSaleFeeCents(preTaxAudioLineSubtotalCents: number): number {
  if (!Number.isSafeInteger(preTaxAudioLineSubtotalCents) || preTaxAudioLineSubtotalCents < 0) {
    throw new Error('Pre-tax audio line subtotal must be a non-negative safe integer number of cents.');
  }

  if (preTaxAudioLineSubtotalCents < SWAY_DISTRIBUTION_SALE_FEE_POLICY.thresholdCents) {
    return Math.floor(
      preTaxAudioLineSubtotalCents * SWAY_DISTRIBUTION_SALE_FEE_POLICY.belowThresholdBasisPoints / 10_000
    );
  }

  return SWAY_DISTRIBUTION_SALE_FEE_POLICY.flatFeeCents;
}

export const AUDIO_FILE_PAIRING_PURPOSES = ['request_files', 'send_files'] as const;
export type AudioFilePairingPurpose = (typeof AUDIO_FILE_PAIRING_PURPOSES)[number];

export const AUDIO_FILE_CONNECTION_QR_CONTRACT = {
  tokenUse: 'single_use_pairing',
  connectionLifetime: 'persistent_until_revoked',
  claimAuthentication: 'authenticated_user_required',
  pairingPath: '/talent/connect/files',
  claimSecretGeneration: 'client_web_crypto_256_bit',
  claimSecretTransport: 'url_fragment_then_authenticated_post_body',
  claimSecretHashAtRest: 'sha256_lowercase_hex',
  roomQrRelationship: 'separate_from_static_sway_room_qr',
  roomOrGigAccessGranted: false,
  projectAccessGrantedAtPairing: false,
  rawTokenStored: false
} as const;

export const AUDIO_FILE_ACCESS_MODEL = {
  connectionExposesAllFiles: false,
  selectedAssetVersionGrantRequired: true,
  originalStorageObjectRelocated: false,
  originalStorageObjectDuplicated: false,
  exactOriginalDownloadAllowedOnlyByGrant: true,
  accessRevocableWithoutDeletingOriginal: true,
  integrityIdentity: 'asset_version_sha256'
} as const;

export type AudioFilePairingClaim = {
  createdByUserId: string;
  claimingUserId: string;
  expiresAt: string | Date;
  consumedAt?: string | Date | null;
  revokedAt?: string | Date | null;
  now?: string | Date;
};

export function assertAudioFilePairingClaim(claim: AudioFilePairingClaim): void {
  if (!claim.claimingUserId) throw new Error('An authenticated user is required to claim a file connection QR.');
  if (claim.createdByUserId === claim.claimingUserId) throw new Error('A file connection QR cannot be claimed by its creator.');
  if (claim.revokedAt) throw new Error('This file connection QR was revoked.');
  if (claim.consumedAt) throw new Error('This file connection QR has already been used.');
  const now = new Date(claim.now ?? Date.now());
  if (new Date(claim.expiresAt) <= now) throw new Error('This file connection QR has expired.');
}

export const CONTINUUM_CONNECTOR_CAPABILITIES = {
  hostedSourceManifest: true,
  embedPlayer: true,
  sourceDownload: true,
  derivativePlanning: true,
  losslessBinaryMasterStorage: false,
  resumableMultipartUpload: false,
  durableAccountPermissions: false,
  privateCollaboration: false,
  audioPlayback: false,
  externalDspDelivery: false,
  directSales: false
} as const;

export const AUDIO_PUBLISHING_RUNTIME_CAPABILITIES = {
  schemaFoundation: true,
  catalogIntakeModel: true,
  catalogCutoverAutomation: false,
  losslessObjectStorage: false,
  resumableUploadRoutes: false,
  fileConnectionQrRoutes: false,
  privateDownloadAuthorization: false,
  creatorDealExecution: false,
  swayPlayback: false,
  externalDspDelivery: false,
  directSales: false,
  royaltyAccounting: false
} as const;
