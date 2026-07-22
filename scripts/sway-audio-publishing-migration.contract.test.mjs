import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const root = process.cwd();
const migrationDirectory = join(root, 'drizzle');
const migrationFiles = readdirSync(migrationDirectory)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();

const database = new PGlite();

async function main() {
for (const migrationFile of migrationFiles) {
  const migrationSql = readFileSync(join(migrationDirectory, migrationFile), 'utf8');
  const statements = migrationSql
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const [statementIndex, statement] of statements.entries()) {
    try {
      await database.exec(statement);
    } catch (error) {
      throw new Error(`Migration failed: ${migrationFile}, statement ${statementIndex + 1}`, { cause: error });
    }
  }
}

const audioFoundationForeignKeys = await database.query(`
  select constraint_name
  from information_schema.table_constraints
  where table_schema = 'public'
    and constraint_type = 'FOREIGN KEY'
    and (
      table_name like 'audio\\_%' escape '\\'
      or table_name like 'music\\_%' escape '\\'
      or table_name = 'media_connector_links'
    )
`);
const audioFoundationForeignKeyNames = new Set(
  audioFoundationForeignKeys.rows.map((row) => String(row.constraint_name))
);
const requiredNamedForeignKeys = [
  'audio_projects_performer_id_performers_id_fk',
  'audio_project_access_grants_project_id_audio_projects_id_fk',
  'audio_project_invitations_project_id_audio_projects_id_fk',
  'audio_upload_sessions_asset_project_fk',
  'audio_project_asset_versions_upload_identity_fk',
  'audio_file_pairing_tokens_connection_members_fk',
  'audio_file_access_grants_grantor_project_access_fk',
  'music_recordings_project_performer_fk',
  'music_release_recordings_release_id_music_releases_id_fk',
  'music_rights_declarations_recording_release_fk',
  'audio_creator_deals_terms_document_project_hash_fk',
  'audio_creator_deal_events_terms_sha_fk',
  'music_distribution_deliveries_release_id_music_releases_id_fk',
  'music_distribution_delivery_events_delivery_id_music_distribution_deliveries_id_fk',
  'music_catalog_transfers_snapshot_performer_fk',
  'music_catalog_transfer_items_transfer_id_music_catalog_transfers_id_fk',
  'music_catalog_transfer_recordings_transfer_item_id_music_catalog_transfer_items_id_fk',
  'media_connector_links_asset_project_fk'
];
for (const constraintName of requiredNamedForeignKeys) {
  const postgresConstraintName = constraintName.slice(0, 63);
  if (!audioFoundationForeignKeyNames.has(postgresConstraintName)) {
    throw new Error(`Missing critical named audio-foundation foreign key: ${constraintName}.`);
  }
}
const automaticallyNamedForeignKeys = audioFoundationForeignKeys.rows
  .filter((row) => String(row.constraint_name).endsWith('_fkey'));
if (automaticallyNamedForeignKeys.length > 0) {
  throw new Error('Audio-foundation foreign keys must use deterministic Drizzle-compatible names.');
}

async function expectDatabaseFailure(label, statement, expectedMessage) {
  try {
    await database.exec(statement);
  } catch (error) {
    if (expectedMessage && !String(error?.message ?? error).includes(expectedMessage)) {
      throw new Error(`${label} Failed for the wrong reason: ${error?.message ?? error}`);
    }
    return;
  }
  throw new Error(label);
}

async function setTransitionContext(reason, metadata = {}) {
  const encodedReason = reason.replaceAll("'", "''");
  const encodedMetadata = JSON.stringify(metadata).replaceAll("'", "''");
  await database.exec(`
    select set_config('sway.actor_user_id', '00000000-0000-0000-0000-000000000001', false);
    select set_config('sway.transition_reason', '${encodedReason}', false);
    select set_config('sway.transition_metadata', '${encodedMetadata}', false);
  `);
}

async function setDeliveryTransitionContext(reason, idempotencyKey, payloadSha256 = '') {
  const encodedReason = reason.replaceAll("'", "''");
  const encodedIdempotencyKey = idempotencyKey.replaceAll("'", "''");
  const encodedPayloadSha256 = payloadSha256.replaceAll("'", "''");
  await database.exec(`
    select set_config('sway.actor_user_id', '00000000-0000-0000-0000-000000000001', false);
    select set_config('sway.delivery_transition_reason', '${encodedReason}', false);
    select set_config('sway.delivery_transition_idempotency_key', '${encodedIdempotencyKey}', false);
    select set_config('sway.delivery_transition_payload_sha256', '${encodedPayloadSha256}', false);
  `);
}

async function recordProviderWebhook(idempotencyKey, providerEventId, payloadSha256) {
  const encodedIdempotencyKey = idempotencyKey.replaceAll("'", "''");
  const encodedProviderEventId = providerEventId.replaceAll("'", "''");
  const encodedPayloadSha256 = payloadSha256.replaceAll("'", "''");
  await database.exec(`
    select set_config('sway.provider_webhook_verified', 'true', false);
    select set_config('sway.provider_webhook_provider_key', 'fixture-provider', false);
    insert into music_distribution_delivery_events (
      delivery_id, event_type, idempotency_key, provider_event_id, payload_sha256
    ) values (
      '00000000-0000-0000-0000-000000000090', 'provider_webhook',
      '${encodedIdempotencyKey}', '${encodedProviderEventId}', '${encodedPayloadSha256}'
    );
    select set_config('sway.provider_webhook_verified', '', false);
    select set_config('sway.provider_webhook_provider_key', '', false);
  `);
}

