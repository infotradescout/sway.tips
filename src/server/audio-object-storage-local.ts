import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { AudioObjectIdentity, AudioObjectStore } from './audio-object-storage';

function assertSafeAbsoluteDir(dir: string, label: string) {
  if (!isAbsolute(dir)) throw new Error(`${label} must be an absolute path.`);
  const resolved = resolve(dir);
  const cwd = resolve(process.cwd());
  const forbiddenRoots = [cwd, resolve(cwd, 'public'), resolve(cwd, 'dist'), resolve(cwd, 'src')];
  for (const root of forbiddenRoots) {
    if (resolved === root || resolved.startsWith(root + sep)) {
      throw new Error(`${label} must not live inside the application source, public, or dist tree.`);
    }
  }
  return resolved;
}

function assertIdentity(identity: AudioObjectIdentity, bucket: string) {
  if (identity.storageProvider !== 'local_private_fs' || identity.storageBucket !== bucket) {
    throw new Error('Object identity does not match configured local store.');
  }
  if (!identity.storageKey || identity.storageKey.includes('\\') || identity.storageKey.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Object storage key is invalid.');
  }
}

function resolveInsideStore(root: string, bucket: string, ...parts: string[]) {
  const storeRoot = resolve(root, bucket);
  const target = resolve(storeRoot, ...parts);
  if (target !== storeRoot && !target.startsWith(storeRoot + sep)) throw new Error('Path traversal rejected.');
  return target;
}

function partPath(root: string, identity: AudioObjectIdentity, partNumber: number) {
  return resolveInsideStore(root, identity.storageBucket, identity.storageKey, 'parts', `${partNumber}.part`);
}

function objectPath(root: string, identity: AudioObjectIdentity) {
  return resolveInsideStore(root, identity.storageBucket, identity.storageKey, 'original.bin');
}

function ensureParent(filePath: string) {
  mkdirSync(dirname(filePath), { recursive: true });
}

export function createLocalAudioObjectStore(env: NodeJS.ProcessEnv): AudioObjectStore {
  const bucket = (env.SWAY_AUDIO_LOCAL_BUCKET || '').trim();
  const rawDir = (env.SWAY_AUDIO_LOCAL_OBJECT_DIR || '').trim();
  if (!bucket || !rawDir) {
    throw new Error('local_private_fs requires SWAY_AUDIO_LOCAL_BUCKET and SWAY_AUDIO_LOCAL_OBJECT_DIR.');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(bucket)) {
    throw new Error('SWAY_AUDIO_LOCAL_BUCKET must be a safe logical bucket name.');
  }
  const root = assertSafeAbsoluteDir(rawDir, 'SWAY_AUDIO_LOCAL_OBJECT_DIR');
  mkdirSync(join(root, bucket), { recursive: true });

  return {
    provider: 'local_private_fs',
    bucket,
    isEnabled: true,
    durability: 'development',
    async verifyReady() {
      mkdirSync(join(root, bucket), { recursive: true });
    },
    async beginUpload({ projectId, uploadSessionId, filename }) {
      const safeName = filename.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'upload.bin';
      return {
        storageProvider: 'local_private_fs',
        storageBucket: bucket,
        storageKey: `projects/${projectId}/uploads/${uploadSessionId}/${randomUUID()}-${safeName}`,
        providerUploadId: uploadSessionId
      };
    },
    async abortUpload(identity) {
      assertIdentity(identity, bucket);
      if (!identity.providerUploadId) throw new Error('Object upload identity is missing.');
      rmSync(dirname(objectPath(root, identity)), { recursive: true, force: true });
    },
    async writePart({ identity, partNumber, body }) {
      assertIdentity(identity, bucket);
      if (!identity.providerUploadId) throw new Error('Object upload identity is missing.');
      if (!Number.isSafeInteger(partNumber) || partNumber < 1) throw new Error('partNumber must be a positive integer');
      const target = partPath(root, identity, partNumber);
      ensureParent(target);
      const tmp = `${target}.${randomUUID()}.tmp`;
      const checksum = createHash('sha256').update(body).digest('hex');
      await pipeline(async function* () { yield body; }(), createWriteStream(tmp));
      renameSync(tmp, target);
      return { etag: checksum, checksum, byteSize: body.byteLength };
    },
    async assembleParts({ identity, parts, expectedByteSize, expectedSha256 }) {
      assertIdentity(identity, bucket);
      if (!identity.providerUploadId) throw new Error('Object upload identity is missing.');
      if (!parts.length || parts.some((part, index) => part.partNumber !== index + 1)) {
        throw new Error('Upload parts must be a complete consecutive sequence starting at 1.');
      }
      const target = objectPath(root, identity);
      ensureParent(target);
      const tmp = `${target}.${randomUUID()}.tmp`;
      const hash = createHash('sha256');
      let total = 0;
      const out = createWriteStream(tmp);
      try {
        for (const part of parts) {
          const source = partPath(root, identity, part.partNumber);
          if (!existsSync(source)) throw new Error(`Missing upload part ${part.partNumber}`);
          const chunk = await new Promise<Buffer>((resolvePromise, reject) => {
            const chunks: Buffer[] = [];
            createReadStream(source)
              .on('data', (data) => chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data)))
              .on('error', reject)
              .on('end', () => resolvePromise(Buffer.concat(chunks)));
          });
          hash.update(chunk);
          total += chunk.byteLength;
          await new Promise<void>((resolvePromise, reject) => {
            out.write(chunk, (error) => (error ? reject(error) : resolvePromise()));
          });
        }
        await new Promise<void>((resolvePromise, reject) => out.end((error) => (error ? reject(error) : resolvePromise())));
      } catch (error) {
        out.destroy();
        rmSync(tmp, { force: true });
        throw error;
      }
      const sha256 = hash.digest('hex');
      if (total !== expectedByteSize || sha256 !== expectedSha256) {
        rmSync(tmp, { force: true });
        throw new Error('Upload integrity mismatch against expected byte size or SHA-256.');
      }
      renameSync(tmp, target);
      rmSync(dirname(partPath(root, identity, 1)), { recursive: true, force: true });
      return { byteSize: total, sha256 };
    },
    async openOriginal(identity) {
      assertIdentity(identity, bucket);
      const target = objectPath(root, identity);
      if (!existsSync(target)) throw new Error('Original object not found.');
      return { stream: createReadStream(target), byteSize: statSync(target).size };
    }
  };
}
