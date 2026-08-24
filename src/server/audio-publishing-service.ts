import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { TextDecoder } from 'node:util';
import { and, asc, desc, eq, gt, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { parseStream } from 'music-metadata';
import sharp from 'sharp';
import type { SwayDb } from '../db/client';
import {
  audioAssets,
  audioCandidateRevisions,
  audioFileAccessGrants,
  audioFileConnections,
  audioObjectCleanupReceipts,
  audioProviderOperations,
  audioProjectAccessGrants,
  audioProjectAssetVersions,
  audioProjects,
  audioShareGrants,
  audioUploadParts,
  audioUploadSessions,
  auditEvents,
  musicRecordingCredits,
  musicRecordings,
  musicDistributionDeliveries,
  musicReleaseRecordings,
  musicReleases,
  musicReleaseStorageManifests,
  musicRightsDeclarationEvents,
  musicRightsDeclarations,
  performers
} from '../db/schema';
import { parseAudioStorageProvider, type AudioObjectIdentity, type AudioObjectStore } from './audio-object-storage';
import {
  AudioProviderOperationBusyError,
  createAudioProviderOperationCoordinator,
  fingerprintAudioProviderValue,
  type AudioProviderOperationRow,
  type AudioProviderOperationTransaction
} from './audio-provider-operation-service';
import {
  assertAudioStorageReservationAvailable,
  assertAudioUploadFirstPartSignature,
  assertAudioWorkingObjectAvailable,
  createAudioStoragePolicy,
  EXPIRABLE_AUDIO_UPLOAD_STATUSES,
  loadAudioStorageUsage,
  lockAudioStorageForPerformer,
  normalizeAudioAssetUploadType
} from './audio-storage-policy';

export { AudioStorageObjectLimitError, AudioStorageQuotaError } from './audio-storage-policy';

const DEFAULT_PART_SIZE = 5 * 1024 * 1024;
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RELEASE_MASTER_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_RELEASE_ARTWORK_BYTES = 50 * 1024 * 1024;
const MAX_RELEASE_RIGHTS_DOCUMENT_BYTES = 10 * 1024 * 1024;
const RELEASE_PACKAGE_VALIDATOR_KEY = 'sway-release-package-v1';
const RELEASE_TYPES = new Set(['single', 'ep', 'album', 'comedy_special', 'spoken_word', 'other']);
const DISTRIBUTION_MODES = new Set(['private', 'sway_only', 'sway_first', 'everywhere']);
const CREDIT_ROLES = new Set([
  'primary_artist', 'featured_artist', 'songwriter', 'composer', 'producer', 'co_producer',
  'engineer', 'mix_engineer', 'mastering_engineer', 'performer', 'publisher', 'other'
]);
const RIGHTS_DECLARATION_TYPES = new Set([
  'master_control', 'composition_control', 'sample_clearance', 'cover_license',
  'beat_license', 'artwork_control', 'performer_consent', 'ai_disclosure',
  'distribution_authorization'
]);
const REQUIRED_RECORDING_RIGHTS = ['master_control', 'composition_control'] as const;
const REQUIRED_RELEASE_RIGHTS = ['artwork_control', 'distribution_authorization'] as const;
const RECORDING_SCOPED_RIGHTS = new Set([
  'master_control', 'composition_control', 'sample_clearance', 'cover_license',
  'beat_license', 'performer_consent', 'ai_disclosure'
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sha256Hex(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

async function readStreamWithLimit(stream: Readable, maxBytes: number) {
  const chunks: Buffer[] = [];
  let byteSize = 0;
  for await (const chunk of stream) {
    const body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteSize += body.byteLength;
    if (byteSize > maxBytes) {
      stream.destroy();
      throw new Error(`Release package object exceeds its ${maxBytes}-byte role limit.`);
    }
    chunks.push(body);
  }
  return Buffer.concat(chunks, byteSize);
}

async function readStreamPrefix(stream: Readable, maxBytes: number) {
  const chunks: Buffer[] = [];
  let byteSize = 0;
  try {
    for await (const chunk of stream) {
      const body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxBytes - byteSize;
      if (remaining > 0) chunks.push(body.subarray(0, remaining));
      byteSize += Math.min(body.byteLength, Math.max(0, remaining));
      if (byteSize >= maxBytes) break;
    }
  } finally {
    if (!stream.destroyed) stream.destroy();
  }
  return Buffer.concat(chunks, byteSize);
}

function assertStrictImageContainer(mimeType: string, body: Buffer) {
  if (mimeType === 'image/png') {
    let offset = 8;
    let sawEnd = false;
    while (offset + 12 <= body.byteLength) {
      const chunkLength = body.readUInt32BE(offset);
      const chunkEnd = offset + 12 + chunkLength;
      if (chunkEnd > body.byteLength) throw new Error('PNG chunk extends beyond the stored object.');
      const chunkType = body.subarray(offset + 4, offset + 8).toString('ascii');
      offset = chunkEnd;
      if (chunkType === 'IEND') {
        sawEnd = true;
        break;
      }
    }
    if (!sawEnd || offset !== body.byteLength) {
      throw new Error('PNG release artwork must end exactly at its IEND chunk.');
    }
  } else if (mimeType === 'image/jpeg') {
    if (body.byteLength < 2 || body.at(-2) !== 0xff || body.at(-1) !== 0xd9) {
      throw new Error('JPEG release artwork must end at its image terminator.');
    }
  } else if (mimeType === 'image/gif') {
    if (body.at(-1) !== 0x3b) throw new Error('GIF release artwork must end at its trailer.');
  } else if (mimeType === 'image/webp') {
    if (body.byteLength < 12 || body.readUInt32LE(4) + 8 !== body.byteLength) {
      throw new Error('WebP release artwork must match its declared RIFF container size.');
    }
  }
}

function assertStrictTextDocument(mimeType: string, body: Buffer) {
  if (mimeType === 'application/pdf') {
    const document = body.toString('latin1');
    if (!/^%PDF-[0-9.]+/.test(document) || !/%%EOF[\x00\x09\x0a\x0c\x0d\x20]*$/.test(document)) {
      throw new Error('Release rights PDF must contain a complete PDF header and final EOF marker.');
    }
    if (/\/(EmbeddedFile|Filespec|Collection|JavaScript|Launch)\b/i.test(document)
      || /\/AF\s*\[/i.test(document)) {
      throw new Error('Release rights PDF may not contain embedded files, portfolios, scripts, or launch actions.');
    }
    if (!/\/Type\s*\/Page\b/.test(document)) {
      throw new Error('Release rights PDF must contain at least one document page.');
    }
    return;
  }
  if (body.includes(0)) throw new Error('Release rights text may not contain binary NUL bytes.');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  if (!text.trim()) throw new Error('Release rights text may not be empty.');
  if ([...text].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code !== 0x09 && code !== 0x0a && code !== 0x0d && code < 0x20;
  })) {
    throw new Error('Release rights text contains unsupported binary control bytes.');
  }
}

function audioContainerMatchesMime(mimeType: string, container: string) {
  const expected = mimeType === 'audio/wav' || mimeType === 'audio/x-wav'
    ? /wave|wav/i
    : mimeType === 'audio/mpeg'
      ? /mpeg|mp3/i
      : mimeType === 'audio/flac'
        ? /flac/i
        : mimeType === 'audio/aiff' || mimeType === 'audio/x-aiff'
          ? /aiff|aifc/i
          : mimeType === 'audio/mp4' || mimeType === 'audio/x-m4a'
            ? /mp4|m4a|quicktime/i
            : mimeType === 'audio/aac'
              ? /aac|adts/i
              : mimeType === 'audio/ogg'
                ? /ogg/i
                : null;
  return expected?.test(container) === true;
}

type ReleaseStorageManifestAsset = {
  assetVersionId: string;
  sha256: string;
  byteSize: number;
  roles: string[];
};

function collectReleaseStorageManifestRoles(release: {
  artworkAssetVersionId: string | null;
  recordings: Array<{ recordingId: string; masterAssetVersionId: string | null }>;
  declarations: Array<{
    id: string;
    recordingId: string | null;
    declarationType: string;
    termsDocumentAssetVersionId: string;
    declaredAt: Date;
    outcome: string;
  }>;
}) {
  const rolesByVersionId = new Map<string, Set<string>>();
  const addRole = (assetVersionId: string | null, role: string) => {
    if (!assetVersionId) throw new Error(`Release package is missing the asset for ${role}.`);
    const roles = rolesByVersionId.get(assetVersionId) ?? new Set<string>();
    roles.add(role);
    rolesByVersionId.set(assetVersionId, roles);
  };

  addRole(release.artworkAssetVersionId, 'release_artwork');
  for (const recording of release.recordings) {
    addRole(recording.masterAssetVersionId, `recording_master:${recording.recordingId}`);
  }

  const latestByScope = new Map<string, typeof release.declarations[number]>();
  const declarations = [...release.declarations].sort((left, right) => (
    right.declaredAt.getTime() - left.declaredAt.getTime()
    || right.id.localeCompare(left.id)
  ));
  for (const declaration of declarations) {
    const scope = `${declaration.recordingId ?? 'release'}:${declaration.declarationType}`;
    if (!latestByScope.has(scope)) latestByScope.set(scope, declaration);
  }
  for (const declaration of latestByScope.values()) {
    if (declaration.outcome === 'verified') {
      addRole(
        declaration.termsDocumentAssetVersionId,
        `rights_document:${declaration.id}`
      );
    }
  }
  return rolesByVersionId;
}

function requiredReleaseText(value: string, label: string, maxLength = 200) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  if (normalized.length > maxLength) throw new Error(`${label} must be ${maxLength} characters or fewer.`);
  return normalized;
}

function optionalReleaseText(value: string | null | undefined, label: string, maxLength = 200) {
  const normalized = value?.trim() || null;
  if (normalized && normalized.length > maxLength) throw new Error(`${label} must be ${maxLength} characters or fewer.`);
  return normalized;
}

function normalizeTerritories(values: string[] | null | undefined) {
  const normalized = [...new Set((values ?? []).map((value) => value.trim().toUpperCase()).filter(Boolean))];
  if (normalized.some((value) => !/^[A-Z]{2}$/.test(value))) {
    throw new Error('Territories must use two-letter country codes.');
  }
  return normalized.length ? normalized : ['US'];
}

function normalizeCredits(values: Array<{ displayName?: string; role?: string }> | null | undefined) {
  const credits = (values ?? []).map((value, sequence) => ({
    displayName: requiredReleaseText(value.displayName ?? '', `Credit ${sequence + 1} name`, 160),
    role: (value.role ?? '').trim().toLowerCase(),
    sequence
  }));
  if (!credits.length) throw new Error('At least one release credit is required.');
  for (const credit of credits) {
    if (!CREDIT_ROLES.has(credit.role)) throw new Error(`Unsupported credit role: ${credit.role || 'blank'}.`);
  }
  if (!credits.some((credit) => credit.role === 'primary_artist')) {
    throw new Error('Credits must identify at least one primary artist.');
  }
  return credits;
}

function normalizeRecordingDraft(input: {
  title: string;
  versionTitle?: string | null;
  primaryArtistName: string;
  isrc?: string | null;
  isExplicit?: boolean;
  languageCode?: string | null;
  originalReleaseDate?: string | null;
  credits?: Array<{ displayName?: string; role?: string }> | null;
}) {
  const title = requiredReleaseText(input.title, 'Track title');
  const versionTitle = optionalReleaseText(input.versionTitle, 'Version title');
  const primaryArtistName = requiredReleaseText(input.primaryArtistName, 'Primary artist');
  const isrc = optionalReleaseText(input.isrc, 'ISRC', 12)?.toUpperCase() ?? null;
  const languageCode = optionalReleaseText(input.languageCode, 'Language code', 3)?.toLowerCase() ?? null;
  const originalReleaseDate = optionalReleaseText(input.originalReleaseDate, 'Original release date', 10);
  const credits = normalizeCredits(input.credits);
  if (isrc && !/^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(isrc)) {
    throw new Error('ISRC must use the 12-character ISRC format.');
  }
  if (languageCode && !/^[a-z]{2,3}$/.test(languageCode)) {
    throw new Error('Language code must contain 2 or 3 letters.');
  }
  if (originalReleaseDate && !/^\d{4}-\d{2}-\d{2}$/.test(originalReleaseDate)) {
    throw new Error('Original release date must use YYYY-MM-DD.');
  }
  return {
    title,
    versionTitle,
    primaryArtistName,
    isrc,
    isExplicit: input.isExplicit === true,
    languageCode,
    originalReleaseDate,
    credits
  };
}

function assertExpectedReleaseVersion(current: Date, expectedUpdatedAt: string | null | undefined) {
  if (!expectedUpdatedAt) throw new Error('expectedUpdatedAt is required for release track changes.');
  const expected = new Date(expectedUpdatedAt);
  if (Number.isNaN(expected.getTime()) || current.toISOString() !== expected.toISOString()) {
    throw new Error('Release changed in another session. Reload before saving.');
  }
}

function buildReleaseReadiness(input: {
  release: {
    artworkAssetVersionId: string | null;
    title: string;
    primaryArtistName: string;
    releaseType: string;
    pLine: string | null;
    cLine: string | null;
    originalReleaseDate: string | null;
    territories: string[] | null;
    distributionMode: string;
    scheduledReleaseAt: Date | null;
  };
  recordings: Array<{ recordingId: string; masterAssetVersionId: string | null; title: string; languageCode: string | null }>;
  credits: Array<{ recordingId: string; role: string }>;
  declarations: Array<{ recordingId: string | null; declarationType: string; outcome: string }>;
}) {
  const metadataIssues: string[] = [];
  const rightsIssues: string[] = [];
  const { release, recordings, credits, declarations } = input;
  const latestDeclarationByScope = new Map<string, { recordingId: string | null; declarationType: string; outcome: string }>();
  for (const declaration of declarations) {
    const scopeKey = `${declaration.recordingId ?? 'release'}:${declaration.declarationType}`;
    if (!latestDeclarationByScope.has(scopeKey)) {
      latestDeclarationByScope.set(scopeKey, declaration);
    }
  }
  if (!release.title.trim()) metadataIssues.push('Release title is required.');
  if (!release.primaryArtistName.trim()) metadataIssues.push('Primary artist is required.');
  if (!release.artworkAssetVersionId) metadataIssues.push('Verified release artwork is required.');
  if (!release.pLine) metadataIssues.push('The ℗ sound-recording copyright line is required.');
  if (!release.cLine) metadataIssues.push('The © artwork/release copyright line is required.');
  if (!release.originalReleaseDate) metadataIssues.push('Original release date is required.');
  if (!release.territories?.length) metadataIssues.push('At least one release territory is required.');
  if (!recordings.length) metadataIssues.push('At least one recording is required.');
  if (release.releaseType === 'single' && recordings.length !== 1) {
    metadataIssues.push('A single must contain exactly one recording.');
  }
  if (['ep', 'album'].includes(release.releaseType) && recordings.length < 2) {
    metadataIssues.push(`${release.releaseType === 'ep' ? 'An EP' : 'An album'} must contain at least two recordings.`);
  }
  if (release.distributionMode !== 'private' && release.scheduledReleaseAt == null) {
    metadataIssues.push('A scheduled release time is required for publication or distribution.');
  }
  for (const recording of recordings) {
    if (!recording.masterAssetVersionId) metadataIssues.push(`${recording.title}: verified master is required.`);
    if (!recording.languageCode) metadataIssues.push(`${recording.title}: language code is required.`);
    const recordingCredits = credits.filter((credit) => credit.recordingId === recording.recordingId);
    if (!recordingCredits.some((credit) => credit.role === 'primary_artist')) metadataIssues.push(`${recording.title}: primary artist credit is required.`);
    if (!recordingCredits.some((credit) => ['songwriter', 'composer'].includes(credit.role))) metadataIssues.push(`${recording.title}: songwriter or composer credit is required.`);
    for (const declarationType of REQUIRED_RECORDING_RIGHTS) {
      if (latestDeclarationByScope.get(`${recording.recordingId}:${declarationType}`)?.outcome !== 'verified') {
        rightsIssues.push(`${recording.title}: verified ${declarationType.replaceAll('_', ' ')} rights evidence is required.`);
      }
    }
  }
  for (const declarationType of REQUIRED_RELEASE_RIGHTS) {
    if (latestDeclarationByScope.get(`release:${declarationType}`)?.outcome !== 'verified') {
      rightsIssues.push(`Verified ${declarationType.replaceAll('_', ' ')} rights evidence is required for the release.`);
    }
  }
  const issues = [...metadataIssues, ...rightsIssues];
  const requiredRights = [
    ...recordings.flatMap((recording) => REQUIRED_RECORDING_RIGHTS.map((type) => `${recording.recordingId}:${type}`)),
    ...REQUIRED_RELEASE_RIGHTS.map((type) => `release:${type}`)
  ];
  return {
    ready: issues.length === 0,
    issues,
    metadataIssues,
    rightsIssues,
    verifiedRights: requiredRights.filter((key) => latestDeclarationByScope.get(key)?.outcome === 'verified'),
    requiredRights
  };
}

async function writeAudit(
  db: Pick<SwayDb, 'insert'>,
  input: {
    actorType?: 'performer' | 'account';
    actorId: string;
    entityType: string;
    entityId: string;
    eventType: string;
    metadata?: Record<string, unknown>;
  }
) {
  await db.insert(auditEvents).values({
    actorType: input.actorType ?? 'performer',
    actorId: input.actorId,
    entityType: input.entityType,
    entityId: input.entityId,
    eventType: input.eventType,
    previousStatus: null,
    nextStatus: null,
    metadata: input.metadata ?? null
  });
}

export function createAudioPublishingService(config: {
  db: SwayDb;
  store: AudioObjectStore;
  workspaceLimitBytes?: number;
  workingObjectLimit?: number;
  collaboratorRevisionUploadsEnabled?: boolean;
  providerOperationLeaseDurationMs?: number;
  providerOperationCallTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}) {
  const { db, store } = config;
  const collaboratorRevisionUploadsEnabled = config.collaboratorRevisionUploadsEnabled === true;
  const storagePolicy = createAudioStoragePolicy({
    workspaceLimitBytes: config.workspaceLimitBytes,
    workingObjectLimit: config.workingObjectLimit,
    env: config.env
  });
  const providerOperations = createAudioProviderOperationCoordinator({
    db,
    leaseDurationMs: config.providerOperationLeaseDurationMs,
    providerCallTimeoutMs: config.providerOperationCallTimeoutMs
  });

  async function requireActiveCollaboratorRevisionGrant(
    executor: Pick<SwayDb, 'execute'>,
    input: {
      grantId: string;
      projectId: string;
      actorUserId: string;
      assetId: string;
      sourceAssetVersionId: string;
    }
  ) {
    try {
      await executor.execute(sql`select sway_require_active_collaborator_revision_grant(
        ${input.grantId}::uuid,
        ${input.projectId}::uuid,
        ${input.actorUserId}::uuid,
        ${input.assetId}::uuid,
        ${input.sourceAssetVersionId}::uuid
      )`);
    } catch (error) {
      throw Object.assign(new Error('Private candidate upload authority is no longer active.', { cause: error }), {
        status: 410,
        code: 'candidate_upload_authority_ended'
      });
    }
  }

  function sessionObjectIdentity(session: Record<string, unknown>): AudioObjectIdentity {
    if (typeof session.storageProvider !== 'string'
      || typeof session.storageBucket !== 'string'
      || typeof session.storageKey !== 'string'
      || typeof session.providerUploadId !== 'string'
      || !session.storageBucket
      || !session.storageKey
      || !session.providerUploadId) {
      throw new Error('Upload session is missing its exact object-store identity.');
    }
    return {
      storageProvider: parseAudioStorageProvider(session.storageProvider),
      storageBucket: session.storageBucket,
      storageKey: session.storageKey,
      providerUploadId: session.providerUploadId
    };
  }

  function operationObjectIdentity(operation: AudioProviderOperationRow): AudioObjectIdentity {
    return {
      storageProvider: parseAudioStorageProvider(operation.storageProvider),
      storageBucket: operation.storageBucket,
      storageKey: operation.storageKey,
      ...(operation.providerUploadId ? { providerUploadId: operation.providerUploadId } : {})
    };
  }

  function providerOperationStateError(operation: AudioProviderOperationRow) {
    if (operation.status === 'dead_letter') {
      return Object.assign(new Error('Audio storage recovery requires operator review.'), {
        status: 503,
        code: 'audio_provider_operation_dead_letter'
      });
    }
    if (operation.status === 'canceled') {
      return Object.assign(new Error('Audio storage operation was canceled.'), {
        status: 409,
        code: 'audio_provider_operation_canceled'
      });
    }
    return new AudioProviderOperationBusyError();
  }

  function requireOperationPayloadString(operation: AudioProviderOperationRow, key: string) {
    const value = operation.requestPayload[key];
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`Provider initiation intent is missing ${key}.`);
    }
    return value;
  }

  function requireOperationPayloadNumber(operation: AudioProviderOperationRow, key: string) {
    const value = operation.requestPayload[key];
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
      throw new Error(`Provider initiation intent has invalid ${key}.`);
    }
    return value as number;
  }

  async function finalizeInitiationDomain(
    tx: AudioProviderOperationTransaction,
    identity: AudioObjectIdentity,
    operation: AudioProviderOperationRow
  ) {
    if (!identity.providerUploadId) throw new Error('Provider initiation identity is missing its multipart upload ID.');
    const purpose = requireOperationPayloadString(operation, 'purpose');
    const projectId = requireOperationPayloadString(operation, 'projectId');
    const actorUserId = requireOperationPayloadString(operation, 'actorUserId');
    const originalFilename = requireOperationPayloadString(operation, 'originalFilename');
    const mimeType = requireOperationPayloadString(operation, 'mimeType');
    const expectedByteSize = requireOperationPayloadNumber(operation, 'expectedByteSize');
    const expectedSha256 = requireOperationPayloadString(operation, 'expectedSha256');
    const partSizeBytes = requireOperationPayloadNumber(operation, 'partSizeBytes');
    const requestFingerprint = requireOperationPayloadString(operation, 'requestFingerprint');
    const sessionIdempotencyKey = requireOperationPayloadString(operation, 'sessionIdempotencyKey');
    if (projectId !== operation.projectId
      || actorUserId !== operation.requestedByUserId
      || expectedByteSize !== operation.reservedByteSize
      || !/^[0-9a-f]{64}$/.test(expectedSha256)
      || !/^[0-9a-f]{64}$/.test(requestFingerprint)) {
      throw new Error('Provider initiation intent payload does not match its immutable operation identity.');
    }

    const [project] = await tx
      .select({ performerId: audioProjects.performerId })
      .from(audioProjects)
      .where(eq(audioProjects.id, projectId))
      .limit(1);
    if (!project || project.performerId !== operation.performerId) {
      throw new Error('Audio project changed before provider initiation could be finalized.');
    }
    await tx.execute(sql`
      select set_config('sway.audio_storage_performer_transaction', ${project.performerId}, true)
    `);
    await lockAudioStorageForPerformer(tx, project.performerId);

    const [existing] = await tx
      .select()
      .from(audioUploadSessions)
      .where(eq(audioUploadSessions.id, operation.plannedUploadSessionId))
      .limit(1);
    if (existing) return existing;

    if (purpose === 'owner_asset') {
      const [authority] = await tx
        .select({ id: audioProjectAccessGrants.id })
        .from(audioProjectAccessGrants)
        .where(and(
          eq(audioProjectAccessGrants.projectId, projectId),
          eq(audioProjectAccessGrants.granteeUserId, actorUserId),
          eq(audioProjectAccessGrants.canUploadVersions, true),
          isNull(audioProjectAccessGrants.revokedAt),
          or(isNull(audioProjectAccessGrants.expiresAt), gt(audioProjectAccessGrants.expiresAt, new Date()))
        ))
        .limit(1);
      if (!authority) throw new Error('Upload permission ended before provider initiation finalized.');
      const title = requireOperationPayloadString(operation, 'title');
      const assetKind = requireOperationPayloadString(operation, 'assetKind');
      const [asset] = await tx.insert(audioAssets).values({
        projectId,
        createdByUserId: actorUserId,
        title,
        assetKind,
        provenanceType: 'user_upload',
        status: 'active'
      }).returning();
      await tx.insert(audioUploadSessions).values({
        id: operation.plannedUploadSessionId,
        projectId,
        assetId: asset.id,
        initiatedByUserId: actorUserId,
        uploadPurpose: 'owner_asset',
        requestFingerprint,
        idempotencyKey: sessionIdempotencyKey,
        storageProvider: identity.storageProvider,
        storageBucket: identity.storageBucket,
        providerUploadId: identity.providerUploadId,
        storageKey: identity.storageKey,
        originalFilename,
        expectedMimeType: mimeType,
        expectedByteSize,
        expectedSha256,
        partSizeBytes,
        uploadStatus: 'initiated',
        expiresAt: new Date(Date.now() + UPLOAD_TTL_MS)
      });
    } else if (purpose === 'collaborator_revision') {
      const grantId = requireOperationPayloadString(operation, 'collaboratorFileGrantId');
      const assetId = requireOperationPayloadString(operation, 'assetId');
      const sourceAssetVersionId = requireOperationPayloadString(operation, 'sourceAssetVersionId');
      await requireActiveCollaboratorRevisionGrant(tx, {
        grantId,
        projectId,
        actorUserId,
        assetId,
        sourceAssetVersionId
      });
      await tx.insert(audioUploadSessions).values({
        id: operation.plannedUploadSessionId,
        projectId,
        assetId,
        initiatedByUserId: actorUserId,
        uploadPurpose: 'collaborator_revision',
        collaboratorFileGrantId: grantId,
        sourceAssetVersionId,
        requestFingerprint,
        idempotencyKey: sessionIdempotencyKey,
        storageProvider: identity.storageProvider,
        storageBucket: identity.storageBucket,
        providerUploadId: identity.providerUploadId,
        storageKey: identity.storageKey,
        originalFilename,
        expectedMimeType: mimeType,
        expectedByteSize,
        expectedSha256,
        partSizeBytes,
        uploadStatus: 'initiated',
        expiresAt: new Date(Date.now() + UPLOAD_TTL_MS)
      });
      await tx.insert(auditEvents).values({
        actorType: 'account',
        actorId: actorUserId,
        entityType: 'audio_upload_session',
        entityId: operation.plannedUploadSessionId,
        eventType: 'audio_candidate_revision.upload_initiated',
        previousStatus: null,
        nextStatus: 'initiated',
        metadata: {
          grantId,
          sourceAssetVersionId,
          requestFingerprint,
          expectedByteSize,
          expectedSha256,
          maxCandidateBytes: operation.requestPayload.maxCandidateBytes
        }
      });
    } else {
      throw new Error('Unsupported durable audio initiation purpose.');
    }

    const [session] = await tx
      .select()
      .from(audioUploadSessions)
      .where(eq(audioUploadSessions.id, operation.plannedUploadSessionId))
      .limit(1);
    if (!session) throw new Error('Audio upload session was not persisted.');
    return session;
  }

  async function runInitiationProviderOperation<T>(input: {
    operation: AudioProviderOperationRow;
    originalFilename: string;
    mimeType: string;
    loadCompleted: () => Promise<T | null>;
    applyDomain: (
      tx: AudioProviderOperationTransaction,
      identity: AudioObjectIdentity,
      operation: AudioProviderOperationRow
    ) => Promise<T>;
  }): Promise<T> {
    const plannedIdentity = operationObjectIdentity(input.operation);
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const claim = await providerOperations.claimOperation(input.operation.id);
      if (claim.kind === 'terminal') {
        if (claim.operation.status === 'succeeded') {
          const completed = await input.loadCompleted();
          if (completed) return completed;
          throw new Error('Successful provider initiation is missing its atomically linked upload session.');
        }
        throw providerOperationStateError(claim.operation);
      }
      if (claim.kind === 'busy') {
        let leaseStillBusy = true;
        for (let poll = 0; poll < 40; poll += 1) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          const completed = await input.loadCompleted();
          if (completed) return completed;
          const current = await providerOperations.loadOperation(input.operation.id);
          if (!current || current.status !== 'leased') {
            leaseStillBusy = false;
            break;
          }
        }
        if (leaseStillBusy) {
          throw new AudioProviderOperationBusyError('Provider initiation is already in progress.');
        }
        continue;
      }
      if (claim.kind !== 'leased') throw providerOperationStateError(claim.operation);

      let providerIdentity: AudioObjectIdentity | null = null;
      let evidence: Record<string, unknown> | null = null;
      if (claim.lease.mode === 'execute') {
        await providerOperations.markProviderStarted(claim.lease);
        try {
          providerIdentity = await providerOperations.runLeasedProviderCall(
            claim.lease,
            (signal) => store.beginUpload({
              projectId: claim.operation.projectId,
              uploadSessionId: claim.operation.plannedUploadSessionId,
              filename: input.originalFilename,
              mimeType: input.mimeType,
              identity: plannedIdentity,
              signal
            })
          );
          if (!providerIdentity.providerUploadId) {
            throw new Error('Audio object store did not return a multipart upload ID.');
          }
          evidence = {
            outcome: 'created',
            providerUploadId: providerIdentity.providerUploadId
          };
        } catch (error) {
          await providerOperations.markReconcileRequired(
            claim.lease,
            error,
            'initiation_result_ambiguous'
          );
          continue;
        }
      } else {
        try {
          const observed = await providerOperations.runLeasedProviderCall(
            claim.lease,
            (signal) => store.reconcileUpload({
              identity: plannedIdentity,
              uploadSessionId: claim.operation.plannedUploadSessionId,
              signal
            })
          );
          if (observed.status === 'found') {
            providerIdentity = observed.identity;
            evidence = {
              outcome: 'recovered',
              providerUploadId: observed.identity.providerUploadId
            };
          } else if (observed.status === 'absent') {
            await providerOperations.resetAfterSafeReconciliation({
              lease: claim.lease,
              evidence: {
                reconciledAbsent: true,
                observation: 'exact_planned_upload_identity'
              }
            });
            continue;
          } else {
            const error = new Error('Multiple provider uploads match the exact planned storage identity.');
            await providerOperations.markReconcileRequired(
              claim.lease,
              error,
              'initiation_identity_ambiguous'
            );
            throw Object.assign(error, { status: 409, code: 'initiation_identity_ambiguous' });
          }
        } catch (error) {
          const current = await providerOperations.loadOperation(claim.operation.id);
          if (current?.status === 'leased' && current.leaseToken === claim.lease.token) {
            await providerOperations.markReconcileRequired(
              claim.lease,
              error,
              'initiation_reconciliation_failed'
            );
          }
          throw error;
        }
      }

      if (!providerIdentity?.providerUploadId || !evidence) {
        throw new Error('Provider initiation did not produce exact durable identity evidence.');
      }
      try {
        const finalized = await providerOperations.finalizeSuccess({
          lease: claim.lease,
          evidence,
          providerUploadId: providerIdentity.providerUploadId,
          uploadSessionId: claim.operation.plannedUploadSessionId,
          applyDomain: (tx, operation) => input.applyDomain(tx, providerIdentity!, operation)
        });
        return finalized.result;
      } catch (error) {
        const current = await providerOperations.loadOperation(claim.operation.id);
        if (current?.status === 'leased' && current.leaseToken === claim.lease.token) {
          await providerOperations.markReconcileRequired(claim.lease, error, 'initiation_finalization_failed');
        }
        throw error;
      }
    }
    throw Object.assign(new Error('Audio provider initiation could not be reconciled within the bounded request attempt.'), {
      status: 503,
      code: 'audio_provider_reconciliation_pending'
    });
  }

  async function runAssemblyProviderOperation<T, V = null>(input: {
    operation: AudioProviderOperationRow;
    parts: Array<{ partNumber: number; etag: string }>;
    expectedByteSize: number;
    expectedSha256: string;
    mimeType: string;
    loadCompleted: () => Promise<T | null>;
    validate?: (assembled: { byteSize: number; sha256: string }) => Promise<V>;
    applyDomain: (
      tx: AudioProviderOperationTransaction,
      assembled: { byteSize: number; sha256: string },
      validation: V,
      operation: AudioProviderOperationRow
    ) => Promise<T>;
    applyCanceled: (
      tx: AudioProviderOperationTransaction,
      error: Error,
      operation: AudioProviderOperationRow
    ) => Promise<void>;
    applyCleanupPending: (validationError: Error, cleanupError: string) => Promise<void>;
  }): Promise<T> {
    const identity = operationObjectIdentity(input.operation);

    async function cancelInvalidAssembly(
      lease: Parameters<typeof providerOperations.finalizeCanceledAfterCleanup>[0]['lease'],
      operation: AudioProviderOperationRow,
      validationError: Error
    ): Promise<never> {
      let cleanupError: string | null = null;
      let cleanupObservation: Awaited<ReturnType<typeof store.reconcileCleanup>> | null = null;
      try {
        cleanupObservation = await providerOperations.runLeasedProviderCall(lease, async (signal) => {
          await discardUnsealedUpload(identity, db, { signal });
          return store.reconcileCleanup(identity, { signal });
        });
        if (cleanupObservation.status !== 'absent'
          || cleanupObservation.multipartPresent
          || cleanupObservation.stagingPresent
          || cleanupObservation.sealedPresent) {
          cleanupError = 'Provider cleanup did not confirm absence of multipart, staging, and sealed state.';
        }
      } catch (error) {
        cleanupError = error instanceof Error ? error.message : 'Unknown object-store discard failure.';
      }

      if (!cleanupError && cleanupObservation) {
        await providerOperations.finalizeCanceledAfterCleanup({
          lease,
          evidence: {
            cleanupConfirmed: true,
            reconciledAbsent: true,
            multipartAbsent: true,
            stagingAbsent: true,
            sealedAbsent: true,
            validationFailureCode: 'assembled_original_invalid'
          },
          applyDomain: (tx, current) => input.applyCanceled(tx, validationError, current)
        });
        throw validationError;
      }

      const current = await providerOperations.loadOperation(operation.id);
      if (current?.status === 'leased' && current.leaseToken === lease.token) {
        await providerOperations.markReconcileRequired(
          lease,
          cleanupError ?? validationError,
          'assembly_cleanup_pending'
        );
      }
      await input.applyCleanupPending(
        validationError,
        cleanupError ?? 'Provider cleanup observation failed.'
      );
      throw validationError;
    }

    for (let cycle = 0; cycle < 4; cycle += 1) {
      const claim = await providerOperations.claimOperation(input.operation.id);
      if (claim.kind === 'terminal') {
        if (claim.operation.status === 'succeeded') {
          const completed = await input.loadCompleted();
          if (completed) return completed;
          throw new Error('Successful provider assembly is missing its atomic sealed receipt.');
        }
        throw providerOperationStateError(claim.operation);
      }
      if (claim.kind === 'busy') {
        let leaseStillBusy = true;
        for (let poll = 0; poll < 40; poll += 1) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          const completed = await input.loadCompleted();
          if (completed) return completed;
          const current = await providerOperations.loadOperation(input.operation.id);
          if (!current || current.status !== 'leased') {
            leaseStillBusy = false;
            break;
          }
        }
        if (leaseStillBusy) {
          throw new AudioProviderOperationBusyError('Provider assembly is already in progress.');
        }
        continue;
      }
      if (claim.kind !== 'leased') throw providerOperationStateError(claim.operation);

      let assembled: { byteSize: number; sha256: string } | null = null;
      let evidence: Record<string, unknown> | null = null;
      if (claim.lease.mode === 'execute') {
        await providerOperations.markProviderStarted(claim.lease);
        try {
          assembled = await providerOperations.runLeasedProviderCall(
            claim.lease,
            (signal) => store.assembleParts({
              identity,
              parts: input.parts,
              expectedByteSize: input.expectedByteSize,
              expectedSha256: input.expectedSha256,
              mimeType: input.mimeType,
              signal
            })
          );
          evidence = {
            outcome: 'assembled',
            byteSize: assembled.byteSize,
            sha256: assembled.sha256
          };
        } catch (error) {
          await providerOperations.markReconcileRequired(claim.lease, error, 'assembly_result_ambiguous');
          continue;
        }
      } else {
        let observed: Awaited<ReturnType<typeof store.reconcileAssembly>>;
        try {
          observed = await providerOperations.runLeasedProviderCall(
            claim.lease,
            (signal) => store.reconcileAssembly({
              identity,
              expectedByteSize: input.expectedByteSize,
              expectedSha256: input.expectedSha256,
              signal
            })
          );
        } catch (error) {
          await providerOperations.markReconcileRequired(claim.lease, error, 'assembly_reconciliation_failed');
          throw error;
        }
        if (observed.status === 'staging' || observed.status === 'sealed') {
          assembled = { byteSize: observed.byteSize, sha256: observed.sha256 };
          evidence = {
            outcome: 'recovered',
            location: observed.status,
            byteSize: observed.byteSize,
            sha256: observed.sha256
          };
        } else if (observed.status === 'multipart_open') {
          await providerOperations.resetAfterSafeReconciliation({
            lease: claim.lease,
            evidence: {
              reconciledSafeToRetry: true,
              multipartStillOpen: true
            }
          });
          continue;
        } else {
          const error = observed.status === 'mismatch'
            ? new Error(`Assembled provider object failed exact ${observed.location} integrity reconciliation.`)
            : new Error('Assembled provider state is absent after provider dispatch.');
          return cancelInvalidAssembly(claim.lease, claim.operation, error);
        }
      }

      if (!assembled || !evidence
        || assembled.byteSize !== input.expectedByteSize
        || assembled.sha256 !== input.expectedSha256) {
        return cancelInvalidAssembly(
          claim.lease,
          claim.operation,
          new Error('Assembled provider object does not match the reserved size and SHA-256.')
        );
      }

      let validation = null as V;
      if (input.validate) {
        try {
          validation = await input.validate(assembled);
        } catch (error) {
          return cancelInvalidAssembly(
            claim.lease,
            claim.operation,
            error instanceof Error ? error : new Error('Assembled original failed technical validation.')
          );
        }
      }
      try {
        const finalized = await providerOperations.finalizeSuccess({
          lease: claim.lease,
          evidence,
          applyDomain: (tx, operation) => input.applyDomain(tx, assembled!, validation, operation)
        });
        return finalized.result;
      } catch (error) {
        const current = await providerOperations.loadOperation(claim.operation.id);
        if (current?.status === 'leased' && current.leaseToken === claim.lease.token) {
          await providerOperations.markReconcileRequired(claim.lease, error, 'assembly_finalization_failed');
        }
        throw error;
      }
    }
    throw Object.assign(new Error('Audio assembly could not be reconciled within the bounded request attempt.'), {
      status: 503,
      code: 'audio_provider_reconciliation_pending'
    });
  }

  async function assertUnsealedUploadIdentity(
    identity: AudioObjectIdentity,
    executor: Pick<SwayDb, 'execute'> = db
  ) {
    const sealed = await executor.execute(sql<{ id: string }>`
      select sealed_object.id
      from (
        select id, storage_provider, storage_bucket, storage_key, original_preserved, sealed_at
        from audio_project_asset_versions
        union all
        select id, storage_provider, storage_bucket, storage_key, original_preserved, sealed_at
        from audio_candidate_revisions
      ) sealed_object
      where sealed_object.storage_provider = ${identity.storageProvider}
        and sealed_object.storage_bucket = ${identity.storageBucket}
        and sealed_object.storage_key = ${identity.storageKey}
        and sealed_object.original_preserved = true
        and sealed_object.sealed_at is not null
      limit 1
    `);
    if (sealed.rows.length > 0) {
      throw new Error('Refusing to discard an object referenced by a sealed preserved asset version. Private candidates are protected too.');
    }
  }

  async function discardUnsealedUpload(
    identity: AudioObjectIdentity,
    executor: Pick<SwayDb, 'execute'> = db,
    options?: { signal?: AbortSignal }
  ) {
    await assertUnsealedUploadIdentity(identity, executor);
    const discardUpload = store.discardUpload ?? store.abortUpload;
    await discardUpload.call(store, identity, options);
  }

  async function runCleanupProviderOperation<T>(input: {
    operation: AudioProviderOperationRow;
    loadCompleted: () => Promise<T | null>;
    applyDomain: (
      tx: AudioProviderOperationTransaction,
      operation: AudioProviderOperationRow
    ) => Promise<T>;
  }): Promise<T> {
    const identity = operationObjectIdentity(input.operation);
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const claim = await providerOperations.claimOperation(input.operation.id);
      if (claim.kind === 'terminal') {
        if (claim.operation.status === 'succeeded') {
          const completed = await input.loadCompleted();
          if (completed) return completed;
          throw new Error('Successful provider cleanup is missing its atomic domain receipt.');
        }
        throw providerOperationStateError(claim.operation);
      }
      if (claim.kind === 'busy') {
        throw new AudioProviderOperationBusyError('Provider cleanup is already in progress.');
      }
      if (claim.kind !== 'leased') throw providerOperationStateError(claim.operation);

      let observation: Awaited<ReturnType<typeof store.reconcileCleanup>>;
      if (claim.lease.mode === 'execute') {
        await providerOperations.markProviderStarted(claim.lease);
        try {
          observation = await providerOperations.runLeasedProviderCall(claim.lease, async (signal) => {
            await discardUnsealedUpload(identity, db, { signal });
            return store.reconcileCleanup(identity, { signal });
          });
        } catch (error) {
          await providerOperations.markReconcileRequired(claim.lease, error, 'cleanup_result_ambiguous');
          throw error;
        }
        if (observation.status !== 'absent'
          || observation.multipartPresent
          || observation.stagingPresent
          || observation.sealedPresent) {
          const error = new Error('Provider cleanup did not confirm exact absence of multipart, staging, and sealed state.');
          await providerOperations.markReconcileRequired(claim.lease, error, 'cleanup_absence_unconfirmed');
          throw error;
        }
      } else {
        try {
          observation = await providerOperations.runLeasedProviderCall(
            claim.lease,
            (signal) => store.reconcileCleanup(identity, { signal })
          );
        } catch (error) {
          await providerOperations.markReconcileRequired(claim.lease, error, 'cleanup_reconciliation_failed');
          throw error;
        }
        if (observation.status !== 'absent'
          || observation.multipartPresent
          || observation.stagingPresent
          || observation.sealedPresent) {
          try {
            await assertUnsealedUploadIdentity(identity);
          } catch (error) {
            await providerOperations.markReconcileRequired(claim.lease, error, 'cleanup_sealed_reference_detected');
            throw error;
          }
          await providerOperations.resetAfterSafeReconciliation({
            lease: claim.lease,
            evidence: {
              reconciledSafeToRetry: true,
              multipartPresent: observation.multipartPresent,
              stagingPresent: observation.stagingPresent,
              sealedPresent: observation.sealedPresent
            }
          });
          continue;
        }
      }

      const finalized = await providerOperations.finalizeSuccess({
        lease: claim.lease,
        evidence: {
          cleanupConfirmed: true,
          reconciledAbsent: true,
          multipartAbsent: true,
          stagingAbsent: true,
          sealedAbsent: true
        },
        applyDomain: async (tx, operation) => {
          await cancelSessionMutationOperationsAfterCleanup(tx, operation);
          return input.applyDomain(tx, operation);
        }
      });
      return finalized.result;
    }
    throw Object.assign(new Error('Audio cleanup could not be reconciled within the bounded request attempt.'), {
      status: 503,
      code: 'audio_provider_reconciliation_pending'
    });
  }

  async function runAssemblyCleanupRecovery<T>(input: {
    operation: AudioProviderOperationRow;
    loadCompleted: () => Promise<T | null>;
    applyDomain: (
      tx: AudioProviderOperationTransaction,
      operation: AudioProviderOperationRow
    ) => Promise<T>;
  }): Promise<T> {
    const identity = operationObjectIdentity(input.operation);
    const claim = await providerOperations.claimOperation(input.operation.id);
    if (claim.kind === 'terminal') {
      if (claim.operation.status === 'canceled') {
        const completed = await input.loadCompleted();
        if (completed) return completed;
        throw new Error('Canceled provider assembly is missing its atomic cleanup receipt.');
      }
      throw providerOperationStateError(claim.operation);
    }
    if (claim.kind === 'busy') {
      throw new AudioProviderOperationBusyError('Assembly cleanup reconciliation is already in progress.');
    }
    if (claim.kind !== 'leased' || claim.lease.mode !== 'reconcile') {
      throw new AudioProviderOperationBusyError('Assembly cleanup requires a reconcile lease.');
    }
    let observation: Awaited<ReturnType<typeof store.reconcileCleanup>>;
    try {
      observation = await providerOperations.runLeasedProviderCall(claim.lease, async (signal) => {
        let current = await store.reconcileCleanup(identity, { signal });
        if (current.status !== 'absent'
          || current.multipartPresent
          || current.stagingPresent
          || current.sealedPresent) {
          await discardUnsealedUpload(identity, db, { signal });
          current = await store.reconcileCleanup(identity, { signal });
        }
        return current;
      });
      if (observation.status !== 'absent'
        || observation.multipartPresent
        || observation.stagingPresent
        || observation.sealedPresent) {
        throw new Error('Assembly cancellation cleanup did not confirm exact provider absence.');
      }
    } catch (error) {
      await providerOperations.markReconcileRequired(claim.lease, error, 'assembly_cleanup_pending');
      throw error;
    }
    const finalized = await providerOperations.finalizeCanceledAfterCleanup({
      lease: claim.lease,
      evidence: {
        cleanupConfirmed: true,
        reconciledAbsent: true,
        multipartAbsent: true,
        stagingAbsent: true,
        sealedAbsent: true,
        recoverySource: 'durable_cleanup_worker'
      },
      applyDomain: async (tx, operation) => {
        await cancelSessionMutationOperationsAfterCleanup(tx, operation);
        return input.applyDomain(tx, operation);
      }
    });
    return finalized.result;
  }

  type AudioCleanupReason =
    | 'orphaned_owner_initiation'
    | 'orphaned_candidate_initiation'
    | 'owner_integrity_validation_failed'
    | 'candidate_technical_validation_failed'
    | 'candidate_grant_revoked'
    | 'candidate_connection_revoked';

  async function reserveSessionCleanupProviderOperation(
    tx: AudioProviderOperationTransaction,
    session: typeof audioUploadSessions.$inferSelect
  ) {
    const [project] = await tx
      .select({ performerId: audioProjects.performerId })
      .from(audioProjects)
      .where(eq(audioProjects.id, session.projectId))
      .limit(1);
    if (!project) throw new Error('Audio cleanup project not found.');
    const identity = sessionObjectIdentity(session);
    const operationType = store.discardUpload ? 'discard_upload' as const : 'abort_upload' as const;
    const reservation = await providerOperations.reserveOperation(tx, {
      projectId: session.projectId,
      performerId: project.performerId,
      requestedByUserId: null,
      uploadSessionId: session.id,
      plannedUploadSessionId: session.id,
      operationType,
      requestOrigin: 'system_cleanup',
      identity,
      requestPayload: {
        action: operationType,
        uploadSessionId: session.id,
        storageIdentityFingerprint: fingerprintAudioProviderValue(identity)
      }
    });
    return reservation.operation;
  }

  async function prepareSessionCleanupProviderOperation(
    tx: AudioProviderOperationTransaction,
    session: typeof audioUploadSessions.$inferSelect
  ) {
    const operations = await tx
      .select()
      .from(audioProviderOperations)
      .where(eq(audioProviderOperations.uploadSessionId, session.id))
      .orderBy(asc(audioProviderOperations.operationType), asc(audioProviderOperations.partNumber))
      .for('update');
    const now = new Date();
    const activeMutation = operations.find((operation) =>
      ['upload_part', 'complete_multipart'].includes(operation.operationType)
      && operation.status === 'leased'
      && operation.leaseExpiresAt !== null
      && operation.leaseExpiresAt.getTime() > now.getTime()
    );
    const existingCleanup = operations.find((operation) =>
      ['discard_upload', 'abort_upload'].includes(operation.operationType)
    );
    const assembly = operations.find((operation) => operation.operationType === 'complete_multipart');
    if (!activeMutation
      && !existingCleanup
      && assembly?.status === 'reconcile_required'
      && assembly.lastErrorCode === 'assembly_cleanup_pending'
      && session.uploadStatus === 'quarantined') {
      return { kind: 'assembly_cleanup' as const, operation: assembly };
    }

    const operation = existingCleanup ?? await reserveSessionCleanupProviderOperation(tx, session);
    if (activeMutation) {
      return { kind: 'deferred' as const, operation, blockingOperation: activeMutation };
    }
    return { kind: 'cleanup' as const, operation };
  }

  async function cancelSessionMutationOperationsAfterCleanup(
    tx: AudioProviderOperationTransaction,
    cleanupOperation: AudioProviderOperationRow
  ) {
    if (!cleanupOperation.uploadSessionId) return;
    const operations = await tx
      .select()
      .from(audioProviderOperations)
      .where(and(
        eq(audioProviderOperations.uploadSessionId, cleanupOperation.uploadSessionId),
        inArray(audioProviderOperations.operationType, ['upload_part', 'complete_multipart'])
      ))
      .orderBy(asc(audioProviderOperations.operationType), asc(audioProviderOperations.partNumber))
      .for('update');
    const now = new Date();
    for (const operation of operations) {
      if (operation.id === cleanupOperation.id
        || ['succeeded', 'canceled', 'dead_letter'].includes(operation.status)) {
        continue;
      }
      if (operation.status === 'leased'
        && operation.leaseExpiresAt
        && operation.leaseExpiresAt.getTime() > now.getTime()) {
        throw new AudioProviderOperationBusyError('Provider cleanup cannot finalize while a byte mutation lease remains active.');
      }
      const evidence = operation.providerStartedAt
        ? {
            cleanupConfirmed: true,
            reconciledAbsent: true,
            multipartAbsent: true,
            stagingAbsent: true,
            sealedAbsent: true,
            cleanupOperationId: cleanupOperation.id
          }
        : {
            providerNotStarted: true,
            cleanupConfirmed: true,
            cleanupOperationId: cleanupOperation.id
          };
      const [canceled] = await tx
        .update(audioProviderOperations)
        .set({
          status: 'canceled',
          resultPayload: evidence,
          resultFingerprint: fingerprintAudioProviderValue(evidence),
          providerConfirmedAt: operation.providerStartedAt ? now : null,
          completedAt: now,
          leaseToken: null,
          leaseOwner: null,
          leaseMode: null,
          leaseExpiresAt: null,
          lastError: null,
          lastErrorCode: null
        })
        .where(eq(audioProviderOperations.id, operation.id))
        .returning({ id: audioProviderOperations.id });
      if (!canceled) {
        throw new AudioProviderOperationBusyError('Provider cleanup lost its cross-operation cancellation fence.');
      }
    }
  }

  async function recordPendingAudioObjectCleanup(input: {
    projectId: string;
    actorUserId: string;
    uploadSessionId?: string | null;
    identity: AudioObjectIdentity;
    cleanupReason: AudioCleanupReason;
    lastError: string;
  }, executor: Pick<SwayDb, 'insert' | 'select' | 'update'> = db) {
    const now = new Date();
    const lastError = input.lastError.trim().slice(0, 4000) || 'Unknown object-store cleanup failure.';
    const inserted = await executor
      .insert(audioObjectCleanupReceipts)
      .values({
        projectId: input.projectId,
        actorUserId: input.actorUserId,
        uploadSessionId: input.uploadSessionId ?? null,
        storageProvider: input.identity.storageProvider,
        storageBucket: input.identity.storageBucket,
        storageKey: input.identity.storageKey,
        providerUploadId: input.identity.providerUploadId ?? null,
        cleanupReason: input.cleanupReason,
        cleanupStatus: 'pending',
        attemptCount: 1,
        lastError,
        requestedAt: now,
        lastAttemptAt: now,
        completedAt: null
      })
      .onConflictDoNothing()
      .returning({ id: audioObjectCleanupReceipts.id });
    if (inserted.length > 0) return inserted[0];

    const [existing] = await executor
      .select()
      .from(audioObjectCleanupReceipts)
      .where(and(
        eq(audioObjectCleanupReceipts.storageProvider, input.identity.storageProvider),
        eq(audioObjectCleanupReceipts.storageBucket, input.identity.storageBucket),
        eq(audioObjectCleanupReceipts.storageKey, input.identity.storageKey)
      ))
      .limit(1);
    if (!existing
      || existing.projectId !== input.projectId
      || existing.uploadSessionId !== (input.uploadSessionId ?? null)
      || existing.providerUploadId !== (input.identity.providerUploadId ?? null)) {
      throw new Error('Audio cleanup receipt storage identity collision refused.');
    }
    if (existing.cleanupStatus === 'completed') {
      throw new Error('A completed audio cleanup receipt cannot be reopened.');
    }
    const [updated] = await executor
      .update(audioObjectCleanupReceipts)
      .set({
        attemptCount: sql`${audioObjectCleanupReceipts.attemptCount} + 1`,
        lastError,
        lastAttemptAt: now
      })
      .where(and(
        eq(audioObjectCleanupReceipts.id, existing.id),
        eq(audioObjectCleanupReceipts.cleanupStatus, 'pending')
      ))
      .returning({ id: audioObjectCleanupReceipts.id });
    if (!updated) throw new Error('Audio cleanup receipt changed before retry evidence could be recorded.');
    return updated;
  }

  async function reserveCollaboratorRevisionAuthorityCleanupIntent(
    tx: AudioProviderOperationTransaction,
    input: {
      actorUserId: string;
      grantId?: string;
      connectionId?: string;
      cleanupReason: 'candidate_grant_revoked' | 'candidate_connection_revoked';
    }
  ) {
    if (Boolean(input.grantId) === Boolean(input.connectionId)) {
      throw new Error('Exactly one candidate cleanup scope is required.');
    }
    const grants = await tx
      .select({ id: audioFileAccessGrants.id, connectionId: audioFileAccessGrants.connectionId })
      .from(audioFileAccessGrants)
      .where(input.grantId
        ? eq(audioFileAccessGrants.id, input.grantId)
        : eq(audioFileAccessGrants.connectionId, input.connectionId!))
      .orderBy(asc(audioFileAccessGrants.id))
      .for('update');
    const grantIds = grants.map((grant) => grant.id);
    if (grantIds.length === 0) {
      return { sessionCount: 0, sessionlessOperationCount: 0, receiptCount: 0 };
    }

    const sessions = await tx
      .select()
      .from(audioUploadSessions)
      .where(and(
        eq(audioUploadSessions.uploadPurpose, 'collaborator_revision'),
        inArray(audioUploadSessions.collaboratorFileGrantId, grantIds),
        inArray(audioUploadSessions.uploadStatus, [...EXPIRABLE_AUDIO_UPLOAD_STATUSES])
      ))
      .orderBy(asc(audioUploadSessions.createdAt), asc(audioUploadSessions.id))
      .for('update');
    let receiptCount = 0;
    for (const session of sessions) {
      const cleanup = await prepareSessionCleanupProviderOperation(tx, session);
      const receipt = await recordPendingAudioObjectCleanup({
        projectId: session.projectId,
        actorUserId: input.actorUserId,
        uploadSessionId: session.id,
        identity: sessionObjectIdentity(session),
        cleanupReason: input.cleanupReason,
        lastError: cleanup.kind === 'deferred'
          ? `Provider operation ${cleanup.blockingOperation.id} still owns an active byte-mutation lease.`
          : 'Authority revocation durably reserved provider cleanup before commit.'
      }, tx);
      receiptCount += 1;
      await tx.insert(auditEvents).values({
        actorType: 'account',
        actorId: input.actorUserId,
        entityType: 'audio_upload_session',
        entityId: session.id,
        eventType: 'audio_candidate_revision.authority_cleanup_requested',
        previousStatus: session.uploadStatus,
        nextStatus: session.uploadStatus,
        metadata: {
          cleanupReason: input.cleanupReason,
          cleanupReceiptId: receipt.id,
          cleanupOperationId: cleanup.operation.id,
          blockingProviderOperationId: cleanup.kind === 'deferred'
            ? cleanup.blockingOperation.id
            : null
        }
      });
    }

    const sessionlessById = new Map<string, AudioProviderOperationRow>();
    for (const grantId of grantIds) {
      const operations = await tx
        .select()
        .from(audioProviderOperations)
        .where(and(
          eq(audioProviderOperations.operationType, 'initiate_multipart'),
          isNull(audioProviderOperations.uploadSessionId),
          inArray(audioProviderOperations.status, ['pending', 'leased', 'reconcile_required', 'awaiting_client_retry']),
          sql`${audioProviderOperations.requestPayload}->>'purpose' = 'collaborator_revision'`,
          sql`${audioProviderOperations.requestPayload}->>'collaboratorFileGrantId' = ${grantId}`
        ))
        .orderBy(asc(audioProviderOperations.createdAt), asc(audioProviderOperations.id))
        .for('update');
      for (const operation of operations) sessionlessById.set(operation.id, operation);
    }
    for (const operation of sessionlessById.values()) {
      const receipt = await recordPendingAudioObjectCleanup({
        projectId: operation.projectId,
        actorUserId: input.actorUserId,
        uploadSessionId: null,
        identity: operationObjectIdentity(operation),
        cleanupReason: 'orphaned_candidate_initiation',
        lastError: `${input.cleanupReason}: sessionless initiation requires due-provider reconciliation.`
      }, tx);
      receiptCount += 1;
      await tx.insert(auditEvents).values({
        actorType: 'account',
        actorId: input.actorUserId,
        entityType: 'audio_provider_operation',
        entityId: operation.id,
        eventType: 'audio_provider_operation.authority_cleanup_requested',
        previousStatus: operation.status,
        nextStatus: operation.status,
        metadata: {
          cleanupReason: input.cleanupReason,
          cleanupReceiptId: receipt.id,
          plannedUploadSessionId: operation.plannedUploadSessionId
        }
      });
    }
    return {
      sessionCount: sessions.length,
      sessionlessOperationCount: sessionlessById.size,
      receiptCount
    };
  }

  async function completePendingAudioObjectCleanupReceipt(
    tx: AudioProviderOperationTransaction,
    session: typeof audioUploadSessions.$inferSelect,
    attemptedAt: Date
  ) {
    const [receipt] = await tx
      .select()
      .from(audioObjectCleanupReceipts)
      .where(and(
        eq(audioObjectCleanupReceipts.uploadSessionId, session.id),
        eq(audioObjectCleanupReceipts.storageProvider, session.storageProvider),
        eq(audioObjectCleanupReceipts.storageBucket, session.storageBucket),
        eq(audioObjectCleanupReceipts.storageKey, session.storageKey),
        eq(audioObjectCleanupReceipts.cleanupStatus, 'pending')
      ))
      .for('update')
      .limit(1);
    if (!receipt) return null;
    await tx
      .update(audioObjectCleanupReceipts)
      .set({
        cleanupStatus: 'completed',
        attemptCount: sql`${audioObjectCleanupReceipts.attemptCount} + 1`,
        lastAttemptAt: attemptedAt,
        completedAt: attemptedAt
      })
      .where(and(
        eq(audioObjectCleanupReceipts.id, receipt.id),
        eq(audioObjectCleanupReceipts.cleanupStatus, 'pending')
      ));
    await tx.insert(auditEvents).values({
      actorType: 'system',
      actorId: null,
      entityType: 'audio_object_cleanup_receipt',
      entityId: receipt.id,
      eventType: 'audio_object_cleanup.completed',
      previousStatus: 'pending',
      nextStatus: 'completed',
      metadata: {
        cleanupReason: receipt.cleanupReason,
        projectId: receipt.projectId,
        uploadSessionId: receipt.uploadSessionId,
        storageProvider: receipt.storageProvider,
        storageBucket: receipt.storageBucket,
        storageKey: receipt.storageKey,
        attemptCount: receipt.attemptCount + 1
      }
    });
    return receipt;
  }

  async function completePendingSessionlessCleanupReceipt(
    tx: AudioProviderOperationTransaction,
    operation: AudioProviderOperationRow,
    attemptedAt: Date
  ) {
    const [receipt] = await tx
      .select()
      .from(audioObjectCleanupReceipts)
      .where(and(
        isNull(audioObjectCleanupReceipts.uploadSessionId),
        eq(audioObjectCleanupReceipts.projectId, operation.projectId),
        eq(audioObjectCleanupReceipts.storageProvider, operation.storageProvider),
        eq(audioObjectCleanupReceipts.storageBucket, operation.storageBucket),
        eq(audioObjectCleanupReceipts.storageKey, operation.storageKey),
        eq(audioObjectCleanupReceipts.cleanupStatus, 'pending')
      ))
      .for('update')
      .limit(1);
    if (!receipt) return null;
    await tx
      .update(audioObjectCleanupReceipts)
      .set({
        cleanupStatus: 'completed',
        attemptCount: sql`${audioObjectCleanupReceipts.attemptCount} + 1`,
        lastAttemptAt: attemptedAt,
        completedAt: attemptedAt
      })
      .where(and(
        eq(audioObjectCleanupReceipts.id, receipt.id),
        eq(audioObjectCleanupReceipts.cleanupStatus, 'pending')
      ));
    await tx.insert(auditEvents).values({
      actorType: 'system',
      actorId: null,
      entityType: 'audio_object_cleanup_receipt',
      entityId: receipt.id,
      eventType: 'audio_object_cleanup.completed',
      previousStatus: 'pending',
      nextStatus: 'completed',
      metadata: {
        cleanupReason: receipt.cleanupReason,
        projectId: receipt.projectId,
        uploadSessionId: null,
        providerOperationId: operation.id,
        plannedUploadSessionId: operation.plannedUploadSessionId,
        attemptCount: receipt.attemptCount + 1
      }
    });
    return receipt;
  }

  async function retryPendingAudioObjectCleanupReceipts(input: { limit?: number } = {}) {
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('limit must be an integer from 1 through 500.');
    }
    const pending = await db
      .select({ id: audioObjectCleanupReceipts.id })
      .from(audioObjectCleanupReceipts)
      .where(eq(audioObjectCleanupReceipts.cleanupStatus, 'pending'))
      .orderBy(asc(audioObjectCleanupReceipts.requestedAt), asc(audioObjectCleanupReceipts.id))
      .limit(limit);
    const completedReceiptIds: string[] = [];
    const failures: Array<{ receiptId: string; error: string }> = [];

    for (const candidate of pending) {
      const prepared = await db.transaction(async (tx) => {
        const [snapshot] = await tx
          .select()
          .from(audioObjectCleanupReceipts)
          .where(and(
            eq(audioObjectCleanupReceipts.id, candidate.id),
            eq(audioObjectCleanupReceipts.cleanupStatus, 'pending')
          ))
          .limit(1);
        if (!snapshot) return { kind: 'skipped' as const };

        if (!snapshot.uploadSessionId) {
          const [operation] = await tx
            .select()
            .from(audioProviderOperations)
            .where(and(
              eq(audioProviderOperations.operationType, 'initiate_multipart'),
              isNull(audioProviderOperations.uploadSessionId),
              eq(audioProviderOperations.projectId, snapshot.projectId),
              eq(audioProviderOperations.storageProvider, snapshot.storageProvider),
              eq(audioProviderOperations.storageBucket, snapshot.storageBucket),
              eq(audioProviderOperations.storageKey, snapshot.storageKey)
            ))
            .for('update')
            .limit(1);
          if (operation) {
            if (operation.status === 'canceled') {
              await completePendingSessionlessCleanupReceipt(tx, operation, new Date());
              return { kind: 'operation_completed' as const, receipt: snapshot };
            }
            await tx
              .update(audioObjectCleanupReceipts)
              .set({
                attemptCount: sql`${audioObjectCleanupReceipts.attemptCount} + 1`,
                lastError: `Provider initiation operation ${operation.id} remains ${operation.status}; due reconciliation owns cleanup.`,
                lastAttemptAt: new Date()
              })
              .where(eq(audioObjectCleanupReceipts.id, snapshot.id));
            return { kind: 'operation_pending' as const, receipt: snapshot };
          }
          return {
            kind: 'legacy_orphan' as const,
            receipt: snapshot,
            identity: {
              storageProvider: parseAudioStorageProvider(snapshot.storageProvider),
              storageBucket: snapshot.storageBucket,
              storageKey: snapshot.storageKey,
              ...(snapshot.providerUploadId ? { providerUploadId: snapshot.providerUploadId } : {})
            }
          };
        }
        const [session] = await tx
          .select()
          .from(audioUploadSessions)
          .where(eq(audioUploadSessions.id, snapshot.uploadSessionId))
          .for('update')
          .limit(1);
        if (!session
          || session.projectId !== snapshot.projectId
          || session.storageProvider !== snapshot.storageProvider
          || session.storageBucket !== snapshot.storageBucket
          || session.storageKey !== snapshot.storageKey
          || session.providerUploadId !== snapshot.providerUploadId
          || session.uploadStatus === 'completed') {
          throw new Error('Cleanup receipt no longer matches an unsealed upload session.');
        }
        const cleanup = await prepareSessionCleanupProviderOperation(tx, session);
        if (cleanup.kind === 'deferred') {
          await tx
            .update(audioObjectCleanupReceipts)
            .set({
              attemptCount: sql`${audioObjectCleanupReceipts.attemptCount} + 1`,
              lastError: `Provider operation ${cleanup.blockingOperation.id} still owns an active byte-mutation lease.`,
              lastAttemptAt: new Date()
            })
            .where(eq(audioObjectCleanupReceipts.id, snapshot.id));
          return { kind: 'deferred' as const, receipt: snapshot };
        }
        return { ...cleanup, receipt: snapshot, session };
      });

      if (prepared.kind === 'skipped' || prepared.kind === 'deferred' || prepared.kind === 'operation_pending') continue;
      if (prepared.kind === 'operation_completed') {
        completedReceiptIds.push(prepared.receipt.id);
        continue;
      }
      const attemptedAt = new Date();
      try {
        if (prepared.kind === 'legacy_orphan') {
          await discardUnsealedUpload(prepared.identity);
          const observation = await store.reconcileCleanup(prepared.identity);
          if (observation.status !== 'absent'
            || observation.multipartPresent
            || observation.stagingPresent
            || observation.sealedPresent) {
            throw new Error('Legacy orphan cleanup did not confirm exact provider absence.');
          }
          await db.transaction(async (tx) => {
            const [receipt] = await tx
              .select()
              .from(audioObjectCleanupReceipts)
              .where(and(
                eq(audioObjectCleanupReceipts.id, prepared.receipt.id),
                eq(audioObjectCleanupReceipts.cleanupStatus, 'pending')
              ))
              .for('update')
              .limit(1);
            if (!receipt) return;
            await tx
              .update(audioObjectCleanupReceipts)
              .set({
                cleanupStatus: 'completed',
                attemptCount: sql`${audioObjectCleanupReceipts.attemptCount} + 1`,
                lastAttemptAt: attemptedAt,
                completedAt: attemptedAt
              })
              .where(eq(audioObjectCleanupReceipts.id, receipt.id));
            await tx.insert(auditEvents).values({
              actorType: 'system',
              actorId: null,
              entityType: 'audio_object_cleanup_receipt',
              entityId: receipt.id,
              eventType: 'audio_object_cleanup.completed',
              previousStatus: 'pending',
              nextStatus: 'completed',
              metadata: {
                cleanupReason: receipt.cleanupReason,
                projectId: receipt.projectId,
                uploadSessionId: null,
                storageProvider: receipt.storageProvider,
                storageBucket: receipt.storageBucket,
                storageKey: receipt.storageKey,
                attemptCount: receipt.attemptCount + 1,
                compatibilityPath: 'legacy_orphan_without_upload_session'
              }
            });
          });
        } else {
          const applyDomain = async (tx: AudioProviderOperationTransaction) => {
            const [session] = await tx
              .select()
              .from(audioUploadSessions)
              .where(eq(audioUploadSessions.id, prepared.session.id))
              .for('update')
              .limit(1);
            if (!session || session.uploadStatus === 'completed') {
              throw new Error('Cleanup receipt session became sealed before cleanup finalization.');
            }
            await tx
              .update(audioUploadSessions)
              .set({ uploadStatus: 'aborted', updatedAt: attemptedAt })
              .where(and(
                eq(audioUploadSessions.id, session.id),
                inArray(audioUploadSessions.uploadStatus, [...EXPIRABLE_AUDIO_UPLOAD_STATUSES])
              ));
            const receipt = await completePendingAudioObjectCleanupReceipt(tx, session, attemptedAt);
            if (!receipt || receipt.id !== prepared.receipt.id) {
              throw new Error('Provider cleanup succeeded without its exact pending cleanup receipt.');
            }
            return { kind: 'completed' as const, receiptId: receipt.id };
          };
          const loadCompleted = async () => {
            const [receipt] = await db
              .select()
              .from(audioObjectCleanupReceipts)
              .where(eq(audioObjectCleanupReceipts.id, prepared.receipt.id))
              .limit(1);
            return receipt?.cleanupStatus === 'completed'
              ? { kind: 'completed' as const, receiptId: receipt.id }
              : null;
          };
          if (prepared.kind === 'assembly_cleanup') {
            await runAssemblyCleanupRecovery({
              operation: prepared.operation,
              loadCompleted,
              applyDomain
            });
          } else {
            await runCleanupProviderOperation({
              operation: prepared.operation,
              loadCompleted,
              applyDomain
            });
          }
        }
        completedReceiptIds.push(prepared.receipt.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Object-store cleanup retry failed.';
        await db
          .update(audioObjectCleanupReceipts)
          .set({
            attemptCount: sql`${audioObjectCleanupReceipts.attemptCount} + 1`,
            lastError: message.slice(0, 4000),
            lastAttemptAt: attemptedAt
          })
          .where(and(
            eq(audioObjectCleanupReceipts.id, prepared.receipt.id),
            eq(audioObjectCleanupReceipts.cleanupStatus, 'pending')
          ));
        failures.push({ receiptId: prepared.receipt.id, error: message });
      }
    }

    return {
      examinedCount: pending.length,
      completedCount: completedReceiptIds.length,
      failedCount: failures.length,
      completedReceiptIds,
      failures
    };
  }

  async function validatePlayableAudioOriginal(version: {
    mimeType: string;
    byteSize: number;
    storageProvider: string;
    storageBucket: string;
    storageKey: string;
  }, purpose: 'private_candidate' | 'release_master' = 'private_candidate') {
    const validationMessages = purpose === 'release_master'
      ? {
          declaration: 'Release recording masters must be declared audio media.',
          maximum: `Release recording masters may not exceed ${MAX_RELEASE_MASTER_BYTES} bytes each.`,
          sizeMismatch: 'Release package object size no longer matches its sealed version.',
          incompleteHeader: 'Release master container header is incomplete.',
          boundary: 'Release master must end exactly at its declared RIFF/FORM container boundary.',
          parseFailure: 'Release master did not parse as complete playable audio matching its declared MIME type.'
        }
      : {
          declaration: 'Private candidate must be declared audio media.',
          maximum: `Audio files may not exceed ${MAX_RELEASE_MASTER_BYTES} bytes each.`,
          sizeMismatch: 'Stored audio size no longer matches its verified upload.',
          incompleteHeader: 'Audio container header is incomplete.',
          boundary: 'Audio must end exactly at its declared RIFF/FORM container boundary.',
          parseFailure: 'Audio did not parse as complete playable audio matching its declared MIME type.'
        };
    if (!version.mimeType.startsWith('audio/')) {
      throw new Error(validationMessages.declaration);
    }
    if (version.byteSize > MAX_RELEASE_MASTER_BYTES) {
      throw new Error(validationMessages.maximum);
    }
    const identity = {
      storageProvider: parseAudioStorageProvider(version.storageProvider),
      storageBucket: version.storageBucket,
      storageKey: version.storageKey
    };
    const openExactOriginal = async () => {
      const opened = await store.openOriginal(identity);
      if (opened.byteSize !== version.byteSize) {
        opened.stream.destroy();
        throw new Error(validationMessages.sizeMismatch);
      }
      return opened;
    };

    if (['audio/wav', 'audio/x-wav', 'audio/aiff', 'audio/x-aiff'].includes(version.mimeType)) {
      const prefixObject = await openExactOriginal();
      const prefix = await readStreamPrefix(prefixObject.stream, 12);
      if (prefix.byteLength < 12) throw new Error(validationMessages.incompleteHeader);
      const declaredSize = version.mimeType.includes('aiff')
        ? prefix.readUInt32BE(4) + 8
        : prefix.readUInt32LE(4) + 8;
      if (declaredSize !== version.byteSize) {
        throw new Error(validationMessages.boundary);
      }
    }

    const opened = await openExactOriginal();
    try {
      let metadata;
      try {
        metadata = await parseStream(
          opened.stream,
          { mimeType: version.mimeType, size: version.byteSize },
          { duration: true, skipCovers: true }
        );
      } catch (cause) {
        throw new Error(validationMessages.parseFailure, { cause });
      }
      const duration = metadata.format.duration;
      const container = metadata.format.container ?? '';
      if (!audioContainerMatchesMime(version.mimeType, container)
        || !metadata.format.codec
        || !Number.isFinite(duration)
        || (duration ?? 0) <= 0
        || (metadata.format.sampleRate ?? 0) <= 0
        || (metadata.format.numberOfChannels ?? 0) <= 0) {
        throw new Error(validationMessages.parseFailure);
      }
      return {
        container,
        codec: metadata.format.codec,
        durationMs: Math.max(1, Math.round((duration ?? 0) * 1000)),
        sampleRateHz: metadata.format.sampleRate ?? null,
        bitDepth: metadata.format.bitsPerSample ?? null,
        channelCount: metadata.format.numberOfChannels ?? null
      };
    } finally {
      if (!opened.stream.destroyed) opened.stream.destroy();
    }
  }

  async function validateReleasePackageAsset(input: {
    version: {
      id: string;
      mimeType: string;
      byteSize: number;
      storageProvider: string;
      storageBucket: string;
      storageKey: string;
    };
    roles: string[];
  }) {
    const { version, roles } = input;
    const roleKinds = new Set(roles.map((role) => (
      role === 'release_artwork'
        ? 'artwork'
        : role.startsWith('recording_master:')
          ? 'master'
          : role.startsWith('rights_document:')
            ? 'rights'
            : 'unsupported'
    )));
    if (roleKinds.size !== 1 || roleKinds.has('unsupported')) {
      throw new Error('Each release package asset must have one supported media role kind.');
    }
    const roleKind = [...roleKinds][0];
    const identity = {
      storageProvider: parseAudioStorageProvider(version.storageProvider),
      storageBucket: version.storageBucket,
      storageKey: version.storageKey
    };
    const openExactOriginal = async () => {
      const opened = await store.openOriginal(identity);
      if (opened.byteSize !== version.byteSize) {
        opened.stream.destroy();
        throw new Error('Release package object size no longer matches its sealed version.');
      }
      return opened;
    };

    if (roleKind === 'master') {
      const validation = await validatePlayableAudioOriginal(version, 'release_master');
      return {
        assetVersionId: version.id,
        validatorKey: RELEASE_PACKAGE_VALIDATOR_KEY,
        roleKind,
        container: validation.container,
        codec: validation.codec,
        durationSeconds: validation.durationMs / 1000,
        sampleRateHz: validation.sampleRateHz,
        channelCount: validation.channelCount
      };
    }

    if (roleKind === 'artwork') {
      if (!version.mimeType.startsWith('image/')) {
        throw new Error('Release artwork must be declared image media.');
      }
      const opened = await openExactOriginal();
      const body = await readStreamWithLimit(opened.stream, MAX_RELEASE_ARTWORK_BYTES);
      assertStrictImageContainer(version.mimeType, body);
      const metadata = await sharp(body, { failOn: 'error' }).metadata();
      const expectedFormat = version.mimeType === 'image/jpeg'
        ? 'jpeg'
        : version.mimeType.replace('image/', '');
      if (metadata.format !== expectedFormat || !metadata.width || !metadata.height) {
        throw new Error('Release artwork did not decode as the declared image type.');
      }
      return {
        assetVersionId: version.id,
        validatorKey: RELEASE_PACKAGE_VALIDATOR_KEY,
        roleKind,
        format: metadata.format,
        width: metadata.width,
        height: metadata.height
      };
    }

    if (!['text/plain', 'text/markdown', 'application/pdf'].includes(version.mimeType)) {
      throw new Error('Release rights evidence must be plain text, Markdown, or a bounded PDF document.');
    }
    const opened = await openExactOriginal();
    const body = await readStreamWithLimit(opened.stream, MAX_RELEASE_RIGHTS_DOCUMENT_BYTES);
    assertStrictTextDocument(version.mimeType, body);
    return {
      assetVersionId: version.id,
      validatorKey: RELEASE_PACKAGE_VALIDATOR_KEY,
      roleKind,
      format: version.mimeType
    };
  }

  async function requireProjectAccess(input: {
    projectId: string;
    userId: string;
    needUpload?: boolean;
    needDownload?: boolean;
    needApprove?: boolean;
    needManageRelease?: boolean;
    needManageAccess?: boolean;
  }) {
    const [grant] = await db
      .select()
      .from(audioProjectAccessGrants)
      .where(and(
        eq(audioProjectAccessGrants.projectId, input.projectId),
        eq(audioProjectAccessGrants.granteeUserId, input.userId),
        isNull(audioProjectAccessGrants.revokedAt),
        or(isNull(audioProjectAccessGrants.expiresAt), gt(audioProjectAccessGrants.expiresAt, new Date()))
      ))
      .limit(1);
    if (!grant) return null;
    if (input.needUpload && !grant.canUploadVersions) return null;
    if (input.needDownload && !grant.canDownloadOriginals) return null;
    if (input.needApprove && !grant.canApprove) return null;
    if (input.needManageRelease && !grant.canManageRelease) return null;
    if (input.needManageAccess && !grant.canManageAccess) return null;
    return grant;
  }

  async function createProject(input: {
    performerId: string;
    actorUserId: string;
    title: string;
    projectKind?: 'music' | 'comedy' | 'podcast' | 'other_audio';
  }) {
    const title = input.title.trim();
    if (!title) throw new Error('Project title is required.');

    return db.transaction(async (tx) => {
      const [project] = await tx.insert(audioProjects).values({
        performerId: input.performerId,
        createdByUserId: input.actorUserId,
        title,
        projectKind: input.projectKind ?? 'music',
        status: 'active'
      }).returning();

      await tx.insert(audioProjectAccessGrants).values({
        projectId: project.id,
        granteeUserId: input.actorUserId,
        role: 'owner',
        canUploadVersions: true,
        canDownloadOriginals: true,
        canComment: true,
        canApprove: true,
        canManageRelease: true,
        canManageAccess: true,
        grantedByUserId: input.actorUserId
      });

      await tx.insert(auditEvents).values({
        actorType: 'performer',
        actorId: input.actorUserId,
        entityType: 'audio_project',
        entityId: project.id,
        eventType: 'audio_project.create',
        previousStatus: null,
        nextStatus: 'active',
        metadata: { title: project.title }
      });

      return project;
    });
  }

  async function listProjects(input: { performerId: string; actorUserId: string }) {
    return db
      .select({
        id: audioProjects.id,
        title: audioProjects.title,
        projectKind: audioProjects.projectKind,
        status: audioProjects.status,
        createdAt: audioProjects.createdAt,
        updatedAt: audioProjects.updatedAt
      })
      .from(audioProjects)
      .innerJoin(
        audioProjectAccessGrants,
        and(
          eq(audioProjectAccessGrants.projectId, audioProjects.id),
          eq(audioProjectAccessGrants.granteeUserId, input.actorUserId),
          isNull(audioProjectAccessGrants.revokedAt),
          or(isNull(audioProjectAccessGrants.expiresAt), gt(audioProjectAccessGrants.expiresAt, new Date()))
        )
      )
      .where(and(eq(audioProjects.performerId, input.performerId), eq(audioProjects.status, 'active')))
      .orderBy(desc(audioProjects.updatedAt));
  }

  async function listProjectAssets(input: { projectId: string; actorUserId: string }) {
    const access = await requireProjectAccess({ projectId: input.projectId, userId: input.actorUserId });
    if (!access) throw new Error('Project access required.');

    const assets = await db
      .select({
        id: audioAssets.id,
        title: audioAssets.title,
        assetKind: audioAssets.assetKind,
        status: audioAssets.status,
        metadata: audioAssets.metadata,
        createdAt: audioAssets.createdAt
      })
      .from(audioAssets)
      .where(and(eq(audioAssets.projectId, input.projectId), eq(audioAssets.status, 'active')))
      .orderBy(desc(audioAssets.createdAt));

    const versions = await db
      .select({
        id: audioProjectAssetVersions.id,
        assetId: audioProjectAssetVersions.assetId,
        versionNumber: audioProjectAssetVersions.versionNumber,
        originalFilename: audioProjectAssetVersions.originalFilename,
        mimeType: audioProjectAssetVersions.mimeType,
        byteSize: audioProjectAssetVersions.byteSize,
        sha256: audioProjectAssetVersions.sha256,
        sealedAt: audioProjectAssetVersions.sealedAt
      })
      .from(audioProjectAssetVersions)
      .where(eq(audioProjectAssetVersions.projectId, input.projectId))
      .orderBy(desc(audioProjectAssetVersions.createdAt));

    return { assets, versions };
  }

  async function getStorageUsage(input: { performerId: string }) {
    return loadAudioStorageUsage(db, storagePolicy, input);
  }

  async function initiateCollaboratorRevisionUpload(input: {
    grantId: string;
    actorUserId: string;
    originalFilename: string;
    mimeType: string;
    expectedByteSize: number;
    expectedSha256: string;
    idempotencyKey: string;
    partSizeBytes?: number;
  }) {
    if (!collaboratorRevisionUploadsEnabled) {
      throw Object.assign(new Error('Private candidate uploads are disabled.'), {
        status: 503,
        code: 'candidate_uploads_disabled'
      });
    }
    const expectedSha256 = input.expectedSha256.trim().toLowerCase();
    const idempotencyKey = input.idempotencyKey.trim();
    const originalFilename = input.originalFilename.trim();
    if (!idempotencyKey || idempotencyKey.length > 200) throw new Error('idempotencyKey is required and must not exceed 200 characters.');
    if (!originalFilename || originalFilename.length > 255) throw new Error('originalFilename is required and must not exceed 255 characters.');
    if (!/^[0-9a-f]{64}$/.test(expectedSha256)) throw new Error('expectedSha256 must be a 64-char hex digest.');
    if (!Number.isSafeInteger(input.expectedByteSize) || input.expectedByteSize <= 0) {
      throw new Error('expectedByteSize must be a positive integer.');
    }
    const partSizeBytes = input.partSizeBytes ?? DEFAULT_PART_SIZE;
    if (!Number.isSafeInteger(partSizeBytes) || partSizeBytes < DEFAULT_PART_SIZE || partSizeBytes > 6 * 1024 * 1024) {
      throw new Error('partSizeBytes must be an integer from 5 MiB through 6 MiB.');
    }
    if (Math.ceil(input.expectedByteSize / partSizeBytes) > 10_000) {
      throw new Error('Upload requires more than the provider maximum of 10000 parts.');
    }

    const reserved = await db.transaction(async (tx) => {
      const [scope] = await tx
        .select({
          grantId: audioFileAccessGrants.id,
          projectId: audioFileAccessGrants.projectId,
          sourceAssetVersionId: audioFileAccessGrants.assetVersionId,
          granteeUserId: audioFileAccessGrants.granteeUserId,
          maxCandidateBytes: audioFileAccessGrants.maxCandidateBytes,
          assetId: audioProjectAssetVersions.assetId,
          assetKind: audioAssets.assetKind,
          performerId: audioProjects.performerId
        })
        .from(audioFileAccessGrants)
        .innerJoin(audioProjectAssetVersions, eq(audioProjectAssetVersions.id, audioFileAccessGrants.assetVersionId))
        .innerJoin(audioAssets, eq(audioAssets.id, audioProjectAssetVersions.assetId))
        .innerJoin(audioProjects, eq(audioProjects.id, audioFileAccessGrants.projectId))
        .where(eq(audioFileAccessGrants.id, input.grantId))
        .limit(1);
      if (!scope || scope.granteeUserId !== input.actorUserId) {
        throw Object.assign(new Error('Exact collaborator revision grant required.'), { status: 403 });
      }
      if (!scope.maxCandidateBytes || input.expectedByteSize > scope.maxCandidateBytes) {
        throw Object.assign(new Error('Private candidate exceeds the creator-approved byte ceiling.'), {
          status: 413,
          code: 'candidate_byte_ceiling_exceeded',
          maxCandidateBytes: scope.maxCandidateBytes ?? 0,
          requestedBytes: input.expectedByteSize
        });
      }
      await requireActiveCollaboratorRevisionGrant(tx, {
        grantId: scope.grantId,
        projectId: scope.projectId,
        actorUserId: input.actorUserId,
        assetId: scope.assetId,
        sourceAssetVersionId: scope.sourceAssetVersionId
      });
      const uploadType = normalizeAudioAssetUploadType({
        assetKind: scope.assetKind,
        mimeType: input.mimeType
      });
      if (!uploadType.mimeType.startsWith('audio/')) {
        throw new Error('Private candidate revisions must be audio files.');
      }
      const requestFingerprint = sha256Hex(JSON.stringify({
        purpose: 'collaborator_revision',
        grantId: scope.grantId,
        actorUserId: input.actorUserId,
        projectId: scope.projectId,
        assetId: scope.assetId,
        sourceAssetVersionId: scope.sourceAssetVersionId,
        originalFilename,
        mimeType: uploadType.mimeType,
        expectedByteSize: input.expectedByteSize,
        expectedSha256,
        partSizeBytes,
        maxCandidateBytes: scope.maxCandidateBytes
      }));

      await tx.execute(sql`
        select set_config('sway.audio_storage_performer_transaction', ${scope.performerId}, true)
      `);
      await lockAudioStorageForPerformer(tx, scope.performerId);
      const [existingSession] = await tx
        .select()
        .from(audioUploadSessions)
        .where(eq(audioUploadSessions.collaboratorFileGrantId, scope.grantId))
        .limit(1);
      if (existingSession) {
        if (existingSession.requestFingerprint !== requestFingerprint) {
          throw Object.assign(new Error('This candidate grant is already bound to a different upload intent.'), {
            status: 409,
            code: 'candidate_upload_intent_conflict'
          });
        }
        return { kind: 'session' as const, session: existingSession };
      }

      const [existingOperation] = await tx
        .select()
        .from(audioProviderOperations)
        .where(and(
          eq(audioProviderOperations.projectId, scope.projectId),
          eq(audioProviderOperations.operationType, 'initiate_multipart'),
          sql`${audioProviderOperations.requestPayload}->>'collaboratorFileGrantId' = ${scope.grantId}`
        ))
        .limit(1);
      if (existingOperation) {
        if (existingOperation.requestPayload.requestFingerprint !== requestFingerprint) {
          throw Object.assign(new Error('This candidate grant is already bound to a different upload intent.'), {
            status: 409,
            code: 'candidate_upload_intent_conflict'
          });
        }
        const replay = await providerOperations.reserveOperation(tx, {
          projectId: scope.projectId,
          performerId: scope.performerId,
          requestedByUserId: input.actorUserId,
          plannedUploadSessionId: existingOperation.plannedUploadSessionId,
          operationType: 'initiate_multipart',
          identity: operationObjectIdentity(existingOperation),
          reservedByteSize: input.expectedByteSize,
          reservedObjectCount: 1,
          requestPayload: existingOperation.requestPayload
        });
        return {
          kind: 'operation' as const,
          operation: replay.operation,
          scope,
          uploadType,
          requestFingerprint
        };
      }

      const workspaceUsage = await loadAudioStorageUsage(tx, storagePolicy, {
        performerId: scope.performerId
      });
      assertAudioWorkingObjectAvailable(workspaceUsage);
      assertAudioStorageReservationAvailable(workspaceUsage, input.expectedByteSize);
      const plannedUploadSessionId = randomUUID();
      const identity = store.planUploadIdentity({
        projectId: scope.projectId,
        uploadSessionId: plannedUploadSessionId,
        filename: originalFilename,
        mimeType: uploadType.mimeType
      });
      const requestPayload = {
        purpose: 'collaborator_revision',
        collaboratorFileGrantId: scope.grantId,
        requestFingerprint,
        sessionIdempotencyKey: `candidate:${sha256Hex(`${scope.grantId}:${idempotencyKey}`)}`,
        projectId: scope.projectId,
        actorUserId: input.actorUserId,
        assetId: scope.assetId,
        sourceAssetVersionId: scope.sourceAssetVersionId,
        originalFilename,
        mimeType: uploadType.mimeType,
        expectedByteSize: input.expectedByteSize,
        expectedSha256,
        partSizeBytes,
        maxCandidateBytes: scope.maxCandidateBytes
      };
      const operation = await providerOperations.reserveOperation(tx, {
        projectId: scope.projectId,
        performerId: scope.performerId,
        requestedByUserId: input.actorUserId,
        plannedUploadSessionId,
        operationType: 'initiate_multipart',
        identity,
        reservedByteSize: input.expectedByteSize,
        reservedObjectCount: 1,
        requestPayload
      });
      return {
        kind: 'operation' as const,
        operation: operation.operation,
        scope,
        uploadType,
        requestFingerprint
      };
    });
    if (reserved.kind === 'session') return reserved.session;

    return runInitiationProviderOperation({
      operation: reserved.operation,
      originalFilename,
      mimeType: reserved.uploadType.mimeType,
      loadCompleted: async () => (await db
        .select()
        .from(audioUploadSessions)
        .where(eq(audioUploadSessions.id, reserved.operation.plannedUploadSessionId))
        .limit(1))[0] ?? null,
      applyDomain: finalizeInitiationDomain
    });
  }

  async function initiateUpload(input: {
    projectId: string;
    actorUserId: string;
    title: string;
    assetKind: string;
    originalFilename: string;
    mimeType: string;
    expectedByteSize: number;
    expectedSha256: string;
    idempotencyKey: string;
    partSizeBytes?: number;
  }) {
    const access = await requireProjectAccess({
      projectId: input.projectId,
      userId: input.actorUserId,
      needUpload: true
    });
    if (!access) throw new Error('Upload permission required.');

    const expectedSha256 = input.expectedSha256.trim().toLowerCase();
    const idempotencyKey = input.idempotencyKey.trim();
    if (!idempotencyKey) throw new Error('idempotencyKey is required.');
    if (!/^[0-9a-f]{64}$/.test(expectedSha256)) throw new Error('expectedSha256 must be a 64-char hex digest.');
    if (!Number.isSafeInteger(input.expectedByteSize) || input.expectedByteSize <= 0) {
      throw new Error('expectedByteSize must be a positive integer.');
    }
    const partSizeBytes = input.partSizeBytes ?? DEFAULT_PART_SIZE;
    if (!Number.isSafeInteger(partSizeBytes) || partSizeBytes < DEFAULT_PART_SIZE || partSizeBytes > 6 * 1024 * 1024) {
      throw new Error('partSizeBytes must be an integer from 5 MiB through 6 MiB.');
    }
    const expectedPartCount = Math.ceil(input.expectedByteSize / partSizeBytes);
    if (expectedPartCount > 10_000) {
      throw new Error('Upload requires more than the provider maximum of 10000 parts.');
    }
    const uploadType = normalizeAudioAssetUploadType({
      assetKind: input.assetKind,
      mimeType: input.mimeType
    });

    const idempotencyHash = sha256Hex(`${input.projectId}:${input.actorUserId}:${idempotencyKey}`);
    const requestIntent = {
      purpose: 'owner_asset',
      idempotencyHash,
      projectId: input.projectId,
      actorUserId: input.actorUserId,
      title: input.title.trim() || input.originalFilename,
      assetKind: uploadType.assetKind,
      originalFilename: input.originalFilename,
      mimeType: uploadType.mimeType,
      expectedByteSize: input.expectedByteSize,
      expectedSha256,
      partSizeBytes
    };
    const requestFingerprint = fingerprintAudioProviderValue(requestIntent);
    const requestPayload = {
      ...requestIntent,
      requestFingerprint,
      sessionIdempotencyKey: idempotencyKey
    };
    const reserved = await db.transaction(async (tx) => {
      const [project] = await tx
        .select({ performerId: audioProjects.performerId })
        .from(audioProjects)
        .where(eq(audioProjects.id, input.projectId))
        .limit(1);
      if (!project) throw new Error('Audio project not found.');

      await tx.execute(sql`
        select set_config('sway.audio_storage_performer_transaction', ${project.performerId}, true)
      `);
      await lockAudioStorageForPerformer(tx, project.performerId);

      const [existingSession] = await tx
        .select()
        .from(audioUploadSessions)
        .where(and(
          eq(audioUploadSessions.projectId, input.projectId),
          eq(audioUploadSessions.idempotencyKey, idempotencyKey)
        ))
        .limit(1);
      if (existingSession) {
        const exactIdentity = existingSession.uploadPurpose === 'owner_asset'
          && existingSession.initiatedByUserId === input.actorUserId;
        let exactIntent = existingSession.requestFingerprint === requestFingerprint;
        if (exactIdentity && !existingSession.requestFingerprint) {
          const [existingAsset] = existingSession.assetId
            ? await tx
                .select({ title: audioAssets.title, assetKind: audioAssets.assetKind })
                .from(audioAssets)
                .where(and(
                  eq(audioAssets.id, existingSession.assetId),
                  eq(audioAssets.projectId, existingSession.projectId)
                ))
                .limit(1)
            : [];
          exactIntent = Boolean(existingAsset)
            && existingAsset!.title === requestIntent.title
            && existingAsset!.assetKind === requestIntent.assetKind
            && existingSession.originalFilename === requestIntent.originalFilename
            && existingSession.expectedMimeType === requestIntent.mimeType
            && existingSession.expectedByteSize === requestIntent.expectedByteSize
            && existingSession.expectedSha256 === requestIntent.expectedSha256
            && existingSession.partSizeBytes === requestIntent.partSizeBytes;
        }
        if (!exactIdentity || !exactIntent) {
          throw Object.assign(new Error('This owner upload idempotency key is already bound to a different actor or intent.'), {
            status: 409,
            code: 'owner_upload_intent_conflict'
          });
        }
        return { kind: 'session' as const, session: existingSession };
      }

      const [existingOperation] = await tx
        .select()
        .from(audioProviderOperations)
        .where(and(
          eq(audioProviderOperations.projectId, input.projectId),
          eq(audioProviderOperations.operationType, 'initiate_multipart'),
          sql`${audioProviderOperations.requestPayload}->>'purpose' = 'owner_asset'`,
          sql`${audioProviderOperations.requestPayload}->>'sessionIdempotencyKey' = ${idempotencyKey}`
        ))
        .limit(1);
      if (existingOperation) {
        if (existingOperation.requestedByUserId !== input.actorUserId
          || existingOperation.requestPayload.requestFingerprint !== requestFingerprint) {
          throw Object.assign(new Error('This owner upload idempotency key is already bound to a different actor or intent.'), {
            status: 409,
            code: 'owner_upload_intent_conflict'
          });
        }
        const replay = await providerOperations.reserveOperation(tx, {
          projectId: input.projectId,
          performerId: project.performerId,
          requestedByUserId: input.actorUserId,
          plannedUploadSessionId: existingOperation.plannedUploadSessionId,
          operationType: 'initiate_multipart',
          identity: operationObjectIdentity(existingOperation),
          reservedByteSize: input.expectedByteSize,
          reservedObjectCount: 1,
          requestPayload
        });
        return { kind: 'operation' as const, operation: replay.operation };
      }

      const workspaceUsage = await loadAudioStorageUsage(tx, storagePolicy, {
        performerId: project.performerId
      });
      assertAudioWorkingObjectAvailable(workspaceUsage);
      assertAudioStorageReservationAvailable(workspaceUsage, input.expectedByteSize);

      const plannedUploadSessionId = randomUUID();
      const identity = store.planUploadIdentity({
        projectId: input.projectId,
        uploadSessionId: plannedUploadSessionId,
        filename: input.originalFilename,
        mimeType: uploadType.mimeType
      });
      const operation = await providerOperations.reserveOperation(tx, {
        projectId: input.projectId,
        performerId: project.performerId,
        requestedByUserId: input.actorUserId,
        plannedUploadSessionId,
        operationType: 'initiate_multipart',
        identity,
        reservedByteSize: input.expectedByteSize,
        reservedObjectCount: 1,
        requestPayload
      });
      return { kind: 'operation' as const, operation: operation.operation };
    });
    if (reserved.kind === 'session') return reserved.session;

    return runInitiationProviderOperation({
      operation: reserved.operation,
      originalFilename: input.originalFilename,
      mimeType: uploadType.mimeType,
      loadCompleted: async () => (await db
        .select()
        .from(audioUploadSessions)
        .where(eq(audioUploadSessions.id, reserved.operation.plannedUploadSessionId))
        .limit(1))[0] ?? null,
      applyDomain: finalizeInitiationDomain
    });
  }

  async function authorizeCollaboratorRevisionUploadPart(input: {
    grantId: string;
    uploadSessionId: string;
    actorUserId: string;
    partNumber: number;
  }) {
    if (!collaboratorRevisionUploadsEnabled) {
      throw Object.assign(new Error('Private candidate uploads are disabled.'), {
        status: 503,
        code: 'candidate_uploads_disabled'
      });
    }
    if (!Number.isSafeInteger(input.partNumber) || input.partNumber < 1) {
      throw Object.assign(new Error('partNumber must be a positive integer.'), { status: 422 });
    }

    return db.transaction(async (tx) => {
      const [scope] = await tx
        .select()
        .from(audioUploadSessions)
        .where(eq(audioUploadSessions.id, input.uploadSessionId))
        .limit(1);
      if (!scope
        || scope.uploadPurpose !== 'collaborator_revision'
        || scope.collaboratorFileGrantId !== input.grantId
        || scope.initiatedByUserId !== input.actorUserId
        || !scope.assetId
        || !scope.sourceAssetVersionId) {
        throw Object.assign(new Error('Exact collaborator revision upload authority required.'), { status: 403 });
      }

      await requireActiveCollaboratorRevisionGrant(tx, {
        grantId: scope.collaboratorFileGrantId,
        projectId: scope.projectId,
        actorUserId: input.actorUserId,
        assetId: scope.assetId,
        sourceAssetVersionId: scope.sourceAssetVersionId
      });
      const [session] = await tx
        .select()
        .from(audioUploadSessions)
        .where(eq(audioUploadSessions.id, input.uploadSessionId))
        .for('update')
        .limit(1);
      if (!session
        || session.collaboratorFileGrantId !== input.grantId
        || session.initiatedByUserId !== input.actorUserId) {
        throw Object.assign(new Error('Exact collaborator revision upload authority required.'), { status: 403 });
      }
      if (session.expiresAt.getTime() <= Date.now()) {
        throw Object.assign(new Error('Upload session expired.'), { status: 410 });
      }
      if (!['initiated', 'uploading'].includes(session.uploadStatus)) {
        throw Object.assign(new Error(`Upload session is ${session.uploadStatus} and cannot accept parts.`), { status: 409 });
      }
      const expectedPartCount = Math.ceil(session.expectedByteSize / session.partSizeBytes);
      if (input.partNumber > expectedPartCount) {
        throw Object.assign(
          new Error(`partNumber must be from 1 through ${expectedPartCount} for this upload.`),
          { status: 422 }
        );
      }
      const expectedPartBytes = input.partNumber === expectedPartCount
        ? session.expectedByteSize - (expectedPartCount - 1) * session.partSizeBytes
        : session.partSizeBytes;
      return {
        uploadSessionId: session.id,
        expectedPartBytes,
        expectedPartCount,
        expiresAt: session.expiresAt
      };
    });
  }

  async function finalizeUploadPartDomain(
    tx: AudioProviderOperationTransaction,
    operation: AudioProviderOperationRow,
    written: { etag: string; checksum: string; byteSize: number }
  ) {
    if (!operation.uploadSessionId
      || !operation.requestedByUserId
      || operation.partNumber === null
      || operation.bodyByteSize === null
      || !operation.bodySha256
      || written.byteSize !== operation.bodyByteSize
      || written.checksum !== operation.bodySha256) {
      throw new Error('Confirmed provider part does not match its immutable durable intent.');
    }
    const [session] = await tx
      .select()
      .from(audioUploadSessions)
      .where(eq(audioUploadSessions.id, operation.uploadSessionId))
      .for('update')
      .limit(1);
    if (!session || session.initiatedByUserId !== operation.requestedByUserId) {
      throw Object.assign(new Error('Upload session actor mismatch.'), { status: 403 });
    }
    if (session.uploadPurpose === 'collaborator_revision') {
      const grantId = operation.requestPayload.collaboratorFileGrantId;
      if (typeof grantId !== 'string'
        || !session.collaboratorFileGrantId
        || session.collaboratorFileGrantId !== grantId
        || !session.assetId
        || !session.sourceAssetVersionId) {
        throw Object.assign(new Error('Exact collaborator revision upload authority required.'), { status: 403 });
      }
      await requireActiveCollaboratorRevisionGrant(tx, {
        grantId,
        projectId: session.projectId,
        actorUserId: operation.requestedByUserId,
        assetId: session.assetId,
        sourceAssetVersionId: session.sourceAssetVersionId
      });
    } else {
      const [access] = await tx
        .select({ id: audioProjectAccessGrants.id })
        .from(audioProjectAccessGrants)
        .where(and(
          eq(audioProjectAccessGrants.projectId, session.projectId),
          eq(audioProjectAccessGrants.granteeUserId, operation.requestedByUserId),
          eq(audioProjectAccessGrants.canUploadVersions, true),
          isNull(audioProjectAccessGrants.revokedAt),
          or(isNull(audioProjectAccessGrants.expiresAt), gt(audioProjectAccessGrants.expiresAt, new Date()))
        ))
        .limit(1);
      if (!access) throw new Error('Upload permission required.');
    }
    if (session.expiresAt.getTime() <= Date.now()) throw new Error('Upload session expired.');
    const [existingPart] = await tx
      .select()
      .from(audioUploadParts)
      .where(and(
        eq(audioUploadParts.uploadSessionId, session.id),
        eq(audioUploadParts.partNumber, operation.partNumber)
      ))
      .limit(1);
    if (existingPart) {
      if (existingPart.byteSize !== written.byteSize
        || existingPart.providerChecksum !== written.checksum
        || existingPart.providerEtag !== written.etag) {
        throw new Error('Durable part receipt conflicts with confirmed provider evidence.');
      }
      return {
        etag: existingPart.providerEtag,
        checksum: existingPart.providerChecksum,
        byteSize: existingPart.byteSize
      };
    }
    if (!['initiated', 'uploading'].includes(session.uploadStatus)) {
      throw new Error(`Upload session is ${session.uploadStatus} and cannot accept parts.`);
    }
    if (operation.partNumber > 1) {
      const [firstPart] = await tx
        .select({ id: audioUploadParts.id })
        .from(audioUploadParts)
        .where(and(
          eq(audioUploadParts.uploadSessionId, session.id),
          eq(audioUploadParts.partNumber, 1)
        ))
        .limit(1);
      if (!firstPart) throw new Error('Upload part 1 must pass file-signature validation before later parts.');
    }
    await tx.insert(audioUploadParts).values({
      uploadSessionId: session.id,
      partNumber: operation.partNumber,
      byteSize: written.byteSize,
      providerEtag: written.etag,
      providerChecksum: written.checksum
    });
    if (session.uploadStatus === 'initiated') {
      await tx
        .update(audioUploadSessions)
        .set({ uploadStatus: 'uploading', updatedAt: new Date() })
        .where(eq(audioUploadSessions.id, session.id));
    }
    return written;
  }

  async function writeUploadPart(input: {
    uploadSessionId: string;
    actorUserId: string;
    grantId?: string;
    partNumber: number;
    body: Buffer;
  }) {
    if (!Number.isSafeInteger(input.partNumber) || input.partNumber < 1) {
      throw new Error('partNumber must be a positive integer.');
    }
    if (!Buffer.isBuffer(input.body) || input.body.length === 0) {
      throw new Error('Upload part body must contain bytes.');
    }
    const [scope] = await db
      .select()
      .from(audioUploadSessions)
      .where(eq(audioUploadSessions.id, input.uploadSessionId))
      .limit(1);
    if (!scope) throw new Error('Upload session not found.');
    if (scope.uploadPurpose === 'collaborator_revision' && !collaboratorRevisionUploadsEnabled) {
      throw Object.assign(new Error('Private candidate uploads are disabled.'), {
        status: 503,
        code: 'candidate_uploads_disabled'
      });
    }

    const bodySha256 = sha256Hex(input.body);
    const bodyMd5 = createHash('md5').update(input.body).digest('hex');
    const prepared = await db.transaction(async (tx) => {
      if (scope.uploadPurpose === 'collaborator_revision') {
        if (scope.initiatedByUserId !== input.actorUserId
          || !scope.collaboratorFileGrantId
          || !input.grantId
          || scope.collaboratorFileGrantId !== input.grantId
          || !scope.assetId
          || !scope.sourceAssetVersionId) {
          throw Object.assign(new Error('Exact collaborator revision upload authority required.'), { status: 403 });
        }
        await requireActiveCollaboratorRevisionGrant(tx, {
          grantId: scope.collaboratorFileGrantId,
          projectId: scope.projectId,
          actorUserId: input.actorUserId,
          assetId: scope.assetId,
          sourceAssetVersionId: scope.sourceAssetVersionId
        });
      }

      const [session] = await tx
        .select()
        .from(audioUploadSessions)
        .where(eq(audioUploadSessions.id, input.uploadSessionId))
        .for('update')
        .limit(1);
      if (!session) throw new Error('Upload session not found.');
      if (session.initiatedByUserId !== input.actorUserId) {
        throw Object.assign(new Error('Upload session actor mismatch.'), { status: 403 });
      }
      if (session.uploadPurpose === 'collaborator_revision'
        && (!input.grantId || session.collaboratorFileGrantId !== input.grantId)) {
        throw Object.assign(new Error('Exact collaborator revision upload authority required.'), { status: 403 });
      }
      if (session.expiresAt.getTime() <= Date.now()) throw new Error('Upload session expired.');

      const [cleanupIntent] = await tx
        .select({ id: audioProviderOperations.id })
        .from(audioProviderOperations)
        .where(and(
          eq(audioProviderOperations.uploadSessionId, session.id),
          inArray(audioProviderOperations.operationType, ['discard_upload', 'abort_upload'])
        ))
        .limit(1);
      if (cleanupIntent) {
        throw new AudioProviderOperationBusyError('Upload cleanup intent already owns this session.');
      }

      if (session.uploadPurpose === 'owner_asset') {
        const [access] = await tx
          .select({ id: audioProjectAccessGrants.id })
          .from(audioProjectAccessGrants)
          .where(and(
            eq(audioProjectAccessGrants.projectId, session.projectId),
            eq(audioProjectAccessGrants.granteeUserId, input.actorUserId),
            eq(audioProjectAccessGrants.canUploadVersions, true),
            isNull(audioProjectAccessGrants.revokedAt),
            or(isNull(audioProjectAccessGrants.expiresAt), gt(audioProjectAccessGrants.expiresAt, new Date()))
          ))
          .limit(1);
        if (!access) throw new Error('Upload permission required.');
      }

      const expectedPartCount = Math.ceil(session.expectedByteSize / session.partSizeBytes);
      if (input.partNumber > expectedPartCount) {
        throw new Error(`partNumber must be from 1 through ${expectedPartCount} for this upload.`);
      }
      const expectedPartBytes = input.partNumber === expectedPartCount
        ? session.expectedByteSize - (expectedPartCount - 1) * session.partSizeBytes
        : session.partSizeBytes;
      if (input.body.byteLength !== expectedPartBytes) {
        throw new Error(
          `Upload part ${input.partNumber} must contain exactly ${expectedPartBytes} bytes for the declared upload geometry.`
        );
      }

      const [existingPart] = await tx
        .select()
        .from(audioUploadParts)
        .where(and(
          eq(audioUploadParts.uploadSessionId, session.id),
          eq(audioUploadParts.partNumber, input.partNumber)
        ))
        .limit(1);
      if (existingPart) {
        if (existingPart.byteSize !== input.body.byteLength || existingPart.providerChecksum !== bodySha256) {
          throw Object.assign(new Error('Upload part replay does not match the originally stored bytes.'), {
            status: 409,
            code: 'upload_part_replay_conflict'
          });
        }
        if (['aborted', 'expired', 'rejected', 'quarantined'].includes(session.uploadStatus)) {
          throw new Error(`Upload session is ${session.uploadStatus} and cannot accept part replays.`);
        }
        return { kind: 'existing' as const, written: {
          etag: existingPart.providerEtag,
          checksum: existingPart.providerChecksum,
          byteSize: existingPart.byteSize
        } };
      }
      if (!['initiated', 'uploading'].includes(session.uploadStatus)) {
        throw new Error(`Upload session is ${session.uploadStatus} and cannot accept parts.`);
      }

      if (input.partNumber === 1) {
        const [asset] = await tx
          .select({ assetKind: audioAssets.assetKind })
          .from(audioAssets)
          .where(and(
            eq(audioAssets.id, session.assetId!),
            eq(audioAssets.projectId, session.projectId)
          ))
          .limit(1);
        if (!asset) throw new Error('Upload session asset not found.');
        assertAudioUploadFirstPartSignature({
          assetKind: asset.assetKind,
          mimeType: session.expectedMimeType,
          body: input.body
        });
      } else {
        const [firstPart] = await tx
          .select({ id: audioUploadParts.id })
          .from(audioUploadParts)
          .where(and(
            eq(audioUploadParts.uploadSessionId, session.id),
            eq(audioUploadParts.partNumber, 1)
          ))
          .limit(1);
        if (!firstPart) throw new Error('Upload part 1 must pass file-signature validation before later parts.');
      }

      const [project] = await tx
        .select({ performerId: audioProjects.performerId })
        .from(audioProjects)
        .where(eq(audioProjects.id, session.projectId))
        .limit(1);
      if (!project) throw new Error('Audio project not found.');
      const requestPayload: Record<string, unknown> = {
        action: 'upload_part',
        uploadSessionId: session.id,
        partNumber: input.partNumber,
        bodySha256,
        bodyMd5,
        bodyByteSize: input.body.byteLength
      };
      if (session.uploadPurpose === 'collaborator_revision') {
        requestPayload.collaboratorFileGrantId = session.collaboratorFileGrantId;
      }
      const reservation = await providerOperations.reserveOperation(tx, {
        projectId: session.projectId,
        performerId: project.performerId,
        requestedByUserId: input.actorUserId,
        uploadSessionId: session.id,
        plannedUploadSessionId: session.id,
        operationType: 'upload_part',
        identity: sessionObjectIdentity(session),
        partNumber: input.partNumber,
        bodySha256,
        bodyMd5,
        bodyByteSize: input.body.byteLength,
        requestPayload
      });
      return { kind: 'operation' as const, operation: reservation.operation };
    });
    if (prepared.kind === 'existing') return prepared.written;

    for (let cycle = 0; cycle < 4; cycle += 1) {
      const claim = await providerOperations.claimOperation(prepared.operation.id);
      if (claim.kind === 'terminal') {
        if (claim.operation.status === 'succeeded') {
          const [part] = await db
            .select()
            .from(audioUploadParts)
            .where(and(
              eq(audioUploadParts.uploadSessionId, input.uploadSessionId),
              eq(audioUploadParts.partNumber, input.partNumber)
            ))
            .limit(1);
          if (!part) throw new Error('Successful provider part operation is missing its atomic part receipt.');
          return { etag: part.providerEtag, checksum: part.providerChecksum, byteSize: part.byteSize };
        }
        throw providerOperationStateError(claim.operation);
      }
      if (claim.kind !== 'leased') throw providerOperationStateError(claim.operation);

      let written: { etag: string; checksum: string; byteSize: number } | null = null;
      let evidence: Record<string, unknown> | null = null;
      if (claim.lease.mode === 'execute') {
        await providerOperations.markProviderStarted(claim.lease);
        try {
          written = await providerOperations.runLeasedProviderCall(
            claim.lease,
            (signal) => store.writePart({
              identity: operationObjectIdentity(claim.operation),
              partNumber: input.partNumber,
              body: input.body,
              signal
            })
          );
          if (!written.etag
            || written.byteSize !== input.body.byteLength
            || written.checksum !== bodySha256) {
            throw new Error('Object store returned part evidence that does not match the reserved bytes.');
          }
          evidence = {
            outcome: 'uploaded',
            partNumber: input.partNumber,
            etag: written.etag,
            checksum: written.checksum,
            byteSize: written.byteSize
          };
        } catch (error) {
          await providerOperations.markReconcileRequired(claim.lease, error, 'part_result_ambiguous');
          continue;
        }
      } else {
        try {
          const observed = await providerOperations.runLeasedProviderCall(
            claim.lease,
            (signal) => store.reconcilePart({
              identity: operationObjectIdentity(claim.operation),
              partNumber: input.partNumber,
              expectedByteSize: input.body.byteLength,
              expectedMd5: bodyMd5,
              signal
            })
          );
          if (observed.status === 'confirmed') {
            written = { etag: observed.etag, checksum: bodySha256, byteSize: observed.byteSize };
            evidence = {
              outcome: 'recovered',
              partNumber: input.partNumber,
              etag: observed.etag,
              checksum: bodySha256,
              byteSize: observed.byteSize
            };
          } else if (observed.status === 'absent') {
            await providerOperations.resetAfterSafeReconciliation({
              lease: claim.lease,
              evidence: {
                reconciledSafeToRetry: true,
                observedPartAbsent: true,
                partNumber: input.partNumber
              }
            });
            continue;
          } else {
            const error = new Error('Provider part differs from the reserved byte digest or size.');
            await providerOperations.markReconcileRequired(claim.lease, error, 'part_evidence_mismatch');
            throw Object.assign(error, { status: 409, code: 'part_evidence_mismatch' });
          }
        } catch (error) {
          const current = await providerOperations.loadOperation(claim.operation.id);
          if (current?.status === 'leased' && current.leaseToken === claim.lease.token) {
            await providerOperations.markReconcileRequired(claim.lease, error, 'part_reconciliation_failed');
          }
          throw error;
        }
      }
      if (!written || !evidence) throw new Error('Upload-part provider evidence is incomplete.');

      try {
        const finalized = await providerOperations.finalizeSuccess({
          lease: claim.lease,
          evidence,
          applyDomain: (tx, operation) => finalizeUploadPartDomain(tx, operation, written!)
        });
        return finalized.result;
      } catch (error) {
        const current = await providerOperations.loadOperation(claim.operation.id);
        if (current?.status === 'leased' && current.leaseToken === claim.lease.token) {
          await providerOperations.markReconcileRequired(claim.lease, error, 'part_finalization_failed');
        }
        throw error;
      }
    }
    throw Object.assign(new Error('Upload part could not be reconciled within the bounded request attempt.'), {
      status: 503,
      code: 'audio_provider_reconciliation_pending'
    });
  }

  async function initiationAuthorityIsActive(operation: AudioProviderOperationRow) {
    if (!operation.requestedByUserId) return false;
    const purpose = operation.requestPayload.purpose;
    if (purpose === 'owner_asset') {
      const [authority] = await db
        .select({ id: audioProjectAccessGrants.id })
        .from(audioProjectAccessGrants)
        .where(and(
          eq(audioProjectAccessGrants.projectId, operation.projectId),
          eq(audioProjectAccessGrants.granteeUserId, operation.requestedByUserId),
          eq(audioProjectAccessGrants.canUploadVersions, true),
          isNull(audioProjectAccessGrants.revokedAt),
          or(isNull(audioProjectAccessGrants.expiresAt), gt(audioProjectAccessGrants.expiresAt, new Date()))
        ))
        .limit(1);
      return Boolean(authority);
    }
    if (purpose === 'collaborator_revision') {
      try {
        await requireActiveCollaboratorRevisionGrant(db, {
          grantId: requireOperationPayloadString(operation, 'collaboratorFileGrantId'),
          projectId: operation.projectId,
          actorUserId: operation.requestedByUserId,
          assetId: requireOperationPayloadString(operation, 'assetId'),
          sourceAssetVersionId: requireOperationPayloadString(operation, 'sourceAssetVersionId')
        });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  async function cancelSessionlessInitiationAfterAuthorityLoss(operation: AudioProviderOperationRow) {
    const plannedIdentity = operationObjectIdentity(operation);
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const claim = await providerOperations.claimOperation(operation.id);
      if (claim.kind === 'terminal') return claim.operation.status;
      if (claim.kind !== 'leased') return claim.kind;
      if (claim.lease.mode === 'execute') {
        const finalized = await providerOperations.finalizeCanceledBeforeProviderStart({
          lease: claim.lease,
          reason: 'upload_authority_ended_before_provider_dispatch',
          applyDomain: async (tx, current) => {
            await completePendingSessionlessCleanupReceipt(tx, current, new Date());
            await tx.insert(auditEvents).values({
              actorType: 'system',
              actorId: null,
              entityType: 'audio_provider_operation',
              entityId: current.id,
              eventType: 'audio_provider_operation.authority_cleanup_completed',
              previousStatus: current.status,
              nextStatus: 'canceled',
              metadata: { providerNotStarted: true, plannedUploadSessionId: current.plannedUploadSessionId }
            });
            return current.id;
          }
        });
        return finalized.operation.status;
      }

      let providerIdentity = plannedIdentity;
      try {
        const observed = await providerOperations.runLeasedProviderCall(
          claim.lease,
          (signal) => store.reconcileUpload({
            identity: plannedIdentity,
            uploadSessionId: claim.operation.plannedUploadSessionId,
            signal
          })
        );
        if (observed.status === 'ambiguous') {
          const error = new Error('Multiple provider uploads match the sessionless initiation cleanup identity.');
          await providerOperations.markReconcileRequired(claim.lease, error, 'initiation_cleanup_identity_ambiguous');
          throw error;
        }
        if (observed.status === 'found') providerIdentity = observed.identity;
        const cleanup = await providerOperations.runLeasedProviderCall(claim.lease, async (signal) => {
          let current = await store.reconcileCleanup(providerIdentity, { signal });
          if (current.status !== 'absent'
            || current.multipartPresent
            || current.stagingPresent
            || current.sealedPresent) {
            await discardUnsealedUpload(providerIdentity, db, { signal });
            current = await store.reconcileCleanup(providerIdentity, { signal });
          }
          return current;
        });
        if (cleanup.status !== 'absent'
          || cleanup.multipartPresent
          || cleanup.stagingPresent
          || cleanup.sealedPresent) {
          throw new Error('Sessionless initiation cleanup did not confirm exact provider absence.');
        }
        const finalized = await providerOperations.finalizeCanceledAfterCleanup({
          lease: claim.lease,
          providerUploadId: providerIdentity.providerUploadId,
          evidence: {
            cleanupConfirmed: true,
            reconciledAbsent: true,
            multipartAbsent: true,
            stagingAbsent: true,
            sealedAbsent: true,
            cancellationReason: 'upload_authority_ended_before_session_recovery'
          },
          applyDomain: async (tx, current) => {
            await completePendingSessionlessCleanupReceipt(tx, current, new Date());
            await tx.insert(auditEvents).values({
              actorType: 'system',
              actorId: null,
              entityType: 'audio_provider_operation',
              entityId: current.id,
              eventType: 'audio_provider_operation.authority_cleanup_completed',
              previousStatus: current.status,
              nextStatus: 'canceled',
              metadata: {
                providerAbsenceConfirmed: true,
                plannedUploadSessionId: current.plannedUploadSessionId
              }
            });
            return current.id;
          }
        });
        return finalized.operation.status;
      } catch (error) {
        const current = await providerOperations.loadOperation(claim.operation.id);
        if (current?.status === 'leased' && current.leaseToken === claim.lease.token) {
          await providerOperations.markReconcileRequired(claim.lease, error, 'initiation_authority_cleanup_failed');
        }
        throw error;
      }
    }
    return 'reconcile_required';
  }

  async function reconcileStartedUploadPart(operation: AudioProviderOperationRow) {
    const claim = await providerOperations.claimOperation(operation.id);
    if (claim.kind === 'terminal') return claim.operation.status;
    if (claim.kind !== 'leased') return claim.kind;
    if (claim.lease.mode !== 'reconcile'
      || claim.operation.partNumber === null
      || claim.operation.bodyByteSize === null
      || !claim.operation.bodyMd5
      || !claim.operation.bodySha256) {
      throw new AudioProviderOperationBusyError('Background part recovery requires a started reconcile lease with immutable byte evidence.');
    }
    try {
      const observed = await providerOperations.runLeasedProviderCall(
        claim.lease,
        (signal) => store.reconcilePart({
          identity: operationObjectIdentity(claim.operation),
          partNumber: claim.operation.partNumber!,
          expectedByteSize: claim.operation.bodyByteSize!,
          expectedMd5: claim.operation.bodyMd5!,
          signal
        })
      );
      if (observed.status === 'absent') {
        await providerOperations.resetAfterSafeReconciliation({
          lease: claim.lease,
          awaitClientRetry: true,
          evidence: {
            reconciledSafeToRetry: true,
            observedPartAbsent: true,
            partNumber: claim.operation.partNumber,
            recoverySource: 'durable_provider_worker'
          }
        });
        return 'awaiting_client_retry';
      }
      if (observed.status !== 'confirmed') {
        const error = new Error('Background provider-part reconciliation found mismatched byte evidence.');
        await providerOperations.markReconcileRequired(claim.lease, error, 'part_evidence_mismatch');
        throw error;
      }
      const written = {
        etag: observed.etag,
        checksum: claim.operation.bodySha256,
        byteSize: observed.byteSize
      };
      const finalized = await providerOperations.finalizeSuccess({
        lease: claim.lease,
        evidence: {
          outcome: 'recovered',
          partNumber: claim.operation.partNumber,
          etag: observed.etag,
          checksum: claim.operation.bodySha256,
          byteSize: observed.byteSize,
          recoverySource: 'durable_provider_worker'
        },
        applyDomain: (tx, current) => finalizeUploadPartDomain(tx, current, written)
      });
      return finalized.operation.status;
    } catch (error) {
      const current = await providerOperations.loadOperation(claim.operation.id);
      if (current?.status === 'leased' && current.leaseToken === claim.lease.token) {
        await providerOperations.markReconcileRequired(claim.lease, error, 'part_background_reconciliation_failed');
      }
      throw error;
    }
  }

  async function reconcileDueAudioProviderOperations(input: { limit?: number } = {}) {
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('limit must be an integer from 1 through 500.');
    }
    const candidates = await db
      .select({ id: audioProviderOperations.id })
      .from(audioProviderOperations)
      .where(or(
        and(
          eq(audioProviderOperations.operationType, 'initiate_multipart'),
          isNull(audioProviderOperations.uploadSessionId),
          or(
            eq(audioProviderOperations.status, 'pending'),
            eq(audioProviderOperations.status, 'reconcile_required'),
            and(
              eq(audioProviderOperations.status, 'leased'),
              lte(audioProviderOperations.leaseExpiresAt, new Date())
            )
          )
        ),
        and(
          inArray(audioProviderOperations.operationType, ['upload_part', 'complete_multipart']),
          sql`${audioProviderOperations.providerStartedAt} is not null`,
          or(
            eq(audioProviderOperations.status, 'reconcile_required'),
            and(
              eq(audioProviderOperations.status, 'leased'),
              lte(audioProviderOperations.leaseExpiresAt, new Date())
            )
          )
        )
      ))
      .orderBy(asc(audioProviderOperations.availableAt), asc(audioProviderOperations.createdAt), asc(audioProviderOperations.id))
      .limit(limit);
    const recoveredOperationIds: string[] = [];
    const canceledOperationIds: string[] = [];
    const deferredOperationIds: string[] = [];
    const failures: Array<{ operationId: string; error: string }> = [];

    for (const candidate of candidates) {
      const operation = await providerOperations.loadOperation(candidate.id);
      if (!operation || ['succeeded', 'canceled', 'dead_letter'].includes(operation.status)) continue;
      try {
        let outcome: string;
        if (operation.operationType === 'initiate_multipart') {
          if (await initiationAuthorityIsActive(operation)) {
            await runInitiationProviderOperation({
              operation,
              originalFilename: requireOperationPayloadString(operation, 'originalFilename'),
              mimeType: requireOperationPayloadString(operation, 'mimeType'),
              loadCompleted: async () => (await db
                .select()
                .from(audioUploadSessions)
                .where(eq(audioUploadSessions.id, operation.plannedUploadSessionId))
                .limit(1))[0] ?? null,
              applyDomain: finalizeInitiationDomain
            });
            outcome = 'succeeded';
          } else {
            outcome = await cancelSessionlessInitiationAfterAuthorityLoss(operation);
          }
        } else if (operation.operationType === 'upload_part') {
          outcome = await reconcileStartedUploadPart(operation);
        } else {
          const [session] = operation.uploadSessionId
            ? await db
                .select()
                .from(audioUploadSessions)
                .where(eq(audioUploadSessions.id, operation.uploadSessionId))
                .limit(1)
            : [];
          if (!session) throw new Error('Started assembly operation is missing its upload session.');
          if (session.uploadPurpose === 'collaborator_revision') {
            if (!session.collaboratorFileGrantId) throw new Error('Candidate assembly recovery is missing its exact grant.');
            await completeAndSealCollaboratorRevision({
              grantId: session.collaboratorFileGrantId,
              uploadSessionId: session.id,
              actorUserId: session.initiatedByUserId
            });
          } else {
            await completeAndSealUpload({
              uploadSessionId: session.id,
              actorUserId: session.initiatedByUserId,
              performerId: operation.performerId
            });
          }
          outcome = 'succeeded';
        }
        if (outcome === 'succeeded') recoveredOperationIds.push(operation.id);
        else if (outcome === 'canceled') canceledOperationIds.push(operation.id);
        else deferredOperationIds.push(operation.id);
      } catch (error) {
        failures.push({
          operationId: operation.id,
          error: error instanceof Error ? error.message : 'Durable provider-operation reconciliation failed.'
        });
      }
    }

    return {
      examinedCount: candidates.length,
      recoveredCount: recoveredOperationIds.length,
      canceledCount: canceledOperationIds.length,
      deferredCount: deferredOperationIds.length,
      failedCount: failures.length,
      recoveredOperationIds,
      canceledOperationIds,
      deferredOperationIds,
      failures
    };
  }

  async function expireStaleUploadSessions(input: { limit?: number; now?: Date } = {}) {
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('limit must be an integer from 1 through 500.');
    }
    const now = input.now ?? new Date();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new Error('now must be a valid Date when provided.');
    }
    const candidates = await db
      .select({ id: audioUploadSessions.id })
      .from(audioUploadSessions)
      .where(and(
        inArray(audioUploadSessions.uploadStatus, [...EXPIRABLE_AUDIO_UPLOAD_STATUSES]),
        lte(audioUploadSessions.expiresAt, now)
      ))
      .orderBy(asc(audioUploadSessions.expiresAt), asc(audioUploadSessions.id))
      .limit(limit);

    const expiredSessionIds: string[] = [];
    const staleAbortedSessionIds: string[] = [];
    const failures: Array<{ uploadSessionId: string; error: string }> = [];
    for (const candidate of candidates) {
      const prepared = await db.transaction(async (tx) => {
        const [session] = await tx
          .select()
          .from(audioUploadSessions)
          .where(and(
            eq(audioUploadSessions.id, candidate.id),
            inArray(audioUploadSessions.uploadStatus, [...EXPIRABLE_AUDIO_UPLOAD_STATUSES]),
            lte(audioUploadSessions.expiresAt, now)
          ))
          .for('update', { skipLocked: true })
          .limit(1);
        if (!session) return { kind: 'skipped' as const };

        const cleanup = await prepareSessionCleanupProviderOperation(tx, session);
        return { ...cleanup, session };
      });
      if (prepared.kind === 'skipped' || prepared.kind === 'deferred') continue;

      try {
        const applyDomain = async (tx: AudioProviderOperationTransaction) => {
          const [session] = await tx
            .select()
            .from(audioUploadSessions)
            .where(eq(audioUploadSessions.id, prepared.session.id))
            .for('update')
            .limit(1);
          if (!session) throw new Error('Stale upload session disappeared before cleanup finalization.');
          if (!EXPIRABLE_AUDIO_UPLOAD_STATUSES.includes(session.uploadStatus as never)
            || session.expiresAt.getTime() > now.getTime()) {
            if (session.uploadStatus === 'expired') {
              return { kind: 'expired' as const, uploadSessionId: session.id };
            }
            if (session.uploadStatus === 'aborted') {
              return { kind: 'stale_aborted' as const, uploadSessionId: session.id };
            }
            throw new Error('Stale upload cleanup intent no longer matches an expirable session.');
          }
          const terminalStatus = ['verifying', 'quarantined'].includes(session.uploadStatus)
            ? 'aborted'
            : 'expired';
          const [terminal] = await tx
            .update(audioUploadSessions)
            .set({ uploadStatus: terminalStatus, updatedAt: now })
            .where(and(
              eq(audioUploadSessions.id, session.id),
              inArray(audioUploadSessions.uploadStatus, [...EXPIRABLE_AUDIO_UPLOAD_STATUSES]),
              lte(audioUploadSessions.expiresAt, now)
            ))
            .returning({ id: audioUploadSessions.id });
          if (!terminal) throw new Error('Stale upload state changed before cleanup finalization.');
          await completePendingAudioObjectCleanupReceipt(tx, session, now);
          await tx.insert(auditEvents).values({
            actorType: 'system',
            actorId: null,
            entityType: 'audio_upload_session',
            entityId: terminal.id,
            eventType: terminalStatus === 'expired'
              ? 'audio_upload_session.expired'
              : 'audio_upload_session.stale_abort',
            previousStatus: session.uploadStatus,
            nextStatus: terminalStatus,
            metadata: {
              storageProvider: session.storageProvider,
              storageBucket: session.storageBucket,
              storageKey: session.storageKey,
              providerUploadId: session.providerUploadId,
              expiresAt: session.expiresAt.toISOString(),
              providerCleanupMethod: store.discardUpload ? 'discardUpload' : 'abortUpload',
              providerDiscardSucceeded: true
            }
          });
          return terminalStatus === 'expired'
            ? { kind: 'expired' as const, uploadSessionId: terminal.id }
            : { kind: 'stale_aborted' as const, uploadSessionId: terminal.id };
        };
        const loadCompleted = async () => {
          const [session] = await db
            .select({ id: audioUploadSessions.id, uploadStatus: audioUploadSessions.uploadStatus })
            .from(audioUploadSessions)
            .where(eq(audioUploadSessions.id, prepared.session.id))
            .limit(1);
          if (session?.uploadStatus === 'expired') {
            return { kind: 'expired' as const, uploadSessionId: session.id };
          }
          if (session?.uploadStatus === 'aborted') {
            return { kind: 'stale_aborted' as const, uploadSessionId: session.id };
          }
          return null;
        };
        const outcome = prepared.kind === 'assembly_cleanup'
          ? await runAssemblyCleanupRecovery({ operation: prepared.operation, loadCompleted, applyDomain })
          : await runCleanupProviderOperation({ operation: prepared.operation, loadCompleted, applyDomain });
        if (outcome.kind === 'expired') expiredSessionIds.push(outcome.uploadSessionId);
        if (outcome.kind === 'stale_aborted') staleAbortedSessionIds.push(outcome.uploadSessionId);
      } catch (error) {
        failures.push({
          uploadSessionId: prepared.session.id,
          error: error instanceof Error ? error.message : 'Object-store upload discard failed.'
        });
      }
    }

    return {
      examinedCount: candidates.length,
      expiredCount: expiredSessionIds.length,
      staleAbortedCount: staleAbortedSessionIds.length,
      failedCount: failures.length,
      expiredSessionIds,
      staleAbortedSessionIds,
      failures
    };
  }

  async function abortCollaboratorRevisionUploadSessions(input: {
    actorUserId: string;
    grantId?: string;
    connectionId?: string;
    cleanupReason: 'candidate_grant_revoked' | 'candidate_connection_revoked';
  }) {
    if (Boolean(input.grantId) === Boolean(input.connectionId)) {
      throw new Error('Exactly one candidate cleanup scope is required.');
    }
    await db.transaction((tx) => reserveCollaboratorRevisionAuthorityCleanupIntent(tx, input));
    const candidates = await db
      .select({ id: audioUploadSessions.id })
      .from(audioUploadSessions)
      .innerJoin(
        audioFileAccessGrants,
        eq(audioFileAccessGrants.id, audioUploadSessions.collaboratorFileGrantId)
      )
      .where(and(
        eq(audioUploadSessions.uploadPurpose, 'collaborator_revision'),
        inArray(audioUploadSessions.uploadStatus, [...EXPIRABLE_AUDIO_UPLOAD_STATUSES]),
        input.grantId
          ? eq(audioFileAccessGrants.id, input.grantId)
          : eq(audioFileAccessGrants.connectionId, input.connectionId!)
      ))
      .orderBy(asc(audioUploadSessions.createdAt), asc(audioUploadSessions.id));

    const sessionlessCandidates = await db
      .select({ id: audioProviderOperations.id })
      .from(audioProviderOperations)
      .where(and(
        eq(audioProviderOperations.operationType, 'initiate_multipart'),
        isNull(audioProviderOperations.uploadSessionId),
        inArray(audioProviderOperations.status, ['pending', 'leased', 'reconcile_required', 'awaiting_client_retry']),
        sql`${audioProviderOperations.requestPayload}->>'purpose' = 'collaborator_revision'`,
        input.grantId
          ? sql`${audioProviderOperations.requestPayload}->>'collaboratorFileGrantId' = ${input.grantId}`
          : sql`exists (
              select 1
              from audio_file_access_grants cleanup_scope
              where cleanup_scope.id::text = ${audioProviderOperations.requestPayload}->>'collaboratorFileGrantId'
                and cleanup_scope.connection_id = ${input.connectionId}::uuid
            )`
      ))
      .orderBy(asc(audioProviderOperations.createdAt), asc(audioProviderOperations.id));

    const abortedSessionIds: string[] = [];
    const pendingReceiptSessionIds: string[] = [];
    const canceledSessionlessOperationIds: string[] = [];
    const pendingReceiptOperationIds: string[] = [];
    const failures: Array<{ uploadSessionId: string; error: string }> = [];
    for (const candidate of candidates) {
      const prepared = await db.transaction(async (tx) => {
        const [session] = await tx
          .select()
          .from(audioUploadSessions)
          .where(and(
            eq(audioUploadSessions.id, candidate.id),
            eq(audioUploadSessions.uploadPurpose, 'collaborator_revision'),
            inArray(audioUploadSessions.uploadStatus, [...EXPIRABLE_AUDIO_UPLOAD_STATUSES])
          ))
          .for('update')
          .limit(1);
        if (!session || !session.collaboratorFileGrantId) return { kind: 'skipped' as const };

        const [grant] = await tx
          .select({ id: audioFileAccessGrants.id, connectionId: audioFileAccessGrants.connectionId })
          .from(audioFileAccessGrants)
          .where(eq(audioFileAccessGrants.id, session.collaboratorFileGrantId))
          .limit(1);
        if (!grant
          || (input.grantId && grant.id !== input.grantId)
          || (input.connectionId && grant.connectionId !== input.connectionId)) {
          return { kind: 'skipped' as const };
        }

        const cleanup = await prepareSessionCleanupProviderOperation(tx, session);
        if (cleanup.kind === 'deferred') {
          const message = `Provider operation ${cleanup.blockingOperation.id} still owns an active byte-mutation lease.`;
          const receipt = await recordPendingAudioObjectCleanup({
            projectId: session.projectId,
            actorUserId: input.actorUserId,
            uploadSessionId: session.id,
            identity: sessionObjectIdentity(session),
            cleanupReason: input.cleanupReason,
            lastError: message
          }, tx);
          await tx.insert(auditEvents).values({
            actorType: 'account',
            actorId: input.actorUserId,
            entityType: 'audio_upload_session',
            entityId: session.id,
            eventType: 'audio_candidate_revision.authority_cleanup_pending',
            previousStatus: session.uploadStatus,
            nextStatus: session.uploadStatus,
            metadata: {
              grantId: grant.id,
              connectionId: grant.connectionId,
              cleanupReason: input.cleanupReason,
              cleanupReceiptId: receipt.id,
              cleanupOperationId: cleanup.operation.id,
              blockingProviderOperationId: cleanup.blockingOperation.id,
              blockingProviderOperationType: cleanup.blockingOperation.operationType
            }
          });
          return { kind: 'deferred' as const, session, grant, receipt };
        }
        return { ...cleanup, session, grant };
      });
      if (prepared.kind === 'skipped') continue;
      if (prepared.kind === 'deferred') {
        pendingReceiptSessionIds.push(prepared.session.id);
        continue;
      }

      try {
        const applyDomain = async (tx: AudioProviderOperationTransaction) => {
          const [session] = await tx
            .select()
            .from(audioUploadSessions)
            .where(eq(audioUploadSessions.id, prepared.session.id))
            .for('update')
            .limit(1);
          if (!session || !session.collaboratorFileGrantId) {
            throw new Error('Candidate cleanup session disappeared before provider finalization.');
          }
          if (session.uploadStatus === 'aborted') {
            return { kind: 'aborted' as const, uploadSessionId: session.id };
          }
          if (!EXPIRABLE_AUDIO_UPLOAD_STATUSES.includes(session.uploadStatus as never)) {
            throw new Error(`Candidate cleanup session is ${session.uploadStatus} and cannot be aborted.`);
          }
          const [grant] = await tx
            .select({ id: audioFileAccessGrants.id, connectionId: audioFileAccessGrants.connectionId })
            .from(audioFileAccessGrants)
            .where(eq(audioFileAccessGrants.id, session.collaboratorFileGrantId))
            .limit(1);
          if (!grant
            || (input.grantId && grant.id !== input.grantId)
            || (input.connectionId && grant.connectionId !== input.connectionId)) {
            throw new Error('Candidate cleanup authority scope changed before provider finalization.');
          }
          const abortedAt = new Date();
          await tx
            .update(audioUploadSessions)
            .set({ uploadStatus: 'aborted', updatedAt: abortedAt })
            .where(eq(audioUploadSessions.id, session.id));
          await completePendingAudioObjectCleanupReceipt(tx, session, abortedAt);
          await tx.insert(auditEvents).values({
            actorType: 'account',
            actorId: input.actorUserId,
            entityType: 'audio_upload_session',
            entityId: session.id,
            eventType: 'audio_candidate_revision.authority_cleanup_completed',
            previousStatus: session.uploadStatus,
            nextStatus: 'aborted',
            metadata: {
              grantId: grant.id,
              connectionId: grant.connectionId,
              cleanupReason: input.cleanupReason,
              providerCleanupMethod: store.discardUpload ? 'discardUpload' : 'abortUpload'
            }
          });
          return { kind: 'aborted' as const, uploadSessionId: session.id };
        };
        const loadCompleted = async () => {
          const [session] = await db
            .select({ id: audioUploadSessions.id, uploadStatus: audioUploadSessions.uploadStatus })
            .from(audioUploadSessions)
            .where(eq(audioUploadSessions.id, prepared.session.id))
            .limit(1);
          return session?.uploadStatus === 'aborted'
            ? { kind: 'aborted' as const, uploadSessionId: session.id }
            : null;
        };
        const outcome = prepared.kind === 'assembly_cleanup'
          ? await runAssemblyCleanupRecovery({ operation: prepared.operation, loadCompleted, applyDomain })
          : await runCleanupProviderOperation({ operation: prepared.operation, loadCompleted, applyDomain });
        abortedSessionIds.push(outcome.uploadSessionId);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Candidate authority-revocation cleanup failed.';
        try {
          await db.transaction(async (tx) => {
            const [session] = await tx
              .select()
              .from(audioUploadSessions)
              .where(eq(audioUploadSessions.id, prepared.session.id))
              .for('update')
              .limit(1);
            if (!session || !session.collaboratorFileGrantId) {
              throw new Error('Candidate cleanup session disappeared before failure receipt recording.');
            }
            await recordPendingAudioObjectCleanup({
              projectId: session.projectId,
              actorUserId: input.actorUserId,
              uploadSessionId: session.id,
              identity: sessionObjectIdentity(session),
              cleanupReason: input.cleanupReason,
              lastError: message
            }, tx);
            await tx.insert(auditEvents).values({
              actorType: 'account',
              actorId: input.actorUserId,
              entityType: 'audio_upload_session',
              entityId: session.id,
              eventType: 'audio_candidate_revision.authority_cleanup_pending',
              previousStatus: session.uploadStatus,
              nextStatus: session.uploadStatus,
              metadata: {
                grantId: prepared.grant.id,
                connectionId: prepared.grant.connectionId,
                cleanupReason: input.cleanupReason,
                providerError: message
              }
            });
          });
          pendingReceiptSessionIds.push(prepared.session.id);
        } catch (receiptError) {
          failures.push({
            uploadSessionId: prepared.session.id,
            error: `Provider cleanup failed and durable receipt recording failed: ${receiptError instanceof Error ? receiptError.message : message}`
          });
        }
      }
    }

    for (const candidate of sessionlessCandidates) {
      const operation = await providerOperations.loadOperation(candidate.id);
      if (!operation) continue;
      try {
        const outcome = await cancelSessionlessInitiationAfterAuthorityLoss(operation);
        if (outcome === 'canceled') {
          canceledSessionlessOperationIds.push(operation.id);
        } else {
          pendingReceiptOperationIds.push(operation.id);
        }
      } catch (error) {
        pendingReceiptOperationIds.push(operation.id);
        failures.push({
          uploadSessionId: operation.plannedUploadSessionId,
          error: error instanceof Error
            ? `Sessionless provider cleanup pending: ${error.message}`
            : 'Sessionless provider cleanup remains unresolved.'
        });
      }
    }

    const inProgressCount = Math.max(
      0,
      candidates.length - abortedSessionIds.length - pendingReceiptSessionIds.length - failures.length
    );
    return {
      examinedCount: candidates.length + sessionlessCandidates.length,
      abortedCount: abortedSessionIds.length,
      sessionlessCleanupCount: canceledSessionlessOperationIds.length,
      pendingReceiptCount: pendingReceiptSessionIds.length + pendingReceiptOperationIds.length,
      inProgressCount,
      failedCount: failures.length,
      abortedSessionIds,
      pendingReceiptSessionIds,
      canceledSessionlessOperationIds,
      pendingReceiptOperationIds,
      failures
    };
  }

  async function completeAndSealCollaboratorRevision(input: {
    grantId: string;
    uploadSessionId: string;
    actorUserId: string;
  }) {
    if (!collaboratorRevisionUploadsEnabled) {
      throw Object.assign(new Error('Private candidate uploads are disabled.'), {
        status: 503,
        code: 'candidate_uploads_disabled'
      });
    }
    const [scope] = await db
      .select()
      .from(audioUploadSessions)
      .where(eq(audioUploadSessions.id, input.uploadSessionId))
      .limit(1);
    if (!scope
      || scope.uploadPurpose !== 'collaborator_revision'
      || scope.collaboratorFileGrantId !== input.grantId
      || scope.initiatedByUserId !== input.actorUserId
      || !scope.assetId
      || !scope.sourceAssetVersionId) {
      throw Object.assign(new Error('Exact collaborator revision upload session required.'), { status: 403 });
    }
    if (scope.uploadStatus === 'completed') {
      const [sealedReceipt] = await db
        .select()
        .from(audioCandidateRevisions)
        .where(and(
          eq(audioCandidateRevisions.uploadSessionId, scope.id),
          eq(audioCandidateRevisions.fileAccessGrantId, input.grantId),
          eq(audioCandidateRevisions.uploadedByUserId, input.actorUserId)
        ))
        .limit(1);
      if (sealedReceipt) return sealedReceipt;
      throw new Error('Completed private candidate upload is missing its sealed receipt.');
    }

    const prepared = await db.transaction(async (tx) => {
      await requireActiveCollaboratorRevisionGrant(tx, {
        grantId: input.grantId,
        projectId: scope.projectId,
        actorUserId: input.actorUserId,
        assetId: scope.assetId,
        sourceAssetVersionId: scope.sourceAssetVersionId
      });

      const [session] = await tx
        .select()
        .from(audioUploadSessions)
        .where(eq(audioUploadSessions.id, input.uploadSessionId))
        .for('update')
        .limit(1);
      if (!session || !session.assetId || !session.sourceAssetVersionId || !session.collaboratorFileGrantId) {
        throw new Error('Private candidate upload session is incomplete.');
      }
      if (session.expiresAt.getTime() <= Date.now()) throw new Error('Upload session expired.');

      if (session.uploadStatus === 'completed') {
        const [existing] = await tx
          .select()
          .from(audioCandidateRevisions)
          .where(and(
            eq(audioCandidateRevisions.uploadSessionId, session.id),
            eq(audioCandidateRevisions.fileAccessGrantId, input.grantId)
          ))
          .limit(1);
        if (existing) return { kind: 'sealed' as const, candidate: existing };
      }
      if (!['initiated', 'uploading', 'uploaded', 'verifying'].includes(session.uploadStatus)) {
        throw new Error(`Upload session is ${session.uploadStatus} and cannot be finalized.`);
      }
      const [cleanupIntent] = await tx
        .select({ id: audioProviderOperations.id })
        .from(audioProviderOperations)
        .where(and(
          eq(audioProviderOperations.uploadSessionId, session.id),
          inArray(audioProviderOperations.operationType, ['discard_upload', 'abort_upload'])
        ))
        .limit(1);
      if (cleanupIntent) {
        throw new AudioProviderOperationBusyError('Upload cleanup intent already owns this session.');
      }

      const parts = await tx
        .select()
        .from(audioUploadParts)
        .where(eq(audioUploadParts.uploadSessionId, session.id))
        .orderBy(asc(audioUploadParts.partNumber));
      if (!parts.length) throw new Error('No upload parts found.');
      const expectedPartCount = Math.ceil(session.expectedByteSize / session.partSizeBytes);
      if (parts.length !== expectedPartCount) throw new Error('Every declared upload part is required before finalization.');
      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        if (part.partNumber !== index + 1) throw new Error('Upload parts must be contiguous starting at 1.');
        const expectedPartBytes = part.partNumber === expectedPartCount
          ? session.expectedByteSize - (expectedPartCount - 1) * session.partSizeBytes
          : session.partSizeBytes;
        if (part.byteSize !== expectedPartBytes) {
          throw new Error(`Upload part ${part.partNumber} does not match the declared upload geometry.`);
        }
      }

      if (session.uploadStatus === 'initiated') {
        await tx
          .update(audioUploadSessions)
          .set({ uploadStatus: 'uploading', updatedAt: new Date() })
          .where(eq(audioUploadSessions.id, session.id));
      }
      if (session.uploadStatus === 'initiated' || session.uploadStatus === 'uploading') {
        await tx
          .update(audioUploadSessions)
          .set({ uploadStatus: 'uploaded', updatedAt: new Date() })
          .where(eq(audioUploadSessions.id, session.id));
      }
      if (session.uploadStatus !== 'verifying') {
        await tx
          .update(audioUploadSessions)
          .set({ uploadStatus: 'verifying', updatedAt: new Date() })
          .where(eq(audioUploadSessions.id, session.id));
      }
      const [project] = await tx
        .select({ performerId: audioProjects.performerId })
        .from(audioProjects)
        .where(eq(audioProjects.id, session.projectId))
        .limit(1);
      if (!project) throw new Error('Candidate audio project not found.');
      const partsFingerprint = fingerprintAudioProviderValue(parts.map((part) => ({
        partNumber: part.partNumber,
        byteSize: part.byteSize,
        etag: part.providerEtag,
        checksum: part.providerChecksum
      })));
      const reservation = await providerOperations.reserveOperation(tx, {
        projectId: session.projectId,
        performerId: project.performerId,
        requestedByUserId: input.actorUserId,
        uploadSessionId: session.id,
        plannedUploadSessionId: session.id,
        operationType: 'complete_multipart',
        identity: sessionObjectIdentity(session),
        requestPayload: {
          action: 'complete_multipart',
          collaboratorFileGrantId: input.grantId,
          uploadSessionId: session.id,
          expectedByteSize: session.expectedByteSize,
          expectedSha256: session.expectedSha256,
          partsFingerprint
        }
      });
      return { kind: 'operation' as const, operation: reservation.operation, session, parts, partsFingerprint };
    });
    if (prepared.kind === 'sealed') return prepared.candidate;
    const objectIdentity = sessionObjectIdentity(prepared.session);
    return runAssemblyProviderOperation({
      operation: prepared.operation,
      parts: prepared.parts.map((part) => ({ partNumber: part.partNumber, etag: part.providerEtag })),
      expectedByteSize: prepared.session.expectedByteSize,
      expectedSha256: prepared.session.expectedSha256,
      mimeType: prepared.session.expectedMimeType,
      loadCompleted: async () => (await db
        .select()
        .from(audioCandidateRevisions)
        .where(and(
          eq(audioCandidateRevisions.uploadSessionId, input.uploadSessionId),
          eq(audioCandidateRevisions.fileAccessGrantId, input.grantId)
        ))
        .limit(1))[0] ?? null,
      validate: (assembled) => validatePlayableAudioOriginal({
        mimeType: prepared.session.expectedMimeType,
        byteSize: assembled.byteSize,
        storageProvider: prepared.session.storageProvider,
        storageBucket: prepared.session.storageBucket,
        storageKey: prepared.session.storageKey
      }),
      applyDomain: async (tx, assembled, technicalValidation, operation) => {
        await requireActiveCollaboratorRevisionGrant(tx, {
          grantId: input.grantId,
          projectId: scope.projectId,
          actorUserId: input.actorUserId,
          assetId: scope.assetId!,
          sourceAssetVersionId: scope.sourceAssetVersionId!
        });
        const [session] = await tx
          .select()
          .from(audioUploadSessions)
          .where(eq(audioUploadSessions.id, input.uploadSessionId))
          .for('update')
          .limit(1);
        if (!session || !session.assetId || !session.sourceAssetVersionId || !session.collaboratorFileGrantId) {
          throw new Error('Private candidate upload session is incomplete.');
        }
        const [existing] = await tx
          .select()
          .from(audioCandidateRevisions)
          .where(eq(audioCandidateRevisions.uploadSessionId, session.id))
          .limit(1);
        if (existing) return existing;
        if (session.uploadStatus !== 'verifying') {
          throw new Error(`Upload session is ${session.uploadStatus} and cannot be finalized.`);
        }
        const currentParts = await tx
          .select()
          .from(audioUploadParts)
          .where(eq(audioUploadParts.uploadSessionId, session.id))
          .orderBy(asc(audioUploadParts.partNumber));
        const currentFingerprint = fingerprintAudioProviderValue(currentParts.map((part) => ({
          partNumber: part.partNumber,
          byteSize: part.byteSize,
          etag: part.providerEtag,
          checksum: part.providerChecksum
        })));
        if (currentFingerprint !== operation.requestPayload.partsFingerprint) {
          throw new Error('Upload parts changed after assembly intent was reserved.');
        }
        const [project] = await tx
          .select({ performerId: audioProjects.performerId })
          .from(audioProjects)
          .where(eq(audioProjects.id, session.projectId))
          .limit(1);
        if (!project) throw new Error('Candidate audio project not found.');
        const verifiedAt = new Date();
        await tx
          .update(audioUploadSessions)
          .set({ uploadStatus: 'completed', completedAt: verifiedAt, updatedAt: verifiedAt })
          .where(eq(audioUploadSessions.id, session.id));
        const [candidate] = await tx.insert(audioCandidateRevisions).values({
          projectId: session.projectId,
          performerId: project.performerId,
          assetId: session.assetId,
          sourceAssetVersionId: session.sourceAssetVersionId,
          fileAccessGrantId: session.collaboratorFileGrantId,
          uploadedByUserId: input.actorUserId,
          uploadSessionId: session.id,
          originalFilename: session.originalFilename,
          storageProvider: session.storageProvider,
          storageBucket: session.storageBucket,
          storageKey: session.storageKey,
          mimeType: session.expectedMimeType,
          byteSize: assembled.byteSize,
          sha256: assembled.sha256,
          durationMs: technicalValidation.durationMs,
          codec: technicalValidation.codec,
          sampleRateHz: technicalValidation.sampleRateHz,
          bitDepth: technicalValidation.bitDepth,
          channelCount: technicalValidation.channelCount,
          integrityStatus: 'verified',
          integrityVerifierKey: `sway.${store.provider}.sha256+playable-audio`,
          integrityVerifiedAt: verifiedAt,
          integrityEvidence: {
            expectedSha256: session.expectedSha256,
            assembledSha256: assembled.sha256,
            expectedByteSize: session.expectedByteSize,
            assembledByteSize: assembled.byteSize,
            partCount: currentParts.length,
            requestFingerprint: session.requestFingerprint,
            technicalValidation
          },
          intakeStatus: 'private_review',
          originalPreserved: true,
          sealedAt: verifiedAt
        }).returning();
        await tx.insert(auditEvents).values({
          actorType: 'account',
          actorId: input.actorUserId,
          entityType: 'audio_candidate_revision',
          entityId: candidate.id,
          eventType: 'audio_candidate_revision.sealed_private',
          previousStatus: 'verifying',
          nextStatus: 'private_review',
          metadata: {
            grantId: input.grantId,
            sourceAssetVersionId: session.sourceAssetVersionId,
            uploadSessionId: session.id,
            requestFingerprint: session.requestFingerprint,
            sha256: candidate.sha256,
            byteSize: candidate.byteSize
          }
        });
        return candidate;
      },
      applyCanceled: async (tx, error) => {
        const [session] = await tx
          .select()
          .from(audioUploadSessions)
          .where(eq(audioUploadSessions.id, input.uploadSessionId))
          .for('update')
          .limit(1);
        if (!session) throw new Error('Private candidate upload session not found during cleanup finalization.');
        await tx
          .update(audioUploadSessions)
          .set({ uploadStatus: 'rejected', updatedAt: new Date() })
          .where(eq(audioUploadSessions.id, session.id));
        await tx.insert(auditEvents).values({
          actorType: 'account',
          actorId: input.actorUserId,
          entityType: 'audio_upload_session',
          entityId: session.id,
          eventType: 'audio_candidate_revision.technical_validation_failed',
          previousStatus: session.uploadStatus,
          nextStatus: 'rejected',
          metadata: {
            grantId: input.grantId,
            sourceAssetVersionId: session.sourceAssetVersionId,
            expectedByteSize: session.expectedByteSize,
            expectedSha256: session.expectedSha256,
            validationError: error.message,
            providerCleanupMethod: store.discardUpload ? 'discardUpload' : 'abortUpload',
            providerDiscardSucceeded: true,
            providerDiscardError: null
          }
        });
      },
      applyCleanupPending: async (validationError, cleanupError) => {
        console.error('[sway.audio] candidate validation cleanup could not discard provider upload:', {
          uploadSessionId: input.uploadSessionId,
          providerDiscardError: cleanupError
        });
        await db.transaction(async (tx) => {
          const [session] = await tx
            .select()
            .from(audioUploadSessions)
            .where(eq(audioUploadSessions.id, input.uploadSessionId))
            .for('update')
            .limit(1);
          if (!session) throw new Error('Private candidate upload session not found during cleanup recording.');
          await recordPendingAudioObjectCleanup({
            projectId: session.projectId,
            actorUserId: input.actorUserId,
            uploadSessionId: session.id,
            identity: objectIdentity,
            cleanupReason: 'candidate_technical_validation_failed',
            lastError: cleanupError
          }, tx);
          if (session.uploadStatus === 'verifying') {
            await tx
              .update(audioUploadSessions)
              .set({ uploadStatus: 'quarantined', updatedAt: new Date() })
              .where(eq(audioUploadSessions.id, session.id));
          }
          await tx.insert(auditEvents).values({
            actorType: 'account',
            actorId: input.actorUserId,
            entityType: 'audio_upload_session',
            entityId: session.id,
            eventType: 'audio_candidate_revision.technical_validation_failed',
            previousStatus: session.uploadStatus,
            nextStatus: 'quarantined',
            metadata: {
              grantId: input.grantId,
              sourceAssetVersionId: session.sourceAssetVersionId,
              expectedByteSize: session.expectedByteSize,
              expectedSha256: session.expectedSha256,
              validationError: validationError.message,
              providerCleanupMethod: store.discardUpload ? 'discardUpload' : 'abortUpload',
              providerDiscardSucceeded: false,
              providerDiscardError: cleanupError
            }
          });
        });
      }
    });
  }

  async function completeAndSealUpload(input: {
    uploadSessionId: string;
    actorUserId: string;
    performerId: string;
  }) {
    const [accessSession] = await db
      .select()
      .from(audioUploadSessions)
      .where(eq(audioUploadSessions.id, input.uploadSessionId))
      .limit(1);
    if (!accessSession) throw new Error('Upload session not found.');
    if (accessSession.uploadPurpose !== 'owner_asset' || accessSession.initiatedByUserId !== input.actorUserId) {
      throw Object.assign(new Error('Owner upload session required.'), { status: 403 });
    }

    const access = await requireProjectAccess({
      projectId: accessSession.projectId,
      userId: input.actorUserId,
      needUpload: true
    });
    if (!access) throw new Error('Upload permission required.');

    const prepared = await db.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(audioUploadSessions)
        .where(eq(audioUploadSessions.id, input.uploadSessionId))
        .for('update')
        .limit(1);
      if (!session) throw new Error('Upload session not found.');
      if (!session.assetId) throw new Error('Upload session is missing an asset.');

      if (session.uploadStatus === 'completed') {
        const [existing] = await tx
          .select()
          .from(audioProjectAssetVersions)
          .where(eq(audioProjectAssetVersions.uploadSessionId, session.id))
          .limit(1);
        if (existing) return { kind: 'sealed' as const, version: existing };
      }
      if (!['initiated', 'uploading', 'uploaded', 'verifying'].includes(session.uploadStatus)) {
        throw new Error(`Upload session is ${session.uploadStatus} and cannot be sealed.`);
      }
      const [cleanupIntent] = await tx
        .select({ id: audioProviderOperations.id })
        .from(audioProviderOperations)
        .where(and(
          eq(audioProviderOperations.uploadSessionId, session.id),
          inArray(audioProviderOperations.operationType, ['discard_upload', 'abort_upload'])
        ))
        .limit(1);
      if (cleanupIntent) {
        throw new AudioProviderOperationBusyError('Upload cleanup intent already owns this session.');
      }

      const parts = await tx
        .select()
        .from(audioUploadParts)
        .where(eq(audioUploadParts.uploadSessionId, session.id))
        .orderBy(asc(audioUploadParts.partNumber));

      if (!parts.length) throw new Error('No upload parts found.');
      for (let i = 0; i < parts.length; i += 1) {
        if (parts[i].partNumber !== i + 1) throw new Error('Upload parts must be contiguous starting at 1.');
        if (parts[i].byteSize > session.partSizeBytes) throw new Error(`Upload part ${parts[i].partNumber} exceeds the declared part size.`);
        if (i < parts.length - 1 && parts[i].byteSize < DEFAULT_PART_SIZE) {
          throw new Error(`Upload part ${parts[i].partNumber} is below the provider minimum of 5 MiB.`);
        }
      }

      if (session.uploadStatus === 'initiated') {
        await tx
          .update(audioUploadSessions)
          .set({ uploadStatus: 'uploading', updatedAt: new Date() })
          .where(eq(audioUploadSessions.id, session.id));
      }
      if (session.uploadStatus === 'initiated' || session.uploadStatus === 'uploading') {
        await tx
          .update(audioUploadSessions)
          .set({ uploadStatus: 'uploaded', updatedAt: new Date() })
          .where(eq(audioUploadSessions.id, session.id));
      }

      if (session.uploadStatus !== 'verifying') {
        await tx
          .update(audioUploadSessions)
          .set({ uploadStatus: 'verifying', updatedAt: new Date() })
          .where(eq(audioUploadSessions.id, session.id));
      }
      const [project] = await tx
        .select({ performerId: audioProjects.performerId })
        .from(audioProjects)
        .where(eq(audioProjects.id, session.projectId))
        .limit(1);
      if (!project || project.performerId !== input.performerId) {
        throw Object.assign(new Error('Exact project performer required.'), { status: 403 });
      }
      const partsFingerprint = fingerprintAudioProviderValue(parts.map((part) => ({
        partNumber: part.partNumber,
        byteSize: part.byteSize,
        etag: part.providerEtag,
        checksum: part.providerChecksum
      })));
      const reservation = await providerOperations.reserveOperation(tx, {
        projectId: session.projectId,
        performerId: project.performerId,
        requestedByUserId: input.actorUserId,
        uploadSessionId: session.id,
        plannedUploadSessionId: session.id,
        operationType: 'complete_multipart',
        identity: sessionObjectIdentity(session),
        requestPayload: {
          action: 'complete_multipart',
          uploadSessionId: session.id,
          expectedByteSize: session.expectedByteSize,
          expectedSha256: session.expectedSha256,
          partsFingerprint
        }
      });
      return { kind: 'operation' as const, operation: reservation.operation, session, parts, partsFingerprint };
    });
    if (prepared.kind === 'sealed') return prepared.version;
    const objectIdentity = sessionObjectIdentity(prepared.session);
    return runAssemblyProviderOperation({
      operation: prepared.operation,
      parts: prepared.parts.map((part) => ({ partNumber: part.partNumber, etag: part.providerEtag })),
      expectedByteSize: prepared.session.expectedByteSize,
      expectedSha256: prepared.session.expectedSha256,
      mimeType: prepared.session.expectedMimeType,
      loadCompleted: async () => (await db
        .select()
        .from(audioProjectAssetVersions)
        .where(eq(audioProjectAssetVersions.uploadSessionId, input.uploadSessionId))
        .limit(1))[0] ?? null,
      applyDomain: async (tx, assembled, _validation, operation) => {
        const [session] = await tx
          .select()
          .from(audioUploadSessions)
          .where(eq(audioUploadSessions.id, input.uploadSessionId))
          .for('update')
          .limit(1);
        if (!session || !session.assetId
          || session.uploadPurpose !== 'owner_asset'
          || session.initiatedByUserId !== input.actorUserId) {
          throw Object.assign(new Error('Exact owner upload session required.'), { status: 403 });
        }
        const [existing] = await tx
          .select()
          .from(audioProjectAssetVersions)
          .where(eq(audioProjectAssetVersions.uploadSessionId, session.id))
          .limit(1);
        if (existing) return existing;
        if (session.uploadStatus !== 'verifying') {
          throw new Error(`Upload session is ${session.uploadStatus} and cannot be sealed.`);
        }
        const [currentAccess] = await tx
          .select()
          .from(audioProjectAccessGrants)
          .where(and(
            eq(audioProjectAccessGrants.projectId, session.projectId),
            eq(audioProjectAccessGrants.granteeUserId, input.actorUserId),
            eq(audioProjectAccessGrants.canUploadVersions, true),
            isNull(audioProjectAccessGrants.revokedAt),
            or(isNull(audioProjectAccessGrants.expiresAt), gt(audioProjectAccessGrants.expiresAt, new Date()))
          ))
          .limit(1);
        if (!currentAccess) throw new Error('Upload permission required.');
        const currentParts = await tx
          .select()
          .from(audioUploadParts)
          .where(eq(audioUploadParts.uploadSessionId, session.id))
          .orderBy(asc(audioUploadParts.partNumber));
        const currentFingerprint = fingerprintAudioProviderValue(currentParts.map((part) => ({
          partNumber: part.partNumber,
          byteSize: part.byteSize,
          etag: part.providerEtag,
          checksum: part.providerChecksum
        })));
        if (currentFingerprint !== operation.requestPayload.partsFingerprint) {
          throw new Error('Upload parts changed after assembly intent was reserved.');
        }
        const [project] = await tx
          .select({ performerId: audioProjects.performerId })
          .from(audioProjects)
          .where(eq(audioProjects.id, session.projectId))
          .limit(1);
        if (!project || project.performerId !== input.performerId) {
          throw Object.assign(new Error('Exact project performer required.'), { status: 403 });
        }
        const [{ nextVersion }] = await tx
          .select({
            nextVersion: sql<number>`coalesce(max(${audioProjectAssetVersions.versionNumber}), 0) + 1`
          })
          .from(audioProjectAssetVersions)
          .where(eq(audioProjectAssetVersions.assetId, session.assetId));
        const verifiedAt = new Date();
        await tx
          .update(audioUploadSessions)
          .set({ uploadStatus: 'completed', completedAt: verifiedAt, updatedAt: verifiedAt })
          .where(eq(audioUploadSessions.id, session.id));
        await tx.insert(audioProjectAssetVersions).values({
          projectId: session.projectId,
          performerId: project.performerId,
          assetId: session.assetId,
          uploadedByUserId: input.actorUserId,
          uploadSessionId: session.id,
          versionNumber: nextVersion,
          originalFilename: session.originalFilename,
          storageProvider: session.storageProvider,
          storageBucket: session.storageBucket,
          storageKey: session.storageKey,
          mimeType: session.expectedMimeType,
          byteSize: assembled.byteSize,
          sha256: assembled.sha256,
          integrityStatus: 'verified',
          integrityVerifierKey: `sway.${store.provider}.sha256`,
          integrityVerifiedAt: verifiedAt,
          integrityEvidence: {
            expectedSha256: session.expectedSha256,
            assembledSha256: assembled.sha256,
            expectedByteSize: session.expectedByteSize,
            assembledByteSize: assembled.byteSize,
            partCount: currentParts.length,
            verifier: `sway.${store.provider}.sha256`
          },
          originalPreserved: true,
          sealedAt: verifiedAt
        });
        const [version] = await tx
          .select()
          .from(audioProjectAssetVersions)
          .where(eq(audioProjectAssetVersions.uploadSessionId, session.id))
          .limit(1);
        if (!version) throw new Error('Sealed audio asset version was not persisted.');
        await tx.insert(auditEvents).values({
          actorType: 'performer',
          actorId: input.actorUserId,
          entityType: 'audio_project_asset_version',
          entityId: version.id,
          eventType: 'audio_asset_version.seal',
          previousStatus: 'verifying',
          nextStatus: 'verified',
          metadata: {
            sha256: version.sha256,
            byteSize: version.byteSize,
            uploadSessionId: session.id
          }
        });
        return version;
      },
      applyCanceled: async (tx, error) => {
        const [session] = await tx
          .select()
          .from(audioUploadSessions)
          .where(eq(audioUploadSessions.id, input.uploadSessionId))
          .for('update')
          .limit(1);
        if (!session) throw new Error('Owner upload session not found during cleanup finalization.');
        await tx
          .update(audioUploadSessions)
          .set({ uploadStatus: 'rejected', updatedAt: new Date() })
          .where(eq(audioUploadSessions.id, session.id));
        await tx.insert(auditEvents).values({
          actorType: 'performer',
          actorId: input.actorUserId,
          entityType: 'audio_upload_session',
          entityId: session.id,
          eventType: 'audio_upload_session.integrity_failed',
          previousStatus: session.uploadStatus,
          nextStatus: 'rejected',
          metadata: {
            expectedByteSize: session.expectedByteSize,
            expectedSha256: session.expectedSha256,
            integrityError: error.message,
            providerCleanupMethod: store.discardUpload ? 'discardUpload' : 'abortUpload',
            providerDiscardSucceeded: true,
            providerDiscardError: null
          }
        });
      },
      applyCleanupPending: async (validationError, cleanupError) => {
        console.error('[sway.audio] owner integrity cleanup could not discard provider upload:', {
          uploadSessionId: input.uploadSessionId,
          providerDiscardError: cleanupError
        });
        await db.transaction(async (tx) => {
          const [session] = await tx
            .select()
            .from(audioUploadSessions)
            .where(eq(audioUploadSessions.id, input.uploadSessionId))
            .for('update')
            .limit(1);
          if (!session) throw new Error('Owner upload session not found during cleanup recording.');
          await recordPendingAudioObjectCleanup({
            projectId: session.projectId,
            actorUserId: input.actorUserId,
            uploadSessionId: session.id,
            identity: objectIdentity,
            cleanupReason: 'owner_integrity_validation_failed',
            lastError: cleanupError
          }, tx);
          if (session.uploadStatus === 'verifying') {
            await tx
              .update(audioUploadSessions)
              .set({ uploadStatus: 'quarantined', updatedAt: new Date() })
              .where(eq(audioUploadSessions.id, session.id));
          }
          await tx.insert(auditEvents).values({
            actorType: 'performer',
            actorId: input.actorUserId,
            entityType: 'audio_upload_session',
            entityId: session.id,
            eventType: 'audio_upload_session.integrity_failed',
            previousStatus: session.uploadStatus,
            nextStatus: 'quarantined',
            metadata: {
              expectedByteSize: session.expectedByteSize,
              expectedSha256: session.expectedSha256,
              integrityError: validationError.message,
              providerCleanupMethod: store.discardUpload ? 'discardUpload' : 'abortUpload',
              providerDiscardSucceeded: false,
              providerDiscardError: cleanupError
            }
          });
        });
      }
    });
  }

  async function createShareGrant(input: {
    versionId: string;
    actorUserId: string;
    maxUses?: number | null;
    recipientLabel?: string | null;
  }) {
    const [version] = await db
      .select()
      .from(audioProjectAssetVersions)
      .where(eq(audioProjectAssetVersions.id, input.versionId))
      .limit(1);
    if (!version) throw new Error('Asset version not found.');

    const access = await requireProjectAccess({
      projectId: version.projectId,
      userId: input.actorUserId,
      needDownload: true
    });
    if (!access) throw new Error('Share permission requires download access.');

    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = sha256Hex(rawToken);
    const [grant] = await db.insert(audioShareGrants).values({
      projectId: version.projectId,
      assetVersionId: version.id,
      createdByUserId: input.actorUserId,
      tokenHash,
      recipientLabel: input.recipientLabel ?? null,
      permissions: {
        view: true,
        downloadOriginal: true,
        uploadVersion: false,
        approve: false
      },
      maxUses: input.maxUses ?? 5,
      useCount: 0,
      expiresAt: new Date(Date.now() + SHARE_TTL_MS)
    }).returning();

    await writeAudit(db, {
      actorId: input.actorUserId,
      entityType: 'audio_share_grant',
      entityId: grant.id,
      eventType: 'audio_share_grant.create',
      metadata: { versionId: version.id, maxUses: grant.maxUses }
    });

    return { grant, rawToken };
  }

  async function downloadSharedOriginal(input: {
    rawToken: string;
    actorUserId: string;
  }) {
    const tokenHash = sha256Hex(input.rawToken.trim());
    const [grant] = await db
      .select()
      .from(audioShareGrants)
      .where(eq(audioShareGrants.tokenHash, tokenHash))
      .limit(1);
    if (!grant || !grant.assetVersionId) throw new Error('Share grant not found.');
    if (grant.revokedAt) throw new Error('Share grant was revoked.');
    if (grant.expiresAt && grant.expiresAt.getTime() <= Date.now()) throw new Error('Share grant expired.');
    if (grant.maxUses != null && grant.useCount >= grant.maxUses) throw new Error('Share grant exhausted.');
    if (!grant.permissions.downloadOriginal) throw new Error('Share grant does not allow original download.');

    const [version] = await db
      .select()
      .from(audioProjectAssetVersions)
      .where(eq(audioProjectAssetVersions.id, grant.assetVersionId))
      .limit(1);
    if (!version) throw new Error('Shared asset version not found.');

    const object = await store.openOriginal({
      storageProvider: parseAudioStorageProvider(version.storageProvider),
      storageBucket: version.storageBucket,
      storageKey: version.storageKey
    });

    try {
      await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(audioShareGrants)
          .set({ useCount: grant.useCount + 1 })
          .where(and(
            eq(audioShareGrants.id, grant.id),
            eq(audioShareGrants.assetVersionId, version.id),
            eq(audioShareGrants.useCount, grant.useCount),
            isNull(audioShareGrants.revokedAt),
            or(
              isNull(audioShareGrants.expiresAt),
              gt(audioShareGrants.expiresAt, new Date())
            ),
            or(
              isNull(audioShareGrants.maxUses),
              sql`${audioShareGrants.useCount} < ${audioShareGrants.maxUses}`
            )
          ))
          .returning();
        if (!updated) throw new Error('Share grant could not be consumed.');

        await tx.insert(auditEvents).values({
          actorType: 'performer',
          actorId: input.actorUserId,
          entityType: 'audio_share_grant',
          entityId: grant.id,
          eventType: 'audio_share_grant.download',
          previousStatus: null,
          nextStatus: null,
          metadata: { versionId: version.id, sha256: version.sha256 }
        });
      });
    } catch (error) {
      object.stream.destroy();
      throw error;
    }

    return { version, ...object };
  }

  async function openOwnedVersion(input: { versionId: string; actorUserId: string }) {
    const [version] = await db
      .select()
      .from(audioProjectAssetVersions)
      .where(eq(audioProjectAssetVersions.id, input.versionId))
      .limit(1);
    if (!version) throw new Error('Catalog audio not found.');

    const access = await requireProjectAccess({
      projectId: version.projectId,
      userId: input.actorUserId,
      needDownload: true
    });
    if (!access) throw new Error('Catalog audio access denied.');

    const object = await store.openOriginal({
      storageProvider: parseAudioStorageProvider(version.storageProvider),
      storageBucket: version.storageBucket,
      storageKey: version.storageKey
    });
    return { version, ...object };
  }

  async function listReleaseWorkspace(
    input: { performerId: string; actorUserId: string },
    executor: Pick<SwayDb, 'select'> = db
  ) {
    const releases = await executor
      .select({
        id: musicReleases.id,
        projectId: musicReleases.projectId,
        title: musicReleases.title,
        primaryArtistName: musicReleases.primaryArtistName,
        releaseType: musicReleases.releaseType,
        distributionMode: musicReleases.distributionMode,
        status: musicReleases.status,
        artworkAssetVersionId: musicReleases.artworkAssetVersionId,
        upc: musicReleases.upc,
        labelName: musicReleases.labelName,
        pLine: musicReleases.pLine,
        cLine: musicReleases.cLine,
        originalReleaseDate: musicReleases.originalReleaseDate,
        scheduledReleaseAt: musicReleases.scheduledReleaseAt,
        territories: musicReleases.territories,
        createdAt: musicReleases.createdAt,
        updatedAt: musicReleases.updatedAt
      })
      .from(musicReleases)
      .where(eq(musicReleases.performerId, input.performerId))
      .orderBy(desc(musicReleases.updatedAt));

    const recordings = await executor
      .select({
        releaseId: musicReleaseRecordings.releaseId,
        recordingId: musicRecordings.id,
        masterAssetVersionId: musicRecordings.masterAssetVersionId,
        title: musicRecordings.title,
        versionTitle: musicRecordings.versionTitle,
        primaryArtistName: musicRecordings.primaryArtistName,
        isrc: musicRecordings.isrc,
        isExplicit: musicRecordings.isExplicit,
        languageCode: musicRecordings.languageCode,
        originalReleaseDate: musicRecordings.originalReleaseDate,
        rightsStatus: musicRecordings.rightsStatus,
        discNumber: musicReleaseRecordings.discNumber,
        trackNumber: musicReleaseRecordings.trackNumber
      })
      .from(musicReleaseRecordings)
      .innerJoin(musicRecordings, eq(musicRecordings.id, musicReleaseRecordings.recordingId))
      .innerJoin(musicReleases, eq(musicReleases.id, musicReleaseRecordings.releaseId))
      .where(eq(musicReleases.performerId, input.performerId))
      .orderBy(asc(musicReleaseRecordings.discNumber), asc(musicReleaseRecordings.trackNumber));

    const credits = await executor
      .select({
        id: musicRecordingCredits.id,
        recordingId: musicRecordingCredits.recordingId,
        displayName: musicRecordingCredits.displayName,
        role: musicRecordingCredits.role,
        sequence: musicRecordingCredits.sequence
      })
      .from(musicRecordingCredits)
      .innerJoin(musicRecordings, eq(musicRecordings.id, musicRecordingCredits.recordingId))
      .where(eq(musicRecordings.performerId, input.performerId))
      .orderBy(asc(musicRecordingCredits.sequence));

    const declarations = await executor
      .select({
        id: musicRightsDeclarations.id,
        releaseId: musicRightsDeclarations.releaseId,
        recordingId: musicRightsDeclarations.recordingId,
        declarationType: musicRightsDeclarations.declarationType,
        declarationText: musicRightsDeclarations.declarationText,
        termsDocumentAssetVersionId: musicRightsDeclarations.termsDocumentAssetVersionId,
        termsVersion: musicRightsDeclarations.termsVersion,
        termsHash: musicRightsDeclarations.termsHash,
        declaredAt: musicRightsDeclarations.declaredAt
      })
      .from(musicRightsDeclarations)
      .innerJoin(musicReleases, eq(musicReleases.id, musicRightsDeclarations.releaseId))
      .where(eq(musicReleases.performerId, input.performerId))
      .orderBy(desc(musicRightsDeclarations.declaredAt));

    const declarationEvents = await executor
      .select({
        declarationId: musicRightsDeclarationEvents.declarationId,
        eventType: musicRightsDeclarationEvents.eventType,
        reason: musicRightsDeclarationEvents.reason,
        createdAt: musicRightsDeclarationEvents.createdAt
      })
      .from(musicRightsDeclarationEvents)
      .innerJoin(musicRightsDeclarations, eq(musicRightsDeclarations.id, musicRightsDeclarationEvents.declarationId))
      .innerJoin(musicReleases, eq(musicReleases.id, musicRightsDeclarations.releaseId))
      .where(eq(musicReleases.performerId, input.performerId))
      .orderBy(asc(musicRightsDeclarationEvents.createdAt));

    const masterRows = await executor
      .select({
        versionId: audioProjectAssetVersions.id,
        assetId: audioProjectAssetVersions.assetId,
        projectId: audioProjectAssetVersions.projectId,
        projectTitle: audioProjects.title,
        title: audioAssets.title,
        originalFilename: audioProjectAssetVersions.originalFilename,
        mimeType: audioProjectAssetVersions.mimeType,
        assetKind: audioAssets.assetKind,
        versionNumber: audioProjectAssetVersions.versionNumber,
        sha256: audioProjectAssetVersions.sha256,
        sealedAt: audioProjectAssetVersions.sealedAt
      })
      .from(audioProjectAssetVersions)
      .innerJoin(audioAssets, eq(audioAssets.id, audioProjectAssetVersions.assetId))
      .innerJoin(audioProjects, eq(audioProjects.id, audioProjectAssetVersions.projectId))
      .innerJoin(audioProjectAccessGrants, and(
        eq(audioProjectAccessGrants.projectId, audioProjects.id),
        eq(audioProjectAccessGrants.granteeUserId, input.actorUserId),
        eq(audioProjectAccessGrants.canManageRelease, true),
        isNull(audioProjectAccessGrants.revokedAt),
        or(isNull(audioProjectAccessGrants.expiresAt), gt(audioProjectAccessGrants.expiresAt, new Date()))
      ))
      .where(and(
        eq(audioProjects.performerId, input.performerId),
        eq(audioProjects.status, 'active'),
        eq(audioAssets.status, 'active'),
        eq(audioProjectAssetVersions.integrityStatus, 'verified')
      ))
      .orderBy(desc(audioProjectAssetVersions.versionNumber), desc(audioProjectAssetVersions.createdAt));

    const seenAssets = new Set<string>();
    const latestAssets = masterRows.filter((row) => {
      if (seenAssets.has(row.assetId)) return false;
      seenAssets.add(row.assetId);
      return true;
    });
    const masters = latestAssets.filter((row) => row.mimeType.startsWith('audio/'));
    const artworks = latestAssets.filter((row) => row.mimeType.startsWith('image/') && row.assetKind === 'artwork');
    const rightsDocuments = latestAssets.filter((row) => row.assetKind === 'document' || row.mimeType === 'application/pdf' || row.mimeType.startsWith('text/'));

    return {
      masters,
      artworks,
      rightsDocuments,
      releases: releases.map((release) => ({
        ...release,
        recordings: recordings.filter((recording) => recording.releaseId === release.id).map((recording) => ({
          ...recording,
          credits: credits.filter((credit) => credit.recordingId === recording.recordingId)
        })),
        declarations: declarations.filter((declaration) => declaration.releaseId === release.id).map((declaration) => {
          const events = declarationEvents.filter((event) => event.declarationId === declaration.id);
          const outcome = events.some((event) => event.eventType === 'revoked')
            ? 'revoked'
            : events.find((event) => event.eventType === 'verified' || event.eventType === 'rejected')?.eventType ?? 'declared';
          return { ...declaration, outcome, events };
        }),
        readiness: buildReleaseReadiness({
          release,
          recordings: recordings.filter((recording) => recording.releaseId === release.id),
          credits,
          declarations: declarations.filter((declaration) => declaration.releaseId === release.id).map((declaration) => {
            const events = declarationEvents.filter((event) => event.declarationId === declaration.id);
            const outcome = events.some((event) => event.eventType === 'revoked')
              ? 'revoked'
              : events.find((event) => event.eventType === 'verified' || event.eventType === 'rejected')?.eventType ?? 'declared';
            return {
              recordingId: declaration.recordingId,
              declarationType: declaration.declarationType,
              outcome
            };
          })
        })
      }))
    };
  }

  async function createReleaseDraft(input: {
    clientReleaseId: string;
    performerId: string;
    actorUserId: string;
    projectId: string;
    masterAssetVersionId: string;
    title: string;
    trackTitle: string;
    versionTitle?: string | null;
    primaryArtistName: string;
    releaseType: string;
    upc?: string | null;
    isrc?: string | null;
    labelName?: string | null;
    pLine?: string | null;
    cLine?: string | null;
    originalReleaseDate?: string | null;
    territories?: string[] | null;
    isExplicit?: boolean;
    languageCode?: string | null;
  }) {
    if (!UUID_PATTERN.test(input.clientReleaseId)) throw new Error('clientReleaseId must be a UUID.');
    if (!RELEASE_TYPES.has(input.releaseType)) throw new Error('Release type is invalid.');

    const title = requiredReleaseText(input.title, 'Release title');
    const trackTitle = requiredReleaseText(input.trackTitle, 'Track title');
    const primaryArtistName = requiredReleaseText(input.primaryArtistName, 'Primary artist');
    const versionTitle = optionalReleaseText(input.versionTitle, 'Version title');
    const labelName = optionalReleaseText(input.labelName, 'Label name');
    const pLine = optionalReleaseText(input.pLine, 'P line');
    const cLine = optionalReleaseText(input.cLine, 'C line');
    const upc = optionalReleaseText(input.upc, 'UPC', 14);
    const isrc = optionalReleaseText(input.isrc, 'ISRC', 12)?.toUpperCase() ?? null;
    const languageCode = optionalReleaseText(input.languageCode, 'Language code', 3)?.toLowerCase() ?? null;
    const originalReleaseDate = optionalReleaseText(input.originalReleaseDate, 'Original release date', 10);
    const territories = normalizeTerritories(input.territories);

    if (upc && !/^[0-9]{8,14}$/.test(upc)) throw new Error('UPC must contain 8 through 14 digits.');
    if (isrc && !/^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(isrc)) throw new Error('ISRC must use the 12-character ISRC format.');
    if (languageCode && !/^[a-z]{2,3}$/.test(languageCode)) throw new Error('Language code must contain 2 or 3 letters.');
    if (originalReleaseDate && !/^\d{4}-\d{2}-\d{2}$/.test(originalReleaseDate)) {
      throw new Error('Original release date must use YYYY-MM-DD.');
    }

    const access = await requireProjectAccess({
      projectId: input.projectId,
      userId: input.actorUserId,
      needManageRelease: true
    });
    if (!access) throw new Error('Release management permission required.');

    const [master] = await db
      .select({
        id: audioProjectAssetVersions.id,
        projectId: audioProjectAssetVersions.projectId,
        performerId: audioProjectAssetVersions.performerId,
        mimeType: audioProjectAssetVersions.mimeType,
        integrityStatus: audioProjectAssetVersions.integrityStatus,
        sha256: audioProjectAssetVersions.sha256
      })
      .from(audioProjectAssetVersions)
      .where(and(
        eq(audioProjectAssetVersions.id, input.masterAssetVersionId),
        eq(audioProjectAssetVersions.projectId, input.projectId),
        eq(audioProjectAssetVersions.performerId, input.performerId)
      ))
      .limit(1);
    if (!master || master.integrityStatus !== 'verified' || !master.mimeType.startsWith('audio/')) {
      throw new Error('A verified audio master owned by this performer is required.');
    }

    return db.transaction(async (tx) => {
      const [release] = await tx
        .insert(musicReleases)
        .values({
          id: input.clientReleaseId,
          performerId: input.performerId,
          projectId: input.projectId,
          title,
          primaryArtistName,
          releaseType: input.releaseType,
          distributionMode: 'private',
          status: 'draft',
          upc,
          labelName,
          pLine,
          cLine,
          originalReleaseDate,
          territories,
          metadata: {
            draftSource: 'creator_catalog',
            clientReleaseId: input.clientReleaseId,
            deliveryEnabled: false
          }
        })
        .onConflictDoNothing({ target: musicReleases.id })
        .returning();

      if (!release) {
        const [existing] = await tx
          .select()
          .from(musicReleases)
          .where(and(eq(musicReleases.id, input.clientReleaseId), eq(musicReleases.performerId, input.performerId)))
          .limit(1);
        if (!existing) throw new Error('Release idempotency key belongs to another account.');
        const [existingRecording] = await tx
          .select({ recording: musicRecordings })
          .from(musicReleaseRecordings)
          .innerJoin(musicRecordings, eq(musicRecordings.id, musicReleaseRecordings.recordingId))
          .where(eq(musicReleaseRecordings.releaseId, existing.id))
          .orderBy(asc(musicReleaseRecordings.trackNumber))
          .limit(1);
        return { release: existing, recording: existingRecording?.recording ?? null, created: false };
      }

      const [recording] = await tx.insert(musicRecordings).values({
        performerId: input.performerId,
        projectId: input.projectId,
        masterAssetVersionId: master.id,
        title: trackTitle,
        versionTitle,
        primaryArtistName,
        isrc,
        isExplicit: input.isExplicit === true,
        languageCode,
        originalReleaseDate,
        rightsStatus: 'draft',
        metadata: { masterSha256: master.sha256 }
      }).returning();

      await tx.insert(musicReleaseRecordings).values({
        releaseId: release.id,
        recordingId: recording.id,
        discNumber: 1,
        trackNumber: 1
      });

      await tx.insert(auditEvents).values([
        {
          actorType: 'performer',
          actorId: input.actorUserId,
          entityType: 'music_release',
          entityId: release.id,
          eventType: 'music_release.draft_create',
          previousStatus: null,
          nextStatus: 'draft',
          metadata: { projectId: input.projectId, releaseType: input.releaseType, distributionMode: 'private' }
        },
        {
          actorType: 'performer',
          actorId: input.actorUserId,
          entityType: 'music_recording',
          entityId: recording.id,
          eventType: 'music_recording.create',
          previousStatus: null,
          nextStatus: 'draft',
          metadata: { releaseId: release.id, masterAssetVersionId: master.id, masterSha256: master.sha256 }
        }
      ]);

      return { release, recording, created: true };
    });
  }

  async function updateReleaseDraft(input: {
    releaseId: string;
    performerId: string;
    actorUserId: string;
    expectedUpdatedAt?: string | null;
    artworkAssetVersionId?: string | null;
    title: string;
    trackTitle: string;
    versionTitle?: string | null;
    primaryArtistName: string;
    releaseType: string;
    distributionMode: string;
    upc?: string | null;
    isrc?: string | null;
    labelName?: string | null;
    pLine?: string | null;
    cLine?: string | null;
    originalReleaseDate?: string | null;
    scheduledReleaseAt?: string | null;
    territories?: string[] | null;
    isExplicit?: boolean;
    languageCode?: string | null;
    credits?: Array<{ displayName?: string; role?: string }> | null;
  }) {
    if (!RELEASE_TYPES.has(input.releaseType)) throw new Error('Release type is invalid.');
    if (!DISTRIBUTION_MODES.has(input.distributionMode)) throw new Error('Distribution mode is invalid.');
    const title = requiredReleaseText(input.title, 'Release title');
    const trackTitle = requiredReleaseText(input.trackTitle, 'Track title');
    const primaryArtistName = requiredReleaseText(input.primaryArtistName, 'Primary artist');
    const versionTitle = optionalReleaseText(input.versionTitle, 'Version title');
    const labelName = optionalReleaseText(input.labelName, 'Label name');
    const pLine = optionalReleaseText(input.pLine, 'P line');
    const cLine = optionalReleaseText(input.cLine, 'C line');
    const upc = optionalReleaseText(input.upc, 'UPC', 14);
    const isrc = optionalReleaseText(input.isrc, 'ISRC', 12)?.toUpperCase() ?? null;
    const languageCode = optionalReleaseText(input.languageCode, 'Language code', 3)?.toLowerCase() ?? null;
    const originalReleaseDate = optionalReleaseText(input.originalReleaseDate, 'Original release date', 10);
    const territories = normalizeTerritories(input.territories);
    const credits = normalizeCredits(input.credits);
    const scheduledReleaseAt = input.scheduledReleaseAt?.trim() ? new Date(input.scheduledReleaseAt) : null;
    if (upc && !/^[0-9]{8,14}$/.test(upc)) throw new Error('UPC must contain 8 through 14 digits.');
    if (isrc && !/^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(isrc)) throw new Error('ISRC must use the 12-character ISRC format.');
    if (languageCode && !/^[a-z]{2,3}$/.test(languageCode)) throw new Error('Language code must contain 2 or 3 letters.');
    if (originalReleaseDate && !/^\d{4}-\d{2}-\d{2}$/.test(originalReleaseDate)) throw new Error('Original release date must use YYYY-MM-DD.');
    if (scheduledReleaseAt && Number.isNaN(scheduledReleaseAt.getTime())) throw new Error('Scheduled release time is invalid.');

    const [release] = await db.select().from(musicReleases).where(and(
      eq(musicReleases.id, input.releaseId),
      eq(musicReleases.performerId, input.performerId)
    )).limit(1);
    if (!release?.projectId) throw new Error('Release draft not found.');
    if (release.status !== 'draft') throw new Error('Only a draft release can be edited. Return it to draft through rights review before changing metadata.');
    if (input.expectedUpdatedAt) {
      const expectedUpdatedAt = new Date(input.expectedUpdatedAt);
      if (Number.isNaN(expectedUpdatedAt.getTime()) || release.updatedAt.toISOString() !== expectedUpdatedAt.toISOString()) {
        throw new Error('Release changed in another session. Reload before saving.');
      }
    }
    const access = await requireProjectAccess({ projectId: release.projectId, userId: input.actorUserId, needManageRelease: true });
    if (!access) throw new Error('Release management permission required.');
    const [releaseRecording] = await db
      .select({ recording: musicRecordings })
      .from(musicReleaseRecordings)
      .innerJoin(musicRecordings, eq(musicRecordings.id, musicReleaseRecordings.recordingId))
      .where(eq(musicReleaseRecordings.releaseId, release.id))
      .orderBy(asc(musicReleaseRecordings.trackNumber))
      .limit(1);
    if (!releaseRecording) throw new Error('Release recording not found.');
    const releaseRecordingLinks = await db
      .select({ recordingId: musicReleaseRecordings.recordingId })
      .from(musicReleaseRecordings)
      .where(eq(musicReleaseRecordings.releaseId, release.id));
    if (input.releaseType === 'single' && releaseRecordingLinks.length !== 1) {
      throw new Error('A single must contain exactly one recording. Remove extra tracks before changing the release type to Single.');
    }

    const artworkAssetVersionId = input.artworkAssetVersionId?.trim() || null;
    if (artworkAssetVersionId) {
      const [artwork] = await db
        .select({ id: audioProjectAssetVersions.id, mimeType: audioProjectAssetVersions.mimeType, assetKind: audioAssets.assetKind })
        .from(audioProjectAssetVersions)
        .innerJoin(audioAssets, eq(audioAssets.id, audioProjectAssetVersions.assetId))
        .where(and(
          eq(audioProjectAssetVersions.id, artworkAssetVersionId),
          eq(audioProjectAssetVersions.projectId, release.projectId),
          eq(audioProjectAssetVersions.performerId, input.performerId),
          eq(audioProjectAssetVersions.integrityStatus, 'verified')
        ))
        .limit(1);
      if (!artwork || artwork.assetKind !== 'artwork' || !artwork.mimeType.startsWith('image/')) {
        throw new Error('Artwork must be a verified image from this release project.');
      }
    }

    const previousMetadataRevision = Number((release.metadata as any)?.metadataRevision ?? 1);
    const now = new Date(Math.max(Date.now(), release.updatedAt.getTime() + 1));
    const result = await db.transaction(async (tx) => {
      const [updatedRelease] = await tx.update(musicReleases).set({
        artworkAssetVersionId,
        title,
        primaryArtistName,
        releaseType: input.releaseType,
        distributionMode: input.distributionMode as 'private' | 'sway_only' | 'sway_first' | 'everywhere',
        upc,
        labelName,
        pLine,
        cLine,
        originalReleaseDate,
        scheduledReleaseAt,
        territories,
        metadata: {
          ...((release.metadata as Record<string, unknown> | null) ?? {}),
          metadataRevision: previousMetadataRevision + 1,
          lastEditedByUserId: input.actorUserId,
          deliveryEnabled: false
        },
        updatedAt: now
      }).where(and(
        eq(musicReleases.id, release.id),
        eq(musicReleases.status, 'draft'),
        sql`coalesce((${musicReleases.metadata}->>'metadataRevision')::integer, 1) = ${previousMetadataRevision}`
      )).returning();
      if (!updatedRelease) {
        throw new Error('Release changed in another session. Reload before saving.');
      }

      const [updatedRecording] = await tx.update(musicRecordings).set({
        title: trackTitle,
        versionTitle,
        primaryArtistName,
        isrc,
        isExplicit: input.isExplicit === true,
        languageCode,
        originalReleaseDate,
        rightsStatus: 'draft',
        updatedAt: now
      }).where(eq(musicRecordings.id, releaseRecording.recording.id)).returning();

      await tx.delete(musicRecordingCredits).where(eq(musicRecordingCredits.recordingId, releaseRecording.recording.id));
      await tx.insert(musicRecordingCredits).values(credits.map((credit) => ({
        recordingId: releaseRecording.recording.id,
        displayName: credit.displayName,
        role: credit.role,
        sequence: credit.sequence
      })));
      await tx.insert(auditEvents).values({
        actorType: 'performer',
        actorId: input.actorUserId,
        entityType: 'music_release',
        entityId: release.id,
        eventType: 'music_release.draft_update',
        previousStatus: 'draft',
        nextStatus: 'draft',
        metadata: {
          projectId: release.projectId,
          previousUpdatedAt: release.updatedAt.toISOString(),
          metadataRevision: Number((updatedRelease.metadata as any)?.metadataRevision ?? 2),
          creditCount: credits.length,
          artworkAssetVersionId
        }
      });
      return { release: updatedRelease, recording: updatedRecording, credits };
    });
    const workspace = await listReleaseWorkspace({
      performerId: input.performerId,
      actorUserId: input.actorUserId
    });
    return {
      ...result,
      readiness: workspace.releases.find((candidate) => candidate.id === release.id)?.readiness ?? null
    };
  }

  async function addReleaseRecording(input: {
    releaseId: string;
    clientRecordingId: string;
    performerId: string;
    actorUserId: string;
    expectedUpdatedAt: string | null;
    masterAssetVersionId: string;
    title: string;
    versionTitle?: string | null;
    primaryArtistName: string;
    isrc?: string | null;
    isExplicit?: boolean;
    languageCode?: string | null;
    originalReleaseDate?: string | null;
    credits?: Array<{ displayName?: string; role?: string }> | null;
  }) {
    if (!UUID_PATTERN.test(input.clientRecordingId)) throw new Error('clientRecordingId must be a UUID.');
    const normalized = normalizeRecordingDraft(input);
    const [existingRecording] = await db
      .select({
        recording: musicRecordings,
        linkedReleaseId: musicReleaseRecordings.releaseId,
        discNumber: musicReleaseRecordings.discNumber,
        trackNumber: musicReleaseRecordings.trackNumber
      })
      .from(musicRecordings)
      .leftJoin(musicReleaseRecordings, eq(musicReleaseRecordings.recordingId, musicRecordings.id))
      .where(eq(musicRecordings.id, input.clientRecordingId))
      .limit(1);
    if (existingRecording) {
      if (existingRecording.recording.performerId !== input.performerId || existingRecording.linkedReleaseId !== input.releaseId) {
        throw new Error('Recording idempotency key belongs to another release or account.');
      }
      const [release] = await db.select().from(musicReleases).where(eq(musicReleases.id, input.releaseId)).limit(1);
      return {
        release,
        recording: existingRecording.recording,
        discNumber: existingRecording.discNumber,
        trackNumber: existingRecording.trackNumber,
        created: false
      };
    }

    const [release] = await db.select().from(musicReleases).where(and(
      eq(musicReleases.id, input.releaseId),
      eq(musicReleases.performerId, input.performerId)
    )).limit(1);
    if (!release?.projectId) throw new Error('Release draft not found.');
    if (release.status !== 'draft') throw new Error('Release tracks are sealed after rights review starts.');
    if (release.releaseType === 'single') throw new Error('Change the release type from Single before adding another track.');
    assertExpectedReleaseVersion(release.updatedAt, input.expectedUpdatedAt);
    const access = await requireProjectAccess({
      projectId: release.projectId,
      userId: input.actorUserId,
      needManageRelease: true
    });
    if (!access) throw new Error('Release management permission required.');
    const [master] = await db
      .select({
        id: audioProjectAssetVersions.id,
        projectId: audioProjectAssetVersions.projectId,
        performerId: audioProjectAssetVersions.performerId,
        mimeType: audioProjectAssetVersions.mimeType,
        integrityStatus: audioProjectAssetVersions.integrityStatus,
        sha256: audioProjectAssetVersions.sha256
      })
      .from(audioProjectAssetVersions)
      .where(and(
        eq(audioProjectAssetVersions.id, input.masterAssetVersionId),
        eq(audioProjectAssetVersions.projectId, release.projectId),
        eq(audioProjectAssetVersions.performerId, input.performerId)
      ))
      .limit(1);
    if (!master || master.integrityStatus !== 'verified' || !master.mimeType.startsWith('audio/')) {
      throw new Error('A verified audio master from this release project is required.');
    }
    const [duplicateMaster] = await db
      .select({ recordingId: musicRecordings.id })
      .from(musicReleaseRecordings)
      .innerJoin(musicRecordings, eq(musicRecordings.id, musicReleaseRecordings.recordingId))
      .where(and(
        eq(musicReleaseRecordings.releaseId, release.id),
        eq(musicRecordings.masterAssetVersionId, master.id)
      ))
      .limit(1);
    if (duplicateMaster) throw new Error('This verified master is already part of the release.');

    const previousMetadataRevision = Number((release.metadata as any)?.metadataRevision ?? 1);
    const now = new Date(Math.max(Date.now(), release.updatedAt.getTime() + 1));
    return db.transaction(async (tx) => {
      const [updatedRelease] = await tx.update(musicReleases).set({
        metadata: {
          ...((release.metadata as Record<string, unknown> | null) ?? {}),
          metadataRevision: previousMetadataRevision + 1,
          lastEditedByUserId: input.actorUserId,
          deliveryEnabled: false
        },
        updatedAt: now
      }).where(and(
        eq(musicReleases.id, release.id),
        eq(musicReleases.status, 'draft'),
        sql`coalesce((${musicReleases.metadata}->>'metadataRevision')::integer, 1) = ${previousMetadataRevision}`
      )).returning();
      if (!updatedRelease) throw new Error('Release changed in another session. Reload before saving.');

      const existingLinks = await tx
        .select({ trackNumber: musicReleaseRecordings.trackNumber })
        .from(musicReleaseRecordings)
        .where(eq(musicReleaseRecordings.releaseId, release.id))
        .orderBy(desc(musicReleaseRecordings.trackNumber));
      const trackNumber = (existingLinks[0]?.trackNumber ?? 0) + 1;
      const [recording] = await tx.insert(musicRecordings).values({
        id: input.clientRecordingId,
        performerId: input.performerId,
        projectId: release.projectId,
        masterAssetVersionId: master.id,
        title: normalized.title,
        versionTitle: normalized.versionTitle,
        primaryArtistName: normalized.primaryArtistName,
        isrc: normalized.isrc,
        isExplicit: normalized.isExplicit,
        languageCode: normalized.languageCode,
        originalReleaseDate: normalized.originalReleaseDate,
        rightsStatus: 'draft',
        metadata: { masterSha256: master.sha256 }
      }).returning();
      await tx.insert(musicReleaseRecordings).values({
        releaseId: release.id,
        recordingId: recording.id,
        discNumber: 1,
        trackNumber
      });
      await tx.insert(musicRecordingCredits).values(normalized.credits.map((credit) => ({
        recordingId: recording.id,
        displayName: credit.displayName,
        role: credit.role,
        sequence: credit.sequence
      })));
      await tx.insert(auditEvents).values({
        actorType: 'performer',
        actorId: input.actorUserId,
        entityType: 'music_release',
        entityId: release.id,
        eventType: 'music_release.recording_add',
        previousStatus: 'draft',
        nextStatus: 'draft',
        metadata: {
          recordingId: recording.id,
          masterAssetVersionId: master.id,
          masterSha256: master.sha256,
          trackNumber,
          metadataRevision: previousMetadataRevision + 1
        }
      });
      return { release: updatedRelease, recording, discNumber: 1, trackNumber, created: true };
    });
  }

  async function updateReleaseRecording(input: {
    releaseId: string;
    recordingId: string;
    performerId: string;
    actorUserId: string;
    expectedUpdatedAt: string | null;
    title: string;
    versionTitle?: string | null;
    primaryArtistName: string;
    isrc?: string | null;
    isExplicit?: boolean;
    languageCode?: string | null;
    originalReleaseDate?: string | null;
    credits?: Array<{ displayName?: string; role?: string }> | null;
  }) {
    const normalized = normalizeRecordingDraft(input);
    const [row] = await db
      .select({ release: musicReleases, recording: musicRecordings })
      .from(musicReleaseRecordings)
      .innerJoin(musicReleases, eq(musicReleases.id, musicReleaseRecordings.releaseId))
      .innerJoin(musicRecordings, eq(musicRecordings.id, musicReleaseRecordings.recordingId))
      .where(and(
        eq(musicReleaseRecordings.releaseId, input.releaseId),
        eq(musicReleaseRecordings.recordingId, input.recordingId),
        eq(musicReleases.performerId, input.performerId),
        eq(musicRecordings.performerId, input.performerId)
      ))
      .limit(1);
    if (!row?.release.projectId) throw new Error('Release recording not found.');
    if (row.release.status !== 'draft') throw new Error('Release tracks are sealed after rights review starts.');
    assertExpectedReleaseVersion(row.release.updatedAt, input.expectedUpdatedAt);
    const access = await requireProjectAccess({
      projectId: row.release.projectId,
      userId: input.actorUserId,
      needManageRelease: true
    });
    if (!access) throw new Error('Release management permission required.');

    const previousMetadataRevision = Number((row.release.metadata as any)?.metadataRevision ?? 1);
    const now = new Date(Math.max(Date.now(), row.release.updatedAt.getTime() + 1));
    return db.transaction(async (tx) => {
      const [updatedRelease] = await tx.update(musicReleases).set({
        metadata: {
          ...((row.release.metadata as Record<string, unknown> | null) ?? {}),
          metadataRevision: previousMetadataRevision + 1,
          lastEditedByUserId: input.actorUserId,
          deliveryEnabled: false
        },
        updatedAt: now
      }).where(and(
        eq(musicReleases.id, row.release.id),
        eq(musicReleases.status, 'draft'),
        sql`coalesce((${musicReleases.metadata}->>'metadataRevision')::integer, 1) = ${previousMetadataRevision}`
      )).returning();
      if (!updatedRelease) throw new Error('Release changed in another session. Reload before saving.');

      const [recording] = await tx.update(musicRecordings).set({
        title: normalized.title,
        versionTitle: normalized.versionTitle,
        primaryArtistName: normalized.primaryArtistName,
        isrc: normalized.isrc,
        isExplicit: normalized.isExplicit,
        languageCode: normalized.languageCode,
        originalReleaseDate: normalized.originalReleaseDate,
        rightsStatus: 'draft',
        updatedAt: now
      }).where(and(
        eq(musicRecordings.id, row.recording.id),
        eq(musicRecordings.performerId, input.performerId)
      )).returning();
      await tx.delete(musicRecordingCredits).where(eq(musicRecordingCredits.recordingId, recording.id));
      await tx.insert(musicRecordingCredits).values(normalized.credits.map((credit) => ({
        recordingId: recording.id,
        displayName: credit.displayName,
        role: credit.role,
        sequence: credit.sequence
      })));
      await tx.insert(auditEvents).values({
        actorType: 'performer',
        actorId: input.actorUserId,
        entityType: 'music_release',
        entityId: row.release.id,
        eventType: 'music_release.recording_update',
        previousStatus: 'draft',
        nextStatus: 'draft',
        metadata: {
          recordingId: recording.id,
          creditCount: normalized.credits.length,
          metadataRevision: previousMetadataRevision + 1
        }
      });
      return { release: updatedRelease, recording, credits: normalized.credits };
    });
  }

  async function reorderReleaseRecordings(input: {
    releaseId: string;
    performerId: string;
    actorUserId: string;
    expectedUpdatedAt: string | null;
    recordingIds: string[];
  }) {
    if (!input.recordingIds.length || input.recordingIds.length > 500) {
      throw new Error('Track order must contain between 1 and 500 recordings.');
    }
    if (new Set(input.recordingIds).size !== input.recordingIds.length) {
      throw new Error('Track order cannot contain duplicate recordings.');
    }
    const [release] = await db.select().from(musicReleases).where(and(
      eq(musicReleases.id, input.releaseId),
      eq(musicReleases.performerId, input.performerId)
    )).limit(1);
    if (!release?.projectId) throw new Error('Release draft not found.');
    if (release.status !== 'draft') throw new Error('Release tracks are sealed after rights review starts.');
    assertExpectedReleaseVersion(release.updatedAt, input.expectedUpdatedAt);
    const access = await requireProjectAccess({ projectId: release.projectId, userId: input.actorUserId, needManageRelease: true });
    if (!access) throw new Error('Release management permission required.');
    const currentLinks = await db
      .select({ recordingId: musicReleaseRecordings.recordingId })
      .from(musicReleaseRecordings)
      .where(eq(musicReleaseRecordings.releaseId, release.id));
    const currentIds = new Set(currentLinks.map((link) => link.recordingId));
    if (currentIds.size !== input.recordingIds.length || input.recordingIds.some((id) => !currentIds.has(id))) {
      throw new Error('Track order must contain every recording in this release exactly once.');
    }

    const previousMetadataRevision = Number((release.metadata as any)?.metadataRevision ?? 1);
    const now = new Date(Math.max(Date.now(), release.updatedAt.getTime() + 1));
    return db.transaction(async (tx) => {
      const [updatedRelease] = await tx.update(musicReleases).set({
        metadata: {
          ...((release.metadata as Record<string, unknown> | null) ?? {}),
          metadataRevision: previousMetadataRevision + 1,
          lastEditedByUserId: input.actorUserId,
          deliveryEnabled: false
        },
        updatedAt: now
      }).where(and(
        eq(musicReleases.id, release.id),
        eq(musicReleases.status, 'draft'),
        sql`coalesce((${musicReleases.metadata}->>'metadataRevision')::integer, 1) = ${previousMetadataRevision}`
      )).returning();
      if (!updatedRelease) throw new Error('Release changed in another session. Reload before saving.');
      await tx.update(musicReleaseRecordings).set({
        trackNumber: sql`${musicReleaseRecordings.trackNumber} + 10000`
      }).where(eq(musicReleaseRecordings.releaseId, release.id));
      for (const [index, recordingId] of input.recordingIds.entries()) {
        await tx.update(musicReleaseRecordings).set({ discNumber: 1, trackNumber: index + 1 }).where(and(
          eq(musicReleaseRecordings.releaseId, release.id),
          eq(musicReleaseRecordings.recordingId, recordingId)
        ));
      }
      await tx.insert(auditEvents).values({
        actorType: 'performer',
        actorId: input.actorUserId,
        entityType: 'music_release',
        entityId: release.id,
        eventType: 'music_release.recordings_reorder',
        previousStatus: 'draft',
        nextStatus: 'draft',
        metadata: { recordingIds: input.recordingIds, metadataRevision: previousMetadataRevision + 1 }
      });
      return { release: updatedRelease, recordingIds: input.recordingIds };
    });
  }

  async function removeReleaseRecording(input: {
    releaseId: string;
    recordingId: string;
    performerId: string;
    actorUserId: string;
    expectedUpdatedAt: string | null;
  }) {
    const [row] = await db
      .select({ release: musicReleases, recording: musicRecordings })
      .from(musicReleaseRecordings)
      .innerJoin(musicReleases, eq(musicReleases.id, musicReleaseRecordings.releaseId))
      .innerJoin(musicRecordings, eq(musicRecordings.id, musicReleaseRecordings.recordingId))
      .where(and(
        eq(musicReleaseRecordings.releaseId, input.releaseId),
        eq(musicReleaseRecordings.recordingId, input.recordingId),
        eq(musicReleases.performerId, input.performerId),
        eq(musicRecordings.performerId, input.performerId)
      ))
      .limit(1);
    if (!row?.release.projectId) throw new Error('Release recording not found.');
    if (row.release.status !== 'draft') throw new Error('Release tracks are sealed after rights review starts.');
    assertExpectedReleaseVersion(row.release.updatedAt, input.expectedUpdatedAt);
    const access = await requireProjectAccess({ projectId: row.release.projectId, userId: input.actorUserId, needManageRelease: true });
    if (!access) throw new Error('Release management permission required.');
    const links = await db
      .select({ recordingId: musicReleaseRecordings.recordingId, trackNumber: musicReleaseRecordings.trackNumber })
      .from(musicReleaseRecordings)
      .where(eq(musicReleaseRecordings.releaseId, row.release.id))
      .orderBy(asc(musicReleaseRecordings.trackNumber));
    if (links.length <= 1) throw new Error('A release must keep at least one recording.');
    const [declaration] = await db.select({ id: musicRightsDeclarations.id }).from(musicRightsDeclarations).where(and(
      eq(musicRightsDeclarations.releaseId, row.release.id),
      eq(musicRightsDeclarations.recordingId, row.recording.id)
    )).limit(1);
    if (declaration) throw new Error('A recording with sealed rights evidence cannot be removed.');

    const previousMetadataRevision = Number((row.release.metadata as any)?.metadataRevision ?? 1);
    const now = new Date(Math.max(Date.now(), row.release.updatedAt.getTime() + 1));
    const remainingIds = links.filter((link) => link.recordingId !== row.recording.id).map((link) => link.recordingId);
    return db.transaction(async (tx) => {
      const [updatedRelease] = await tx.update(musicReleases).set({
        metadata: {
          ...((row.release.metadata as Record<string, unknown> | null) ?? {}),
          metadataRevision: previousMetadataRevision + 1,
          lastEditedByUserId: input.actorUserId,
          deliveryEnabled: false
        },
        updatedAt: now
      }).where(and(
        eq(musicReleases.id, row.release.id),
        eq(musicReleases.status, 'draft'),
        sql`coalesce((${musicReleases.metadata}->>'metadataRevision')::integer, 1) = ${previousMetadataRevision}`
      )).returning();
      if (!updatedRelease) throw new Error('Release changed in another session. Reload before saving.');
      await tx.delete(musicReleaseRecordings).where(and(
        eq(musicReleaseRecordings.releaseId, row.release.id),
        eq(musicReleaseRecordings.recordingId, row.recording.id)
      ));
      await tx.update(musicReleaseRecordings).set({
        trackNumber: sql`${musicReleaseRecordings.trackNumber} + 10000`
      }).where(eq(musicReleaseRecordings.releaseId, row.release.id));
      for (const [index, recordingId] of remainingIds.entries()) {
        await tx.update(musicReleaseRecordings).set({ discNumber: 1, trackNumber: index + 1 }).where(and(
          eq(musicReleaseRecordings.releaseId, row.release.id),
          eq(musicReleaseRecordings.recordingId, recordingId)
        ));
      }
      await tx.insert(auditEvents).values({
        actorType: 'performer',
        actorId: input.actorUserId,
        entityType: 'music_release',
        entityId: row.release.id,
        eventType: 'music_release.recording_remove',
        previousStatus: 'draft',
        nextStatus: 'draft',
        metadata: {
          recordingId: row.recording.id,
          remainingRecordingIds: remainingIds,
          metadataRevision: previousMetadataRevision + 1
        }
      });
      return { release: updatedRelease, removedRecordingId: row.recording.id, recordingIds: remainingIds };
    });
  }

  async function createRightsDeclaration(input: {
    releaseId: string;
    performerId: string;
    actorUserId: string;
    declarationType: string;
    termsDocumentAssetVersionId: string;
    termsVersion: string;
    declarationText: string;
    evidenceNote: string;
    recordingId?: string | null;
  }) {
    const declarationType = input.declarationType.trim().toLowerCase();
    if (!RIGHTS_DECLARATION_TYPES.has(declarationType)) throw new Error('Rights declaration type is invalid.');
    const termsVersion = requiredReleaseText(input.termsVersion, 'Terms version', 80);
    const declarationText = requiredReleaseText(input.declarationText, 'Declaration text', 4000);
    const evidenceNote = requiredReleaseText(input.evidenceNote, 'Evidence note', 1000);
    const [release] = await db.select().from(musicReleases).where(and(
      eq(musicReleases.id, input.releaseId), eq(musicReleases.performerId, input.performerId)
    )).limit(1);
    if (!release?.projectId) throw new Error('Release not found.');
    if (!['draft', 'rights_review'].includes(release.status)) throw new Error('Rights evidence cannot be added in the current release state.');
    const access = await requireProjectAccess({ projectId: release.projectId, userId: input.actorUserId, needManageRelease: true });
    if (!access) throw new Error('Release management permission required.');
    if (release.status === 'draft') {
      const workspace = await listReleaseWorkspace({ performerId: input.performerId, actorUserId: input.actorUserId });
      const current = workspace.releases.find((candidate) => candidate.id === release.id);
      const metadataIssues = current?.readiness.metadataIssues
        ?? ['Release readiness could not be evaluated.'];
      if (metadataIssues.length) {
        throw new Error(`Complete release metadata before rights review: ${metadataIssues.join(' ')}`);
      }
    }
    const [document] = await db
      .select({
        id: audioProjectAssetVersions.id,
        sha256: audioProjectAssetVersions.sha256,
        assetKind: audioAssets.assetKind,
        integrityStatus: audioProjectAssetVersions.integrityStatus
      })
      .from(audioProjectAssetVersions)
      .innerJoin(audioAssets, eq(audioAssets.id, audioProjectAssetVersions.assetId))
      .where(and(
        eq(audioProjectAssetVersions.id, input.termsDocumentAssetVersionId),
        eq(audioProjectAssetVersions.projectId, release.projectId),
        eq(audioProjectAssetVersions.performerId, input.performerId)
      ))
      .limit(1);
    if (!document || document.integrityStatus !== 'verified' || document.assetKind !== 'document') {
      throw new Error('A verified rights document from this release project is required.');
    }
    const requestedRecordingId = input.recordingId?.trim() || null;
    if (RECORDING_SCOPED_RIGHTS.has(declarationType) && !requestedRecordingId) {
      throw new Error(`${declarationType.replaceAll('_', ' ')} evidence must identify the recording it covers.`);
    }
    const recordingId = RECORDING_SCOPED_RIGHTS.has(declarationType) ? requestedRecordingId : null;
    if (recordingId) {
      const [link] = await db.select().from(musicReleaseRecordings).where(and(
        eq(musicReleaseRecordings.releaseId, release.id), eq(musicReleaseRecordings.recordingId, recordingId)
      )).limit(1);
      if (!link) throw new Error('Rights recording must belong to this release.');
    }
    const evidence = { note: evidenceNote, sourceDocumentSha256: document.sha256, attestedByUserId: input.actorUserId };
    const declarationSha256 = sha256Hex(JSON.stringify({
      releaseId: release.id,
      recordingId,
      declarationType,
      termsVersion,
      termsHash: document.sha256,
      declarationText,
      evidence
    }));
    const [declaration] = await db.insert(musicRightsDeclarations).values({
      projectId: release.projectId,
      releaseId: release.id,
      recordingId,
      declaredByUserId: input.actorUserId,
      declarationType,
      termsDocumentAssetVersionId: document.id,
      termsVersion,
      termsHash: document.sha256,
      declarationText,
      declarationSha256,
      evidence
    }).returning();
    if (release.status === 'draft') {
      await db.update(musicReleases).set({ status: 'rights_review', updatedAt: new Date() }).where(eq(musicReleases.id, release.id));
    }
    if (recordingId) {
      await db.update(musicRecordings).set({ rightsStatus: 'declared', updatedAt: new Date() }).where(eq(musicRecordings.id, recordingId));
    }
    await writeAudit(db, {
      actorId: input.actorUserId,
      entityType: 'music_rights_declaration',
      entityId: declaration.id,
      eventType: 'music_rights_declaration.create',
      metadata: { releaseId: release.id, recordingId, declarationType, termsHash: document.sha256, declarationSha256 }
    });
    return declaration;
  }

  async function reviewRightsDeclaration(input: {
    declarationId: string;
    actorUserId: string;
    outcome: 'verified' | 'rejected';
    reason: string;
  }) {
    const reason = requiredReleaseText(input.reason, 'Review reason', 1000);
    const [row] = await db
      .select({
        declaration: musicRightsDeclarations,
        release: musicReleases,
        performerOwnerUserId: performers.ownerUserId
      })
      .from(musicRightsDeclarations)
      .innerJoin(musicReleases, eq(musicReleases.id, musicRightsDeclarations.releaseId))
      .innerJoin(performers, eq(performers.id, musicReleases.performerId))
      .where(eq(musicRightsDeclarations.id, input.declarationId))
      .limit(1);
    if (!row?.release.projectId) throw new Error('Rights declaration not found.');
    if (row.declaration.declaredByUserId === input.actorUserId) throw new Error('Rights evidence requires an independent project reviewer.');
    const access = await requireProjectAccess({ projectId: row.release.projectId, userId: input.actorUserId, needApprove: true });
    if (!access) throw new Error('Release review permission required.');
    const [evidenceAccess] = await db
      .select({ eventId: auditEvents.eventId })
      .from(auditEvents)
      .where(and(
        eq(auditEvents.actorId, input.actorUserId),
        eq(auditEvents.entityType, 'music_rights_declaration'),
        eq(auditEvents.entityId, row.declaration.id),
        eq(auditEvents.eventType, 'music_rights_declaration.evidence_access'),
        sql`${auditEvents.metadata}->>'termsHash' = ${row.declaration.termsHash}`,
        sql`${auditEvents.metadata}->>'termsDocumentAssetVersionId' = ${row.declaration.termsDocumentAssetVersionId}`
      ))
      .limit(1);
    if (!evidenceAccess) {
      throw new Error('Open the exact sealed rights document before recording a review outcome.');
    }
    return db.transaction(async (tx) => {
      const [lockedRelease] = await tx
        .select({ status: musicReleases.status })
        .from(musicReleases)
        .where(eq(musicReleases.id, row.release.id))
        .for('update')
        .limit(1);
      if (!lockedRelease) throw new Error('Rights declaration release no longer exists.');

      const [event] = await tx.insert(musicRightsDeclarationEvents).values({
        declarationId: row.declaration.id,
        actorUserId: input.actorUserId,
        eventType: input.outcome,
        declarationSha256: row.declaration.declarationSha256,
        evidence: { independentReview: true, reviewerUserId: input.actorUserId },
        reason
      }).returning();

      const now = new Date();
      if (row.declaration.recordingId) {
        await tx.update(musicRecordings).set({
          rightsStatus: input.outcome === 'verified' ? 'under_review' : 'blocked',
          updatedAt: now
        }).where(eq(musicRecordings.id, row.declaration.recordingId));
      }
      if (input.outcome === 'rejected') {
        await tx.update(musicReleases)
          .set({ status: 'blocked', updatedAt: now })
          .where(eq(musicReleases.id, row.release.id));
      }
      await writeAudit(tx, {
        actorType: 'account',
        actorId: input.actorUserId,
        entityType: 'music_rights_declaration',
        entityId: row.declaration.id,
        eventType: `music_rights_declaration.${input.outcome}`,
        metadata: { releaseId: row.release.id, reason }
      });

      if (input.outcome !== 'verified') return event;

      const workspace = await listReleaseWorkspace({
        performerId: row.release.performerId,
        actorUserId: row.performerOwnerUserId
      }, tx);
      const refreshed = workspace.releases.find((release) => release.id === row.release.id);
      if (!refreshed?.readiness.ready) return event;

      const rolesByVersionId = collectReleaseStorageManifestRoles(refreshed);
      const assetVersionIds = [...rolesByVersionId.keys()];
      const versionRows = await tx
        .select({
          id: audioProjectAssetVersions.id,
          sha256: audioProjectAssetVersions.sha256,
          byteSize: audioProjectAssetVersions.byteSize,
          mimeType: audioProjectAssetVersions.mimeType,
          storageProvider: audioProjectAssetVersions.storageProvider,
          storageBucket: audioProjectAssetVersions.storageBucket,
          storageKey: audioProjectAssetVersions.storageKey
        })
        .from(audioProjectAssetVersions)
        .where(and(
          eq(audioProjectAssetVersions.performerId, row.release.performerId),
          inArray(audioProjectAssetVersions.id, assetVersionIds),
          eq(audioProjectAssetVersions.integrityStatus, 'verified'),
          eq(audioProjectAssetVersions.originalPreserved, true)
        ));
      if (versionRows.length !== assetVersionIds.length) {
        throw new Error('Release package contains a missing or unverified asset version.');
      }
      const versionsById = new Map(versionRows.map((version) => [version.id, version]));
      const manifestAssets: ReleaseStorageManifestAsset[] = assetVersionIds.map((assetVersionId) => {
        const version = versionsById.get(assetVersionId);
        if (!version) throw new Error('Release package asset version lookup failed.');
        return {
          assetVersionId,
          sha256: version.sha256,
          byteSize: version.byteSize,
          roles: [...(rolesByVersionId.get(assetVersionId) ?? [])].sort()
        };
      }).sort((left, right) => left.assetVersionId.localeCompare(right.assetVersionId));
      const assetValidation: Awaited<ReturnType<typeof validateReleasePackageAsset>>[] = [];
      for (const manifestAsset of manifestAssets) {
        const version = versionsById.get(manifestAsset.assetVersionId);
        if (!version) throw new Error('Release package validation version lookup failed.');
        assetValidation.push(await validateReleasePackageAsset({
          version,
          roles: manifestAsset.roles
        }));
      }
      const packageFingerprint = sha256Hex(JSON.stringify({
        schemaVersion: 1,
        releaseId: row.release.id,
        performerId: row.release.performerId,
        assets: manifestAssets
      }));

      await tx.update(musicReleases)
        .set({ status: 'ready', updatedAt: now })
        .where(eq(musicReleases.id, row.release.id));
      for (const recording of refreshed.recordings) {
        await tx.update(musicRecordings)
          .set({ rightsStatus: 'cleared', updatedAt: now })
          .where(eq(musicRecordings.id, recording.recordingId));
      }

      const [existingManifest] = await tx
        .select()
        .from(musicReleaseStorageManifests)
        .where(and(
          eq(musicReleaseStorageManifests.releaseId, row.release.id),
          eq(musicReleaseStorageManifests.packageFingerprint, packageFingerprint)
        ))
        .limit(1);
      let storageManifest = existingManifest;
      if (!storageManifest) {
        const [revisionRow] = await tx
          .select({
            nextRevision: sql<number>`coalesce(max(${musicReleaseStorageManifests.packageRevision}), 0) + 1`
          })
          .from(musicReleaseStorageManifests)
          .where(eq(musicReleaseStorageManifests.releaseId, row.release.id));
        [storageManifest] = await tx.insert(musicReleaseStorageManifests).values({
          releaseId: row.release.id,
          performerId: row.release.performerId,
          createdByUserId: input.actorUserId,
          sourceType: 'readiness_pass',
          sourceEventId: event.id,
          packageRevision: Number(revisionRow?.nextRevision ?? 1),
          packageFingerprint,
          assets: manifestAssets,
          metadata: {
            schemaVersion: 1,
            assetCount: manifestAssets.length,
            validatorKey: RELEASE_PACKAGE_VALIDATOR_KEY,
            assetValidation,
            verifiedDeclarationId: row.declaration.id
          }
        }).returning();
      }

      await tx.insert(auditEvents).values({
        actorType: 'account',
        actorId: input.actorUserId,
        entityType: 'music_release',
        entityId: row.release.id,
        eventType: 'music_release.readiness_pass',
        previousStatus: lockedRelease.status,
        nextStatus: 'ready',
        metadata: {
          verifiedDeclarationId: row.declaration.id,
          readinessIssues: [],
          storageManifestId: storageManifest.id,
          storagePackageRevision: storageManifest.packageRevision,
          storagePackageFingerprint: storageManifest.packageFingerprint
        }
      });
      return event;
    });
  }

  async function openRightsReviewDocument(input: {
    declarationId: string;
    actorUserId: string;
  }) {
    const [row] = await db
      .select({
        declaration: musicRightsDeclarations,
        releaseProjectId: musicReleases.projectId
      })
      .from(musicRightsDeclarations)
      .innerJoin(musicReleases, eq(musicReleases.id, musicRightsDeclarations.releaseId))
      .where(eq(musicRightsDeclarations.id, input.declarationId))
      .limit(1);
    if (!row?.releaseProjectId || row.releaseProjectId !== row.declaration.projectId) {
      throw new Error('Rights declaration not found.');
    }
    if (row.declaration.declaredByUserId === input.actorUserId) {
      throw new Error('Rights evidence requires an independent project reviewer.');
    }
    const access = await requireProjectAccess({
      projectId: row.declaration.projectId,
      userId: input.actorUserId,
      needApprove: true
    });
    if (!access) throw new Error('Release review permission required.');

    const [version] = await db
      .select({
        id: audioProjectAssetVersions.id,
        projectId: audioProjectAssetVersions.projectId,
        originalFilename: audioProjectAssetVersions.originalFilename,
        mimeType: audioProjectAssetVersions.mimeType,
        byteSize: audioProjectAssetVersions.byteSize,
        sha256: audioProjectAssetVersions.sha256,
        storageProvider: audioProjectAssetVersions.storageProvider,
        storageBucket: audioProjectAssetVersions.storageBucket,
        storageKey: audioProjectAssetVersions.storageKey,
        integrityStatus: audioProjectAssetVersions.integrityStatus,
        assetKind: audioAssets.assetKind
      })
      .from(audioProjectAssetVersions)
      .innerJoin(audioAssets, eq(audioAssets.id, audioProjectAssetVersions.assetId))
      .where(and(
        eq(audioProjectAssetVersions.id, row.declaration.termsDocumentAssetVersionId),
        eq(audioProjectAssetVersions.projectId, row.declaration.projectId),
        eq(audioProjectAssetVersions.integrityStatus, 'verified'),
        eq(audioAssets.assetKind, 'document')
      ))
      .limit(1);
    if (!version) throw new Error('The sealed rights document is unavailable for review.');
    if (version.sha256 !== row.declaration.termsHash) {
      throw new Error('The sealed rights document does not match the declaration terms hash.');
    }

    const object = await store.openOriginal({
      storageProvider: parseAudioStorageProvider(version.storageProvider),
      storageBucket: version.storageBucket,
      storageKey: version.storageKey
    });
    await writeAudit(db, {
      actorType: 'account',
      actorId: input.actorUserId,
      entityType: 'music_rights_declaration',
      entityId: row.declaration.id,
      eventType: 'music_rights_declaration.evidence_access',
      metadata: {
        projectId: row.declaration.projectId,
        termsDocumentAssetVersionId: row.declaration.termsDocumentAssetVersionId,
        termsHash: row.declaration.termsHash
      }
    });
    return { version, ...object };
  }

  async function grantReleaseReviewer(input: {
    projectId: string;
    connectionId: string;
    actorUserId: string;
  }) {
    const access = await requireProjectAccess({
      projectId: input.projectId,
      userId: input.actorUserId,
      needManageAccess: true
    });
    if (!access) throw new Error('Project access management permission required.');
    const [connection] = await db.select().from(audioFileConnections).where(and(
      eq(audioFileConnections.id, input.connectionId),
      isNull(audioFileConnections.revokedAt)
    )).limit(1);
    if (!connection || ![connection.memberOneUserId, connection.memberTwoUserId].includes(input.actorUserId)) {
      throw new Error('Active file connection required.');
    }
    const reviewerUserId = connection.memberOneUserId === input.actorUserId
      ? connection.memberTwoUserId
      : connection.memberOneUserId;
    const now = new Date();
    const [existing] = await db.select().from(audioProjectAccessGrants).where(and(
      eq(audioProjectAccessGrants.projectId, input.projectId),
      eq(audioProjectAccessGrants.granteeUserId, reviewerUserId),
      isNull(audioProjectAccessGrants.revokedAt)
    )).limit(1);
    const existingIsActive = Boolean(existing && (!existing.expiresAt || existing.expiresAt.getTime() > now.getTime()));
    if (existing?.role === 'owner' && (!existingIsActive || !existing.canApprove)) {
      throw new Error('The project owner grant cannot be replaced through reviewer access.');
    }

    const { grant, replacedGrantId } = existingIsActive && existing?.canApprove
      ? { grant: existing, replacedGrantId: null }
      : await db.transaction(async (tx) => {
          if (existing) {
            await tx.update(audioProjectAccessGrants).set({
              revokedAt: now,
              revokedByUserId: input.actorUserId,
              revocationReason: 'Replaced by an explicit release-review grant.'
            }).where(and(
              eq(audioProjectAccessGrants.id, existing.id),
              isNull(audioProjectAccessGrants.revokedAt)
            ));
          }
          const [replacement] = await tx.insert(audioProjectAccessGrants).values({
            projectId: input.projectId,
            granteeUserId: reviewerUserId,
            role: existing?.role ?? 'reviewer',
            canUploadVersions: existing?.canUploadVersions ?? false,
            canDownloadOriginals: existing?.canDownloadOriginals ?? false,
            canComment: existing?.canComment ?? true,
            canApprove: true,
            canManageRelease: existing?.canManageRelease ?? false,
            canManageAccess: existing?.canManageAccess ?? false,
            grantedByUserId: input.actorUserId,
            expiresAt: existingIsActive ? existing?.expiresAt ?? null : null
          }).returning();
          return { grant: replacement, replacedGrantId: existing?.id ?? null };
        });
    await writeAudit(db, {
      actorId: input.actorUserId,
      entityType: 'audio_project_access_grant',
      entityId: grant.id,
      eventType: 'audio_project.release_reviewer_grant',
      metadata: { projectId: input.projectId, connectionId: input.connectionId, reviewerUserId, replacedGrantId }
    });
    return { grant, reviewerUserId, reused: existingIsActive && Boolean(existing?.canApprove), replaced: Boolean(replacedGrantId) };
  }

  async function listRightsReviewQueue(input: { actorUserId: string }) {
    const declarations = await db
      .select({
        id: musicRightsDeclarations.id,
        releaseId: musicRightsDeclarations.releaseId,
        releaseTitle: musicReleases.title,
        primaryArtistName: musicReleases.primaryArtistName,
        projectId: musicRightsDeclarations.projectId,
        recordingId: musicRightsDeclarations.recordingId,
        declaredByUserId: musicRightsDeclarations.declaredByUserId,
        declarationType: musicRightsDeclarations.declarationType,
        declarationText: musicRightsDeclarations.declarationText,
        declarationSha256: musicRightsDeclarations.declarationSha256,
        termsVersion: musicRightsDeclarations.termsVersion,
        termsHash: musicRightsDeclarations.termsHash,
        evidence: musicRightsDeclarations.evidence,
        declaredAt: musicRightsDeclarations.declaredAt
      })
      .from(musicRightsDeclarations)
      .innerJoin(musicReleases, eq(musicReleases.id, musicRightsDeclarations.releaseId))
      .innerJoin(audioProjectAccessGrants, and(
        eq(audioProjectAccessGrants.projectId, musicRightsDeclarations.projectId),
        eq(audioProjectAccessGrants.granteeUserId, input.actorUserId),
        eq(audioProjectAccessGrants.canApprove, true),
        isNull(audioProjectAccessGrants.revokedAt),
        or(isNull(audioProjectAccessGrants.expiresAt), gt(audioProjectAccessGrants.expiresAt, new Date()))
      ))
      .where(sql`${musicRightsDeclarations.declaredByUserId} <> ${input.actorUserId}`)
      .orderBy(asc(musicRightsDeclarations.declaredAt));
    if (!declarations.length) return [];
    const events = await db.select({
      declarationId: musicRightsDeclarationEvents.declarationId,
      eventType: musicRightsDeclarationEvents.eventType
    }).from(musicRightsDeclarationEvents);
    return declarations.filter((declaration) => !events.some((event) =>
      event.declarationId === declaration.id && ['verified', 'rejected', 'revoked'].includes(event.eventType)
    ));
  }

  async function getPublicRelease(input: { releaseId: string }) {
    const [release] = await db.select({
      id: musicReleases.id,
      performerId: musicReleases.performerId,
      artworkAssetVersionId: musicReleases.artworkAssetVersionId,
      title: musicReleases.title,
      primaryArtistName: musicReleases.primaryArtistName,
      releaseType: musicReleases.releaseType,
      distributionMode: musicReleases.distributionMode,
      status: musicReleases.status,
      labelName: musicReleases.labelName,
      pLine: musicReleases.pLine,
      cLine: musicReleases.cLine,
      originalReleaseDate: musicReleases.originalReleaseDate,
      scheduledReleaseAt: musicReleases.scheduledReleaseAt,
      publishedAt: musicReleases.publishedAt,
      territories: musicReleases.territories
    }).from(musicReleases).where(and(
      eq(musicReleases.id, input.releaseId),
      ne(musicReleases.distributionMode, 'private'),
      inArray(musicReleases.status, ['ready', 'scheduled', 'published'])
    )).limit(1);
    if (!release) return null;
    const recordings = await db.select({
      recordingId: musicRecordings.id,
      title: musicRecordings.title,
      versionTitle: musicRecordings.versionTitle,
      primaryArtistName: musicRecordings.primaryArtistName,
      isExplicit: musicRecordings.isExplicit,
      languageCode: musicRecordings.languageCode,
      rightsStatus: musicRecordings.rightsStatus,
      discNumber: musicReleaseRecordings.discNumber,
      trackNumber: musicReleaseRecordings.trackNumber
    }).from(musicReleaseRecordings)
      .innerJoin(musicRecordings, eq(musicRecordings.id, musicReleaseRecordings.recordingId))
      .where(eq(musicReleaseRecordings.releaseId, release.id))
      .orderBy(asc(musicReleaseRecordings.discNumber), asc(musicReleaseRecordings.trackNumber));
    if (!release.artworkAssetVersionId || !recordings.length || recordings.some((recording) => recording.rightsStatus !== 'cleared')) {
      return null;
    }
    const credits = await db.select({
      recordingId: musicRecordingCredits.recordingId,
      displayName: musicRecordingCredits.displayName,
      role: musicRecordingCredits.role,
      sequence: musicRecordingCredits.sequence
    }).from(musicRecordingCredits)
      .innerJoin(musicReleaseRecordings, eq(musicReleaseRecordings.recordingId, musicRecordingCredits.recordingId))
      .where(eq(musicReleaseRecordings.releaseId, release.id))
      .orderBy(asc(musicRecordingCredits.sequence));
    const destinations = await db.select({
      destinationKey: musicDistributionDeliveries.destinationKey,
      deliveryStatus: musicDistributionDeliveries.deliveryStatus,
      liveAt: musicDistributionDeliveries.liveAt
    }).from(musicDistributionDeliveries)
      .where(eq(musicDistributionDeliveries.releaseId, release.id))
      .orderBy(asc(musicDistributionDeliveries.destinationKey));
    const providerConfirmedLive = destinations.some((destination) => destination.deliveryStatus === 'live' && destination.liveAt);
    return {
      ...release,
      status: release.status === 'published' && !providerConfirmedLive ? 'ready' : release.status,
      artworkUrl: release.artworkAssetVersionId ? `/api/public/releases/${release.id}/artwork` : null,
      releasePath: `/r/${release.id}`,
      recordings: recordings.map((recording) => ({
        ...recording,
        credits: credits.filter((credit) => credit.recordingId === recording.recordingId)
      })),
      destinations
    };
  }

  async function openPublicReleaseArtwork(input: { releaseId: string }) {
    const release = await getPublicRelease(input);
    if (!release?.artworkAssetVersionId) throw new Error('Public release artwork not found.');
    const [version] = await db.select().from(audioProjectAssetVersions).where(and(
      eq(audioProjectAssetVersions.id, release.artworkAssetVersionId),
      eq(audioProjectAssetVersions.integrityStatus, 'verified')
    )).limit(1);
    if (!version || !version.mimeType.startsWith('image/')) throw new Error('Public release artwork not found.');
    const object = await store.openOriginal({
      storageProvider: parseAudioStorageProvider(version.storageProvider),
      storageBucket: version.storageBucket,
      storageKey: version.storageKey
    });
    return { version, ...object };
  }

  return {
    createProject,
    listProjects,
    listProjectAssets,
    getStorageUsage,
    initiateCollaboratorRevisionUpload,
    initiateUpload,
    authorizeCollaboratorRevisionUploadPart,
    writeUploadPart,
    completeAndSealCollaboratorRevision,
    completeAndSealUpload,
    validateReleasePackageAsset,
    reconcileDueAudioProviderOperations,
    retryPendingAudioObjectCleanupReceipts,
    expireStaleUploadSessions,
    reserveCollaboratorRevisionAuthorityCleanupIntent,
    abortCollaboratorRevisionUploadSessions,
    createShareGrant,
    openOwnedVersion,
    listReleaseWorkspace,
    createReleaseDraft,
    updateReleaseDraft,
    addReleaseRecording,
    updateReleaseRecording,
    reorderReleaseRecordings,
    removeReleaseRecording,
    createRightsDeclaration,
    openRightsReviewDocument,
    reviewRightsDeclaration,
    grantReleaseReviewer,
    listRightsReviewQueue,
    getPublicRelease,
    openPublicReleaseArtwork,
    downloadSharedOriginal
  };
}

export type AudioPublishingService = ReturnType<typeof createAudioPublishingService>;