await database.exec(`
  insert into users (id, email, email_verified_at) values
    ('00000000-0000-0000-0000-000000000001', 'owner@example.test', now()),
    ('00000000-0000-0000-0000-000000000002', 'producer@example.test', now()),
    ('00000000-0000-0000-0000-000000000003', 'outsider@example.test', now());

  insert into performers (id, owner_user_id, display_name)
    values ('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001', 'Migration Test');

  insert into audio_projects (id, performer_id, created_by_user_id, title)
    values ('00000000-0000-0000-0000-000000000020', '00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001', 'Test Project');

  insert into audio_project_access_grants (
    id, project_id, grantee_user_id, role, can_upload_versions, can_download_originals,
    can_comment, can_approve, can_manage_release, can_manage_access, granted_by_user_id
  ) values (
    '00000000-0000-0000-0000-000000000025',
    '00000000-0000-0000-0000-000000000020',
    '00000000-0000-0000-0000-000000000001',
    'owner', true, true, true, true, true, true,
    '00000000-0000-0000-0000-000000000001'
  );

  insert into audio_project_access_grants (
    id, project_id, grantee_user_id, role, can_upload_versions, can_download_originals,
    can_comment, can_approve, can_manage_release, can_manage_access, granted_by_user_id
  ) values (
    '00000000-0000-0000-0000-000000000026',
    '00000000-0000-0000-0000-000000000020',
    '00000000-0000-0000-0000-000000000002',
    'producer', true, true, true, true, false, true,
    '00000000-0000-0000-0000-000000000001'
  );

  insert into audio_project_access_grants (
    id, project_id, grantee_user_id, role, can_approve, granted_by_user_id, expires_at
  ) values (
    '00000000-0000-0000-0000-000000000028',
    '00000000-0000-0000-0000-000000000020',
    '00000000-0000-0000-0000-000000000003',
    'reviewer', true, '00000000-0000-0000-0000-000000000001',
    clock_timestamp() - interval '1 hour'
  );

  insert into audio_assets (id, project_id, created_by_user_id, title, asset_kind)
    values ('00000000-0000-0000-0000-000000000030', '00000000-0000-0000-0000-000000000020', '00000000-0000-0000-0000-000000000001', 'Terms', 'document');

  insert into audio_upload_sessions (
    id, project_id, asset_id, initiated_by_user_id, idempotency_key, storage_provider,
    storage_bucket, provider_upload_id, storage_key, original_filename, expected_mime_type,
    expected_byte_size, expected_sha256, part_size_bytes, expires_at
  ) values (
    '00000000-0000-0000-0000-000000000035',
    '00000000-0000-0000-0000-000000000020',
    '00000000-0000-0000-0000-000000000030',
    '00000000-0000-0000-0000-000000000001',
    'fixture-upload', 'test', 'private', 'fixture-provider-upload', 'terms/1',
    'terms.pdf', 'application/pdf', 100,
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    5242880, now() + interval '1 day'
  );

  update audio_upload_sessions set upload_status = 'uploading' where id = '00000000-0000-0000-0000-000000000035';
  update audio_upload_sessions set upload_status = 'uploaded' where id = '00000000-0000-0000-0000-000000000035';
  update audio_upload_sessions set upload_status = 'verifying' where id = '00000000-0000-0000-0000-000000000035';
  update audio_upload_sessions set upload_status = 'completed', completed_at = clock_timestamp() where id = '00000000-0000-0000-0000-000000000035';

  insert into audio_project_asset_versions (
    id, project_id, performer_id, asset_id, uploaded_by_user_id, upload_session_id,
    version_number, original_filename, storage_provider, storage_bucket, storage_key,
    mime_type, byte_size, sha256, integrity_status, integrity_verifier_key,
    integrity_verified_at, integrity_evidence
  ) values (
    '00000000-0000-0000-0000-000000000040',
    '00000000-0000-0000-0000-000000000020',
    '00000000-0000-0000-0000-000000000010',
    '00000000-0000-0000-0000-000000000030',
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000035',
    1, 'terms.pdf', 'test', 'private', 'terms/1', 'application/pdf', 100,
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'verified', 'migration-contract', clock_timestamp() + interval '1 second',
    '{"checksumVerified":true}'::jsonb
  );

  insert into audio_file_connections (
    id, member_one_user_id, member_two_user_id, created_by_user_id, created_from_purpose
  ) values (
    '00000000-0000-0000-0000-000000000050',
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000001',
    'request_files'
  );

  insert into audio_file_pairing_tokens (
    id, created_by_user_id, purpose, idempotency_key, token_hash, expires_at
  ) values (
    '00000000-0000-0000-0000-000000000051',
    '00000000-0000-0000-0000-000000000001',
    'request_files', 'fixture-pairing',
    'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    now() + interval '10 minutes'
  );

  update audio_file_pairing_tokens set
    consumed_at = now(),
    consumed_by_user_id = '00000000-0000-0000-0000-000000000002',
    connection_id = '00000000-0000-0000-0000-000000000050',
    connection_member_one_user_id = '00000000-0000-0000-0000-000000000001',
    connection_member_two_user_id = '00000000-0000-0000-0000-000000000002'
  where id = '00000000-0000-0000-0000-000000000051';

  insert into audio_file_connection_events (
    connection_id, actor_user_id, event_type, pairing_token_id
  ) values (
    '00000000-0000-0000-0000-000000000050',
    '00000000-0000-0000-0000-000000000001',
    'connected', '00000000-0000-0000-0000-000000000051'
  );

  insert into audio_file_access_grants (
    id, connection_id, connection_member_one_user_id, connection_member_two_user_id,
    project_id, asset_version_id, grantor_project_access_grant_id,
    grantor_can_manage_access, granted_by_user_id, grantee_user_id, can_download_original
  ) values (
    '00000000-0000-0000-0000-000000000055',
    '00000000-0000-0000-0000-000000000050',
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000020',
    '00000000-0000-0000-0000-000000000040',
    '00000000-0000-0000-0000-000000000025', true,
    '00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000002', true
  );

  insert into audio_creator_deals (
    id, project_id, proposed_by_user_id, deal_type, title,
    terms_document_asset_version_id, terms_sha256, terms_version
  ) values (
    '00000000-0000-0000-0000-000000000060',
    '00000000-0000-0000-0000-000000000020',
    '00000000-0000-0000-0000-000000000001',
    'producer_agreement', 'Producer agreement',
    '00000000-0000-0000-0000-000000000040',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '1'
  );

  insert into audio_creator_deal_parties (
    id, deal_id, user_id, display_name, party_role
  ) values (
    '00000000-0000-0000-0000-000000000061',
    '00000000-0000-0000-0000-000000000060',
    '00000000-0000-0000-0000-000000000002',
    'Producer', 'producer'
  );

  insert into audio_creator_deal_allocations (
    deal_id, party_id, allocation_type, basis_points
  ) values (
    '00000000-0000-0000-0000-000000000060',
    '00000000-0000-0000-0000-000000000061',
    'producer_points', 200
  );

  insert into music_recordings (
    id, performer_id, project_id, title, primary_artist_name, isrc
  ) values (
    '00000000-0000-0000-0000-000000000080',
    '00000000-0000-0000-0000-000000000010',
    '00000000-0000-0000-0000-000000000020',
    'Fixture Track', 'Migration Test', 'USAAA2600001'
  );

  insert into music_releases (
    id, performer_id, project_id, title, primary_artist_name, release_type
  ) values (
    '00000000-0000-0000-0000-000000000081',
    '00000000-0000-0000-0000-000000000010',
    '00000000-0000-0000-0000-000000000020',
    'Fixture Release', 'Migration Test', 'single'
  );

  insert into music_release_recordings (release_id, recording_id, track_number)
  values (
    '00000000-0000-0000-0000-000000000081',
    '00000000-0000-0000-0000-000000000080', 1
  );

  insert into music_rights_declarations (
    id, project_id, release_id, recording_id, declared_by_user_id, declaration_type,
    terms_document_asset_version_id, terms_version, terms_hash, declaration_text,
    declaration_sha256, evidence
  ) values (
    '00000000-0000-0000-0000-000000000082',
    '00000000-0000-0000-0000-000000000020',
    '00000000-0000-0000-0000-000000000081',
    '00000000-0000-0000-0000-000000000080',
    '00000000-0000-0000-0000-000000000001',
    'distribution_authorization',
    '00000000-0000-0000-0000-000000000040', '1',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'Owner authorizes the selected distribution scope.',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    '{"authenticatedSession":true}'::jsonb
  );
`);

