import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const failures = [];

function read(relPath) {
  const absolutePath = join(root, relPath);
  if (!existsSync(absolutePath)) {
    failures.push(`Missing audio publishing foundation file: ${relPath}`);
    return '';
  }
  return readFileSync(absolutePath, 'utf8');
}

const schema = read('src/db/schema.ts');
const migration = read('drizzle/0023_audio_publishing_foundation.sql');
const contract = read('src/server/audio-publishing-contract.ts');
const doc = read('docs/SWAY_AUDIO_PUBLISHING_FOUNDATION.md');
const packageJson = read('package.json');
const roomQrSources = [
  read('src/components/PerformerShareKit.tsx'),
  read('src/components/PerformerRoomShare.tsx'),
  read('src/components/PerformerAudienceScreen.tsx')
].join('\n');

const requiredSchemaTerms = [
  "pgEnum('audio_project_kind'",
  "'music'",
  "'comedy'",
  "'podcast'",
  "'other_audio'",
  "pgEnum('audio_asset_integrity_status'",
  "pgEnum('audio_file_pairing_purpose'",
  "'request_files'",
  "'send_files'",
  "pgEnum('music_distribution_mode'",
  "'sway_only'",
  "'sway_first'",
  "'everywhere'",
  "pgEnum('catalog_transfer_status'",
  "export const audioProjects = pgTable('audio_projects'",
  "export const audioProjectAccessGrants = pgTable('audio_project_access_grants'",
  "export const audioProjectInvitations = pgTable('audio_project_invitations'",
  "export const audioAssets = pgTable('audio_assets'",
  "export const audioUploadSessions = pgTable('audio_upload_sessions'",
  "export const audioUploadParts = pgTable('audio_upload_parts'",
  "export const audioProjectAssetVersions = pgTable('audio_project_asset_versions'",
  "integrityVerifierKey: text('integrity_verifier_key').notNull()",
  "integrityVerifiedAt: timestamp('integrity_verified_at'",
  "integrityEvidence: jsonb('integrity_evidence').notNull()",
  'audio_upload_sessions_completion_coherent',
  "export const audioAssetDerivatives = pgTable('audio_asset_derivatives'",
  "export const audioFileConnections = pgTable('audio_file_connections'",
  "export const audioFilePairingTokens = pgTable('audio_file_pairing_tokens'",
  "export const audioFileAccessGrants = pgTable('audio_file_access_grants'",
  "export const audioFileConnectionEvents = pgTable('audio_file_connection_events'",
  "export const audioShareGrants = pgTable('audio_share_grants'",
  "export const audioReviewEvents = pgTable('audio_review_events'",
  "export const musicRecordings = pgTable('music_recordings'",
  "export const musicRecordingCredits = pgTable('music_recording_credits'",
  "export const musicReleases = pgTable('music_releases'",
  "export const musicReleaseRecordings = pgTable('music_release_recordings'",
  "export const musicRightsDeclarations = pgTable('music_rights_declarations'",
  "export const musicRightsDeclarationEvents = pgTable('music_rights_declaration_events'",
  'music_rights_declarations_evidence_required',
  "export const audioCreatorDeals = pgTable('audio_creator_deals'",
  "export const audioCreatorDealParties = pgTable('audio_creator_deal_parties'",
  "export const audioCreatorDealAllocations = pgTable('audio_creator_deal_allocations'",
  "export const audioCreatorDealEvents = pgTable('audio_creator_deal_events'",
  "export const musicDistributionDeliveries = pgTable('music_distribution_deliveries'",
  "export const musicDistributionDeliveryEvents = pgTable('music_distribution_delivery_events'",
  'music_distribution_deliveries_metadata_fingerprint_valid',
  'music_distribution_delivery_events_idempotency_required',
  'music_distribution_delivery_events_status_shape',
  'music_distribution_delivery_events_provider_shape',
  "export const musicCatalogTransfers = pgTable('music_catalog_transfers'",
  "export const musicCatalogTransferItems = pgTable('music_catalog_transfer_items'",
  "export const musicCatalogTransferRecordings = pgTable('music_catalog_transfer_recordings'",
  "export const musicCatalogTransferEvents = pgTable('music_catalog_transfer_events'",
  "continuityEvidenceFingerprint: text('continuity_evidence_fingerprint')",
  "export const mediaConnectorLinks = pgTable('media_connector_links'"
];

