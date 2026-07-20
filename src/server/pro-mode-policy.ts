export const SWAY_CORE_PRO_PLAN_KEY = 'sway_core_pro' as const;
export const SWAY_CORE_PRO_MONTHLY_PRICE_CENTS = 1900 as const;
export const FOUNDING_PRO_LIFETIME_ENTITLEMENT = 'founding_pro_lifetime' as const;

export const PRO_MODE_STATUSES = [
  'disabled',
  'onboarding',
  'active',
  'suspended',
  'revoked'
] as const;

export type ProModeStatus = (typeof PRO_MODE_STATUSES)[number];

export type FoundingProQualificationRequirement =
  | 'public_beta_active'
  | 'offer_not_open'
  | 'offer_closed'
  | 'account_verification'
  | 'published_creator_profile'
  | 'founding_terms_acceptance';

export type FoundingProQualificationInput = {
  publicBetaActive: boolean;
  evaluatedAt: Date;
  offerOpenedAt?: Date | null;
  offerClosesAt?: Date | null;
  accountVerified: boolean;
  creatorProfilePublished: boolean;
  foundingTermsAccepted: boolean;
};

export type FoundingProQualificationResult = {
  eligible: boolean;
  missingRequirements: FoundingProQualificationRequirement[];
};

export function evaluateFoundingProQualification(
  input: FoundingProQualificationInput
): FoundingProQualificationResult {
  const missingRequirements: FoundingProQualificationRequirement[] = [];

  if (!input.publicBetaActive) {
    missingRequirements.push('public_beta_active');
  }
  if (input.offerOpenedAt && input.evaluatedAt < input.offerOpenedAt) {
    missingRequirements.push('offer_not_open');
  }
  if (input.offerClosesAt && input.evaluatedAt >= input.offerClosesAt) {
    missingRequirements.push('offer_closed');
  }
  if (!input.accountVerified) {
    missingRequirements.push('account_verification');
  }
  if (!input.creatorProfilePublished) {
    missingRequirements.push('published_creator_profile');
  }
  if (!input.foundingTermsAccepted) {
    missingRequirements.push('founding_terms_acceptance');
  }

  return {
    eligible: missingRequirements.length === 0,
    missingRequirements
  };
}

export type CoreProAccessSource =
  | 'founding_lifetime'
  | 'paid_subscription'
  | 'free_trial'
  | 'none';

export type CoreProAccessInput = {
  proModeStatus: ProModeStatus;
  foundingLifetimeEntitlementActive: boolean;
  paidSubscriptionActive: boolean;
  freeTrialActive: boolean;
};

export type CoreProAccessDecision = {
  allowed: boolean;
  source: CoreProAccessSource;
  requiresPaidSubscription: boolean;
  reason:
    | 'founding_lifetime_access'
    | 'paid_subscription_active'
    | 'free_trial_active'
    | 'pro_mode_not_active'
    | 'no_eligible_access';
};

export function resolveCoreProAccess(input: CoreProAccessInput): CoreProAccessDecision {
  if (input.proModeStatus !== 'active') {
    return {
      allowed: false,
      source: 'none',
      requiresPaidSubscription: false,
      reason: 'pro_mode_not_active'
    };
  }

  if (input.foundingLifetimeEntitlementActive) {
    return {
      allowed: true,
      source: 'founding_lifetime',
      requiresPaidSubscription: false,
      reason: 'founding_lifetime_access'
    };
  }

  if (input.paidSubscriptionActive) {
    return {
      allowed: true,
      source: 'paid_subscription',
      requiresPaidSubscription: true,
      reason: 'paid_subscription_active'
    };
  }

  if (input.freeTrialActive) {
    return {
      allowed: true,
      source: 'free_trial',
      requiresPaidSubscription: false,
      reason: 'free_trial_active'
    };
  }

  return {
    allowed: false,
    source: 'none',
    requiresPaidSubscription: false,
    reason: 'no_eligible_access'
  };
}

export type SubscriptionCreditApplicationInput = {
  invoiceAmountCents?: number;
  availableCreditCents: number;
  foundingLifetimeEntitlementActive: boolean;
};

export type SubscriptionCreditApplication = {
  invoiceAmountCents: number;
  appliedCreditCents: number;
  amountDueCents: number;
  remainingCreditCents: number;
  fullyCovered: boolean;
};

function normalizeWholeCents(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

export function calculateSubscriptionCreditApplication(
  input: SubscriptionCreditApplicationInput
): SubscriptionCreditApplication {
  const invoiceAmountCents = normalizeWholeCents(
    input.invoiceAmountCents ?? SWAY_CORE_PRO_MONTHLY_PRICE_CENTS
  );
  const availableCreditCents = normalizeWholeCents(input.availableCreditCents);

  // Founding Pro accounts owe $0 for the core plan. Their credits remain available
  // for separately eligible future Sway charges and are never consumed by core access.
  if (input.foundingLifetimeEntitlementActive) {
    return {
      invoiceAmountCents,
      appliedCreditCents: 0,
      amountDueCents: 0,
      remainingCreditCents: availableCreditCents,
      fullyCovered: true
    };
  }

  const appliedCreditCents = Math.min(invoiceAmountCents, availableCreditCents);
  const amountDueCents = invoiceAmountCents - appliedCreditCents;

  return {
    invoiceAmountCents,
    appliedCreditCents,
    amountDueCents,
    remainingCreditCents: availableCreditCents - appliedCreditCents,
    fullyCovered: amountDueCents === 0
  };
}