await expectDatabaseFailure(
  'Outsiders must not create projects for another performer.',
  `insert into audio_projects (performer_id, created_by_user_id, title)
   values ('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000003', 'Forged')`,
  'Audio projects may be created only'
);

await expectDatabaseFailure(
  'A forged project manager grant must be rejected.',
  `insert into audio_project_access_grants (
     project_id, grantee_user_id, role, can_manage_access, granted_by_user_id
   ) values (
     '00000000-0000-0000-0000-000000000020',
     '00000000-0000-0000-0000-000000000003', 'producer', true,
     '00000000-0000-0000-0000-000000000003'
   )`,
  'Project access grants require active access-management authority'
);

await expectDatabaseFailure(
  'An outsider must not create an asset in another creator project.',
  `insert into audio_assets (project_id, created_by_user_id, title, asset_kind)
   values (
     '00000000-0000-0000-0000-000000000020',
     '00000000-0000-0000-0000-000000000003', 'Forged Asset', 'master_audio'
   )`,
  'Audio asset creation requires active upload authority'
);

await expectDatabaseFailure(
  'An outsider must not initiate an upload in another creator project.',
  `insert into audio_upload_sessions (
     project_id, asset_id, initiated_by_user_id, idempotency_key, storage_provider,
     storage_bucket, provider_upload_id, storage_key, original_filename, expected_mime_type,
     expected_byte_size, expected_sha256, part_size_bytes, expires_at
   ) values (
     '00000000-0000-0000-0000-000000000020',
     '00000000-0000-0000-0000-000000000030',
     '00000000-0000-0000-0000-000000000003', 'forged-upload', 'test', 'private',
     'forged-provider-upload', 'terms/forged', 'forged.pdf', 'application/pdf', 100,
     'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
     5242880, now() + interval '1 day'
   )`,
  'Audio upload sessions require active upload authority'
);

await database.exec(`
  insert into audio_project_invitations (
    id, project_id, target_email_normalized, token_hash, role, permission_snapshot,
    invited_by_user_id, expires_at, created_at
  ) values (
    '00000000-0000-0000-0000-000000000027',
    '00000000-0000-0000-0000-000000000020', 'outsider@example.test',
    'abababababababababababababababababababababababababababababababab',
    'collaborator',
    '{"uploadVersions":true,"downloadOriginals":false,"comment":true,"approve":false,"manageRelease":false,"manageAccess":false}'::jsonb,
    '00000000-0000-0000-0000-000000000001',
    clock_timestamp() - interval '1 hour', clock_timestamp() - interval '2 hours'
  );
`);

await expectDatabaseFailure(
  'An expired project invitation must not be accepted with a backdated client timestamp.',
  `update audio_project_invitations set
     accepted_at = clock_timestamp() - interval '90 minutes',
     accepted_by_user_id = '00000000-0000-0000-0000-000000000003'
   where id = '00000000-0000-0000-0000-000000000027'`,
  'before expiry'
);

await database.exec(`
  insert into audio_file_pairing_tokens (
    id, created_by_user_id, purpose, idempotency_key, token_hash, expires_at, created_at
  ) values (
    '00000000-0000-0000-0000-000000000052',
    '00000000-0000-0000-0000-000000000001', 'send_files', 'expired-pairing',
    'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
    clock_timestamp() - interval '1 hour', clock_timestamp() - interval '2 hours'
  );
`);

await expectDatabaseFailure(
  'An expired file-pairing token must not be claimable with a backdated client timestamp.',
  `update audio_file_pairing_tokens set
     consumed_at = clock_timestamp() - interval '90 minutes',
     consumed_by_user_id = '00000000-0000-0000-0000-000000000002',
     connection_id = '00000000-0000-0000-0000-000000000050',
     connection_member_one_user_id = '00000000-0000-0000-0000-000000000001',
     connection_member_two_user_id = '00000000-0000-0000-0000-000000000002'
   where id = '00000000-0000-0000-0000-000000000052'`,
  'Expired file pairing tokens cannot be consumed'
);

await expectDatabaseFailure(
  'Upload sessions must not skip directly to completed.',
  `insert into audio_upload_sessions (
     project_id, asset_id, initiated_by_user_id, idempotency_key, storage_provider,
     storage_bucket, provider_upload_id, storage_key, original_filename, expected_mime_type,
     expected_byte_size, expected_sha256, part_size_bytes, upload_status, completed_at, expires_at
   ) values (
     '00000000-0000-0000-0000-000000000020',
     '00000000-0000-0000-0000-000000000030',
     '00000000-0000-0000-0000-000000000001', 'skip-completed', 'test', 'private',
     'skip-completed', 'terms/skip', 'terms.pdf', 'application/pdf', 100,
     'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
     5242880, 'completed', now(), now() + interval '1 day'
   )`,
  'must begin in initiated state'
);

