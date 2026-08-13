import { TextDecoder } from 'node:util';
import { sql } from 'drizzle-orm';
import type { SwayDb } from '../db/client';

export const DEFAULT_AUDIO_WORKSPACE_LIMIT_BYTES = 5368709120;
export const AUDIO_WORKSPACE_LIMIT_ENV = 'SWAY_AUDIO_WORKSPACE_LIMIT_BYTES';
export const DEFAULT_AUDIO_WORKING_OBJECT_LIMIT = 10_000;
export const AUDIO_WORKING_OBJECT_LIMIT_ENV = 'SWAY_AUDIO_WORKING_OBJECT_LIMIT';

export const ACTIVE_AUDIO_UPLOAD_RESERVATION_STATUSES = [
  'initiated',
  'uploading',
  'uploaded',
  'verifying',
  'quarantined'
] as const;

export const EXPIRABLE_AUDIO_UPLOAD_STATUSES = [
  'initiated',
  'uploading',
  'uploaded',
  'verifying',
  'quarantined'
] as const;

export type AudioStoragePolicy = Readonly<{
  workspaceLimitBytes: number;
  workingObjectLimit: number;
  releaseCountLimit: null;
}>;

export type AudioStorageUsage = {
  workspaceLimitBytes: number;
  workingBytes: number;
  sealedWorkingBytes: number;
  reservedBytes: number;
  releaseProtectedBytes: number;
  availableWorkspaceBytes: number;
  workingObjectCount: number;
  workingObjectLimit: number;
  releaseCountLimit: null;
};

type AudioStorageQueryExecutor = Pick<SwayDb, 'execute'>;

type AudioStorageUsageRow = {
  sealed_working_bytes: string;
  release_protected_bytes: string;
  reserved_bytes: string;
  sealed_working_object_count: string;
  reserved_object_count: string;
};

export class AudioStorageQuotaError extends Error {
  readonly code = 'audio_workspace_limit_exceeded';
  readonly workspaceLimitBytes: number;
  readonly workingBytes: number;
  readonly requestedBytes: number;
  readonly availableWorkspaceBytes: number;

  constructor(input: {
    workspaceLimitBytes: number;
    workingBytes: number;
    requestedBytes: number;
    availableWorkspaceBytes: number;
  }) {
    super(
      `Audio working storage limit exceeded: ${input.requestedBytes} requested bytes, `
      + `${input.availableWorkspaceBytes} available of ${input.workspaceLimitBytes}.`
    );
    this.name = 'AudioStorageQuotaError';
    this.workspaceLimitBytes = input.workspaceLimitBytes;
    this.workingBytes = input.workingBytes;
    this.requestedBytes = input.requestedBytes;
    this.availableWorkspaceBytes = input.availableWorkspaceBytes;
  }
}

export class AudioStorageObjectLimitError extends Error {
  readonly code = 'audio_working_object_limit_exceeded';
  readonly workingObjectCount: number;
  readonly workingObjectLimit: number;

  constructor(input: { workingObjectCount: number; workingObjectLimit: number }) {
    super(
      `Audio working object limit exceeded: ${input.workingObjectCount} of `
      + `${input.workingObjectLimit} working objects are already retained.`
    );
    this.name = 'AudioStorageObjectLimitError';
    this.workingObjectCount = input.workingObjectCount;
    this.workingObjectLimit = input.workingObjectLimit;
  }
}

function parsePositiveLimit(value: unknown, source: string, unit: string) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${source} must be a positive safe integer ${unit}.`);
    }
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!/^[1-9][0-9]*$/.test(normalized)) {
      throw new Error(`${source} must be a positive base-10 integer ${unit}.`);
    }
    const parsed = Number(normalized);
    if (!Number.isSafeInteger(parsed)) {
      throw new Error(`${source} must not exceed Number.MAX_SAFE_INTEGER bytes.`);
    }
    return parsed;
  }
  throw new Error(`${source} must be a positive safe integer ${unit}.`);
}

export function createAudioStoragePolicy(input: {
  workspaceLimitBytes?: number;
  workingObjectLimit?: number;
  env?: NodeJS.ProcessEnv;
} = {}): AudioStoragePolicy {
  const env = input.env ?? process.env;
  const configured = input.workspaceLimitBytes ?? env[AUDIO_WORKSPACE_LIMIT_ENV]?.trim();
  const workspaceLimitBytes = configured == null || configured === ''
    ? DEFAULT_AUDIO_WORKSPACE_LIMIT_BYTES
    : parsePositiveLimit(
        configured,
        input.workspaceLimitBytes == null ? AUDIO_WORKSPACE_LIMIT_ENV : 'workspaceLimitBytes',
        'number of bytes'
      );
  const configuredObjectLimit = input.workingObjectLimit ?? env[AUDIO_WORKING_OBJECT_LIMIT_ENV]?.trim();
  const workingObjectLimit = configuredObjectLimit == null || configuredObjectLimit === ''
    ? DEFAULT_AUDIO_WORKING_OBJECT_LIMIT
    : parsePositiveLimit(
        configuredObjectLimit,
        input.workingObjectLimit == null ? AUDIO_WORKING_OBJECT_LIMIT_ENV : 'workingObjectLimit',
        'object count'
      );
  return Object.freeze({
    workspaceLimitBytes,
    workingObjectLimit,
    releaseCountLimit: null
  });
}

export async function lockAudioStorageForPerformer(
  executor: AudioStorageQueryExecutor,
  performerId: string
) {
  const lockKey = `audio-storage:${performerId}`;
  const result = await executor.execute(sql<{ transaction_marker: string | null }>`
    select
      current_setting('sway.audio_storage_performer_transaction', true) as transaction_marker,
      pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
  `);
  const row = result.rows[0] as { transaction_marker: string | null } | undefined;
  if (row?.transaction_marker !== performerId) {
    throw new Error('Audio storage performer lock requires an explicit marked database transaction.');
  }
}

function safeByteCount(value: string | number | bigint | null | undefined, label: string) {
  const parsed = BigInt(value ?? 0);
  if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} is outside the supported safe-integer byte range.`);
  }
  return Number(parsed);
}

