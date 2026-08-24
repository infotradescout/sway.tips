import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');
const schema = read('src/db/schema.ts');
const migration = read('drizzle/0043_greedy_reavers.sql');
const storagePolicy = read('src/server/audio-storage-policy.ts');
const coordinator = read('src/server/audio-provider-operation-service.ts');
const publishing = read('src/server/audio-publishing-service.ts');
const objectStorage = read('src/server/audio-object-storage.ts');
const localObjectStorage = read('src/server/audio-object-storage-local.ts');
const r2ObjectStorage = read('src/server/audio-object-storage-r2.ts');
const collaboration = read('src/server/audio-file-collaboration-service.ts');
const pairing = read('src/server/audio-file-pairing-service.ts');
const integration = read('scripts/sway-audio-provider-operation-durability.integration.test.mjs');
const storageIntegration = read('scripts/sway-audio-storage-policy.integration.test.mjs');
const candidateIntegration = read('scripts/sway-audio-candidate-revisions.integration.test.mjs');
const httpIntegration = read('scripts/sway-collaborator-revision-http.integration.test.mjs');
const server = read('server.ts');
const packageJson = JSON.parse(read('package.json'));
const failures = [];

function requireTerms(source, label, terms) {
  for (const term of terms) {
    if (!source.includes(term)) failures.push(`${label} missing required term: ${term}`);
  }
}

