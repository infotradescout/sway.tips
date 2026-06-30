import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { createRequire } from 'node:module';

const root = process.cwd();

async function loadBundle(entryPoint, outfileName) {
  const tempDir = join(root, '.tmp');
  mkdirSync(tempDir, { recursive: true });
  const outfile = join(tempDir, outfileName);

  await build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    sourcemap: false
  });

  const require = createRequire(import.meta.url);
  return require(outfile);
}

function createInsertSpyDb() {
  let insertedValues = null;

  return {
    db: {
      insert() {
        return {
          values(values) {
            insertedValues = values;
            return {
              returning() {
                return Promise.resolve([{
                  id: 'challenge-1',
                  expiresAt: values.expiresAt
                }]);
              }
            };
          }
        };
      }
    },
    getInsertedValues() {
      return insertedValues;
    }
  };
}

async function main() {
  const serverSource = readFileSync(join(root, 'server.ts'), 'utf8');
  const talentAppSource = readFileSync(join(root, 'src/shells/TalentApp.tsx'), 'utf8');
  const talentLoginCardSource = readFileSync(join(root, 'src/components/TalentLoginCard.tsx'), 'utf8');
  const appSource = readFileSync(join(root, 'src/App.tsx'), 'utf8');
  const bootstrapRunbook = readFileSync(join(root, 'docs/runbooks/performer-browser-session-bootstrap.md'), 'utf8');
  const emailRunbookPath = join(root, 'docs/runbooks/performer-email-magic-link-login.md');
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

  const performerLoginModule = await loadBundle(
    'src/server/performer-login.ts',
    'performer-login.contract.bundle.cjs'
  );
  const performerMailerModule = await loadBundle(
    'src/server/performer-login-mailer.ts',
    'performer-login-mailer.contract.bundle.cjs'
  );

  const {
    createPerformerLoginChallengeStore,
    createPerformerLoginRateLimiter,
    hashPerformerLoginToken,
    normalizePerformerLoginEmail,
    PERFORMER_LOGIN_LINK_TTL_MS,
    resolvePerformerLoginRedirectPath
  } = performerLoginModule;
  const {
    createPerformerLoginMailer,
    resolvePerformerLoginBaseUrl
  } = performerMailerModule;

  assert.ok(talentAppSource.includes('TalentLoginCard'), 'TalentApp must render the dedicated performer login card.');
  assert.ok(appSource.includes('TalentLoginCard'), 'App talent-login route must share the performer login card.');
  assert.ok(
    talentLoginCardSource.includes('Email me a secure sign-in link'),
    'Talent login card must show the approved magic-link CTA.'
  );
  assert.ok(
    talentLoginCardSource.includes('If this email is on an approved Sway performer account, we sent a link.'),
    'Talent login card must keep enumeration-safe success copy.'
  );
  assert.ok(
    !talentAppSource.includes('secure Sway session link'),
    'TalentApp must not present bootstrap session links as the primary performer login UX.'
  );

  for (const term of [
    "app.post('/api/talent/login/request'",
    "app.get('/api/talent/login/consume'",
    'performerLoginRateLimiter.consume',
    'performerLoginChallengeStore.issueChallenge',
    'performerLoginMailer.sendMagicLink',
    'performerLoginChallengeStore.consumeChallengeFromToken',
    'performerSessionStore.revokeActiveSessionsForActorUser',
    "res.cookie(performerSessionStore.cookieName, outcome.issuedSession.token, {"
  ]) {
    assert.ok(serverSource.includes(term), `Server performer email login route missing required term: ${term}`);
  }

  const revokeIndex = serverSource.indexOf('performerSessionStore.revokeActiveSessionsForActorUser');
  const issueIndex = serverSource.indexOf('performerSessionStore.issueSession');
  assert.ok(revokeIndex !== -1 && issueIndex !== -1 && revokeIndex < issueIndex, 'Consume flow must revoke older active performer sessions before issuing the new session.');

  assert.equal(normalizePerformerLoginEmail(' Perf@Sway.Tips '), 'perf@sway.tips', 'Email normalization must trim and lowercase performer emails.');
  assert.equal(normalizePerformerLoginEmail('not-an-email'), null, 'Malformed emails must be rejected before challenge issuance.');
  assert.equal(resolvePerformerLoginRedirectPath('https://evil.com'), '/talent', 'External redirect URLs must be ignored.');
  assert.equal(resolvePerformerLoginRedirectPath('/talent/gigs?room=1'), '/talent/gigs?room=1', 'Allowlisted internal talent redirects may pass through.');
  assert.equal(resolvePerformerLoginBaseUrl({ SWAY_APP_BASE_URL: 'https://app.sway.tips', APP_URL: 'https://fallback.sway.tips' }), 'https://app.sway.tips');

  const insertSpy = createInsertSpyDb();
  const challengeStore = createPerformerLoginChallengeStore({
    databaseUrl: 'postgres://db-present.example/sway',
    dbOverride: insertSpy.db
  });
  const issuedAt = new Date('2026-06-29T12:00:00.000Z');
  const issuedChallenge = await challengeStore.issueChallenge({
    actorUserId: '11111111-1111-4111-8111-111111111111',
    targetEmail: 'perf@sway.tips',
    requesterIpHash: 'ip-hash-1',
    now: issuedAt
  });
  const insertedValues = insertSpy.getInsertedValues();
  assert.ok(insertedValues, 'Authorized performer login requests must persist a durable challenge row.');
  assert.equal(insertedValues.tokenHash, hashPerformerLoginToken(issuedChallenge.token), 'Performer login challenges must store only the SHA-256 token hash.');
  assert.notEqual(insertedValues.tokenHash, issuedChallenge.token, 'Performer login challenges must never store the plaintext magic-link token.');
  assert.equal(insertedValues.sendCount, 1, 'Performer login challenges must start with send_count = 1.');
  assert.equal(insertedValues.requestedAt.toISOString(), issuedAt.toISOString(), 'Challenge request timestamps must persist the request time.');
  assert.equal(issuedChallenge.expiresAt.getTime() - issuedAt.getTime(), PERFORMER_LOGIN_LINK_TTL_MS, 'Performer magic links must expire exactly 15 minutes after issuance.');

  const limiter = createPerformerLoginRateLimiter({ maxRequests: 3, windowMs: 600000 });
  assert.equal(limiter.consume({ requesterIpHash: 'ip-a', targetEmail: 'perf@sway.tips', now: 0 }).allowed, true);
  assert.equal(limiter.consume({ requesterIpHash: 'ip-a', targetEmail: 'perf@sway.tips', now: 1000 }).allowed, true);
  assert.equal(limiter.consume({ requesterIpHash: 'ip-a', targetEmail: 'perf@sway.tips', now: 2000 }).allowed, true);
  assert.equal(limiter.consume({ requesterIpHash: 'ip-a', targetEmail: 'perf@sway.tips', now: 3000 }).allowed, false, 'Performer login requests must rate limit to 3 sends per 10 minutes for the same IP+email bucket.');

  const capturedLogs = [];
  const originalLog = console.log;
  try {
    console.log = (...args) => {
      capturedLogs.push(args.join(' '));
    };
    const mockMailer = createPerformerLoginMailer({
      env: {},
      isProduction: false
    });
    const result = await mockMailer.sendMagicLink({
      toEmail: 'perf@sway.tips',
      magicLink: 'https://app.sway.tips/api/talent/login/consume?token=abc'
    });
    assert.equal(result.delivered, true, 'Non-production performer login mailer must succeed without external credentials.');
  } finally {
    console.log = originalLog;
  }

  assert.ok(
    capturedLogs.some((entry) => entry.includes('[SWAY_EMAIL_MOCK]') && entry.includes('/api/talent/login/consume?token=')),
    'Non-production performer login mailer must log the generated magic link for operators.'
  );

  assert.ok(existsSync(emailRunbookPath), 'Performer email magic-link runbook is required.');
  assert.ok(bootstrapRunbook.includes('fallback'), 'Bootstrap runbook must remain documented as the support fallback path.');
  assert.ok(
    (packageJson.scripts?.['test:contracts'] ?? '').includes('node scripts/sway-performer-email-login.contract.test.mjs'),
    'test:contracts must include the performer email login contract.'
  );

  console.log('Performer email login contract passed.');
}

main().catch((error) => {
  console.error('Performer email login contract failed:');
  console.error(error);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
