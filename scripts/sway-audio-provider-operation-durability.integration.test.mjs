import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createSwayDb } from '../src/db/client.ts';
import {
  createAudioStoragePolicy,
  loadAudioStorageUsage
} from '../src/server/audio-storage-policy.ts';
import { createAudioProviderOperationCoordinator } from '../src/server/audio-provider-operation-service.ts';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof.ts';

const FINGERPRINT = 'a'.repeat(64);
const EXPECTED_SHA256 = 'b'.repeat(64);
const STORAGE_PROVIDER = 'r2';
const STORAGE_BUCKET = 'wave5b-proof';

function evidenceFingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function operationKey(projectId, plannedSessionId, operationType, partNumber = null) {
  return `audio-provider:v1:${projectId}:${plannedSessionId}:${operationType}:${partNumber ?? 0}`;
}

function errorChainMatches(error, pattern) {
  let current = error;
  while (current) {
    const message = current instanceof Error ? current.message : String(current);
    if (pattern.test(message)) return true;
    current = typeof current === 'object' && current !== null ? current.cause : null;
  }
  return false;
}

async function assertDatabaseRejects(action, pattern, label) {
  await assert.rejects(action, (error) => {
    assert.equal(errorChainMatches(error, pattern), true, `${label}: ${String(error)}`);
    return true;
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const proof = await startEmbeddedPostgresProof('audio_provider_operation_durability');
const db = createSwayDb(proof.databaseUrl);
const coordinator = createAudioProviderOperationCoordinator({
  db,
  leaseOwner: 'wave5b-coordinator-proof',
  leaseDurationMs: 60_000
});
const policy = createAudioStoragePolicy({
  workspaceLimitBytes: 1024 * 1024,
  workingObjectLimit: 100
});

const ownerUserId = randomUUID();
const outsiderUserId = randomUUID();
const performerId = randomUUID();
const projectId = randomUUID();
const plannedUploadSessionId = randomUUID();
const operationId = randomUUID();
const storageKey = `masters/projects/${projectId}/uploads/${plannedUploadSessionId}/original.wav`;

async function inTransaction(action) {
  const client = new Client({ connectionString: proof.databaseUrl });
  await client.connect();
  try {
    await client.query('begin');
    const result = await action(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

async function insertInitiationOperation({
  id,
  plannedSessionId,
  reservedBytes,
  suffix,
  actorUserId = ownerUserId,
  availableAt = null,
  requestOrigin = 'user',
  requestPayload = { expectedByteSize: reservedBytes, filename: `${suffix}.wav` },
  maxAttempts = 20
}) {
  const key = `masters/projects/${projectId}/uploads/${plannedSessionId}/${suffix}.wav`;
  await inTransaction(async (client) => {
    await client.query(
      "select set_config('sway.audio_storage_performer_transaction', $1, true)",
      [performerId]
    );
    await client.query(
      'select pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`audio-storage:${performerId}`]
    );
    await client.query(`
      insert into audio_provider_operations (
        id,
        project_id,
        performer_id,
        requested_by_user_id,
        planned_upload_session_id,
        operation_type,
        operation_key,
        intent_fingerprint,
        storage_provider,
        storage_bucket,
        storage_key,
        reserved_byte_size,
        reserved_object_count,
        request_payload,
        available_at,
        request_origin,
        max_attempts
      ) values (
        $1, $2, $3, $4, $5, 'initiate_multipart', $6, $7, $8, $9, $10, $11, 1, $12::jsonb,
        coalesce($13::timestamptz, clock_timestamp()), $14, $15
      )
    `, [
      id,
      projectId,
      performerId,
      actorUserId,
      plannedSessionId,
      operationKey(projectId, plannedSessionId, 'initiate_multipart'),
      FINGERPRINT,
      STORAGE_PROVIDER,
      STORAGE_BUCKET,
      key,
      reservedBytes,
      JSON.stringify(requestPayload),
      availableAt,
      requestOrigin,
      maxAttempts
    ]);
  });
  return key;
}

async function acquireLease({
  id,
  token,
  owner,
  mode,
  ttl = "interval '4 minutes'"
}) {
  return proof.query(`
    update audio_provider_operations
    set status = 'leased',
        lease_token = $2,
        lease_owner = $3,
        lease_mode = $4,
        lease_expires_at = clock_timestamp() + ${ttl},
        attempt_count = attempt_count + 1
    where id = $1
  `, [id, token, owner, mode]);
}

async function insertNonInitiationOperation({
  id,
  operationType,
  actorUserId = ownerUserId,
  uploadSessionId = plannedUploadSessionId,
  sessionStorageKey = storageKey,
  sessionProviderUploadId = `multipart-${plannedUploadSessionId}`,
  partNumber = null,
  bodySha256 = null,
  bodyMd5 = null,
  bodyByteSize = null,
  requestPayload = { reason: 'provider-operation proof' }
}) {
  await proof.query(`
    insert into audio_provider_operations (
      id,
      project_id,
      performer_id,
      requested_by_user_id,
      upload_session_id,
      planned_upload_session_id,
      operation_type,
      operation_key,
      intent_fingerprint,
      storage_provider,
      storage_bucket,
      storage_key,
      provider_upload_id,
      part_number,
      body_sha256,
      body_md5,
      body_byte_size,
      request_payload
    ) values (
      $1, $2, $3, $4, $5, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb
    )
  `, [
    id,
    projectId,
    performerId,
    actorUserId,
    uploadSessionId,
    operationType,
    operationKey(projectId, uploadSessionId, operationType, partNumber),
    FINGERPRINT,
    STORAGE_PROVIDER,
    STORAGE_BUCKET,
    sessionStorageKey,
    sessionProviderUploadId,
    partNumber,
    bodySha256,
    bodyMd5,
    bodyByteSize,
    JSON.stringify(requestPayload)
  ]);
}

async function createDeadLetterInitiationWithSession({
  suffix,
  sessionActorUserId,
  expireSession = false
}) {
  const id = randomUUID();
  const plannedSessionId = randomUUID();
  const key = await insertInitiationOperation({
    id,
    plannedSessionId,
    reservedBytes: 128,
    suffix
  });
  const leaseToken = randomUUID();
  await acquireLease({
    id,
    token: leaseToken,
    owner: `wave5b-${suffix}-worker`,
    mode: 'execute'
  });
  await proof.query(
    'update audio_provider_operations set provider_started_at = clock_timestamp() where id = $1 and lease_token = $2',
    [id, leaseToken]
  );
  const providerUploadId = `multipart-${plannedSessionId}`;
  await proof.query(
    'update audio_provider_operations set provider_upload_id = $3 where id = $1 and lease_token = $2',
    [id, leaseToken, providerUploadId]
  );
  await proof.query(`
    update audio_provider_operations
    set status = 'dead_letter',
        last_error = 'session recovery requires independent resolution',
        last_error_code = 'session_recovery_required',
        lease_token = null,
        lease_owner = null,
        lease_mode = null,
        lease_expires_at = null
    where id = $1 and lease_token = $2
  `, [id, leaseToken]);
  await proof.query(`
    insert into audio_upload_sessions (
      id,
      project_id,
      initiated_by_user_id,
      idempotency_key,
      storage_provider,
      storage_bucket,
      provider_upload_id,
      storage_key,
      original_filename,
      expected_mime_type,
      expected_byte_size,
      expected_sha256,
      part_size_bytes,
      upload_status,
      expires_at
    ) values (
      $1, $2, $3, $4, $5, $6, $7, $8,
      $9, 'audio/wav', 128, $10, 5242880, 'initiated', clock_timestamp() + interval '1 day'
    )
  `, [
    plannedSessionId,
    projectId,
    sessionActorUserId,
    `wave5b:${suffix}:${plannedSessionId}`,
    STORAGE_PROVIDER,
    STORAGE_BUCKET,
    providerUploadId,
    key,
    `${suffix}.wav`,
    EXPECTED_SHA256
  ]);
  if (expireSession) {
    await proof.query(
      "update audio_upload_sessions set upload_status = 'expired' where id = $1",
      [plannedSessionId]
    );
  }
  return { id, plannedSessionId };
}

try {
  await proof.query(
    'insert into users (id, email, email_verified_at) values ($1, $2, clock_timestamp()), ($3, $4, clock_timestamp())',
    [
      ownerUserId,
      `wave5b-owner-${ownerUserId}@example.test`,
      outsiderUserId,
      `wave5b-outsider-${outsiderUserId}@example.test`
    ]
  );
  await proof.query(
    'insert into performers (id, owner_user_id, display_name) values ($1, $2, $3)',
    [performerId, ownerUserId, 'Wave 5B provider-operation proof']
  );
  await proof.query(
    'insert into audio_projects (id, performer_id, created_by_user_id, title) values ($1, $2, $3, $4)',
    [projectId, performerId, ownerUserId, 'Durable provider operation project']
  );
  await proof.query(`
    insert into audio_project_access_grants (
      project_id,
      grantee_user_id,
      role,
      can_upload_versions,
      can_download_originals,
      can_comment,
      can_approve,
      can_manage_release,
      can_manage_access,
      granted_by_user_id
    ) values ($1, $2, 'owner', true, true, true, true, true, true, $2)
  `, [projectId, ownerUserId]);

  await assertDatabaseRejects(
    () => insertInitiationOperation({
      id: randomUUID(),
      plannedSessionId: randomUUID(),
      reservedBytes: 256,
      suffix: 'outsider',
      actorUserId: outsiderUserId
    }),
    /require active project upload authority/i,
    'Outsider provider-operation reservation must fail closed'
  );

  await assertDatabaseRejects(
    () => insertInitiationOperation({
      id: randomUUID(),
      plannedSessionId: randomUUID(),
      reservedBytes: 256,
      suffix: 'missing-reservation-size',
      requestPayload: { filename: 'missing-reservation-size.wav' }
    }),
    /audio_provider_operations_reservation_valid|violates check constraint/i,
    'Initiation reservation without expectedByteSize must fail closed'
  );

  await assertDatabaseRejects(
    () => insertInitiationOperation({
      id: randomUUID(),
      plannedSessionId: randomUUID(),
      reservedBytes: 256,
      suffix: 'authorityless-system-recovery',
      actorUserId: null,
      requestOrigin: 'system_recovery'
    }),
    /system recovery cannot create fresh multipart initiation intent/i,
    'System recovery must not mint authorityless initiation intent'
  );

  await insertInitiationOperation({
    id: operationId,
    plannedSessionId: plannedUploadSessionId,
    reservedBytes: 4096,
    suffix: 'original'
  });

  await assertDatabaseRejects(
    () => proof.query(`
      insert into audio_provider_operation_attempts (
        operation_id,
        attempt_number,
        fencing_token,
        mode,
        lease_owner,
        lease_started_at,
        lease_expires_at,
        request_fingerprint
      ) values ($1, 1, $2, 'execute', 'forged-worker', clock_timestamp(),
        clock_timestamp() + interval '1 minute', $3)
    `, [operationId, randomUUID(), 'f'.repeat(64)]),
    /internal durable evidence.*only be changed by provider-operation transitions/i,
    'Attempt rows must reject independent forged inserts'
  );

  let usage = await loadAudioStorageUsage(db, policy, { performerId });
  assert.equal(usage.reservedBytes, 4096, 'Sessionless provider intent must reserve its bytes.');
  assert.equal(usage.workingObjectCount, 1, 'Sessionless provider intent must reserve one object.');

  const initialAudit = await proof.query(`
    select event_type, previous_status, next_status, metadata
    from audit_events
    where entity_type = 'audio_provider_operation' and entity_id = $1
  `, [operationId]);
  assert.equal(initialAudit.rowCount, 1);
  assert.equal(initialAudit.rows[0].event_type, 'audio_provider_operation_reserved');
  assert.equal(initialAudit.rows[0].previous_status, null);
  assert.equal(initialAudit.rows[0].next_status, 'pending');
  assert.equal(JSON.stringify(initialAudit.rows[0].metadata).includes(storageKey), false);

  await assertDatabaseRejects(
    () => proof.query('delete from audio_provider_operations where id = $1', [operationId]),
    /durable evidence and cannot be deleted/i,
    'Provider-operation deletion must fail closed'
  );
  await assertDatabaseRejects(
    () => proof.query(
      'update audio_provider_operations set storage_key = $2 where id = $1',
      [operationId, `${storageKey}.mutated`]
    ),
    /intent identity is immutable/i,
    'Provider-operation identity mutation must fail closed'
  );

  const firstLeaseToken = randomUUID();
  await acquireLease({
    id: operationId,
    token: firstLeaseToken,
    owner: 'wave5b-worker-one',
    mode: 'execute',
    ttl: "interval '120 milliseconds'"
  });
  await proof.query(`
    update audio_provider_operations
    set provider_started_at = clock_timestamp()
    where id = $1 and lease_token = $2
  `, [operationId, firstLeaseToken]);

  await assertDatabaseRejects(
    () => proof.query(`
      update audio_provider_operations
      set status = 'pending',
          lease_token = null,
          lease_owner = null,
          lease_mode = null,
          lease_expires_at = null
      where id = $1
    `, [operationId]),
    /must reconcile before retry/i,
    'Started provider I/O must never return directly to pending'
  );

  await wait(180);
  await assertDatabaseRejects(
    () => proof.query(`
      update audio_provider_operations
      set lease_expires_at = clock_timestamp() + interval '2 minutes'
      where id = $1 and lease_token = $2
    `, [operationId, firstLeaseToken]),
    /expired .* leases are fenced/i,
    'Expired holder must not renew the same fencing token'
  );
  await assertDatabaseRejects(
    () => proof.query(`
      update audio_provider_operations
      set provider_confirmed_at = clock_timestamp(),
          result_payload = '{"receipt":"stale"}'::jsonb,
          result_fingerprint = $3
      where id = $1 and lease_token = $2
    `, [operationId, firstLeaseToken, evidenceFingerprint({ receipt: 'stale' })]),
    /expired .* leases are fenced/i,
    'Expired holder must not confirm a provider result'
  );

  const recoveryLeaseToken = randomUUID();
  await acquireLease({
    id: operationId,
    token: recoveryLeaseToken,
    owner: 'wave5b-recovery-worker',
    mode: 'reconcile'
  });
  const recovered = await proof.query(`
    select status, attempt_count, provider_started_at, provider_confirmed_at, lease_token, lease_mode
    from audio_provider_operations
    where id = $1
  `, [operationId]);
  assert.equal(recovered.rows[0].status, 'leased');
  assert.equal(recovered.rows[0].attempt_count, 2);
  assert.ok(recovered.rows[0].provider_started_at, 'Lost-response recovery must retain provider-start evidence.');
  assert.equal(recovered.rows[0].provider_confirmed_at, null);
  assert.equal(recovered.rows[0].lease_token, recoveryLeaseToken);
  assert.equal(recovered.rows[0].lease_mode, 'reconcile');

  await proof.query(`
    update audio_provider_operations
    set status = 'reconcile_required',
        lease_token = null,
        lease_owner = null,
        lease_mode = null,
        lease_expires_at = null,
        last_error = 'simulated worker termination during provider observation',
        last_error_code = 'provider_observation_interrupted'
    where id = $1 and lease_token = $2
  `, [operationId, recoveryLeaseToken]);
  const reconciliationLeaseToken = randomUUID();
  await acquireLease({
    id: operationId,
    token: reconciliationLeaseToken,
    owner: 'wave5b-reconciler',
    mode: 'reconcile'
  });

  const providerUploadId = `multipart-${plannedUploadSessionId}`;
  const successResult = { reconciled: true, providerUploadIdRecorded: true };
  await inTransaction(async (client) => {
    await client.query(`
      insert into audio_upload_sessions (
        id,
        project_id,
        initiated_by_user_id,
        idempotency_key,
        storage_provider,
        storage_bucket,
        provider_upload_id,
        storage_key,
        original_filename,
        expected_mime_type,
        expected_byte_size,
        expected_sha256,
        part_size_bytes,
        upload_status,
        expires_at
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8,
        'original.wav', 'audio/wav', 4096, $9, 5242880, 'initiated', clock_timestamp() + interval '1 day'
      )
    `, [
      plannedUploadSessionId,
      projectId,
      ownerUserId,
      `wave5b:${plannedUploadSessionId}`,
      STORAGE_PROVIDER,
      STORAGE_BUCKET,
      providerUploadId,
      storageKey,
      EXPECTED_SHA256
    ]);
    const finalized = await client.query(`
      update audio_provider_operations
      set status = 'succeeded',
          upload_session_id = planned_upload_session_id,
          provider_upload_id = $2,
          provider_confirmed_at = clock_timestamp(),
          result_payload = $3::jsonb,
          result_fingerprint = $4,
          completed_at = clock_timestamp(),
          lease_token = null,
          lease_owner = null,
          lease_mode = null,
          lease_expires_at = null,
          last_error = null,
          last_error_code = null
      where id = $1 and lease_token = $5
    `, [
      operationId,
      providerUploadId,
      JSON.stringify(successResult),
      evidenceFingerprint(successResult),
      reconciliationLeaseToken
    ]);
    assert.equal(finalized.rowCount, 1, 'Session creation and reservation transfer must finalize atomically.');
  });

  usage = await loadAudioStorageUsage(db, policy, { performerId });
  assert.equal(usage.reservedBytes, 4096, 'Linked initiation must transfer, not duplicate, its reservation.');
  assert.equal(usage.workingObjectCount, 1, 'Linked initiation must transfer exactly one object reservation.');

  const coordinatorPayload = {
    action: 'complete-multipart-coordinator-proof',
    expectedByteSize: 4096,
    expectedSha256: EXPECTED_SHA256
  };
  const coordinatorReservation = await db.transaction((tx) => coordinator.reserveOperation(tx, {
    projectId,
    performerId,
    requestedByUserId: ownerUserId,
    uploadSessionId: plannedUploadSessionId,
    plannedUploadSessionId,
    operationType: 'complete_multipart',
    identity: {
      storageProvider: STORAGE_PROVIDER,
      storageBucket: STORAGE_BUCKET,
      storageKey,
      providerUploadId
    },
    requestPayload: coordinatorPayload
  }));
  assert.equal(coordinatorReservation.created, true);
  const coordinatorClaim = await coordinator.claimOperation(coordinatorReservation.operation.id);
  assert.equal(coordinatorClaim.kind, 'leased');
  assert.equal(coordinatorClaim.kind === 'leased' && coordinatorClaim.lease.mode, 'execute');
  if (coordinatorClaim.kind !== 'leased') throw new Error('Coordinator proof did not acquire its execute lease.');
  await coordinator.markProviderStarted(coordinatorClaim.lease);
  const providerResult = await Promise.resolve({ assembledByteSize: 4096, assembledSha256: EXPECTED_SHA256 });
  const coordinatorFinal = await coordinator.finalizeSuccess({
    lease: coordinatorClaim.lease,
    evidence: providerResult,
    applyDomain: async (_tx, operation) => ({ operationId: operation.id })
  });
  assert.equal(coordinatorFinal.operation.status, 'succeeded');
  assert.equal(coordinatorFinal.result.operationId, coordinatorReservation.operation.id);
  const coordinatorReplay = await db.transaction((tx) => coordinator.reserveOperation(tx, {
    projectId,
    performerId,
    requestedByUserId: ownerUserId,
    uploadSessionId: plannedUploadSessionId,
    plannedUploadSessionId,
    operationType: 'complete_multipart',
    identity: {
      storageProvider: STORAGE_PROVIDER,
      storageBucket: STORAGE_BUCKET,
      storageKey,
      providerUploadId
    },
    requestPayload: coordinatorPayload
  }));
  assert.equal(coordinatorReplay.created, false, 'Exact coordinator reservation replay must reuse durable intent.');
  await assert.rejects(
    () => db.transaction((tx) => coordinator.reserveOperation(tx, {
      projectId,
      performerId,
      requestedByUserId: ownerUserId,
      uploadSessionId: plannedUploadSessionId,
      plannedUploadSessionId,
      operationType: 'complete_multipart',
      identity: {
        storageProvider: STORAGE_PROVIDER,
        storageBucket: STORAGE_BUCKET,
        storageKey,
        providerUploadId
      },
      requestPayload: { ...coordinatorPayload, expectedByteSize: 4097 }
    })),
    /different intent/i,
    'Conflicting coordinator replay must fail closed.'
  );

  const attempts = await proof.query(`
    select attempt_number, mode, outcome, provider_started_at, provider_result_fingerprint, error_code
    from audio_provider_operation_attempts
    where operation_id = $1
    order by attempt_number
  `, [operationId]);
  assert.deepEqual(
    attempts.rows.map((row) => [row.attempt_number, row.mode, row.outcome]),
    [
      [1, 'execute', 'stale'],
      [2, 'reconcile', 'reconcile_required'],
      [3, 'reconcile', 'succeeded']
    ],
    'Every lease generation and process-kill outcome must remain independently durable.'
  );
  assert.ok(attempts.rows[0].provider_started_at);
  assert.equal(attempts.rows[0].error_code, 'lease_expired');
  assert.equal(attempts.rows[2].provider_result_fingerprint, evidenceFingerprint(successResult));
  for (const forgedMutation of [
    {
      label: 'lease expiry',
      statement: "update audio_provider_operation_attempts set lease_expires_at = lease_expires_at + interval '1 second' where operation_id = $1 and attempt_number = 1"
    },
    {
      label: 'provider result',
      statement: "update audio_provider_operation_attempts set provider_result_fingerprint = $2 where operation_id = $1 and attempt_number = 1",
      parameters: [operationId, 'e'.repeat(64)]
    },
    {
      label: 'outcome finalization',
      statement: "update audio_provider_operation_attempts set outcome = 'released', completed_at = clock_timestamp() where operation_id = $1 and attempt_number = 1"
    }
  ]) {
    await assertDatabaseRejects(
      () => proof.query(
        forgedMutation.statement,
        forgedMutation.parameters ?? [operationId]
      ),
      /internal durable evidence.*only be changed by provider-operation transitions/i,
      `Attempt rows must reject independent ${forgedMutation.label} mutation`
    );
  }
  await assertDatabaseRejects(
    () => proof.query(
      'delete from audio_provider_operation_attempts where operation_id = $1 and attempt_number = 1',
      [operationId]
    ),
    /durable evidence and cannot be deleted/i,
    'Prior attempt evidence must be append-only'
  );

  await assertDatabaseRejects(
    () => proof.query(
      "update audio_provider_operations set last_error = 'mutated after success' where id = $1",
      [operationId]
    ),
    /terminal audio provider operations cannot be changed/i,
    'Terminal provider-operation evidence must be immutable'
  );

  const invalidPartCases = [
    { label: 'part number', partNumber: null, sha: EXPECTED_SHA256, md5: 'c'.repeat(32), size: 16 },
    { label: 'SHA-256', partNumber: 1, sha: null, md5: 'c'.repeat(32), size: 16 },
    { label: 'MD5', partNumber: 1, sha: EXPECTED_SHA256, md5: null, size: 16 },
    { label: 'byte size', partNumber: 1, sha: EXPECTED_SHA256, md5: 'c'.repeat(32), size: null }
  ];
  for (const invalid of invalidPartCases) {
    await assertDatabaseRejects(
      () => insertNonInitiationOperation({
        id: randomUUID(),
        operationType: 'upload_part',
        partNumber: invalid.partNumber,
        bodySha256: invalid.sha,
        bodyMd5: invalid.md5,
        bodyByteSize: invalid.size,
        requestPayload: { partNumber: invalid.partNumber ?? 0 }
      }),
      /audio_provider_operations_part_shape|violates check constraint/i,
      `Upload-part intent missing ${invalid.label} must fail closed`
    );
  }

  const startedPartOperationId = randomUUID();
  await insertNonInitiationOperation({
    id: startedPartOperationId,
    operationType: 'upload_part',
    partNumber: 1,
    bodySha256: EXPECTED_SHA256,
    bodyMd5: 'd'.repeat(32),
    bodyByteSize: 4096,
    requestPayload: { partNumber: 1, recoveryCase: 'client-body-replay' }
  });
  const startedPartLease = randomUUID();
  await acquireLease({
    id: startedPartOperationId,
    token: startedPartLease,
    owner: 'wave5b-part-worker',
    mode: 'execute',
    ttl: "interval '120 milliseconds'"
  });
  await proof.query(
    'update audio_provider_operations set provider_started_at = clock_timestamp() where id = $1 and lease_token = $2',
    [startedPartOperationId, startedPartLease]
  );
  await assertDatabaseRejects(
    () => proof.query(`
      update audio_provider_operations
      set status = 'awaiting_client_retry',
          lease_token = null,
          lease_owner = null,
          lease_mode = null,
          lease_expires_at = null
      where id = $1 and lease_token = $2
    `, [startedPartOperationId, startedPartLease]),
    /only reconciled, provider-safe upload-part operations may await/i,
    'Started upload-part work must reconcile before requesting a client replay'
  );
  await wait(180);
  await assertDatabaseRejects(
    () => acquireLease({
      id: startedPartOperationId,
      token: randomUUID(),
      owner: 'wave5b-part-unsafe-retry',
      mode: 'execute'
    }),
    /lease acquisition must be available, fresh, fenced, mode-safe, and bounded/i,
    'Expired started upload-part work must not reacquire execute mode'
  );
  const partReconcileLease = randomUUID();
  await acquireLease({
    id: startedPartOperationId,
    token: partReconcileLease,
    owner: 'wave5b-part-reconciler',
    mode: 'reconcile'
  });
  const safePartReplay = { reconciledSafeToRetry: true, observedPartAbsent: true };
  await proof.query(`
    update audio_provider_operations
    set status = 'awaiting_client_retry',
        provider_started_at = null,
        result_payload = $3::jsonb,
        result_fingerprint = $4,
        lease_token = null,
        lease_owner = null,
        lease_mode = null,
        lease_expires_at = null
    where id = $1 and lease_token = $2
  `, [
    startedPartOperationId,
    partReconcileLease,
    JSON.stringify(safePartReplay),
    evidenceFingerprint(safePartReplay)
  ]);

  const confirmedCrashOperationId = randomUUID();
  await insertNonInitiationOperation({
    id: confirmedCrashOperationId,
    operationType: 'discard_upload',
    requestPayload: { recoveryCase: 'confirmed-before-finalization' }
  });
  const confirmedCrashLease = randomUUID();
  await acquireLease({
    id: confirmedCrashOperationId,
    token: confirmedCrashLease,
    owner: 'wave5b-confirmed-worker',
    mode: 'execute',
    ttl: "interval '120 milliseconds'"
  });
  await proof.query(
    'update audio_provider_operations set provider_started_at = clock_timestamp() where id = $1 and lease_token = $2',
    [confirmedCrashOperationId, confirmedCrashLease]
  );
  const confirmedCrashResult = { cleanupConfirmed: true, reconciledAbsent: true };
  await proof.query(`
    update audio_provider_operations
    set provider_confirmed_at = clock_timestamp(),
        result_payload = $3::jsonb,
        result_fingerprint = $4
    where id = $1 and lease_token = $2
  `, [
    confirmedCrashOperationId,
    confirmedCrashLease,
    JSON.stringify(confirmedCrashResult),
    evidenceFingerprint(confirmedCrashResult)
  ]);
  await wait(180);
  await assertDatabaseRejects(
    () => acquireLease({
      id: confirmedCrashOperationId,
      token: randomUUID(),
      owner: 'wave5b-confirmed-unsafe-retry',
      mode: 'execute'
    }),
    /lease acquisition must be available, fresh, fenced, mode-safe, and bounded/i,
    'Expired confirmed provider work must not reacquire execute mode'
  );
  const confirmedReconcileLease = randomUUID();
  await acquireLease({
    id: confirmedCrashOperationId,
    token: confirmedReconcileLease,
    owner: 'wave5b-confirmed-reconciler',
    mode: 'reconcile'
  });
  await proof.query(`
    update audio_provider_operations
    set status = 'succeeded',
        completed_at = clock_timestamp(),
        lease_token = null,
        lease_owner = null,
        lease_mode = null,
        lease_expires_at = null
    where id = $1 and lease_token = $2
  `, [confirmedCrashOperationId, confirmedReconcileLease]);

  const prestartCancellationId = randomUUID();
  const prestartSessionId = randomUUID();
  await insertInitiationOperation({
    id: prestartCancellationId,
    plannedSessionId: prestartSessionId,
    reservedBytes: 2048,
    suffix: 'prestart-cancel'
  });
  usage = await loadAudioStorageUsage(db, policy, { performerId });
  assert.equal(usage.reservedBytes, 6144);

  await assertDatabaseRejects(
    () => proof.query(`
      update audio_provider_operations
      set status = 'canceled',
          result_payload = '{"providerNotStarted":true}'::jsonb,
          completed_at = clock_timestamp()
      where id = $1
    `, [prestartCancellationId]),
    /audio_provider_operations_result_evidence_valid|violates check constraint/i,
    'Cancellation evidence without a result fingerprint must fail closed'
  );

  const unprovenResult = { reason: 'unproven' };
  await assertDatabaseRejects(
    () => proof.query(`
      update audio_provider_operations
      set status = 'canceled',
          result_payload = $2::jsonb,
          result_fingerprint = $3,
          completed_at = clock_timestamp()
      where id = $1
    `, [
      prestartCancellationId,
      JSON.stringify(unprovenResult),
      evidenceFingerprint(unprovenResult)
    ]),
    /require exact proof that no provider state remains/i,
    'Cancellation without provider-absence proof must fail closed'
  );
  const prestartResult = { providerNotStarted: true };
  await proof.query(`
    update audio_provider_operations
    set status = 'canceled',
        result_payload = $2::jsonb,
        result_fingerprint = $3,
        completed_at = clock_timestamp()
    where id = $1
  `, [
    prestartCancellationId,
    JSON.stringify(prestartResult),
    evidenceFingerprint(prestartResult)
  ]);

  const cleanupCancellationId = randomUUID();
  const cleanupSessionId = randomUUID();
  await insertInitiationOperation({
    id: cleanupCancellationId,
    plannedSessionId: cleanupSessionId,
    reservedBytes: 1024,
    suffix: 'reconciled-cleanup'
  });
  const cleanupLeaseToken = randomUUID();
  await acquireLease({
    id: cleanupCancellationId,
    token: cleanupLeaseToken,
    owner: 'wave5b-cleanup-reconciler',
    mode: 'execute'
  });
  await assertDatabaseRejects(
    () => proof.query(`
      update audio_provider_operations
      set provider_upload_id = 'provider-id-without-dispatch'
      where id = $1 and lease_token = $2
    `, [cleanupCancellationId, cleanupLeaseToken]),
    /after active leased initiation dispatch/i,
    'Provider upload identity without provider-start evidence must fail closed'
  );
  await proof.query(`
    update audio_provider_operations
    set provider_started_at = clock_timestamp()
    where id = $1 and lease_token = $2
  `, [cleanupCancellationId, cleanupLeaseToken]);
  const cleanupResult = {
    cleanupConfirmed: true,
    reconciledAbsent: true,
    multipartAbsent: true,
    stagingAbsent: true,
    sealedAbsent: true
  };
  await proof.query(`
    update audio_provider_operations
    set status = 'canceled',
        provider_confirmed_at = clock_timestamp(),
        result_payload = $3::jsonb,
        result_fingerprint = $4,
        completed_at = clock_timestamp(),
        lease_token = null,
        lease_owner = null,
        lease_mode = null,
        lease_expires_at = null
    where id = $1 and lease_token = $2
  `, [
    cleanupCancellationId,
    cleanupLeaseToken,
    JSON.stringify(cleanupResult),
    evidenceFingerprint(cleanupResult)
  ]);

  const abortOperationId = randomUUID();
  await insertNonInitiationOperation({
    id: abortOperationId,
    operationType: 'abort_upload'
  });
  const abortLeaseToken = randomUUID();
  await acquireLease({
    id: abortOperationId,
    token: abortLeaseToken,
    owner: 'wave5b-abort-worker',
    mode: 'execute'
  });
  await proof.query(
    'update audio_provider_operations set provider_started_at = clock_timestamp() where id = $1 and lease_token = $2',
    [abortOperationId, abortLeaseToken]
  );
  const receiptA = { receipt: 'A', cleanupConfirmed: true };
  await proof.query(`
    update audio_provider_operations
    set provider_confirmed_at = clock_timestamp(),
        result_payload = $3::jsonb,
        result_fingerprint = $4
    where id = $1 and lease_token = $2
  `, [
    abortOperationId,
    abortLeaseToken,
    JSON.stringify(receiptA),
    evidenceFingerprint(receiptA)
  ]);
  const auditBeforeRewrite = await proof.query(
    "select count(*)::int as count from audit_events where entity_type = 'audio_provider_operation' and entity_id = $1",
    [abortOperationId]
  );
  const receiptB = { receipt: 'B', cleanupConfirmed: true };
  await assertDatabaseRejects(
    () => proof.query(`
      update audio_provider_operations
      set result_payload = $2::jsonb, result_fingerprint = $3
      where id = $1
    `, [abortOperationId, JSON.stringify(receiptB), evidenceFingerprint(receiptB)]),
    /confirmed provider result evidence is immutable/i,
    'Confirmed provider result must not be silently rewritten'
  );
  const auditAfterRewrite = await proof.query(
    "select count(*)::int as count from audit_events where entity_type = 'audio_provider_operation' and entity_id = $1",
    [abortOperationId]
  );
  assert.equal(auditAfterRewrite.rows[0].count, auditBeforeRewrite.rows[0].count);
  await proof.query(`
    update audio_provider_operations
    set status = 'succeeded',
        completed_at = clock_timestamp(),
        lease_token = null,
        lease_owner = null,
        lease_mode = null,
        lease_expires_at = null
    where id = $1 and lease_token = $2
  `, [abortOperationId, abortLeaseToken]);

  const deadLetterId = randomUUID();
  const deadLetterSessionId = randomUUID();
  await insertInitiationOperation({
    id: deadLetterId,
    plannedSessionId: deadLetterSessionId,
    reservedBytes: 512,
    suffix: 'dead-letter'
  });
  await proof.query(`
    update audio_provider_operations
    set status = 'dead_letter',
        last_error = 'provider state requires reconciliation',
        last_error_code = 'provider_state_unresolved'
    where id = $1
  `, [deadLetterId]);

  usage = await loadAudioStorageUsage(db, policy, { performerId });
  assert.equal(
    usage.reservedBytes,
    4608,
    'Unresolved dead-letter initiation must remain charged while proven cancellations release quota.'
  );
  assert.equal(usage.workingObjectCount, 2);

  const resolutionEvidence = {
    multipartAbsent: true,
    stagingAbsent: true,
    sealedAbsent: true,
    observation: 'exact-provider-identity'
  };
  const incompleteResolutionEvidence = { observation: 'missing-absence-fields' };
  await assertDatabaseRejects(
    () => proof.query(`
      insert into audio_provider_operation_resolutions (
        operation_id,
        resolution_type,
        resolved_by_user_id,
        provider_observed_at,
        evidence_fingerprint,
        evidence
      ) values ($1, 'cleanup_confirmed', $2, clock_timestamp(), $3, $4::jsonb)
    `, [
      deadLetterId,
      ownerUserId,
      evidenceFingerprint(incompleteResolutionEvidence),
      JSON.stringify(incompleteResolutionEvidence)
    ]),
    /cleanup resolution requires confirmed absence/i,
    'Cleanup resolution missing any explicit absence field must fail closed'
  );
  await proof.query(`
    insert into audio_provider_operation_resolutions (
      operation_id,
      resolution_type,
      resolved_by_user_id,
      provider_observed_at,
      evidence_fingerprint,
      evidence
    ) values ($1, 'cleanup_confirmed', $2, clock_timestamp(), $3, $4::jsonb)
  `, [
    deadLetterId,
    ownerUserId,
    evidenceFingerprint(resolutionEvidence),
    JSON.stringify(resolutionEvidence)
  ]);
  usage = await loadAudioStorageUsage(db, policy, { performerId });
  assert.equal(usage.reservedBytes, 4096, 'Confirmed dead-letter cleanup must release its reservation exactly once.');
  assert.equal(usage.workingObjectCount, 1);
  await assertDatabaseRejects(
    () => proof.query(`
      insert into audio_provider_operation_resolutions (
        operation_id, resolution_type, resolved_by_user_id,
        provider_observed_at, evidence_fingerprint, evidence
      ) values ($1, 'cleanup_confirmed', $2, clock_timestamp(), $3, $4::jsonb)
    `, [
      deadLetterId,
      ownerUserId,
      evidenceFingerprint(resolutionEvidence),
      JSON.stringify(resolutionEvidence)
    ]),
    /audio_provider_operation_resolutions_operation_idx|duplicate key/i,
    'Dead-letter resolution must be unique and append-only'
  );
  const deadLetterState = await proof.query(
    'select status from audio_provider_operations where id = $1',
    [deadLetterId]
  );
  assert.equal(deadLetterState.rows[0].status, 'dead_letter', 'Resolution must preserve original dead-letter evidence.');

  const exhaustedOperationId = randomUUID();
  const exhaustedSessionId = randomUUID();
  await insertInitiationOperation({
    id: exhaustedOperationId,
    plannedSessionId: exhaustedSessionId,
    reservedBytes: 256,
    suffix: 'attempt-budget-exhausted',
    maxAttempts: 1
  });
  const exhaustedLease = randomUUID();
  await acquireLease({
    id: exhaustedOperationId,
    token: exhaustedLease,
    owner: 'wave5b-final-attempt-worker',
    mode: 'execute',
    ttl: "interval '120 milliseconds'"
  });
  await proof.query(
    'update audio_provider_operations set provider_started_at = clock_timestamp() where id = $1 and lease_token = $2',
    [exhaustedOperationId, exhaustedLease]
  );
  await wait(180);
  const exhaustedClaim = await coordinator.claimOperation(exhaustedOperationId);
  assert.equal(exhaustedClaim.kind, 'exhausted');
  assert.equal(exhaustedClaim.operation.status, 'dead_letter');
  const exhaustedAttempt = await proof.query(`
    select outcome, error_code
    from audio_provider_operation_attempts
    where operation_id = $1 and attempt_number = 1
  `, [exhaustedOperationId]);
  assert.equal(exhaustedAttempt.rows[0].outcome, 'dead_letter');
  assert.equal(exhaustedAttempt.rows[0].error_code, 'attempt_budget_exhausted');
  usage = await loadAudioStorageUsage(db, policy, { performerId });
  assert.equal(usage.reservedBytes, 4352, 'Exhausted initiation must remain charged after atomic dead-letter finalization.');
  const exhaustedResolution = {
    multipartAbsent: true,
    stagingAbsent: true,
    sealedAbsent: true,
    observation: 'attempt-budget-exhausted-cleanup'
  };
  await proof.query(`
    insert into audio_provider_operation_resolutions (
      operation_id, resolution_type, resolved_by_user_id,
      provider_observed_at, evidence_fingerprint, evidence
    ) values ($1, 'cleanup_confirmed', $2, clock_timestamp(), $3, $4::jsonb)
  `, [
    exhaustedOperationId,
    ownerUserId,
    evidenceFingerprint(exhaustedResolution),
    JSON.stringify(exhaustedResolution)
  ]);
  usage = await loadAudioStorageUsage(db, policy, { performerId });
  assert.equal(usage.reservedBytes, 4096, 'Resolved exhausted initiation must release its retained reservation.');

  await proof.query(`
    insert into audio_project_access_grants (
      project_id,
      grantee_user_id,
      role,
      can_upload_versions,
      can_download_originals,
      can_comment,
      can_approve,
      can_manage_release,
      can_manage_access,
      granted_by_user_id
    ) values ($1, $2, 'collaborator', true, false, false, false, false, false, $3)
  `, [projectId, outsiderUserId, ownerUserId]);

  for (const operationType of ['upload_part', 'complete_multipart', 'abort_upload', 'discard_upload']) {
    await assertDatabaseRejects(
      () => insertNonInitiationOperation({
        id: randomUUID(),
        operationType,
        actorUserId: outsiderUserId,
        ...(operationType === 'upload_part'
          ? {
              partNumber: 2,
              bodySha256: EXPECTED_SHA256,
              bodyMd5: '9'.repeat(32),
              bodyByteSize: 16
            }
          : {}),
        requestPayload: { operationType, negativeProof: 'cross-session-actor' }
      }),
      /must match the exact upload-session actor/i,
      `${operationType} must reject a different authorized project user`
    );
  }

  const sourceAssetId = randomUUID();
  const sourceSessionId = randomUUID();
  const sourceVersionId = randomUUID();
  const sourceStorageKey = `masters/projects/${projectId}/source/${sourceVersionId}.wav`;
  const sourceProviderUploadId = `multipart-${sourceSessionId}`;
  await proof.query(`
    insert into audio_assets (
      id, project_id, created_by_user_id, title, asset_kind, provenance_type, status
    ) values ($1, $2, $3, 'Revoked collaborator grant proof source', 'mix', 'user_upload', 'active')
  `, [sourceAssetId, projectId, ownerUserId]);
  await proof.query(`
    insert into audio_upload_sessions (
      id, project_id, asset_id, initiated_by_user_id, idempotency_key,
      storage_provider, storage_bucket, provider_upload_id, storage_key,
      original_filename, expected_mime_type, expected_byte_size, expected_sha256,
      part_size_bytes, upload_status, expires_at
    ) values (
      $1, $2, $3, $4, $5, $6, $7, $8, $9,
      'revoked-grant-source.wav', 'audio/wav', 128, $10, 5242880,
      'initiated', clock_timestamp() + interval '1 day'
    )
  `, [
    sourceSessionId,
    projectId,
    sourceAssetId,
    ownerUserId,
    `wave5b:source:${sourceSessionId}`,
    STORAGE_PROVIDER,
    STORAGE_BUCKET,
    sourceProviderUploadId,
    sourceStorageKey,
    EXPECTED_SHA256
  ]);
  for (const sourceStatus of ['uploading', 'uploaded', 'verifying']) {
    await proof.query(
      'update audio_upload_sessions set upload_status = $2 where id = $1',
      [sourceSessionId, sourceStatus]
    );
  }
  await proof.query(`
    update audio_upload_sessions
    set upload_status = 'completed', completed_at = clock_timestamp()
    where id = $1
  `, [sourceSessionId]);
  await proof.query(`
    insert into audio_project_asset_versions (
      id, project_id, performer_id, asset_id, uploaded_by_user_id, upload_session_id,
      version_number, original_filename, storage_provider, storage_bucket, storage_key,
      mime_type, byte_size, sha256, integrity_status, integrity_verifier_key,
      integrity_verified_at, integrity_evidence, original_preserved, sealed_at
    ) values (
      $1, $2, $3, $4, $5, $6, 1, 'revoked-grant-source.wav', $7, $8, $9,
      'audio/wav', 128, $10, 'verified', 'wave5b.revoked-grant-proof',
      clock_timestamp(), '{"proof":"revoked-grant"}'::jsonb, true, clock_timestamp()
    )
  `, [
    sourceVersionId,
    projectId,
    performerId,
    sourceAssetId,
    ownerUserId,
    sourceSessionId,
    STORAGE_PROVIDER,
    STORAGE_BUCKET,
    sourceStorageKey,
    EXPECTED_SHA256
  ]);
  const [connectionMemberOneUserId, connectionMemberTwoUserId] = [ownerUserId, outsiderUserId].sort();
  const connectionId = randomUUID();
  await proof.query(`
    insert into audio_file_connections (
      id, member_one_user_id, member_two_user_id, created_by_user_id, created_from_purpose
    ) values ($1, $2, $3, $4, 'send_files')
  `, [connectionId, connectionMemberOneUserId, connectionMemberTwoUserId, ownerUserId]);
  const ownerAuthority = await proof.query(`
    select id
    from audio_project_access_grants
    where project_id = $1 and grantee_user_id = $2 and revoked_at is null
    limit 1
  `, [projectId, ownerUserId]);
  await proof.query(`
    insert into performer_capability_grant_events (
      performer_id, capability, decision, actor_type, actor_user_id,
      reason, evidence, expires_at, idempotency_key_hash
    ) values (
      $1, 'private_collaboration', 'granted', 'system', null,
      'Disposable Wave 5B revoked collaborator grant proof',
      '{"environment":"test","reference":"wave5b-provider-operation"}'::jsonb,
      null, $2
    )
  `, [performerId, '4'.repeat(64)]);
  const collaboratorGrantId = randomUUID();
  await proof.query(`
    insert into audio_file_access_grants (
      id, connection_id, connection_member_one_user_id, connection_member_two_user_id,
      project_id, asset_version_id, grantor_project_access_grant_id,
      grantor_can_manage_access, granted_by_user_id, grantee_user_id,
      grant_purpose, idempotency_key_hash, intent_fingerprint, max_candidate_bytes,
      can_stream_preview, can_download_original, can_upload_new_version,
      can_comment, can_approve, expires_at
    ) values (
      $1, $2, $3, $4, $5, $6, $7, true, $8, $9,
      'collaborator_revision_upload', $10, $11, 512,
      false, false, true, false, false, clock_timestamp() + interval '1 day'
    )
  `, [
    collaboratorGrantId,
    connectionId,
    connectionMemberOneUserId,
    connectionMemberTwoUserId,
    projectId,
    sourceVersionId,
    ownerAuthority.rows[0].id,
    ownerUserId,
    outsiderUserId,
    '7'.repeat(64),
    '8'.repeat(64)
  ]);
  const collaboratorSessionId = randomUUID();
  const collaboratorStorageKey = `masters/projects/${projectId}/uploads/${collaboratorSessionId}/candidate.wav`;
  const collaboratorProviderUploadId = `multipart-${collaboratorSessionId}`;
  await proof.query(`
    insert into audio_upload_sessions (
      id, project_id, asset_id, initiated_by_user_id, upload_purpose,
      collaborator_file_grant_id, source_asset_version_id, request_fingerprint,
      idempotency_key, storage_provider, storage_bucket, provider_upload_id, storage_key,
      original_filename, expected_mime_type, expected_byte_size, expected_sha256,
      part_size_bytes, upload_status, expires_at
    ) values (
      $1, $2, $3, $4, 'collaborator_revision', $5, $6, $7,
      $8, $9, $10, $11, $12, 'revoked-grant-candidate.wav', 'audio/wav',
      128, $13, 5242880, 'initiated', clock_timestamp() + interval '1 day'
    )
  `, [
    collaboratorSessionId,
    projectId,
    sourceAssetId,
    outsiderUserId,
    collaboratorGrantId,
    sourceVersionId,
    '6'.repeat(64),
    `candidate:${collaboratorSessionId}`,
    STORAGE_PROVIDER,
    STORAGE_BUCKET,
    collaboratorProviderUploadId,
    collaboratorStorageKey,
    EXPECTED_SHA256
  ]);
  await proof.query(`
    update audio_file_access_grants
    set revoked_at = clock_timestamp(),
        revoked_by_user_id = $2,
        revocation_reason = 'Wave 5B provider-operation negative proof'
    where id = $1
  `, [collaboratorGrantId, ownerUserId]);
  for (const operationType of ['upload_part', 'complete_multipart', 'abort_upload', 'discard_upload']) {
    await assertDatabaseRejects(
      () => insertNonInitiationOperation({
        id: randomUUID(),
        operationType,
        actorUserId: outsiderUserId,
        uploadSessionId: collaboratorSessionId,
        sessionStorageKey: collaboratorStorageKey,
        sessionProviderUploadId: collaboratorProviderUploadId,
        ...(operationType === 'upload_part'
          ? {
              partNumber: 1,
              bodySha256: EXPECTED_SHA256,
              bodyMd5: '5'.repeat(32),
              bodyByteSize: 128
            }
          : {}),
        requestPayload: {
          collaboratorFileGrantId: collaboratorGrantId,
          operationType,
          negativeProof: 'revoked-collaborator-grant'
        }
      }),
      /requires an active exact-file upload grant/i,
      `${operationType} must reject a revoked collaborator file grant`
    );
  }

  const wrongActorRecovery = await createDeadLetterInitiationWithSession({
    suffix: 'wrong-actor-recovery',
    sessionActorUserId: outsiderUserId
  });
  const wrongActorEvidence = { sessionRecovered: true, observation: 'wrong-actor-negative-proof' };
  await assertDatabaseRejects(
    () => proof.query(`
      insert into audio_provider_operation_resolutions (
        operation_id,
        resolution_type,
        upload_session_id,
        resolved_by_user_id,
        provider_observed_at,
        evidence_fingerprint,
        evidence
      ) values ($1, 'session_recovered', $2, $3, clock_timestamp(), $4, $5::jsonb)
    `, [
      wrongActorRecovery.id,
      wrongActorRecovery.plannedSessionId,
      ownerUserId,
      evidenceFingerprint(wrongActorEvidence),
      JSON.stringify(wrongActorEvidence)
    ]),
    /recovered session resolution must match the exact dead-letter provider intent/i,
    'Session recovery must preserve the original user actor'
  );

  const inactiveSessionRecovery = await createDeadLetterInitiationWithSession({
    suffix: 'inactive-session-recovery',
    sessionActorUserId: ownerUserId,
    expireSession: true
  });
  const inactiveSessionEvidence = { sessionRecovered: true, observation: 'inactive-session-negative-proof' };
  await assertDatabaseRejects(
    () => proof.query(`
      insert into audio_provider_operation_resolutions (
        operation_id,
        resolution_type,
        upload_session_id,
        resolved_by_user_id,
        provider_observed_at,
        evidence_fingerprint,
        evidence
      ) values ($1, 'session_recovered', $2, $3, clock_timestamp(), $4, $5::jsonb)
    `, [
      inactiveSessionRecovery.id,
      inactiveSessionRecovery.plannedSessionId,
      ownerUserId,
      evidenceFingerprint(inactiveSessionEvidence),
      JSON.stringify(inactiveSessionEvidence)
    ]),
    /recovered session resolution must match the exact dead-letter provider intent/i,
    'Inactive unsealed sessions must not release a dead-letter reservation'
  );

  const audit = await proof.query(`
    select event_type, previous_status, next_status, metadata::text as metadata_text
    from audit_events
    where entity_type = 'audio_provider_operation' and entity_id = $1
    order by created_at, event_id
  `, [operationId]);
  assert.ok(audit.rowCount >= 7, 'Every durable reservation/attempt/state change must append audit evidence.');
  assert.equal(
    audit.rows.some((row) => row.metadata_text.includes(storageKey) || row.metadata_text.includes('expectedByteSize')),
    false,
    'Provider-operation audit metadata must not copy private object keys or request payloads.'
  );

  console.log(`Audio provider-operation database durability proof passed (${proof.kind}).`);
} finally {
  await proof.close();
}