requireTerms(schema, 'Provider-operation schema', [
  "export const audioProviderOperations = pgTable('audio_provider_operations'",
  "'initiate_multipart', 'upload_part', 'complete_multipart', 'discard_upload', 'abort_upload'",
  "'pending', 'leased', 'reconcile_required', 'awaiting_client_retry', 'succeeded', 'canceled', 'dead_letter'",
  'audio_provider_operations_operation_key_idx',
  'audio_provider_operations_subject_operation_idx',
  'audio_provider_operations_storage_identity_required',
  'audio_provider_operations_lease_coherent',
  "export const audioProviderOperationAttempts = pgTable('audio_provider_operation_attempts'",
  "export const audioProviderOperationResolutions = pgTable('audio_provider_operation_resolutions'",
  '${table.partNumber} is not null',
  '${table.bodySha256} is not null',
  '${table.bodyMd5} is not null',
  '${table.bodyByteSize} is not null',
  "${table.requestPayload} ? 'expectedByteSize'",
  '${table.resultFingerprint} is not null'
]);
requireTerms(migration, 'Provider-operation migration', [
  'sway_enforce_audio_provider_attempt_state',
  'sway_enforce_audio_provider_operation_state',
  'sway_enforce_audio_provider_operation_resolution',
  'Audio provider operations are durable evidence and cannot be deleted.',
  'Audio provider operation intent identity is immutable.',
  'must reconcile before retry',
  'lease acquisition must be available, fresh, fenced, mode-safe, and bounded',
  'Expired audio provider operation leases are fenced',
  'Confirmed provider result evidence is immutable.',
  'pg_trigger_depth() <> 2',
  'internal durable evidence and may only be changed by provider-operation transitions',
  'System recovery cannot create fresh multipart initiation intent',
  'User-origin provider operations must match the exact upload-session actor.',
  'Collaborator provider operations require the exact session file grant.',
  'PERFORM sway_require_active_collaborator_revision_grant(',
  'operation_record.attempt_count >= operation_record.max_attempts',
  "NEW.status = 'dead_letter'",
  "WHEN OLD.status = 'leased' AND OLD.provider_started_at IS NOT NULL THEN 'reconcile'",
  'Only reconciled, provider-safe upload-part operations may await a replayed client body.',
  "NOT coalesce(NEW.evidence->>'multipartAbsent' = 'true', false)",
  "upload_record.initiated_by_user_id IS DISTINCT FROM operation_record.requested_by_user_id",
  'Successful multipart initiation must atomically transfer its exact actor-bound reservation',
  'Canceled audio provider operations require exact proof that no provider state remains.',
  'Audio provider operation resolutions are append-only evidence.',
  'sway_record_audio_provider_operation_audit',
  "'providerCallStarted'",
  "'sessionLinked'"
]);
requireTerms(storagePolicy, 'Sessionless reservation accounting', [
  'provider_operation_reservation_usage as (',
  "operation.operation_type = 'initiate_multipart'",
  "operation.status not in ('succeeded', 'canceled')",
  'audio_provider_operation_resolutions resolution',
  'session_reservation_usage.reserved_bytes::bigint',
  'provider_operation_reservation_usage.reserved_bytes::bigint'
]);
requireTerms(coordinator, 'Provider-operation coordinator', [
  'AudioProviderCallTimeoutError',
  "readonly code = 'audio_provider_call_timed_out'",
  'AudioProviderLeaseHeartbeatError',
  "readonly code = 'audio_provider_lease_heartbeat_failed'",
  'providerCallTimeoutMs',
  'buildAudioProviderOperationKey',
  'canonicalAudioProviderValue',
  'assertReservedOperationMatches',
  "status === 'reconcile_required'",
  'markProviderStarted',
  'markReconcileRequired',
  'renewLease',
  'runLeasedProviderCall',
  'call: (signal: AbortSignal) => Promise<T>',
  'controller.abort(timeoutError)',
  'void renewLease(lease)',
  'heartbeatFenceError',
  'detachUntilProviderSettles',
  "'provider_lease_heartbeat_failed'",
  'resetAfterSafeReconciliation',
  'finalizeSuccess',
  'finalizeCanceledAfterCleanup',
  'finalizeCanceledBeforeProviderStart',
  "return { kind: 'fenced' as const, operation }",
  "throw new AudioProviderOperationBusyError('The provider-operation lease expired or was fenced by another worker.')"
]);
requireTerms(objectStorage, 'Abortable object-storage contract', [
  'signal?: AbortSignal'
]);
requireTerms(localObjectStorage, 'Local provider abort handling', [
  'signal?.throwIfAborted()',
  'options?.signal?.throwIfAborted()'
]);
requireTerms(r2ObjectStorage, 'R2 provider abort handling', [
  'abortSignal: signal',
  'sendOptions(signal)'
]);
requireTerms(publishing, 'Provider-operation publishing runtime', [
  'providerOperationLeaseDurationMs',
  'providerOperationCallTimeoutMs',
  'providerOperations.runLeasedProviderCall',
  'runInitiationProviderOperation',
  'runAssemblyProviderOperation',
  'runCleanupProviderOperation',
  'runAssemblyCleanupRecovery',
  'prepareSessionCleanupProviderOperation',
  'cancelSessionMutationOperationsAfterCleanup',
  'reconcileDueAudioProviderOperations',
  'finalizeInitiationDomain',
  'finalizeUploadPartDomain',
  'reserveSessionCleanupProviderOperation',
  'store.reconcileUpload',
  'store.reconcilePart',
  'store.reconcileAssembly',
  'store.reconcileCleanup',
  "operationType: 'initiate_multipart'",
  "operationType: 'upload_part'",
  "operationType: 'complete_multipart'",
  "inArray(audioProviderOperations.operationType, ['discard_upload', 'abort_upload'])",
  "throw new AudioProviderOperationBusyError('Upload cleanup intent already owns this session.')",
  'Successful provider cleanup is missing its atomic domain receipt.'
]);
const initiationRunner = publishing.slice(
  publishing.indexOf('async function runInitiationProviderOperation'),
  publishing.indexOf('async function runAssemblyProviderOperation')
);
const assemblyRunner = publishing.slice(
  publishing.indexOf('async function runAssemblyProviderOperation'),
  publishing.indexOf('async function assertUnsealedUploadIdentity')
);
for (const [label, runner] of [['initiation', initiationRunner], ['assembly', assemblyRunner]]) {
  if (!runner.includes('poll < 40')
    || !runner.includes('setTimeout(resolve, 25)')
    || !runner.includes('leaseStillBusy')
    || !runner.includes('AudioProviderOperationBusyError')) {
    failures.push(`Provider-operation ${label} busy wait must remain bounded to 40 polls at 25ms before returning busy.`);
  }
}
requireTerms(publishing, 'Cross-operation cleanup and replay runtime', [
  "['upload_part', 'complete_multipart'].includes(operation.operationType)",
  "['discard_upload', 'abort_upload'].includes(operation.operationType)",
  "return { kind: 'deferred' as const, operation, blockingOperation: activeMutation }",
  'cleanupOperationId: cleanupOperation.id',
  'owner_upload_intent_conflict',
  'const requestFingerprint = fingerprintAudioProviderValue(requestIntent)',
  "sessionIdempotencyKey: idempotencyKey",
  "'initiation_finalization_failed'",
  "'assembly_finalization_failed'"
]);
requireTerms(publishing, 'Atomic authority-loss cleanup runtime', [
  'reserveCollaboratorRevisionAuthorityCleanupIntent',
  'completePendingSessionlessCleanupReceipt',
  "eventType: 'audio_candidate_revision.authority_cleanup_requested'",
  "eventType: 'audio_provider_operation.authority_cleanup_requested'",
  'sessionlessCleanupCount',
  'pendingReceiptOperationIds',
  'canceledSessionlessOperationIds'
]);
requireTerms(collaboration, 'Atomic grant-revocation cleanup hook', [
  'beforeGrantRevocation',
  '.for(\'update\')',
  'await beforeGrantRevocation(tx, { grantId: lockedGrant.id, actorUserId: input.userId })'
]);
const grantRevocation = collaboration.slice(
  collaboration.indexOf('async function revokeGrant')
);
if (grantRevocation.indexOf('await beforeGrantRevocation') < 0
  || grantRevocation.indexOf('await beforeGrantRevocation') > grantRevocation.indexOf('.update(audioFileAccessGrants)')) {
  failures.push('Grant revocation must reserve candidate cleanup intent before the revocation update commits.');
}
requireTerms(pairing, 'Atomic connection-revocation cleanup hook', [
  'beforeConnectionRevocation',
  '.for(\'update\')',
  'await beforeConnectionRevocation(tx, {'
]);
const connectionRevocation = pairing.slice(
  pairing.indexOf('async function revokeConnection'),
  pairing.indexOf('return {', pairing.indexOf('async function revokeConnection'))
);
if (connectionRevocation.indexOf('await beforeConnectionRevocation') < 0
  || connectionRevocation.indexOf('await beforeConnectionRevocation') > connectionRevocation.indexOf('.update(audioFileConnections)')) {
  failures.push('Connection revocation must reserve candidate cleanup intent before the revocation update commits.');
}
requireTerms(server, 'Provider-operation worker and truthful cleanup response', [
  'audioPublishingService.reconcileDueAudioProviderOperations({ limit: 100 })',
  'beforeConnectionRevocation: audioPublishingService',
  'beforeGrantRevocation: audioPublishingService',
  'reserveCollaboratorRevisionAuthorityCleanupIntent(tx, {',
  'cleanup.inProgressCount > 0',
  "? 'in_progress'",
  'inProgressCount: cleanup.inProgressCount'
]);
requireTerms(storageIntegration, 'Expiry and owner replay barrier proof', [
  "process.argv.includes('--strict-real-postgres')",
  'Wave 5B standalone-PostgreSQL proof refuses generic DATABASE_URL',
  'Owner idempotency is actor-and-intent bound before provider dispatch.',
  'Expiry installs a durable cleanup fence while a part provider call is in',
  'Expiry must persist cleanup intent before the part lease settles.',
  'A provider call that ignores abort and outlives its original short lease',
  'remains fenced by the durable heartbeat.',
  'providerOperationCallTimeoutMs: 500',
  'A transient database failure during lease renewal must take the same',
  'forced audio provider heartbeat renewal failure',
  "assert.equal(heartbeatAttemptWhileProviderHeld.outcome, 'active')",
  "heartbeatFailureAttempts.every((attempt) => attempt.outcome !== 'active')",
  'Rejected owner replay must not dispatch provider I/O.',
  "attempt.outcome !== 'active'"
]);
requireTerms(candidateIntegration, 'Authority-loss process barrier proof', [
  'CreateMultipart succeeds but grant authority ends before the session',
  'Grant revocation installs a durable cleanup operation and receipt while a',
  "assert.equal(sessionlessReceiptBeforeRecovery.cleanupStatus, 'pending')",
  "assert.equal(sessionlessReceiptAfterRecovery.cleanupStatus, 'completed')",
  'CompleteMultipart may succeed before revocation wins the atomic DB',
  "sessionlessOperationBeforeRecovery.status, 'reconcile_required'",
  "assemblyAfterCleanup.status, 'canceled'",
  "attempt.outcome !== 'active'"
]);
requireTerms(httpIntegration, 'Sessionless revocation route proof', [
  "assertStatus(revokeDuringSessionlessInitiation, 202",
  "candidateUploadCleanup.state, 'complete'",
  'candidateUploadCleanup.pendingReceiptCount >= 1',
  "assert.equal(revocationRaceReceipt.cleanupStatus, 'completed')"
]);
for (const forbidden of [
  'discardUnsealedUpload(identity, tx)',
  'discardUnsealedUpload(sessionObjectIdentity(session), tx)',
  'discardUnsealedUpload(objectIdentity, tx)'
]) {
  if (publishing.includes(forbidden)) {
    failures.push(`Provider-operation publishing runtime still performs cleanup inside a transaction: ${forbidden}`);
  }
}
requireTerms(integration, 'Provider-operation database proof', [
  'Sessionless provider intent must reserve its bytes.',
  'Started provider I/O must never return directly to pending',
  'Expired holder must not renew the same fencing token',
  'Lost-response recovery must retain provider-start evidence.',
  'Every lease generation and process-kill outcome must remain independently durable.',
  'Attempt rows must reject independent forged inserts',
  'Attempt rows must reject independent ${forgedMutation.label} mutation',
  'Upload-part intent missing',
  'Initiation reservation without expectedByteSize must fail closed',
  'Cancellation evidence without a result fingerprint must fail closed',
  'Started upload-part work must reconcile before requesting a client replay',
  'Expired confirmed provider work must not reacquire execute mode',
  'Exhausted initiation must remain charged after atomic dead-letter finalization.',
  'Resolved exhausted initiation must release its retained reservation.',
  'must reject a different authorized project user',
  'must reject a revoked collaborator file grant',
  'Linked initiation must transfer, not duplicate, its reservation.',
  'Cancellation without provider-absence proof must fail closed',
  'Provider upload identity without provider-start evidence must fail closed',
  'Confirmed provider result must not be silently rewritten',
  'Unresolved dead-letter initiation must remain charged',
  'Cleanup resolution missing any explicit absence field must fail closed',
  'Session recovery must preserve the original user actor',
  'Inactive unsealed sessions must not release a dead-letter reservation',
  'System recovery must not mint authorityless initiation intent',
  'Confirmed dead-letter cleanup must release its reservation exactly once.',
  'audit metadata must not copy private object keys or request payloads.'
]);

