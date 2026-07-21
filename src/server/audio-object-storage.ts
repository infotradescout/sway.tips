import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

export type AudioObjectIdentity = {
  storageProvider: 'local_private_fs';
  storageBucket: string;
  storageKey: string;
};

export type AudioObjectStore = {
  provider: 'local_private_fs';
  bucket: string;
  isEnabled: boolean;
  createObjectKey: (input: { projectId: string; uploadSessionId: string; filename: string }) => string;
  writePart: (input: {
    identity: AudioObjectIdentity;
    partNumber: number;
    body: Buffer;
  }) => Promise<{ etag: string; checksum: string; byteSize: number }>;
  assembleParts: (input: {
    identity: AudioObjectIdentity;
    partNumbers: number[];
    expectedByteSize: number;
    expectedSha256: string;
  }) => Promise<{ byteSize: number; sha256: string }>;
  openOriginal: (identity: AudioObjectIdentity) => {
    stream: Readable;
    byteSize: number;
  };
};

function assertSafeAbsoluteDir(dir: string, label: string) {
  if (!isAbsolute(dir)) {
    throw new Error(`${label} must be an absolute path.`);
  }
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

function partPath(root: string, identity: AudioObjectIdentity, partNumber: number) {
  return join(root, identity.storageBucket, identity.storageKey, `parts`, `${partNumber}.part`);
}

function objectPath(root: string, identity: AudioObjectIdentity) {
  return join(root, identity.storageBucket, identity.storageKey, 'original.bin');
}

function ensureParent(filePath: string) {
  mkdirSync(dirname(filePath), { recursive: true });
}

export function createConfiguredAudioObjectStore(env: NodeJS.ProcessEnv = process.env): AudioObjectStore | null {
  const provider = (env.SWAY_AUDIO_STORAGE_PROVIDER || '').trim();
  if (!provider) return null;
  if (provider !== 'local_private_fs') {
    throw new Error(`Unsupported SWAY_AUDIO_STORAGE_PROVIDER: ${provider}`);
  }

  const bucket = (env.SWAY_AUDIO_LOCAL_BUCKET || '').trim();
  const rawDir = (env.SWAY_AUDIO_LOCAL_OBJECT_DIR || '').trim();
  if (!bucket || !rawDir) {
    throw new Error('local_private_fs requires SWAY_AUDIO_LOCAL_BUCKET and SWAY_AUDIO_LOCAL_OBJECT_DIR.');
  }

  const root = assertSafeAbsoluteDir(rawDir, 'SWAY_AUDIO_LOCAL_OBJECT_DIR');
  const isProduction = env.NODE_ENV === 'production';
  if (isProduction && env.SWAY_AUDIO_LOCAL_DURABLE_MOUNT !== 'true') {
    throw new Error('Production local_private_fs requires SWAY_AUDIO_LOCAL_DURABLE_MOUNT=true.');
  }

  mkdirSync(join(root, bucket), { recursive: true });

  return {
    provider: 'local_private_fs',
    bucket,
    isEnabled: true,
    createObjectKey({ projectId, uploadSessionId, filename }) {
      const safeName = filename.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'upload.bin';
      return `projects/${projectId}/uploads/${uploadSessionId}/${randomUUID()}-${safeName}`;
    },
    async writePart({ identity, partNumber, body }) {
      if (identity.storageProvider !== 'local_private_fs' || identity.storageBucket !== bucket) {
        throw new Error('Object identity does not match configured local store.');
      }
      if (partNumber < 1) throw new Error('partNumber must be >= 1');
      const target = partPath(root, identity, partNumber);
      const normalized = normalize(target);
      if (!normalized.startsWith(join(root, bucket))) {
        throw new Error('Path traversal rejected.');
      }
      ensureParent(target);
      const tmp = `${target}.${randomUUID()}.tmp`;
      const checksum = createHash('sha256').update(body).digest('hex');
      await pipeline(
        async function* () { yield body; }(),
        createWriteStream(tmp)
      );
      renameSync(tmp, target);
      return { etag: checksum, checksum, byteSize: body.byteLength };
    },
    async assembleParts({ identity, partNumbers, expectedByteSize, expectedSha256 }) {
      const target = objectPath(root, identity);
      ensureParent(target);
      const tmp = `${target}.${randomUUID()}.tmp`;
      const hash = createHash('sha256');
      let total = 0;
      const out = createWriteStream(tmp);
      try {
        for (const partNumber of partNumbers) {
          const source = partPath(root, identity, partNumber);
          if (!existsSync(source)) throw new Error(`Missing upload part ${partNumber}`);
          const chunk = await new Promise<Buffer>((resolvePromise, reject) => {
            const chunks: Buffer[] = [];
            createReadStream(source)
              .on('data', (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)))
              .on('error', reject)
              .on('end', () => resolvePromise(Buffer.concat(chunks)));
          });
          hash.update(chunk);
          total += chunk.byteLength;
          await new Promise<void>((resolvePromise, reject) => {
            out.write(chunk, (err) => (err ? reject(err) : resolvePromise()));
          });
        }
        await new Promise<void>((resolvePromise, reject) => out.end((err) => (err ? reject(err) : resolvePromise())));
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
      return { byteSize: total, sha256 };
    },
    openOriginal(identity) {
      const target = objectPath(root, identity);
      if (!existsSync(target)) throw new Error('Original object not found.');
      const byteSize = statSync(target).size;
      return { stream: createReadStream(target), byteSize };
    }
  };
}
