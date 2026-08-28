import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const migrationDirectory = join(process.cwd(), 'drizzle');
const migrationFiles = readdirSync(migrationDirectory)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();

async function applyMigration(database: PGlite, migrationFile: string) {
  const statements = readFileSync(join(migrationDirectory, migrationFile), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const [index, statement] of statements.entries()) {
    try {
      await database.exec(statement);
    } catch (error) {
      throw new Error(`${migrationFile} statement ${index + 1} failed`, { cause: error });
    }
  }
}

const database = new PGlite();

try {
  const attendanceMigration = migrationFiles.find((name) => name.startsWith('0038_'));
  assert.ok(attendanceMigration, '0038 attendance migration must exist.');
  const attendanceCompatibilityMigration = migrationFiles.find((name) => (
    name.startsWith('0039_')
    && readFileSync(join(migrationDirectory, name), 'utf8').includes(
      'CREATE OR REPLACE FUNCTION "sway_sync_legacy_performer_event_attendance_mode"'
    )
  ));
  assert.ok(attendanceCompatibilityMigration, '0039 attendance compatibility follow-up migration must exist.');
  for (const migrationFile of migrationFiles.filter((name) => name < attendanceMigration)) {
    await applyMigration(database, migrationFile);
  }

  await database.exec(`
    insert into users (id, email, role) values
      ('10000000-0000-4000-8000-000000000001', 'attendance-migration@example.test', 'performer');
    insert into performers (
      id, owner_user_id, display_name, handle, bio, is_active, visibility_state, onboarding_status
    ) values (
      '20000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      'Attendance Migration Artist',
      'attendance-migration-artist',
      'A resolvable performer profile.',
      true,
      'public',
      'gig_ready'
    );

    insert into performer_events (
      id, performer_id, client_request_id, created_by_actor_user_id, last_mutation_actor_user_id,
      title, starts_at, time_zone, ticketing_mode, external_ticket_url, external_ticket_label
    ) values
      (
        '30000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000001',
        '40000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000001',
        'Legacy external draft', '2035-01-01T20:00:00Z', 'UTC', 'external', null, null
      ),
      (
        '30000000-0000-4000-8000-000000000002',
        '20000000-0000-4000-8000-000000000001',
        '40000000-0000-4000-8000-000000000002',
        '10000000-0000-4000-8000-000000000001',
        '10000000-0000-4000-8000-000000000001',
        'Legacy RSVP draft', '2035-01-02T20:00:00Z', 'UTC', 'external',
        'https://rsvp.example.test/show', 'RSVP'
      );

    insert into performer_events (
      id, performer_id, client_request_id, created_by_actor_user_id, last_mutation_actor_user_id,
      title, starts_at, door_opens_at, ends_at, time_zone, ticketing_mode
    ) values (
      '30000000-0000-4000-8000-000000000003',
      '20000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      'Legacy native draft', '2035-01-03T20:00:00Z', '2035-01-03T19:00:00Z',
      '2035-01-03T23:00:00Z', 'UTC', 'native_ga'
    );
  `);

  await applyMigration(database, attendanceMigration);

  const backfilled = await database.query<{ title: string; attendance_mode: string }>(`
    select title, attendance_mode::text as attendance_mode
    from performer_events
    order by title
  `);
  assert.deepEqual(Object.fromEntries(backfilled.rows.map((row) => [row.title, row.attendance_mode])), {
    'Legacy external draft': 'external_ticket',
    'Legacy native draft': 'native_ticket',
    'Legacy RSVP draft': 'external_rsvp'
  });

  const column = await database.query<{ column_default: string | null; is_nullable: string }>(`
    select column_default, is_nullable
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'performer_events'
      and column_name = 'attendance_mode'
  `);
  assert.equal(column.rows[0]?.column_default, null);
  assert.equal(column.rows[0]?.is_nullable, 'NO');

  // This insert deliberately omits attendance_mode to model the old writer
  // during a rolling deployment. The trigger derives intent before NOT NULL.
  await database.exec(`
    insert into performer_events (
      id, performer_id, client_request_id, created_by_actor_user_id, last_mutation_actor_user_id,
      title, starts_at, time_zone, ticketing_mode, external_ticket_url, external_ticket_label
    ) values (
      '30000000-0000-4000-8000-000000000004',
      '20000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000004',
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      'Rolling RSVP writer', '2035-01-04T20:00:00Z', 'UTC', 'external',
      'https://rsvp.example.test/rolling', 'RSVP'
    );
  `);
  const rolling = await database.query<{ attendance_mode: string }>(`
    select attendance_mode::text as attendance_mode
    from performer_events
    where id = '30000000-0000-4000-8000-000000000004'
  `);
  assert.equal(rolling.rows[0]?.attendance_mode, 'external_rsvp');

  await database.exec(`
    insert into performer_events (
      id, performer_id, client_request_id, created_by_actor_user_id, last_mutation_actor_user_id,
      title, starts_at, time_zone, ticketing_mode
    ) values (
      '30000000-0000-4000-8000-000000000007',
      '20000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000007',
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      'Rolling plain external writer', '2035-01-07T20:00:00Z', 'UTC', 'external'
    );

    insert into performer_events (
      id, performer_id, client_request_id, created_by_actor_user_id, last_mutation_actor_user_id,
      title, starts_at, door_opens_at, ends_at, time_zone, ticketing_mode
    ) values (
      '30000000-0000-4000-8000-000000000008',
      '20000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000008',
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      'Rolling native writer', '2035-01-08T20:00:00Z', '2035-01-08T19:00:00Z',
      '2035-01-08T23:00:00Z', 'UTC', 'native_ga'
    );
  `);
  const rollingModes = await database.query<{ title: string; attendance_mode: string }>(`
    select title, attendance_mode::text as attendance_mode
    from performer_events
    where id in (
      '30000000-0000-4000-8000-000000000007',
      '30000000-0000-4000-8000-000000000008'
    )
    order by title
  `);
  assert.deepEqual(Object.fromEntries(rollingModes.rows.map((row) => [row.title, row.attendance_mode])), {
    'Rolling native writer': 'native_ticket',
    'Rolling plain external writer': 'external_ticket'
  });

  // 0038 is already committed and may have been applied independently. The
  // follow-up must upgrade that exact state without rewriting migration
  // history, while preserving the original rolling-writer behavior above.
  await applyMigration(database, attendanceCompatibilityMigration);

  await database.exec(`
    update performer_events
    set external_ticket_url = 'https://rsvp.example.test/converted', external_ticket_label = 'RSVP'
    where id = '30000000-0000-4000-8000-000000000001';

    insert into performer_events (
      id, performer_id, client_request_id, created_by_actor_user_id, last_mutation_actor_user_id,
      title, starts_at, time_zone, attendance_mode, location_name, city, visibility,
      status, published_at
    ) values (
      '30000000-0000-4000-8000-000000000005',
      '20000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000005',
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      'Explicit walk-in', '2035-01-05T20:00:00Z', 'UTC', 'walk_in',
      'Neighborhood Stage', 'Chicago', 'public', 'published', now()
    );
  `);
  const converted = await database.query<{ attendance_mode: string }>(`
    select attendance_mode::text as attendance_mode
    from performer_events
    where id = '30000000-0000-4000-8000-000000000001'
  `);
  assert.equal(converted.rows[0]?.attendance_mode, 'external_rsvp');

  await database.exec(`
    update performer_events
    set external_ticket_url = null, external_ticket_label = null
    where id = '30000000-0000-4000-8000-000000000001'
  `);
  const removedLink = await database.query<{ attendance_mode: string }>(`
    select attendance_mode::text as attendance_mode
    from performer_events
    where id = '30000000-0000-4000-8000-000000000001'
  `);
  assert.equal(
    removedLink.rows[0]?.attendance_mode,
    'external_rsvp',
    'Clearing a draft RSVP link must preserve the still-valid explicit RSVP mode.'
  );

  await database.exec(`
    update performer_events
    set external_ticket_url = 'https://tickets.example.test/relabeled',
        external_ticket_label = 'Get tickets'
    where id = '30000000-0000-4000-8000-000000000001';
    update performer_events
    set external_ticket_label = 'RSVP'
    where id = '30000000-0000-4000-8000-000000000001'
  `);
  const relabeled = await database.query<{ attendance_mode: string }>(`
    select attendance_mode::text as attendance_mode
    from performer_events
    where id = '30000000-0000-4000-8000-000000000001'
  `);
  assert.equal(relabeled.rows[0]?.attendance_mode, 'external_rsvp');

  await assert.rejects(() => database.exec(`
    update performer_events
    set location_name = null, city = null
    where id = '30000000-0000-4000-8000-000000000005'
  `));
  await assert.rejects(() => database.exec(`
    insert into performer_events (
      id, performer_id, client_request_id, created_by_actor_user_id, last_mutation_actor_user_id,
      title, starts_at, time_zone, attendance_mode, location_name, city,
      external_ticket_url, external_ticket_label
    ) values (
      '30000000-0000-4000-8000-000000000006',
      '20000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000006',
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      'Invalid linked walk-in', '2035-01-06T20:00:00Z', 'UTC', 'walk_in',
      'Neighborhood Stage', 'Chicago',
      'https://tickets.example.test/not-walk-in', 'Get tickets'
    )
  `));
  await assert.rejects(() => database.exec(`
    insert into performer_events (
      id, performer_id, client_request_id, created_by_actor_user_id, last_mutation_actor_user_id,
      title, starts_at, time_zone, attendance_mode, location_name, city,
      visibility, status, published_at
    ) values (
      '30000000-0000-4000-8000-000000000009',
      '20000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000009',
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      'Whitespace walk-in', '2035-01-09T20:00:00Z', 'UTC', 'walk_in',
      '   ', '   ', 'public', 'published', now()
    )
  `));

  // This is the complete 0037 event write shape after 0038 has landed. It
  // proves rolling code rollback can continue writing without knowing the new
  // column; the compatibility trigger supplies the unambiguous legacy mode.
  await database.exec(`
    insert into performer_events (
      id, performer_id, client_request_id, created_by_actor_user_id, last_mutation_actor_user_id,
      title, description, starts_at, door_opens_at, ends_at, time_zone,
      location_name, location_address, city, location_is_tba, cover_image_url,
      ticketing_mode, external_ticket_url, external_ticket_label, visibility, status,
      published_at, cancelled_at, cancellation_reason, created_at, updated_at
    ) values (
      '30000000-0000-4000-8000-000000000010',
      '20000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000010',
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      'Rollback 0037 writer', null, '2035-01-10T20:00:00Z', null, null, 'UTC',
      null, null, null, false, null, 'external', null, null, 'unlisted', 'draft',
      null, null, null, now(), now()
    )
  `);
  const rollbackWriter = await database.query<{ attendance_mode: string }>(`
    select attendance_mode::text as attendance_mode
    from performer_events
    where id = '30000000-0000-4000-8000-000000000010'
  `);
  assert.equal(rollbackWriter.rows[0]?.attendance_mode, 'external_ticket');

  console.log('Performer event attendance migration integration test passed.');
} finally {
  await database.close();
}