for (const term of requiredSchemaTerms) {
  if (!schema.includes(term)) failures.push(`Audio publishing schema missing required term: ${term}`);
}

const losslessSchemaTerms = [
  "idempotencyKey: text('idempotency_key').notNull()",
  "expectedByteSize: bigint('expected_byte_size'",
  "expectedSha256: text('expected_sha256').notNull()",
  "providerUploadId: text('provider_upload_id').notNull()",
  "partNumber: integer('part_number').notNull()",
  "providerChecksum: text('provider_checksum')",
  "versionNumber: integer('version_number').notNull()",
  "storageProvider: text('storage_provider').notNull()",
  "storageBucket: text('storage_bucket').notNull()",
  "storageKey: text('storage_key').notNull()",
  "byteSize: bigint('byte_size'",
  "sha256: text('sha256').notNull()",
  "sampleRateHz: integer('sample_rate_hz')",
  "bitDepth: integer('bit_depth')",
  "originalPreserved: boolean('original_preserved').notNull().default(true)",
  "sourceAssetVersionId: uuid('source_asset_version_id').notNull()",
  "'preview_stream'",
  "'continuum_source'",
  "'continuum_render'"
];

for (const term of losslessSchemaTerms) {
  if (!schema.includes(term)) failures.push(`Lossless asset contract missing schema term: ${term}`);
}

const fileConnectionSchemaTerms = [
  "memberOneUserId: uuid('member_one_user_id').notNull()",
  "memberTwoUserId: uuid('member_two_user_id').notNull()",
  "createdFromPurpose: audioFilePairingPurposeEnum('created_from_purpose').notNull()",
  "revokedAt: timestamp('revoked_at'",
  "tokenHash: text('token_hash').notNull()",
  "expiresAt: timestamp('expires_at'",
  "consumedAt: timestamp('consumed_at'",
  "consumedByUserId: uuid('consumed_by_user_id')",
  "connectionId: uuid('connection_id').references(() => audioFileConnections.id)",
  'audio_file_connections_active_member_pair_idx',
  'audio_file_connections_canonical_pair_required',
  'audio_file_pairing_tokens_creator_idempotency_idx',
  'audio_file_pairing_tokens_token_hash_valid',
  'audio_file_pairing_tokens_expiry_valid',
  'audio_file_pairing_tokens_claim_complete',
  'audio_file_pairing_tokens_creator_cannot_claim',
  'audio_file_pairing_tokens_consumed_or_revoked',
  "connectionId: uuid('connection_id').notNull().references(() => audioFileConnections.id)",
  "assetVersionId: uuid('asset_version_id').notNull().references(() => audioProjectAssetVersions.id)",
  "grantedByUserId: uuid('granted_by_user_id').notNull()",
  "granteeUserId: uuid('grantee_user_id').notNull()",
  "canStreamPreview: boolean('can_stream_preview').notNull().default(true)",
  "canDownloadOriginal: boolean('can_download_original').notNull().default(false)",
  "canUploadNewVersion: boolean('can_upload_new_version').notNull().default(false)",
  'audio_file_access_grants_active_connection_asset_grantee_idx',
  'audio_file_access_grants_different_users',
  'audio_file_access_grants_permission_required',
  'audio_file_access_grants_grantor_project_access_fk',
  "'connected'",
  "'file_requested'",
  "'file_shared'",
  "'connection_removed'"
];

for (const term of fileConnectionSchemaTerms) {
  if (!schema.includes(term)) failures.push(`Private file connection schema missing term: ${term}`);
}