await expectDatabaseFailure(
  'A sealed version must match the verified upload storage identity.',
  `insert into audio_project_asset_versions (
     project_id, performer_id, asset_id, uploaded_by_user_id, upload_session_id,
     version_number, original_filename, storage_provider, storage_bucket, storage_key,
     mime_type, byte_size, sha256, integrity_status, integrity_verifier_key,
     integrity_verified_at, integrity_evidence
   ) values (
     '00000000-0000-0000-0000-000000000020',
     '00000000-0000-0000-0000-000000000010',
     '00000000-0000-0000-0000-000000000030',
     '00000000-0000-0000-0000-000000000001',
     '00000000-0000-0000-0000-000000000035', 2, 'terms.pdf',
     'test', 'private', 'terms/tampered', 'application/pdf', 100,
     'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
     'verified', 'migration-contract', clock_timestamp() + interval '1 second',
     '{"checksumVerified":true}'::jsonb
   )`,
  'identity does not match its verified upload session'
);

await database.exec(`
  insert into audio_assets (id, project_id, created_by_user_id, title, asset_kind)
  values (
    '00000000-0000-0000-0000-000000000031',
    '00000000-0000-0000-0000-000000000020',
    '00000000-0000-0000-0000-000000000002', 'Producer Revision', 'mix'
  );

  insert into audio_upload_sessions (
    id, project_id, asset_id, initiated_by_user_id, idempotency_key, storage_provider,
    storage_bucket, provider_upload_id, storage_key, original_filename, expected_mime_type,
    expected_byte_size, expected_sha256, part_size_bytes, expires_at
  ) values (
    '00000000-0000-0000-0000-000000000036',
    '00000000-0000-0000-0000-000000000020',
    '00000000-0000-0000-0000-000000000031',
    '00000000-0000-0000-0000-000000000002',
    'producer-upload', 'test', 'private', 'producer-provider-upload',
    'mix/producer-1', 'producer-mix.wav', 'audio/wav', 200,
    '4444444444444444444444444444444444444444444444444444444444444444',
    5242880, now() + interval '1 day'
  );

  update audio_upload_sessions set upload_status = 'uploading'
  where id = '00000000-0000-0000-0000-000000000036';
  update audio_upload_sessions set upload_status = 'uploaded'
  where id = '00000000-0000-0000-0000-000000000036';
  update audio_upload_sessions set upload_status = 'verifying'
  where id = '00000000-0000-0000-0000-000000000036';
  update audio_upload_sessions set upload_status = 'completed', completed_at = clock_timestamp()
  where id = '00000000-0000-0000-0000-000000000036';
`);

await expectDatabaseFailure(
  'A pairing token must not be replayable after claim.',
  `update audio_file_pairing_tokens set connection_label = 'replay'
   where id = '00000000-0000-0000-0000-000000000051'`,
  'identity is immutable'
);

const declaredEventCount = await database.query(`
  select count(*)::int as count
  from music_rights_declaration_events
  where declaration_id = '00000000-0000-0000-0000-000000000082'
    and event_type = 'declared'
`);
if (declaredEventCount.rows[0]?.count !== 1) {
  throw new Error('A rights declaration must atomically create exactly one declared event.');
}

await expectDatabaseFailure(
  'Rights-review authority must not grant declaration-creation authority.',
  `insert into music_rights_declarations (
     id, project_id, release_id, recording_id, declared_by_user_id, declaration_type,
     terms_document_asset_version_id, terms_version, terms_hash, declaration_text,
     declaration_sha256, evidence
   ) values (
     '00000000-0000-0000-0000-000000000083',
     '00000000-0000-0000-0000-000000000020',
     '00000000-0000-0000-0000-000000000081',
     '00000000-0000-0000-0000-000000000080',
     '00000000-0000-0000-0000-000000000002',
     'master_control',
     '00000000-0000-0000-0000-000000000040', '1',
     'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
     'Reviewer must not create owner declarations.',
     'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
     '{"authenticatedSession":true}'::jsonb
   )`,
  'Rights declarations require active release-management authority'
);

await expectDatabaseFailure(
  'An expired reviewer must not verify a rights declaration.',
  `insert into music_rights_declaration_events (
     declaration_id, actor_user_id, event_type, declaration_sha256, evidence
   ) values (
     '00000000-0000-0000-0000-000000000082',
     '00000000-0000-0000-0000-000000000003', 'verified',
     'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
     '{"reviewed":true}'::jsonb
   )`,
  'require active rights-review authority'
);

await database.exec(`
  insert into music_rights_declaration_events (
    declaration_id, actor_user_id, event_type, declaration_sha256, evidence
  ) values (
    '00000000-0000-0000-0000-000000000082',
    '00000000-0000-0000-0000-000000000002', 'verified',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    '{"reviewed":true}'::jsonb
  );
`);

await expectDatabaseFailure(
  'A verified rights declaration must reject a contradictory review result.',
  `insert into music_rights_declaration_events (
     declaration_id, actor_user_id, event_type, declaration_sha256, evidence
   ) values (
     '00000000-0000-0000-0000-000000000082',
     '00000000-0000-0000-0000-000000000002', 'rejected',
     'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
     '{"reviewed":true}'::jsonb
   )`,
  'terminal review event'
);

const proposedEventCount = await database.query(`
  select count(*)::int as count
  from audio_creator_deal_events
  where deal_id = '00000000-0000-0000-0000-000000000060'
    and event_type = 'proposed'
`);
if (proposedEventCount.rows[0]?.count !== 1) {
  throw new Error('A creator deal must atomically create exactly one proposed event.');
}

for (const eventType of ['withdrawn', 'superseded']) {
  await expectDatabaseFailure(
    `A non-proposer must not append a forged ${eventType} creator-deal event.`,
    `insert into audio_creator_deal_events (
       deal_id, actor_user_id, event_type, terms_sha256
     ) values (
       '00000000-0000-0000-0000-000000000060',
       '00000000-0000-0000-0000-000000000003', '${eventType}',
       'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
     )`,
    'Only the deal proposer may withdraw or supersede'
  );
}

await expectDatabaseFailure(
  'A different account must not accept for the named creator-deal party.',
  `insert into audio_creator_deal_events (
     deal_id, party_id, actor_user_id, event_type, terms_sha256, authentication_evidence
   ) values (
     '00000000-0000-0000-0000-000000000060',
     '00000000-0000-0000-0000-000000000061',
     '00000000-0000-0000-0000-000000000003', 'accepted',
     'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
     '{"authenticatedSession":true}'::jsonb
   )`,
  'must be made by the named account party'
);

