import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { build } from 'esbuild';
import { createRequire } from 'node:module';

async function loadAccessControlFactory() {
  const tempDir = join(process.cwd(), '.tmp');
  mkdirSync(tempDir, { recursive: true });
  const outfile = join(tempDir, 'access-control.persisted-readiness.bundle.cjs');

  await build({
    entryPoints: ['src/server/access-control.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    sourcemap: false
  });

  const require = createRequire(import.meta.url);
  return require(outfile).createAccessControl;
}

function makeReq(actorId, extraHeaders = {}) {
  const headers = {
    'x-sway-session-id': 'sess-test',
    'x-sway-device-id-hash': 'device-test',
    ...extraHeaders
  };

  if (actorId) {
    headers['x-sway-actor-id'] = actorId;
  }

  return { headers };
}

function createSignedFallbackHeaders({
  actorId,
  role,
  secret,
  sessionId = 'sess-test',
  timestamp = new Date().toISOString()
}) {
  const payload = [actorId, sessionId, role, timestamp].join('|');
  const signature = createHmac('sha256', secret).update(payload).digest('hex');

  return {
    'x-sway-session-id': sessionId,
    'x-sway-fallback-role': role,
    'x-sway-fallback-timestamp': timestamp,
    'x-sway-fallback-signature': signature
  };
}

function createEmptyDbStub() {
  let queryCount = 0;
  const builder = {
    from() {
      return builder;
    },
    where() {
      return builder;
    },
    limit() {
      queryCount += 1;
      return Promise.resolve([]);
    }
  };

  return {
    db: {
      select() {
        return builder;
      }
    },
    getQueryCount() {
      return queryCount;
    }
  };
}

async function main() {
  const createAccessControl = await loadAccessControlFactory();
  const previousEnv = {
    talent: process.env.SWAY_FALLBACK_TALENT_ACTOR_IDS,
    admin: process.env.SWAY_FALLBACK_ADMIN_ACTOR_IDS,
    support: process.env.SWAY_FALLBACK_SUPPORT_ACTOR_IDS,
    secret: process.env.SWAY_FALLBACK_ACTOR_HEADER_SECRET,
    maxAge: process.env.SWAY_FALLBACK_ACTOR_SIGNATURE_MAX_AGE_SECONDS
  };

  try {
    delete process.env.SWAY_FALLBACK_TALENT_ACTOR_IDS;
    delete process.env.SWAY_FALLBACK_ADMIN_ACTOR_IDS;
    delete process.env.SWAY_FALLBACK_SUPPORT_ACTOR_IDS;
    delete process.env.SWAY_FALLBACK_ACTOR_HEADER_SECRET;
    delete process.env.SWAY_FALLBACK_ACTOR_SIGNATURE_MAX_AGE_SECONDS;

    const noFallback = createAccessControl({ databaseUrl: undefined, isProduction: true });
    const anonymousTalent = await noFallback.requireTalentAccess(makeReq(null));
    assert.equal(anonymousTalent.allowed, false);
    assert.equal(anonymousTalent.status, 401, 'Anonymous talent route access must fail with 401.');

    const unavailableTalent = await noFallback.requireTalentAccess(makeReq('11111111-1111-4111-8111-111111111111'));
    assert.equal(unavailableTalent.allowed, false);
    assert.equal(unavailableTalent.status, 503, 'No configured fallback should remain a 503 infrastructure failure.');

    process.env.SWAY_FALLBACK_TALENT_ACTOR_IDS = 'garbage, 11111111-1111-4111-8111-111111111111 \n [22222222-2222-4222-8222-222222222222]';
    process.env.SWAY_FALLBACK_ADMIN_ACTOR_IDS = 'not-a-uuid, 22222222-2222-4222-8222-222222222222, \n [33333333-3333-4333-8333-333333333333]';
    process.env.SWAY_FALLBACK_SUPPORT_ACTOR_IDS = 'junk\t33333333-3333-4333-8333-333333333333';

    const unsignedProductionFallback = createAccessControl({ databaseUrl: undefined, isProduction: true });
    const rawSpoofDenied = await unsignedProductionFallback.requireTalentAccess(makeReq('11111111-1111-4111-8111-111111111111'));
    assert.equal(rawSpoofDenied.allowed, false, 'Raw fallback actor headers alone must not authorize production fallback access.');
    assert.equal(rawSpoofDenied.status, 503);

    process.env.SWAY_FALLBACK_ACTOR_HEADER_SECRET = 'fallback-test-secret';
    process.env.SWAY_FALLBACK_ACTOR_SIGNATURE_MAX_AGE_SECONDS = '300';

    const fallbackAccess = createAccessControl({ databaseUrl: undefined, isProduction: true });

    const missingSignatureDenied = await fallbackAccess.requireTalentAccess(makeReq('11111111-1111-4111-8111-111111111111'));
    assert.equal(missingSignatureDenied.allowed, false, 'Missing fallback verification headers must be denied.');
    assert.equal(missingSignatureDenied.status, 403);

    const invalidSignatureDenied = await fallbackAccess.requireTalentAccess(
      makeReq('11111111-1111-4111-8111-111111111111', {
        'x-sway-fallback-role': 'performer',
        'x-sway-fallback-timestamp': new Date().toISOString(),
        'x-sway-fallback-signature': 'deadbeef'
      })
    );
    assert.equal(invalidSignatureDenied.allowed, false, 'Invalid fallback signatures must be denied.');
    assert.equal(invalidSignatureDenied.status, 403);

    const staleSignatureDenied = await fallbackAccess.requireTalentAccess(
      makeReq('11111111-1111-4111-8111-111111111111', createSignedFallbackHeaders({
        actorId: '11111111-1111-4111-8111-111111111111',
        role: 'performer',
        secret: 'fallback-test-secret',
        timestamp: '2000-01-01T00:00:00.000Z'
      }))
    );
    assert.equal(staleSignatureDenied.allowed, false, 'Stale fallback signatures must be denied.');
    assert.equal(staleSignatureDenied.status, 403);

    const talentAllowed = await fallbackAccess.requireTalentAccess(
      makeReq('11111111-1111-4111-8111-111111111111', createSignedFallbackHeaders({
        actorId: '11111111-1111-4111-8111-111111111111',
        role: 'performer',
        secret: 'fallback-test-secret'
      }))
    );
    assert.equal(talentAllowed.allowed, true, 'Configured fallback performer must be allowed on talent routes.');
    assert.equal(talentAllowed.role, 'performer');

    const adminDeniedOnTalent = await fallbackAccess.requireTalentAccess(
      makeReq('22222222-2222-4222-8222-222222222222', createSignedFallbackHeaders({
        actorId: '22222222-2222-4222-8222-222222222222',
        role: 'admin',
        secret: 'fallback-test-secret'
      }))
    );
    assert.equal(adminDeniedOnTalent.allowed, false, 'Admin fallback must not bleed into talent routes.');
    assert.equal(adminDeniedOnTalent.status, 403);

    const invalidTalent = await fallbackAccess.requireTalentAccess(
      makeReq('99999999-9999-4999-8999-999999999999', createSignedFallbackHeaders({
        actorId: '99999999-9999-4999-8999-999999999999',
        role: 'performer',
        secret: 'fallback-test-secret'
      }))
    );
    assert.equal(invalidTalent.allowed, false, 'Unknown actor must remain fail-closed for talent routes.');
    assert.equal(invalidTalent.status, 403);

    const bracketedTalent = await fallbackAccess.requireTalentAccess(
      makeReq('[22222222-2222-4222-8222-222222222222]', createSignedFallbackHeaders({
        actorId: '[22222222-2222-4222-8222-222222222222]',
        role: 'performer',
        secret: 'fallback-test-secret'
      }))
    );
    assert.equal(bracketedTalent.allowed, false, 'Bracketed garbage tokens must not become authorized performer access.');
    assert.equal(bracketedTalent.status, 403);

    const adminAllowed = await fallbackAccess.requireAdminOrSupportAccess(
      makeReq('22222222-2222-4222-8222-222222222222', createSignedFallbackHeaders({
        actorId: '22222222-2222-4222-8222-222222222222',
        role: 'admin',
        secret: 'fallback-test-secret'
      }))
    );
    assert.equal(adminAllowed.allowed, true, 'Configured fallback admin must be allowed on admin routes.');
    assert.equal(adminAllowed.role, 'admin');

    const supportAllowed = await fallbackAccess.requireAdminOrSupportAccess(
      makeReq('33333333-3333-4333-8333-333333333333', createSignedFallbackHeaders({
        actorId: '33333333-3333-4333-8333-333333333333',
        role: 'support',
        secret: 'fallback-test-secret'
      }))
    );
    assert.equal(supportAllowed.allowed, true, 'Configured fallback support must be allowed on admin/support routes.');
    assert.equal(supportAllowed.role, 'support');

    const talentDeniedOnAdmin = await fallbackAccess.requireAdminOrSupportAccess(
      makeReq('11111111-1111-4111-8111-111111111111', createSignedFallbackHeaders({
        actorId: '11111111-1111-4111-8111-111111111111',
        role: 'performer',
        secret: 'fallback-test-secret'
      }))
    );
    assert.equal(talentDeniedOnAdmin.allowed, false, 'Performer fallback must not bypass admin route checks.');
    assert.equal(talentDeniedOnAdmin.status, 403);

    const adminOnlyDeniedSupport = await fallbackAccess.requireAdminAccess(
      makeReq('33333333-3333-4333-8333-333333333333', createSignedFallbackHeaders({
        actorId: '33333333-3333-4333-8333-333333333333',
        role: 'support',
        secret: 'fallback-test-secret'
      }))
    );
    assert.equal(adminOnlyDeniedSupport.allowed, false, 'Support fallback must not bypass admin-only checks.');
    assert.equal(adminOnlyDeniedSupport.status, 403);

    const mutationUnavailable = await fallbackAccess.requireGigMutationAccess(
      makeReq('11111111-1111-4111-8111-111111111111', createSignedFallbackHeaders({
        actorId: '11111111-1111-4111-8111-111111111111',
        role: 'performer',
        secret: 'fallback-test-secret'
      })),
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    );
    assert.equal(mutationUnavailable.allowed, false, 'Fallback must not silently authorize gig mutations without durable persistence.');
    assert.equal(mutationUnavailable.status, 503);

    const stub = createEmptyDbStub();
    const databaseBackedAccess = createAccessControl({
      databaseUrl: 'postgres://db-present.example/sway',
      isProduction: true,
      dbOverride: stub.db
    });

    const fallbackIgnoredForTalent = await databaseBackedAccess.requireTalentAccess(
      makeReq('11111111-1111-4111-8111-111111111111', createSignedFallbackHeaders({
        actorId: '11111111-1111-4111-8111-111111111111',
        role: 'performer',
        secret: 'fallback-test-secret'
      }))
    );
    assert.equal(fallbackIgnoredForTalent.allowed, false, 'Fallback performer IDs must become inactive when durable DB access exists.');
    assert.equal(fallbackIgnoredForTalent.status, 403);

    const fallbackIgnoredForAdmin = await databaseBackedAccess.requireAdminOrSupportAccess(
      makeReq('22222222-2222-4222-8222-222222222222', createSignedFallbackHeaders({
        actorId: '22222222-2222-4222-8222-222222222222',
        role: 'admin',
        secret: 'fallback-test-secret'
      }))
    );
    assert.equal(fallbackIgnoredForAdmin.allowed, false, 'Fallback admin IDs must not bypass DB-backed authorization.');
    assert.equal(fallbackIgnoredForAdmin.status, 403);

    assert.ok(stub.getQueryCount() >= 5, 'DB-backed route checks must consult the durable store instead of fallback allowlists.');

    console.log('Persisted access store readiness contract passed.');
  } finally {
    if (previousEnv.talent === undefined) delete process.env.SWAY_FALLBACK_TALENT_ACTOR_IDS;
    else process.env.SWAY_FALLBACK_TALENT_ACTOR_IDS = previousEnv.talent;

    if (previousEnv.admin === undefined) delete process.env.SWAY_FALLBACK_ADMIN_ACTOR_IDS;
    else process.env.SWAY_FALLBACK_ADMIN_ACTOR_IDS = previousEnv.admin;

    if (previousEnv.support === undefined) delete process.env.SWAY_FALLBACK_SUPPORT_ACTOR_IDS;
    else process.env.SWAY_FALLBACK_SUPPORT_ACTOR_IDS = previousEnv.support;

    if (previousEnv.secret === undefined) delete process.env.SWAY_FALLBACK_ACTOR_HEADER_SECRET;
    else process.env.SWAY_FALLBACK_ACTOR_HEADER_SECRET = previousEnv.secret;

    if (previousEnv.maxAge === undefined) delete process.env.SWAY_FALLBACK_ACTOR_SIGNATURE_MAX_AGE_SECONDS;
    else process.env.SWAY_FALLBACK_ACTOR_SIGNATURE_MAX_AGE_SECONDS = previousEnv.maxAge;
  }
}

main().catch((error) => {
  console.error('Persisted access store readiness contract failed:');
  console.error(error);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
