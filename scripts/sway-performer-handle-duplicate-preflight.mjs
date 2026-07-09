import { Client } from 'pg';

function requireDatabaseUrl() {
  const value = process.env.DATABASE_URL;
  if (!value || !value.trim()) {
    throw new Error('DATABASE_URL is required for performer handle duplicate preflight.');
  }
  return value.trim();
}

async function run() {
  const databaseUrl = requireDatabaseUrl();
  const client = new Client({ connectionString: databaseUrl });

  await client.connect();

  try {
    const result = await client.query(
      `SELECT lower(handle) AS normalized_handle,
              COUNT(*)::int AS duplicate_count,
              string_agg(handle, ', ' ORDER BY handle) AS conflicting_handles
       FROM performers
       WHERE handle IS NOT NULL
       GROUP BY lower(handle)
       HAVING COUNT(*) > 1
       ORDER BY duplicate_count DESC, normalized_handle ASC;`
    );

    if (result.rowCount && result.rowCount > 0) {
      console.error('Performer handle duplicate preflight failed. Resolve these rows before applying migration 0013:');
      console.table(result.rows);
      process.exitCode = 1;
      return;
    }

    console.log('Performer handle duplicate preflight passed. No case-insensitive collisions found.');
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});