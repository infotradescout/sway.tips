import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import express from 'express';

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
const uploadTransport = read('src/server/audio-upload-transport.ts');
const server = read('server.ts');
const renderBlueprint = read('render.yaml');
const envExample = read('.env.example');
const filesSurface = read('src/components/PerformerAudioFiles.tsx');
const productionProof = read('scripts/sway-production-audio-proof.mjs');
const productionEvidenceAudit = read('scripts/sway-production-audio-evidence-audit.mjs');
const productionFixtureGenerator = read('scripts/sway-generate-audio-proof-fixture.mjs');
const packageJson = read('package.json');

for (const term of [
  "export type AudioStorageProvider = 'local_private_fs' | 'r2'",
  "Production audio storage requires SWAY_AUDIO_STORAGE_PROVIDER=r2.",
  'beginUpload:',
  'planUploadIdentity:',
  'reconcileUpload:',
  'reconcilePart:',
  'reconcileAssembly:',
  'reconcileCleanup:',
  'abortUpload:',
  'discardUpload?:',
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
  'ListMultipartUploadsCommand',
  'ListPartsCommand',
  'ContentMD5:',
  "storageKey = `masters/",
  "return `staging/",
  "'sway-sha256': expectedSha256",
  'R2 sealed master integrity mismatch'
]) {
  if (!r2Source.includes(term)) failures.push(`R2 adapter is missing required private-master control: ${term}`);
}

for (const term of [
  'operationObjectIdentity',
  'storageProvider: session.storageProvider',
  'providerUploadId: operation.providerUploadId',
  'parseAudioStorageProvider(session.storageProvider)',
  'await store.openOriginal',
  'await discardUpload.call(store, identity, options)'
]) {
  if (!service.includes(term)) failures.push(`Publishing service still lacks provider-neutral behavior: ${term}`);
}
if (service.includes("storageProvider: 'local_private_fs'")) {
  failures.push('Publishing service must never relabel provider-backed identities as local filesystem objects.');
}
const sealTransaction = service.slice(
  service.indexOf('async function completeAndSealUpload'),
  service.indexOf('async function createShareGrant')
);
const completedSessionWrite = sealTransaction.indexOf("uploadStatus: 'completed'");
const immutableVersionWrite = sealTransaction.indexOf('tx.insert(audioProjectAssetVersions)');
if (completedSessionWrite < 0 || immutableVersionWrite < 0 || completedSessionWrite > immutableVersionWrite) {
  failures.push('The upload session must become completed before the verified-seal trigger accepts the immutable version row.');
}
if (!sealTransaction.includes('runAssemblyProviderOperation')
  || !service.includes('providerOperations.finalizeSuccess({')) {
  failures.push('Verified seal persistence must finalize atomically with durable provider-operation success.');
}
for (const term of [
  "if (session.uploadStatus === 'initiated' || session.uploadStatus === 'uploading')",
  "if (session.uploadStatus !== 'verifying')",
  "!['initiated', 'uploading', 'uploaded', 'verifying'].includes(session.uploadStatus)"
]) {
  if (!service.includes(term)) failures.push(`Upload sealing must remain monotonic and retry-safe: ${term}`);
}
const sharedDownload = service.slice(
  service.indexOf('async function downloadSharedOriginal'),
  service.indexOf('async function openOwnedVersion')
);
const sharedObjectOpen = sharedDownload.indexOf('const object = await store.openOriginal');
const sharedConsumeTransaction = sharedDownload.indexOf('await db.transaction');
const sharedUseIncrement = sharedDownload.indexOf('.update(audioShareGrants)', sharedConsumeTransaction);
const sharedAuditWrite = sharedDownload.indexOf('tx.insert(auditEvents)', sharedUseIncrement);
if (sharedObjectOpen < 0
  || sharedConsumeTransaction < 0
  || sharedUseIncrement < 0
  || sharedAuditWrite < 0
  || !(sharedObjectOpen < sharedConsumeTransaction
    && sharedConsumeTransaction < sharedUseIncrement
    && sharedUseIncrement < sharedAuditWrite)) {
  failures.push('Share download must open storage before atomically committing its use increment and audit event.');
}
for (const term of [
  'isNull(audioShareGrants.revokedAt)',
  'gt(audioShareGrants.expiresAt, new Date())',
  'sql`${audioShareGrants.useCount} < ${audioShareGrants.maxUses}`',
  'object.stream.destroy()'
]) {
  if (!sharedDownload.includes(term)) failures.push(`One-time share consumption is missing a failure-safe control: ${term}`);
}

