import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { createSwayDb, type SwayDb } from '../db/client';
import { performerLoginChallenges } from '../db/schema';

export const PERFORMER_LOGIN_SUCCESS_COPY = 'If this email is on an approved Sway performer account, we sent a link.';
export const PERFORMER_LOGIN_LINK_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_PERFORMER_LOGIN_RATE_LIMIT_MAX = 3;
export const DEFAULT_PERFORMER_LOGIN_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

type DbExecutor = SwayDb | any;

function parsePositiveInteger(rawValue: string | undefined, fallbackValue: number) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackValue;
  }
  return Math.floor(parsed);
}

export function normalizePerformerLoginEmail(rawValue: unknown) {
  if (typeof rawValue !== 'string') return null;

  const normalized = rawValue.trim().toLowerCase();
  if (!normalized) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return null;

  return normalized;
}

export function hashPerformerLoginToken(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function hashPerformerLoginRequesterIp(ipAddress: string | null | undefined) {
  const normalizedIp = typeof ipAddress === 'string' && ipAddress.trim()
    ? ipAddress.trim()
    : 'unknown';
  return createHash('sha256').update(normalizedIp, 'utf8').digest('hex');
}

export function resolvePerformerLoginRedirectPath(rawValue: unknown) {
  if (typeof rawValue !== 'string') return '/talent';

  const trimmed = rawValue.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return '/talent';

  try {
    const parsed = new URL(trimmed, 'https://sway.tips');
    if (parsed.origin !== 'https://sway.tips') return '/talent';
    if (!parsed.pathname.startsWith('/talent')) return '/talent';
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '/talent';
  }
}

export function createPerformerLoginRateLimiter({
  maxRequests = parsePositiveInteger(process.env.SWAY_PERFORMER_LOGIN_RATE_LIMIT_MAX, DEFAULT_PERFORMER_LOGIN_RATE_LIMIT_MAX),
  windowMs = parsePositiveInteger(process.env.SWAY_PERFORMER_LOGIN_RATE_LIMIT_WINDOW_MS, DEFAULT_PERFORMER_LOGIN_RATE_LIMIT_WINDOW_MS)
}: {
  maxRequests?: number;
  windowMs?: number;
} = {}) {
  const buckets = new Map<string, number[]>();

  return {
    maxRequests,
    windowMs,

    consume({
      requesterIpHash,
      targetEmail,
      now = Date.now()
    }: {
      requesterIpHash: string;
      targetEmail: string;
      now?: number;
    }) {
      const bucketKey = `${requesterIpHash}:${targetEmail}`;
      const activeWindowStart = now - windowMs;
      const nextEntries = (buckets.get(bucketKey) ?? []).filter((timestamp) => timestamp > activeWindowStart);

      if (nextEntries.length >= maxRequests) {
        buckets.set(bucketKey, nextEntries);
        return {
          allowed: false as const,
          retryAfterMs: Math.max(0, windowMs - (now - nextEntries[0]))
        };
      }

      nextEntries.push(now);
      buckets.set(bucketKey, nextEntries);
      return {
        allowed: true as const,
        retryAfterMs: 0
      };
    }
  };
}

export function createPerformerLoginChallengeStore({
  databaseUrl,
  dbOverride
}: {
  databaseUrl?: string;
  dbOverride?: SwayDb | null;
}) {
  const db = dbOverride ?? (databaseUrl ? createSwayDb(databaseUrl) : null);

  function executorOrDb(executor?: DbExecutor | null) {
    return executor ?? db;
  }

  return {
    hasDurableStore: Boolean(db),

    async issueChallenge({
      actorUserId,
      targetEmail,
      requesterIpHash,
      sendCount = 1,
      executor,
      now = new Date()
    }: {
      actorUserId: string;
      targetEmail: string;
      requesterIpHash: string;
      sendCount?: number;
      executor?: DbExecutor | null;
      now?: Date;
    }) {
      const writer = executorOrDb(executor);
      if (!writer) {
        throw new Error('Performer login challenge issuance requires a durable database connection.');
      }

      const token = randomBytes(32).toString('base64url');
      const tokenHash = hashPerformerLoginToken(token);
      const expiresAt = new Date(now.getTime() + PERFORMER_LOGIN_LINK_TTL_MS);

      const [inserted] = await writer
        .insert(performerLoginChallenges)
        .values({
          actorUserId,
          targetEmail,
          tokenHash,
          expiresAt,
          consumedAt: null,
          revokedAt: null,
          sendCount,
          requestedAt: now,
          requesterIpHash
        })
        .returning({
          id: performerLoginChallenges.id,
          expiresAt: performerLoginChallenges.expiresAt
        });

      return {
        challengeId: inserted.id,
        token,
        expiresAt: inserted.expiresAt
      };
    },

    async consumeChallengeFromToken({
      token,
      executor,
      now = new Date()
    }: {
      token: string;
      executor?: DbExecutor | null;
      now?: Date;
    }) {
      const writer = executorOrDb(executor);
      if (!writer || !token) return null;

      const tokenHash = hashPerformerLoginToken(token);
      const [consumed] = await writer
        .update(performerLoginChallenges)
        .set({
          consumedAt: now
        })
        .where(and(
          eq(performerLoginChallenges.tokenHash, tokenHash),
          isNull(performerLoginChallenges.consumedAt),
          isNull(performerLoginChallenges.revokedAt),
          gt(performerLoginChallenges.expiresAt, now)
        ))
        .returning({
          id: performerLoginChallenges.id,
          actorUserId: performerLoginChallenges.actorUserId,
          targetEmail: performerLoginChallenges.targetEmail,
          expiresAt: performerLoginChallenges.expiresAt,
          requestedAt: performerLoginChallenges.requestedAt
        });

      return consumed ?? null;
    },

    async revokeChallengeById({
      challengeId,
      executor,
      now = new Date()
    }: {
      challengeId: string;
      executor?: DbExecutor | null;
      now?: Date;
    }) {
      const writer = executorOrDb(executor);
      if (!writer) return null;

      const [revoked] = await writer
        .update(performerLoginChallenges)
        .set({
          revokedAt: now
        })
        .where(and(
          eq(performerLoginChallenges.id, challengeId),
          isNull(performerLoginChallenges.revokedAt),
          isNull(performerLoginChallenges.consumedAt)
        ))
        .returning({
          id: performerLoginChallenges.id,
          actorUserId: performerLoginChallenges.actorUserId
        });

      return revoked ?? null;
    }
  };
}