await expectDatabaseFailure(
  'Creator-deal acceptance requires non-empty authentication evidence.',
  `insert into audio_creator_deal_events (
     deal_id, party_id, actor_user_id, event_type, terms_sha256, authentication_evidence
   ) values (
     '00000000-0000-0000-0000-000000000060',
     '00000000-0000-0000-0000-000000000061',
     '00000000-0000-0000-0000-000000000002', 'accepted',
     'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
     '{}'::jsonb
   )`,
  'audio_creator_deal_events_authentication_evidence_required'
);

await database.exec(`
  insert into audio_creator_deal_events (
    deal_id, party_id, actor_user_id, event_type, terms_sha256, authentication_evidence
  ) values (
    '00000000-0000-0000-0000-000000000060',
    '00000000-0000-0000-0000-000000000061',
    '00000000-0000-0000-0000-000000000002', 'accepted',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '{"authenticatedSession":true}'::jsonb
  );
`);

await expectDatabaseFailure(
  'Creator-deal structure must seal when invitation or signature activity begins.',
  `insert into audio_creator_deal_parties (
     deal_id, user_id, display_name, party_role
   ) values (
     '00000000-0000-0000-0000-000000000060',
     '00000000-0000-0000-0000-000000000003', 'Late Party', 'collaborator'
   )`,
  'sealed after invitation activity begins'
);

await expectDatabaseFailure(
  'Immutable audio versions must reject mutation.',
  `update audio_project_asset_versions set original_filename = 'changed.pdf'
   where id = '00000000-0000-0000-0000-000000000040'`,
  'immutable'
);

await expectDatabaseFailure(
  'Immutable creator deals must reject mutation.',
  `update audio_creator_deals set title = 'Changed'
   where id = '00000000-0000-0000-0000-000000000060'`,
  'immutable'
);

await database.exec(`
  select set_config('sway.actor_user_id', '00000000-0000-0000-0000-000000000003', false);
`);
await expectDatabaseFailure(
  'An outsider must not create a distribution delivery.',
  `insert into music_distribution_deliveries (
     release_id, provider_key, destination_key
   ) values (
     '00000000-0000-0000-0000-000000000081', 'fixture-provider', 'fixture-store'
   )`,
  'requires active release-management authority'
);

await database.exec(`
  select set_config('sway.actor_user_id', '00000000-0000-0000-0000-000000000001', false);
  insert into music_distribution_deliveries (
    id, release_id, provider_key, destination_key, metadata_fingerprint, metadata
  ) values (
    '00000000-0000-0000-0000-000000000090',
    '00000000-0000-0000-0000-000000000081',
    'fixture-provider', 'fixture-store',
    '9999999999999999999999999999999999999999999999999999999999999999',
    '{"packageVersion":1}'::jsonb
  );

  insert into music_distribution_deliveries (
    id, release_id, provider_key, destination_key
  ) values (
    '00000000-0000-0000-0000-000000000091',
    '00000000-0000-0000-0000-000000000081',
    'fixture-provider', 'second-store'
  );
`);

await setDeliveryTransitionContext(
  'Reject skipped delivery states',
  'delivery-skipped-state',
  '5555555555555555555555555555555555555555555555555555555555555555'
);
await expectDatabaseFailure(
  'Distribution deliveries must reject skipped status edges even with valid context.',
  `update music_distribution_deliveries set delivery_status = 'live'
   where id = '00000000-0000-0000-0000-000000000091'`,
  'Invalid distribution delivery transition'
);

await database.exec(`
  select set_config('sway.actor_user_id', '00000000-0000-0000-0000-000000000003', false);
  select set_config('sway.delivery_transition_reason', 'Forged queue attempt', false);
  select set_config('sway.delivery_transition_idempotency_key', 'delivery-outsider-queued', false);
  select set_config('sway.delivery_transition_payload_sha256', '', false);
`);
await expectDatabaseFailure(
  'An outsider must not perform an otherwise-valid distribution transition.',
  `update music_distribution_deliveries set delivery_status = 'queued'
   where id = '00000000-0000-0000-0000-000000000091'`,
  'require active release-management authority'
);

await setDeliveryTransitionContext('Queue evidence-negative fixture', 'delivery-empty-queued');
await database.exec(`
  update music_distribution_deliveries set delivery_status = 'queued'
  where id = '00000000-0000-0000-0000-000000000091'
`);
await setDeliveryTransitionContext(
  'Reject submission without a package fingerprint',
  'delivery-empty-submitted',
  '6666666666666666666666666666666666666666666666666666666666666666'
);
await expectDatabaseFailure(
  'A distribution delivery must not be submitted without immutable package evidence.',
  `update music_distribution_deliveries set
     delivery_status = 'submitted', provider_release_id = 'provider-release-empty'
   where id = '00000000-0000-0000-0000-000000000091'`,
  'require a provider release ID, metadata fingerprint, and payload fingerprint'
);

const createdDeliveryEventCount = await database.query(`
  select count(*)::int as count
  from music_distribution_delivery_events
  where delivery_id = '00000000-0000-0000-0000-000000000090'
    and event_type = 'delivery_created'
    and next_status = 'draft'
    and payload_sha256 = '9999999999999999999999999999999999999999999999999999999999999999'
`);
if (createdDeliveryEventCount.rows[0]?.count !== 1) {
  throw new Error('A distribution delivery must atomically create one fingerprinted draft event.');
}

await database.exec(`
  select set_config('sway.delivery_transition_reason', '', false);
  select set_config('sway.delivery_transition_idempotency_key', '', false);
  select set_config('sway.delivery_transition_payload_sha256', '', false);
`);
await expectDatabaseFailure(
  'Distribution status must not change without audited transition context.',
  `update music_distribution_deliveries set delivery_status = 'queued'
   where id = '00000000-0000-0000-0000-000000000090'`,
  'require actor, reason, and idempotency context'
);

await setDeliveryTransitionContext(
  'Reject forged lifecycle timestamp',
  'delivery-forged-milestone'
);
await expectDatabaseFailure(
  'A caller must not inject a future delivery milestone during another transition.',
  `update music_distribution_deliveries set
     delivery_status = 'queued', live_at = clock_timestamp() + interval '1 day'
   where id = '00000000-0000-0000-0000-000000000090'`,
  'milestones are assigned only by the transition trigger'
);

