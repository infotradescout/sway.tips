import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { closeDisposableSwayDbProof, createSwayDb } from '../src/db/client';
import {
  createAccountDiscoveryAttributionService,
  createDiscoveryAttributionReceipt,
  DISCOVERY_ATTRIBUTION_RECEIPT_TTL_MS,
  resolveReceiptBackedAttributionEvidence,
  resolveServerObservedAttributionEvidence,
  type ServerObservedAttributionEvidence
} from '../src/server/account-discovery-attribution';
import { discoveryEntityUuid } from '../src/server/discovery-observatory';
import { createDiscoveryObservatoryStore } from '../src/server/discovery-observatory-store';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof';

const RECEIPT_SECRET = 'signup-attribution-proof-secret-2026-08-21';
const TRUSTED_ORIGIN = 'https://app.sway.tips';

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function createSignedUnverifiedEvidence(campaign: string, now: Date) {
  const landingUrl = `${TRUSTED_ORIGIN}/discover?utm_source=google&utm_medium=organic&utm_campaign=${campaign}`;
  const receipt = createDiscoveryAttributionReceipt({
    landingUrl,
    allowedOrigins: [TRUSTED_ORIGIN],
    entryPath: '/discover',
    secret: RECEIPT_SECRET,
    referrer: 'https://www.google.com/search?q=sway+tips',
    fetchSite: 'cross-site',
    fetchMode: 'navigate',
    fetchDest: 'document',
    now
  });
  assert.ok(receipt);
  const evidence = resolveReceiptBackedAttributionEvidence({
    receipt,
    secret: RECEIPT_SECRET,
    entryPath: '/discover',
    clientChannel: 'other',
    now
  });
  assert.equal(evidence.linkStrength, 'client_correlated_unverified');
  assert.equal(evidence.sourceClass, 'unknown');
  assert.equal(evidence.claimedSourceClass, 'organic_unpaid');
  assert.equal(evidence.attributionReceipt, receipt);
  return { receipt, evidence };
}

