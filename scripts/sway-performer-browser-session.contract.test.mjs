import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { createRequire } from 'node:module';

async function loadSessionStoreFactory() {
  const tempDir = join(process.cwd(), '.tmp');
  mkdirSync(tempDir, { recursive: true });
  const outfile = join(tempDir, 'performer-session-store.contract.bundle.cjs');

  await build({
    entryPoints: ['src/server/performer-session-store.ts'],
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
                  id: 'session-1',
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
  const root = process.cwd();
  const serverSource = readFileSync(join(root, 'server.ts'), 'utf8');
  const accessSource = readFileSync(join(root, 'src/server/access-control.ts'), 'utf8');
  const runbookPath = join(root, 'docs/runbooks/performer-browser-session-bootstrap.md');
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

  const {
    createPerformerSessionStore,
    hashPerformerSessionToken,
    PERFORMER_SESSION_COOKIE_NAME
  } = await loadSessionStoreFactory();

  const insertSpy = createInsertSpyDb();
  const sessionStore = createPerformerSessionStore({
    databaseUrl: 'postgres://db-present.example/sway',
    dbOverride: insertSpy.db
  });

  const issuedSession = await sessionStore.issueSession({
    actorUserId: '11111111-1111-4111-8111-111111111111',
    issuedBy: '11111111-1111-4111-8111-111111111111'
  });

  const insertedValues = insertSpy.getInsertedValues();
  assert.ok(insertedValues, 'Performer session issuance must persist a database row.');
  assert.equal(insertedValues.tokenHash, hashPerformerSessionToken(issuedSession.token), 'Performer sessions must persist only the hashed token value.');
  assert.notEqual(insertedValues.tokenHash, issuedSession.token, 'Performer sessions must not store the plaintext browser token.');
  assert.equal(PERFORMER_SESSION_COOKIE_NAME, 'sway_performer_session', 'Performer session cookie name must stay stable for the browser bootstrap flow.');

  for (const term of [
    'hydrateRequestActor',
    'createPerformerSessionStore',
    'Protected performer session rejected.'
  ]) {
    assert.ok(accessSource.includes(term), `Access control missing required browser-session term: ${term}`);
  }

  for (const term of [
    "app.get('/api/talent/session/bootstrap'",
    "app.post('/api/talent/session/logout'",
    "res.cookie(performerSessionStore.cookieName, issuedSession.token, {",
    'httpOnly: true',
    "sameSite: 'lax'",
    "path: '/'",
    'secure: isProduction'
  ]) {
    assert.ok(serverSource.includes(term), `Server browser-session wiring missing required term: ${term}`);
  }

  assert.ok(existsSync(runbookPath), 'Performer browser session bootstrap runbook is required.');
  assert.ok(packageJson.scripts?.['performer:access:link'], 'package.json must expose the performer access link generator script.');
  assert.ok(
    (packageJson.scripts?.['test:contracts'] ?? '').includes('node scripts/sway-performer-browser-session.contract.test.mjs'),
    'test:contracts must include the performer browser session contract.'
  );

  console.log('Performer browser session contract passed.');
}

main().catch((error) => {
  console.error('Performer browser session contract failed:');
  console.error(error);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