export async function loadAudioStorageUsage(
  executor: AudioStorageQueryExecutor,
  policy: AudioStoragePolicy,
  input: { performerId: string }
): Promise<AudioStorageUsage> {
  const result = await executor.execute(sql<AudioStorageUsageRow>`
    with protected_versions as materialized (
      select distinct version.id as asset_version_id
      from music_release_storage_manifests manifest
      cross join lateral jsonb_array_elements(manifest.assets) manifest_asset
      inner join audio_project_asset_versions version
        on version.id = (manifest_asset->>'assetVersionId')::uuid
        and version.performer_id = manifest.performer_id
        and version.sha256 = manifest_asset->>'sha256'
        and version.byte_size = (manifest_asset->>'byteSize')::bigint
        and version.sealed_at is not null
        and version.original_preserved = true
        and version.integrity_status = 'verified'
      where manifest.performer_id = ${input.performerId}
    ), sealed_usage as (
      select
        coalesce(sum(version.byte_size) filter (where protected.asset_version_id is null), 0)::text
          as sealed_working_bytes,
        coalesce(sum(version.byte_size) filter (where protected.asset_version_id is not null), 0)::text
          as release_protected_bytes,
        count(version.id) filter (where protected.asset_version_id is null)::text
          as sealed_working_object_count
      from audio_project_asset_versions version
      left join protected_versions protected on protected.asset_version_id = version.id
      where version.performer_id = ${input.performerId}
        and version.sealed_at is not null
        and version.original_preserved = true
    ), reservation_usage as (
      select
        coalesce(sum(upload.expected_byte_size), 0)::text as reserved_bytes,
        count(upload.id)::text as reserved_object_count
      from audio_upload_sessions upload
      inner join audio_projects project on project.id = upload.project_id
      where project.performer_id = ${input.performerId}
        and upload.upload_status in (${sql.join(ACTIVE_AUDIO_UPLOAD_RESERVATION_STATUSES.map((status) => sql`${status}`), sql`, `)})
    )
    select
      sealed_usage.sealed_working_bytes,
      sealed_usage.release_protected_bytes,
      reservation_usage.reserved_bytes,
      sealed_usage.sealed_working_object_count,
      reservation_usage.reserved_object_count
    from sealed_usage
    cross join reservation_usage
  `);
  const row = result.rows[0] as AudioStorageUsageRow | undefined;
  if (!row) throw new Error('Audio storage usage query returned no result.');

  const sealedWorkingBytes = safeByteCount(row.sealed_working_bytes, 'sealedWorkingBytes');
  const releaseProtectedBytes = safeByteCount(row.release_protected_bytes, 'releaseProtectedBytes');
  const reservedBytes = safeByteCount(row.reserved_bytes, 'reservedBytes');
  const sealedWorkingObjectCount = safeByteCount(
    row.sealed_working_object_count,
    'sealedWorkingObjectCount'
  );
  const reservedObjectCount = safeByteCount(row.reserved_object_count, 'reservedObjectCount');
  const workingBytes = safeByteCount(
    BigInt(sealedWorkingBytes) + BigInt(reservedBytes),
    'workingBytes'
  );
  return {
    workspaceLimitBytes: policy.workspaceLimitBytes,
    workingBytes,
    sealedWorkingBytes,
    reservedBytes,
    releaseProtectedBytes,
    availableWorkspaceBytes: Math.max(0, policy.workspaceLimitBytes - workingBytes),
    workingObjectCount: sealedWorkingObjectCount + reservedObjectCount,
    workingObjectLimit: policy.workingObjectLimit,
    releaseCountLimit: policy.releaseCountLimit
  };
}

export function assertAudioStorageReservationAvailable(
  usage: AudioStorageUsage,
  requestedBytes: number
) {
  if (!Number.isSafeInteger(requestedBytes) || requestedBytes <= 0) {
    throw new Error('requestedBytes must be a positive safe integer.');
  }
  if (requestedBytes > usage.availableWorkspaceBytes) {
    throw new AudioStorageQuotaError({
      workspaceLimitBytes: usage.workspaceLimitBytes,
      workingBytes: usage.workingBytes,
      requestedBytes,
      availableWorkspaceBytes: usage.availableWorkspaceBytes
    });
  }
}

