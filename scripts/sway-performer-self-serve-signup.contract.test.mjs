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

async function main() {
  const serverSource = readFileSync(join(root, 'server.ts'), 'utf8');
  const accessSource = readFileSync(join(root, 'src/server/access-control.ts'), 'utf8');
  const talentAppSource = readFileSync(join(root, 'src/shells/TalentApp.tsx'), 'utf8');
  const appSource = readFileSync(join(root, 'src/App.tsx'), 'utf8');
  const schemaSource = readFileSync(join(root, 'src/db/schema.ts'), 'utf8');
  const signupCardSource = readFileSync(join(root, 'src/components/TalentSignupCard.tsx'), 'utf8');
  const envExample = readFileSync(join(root, '.env.example'), 'utf8');
  const envContract = readFileSync(join(root, 'docs/SWAY_ENVIRONMENT_CONTRACT.md'), 'utf8');
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const signupRunbookPath = join(root, 'docs/runbooks/performer-self-serve-signup.md');

  const performerLoginModule = await loadBundle(
    'src/server/performer-login.ts',
    'performer-self-serve-signup.contract.bundle.cjs'
  );
  const performerPasswordModule = await loadBundle(
    'src/server/performer-password-auth.ts',
    'performer-password-auth.contract.bundle.cjs'
  );

  const {
    normalizePerformerHandle,
    normalizePerformerDisplayName,
    PERFORMER_LOGIN_CHALLENGE_TYPE_VERIFY_EMAIL,
    PERFORMER_SIGNUP_SUCCESS_COPY
  } = performerLoginModule;
  const {
    normalizePerformerPassword,
    validatePerformerPasswordStrength,
    hashPerformerPassword,
    verifyPerformerPassword
  } = performerPasswordModule;

  assert.ok(appSource.includes('/talent/signup'), 'App route spine must include /talent/signup.');
  assert.ok(talentAppSource.includes('TalentSignupCard'), 'TalentApp must route /talent/signup to TalentSignupCard.');
  assert.ok(signupCardSource.includes('I have a code'), 'Talent signup card must expose code claim entry at the top.');
  assert.ok(signupCardSource.includes('/api/talent/claim/accept'), 'Talent signup card must redeem claim codes without separate onboarding.');
  assert.ok(signupCardSource.includes('Claim profile'), 'Talent signup card must claim the prepared profile from a code.');
  assert.ok(signupCardSource.includes('Performer Name'), 'Talent signup card must collect performer name.');
  assert.ok(signupCardSource.includes('Handle'), 'Talent signup card must collect the performer handle.');
  assert.ok(signupCardSource.includes('Password'), 'Talent signup card must collect a password.');
  assert.ok(signupCardSource.includes('Confirm Password'), 'Talent signup card must collect password confirmation.');
  assert.ok(signupCardSource.includes('Create Account'), 'Talent signup card must expose the Create Account CTA.');
  assert.ok(signupCardSource.includes('Already have an account?'), 'Talent signup card must link performers back to /talent/login.');
  assert.ok(signupCardSource.includes('termsAccepted'), 'Talent signup card must capture terms acceptance.');
  assert.ok(signupCardSource.includes(PERFORMER_SIGNUP_SUCCESS_COPY), 'Talent signup card must show the approved signup success copy.');
  assert.ok(signupCardSource.includes('Open local verification link'), 'Local mock signup must expose the verification link instead of implying real email delivery.');

  assert.ok(
    accessSource.includes("req.path === '/talent/login'")
      && accessSource.includes("req.path === '/talent/signup'")
      && accessSource.includes("req.path === '/talent/invite'"),
    'Public talent auth allowlist must include login, signup, and one-time owner invitation pages.'
  );

  for (const term of [
    "app.post('/api/talent/signup'",
    "app.get('/api/talent/verify-email/consume'",
    'performerSignupRateLimiter.consume',
    'normalizePerformerHandle',
    'normalizePerformerDisplayName',
    'normalizePerformerPassword',
    'validatePerformerPasswordStrength',
    'hashPerformerPassword',
    "passwordHash,",
    "emailVerifiedAt: null",
    "termsAcceptedAt: new Date()",
    "challengeType: PERFORMER_LOGIN_CHALLENGE_TYPE_VERIFY_EMAIL",
    'performerLoginMailer.sendVerificationLink',
    "deliveryMode: 'mock'",
    'verificationLink: debugVerificationLink',
    'This handle is already taken.',
    'idx_performers_handle_lower',
    'This email or handle is already in use.',
    'Password confirmation does not match.',
    'Terms acceptance is required before creating a performer account.',
    "Verified performer email is required before starting a live room."
  ]) {
    assert.ok(serverSource.includes(term), `Server signup flow missing required term: ${term}`);
  }

  assert.equal(normalizePerformerHandle('dj-sunset'), 'dj-sunset');
  assert.equal(normalizePerformerHandle('DJ-Sunset'), 'DJ-Sunset', 'Performer handles must allow performer-chosen casing.');
  assert.equal(normalizePerformerHandle('bad handle'), null, 'Performer handles must reject spaces.');
  assert.equal(normalizePerformerHandle('bad*handle'), null, 'Performer handles must reject unsupported characters.');
  assert.equal(normalizePerformerHandle('Admin'), null, 'Performer handles must reject reserved names case-insensitively.');
  assert.ok(
    schemaSource.includes("uniqueIndex('idx_performers_handle_lower').on(sql`lower(${table.handle})`)"),
    'Performer handle uniqueness must be case-insensitive at the schema level.'
  );
  assert.ok(
    readFileSync(join(root, 'drizzle/0013_performer_handle_case_insensitive.sql'), 'utf8').includes('idx_performers_handle_lower'),
    'Performer handle migration must add the case-insensitive uniqueness index.'
  );
  assert.equal(normalizePerformerDisplayName(' DJ Sunset '), 'DJ Sunset', 'Performer display names must trim.');
  assert.equal(normalizePerformerDisplayName(''), null, 'Performer display names must reject empty strings.');
  assert.equal(normalizePerformerPassword('secret123'), 'secret123', 'Performer passwords must stay in request scope only as raw strings.');
  assert.equal(normalizePerformerPassword(''), null, 'Empty performer passwords must be rejected.');

  assert.equal(validatePerformerPasswordStrength('12').ok, false, 'Too-short passwords must be rejected.');
  assert.equal(validatePerformerPasswordStrength('123').ok, true, 'Short numeric quick-access passwords must pass.');
  assert.equal(validatePerformerPasswordStrength('longpassword').ok, false, 'Passwords without digits must be rejected.');
  assert.equal(validatePerformerPasswordStrength('sway1234').ok, true, 'Passwords with minimum strength must pass.');
  assert.equal(PERFORMER_LOGIN_CHALLENGE_TYPE_VERIFY_EMAIL, 'verify_email', 'Verification links must use the verify_email challenge type.');
  assert.equal(PERFORMER_SIGNUP_SUCCESS_COPY, 'Check your email to verify your Sway performer account.');

  const passwordHash = await hashPerformerPassword('SwaySecure123');
  assert.ok(passwordHash.startsWith('scrypt$'), 'Performer password hashes must use versioned scrypt storage.');
  assert.ok(!passwordHash.includes('SwaySecure123'), 'Performer password hashes must never contain plaintext passwords.');
  assert.equal(await verifyPerformerPassword('SwaySecure123', passwordHash), true, 'Password verification must succeed for the correct password.');
  assert.equal(await verifyPerformerPassword('WrongSecure123', passwordHash), false, 'Password verification must fail for the wrong password.');

  assert.ok(envExample.includes('SWAY_PERFORMER_SIGNUP_RATE_LIMIT_MAX'), '.env.example must document signup rate-limit configuration.');
  assert.ok(envExample.includes('SWAY_PERFORMER_PASSWORD_LOGIN_RATE_LIMIT_MAX'), '.env.example must document password login rate-limit configuration.');
  assert.ok(envContract.includes('SWAY_PERFORMER_SIGNUP_RATE_LIMIT_MAX'), 'Environment contract must include signup rate-limit configuration.');
  assert.ok(envContract.includes('SWAY_PERFORMER_PASSWORD_LOGIN_RATE_LIMIT_MAX'), 'Environment contract must include password login rate-limit configuration.');
  assert.ok(existsSync(signupRunbookPath), 'Performer self-serve signup runbook is required.');

  const signupRunbook = readFileSync(signupRunbookPath, 'utf8');
  assert.ok(signupRunbook.includes('/api/talent/verify-email/consume'), 'Signup runbook must document the verification consume route.');
  assert.ok(signupRunbook.includes('log in before verification'), 'Signup runbook must document the restricted unverified login state.');

  assert.ok(
    (packageJson.scripts?.['test:contracts'] ?? '').includes('node scripts/sway-performer-self-serve-signup.contract.test.mjs'),
    'test:contracts must include the self-serve performer signup contract.'
  );

  console.log('Performer self-serve signup contract passed.');
}

main().catch((error) => {
  console.error('Performer self-serve signup contract failed:');
  console.error(error);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
