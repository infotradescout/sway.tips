import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool, type PoolClient, type PoolConfig } from 'pg';

export const RELEASE_HEALTH_TIMEOUTS = {
  connectionTimeoutMillis: 1_000,
  statementTimeoutMs: 1_500,
  queryTimeoutMs: 2_000,
  idleTimeoutMillis: 1_000,
  handlerDeadlineMs: 3_000,
  poolMax: 1
} as const;

export type BuildMarkerIdentity = {
  service: string;
  commit: string;
  branch: string;
  buildTimestamp: string;
  nodeEnv: string;
};

export type MigrationCompatibilityStatus =
  | 'compatible'
  | 'pending'
  | 'drift'
  | 'unconfigured'
  | 'unavailable'
  | 'unknown';

export type ReleaseHealthStatus = 'ok' | 'degraded' | 'unavailable';

export type ReleaseHealthReport = {
  ok: boolean;
  service: string;
  status: ReleaseHealthStatus;
  commit: string;
  branch: string;
  buildTimestamp: string;
  nodeEnv: string;
  database: {
    configured: boolean;
    reachable: boolean;
  };
  migrations: {
    status: MigrationCompatibilityStatus;
    compatible: boolean;
    expectedCount: number;
    appliedCount: number;
    missingCount: number;
    driftedCount: number;
    latestExpectedTag: string | null;
  };
  releaseActive: boolean;
};

export type ExpectedMigration = {
  tag: string;
  hash: string;
};

type JournalFile = {
  entries?: Array<{ tag?: unknown }>;
};

export type ReleaseDatabaseProbeResult = {
  databaseConfigured: boolean;
  databaseReachable: boolean;
  migrationQueryOk: boolean;
  appliedHashes: string[];
};

export type ReleaseHealthPoolFactory = (config: PoolConfig) => {
  connect: () => Promise<PoolClient>;
  end: () => Promise<void>;
};

const MIGRATION_LEDGER_QUERY =
  'SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id ASC';

export function buildReleaseHealthPoolConfig(databaseUrl: string): PoolConfig {
  return {
    connectionString: databaseUrl,
    max: RELEASE_HEALTH_TIMEOUTS.poolMax,
    idleTimeoutMillis: RELEASE_HEALTH_TIMEOUTS.idleTimeoutMillis,
    connectionTimeoutMillis: RELEASE_HEALTH_TIMEOUTS.connectionTimeoutMillis,
    // node-pg aborts in-flight queries after this budget (independent of Promise.race).
    query_timeout: RELEASE_HEALTH_TIMEOUTS.queryTimeoutMs,
    // PostgreSQL-side abort; required because Promise.race alone does not cancel PG work.
    options: `-c statement_timeout=${RELEASE_HEALTH_TIMEOUTS.statementTimeoutMs}`
  };
}

export function loadExpectedMigrations(migrationsDir = join(process.cwd(), 'drizzle')): ExpectedMigration[] {
  const journalPath = join(migrationsDir, 'meta', '_journal.json');
  if (!existsSync(journalPath)) {
    return [];
  }

  let journal: JournalFile;
  try {
    journal = JSON.parse(readFileSync(journalPath, 'utf8')) as JournalFile;
  } catch {
    return [];
  }

  const entries = Array.isArray(journal.entries) ? journal.entries : [];
  const expected: ExpectedMigration[] = [];

  for (const entry of entries) {
    if (typeof entry?.tag !== 'string' || entry.tag.length === 0) {
      continue;
    }
    const sqlPath = join(migrationsDir, `${entry.tag}.sql`);
    if (!existsSync(sqlPath)) {
      continue;
    }
    const hash = createHash('sha256').update(readFileSync(sqlPath)).digest('hex');
    expected.push({ tag: entry.tag, hash });
  }

  return expected;
}

export function evaluateMigrationCompatibility(
  expected: ExpectedMigration[],
  appliedHashes: Iterable<string>
): Pick<
  ReleaseHealthReport['migrations'],
  'status' | 'compatible' | 'expectedCount' | 'appliedCount' | 'missingCount' | 'driftedCount' | 'latestExpectedTag'