const requiredMigrationTerms = [
  'CREATE TYPE "public"."audio_project_kind" AS ENUM',
  'CREATE TYPE "public"."audio_file_pairing_purpose" AS ENUM(\'request_files\', \'send_files\')',
  'CREATE TYPE "public"."catalog_transfer_status" AS ENUM',
  'CREATE TABLE "audio_projects"',
  'CREATE TABLE "audio_upload_sessions"',
  'CREATE TABLE "audio_upload_parts"',
  'CREATE TABLE "audio_project_asset_versions"',
  'CONSTRAINT "audio_project_asset_versions_integrity_evidence_required"',
  'CONSTRAINT "audio_project_asset_versions_upload_identity_fk"',
  'CONSTRAINT "audio_upload_sessions_completion_coherent"',
  'CREATE TABLE "audio_asset_derivatives"',
  'CREATE TABLE "audio_file_connections"',
  'CREATE TABLE "audio_file_pairing_tokens"',
  'CREATE TABLE "audio_file_access_grants"',
  'CREATE TABLE "audio_file_connection_events"',
  'CREATE TABLE "audio_share_grants"',
  'CREATE TABLE "music_recordings"',
  'CREATE TABLE "music_releases"',
  'CREATE TABLE "music_rights_declarations"',
  'CREATE TABLE "music_rights_declaration_events"',
  'CREATE TABLE "audio_creator_deals"',
  'CREATE TABLE "audio_creator_deal_parties"',
  'CREATE TABLE "audio_creator_deal_allocations"',
  'CREATE TABLE "audio_creator_deal_events"',
  'CREATE TABLE "music_distribution_deliveries"',
  'CREATE TABLE "music_distribution_delivery_events"',
  'CREATE TABLE "music_catalog_transfers"',
  'CREATE TABLE "music_catalog_transfer_items"',
  'CREATE TABLE "music_catalog_transfer_recordings"',
  'CREATE TABLE "music_catalog_transfer_events"',
  'CREATE TABLE "media_connector_links"',
  '"expected_sha256" text NOT NULL',
  '"original_preserved" boolean DEFAULT true NOT NULL',
  'CONSTRAINT "audio_project_asset_versions_original_required"',
  'CONSTRAINT "audio_file_pairing_tokens_claim_complete"',
  'CONSTRAINT "audio_file_pairing_tokens_creator_cannot_claim"',
  'CONSTRAINT "audio_file_pairing_tokens_token_hash_valid"',
  'CONSTRAINT "audio_file_pairing_tokens_expiry_valid"',
  'CONSTRAINT "audio_file_access_grants_different_users"',
  'CONSTRAINT "audio_file_access_grants_permission_required"',
  'CONSTRAINT "music_rights_declarations_evidence_required"',
  'CONSTRAINT "music_rights_declarations_recording_release_fk"',
  'CONSTRAINT "music_distribution_deliveries_metadata_fingerprint_valid"',
  'CONSTRAINT "music_distribution_delivery_events_idempotency_required"',
  'CONSTRAINT "music_distribution_delivery_events_status_shape"',
  'CONSTRAINT "music_distribution_delivery_events_provider_shape"',
  '"can_stream_preview" boolean DEFAULT true NOT NULL',
  '"can_download_original" boolean DEFAULT false NOT NULL',
  '"can_upload_new_version" boolean DEFAULT false NOT NULL',
  'CREATE UNIQUE INDEX "audio_file_access_grants_active_connection_asset_grantee_idx"',
  'CREATE TRIGGER "audio_project_asset_versions_immutable" BEFORE UPDATE OR DELETE',
  'CREATE TRIGGER "audio_file_connection_events_append_only" BEFORE UPDATE OR DELETE',
  'CREATE TRIGGER "audio_review_events_append_only" BEFORE UPDATE OR DELETE',
  'CREATE TRIGGER "music_rights_declarations_immutable" BEFORE UPDATE OR DELETE',
  'CREATE TRIGGER "music_rights_declaration_events_append_only" BEFORE UPDATE OR DELETE',
  'CREATE TRIGGER "audio_creator_deals_immutable" BEFORE UPDATE OR DELETE',
  'CREATE TRIGGER "audio_creator_deal_events_append_only" BEFORE UPDATE OR DELETE',
  'CREATE TRIGGER "music_distribution_delivery_events_append_only" BEFORE UPDATE OR DELETE',
  'CREATE TRIGGER "music_catalog_transfer_events_append_only" BEFORE UPDATE OR DELETE',
  'CREATE TRIGGER "audio_projects_authority" BEFORE INSERT',
  'CREATE TRIGGER "audio_project_access_grants_authority" BEFORE INSERT OR UPDATE',
  'CREATE TRIGGER "audio_assets_authority" BEFORE INSERT',
  'CREATE TRIGGER "audio_upload_sessions_state" BEFORE INSERT OR UPDATE',
  'CREATE TRIGGER "audio_project_asset_versions_verified_seal" BEFORE INSERT',
  'CREATE TRIGGER "audio_file_pairing_tokens_state" BEFORE INSERT OR UPDATE',
  'CREATE TRIGGER "audio_file_access_grants_authority" BEFORE INSERT',
  'CREATE TRIGGER "music_rights_declarations_initial_event" AFTER INSERT',
  'CREATE TRIGGER "music_rights_declaration_events_state" BEFORE INSERT',
  'CREATE TRIGGER "audio_creator_deals_initial_event" AFTER INSERT',
  'CREATE TRIGGER "audio_creator_deal_events_state" BEFORE INSERT',
  'CREATE TRIGGER "music_distribution_deliveries_authority" BEFORE INSERT',
  'CREATE TRIGGER "music_distribution_deliveries_initial_event" AFTER INSERT',
  'CREATE TRIGGER "music_distribution_deliveries_transition_audit" BEFORE UPDATE ON',
  'CREATE TRIGGER "music_distribution_delivery_events_state" BEFORE INSERT',
  'CREATE FUNCTION "sway_validate_distribution_delivery_insert"()',
  'CREATE FUNCTION "sway_record_distribution_delivery_created"()',
  'CREATE FUNCTION "sway_record_distribution_delivery_transition"()',
  'CREATE FUNCTION "sway_validate_distribution_delivery_event"()',
  "pg_trigger_depth() < 2",
  'Catalog cutover execution is disabled until continuity is bound to immutable provider delivery evidence.',
  'CREATE TRIGGER "music_catalog_transfers_intake" BEFORE INSERT',
  'CREATE TRIGGER "music_catalog_transfer_items_scope" BEFORE INSERT OR UPDATE OR DELETE',
  'CREATE TRIGGER "music_catalog_transfers_transition_audit" BEFORE UPDATE OF "status"'
];

