import { createHash, randomBytes } from 'node:crypto';
import type { Request } from 'express';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { createSwayDb, type SwayDb } from '../db/client';
import { performerSessions } from '../db/schema';

export const PERFORMER_SESSION_COOKIE_NAME = 'sway_performer_session';
const DEFAULT_PERFORMER_SESSION_TTL_HOURS = 12;

export type IssuedPerformerSession = {
  sessionId: string;
  token: string;
  expiresAt: Date;
};

export type ResolvedPerformerSession = {
  sessionId: string;
  actorUserId: string;
  expiresAt: Date;
};

function parsePositiveInteger(rawValue: string | undefined, fallbackValue: number) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackValue;
  }
  return Math.floor(parsed);
}

export function hashPerformerSessionToken(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function readCookieHeaderValue(req: Request, cookieName: string) {
  const cookieHeader = req.headers.cookie;
  if (typeof cookieHeader !== 'string' || !cookieHeader.trim()) {
    return null;
  }

  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex <= 0) continue;

    const key = part.slice(0, separatorIndex).trim();
    if (key !== cookieName) continue;

    const value = part.slice(separatorIndex + 1).trim();
    if (!value) return null;

    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  return null;
}

export function createPerformerSessionStore({
  databaseUrl,
  dbOverride,
  cookieName = PERFORMER_SESSION_COOKIE_NAME,
  sessionTtlHours = parsePositiveInteger(process.env.SWAY_PERFORMER_SESSION_TTL_HOURS, DEFAULT_PERFORMER_SESSION_TTL_HOURS)
}: {
  databaseUrl?: string;
  dbOverride?: SwayDb | null;
  cookieName?: string;
  sessionTtlHours?: number;
}) {
  const db = dbOverride ?? (databaseUrl ? createSwayDb(databaseUrl) : null);

  return {
    cookieName,
    hasDurableStore: Boolean(db),

    readSessionTokenFromRequest(req: Request) {
      return readCookieHeaderValue(req, cookieName);
    },

    async issueSession({
      actorUserId,
      issuedBy
    }: {
      actorUserId: string;
      issuedBy?: string | null;
    }): Promise<IssuedPerformerSession> {
      if (!db) {
        throw new Error('Performer session issuance requires a durable database connection.');
      }

      const token = randomBytes(32).toString('base64url');
      const tokenHash = hashPerformerSessionToken(token);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + sessionTtlHours * 60 * 60 * 1000);

      const [inserted] = await db
        .insert(performerSessions)
        .values({
          actorUserId,
          tokenHash,
          expiresAt,
          revokedAt: null,
          lastSeenAt: now,
          issuedBy: issuedBy ?? null
        })
        .returning({
          id: performerSessions.id,
          expiresAt: performerSessions.expiresAt
        });

      return {
        sessionId: inserted.id,
        token,
        expiresAt: inserted.expiresAt
      };
    },

    async resolveSessionFromToken(token: string): Promise<ResolvedPerformerSession | null> {
      if (!db || !token) return null;

      const tokenHash = hashPerformerSessionToken(token);
      const now = new Date();
      const [row] = await db
        .select({
          id: performerSessions.id,
          actorUserId: performerSessions.actorUserId,
          expiresAt: performerSessions.expiresAt
        })
        .from(performerSessions)
        .where(and(
          eq(performerSessions.tokenHash, tokenHash),
          isNull(performerSessions.revokedAt),
          gt(performerSessions.expiresAt, now)
        ))
        .limit(1);

      if (!row) {
        return null;
      }

      return {
        sessionId: row.id,
        actorUserId: row.actorUserId,
        expiresAt: row.expiresAt
      };
    },

    async revokeSessionFromToken(token: string): Promise<{ sessionId: string; actorUserId: string } | null> {
      if (!db || !token) return null;

      const tokenHash = hashPerformerSessionToken(token);
      const now = new Date();
      const [revoked] = await db
        .update(performerSessions)
        .set({
          revokedAt: now
        })
        .where(and(
          eq(performerSessions.tokenHash, tokenHash),
          isNull(performerSessions.revokedAt)
        ))
        .returning({
          id: performerSessions.id,
          actorUserId: performerSessions.actorUserId
        });

      if (!revoked) {
        return null;
      }

      return {
        sessionId: revoked.id,
        actorUserId: revoked.actorUserId
      };
    }
  };
}
