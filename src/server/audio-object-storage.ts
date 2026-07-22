import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
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
  durability: 'development' | 'verified_mount';
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

type AudioObjectStoreConfigDependencies = {
  readMountInfo?: () => string;
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

function decodeLinuxMountInfoPath(value: string) {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

export function parseLinuxMountPoints(mountInfo: string) {
  return mountInfo
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(' '))
    .filter((fields) => fields.length >= 6 && fields.includes('-'))
    .map((fields) => resolve(decodeLinuxMountInfoPath(fields[4])));
}

export function assertProductionDurableMount(input: {
  objectRoot: string;
  mountPath: string;
  mountInfo: string;
}) {
  const objectRoot = assertSafeAbsoluteDir(input.objectRoot, 'SWAY_AUDIO_LOCAL_OBJECT_DIR');
  const mountPath = assertSafeAbsoluteDir(input.mountPath, 'SWAY_AUDIO_LOCAL_MOUNT_PATH');
  if (objectRoot !== mountPath && !objectRoot.startsWith(mountPath + sep)) {
    throw new Error('SWAY_AUDIO_LOCAL_OBJECT_DIR must be inside SWAY_AUDIO_LOCAL_MOUNT_PATH.');
  }

  const mountedPaths = parseLinuxMountPoints(input.mountInfo);
  if (!mountedPaths.includes(mountPath)) {
    throw new Error('SWAY_AUDIO_LOCAL_MOUNT_PATH is not an active mounted filesystem.');
  }
  return mountPath;
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
  if (target !== storeRoot && !target.startsWith(storeRoot + sep)) {
    throw new Error('Path traversal rejected.');
  }
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

export function createConfiguredAudioObjectStore(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: AudioObjectStoreConfigDependencies = {}
): AudioObjectStore | null {
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
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(bucket)) {
    throw new Error('SWAY_AUDIO_LOCAL_BUCKET must be a safe logical bucket name.');
  }

  const root = assertSafeAbsoluteDir(rawDir, 'SWAY_AUDIO_LOCAL_OBJECT_DIR');
  const isProduction = env.NODE_ENV === 'production';
  let durability: AudioObjectStore['durability'] = 'development';
  if (isProduction && env.SWAY_AUDIO_LOCAL_DURABLE_MOUNT !== 'true') {
    throw new Error('Production local_private_fs requires SWAY_AUDIO_LOCAL_DURABLE_MOUNT=true.');
  }
  if (isProduction) {
    const mountPath = (env.SWAY_AUDIO_LOCAL_MOUNT_PATH || '').trim();
    if (!mountPath) {
      throw new Error('Production local_private_fs requires SWAY_AUDIO_LOCAL_MOUNT_PATH.');
    }
    const readMountInfo = dependencies.readMountInfo ?? (() => readFileSync('/proc/self/mountinfo', 'utf8'));
    let mountInfo: string;
    try {
      mountInfo = readMountInfo();
    } catch {
      throw new Error('Production local_private_fs could not inspect /proc/self/mountinfo.');
    }
    assertProductionDurableMount({ objectRoot: root, mountPath, mountInfo });
    durability = 'verified_mount';
  }

  mkdirSync(join(root, bucket), { recursive: true });

  return {
    provider: 'local_private_fs',
    bucket,
    isEnabled: true,
    durability,
    createObjectKey({ projectId, uploadSessionId, filename }) {
      const safeName = filename.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'upload.bin';
      return `projects/${projectId}/uploads/${uploadSessionId}/${randomUUID()}-${safeName}`;
    },
    async writePart({ identity, partNumber, body }) {
      assertIdentity(identity, bucket);
      if (!Number.isSafeInteger(partNumber) || partNumber < 1) throw new Error('partNumber must be a positive integer');
      const target = partPath(root, identity, partNumber);
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
      assertIdentity(identity, bucket);
      if (!partNumbers.length || partNumbers.some((partNumber, index) => partNumber !== index + 1)) {
        throw new Error('Upload parts must be a complete consecutive sequence starting at 1.');
      }
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
      rmSync(dirname(partPath(root, identity, 1)), { recursive: true, force: true });
      return { byteSize: total, sha256 };
    },
    openOriginal(identity) {
      assertIdentity(identity, bucket);
      const target = objectPath(root, identity);
      if (!existsSync(target)) throw new Error('Original object not found.');
      const byteSize = statSync(target).size;
      return { stream: createReadStream(target), byteSize };
    }
  };
}
