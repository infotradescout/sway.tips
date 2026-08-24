import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Client } from 'pg';
import { assertDisposableDatabaseTarget } from './lib/disposable-database-guard.mjs';

const root = process.cwd();
const migrationsDirectory = join(root, 'drizzle');

function migrationNumber(filename) {
  const match = /^(\d{4})_.+\.sql$/.exec(filename);
  return match ? Number(match[1]) : null;
}

function migrationStatements(filename) {
  return readFileSync(filename, 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function applyMigration(database, filename) {
  for (const [index, statement] of migrationStatements(join(migrationsDirectory, filename)).entries()) {
    try {
      if (typeof database.exec === 'function') {
        await database.exec(statement);
      } else {
        await database.query(statement);
      }
    } catch (error) {
      throw new Error(`Failed to apply ${filename}, statement ${index + 1}.`, { cause: error });
    }
  }
}

const strictRealPostgresProof = process.argv.includes('--strict-real-postgres')
  || process.env.SWAY_REQUIRE_REAL_POSTGRES_PROOF === 'true';
const realDatabaseUrl = process.env.SWAY_REAL_POSTGRES_PROOF_DATABASE_URL?.trim();

if (strictRealPostgresProof && !realDatabaseUrl) {
  throw new Error('SWAY_REAL_POSTGRES_PROOF_DATABASE_URL is required for the strict real-PostgreSQL migration-upgrade proof.');
}
if (strictRealPostgresProof && process.env.SWAY_ALLOW_DISPOSABLE_DATABASE_RESET !== 'true') {
  throw new Error('SWAY_ALLOW_DISPOSABLE_DATABASE_RESET=true is required for the strict real-PostgreSQL migration-upgrade proof.');
}
if (!strictRealPostgresProof && realDatabaseUrl) {
  throw new Error('SWAY_REAL_POSTGRES_PROOF_DATABASE_URL may be used only with the strict real-PostgreSQL migration-upgrade proof.');
}

const migrationFiles = readdirSync(migrationsDirectory)
  .filter((name) => migrationNumber(name) !== null)
  .sort();
const migrationsThrough0039 = migrationFiles.filter((name) => migrationNumber(name) <= 39);
const migration0040 = migrationFiles.find((name) => migrationNumber(name) === 40);
const migration0041 = migrationFiles.find((name) => migrationNumber(name) === 41);
const migration0042 = migrationFiles.find((name) => migrationNumber(name) === 42);

assert.ok(migrationsThrough0039.length > 0, 'Migrations through 0039 are required.');
assert.ok(migration0040, 'Migration 0040 is required.');
assert.ok(migration0041, 'Migration 0041 is required.');
assert.ok(migration0042, 'Migration 0042 is required.');

let database;
let proofKind;
if (strictRealPostgresProof) {
  assertDisposableDatabaseTarget({
    databaseUrl: realDatabaseUrl,
    label: 'Audio candidate migration-upgrade real PostgreSQL proof',
    stripeSecretKey: undefined
  });
  const client = new Client({ connectionString: realDatabaseUrl });
  await client.connect();
  const attestation = await client.query(
    `select version() as version,
            pg_backend_pid() as backend_pid,
            inet_server_port() as server_port,
            pg_postmaster_start_time() as postmaster_started_at`
  );
  const identity = attestation.rows[0];
  assert.ok(
    identity
      && /^PostgreSQL\b/i.test(identity.version)
      && !/pglite|electric|wasm/i.test(identity.version)
      && Number.isInteger(identity.backend_pid)
      && identity.backend_pid > 0
      && Number.isInteger(identity.server_port)
      && identity.postmaster_started_at,
    'Strict migration-upgrade proof requires an attested standalone PostgreSQL server.'
  );
  const independentClient = new Client({ connectionString: realDatabaseUrl });
  await independentClient.connect();
  try {
    const secondBackend = await independentClient.query('select pg_backend_pid() as backend_pid');
    assert.notEqual(
      secondBackend.rows[0]?.backend_pid,
      identity.backend_pid,
      'Strict migration-upgrade proof requires an independent PostgreSQL backend connection.'
    );
  } finally {
    await independentClient.end();
  }
  await client.query('DROP SCHEMA IF EXISTS public CASCADE');
  await client.query('CREATE SCHEMA public');
  database = client;
  proofKind = 'attested disposable real PostgreSQL';
} else {
  database = new PGlite();
  proofKind = 'isolated PGlite';
}

try {
  for (const filename of migrationsThrough0039) await applyMigration(database, filename);

  const [ownerUserId, collaboratorUserId] = [randomUUID(), randomUUID()].sort();
  const performerId = randomUUID();
  const projectId = randomUUID();
  const projectAccessGrantId = randomUUID();
  const assetId = randomUUID();
  const uploadSessionId = randomUUID();
  const sourceVersionId = randomUUID();
  const connectionId = randomUUID();
  const legacyGrantId = randomUUID();
  const candidateGrantId = randomUUID();
  const candidateUploadSessionId = randomUUID();
  const orphanCleanupReceiptId = randomUUID();
  const sessionCleanupReceiptId = randomUUID();
  const invalidCleanupReceiptId = randomUUID();
  const sourceSha256 = 'a'.repeat(64);
  const candidateSha256 = 'b'.repeat(64);
  const candidateGrantKeyHash = 'c'.repeat(64);
  const candidateGrantFingerprint = 'd'.repeat(64);
  const candidateUploadFingerprint = 'e'.repeat(64);

  await database.query(
    `insert into users (id, email) values ($1::uuid, $2), ($3::uuid, $4)`,
    [
      ownerUserId,
      `legacy-owner-${ownerUserId}@example.test`,
      collaboratorUserId,
      `legacy-collaborator-${collaboratorUserId}@example.test`
    ]
  );
  await database.query(
    `insert into performers (id, owner_user_id, handle, display_name)
     values ($1::uuid, $2::uuid, $3, $4)`,
    [performerId, ownerUserId, `legacy-${performerId.slice(0, 12)}`, 'Legacy candidate migration proof']
  );
  await database.query(
    `insert into audio_projects (id, performer_id, created_by_user_id, title)
     values ($1::uuid, $2::uuid, $3::uuid, $4)`,
    [projectId, performerId, ownerUserId, 'Legacy candidate migration project']
  );
  await database.query(
    `insert into audio_project_access_grants (
       id, project_id, grantee_user_id, role, can_upload_versions,
       can_download_originals, can_comment, can_approve, can_manage_release,
       can_manage_access, granted_by_user_id
     ) values (
       $1::uuid, $2::uuid, $3::uuid, 'owner', true,
       true, true, true, true,
       true, $3::uuid
     )`,
    [projectAccessGrantId, projectId, ownerUserId]
  );
  await database.query(
    `insert into audio_assets (id, project_id, created_by_user_id, title, asset_kind)
     values ($1::uuid, $2::uuid, $3::uuid, $4, 'master_audio')`,
    [assetId, projectId, ownerUserId, 'legacy-source.wav']
  );
  await database.query(
    `insert into audio_upload_sessions (
       id, project_id, asset_id, initiated_by_user_id, idempotency_key,
       storage_provider, storage_bucket, provider_upload_id, storage_key,
       original_filename, expected_mime_type, expected_byte_size,
       expected_sha256, part_size_bytes, upload_status, expires_at
     ) values (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
       'local_private_fs', 'legacy-upgrade-proof', $6, $7,
       'legacy-source.wav', 'audio/wav', 844,
       $8, 5242880, 'initiated', clock_timestamp() + interval '1 day'
     )`,
    [
      uploadSessionId,
      projectId,
      assetId,
      ownerUserId,
      `legacy-upload-${uploadSessionId}`,
      `legacy-provider-${uploadSessionId}`,
      `legacy/${projectId}/${uploadSessionId}/source.wav`,
      sourceSha256
    ]
  );
  await database.query(`update audio_upload_sessions set upload_status = 'uploading' where id = $1::uuid`, [uploadSessionId]);
  await database.query(`update audio_upload_sessions set upload_status = 'uploaded' where id = $1::uuid`, [uploadSessionId]);
  await database.query(`update audio_upload_sessions set upload_status = 'verifying' where id = $1::uuid`, [uploadSessionId]);
  await database.query(
    `update audio_upload_sessions
     set upload_status = 'completed', completed_at = clock_timestamp()
     where id = $1::uuid`,
    [uploadSessionId]
  );
  await database.query(
    `insert into audio_project_asset_versions (
       id, project_id, performer_id, asset_id, uploaded_by_user_id,
       upload_session_id, version_number, original_filename, storage_provider,
       storage_bucket, storage_key, mime_type, byte_size, sha256,
       integrity_status, integrity_verifier_key, integrity_verified_at,
       integrity_evidence, original_preserved
     ) values (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
       $6::uuid, 1, 'legacy-source.wav', 'local_private_fs',
       'legacy-upgrade-proof', $7, 'audio/wav', 844, $8,
       'verified', 'sway.migration-upgrade-proof', clock_timestamp(),
       '{"source":"legacy-upgrade-proof"}'::jsonb, true
     )`,
    [
      sourceVersionId,
      projectId,
      performerId,
      assetId,
      ownerUserId,
      uploadSessionId,
      `legacy/${projectId}/${uploadSessionId}/source.wav`,
      sourceSha256
    ]
  );
  await database.query(
    `insert into audio_file_connections (
       id, member_one_user_id, member_two_user_id, created_by_user_id, created_from_purpose
     ) values ($1::uuid, $2::uuid, $3::uuid, $2::uuid, 'request_files')`,
    [connectionId, ownerUserId, collaboratorUserId]
  );
  await database.query(
    `insert into audio_file_access_grants (
       id, connection_id, connection_member_one_user_id, connection_member_two_user_id,
       project_id, asset_version_id, grantor_project_access_grant_id,
       grantor_can_manage_access, granted_by_user_id, grantee_user_id,
       can_stream_preview, can_download_original, can_upload_new_version,
       can_comment, can_approve
     ) values (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       $5::uuid, $6::uuid, $7::uuid,
       true, $3::uuid, $4::uuid,
       true, false, true,
       true, false
     )`,
    [
      legacyGrantId,
      connectionId,
      ownerUserId,
      collaboratorUserId,
      projectId,
      sourceVersionId,
      projectAccessGrantId
    ]
  );

  const legacyRows = await database.query(
    `select can_upload_new_version from audio_file_access_grants where id = $1::uuid`,
    [legacyGrantId]
  );
  assert.equal(legacyRows.rows[0]?.can_upload_new_version, true, 'The pre-0040 fixture must exercise the valid legacy upload permission.');

  await applyMigration(database, migration0040);

  await database.query(
    `insert into performer_capability_grant_events (
       performer_id, capability, decision, actor_type, actor_user_id,
       reason, evidence, expires_at, idempotency_key_hash
     ) values (
       $1::uuid, 'private_collaboration', 'granted', 'system', null,
       $2, $3::jsonb, null, $4
     )`,
    [
      performerId,
      'Wave 5A migration-upgrade candidate fixture',
      JSON.stringify({ proof: 'candidate_grant_before_0042' }),
      'f'.repeat(64)
    ]
  );
  await database.query(
    `insert into audio_file_access_grants (
       id, connection_id, connection_member_one_user_id, connection_member_two_user_id,
       project_id, asset_version_id, grantor_project_access_grant_id,
       grantor_can_manage_access, granted_by_user_id, grantee_user_id,
       grant_purpose, idempotency_key_hash, intent_fingerprint,
       can_stream_preview, can_download_original, can_upload_new_version,
       can_comment, can_approve, expires_at
     ) values (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       $5::uuid, $6::uuid, $7::uuid,
       true, $3::uuid, $4::uuid,
       'collaborator_revision_upload', $8, $9,
       false, false, true,
       false, false, clock_timestamp() + interval '1 day'
     )`,
    [
      candidateGrantId,
      connectionId,
      ownerUserId,
      collaboratorUserId,
      projectId,
      sourceVersionId,
      projectAccessGrantId,
      candidateGrantKeyHash,
      candidateGrantFingerprint
    ]
  );
  await database.query(
    `insert into audio_upload_sessions (
       id, project_id, asset_id, initiated_by_user_id, upload_purpose,
       collaborator_file_grant_id, source_asset_version_id, request_fingerprint,
       idempotency_key, storage_provider, storage_bucket, provider_upload_id,
       storage_key, original_filename, expected_mime_type, expected_byte_size,
       expected_sha256, part_size_bytes, upload_status, expires_at
     ) values (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'collaborator_revision',
       $5::uuid, $6::uuid, $7,
       $8, 'local_private_fs', 'legacy-upgrade-proof', $9,
       $10, 'candidate-before-0042.wav', 'audio/wav', 844,
       $11, 5242880, 'initiated', clock_timestamp() + interval '1 day'
     )`,
    [
      candidateUploadSessionId,
      projectId,
      assetId,
      collaboratorUserId,
      candidateGrantId,
      sourceVersionId,
      candidateUploadFingerprint,
      `candidate-upload-before-0042-${candidateUploadSessionId}`,
      `candidate-provider-${candidateUploadSessionId}`,
      `legacy/${projectId}/${candidateUploadSessionId}/candidate.wav`,
      candidateSha256
    ]
  );

  await applyMigration(database, migration0041);
  await database.query(
    `insert into audio_object_cleanup_receipts (
       id, project_id, actor_user_id, upload_session_id,
       storage_provider, storage_bucket, storage_key, provider_upload_id,
       cleanup_reason, cleanup_status, attempt_count, last_error
     ) values (
       $1::uuid, $2::uuid, $3::uuid, null,
       'local_private_fs', 'legacy-upgrade-proof', $4, $5,
       'orphaned_candidate_initiation', 'pending', 1, $6
     )`,
    [
      orphanCleanupReceiptId,
      projectId,
      collaboratorUserId,
      `legacy/${projectId}/orphan-before-0042/candidate.wav`,
      `orphan-provider-${orphanCleanupReceiptId}`,
      'Fixture orphan retained before exact cleanup identity constraints.'
    ]
  );
  await database.query(
    `insert into audio_object_cleanup_receipts (
       id, project_id, actor_user_id, upload_session_id,
       storage_provider, storage_bucket, storage_key, provider_upload_id,
       cleanup_reason, cleanup_status, attempt_count, last_error
     ) values (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       'local_private_fs', 'legacy-upgrade-proof', $5, $6,
       'candidate_technical_validation_failed', 'pending', 1, $7
     )`,
    [
      sessionCleanupReceiptId,
      projectId,
      collaboratorUserId,
      candidateUploadSessionId,
      `legacy/${projectId}/${candidateUploadSessionId}/candidate.wav`,
      `candidate-provider-${candidateUploadSessionId}`,
      'Fixture session-backed cleanup retained before exact cleanup identity constraints.'
    ]
  );
  await database.query(
    `insert into audio_object_cleanup_receipts (
       id, project_id, actor_user_id, upload_session_id,
       storage_provider, storage_bucket, storage_key, provider_upload_id,
       cleanup_reason, cleanup_status, attempt_count, last_error
     ) values (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       'local_private_fs', 'legacy-upgrade-proof', $5, null,
       'owner_integrity_validation_failed', 'pending', 1, $6
     )`,
    [
      invalidCleanupReceiptId,
      projectId,
      ownerUserId,
      uploadSessionId,
      `legacy/${projectId}/invalid-null-provider-before-0042/source.wav`,
      'Fixture must be rejected before any 0042 DDL is applied.'
    ]
  );

  const upgradedRows = await database.query(
    `select grant_purpose, can_upload_new_version, idempotency_key_hash, intent_fingerprint,
            revoked_at, revoked_by_user_id, revocation_reason
     from audio_file_access_grants
     where id = $1::uuid`,
    [legacyGrantId]
  );
  assert.equal(upgradedRows.rows.length, 1, 'The legacy selected-file grant must survive the Wave 5A migration.');
  const upgradedGrant = upgradedRows.rows[0];
  assert.equal(upgradedGrant.grant_purpose, 'review_share');
  assert.equal(upgradedGrant.can_upload_new_version, false);
  assert.equal(upgradedGrant.idempotency_key_hash, null);
  assert.equal(upgradedGrant.intent_fingerprint, null);
  assert.ok(upgradedGrant.revoked_at, 'Legacy upload authority must be explicitly revoked during 0040.');
  assert.equal(upgradedGrant.revoked_by_user_id, ownerUserId);
  assert.equal(
    upgradedGrant.revocation_reason,
    'Revoked during Wave 5A migration: legacy upload authority lacked bounded candidate intent.'
  );
  const activeAfter0041 = await database.query(
    `select id from audio_file_access_grants where id = $1::uuid and revoked_at is null`,
    [legacyGrantId]
  );
  assert.equal(
    activeAfter0041.rows.length,
    0,
    'Legacy upload authority must not be silently converted into active review access.'
  );

  await assert.rejects(
    applyMigration(database, migration0042),
    (error) => /cleanup receipt preflight failed/i.test(
      String(error?.cause?.message || error?.message || error)
    )
  );
  await database.query(
    `delete from audio_object_cleanup_receipts where id = $1::uuid`,
    [invalidCleanupReceiptId]
  );
  await applyMigration(database, migration0042);

  const finalRows = await database.query(
    `select grant_purpose, can_upload_new_version, idempotency_key_hash, intent_fingerprint,
            max_candidate_bytes, revoked_at, revoked_by_user_id, revocation_reason
     from audio_file_access_grants
     where id = $1::uuid`,
    [legacyGrantId]
  );
  assert.equal(finalRows.rows.length, 1, 'The sanitized legacy grant must remain present after 0042.');
  const finalGrant = finalRows.rows[0];
  assert.equal(finalGrant.grant_purpose, 'review_share');
  assert.equal(finalGrant.can_upload_new_version, false);
  assert.equal(finalGrant.idempotency_key_hash, null);
  assert.equal(finalGrant.intent_fingerprint, null);
  assert.equal(finalGrant.max_candidate_bytes, null, 'Review-only legacy rows must not gain a candidate byte ceiling.');
  assert.equal(new Date(finalGrant.revoked_at).getTime(), new Date(upgradedGrant.revoked_at).getTime());
  assert.equal(finalGrant.revoked_by_user_id, ownerUserId);
  assert.equal(finalGrant.revocation_reason, upgradedGrant.revocation_reason);

  const migratedCandidateRows = await database.query(
    `select grant_purpose, max_candidate_bytes, revoked_at, revoked_by_user_id, revocation_reason
     from audio_file_access_grants
     where id = $1::uuid`,
    [candidateGrantId]
  );
  assert.equal(migratedCandidateRows.rows.length, 1, 'The valid pre-0042 candidate grant must survive as audit evidence.');
  const migratedCandidateGrant = migratedCandidateRows.rows[0];
  assert.equal(migratedCandidateGrant.grant_purpose, 'collaborator_revision_upload');
  assert.equal(Number(migratedCandidateGrant.max_candidate_bytes), 536870912);
  assert.ok(migratedCandidateGrant.revoked_at, 'A pre-ceiling candidate grant must be explicitly revoked by 0042.');
  assert.equal(migratedCandidateGrant.revoked_by_user_id, ownerUserId);
  assert.equal(
    migratedCandidateGrant.revocation_reason,
    'Revoked during Wave 5A migration: creator-approved candidate byte ceiling was not recorded.'
  );
  await assert.rejects(
    database.query(
      `select sway_require_active_collaborator_revision_grant(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid
       )`,
      [candidateGrantId, projectId, collaboratorUserId, assetId, sourceVersionId]
    ),
    (error) => /active exact-file upload grant/i.test(String(error?.message || error?.cause?.message || error))
  );

  const migratedReceipts = await database.query(
    `select id, upload_session_id, storage_provider, storage_bucket, storage_key,
            provider_upload_id, cleanup_reason, cleanup_status
     from audio_object_cleanup_receipts
     where id in ($1::uuid, $2::uuid)
     order by id`,
    [orphanCleanupReceiptId, sessionCleanupReceiptId]
  );
  assert.equal(migratedReceipts.rows.length, 2, 'Both valid pre-0042 cleanup receipt shapes must survive 0042.');
  const orphanReceipt = migratedReceipts.rows.find((row) => row.id === orphanCleanupReceiptId);
  const sessionReceipt = migratedReceipts.rows.find((row) => row.id === sessionCleanupReceiptId);
  assert.equal(orphanReceipt?.upload_session_id, null);
  assert.equal(orphanReceipt?.cleanup_reason, 'orphaned_candidate_initiation');
  assert.equal(orphanReceipt?.cleanup_status, 'pending');
  assert.equal(sessionReceipt?.upload_session_id, candidateUploadSessionId);
  assert.equal(sessionReceipt?.storage_provider, 'local_private_fs');
  assert.equal(sessionReceipt?.storage_bucket, 'legacy-upgrade-proof');
  assert.equal(sessionReceipt?.storage_key, `legacy/${projectId}/${candidateUploadSessionId}/candidate.wav`);
  assert.equal(sessionReceipt?.provider_upload_id, `candidate-provider-${candidateUploadSessionId}`);
  assert.equal(sessionReceipt?.cleanup_reason, 'candidate_technical_validation_failed');
  assert.equal(sessionReceipt?.cleanup_status, 'pending');
  await assert.rejects(
    database.query(
      `insert into audio_object_cleanup_receipts (
         project_id, actor_user_id, upload_session_id,
         storage_provider, storage_bucket, storage_key, provider_upload_id,
         cleanup_reason, cleanup_status, attempt_count, last_error, completed_at
       ) values (
         $1::uuid, $2::uuid, null,
         'local_private_fs', 'legacy-upgrade-proof', $3, null,
         'orphaned_candidate_initiation', 'completed', 1, $4, clock_timestamp()
       )`,
      [
        projectId,
        collaboratorUserId,
        `legacy/${projectId}/invalid-completed-insert/candidate.wav`,
        'Completed insertion must be rejected by the append-only receipt trigger.'
      ]
    ),
    (error) => /must begin pending at attempt one/i.test(String(error?.message || error))
  );

  console.log(
    `Audio candidate migration upgrade integration passed on ${proofKind}: a valid legacy upload-enabled `
      + 'selected-file grant is explicitly revoked and sanitized by 0040/0041, then remains schema-valid '
      + 'through 0042 as an inactive review-only record with max_candidate_bytes null; a valid pre-ceiling '
      + 'candidate grant is capped and revoked, cannot authorize intake, and both orphan and exact-session '
      + 'cleanup receipts survive the new 0042 constraints; invalid populated identity is rejected before '
      + 'DDL and new cleanup evidence must begin pending at attempt one.'
  );
} finally {
  if (strictRealPostgresProof) {
    await database.end();
  } else {
    await database.close();
  }
}
