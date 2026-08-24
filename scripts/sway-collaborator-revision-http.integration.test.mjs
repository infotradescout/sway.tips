import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { createSwayDb } from '../src/db/client.ts';
import {
  audioCandidateRevisions,
  audioFileConnections,
  audioObjectCleanupReceipts,
  audioProviderOperations,
  audioUploadParts,
  audioUploadSessions,
  performerCapabilityGrantEvents,
  performers,
  users
} from '../src/db/schema.ts';
import { createLocalAudioObjectStore } from '../src/server/audio-object-storage-local.ts';
import { createAudioPublishingService } from '../src/server/audio-publishing-service.ts';
import { createPerformerSessionStore } from '../src/server/performer-session-store.ts';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof.ts';

const MIB = 1024 * 1024;
const PART_LIMIT_BYTES = 6 * MIB;
const MAX_CANDIDATE_BYTES = 8 * MIB;
const LOCAL_BUCKET = 'wave5a-http-proof';

function sha256(body) {
  return createHash('sha256').update(body).digest('hex');
}

function wavFixture(label) {
  const dataSize = 800;
  const body = Buffer.alloc(44 + dataSize, 0x80);
  body.write('RIFF', 0, 'ascii');
  body.writeUInt32LE(body.byteLength - 8, 4);
  body.write('WAVE', 8, 'ascii');
  body.write('fmt ', 12, 'ascii');
  body.writeUInt32LE(16, 16);
  body.writeUInt16LE(1, 20);
  body.writeUInt16LE(1, 22);
  body.writeUInt32LE(8_000, 24);
  body.writeUInt32LE(8_000, 28);
  body.writeUInt16LE(1, 32);
  body.writeUInt16LE(8, 34);
  body.write('data', 36, 'ascii');
  body.writeUInt32LE(dataSize, 40);
  Buffer.from(label).copy(body, 44, 0, dataSize);
  return body;
}

function snapshotStorageTree(root) {
  const snapshot = [];
  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const relativePath = relative(root, absolutePath).split(sep).join('/');
      if (entry.isDirectory()) {
        snapshot.push('dir:' + relativePath);
        visit(absolutePath);
      } else if (entry.isFile()) {
        const body = readFileSync(absolutePath);
        snapshot.push('file:' + relativePath + ':' + statSync(absolutePath).size + ':' + sha256(body));
      } else {
        throw new Error('Unexpected object-store entry type: ' + absolutePath);
      }
    }
  };
  visit(root);
  return snapshot;
}

function normalizedKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function assertRecursivelyExcludesInternals(value, label, extraForbidden = []) {
  const forbidden = new Set([
    'storageprovider',
    'storagebucket',
    'storagekey',
    'provideruploadid',
    'requestfingerprint',
    'idempotencykey',
    'idempotencykeyhash',
    'intentfingerprint',
    ...extraForbidden.map(normalizedKey)
  ]);
  const visit = (candidate, path) => {
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => visit(entry, path + '[' + index + ']'));
      return;
    }
    if (!candidate || typeof candidate !== 'object') return;
    for (const [key, child] of Object.entries(candidate)) {
      const normalized = normalizedKey(key);
      assert.equal(
        forbidden.has(normalized) || normalized.startsWith('idempotency'),
        false,
        label + ' leaked internal field at ' + path + '.' + key
      );
      visit(child, path + '.' + key);
    }
  };
  visit(value, '$');
}

function assertExactKeys(value, expectedKeys, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), label + ' must be an object.');
  assert.deepEqual(Object.keys(value).sort(), [...expectedKeys].sort(), label + ' shape changed.');
}

async function reservePort() {
  const socket = createNetServer();
  await new Promise((resolveReady, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolveReady);
  });
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('Unable to reserve an HTTP proof port.');
  await new Promise((resolveClosed, reject) => {
    socket.close((error) => error ? reject(error) : resolveClosed());
  });
  return address.port;
}

