import { createHash, randomUUID } from 'node:crypto';
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

  return {
    provider: 'r2',
    bucket,
    isEnabled: true,
    durability: 'object_storage',
    async verifyReady() {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
    },
    async beginUpload({ projectId, uploadSessionId, filename, mimeType }) {
      const safeName = filename.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'upload.bin';
      const storageKey = `masters/projects/${projectId}/uploads/${uploadSessionId}/${randomUUID()}-${safeName}`;
      const created = await client.send(new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: stagingKey(storageKey),
        ContentType: mimeType
      }));
      if (!created.UploadId) throw new Error('R2 did not return a multipart upload ID.');
      return {
        storageProvider: 'r2',
        storageBucket: bucket,
        storageKey,
        providerUploadId: created.UploadId
      };
    },
    async abortUpload(identity) {
      assertIdentity(identity, bucket);
      if (!identity.providerUploadId) throw new Error('R2 multipart upload identity is missing.');
      await client.send(new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: stagingKey(identity.storageKey),
        UploadId: identity.providerUploadId
      }));
    },
    async writePart({ identity, partNumber, body }) {
      assertIdentity(identity, bucket);
      if (!identity.providerUploadId) throw new Error('R2 multipart upload identity is missing.');
      if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
        throw new Error('partNumber must be an integer from 1 through 10000.');
      }
      const checksum = createHash('sha256').update(body).digest('hex');
      const uploaded = await client.send(new UploadPartCommand({
        Bucket: bucket,
        Key: stagingKey(identity.storageKey),
        UploadId: identity.providerUploadId,
        PartNumber: partNumber,
        Body: body,
        ContentLength: body.byteLength
      }));
      if (!uploaded.ETag) throw new Error(`R2 did not return an ETag for upload part ${partNumber}.`);
      return { etag: uploaded.ETag, checksum, byteSize: body.byteLength };
    },
    async assembleParts({ identity, parts, expectedByteSize, expectedSha256, mimeType }) {
      assertIdentity(identity, bucket);
      if (!identity.providerUploadId) throw new Error('R2 multipart upload identity is missing.');
      if (!parts.length || parts.some((part, index) => part.partNumber !== index + 1 || !part.etag)) {
        throw new Error('Upload parts must be a complete consecutive sequence with provider ETags.');
      }
      const temporaryKey = stagingKey(identity.storageKey);

      try {
        const existing = await client.send(new GetObjectCommand({ Bucket: bucket, Key: identity.storageKey }));
        const verifiedExisting = await hashBody(existing.Body);
        if (verifiedExisting.byteSize !== expectedByteSize || verifiedExisting.sha256 !== expectedSha256) {
          throw new Error('Existing R2 sealed master does not match the expected byte size or SHA-256.');
        }
        try {
          await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: temporaryKey }));
        } catch (cleanupError) {
          console.error('[sway.audio] verified master but could not remove R2 staging object:', cleanupError);
        }
        return verifiedExisting;
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }

      let stagingExists = true;
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: temporaryKey }));
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
        }));
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
      }));
      if (!copy.CopyObjectResult?.ETag) throw new Error('R2 did not confirm the sealed master copy.');

      const sealed = await client.send(new GetObjectCommand({ Bucket: bucket, Key: identity.storageKey }));
      const verified = await hashBody(sealed.Body);
      if (verified.byteSize !== expectedByteSize || verified.sha256 !== expectedSha256) {
        throw new Error('R2 sealed master integrity mismatch against expected byte size or SHA-256.');
      }

      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: temporaryKey }));
      } catch (cleanupError) {
        console.error('[sway.audio] verified master but could not remove R2 staging object:', cleanupError);
      }
      return verified;
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
