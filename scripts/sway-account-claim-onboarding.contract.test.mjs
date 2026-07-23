import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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

const confirmIdx = account.indexOf('placeholder="Confirm password"');
const claimFieldIdx = account.indexOf('<ClaimCodeField');
const termsIdx = account.indexOf('I accept the Sway Terms.');
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
