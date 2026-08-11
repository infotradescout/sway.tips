import type { StripeConnectService } from './stripe-connect';
import type { StripeConnectOnboardingStore } from './stripe-connect-onboarding-store';

export type StripeConnectProvisioningResult =
  | { kind: 'bound'; accountId: string }
  | { kind: 'busy' }
  | { kind: 'not_found' }
  | { kind: 'unverified' };

export async function provisionStripeConnectRecipient(input: {
  performerId: string;
  ownerUserId: string;
  store: StripeConnectOnboardingStore;
  stripe: StripeConnectService;
}): Promise<StripeConnectProvisioningResult> {
  const reservation = await input.store.reserve({
    performerId: input.performerId,
    ownerUserId: input.ownerUserId
  });

  if (reservation.kind !== 'reserved') return reservation;

  try {
    const created = await input.stripe.createRecipientAccount({
      displayName: reservation.displayName,
      contactEmail: reservation.contactEmail,
      operationKey: reservation.operationKey
    });
    const completed = await input.store.complete({
      performerId: input.performerId,
      ownerUserId: input.ownerUserId,
      leaseToken: reservation.leaseToken,
      operationKey: reservation.operationKey,
      accountId: created.accountId
    });
    return { kind: 'bound', accountId: completed.accountId };
  } catch (error) {
    await input.store.fail({
      performerId: input.performerId,
      leaseToken: reservation.leaseToken,
      error
    }).catch(() => undefined);
    throw error;
  }
}
