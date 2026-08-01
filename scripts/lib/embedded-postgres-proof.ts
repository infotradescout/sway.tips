import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { Client } from 'pg';
import { assertDisposableDatabaseTarget } from './disposable-database-guard.mjs';

function migrationStatements(filename: string) {
  return readFileSync(filename, 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export async function startEmbeddedPostgresProof(label: string) {
  const realDatabaseUrl = process.env.SWAY_REAL_POSTGRES_PROOF_DATABASE_URL?.trim();
  if (process.env.SWAY_REQUIRE_REAL_POSTGRES_PROOF === 'true' && !realDatabaseUrl) {
    throw new Error('SWAY_REAL_POSTGRES_PROOF_DATABASE_URL is required for the strict real-PostgreSQL proof.');
  }

  if (realDatabaseUrl) {
    assertDisposableDatabaseTarget({
      databaseUrl: realDatabaseUrl,
      label: `${label} real PostgreSQL proof`,
      stripeSecretKey: undefined
    });
    const admin = new Client({ connectionString: realDatabaseUrl });
    await admin.connect();
    try {
      const attestation = await admin.query<{
        version: string;
        backend_pid: number;
        server_port: number | null;
        postmaster_started_at: Date | null;
      }>(`
        select version() as version,
               pg_backend_pid() as backend_pid,
               inet_server_port() as server_port,
               pg_postmaster_start_time() as postmaster_started_at
      `);
      const identity = attestation.rows[0];
      if (
        !identity
        || !/^PostgreSQL\b/i.test(identity.version)
        || /pglite|electric|wasm/i.test(identity.version)
        || !Number.isInteger(identity.backend_pid)
        || identity.backend_pid <= 0
        || !Number.isInteger(identity.server_port)
        || !identity.postmaster_started_at
      ) {
        throw new Error('Strict concurrency proof requires an attested standalone PostgreSQL server, not an embedded protocol facade.');
      }
      const independentClient = new Client({ connectionString: realDatabaseUrl });
      await independentClient.connect();
      try {
        const secondBackend = await independentClient.query<{ backend_pid: number }>('select pg_backend_pid() as backend_pid');
        if (secondBackend.rows[0]?.backend_pid === identity.backend_pid) {
          throw new Error('Strict concurrency proof requires two independent PostgreSQL backend connections.');
        }
      } finally {
        await independentClient.end();
      }

      await admin.query('drop schema if exists public cascade');
      await admin.query('create schema public');
      const migrationDirectory = join(process.cwd(), 'drizzle');
      const migrationFiles = readdirSync(migrationDirectory)
        .filter((name) => /^\d{4}_.+\.sql$/.test(name))
        .sort();
      for (const filename of migrationFiles) {
        for (const [index, statement] of migrationStatements(join(migrationDirectory, filename)).entries()) {
          try {
            await admin.query(statement);
          } catch (error) {
            throw new Error(`Real PostgreSQL proof failed to apply ${filename}, statement ${index + 1}.`, { cause: error });
          }
        }
      }
    } finally {
      await admin.end();
    }

    async function query<T extends Record<string, unknown> = Record<string, unknown>>(text: string, values: unknown[] = []) {
      const client = new Client({ connectionString: realDatabaseUrl });
      await client.connect();
      try {
        return await client.query<T>(text, values);
      } finally {
        await client.end();
      }
    }

    return {
      kind: 'real-postgres' as const,
      database: null,
      socket: null,
      databaseUrl: realDatabaseUrl,
      query,
      async close() {
        const { closeDisposableSwayDbProof } = await import('../../src/db/client');
        await closeDisposableSwayDbProof(realDatabaseUrl);
      }
    };
  }

  const database = new PGlite();
  const migrationDirectory = join(process.cwd(), 'drizzle');
  const migrationFiles = readdirSync(migrationDirectory)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();

  if (!migrationFiles.length) throw new Error('No Drizzle migrations were found.');
  for (const filename of migrationFiles) {
    for (const [index, statement] of migrationStatements(join(migrationDirectory, filename)).entries()) {
      try {
        await database.exec(statement);
      } catch (error) {
        throw new Error(`Embedded PostgreSQL proof failed to apply ${filename}, statement ${index + 1}.`, {
          cause: error
        });
      }
    }
  }

  const socket = new PGLiteSocketServer({
    db: database,
    host: '127.0.0.1',
    port: 0,
    maxConnections: 64
  });
  await socket.start();
  const safeLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'proof';
  const databaseUrl = `postgresql://postgres:postgres@${socket.getServerConn()}/sway_embedded_disposable_test_${safeLabel}`;

  async function query<T extends Record<string, unknown> = Record<string, unknown>>(text: string, values: unknown[] = []) {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      return await client.query<T>(text, values);
    } finally {
      await client.end();
    }
  }

  return {
    kind: 'embedded-postgres' as const,
    database,
    socket,
    databaseUrl,
    query,
    async close() {
      const { closeDisposableSwayDbProof } = await import('../../src/db/client');
      await closeDisposableSwayDbProof(databaseUrl);
      await socket.stop();
      await database.close();
    }
  };
}