const contractCommand = packageJson.scripts?.['test:contracts'] ?? '';
const expectedCommand = 'node scripts/sway-audio-provider-operation-durability.contract.test.mjs';
const hygieneCommand = 'node scripts/sway-contract-temp-artifact-hygiene.contract.test.mjs';
assert.equal(
  packageJson.scripts?.['test:integration:audio-storage-policy:real-postgres'],
  'node --import tsx scripts/sway-audio-storage-policy.integration.test.mjs --strict-real-postgres',
  'Wave 5B standalone-PostgreSQL race proof must have one portable named command.'
);
assert.ok(
  packageJson.scripts?.['test:wave5b:real-postgres']?.includes('test:integration:audio-storage-policy:real-postgres'),
  'The strict Wave 5B aggregate must include the standalone-PostgreSQL race proof.'
);
assert.ok(contractCommand.includes(expectedCommand), 'Provider-operation durability gate must be wired into test:contracts.');
assert.ok(
  contractCommand.indexOf(expectedCommand) < contractCommand.indexOf(hygieneCommand),
  'Provider-operation durability must run before the terminal temp-artifact hygiene gate.'
);

if (failures.length) {
  console.error('Audio provider-operation durability contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

const databaseProof = spawnSync(
  process.execPath,
  ['--import', 'tsx', join(root, 'scripts/sway-audio-provider-operation-durability.integration.test.mjs')],
  { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }
);
if (databaseProof.stdout) process.stdout.write(databaseProof.stdout);
if (databaseProof.stderr) process.stderr.write(databaseProof.stderr);
if (databaseProof.error || databaseProof.status !== 0) {
  console.error(databaseProof.error ?? 'Audio provider-operation database proof failed.');
  process.exit(1);
}

console.log('Audio provider-operation schema durability checkpoint passed.');
