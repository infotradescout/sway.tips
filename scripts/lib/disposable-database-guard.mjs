const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const FORBIDDEN_DATABASE_NAMES = new Set(['postgres', 'template0', 'template1']);
const DISPOSABLE_DATABASE_NAME = /(^|[_-])(test|testing|disposable|proof)([_-]|$)/i;
const LIVE_STRIPE_KEY = /^(sk|rk|pk)_live_/;

export function assertStripeTestKey(secretKey, label = 'STRIPE_SECRET_KEY') {
  if (typeof secretKey !== 'string' || !secretKey.startsWith('sk_test_')) {
    throw new Error(`${label} must be a Stripe test-mode key. Live or unrecognized keys are forbidden in destructive proofs.`);
  }
  return secretKey;
}

export function assertDisposableDatabaseTarget({
  databaseUrl,
  env = process.env,
  approval = env.SWAY_ALLOW_DISPOSABLE_DATABASE_RESET,
  label = 'destructive database proof',
  stripeSecretKey
}) {
  if (approval !== 'true') {
    throw new Error(`${label} is blocked. Set SWAY_ALLOW_DISPOSABLE_DATABASE_RESET=true only for an isolated local test database.`);
  }

  if (
    env.NODE_ENV === 'production'
    || env.RENDER === 'true'
    || env.RENDER_SERVICE_ID
    || env.RENDER_INSTANCE_ID
    || env.RENDER_EXTERNAL_URL
  ) {
    throw new Error(`${label} is blocked in production or Render environments.`);
  }

  for (const keyName of ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY', 'VITE_STRIPE_PUBLISHABLE_KEY']) {
    if (LIVE_STRIPE_KEY.test(String(env[keyName] ?? ''))) {
      throw new Error(`${label} is blocked because live Stripe credentials are present.`);
    }
  }

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error(`${label} is blocked because DATABASE_URL is not a valid PostgreSQL URL.`);
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`${label} is blocked because only PostgreSQL disposable targets are supported.`);
  }

  // node-postgres accepts connection options from the query string. A URL such
  // as localhost/test?host=remote.example can therefore pass a naive hostname
  // check and still connect remotely. Destructive proofs accept no URL options.
  if (parsed.search || parsed.hash) {
    throw new Error(`${label} is blocked because disposable DATABASE_URL values may not contain query parameters or fragments.`);
  }

  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(`${label} is blocked because destructive proofs may only target localhost or loopback PostgreSQL.`);
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, '')).trim();
  if (
    !databaseName
    || databaseName.includes('/')
    || !/^sway[_-]/i.test(databaseName)
    || FORBIDDEN_DATABASE_NAMES.has(databaseName.toLowerCase())
    || !DISPOSABLE_DATABASE_NAME.test(databaseName)
  ) {
    throw new Error(`${label} is blocked because the database name must explicitly contain test, testing, disposable, or proof.`);
  }

  if (stripeSecretKey !== undefined) {
    assertStripeTestKey(stripeSecretKey);
  }

  return databaseUrl;
}
