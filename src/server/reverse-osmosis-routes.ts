import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { createSwayReverseOsmosisService, type ReverseOsmosisDatabase } from './reverse-osmosis-native';

interface ProfileSyncDependencies {
  externalOrigin?: string;
  database: () => ReverseOsmosisDatabase | null;
  requireTalentAccess: (request: Request) => Promise<any>;
  loadOwnedPerformer: (actorId: string) => Promise<{ performerId: string; handle?: string | null } | null>;
}
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const exactBody = (body: unknown, keys: string[]) => body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === keys.length && keys.every(key => Object.hasOwn(body, key));

export function registerSwayReverseOsmosisRoutes(app: Express, dependencies: ProfileSyncDependencies) {
  const externalOrigin = dependencies.externalOrigin ? new URL(dependencies.externalOrigin).origin : null;
  async function context(req: Request, res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const access = await dependencies.requireTalentAccess(req);
    if (access.allowed === false) { res.status(access.status).json({ error: access.reason }); return null; }
    const actorId = access.actor?.actorId;
    const db = dependencies.database();
    if (!actorId || !db) { res.status(503).json({ error: 'Profile updates need a durable database connection.' }); return null; }
    const owner = await dependencies.loadOwnedPerformer(actorId);
    if (!owner) { res.status(403).json({ error: 'Only the profile owner can review these updates.' }); return null; }
    if (req.query.handle !== undefined && req.query.handle !== owner.handle) {
      res.status(409).json({ error: 'Reload the intended performer profile before continuing.' }); return null;
    }
    if (req.method === 'POST') {
      if (!req.is('application/json')) { res.status(415).json({ error: 'A profile review must use a JSON request.' }); return null; }
      const origin = req.get('origin');
      const requestOrigin = `${req.protocol}://${req.get('host')}`;
      const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(req.hostname);
      // Render terminates TLS before Express. Use the existing canonical application
      // origin, rather than accepting arbitrary forwarded-protocol/host headers.
      const trustedOrigin = origin === externalOrigin || (origin === requestOrigin && (externalOrigin === null || loopback));
      if (origin && !trustedOrigin) {
        res.status(403).json({ error: 'Open this review from your Sway profile.' }); return null;
      }
    }
    return { owner, service: createSwayReverseOsmosisService(db, actorId, { performerId: owner.performerId }) };
  }
  function failure(res: Response, error: unknown) {
    const code = error instanceof Error ? error.message : '';
    if (['owner-required', 'proposal-not-found', 'selected-profile-mismatch'].includes(code)) {
      return res.status(403).json({ error: 'Your access to this profile changed. Reload before continuing.' });
    }
    if (['business-asset-required', 'business-binding-required', 'business-binding-changed', 'proposal-integrity'].includes(code)) {
      return res.status(409).json({ error: 'This exact business account needs fresh verification. No update was authorized.' });
    }
    if (['native-version-conflict', 'review-mismatch', 'exact-approval-required', 'approval-expired-or-revoked', 'operation-payload-conflict'].includes(code)) {
      return res.status(409).json({ error: 'The profile or approval changed. Review a fresh preview before continuing.' });
    }
    if (['target-reconciliation-required', 'effect-uncertain-reconciliation-required'].includes(code)) {
      return res.status(409).json({ error: 'An earlier update needs its delivery checked. Check its saved outcome before another action.', outcome: { status: 'held' } });
    }
    // Database/parser errors may contain SQL or connection details; never expose them.
    return res.status(503).json({ error: 'Sway could not confirm this update. Check its saved outcome before trying another action.' });
  }
  const route = (handler: (req: Request, res: Response, c: NonNullable<Awaited<ReturnType<typeof context>>>) => Promise<unknown>) =>
    async (req: Request, res: Response) => { try { const c = await context(req, res); if (c) await handler(req, res, c); } catch (error) { failure(res, error); } };

  app.get('/api/talent/profile/sync', route(async (_req, res, c) => res.json(await c.service.status(c.owner.performerId))));
  app.post('/api/talent/profile/sync/preview', route(async (req, res, c) => {
    if (!exactBody(req.body, ['bindingId']) || !uuid(req.body.bindingId)) return res.status(422).json({ error: 'Choose one verified business account.' });
    const snapshot = await c.service.status(c.owner.performerId);
    if (!snapshot.bindings.some(binding => binding.id === req.body.bindingId)) return res.status(409).json({ error: 'This exact business account needs fresh verification.' });
    // The server captures saved native fields and revision. Clients cannot invent a source event or substitute private fields.
    const result = await c.service.createProposal({ bindingId: req.body.bindingId, direction: 'native-to-social', eventId: randomUUID(), sourceVersion: snapshot.nativeVersion, expectedNativeVersion: snapshot.nativeVersion, fields: snapshot.fields });
    res.status(201).json(result);
  }));
  app.post('/api/talent/profile/sync/:proposalId/approve', route(async (req, res, c) => {
    if (!uuid(req.params.proposalId) || !exactBody(req.body, ['confirmed', 'payloadDigest', 'expectedNativeVersion', 'businessBindingRevision']) || req.body.confirmed !== true
      || !['payloadDigest', 'expectedNativeVersion', 'businessBindingRevision'].every(key => typeof req.body[key] === 'string')) {
      return res.status(422).json({ error: 'Review the exact business account and changes, then explicitly approve them.' });
    }
    const { payloadDigest, expectedNativeVersion, businessBindingRevision } = req.body;
    res.status(201).json(await c.service.approveExact(req.params.proposalId, { payloadDigest, expectedNativeVersion, businessBindingRevision }));
  }));
  app.post('/api/talent/profile/sync/:proposalId/run', route(async (req, res, c) => {
    if (!uuid(req.params.proposalId) || !exactBody(req.body, ['approvalId']) || !uuid(req.body.approvalId)) return res.status(422).json({ error: 'An exact saved approval is required.' });
    res.json({ outcome: await c.service.run(req.params.proposalId, req.body.approvalId) });
  }));
  app.get('/api/talent/profile/sync/:proposalId/outcome', route(async (req, res, c) => {
    if (!uuid(req.params.proposalId)) return res.status(422).json({ error: 'Choose a saved profile update.' });
    // Owner-scoped bookkeeping remains readable after provider revocation; this endpoint cannot dispatch or release a hold.
    res.json({ outcome: await c.service.readStoredOutcome(req.params.proposalId) ?? null });
  }));
}
