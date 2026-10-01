import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { createReverseOsmosisEngine, type Proposal, type ProposalInput, type ExactApproval, type NativePort, type DurableOutcome, type BusinessAssetEvidence } from '../../vendor/infinity-reverse-osmosis/dist/src/index.js';
import { normalizePublicProfileText } from './public-profile';

// Structural port supports both the existing Pg database and the isolated PGlite proof.
export interface ReverseOsmosisDatabase {
  execute(query: SQL): Promise<any>;
  transaction<T>(body: (tx: any) => Promise<T>): Promise<T>;
}
export type SwayReverseOsmosisInput = Omit<ProposalInput, 'scope'> & { bindingId: string };
export type SwayExactReview = Pick<Proposal, 'payloadDigest' | 'expectedNativeVersion' | 'businessBindingRevision'>;
export interface SwayReverseOsmosisOptions {
  performerId?: string;
  // Only a trusted server composition may supply an existing authorized transport.
  publish?: (proposal: Proposal, operationKey: string) => Promise<Record<string, string>>;
}
const rows = (result: any): any[] => Array.isArray(result) ? result : result.rows;
const one = async (db: ReverseOsmosisDatabase, q: SQL) => rows(await db.execute(q))[0];
const fail = (message: string): never => { throw new Error(message); };
const stable = (v: any): string => JSON.stringify(v, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value);
const inputOf = (p: Proposal): ProposalInput => {
  const { payloadDigest: _d, operationKey: _k, businessBindingRevision: _b, ...input } = p;
  return input;
};
const fieldsOf = (value: unknown): Record<string, string | null> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('invalid-profile-fields');
  const fields: Record<string, string | null> = {};
  const limits: Record<string, number> = { bio: 1200, headline: 140, city: 80 };
  for (const [key, raw] of Object.entries(value)) {
    if (!Object.hasOwn(limits, key) || (typeof raw !== 'string' && raw !== null)) fail('invalid-profile-fields');
    fields[key] = normalizePublicProfileText(raw, limits[key]);
  }
  if (!Object.keys(fields).length) fail('empty-profile-fields');
  return fields;
};