await database.exec(`
  select set_config('sway.delivery_transition_in_progress', '00000000-0000-0000-0000-000000000090', false);
`);
await expectDatabaseFailure(
  'A caller must not forge a coupled distribution status event.',
  `insert into music_distribution_delivery_events (
     delivery_id, actor_user_id, event_type, idempotency_key, previous_status, next_status
   ) values (
     '00000000-0000-0000-0000-000000000090',
     '00000000-0000-0000-0000-000000000001', 'status_changed',
     'forged-status-event', 'draft', 'queued'
   )`,
  'only by the coupled delivery trigger'
);
await database.exec(`select set_config('sway.delivery_transition_in_progress', '', false);`);

await database.exec(`
  select set_config('sway.actor_user_id', '00000000-0000-0000-0000-000000000003', false);
`);
await expectDatabaseFailure(
  'An outsider must not append a manual distribution event.',
  `insert into music_distribution_delivery_events (
     delivery_id, actor_user_id, event_type, idempotency_key, payload_sha256
   ) values (
     '00000000-0000-0000-0000-000000000090',
     '00000000-0000-0000-0000-000000000003', 'delivery_attempted',
     'forged-attempt',
     '7777777777777777777777777777777777777777777777777777777777777777'
   )`,
  'require active release-management authority'
);

await setDeliveryTransitionContext('Queue replacement release', 'delivery-queued');
await database.exec(`
  update music_distribution_deliveries set delivery_status = 'queued'
  where id = '00000000-0000-0000-0000-000000000090'
`);

await setDeliveryTransitionContext(
  'Duplicate transition attempt',
  'delivery-queued',
  '1111111111111111111111111111111111111111111111111111111111111111'
);
await expectDatabaseFailure(
  'Distribution transition idempotency keys must not be reusable.',
  `update music_distribution_deliveries set
     delivery_status = 'submitted', provider_release_id = 'provider-release-1'
   where id = '00000000-0000-0000-0000-000000000090'`,
  'duplicate key'
);

await setDeliveryTransitionContext(
  'Submit replacement release',
  'delivery-submitted',
  '1111111111111111111111111111111111111111111111111111111111111111'
);
await database.exec(`
  update music_distribution_deliveries set
    delivery_status = 'submitted', provider_release_id = 'provider-release-1'
  where id = '00000000-0000-0000-0000-000000000090'
`);

await setDeliveryTransitionContext(
  'Reject acceptance without matching provider callback',
  'delivery-accepted-without-callback',
  '8888888888888888888888888888888888888888888888888888888888888888'
);
await expectDatabaseFailure(
  'Delivery acceptance must fail when no provider callback matches the transition payload.',
  `update music_distribution_deliveries set
     delivery_status = 'accepted', destination_release_id = 'destination-release-1'
   where id = '00000000-0000-0000-0000-000000000090'`,
  'require immutable provider callback evidence for the exact payload fingerprint'
);

await setDeliveryTransitionContext(
  'Provider accepted replacement release',
  'delivery-accepted',
  '2222222222222222222222222222222222222222222222222222222222222222'
);
await recordProviderWebhook(
  'webhook-accepted',
  'provider-event-accepted',
  '2222222222222222222222222222222222222222222222222222222222222222'
);
await database.exec(`
  update music_distribution_deliveries set
    delivery_status = 'accepted', destination_release_id = 'destination-release-1'
  where id = '00000000-0000-0000-0000-000000000090'
`);

await recordProviderWebhook(
  'webhook-live',
  'provider-event-live',
  '3333333333333333333333333333333333333333333333333333333333333333'
);
await setDeliveryTransitionContext(
  'Replacement release is live',
  'delivery-live',
  '3333333333333333333333333333333333333333333333333333333333333333'
);
await database.exec(`
  update music_distribution_deliveries set delivery_status = 'live'
  where id = '00000000-0000-0000-0000-000000000090'
`);

const liveDelivery = await database.query(`
  select delivery_status, submitted_at is not null as submitted,
    accepted_at is not null as accepted, live_at is not null as live
  from music_distribution_deliveries
  where id = '00000000-0000-0000-0000-000000000090'
`);
const liveDeliveryRow = liveDelivery.rows[0];
if (liveDeliveryRow?.delivery_status !== 'live'
  || liveDeliveryRow?.submitted !== true
  || liveDeliveryRow?.accepted !== true
  || liveDeliveryRow?.live !== true) {
  throw new Error('Audited distribution transitions must server-assign their lifecycle milestones.');
}

const deliveryStatusEventCount = await database.query(`
  select count(*)::int as count
  from music_distribution_delivery_events
  where delivery_id = '00000000-0000-0000-0000-000000000090'
    and event_type = 'status_changed'
`);
if (deliveryStatusEventCount.rows[0]?.count !== 4) {
  throw new Error('Every successful distribution status transition must append exactly one event.');
}

await expectDatabaseFailure(
  'Delivery evidence must not change outside a status transition.',
  `update music_distribution_deliveries set destination_release_id = 'rewritten'
   where id = '00000000-0000-0000-0000-000000000090'`,
  'evidence may change only with an audited status transition'
);

await expectDatabaseFailure(
  'Provider webhook events must not be forged without verified service context.',
  `insert into music_distribution_delivery_events (
     delivery_id, event_type, idempotency_key, provider_event_id, payload_sha256
   ) values (
     '00000000-0000-0000-0000-000000000090', 'provider_webhook',
     'forged-webhook', 'provider-event-forged',
     '3333333333333333333333333333333333333333333333333333333333333333'
   )`,
  'require verified provider service context'
);

await expectDatabaseFailure(
  'Distribution delivery events must remain append-only.',
  `update music_distribution_delivery_events set metadata = '{"rewritten":true}'::jsonb
   where delivery_id = '00000000-0000-0000-0000-000000000090'
     and event_type = 'delivery_created'`,
  'immutable'
);

await expectDatabaseFailure(
  'Catalog transfers must not bypass the state machine on insert.',
  `insert into music_catalog_transfers (
     performer_id, created_by_user_id, source_distributor, status
   ) values (
     '00000000-0000-0000-0000-000000000010',
     '00000000-0000-0000-0000-000000000001', 'fixture-provider', 'complete'
   )`,
  'must begin in a clean intake state'
);