if (!server.includes('await audioObjectStore.verifyReady()')
  || !server.includes('objectStorageVerified: audioObjectStoreVerified')
  || !server.includes("console.error('[sway.startup] server failed before accepting traffic:'")) {
  failures.push('Server startup and runtime status must require verified private bucket access.');
}
if (!server.includes('createAudioUploadPartBodyParser()')
  || !uploadTransport.includes('express.raw({')
  || !uploadTransport.includes("type: 'application/octet-stream'")
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
if (!filesSurface.includes('body: JSON.stringify({ maxUses: 1 })')
  || !filesSurface.includes('Create one-time link')) {
  failures.push('The Catalog one-time-link control must create an actual single-use share grant.');
}
if (!filesSurface.includes('const projectId = await refreshProjects();')
  || !filesSurface.includes('if (projectId && selectedProjectIdRef.current === projectId) await refreshAssets(projectId);')) {
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
  "wav.write('RIFF'",
  "wav.write('WAVEfmt '",
  "createHash('sha256')",
  'generatedFixture: true',
  'userOwned: false'
]) {
  if (!productionFixtureGenerator.includes(term)) failures.push(`Production fixture generator is missing required synthetic-audio evidence: ${term}`);
}
if (!packageJson.includes('"fixture:audio:production": "node scripts/sway-generate-audio-proof-fixture.mjs"')) {
  failures.push('Package scripts must expose the generated production-audio fixture command.');
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
  failAfterApply = null;
  multipartPageSize = Number.POSITIVE_INFINITY;

  applied(name, result) {
    if (this.failAfterApply === name) {
      this.failAfterApply = null;
      throw new Error(`simulated lost ${name} response`);
    }
    return result;
  }

  async send(command) {
    const name = command.constructor.name.replace(/\d+$/, '');
    const input = command.input;
    this.commands.push({ name, input });
    if (name === 'HeadBucketCommand') return {};
    if (name === 'CreateMultipartUploadCommand') {
      const uploadId = `r2-upload-${++this.uploadSequence}`;
      this.uploads.set(uploadId, { key: input.Key, parts: new Map() });
      return this.applied(name, { UploadId: uploadId });
    }
    if (name === 'ListMultipartUploadsCommand') {
      const matches = [...this.uploads.entries()]
        .map(([uploadId, upload]) => ({ uploadId, key: upload.key }))
        .filter((upload) => upload.key.startsWith(input.Prefix ?? ''))
        .sort((left, right) => left.key.localeCompare(right.key) || left.uploadId.localeCompare(right.uploadId));
      const start = input.KeyMarker == null
        ? 0
        : matches.findIndex((upload) => upload.key === input.KeyMarker && upload.uploadId === input.UploadIdMarker) + 1;
      const page = matches.slice(Math.max(0, start), Math.max(0, start) + this.multipartPageSize);
      const truncated = Math.max(0, start) + page.length < matches.length;
      const last = page.at(-1);
      return {
        Uploads: page.map((upload) => ({ Key: upload.key, UploadId: upload.uploadId })),
        IsTruncated: truncated,
        NextKeyMarker: truncated ? last?.key : undefined,
        NextUploadIdMarker: truncated ? last?.uploadId : undefined
      };
    }
    if (name === 'UploadPartCommand') {
      const upload = this.uploads.get(input.UploadId);
      if (!upload || upload.key !== input.Key) throw new Error('Unknown multipart upload.');
      const body = Buffer.from(input.Body);
      const md5 = createHash('md5').update(body).digest();
      assert.equal(input.ContentMD5, md5.toString('base64'), 'R2 part upload must carry provider-validated Content-MD5.');
      const etag = md5.toString('hex');
      upload.parts.set(input.PartNumber, { body, etag });
      return this.applied(name, { ETag: `"${etag}"` });
    }
    if (name === 'ListPartsCommand') {
      const upload = this.uploads.get(input.UploadId);
      if (!upload || upload.key !== input.Key) {
        throw Object.assign(new Error('Multipart upload not found.'), {
          name: 'NoSuchUpload',
          $metadata: { httpStatusCode: 404 }
        });
      }
      const marker = Number(input.PartNumberMarker ?? 0);
      const all = [...upload.parts.entries()]
        .filter(([partNumber]) => partNumber > marker)
        .sort(([left], [right]) => left - right);
      const page = all.slice(0, input.MaxParts ?? 1000);
      const truncated = page.length < all.length;
      return {
        Parts: page.map(([partNumber, part]) => ({
          PartNumber: partNumber,
          ETag: `"${part.etag}"`,
          Size: part.body.byteLength
        })),
        IsTruncated: truncated,
        NextPartNumberMarker: truncated ? page.at(-1)?.[0] : undefined
      };
    }
    if (name === 'CompleteMultipartUploadCommand') {
      const upload = this.uploads.get(input.UploadId);
      if (!upload) throw new Error('Unknown multipart upload.');
      const bytes = Buffer.concat(input.MultipartUpload.Parts.map((part) => upload.parts.get(part.PartNumber).body));
      this.objects.set(input.Key, bytes);
      this.uploads.delete(input.UploadId);
      return this.applied(name, { ETag: '"completed"' });
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
      return this.applied(name, {});
    }
    throw new Error(`Unexpected command: ${name}`);
  }
}

