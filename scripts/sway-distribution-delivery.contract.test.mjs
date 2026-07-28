import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import 'tsx/esm';

process.on('uncaughtException', (error) => {
  console.error('Distribution delivery contract failed:', error);
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  console.error('Distribution delivery contract failed:', error);
  process.exit(1);
});

const {
  SANDBOX_DISTRIBUTION_PROVIDER_KEY,
  createSandboxDistributionAdapter
} = await import('../src/server/distribution-adapter.ts');
const {
  classifyDistributionWebhookFailure,
  createDistributionDeliveryService
} = await import('../src/server/distribution-delivery-service.ts');

const root = process.cwd();
const read = (relativePath) => readFileSync(join(root, relativePath), 'utf8');

const contract = read('src/server/audio-publishing-contract.ts');
assert.match(contract, /distributionDeliveryEngine:\s*false/, 'The delivery engine must remain fail-closed.');
assert.match(contract, /externalDspDelivery:\s*false/, 'Real external DSP delivery must remain false.');

const server = read('server.ts');
assert.match(
  server,
  /adapters:\s*\{\s*sway_sandbox:\s*createSandboxDistributionAdapter/,
  'The server may register only the in-process sway_sandbox adapter.'
);
assert.doesNotMatch(
  server,
  /adapters:\s*\{[^}]*,\s*[a-zA-Z0-9_]+:/s,
  'No second or real provider adapter may be registered in this slice.'
);
assert.match(server, /requireDistributionDeliveryRuntime/, 'All delivery routes must stay behind the false capability.');
assert.match(server, /req\.header\('sway-distribution-signature'\)/, 'Webhook bodies require a signature.');
assert.match(server, /classifyDistributionWebhookFailure\(error\)/, 'Webhook failures require typed retry classification.');
assert.match(server, /Retry-After', '30'/, 'Retryable sandbox webhook failures must advertise retry timing.');
assert.match(
  server,
  /This records correction-request intake only\. Provider transmission and resubmission are not implemented\./,
  'Correction route copy must state that the operation is intake-only.'
);
assert.match(
  server,
  /Authorized release managers can test this sandbox lifecycle\. It does not send music to stores\./,
  'Route copy must identify both delegated authority and the sandbox-only non-claim.'
);
assert.doesNotMatch(
  server.slice(
    server.indexOf("app.post('/api/talent/audio/releases/:releaseId/deliveries'"),
    server.indexOf("app.get('/api/talent/audio/projects'")
  ),
  /loadOwnedPerformerByActorUserId|Only the performer owner/,
  'DSP routes must rely on canonical active canManageRelease authority, not owner-only route copy.'
);

const service = read('src/server/distribution-delivery-service.ts');
for (const authorityRule of [
  'eq(audioProjectAccessGrants.canManageRelease, true)',
  'isNull(audioProjectAccessGrants.revokedAt)',
  'or(isNull(audioProjectAccessGrants.expiresAt), gt(audioProjectAccessGrants.expiresAt, new Date()))'
]) {
  assert.ok(service.includes(authorityRule), `Delivery authority must retain ${authorityRule}.`);
}
assert.match(
  service,
  /Distribution delivery not found or unavailable\./,
  'Missing and unauthorized delivery IDs must use one non-enumerating result.'
);
assert.match(
  service,
  /permits only the sway_sandbox adapter/,
  'Service construction must reject real adapter registration.'
);
assert.match(
  service,
  /Correction-request intake is pending; provider transmission and resubmission are not implemented\./,
  'A pending correction request must not be transmitted or resubmitted.'
);

const providerTransitionMigration = read('drizzle/0028_provider_delivery_transition_context.sql');
assert.match(
  providerTransitionMigration,
  /provider_verified_setting = 'true'\s+AND provider_key_setting = NEW\.provider_key/,
  'The database trigger may bypass human grant checks only for verified callbacks from the matching provider.'
);
assert.match(
  providerTransitionMigration,
  /\(OLD\.delivery_status = 'correction_pending' AND NEW\.delivery_status = 'failed'\)/,
  'Correction-request intake must not allow queued or submitted resubmission transitions.'
);
assert.doesNotMatch(
  providerTransitionMigration,
  /OLD\.delivery_status = 'correction_pending'[^;\n]*\b(?:queued|submitted)\b/,
  'Correction-request intake must remain non-resubmittable at the database boundary.'
);

const publishing = read('src/server/audio-publishing-service.ts');
assert.match(
  publishing,
  /const REAL_DISTRIBUTION_PROVIDER_KEYS = new Set<string>\(\)/,
  'No provider may be treated as real in the public release projection.'
);
assert.match(
  publishing,
  /\.filter\(\(destination\) => REAL_DISTRIBUTION_PROVIDER_KEYS\.has\(destination\.providerKey\)\)/,
  'Public release status must exclude sandbox destinations.'
);
assert.match(publishing, /isSandbox:/, 'Performer workspace delivery rows must be labeled as sandbox.');

const readiness = JSON.parse(read('config/sway-complete-product-readiness.json'));
const capabilities = readiness.pillars.flatMap((pillar) => pillar.capabilities);
assert.equal(readiness.decision, 'HOLD', 'Complete-product readiness must remain HOLD.');
assert.equal(capabilities.find((capability) => capability.id === 'dsp_delivery')?.status, 'missing');
assert.equal(
  capabilities.find((capability) => capability.id === 'delivery_lifecycle')?.status,
  'implemented_unverified'
);

const adapter = createSandboxDistributionAdapter({ secret: 'contract-test-secret' });
assert.equal(adapter.providerKey, SANDBOX_DISTRIBUTION_PROVIDER_KEY);

const payload = {
  releaseId: 'release-1',
  providerKey: SANDBOX_DISTRIBUTION_PROVIDER_KEY,
  destinationKey: 'spotify',
  title: 'Contract Test Release',
  primaryArtistName: 'Test Artist',
  releaseType: 'single',
  upc: null,
  originalReleaseDate: '2026-01-01',
  territories: ['US', 'CA'],
  recordings: [
    {
      recordingId: 'rec-1',
      isrc: 'USAAA2400001',
      title: 'Track One',
      primaryArtistName: 'Test Artist',
      trackNumber: 1,
      discNumber: 1
    }
  ]
};

const fingerprint = adapter.buildMetadataFingerprint(payload);
assert.match(fingerprint, /^[0-9a-f]{64}$/);
assert.equal(adapter.buildMetadataFingerprint({ ...payload, territories: ['CA', 'US'] }), fingerprint);
assert.notEqual(adapter.buildMetadataFingerprint({ ...payload, title: 'Changed' }), fingerprint);

const submission = await adapter.submit(payload);
assert.match(submission.providerReleaseId, /^sandbox-release-1-/);
const event = {
  providerEventId: 'evt-1',
  providerReleaseId: submission.providerReleaseId,
  destinationKey: 'spotify',
  status: 'live',
  destinationReleaseId: 'sandbox-destination-1',
  error: null
};
const { rawBody, signatureHeader } = adapter.signWebhookEvent(event);
assert.equal(adapter.verifyWebhookSignature(rawBody, signatureHeader), true);
assert.equal(adapter.verifyWebhookSignature(rawBody, undefined), false);
assert.equal(adapter.verifyWebhookSignature(Buffer.from(`${rawBody} `), signatureHeader), false);
assert.deepEqual(adapter.parseWebhookEvent(rawBody), event);

assert.throws(
  () => createDistributionDeliveryService({
    db: {},
    adapters: {
      sway_sandbox: adapter,
      real_provider: { ...adapter, providerKey: 'real_provider' }
    }
  }),
  /permits only the sway_sandbox adapter/
);
assert.throws(
  () => createDistributionDeliveryService({
    db: {},
    adapters: { real_provider: { ...adapter, providerKey: 'real_provider' } }
  }),
  /permits only the sway_sandbox adapter/
);

let transactionCalls = 0;
const invalidSignatureService = createDistributionDeliveryService({
  db: {
    async transaction() {
      transactionCalls += 1;
      throw new Error('Transaction must not run.');
    }
  },
  adapters: { sway_sandbox: adapter }
});
const captureFailure = async (operation) => {
  try {
    await operation();
  } catch (error) {
    return classifyDistributionWebhookFailure(error);
  }
  throw new Error('Expected operation to fail.');
};
const invalidSignatureFailure = await captureFailure(() => invalidSignatureService.ingestWebhook({
  providerKey: 'sway_sandbox',
  rawBody,
  signatureHeader: 'invalid-signature'
}));
assert.equal(invalidSignatureFailure.statusCode, 400);
assert.equal(invalidSignatureFailure.retryable, false);
assert.equal(transactionCalls, 0);

const storageFailure = await captureFailure(() => invalidSignatureService.ingestWebhook({
  providerKey: 'sway_sandbox',
  rawBody,
  signatureHeader
}));
assert.equal(storageFailure.statusCode, 503);
assert.equal(storageFailure.retryable, true);
assert.equal(storageFailure.message, 'Distribution webhook processing is temporarily unavailable.');

console.log('Distribution delivery contract passed.');
