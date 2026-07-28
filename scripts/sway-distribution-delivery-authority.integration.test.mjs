import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { and, eq } from 'drizzle-orm';
import { createSwayDb } from '../src/db/client.ts';
import {
  audioProjectAccessGrants,
  audioProjects,
  musicDistributionDeliveries,
  musicReleaseRecordings,
  musicReleases,
  musicRecordings,
  performers,
  users
} from '../src/db/schema.ts';
import { createSandboxDistributionAdapter } from '../src/server/distribution-adapter.ts';
import { createDistributionDeliveryService } from '../src/server/distribution-delivery-service.ts';

if (process.env.SWAY_DISPOSABLE_MIGRATION_PROOF !== '1') {
  throw new Error('Distribution authority integration requires SWAY_DISPOSABLE_MIGRATION_PROOF=1.');
}
const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error('DATABASE_URL is required.');
const parsedDatabaseUrl = new URL(databaseUrl);
const databaseName = parsedDatabaseUrl.pathname.replace(/^\//, '');
if (!['127.0.0.1', 'localhost', '::1'].includes(parsedDatabaseUrl.hostname)) {
  throw new Error('Distribution authority proof refuses non-local database hosts.');
}
if (!/^sway_distribution_delivery_proof_[a-z0-9_]+$/i.test(databaseName)) {
  throw new Error('Distribution authority proof requires a database named sway_distribution_delivery_proof_* .');
}
const proofDbClient = new Client({ connectionString: databaseUrl });
await proofDbClient.connect();
const proofDbTables = await proofDbClient.query(
  `SELECT count(*)::int AS count FROM pg_tables WHERE schemaname = 'public'`
);
await proofDbClient.end();
if (proofDbTables.rows[0].count !== 0) {
  throw new Error('Distribution authority proof database must be empty.');
}

const db = createSwayDb(databaseUrl);
await migrate(db, { migrationsFolder: 'drizzle' });

const actorIds = {
  owner: randomUUID(),
  delegate: randomUUID(),
  expiringDelegate: randomUUID(),
  unrelated: randomUUID(),
  revoked: randomUUID(),
  expired: randomUUID()
};
await db.insert(users).values(Object.entries(actorIds).map(([label, id]) => ({
  id,
  email: `${label}-${id}@example.test`,
  emailVerifiedAt: new Date()
})));

const [performer] = await db.insert(performers).values({
  ownerUserId: actorIds.owner,
  displayName: 'Distribution authority performer'
}).returning();
const [unrelatedPerformer] = await db.insert(performers).values({
  ownerUserId: actorIds.unrelated,
  displayName: 'Unrelated performer'
}).returning();

const [project] = await db.insert(audioProjects).values({
  performerId: performer.id,
  createdByUserId: actorIds.owner,
  title: 'Distribution authority project'
}).returning();
const [unrelatedProject] = await db.insert(audioProjects).values({
  performerId: unrelatedPerformer.id,
  createdByUserId: actorIds.unrelated,
  title: 'Unrelated project'
}).returning();

await db.insert(audioProjectAccessGrants).values([
  {
    projectId: project.id,
    granteeUserId: actorIds.owner,
    role: 'owner',
    canUploadVersions: true,
    canDownloadOriginals: true,
    canApprove: true,
    canManageRelease: true,
    canManageAccess: true,
    grantedByUserId: actorIds.owner
  },
  {
    projectId: project.id,
    granteeUserId: actorIds.delegate,
    role: 'collaborator',
    canManageRelease: true,
    grantedByUserId: actorIds.owner
  },
  {
    projectId: project.id,
    granteeUserId: actorIds.revoked,
    role: 'collaborator',
    canManageRelease: true,
    grantedByUserId: actorIds.owner,
    revokedAt: new Date(),
    revokedByUserId: actorIds.owner,
    revocationReason: 'Authority proof'
  },
  {
    projectId: project.id,
    granteeUserId: actorIds.expired,
    role: 'collaborator',
    canManageRelease: true,
    grantedByUserId: actorIds.owner,
    expiresAt: new Date(Date.now() - 60_000)
  },
  {
    projectId: unrelatedProject.id,
    granteeUserId: actorIds.unrelated,
    role: 'owner',
    canUploadVersions: true,
    canDownloadOriginals: true,
    canApprove: true,
    canManageRelease: true,
    canManageAccess: true,
    grantedByUserId: actorIds.unrelated
  }
]);

const [release] = await db.insert(musicReleases).values({
  performerId: performer.id,
  projectId: project.id,
  title: 'Authority proof release',
  primaryArtistName: 'Authority proof artist',
  releaseType: 'single',
  distributionMode: 'sway_first',
  status: 'ready',
  originalReleaseDate: '2026-07-26',
  territories: ['US']
}).returning();
const [recording] = await db.insert(musicRecordings).values({
  performerId: performer.id,
  projectId: project.id,
  title: 'Authority proof recording',
  primaryArtistName: 'Authority proof artist',
  originalReleaseDate: '2026-07-26',
  rightsStatus: 'cleared'
}).returning();
await db.insert(musicReleaseRecordings).values({
  releaseId: release.id,
  recordingId: recording.id,
  trackNumber: 1
});

const adapter = createSandboxDistributionAdapter({ secret: 'distribution-authority-proof' });
const service = createDistributionDeliveryService({
  db,
  adapters: { sway_sandbox: adapter }
});

for (const [label, actorUserId] of [
  ['unrelated performer', actorIds.unrelated],
  ['revoked delegate', actorIds.revoked],
  ['expired delegate', actorIds.expired]
]) {
  await assert.rejects(
    service.createDelivery({
      releaseId: release.id,
      actorUserId,
      providerKey: 'sway_sandbox',
      destinationKey: `${label.replace(/\s/g, '_')}_destination`
    }),
    { message: 'Release not found or unavailable.' },
    `${label} must not create a delivery`
  );
}

const delivery = await service.createDelivery({
  releaseId: release.id,
  actorUserId: actorIds.delegate,
  providerKey: 'sway_sandbox',
  destinationKey: 'spotify'
});
assert.equal(delivery.releaseId, release.id, 'An active canManageRelease delegate may create a sandbox delivery.');

const missingDeliveryId = randomUUID();
for (const actorUserId of [actorIds.unrelated, actorIds.revoked, actorIds.expired]) {
  await assert.rejects(
    service.submitDelivery({ deliveryId: delivery.id, actorUserId }),
    { message: 'Distribution delivery not found or unavailable.' }
  );
  await assert.rejects(
    service.submitDelivery({ deliveryId: missingDeliveryId, actorUserId }),
    { message: 'Distribution delivery not found or unavailable.' }
  );
}

const submitted = await service.submitDelivery({
  deliveryId: delivery.id,
  actorUserId: actorIds.delegate
});
assert.equal(submitted.delivery.deliveryStatus, 'submitted');
assert.equal(submitted.alreadySubmitted, false);

await db.update(audioProjectAccessGrants)
  .set({
    revokedAt: new Date(),
    revokedByUserId: actorIds.owner,
    revocationReason: 'Provider callback continuity proof'
  })
  .where(and(
    eq(audioProjectAccessGrants.projectId, project.id),
    eq(audioProjectAccessGrants.granteeUserId, actorIds.delegate)
  ));

await assert.rejects(
  service.submitDelivery({ deliveryId: delivery.id, actorUserId: actorIds.delegate }),
  { message: 'Distribution delivery not found or unavailable.' },
  'A revoked originating delegate must lose all manual delivery authority.'
);

async function confirmAcceptedThenLive({
  deliveryId,
  providerReleaseId,
  destinationKey,
  eventPrefix
}) {
  const accepted = adapter.signWebhookEvent({
    providerEventId: `${eventPrefix}-accepted`,
    providerReleaseId,
    destinationKey,
    status: 'accepted',
    destinationReleaseId: `${eventPrefix}-destination`,
    error: null
  });
  await service.ingestWebhook({
    providerKey: 'sway_sandbox',
    rawBody: accepted.rawBody,
    signatureHeader: accepted.signatureHeader
  });
  const live = adapter.signWebhookEvent({
    providerEventId: `${eventPrefix}-live`,
    providerReleaseId,
    destinationKey,
    status: 'live',
    destinationReleaseId: `${eventPrefix}-destination`,
    error: null
  });
  await service.ingestWebhook({
    providerKey: 'sway_sandbox',
    rawBody: live.rawBody,
    signatureHeader: live.signatureHeader
  });
  const [row] = await db
    .select()
    .from(musicDistributionDeliveries)
    .where(eq(musicDistributionDeliveries.id, deliveryId));
  assert.equal(row.deliveryStatus, 'live');
}

await confirmAcceptedThenLive({
  deliveryId: delivery.id,
  providerReleaseId: submitted.delivery.providerReleaseId,
  destinationKey: 'spotify',
  eventPrefix: 'revoked-origin'
});
await assert.rejects(
  service.requestTakedown({
    deliveryId: delivery.id,
    actorUserId: actorIds.delegate,
    reason: 'Revoked actors cannot perform manual operations.'
  }),
  { message: 'Distribution delivery not found or unavailable.' }
);

await db.insert(audioProjectAccessGrants).values({
  projectId: project.id,
  granteeUserId: actorIds.expiringDelegate,
  role: 'collaborator',
  canManageRelease: true,
  grantedByUserId: actorIds.owner,
  expiresAt: new Date(Date.now() + 2_000)
});
const expiringDelivery = await service.createDelivery({
  releaseId: release.id,
  actorUserId: actorIds.expiringDelegate,
  providerKey: 'sway_sandbox',
  destinationKey: 'apple_music'
});
const expiringSubmitted = await service.submitDelivery({
  deliveryId: expiringDelivery.id,
  actorUserId: actorIds.expiringDelegate
});
await new Promise((resolve) => setTimeout(resolve, 2_200));
await assert.rejects(
  service.submitDelivery({
    deliveryId: expiringDelivery.id,
    actorUserId: actorIds.expiringDelegate
  }),
  { message: 'Distribution delivery not found or unavailable.' }
);
await confirmAcceptedThenLive({
  deliveryId: expiringDelivery.id,
  providerReleaseId: expiringSubmitted.delivery.providerReleaseId,
  destinationKey: 'apple_music',
  eventPrefix: 'expired-origin'
});

console.log('Distribution delivery authority integration proof passed.');
process.exit(0);
