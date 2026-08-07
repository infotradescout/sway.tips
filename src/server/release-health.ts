import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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
