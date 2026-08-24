import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand
} from '@aws-sdk/client-s3';
import type { AudioObjectIdentity, AudioObjectStore } from './audio-object-storage';

type R2Client = Pick<S3Client, 'send'>;

type R2StoreDependencies = {
  client?: R2Client;
};

function requireValue(env: NodeJS.ProcessEnv, name: string) {
  const value = (env[name] || '').trim();
  if (!value) throw new Error(`R2 audio storage requires ${name}.`);
  return value;
}

function assertBucketName(bucket: string) {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error('SWAY_AUDIO_R2_BUCKET must be a valid private R2 bucket name.');
  }
}

function assertIdentity(identity: AudioObjectIdentity, bucket: string) {
  if (identity.storageProvider !== 'r2' || identity.storageBucket !== bucket) {
    throw new Error('Object identity does not match configured R2 store.');
  }
  if (!identity.storageKey.startsWith('masters/')
    || identity.storageKey.includes('\\')
    || identity.storageKey.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('R2 object storage key is invalid.');
  }
}

function stagingKey(storageKey: string) {
  return `staging/${storageKey.slice('masters/'.length)}`;
}

function safeUploadSegment(value: string, label: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new Error(`${label} must be a safe storage-key segment.`);
  }
  return value;
}

function safeFilename(filename: string) {
  return filename.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'upload.bin';
}

function samePlannedIdentity(left: AudioObjectIdentity, right: AudioObjectIdentity) {
  return left.storageProvider === right.storageProvider
    && left.storageBucket === right.storageBucket
    && left.storageKey === right.storageKey;
}

