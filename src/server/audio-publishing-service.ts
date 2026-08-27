import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { TextDecoder } from 'node:util';
import { and, asc, desc, eq, gt, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { parseStream } from 'music-metadata';
import sharp from 'sharp';
import type { SwayDb } from '../db/client';
import {
  audioAssets,
  audioFileConnections,
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
  musicReleaseReportEvents,
  musicReleaseReports,
  musicReleaseRecordings,
  musicReleases,
  musicReleaseStorageManifests,
  musicRightsDeclarationEvents,
  musicRightsDeclarations,
  performers,
  users
} from '../db/schema';
import { parseAudioStorageProvider, type AudioObjectIdentity, type AudioObjectStore } from './audio-object-storage';
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
const LYRICS_AUTHORSHIP = new Set(['not_declared', 'human', 'human_ai_assisted', 'generated', 'instrumental']);
const COMPOSITION_AUTHORSHIP = new Set(['not_declared', 'human', 'human_ai_assisted', 'generated']);
const VOCAL_PERFORMANCE = new Set(['not_declared', 'human', 'virtual_original', 'licensed_replica', 'mixed', 'instrumental']);
const PRODUCTION_METHOD = new Set(['not_declared', 'human', 'ai_assisted', 'generated', 'mixed']);
const RELEASE_REPORT_REASONS = new Set([
  'copied_lyrics', 'unauthorized_voice', 'unlicensed_sample', 'missing_commercial_rights',
  'incorrect_creation_credit', 'spam_or_duplicate', 'fake_engagement', 'impersonation'
]);
const RELEASE_REPORT_OUTCOMES = new Set(['dismissed', 'escalated', 'resolved']);
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

function normalizeCreationDisclosure(input: {
  lyricsAuthorship?: string | null;
  compositionAuthorship?: string | null;
  vocalPerformance?: string | null;
  productionMethod?: string | null;
  lyricsExcerpt?: string | null;
}) {
  const lyricsAuthorship = (input.lyricsAuthorship ?? '').trim().toLowerCase();
  const compositionAuthorship = (input.compositionAuthorship ?? '').trim().toLowerCase();
  const vocalPerformance = (input.vocalPerformance ?? '').trim().toLowerCase();
  const productionMethod = (input.productionMethod ?? '').trim().toLowerCase();
  if (!LYRICS_AUTHORSHIP.has(lyricsAuthorship) || lyricsAuthorship === 'not_declared') {
    throw new Error('Choose how the lyrics were authored.');
  }
  if (!COMPOSITION_AUTHORSHIP.has(compositionAuthorship) || compositionAuthorship === 'not_declared') {
    throw new Error('Choose how the musical composition was authored.');
  }
  if (!VOCAL_PERFORMANCE.has(vocalPerformance) || vocalPerformance === 'not_declared') {
    throw new Error('Choose how the vocal or featured performance was made.');
  }
  if (!PRODUCTION_METHOD.has(productionMethod) || productionMethod === 'not_declared') {
    throw new Error('Choose how the recording was produced.');
  }
  const lyricsExcerpt = optionalReleaseText(input.lyricsExcerpt, 'Lyric excerpt', 500);
  if (lyricsAuthorship === 'instrumental' && lyricsExcerpt) {
    throw new Error('An instrumental recording cannot publish a lyric excerpt.');
  }
  return { lyricsAuthorship, compositionAuthorship, vocalPerformance, productionMethod, lyricsExcerpt };
}

function requiresSyntheticRightsDisclosure(recording: {
  lyricsAuthorship: string;
  compositionAuthorship: string;
  vocalPerformance: string;
  productionMethod: string;
}) {
  return ['human_ai_assisted', 'generated'].includes(recording.lyricsAuthorship)
    || ['human_ai_assisted', 'generated'].includes(recording.compositionAuthorship)
    || ['virtual_original', 'licensed_replica', 'mixed'].includes(recording.vocalPerformance)
    || ['ai_assisted', 'generated', 'mixed'].includes(recording.productionMethod);
}

function buildPublicCreationDetails(recording: {
  lyricsAuthorship: string;
  compositionAuthorship: string;
  vocalPerformance: string;
  productionMethod: string;
}) {
  const publicTags: string[] = [];
  const howMade: string[] = [];
  if (recording.lyricsAuthorship === 'human') publicTags.push('Human-written lyrics');
  if (recording.lyricsAuthorship === 'human_ai_assisted') publicTags.push('Human-led lyrics');
  if (recording.lyricsAuthorship === 'generated') publicTags.push('Generated lyrics');
  if (recording.lyricsAuthorship === 'instrumental') publicTags.push('Instrumental');
  if (recording.vocalPerformance === 'virtual_original') publicTags.push('Original virtual artist');
  if (recording.vocalPerformance === 'licensed_replica') publicTags.push('Licensed synthetic voice');

  const compositionLabels: Record<string, string> = {
    human: 'Human-composed music',
    human_ai_assisted: 'Human-led composition with generative assistance',
    generated: 'Generated musical composition'
  };
  const performanceLabels: Record<string, string> = {
    human: 'Human performance',
    virtual_original: 'Original virtual performance',
    licensed_replica: 'Licensed synthetic voice performance',
    mixed: 'Mixed human and virtual performance',
    instrumental: 'Instrumental performance'
  };
  const productionLabels: Record<string, string> = {
    human: 'Human production',
    ai_assisted: 'AI-assisted production',
    generated: 'Generative production',
    mixed: 'Mixed human and generative production'
  };
  if (compositionLabels[recording.compositionAuthorship]) howMade.push(compositionLabels[recording.compositionAuthorship]);
  if (performanceLabels[recording.vocalPerformance]) howMade.push(performanceLabels[recording.vocalPerformance]);
  if (productionLabels[recording.productionMethod]) howMade.push(productionLabels[recording.productionMethod]);

  const fullyGenerated = recording.lyricsAuthorship === 'generated'
    && recording.compositionAuthorship === 'generated'
    && ['virtual_original', 'licensed_replica'].includes(recording.vocalPerformance)
    && recording.productionMethod === 'generated';
  return { publicTags, howMade, fullyGenerated };
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
  lyricsAuthorship?: string | null;
  compositionAuthorship?: string | null;
  vocalPerformance?: string | null;
  productionMethod?: string | null;
  lyricsExcerpt?: string | null;
}) {
  const title = requiredReleaseText(input.title, 'Track title');
  const versionTitle = optionalReleaseText(input.versionTitle, 'Version title');
  const primaryArtistName = requiredReleaseText(input.primaryArtistName, 'Primary artist');
  const isrc = optionalReleaseText(input.isrc, 'ISRC', 12)?.toUpperCase() ?? null;
  const languageCode = optionalReleaseText(input.languageCode, 'Language code', 3)?.toLowerCase() ?? null;
  const originalReleaseDate = optionalReleaseText(input.originalReleaseDate, 'Original release date', 10);
  const credits = normalizeCredits(input.credits);
  const creation = normalizeCreationDisclosure(input);
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
    credits,
    ...creation
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
  recordings: Array<{
    recordingId: string;
    masterAssetVersionId: string | null;
    title: string;
    languageCode: string | null;
    lyricsAuthorship: string;
    compositionAuthorship: string;
    vocalPerformance: string;
    productionMethod: string;
  }>;
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
    if (recording.lyricsAuthorship === 'not_declared') metadataIssues.push(`${recording.title}: declare how the lyrics were authored.`);
    if (recording.compositionAuthorship === 'not_declared') metadataIssues.push(`${recording.title}: declare how the musical composition was authored.`);
    if (recording.vocalPerformance === 'not_declared') metadataIssues.push(`${recording.title}: declare how the vocal or featured performance was made.`);
    if (recording.productionMethod === 'not_declared') metadataIssues.push(`${recording.title}: declare how the recording was produced.`);
    if (['human', 'human_ai_assisted'].includes(recording.lyricsAuthorship)
      && !recordingCredits.some((credit) => credit.role === 'songwriter')) {
      metadataIssues.push(`${recording.title}: human-written lyrics require a songwriter credit.`);
    }
    for (const declarationType of REQUIRED_RECORDING_RIGHTS) {
      if (latestDeclarationByScope.get(`${recording.recordingId}:${declarationType}`)?.outcome !== 'verified') {
        rightsIssues.push(`${recording.title}: verified ${declarationType.replaceAll('_', ' ')} rights evidence is required.`);
      }
    }
    if (requiresSyntheticRightsDisclosure(recording)
      && latestDeclarationByScope.get(`${recording.recordingId}:ai_disclosure`)?.outcome !== 'verified') {
      rightsIssues.push(`${recording.title}: verified commercial-use evidence for synthetic performance or generative production is required.`);
    }
    if (recording.vocalPerformance === 'licensed_replica'
      && latestDeclarationByScope.get(`${recording.recordingId}:performer_consent`)?.outcome !== 'verified') {
      rightsIssues.push(`${recording.title}: verified consent from the replicated performer is required.`);
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
    ...recordings
      .filter(requiresSyntheticRightsDisclosure)
      .map((recording) => `${recording.recordingId}:ai_disclosure`),
    ...recordings
      .filter((recording) => recording.vocalPerformance === 'licensed_replica')
      .map((recording) => `${recording.recordingId}:performer_consent`),
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
  env?: NodeJS.ProcessEnv;
}) {
  const { db, store } = config;
  const storagePolicy = createAudioStoragePolicy({
    workspaceLimitBytes: config.workspaceLimitBytes,
    workingObjectLimit: config.workingObjectLimit,
    env: config.env
  });

  function sessionObjectIdentity(session: {
    storageProvider: string;
    storageBucket: string;
    storageKey: string;
    providerUploadId: string;
  }): AudioObjectIdentity {
    return {
      storageProvider: parseAudioStorageProvider(session.storageProvider),
      storageBucket: session.storageBucket,
      storageKey: session.storageKey,
      providerUploadId: session.providerUploadId
    };
  }

  async function discardUnsealedUpload(
    identity: AudioObjectIdentity,
    executor: Pick<SwayDb, 'execute'> = db
  ) {
    const sealed = await executor.execute(sql<{ id: string }>`
      select id
      from audio_project_asset_versions
      where storage_provider = ${identity.storageProvider}
        and storage_bucket = ${identity.storageBucket}
        and storage_key = ${identity.storageKey}
        and original_preserved = true
        and sealed_at is not null
      limit 1
    `);
    if (sealed.rows.length > 0) {
      throw new Error('Refusing to discard an object referenced by a sealed preserved asset version.');
    }
    const discardUpload = store.discardUpload ?? store.abortUpload;
    await discardUpload.call(store, identity);
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
      if (!version.mimeType.startsWith('audio/')) {
        throw new Error('Release recording masters must be declared audio media.');
      }
      if (version.byteSize > MAX_RELEASE_MASTER_BYTES) {
        throw new Error(`Release recording masters may not exceed ${MAX_RELEASE_MASTER_BYTES} bytes each.`);
      }
      if (['audio/wav', 'audio/x-wav', 'audio/aiff', 'audio/x-aiff'].includes(version.mimeType)) {
        const prefixObject = await openExactOriginal();
        const prefix = await readStreamPrefix(prefixObject.stream, 12);
        if (prefix.byteLength < 12) throw new Error('Release master container header is incomplete.');
        const declaredSize = version.mimeType.includes('aiff')
          ? prefix.readUInt32BE(4) + 8
          : prefix.readUInt32LE(4) + 8;
        if (declaredSize !== version.byteSize) {
          throw new Error('Release master must end exactly at its declared RIFF/FORM container boundary.');
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
          throw new Error(
            'Release master did not parse as complete playable audio matching its declared MIME type.',
            { cause }
          );
        }
        const duration = metadata.format.duration;
        const container = metadata.format.container ?? '';
        if (!audioContainerMatchesMime(version.mimeType, container)
          || !metadata.format.codec
          || !Number.isFinite(duration)
          || (duration ?? 0) <= 0
          || (metadata.format.sampleRate ?? 0) <= 0
          || (metadata.format.numberOfChannels ?? 0) <= 0) {
          throw new Error('Release master did not parse as complete playable audio matching its declared MIME type.');
        }
        return {
          assetVersionId: version.id,
          validatorKey: RELEASE_PACKAGE_VALIDATOR_KEY,
          roleKind,
          container,
          codec: metadata.format.codec,
          durationSeconds: duration,
          sampleRateHz: metadata.format.sampleRate,
          channelCount: metadata.format.numberOfChannels
        };
      } finally {
        if (!opened.stream.destroyed) opened.stream.destroy();
      }
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

    let objectIdentity: AudioObjectIdentity | null = null;
    try {
      return await db.transaction(async (tx) => {
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

        const [existing] = await tx
          .select()
          .from(audioUploadSessions)
          .where(and(
            eq(audioUploadSessions.projectId, input.projectId),
            eq(audioUploadSessions.idempotencyKey, idempotencyKey)
          ))
          .limit(1);
        if (existing) return existing;

        const workspaceUsage = await loadAudioStorageUsage(tx, storagePolicy, {
          performerId: project.performerId
        });
        assertAudioWorkingObjectAvailable(workspaceUsage);
        assertAudioStorageReservationAvailable(workspaceUsage, input.expectedByteSize);

        const [asset] = await tx.insert(audioAssets).values({
          projectId: input.projectId,
          createdByUserId: input.actorUserId,
          title: input.title.trim() || input.originalFilename,
          assetKind: uploadType.assetKind,
          provenanceType: 'user_upload',
          status: 'active'
        }).returning();

        const uploadSessionId = randomUUID();
        objectIdentity = await store.beginUpload({
          projectId: input.projectId,
          uploadSessionId,
          filename: input.originalFilename,
          mimeType: uploadType.mimeType
        });
        if (!objectIdentity.providerUploadId) {
          throw new Error('Audio object store did not return a multipart upload ID.');
        }

        const [session] = await tx.insert(audioUploadSessions).values({
          id: uploadSessionId,
          projectId: input.projectId,
          assetId: asset.id,
          initiatedByUserId: input.actorUserId,
          idempotencyKey,
          storageProvider: objectIdentity.storageProvider,
          storageBucket: objectIdentity.storageBucket,
          providerUploadId: objectIdentity.providerUploadId!,
          storageKey: objectIdentity.storageKey,
          originalFilename: input.originalFilename,
          expectedMimeType: uploadType.mimeType,
          expectedByteSize: input.expectedByteSize,
          expectedSha256,
          partSizeBytes,
          uploadStatus: 'initiated',
          expiresAt: new Date(Date.now() + UPLOAD_TTL_MS)
        }).returning();

        return session;
      });
    } catch (error) {
      if (objectIdentity) {
        try {
          await store.abortUpload(objectIdentity);
        } catch (abortError) {
          console.error('[sway.audio] failed to abort orphaned provider upload:', abortError);
        }
      }
      throw error;
    }
  }

  async function writeUploadPart(input: {
    uploadSessionId: string;
    actorUserId: string;
    partNumber: number;
    body: Buffer;
  }) {
    if (!Number.isSafeInteger(input.partNumber) || input.partNumber < 1) {
      throw new Error('partNumber must be a positive integer.');
    }
    if (!Buffer.isBuffer(input.body) || input.body.length === 0) {
      throw new Error('Upload part body must contain bytes.');
    }
    const [session] = await db
      .select()
      .from(audioUploadSessions)
      .where(eq(audioUploadSessions.id, input.uploadSessionId))
      .limit(1);
    if (!session) throw new Error('Upload session not found.');
    if (session.expiresAt.getTime() <= Date.now()) throw new Error('Upload session expired.');
    if (!['initiated', 'uploading'].includes(session.uploadStatus)) {
      throw new Error(`Upload session is ${session.uploadStatus} and cannot accept parts.`);
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

    const access = await requireProjectAccess({
      projectId: session.projectId,
      userId: input.actorUserId,
      needUpload: true
    });
    if (!access) throw new Error('Upload permission required.');

    if (input.partNumber === 1) {
      const [asset] = await db
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
      const [firstPart] = await db
        .select({ id: audioUploadParts.id })
        .from(audioUploadParts)
        .where(and(
          eq(audioUploadParts.uploadSessionId, session.id),
          eq(audioUploadParts.partNumber, 1)
        ))
        .limit(1);
      if (!firstPart) throw new Error('Upload part 1 must pass file-signature validation before later parts.');
    }

    const written = await store.writePart({
      identity: sessionObjectIdentity(session),
      partNumber: input.partNumber,
      body: input.body
    });

    await db
      .insert(audioUploadParts)
      .values({
        uploadSessionId: session.id,
        partNumber: input.partNumber,
        byteSize: written.byteSize,
        providerEtag: written.etag,
        providerChecksum: written.checksum
      })
      .onConflictDoNothing();

    if (session.uploadStatus === 'initiated') {
      await db
        .update(audioUploadSessions)
        .set({ uploadStatus: 'uploading', updatedAt: new Date() })
        .where(eq(audioUploadSessions.id, session.id));
    }

    return written;
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
      const outcome = await db.transaction(async (tx) => {
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

        try {
          await discardUnsealedUpload(sessionObjectIdentity(session), tx);
        } catch (error) {
          return {
            kind: 'failed' as const,
            uploadSessionId: session.id,
            error: error instanceof Error ? error.message : 'Object-store upload discard failed.'
          };
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
        if (!terminal) return { kind: 'skipped' as const };

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
      });

      if (outcome.kind === 'expired') expiredSessionIds.push(outcome.uploadSessionId);
      if (outcome.kind === 'stale_aborted') staleAbortedSessionIds.push(outcome.uploadSessionId);
      if (outcome.kind === 'failed') failures.push({
        uploadSessionId: outcome.uploadSessionId,
        error: outcome.error
      });
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

    const access = await requireProjectAccess({
      projectId: accessSession.projectId,
      userId: input.actorUserId,
      needUpload: true
    });
    if (!access) throw new Error('Upload permission required.');

    const outcome = await db.transaction(async (tx) => {
      // Cleanup locks this same row before provider deletion. Holding the lock
      // through assembly and the immutable version insert makes "check then
      // delete" and "seal then delete" mutually exclusive across instances.
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

      let assembled: { byteSize: number; sha256: string };
      try {
        assembled = await store.assembleParts({
          identity: sessionObjectIdentity(session),
          parts: parts.map((part) => ({
            partNumber: part.partNumber,
            etag: part.providerEtag
          })),
          expectedByteSize: session.expectedByteSize,
          expectedSha256: session.expectedSha256,
          mimeType: session.expectedMimeType
        });
      } catch (error) {
        const objectIdentity = sessionObjectIdentity(session);
        let providerDiscardSucceeded = false;
        let providerDiscardError: string | null = null;
        try {
          await discardUnsealedUpload(objectIdentity, tx);
          providerDiscardSucceeded = true;
        } catch (cleanupError) {
          providerDiscardError = cleanupError instanceof Error
            ? cleanupError.message
            : 'Unknown object-store discard failure.';
          console.error('[sway.audio] integrity failure cleanup could not discard provider upload:', {
            uploadSessionId: session.id,
            storageProvider: session.storageProvider,
            providerDiscardError
          });
        }
        const quarantinedAt = new Date();
        await tx
          .update(audioUploadSessions)
          .set({ uploadStatus: 'quarantined', updatedAt: quarantinedAt })
          .where(eq(audioUploadSessions.id, session.id));
        await tx.insert(auditEvents).values({
          actorType: 'performer',
          actorId: input.actorUserId,
          entityType: 'audio_upload_session',
          entityId: session.id,
          eventType: 'audio_upload_session.integrity_failed',
          previousStatus: 'verifying',
          nextStatus: 'quarantined',
          metadata: {
            expectedByteSize: session.expectedByteSize,
            expectedSha256: session.expectedSha256,
            integrityError: error instanceof Error ? error.message : 'Unknown upload integrity failure.',
            providerCleanupMethod: store.discardUpload ? 'discardUpload' : 'abortUpload',
            providerDiscardSucceeded,
            providerDiscardError
          }
        });
        return { kind: 'failed' as const, error };
      }

      const [{ nextVersion }] = await tx
        .select({
          nextVersion: sql<number>`coalesce(max(${audioProjectAssetVersions.versionNumber}), 0) + 1`
        })
        .from(audioProjectAssetVersions)
        .where(eq(audioProjectAssetVersions.assetId, session.assetId!));

      const verifiedAt = new Date();
      await tx
        .update(audioUploadSessions)
        .set({
          uploadStatus: 'completed',
          completedAt: verifiedAt,
          updatedAt: verifiedAt
        })
        .where(eq(audioUploadSessions.id, session.id));

      const [version] = await tx.insert(audioProjectAssetVersions).values({
        projectId: session.projectId,
        performerId: input.performerId,
        assetId: session.assetId!,
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
          partCount: parts.length,
          verifier: `sway.${store.provider}.sha256`
        },
        originalPreserved: true,
        sealedAt: verifiedAt
      }).returning();

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

      return { kind: 'sealed' as const, version };
    });

    if (outcome.kind === 'failed') throw outcome.error;
    return outcome.version;
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
        lyricsAuthorship: musicRecordings.lyricsAuthorship,
        compositionAuthorship: musicRecordings.compositionAuthorship,
        vocalPerformance: musicRecordings.vocalPerformance,
        productionMethod: musicRecordings.productionMethod,
        lyricsExcerpt: musicRecordings.lyricsExcerpt,
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
    songwriterName: string;
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
    lyricsAuthorship?: string | null;
    compositionAuthorship?: string | null;
    vocalPerformance?: string | null;
    productionMethod?: string | null;
    lyricsExcerpt?: string | null;
  }) {
    if (!UUID_PATTERN.test(input.clientReleaseId)) throw new Error('clientReleaseId must be a UUID.');
    if (!RELEASE_TYPES.has(input.releaseType)) throw new Error('Release type is invalid.');

    const title = requiredReleaseText(input.title, 'Release title');
    const trackTitle = requiredReleaseText(input.trackTitle, 'Track title');
    const primaryArtistName = requiredReleaseText(input.primaryArtistName, 'Primary artist');
    const songwriterName = requiredReleaseText(input.songwriterName, 'Songwriter credit name', 160);
    const versionTitle = optionalReleaseText(input.versionTitle, 'Version title');
    const labelName = optionalReleaseText(input.labelName, 'Label name');
    const pLine = optionalReleaseText(input.pLine, 'P line');
    const cLine = optionalReleaseText(input.cLine, 'C line');
    const upc = optionalReleaseText(input.upc, 'UPC', 14);
    const isrc = optionalReleaseText(input.isrc, 'ISRC', 12)?.toUpperCase() ?? null;
    const languageCode = optionalReleaseText(input.languageCode, 'Language code', 3)?.toLowerCase() ?? null;
    const originalReleaseDate = optionalReleaseText(input.originalReleaseDate, 'Original release date', 10);
    const territories = normalizeTerritories(input.territories);
    const creation = normalizeCreationDisclosure(input);
    const writingCreditRole = creation.lyricsAuthorship === 'instrumental' ? 'composer' : 'songwriter';

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
        ...creation,
        rightsStatus: 'draft',
        metadata: { masterSha256: master.sha256 }
      }).returning();

      await tx.insert(musicReleaseRecordings).values({
        releaseId: release.id,
        recordingId: recording.id,
        discNumber: 1,
        trackNumber: 1
      });

      await tx.insert(musicRecordingCredits).values([
        { recordingId: recording.id, displayName: primaryArtistName, role: 'primary_artist', sequence: 0 },
        { recordingId: recording.id, displayName: songwriterName, role: writingCreditRole, sequence: 1 }
      ]);

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
          metadata: {
            releaseId: release.id,
            masterAssetVersionId: master.id,
            masterSha256: master.sha256,
            lyricsAuthorship: creation.lyricsAuthorship,
            vocalPerformance: creation.vocalPerformance,
            writingCreditRole
          }
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
    lyricsAuthorship?: string | null;
    compositionAuthorship?: string | null;
    vocalPerformance?: string | null;
    productionMethod?: string | null;
    lyricsExcerpt?: string | null;
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
    const creation = normalizeCreationDisclosure(input);
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
        ...creation,
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
          artworkAssetVersionId,
          creationDisclosure: creation
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
    lyricsAuthorship?: string | null;
    compositionAuthorship?: string | null;
    vocalPerformance?: string | null;
    productionMethod?: string | null;
    lyricsExcerpt?: string | null;
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
        lyricsAuthorship: normalized.lyricsAuthorship,
        compositionAuthorship: normalized.compositionAuthorship,
        vocalPerformance: normalized.vocalPerformance,
        productionMethod: normalized.productionMethod,
        lyricsExcerpt: normalized.lyricsExcerpt,
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
    lyricsAuthorship?: string | null;
    compositionAuthorship?: string | null;
    vocalPerformance?: string | null;
    productionMethod?: string | null;
    lyricsExcerpt?: string | null;
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
        lyricsAuthorship: normalized.lyricsAuthorship,
        compositionAuthorship: normalized.compositionAuthorship,
        vocalPerformance: normalized.vocalPerformance,
        productionMethod: normalized.productionMethod,
        lyricsExcerpt: normalized.lyricsExcerpt,
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
          lyricsAuthorship: normalized.lyricsAuthorship,
          vocalPerformance: normalized.vocalPerformance,
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

  async function createReleaseReport(input: {
    releaseId: string;
    reporterUserId: string;
    reason: string;
    details: string;
  }) {
    const reason = input.reason.trim().toLowerCase();
    if (!RELEASE_REPORT_REASONS.has(reason)) {
      throw new Error('Choose a concrete rights, credit, identity, or manipulation concern. AI use by itself is not reportable.');
    }
    const details = requiredReleaseText(input.details, 'Report evidence', 2000);
    if (details.length < 40) throw new Error('Report evidence must be at least 40 characters so reviewers can investigate it.');
    const [release] = await db
      .select({
        id: musicReleases.id,
        status: musicReleases.status,
        distributionMode: musicReleases.distributionMode,
        ownerUserId: performers.ownerUserId
      })
      .from(musicReleases)
      .innerJoin(performers, eq(performers.id, musicReleases.performerId))
      .where(eq(musicReleases.id, input.releaseId))
      .limit(1);
    if (!release || release.distributionMode === 'private' || !['ready', 'scheduled', 'published'].includes(release.status)) {
      throw new Error('Public release not found.');
    }
    if (release.ownerUserId === input.reporterUserId) throw new Error('Release owners cannot report their own release.');

    return db.transaction(async (tx) => {
      const [report] = await tx.insert(musicReleaseReports).values({
        releaseId: release.id,
        reporterUserId: input.reporterUserId,
        reason,
        details,
        status: 'pending'
      }).onConflictDoNothing().returning();
      if (!report) throw new Error('You already have an active report for this release and reason.');
      await tx.insert(musicReleaseReportEvents).values({
        reportId: report.id,
        actorUserId: input.reporterUserId,
        eventType: 'submitted',
        note: details,
        metadata: { source: 'public_release', automaticReleaseAction: false }
      });
      await writeAudit(tx, {
        actorType: 'account',
        actorId: input.reporterUserId,
        entityType: 'music_release_report',
        entityId: report.id,
        eventType: 'music_release.report_submitted',
        metadata: { releaseId: release.id, reason, automaticReleaseAction: false }
      });
      return report;
    });
  }

  async function listReleaseReports(input: { status?: string | null } = {}) {
    const status = input.status?.trim().toLowerCase() || null;
    if (status && !['pending', 'dismissed', 'escalated', 'resolved'].includes(status)) {
      throw new Error('Release report status filter is invalid.');
    }
    const rows = await db
      .select({
        id: musicReleaseReports.id,
        releaseId: musicReleaseReports.releaseId,
        releaseTitle: musicReleases.title,
        primaryArtistName: musicReleases.primaryArtistName,
        reason: musicReleaseReports.reason,
        details: musicReleaseReports.details,
        status: musicReleaseReports.status,
        reporterUserId: musicReleaseReports.reporterUserId,
        reporterDisplayName: users.displayName,
        reporterEmail: users.email,
        createdAt: musicReleaseReports.createdAt,
        updatedAt: musicReleaseReports.updatedAt
      })
      .from(musicReleaseReports)
      .innerJoin(musicReleases, eq(musicReleases.id, musicReleaseReports.releaseId))
      .innerJoin(users, eq(users.id, musicReleaseReports.reporterUserId))
      .where(status ? eq(musicReleaseReports.status, status) : undefined)
      .orderBy(desc(musicReleaseReports.createdAt));
    const events = await db
      .select({
        reportId: musicReleaseReportEvents.reportId,
        actorUserId: musicReleaseReportEvents.actorUserId,
        eventType: musicReleaseReportEvents.eventType,
        note: musicReleaseReportEvents.note,
        createdAt: musicReleaseReportEvents.createdAt
      })
      .from(musicReleaseReportEvents)
      .orderBy(asc(musicReleaseReportEvents.createdAt));
    return rows.map((report) => ({
      ...report,
      releasePath: `/r/${report.releaseId}`,
      events: events.filter((event) => event.reportId === report.id)
    }));
  }

  async function reviewReleaseReport(input: {
    reportId: string;
    actorUserId: string;
    outcome: string;
    note: string;
  }) {
    const outcome = input.outcome.trim().toLowerCase();
    if (!RELEASE_REPORT_OUTCOMES.has(outcome)) throw new Error('Release report outcome is invalid.');
    const note = requiredReleaseText(input.note, 'Review note', 2000);
    if (note.length < 20) throw new Error('Review note must be at least 20 characters and explain the evidence-based outcome.');
    const [current] = await db.select().from(musicReleaseReports).where(eq(musicReleaseReports.id, input.reportId)).limit(1);
    if (!current) throw new Error('Release report not found.');
    if (!['pending', 'escalated'].includes(current.status)) throw new Error('Release report already has a final outcome.');
    if (current.status === outcome) throw new Error(`Release report is already ${outcome}.`);

    return db.transaction(async (tx) => {
      const [report] = await tx.update(musicReleaseReports).set({
        status: outcome,
        updatedAt: new Date()
      }).where(and(
        eq(musicReleaseReports.id, current.id),
        eq(musicReleaseReports.status, current.status)
      )).returning();
      if (!report) throw new Error('Release report changed before this review was saved.');
      const [event] = await tx.insert(musicReleaseReportEvents).values({
        reportId: report.id,
        actorUserId: input.actorUserId,
        eventType: outcome,
        note,
        metadata: { automaticReleaseAction: false }
      }).returning();
      await writeAudit(tx, {
        actorType: 'account',
        actorId: input.actorUserId,
        entityType: 'music_release_report',
        entityId: report.id,
        eventType: `music_release.report_${outcome}`,
        metadata: {
          releaseId: report.releaseId,
          previousStatus: current.status,
          automaticReleaseAction: false
        }
      });
      return { report, event };
    });
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
      lyricsAuthorship: musicRecordings.lyricsAuthorship,
      compositionAuthorship: musicRecordings.compositionAuthorship,
      vocalPerformance: musicRecordings.vocalPerformance,
      productionMethod: musicRecordings.productionMethod,
      lyricsExcerpt: musicRecordings.lyricsExcerpt,
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
    const publicRecordings = recordings.map((recording) => {
      const creation = buildPublicCreationDetails(recording);
      return {
        ...recording,
        creation,
        credits: credits.filter((credit) => credit.recordingId === recording.recordingId)
      };
    });
    const creationTags = [...new Set([
      ...publicRecordings.flatMap((recording) => recording.creation.publicTags),
      'Rights checked'
    ])];
    return {
      ...release,
      status: release.status === 'published' && !providerConfirmedLive ? 'ready' : release.status,
      artworkUrl: release.artworkAssetVersionId ? `/api/public/releases/${release.id}/artwork` : null,
      releasePath: `/r/${release.id}`,
      creationTags,
      humanWrittenLyrics: publicRecordings.some((recording) => recording.lyricsAuthorship === 'human'),
      originalVirtualArtist: publicRecordings.some((recording) => recording.vocalPerformance === 'virtual_original'),
      fullyGenerated: publicRecordings.length > 0 && publicRecordings.every((recording) => recording.creation.fullyGenerated),
      recordings: publicRecordings,
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
    initiateUpload,
    writeUploadPart,
    completeAndSealUpload,
    validateReleasePackageAsset,
    expireStaleUploadSessions,
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
    createReleaseReport,
    listReleaseReports,
    reviewReleaseReport,
    getPublicRelease,
    openPublicReleaseArtwork,
    downloadSharedOriginal
  };
}

export type AudioPublishingService = ReturnType<typeof createAudioPublishingService>;