for (const term of requiredMigrationTerms) {
  if (!migration.includes(term)) failures.push(`Audio publishing migration missing required term: ${term}`);
}

const transferStates = [
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
];

for (const state of transferStates) {
  if (!schema.includes(`'${state}'`)) failures.push(`Catalog transfer schema missing state: ${state}`);
  if (!migration.includes(`'${state}'`)) failures.push(`Catalog transfer migration missing state: ${state}`);
  if (!contract.includes(`'${state}'`)) failures.push(`Catalog transfer runtime contract missing state: ${state}`);
}

for (const term of [
  'CATALOG_TRANSFER_STATES',
  'CATALOG_TRANSFER_HOLD_STATES',
  'CATALOG_TRANSFER_PRESERVATION_FIELDS',
  'CATALOG_TRANSFER_PROMISE',
  'CATALOG_CUTOVER_EXECUTION_ENABLED = false',
  'CATALOG_CUTOVER_DISABLED_STATES',
  'assertCatalogTransferTransition',
  'normalizeIsrc',
  'SWAY_DISTRIBUTION_RIGHTS_POLICY',
  'SWAY_DISTRIBUTION_SALE_FEE_POLICY',
  'calculateSwayDistributionSaleFeeCents',
  'swayAcquiresMasterOwnership: false',
  'swayAcquiresCompositionOwnership: false',
  'creatorDealsRemainBetweenCreators: true',
  "distributionAuthority: 'limited_non_exclusive_contractual_license'",
  'thresholdCents: 500',
  'flatFeeCents: 100',
  'belowThresholdBasisPoints: 2_000',
  "rounding: 'down_to_cent_in_creator_favor'",
  "appliesPer: 'paid_audio_line_item'",
  'taxIncludedInFeeBase: false',
  'refundsRequireFeeReversal: true',
  "'live_room_tip'",
  "'live_room_request'",
  "'live_room_boost'",
  "'merch_fulfillment'",
  "'ticketed_show'",
  "'paid_stream'",
  'crossLaneFeeStackingAllowed: false',
  'separateLaneTermsAndDisclosureRequired: true',
  'AUDIO_FILE_PAIRING_PURPOSES',
  'AUDIO_FILE_CONNECTION_QR_CONTRACT',
  'AUDIO_FILE_ACCESS_MODEL',
  'assertAudioFilePairingClaim',
  "tokenUse: 'single_use_pairing'",
  "connectionLifetime: 'persistent_until_revoked'",
  "roomQrRelationship: 'separate_from_static_sway_room_qr'",
  "pairingPath: '/talent/connect/files'",
  "claimSecretTransport: 'url_fragment_then_authenticated_post_body'",
  'roomOrGigAccessGranted: false',
  'projectAccessGrantedAtPairing: false',
  'rawTokenStored: false',
  'connectionExposesAllFiles: false',
  'selectedAssetVersionGrantRequired: true',
  'originalStorageObjectRelocated: false',
  'originalStorageObjectDuplicated: false',
  'exactOriginalDownloadAllowedOnlyByGrant: true',
  'accessRevocableWithoutDeletingOriginal: true',
  "integrityIdentity: 'asset_version_sha256'",
  'catalogCutoverAutomation: false',
  'losslessObjectStorage: true',
  'resumableUploadRoutes: true',
  'fileConnectionQrRoutes: true',
  'privateDownloadAuthorization: true',
  'creatorDealExecution: false',
  'swayPlayback: false',
  'externalDspDelivery: false',
  'directSales: false',
  'royaltyAccounting: false'
]) {
  if (!contract.includes(term)) failures.push(`Audio publishing runtime contract missing term: ${term}`);
}

