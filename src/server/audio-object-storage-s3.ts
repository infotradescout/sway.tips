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

export type AudioS3StoreDependencies = {
  client?: Pick<S3Client, 'send'>;
};

type AudioS3StoreConfig = {
  provider: 'r2' | 'neon';
  label: string;
  bucket: string;
  client: Pick<S3Client, 'send'>;
  multipartTarget?: 'staging' | 'master';
};

function assertIdentity(identity: AudioObjectIdentity, bucket: string, provider: 'r2' | 'neon', label: string) {
  if (identity.storageProvider !== provider || identity.storageBucket !== bucket) {
    throw new Error(`Object identity does not match configured ${label} store.`);
  }
  if (!identity.storageKey.startsWith('masters/')
    || identity.storageKey.includes('\\')
    || identity.storageKey.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`${label} object storage key is invalid.`);
  }
}

function stagingKey(storageKey: string) {
  return `staging/${storageKey.slice('masters/'.length)}`;
}

function copySource(bucket: string, key: string) {
  return `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

function asNodeReadable(body: unknown, label: string): Readable {
  if (body instanceof Readable) return body;
  throw new Error(`${label} returned a non-streaming object body.`);
}

async function hashBody(body: unknown, label: string) {
  const stream = asNodeReadable(body, label);
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

export function createS3AudioObjectStore({
  provider, label, bucket, client, multipartTarget = 'staging'
}: AudioS3StoreConfig): AudioObjectStore {
  const uploadKey = (storageKey: string) => multipartTarget === 'master' ? storageKey : stagingKey(storageKey);

  async function removeStaging(storageKey: string) {
    const key = uploadKey(storageKey);
    if (key === storageKey) return;
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch (cleanupError) {
      console.error(`[sway.audio] verified master but could not remove ${label} staging object:`, cleanupError);
    }
  }

  return {
    provider,
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
        Key: uploadKey(storageKey),
        ContentType: mimeType
      }));
      if (!created.UploadId) throw new Error(`${label} did not return a multipart upload ID.`);
      return {
        storageProvider: provider,
        storageBucket: bucket,
        storageKey,
        providerUploadId: created.UploadId
      };
    },
    async abortUpload(identity) {
      assertIdentity(identity, bucket, provider, label);
      if (!identity.providerUploadId) throw new Error(`${label} multipart upload identity is missing.`);
      await client.send(new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: uploadKey(identity.storageKey),
        UploadId: identity.providerUploadId
      }));
    },
    async discardUpload(identity) {
      assertIdentity(identity, bucket, provider, label);
      if (!identity.providerUploadId) throw new Error(`${label} multipart upload identity is missing.`);
      const cleanupErrors: unknown[] = [];
      try {
        await client.send(new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: uploadKey(identity.storageKey),
          UploadId: identity.providerUploadId
        }));
      } catch (error) {
        // A completed multipart upload no longer exists as multipart state;
        // the object deletes below are still required and authoritative.
        if (!isNotFound(error)) cleanupErrors.push(error);
      }
      for (const key of new Set([uploadKey(identity.storageKey), identity.storageKey])) {
        try {
          await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        } catch (error) {
          if (!isNotFound(error)) cleanupErrors.push(error);
        }
      }
      if (cleanupErrors.length) {
        throw new AggregateError(cleanupErrors, `${label} could not fully discard a failed audio upload.`);
      }
    },
    async writePart({ identity, partNumber, body }) {
      assertIdentity(identity, bucket, provider, label);
      if (!identity.providerUploadId) throw new Error(`${label} multipart upload identity is missing.`);
      if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
        throw new Error('partNumber must be an integer from 1 through 10000.');
      }
      const checksum = createHash('sha256').update(body).digest('hex');
      const uploaded = await client.send(new UploadPartCommand({
        Bucket: bucket,
        Key: uploadKey(identity.storageKey),
        UploadId: identity.providerUploadId,
        PartNumber: partNumber,
        Body: body,
        ContentLength: body.byteLength
      }));
      if (!uploaded.ETag) throw new Error(`${label} did not return an ETag for upload part ${partNumber}.`);
      return { etag: uploaded.ETag, checksum, byteSize: body.byteLength };
    },
    async assembleParts({ identity, parts, expectedByteSize, expectedSha256, mimeType }) {
      assertIdentity(identity, bucket, provider, label);
      if (!identity.providerUploadId) throw new Error(`${label} multipart upload identity is missing.`);
      if (!parts.length || parts.some((part, index) => part.partNumber !== index + 1 || !part.etag)) {
        throw new Error('Upload parts must be a complete consecutive sequence with provider ETags.');
      }
      const temporaryKey = uploadKey(identity.storageKey);

      try {
        const existing = await client.send(new GetObjectCommand({ Bucket: bucket, Key: identity.storageKey }));
        const verifiedExisting = await hashBody(existing.Body, label);
        if (verifiedExisting.byteSize !== expectedByteSize || verifiedExisting.sha256 !== expectedSha256) {
          throw new Error(`Existing ${label} sealed master does not match the expected byte size or SHA-256.`);
        }
        await removeStaging(identity.storageKey);
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

      if (temporaryKey !== identity.storageKey) {
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
        if (!copy.CopyObjectResult?.ETag) throw new Error(`${label} did not confirm the sealed master copy.`);
      }

      const sealed = await client.send(new GetObjectCommand({ Bucket: bucket, Key: identity.storageKey }));
      const verified = await hashBody(sealed.Body, label);
      if (verified.byteSize !== expectedByteSize || verified.sha256 !== expectedSha256) {
        throw new Error(`${label} sealed master integrity mismatch against expected byte size or SHA-256.`);
      }

      await removeStaging(identity.storageKey);
      return verified;
    },
    async openOriginal(identity) {
      assertIdentity(identity, bucket, provider, label);
      const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: identity.storageKey }));
      const byteSize = Number(object.ContentLength);
      if (!Number.isSafeInteger(byteSize) || byteSize < 0) throw new Error(`${label} original is missing a valid content length.`);
      return { stream: asNodeReadable(object.Body, label), byteSize };
    }
  };
}