async function startSwayServer(input) {
  const port = await reservePort();
  const baseUrl = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DATABASE_URL: input.databaseUrl,
      APP_URL: baseUrl,
      APP_BASE_URL: baseUrl,
      SWAY_APP_BASE_URL: baseUrl,
      SWAY_API_ONLY_TEST_MODE: 'true',
      SWAY_SKIP_STARTUP_BUSINESS_STATE_HYDRATION: 'true',
      SWAY_STARTUP_DIAGNOSTICS: 'true',
      VITE_SWAY_DEMO_MODE: 'false',
      DISABLE_HMR: 'true',
      SWAY_LIVE_ROOM_DURABILITY_WRITES_DISABLED: 'false',
      SWAY_AUDIO_STORAGE_PROVIDER: 'local_private_fs',
      SWAY_AUDIO_LOCAL_OBJECT_DIR: input.objectRoot,
      SWAY_AUDIO_LOCAL_BUCKET: LOCAL_BUCKET,
      SWAY_AUDIO_WORKSPACE_LIMIT_BYTES: String(input.workspaceLimitBytes ?? 64 * MIB),
      SWAY_AUDIO_WORKING_OBJECT_LIMIT: '100',
      SWAY_AUDIO_COLLABORATOR_REVISION_UPLOAD_ENABLED: input.candidateUploadsEnabled ? 'true' : 'false',
      SWAY_AUDIO_R2_ACCOUNT_ID: '',
      SWAY_AUDIO_R2_ACCESS_KEY_ID: '',
      SWAY_AUDIO_R2_SECRET_ACCESS_KEY: '',
      SWAY_AUDIO_R2_BUCKET: '',
      STRIPE_SECRET_KEY: '',
      STRIPE_PUBLISHABLE_KEY: '',
      STRIPE_WEBHOOK_SECRET: '',
      VITE_STRIPE_PUBLISHABLE_KEY: '',
      SWAY_EMAIL_PROVIDER: '',
      SWAY_EMAIL_API_KEY: '',
      SWAY_EMAIL_FROM: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  const appendOutput = (chunk) => {
    output = (output + chunk.toString('utf8')).slice(-30_000);
  };
  child.stdout.on('data', appendOutput);
  child.stderr.on('data', appendOutput);

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Sway HTTP proof server exited before readiness.\n' + output);
    }
    try {
      const response = await fetch(baseUrl + '/api/build-marker', {
        signal: AbortSignal.timeout(3_000)
      });
      if (response.ok) {
        return {
          baseUrl,
          child,
          logs: () => output
        };
      }
    } catch {
      // The actual Express server has not started listening yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }

  child.kill('SIGTERM');
  throw new Error('Sway HTTP proof server did not become ready.\n' + output);
}

async function stopSwayServer(server) {
  if (!server || server.child.exitCode !== null || server.child.signalCode !== null) return;
  const stopped = new Promise((resolveStopped) => server.child.once('exit', resolveStopped));
  server.child.kill('SIGTERM');
  await Promise.race([
    stopped,
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 4_000))
  ]);
  if (server.child.exitCode === null && server.child.signalCode === null) {
    server.child.kill('SIGKILL');
  }
}

async function request(server, path, input = {}) {
  const headers = new Headers(input.headers);
  if (input.token) headers.set('authorization', 'Bearer ' + input.token);
  const response = await fetch(server.baseUrl + path, {
    method: input.method || 'GET',
    headers,
    body: input.body,
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000)
  });
  const text = await response.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { text };
    }
  }
  return { status: response.status, body, headers: response.headers };
}

function assertStatus(response, expected, label, server) {
  assert.equal(
    response.status,
    expected,
    label + ': ' + JSON.stringify(response.body) + '\n' + server.logs()
  );
}

async function countUploadParts(db, uploadSessionId) {
  const rows = await db
    .select({ id: audioUploadParts.id })
    .from(audioUploadParts)
    .where(uploadSessionId ? eq(audioUploadParts.uploadSessionId, uploadSessionId) : undefined);
  return rows.length;
}

async function removeExactTempRoot(tempRoot) {
  const resolvedTarget = resolve(tempRoot);
  const resolvedTemp = resolve(tmpdir());
  if (resolvedTarget === resolvedTemp || !resolvedTarget.startsWith(resolvedTemp + sep)) {
    throw new Error('Refusing to remove unexpected HTTP proof directory: ' + resolvedTarget);
  }
  await rm(resolvedTarget, { recursive: true, force: true });
}

const embeddedPostgres = await startEmbeddedPostgresProof('wave5a_candidate_http_boundary');
const db = createSwayDb(embeddedPostgres.databaseUrl);
const tempRoot = await mkdtemp(join(tmpdir(), 'sway-wave5a-http-'));
const objectRoot = join(tempRoot, 'objects');
let disabledServer = null;
let enabledServer = null;