export function assertAudioWorkingObjectAvailable(usage: AudioStorageUsage) {
  if (usage.workingObjectCount >= usage.workingObjectLimit) {
    throw new AudioStorageObjectLimitError({
      workingObjectCount: usage.workingObjectCount,
      workingObjectLimit: usage.workingObjectLimit
    });
  }
}

const SUPPORTED_ASSET_MIME_TYPES = {
  master_audio: new Set([
    'audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/flac', 'audio/aiff',
    'audio/x-aiff', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/ogg'
  ]),
  mix: new Set([
    'audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/flac', 'audio/aiff',
    'audio/x-aiff', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/ogg'
  ]),
  stem: new Set([
    'audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/flac', 'audio/aiff',
    'audio/x-aiff', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/ogg'
  ]),
  session: new Set<string>(),
  artwork: new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  lyrics: new Set(['text/plain', 'text/markdown', 'application/pdf']),
  video: new Set(['video/mp4', 'video/webm']),
  document: new Set(['application/pdf', 'text/plain', 'text/markdown']),
  other: new Set<string>()
} as const;

export type SupportedAudioAssetKind = keyof typeof SUPPORTED_ASSET_MIME_TYPES;

export function normalizeAudioAssetUploadType(input: { assetKind: string; mimeType: string }) {
  const assetKind = input.assetKind.trim().toLowerCase() as SupportedAudioAssetKind;
  const mimeType = input.mimeType.split(';', 1)[0].trim().toLowerCase();
  const allowed = SUPPORTED_ASSET_MIME_TYPES[assetKind];
  if (!allowed || !allowed.has(mimeType)) {
    throw new Error(`Unsupported audio asset kind/MIME combination: ${assetKind || 'blank'} / ${mimeType || 'blank'}.`);
  }
  return { assetKind, mimeType };
}

function beginsWith(body: Buffer, bytes: number[]) {
  return body.length >= bytes.length && bytes.every((value, index) => body[index] === value);
}

function beginsWithAscii(body: Buffer, value: string, offset = 0) {
  return body.length >= offset + value.length
    && body.subarray(offset, offset + value.length).equals(Buffer.from(value, 'ascii'));
}

function hasIsoBaseMediaSignature(body: Buffer) {
  return beginsWithAscii(body, 'ftyp', 4);
}

function hasUtf8TextSignature(body: Buffer) {
  if (!body.length || body.includes(0)) return false;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    return [...text].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 0x09 || code === 0x0a || code === 0x0d || code >= 0x20;
    });
  } catch {
    return false;
  }
}

function signatureMatches(mimeType: string, body: Buffer) {
  switch (mimeType) {
    case 'audio/wav':
    case 'audio/x-wav':
      return beginsWithAscii(body, 'RIFF') && beginsWithAscii(body, 'WAVE', 8);
    case 'audio/mpeg':
      return beginsWithAscii(body, 'ID3')
        || (body.length >= 2 && body[0] === 0xff && (body[1] & 0xe0) === 0xe0);
    case 'audio/flac':
      return beginsWithAscii(body, 'fLaC');
    case 'audio/aiff':
    case 'audio/x-aiff':
      return beginsWithAscii(body, 'FORM')
        && (beginsWithAscii(body, 'AIFF', 8) || beginsWithAscii(body, 'AIFC', 8));
    case 'audio/mp4':
    case 'audio/x-m4a':
    case 'video/mp4':
      return hasIsoBaseMediaSignature(body);
    case 'audio/aac':
      return beginsWithAscii(body, 'ID3')
        || (body.length >= 2 && body[0] === 0xff && (body[1] & 0xf6) === 0xf0);
    case 'audio/ogg':
      return beginsWithAscii(body, 'OggS');
    case 'image/png':
      return beginsWith(body, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg':
      return beginsWith(body, [0xff, 0xd8, 0xff]);
    case 'image/webp':
      return beginsWithAscii(body, 'RIFF') && beginsWithAscii(body, 'WEBP', 8);
    case 'image/gif':
      return beginsWithAscii(body, 'GIF87a') || beginsWithAscii(body, 'GIF89a');
    case 'application/pdf':
      return beginsWithAscii(body, '%PDF-');
    case 'video/webm':
      return beginsWith(body, [0x1a, 0x45, 0xdf, 0xa3]);
    case 'text/plain':
    case 'text/markdown':
      return hasUtf8TextSignature(body);
    default:
      return false;
  }
}

export function assertAudioUploadFirstPartSignature(input: {
  assetKind: string;
  mimeType: string;
  body: Buffer;
}) {
  const normalized = normalizeAudioAssetUploadType(input);
  if (!signatureMatches(normalized.mimeType, input.body)) {
    throw new Error(
      `Upload first part does not match declared ${normalized.assetKind} MIME type ${normalized.mimeType}.`
    );
  }
}
