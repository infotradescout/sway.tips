import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const failures = [];
const read = (file) => readFileSync(join(root, file), 'utf8');
const requireTerm = (source, term, label) => {
  if (!source.includes(term)) failures.push(`${label} missing: ${term}`);
};

for (const file of [
  'src/components/AccountAccess.tsx',
  'src/server/account-claim.ts',
  'src/server/performer-login.ts',
  'src/shells/PatronApp.tsx',
  'server.ts'
]) {
  if (!existsSync(join(root, file))) failures.push(`Missing claim-onboarding file: ${file}`);
}

const account = read('src/components/AccountAccess.tsx');
const server = read('server.ts');
const patronApp = read('src/shells/PatronApp.tsx');
const performerLogin = read('src/server/performer-login.ts');
const accountClaim = read('src/server/account-claim.ts');

for (const term of [
  'Claim code (optional)',
  'Enter claim code',
  'Have a performer profile waiting for you? Enter the code to claim it.',
  'Performer profile found:',
  'This account will claim that profile and activate Pro Mode.',
  '/api/account/claim/peek',
  '/api/account/claim/attach',
  "claimCode: trimmedClaim || undefined",
  "params.get('claim') || params.get('code')",
  'Claim confirmation',
  'Claim profile on this account'
]) {
  requireTerm(account, term, 'Account signup claim UI');
}

const confirmIdx = account.indexOf('>Confirm password</label>');
const claimFieldIdx = account.indexOf('<ClaimCodeField');
const termsIdx = account.indexOf('I accept the <a href="/terms"');
if (!(confirmIdx >= 0 && claimFieldIdx > confirmIdx && termsIdx > claimFieldIdx)) {
  failures.push('Claim code field must render below Confirm password and above Terms.');
}

for (const term of [
  "app.post('/api/account/claim/peek'",
  "app.post('/api/account/claim/attach'",
  'claimCodeFingerprint',
  'account.signup.claim',
  'account.claim.attach',
  'activateClaimedPerformerAndProMode',
  'const redirectPath = claimCode',
  '/signup?claim='
]) {
  requireTerm(server, term, 'Account claim runtime');
}

for (const term of [
  "pathname === '/signup'",
  "pathname === '/login'"
]) {
  requireTerm(patronApp, term, 'Public signup/login aliases');
}

for (const term of [
  'inspectClaimChallengeByToken',
  "PERFORMER_LOGIN_CHALLENGE_TYPE_CLAIM_CODE"
]) {
  requireTerm(performerLogin, term, 'Claim challenge inspection');
}

for (const term of [
  'mapClaimInspectionToClientError',
  "code: 'expired'",
  "code: 'already_used'",
  "code: 'profile_already_claimed'",
  "code: 'payout_identity_configured'",
  'performerPayoutPreferences',
  'performerWithdrawals',
  'performerPayoutKycReviews',
  'transferPerformerOwnership',
  'claimCodeFingerprint'
]) {
  requireTerm(accountClaim, term, 'Account claim helpers');
}

if (account.includes('console.log(claimCode') || server.includes('console.warn(claimCode')) {
  failures.push('Full claim codes must not be logged.');
}

if (failures.length) {
  console.error('Account claim-code onboarding contract FAILED:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Account claim-code onboarding contract passed.');
const behavior = spawnSync(process.execPath, ['scripts/sway-signup-claim.behavior.test.mjs'], { stdio: 'inherit' });
if (behavior.error) throw behavior.error;
if (behavior.status !== 0) process.exit(behavior.status || 1);

for (const script of ['scripts/sway-signup-claim.browser.test.mjs', 'scripts/sway-account-home.browser.test.mjs']) {
  const browser = spawnSync(process.execPath, [script], { stdio: 'inherit' });
  if (browser.error) throw browser.error;
  if (browser.status !== 0) process.exit(browser.status || 1);
}
