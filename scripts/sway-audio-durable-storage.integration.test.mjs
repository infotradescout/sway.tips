import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
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

const dispatcher = read('src/server/audio-object-storage.ts');
const r2Source = read('src/server/audio-object-storage-r2.ts');
const service = read('src/server/audio-publishing-service.ts');
const server = read('server.ts');
const renderBlueprint = read('render.yaml');
const envExample = read('.env.example');
const filesSurface = read('src/components/PerformerAudioFiles.tsx');
const productionProof = read('scripts/sway-production-audio-proof.mjs');
const productionEvidenceAudit = read('scripts/sway-production-audio-evidence-audit.mjs');
const packageJson = read('package.json');

for (const term of [
  "export type AudioStorageProvider = 'local_private_fs' | 'r2'",
  "Production audio storage requires SWAY_AUDIO_STORAGE_PROVIDER=r2.",
  'beginUpload:',
  'abortUpload:',
  'verifyReady:'
]) {
  if (!dispatcher.includes(term)) failures.push(`Audio storage contract is missing provider-neutral control: ${term}`);
}

for (const term of [
  'CreateMultipartUploadCommand',
  'UploadPartCommand',
  'CompleteMultipartUploadCommand',
  'CopyObjectCommand',
  'HeadBucketCommand',
  'HeadObjectCommand',
  "storageKey = `masters/",
  "return `staging/",
  "'sway-sha256': expectedSha256",
  'R2 sealed master integrity mismatch'
]) {
  if (!r2Source.includes(term)) failures.push(`R2 adapter is missing required private-master control: ${term}`);
}

for (const term of [
  'storageProvider: objectIdentity.storageProvider',
  'providerUploadId: objectIdentity.providerUploadId!',
  'parseAudioStorageProvider(session.storageProvider)',
  'await store.openOriginal',
  'await store.abortUpload(objectIdentity)'
]) {
  if (!service.includes(term)) failures.push(`Publishing service still lacks provider-neutral behavior: ${term}`);
}
if (service.includes("storageProvider: 'local_private_fs'")) {
  failures.push('Publishing service must never relabel provider-backed identities as local filesystem objects.');
}
const sealTransaction = service.slice(
  service.indexOf('return db.transaction(async (tx) => {', service.indexOf('async function completeAndSealUpload')),
  service.indexOf('async function createShareGrant')
);
const completedSessionWrite = sealTransaction.indexOf("uploadStatus: 'completed'");
const immutableVersionWrite = sealTransaction.indexOf('tx.insert(audioProjectAssetVersions)');
if (completedSessionWrite < 0 || immutableVersionWrite < 0 || completedSessionWrite > immutableVersionWrite) {
  failures.push('The upload session must become completed before the verified-seal trigger accepts the immutable version row.');
}
for (const term of [
  "if (session.uploadStatus === 'initiated' || session.uploadStatus === 'uploading')",
  "if (session.uploadStatus !== 'verifying')",
  "!['initiated', 'uploading', 'uploaded', 'verifying'].includes(session.uploadStatus)"
]) {
  if (!service.includes(term)) failures.push(`Upload sealing must remain monotonic and retry-safe: ${term}`);
}

if (!server.includes('await audioObjectStore.verifyReady()')
  || !server.includes('objectStorageVerified: audioObjectStoreVerified')
  || !server.includes("console.error('[sway.startup] server failed before accepting traffic:'")) {
  failures.push('Server startup and runtime status must require verified private bucket access.');
}
if (!server.includes("express.raw({")
  || !server.includes("type: 'application/octet-stream'")
  || server.includes('contentBase64 is required for this upload part.')) {
  failures.push('Audio parts must use bounded raw binary transport instead of oversized base64 JSON.');
}
if (!filesSurface.includes("headers: { 'Content-Type': 'application/octet-stream' }")
  || filesSurface.includes('blobToBase64')) {
  failures.push('The performer uploader must send raw binary parts without base64 inflation.');
}
if (!filesSurface.includes('aria-label="Add audio to Catalog"')
  || filesSurface.includes('type="file"\n            className="hidden"')) {
  failures.push('The production master picker must remain keyboard-addressable instead of hiding the file input from interaction.');
}
if (!filesSurface.includes('const projectId = await refreshProjects();')
  || !filesSurface.includes('if (projectId) await refreshAssets(projectId);')) {
  failures.push('Opening Files & projects must load sealed versions for the automatically selected project.');
}
for (const term of [
  'await store.verifyReady()',
  'await service.completeAndSealUpload',
  'await service.downloadSharedOriginal',
  'downloadedBody.equals(body)',
  'downloaded.version.sha256 !== sha256',
  "outcome: 'verified'",
  'exactBytesRecovered: true'
]) {
  if (!productionProof.includes(term)) failures.push(`Production audio proof is missing required evidence control: ${term}`);
}
if (!packageJson.includes('"proof:audio:production": "tsx scripts/sway-production-audio-proof.mjs"')) {
  failures.push('Package scripts must expose the fail-closed production audio proof command.');
}
for (const term of [
  'unauthenticatedHttpDenied',
  'crossAccountProjectReadDenied',
  'deniedAccessReachedObjectStorage',
  'independentRecoveryVerified: false',
  "notIlike(users.email, '%smoke%')"
]) {
  if (!productionEvidenceAudit.includes(term)) failures.push(`Production audio evidence audit is missing required denial control: ${term}`);
}
if (!packageJson.includes('"audit:audio:production-evidence": "tsx scripts/sway-production-audio-evidence-audit.mjs"')) {
  failures.push('Package scripts must expose the fail-closed production audio evidence audit.');
}

