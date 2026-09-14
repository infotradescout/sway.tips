import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, asc, eq } from 'drizzle-orm';
import { closeDisposableSwayDbProof, createSwayDb } from '../src/db/client.ts';
import {
  audioCandidateRevisions,
  audioFileConnections,
  audioProviderOperationAttempts,
  audioProviderOperations,
  audioUploadParts,
  audioUploadSessions,
  performerCapabilityGrantEvents,
  performers,
  users
} from '../src/db/schema.ts';
import { createAudioFileCollaborationService } from '../src/server/audio-file-collaboration-service.ts';
import { createLocalAudioObjectStore } from '../src/server/audio-object-storage-local.ts';
import { createAudioPublishingService } from '../src/server/audio-publishing-service.ts';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof.ts';

const WORKER_FLAG = '--process-kill-worker';
const STRICT_REAL_POSTGRES_FLAG = '--strict-real-postgres';
const WORKER_INPUT_ENV = 'SWAY_AUDIO_PROCESS_KILL_WORKER_INPUT';
const BUCKET = 'wave5b-process-kill-proof';
const LEASE_DURATION_MS = 1_000;
const PROVIDER_CALL_TIMEOUT_MS = 800;
const WORKSPACE_LIMIT_BYTES = 64 * 1024 * 1024;
const WORKING_OBJECT_LIMIT = 100;
const scriptPath = fileURLToPath(import.meta.url);

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

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function operationIdentity(operation) {
  return {
    storageProvider: operation.storageProvider,
    storageBucket: operation.storageBucket,
    storageKey: operation.storageKey,
    providerUploadId: operation.providerUploadId ?? undefined
  };
}

function parseWorkerInput() {
  const raw = process.env[WORKER_INPUT_ENV];
  if (!raw) throw new Error(`${WORKER_INPUT_ENV} is required in process-kill worker mode.`);
  const input = JSON.parse(raw);
  if (!input.databaseUrl || !input.objectRoot || !input.action) {
    throw new Error('Process-kill worker input is incomplete.');
  }
  return input;
}

async function sendWorkerMessage(message) {
  if (!process.send) throw new Error('Process-kill worker requires an IPC channel.');
  await new Promise((resolveSend, reject) => {
    process.send(message, (error) => error ? reject(error) : resolveSend());
  });
}

async function runWorker() {
  const input = parseWorkerInput();
  const db = createSwayDb(input.databaseUrl);
  const localStore = createLocalAudioObjectStore({
    SWAY_AUDIO_LOCAL_OBJECT_DIR: input.objectRoot,
    SWAY_AUDIO_LOCAL_BUCKET: BUCKET
  });
  await localStore.verifyReady();

  const pauseAfterProviderSideEffect = async (phase, evidence) => {
    if (input.crashPhase !== phase) return;
    await sendWorkerMessage({ type: 'provider-side-effect', phase, evidence });
    await new Promise(() => {});
  };
  const store = {
    ...localStore,
    async beginUpload(providerInput) {
      const identity = await localStore.beginUpload(providerInput);
      await pauseAfterProviderSideEffect('initiate', identity);
      return identity;
    },
    async writePart(providerInput) {
      const result = await localStore.writePart(providerInput);
      await pauseAfterProviderSideEffect('part', {
        identity: providerInput.identity,
        partNumber: providerInput.partNumber,
        ...result
      });
      return result;
    },
    async assembleParts(providerInput) {
      const result = await localStore.assembleParts(providerInput);
      await pauseAfterProviderSideEffect('complete', {
        identity: providerInput.identity,
        ...result
      });
      return result;
    }
  };
  const publishing = createAudioPublishingService({
    db,
    store,
    collaboratorRevisionUploadsEnabled: true,
    workspaceLimitBytes: WORKSPACE_LIMIT_BYTES,
    workingObjectLimit: WORKING_OBJECT_LIMIT,
    providerOperationLeaseDurationMs: LEASE_DURATION_MS,
    providerOperationCallTimeoutMs: PROVIDER_CALL_TIMEOUT_MS
  });

  try {
    if (input.action === 'initiate') {
      await publishing.initiateCollaboratorRevisionUpload({
        grantId: input.grantId,
        actorUserId: input.actorUserId,
        originalFilename: input.originalFilename,
        mimeType: 'audio/wav',
        expectedByteSize: input.expectedByteSize,
        expectedSha256: input.expectedSha256,
        idempotencyKey: input.idempotencyKey
      });
    } else if (input.action === 'part') {
      await publishing.writeUploadPart({
        grantId: input.grantId,
        uploadSessionId: input.uploadSessionId,
        actorUserId: input.actorUserId,
        partNumber: 1,
        body: Buffer.from(input.bodyBase64, 'base64')
      });
    } else if (input.action === 'complete') {
      await publishing.completeAndSealCollaboratorRevision({
        grantId: input.grantId,
        uploadSessionId: input.uploadSessionId,
        actorUserId: input.actorUserId
      });
    } else if (input.action === 'recover') {
      const result = await publishing.reconcileDueAudioProviderOperations({ limit: 100 });
      await sendWorkerMessage({ type: 'recovery-result', result });
      return;
    } else {
      throw new Error(`Unsupported process-kill worker action: ${input.action}`);
    }
    await sendWorkerMessage({ type: 'worker-completed-without-kill', action: input.action });
  } finally {
    await closeDisposableSwayDbProof(input.databaseUrl);
  }
}