try {
  const [ownerUserId, collaboratorUserId, outsiderUserId] = [
    randomUUID(),
    randomUUID(),
    randomUUID()
  ].sort();
  await db.insert(users).values([
    {
      id: ownerUserId,
      email: 'wave5a-http-owner-' + ownerUserId + '@example.test',
      emailVerifiedAt: new Date()
    },
    {
      id: collaboratorUserId,
      email: 'wave5a-http-collaborator-' + collaboratorUserId + '@example.test',
      emailVerifiedAt: new Date()
    },
    {
      id: outsiderUserId,
      email: 'wave5a-http-outsider-' + outsiderUserId + '@example.test',
      emailVerifiedAt: new Date()
    }
  ]);
  const [performer] = await db.insert(performers).values({
    ownerUserId,
    displayName: 'Wave 5A HTTP boundary proof'
  }).returning();

  const store = createLocalAudioObjectStore({
    SWAY_AUDIO_LOCAL_OBJECT_DIR: objectRoot,
    SWAY_AUDIO_LOCAL_BUCKET: LOCAL_BUCKET
  });
  await store.verifyReady();
  const publishing = createAudioPublishingService({
    db,
    store,
    collaboratorRevisionUploadsEnabled: true,
    workspaceLimitBytes: 64 * MIB,
    workingObjectLimit: 100
  });
  const project = await publishing.createProject({
    performerId: performer.id,
    actorUserId: ownerUserId,
    title: 'Wave 5A route source'
  });
  const sourceBody = wavFixture('source');
  const sourceUpload = await publishing.initiateUpload({
    projectId: project.id,
    actorUserId: ownerUserId,
    title: 'source.wav',
    assetKind: 'master_audio',
    originalFilename: 'source.wav',
    mimeType: 'audio/wav',
    expectedByteSize: sourceBody.byteLength,
    expectedSha256: sha256(sourceBody),
    idempotencyKey: 'wave5a-http-source'
  });
  await publishing.writeUploadPart({
    uploadSessionId: sourceUpload.id,
    actorUserId: ownerUserId,
    partNumber: 1,
    body: sourceBody
  });
  const sourceVersion = await publishing.completeAndSealUpload({
    uploadSessionId: sourceUpload.id,
    actorUserId: ownerUserId,
    performerId: performer.id
  });

  await db.insert(performerCapabilityGrantEvents).values({
    performerId: performer.id,
    capability: 'private_collaboration',
    decision: 'granted',
    actorType: 'system',
    actorUserId: null,
    reason: 'Disposable Wave 5A real HTTP boundary proof',
    evidence: { proof: 'wave5a_candidate_http_boundary' },
    expiresAt: null,
    idempotencyKeyHash: sha256(Buffer.from('wave5a-http-private-collaboration:' + performer.id))
  });

  const [memberOneUserId, memberTwoUserId] = [ownerUserId, collaboratorUserId].sort();
  const [connection] = await db.insert(audioFileConnections).values({
    memberOneUserId,
    memberTwoUserId,
    createdByUserId: ownerUserId,
    createdFromPurpose: 'request_files'
  }).returning();

  const sessionStore = createPerformerSessionStore({ dbOverride: db });
  const ownerSession = await sessionStore.issueSession({ actorUserId: ownerUserId });
  const collaboratorSession = await sessionStore.issueSession({ actorUserId: collaboratorUserId });
  const outsiderSession = await sessionStore.issueSession({ actorUserId: outsiderUserId });

  const storageBeforeDisabledRequest = snapshotStorageTree(objectRoot);
  const uploadPartCountBeforeDisabledRequest = await countUploadParts(db);
  const oversizedBody = Buffer.alloc(PART_LIMIT_BYTES + 1, 0x61);
  disabledServer = await startSwayServer({
    databaseUrl: embeddedPostgres.databaseUrl,
    objectRoot,
    candidateUploadsEnabled: false
  });
  const disabledPart = await request(
    disabledServer,
    '/api/talent/audio/file-grants/' + randomUUID() + '/candidate-uploads/' + randomUUID() + '/parts/1',
    {
      method: 'PUT',
      token: collaboratorSession.token,
      headers: { 'content-type': 'application/octet-stream' },
      body: oversizedBody
    }
  );
  assertStatus(disabledPart, 503, 'Disabled candidate route must fail before its 6 MiB parser', disabledServer);
  assert.equal(disabledPart.body.code, 'candidate_uploads_disabled');
  assert.deepEqual(
    snapshotStorageTree(objectRoot),
    storageBeforeDisabledRequest,
    'Feature-flag rejection must not mutate private object storage.'
  );
  assert.equal(
    await countUploadParts(db),
    uploadPartCountBeforeDisabledRequest,
    'Feature-flag rejection must not persist an upload part.'
  );
  await stopSwayServer(disabledServer);
  disabledServer = null;

  enabledServer = await startSwayServer({
    databaseUrl: embeddedPostgres.databaseUrl,
    objectRoot,
    candidateUploadsEnabled: true
  });

  const grantResponse = await request(
    enabledServer,
    '/api/talent/audio/pairing/connections/' + connection.id + '/candidate-revision-grants',
    {
      method: 'POST',
      token: ownerSession.token,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        versionId: sourceVersion.id,
        idempotencyKey: 'wave5a-http-candidate-grant',
        maxCandidateBytes: MAX_CANDIDATE_BYTES,
        expiresInHours: 24
      })
    }
  );
  assertStatus(grantResponse, 201, 'Exact creator grant route', enabledServer);
  assertExactKeys(grantResponse.body, ['grant', 'reused'], 'Candidate grant envelope');
  assertExactKeys(grantResponse.body.grant, [
    'id',
    'connectionId',
    'sourceAssetVersionId',
    'granteeUserId',
    'canUploadCandidateRevision',
    'maxCandidateBytes',
    'expiresAt'
  ], 'Candidate grant DTO');
  assert.equal(grantResponse.body.grant.granteeUserId, collaboratorUserId);
  assert.equal(grantResponse.body.grant.canUploadCandidateRevision, true);
  assert.equal(grantResponse.body.grant.maxCandidateBytes, MAX_CANDIDATE_BYTES);
  assert.equal(grantResponse.body.reused, false);
  assertRecursivelyExcludesInternals(grantResponse.body, 'Candidate grant DTO');
  const grantId = String(grantResponse.body.grant.id);

  await stopSwayServer(enabledServer);
  enabledServer = await startSwayServer({
    databaseUrl: embeddedPostgres.databaseUrl,
    objectRoot,
    candidateUploadsEnabled: true,
    workspaceLimitBytes: 1 * MIB
  });
  const quotaResponse = await request(
    enabledServer,
    '/api/talent/audio/file-grants/' + grantId + '/candidate-uploads',
    {
      method: 'POST',
      token: collaboratorSession.token,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        originalFilename: 'quota-denied.wav',
        mimeType: 'audio/wav',
        expectedByteSize: 2 * MIB,
        expectedSha256: 'f'.repeat(64),
        idempotencyKey: 'wave5a-http-quota-denial'
      })
    }
  );
  assertStatus(quotaResponse, 413, 'Candidate quota denial', enabledServer);
  assertExactKeys(quotaResponse.body, ['error', 'code'], 'Candidate quota denial DTO');
  assert.equal(quotaResponse.body.code, 'audio_workspace_limit_exceeded');
  assertRecursivelyExcludesInternals(quotaResponse.body, 'Candidate quota denial DTO', [
    'workspaceLimitBytes',
    'workingBytes',
    'availableWorkspaceBytes',
    'workingObjectCount',
    'workingObjectLimit',
    'releaseCountLimit',
    'requestedBytes'
  ]);
  await stopSwayServer(enabledServer);
  enabledServer = await startSwayServer({
    databaseUrl: embeddedPostgres.databaseUrl,
    objectRoot,
    candidateUploadsEnabled: true
  });

  const candidateBody = wavFixture('candidate');
  const initiationResponse = await request(
    enabledServer,
    '/api/talent/audio/file-grants/' + grantId + '/candidate-uploads',
    {
      method: 'POST',
      token: collaboratorSession.token,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        originalFilename: 'candidate.wav',
        mimeType: 'audio/wav',
        expectedByteSize: candidateBody.byteLength,
        expectedSha256: sha256(candidateBody),
        idempotencyKey: 'wave5a-http-candidate-upload'
      })
    }
  );
  assertStatus(initiationResponse, 201, 'Exact collaborator initiation route', enabledServer);
  assertExactKeys(initiationResponse.body, ['uploadSession'], 'Candidate initiation envelope');
  assertExactKeys(initiationResponse.body.uploadSession, [
    'id',
    'expectedByteSize',
    'partSizeBytes',
    'expectedPartCount',
    'uploadStatus',
    'expiresAt'
  ], 'Candidate initiation DTO');
  assertRecursivelyExcludesInternals(initiationResponse.body, 'Candidate initiation DTO');
  assert.equal(initiationResponse.body.uploadSession.expectedByteSize, candidateBody.byteLength);
  assert.equal(initiationResponse.body.uploadSession.expectedPartCount, 1);
  assert.equal(initiationResponse.body.uploadSession.uploadStatus, 'initiated');
  const uploadSessionId = String(initiationResponse.body.uploadSession.id);

  const [durableSession] = await db
    .select()
    .from(audioUploadSessions)
    .where(eq(audioUploadSessions.id, uploadSessionId));
  assert.ok(durableSession, 'Candidate initiation must persist its upload session.');
  assert.ok(durableSession.storageProvider);
  assert.ok(durableSession.storageBucket);
  assert.ok(durableSession.storageKey);
  assert.ok(durableSession.providerUploadId);
  assert.ok(durableSession.requestFingerprint);
  assert.ok(durableSession.idempotencyKey);

  const partPath = '/api/talent/audio/file-grants/' + grantId
    + '/candidate-uploads/' + uploadSessionId + '/parts/1';
  const storageBeforeRejectedParts = snapshotStorageTree(objectRoot);
  const anonymousPart = await request(enabledServer, partPath, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: oversizedBody
  });
  assertStatus(anonymousPart, 401, 'Anonymous binary route must fail before its parser', enabledServer);

  const wrongActorPart = await request(enabledServer, partPath, {
    method: 'PUT',
    token: outsiderSession.token,
    headers: { 'content-type': 'application/octet-stream' },
    body: oversizedBody
  });
  assertStatus(wrongActorPart, 403, 'Wrong actor binary route must fail before its parser', enabledServer);

  const wrongGrantPart = await request(
    enabledServer,
    '/api/talent/audio/file-grants/' + randomUUID()
      + '/candidate-uploads/' + uploadSessionId + '/parts/1',
    {
      method: 'PUT',
      token: collaboratorSession.token,
      headers: { 'content-type': 'application/octet-stream' },
      body: candidateBody
    }
  );
  assertStatus(wrongGrantPart, 403, 'Wrong grant must be rejected at the Express authority boundary', enabledServer);

  const wrongSessionPart = await request(
    enabledServer,
    '/api/talent/audio/file-grants/' + grantId
      + '/candidate-uploads/' + randomUUID() + '/parts/1',
    {
      method: 'PUT',
      token: collaboratorSession.token,
      headers: { 'content-type': 'application/octet-stream' },
      body: candidateBody
    }
  );
  assertStatus(
    wrongSessionPart,
    403,
    'wrong-session binary request must not reach the raw parser',
    enabledServer
  );
  assert.equal(
    await countUploadParts(db, uploadSessionId),
    0,
    'Rejected binary requests must not persist upload-part records.'
  );
  assert.deepEqual(
    snapshotStorageTree(objectRoot),
    storageBeforeRejectedParts,
    'Rejected binary requests must not write private object-storage parts.'
  );

  const partResponse = await request(enabledServer, partPath, {
    method: 'PUT',
    token: collaboratorSession.token,
    headers: { 'content-type': 'application/octet-stream' },
    body: candidateBody
  });
  assertStatus(partResponse, 200, 'Exact collaborator part route', enabledServer);
  assertExactKeys(partResponse.body, ['part'], 'Candidate part envelope');
  assertExactKeys(partResponse.body.part, ['partNumber', 'byteSize'], 'Candidate part DTO');
  assertRecursivelyExcludesInternals(partResponse.body, 'Candidate part DTO', ['provider_etag', 'provider_checksum']);
  assert.equal(partResponse.body.part.partNumber, 1);
  assert.equal(partResponse.body.part.byteSize, candidateBody.byteLength);

  const [durablePart] = await db
    .select()
    .from(audioUploadParts)
    .where(eq(audioUploadParts.uploadSessionId, uploadSessionId));
  assert.ok(
    durablePart?.providerEtag,
    'provider etag must be persisted even though it is not returned'
  );

  const completionResponse = await request(
    enabledServer,
    '/api/talent/audio/file-grants/' + grantId
      + '/candidate-uploads/' + uploadSessionId + '/complete',
    {
      method: 'POST',
      token: collaboratorSession.token
    }
  );
  assertStatus(completionResponse, 200, 'Exact collaborator completion route', enabledServer);
  assertExactKeys(completionResponse.body, ['candidate'], 'Candidate completion envelope');
  assertExactKeys(completionResponse.body.candidate, [
    'id',
    'sourceAssetVersionId',
    'originalFilename',
    'mimeType',
    'byteSize',
    'sha256',
    'durationMs',
    'codec',
    'sampleRateHz',
    'bitDepth',
    'channelCount',
    'intakeStatus',
    'sealedAt'
  ], 'Candidate completion DTO');
  assertRecursivelyExcludesInternals(completionResponse.body, 'Candidate completion DTO');
  assert.equal(completionResponse.body.candidate.sourceAssetVersionId, sourceVersion.id);
  assert.equal(completionResponse.body.candidate.sha256, sha256(candidateBody));
  assert.equal(completionResponse.body.candidate.intakeStatus, 'private_review');

  const [durableCandidate] = await db
    .select()
    .from(audioCandidateRevisions)
    .where(eq(audioCandidateRevisions.id, String(completionResponse.body.candidate.id)));
  assert.ok(durableCandidate, 'Candidate completion must persist the sealed candidate.');
  assert.ok(durableCandidate.storageProvider);
  assert.ok(durableCandidate.storageBucket);
  assert.ok(durableCandidate.storageKey);

  const candidateObjectPath = resolve(
    objectRoot,
    durableCandidate.storageBucket,
    ...durableCandidate.storageKey.split('/'),
    'original.bin'
  );
  const resolvedObjectRoot = resolve(objectRoot);
  assert.ok(
    candidateObjectPath.startsWith(resolvedObjectRoot + sep),
    'Candidate HTTP proof may remove only the exact object inside its disposable root.'
  );

  const candidateContentPath = '/api/talent/audio/file-grants/' + grantId
    + '/candidates/' + durableCandidate.id + '/content';
  const outsiderExistingCandidate = await request(enabledServer, candidateContentPath, {
    token: outsiderSession.token
  });
  const outsiderMissingCandidate = await request(
    enabledServer,
    '/api/talent/audio/file-grants/' + randomUUID() + '/candidates/' + randomUUID() + '/content',
    { token: outsiderSession.token }
  );
  for (const [label, response] of [
    ['existing', outsiderExistingCandidate],
    ['missing', outsiderMissingCandidate]
  ]) {
    assertStatus(response, 404, 'Outsider ' + label + ' candidate lookup', enabledServer);
    assertExactKeys(response.body, ['error', 'correlationId'], 'Outsider ' + label + ' candidate DTO');
    assert.match(response.body.correlationId, /^[0-9a-f]{24}$/);
  }
  assert.equal(
    outsiderExistingCandidate.body.error,
    outsiderMissingCandidate.body.error,
    'Outsiders must receive the same message for existing and missing private candidates.'
  );

  // The real revoke route must atomically leave cleanup intent even when the
  // provider created multipart state but the upload session does not exist yet.
  // A response may not say cleanup is complete until due recovery proves the
  // exact provider identity absent.
  const revocationRaceSourceBody = wavFixture('route revocation race source');
  const revocationRaceSourceUpload = await publishing.initiateUpload({
    projectId: project.id,
    actorUserId: ownerUserId,
    title: 'route-revocation-source.wav',
    assetKind: 'master_audio',
    originalFilename: 'route-revocation-source.wav',
    mimeType: 'audio/wav',
    expectedByteSize: revocationRaceSourceBody.byteLength,
    expectedSha256: sha256(revocationRaceSourceBody),
    idempotencyKey: 'wave5b-http-revocation-source'
  });
  await publishing.writeUploadPart({
    uploadSessionId: revocationRaceSourceUpload.id,
    actorUserId: ownerUserId,
    partNumber: 1,
    body: revocationRaceSourceBody
  });
  const revocationRaceSource = await publishing.completeAndSealUpload({
    uploadSessionId: revocationRaceSourceUpload.id,
    actorUserId: ownerUserId,
    performerId: performer.id
  });
  const revocationRaceGrantResponse = await request(
    enabledServer,
    '/api/talent/audio/pairing/connections/' + connection.id + '/candidate-revision-grants',
    {
      method: 'POST',
      token: ownerSession.token,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        versionId: revocationRaceSource.id,
        idempotencyKey: 'wave5b-http-sessionless-revocation-grant',
        maxCandidateBytes: MAX_CANDIDATE_BYTES,
        expiresInHours: 24
      })
    }
  );
  assertStatus(revocationRaceGrantResponse, 201, 'Sessionless revocation race grant', enabledServer);
  const revocationRaceGrantId = String(revocationRaceGrantResponse.body.grant.id);
  let releaseRevocationRaceInitiation;
  let signalRevocationRaceInitiated;
  const revocationRaceInitiated = new Promise((resolveStarted) => {
    signalRevocationRaceInitiated = resolveStarted;
  });
  const revocationRaceBarrier = new Promise((resolveRelease) => {
    releaseRevocationRaceInitiation = resolveRelease;
  });
  const revocationRaceStore = {
    ...store,
    async beginUpload(input) {
      const identity = await store.beginUpload(input);
      signalRevocationRaceInitiated(identity);
      await revocationRaceBarrier;
      return identity;
    }
  };
  const revocationRacePublishing = createAudioPublishingService({
    db,
    store: revocationRaceStore,
    collaboratorRevisionUploadsEnabled: true,
    workspaceLimitBytes: 64 * MIB,
    workingObjectLimit: 100
  });
  const revocationRaceBody = wavFixture('route sessionless revocation race');
  const revocationRaceInitiation = revocationRacePublishing.initiateCollaboratorRevisionUpload({
    grantId: revocationRaceGrantId,
    actorUserId: collaboratorUserId,
    originalFilename: 'route-sessionless-race.wav',
    mimeType: 'audio/wav',
    expectedByteSize: revocationRaceBody.byteLength,
    expectedSha256: sha256(revocationRaceBody),
    idempotencyKey: 'wave5b-http-sessionless-revocation-upload'
  });
  const revocationRaceIdentity = await revocationRaceInitiated;
  const revokeDuringSessionlessInitiation = await request(
    enabledServer,
    '/api/talent/audio/file-grants/' + revocationRaceGrantId + '/revoke',
    {
      method: 'POST',
      token: ownerSession.token,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Route-bound sessionless initiation cleanup proof.' })
    }
  );
  assertStatus(revokeDuringSessionlessInitiation, 202, 'Sessionless revoke cleanup must remain pending', enabledServer);
  assert.notEqual(revokeDuringSessionlessInitiation.body.candidateUploadCleanup.state, 'complete');
  assert.ok(revokeDuringSessionlessInitiation.body.candidateUploadCleanup.examinedCount >= 1);
  assert.ok(revokeDuringSessionlessInitiation.body.candidateUploadCleanup.pendingReceiptCount >= 1);
  assertRecursivelyExcludesInternals(
    revokeDuringSessionlessInitiation.body,
    'Sessionless revoke cleanup response'
  );
  releaseRevocationRaceInitiation();
  await assert.rejects(revocationRaceInitiation, /authority is no longer active/i);
  const [revocationRaceOperation] = await db
    .select()
    .from(audioProviderOperations)
    .where(and(
      eq(audioProviderOperations.operationType, 'initiate_multipart'),
      sql`${audioProviderOperations.requestPayload}->>'collaboratorFileGrantId' = ${revocationRaceGrantId}`
    ));
  assert.equal(revocationRaceOperation.uploadSessionId, null);
  const dueRevocationRace = await revocationRacePublishing.reconcileDueAudioProviderOperations({ limit: 100 });
  assert.ok(dueRevocationRace.canceledOperationIds.includes(revocationRaceOperation.id));
  await revocationRacePublishing.retryPendingAudioObjectCleanupReceipts({ limit: 100 });
  const [revocationRaceReceipt] = await db
    .select()
    .from(audioObjectCleanupReceipts)
    .where(eq(audioObjectCleanupReceipts.storageKey, revocationRaceIdentity.storageKey));
  assert.equal(revocationRaceReceipt.cleanupStatus, 'completed');
  assert.deepEqual(await store.reconcileCleanup(revocationRaceIdentity), {
    status: 'absent',
    multipartPresent: false,
    stagingPresent: false,
    sealedPresent: false
  });

  await db.insert(performerCapabilityGrantEvents).values({
    performerId: performer.id,
    capability: 'private_collaboration',
    decision: 'revoked',
    actorType: 'system',
    actorUserId: null,
    reason: 'Wave 5A HTTP authority-revocation proof',
    evidence: { proof: 'wave5a_candidate_http_authority_revoked' },
    expiresAt: null,
    idempotencyKeyHash: sha256(Buffer.from('wave5a-http-private-collaboration-revoked:' + performer.id))
  });

  const collaboratorListAfterRevocation = await request(
    enabledServer,
    '/api/talent/audio/files/shared-with-me',
    { token: collaboratorSession.token }
  );
  assertStatus(collaboratorListAfterRevocation, 200, 'Collaborator list after capability revocation', enabledServer);
  assert.equal(
    collaboratorListAfterRevocation.body.files.some((file) => file.grantId === grantId),
    false,
    'Capability revocation must remove the candidate grant from the collaborator list.'
  );

  const collaboratorOpenAfterRevocation = await request(enabledServer, candidateContentPath, {
    token: collaboratorSession.token
  });
  assertStatus(collaboratorOpenAfterRevocation, 410, 'Collaborator playback after authority revocation', enabledServer);
  assertExactKeys(
    collaboratorOpenAfterRevocation.body,
    ['error', 'code'],
    'Collaborator authority-ended candidate DTO'
  );
  assert.equal(collaboratorOpenAfterRevocation.body.code, 'candidate_upload_authority_ended');

  const creatorListAfterRevocation = await request(
    enabledServer,
    '/api/talent/audio/files/shared-by-me',
    { token: ownerSession.token }
  );
  assertStatus(creatorListAfterRevocation, 200, 'Creator retention list after capability revocation', enabledServer);
  const retainedCandidate = creatorListAfterRevocation.body.files.find((file) => file.grantId === grantId);
  assert.equal(
    retainedCandidate?.candidateId,
    durableCandidate.id,
    'A current project manager must retain the sealed candidate after upload authority ends.'
  );

  const creatorOpenAfterRevocation = await request(enabledServer, candidateContentPath, {
    token: ownerSession.token
  });
  assertStatus(creatorOpenAfterRevocation, 200, 'Creator playback after capability revocation', enabledServer);
  assert.equal(
    creatorOpenAfterRevocation.headers.get('x-sway-candidate-sha256'),
    durableCandidate.sha256,
    'Creator playback must identify the exact sealed candidate bytes.'
  );

  await rm(candidateObjectPath);
  const providerFailureResponse = await request(enabledServer, candidateContentPath, {
    token: ownerSession.token
  });
  assertStatus(providerFailureResponse, 503, 'Unknown provider read failure', enabledServer);
  assertExactKeys(
    providerFailureResponse.body,
    ['error', 'correlationId'],
    'Unknown provider read failure DTO'
  );
  assert.equal(providerFailureResponse.body.error, 'Private candidate access denied.');
  assert.match(providerFailureResponse.body.correlationId, /^[0-9a-f]{24}$/);
  const serializedProviderFailure = JSON.stringify(providerFailureResponse.body);
  const sanitizedServerLogs = enabledServer.logs();
  const privateResponseValues = [
    'Original object not found',
    durableCandidate.storageProvider,
    durableCandidate.storageBucket,
    durableCandidate.storageKey,
    candidateObjectPath
  ];
  for (const privateValue of privateResponseValues) {
    assert.equal(
      serializedProviderFailure.includes(privateValue),
      false,
      'Unknown provider errors must not expose private storage details.'
    );
  }
  for (const privateValue of privateResponseValues.filter(
    (value) => value !== durableCandidate.storageProvider
  )) {
    assert.equal(
      sanitizedServerLogs.includes(privateValue),
      false,
      'Unknown provider logs must not expose private storage details. Value: ' + privateValue
    );
  }

  console.log(
    'Sway Wave 5A/5B real Express HTTP trust-boundary proof passed: flag-off, anonymous, '
      + 'wrong-actor, wrong-grant, and wrong-session binary requests were rejected before '
      + 'parser/storage mutation; existing and missing candidates were indistinguishable to an '
      + 'outsider; authority revocation removed collaborator list/playback while preserving creator '
      + 'review; sessionless provider-initiation revocation returned 202 with durable pending cleanup; '
      + 'quota denial and provider failure responses and logs remained private; '
      + 'exact actor routes returned allowlisted initiation, part, and completion DTOs without '
      + 'provider or idempotency internals.'
  );
} finally {
  await stopSwayServer(enabledServer);
  await stopSwayServer(disabledServer);
  await embeddedPostgres.close();
  await removeExactTempRoot(tempRoot);
}
