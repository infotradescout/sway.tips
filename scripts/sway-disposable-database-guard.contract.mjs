import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertDisposableDatabaseTarget,
  assertStripeTestKey
} from './lib/disposable-database-guard.mjs';

// These are pure validator fixtures. They never connect to a database. Give each
// case its own environment so a hosting marker cannot mask the rule under test.
// Actual reset scripts still use process.env and the unchanged production guard.
const localEnvironment = Object.freeze({ NODE_ENV: 'test' });
const allowed = assertDisposableDatabaseTarget({
  databaseUrl: 'postgresql://postgres:postgres@127.0.0.1:5432/sway_disposable_test',
  approval: 'true',
  stripeSecretKey: 'sk_test_guard',
  env: localEnvironment
});
assert.equal(allowed, 'postgresql://postgres:postgres@127.0.0.1:5432/sway_disposable_test');

for (const input of [
  {
    databaseUrl: 'postgresql://postgres:postgres@127.0.0.1:5432/sway_test',
    approval: undefined
  },
  {
    databaseUrl: 'postgresql://postgres:postgres@db.example.com:5432/sway_test',
    approval: 'true'
  },
  {
    databaseUrl: 'postgresql://postgres:postgres@ep-example.us-east-2.aws.neon.tech/sway_test',
    approval: 'true'
  },
  {
    databaseUrl: 'postgresql://postgres:postgres@localhost.evil/sway_test',
    approval: 'true'
  },
  {
    databaseUrl: 'postgresql://postgres:postgres@127.0.0.1.nip.io/sway_test',
    approval: 'true'
  },
  {
    databaseUrl: 'postgresql://postgres:postgres@localhost:5432/sway_test?host=ep-example.us-east-2.aws.neon.tech',
    approval: 'true'
  },
  {
    databaseUrl: 'postgresql://postgres:postgres@localhost:5432/postgres',
    approval: 'true'
  },
  {
    databaseUrl: 'postgresql://postgres:postgres@localhost:5432/sway',
    approval: 'true'
  },
  {
    databaseUrl: 'postgresql://postgres:postgres@localhost:5432/sway_test/extra',
    approval: 'true'
  },
  {
    databaseUrl: 'postgresql://postgres:postgres@localhost:5432/sway_test#remote',
    approval: 'true'
  },
  {
    databaseUrl: 'mysql://root:root@localhost:3306/sway_test',
    approval: 'true'
  },
  {
    databaseUrl: 'postgresql://postgres:postgres@localhost:5432/sway_test',
    approval: 'true',
    stripeSecretKey: 'sk_live_forbidden'
  },
  {
    databaseUrl: 'postgresql://postgres:postgres@localhost:5432/sway_test',
    approval: 'true',
    env: { NODE_ENV: 'production' }
  },
  {
    databaseUrl: 'postgresql://postgres:postgres@localhost:5432/sway_test',
    approval: 'true',
    env: { RENDER_SERVICE_ID: 'srv-production' }
  },
  {
    databaseUrl: 'postgresql://postgres:postgres@localhost:5432/sway_test',
    approval: 'true',
    env: { VITE_STRIPE_PUBLISHABLE_KEY: 'pk_live_forbidden' }
  }
]) {
  assert.throws(() => assertDisposableDatabaseTarget({ env: localEnvironment, ...input }));
}

// Prove every hosting marker is denied through the helper's default process.env
// path, not merely through injected fixtures. The child only calls the validator;
// it imports no database driver and performs no reset or provider operation.
const inheritedEnvironmentProof = `
  import assert from 'node:assert/strict';
  import { assertDisposableDatabaseTarget } from ${JSON.stringify(new URL('./lib/disposable-database-guard.mjs', import.meta.url).href)};
  assert.throws(() => assertDisposableDatabaseTarget({
    databaseUrl: 'postgresql://postgres:postgres@127.0.0.1:5432/sway_disposable_test',
    approval: 'true'
  }), /blocked in production or Render environments/);
`;
for (const env of [
  { NODE_ENV: 'production' },
  { RENDER: 'true' },
  { RENDER_SERVICE_ID: 'srv-proof-denial' },
  { RENDER_INSTANCE_ID: 'instance-proof-denial' },
  { RENDER_EXTERNAL_URL: 'https://proof-denial.example.test' }
]) {
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', inheritedEnvironmentProof], {
    env,
    encoding: 'utf8',
    timeout: 10_000
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, `Inherited ${Object.keys(env)[0]} must remain denied: ${child.stderr}`);
}
for (const keyName of ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'VITE_STRIPE_PUBLISHABLE_KEY']) {
  for (const prefix of ['sk', 'rk', 'pk']) {
    assert.throws(() => assertDisposableDatabaseTarget({
      databaseUrl: allowed,
      approval: 'true',
      env: { [keyName]: `${prefix}_live_forbidden` }
    }), /live Stripe credentials are present/);
  }
}

assert.equal(assertStripeTestKey('sk_test_only'), 'sk_test_only');
assert.throws(() => assertStripeTestKey('sk_live_never'));
assert.throws(() => assertStripeTestKey('not-a-stripe-key'));

for (const filename of readdirSync(join(process.cwd(), 'scripts')).filter((name) => name.endsWith('.mjs'))) {
  const source = readFileSync(join(process.cwd(), 'scripts', filename), 'utf8');
  if (!/DROP SCHEMA/i.test(source)) continue;
  assert.match(source, /assertDisposableDatabaseTarget\s*\(/, `${filename} must guard every destructive schema reset.`);
  assert.doesNotMatch(source, /dotenv\.config|from ['"]dotenv['"]/, `${filename} must not auto-load application credentials.`);
  assert.ok(
    source.indexOf('assertDisposableDatabaseTarget') < source.indexOf('DROP SCHEMA'),
    `${filename} must guard the target before destructive SQL is reachable.`
  );
}

const secretUrl = 'postgresql://private-user:private-password@remote.example/sway_test';
assert.throws(() => assertDisposableDatabaseTarget({
  databaseUrl: secretUrl,
  approval: 'true',
  env: localEnvironment
}), (error) => {
  assert.match(String(error), /only target localhost or loopback/);
  assert.equal(String(error).includes(secretUrl), false);
  assert.equal(String(error).includes('private-password'), false);
  return true;
});

console.log('Sway disposable database guard contract tests passed.');
