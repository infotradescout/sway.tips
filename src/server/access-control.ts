import type { Request, Response, NextFunction } from 'express';
import { and, eq } from 'drizzle-orm';
import { createSwayDb, type SwayDb } from '../db/client';
import { gigAccessGrants, gigSessions, performerMemberships, performers, users } from '../db/schema';

export type SwayActor = {
  actorId: string | null;
  sessionId: string | null;
  patronDeviceIdHash: string | null;
};

type ActorRole = 'patron' | 'performer' | 'admin' | 'support' | null;

type GuardResult =
  | { allowed: true; actor: SwayActor; role: ActorRole }
  | { allowed: false; status: number; reason: string };

export type AccessControl = {
  resolveServerActor: (req: Request) => SwayActor;
  requireTalentAccess: (req: Request) => Promise<GuardResult>;
  requireAdminAccess: (req: Request) => Promise<GuardResult>;
  requireAdminOrSupportAccess: (req: Request) => Promise<GuardResult>;
  requireGigMutationAccess: (req: Request, gigId: string) => Promise<GuardResult>;
  allowPublicPatronAccess: (req: Request) => Promise<GuardResult>;
  allowPublicOverlayAccess: (req: Request) => Promise<GuardResult>;
  requireDevSandboxAccess: (req: Request) => Promise<GuardResult>;
};

function resolveActor(req: Request): SwayActor {
  return {
    actorId: typeof req.headers['x-sway-actor-id'] === 'string' ? req.headers['x-sway-actor-id'] : null,
    sessionId: typeof req.headers['x-sway-session-id'] === 'string' ? req.headers['x-sway-session-id'] : null,
    patronDeviceIdHash: typeof req.headers['x-sway-device-id-hash'] === 'string' ? req.headers['x-sway-device-id-hash'] : null
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

async function hasSupportRole(db: SwayDb, actorId: string) {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, actorId), eq(users.role, 'support')))
    .limit(1);
  return rows.length > 0;
}

async function getActorRole(db: SwayDb, actorId: string): Promise<ActorRole> {
  const rows = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, actorId))
    .limit(1);

  if (!rows.length) {
    return null;
  }

  return rows[0].role;
}

async function hasTalentRole(db: SwayDb, actorId: string) {
  const ownerRows = await db
    .select({ id: performers.id })
    .from(performers)
    .where(eq(performers.ownerUserId, actorId))
    .limit(1);

  if (ownerRows.length > 0) return true;

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
    resolveServerActor(req) {
      return resolveActor(req);
    },

    async requireTalentAccess(req) {
      const actor = resolveActor(req);
      if (!actor.actorId) return missingActor();
      if (!db) return missingPersistence();
      if (await hasTalentRole(db, actor.actorId)) {
        return { allowed: true, actor, role: await getActorRole(db, actor.actorId) };
      }
      return { allowed: false, status: 403, reason: 'Performer membership or gig access grant required.' };
    },

    async requireAdminAccess(req) {
      const actor = resolveActor(req);
      if (!actor.actorId) return missingActor();
      if (!db) return missingPersistence();
      if (await hasAdminRole(db, actor.actorId)) {
        return { allowed: true, actor, role: await getActorRole(db, actor.actorId) };
      }
      return { allowed: false, status: 403, reason: 'Admin authorization required.' };
    },

    async requireAdminOrSupportAccess(req) {
      const actor = resolveActor(req);
      if (!actor.actorId) return missingActor();
      if (!db) return missingPersistence();

      if (await hasAdminRole(db, actor.actorId) || await hasSupportRole(db, actor.actorId)) {
        return { allowed: true, actor, role: await getActorRole(db, actor.actorId) };
      }

      return { allowed: false, status: 403, reason: 'Admin or support authorization required.' };
    },

    async requireGigMutationAccess(req, gigId) {
      const actor = resolveActor(req);
      if (!actor.actorId) return missingActor();
      if (!db) return missingPersistence();

      const role = await getActorRole(db, actor.actorId);
      if (!role) {
        return { allowed: false, status: 403, reason: 'Resolved actor identity is not recognized.' };
      }

      if (role === 'admin' || role === 'support') {
        return { allowed: true, actor, role };
      }

      const performerOwnership = await db
        .select({ performerId: gigSessions.performerId })
        .from(gigSessions)
        .where(and(
          eq(gigSessions.id, gigId),
          eq(gigSessions.ownerActorUserId, actor.actorId)
        ))
        .limit(1);

      if (performerOwnership.length > 0) {
        return { allowed: true, actor, role };
      }

      const gigRows = await db
        .select({ performerId: gigSessions.performerId })
        .from(gigSessions)
        .where(eq(gigSessions.id, gigId))
        .limit(1);

      if (!gigRows.length) {
        return { allowed: false, status: 404, reason: 'Gig not found for mutation authorization.' };
      }

      const gigPerformerId = gigRows[0].performerId;

      const performerRows = await db
        .select({ id: performers.id })
        .from(performers)
        .where(and(eq(performers.id, gigPerformerId), eq(performers.ownerUserId, actor.actorId)))
        .limit(1);

      if (performerRows.length > 0) {
        return { allowed: true, actor, role };
      }

      const memberRows = await db
        .select({ id: performerMemberships.id })
        .from(performerMemberships)
        .where(and(
          eq(performerMemberships.performerId, gigPerformerId),
          eq(performerMemberships.userId, actor.actorId)
        ))
        .limit(1);

      if (memberRows.length > 0) {
        return { allowed: true, actor, role };
      }

      const grantRows = await db
        .select({ id: gigAccessGrants.id })
        .from(gigAccessGrants)
        .where(and(
          eq(gigAccessGrants.gigId, gigId),
          eq(gigAccessGrants.userId, actor.actorId)
        ))
        .limit(1);

      if (grantRows.length > 0) {
        return { allowed: true, actor, role };
      }

      return { allowed: false, status: 403, reason: 'Gig ownership or delegated performer access required.' };
    },

    async allowPublicPatronAccess(req) {
      return { allowed: true, actor: resolveActor(req), role: null };
    },

    async allowPublicOverlayAccess(req) {
      return { allowed: true, actor: resolveActor(req), role: null };
    },

    async requireDevSandboxAccess(req) {
      if (isProduction) {
        return { allowed: false, status: 404, reason: 'Dev sandbox is unavailable in production.' };
      }
      return { allowed: true, actor: resolveActor(req), role: null };
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
          ? accessControl.requireAdminOrSupportAccess
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
    req.headers['x-sway-resolved-device-id-hash'] = result.actor.patronDeviceIdHash ?? '';
    next();
  };
}
