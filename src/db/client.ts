import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

// The embedded protocol proof multiplexes one PGlite database behind a TCP
// facade. Reuse one single-connection pool for its unmistakably disposable,
// loopback-only database names so concurrent callers are serialized by the
// facade instead of colliding on its shared unnamed portal. Real PostgreSQL
// connections never enter this lane and retain normal pooling/locking.
const disposableProofPools = new Map<string, Pool>();

function isEmbeddedDisposableProof(connectionString: string) {
  try {
    const parsed = new URL(connectionString);
    return ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)
      && parsed.pathname.toLowerCase().includes('sway_embedded_disposable_test');
  } catch {
    return false;
  }
}

function isLocalDisposableProof(connectionString: string) {
  try {
    const parsed = new URL(connectionString);
    const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, '')).toLowerCase();
    return ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)
      && !parsed.search
      && !parsed.hash
      && databaseName.startsWith('sway_')
      && /(^|[_-])(test|testing|disposable|proof)([_-]|$)/.test(databaseName);
  } catch {
    return false;
  }
}

export function createSwayDb(connectionString: string) {
  const embeddedProof = isEmbeddedDisposableProof(connectionString);
  const disposableProof = isLocalDisposableProof(connectionString);
  const pool = disposableProof
    ? disposableProofPools.get(connectionString) ?? new Pool({ connectionString, max: embeddedProof ? 1 : 20 })
    : new Pool({ connectionString });
  if (disposableProof) disposableProofPools.set(connectionString, pool);
  return drizzle(pool, { schema });
}

export async function closeDisposableSwayDbProof(connectionString: string) {
  if (!isLocalDisposableProof(connectionString)) return;
  const pool = disposableProofPools.get(connectionString);
  if (!pool) return;
  disposableProofPools.delete(connectionString);
  await pool.end();
}

export type SwayDb = ReturnType<typeof createSwayDb>;
