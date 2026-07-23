import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const failures = [];

function read(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8');
}

// The engine must stay unreachable until a real provider is wired in --
// no route may claim a sandbox delivery as a real DSP confirmation.
const contract = read('src/server/audio-publishing-contract.ts');
if (!/distributionDeliveryEngine:\s*false/.test(contract)) {
  failures.push('distributionDeliveryEngine capability must default to false.');
}
if (!/externalDspDelivery:\s*false/.test(contract)) {
  failures.push('externalDspDelivery capability must remain false alongside the delivery engine.');
}

const server = read('server.ts');
if (!server.includes('requireDistributionDeliveryRuntime')) {
  failures.push('server.ts must gate distribution delivery routes behind requireDistributionDeliveryRuntime.');
}
if (!/adapters:\s*\{\s*sway_sandbox:/.test(server)) {
  failures.push('server.ts must register only the sandbox adapter under the sway_sandbox key.');
}
if (!server.includes("req.header('sway-distribution-signature')")) {
  failures.push('Distribution webhook route must read a signature header before trusting the body.');
}
for (const disclosure of [
  'It prepares a release but does not send it to stores',
  'provider-backed delivery, royalty accounting, splits, payouts, true pre-saves, and safe distributor cutover are not live'
]) {
  if (!server.includes(disclosure)) {
    failures.push(`About page must keep the DSP-delivery disclosure: "${disclosure}"`);
  }
}

const behaviorProgram = `
  import assert from 'node:assert/strict';
  import { createSandboxDistributionAdapter } from './src/server/distribution-adapter.ts';

  const adapter = createSandboxDistributionAdapter({ secret: 'contract-test-secret' });
  assert.equal(adapter.providerKey, 'sway_sandbox');

  const payload = {
    releaseId: 'release-1',
    providerKey: 'sway_sandbox',
    destinationKey: 'spotify',
    title: 'Contract Test Release',
    primaryArtistName: 'Test Artist',
    releaseType: 'single',
    upc: null,
    originalReleaseDate: '2026-01-01',
    territories: ['US', 'CA'],
    recordings: [
      { recordingId: 'rec-1', isrc: 'USAAA2400001', title: 'Track One', primaryArtistName: 'Test Artist', trackNumber: 1, discNumber: 1 }
    ]
  };

  const fingerprintA = adapter.buildMetadataFingerprint(payload);
  const fingerprintB = adapter.buildMetadataFingerprint(payload);
  assert.equal(fingerprintA, fingerprintB, 'Fingerprint must be deterministic for identical payloads.');
  assert.match(fingerprintA, /^[0-9a-f]{64}$/, 'Fingerprint must be a SHA-256 hex digest.');

  const reordered = { ...payload, territories: ['CA', 'US'] };
  assert.equal(
    adapter.buildMetadataFingerprint(reordered),
    fingerprintA,
    'Fingerprint must be order-independent for territories.'
  );

  const changed = { ...payload, title: 'A Different Title' };
  assert.notEqual(
    adapter.buildMetadataFingerprint(changed),
    fingerprintA,
    'Fingerprint must change when release content changes.'
  );

  const submission = await adapter.submit(payload);
  assert.match(submission.providerReleaseId, /^sandbox-release-1-/, 'Sandbox provider release id must be traceable to the source release.');

  const event = {
    providerEventId: 'evt-1',
    providerReleaseId: submission.providerReleaseId,
    destinationKey: 'spotify',
    status: 'live',
    destinationReleaseId: 'spotify-track-123',
    error: null
  };
  const { rawBody, signatureHeader } = adapter.signWebhookEvent(event);
  assert.equal(adapter.verifyWebhookSignature(rawBody, signatureHeader), true, 'A correctly signed event must verify.');
  assert.equal(adapter.verifyWebhookSignature(rawBody, undefined), false, 'A missing signature header must fail verification.');
  assert.equal(
    adapter.verifyWebhookSignature(rawBody, signatureHeader.replace(/.$/, signatureHeader.at(-1) === '0' ? '1' : '0')),
    false,
    'A tampered signature must fail verification.'
  );
  const tamperedBody = Buffer.from(rawBody.toString('utf8').replace('live', 'accepted'));
  assert.equal(adapter.verifyWebhookSignature(tamperedBody, signatureHeader), false, 'A tampered body must fail verification against the original signature.');

  const parsed = adapter.parseWebhookEvent(rawBody);
  assert.deepEqual(parsed, event, 'Round-tripped webhook event must match the signed event exactly.');

  const expectThrow = (label, operation) => {
    let threw = false;
    try { operation(); } catch { threw = true; }
    if (!threw) throw new Error(label);
  };
  expectThrow('accepted status must require a destinationReleaseId', () => {
    adapter.parseWebhookEvent(Buffer.from(JSON.stringify({ ...event, status: 'accepted', destinationReleaseId: undefined })));
  });
  expectThrow('unsupported status must be rejected', () => {
    adapter.parseWebhookEvent(Buffer.from(JSON.stringify({ ...event, status: 'delivered_by_carrier_pigeon' })));
  });
  expectThrow('missing providerEventId must be rejected', () => {
    adapter.parseWebhookEvent(Buffer.from(JSON.stringify({ ...event, providerEventId: undefined })));
  });
`;

const behavior = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--input-type=module', '--eval', behaviorProgram],
  { cwd: root, encoding: 'utf8' }
);
if (behavior.status !== 0) {
  failures.push(`Sandbox distribution adapter behavior checks failed:\n${behavior.stderr || behavior.stdout}`);
}

if (failures.length) {
  console.error('Distribution delivery contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Distribution delivery contract passed.');