await database.exec(`
  insert into performers (id, owner_user_id, display_name)
  values ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000003', 'Other Artist');

  insert into music_releases (
    id, performer_id, title, primary_artist_name, release_type
  ) values (
    '00000000-0000-0000-0000-000000000083',
    '00000000-0000-0000-0000-000000000011',
    'Other Release', 'Other Artist', 'single'
  );

  insert into music_catalog_transfers (
    id, performer_id, created_by_user_id, source_distributor,
    expected_release_count, expected_recording_count
  ) values (
    '00000000-0000-0000-0000-000000000070',
    '00000000-0000-0000-0000-000000000010',
    '00000000-0000-0000-0000-000000000001',
    'fixture-provider', 1, 1
  );
`);

await expectDatabaseFailure(
  'Catalog transfer items must not reference another performer release.',
  `insert into music_catalog_transfer_items (
     transfer_id, release_id, source_release_id, source_metadata_snapshot,
     artist_identity_map, audio_manifest
   ) values (
     '00000000-0000-0000-0000-000000000070',
     '00000000-0000-0000-0000-000000000083', 'foreign-release',
     '{}'::jsonb, '{}'::jsonb, '{}'::jsonb
   )`,
  'must belong to the transfer performer'
);

await expectDatabaseFailure(
  'Catalog source-account identity must not be silently rewritten.',
  `update music_catalog_transfers set source_account_reference = 'forged-source-account'
   where id = '00000000-0000-0000-0000-000000000070'`,
  'source identity are immutable'
);

await database.exec(`
  insert into music_catalog_transfer_items (
    id, transfer_id, release_id, source_release_id, source_metadata_snapshot,
    artist_identity_map, audio_manifest, store_continuity_report,
    parity_status, store_match_status, overlap_verified_at
  ) values (
    '00000000-0000-0000-0000-000000000071',
    '00000000-0000-0000-0000-000000000070',
    '00000000-0000-0000-0000-000000000081', 'source-release',
    '{"title":"Fixture Release"}'::jsonb, '{"mapped":true}'::jsonb,
    '{"recordings":1}'::jsonb, '{"matched":true}'::jsonb,
    'matched', 'matched', now()
  );

  insert into music_catalog_transfer_recordings (
    id, transfer_item_id, recording_id, source_recording_id, existing_isrc,
    source_master_sha256, source_audio_identity, source_metadata_snapshot,
    source_store_identifiers, continuity_report, parity_status,
    store_match_status, overlap_verified_at
  ) values (
    '00000000-0000-0000-0000-000000000072',
    '00000000-0000-0000-0000-000000000071',
    '00000000-0000-0000-0000-000000000080', 'source-recording', 'USAAA2600001',
    'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    '{"sha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}'::jsonb,
    '{"title":"Fixture Track"}'::jsonb, '{"spotify":"fixture"}'::jsonb,
    '{"matched":true}'::jsonb, 'matched', 'matched', now()
  );
`);

await expectDatabaseFailure(
  'Catalog status changes require an actor and reason.',
  `update music_catalog_transfers set status = 'source_snapshot'
   where id = '00000000-0000-0000-0000-000000000070'`,
  'require sway.actor_user_id and sway.transition_reason'
);

await setTransitionContext('Reject skipped states');
await expectDatabaseFailure(
  'Catalog transitions must reject skipped states.',
  `update music_catalog_transfers set status = 'complete'
   where id = '00000000-0000-0000-0000-000000000070'`,
  'Invalid catalog transfer transition'
);

for (const [nextStatus, reason] of [
  ['source_snapshot', 'Source snapshot captured'],
  ['rights_review', 'Rights review started'],
  ['artist_identity_mapped', 'Artist identity mapped'],
  ['parity_locked', 'Frozen parity confirmed'],
  ['new_delivery_staged', 'Replacement delivery staged'],
  ['store_processing', 'Stores processing replacement'],
  ['overlap_live', 'Verified live overlap']
]) {
  await setTransitionContext(reason);
  await database.exec(`
    update music_catalog_transfers set status = '${nextStatus}'
    where id = '00000000-0000-0000-0000-000000000070'
  `);
}

await setTransitionContext('Store continuity matched');
await database.exec(`
  update music_catalog_transfers set
    status = 'store_match_verified',
    continuity_evidence_fingerprint = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
  where id = '00000000-0000-0000-0000-000000000070'
`);

await expectDatabaseFailure(
  'Catalog evidence must be immutable after store matching.',
  `update music_catalog_transfer_items set source_metadata_snapshot = '{"changed":true}'::jsonb
   where id = '00000000-0000-0000-0000-000000000071'`,
  'sealed after store matching'
);

await setTransitionContext('Artist approved disclosed continuity', {
  artistCutoverApprovalFingerprint: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  knownLimitationsDisclosed: true
});
await database.exec(`
  update music_catalog_transfers set
    status = 'artist_cutover_approved',
    artist_cutover_approved_by_user_id = '00000000-0000-0000-0000-000000000001',
    artist_cutover_approved_at = now(),
    artist_cutover_approval_fingerprint = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
  where id = '00000000-0000-0000-0000-000000000070'
`);

await setTransitionContext('Artist requested old-provider takedown', {
  artistCutoverApprovalFingerprint: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  unresolvedHoldCount: 0
});
await expectDatabaseFailure(
  'Old-provider takedown must remain disabled until immutable provider evidence is bound.',
  `update music_catalog_transfers set
     status = 'old_provider_takedown', old_provider_takedown_requested_at = now()
   where id = '00000000-0000-0000-0000-000000000070'`,
  'Catalog cutover execution is disabled'
);

await setTransitionContext('Content identity conflict found');
await database.exec(`
  update music_catalog_transfers set status = 'content_id_conflict'
  where id = '00000000-0000-0000-0000-000000000070'
`);

await setTransitionContext('Attempt post-cutover hold bypass', {
  resolvedHoldState: 'content_id_conflict',
  holdResolutionEvidenceFingerprint: '1212121212121212121212121212121212121212121212121212121212121212'
});
await expectDatabaseFailure(
  'A hold-recovery edge must not bypass disabled catalog cutover.',
  `update music_catalog_transfers set status = 'cutover_monitoring'
   where id = '00000000-0000-0000-0000-000000000070'`,
  'Catalog cutover execution is disabled'
);

await database.exec(`
  insert into music_catalog_transfers (
    id, performer_id, created_by_user_id, source_distributor
  ) values (
    '00000000-0000-0000-0000-000000000073',
    '00000000-0000-0000-0000-000000000010',
    '00000000-0000-0000-0000-000000000001', 'fixture-provider'
  );
`);

