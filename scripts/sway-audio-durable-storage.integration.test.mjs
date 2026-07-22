import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = process.cwd();
const failures = [];

function read(relativePath) {
  const absolutePath = join(root, relativePath);
  if (!existsSync(absolutePath)) {
    failures.push(`Missing durable audio storage file: ${relativePath}`);
    return '';
  }
  return readFileSync(absolutePath, 'utf8');
}

const source = read('src/server/audio-object-storage.ts');
const server = read('server.ts');
const renderBlueprint = read('render.yaml');
const envExample = read('.env.example');
const filesSurface = read('src/components/PerformerAudioFiles.tsx');

const requiredSourceTerms = [
  "readFileSync('/proc/self/mountinfo', 'utf8')",
  'assertProductionDurableMount',
  'SWAY_AUDIO_LOCAL_MOUNT_PATH is not an active mounted filesystem.',
  "durability = 'verified_mount'",
  'Upload parts must be a complete consecutive sequence starting at 1.',
  "rmSync(dirname(partPath(root, identity, 1)), { recursive: true, force: true })"
];
for (const term of requiredSourceTerms) {
  if (!source.includes(term)) failures.push(`Audio object store is missing required durability control: ${term}`);
}

if (!server.includes("if (isProduction && process.env.SWAY_AUDIO_STORAGE_PROVIDER?.trim())")
  || !server.includes('throw error;')) {
  failures.push('Configured production audio storage must fail startup when durability validation fails.');
}
if (!server.includes("durableMountVerified: audioObjectStore?.durability === 'verified_mount'")) {
  failures.push('Runtime config status must expose mount verification without exposing the storage path.');
}

const requiredBlueprintTerms = [
  'name: sway-audio-originals',
  'mountPath: /var/data/sway-audio',
  'sizeGB: 10',
  'key: SWAY_AUDIO_STORAGE_PROVIDER',
  'value: local_private_fs',
  'key: SWAY_AUDIO_LOCAL_OBJECT_DIR',
  'value: /var/data/sway-audio/objects',
  'key: SWAY_AUDIO_LOCAL_DURABLE_MOUNT',
  'key: SWAY_AUDIO_LOCAL_MOUNT_PATH'
];
for (const term of requiredBlueprintTerms) {
  if (!renderBlueprint.includes(term)) failures.push(`Render blueprint is missing durable storage configuration: ${term}`);
}
if (!envExample.includes('SWAY_AUDIO_LOCAL_MOUNT_PATH=""')) {
  failures.push('The example environment must document the verified production mount path.');
}
if (filesSurface.includes('Pairing QR and DistroKid are still offline.')) {
  failures.push('The Files surface must not claim that the production-verified pairing QR is offline.');
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function runBehaviorProof() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'sway-audio-storage-'));
  const bundlePath = join(tempRoot, 'audio-object-storage.cjs');
  try {
    await build({
      entryPoints: ['src/server/audio-object-storage.ts'],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: bundlePath,
      sourcemap: false
    });
    const require = createRequire(import.meta.url);
    const {
      assertProductionDurableMount,
      createConfiguredAudioObjectStore,
      parseLinuxMountPoints
    } = require(bundlePath);

    const mountPath = join(tempRoot, 'durable mount');
    const objectRoot = join(mountPath, 'objects');
    const escapedMount = mountPath.replace(/\\/g, '/').replace(/ /g, '\\040');
    const mountInfo = `36 25 0:32 / ${escapedMount} rw,relatime - ext4 /dev/sda rw\n`;
    assert.deepEqual(parseLinuxMountPoints(mountInfo), [mountPath]);

    const productionEnv = {
      NODE_ENV: 'production',
      SWAY_AUDIO_STORAGE_PROVIDER: 'local_private_fs',
      SWAY_AUDIO_LOCAL_OBJECT_DIR: objectRoot,
      SWAY_AUDIO_LOCAL_BUCKET: 'sway-audio-originals',
      SWAY_AUDIO_LOCAL_DURABLE_MOUNT: 'true',
      SWAY_AUDIO_LOCAL_MOUNT_PATH: mountPath
    };

    assert.throws(
      () => createConfiguredAudioObjectStore({ ...productionEnv, SWAY_AUDIO_LOCAL_DURABLE_MOUNT: 'false' }),
      /requires SWAY_AUDIO_LOCAL_DURABLE_MOUNT=true/
    );
    assert.throws(
      () => createConfiguredAudioObjectStore(productionEnv, { readMountInfo: () => '' }),
      /not an active mounted filesystem/
    );
    assert.throws(
      () => assertProductionDurableMount({
        objectRoot: join(tempRoot, 'durable mount-sibling', 'objects'),
        mountPath,
        mountInfo
      }),
      /must be inside/
    );

    const store = createConfiguredAudioObjectStore(productionEnv, { readMountInfo: () => mountInfo });
    assert.equal(store.durability, 'verified_mount');
    const storageKey = store.createObjectKey({
      projectId: 'project-1',
      uploadSessionId: 'upload-1',
      filename: 'master.wav'
    });
    const identity = {
      storageProvider: 'local_private_fs',
      storageBucket: store.bucket,
      storageKey
    };
    const original = Buffer.concat([
      Buffer.from('RIFF deterministic exact-original proof '),
      Buffer.from([0, 1, 2, 3, 254, 255])
    ]);
    const first = original.subarray(0, 17);
    const second = original.subarray(17);
    await store.writePart({ identity, partNumber: 1, body: first });
    await store.writePart({ identity, partNumber: 2, body: second });
    const sha256 = createHash('sha256').update(original).digest('hex');
    const sealed = await store.assembleParts({
      identity,
      partNumbers: [1, 2],
      expectedByteSize: original.byteLength,
      expectedSha256: sha256
    });
    assert.deepEqual(sealed, { byteSize: original.byteLength, sha256 });

    const restartedStore = createConfiguredAudioObjectStore(productionEnv, { readMountInfo: () => mountInfo });
    const reopened = restartedStore.openOriginal(identity);
    assert.equal(reopened.byteSize, original.byteLength);
    assert.deepEqual(await streamToBuffer(reopened.stream), original);

    await assert.rejects(
      store.writePart({
        identity: { ...identity, storageBucket: 'wrong-bucket' },
        partNumber: 1,
        body: Buffer.from('denied')
      }),
      /does not match configured local store/
    );
    assert.throws(
      () => store.openOriginal({ ...identity, storageKey: '../outside' }),
      /storage key is invalid/
    );

    const mismatchIdentity = { ...identity, storageKey: `${storageKey}-mismatch` };
    await store.writePart({ identity: mismatchIdentity, partNumber: 1, body: Buffer.from('wrong') });
    await assert.rejects(
      store.assembleParts({
        identity: mismatchIdentity,
        partNumbers: [1],
        expectedByteSize: 5,
        expectedSha256: '0'.repeat(64)
      }),
      /integrity mismatch/
    );
    assert.throws(() => store.openOriginal(mismatchIdentity), /not found/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

try {
  await runBehaviorProof();
} catch (error) {
  failures.push(`Durable storage behavior proof failed: ${error instanceof Error ? error.stack : error}`);
}

if (failures.length) {
  console.error('Sway durable audio storage contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Sway durable audio storage contract passed: mount verification, exact restart-safe bytes, integrity denial, and identity denial are proven locally.');