for (const term of [
  'This is a schema-and-contract slice with Slice 1 upload/share runtime and live file-pairing QR routes.',
  'Sway preserves everything the stores allow us to preserve',
  'An accepted original asset version is immutable evidence.',
  'bind the sealed row to its upload session, verifier, verification timestamp, and non-empty evidence',
  'whose SHA-256 digest matches the accepted source version',
  "The required file-pairing QR flow is separate from Sway's static room QR.",
  'Private file-pairing QR routes are live for one-time connection claims',
  'The one-time rule will apply to the QR claim, not to the resulting connection.',
  '/talent/connect/files#token={opaque-token}',
  'opaque token in its URL fragment',
  'client submits the token in an authenticated POST body',
  '`request_files`',
  '`send_files`',
  'remains available until either participant removes it',
  'Pairing alone will grant no project or file access.',
  '`audio_file_access_grants`',
  'one selected immutable asset version and one grantee',
  'It does not copy, relocate, rename, or transcode the original object.',
  'A file connection must not silently grant access to every project',
  'Any hold blocks old-provider takedown.',
  'A database trigger validates every status edge',
  'Music distribution and composition publishing administration are different services.',
  'Continuum is a connector for source manifests',
  "It is not Sway's master vault",
  "Under the target model, Sway is FlavorGood Marketing's distribution product.",
  "Sway will not acquire a creator's master copyright",
  'The target workflow will let artists, producers, writers, engineers, comedians, and other collaborators propose and accept deals among themselves through Sway.',
  'sale price below $5.00: 20% of the price',
  'sale price of $5.00 or more: a flat $1.00',
  'a $4.99 item produces a $0.99 fee',
  'does not yet charge for downloads, sell releases, execute creator agreements, calculate royalties',
  'reuse Sway\'s live-room tip/request/boost payment records'
]) {
  if (!doc.includes(term)) failures.push(`Audio publishing foundation document missing truth term: ${term}`);
}

for (const forbidden of [
  "token: text('token')",
  "rawToken: text('raw_token')",
  "tokenValue: text('token_value')",
  "audioFileConnectionGigId",
  "musicRoyaltyLedger",
  "audioSalesOrders"
]) {
  if (schema.includes(forbidden) || migration.includes(forbidden)) {
    failures.push(`Audio publishing foundation must not add raw pairing secrets, gig-scoped file connections, or premature money tables: ${forbidden}`);
  }
}

for (const forbidden of ["'/g/'", 'gigId', 'roomId']) {
  if (contract.includes(forbidden)) {
    failures.push(`Private file connection contract must not be room- or gig-scoped: ${forbidden}`);
  }
}

for (const forbidden of [
  'request_files',
  'send_files',
  '/talent/connect/files',
  'audio_file_connections',
  'AUDIO_FILE_CONNECTION_QR_CONTRACT'
]) {
  if (roomQrSources.includes(forbidden)) {
    failures.push(`Static room QR components must remain separate from private file pairing: ${forbidden}`);
  }
}

