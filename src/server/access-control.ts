import type { Request, Response, NextFunction } from 'express';
import { and, eq } from 'drizzle-orm';
import { createSwayDb, type SwayDb } from '../db/client';
import { gigAccessGrants, performerMemberships, users } from '../db/schema';

export type SwayActor = {
  actorId: string | null;
  sessionId: string | null;
};

type GuardResult =
  | { allowed: true; actor: SwayActor }
  | { allowed: false; status: number; reason: string };

export type AccessControl = {
  requireTalentAccess: (req: Request) => Promise<GuardResult>;
  requireAdminAccess: (req: Request) => Promise<GuardResult>;
  allowPublicPatronAccess: (req: Request) => Promise<GuardResult>;
  allowPublicOverlayAccess: (req: Request) => Promise<GuardResult>;
  requireDevSandboxAccess: (req: Request) => Promise<GuardResult>;
};

function resolveActor(req: Request): SwayActor {
  return {
    actorId: typeof req.headers['x-sway-actor-id'] === 'string' ? req.headers['x-sway-actor-id'] : null,
    sessionId: typeof req.headers['x-sway-session-id'] === 'string' ? req.headers['x-sway-session-id'] : null
  };
}

function missingActor(): GuardResult {
  return { allowed: false, status: 401, reason: 'Sway actor resolution required.' };
}

function missingPersistence(): GuardResult {
  return { allowed: false, status: 503, reason: 'Persisted access store is required for this route family.' };
}

async function hasAdminRole(db: SwayDb, actorId: string) {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, actorId), eq(users.role, 'admin')))
    .limit(1);
  return rows.length > 0;
}

async function hasTalentRole(db: SwayDb, actorId: string) {
  const membershipRows = await db
    .select({ id: performerMemberships.id })
    .from(performerMemberships)
    .where(eq(performerMemberships.userId, actorId))
    .limit(1);

  if (membershipRows.length > 0) return true;

  const accessRows = await db
    .select({ id: gigAccessGrants.id })
    .from(gigAccessGrants)
    .where(eq(gigAccessGrants.userId, actorId))
    .limit(1);

  return accessRows.length > 0;
}

export function createAccessControl({
  databaseUrl,
  isProduction
}: {
  databaseUrl?: string;
  isProduction: boolean;
}): AccessControl {
  const db = databaseUrl ? createSwayDb(databaseUrl) : null;

  return {
    async requireTalentAccess(req) {
      const actor = resolveActor(req);
      if (!actor.actorId) return missingActor();
      if (!db) return missingPersistence();
      if (await hasTalentRole(db, actor.actorId)) return { allowed: true, actor };
      return { allowed: false, status: 403, reason: 'Performer membership or gig access grant required.' };
    },

    async requireAdminAccess(req) {
      const actor = resolveActor(req);
      if (!actor.actorId) return missingActor();
      if (!db) return missingPersistence();
      if (await hasAdminRole(db, actor.actorId)) return { allowed: true, actor };
      return { allowed: false, status: 403, reason: 'Admin authorization required.' };
    },

    async allowPublicPatronAccess(req) {
      return { allowed: true, actor: resolveActor(req) };
    },

    async allowPublicOverlayAccess(req) {
      return { allowed: true, actor: resolveActor(req) };
    },

    async requireDevSandboxAccess(req) {
      if (isProduction) {
        return { allowed: false, status: 404, reason: 'Dev sandbox is unavailable in production.' };
      }
      return { allowed: true, actor: resolveActor(req) };
    }
  };
}

export function routeFamilyGuard(accessControl: AccessControl) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const shell = req.headers['x-sway-shell'];
    const guard =
      shell === 'talent'
        ? accessControl.requireTalentAccess
        : shell === 'admin'
          ? accessControl.requireAdminAccess
          : shell === 'overlay'
            ? accessControl.allowPublicOverlayAccess
            : shell === 'dev-sandbox'
              ? accessControl.requireDevSandboxAccess
              : accessControl.allowPublicPatronAccess;

    const result = await guard(req);
    if (result.allowed === false) {
      res.status(result.status).json({ error: result.reason });
      return;
    }

    req.headers['x-sway-resolved-actor-id'] = result.actor.actorId ?? '';
    next();
  };
}
