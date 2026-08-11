import type { ConnectAccountStatus } from './stripe-connect';
import type { StripeConnectStatusReconciliationResult } from './stripe-connect-status';

type AccountStatusEvent = {
  accountId: string;
  status: ConnectAccountStatus;
  providerEventId: string;
  eventType: string;
};

type JsonResponse<Response> = {
  status: (statusCode: number) => Response;
  json: (body: unknown) => unknown;
};

export async function handleStripeConnectAccountStatusWebhook<
  Response extends JsonResponse<Response>
>(input: {
  res: Response;
  accountEvent: AccountStatusEvent;
  applyStatus: (accountEvent: AccountStatusEvent) => Promise<StripeConnectStatusReconciliationResult>;
}) {
  try {
    const reconciliation = await input.applyStatus(input.accountEvent);
    if (reconciliation.kind === 'not_found') {
      throw new Error('stripe_connect_account_not_bound');
    }
    return input.res.json({ received: true, result: { type: 'account.updated' } });
  } catch (error) {
    return input.res.status(400).json({
      error: error instanceof Error ? error.message : 'Connect webhook processing failed.'
    });
  }
}
