import type { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { createSwayDb, type SwayDb } from '../db/client';
import { gigAccessGrants, gigSessions, performerMemberships, performers, users } from '../db/schema';
import { createPerformerSessionStore, type ResolvedPerformerSession } from './performer-session-store';

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
  hydrateRequestActor: (req: Request) => Promise<SwayActor>;
  resolveServerActor: (req: Request) => SwayActor;
  requireTalentAccess: (req: Request) => Promise<GuardResult>;
  requireAdminAccess: (req: Request) => Promise<GuardResult>;
  requireAdminOrSupportAccess: (req: Request) => Promise<GuardResult>;
  requireGigMutationAccess: (req: Request, gigId: string) => Promise<GuardResult>;
  allowPublicPatronAccess: (req: Request) => Promise<GuardResult>;
  allowPublicOverlayAccess: (req: Request) => Promise<GuardResult>;
  requireDevSandboxAccess: (req: Request) => Promise<GuardResult>;
};

// Talent route families intentionally map to the persisted performer role during fallback smoke and verification.
type FallbackRole = 'performer' | 'admin' | 'support';

type FallbackAccessPolicy = {
  performerActorIds: Set<string>;
  adminActorIds: Set<string>;
  supportActorIds: Set<string>;
};

type FallbackVerificationConfig = {
  signatureSecret: string | null;
  maxAgeMs: number;
};

function isBrowserHtmlRequest(req: Request) {
  const accept = req.headers.accept;
  return req.method === 'GET' && typeof accept === 'string' && accept.includes('text/html');
}

function isPublicTalentLoginEntryRoute(req: Request) {
  return req.method === 'GET' && (req.path === '/talent/login' || req.path === '/talent/signup');
}

function isPublicAdminLoginEntryRoute(req: Request) {
  return req.method === 'GET' && req.path === '/admin/login';
}

function escapeHtml(input: string) {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderProtectedRouteRecovery(status: number, reason: string, shell?: string) {
  const safeReason = escapeHtml(reason);
  const signInHref = shell === 'talent' ? '/talent/login' : shell === 'admin' ? '/admin/login' : null;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sway | Session needed</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        background: #070812;
        color: #f8fafc;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        width: min(100%, 440px);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 20px;
        background: rgba(15, 23, 42, 0.86);
        padding: 28px;
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.42);
      }
      .mark {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 44px;
        height: 44px;
        border-radius: 14px;
        margin-bottom: 18px;
        border: 1px solid rgba(217, 70, 239, 0.28);
        background: rgba(217, 70, 239, 0.12);
        color: #f0abfc;
        font-weight: 900;
      }
      h1 {
        margin: 0;
        font-size: 26px;
        line-height: 1.08;
        letter-spacing: 0;
      }
      p {
        margin: 12px 0 0;
        color: #cbd5e1;
        font-size: 15px;
        line-height: 1.55;
      }
      .reason {
        margin-top: 16px;
        padding: 12px;
        border-radius: 12px;
        background: rgba(2, 6, 23, 0.62);
        color: #94a3b8;
        font-size: 13px;
      }
      a {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 44px;
        margin-top: 22px;
        padding: 0 16px;
        border-radius: 12px;
        background: #d946ef;
        color: white;
        font-weight: 800;
        text-decoration: none;
      }
    </style>
  </head>
  <body>
    <main>
      <div class="mark" aria-hidden="true">S</div>
      <h1>Session needed</h1>
      <p><strong>Sign in to continue.</strong></p>
      <p>This Sway area needs an active performer or operator session.</p>
      <div class="reason">Status ${status}: ${safeReason}</div>
      ${signInHref ? `<a href="${signInHref}">Sign in</a>` : ''}
      <a href="/">Return home</a>
    </main>
  </body>