> {
  const applied = new Set(
    [...appliedHashes].filter((hash) => typeof hash === 'string' && hash.length > 0)
  );
  const missing = expected.filter((migration) => !applied.has(migration.hash));
  const expectedHashSet = new Set(expected.map((migration) => migration.hash));
  const driftedCount = [...applied].filter((hash) => !expectedHashSet.has(hash)).length;

  let status: MigrationCompatibilityStatus = 'compatible';
  if (expected.length === 0) {
    status = 'unknown';
  } else if (missing.length > 0) {
    status = 'pending';
  } else if (driftedCount > 0) {
    // All expected hashes are present; extra ledger rows are recorded but do not
    // block releaseActive (production may retain reconciled historical rows).
    status = 'compatible';
  }

  return {
    status,
    compatible: status === 'compatible' && expected.length > 0,
    expectedCount: expected.length,
    appliedCount: applied.size,
    missingCount: missing.length,
    driftedCount,
    latestExpectedTag: expected.at(-1)?.tag ?? null
  };
}

export function buildReleaseHealthReport(input: {
  buildMarker: BuildMarkerIdentity;
  databaseConfigured: boolean;
  databaseReachable: boolean;
  migrationQueryOk: boolean;
  appliedHashes: string[];
  expectedMigrations?: ExpectedMigration[];
}): ReleaseHealthReport {
  const expected = input.expectedMigrations ?? loadExpectedMigrations();

  let migrations: ReleaseHealthReport['migrations'];
  if (!input.databaseConfigured) {
    migrations = {
      status: 'unconfigured',
      compatible: false,
      expectedCount: expected.length,
      appliedCount: 0,
      missingCount: expected.length,
      driftedCount: 0,
      latestExpectedTag: expected.at(-1)?.tag ?? null
    };
  } else if (!input.databaseReachable || !input.migrationQueryOk) {
    migrations = {
      status: 'unavailable',
      compatible: false,
      expectedCount: expected.length,
      appliedCount: 0,
      missingCount: expected.length,
      driftedCount: 0,
      latestExpectedTag: expected.at(-1)?.tag ?? null
    };
  } else {
    migrations = evaluateMigrationCompatibility(expected, input.appliedHashes);
  }

  const database = {
    configured: input.databaseConfigured,
    reachable: input.databaseReachable
  };

  const releaseActive =
    input.databaseConfigured
    && input.databaseReachable
    && migrations.compatible
    && typeof input.buildMarker.commit === 'string'
    && input.buildMarker.commit.length >= 7
    && input.buildMarker.commit !== 'unknown';

  let status: ReleaseHealthStatus = 'ok';
  if (!releaseActive) {
    status = !input.databaseConfigured || !input.databaseReachable || migrations.status === 'unavailable'
      ? 'unavailable'
      : 'degraded';
  }

  return {
    ok: releaseActive,
    service: input.buildMarker.service,
    status,
    commit: input.buildMarker.commit,
    branch: input.buildMarker.branch,
    buildTimestamp: input.buildMarker.buildTimestamp,
    nodeEnv: input.buildMarker.nodeEnv,
    database,
    migrations,
    releaseActive
  };
}

function remainingBudgetMs(deadlineAt: number, now: () => number): number {
  return deadlineAt - now();
}

async function destroyClient(client: PoolClient | null): Promise<void> {
  if (!client) return;
  try {
    // release(true) destroys the underlying connection rather than returning it to the pool.
    client.release(true);
  } catch {
    // ignore cleanup failures
  }
}

/**
 * Isolated release-health DB probe. Does not use the application pool.
 * Reachability is successful connect; then ONE bounded migration ledger query.
 */
