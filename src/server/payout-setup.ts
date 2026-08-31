import type { StripeConnectProvisioningResult } from './stripe-connect-onboarding';

export type PreparedPayoutSetup =
  | { kind: 'ready'; url: string; accountId: string; setupSurface: 'management' | 'onboarding' }
  | { kind: 'busy' }
  | { kind: 'not_found' }
  | { kind: 'unverified' };

export async function preparePayoutSetup(input: {
  useManagementPortal: boolean;
  provision: () => Promise<StripeConnectProvisioningResult>;
  createOnboardingLink: (accountId: string) => Promise<{ url: string }>;
  createManagementLink: (accountId: string) => Promise<{ url: string }>;
  persistDestination: () => Promise<{ kind: 'updated' | 'unchanged' | 'not_found' }>;
}): Promise<PreparedPayoutSetup> {
  const provisioning = await input.provision();
  if (provisioning.kind !== 'bound') return provisioning;

  const setupSurface = input.useManagementPortal ? 'management' : 'onboarding';
  const link = input.useManagementPortal
    ? await input.createManagementLink(provisioning.accountId)
    : await input.createOnboardingLink(provisioning.accountId);

  const preference = await input.persistDestination();
  if (preference.kind === 'not_found') return { kind: 'not_found' };

  return {
    kind: 'ready',
    url: link.url,
    accountId: provisioning.accountId,
    setupSurface
  };
}