</html>`;
}

function resolveRawActor(req: Request): SwayActor {
  return {
    actorId: typeof req.headers['x-sway-actor-id'] === 'string' ? req.headers['x-sway-actor-id'] : null,
    sessionId: typeof req.headers['x-sway-session-id'] === 'string' ? req.headers['x-sway-session-id'] : null,
    patronDeviceIdHash: typeof req.headers['x-sway-device-id-hash'] === 'string' ? req.headers['x-sway-device-id-hash'] : null
  };
}

function writeResolvedActor(req: Request, actor: SwayActor) {
  req.headers[RESOLVED_ACTOR_HEADER] = actor.actorId ?? '';
  req.headers[RESOLVED_SESSION_HEADER] = actor.sessionId ?? '';
  req.headers[RESOLVED_DEVICE_HEADER] = actor.patronDeviceIdHash ?? '';
  req.headers[HYDRATED_ACTOR_HEADER] = '1';
}

function hasResolvedActor(req: Request) {
  return req.headers[HYDRATED_ACTOR_HEADER] === '1';
}

function resolveActor(req: Request): SwayActor {
  if (hasResolvedActor(req)) {
    return {
      actorId: typeof req.headers[RESOLVED_ACTOR_HEADER] === 'string' && req.headers[RESOLVED_ACTOR_HEADER].length > 0
        ? req.headers[RESOLVED_ACTOR_HEADER]
        : null,
      sessionId: typeof req.headers[RESOLVED_SESSION_HEADER] === 'string' && req.headers[RESOLVED_SESSION_HEADER].length > 0
        ? req.headers[RESOLVED_SESSION_HEADER]
        : null,
      patronDeviceIdHash: typeof req.headers[RESOLVED_DEVICE_HEADER] === 'string' && req.headers[RESOLVED_DEVICE_HEADER].length > 0
        ? req.headers[RESOLVED_DEVICE_HEADER]
        : null
    };
  }

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
  return {
    allowed: false,
    status: 503,
    reason: 'Protected route authorization requires durable access persistence or an explicitly configured fallback actor allowlist.'
  };
}

function fallbackVerificationUnavailable(): GuardResult {
  return {
    allowed: false,
    status: 503,
    reason: 'Protected route fallback authorization requires a verified internal actor assertion configuration.'
  };
}

function invalidFallbackAssertion(): GuardResult {
  return {
    allowed: false,
    status: 403,
    reason: 'Verified internal actor assertion required for fallback authorization.'
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_FALLBACK_ASSERTION_MAX_AGE_MS = 5 * 60 * 1000;
const RESOLVED_ACTOR_HEADER = 'x-sway-resolved-actor-id';
const RESOLVED_SESSION_HEADER = 'x-sway-resolved-session-id';
const RESOLVED_DEVICE_HEADER = 'x-sway-resolved-device-id-hash';
const HYDRATED_ACTOR_HEADER = 'x-sway-actor-hydrated';

function parseFallbackActorIds(rawValue: string | undefined) {
  if (!rawValue) return new Set<string>();

  return new Set(
    rawValue
      .split(/[,\s]+/)
      .map((value) => value.trim())
      .filter((value) => UUID_PATTERN.test(value))
  );
}

function createFallbackAccessPolicy(): FallbackAccessPolicy {
  return {
    performerActorIds: parseFallbackActorIds(process.env.SWAY_FALLBACK_TALENT_ACTOR_IDS),
    adminActorIds: parseFallbackActorIds(process.env.SWAY_FALLBACK_ADMIN_ACTOR_IDS),
    supportActorIds: parseFallbackActorIds(process.env.SWAY_FALLBACK_SUPPORT_ACTOR_IDS)
  };
}

function parseFallbackAssertionMaxAgeMs(rawValue: string | undefined) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_FALLBACK_ASSERTION_MAX_AGE_MS;
  }
  return Math.floor(parsed * 1000);
}

function createFallbackVerificationConfig(): FallbackVerificationConfig {
  const secret = process.env.SWAY_FALLBACK_ACTOR_HEADER_SECRET?.trim() || null;

  return {
    signatureSecret: secret,
    maxAgeMs: parseFallbackAssertionMaxAgeMs(process.env.SWAY_FALLBACK_ACTOR_SIGNATURE_MAX_AGE_SECONDS)
  };
}

function hasConfiguredFallback(policy: FallbackAccessPolicy, role: FallbackRole) {
  if (role === 'performer') return policy.performerActorIds.size > 0;
  if (role === 'admin') return policy.adminActorIds.size > 0;
  return policy.supportActorIds.size > 0;
}

function allowsFallbackRole(policy: FallbackAccessPolicy, actorId: string, role: FallbackRole) {
  if (role === 'performer') return policy.performerActorIds.has(actorId);
  if (role === 'admin') return policy.adminActorIds.has(actorId);
  return policy.supportActorIds.has(actorId);
}

function fallbackRoleResult(actor: SwayActor, role: ActorRole): GuardResult {
  return { allowed: true, actor, role };
}

function readHeaderValue(req: Request, key: string) {
  const value = req.headers[key];
  return typeof value === 'string' ? value : null;
}

function createFallbackAssertionPayload(input: {
  actorId: string;
  sessionId: string | null;
  role: FallbackRole;
  timestamp: string;
}) {
  return [input.actorId, input.sessionId ?? '', input.role, input.timestamp].join('|');
}

function verifyFallbackAssertion(req: Request, actor: SwayActor, role: FallbackRole, config: FallbackVerificationConfig): GuardResult | null {
  if (!config.signatureSecret) {
    return fallbackVerificationUnavailable();
  }

  const assertedRole = readHeaderValue(req, 'x-sway-fallback-role');
  const timestamp = readHeaderValue(req, 'x-sway-fallback-timestamp');
  const signature = readHeaderValue(req, 'x-sway-fallback-signature');

  if (!assertedRole || !timestamp || !signature) {
    return invalidFallbackAssertion();
  }

  if (assertedRole !== role) {
    return invalidFallbackAssertion();
  }

  const assertedAt = Date.parse(timestamp);
  if (!Number.isFinite(assertedAt) || Math.abs(Date.now() - assertedAt) > config.maxAgeMs) {
    return invalidFallbackAssertion();
  }

  const expectedSignature = createHmac('sha256', config.signatureSecret)
    .update(createFallbackAssertionPayload({
      actorId: actor.actorId ?? '',
      sessionId: actor.sessionId,
      role,
      timestamp
    }))
    .digest('hex');

  const signatureBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expectedSignature, 'hex');

  if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return invalidFallbackAssertion();
  }

  return null;
}

function resolveTalentFallbackAccess(
  req: Request,
  actor: SwayActor,
  policy: FallbackAccessPolicy,
  verificationConfig: FallbackVerificationConfig
): GuardResult {
  if (!actor.actorId) return missingActor();
  if (!hasConfiguredFallback(policy, 'performer')) {
    return missingPersistence();
  }
  const verificationFailure = verifyFallbackAssertion(req, actor, 'performer', verificationConfig);
  if (verificationFailure) return verificationFailure;
  if (allowsFallbackRole(policy, actor.actorId, 'performer')) {
    return fallbackRoleResult(actor, 'performer');
  }
  return { allowed: false, status: 403, reason: 'Performer membership or gig access grant required.' };
}

function resolveAdminFallbackAccess(
  req: Request,
  actor: SwayActor,
  policy: FallbackAccessPolicy,
  verificationConfig: FallbackVerificationConfig,
  options: { allowSupport: boolean }
): GuardResult {
  if (!actor.actorId) return missingActor();
  if (!hasConfiguredFallback(policy, 'admin') && !(options.allowSupport && hasConfiguredFallback(policy, 'support'))) {
    return missingPersistence();
  }
  let verifiedRole: FallbackRole | null = null;
  let verificationFailure = verifyFallbackAssertion(req, actor, 'admin', verificationConfig);
  if (!verificationFailure) {
    verifiedRole = 'admin';
  } else if (options.allowSupport) {
    verificationFailure = verifyFallbackAssertion(req, actor, 'support', verificationConfig);
    if (!verificationFailure) {
      verifiedRole = 'support';
    }
  }

  if (!verifiedRole) {
    return verificationFailure ?? invalidFallbackAssertion();
  }

  if (verifiedRole === 'admin' && allowsFallbackRole(policy, actor.actorId, 'admin')) {
    return fallbackRoleResult(actor, 'admin');
  }
  if (verifiedRole === 'support' && options.allowSupport && allowsFallbackRole(policy, actor.actorId, 'support')) {
    return fallbackRoleResult(actor, 'support');
  }
  return {
    allowed: false,
    status: 403,
    reason: options.allowSupport ? 'Admin or support authorization required.' : 'Admin authorization required.'
  };
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
  isProduction,
  dbOverride,
  performerSessionStoreOverride
}: {
  databaseUrl?: string;
  isProduction: boolean;
  dbOverride?: SwayDb | null;
  performerSessionStoreOverride?: ReturnType<typeof createPerformerSessionStore> | null;
}): AccessControl {
  const db = dbOverride ?? (databaseUrl ? createSwayDb(databaseUrl) : null);
  const fallbackPolicy = db ? null : createFallbackAccessPolicy();
  const fallbackVerificationConfig = db ? null : createFallbackVerificationConfig();
  const performerSessionStore = db
    ? (performerSessionStoreOverride ?? createPerformerSessionStore({ databaseUrl, dbOverride: db }))
    : null;

  function actorFromSession(session: ResolvedPerformerSession | null, req: Request): SwayActor {
    const rawActor = resolveRawActor(req);
    return {
      actorId: session?.actorUserId ?? null,
      sessionId: session?.sessionId ?? null,
      patronDeviceIdHash: rawActor.patronDeviceIdHash
    };
  }

  async function hydrateRequestActor(req: Request) {
    if (hasResolvedActor(req)) {
      return resolveActor(req);
    }

    if (!db) {
      const rawActor = resolveRawActor(req);
      writeResolvedActor(req, rawActor);
      return rawActor;
    }

    const sessionToken = performerSessionStore?.readSessionTokenFromRequest(req) ?? null;
    if (!sessionToken) {
      const anonymousActor = actorFromSession(null, req);
      writeResolvedActor(req, anonymousActor);
      return anonymousActor;
    }

    const resolvedSession = await performerSessionStore?.resolveSessionFromToken(sessionToken) ?? null;
    if (!resolvedSession) {
      console.warn('Protected performer session rejected.', {
        path: req.path,
        ip: req.ip || null,
        reason: 'invalid_or_expired_session'
      });
      const rejectedActor = actorFromSession(null, req);
      writeResolvedActor(req, rejectedActor);
      return rejectedActor;
    }

    const hydratedActor = actorFromSession(resolvedSession, req);
    writeResolvedActor(req, hydratedActor);
    return hydratedActor;
  }

  return {
    hydrateRequestActor,

    resolveServerActor(req) {
      return resolveActor(req);
    },

    async requireTalentAccess(req) {
      await hydrateRequestActor(req);
      const actor = resolveActor(req);
      if (!actor.actorId) return missingActor();
      if (!db) {
        return resolveTalentFallbackAccess(
          req,
          actor,
          fallbackPolicy ?? createFallbackAccessPolicy(),
          fallbackVerificationConfig ?? createFallbackVerificationConfig()
        );
      }
      if (await hasTalentRole(db, actor.actorId)) {
        return { allowed: true, actor, role: await getActorRole(db, actor.actorId) };
      }
      return { allowed: false, status: 403, reason: 'Performer membership or gig access grant required.' };
    },

    async requireAdminAccess(req) {
      await hydrateRequestActor(req);
      const actor = resolveActor(req);
      if (!actor.actorId) return missingActor();
      if (!db) {
        return resolveAdminFallbackAccess(
          req,
          actor,
          fallbackPolicy ?? createFallbackAccessPolicy(),
          fallbackVerificationConfig ?? createFallbackVerificationConfig(),
          { allowSupport: false }
        );
      }
      if (await hasAdminRole(db, actor.actorId)) {
        return { allowed: true, actor, role: await getActorRole(db, actor.actorId) };
      }
      return { allowed: false, status: 403, reason: 'Admin authorization required.' };
    },

    async requireAdminOrSupportAccess(req) {
      await hydrateRequestActor(req);
      const actor = resolveActor(req);
      if (!actor.actorId) return missingActor();
      if (!db) {
        return resolveAdminFallbackAccess(
          req,
          actor,
          fallbackPolicy ?? createFallbackAccessPolicy(),
          fallbackVerificationConfig ?? createFallbackVerificationConfig(),
          { allowSupport: true }
        );
      }

      if (await hasAdminRole(db, actor.actorId) || await hasSupportRole(db, actor.actorId)) {
        return { allowed: true, actor, role: await getActorRole(db, actor.actorId) };
      }

      return { allowed: false, status: 403, reason: 'Admin or support authorization required.' };
    },

    async requireGigMutationAccess(req, gigId) {
      await hydrateRequestActor(req);
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
    const demoPreviewShellAllowed =
      process.env.NODE_ENV !== 'production' &&
      process.env.VITE_SWAY_DEMO_MODE === 'true' &&
      req.method === 'GET' &&
      (shell === 'talent' || shell === 'admin');

    if (demoPreviewShellAllowed) {
      writeResolvedActor(req, {
        actorId: null,
        sessionId: null,
        patronDeviceIdHash: null
      });
      next();
      return;
    }

    if (shell === 'talent' && isPublicTalentLoginEntryRoute(req)) {
      writeResolvedActor(req, {
        actorId: null,
        sessionId: null,
        patronDeviceIdHash: null
      });
      next();
      return;
    }

    if (shell === 'admin' && isPublicAdminLoginEntryRoute(req)) {
      writeResolvedActor(req, {
        actorId: null,
        sessionId: null,
        patronDeviceIdHash: null
      });
      next();
      return;
    }

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
      if (shell === 'talent' && req.method === 'GET' && req.path === '/talent' && isBrowserHtmlRequest(req)) {
        res.redirect('/talent/login');
        return;
      }

      if (isBrowserHtmlRequest(req)) {
        res
          .status(result.status)
          .set({ 'Content-Type': 'text/html; charset=utf-8' })
          .send(renderProtectedRouteRecovery(result.status, result.reason, typeof shell === 'string' ? shell : undefined));
        return;
      }
      res.status(result.status).json({ error: result.reason });
      return;
    }

    writeResolvedActor(req, result.actor);
    next();
  };
}