for (const [nextStatus, reason] of [
  ['source_snapshot', 'Source snapshot captured'],
  ['rights_review', 'Rights review started'],
  ['rights_blocked', 'Rights conflict found']
]) {
  await setTransitionContext(reason);
  await database.exec(`
    update music_catalog_transfers set status = '${nextStatus}'
    where id = '00000000-0000-0000-0000-000000000073'
  `);
}

await setTransitionContext('Attempt hold recovery without evidence');
await expectDatabaseFailure(
  'Catalog holds must not resume without fingerprinted resolution evidence.',
  `update music_catalog_transfers set status = 'rights_review'
   where id = '00000000-0000-0000-0000-000000000073'`,
  'requires a matching state and SHA-256 evidence fingerprint'
);

await setTransitionContext('Rights hold resolved', {
  resolvedHoldState: 'rights_blocked',
  holdResolutionEvidenceFingerprint: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
});
await database.exec(`
  update music_catalog_transfers set status = 'rights_review'
  where id = '00000000-0000-0000-0000-000000000073'
`);

await database.exec(`
  insert into music_catalog_transfers (
    id, performer_id, created_by_user_id, source_distributor,
    expected_release_count, expected_recording_count
  ) values (
    '00000000-0000-0000-0000-000000000074',
    '00000000-0000-0000-0000-000000000010',
    '00000000-0000-0000-0000-000000000001', 'fixture-provider', 1, 1
  );
`);

for (const [nextStatus, reason] of [
  ['source_snapshot', 'Empty source snapshot captured'],
  ['rights_review', 'Empty fixture rights review started'],
  ['artist_identity_mapped', 'Empty fixture artist identity mapped'],
  ['parity_locked', 'Empty fixture parity stage reached'],
  ['new_delivery_staged', 'Empty fixture replacement staged'],
  ['store_processing', 'Empty fixture store processing'],
  ['overlap_live', 'Empty fixture overlap claimed']
]) {
  await setTransitionContext(reason);
  await database.exec(`
    update music_catalog_transfers set status = '${nextStatus}'
    where id = '00000000-0000-0000-0000-000000000074'
  `);
}

await setTransitionContext('Reject empty continuity manifest');
await expectDatabaseFailure(
  'Store-match verification must reject an empty expected catalog manifest.',
  `update music_catalog_transfers set
     status = 'store_match_verified',
     continuity_evidence_fingerprint = '3434343434343434343434343434343434343434343434343434343434343434'
   where id = '00000000-0000-0000-0000-000000000074'`,
  'requires complete, non-empty release and recording manifests'
);

await database.exec(`
  update audio_project_access_grants set
    revoked_at = now(), revoked_by_user_id = '00000000-0000-0000-0000-000000000001'
  where id = '00000000-0000-0000-0000-000000000026';
`);

await expectDatabaseFailure(
  'A revoked uploader must not seal a completed upload into an immutable version.',
  `insert into audio_project_asset_versions (
     project_id, performer_id, asset_id, uploaded_by_user_id, upload_session_id,
     version_number, original_filename, storage_provider, storage_bucket, storage_key,
     mime_type, byte_size, sha256, integrity_status, integrity_verifier_key,
     integrity_verified_at, integrity_evidence
   ) values (
     '00000000-0000-0000-0000-000000000020',
     '00000000-0000-0000-0000-000000000010',
     '00000000-0000-0000-0000-000000000031',
     '00000000-0000-0000-0000-000000000002',
     '00000000-0000-0000-0000-000000000036', 1, 'producer-mix.wav',
     'test', 'private', 'mix/producer-1', 'audio/wav', 200,
     '4444444444444444444444444444444444444444444444444444444444444444',
     'verified', 'migration-contract', clock_timestamp() + interval '1 second',
     '{"checksumVerified":true}'::jsonb
   )`,
  'requires active upload authority'
);

await expectDatabaseFailure(
  'A revoked project manager must not grant selected-file access.',
  `insert into audio_file_access_grants (
     connection_id, connection_member_one_user_id, connection_member_two_user_id,
     project_id, asset_version_id, grantor_project_access_grant_id,
     grantor_can_manage_access, granted_by_user_id, grantee_user_id
   ) values (
     '00000000-0000-0000-0000-000000000050',
     '00000000-0000-0000-0000-000000000001',
     '00000000-0000-0000-0000-000000000002',
     '00000000-0000-0000-0000-000000000020',
     '00000000-0000-0000-0000-000000000040',
     '00000000-0000-0000-0000-000000000026', true,
     '00000000-0000-0000-0000-000000000002',
     '00000000-0000-0000-0000-000000000001'
   )`,
  'requires active project access-management authority'
);

await database.exec(`
  update audio_file_access_grants set
    revoked_at = now(), revoked_by_user_id = '00000000-0000-0000-0000-000000000002'
  where id = '00000000-0000-0000-0000-000000000055';
`);

await expectDatabaseFailure(
  'Revoked selected-file access grants must not be restorable.',
  `update audio_file_access_grants set revoked_at = null, revoked_by_user_id = null
   where id = '00000000-0000-0000-0000-000000000055'`,
  'cannot be restored or changed'
);

await database.exec(`
  update audio_file_connections set
    revoked_at = now(), revoked_by_user_id = '00000000-0000-0000-0000-000000000001'
  where id = '00000000-0000-0000-0000-000000000050';
`);

await expectDatabaseFailure(
  'A revoked file connection must not authorize a new selected-file grant.',
  `insert into audio_file_access_grants (
     connection_id, connection_member_one_user_id, connection_member_two_user_id,
     project_id, asset_version_id, grantor_project_access_grant_id,
     grantor_can_manage_access, granted_by_user_id, grantee_user_id
   ) values (
     '00000000-0000-0000-0000-000000000050',
     '00000000-0000-0000-0000-000000000001',
     '00000000-0000-0000-0000-000000000002',
     '00000000-0000-0000-0000-000000000020',
     '00000000-0000-0000-0000-000000000040',
     '00000000-0000-0000-0000-000000000025', true,
     '00000000-0000-0000-0000-000000000001',
     '00000000-0000-0000-0000-000000000002'
   )`,
  'requires an active file connection'
);

await database.close();
console.log(`Applied ${migrationFiles.length} migrations and verified audio-publishing database invariants.`);
}

main().catch(async (error) => {
  console.error('Audio publishing migration contract failed:');
  console.error(error);
  await database.close().catch(() => undefined);
  process.exit(1);
});
