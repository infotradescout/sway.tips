import assert from 'node:assert/strict';
import { handleStripeConnectAccountStatusWebhook } from '../src/server/stripe-connect-webhook';

const accountEvent = {
  accountId: 'acct_webhook_test',
  paymentMode: 'test' as const,
  status: { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true },
  providerEventId: 'evt_webhook_test',
  eventType: 'v2.core.account.updated'
};

function responseRecorder() {
  let statusCode = 200;
  let body: unknown = null;
  const response = {
    status(nextStatusCode: number) {
      statusCode = nextStatusCode;
      return response;
    },
    json(nextBody: unknown) {
      body = nextBody;
      return response;
    }
  };
  return { response, read: () => ({ statusCode, body }) };
}

{
  const { response, read } = responseRecorder();
  await handleStripeConnectAccountStatusWebhook({
    res: response,
    accountEvent,
    applyStatus: async (received) => {
      assert.deepEqual(received, accountEvent);
      return { kind: 'updated', performerId: '20000000-0000-4000-8000-000000000021' };
    }
  });
  assert.deepEqual(read(), {
    statusCode: 200,
    body: { received: true, result: { type: 'account.updated' } }
  });
}

{
  const { response, read } = responseRecorder();
  await handleStripeConnectAccountStatusWebhook({
    res: response,
    accountEvent,
    applyStatus: async () => ({
      kind: 'unchanged',
      performerId: '20000000-0000-4000-8000-000000000021'
    })
  });
  assert.deepEqual(read(), {
    statusCode: 200,
    body: { received: true, result: { type: 'account.updated' } }
  });
}

{
  const { response, read } = responseRecorder();
  await handleStripeConnectAccountStatusWebhook({
    res: response,
    accountEvent,
    applyStatus: async () => ({ kind: 'not_found' })
  });
  assert.deepEqual(read(), {
    statusCode: 400,
    body: { error: 'stripe_connect_account_not_bound' }
  });
}

{
  const { response, read } = responseRecorder();
  await handleStripeConnectAccountStatusWebhook({
    res: response,
    accountEvent,
    applyStatus: async () => {
      throw new Error('database unavailable');
    }
  });
  assert.deepEqual(read(), {
    statusCode: 400,
    body: { error: 'database unavailable' }
  });
}

console.log('Stripe Connect webhook behavior test passed.');
