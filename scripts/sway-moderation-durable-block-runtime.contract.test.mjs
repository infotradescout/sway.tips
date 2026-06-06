import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

function normalizeValue(value) {
  return value.trim().toLowerCase();
}

function createRuntimeDurableStore() {
  const active = new Map();
  const moderationEvents = [];
  let lookupCount = 0;

  const persistence = {
    hasDurableStore: true,
    async findMatchingBlock(input) {
      lookupCount += 1;
      const candidates = [
        ['patron_user_id', input.patronUserId],
        ['patron_device_id_hash', input.patronDeviceIdHash],
        ['sender_name', input.senderName]
      ];

      for (const [scope, raw] of candidates) {
        if (!raw) continue;
        const key = `${scope}:${normalizeValue(raw)}`;
        const found = active.get(key);
        if (found) {
          return {
            outage: false,
            match: {
              scope,
              value: found.normalizedValue,
              reason: found.reason
            }
          };
        }
      }

      return { outage: false, match: null };
    },
    async upsertActiveBlock(input) {
      active.set(`${input.scope}:${input.normalizedValue}`, {
        scope: input.scope,
        normalizedValue: input.normalizedValue,
        reason: input.reason
      });
    },
    async writeModerationEvent(input) {
      moderationEvents.push({ entityType: input.entityType, status: input.status });
      return { status: 'written' };
    }
  };

  return {
    persistence,
    getLookupCount: () => lookupCount,
    getActiveCount: () => active.size,
    getEvents: () => moderationEvents
  };
}

async function loadModerationServiceFactory() {
  const tempDir = join(process.cwd(), '.tmp');
  const outfile = join(tempDir, 'moderation-service.contract.bundle.cjs');
  mkdirSync(tempDir, { recursive: true });
  const require = createRequire(import.meta.url);

  try {
    await build({
      entryPoints: ['src/server/moderation-service.ts'],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile,
      sourcemap: false
    });

    const loaded = require(outfile);
    return loaded.createModerationService;
  } finally {
    rmSync(outfile, { force: true });
  }
}

async function main() {
  const createModerationService = await loadModerationServiceFactory();
  const store = createRuntimeDurableStore();

  function createServiceInstance() {
    return createModerationService(undefined, store.persistence);
  }

  const vectors = [
  {
    scope: 'patron_device_id_hash',
    value: 'Device-ABC-001',
    evaluateInput: {
      senderName: 'Neutral Name',
      text: 'hello world',
      patronDeviceIdHash: 'device-abc-001'
    }
  },
  {
    scope: 'patron_user_id',
    value: '61f7383e-3ef8-4cae-9dbe-6f8f9f8d58d7',
    evaluateInput: {
      senderName: 'Another Person',
      text: 'friendly message',
      patronUserId: '61f7383e-3ef8-4cae-9dbe-6f8f9f8d58d7'
    }
  },
  {
    scope: 'sender_name',
    value: 'Trouble Maker',
    evaluateInput: {
      senderName: 'trouble maker',
      text: 'just saying hi'
    }
  }
  ];

  for (const vector of vectors) {
    const initialService = createServiceInstance();
    await initialService.addBlockRule({
      scope: vector.scope,
      value: vector.value,
      reason: `Durable runtime block for ${vector.scope}`
    });

    const reinitializedService = createServiceInstance();
    const decision = await reinitializedService.evaluateSubmission(vector.evaluateInput);

    assert.equal(
      decision.decision,
      'block_submission',
      `Expected ${vector.scope} to remain blocked after service reinitialization`
    );
  }

  assert.equal(store.getActiveCount(), 3, 'Expected one durable active block entry per scope vector');
  assert.ok(
    store.getLookupCount() >= vectors.length,
    'Expected evaluateSubmission to query durable block lookup during runtime checks'
  );
  assert.ok(
    store.getEvents().some((event) => event.entityType === 'block_rule' && event.status === 'blocked'),
    'Expected addBlockRule to write moderation event entries'
  );

  console.log('Moderation durable block runtime contract passed.');
}

main().catch((error) => {
  console.error('Moderation durable block runtime contract failed:');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
