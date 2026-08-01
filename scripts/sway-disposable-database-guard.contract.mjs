import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertDisposableDatabaseTarget,
  assertStripeTestKey
} from './lib/disposable-database-guard.mjs';

const allowed = assertDisposableDatabaseTarget({
  databaseUrl: 'postgresql://postgres:postgres@127.0.0.1:5432/sway_disposable_test',
  approval: 'true',
  stripeSecretKey: 'sk_test_guard'
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
  assert.throws(() => assertDisposableDatabaseTarget(input));
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
try {
  assertDisposableDatabaseTarget({ databaseUrl: secretUrl, approval: 'true' });
  assert.fail('Remote secret URL should have been rejected.');
} catch (error) {
  assert.equal(String(error).includes(secretUrl), false);
  assert.equal(String(error).includes('private-password'), false);
}

console.log('Sway disposable database guard contract tests passed.');