async function main() {
  const proof = await startEmbeddedPostgresProof('signup_attribution');
  const db = createSwayDb(proof.databaseUrl);
  try {
    const ids = {
      organicUser: randomUUID(),
      conflictingUser: randomUUID(),
      unverifiedUser: randomUUID(),
      unknownUser: randomUUID(),
      duplicateUser: randomUUID(),
      crossJourneyUser: randomUUID(),
      tamperedUser: randomUUID(),
      orphanUser: randomUUID(),
      organicJourney: randomUUID(),
      unverifiedJourney: randomUUID(),
      unknownJourney: randomUUID(),
      duplicateJourney: randomUUID(),
      crossJourneyA: randomUUID(),
      crossJourneyB: randomUUID(),
      tamperedJourney: randomUUID(),
      orphanJourney: randomUUID(),
      receiptReuseJourneyA: randomUUID(),
      receiptReuseJourneyB: randomUUID(),
      missingJourney: randomUUID()
    };
    await proof.query(
      `insert into users (id, email, display_name, role, email_verified_at)
       values ($1, 'organic@example.test', 'Organic signup', 'patron', now()),
              ($2, 'conflict@example.test', 'Conflict signup', 'patron', now()),
              ($3, 'unverified@example.test', 'Unverified signup', 'patron', now()),
              ($4, 'unknown@example.test', 'Unknown signup', 'patron', now()),
              ($5, 'duplicate@example.test', 'Duplicate signup', 'patron', now()),
              ($6, 'cross@example.test', 'Cross journey signup', 'patron', now()),
              ($7, 'tampered@example.test', 'Tampered signup', 'patron', now()),
              ($8, 'orphan@example.test', 'Orphan signup', 'patron', now())`,
      [
        ids.organicUser,
        ids.conflictingUser,
        ids.unverifiedUser,
        ids.unknownUser,
        ids.duplicateUser,
        ids.crossJourneyUser,
        ids.tamperedUser,
        ids.orphanUser
      ]
    );

    const firstTouchAt = new Date(Date.now() - 1_000);
    const landingUrl = `${TRUSTED_ORIGIN}/discover?utm_source=google&utm_medium=organic&utm_campaign=pro-pages`;
    const classifiedOrganic = resolveServerObservedAttributionEvidence({
      landingUrl,
      allowedOrigins: [TRUSTED_ORIGIN],
      entryPath: '/discover',
      clientChannel: 'other',
      referrer: 'https://www.google.com/search?q=sway+tips',
      fetchSite: 'cross-site',
      fetchMode: 'navigate',
      fetchDest: 'document'
    });
    assert.equal(classifiedOrganic.source, 'google');
    assert.equal(classifiedOrganic.sourceClass, 'unknown');
    assert.equal(classifiedOrganic.claimedSourceClass, 'organic_unpaid');
    assert.equal(classifiedOrganic.linkStrength, 'client_correlated_unverified');
    assert.equal(classifiedOrganic.utmCampaign, 'pro-pages');
    assert.equal(classifiedOrganic.attributionReceipt, null);

    const paid = resolveServerObservedAttributionEvidence({
      landingUrl: `${TRUSTED_ORIGIN}/discover?utm_source=facebook&utm_medium=cpc`,
      allowedOrigins: [TRUSTED_ORIGIN],
      entryPath: '/discover',
      clientChannel: 'facebook',
      referrer: 'https://www.facebook.com/',
      fetchSite: 'cross-site',
      fetchMode: 'navigate',
      fetchDest: 'document'
    });
    assert.equal(paid.sourceClass, 'unknown');
    assert.equal(paid.claimedSourceClass, 'paid');
    const spoofedOrigin = resolveServerObservedAttributionEvidence({
      landingUrl: 'https://attacker.example/discover?utm_source=google&utm_medium=organic',
      allowedOrigins: [TRUSTED_ORIGIN],
      entryPath: '/discover',
      clientChannel: 'google',
      referrer: 'https://www.google.com/search?q=sway+tips',
      fetchSite: 'cross-site',
      fetchMode: 'navigate',
      fetchDest: 'document'
    });
    assert.equal(spoofedOrigin.sourceClass, 'unknown');
    assert.equal(spoofedOrigin.linkStrength, 'client_correlated_unverified');
    const directTypedUtm = resolveServerObservedAttributionEvidence({
      landingUrl,
      allowedOrigins: [TRUSTED_ORIGIN],
      entryPath: '/discover',
      clientChannel: 'google',
      referrer: null,
      fetchSite: null,
      fetchMode: null,
      fetchDest: null
    });
    assert.equal(directTypedUtm.sourceClass, 'unknown');
    assert.equal(directTypedUtm.linkStrength, 'client_correlated_unverified');

    const { receipt: organicReceipt, evidence: observedOrganic } = createSignedUnverifiedEvidence('pro-pages', firstTouchAt);
    const tamperedReceipt = `${organicReceipt.slice(0, -1)}${organicReceipt.endsWith('a') ? 'b' : 'a'}`;
    const rejectedTamperedReceipt = resolveReceiptBackedAttributionEvidence({
      receipt: tamperedReceipt,
      secret: RECEIPT_SECRET,
      entryPath: '/discover',
      clientChannel: 'google',
      now: firstTouchAt
    });
    assert.equal(rejectedTamperedReceipt.attributionReceipt, null);
    const rejectedExpiredReceipt = resolveReceiptBackedAttributionEvidence({
      receipt: organicReceipt,
      secret: RECEIPT_SECRET,
      entryPath: '/discover',
      clientChannel: 'google',
      now: new Date(firstTouchAt.getTime() + DISCOVERY_ATTRIBUTION_RECEIPT_TTL_MS + 1)
    });
    assert.equal(rejectedExpiredReceipt.attributionReceipt, null);

    const observatory = createDiscoveryObservatoryStore(db);
    const linker = createAccountDiscoveryAttributionService(db, { receiptSecret: RECEIPT_SECRET });
    const recordEntry = async (
      journeyId: string,
      evidence: ServerObservedAttributionEvidence,
      campaignLabel: string
    ) => observatory.recordJourneyEvent({
      journeyId,
      stage: 'entry',
      eventType: 'discovery_landing',
      occurredAt: firstTouchAt.toISOString(),
      source: evidence.source,
      surface: 'public-discover',
      entryPath: '/discover',
      entityKind: 'performer',
      entityKey: campaignLabel,
      visibilityEligibility: 'eligible',
      linkStrength: evidence.linkStrength
    }, firstTouchAt, { attributionEvidence: evidence });

    // No idempotency key is supplied: this exercises the ordinary HTTP path's
    // writeAuditEvent hashing and the linker's canonical journey lookup.
    await recordEntry(ids.organicJourney, observedOrganic, 'comic-one');
    const linked = await linker.linkFromJourney({
      userId: ids.organicUser,
      journeyId: ids.organicJourney
    }, new Date());
    assert.equal(linked.linked, true);
    const attribution = await proof.query<{
      id: string;
      source_event_id: string;
      source_channel: string;
      source_class: string;
      utm_source: string | null;
      utm_medium: string | null;
      utm_campaign: string | null;
      landing_path: string;
      entity_kind: string | null;
      entity_key: string | null;
      evidence_strength: string;
    }>(
      `select id, source_event_id, source_channel, source_class, utm_source, utm_medium, utm_campaign,
              landing_path, entity_kind, entity_key, evidence_strength
       from account_discovery_attributions where user_id = $1`,
      [ids.organicUser]
    );
    assert.deepEqual({
      source_channel: attribution.rows[0]?.source_channel,
      source_class: attribution.rows[0]?.source_class,
      utm_source: attribution.rows[0]?.utm_source,
      utm_medium: attribution.rows[0]?.utm_medium,
      utm_campaign: attribution.rows[0]?.utm_campaign,
      landing_path: attribution.rows[0]?.landing_path,
      entity_kind: attribution.rows[0]?.entity_kind,
      entity_key: attribution.rows[0]?.entity_key,
      evidence_strength: attribution.rows[0]?.evidence_strength
    }, {
      source_channel: 'google',
      source_class: 'unknown',
      utm_source: 'google',
      utm_medium: 'organic',
      utm_campaign: 'pro-pages',
      landing_path: '/discover',
      entity_kind: 'performer',
      entity_key: 'comic-one',
      evidence_strength: 'client_correlated_unverified'
    });
    assert.equal(discoveryEntityUuid(ids.organicJourney), (await proof.query<{ entity_id: string }>(
      'select entity_id from audit_events where event_id = $1',
      [attribution.rows[0]?.source_event_id]
    )).rows[0]?.entity_id);
    assert.equal((await proof.query<{ contains_email: boolean }>(
      `select metadata::text like '%@%' as contains_email from audit_events where event_id = $1`,
      [attribution.rows[0]?.source_event_id]
    )).rows[0]?.contains_email, false, 'Attribution evidence must not persist account contact data.');

    const replay = await linker.linkFromJourney({ userId: ids.organicUser, journeyId: ids.organicJourney });
    assert.equal(replay.linked, false);
    assert.equal(replay.reason, 'already_linked');
    assert.equal(replay.attributionId, attribution.rows[0]?.id);
    const conflict = await linker.linkFromJourney({ userId: ids.conflictingUser, journeyId: ids.organicJourney });
    assert.equal(conflict.linked, false);
    assert.equal(conflict.reason, 'attribution_conflict');
    assert.equal(conflict.attributionId, attribution.rows[0]?.id);

    const unsafeOrganic: ServerObservedAttributionEvidence = {
      source: 'google', sourceClass: 'organic_unpaid', claimedSourceClass: 'organic_unpaid', linkStrength: 'client_correlated_unverified',
      utmSource: null, utmMedium: null, utmCampaign: null, offlineSource: null,
      referrerHost: null,
      attributionReceipt: null, attributionReceiptId: null
    };
    await recordEntry(ids.unverifiedJourney, unsafeOrganic, 'unverified-entry');
    const unverified = await linker.linkFromJourney({ userId: ids.unverifiedUser, journeyId: ids.unverifiedJourney });
    assert.equal(unverified.linked, false);
    assert.equal(unverified.reason, 'unverified_organic_evidence');

    const unknownEvidence: ServerObservedAttributionEvidence = {
      source: 'google', sourceClass: 'unknown', claimedSourceClass: null, linkStrength: 'client_correlated_unverified',
      utmSource: null, utmMedium: null, utmCampaign: null, offlineSource: null,
      referrerHost: null,
      attributionReceipt: null, attributionReceiptId: null
    };
    await recordEntry(ids.unknownJourney, unknownEvidence, 'unknown-entry');
    const unknown = await linker.linkFromJourney({ userId: ids.unknownUser, journeyId: ids.unknownJourney });
    assert.equal(unknown.linked, true, 'Unknown evidence may be retained but cannot qualify as organic.');
    const missing = await linker.linkFromJourney({ userId: ids.conflictingUser, journeyId: ids.missingJourney });
    assert.equal(missing.linked, false);
    assert.equal(missing.reason, 'no_durable_entry');

    await recordEntry(ids.duplicateJourney, unknownEvidence, 'duplicate-entry');
    const duplicateResults = await Promise.all([
      linker.linkFromJourney({ userId: ids.duplicateUser, journeyId: ids.duplicateJourney }),
      linker.linkFromJourney({ userId: ids.duplicateUser, journeyId: ids.duplicateJourney })
    ]);
    assert.equal(duplicateResults.filter((result) => result.linked).length, 1);
    assert.deepEqual(duplicateResults.filter((result) => !result.linked).map((result) => result.reason), ['already_linked']);
    assert.equal((await proof.query<{ count: number }>(
      'select count(*)::int as count from account_discovery_attributions where user_id = $1', [ids.duplicateUser]
    )).rows[0]?.count, 1);

    await recordEntry(ids.crossJourneyA, unknownEvidence, 'cross-a');
    await recordEntry(ids.crossJourneyB, unknownEvidence, 'cross-b');
    const crossResults = await Promise.all([
      linker.linkFromJourney({ userId: ids.crossJourneyUser, journeyId: ids.crossJourneyA }),
      linker.linkFromJourney({ userId: ids.crossJourneyUser, journeyId: ids.crossJourneyB })
    ]);
    assert.equal(crossResults.filter((result) => result.linked).length, 1);
    assert.deepEqual(crossResults.filter((result) => !result.linked).map((result) => result.reason), ['attribution_conflict']);
    assert.equal((await proof.query<{ count: number }>(
      'select count(*)::int as count from account_discovery_attributions where user_id = $1', [ids.crossJourneyUser]
    )).rows[0]?.count, 1);

    const reusedReceiptEvidence = createSignedUnverifiedEvidence('one-journey-only', firstTouchAt).evidence;
    await recordEntry(ids.receiptReuseJourneyA, reusedReceiptEvidence, 'receipt-reuse-a');
    await assert.rejects(
      () => recordEntry(ids.receiptReuseJourneyB, reusedReceiptEvidence, 'receipt-reuse-b'),
      /already consumed by another journey/i,
      'A signed receipt must be atomically consumed by exactly one journey.'
    );

    const tamperedEvidence = createSignedUnverifiedEvidence('tamper-proof', firstTouchAt).evidence;
    await recordEntry(ids.tamperedJourney, tamperedEvidence, 'tamper-proof');
    await proof.query(
      `update audit_events set metadata = jsonb_set(metadata, '{utm_campaign}', '"forged"'::jsonb)
       where entity_type = 'shell_friction' and entity_id = $1`,
      [discoveryEntityUuid(ids.tamperedJourney)]
    );
    const tampered = await linker.linkFromJourney({ userId: ids.tamperedUser, journeyId: ids.tamperedJourney });
    assert.equal(tampered.linked, false);
    assert.equal(tampered.reason, 'unverified_server_evidence', 'A pre-link metadata edit must break signed evidence verification.');

    const orphanEvidence = createSignedUnverifiedEvidence('orphan-proof', firstTouchAt).evidence;
    await recordEntry(ids.orphanJourney, orphanEvidence, 'orphan-proof');
    const orphan = await linker.linkFromJourney({ userId: ids.orphanUser, journeyId: ids.orphanJourney });
    assert.equal(orphan.linked, true);
    await proof.query('delete from users where id = $1', [ids.orphanUser]);
    await assert.rejects(
      () => proof.query(
        `insert into growth_milestones (
           user_id, performer_id, attribution_id, milestone_kind, evidence_event_id,
           occurred_at, environment, qualification_snapshot, idempotency_key_hash
         ) values ($1, $2, $3, 'qualified_signup', $4, now(), 'production', '{"test":true}'::jsonb, $5)`,
        [ids.orphanUser, randomUUID(), orphan.attributionId, randomUUID(), hash('orphan-qualified-signup')]
      ),
      /existing account/i,
      'A removed or rolled-back account can retain audit attribution but can never become an OQPS milestone.'
    );

    await assert.rejects(
      () => proof.query('update account_discovery_attributions set source_channel = $1 where user_id = $2', ['facebook', ids.organicUser]),
      /append-only/i
    );
    await assert.rejects(
      () => proof.query('delete from account_discovery_attributions where user_id = $1', [ids.organicUser]),
      /append-only/i
    );
    await assert.rejects(
      () => proof.query('update audit_events set event_type = $1 where event_id = $2', ['tampered', attribution.rows[0]?.source_event_id]),
      /immutable/i
    );
    await assert.rejects(
      () => proof.query('delete from audit_events where event_id = $1', [attribution.rows[0]?.source_event_id]),
      /immutable/i
    );

    const replacementEventId = randomUUID();
    await proof.query(
      `insert into audit_events (
         event_id, actor_id, actor_type, entity_type, entity_id, event_type, metadata
       ) values ($1, null, 'anonymous', 'shell_friction', $2, 'discovery_landing', $3::jsonb)`,
      [
        replacementEventId,
        discoveryEntityUuid(ids.organicJourney),
        JSON.stringify({
          journey_id: ids.organicJourney,
          stage: 'entry',
          event_type: 'discovery_landing',
          occurred_at: new Date(firstTouchAt.getTime() - 1_000).toISOString(),
          source: 'unknown',
          source_class: 'unknown',
          surface: 'public-discover',
          entry_path: '/discover',
          entity_kind: 'performer',
          entity_key: 'replacement',
          visibility_eligibility: 'unknown',
          link_strength: 'client_correlated_unverified'
        })
      ]
    );
    const replayAfterReplacement = await linker.linkFromJourney({ userId: ids.organicUser, journeyId: ids.organicJourney });
    assert.equal(replayAfterReplacement.reason, 'already_linked');
    const retained = await proof.query<{ source_event_id: string; utm_campaign: string | null }>(
      'select source_event_id, utm_campaign from account_discovery_attributions where user_id = $1', [ids.organicUser]
    );
    assert.deepEqual(retained.rows[0], {
      source_event_id: attribution.rows[0]?.source_event_id,
      utm_campaign: 'pro-pages'
    }, 'A later replacement event cannot rewrite the immutable first-touch snapshot.');

    const counts = await proof.query<{ attributions: number; milestones: number }>(
      `select
         (select count(*)::int from account_discovery_attributions) attributions,
         (select count(*)::int from growth_milestones) milestones`
    );
    assert.deepEqual(counts.rows[0], { attributions: 5, milestones: 0 });

    console.log('Sway signup attribution integration test passed (39 migrations).');
  } finally {
    await closeDisposableSwayDbProof(proof.databaseUrl);
    await proof.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