export async function probeReleaseDatabase(input: {
  databaseUrl?: string | null;
  createPool?: ReleaseHealthPoolFactory;
  now?: () => number;
  deadlineMs?: number;
  migrationQuerySql?: string;
}): Promise<ReleaseDatabaseProbeResult> {
  const databaseUrl = typeof input.databaseUrl === 'string' ? input.databaseUrl.trim() : '';
  const databaseConfigured = Boolean(databaseUrl);
  if (!databaseConfigured) {
    return {
      databaseConfigured: false,
      databaseReachable: false,
      migrationQueryOk: false,
      appliedHashes: []
    };
  }

  const now = input.now ?? Date.now;
  const deadlineMs = input.deadlineMs ?? RELEASE_HEALTH_TIMEOUTS.handlerDeadlineMs;
  const deadlineAt = now() + deadlineMs;
  const createPool = input.createPool ?? ((config: PoolConfig) => new Pool(config));
  const migrationQuerySql = input.migrationQuerySql ?? MIGRATION_LEDGER_QUERY;

  if (remainingBudgetMs(deadlineAt, now) <= 0) {
    return {
      databaseConfigured: true,
      databaseReachable: false,
      migrationQueryOk: false,
      appliedHashes: []
    };
  }

  const poolConfig = buildReleaseHealthPoolConfig(databaseUrl);
  const probePool = createPool(poolConfig);
  let client: PoolClient | null = null;

  try {
    if (remainingBudgetMs(deadlineAt, now) <= 0) {
      return {
        databaseConfigured: true,
        databaseReachable: false,
        migrationQueryOk: false,
        appliedHashes: []
      };
    }

    client = await probePool.connect();
    const databaseReachable = true;

    if (remainingBudgetMs(deadlineAt, now) <= 0) {
      await destroyClient(client);
      client = null;
      return {
        databaseConfigured: true,
        databaseReachable: true,
        migrationQueryOk: false,
        appliedHashes: []
      };
    }

    try {
      const migrationRows = await client.query<{ hash: string }>(migrationQuerySql);
      const appliedHashes = migrationRows.rows
        .map((row) => row.hash)
        .filter((hash): hash is string => typeof hash === 'string' && hash.length > 0);
      client.release();
      client = null;
      return {
        databaseConfigured: true,
        databaseReachable,
        migrationQueryOk: true,
        appliedHashes
      };
    } catch {
      // Connect succeeded (reachable); migration/statement/query timeout or ledger error fails closed.
      await destroyClient(client);
      client = null;
      return {
        databaseConfigured: true,
        databaseReachable,
        migrationQueryOk: false,
        appliedHashes: []
      };
    }
  } catch {
    await destroyClient(client);
    client = null;
    return {
      databaseConfigured: true,
      databaseReachable: false,
      migrationQueryOk: false,
      appliedHashes: []
    };
  } finally {
    await probePool.end().catch(() => undefined);
  }
}

export async function evaluateReleaseHealth(input: {
  buildMarker: BuildMarkerIdentity;
  databaseUrl?: string | null;
  expectedMigrations?: ExpectedMigration[];
  createPool?: ReleaseHealthPoolFactory;
  now?: () => number;
  deadlineMs?: number;
  migrationQuerySql?: string;
  probe?: () => Promise<ReleaseDatabaseProbeResult>;
}): Promise<{ statusCode: number; report: ReleaseHealthReport }> {
  const probeResult = input.probe
    ? await input.probe()
    : await probeReleaseDatabase({
        databaseUrl: input.databaseUrl,
        createPool: input.createPool,
        now: input.now,
        deadlineMs: input.deadlineMs,
        migrationQuerySql: input.migrationQuerySql
      });

  const report = buildReleaseHealthReport({
    buildMarker: input.buildMarker,
    databaseConfigured: probeResult.databaseConfigured,
    databaseReachable: probeResult.databaseReachable,
    migrationQueryOk: probeResult.migrationQueryOk,
    appliedHashes: probeResult.appliedHashes,
    expectedMigrations: input.expectedMigrations
  });

  return {
    statusCode: report.releaseActive ? 200 : 503,
    report
  };
}
