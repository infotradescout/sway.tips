import type { ConnectAccountStatus } from './stripe-connect';
import type { StripeConnectStatusReconciliationResult } from './stripe-connect-status';

type TalentAccess =
  | { allowed: false }
  | { allowed: true; actor: { actorId: string | null } };

type RedirectResponse = {
  redirect: (status: number, path: string) => unknown;
};

export async function handleStripeConnectReturn<Request, Response extends RedirectResponse>(input: {
  req: Request;
  res: Response;
  runtimeAvailable: boolean;
  requireTalentAccess: (req: Request) => Promise<TalentAccess>;
  loadOwnedPerformer: (ownerUserId: string) => Promise<{
    performerId: string;
    stripeAccountId: string | null;
  } | null>;
  getAccountStatus: (accountId: string) => Promise<ConnectAccountStatus>;
  applyStatus: (status: {
    performerId: string;
    ownerUserId: string;
    accountId: string;
    providerStatus: ConnectAccountStatus;
  }) => Promise<StripeConnectStatusReconciliationResult>;
  logError?: (error: unknown) => void;
}) {
  try {
    const talentAccess = await input.requireTalentAccess(input.req);
    if (talentAccess.allowed === false || !talentAccess.actor.actorId) {
      return input.res.redirect(303, '/talent/account?connect=auth');
    }
    if (!input.runtimeAvailable) {
      return input.res.redirect(303, '/talent/account?connect=pending');
    }
    const ownerUserId = talentAccess.actor.actorId;
    const performerOwner = await input.loadOwnedPerformer(ownerUserId);
    if (!performerOwner?.stripeAccountId) {
      return input.res.redirect(303, '/talent/account?connect=pending');
    }
    const providerStatus = await input.getAccountStatus(performerOwner.stripeAccountId);
    const result = await input.applyStatus({
      performerId: performerOwner.performerId,
      ownerUserId,
      accountId: performerOwner.stripeAccountId,
      providerStatus
    });
    return input.res.redirect(
      303,
      result.kind === 'not_found' ? '/talent/account?connect=pending' : '/talent/account?connect=return'
    );
  } catch (error) {
    input.logError?.(error);
    return input.res.redirect(303, '/talent/account?connect=pending');
  }
}