if (!packageJson.includes('node scripts/sway-audio-publishing-foundation.contract.test.mjs')) {
  failures.push('package.json must register the audio publishing foundation contract in test:contracts.');
}
if (!packageJson.includes('node scripts/sway-audio-publishing-migration.contract.test.mjs')) {
  failures.push('package.json must execute the audio publishing migration behavior contract.');
}

if (contract && schema && migration) {
  const behaviorProgram = String.raw`
    import {
      AUDIO_FILE_ACCESS_MODEL,
      AUDIO_FILE_CONNECTION_QR_CONTRACT,
      CATALOG_CUTOVER_EXECUTION_ENABLED,
      assertAudioFilePairingClaim,
      assertCatalogTransferTransition,
      calculateSwayDistributionSaleFeeCents,
      SWAY_DISTRIBUTION_SALE_FEE_POLICY,
      SWAY_DISTRIBUTION_RIGHTS_POLICY,
      normalizeIsrc
    } from './src/server/audio-publishing-contract.ts';

    const expectThrow = (label, operation) => {
      let threw = false;
      try { operation(); } catch { threw = true; }
      if (!threw) throw new Error(label);
    };

    const parityEvidence = {
      sourceSnapshotCaptured: true,
      rightsCleared: true,
      artistIdentityMapped: true,
      allItemsParityMatched: true
    };
    assertCatalogTransferTransition('artist_identity_mapped', 'parity_locked', parityEvidence);
    expectThrow('parity lock must reject missing evidence', () => {
      assertCatalogTransferTransition('artist_identity_mapped', 'parity_locked', {});
    });
    expectThrow('state machine must reject skipped cutover states', () => {
      assertCatalogTransferTransition('overlap_live', 'old_provider_takedown', {});
    });
    expectThrow('a hold must never jump to old-provider takedown', () => {
      assertCatalogTransferTransition('track_link_failed', 'old_provider_takedown', {});
    });
    expectThrow('a hold must not bypass disabled cutover through monitoring', () => {
      assertCatalogTransferTransition('content_id_conflict', 'cutover_monitoring', {
        resolvedHoldState: 'content_id_conflict',
        holdResolutionEvidenceFingerprint: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        oldProviderTakedownRequestedAt: '2026-07-18T00:05:00.000Z'
      });
    });
    if (CATALOG_CUTOVER_EXECUTION_ENABLED !== false) {
      throw new Error('Catalog cutover execution must remain disabled in the schema-only foundation.');
    }
    expectThrow('old-provider takedown must remain disabled even with complete continuity evidence', () => {
      assertCatalogTransferTransition('artist_cutover_approved', 'old_provider_takedown', {
        overlapLiveVerified: true,
        allRequiredStoresMatched: true,
        artistCutoverApprovedAt: '2026-07-18T00:00:00.000Z',
        artistCutoverApprovalFingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        unresolvedHoldCount: 0,
        expectedReleaseCount: 1,
        continuityVerifiedReleaseCount: 1,
        expectedRecordingCount: 2,
        continuityVerifiedRecordingCount: 2,
        oldProviderTakedownRequestedAt: '2026-07-18T00:05:00.000Z'
      });
    });
    assertCatalogTransferTransition('rights_blocked', 'rights_review', {
      resolvedHoldState: 'rights_blocked',
      holdResolutionEvidenceFingerprint: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    });
    expectThrow('hold recovery must require fingerprinted resolution evidence', () => {
      assertCatalogTransferTransition('rights_blocked', 'rights_review', {});
    });

    const validClaim = {
      createdByUserId: 'creator',
      claimingUserId: 'collaborator',
      expiresAt: '2026-07-19T00:00:00.000Z',
      now: '2026-07-18T00:00:00.000Z'
    };
    assertAudioFilePairingClaim(validClaim);
    expectThrow('pairing creator must not claim their own QR', () => {
      assertAudioFilePairingClaim({ ...validClaim, claimingUserId: 'creator' });
    });
    expectThrow('consumed QR must not be replayed', () => {
      assertAudioFilePairingClaim({ ...validClaim, consumedAt: '2026-07-18T01:00:00.000Z' });
    });
    expectThrow('revoked QR must fail closed', () => {
      assertAudioFilePairingClaim({ ...validClaim, revokedAt: '2026-07-18T01:00:00.000Z' });
    });
    expectThrow('expired QR must fail closed', () => {
      assertAudioFilePairingClaim({ ...validClaim, now: '2026-07-20T00:00:00.000Z' });
    });

    if (AUDIO_FILE_CONNECTION_QR_CONTRACT.claimSecretTransport !== 'url_fragment_then_authenticated_post_body') {
      throw new Error('File-pairing claim secrets must be separated from room paths and ordinary HTTP URL transport.');
    }
    if (AUDIO_FILE_CONNECTION_QR_CONTRACT.pairingPath !== '/talent/connect/files') {
      throw new Error('File pairing must use its dedicated performer-side path.');
    }
    if (AUDIO_FILE_CONNECTION_QR_CONTRACT.projectAccessGrantedAtPairing !== false) {
      throw new Error('Pairing must not grant project access.');
    }
    if (AUDIO_FILE_ACCESS_MODEL.selectedAssetVersionGrantRequired !== true
      || AUDIO_FILE_ACCESS_MODEL.connectionExposesAllFiles !== false
      || AUDIO_FILE_ACCESS_MODEL.originalStorageObjectRelocated !== false
      || AUDIO_FILE_ACCESS_MODEL.originalStorageObjectDuplicated !== false) {
      throw new Error('Sharing must reference one immutable asset version without copying or moving original bytes.');
    }

    if (normalizeIsrc('US-AAA-24-00001') !== 'USAAA2400001') {
      throw new Error('ISRC normalization must preserve the canonical recording identifier.');
    }

    const feeExamples = new Map([
      [0, 0],
      [1, 0],
      [5, 1],
      [100, 20],
      [499, 99],
      [500, 100],
      [2000, 100]
    ]);
    for (const [priceCents, expectedFeeCents] of feeExamples) {
      if (calculateSwayDistributionSaleFeeCents(priceCents) !== expectedFeeCents) {
        throw new Error('Distribution fee mismatch at ' + priceCents + ' cents.');
      }
    }
    expectThrow('distribution fee must reject fractional cents', () => {
      calculateSwayDistributionSaleFeeCents(499.5);
    });
    expectThrow('distribution fee must reject negative cents', () => {
      calculateSwayDistributionSaleFeeCents(-1);
    });
    expectThrow('distribution fee must reject non-finite cents', () => {
      calculateSwayDistributionSaleFeeCents(Number.POSITIVE_INFINITY);
    });
    expectThrow('distribution fee must reject unsafe integer cents', () => {
      calculateSwayDistributionSaleFeeCents(Number.MAX_SAFE_INTEGER + 1);
    });
    const requiredSeparateLanes = [
      'live_room_tip', 'live_room_request', 'live_room_boost',
      'merch_fulfillment', 'ticketed_show', 'paid_stream'
    ];
    if (SWAY_DISTRIBUTION_SALE_FEE_POLICY.taxIncludedInFeeBase !== false
      || SWAY_DISTRIBUTION_SALE_FEE_POLICY.refundsRequireFeeReversal !== true
      || SWAY_DISTRIBUTION_SALE_FEE_POLICY.crossLaneFeeStackingAllowed !== false
      || SWAY_DISTRIBUTION_SALE_FEE_POLICY.separateLaneTermsAndDisclosureRequired !== true
      || requiredSeparateLanes.some((lane) => !SWAY_DISTRIBUTION_SALE_FEE_POLICY.excludedRevenueLanes.includes(lane))) {
      throw new Error('Distribution sales must keep tax and every other Sway revenue lane outside the audio fee.');
    }
    if (SWAY_DISTRIBUTION_RIGHTS_POLICY.swayAcquiresMasterOwnership !== false
      || SWAY_DISTRIBUTION_RIGHTS_POLICY.swayAcquiresCompositionOwnership !== false
      || SWAY_DISTRIBUTION_RIGHTS_POLICY.creatorDealsRemainBetweenCreators !== true) {
      throw new Error('Sway distribution must not acquire creator copyrights or become a party to creator deals.');
    }
  `;

  const behavior = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', behaviorProgram],
    { cwd: root, encoding: 'utf8' }
  );

  if (behavior.status !== 0) {
    failures.push(`Audio publishing behavior checks failed:\n${behavior.stderr || behavior.stdout}`);
  }
}

if (failures.length) {
  console.error('Audio publishing foundation contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Audio publishing foundation contract passed.');
