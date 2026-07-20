import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { createRequire } from 'node:module';

const root = process.cwd();

async function loadPolicyModule() {
  const tempDir = join(root, '.tmp');
  mkdirSync(tempDir, { recursive: true });
  const outfile = join(tempDir, 'sway-phase2-pro-mode-foundation.contract.bundle.cjs');

  await build({
    entryPoints: ['src/server/pro-mode-policy.ts'],
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
  const policy = await loadPolicyModule();

  assert.equal(policy.SWAY_CORE_PRO_PLAN_KEY, 'sway_core_pro');
  assert.equal(policy.SWAY_CORE_PRO_MONTHLY_PRICE_CENTS, 1900);
  assert.equal(policy.FOUNDING_PRO_LIFETIME_ENTITLEMENT, 'founding_pro_lifetime');
  assert.deepEqual(policy.PRO_MODE_STATUSES, [
    'disabled',
    'onboarding',
    'active',
    'suspended',
    'revoked'
  ]);

  const eligibleFoundingAccount = policy.evaluateFoundingProQualification({
    publicBetaActive: true,
    evaluatedAt: new Date('2026-07-20T18:00:00.000Z'),
    offerOpenedAt: new Date('2026-07-01T00:00:00.000Z'),
    offerClosesAt: null,
    accountVerified: true,
    creatorProfilePublished: true,
    foundingTermsAccepted: true
  });
  assert.equal(eligibleFoundingAccount.eligible, true);
  assert.deepEqual(eligibleFoundingAccount.missingRequirements, []);

  const incompleteFoundingAccount = policy.evaluateFoundingProQualification({
    publicBetaActive: true,
    evaluatedAt: new Date('2026-07-20T18:00:00.000Z'),
    accountVerified: false,
    creatorProfilePublished: false,
    foundingTermsAccepted: false
  });
  assert.equal(incompleteFoundingAccount.eligible, false);
  assert.deepEqual(incompleteFoundingAccount.missingRequirements, [
    'account_verification',
    'published_creator_profile',
    'founding_terms_acceptance'
  ]);

  const closedOffer = policy.evaluateFoundingProQualification({
    publicBetaActive: false,
    evaluatedAt: new Date('2026-08-01T00:00:00.000Z'),
    offerOpenedAt: new Date('2026-07-01T00:00:00.000Z'),
    offerClosesAt: new Date('2026-08-01T00:00:00.000Z'),
    accountVerified: true,
    creatorProfilePublished: true,
    foundingTermsAccepted: true
  });
  assert.equal(closedOffer.eligible, false);
  assert.deepEqual(closedOffer.missingRequirements, ['public_beta_active', 'offer_closed']);

  const disabledPatron = policy.resolveCoreProAccess({
    proModeStatus: 'disabled',
    foundingLifetimeEntitlementActive: true,
    paidSubscriptionActive: true,
    freeTrialActive: true
  });
  assert.equal(disabledPatron.allowed, false, 'Pro capabilities require an active Pro Mode state.');
  assert.equal(disabledPatron.reason, 'pro_mode_not_active');

  const foundingAccess = policy.resolveCoreProAccess({
    proModeStatus: 'active',
    foundingLifetimeEntitlementActive: true,
    paidSubscriptionActive: false,
    freeTrialActive: false
  });
  assert.equal(foundingAccess.allowed, true);
  assert.equal(foundingAccess.source, 'founding_lifetime');
  assert.equal(foundingAccess.requiresPaidSubscription, false);

  const paidAccess = policy.resolveCoreProAccess({
    proModeStatus: 'active',
    foundingLifetimeEntitlementActive: false,
    paidSubscriptionActive: true,
    freeTrialActive: false
  });
  assert.equal(paidAccess.allowed, true);
  assert.equal(paidAccess.source, 'paid_subscription');
  assert.equal(paidAccess.requiresPaidSubscription, true);

  const trialAccess = policy.resolveCoreProAccess({
    proModeStatus: 'active',
    foundingLifetimeEntitlementActive: false,
    paidSubscriptionActive: false,
    freeTrialActive: true
  });
  assert.equal(trialAccess.allowed, true);
  assert.equal(trialAccess.source, 'free_trial');

  const fullyCoveredSubscription = policy.calculateSubscriptionCreditApplication({
    availableCreditCents: 2400,
    foundingLifetimeEntitlementActive: false
  });
  assert.deepEqual(fullyCoveredSubscription, {
    invoiceAmountCents: 1900,
    appliedCreditCents: 1900,
    amountDueCents: 0,
    remainingCreditCents: 500,
    fullyCovered: true
  });

  const partiallyCoveredSubscription = policy.calculateSubscriptionCreditApplication({
    availableCreditCents: 750,
    foundingLifetimeEntitlementActive: false
  });
  assert.deepEqual(partiallyCoveredSubscription, {
    invoiceAmountCents: 1900,
    appliedCreditCents: 750,
    amountDueCents: 1150,
    remainingCreditCents: 0,
    fullyCovered: false
  });

  const foundingSubscription = policy.calculateSubscriptionCreditApplication({
    availableCreditCents: 1200,
    foundingLifetimeEntitlementActive: true
  });
  assert.deepEqual(foundingSubscription, {
    invoiceAmountCents: 1900,
    appliedCreditCents: 0,
    amountDueCents: 0,
    remainingCreditCents: 1200,
    fullyCovered: true
  }, 'Founding Pro must remain free without consuming subscription credits.');

  const normalizedInvalidCredits = policy.calculateSubscriptionCreditApplication({
    invoiceAmountCents: 1900.9,
    availableCreditCents: -100,
    foundingLifetimeEntitlementActive: false
  });
  assert.deepEqual(normalizedInvalidCredits, {
    invoiceAmountCents: 1900,
    appliedCreditCents: 0,
    amountDueCents: 1900,
    remainingCreditCents: 0,
    fullyCovered: false
  });

  console.log('Sway Phase 2 Pro Mode foundation contract passed.');
}

main().catch((error) => {
  console.error('Sway Phase 2 Pro Mode foundation contract failed:');
  console.error(error);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
