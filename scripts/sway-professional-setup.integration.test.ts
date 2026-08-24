import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { closeDisposableSwayDbProof, createSwayDb } from '../src/db/client';
import {
  createTalentProfessionalSetupService,
  TalentProfessionalSetupError
} from '../src/server/talent-professional-setup-service';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

async function main() {
  const proof = await startEmbeddedPostgresProof('professional_setup');
  const db = createSwayDb(proof.databaseUrl);
  try {
    const ids = {
      owner: randomUUID(),
      otherOwner: randomUUID(),
      noPerformer: randomUUID(),
      admin: randomUUID(),
      multiOwner: randomUUID(),
      performer: randomUUID(),
      otherPerformer: randomUUID(),
      multiPerformerA: randomUUID(),
      multiPerformerB: randomUUID()
    };
    await proof.query(
      `insert into users (id, email, display_name, role, email_verified_at, pro_mode_status)
       values ($1, 'owner@example.test', 'Owner', 'performer', now(), 'active'),
              ($2, 'other@example.test', 'Other', 'performer', now(), 'active'),
              ($3, 'none@example.test', 'No performer', 'performer', now(), 'active'),
              ($4, 'admin@example.test', 'Admin', 'admin', now(), 'disabled'),
              ($5, 'multi@example.test', 'Multiple owner', 'performer', now(), 'active')`,
      [ids.owner, ids.otherOwner, ids.noPerformer, ids.admin, ids.multiOwner]
    );
    await proof.query(
      `insert into performers (id, owner_user_id, handle, display_name, is_active, onboarding_status, visibility_state)
       values ($1, $3, 'comic-owner', 'Comic Owner', true, 'profile_started', 'draft'),
              ($2, $4, 'other-owner', 'Other Owner', true, 'profile_started', 'draft'),
              ($5, $7, 'multi-owner-a', 'Multiple Owner A', true, 'profile_started', 'draft'),
              ($6, $7, 'multi-owner-b', 'Multiple Owner B', true, 'profile_started', 'draft')`,
      [ids.performer, ids.otherPerformer, ids.owner, ids.otherOwner, ids.multiPerformerA, ids.multiPerformerB, ids.multiOwner]
    );

    const service = createTalentProfessionalSetupService(db);
    const initial = await service.getState(ids.owner);
    assert.equal(initial.primaryIdentity, null);
    assert.deepEqual(initial.earningModes, []);
    assert.deepEqual(initial.desiredCapabilities, []);
    assert.equal(initial.publication.visibilityState, 'draft');
    assert.equal(initial.publication.managedSeparately, true);

    await assert.rejects(
      () => service.getState(ids.noPerformer),
      (error: unknown) => error instanceof TalentProfessionalSetupError && error.status === 403
    );
    await assert.rejects(
      () => service.getState(ids.multiOwner),
      (error: unknown) => error instanceof TalentProfessionalSetupError
        && error.status === 409
        && error.code === 'ambiguous_owner_subject'
    );
    await assert.rejects(
      () => service.save(ids.multiOwner, {
        clientMutationId: randomUUID(),
        primaryIdentity: { kind: 'comedian', customLabel: null },
        secondaryIdentities: [],
        earningModes: [],
        desiredCapabilities: []
      }),
      (error: unknown) => error instanceof TalentProfessionalSetupError
        && error.status === 409
        && error.code === 'ambiguous_owner_subject'
    );
    const ambiguousOwnerWrites = await proof.query<{ count: number }>(
      `select count(*)::int count from performer_identity_events where performer_id in ($1, $2)`,
      [ids.multiPerformerA, ids.multiPerformerB]
    );
    assert.equal(ambiguousOwnerWrites.rows[0]?.count, 0, 'An ambiguous owner subject must fail closed without ledger writes.');

    const mutationId = randomUUID();
    const firstPayload = {
      clientMutationId: mutationId,
      performerId: ids.otherPerformer,
      primaryIdentity: { kind: 'comedian', customLabel: null },
      secondaryIdentities: [{ kind: 'host', customLabel: null }],
      earningModes: ['live_tips', 'bookings'],
      desiredCapabilities: ['profile_publication', 'live_money', 'native_ticket_sales']
    };
    const saved = await service.save(ids.owner, firstPayload);
    assert.equal(saved.changed, true);
    assert.equal(saved.replayed, false);
    assert.equal(saved.state.primaryIdentity?.kind, 'comedian');
    assert.deepEqual(saved.state.secondaryIdentities.map((identity) => identity.kind), ['host']);
    assert.deepEqual(saved.state.earningModes, ['live_tips', 'bookings']);
    assert.deepEqual(saved.state.desiredCapabilities, ['profile_publication', 'live_money', 'native_ticket_sales']);
    assert.equal(saved.state.publication.visibilityState, 'draft', 'Saving professional setup must not publish.');
    assert.ok(saved.state.capabilityStatuses.every((status) => status.decision === null), 'Owner requests must not create grants.');

    const ownerCounts = await proof.query<{ identities: number; intents: number; grants: number; authorities: number; receipts: number }>(
      `select
         (select count(*)::int from performer_identity_events where performer_id = $1) identities,
         (select count(*)::int from performer_intent_events where performer_id = $1) intents,
         (select count(*)::int from performer_capability_grant_events where performer_id = $1) grants,
         (select count(*)::int from performer_authority_events where performer_id = $1) authorities,
         (select count(*)::int from audit_events where entity_id = $1 and event_type = 'professional_setup.update') receipts`,
      [ids.performer]
    );
    assert.deepEqual(ownerCounts.rows[0], { identities: 2, intents: 5, grants: 0, authorities: 0, receipts: 1 });
    const otherCounts = await proof.query<{ identities: number }>(
      'select count(*)::int identities from performer_identity_events where performer_id = $1',
      [ids.otherPerformer]
    );
    assert.equal(otherCounts.rows[0]?.identities, 0, 'A caller performerId must never redirect owner-scoped setup writes.');

    const replay = await service.save(ids.owner, firstPayload);
    assert.equal(replay.replayed, true);
    assert.equal(replay.changed, false);
    const replayCounts = await proof.query<{ identities: number; intents: number; receipts: number }>(
      `select
         (select count(*)::int from performer_identity_events where performer_id = $1) identities,
         (select count(*)::int from performer_intent_events where performer_id = $1) intents,
         (select count(*)::int from audit_events where entity_id = $1 and event_type = 'professional_setup.update') receipts`,
      [ids.performer]
    );
    assert.deepEqual(replayCounts.rows[0], { identities: 2, intents: 5, receipts: 1 });

    await assert.rejects(
      () => service.save(ids.owner, { ...firstPayload, earningModes: ['services'] }),
      (error: unknown) => error instanceof TalentProfessionalSetupError
        && error.status === 409
        && error.code === 'mutation_reuse_conflict'
    );

    const switched = await service.save(ids.owner, {
      clientMutationId: randomUUID(),
      primaryIdentity: { kind: 'bartender', customLabel: null },
      secondaryIdentities: [],
      earningModes: ['services'],
      desiredCapabilities: ['service_inquiries']
    });
    assert.equal(switched.state.primaryIdentity?.kind, 'bartender');
    assert.deepEqual(switched.state.secondaryIdentities, []);
    assert.deepEqual(switched.state.earningModes, ['services']);
    assert.deepEqual(switched.state.desiredCapabilities, ['service_inquiries']);
    assert.equal(switched.state.publication.visibilityState, 'draft');

    await proof.query(
      `insert into performer_capability_grant_events (
         performer_id, capability, decision, actor_type, actor_user_id, reason, evidence,
         idempotency_key_hash
       ) values ($1, 'service_inquiries', 'granted', 'admin', $2,
         'Abuse controls reviewed', '{"reference":"setup-proof-grant"}'::jsonb, $3)`,
      [ids.performer, ids.admin, hash('professional-setup-admin-grant')]
    );
    const granted = await service.getState(ids.owner);
    const serviceInquiry = granted.capabilityStatuses.find((status) => status.capability === 'service_inquiries');
    assert.equal(serviceInquiry?.requested, true);
    assert.equal(serviceInquiry?.decision, 'granted');
    assert.equal(serviceInquiry?.grantCurrent, true);

    const receipts = await proof.query<{ event_id: string }>(
      `select event_id from audit_events
       where entity_id = $1 and event_type = 'professional_setup.update'
       order by created_at asc`,
      [ids.performer]
    );
    assert.equal(receipts.rowCount, 2);
    await assert.rejects(
      () => proof.query('delete from audit_events where event_id = $1', [receipts.rows[0]?.event_id]),
      /append-only/i
    );

    console.log('Sway professional setup integration test passed (39 migrations).');
  } finally {
    await closeDisposableSwayDbProof(proof.databaseUrl);
    await proof.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