function startWorker(input) {
  const child = spawn(process.execPath, ['--import', 'tsx', scriptPath, WORKER_FLAG], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      [WORKER_INPUT_ENV]: JSON.stringify(input)
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  let output = '';
  const appendOutput = (chunk) => {
    output = (output + chunk.toString('utf8')).slice(-30_000);
  };
  child.stdout.on('data', appendOutput);
  child.stderr.on('data', appendOutput);
  return { child, logs: () => output };
}

function waitForWorkerMessage(worker, expectedType, timeoutMs = 45_000) {
  return new Promise((resolveMessage, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${expectedType}.\n${worker.logs()}`));
    }, timeoutMs);
    const onMessage = (message) => {
      if (message?.type === 'worker-error') {
        cleanup();
        reject(new Error(`Process-kill worker failed: ${message.error}\n${worker.logs()}`));
      } else if (message?.type === expectedType) {
        cleanup();
        resolveMessage(message);
      } else if (message?.type === 'worker-completed-without-kill') {
        cleanup();
        reject(new Error(`Worker completed before the required kill point.\n${worker.logs()}`));
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(
        `Process-kill worker exited before ${expectedType} (code=${code}, signal=${signal}).\n${worker.logs()}`
      ));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      worker.child.off('message', onMessage);
      worker.child.off('exit', onExit);
      worker.child.off('error', onError);
    };
    worker.child.on('message', onMessage);
    worker.child.once('exit', onExit);
    worker.child.once('error', onError);
  });
}

async function waitForWorkerExit(worker, timeoutMs = 10_000) {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
  const exit = once(worker.child, 'exit');
  await Promise.race([
    exit,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`Timed out waiting for worker exit.\n${worker.logs()}`)),
      timeoutMs
    ))
  ]);
}

async function forceStopWorker(worker) {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
  worker.child.kill('SIGKILL');
  await waitForWorkerExit(worker);
}

async function killAtProviderSideEffect(input, expectedPhase) {
  const worker = startWorker({ ...input, crashPhase: expectedPhase });
  try {
    const message = await waitForWorkerMessage(worker, 'provider-side-effect');
    assert.equal(message.phase, expectedPhase, `Worker must stop after the ${expectedPhase} provider side effect.`);
    const killed = worker.child.kill('SIGKILL');
    assert.equal(killed, true, `The ${expectedPhase} worker must accept the explicit process kill.`);
    await waitForWorkerExit(worker);
    return message.evidence;
  } finally {
    await forceStopWorker(worker);
  }
}

async function runRecoveryWorker(input) {
  const worker = startWorker({ ...input, action: 'recover', crashPhase: null });
  try {
    const message = await waitForWorkerMessage(worker, 'recovery-result');
    await waitForWorkerExit(worker);
    assert.equal(worker.child.exitCode, 0, `Recovery worker must exit cleanly.\n${worker.logs()}`);
    return message.result;
  } finally {
    await forceStopWorker(worker);
  }
}

async function waitForExpiredLease(db, operationId) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [operation] = await db
      .select()
      .from(audioProviderOperations)
      .where(eq(audioProviderOperations.id, operationId))
      .limit(1);
    if (operation?.leaseExpiresAt && operation.leaseExpiresAt.getTime() <= Date.now()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for provider-operation lease ${operationId} to expire after process kill.`);
}

async function assertKilledOperation(db, operation, label) {
  assert.equal(operation.status, 'leased', `${label} must remain durably leased at the kill boundary.`);
  assert.equal(operation.leaseMode, 'execute', `${label} must record the original execute lease.`);
  assert.ok(operation.providerStartedAt, `${label} must record provider dispatch before the process dies.`);
  assert.equal(operation.providerConfirmedAt, null, `${label} must not claim a confirmed result before recovery.`);
  assert.equal(operation.completedAt, null, `${label} must not claim completion before recovery.`);
  const attempts = await db
    .select()
    .from(audioProviderOperationAttempts)
    .where(eq(audioProviderOperationAttempts.operationId, operation.id))
    .orderBy(asc(audioProviderOperationAttempts.attemptNumber));
  assert.equal(attempts.length, 1, `${label} must preserve exactly one interrupted attempt before restart.`);
  assert.equal(attempts[0].mode, 'execute');
  assert.equal(attempts[0].outcome, 'active');
  assert.ok(attempts[0].providerStartedAt);
}

async function assertRecoveredOperation(db, operationId, label) {
  const [operation] = await db
    .select()
    .from(audioProviderOperations)
    .where(eq(audioProviderOperations.id, operationId))
    .limit(1);
  assert.equal(operation.status, 'succeeded', `${label} must succeed from reconciliation after restart.`);
  assert.equal(operation.leaseToken, null);
  assert.equal(operation.leaseMode, null);
  assert.ok(operation.providerConfirmedAt, `${label} must record provider confirmation after restart.`);
  assert.ok(operation.completedAt, `${label} must record durable completion after restart.`);
  const attempts = await db
    .select()
    .from(audioProviderOperationAttempts)
    .where(eq(audioProviderOperationAttempts.operationId, operationId))
    .orderBy(asc(audioProviderOperationAttempts.attemptNumber));
  assert.equal(attempts.length, 2, `${label} must preserve the killed attempt and the restart attempt.`);
  assert.equal(attempts[0].mode, 'execute');
  assert.equal(attempts[0].outcome, 'stale');
  assert.equal(attempts[1].mode, 'reconcile');
  assert.equal(attempts[1].outcome, 'succeeded');
  assert.ok(attempts[1].providerResultFingerprint);
  return operation;
}

async function removeExactTempRoot(tempRoot) {
  const resolvedTarget = resolve(tempRoot);
  const resolvedTemp = resolve(tmpdir());
  if (resolvedTarget === resolvedTemp || !resolvedTarget.startsWith(resolvedTemp + sep)) {
    throw new Error(`Refusing to remove unexpected process-kill proof directory: ${resolvedTarget}`);
  }
  await rm(resolvedTarget, { recursive: true, force: true });
}

async function main() {
  const strictRealPostgres = process.argv.includes(STRICT_REAL_POSTGRES_FLAG);
  if (process.env.DATABASE_URL?.trim()) {
    throw new Error('Wave 5B process-kill proof refuses generic DATABASE_URL.');
  }
  if (strictRealPostgres) {
    if (process.env.SWAY_ALLOW_DISPOSABLE_DATABASE_RESET !== 'true') {
      throw new Error('SWAY_ALLOW_DISPOSABLE_DATABASE_RESET=true is required for the strict process-kill proof.');
    }
    process.env.SWAY_REQUIRE_REAL_POSTGRES_PROOF = 'true';
  } else if (process.env.SWAY_REAL_POSTGRES_PROOF_DATABASE_URL?.trim()) {
    throw new Error('Use --strict-real-postgres with SWAY_REAL_POSTGRES_PROOF_DATABASE_URL.');
  }

  const proof = await startEmbeddedPostgresProof('audio_provider_process_kill');
  if (strictRealPostgres && proof.kind !== 'real-postgres') {
    throw new Error('Strict process-kill proof requires an attested standalone PostgreSQL server.');
  }
  const db = createSwayDb(proof.databaseUrl);
  const objectRoot = await mkdtemp(resolve(tmpdir(), 'sway-audio-process-kill-'));

  try {
    const localStore = createLocalAudioObjectStore({
      SWAY_AUDIO_LOCAL_OBJECT_DIR: objectRoot,
      SWAY_AUDIO_LOCAL_BUCKET: BUCKET
    });
    await localStore.verifyReady();
    const publishing = createAudioPublishingService({
      db,
      store: localStore,
      collaboratorRevisionUploadsEnabled: true,
      workspaceLimitBytes: WORKSPACE_LIMIT_BYTES,
      workingObjectLimit: WORKING_OBJECT_LIMIT,
      providerOperationLeaseDurationMs: LEASE_DURATION_MS,
      providerOperationCallTimeoutMs: PROVIDER_CALL_TIMEOUT_MS
    });
    const collaboration = createAudioFileCollaborationService({
      db,
      store: localStore,
      collaboratorRevisionUploadsEnabled: true
    });

    const [ownerUserId, collaboratorUserId] = [randomUUID(), randomUUID()].sort();
    await db.insert(users).values([
      {
        id: ownerUserId,
        email: `process-kill-owner-${ownerUserId}@example.test`,
        emailVerifiedAt: new Date()
      },
      {
        id: collaboratorUserId,
        email: `process-kill-collaborator-${collaboratorUserId}@example.test`,
        emailVerifiedAt: new Date()
      }
    ]);
    const [performer] = await db.insert(performers).values({
      ownerUserId,
      displayName: 'Wave 5B process-kill proof'
    }).returning();
    const project = await publishing.createProject({
      performerId: performer.id,
      actorUserId: ownerUserId,
      title: 'Process-kill recovery source'
    });
    const sourceBody = wavFixture('process kill source');
    const sourceUpload = await publishing.initiateUpload({
      projectId: project.id,
      actorUserId: ownerUserId,
      title: 'process-kill-source.wav',
      assetKind: 'master_audio',
      originalFilename: 'process-kill-source.wav',
      mimeType: 'audio/wav',
      expectedByteSize: sourceBody.byteLength,
      expectedSha256: sha256(sourceBody),
      idempotencyKey: 'wave5b-process-kill-source'
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
    const [connection] = await db.insert(audioFileConnections).values({
      memberOneUserId: ownerUserId,
      memberTwoUserId: collaboratorUserId,
      createdByUserId: ownerUserId,
      createdFromPurpose: 'request_files'
    }).returning();
    const capabilityKey = `wave5b-process-kill-capability:${performer.id}`;
    await db.insert(performerCapabilityGrantEvents).values({
      performerId: performer.id,
      capability: 'private_collaboration',
      decision: 'granted',
      actorType: 'system',
      actorUserId: null,
      reason: 'Disposable Wave 5B operating-system process-kill proof',
      evidence: { environment: 'test', proof: 'audio_provider_process_kill' },
      expiresAt: null,
      idempotencyKeyHash: sha256(Buffer.from(capabilityKey))
    });
    const grantResult = await collaboration.grantCandidateRevisionUpload({
      connectionId: connection.id,
      versionId: sourceVersion.id,
      grantedByUserId: ownerUserId,
      idempotencyKey: 'wave5b-process-kill-grant',
      maxCandidateBytes: 8 * 1024 * 1024,
      expiresInHours: 24
    });
    const grantId = grantResult.grant.id;
    const candidateBody = wavFixture('process kill candidate');
    const candidateHash = sha256(candidateBody);
    const commonWorkerInput = {
      databaseUrl: proof.databaseUrl,
      objectRoot,
      grantId,
      actorUserId: collaboratorUserId
    };

    const initiationInput = {
      ...commonWorkerInput,
      action: 'initiate',
      originalFilename: 'process-kill-candidate.wav',
      expectedByteSize: candidateBody.byteLength,
      expectedSha256: candidateHash,
      idempotencyKey: 'wave5b-process-kill-upload'
    };
    await killAtProviderSideEffect(initiationInput, 'initiate');
    const initiationOperations = (await db
      .select()
      .from(audioProviderOperations)
      .where(and(
        eq(audioProviderOperations.requestedByUserId, collaboratorUserId),
        eq(audioProviderOperations.operationType, 'initiate_multipart')
      ))).filter((operation) => operation.requestPayload.collaboratorFileGrantId === grantId);
    assert.equal(initiationOperations.length, 1, 'Process-killed initiation must reserve one operation.');
    const initiationOperation = initiationOperations[0];
    await assertKilledOperation(db, initiationOperation, 'Initiation operation');
    assert.equal(initiationOperation.uploadSessionId, null);
    assert.equal(
      (await db.select().from(audioUploadSessions).where(eq(audioUploadSessions.collaboratorFileGrantId, grantId))).length,
      0,
      'Killed initiation must not fabricate a completed upload session.'
    );
    const initiationProviderState = await localStore.reconcileUpload({
      identity: operationIdentity(initiationOperation),
      uploadSessionId: initiationOperation.plannedUploadSessionId
    });
    assert.equal(initiationProviderState.status, 'found', 'Provider multipart state must survive the process kill.');
    await waitForExpiredLease(db, initiationOperation.id);
    const initiationRecovery = await runRecoveryWorker(commonWorkerInput);
    assert.ok(initiationRecovery.recoveredOperationIds.includes(initiationOperation.id));
    const recoveredInitiation = await assertRecoveredOperation(db, initiationOperation.id, 'Initiation operation');
    const sessions = await db
      .select()
      .from(audioUploadSessions)
      .where(eq(audioUploadSessions.collaboratorFileGrantId, grantId));
    assert.equal(sessions.length, 1, 'Restart recovery must create exactly one upload session.');
    const session = sessions[0];
    assert.equal(session.id, initiationOperation.plannedUploadSessionId);
    assert.equal(recoveredInitiation.uploadSessionId, session.id);
    const initiationReplay = await publishing.initiateCollaboratorRevisionUpload({
      grantId,
      actorUserId: collaboratorUserId,
      originalFilename: 'process-kill-candidate.wav',
      mimeType: 'audio/wav',
      expectedByteSize: candidateBody.byteLength,
      expectedSha256: candidateHash,
      idempotencyKey: 'wave5b-process-kill-upload'
    });
    assert.equal(initiationReplay.id, session.id, 'Original initiation retry must replay the recovered session.');

    const partInput = {
      ...commonWorkerInput,
      action: 'part',
      uploadSessionId: session.id,
      bodyBase64: candidateBody.toString('base64')
    };
    await killAtProviderSideEffect(partInput, 'part');
    const [partOperation] = await db
      .select()
      .from(audioProviderOperations)
      .where(and(
        eq(audioProviderOperations.uploadSessionId, session.id),
        eq(audioProviderOperations.operationType, 'upload_part')
      ));
    assert.ok(partOperation, 'Process-killed part upload must reserve one operation.');
    await assertKilledOperation(db, partOperation, 'Part operation');
    assert.equal(
      (await db.select().from(audioUploadParts).where(eq(audioUploadParts.uploadSessionId, session.id))).length,
      0,
      'Killed part upload must not fabricate a database receipt.'
    );
    const partProviderState = await localStore.reconcilePart({
      identity: { ...operationIdentity(partOperation), providerUploadId: session.providerUploadId },
      partNumber: 1,
      expectedByteSize: candidateBody.byteLength,
      expectedMd5: createHash('md5').update(candidateBody).digest('hex')
    });
    assert.equal(partProviderState.status, 'confirmed', 'Provider part bytes must survive the process kill.');
    await waitForExpiredLease(db, partOperation.id);
    const partRecovery = await runRecoveryWorker(commonWorkerInput);
    assert.ok(partRecovery.recoveredOperationIds.includes(partOperation.id));
    await assertRecoveredOperation(db, partOperation.id, 'Part operation');
    const recoveredParts = await db
      .select()
      .from(audioUploadParts)
      .where(eq(audioUploadParts.uploadSessionId, session.id));
    assert.equal(recoveredParts.length, 1, 'Restart recovery must persist exactly one part receipt.');
    const partReplay = await publishing.writeUploadPart({
      grantId,
      uploadSessionId: session.id,
      actorUserId: collaboratorUserId,
      partNumber: 1,
      body: candidateBody
    });
    assert.deepEqual(partReplay, {
      etag: recoveredParts[0].providerEtag,
      checksum: recoveredParts[0].providerChecksum,
      byteSize: recoveredParts[0].byteSize
    }, 'Original part retry must replay the recovered public receipt.');

    const completionInput = {
      ...commonWorkerInput,
      action: 'complete',
      uploadSessionId: session.id
    };
    await killAtProviderSideEffect(completionInput, 'complete');
    const [completionOperation] = await db
      .select()
      .from(audioProviderOperations)
      .where(and(
        eq(audioProviderOperations.uploadSessionId, session.id),
        eq(audioProviderOperations.operationType, 'complete_multipart')
      ));
    assert.ok(completionOperation, 'Process-killed completion must reserve one operation.');
    await assertKilledOperation(db, completionOperation, 'Completion operation');
    assert.equal(
      (await db.select().from(audioCandidateRevisions).where(eq(audioCandidateRevisions.uploadSessionId, session.id))).length,
      0,
      'Killed completion must not fabricate a sealed candidate receipt.'
    );
    const assemblyProviderState = await localStore.reconcileAssembly({
      identity: { ...operationIdentity(completionOperation), providerUploadId: session.providerUploadId },
      expectedByteSize: candidateBody.byteLength,
      expectedSha256: candidateHash
    });
    assert.equal(assemblyProviderState.status, 'sealed', 'Exact assembled bytes must survive the process kill.');
    await waitForExpiredLease(db, completionOperation.id);
    const completionRecovery = await runRecoveryWorker(commonWorkerInput);
    assert.ok(completionRecovery.recoveredOperationIds.includes(completionOperation.id));
    await assertRecoveredOperation(db, completionOperation.id, 'Completion operation');
    const candidates = await db
      .select()
      .from(audioCandidateRevisions)
      .where(eq(audioCandidateRevisions.uploadSessionId, session.id));
    assert.equal(candidates.length, 1, 'Restart recovery must seal exactly one private candidate.');
    const candidate = candidates[0];
    assert.equal(candidate.intakeStatus, 'private_review');
    assert.equal(candidate.sha256, candidateHash);
    assert.equal(candidate.byteSize, candidateBody.byteLength);
    const recoveredSession = (await db
      .select()
      .from(audioUploadSessions)
      .where(eq(audioUploadSessions.id, session.id)))[0];
    assert.equal(recoveredSession.uploadStatus, 'completed');
    const recoveredOriginal = await localStore.openOriginal({
      storageProvider: candidate.storageProvider,
      storageBucket: candidate.storageBucket,
      storageKey: candidate.storageKey,
      providerUploadId: session.providerUploadId
    });
    assert.deepEqual(await streamToBuffer(recoveredOriginal.stream), candidateBody);
    const completionReplay = await publishing.completeAndSealCollaboratorRevision({
      grantId,
      uploadSessionId: session.id,
      actorUserId: collaboratorUserId
    });
    assert.equal(completionReplay.id, candidate.id, 'Original completion retry must replay the recovered candidate.');

    const candidateOperations = await db
      .select()
      .from(audioProviderOperations)
      .where(eq(audioProviderOperations.requestedByUserId, collaboratorUserId));
    assert.equal(
      candidateOperations.filter((operation) => operation.operationType === 'initiate_multipart').length,
      1,
      'Restart recovery must not duplicate provider initiation.'
    );
    assert.equal(
      candidateOperations.filter((operation) => operation.operationType === 'upload_part').length,
      1,
      'Restart recovery must not duplicate provider part intent.'
    );
    assert.equal(
      candidateOperations.filter((operation) => operation.operationType === 'complete_multipart').length,
      1,
      'Restart recovery must not duplicate provider completion intent.'
    );

    console.log(
      `Sway audio provider operating-system process-kill proof passed on ${proof.kind}; initiation, part, and completion recovered without duplicate intent or bytes.`
    );
  } finally {
    try {
      await proof.close();
    } finally {
      await removeExactTempRoot(objectRoot);
    }
  }
}

if (process.argv.includes(WORKER_FLAG)) {
  runWorker().catch(async (error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    try {
      await sendWorkerMessage({ type: 'worker-error', error: message });
    } catch {
      // The parent may already have terminated the IPC channel.
    }
    process.exit(1);
  });
} else {
  main().catch((error) => {
    console.error('Sway audio provider operating-system process-kill proof failed:');
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