async function runBehaviorProof() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'sway-audio-storage-'));
  const dispatcherBundle = join(tempRoot, 'audio-object-storage.cjs');
  const r2Bundle = join(tempRoot, 'audio-object-storage-r2.cjs');
  const uploadTransportBundle = join(tempRoot, 'audio-upload-transport.cjs');
  try {
    const generatedFixture = JSON.parse(execFileSync(
      process.execPath,
      [join(root, 'scripts/sway-generate-audio-proof-fixture.mjs'), '--output-dir', tempRoot],
      { cwd: root, encoding: 'utf8' }
    ));
    const generatedFixtureBytes = readFileSync(generatedFixture.filePath);
    assert.equal(generatedFixture.generatedFixture, true);
    assert.equal(generatedFixture.userOwned, false);
    assert.equal(generatedFixtureBytes.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(generatedFixtureBytes.subarray(8, 12).toString('ascii'), 'WAVE');
    assert.equal(generatedFixtureBytes.byteLength, generatedFixture.byteSize);
    assert.equal(createHash('sha256').update(generatedFixtureBytes).digest('hex'), generatedFixture.sha256);

    await Promise.all([
      build({ entryPoints: ['src/server/audio-object-storage.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: dispatcherBundle }),
      build({ entryPoints: ['src/server/audio-object-storage-r2.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: r2Bundle }),
      build({
        entryPoints: ['src/server/audio-upload-transport.ts'],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: uploadTransportBundle
      })
    ]);
    const require = createRequire(import.meta.url);
    const { createConfiguredAudioObjectStore } = require(dispatcherBundle);
    const { createR2AudioObjectStore } = require(r2Bundle);
    const {
      AUDIO_UPLOAD_PART_MAX_BYTES,
      AUDIO_UPLOAD_PART_PATH_PATTERN,
      createAudioUploadPartBodyParser
    } = require(uploadTransportBundle);

    assert.equal(AUDIO_UPLOAD_PART_MAX_BYTES, 6 * 1024 * 1024);
    const uploadTransportApp = express();
    uploadTransportApp.use(AUDIO_UPLOAD_PART_PATH_PATTERN, createAudioUploadPartBodyParser());
    uploadTransportApp.use(express.json());
    const receivePart = (request, response) => {
      if (!Buffer.isBuffer(request.body)) {
        return response.status(415).json({ error: 'binary body required' });
      }
      return response.json({ hex: request.body.toString('hex') });
    };
    uploadTransportApp.put('/api/talent/audio/uploads/:uploadSessionId/parts/:partNumber', receivePart);
    uploadTransportApp.put('/api/talent/audio/uploads-sibling/:uploadSessionId/parts/:partNumber', receivePart);

    const uploadTransportServer = await new Promise((resolve, reject) => {
      const listeningServer = uploadTransportApp.listen(0, '127.0.0.1', () => resolve(listeningServer));
      listeningServer.once('error', reject);
    });
    try {
      const address = uploadTransportServer.address();
      assert(address && typeof address === 'object');
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const exactPart = Buffer.from([0, 1, 2, 3, 254, 255]);
      const validResponse = await fetch(`${baseUrl}/api/talent/audio/uploads/session-1/parts/1`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: exactPart
      });
      assert.equal(validResponse.status, 200, 'Nested upload-part paths must reach the raw body parser.');
      assert.deepEqual(await validResponse.json(), { hex: exactPart.toString('hex') });

      const wrongTypeResponse = await fetch(`${baseUrl}/api/talent/audio/uploads/session-1/parts/1`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      assert.equal(wrongTypeResponse.status, 415, 'Non-binary upload parts must remain rejected.');

      const siblingResponse = await fetch(`${baseUrl}/api/talent/audio/uploads-sibling/session-1/parts/1`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: exactPart
      });
      assert.equal(siblingResponse.status, 415, 'The raw parser must not attach to sibling route prefixes.');
    } finally {
      await new Promise((resolve, reject) => {
        uploadTransportServer.close((error) => error ? reject(error) : resolve());
      });
    }

    const localStore = createConfiguredAudioObjectStore({
      NODE_ENV: 'development',
      SWAY_AUDIO_STORAGE_PROVIDER: 'local_private_fs',
      SWAY_AUDIO_LOCAL_OBJECT_DIR: join(tempRoot, 'local'),
      SWAY_AUDIO_LOCAL_BUCKET: 'sway-audio-local'
    });
    await localStore.verifyReady();
    const localPlan = localStore.planUploadIdentity({
      projectId: 'local-project',
      uploadSessionId: 'local-upload',
      filename: 'master.wav',
      mimeType: 'audio/wav'
    });
    assert.deepEqual(
      localPlan,
      localStore.planUploadIdentity({
        projectId: 'local-project',
        uploadSessionId: 'local-upload',
        filename: 'master.wav',
        mimeType: 'audio/wav'
      }),
      'Local planned identity must be deterministic.'
    );
    assert.deepEqual(
      await localStore.reconcileUpload({ identity: localPlan, uploadSessionId: 'local-upload' }),
      { status: 'absent' }
    );
    const localIdentity = await localStore.beginUpload({
      projectId: 'local-project',
      uploadSessionId: 'local-upload',
      filename: 'master.wav',
      mimeType: 'audio/wav',
      identity: localPlan
    });
    assert.deepEqual(
      await localStore.reconcileUpload({ identity: localPlan, uploadSessionId: 'local-upload' }),
      { status: 'found', identity: localIdentity }
    );
    await localStore.abortUpload(localIdentity);
    assert.equal((await localStore.reconcileCleanup(localIdentity)).status, 'absent');
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
    const uploadInput = {
      projectId: 'project-1',
      uploadSessionId: 'upload-1',
      filename: 'master.wav',
      mimeType: 'audio/wav'
    };
    const plannedIdentity = store.planUploadIdentity(uploadInput);
    assert.deepEqual(plannedIdentity, store.planUploadIdentity(uploadInput));
    assert.deepEqual(
      await store.reconcileUpload({ identity: plannedIdentity, uploadSessionId: 'upload-1' }),
      { status: 'absent' }
    );
    client.failAfterApply = 'CreateMultipartUploadCommand';
    await assert.rejects(
      store.beginUpload({ ...uploadInput, identity: plannedIdentity }),
      /simulated lost CreateMultipartUploadCommand response/
    );
    const recoveredInitiation = await store.reconcileUpload({
      identity: plannedIdentity,
      uploadSessionId: 'upload-1'
    });
    assert.equal(recoveredInitiation.status, 'found', 'Lost create response must reconcile by exact deterministic key.');
    const identity = recoveredInitiation.identity;
    assert.equal(identity.storageProvider, 'r2');
    assert.equal(identity.storageKey, 'masters/projects/project-1/uploads/upload-1/master.wav');

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
      const partMd5 = createHash('md5').update(chunks[index]).digest('hex');
      assert.deepEqual(
        await store.reconcilePart({
          identity,
          partNumber: index + 1,
          expectedByteSize: chunks[index].byteLength,
          expectedMd5: partMd5
        }),
        { status: 'confirmed', etag: partMd5, byteSize: chunks[index].byteLength },
        'Lost part response must reconcile by exact part number, size, and provider-validated MD5.'
      );
    }
    assert.equal((await store.reconcilePart({
      identity,
      partNumber: 1,
      expectedByteSize: chunks[0].byteLength,
      expectedMd5: '0'.repeat(32)
    })).status, 'mismatch');
    assert.deepEqual(await store.reconcilePart({
      identity,
      partNumber: 3,
      expectedByteSize: 1,
      expectedMd5: '0'.repeat(32)
    }), { status: 'absent' });
    const sha256 = createHash('sha256').update(original).digest('hex');
    assert.deepEqual(
      await store.reconcileAssembly({
        identity,
        expectedByteSize: original.byteLength,
        expectedSha256: sha256
      }),
      { status: 'multipart_open' }
    );
    client.failAfterApply = 'CompleteMultipartUploadCommand';
    await assert.rejects(
      store.assembleParts({
        identity,
        parts,
        expectedByteSize: original.byteLength,
        expectedSha256: sha256,
        mimeType: 'audio/wav'
      }),
      /simulated lost CompleteMultipartUploadCommand response/
    );
    assert.deepEqual(
      await store.reconcileAssembly({
        identity,
        expectedByteSize: original.byteLength,
        expectedSha256: sha256
      }),
      { status: 'staging', byteSize: original.byteLength, sha256 },
      'Lost completion response must reconcile the exact staging bytes before retry.'
    );
    assert.deepEqual(await store.assembleParts({
      identity,
      parts,
      expectedByteSize: original.byteLength,
      expectedSha256: sha256,
      mimeType: 'audio/wav'
    }), { byteSize: original.byteLength, sha256 });
    assert.deepEqual(
      await store.reconcileAssembly({
        identity,
        expectedByteSize: original.byteLength,
        expectedSha256: sha256
      }),
      { status: 'sealed', byteSize: original.byteLength, sha256 }
    );
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
    assert.deepEqual(restartedStore.planUploadIdentity(uploadInput), plannedIdentity);
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

    const ambiguousInput = {
      projectId: 'project-1',
      uploadSessionId: 'ambiguous-1',
      filename: 'ambiguous.wav',
      mimeType: 'audio/wav'
    };
    const ambiguousPlan = store.planUploadIdentity(ambiguousInput);
    const ambiguousOne = await store.beginUpload({ ...ambiguousInput, identity: ambiguousPlan });
    const ambiguousTwo = await store.beginUpload({ ...ambiguousInput, identity: ambiguousPlan });
    client.multipartPageSize = 1;
    const ambiguous = await store.reconcileUpload({
      identity: ambiguousPlan,
      uploadSessionId: 'ambiguous-1'
    });
    assert.equal(ambiguous.status, 'ambiguous');
    assert.equal(ambiguous.identities.length, 2, 'Multiple exact uploads must be reported, never guessed.');
    client.multipartPageSize = Number.POSITIVE_INFINITY;
    await store.abortUpload(ambiguousOne);
    await store.abortUpload(ambiguousTwo);

    const orphan = await store.beginUpload({
      projectId: 'project-1',
      uploadSessionId: 'orphan-1',
      filename: 'orphan.wav',
      mimeType: 'audio/wav'
    });
    assert.equal(client.uploads.has(orphan.providerUploadId), true);
    assert.equal((await store.reconcileCleanup(orphan)).status, 'present');
    await store.abortUpload(orphan);
    assert.equal(client.uploads.has(orphan.providerUploadId), false, 'Aborted database work must not leave an R2 multipart upload.');
    assert.deepEqual(await store.reconcileCleanup(orphan), {
      status: 'absent',
      multipartPresent: false,
      stagingPresent: false,
      sealedPresent: false
    });

    const lostCleanup = await store.beginUpload({
      projectId: 'project-1',
      uploadSessionId: 'lost-cleanup-1',
      filename: 'lost-cleanup.wav',
      mimeType: 'audio/wav'
    });
    client.failAfterApply = 'DeleteObjectCommand';
    await assert.rejects(
      store.discardUpload(lostCleanup),
      /could not fully discard a failed audio upload/
    );
    assert.deepEqual(await store.reconcileCleanup(lostCleanup), {
      status: 'absent',
      multipartPresent: false,
      stagingPresent: false,
      sealedPresent: false
    }, 'Lost cleanup response must reconcile exact absence before durable finalization.');

    const failedIntegrity = await store.beginUpload({
      projectId: 'project-1',
      uploadSessionId: 'failed-integrity-1',
      filename: 'failed.wav',
      mimeType: 'audio/wav'
    });
    const failedBytes = Buffer.from('RIFF0000WAVE failed integrity proof');
    const failedPart = await store.writePart({
      identity: failedIntegrity,
      partNumber: 1,
      body: failedBytes
    });
    await assert.rejects(
      store.assembleParts({
        identity: failedIntegrity,
        parts: [{ partNumber: 1, etag: failedPart.etag }],
        expectedByteSize: failedBytes.byteLength,
        expectedSha256: '0'.repeat(64),
        mimeType: 'audio/wav'
      }),
      /integrity mismatch/
    );
    assert.equal(client.objects.has(failedIntegrity.storageKey), true, 'A provider copy may exist before final integrity verification fails.');
    await store.discardUpload(failedIntegrity);
    assert.equal(client.uploads.has(failedIntegrity.providerUploadId), false, 'Failed-upload discard must remove multipart state.');
    assert.equal(client.objects.has(failedIntegrity.storageKey), false, 'Failed-upload discard must remove the unsealed target object.');
    assert.equal(
      [...client.objects.keys()].some((key) => key.includes('/failed-integrity-1/')),
      false,
      'Failed-upload discard must remove completed staging bytes.'
    );
    assert.equal((await store.reconcileCleanup(failedIntegrity)).status, 'absent');
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
