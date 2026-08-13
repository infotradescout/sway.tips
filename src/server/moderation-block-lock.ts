import { sql } from 'drizzle-orm';

export type ModerationBlockIdentity = {
  scope: 'patron_user_id' | 'patron_device_id_hash' | 'sender_name';
  normalizedValue: string;
};

type SqlExecutor = {
  execute: (query: unknown) => Promise<unknown>;
};

export function moderationBlockIdentities(input: {
  patronUserId?: string | null;
  patronDeviceIdHash?: string | null;
  senderName?: string | null;
}): ModerationBlockIdentity[] {
  const candidates: ModerationBlockIdentity[] = [
    ...(input.patronUserId?.trim()
      ? [{ scope: 'patron_user_id' as const, normalizedValue: input.patronUserId.trim().toLowerCase() }]
      : []),
    ...(input.patronDeviceIdHash?.trim()
      ? [{ scope: 'patron_device_id_hash' as const, normalizedValue: input.patronDeviceIdHash.trim().toLowerCase() }]
      : []),
    ...(input.senderName?.trim()
      ? [{ scope: 'sender_name' as const, normalizedValue: input.senderName.trim().toLowerCase() }]
      : [])
  ];

  return [...new Map(
    candidates.map((identity) => [`${identity.scope}:${identity.normalizedValue}`, identity])
  ).values()].sort((left, right) => (
    `${left.scope}:${left.normalizedValue}`.localeCompare(`${right.scope}:${right.normalizedValue}`)
  ));
}

export async function lockModerationBlockIdentities(
  executor: SqlExecutor,
  identities: ModerationBlockIdentity[]
) {
  for (const identity of identities) {
    const key = `moderation-block:${identity.scope}:${identity.normalizedValue}`;
    await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }
}