for (const term of [
  'value: r2',
  'key: SWAY_AUDIO_R2_BUCKET',
  'key: SWAY_AUDIO_R2_ACCOUNT_ID',
  'key: SWAY_AUDIO_R2_ACCESS_KEY_ID',
  'key: SWAY_AUDIO_R2_SECRET_ACCESS_KEY',
  'sync: false'
]) {
  if (!renderBlueprint.includes(term)) failures.push(`Render blueprint is missing R2 configuration: ${term}`);
}
for (const forbidden of ['disk:', 'mountPath:', 'SWAY_AUDIO_LOCAL_DURABLE_MOUNT', 'SWAY_AUDIO_LOCAL_MOUNT_PATH']) {
  if (renderBlueprint.includes(forbidden)) failures.push(`Render blueprint must not couple masters to a service disk: ${forbidden}`);
}
for (const term of [
  'SWAY_AUDIO_R2_ACCOUNT_ID=""',
  'SWAY_AUDIO_R2_ACCESS_KEY_ID=""',
  'SWAY_AUDIO_R2_SECRET_ACCESS_KEY=""',
  'SWAY_AUDIO_R2_BUCKET="sway-audio-originals"'
]) {
  if (!envExample.includes(term)) failures.push(`Example environment is missing R2 variable: ${term}`);
}
if (filesSurface.includes('Pairing QR and DistroKid are still offline.')) {
  failures.push('The Files surface must not claim that the production-verified pairing QR is offline.');
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

class InMemoryR2Client {
  objects = new Map();
  uploads = new Map();
  commands = [];
  uploadSequence = 0;

  async send(command) {
    const name = command.constructor.name.replace(/\d+$/, '');
    const input = command.input;
    this.commands.push({ name, input });
    if (name === 'HeadBucketCommand') return {};
    if (name === 'CreateMultipartUploadCommand') {
      const uploadId = `r2-upload-${++this.uploadSequence}`;
      this.uploads.set(uploadId, { key: input.Key, parts: new Map() });
      return { UploadId: uploadId };
    }
    if (name === 'UploadPartCommand') {
      const upload = this.uploads.get(input.UploadId);
      if (!upload || upload.key !== input.Key) throw new Error('Unknown multipart upload.');
      upload.parts.set(input.PartNumber, Buffer.from(input.Body));
      return { ETag: `"etag-${input.PartNumber}"` };
    }
    if (name === 'CompleteMultipartUploadCommand') {
      const upload = this.uploads.get(input.UploadId);
      if (!upload) throw new Error('Unknown multipart upload.');
      const bytes = Buffer.concat(input.MultipartUpload.Parts.map((part) => upload.parts.get(part.PartNumber)));
      this.objects.set(input.Key, bytes);
      this.uploads.delete(input.UploadId);
      return { ETag: '"completed"' };
    }
    if (name === 'AbortMultipartUploadCommand') {
      this.uploads.delete(input.UploadId);
      return {};
    }
    if (name === 'CopyObjectCommand') {
      const source = decodeURIComponent(input.CopySource);
      const sourceKey = source.slice(source.indexOf('/') + 1);
      const bytes = this.objects.get(sourceKey);
      if (!bytes) throw new Error('Copy source not found.');
      this.objects.set(input.Key, Buffer.from(bytes));
      return { CopyObjectResult: { ETag: '"copied"' } };
    }
    if (name === 'GetObjectCommand') {
      const bytes = this.objects.get(input.Key);
      if (!bytes) throw Object.assign(new Error('Object not found.'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
      return { Body: Readable.from([bytes]), ContentLength: bytes.byteLength };
    }
    if (name === 'HeadObjectCommand') {
      const bytes = this.objects.get(input.Key);
      if (!bytes) throw Object.assign(new Error('Object not found.'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
      return { ContentLength: bytes.byteLength };
    }
    if (name === 'DeleteObjectCommand') {
      this.objects.delete(input.Key);
      return {};
    }
    throw new Error(`Unexpected command: ${name}`);
  }
}

async function runBehaviorProof() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'sway-audio-storage-'));
  const dispatcherBundle = join(tempRoot, 'audio-object-storage.cjs');
  const r2Bundle = join(tempRoot, 'audio-object-storage-r2.cjs');
  try {
    await Promise.all([
      build({ entryPoints: ['src/server/audio-object-storage.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: dispatcherBundle }),
      build({ entryPoints: ['src/server/audio-object-storage-r2.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: r2Bundle })
    ]);
    const require = createRequire(import.meta.url);
    const { createConfiguredAudioObjectStore } = require(dispatcherBundle);
    const { createR2AudioObjectStore } = require(r2Bundle);

    const localStore = createConfiguredAudioObjectStore({
      NODE_ENV: 'development',
      SWAY_AUDIO_STORAGE_PROVIDER: 'local_private_fs',
      SWAY_AUDIO_LOCAL_OBJECT_DIR: join(tempRoot, 'local'),
      SWAY_AUDIO_LOCAL_BUCKET: 'sway-audio-local'
    });
    await localStore.verifyReady();
    assert.throws(() => createConfiguredAudioObjectStore({
      NODE_ENV: 'production',
      SWAY_AUDIO_STORAGE_PROVIDER: 'local_private_fs',
      SWAY_AUDIO_LOCAL_OBJECT_DIR: join(tempRoot, 'local'),
      SWAY_AUDIO_LOCAL_BUCKET: 'sway-audio-local'
    }), /requires SWAY_AUDIO_STORAGE_PROVIDER=r2/);

    const r2Env = {
      NODE_ENV: 'production',
      SWAY_AUDIO_STORAGE_PROVIDER: 'r2',
      SWAY_AUDIO_R2_ACCOUNT_ID: 'account-id',
      SWAY_AUDIO_R2_ACCESS_KEY_ID: 'access-key',
      SWAY_AUDIO_R2_SECRET_ACCESS_KEY: 'secret-key',
      SWAY_AUDIO_R2_BUCKET: 'sway-audio-originals'
    };
    assert.throws(
      () => createConfiguredAudioObjectStore({ ...r2Env, SWAY_AUDIO_R2_SECRET_ACCESS_KEY: '' }),
      /requires SWAY_AUDIO_R2_SECRET_ACCESS_KEY/
    );

    const client = new InMemoryR2Client();
    const store = createR2AudioObjectStore(r2Env, { client });
    await store.verifyReady();
    const identity = await store.beginUpload({
      projectId: 'project-1',
      uploadSessionId: 'upload-1',
      filename: 'master.wav',
      mimeType: 'audio/wav'
    });
    assert.equal(identity.storageProvider, 'r2');
    assert.match(identity.storageKey, /^masters\/projects\/project-1\/uploads\/upload-1\//);

    const original = Buffer.concat([
      Buffer.alloc(5 * 1024 * 1024, 0x53),
      Buffer.from('RIFF deterministic exact-original R2 proof '),
      Buffer.from([0, 1, 2, 3, 254, 255])
    ]);
    const chunks = [original.subarray(0, 5 * 1024 * 1024), original.subarray(5 * 1024 * 1024)];
    const parts = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const written = await store.writePart({ identity, partNumber: index + 1, body: chunks[index] });
      parts.push({ partNumber: index + 1, etag: written.etag });
    }
    const sha256 = createHash('sha256').update(original).digest('hex');
    assert.deepEqual(await store.assembleParts({
      identity,
      parts,
      expectedByteSize: original.byteLength,
      expectedSha256: sha256,
      mimeType: 'audio/wav'
    }), { byteSize: original.byteLength, sha256 });
    assert.equal(client.objects.has(identity.storageKey), true, 'Sealed master must exist in the masters namespace.');
    assert.equal([...client.objects.keys()].some((key) => key.startsWith('staging/')), false, 'Verified staging objects must be removed.');
    assert.deepEqual(await store.assembleParts({
      identity,
      parts,
      expectedByteSize: original.byteLength,
      expectedSha256: sha256,
      mimeType: 'audio/wav'
    }), { byteSize: original.byteLength, sha256 }, 'Sealing must be idempotent after provider completion and staging cleanup.');

    const restartedStore = createR2AudioObjectStore(r2Env, { client });
    const reopened = await restartedStore.openOriginal({
      storageProvider: identity.storageProvider,
      storageBucket: identity.storageBucket,
      storageKey: identity.storageKey
    });
    assert.equal(reopened.byteSize, original.byteLength);
    assert.deepEqual(await streamToBuffer(reopened.stream), original);

    await assert.rejects(
      store.writePart({
        identity: { ...identity, storageBucket: 'wrong-bucket' },
        partNumber: 1,
        body: Buffer.from('denied')
      }),
      /does not match configured R2 store/
    );
    await assert.rejects(
      store.openOriginal({ ...identity, storageKey: '../outside', providerUploadId: undefined }),
      /storage key is invalid/
    );

    const orphan = await store.beginUpload({
      projectId: 'project-1',
      uploadSessionId: 'orphan-1',
      filename: 'orphan.wav',
      mimeType: 'audio/wav'
    });
    assert.equal(client.uploads.has(orphan.providerUploadId), true);
    await store.abortUpload(orphan);
    assert.equal(client.uploads.has(orphan.providerUploadId), false, 'Aborted database work must not leave an R2 multipart upload.');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

try {
  await runBehaviorProof();
} catch (error) {
  failures.push(`Durable R2 storage behavior proof failed: ${error instanceof Error ? error.stack : error}`);
}

if (failures.length) {
  console.error('Sway durable audio storage integration failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Sway durable audio storage integration passed: private R2 multipart staging, exact sealing, restart-safe retrieval, cleanup, and denial are proven deterministically.');
