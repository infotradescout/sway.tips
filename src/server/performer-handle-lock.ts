import { sql } from 'drizzle-orm';

type SqlExecutor = {
  execute: (query: unknown) => Promise<unknown>;
};

const PERFORMER_HANDLE_LOCK_PREFIX = 'sway:performer-handle:v1:';

export function canonicalPerformerHandle(handle: string | null | undefined) {
  const canonical = typeof handle === 'string' ? handle.trim().toLowerCase() : '';
  return canonical || null;
}

export async function lockPerformerHandleNamespace(
  executor: SqlExecutor,
  handle: string | null | undefined
) {
  const canonical = canonicalPerformerHandle(handle);
  if (!canonical) return null;

  const lockKey = `${PERFORMER_HANDLE_LOCK_PREFIX}${canonical}`;
  await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
  return canonical;
}

export async function lockPerformerHandleNamespaces(
  executor: SqlExecutor,
  handles: Array<string | null | undefined>
) {
  const canonicalHandles = [...new Set(
    handles
      .map((handle) => canonicalPerformerHandle(handle))
      .filter((handle): handle is string => Boolean(handle))
  )].sort((left, right) => left.localeCompare(right));

  for (const canonical of canonicalHandles) {
    await lockPerformerHandleNamespace(executor, canonical);
  }

  return canonicalHandles;
}