export function createSwayReverseOsmosisService(db: ReverseOsmosisDatabase, actorId: string, options: SwayReverseOsmosisOptions = {}) {
  if (!actorId) fail('owner-required');
  const claims = new WeakMap<object, { id: string; token: string; p: Proposal; a: ExactApproval }>();
  async function owned(tx: ReverseOsmosisDatabase, performerId: string, lock = false) {
    if (options.performerId && options.performerId !== performerId) fail('selected-profile-mismatch');
    const p = await one(tx, sql`SELECT * FROM performers WHERE id=${performerId} AND owner_user_id=${actorId} ${lock ? sql`FOR UPDATE` : sql``}`);
    if (!p) fail('owner-required');
    return p;
  }
  async function binding(tx: ReverseOsmosisDatabase, id: string, lock = false) {
    const b = await one(tx, sql`SELECT * FROM sway_ro_business_bindings WHERE id=${id} ${lock ? sql`FOR UPDATE` : sql``}`);
    if (!b || b.owner_id !== actorId) fail('business-binding-required');
    return b;
  }
  function evidence(b: any, p: ProposalInput): BusinessAssetEvidence {
    return { scope: { product: 'sway', businessId: b.business_id, ownerId: b.owner_id, tenantId: b.tenant_id, subjectId: b.performer_id, provider: b.provider, accountId: b.account_id },
      assetKind: b.asset_kind, providerVerified: b.provider_verified, ownerAuthorized: b.owner_authorized, revoked: b.revoked,
      verifiedAt: new Date(b.verified_at).getTime(), expiresAt: new Date(b.expires_at).getTime(), providerAssetId: b.account_id,
      nativeBusinessId: b.business_id, nativeSubjectId: b.performer_id, authorizedOwnerId: b.owner_id, bindingRevision: b.revision };
  }
  async function record(id: string) {
    const r = await one(db, sql`SELECT * FROM sway_ro_proposals WHERE id=${id} AND actor_id=${actorId}`);
    if (!r) fail('proposal-not-found');
    await owned(db, r.performer_id);
    return r;
  }
  async function current(tx: ReverseOsmosisDatabase, r: any, a?: ExactApproval, requireVersion = true) {
    const native = await owned(tx, r.performer_id, true);
    const b = await binding(tx, r.binding_id, true);
    const stored = await one(tx, sql`SELECT * FROM sway_ro_proposals WHERE id=${r.id} AND actor_id=${actorId} FOR UPDATE`);
    if (!stored || stable(stored.proposal) !== stable(r.proposal)) fail('proposal-integrity');
    const p: Proposal = stored.proposal;
    fieldsOf(p.fields);
    // The shared core owns ALL business asset policy, also at the locked effect boundary.
    const verifier = createReverseOsmosisEngine({ ...port, verifyBusinessAsset: async () => evidence(b, p) });
    const fresh = await verifier.propose(inputOf(p));
    if (fresh.payloadDigest !== p.payloadDigest || fresh.operationKey !== p.operationKey || fresh.businessBindingRevision !== p.businessBindingRevision) fail('business-binding-changed');
    if (a) {
      const approval = await one(tx, sql`SELECT * FROM sway_ro_approvals WHERE id=${a.approvalId} AND proposal_id=${r.id} AND actor_id=${actorId} FOR UPDATE`);
      if (!approval || approval.revoked_at || new Date(approval.expires_at).getTime() <= Date.now() || stable(approval.approval) !== stable(a)) fail('exact-approval-required');
    }
    if (requireVersion && String(native.public_profile_revision) !== p.expectedNativeVersion) fail('native-version-conflict');
    return { native, p };
  }
  const outcome = (o: any, p: Proposal): DurableOutcome => ({ operationKey: p.operationKey, payloadDigest: p.payloadDigest, status: o.status === 'claimed' ? 'held' : o.status, ...(o.receipt == null ? {} : { receipt: o.receipt }) });
  async function reflection(tx: ReverseOsmosisDatabase, p: Proposal) {
    if (!p.causalProvenance) return false;
    const prior = await one(tx, sql`SELECT o.*, q.proposal FROM sway_ro_operations o JOIN sway_ro_proposals q ON q.id=o.proposal_id WHERE o.operation_key=${p.causalProvenance} AND q.actor_id=${actorId}`);
    if (!prior || prior.status !== 'completed') return false;
    const old: Proposal = prior.proposal;
    return stable(old.scope) === stable(p.scope) && old.direction !== p.direction && stable(old.fields) === stable(p.fields) && prior.receipt?.sourceVersion === p.sourceVersion;
  }
  const port: NativePort = {
    verifyBusinessAsset: async (p) => {
      await owned(db, p.scope.subjectId);
      const b = await one(db, sql`SELECT * FROM sway_ro_business_bindings WHERE performer_id=${p.scope.subjectId} AND provider=${p.scope.provider} AND account_id=${p.scope.accountId} AND owner_id=${actorId}`);
      if (!b) fail('business-binding-required');
      return evidence(b, p);
    },
    authorizeAndClaim: async ({ proposal: p, approval: a }) => db.transaction(async (tx) => {
      const r = await recordByOperation(tx, p);
      await current(tx, r, a, false);
      const existing = await one(tx, sql`SELECT * FROM sway_ro_operations WHERE operation_key=${p.operationKey} FOR UPDATE`);
      if (existing) {
        if (existing.payload_digest !== p.payloadDigest) fail('operation-payload-conflict');
        return { kind: 'outcome' as const, outcome: outcome(existing, p) };
      }
      await current(tx, r, a);
      const unresolved = await one(tx, sql`SELECT o.operation_key FROM sway_ro_operations o JOIN sway_ro_proposals q ON q.id=o.proposal_id WHERE q.performer_id=${r.performer_id} AND o.status IN ('claimed','held') LIMIT 1`);
      if (unresolved) fail('target-reconciliation-required');
      const token = randomUUID();
      const reflected = await reflection(tx, p);
      await tx.execute(sql`INSERT INTO sway_ro_operations(operation_key,proposal_id,payload_digest,approval_id,claim_token,status) VALUES(${p.operationKey},${r.id},${p.payloadDigest},${a.approvalId},${token},${reflected ? 'reflected' : 'claimed'})`);
      if (reflected) return { kind: 'outcome' as const, outcome: { operationKey: p.operationKey, payloadDigest: p.payloadDigest, status: 'reflected' as const } };
      const claim = Object.freeze({}); claims.set(claim, { id: r.id, token, p, a });
      return { kind: 'claimed' as const, claim };
    }),
    executeClaimed: async (claim) => {
      const c = claims.get(claim); if (!c) fail('invalid-native-claim');
      return db.transaction(async (tx) => {
        const r = await recordByOperation(tx, c.p);
        await current(tx, r, c.a);
        const operation = await one(tx, sql`SELECT * FROM sway_ro_operations WHERE operation_key=${c.p.operationKey} FOR UPDATE`);
        if (!operation || operation.claim_token !== c.token || operation.status !== 'claimed') fail('invalid-native-claim');
        let receipt: Record<string, string>;
        if (c.p.direction === 'native-to-social') {
          if (!options.publish) {
            await tx.execute(sql`UPDATE sway_ro_operations SET status='held', receipt=${JSON.stringify({ reason: 'provider-transport-unavailable' })}::jsonb, updated_at=now() WHERE operation_key=${c.p.operationKey}`);
            return outcome({ status: 'held', receipt: { reason: 'provider-transport-unavailable' } }, c.p);
          }
          const delivered = await options.publish(c.p, c.p.operationKey);
          if (typeof delivered?.providerReceiptId !== 'string' || !delivered.providerReceiptId || typeof delivered?.sourceVersion !== 'string' || !delivered.sourceVersion) fail('provider-delivery-not-confirmed');
          receipt = { providerReceiptId: delivered.providerReceiptId, sourceVersion: delivered.sourceVersion };
        } else {
          const f = fieldsOf(c.p.fields);
          if ('bio' in f) await tx.execute(sql`UPDATE performers SET bio=${f.bio}, updated_at=now() WHERE id=${r.performer_id}`);
          await tx.execute(sql`INSERT INTO performer_public_profiles(performer_id) VALUES(${r.performer_id}) ON CONFLICT DO NOTHING`);
          if ('headline' in f) await tx.execute(sql`UPDATE performer_public_profiles SET headline=${f.headline}, updated_at=now() WHERE performer_id=${r.performer_id}`);
          if ('city' in f) await tx.execute(sql`UPDATE performer_public_profiles SET city=${f.city}, updated_at=now() WHERE performer_id=${r.performer_id}`);
          const updated = await one(tx, sql`UPDATE performers SET public_profile_revision=public_profile_revision+1,updated_at=now() WHERE id=${r.performer_id} RETURNING public_profile_revision`);
          receipt = { nativeVersion: String(updated.public_profile_revision), sourceVersion: String(updated.public_profile_revision) };
        }
        await tx.execute(sql`UPDATE sway_ro_operations SET status='completed',receipt=${JSON.stringify(receipt)}::jsonb,updated_at=now() WHERE operation_key=${c.p.operationKey}`);
        await tx.execute(sql`INSERT INTO audit_events(event_id,actor_type,actor_id,entity_type,entity_id,event_type,metadata) VALUES(${randomUUID()},'user',${actorId},'performer',${r.performer_id},'reverse_osmosis_completed',${JSON.stringify({ operationKey: c.p.operationKey, payloadDigest: c.p.payloadDigest, direction: c.p.direction })}::jsonb)`);
        return outcome({ status: 'completed', receipt }, c.p);
      });
    },
    holdUncertain: async (claim) => {
      const c = claims.get(claim); if (!c) fail('invalid-native-claim');
      await db.execute(sql`UPDATE sway_ro_operations SET status='held',updated_at=now() WHERE operation_key=${c.p.operationKey} AND claim_token=${c.token} AND status='claimed'`);
    },
    readOutcome: async (p) => db.transaction(async (tx) => {
      const r = await recordByOperation(tx, p); await current(tx, r, undefined, false);
      const o = await one(tx, sql`SELECT * FROM sway_ro_operations WHERE operation_key=${p.operationKey}`);
      return o ? outcome(o, p) : undefined;
    }),
    reconcile: async (p) => {
      const existing = await port.readOutcome(p);
      // No delivery/absence verifier is configured. Never infer absence or resend.
      return existing ?? { operationKey: p.operationKey, payloadDigest: p.payloadDigest, status: 'absent' };
    },
    verifyReflection: async (p) => reflection(db, p),
  };
  async function recordByOperation(tx: ReverseOsmosisDatabase, p: Proposal) {
    const r = await one(tx, sql`SELECT * FROM sway_ro_proposals WHERE operation_key=${p.operationKey} AND actor_id=${actorId}`);
    if (!r || r.payload_digest !== p.payloadDigest) fail('operation-payload-conflict');
    return r;
  }
  const engine = createReverseOsmosisEngine(port);
  return {
    async status(performerId: string) {
      const p = await owned(db, performerId);
      const profile = await one(db, sql`SELECT headline,city FROM performer_public_profiles WHERE performer_id=${performerId}`);
      const savedBindings = rows(await db.execute(sql`SELECT * FROM sway_ro_business_bindings WHERE performer_id=${performerId} AND owner_id=${actorId}`));
      const bindings: { id: string; businessId: string; subjectId: string; provider: string; accountId: string; revision: string }[] = [];
      for (const b of savedBindings) {
        try {
          await engine.propose({ scope: evidence(b, {} as ProposalInput).scope, direction: 'native-to-social', eventId: 'binding-status', sourceVersion: String(p.public_profile_revision), expectedNativeVersion: String(p.public_profile_revision), fields: {} });
          bindings.push({ id: b.id, businessId: b.business_id, subjectId: b.performer_id, provider: b.provider, accountId: b.account_id, revision: b.revision });
        } catch { /* Central policy rejected this binding; it cannot be offered as verified. */ }
      }
      const proposals = rows(await db.execute(sql`SELECT q.id,q.proposal,a.id AS approval_id,o.status,o.receipt FROM sway_ro_proposals q LEFT JOIN sway_ro_approvals a ON a.proposal_id=q.id LEFT JOIN sway_ro_operations o ON o.proposal_id=q.id WHERE q.performer_id=${performerId} AND q.actor_id=${actorId} ORDER BY q.created_at DESC LIMIT 30`));
      return { nativeVersion: String(p.public_profile_revision), fields: { bio: p.bio, headline: profile?.headline ?? null, city: profile?.city ?? null }, bindings, proposals, providerPublishingAvailable: Boolean(options.publish) };
    },
    async createProposal(input: SwayReverseOsmosisInput) {
      const b = await binding(db, input.bindingId);
      await owned(db, b.performer_id);
      const { bindingId, ...data } = input;
      const proposal = await engine.propose({ ...data, fields: fieldsOf(input.fields), scope: evidence(b, {} as ProposalInput).scope });
      return db.transaction(async (tx) => {
        await owned(tx, b.performer_id, true); await binding(tx, bindingId, true);
        const prior = await one(tx, sql`SELECT * FROM sway_ro_proposals WHERE operation_key=${proposal.operationKey}`);
        if (prior) {
          if (prior.actor_id !== actorId || prior.payload_digest !== proposal.payloadDigest) fail('operation-payload-conflict');
          return { id: prior.id as string, proposal: prior.proposal as Proposal };
        }
        const id = randomUUID();
        await tx.execute(sql`INSERT INTO sway_ro_proposals(id,binding_id,performer_id,actor_id,operation_key,payload_digest,proposal) VALUES(${id},${bindingId},${b.performer_id},${actorId},${proposal.operationKey},${proposal.payloadDigest},${JSON.stringify(proposal)}::jsonb)`);
        return { id, proposal };
      });
    },
    async approveExact(proposalId: string, review: SwayExactReview) {
      const r = await record(proposalId);
      return db.transaction(async (tx) => {
        const { p } = await current(tx, r);
        if (review.payloadDigest !== p.payloadDigest || review.expectedNativeVersion !== p.expectedNativeVersion || review.businessBindingRevision !== p.businessBindingRevision) fail('review-mismatch');
        const existing = await one(tx, sql`SELECT * FROM sway_ro_approvals WHERE proposal_id=${proposalId}`);
        if (existing) {
          if (existing.revoked_at || new Date(existing.expires_at).getTime() <= Date.now()) fail('approval-expired-or-revoked');
          return { id: existing.id as string, approval: existing.approval as ExactApproval };
        }
        const id = randomUUID();
        const { fields: _f, operationKey: _k, causalProvenance: _c, ...exact } = p;
        const approval: ExactApproval = { ...exact, approvalId: id };
        await tx.execute(sql`INSERT INTO sway_ro_approvals(id,proposal_id,actor_id,approval,expires_at) VALUES(${id},${proposalId},${actorId},${JSON.stringify(approval)}::jsonb,${new Date(Date.now()+300000)})`);
        return { id, approval };
      });
    },
    async run(proposalId: string, approvalId: string) {
      const r = await record(proposalId);
      const a = await one(db, sql`SELECT * FROM sway_ro_approvals WHERE id=${approvalId} AND proposal_id=${proposalId} AND actor_id=${actorId}`);
      if (!a) fail('exact-approval-required');
      return r.proposal.direction === 'social-to-native' ? engine.apply(r.proposal, a.approval) : engine.publish(r.proposal, a.approval);
    },
    async readOutcome(proposalId: string) { return engine.authorizedOutcome((await record(proposalId)).proposal); },
    async readStoredOutcome(proposalId: string): Promise<DurableOutcome | undefined> {
      // Native bookkeeping disclosure has owner authority even if the connection expires.
      // It cannot authorize a provider action or manufacture a delivery/absence decision.
      const r = await record(proposalId);
      return db.transaction(async (tx) => {
        await owned(tx, r.performer_id, true);
        const o = await one(tx, sql`SELECT * FROM sway_ro_operations WHERE proposal_id=${proposalId}`);
        if (!o) return undefined;
        if (o.operation_key !== r.proposal.operationKey || o.payload_digest !== r.proposal.payloadDigest) fail('outcome-mismatch');
        return outcome(o, r.proposal);
      });
    },
    async reconcile(proposalId: string) { return engine.reconcile((await record(proposalId)).proposal); },
  };
}