function copySource(bucket: string, key: string) {
  return `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

function asNodeReadable(body: unknown): Readable {
  if (body instanceof Readable) return body;
  throw new Error('R2 returned a non-streaming object body.');
}

async function hashBody(body: unknown) {
  const stream = asNodeReadable(body);
  const hash = createHash('sha256');
  let byteSize = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buffer);
    byteSize += buffer.byteLength;
  }
  return { sha256: hash.digest('hex'), byteSize };
}

function isNotFound(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === 'NotFound'
    || candidate.name === 'NoSuchKey'
    || candidate.$metadata?.httpStatusCode === 404;
}

function normalizeEtag(value: string | undefined) {
  return value?.trim().replace(/^"|"$/g, '').toLowerCase() || null;
}

export function createR2AudioObjectStore(
  env: NodeJS.ProcessEnv,
  dependencies: R2StoreDependencies = {}
): AudioObjectStore {
  const accountId = requireValue(env, 'SWAY_AUDIO_R2_ACCOUNT_ID');
  const accessKeyId = requireValue(env, 'SWAY_AUDIO_R2_ACCESS_KEY_ID');
  const secretAccessKey = requireValue(env, 'SWAY_AUDIO_R2_SECRET_ACCESS_KEY');
  const bucket = requireValue(env, 'SWAY_AUDIO_R2_BUCKET');
  assertBucketName(bucket);

  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  const client = dependencies.client ?? new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true
  });

  function planUploadIdentity({ projectId, uploadSessionId, filename }: {
    projectId: string;
    uploadSessionId: string;
    filename: string;
  }): AudioObjectIdentity {
    const storageKey = `masters/projects/${safeUploadSegment(projectId, 'projectId')}/uploads/${safeUploadSegment(uploadSessionId, 'uploadSessionId')}/${safeFilename(filename)}`;
    return {
      storageProvider: 'r2',
      storageBucket: bucket,
      storageKey
    };
  }

  const sendOptions = (signal?: AbortSignal) => signal ? { abortSignal: signal } : undefined;

  async function listExactMultipartUploads(identity: AudioObjectIdentity, signal?: AbortSignal) {
    const targetKey = stagingKey(identity.storageKey);
    const matches: AudioObjectIdentity[] = [];
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const listed = await client.send(new ListMultipartUploadsCommand({
        Bucket: bucket,
        Prefix: targetKey,
        KeyMarker: keyMarker,
        UploadIdMarker: uploadIdMarker
      }), sendOptions(signal));
      for (const upload of listed.Uploads ?? []) {
        if (upload.Key === targetKey && upload.UploadId) {
          matches.push({ ...identity, providerUploadId: upload.UploadId });
        }
      }
      if (!listed.IsTruncated) return matches;
      if (!listed.NextKeyMarker
        || (listed.NextKeyMarker === keyMarker && listed.NextUploadIdMarker === uploadIdMarker)) {
        throw new Error('R2 multipart reconciliation pagination did not advance.');
      }
      keyMarker = listed.NextKeyMarker;
      uploadIdMarker = listed.NextUploadIdMarker;
    }
    throw new Error('R2 multipart reconciliation exceeded its bounded page limit.');
  }

  async function listUploadParts(identity: AudioObjectIdentity, signal?: AbortSignal) {
    if (!identity.providerUploadId) throw new Error('R2 multipart upload identity is missing.');
    const parts: Array<{ partNumber: number; etag: string | null; byteSize: number | null }> = [];
    let partNumberMarker: string | undefined;
    try {
      for (let page = 0; page < 11; page += 1) {
        const listed = await client.send(new ListPartsCommand({
          Bucket: bucket,
          Key: stagingKey(identity.storageKey),
          UploadId: identity.providerUploadId,
          PartNumberMarker: partNumberMarker,
          MaxParts: 1000
        }), sendOptions(signal));
        for (const part of listed.Parts ?? []) {
          if (Number.isInteger(part.PartNumber)) {
            parts.push({
              partNumber: part.PartNumber!,
              etag: normalizeEtag(part.ETag),
              byteSize: Number.isSafeInteger(part.Size) ? part.Size! : null
            });
          }
        }
        if (!listed.IsTruncated) return parts;
        const nextMarker = listed.NextPartNumberMarker == null
          ? undefined
          : String(listed.NextPartNumberMarker);
        if (!nextMarker || nextMarker === partNumberMarker) {
          throw new Error('R2 part reconciliation pagination did not advance.');
        }
        partNumberMarker = nextMarker;
      }
      throw new Error('R2 part reconciliation exceeded its bounded page limit.');
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async function loadObjectHash(key: string, signal?: AbortSignal) {
    try {
      const object = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        sendOptions(signal)
      );
      return await hashBody(object.Body);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  return {
    provider: 'r2',
    bucket,
    isEnabled: true,
    durability: 'object_storage',
    async verifyReady() {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
    },
    planUploadIdentity,
    async beginUpload({ projectId, uploadSessionId, filename, mimeType, identity, signal }) {
      const planned = planUploadIdentity({ projectId, uploadSessionId, filename });
      const requested = identity ?? planned;
      assertIdentity(requested, bucket);
      if (!samePlannedIdentity(requested, planned) || requested.providerUploadId != null) {
        throw new Error('R2 upload identity does not match its deterministic plan.');
      }
      const created = await client.send(new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: stagingKey(requested.storageKey),
        ContentType: mimeType
      }), sendOptions(signal));
      if (!created.UploadId) throw new Error('R2 did not return a multipart upload ID.');
      return { ...requested, providerUploadId: created.UploadId };
    },
    async reconcileUpload({ identity, signal }) {
      assertIdentity(identity, bucket);
      const matches = await listExactMultipartUploads(identity, signal);
      if (matches.length === 0) return { status: 'absent' };
      if (matches.length === 1) return { status: 'found', identity: matches[0] };
      return { status: 'ambiguous', identities: matches };
    },
    async abortUpload(identity, options) {
      assertIdentity(identity, bucket);
      if (!identity.providerUploadId) throw new Error('R2 multipart upload identity is missing.');
      await client.send(new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: stagingKey(identity.storageKey),
        UploadId: identity.providerUploadId
      }), sendOptions(options?.signal));
    },
    async discardUpload(identity, options) {
      assertIdentity(identity, bucket);
      if (!identity.providerUploadId) throw new Error('R2 multipart upload identity is missing.');
      const cleanupErrors: unknown[] = [];
      try {
        await client.send(new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: stagingKey(identity.storageKey),
          UploadId: identity.providerUploadId
        }), sendOptions(options?.signal));
      } catch (error) {
        // A completed multipart upload no longer exists as multipart state;
        // the two object deletes below are still required and authoritative.
        if (!isNotFound(error)) cleanupErrors.push(error);
      }
      for (const key of [stagingKey(identity.storageKey), identity.storageKey]) {
        try {
          await client.send(
            new DeleteObjectCommand({ Bucket: bucket, Key: key }),
            sendOptions(options?.signal)
          );
        } catch (error) {
          if (!isNotFound(error)) cleanupErrors.push(error);
        }
      }
      if (cleanupErrors.length) {
        throw new AggregateError(cleanupErrors, 'R2 could not fully discard a failed audio upload.');
      }
    },
    async writePart({ identity, partNumber, body, signal }) {
      assertIdentity(identity, bucket);
      if (!identity.providerUploadId) throw new Error('R2 multipart upload identity is missing.');
      if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
        throw new Error('partNumber must be an integer from 1 through 10000.');
      }
      const checksum = createHash('sha256').update(body).digest('hex');
      const md5 = createHash('md5').update(body).digest();
      const expectedEtag = md5.toString('hex');
      const uploaded = await client.send(new UploadPartCommand({
        Bucket: bucket,
        Key: stagingKey(identity.storageKey),
        UploadId: identity.providerUploadId,
        PartNumber: partNumber,
        Body: body,
        ContentLength: body.byteLength,
        ContentMD5: md5.toString('base64')
      }), sendOptions(signal));
      if (!uploaded.ETag) throw new Error(`R2 did not return an ETag for upload part ${partNumber}.`);
      if (normalizeEtag(uploaded.ETag) !== expectedEtag) {
        throw new Error(`R2 upload part ${partNumber} ETag did not match its provider-validated Content-MD5.`);
      }
      return { etag: uploaded.ETag, checksum, byteSize: body.byteLength };
    },
    async reconcilePart({ identity, partNumber, expectedByteSize, expectedMd5, signal }) {
      assertIdentity(identity, bucket);
      const parts = await listUploadParts(identity, signal);
      if (parts == null) return { status: 'absent' };
      const observed = parts.find((part) => part.partNumber === partNumber);
      if (!observed) return { status: 'absent' };
      if (observed.byteSize !== expectedByteSize || observed.etag !== expectedMd5) {
        return { status: 'mismatch', etag: observed.etag, byteSize: observed.byteSize };
      }
      return { status: 'confirmed', etag: observed.etag, byteSize: observed.byteSize };
    },
    async assembleParts({ identity, parts, expectedByteSize, expectedSha256, mimeType, signal }) {
      assertIdentity(identity, bucket);
      if (!identity.providerUploadId) throw new Error('R2 multipart upload identity is missing.');
      if (!parts.length || parts.some((part, index) => part.partNumber !== index + 1 || !part.etag)) {
        throw new Error('Upload parts must be a complete consecutive sequence with provider ETags.');
      }
      const temporaryKey = stagingKey(identity.storageKey);

      try {
        const existing = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: identity.storageKey }),
          sendOptions(signal)
        );
        const verifiedExisting = await hashBody(existing.Body);
        if (verifiedExisting.byteSize !== expectedByteSize || verifiedExisting.sha256 !== expectedSha256) {
          throw new Error('Existing R2 sealed master does not match the expected byte size or SHA-256.');
        }
        try {
          await client.send(
            new DeleteObjectCommand({ Bucket: bucket, Key: temporaryKey }),
            sendOptions(signal)
          );
        } catch (cleanupError) {
          console.error('[sway.audio] verified master but could not remove R2 staging object:', cleanupError);
        }
        return verifiedExisting;
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }

      let stagingExists = true;
      try {
        await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: temporaryKey }),
          sendOptions(signal)
        );
      } catch (error) {
        if (!isNotFound(error)) throw error;
        stagingExists = false;
      }
      if (!stagingExists) {
        await client.send(new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: temporaryKey,
          UploadId: identity.providerUploadId,
          MultipartUpload: {
            Parts: parts.map((part) => ({ ETag: part.etag, PartNumber: part.partNumber }))
          }
        }), sendOptions(signal));
      }

      const copy = await client.send(new CopyObjectCommand({
        Bucket: bucket,
        Key: identity.storageKey,
        CopySource: copySource(bucket, temporaryKey),
        ContentType: mimeType,
        MetadataDirective: 'REPLACE',
        Metadata: {
          'sway-sha256': expectedSha256,
          'sway-byte-size': String(expectedByteSize)
        }
      }), sendOptions(signal));
      if (!copy.CopyObjectResult?.ETag) throw new Error('R2 did not confirm the sealed master copy.');

      const sealed = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: identity.storageKey }),
        sendOptions(signal)
      );
      const verified = await hashBody(sealed.Body);
      if (verified.byteSize !== expectedByteSize || verified.sha256 !== expectedSha256) {
        throw new Error('R2 sealed master integrity mismatch against expected byte size or SHA-256.');
      }

      try {
        await client.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: temporaryKey }),
          sendOptions(signal)
        );
      } catch (cleanupError) {
        console.error('[sway.audio] verified master but could not remove R2 staging object:', cleanupError);
      }
      return verified;
    },
    async reconcileAssembly({ identity, expectedByteSize, expectedSha256, signal }) {
      assertIdentity(identity, bucket);
      if (!identity.providerUploadId) throw new Error('R2 multipart upload identity is missing.');
      const sealed = await loadObjectHash(identity.storageKey, signal);
      if (sealed) {
        if (sealed.byteSize !== expectedByteSize || sealed.sha256 !== expectedSha256) {
          return { status: 'mismatch', location: 'sealed', ...sealed };
        }
        return { status: 'sealed', ...sealed };
      }
      const staging = await loadObjectHash(stagingKey(identity.storageKey), signal);
      if (staging) {
        if (staging.byteSize !== expectedByteSize || staging.sha256 !== expectedSha256) {
          return { status: 'mismatch', location: 'staging', ...staging };
        }
        return { status: 'staging', ...staging };
      }
      const parts = await listUploadParts(identity, signal);
      return parts == null ? { status: 'absent' } : { status: 'multipart_open' };
    },
    async reconcileCleanup(identity, options) {
      assertIdentity(identity, bucket);
      if (!identity.providerUploadId) throw new Error('R2 multipart upload identity is missing.');
      const parts = await listUploadParts(identity, options?.signal);
      const staging = await loadObjectHash(stagingKey(identity.storageKey), options?.signal);
      const sealed = await loadObjectHash(identity.storageKey, options?.signal);
      const result = {
        multipartPresent: parts != null,
        stagingPresent: staging != null,
        sealedPresent: sealed != null
      };
      return {
        status: result.multipartPresent || result.stagingPresent || result.sealedPresent
          ? 'present'
          : 'absent',
        ...result
      };
    },
    async openOriginal(identity) {
      assertIdentity(identity, bucket);
      const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: identity.storageKey }));
      const byteSize = Number(object.ContentLength);
      if (!Number.isSafeInteger(byteSize) || byteSize < 0) throw new Error('R2 original is missing a valid content length.');
      return { stream: asNodeReadable(object.Body), byteSize };
    }
  };
}
