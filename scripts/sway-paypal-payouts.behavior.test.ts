import assert from 'node:assert/strict';
import {
  createConfiguredPayPalPayoutsAdapter,
  createPayPalPayoutsAdapter,
  PayPalPayoutsError,
  payPalSenderItemId
} from '../src/server/paypal-payouts';

type FetchCall = { url: string; init: RequestInit };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function queuedFetch(responses: Response[]) {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const response = responses.shift();
    if (!response) throw new Error('unexpected fetch call');
    return response;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const transport = queuedFetch([
  jsonResponse({ access_token: 'sandbox-access-token', expires_in: 3_600 }),
  jsonResponse({ batch_header: { payout_batch_id: 'BATCH-PAYPAL', batch_status: 'PENDING' } }, 201),
  jsonResponse({ batch_header: { payout_batch_id: 'BATCH-VENMO', batch_status: 'PENDING' } }, 201),
  jsonResponse({ batch_header: { payout_batch_id: 'BATCH-PAYPAL-RETRY', batch_status: 'PENDING' } }, 201),
  jsonResponse({
    batch_header: { payout_batch_id: 'BATCH-VENMO', batch_status: 'SUCCESS' },
    items: [{
      payout_batch_id: 'BATCH-VENMO',
      payout_item_id: 'ITEM-VENMO',
      transaction_id: 'TXN-VENMO',
      transaction_status: 'SUCCESS',
      payout_item: { sender_item_id: payPalSenderItemId('withdrawal-venmo') },
      payout_item_fee: { currency: 'USD', value: '0.25' }
    }]
  }),
  jsonResponse({ verification_status: 'SUCCESS' }),
  jsonResponse({ verification_status: 'FAILURE' })
]);

const adapter = createPayPalPayoutsAdapter({
  clientId: 'sandbox-client-id',
  clientSecret: 'sandbox-client-secret',
  webhookId: 'sandbox-webhook-id',
  mode: 'test',
  feeCents: 25,
  fetchImpl: transport.fetchImpl,
  now: () => Date.parse('2026-09-02T12:00:00.000Z')
});

const paypal = await adapter.createPayout({
  withdrawalId: 'withdrawal-paypal',
  destinationKind: 'paypal',
  recipientType: 'email',
  recipientValue: 'artist@example.test',
  netAmountCents: 1_275
});
assert.equal(paypal.payoutBatchId, 'BATCH-PAYPAL');

const venmo = await adapter.createPayout({
  withdrawalId: 'withdrawal-venmo',
  destinationKind: 'venmo',
  recipientType: 'user_handle',
  recipientValue: 'sway-artist',
  netAmountCents: 2_475
});
assert.equal(venmo.payoutBatchId, 'BATCH-VENMO');

await adapter.createPayout({
  withdrawalId: 'withdrawal-paypal',
  destinationKind: 'paypal',
  recipientType: 'email',
  recipientValue: 'artist@example.test',
  netAmountCents: 1_275
});

assert.equal(transport.calls.filter((call) => call.url.endsWith('/v1/oauth2/token')).length, 1,
  'OAuth credentials should be cached without leaking into payout bodies');
const payoutCalls = transport.calls.filter((call) => call.url.endsWith('/v1/payments/payouts'));
assert.equal(payoutCalls.length, 3);
assert.ok(payoutCalls.every((call) => call.url.startsWith('https://api-m.sandbox.paypal.com/')));

const paypalBody = JSON.parse(String(payoutCalls[0].init.body));
assert.deepEqual(paypalBody.items[0], {
  recipient_type: 'EMAIL',
  amount: { value: '12.75', currency: 'USD' },
  receiver: 'artist@example.test',
  note: 'Your Sway performer earnings cash-out',
  sender_item_id: payPalSenderItemId('withdrawal-paypal')
});
assert.equal('recipient_wallet' in paypalBody.items[0], false, 'ordinary PayPal payouts must use the default wallet');

const venmoBody = JSON.parse(String(payoutCalls[1].init.body));
assert.equal(venmoBody.items[0].recipient_wallet, 'Venmo', 'native Venmo requires PayPal\'s exact wallet selector');
assert.equal(venmoBody.items[0].recipient_type, 'USER_HANDLE');
assert.equal(venmoBody.items[0].receiver, 'sway-artist');
assert.equal(venmoBody.items[0].amount.value, '24.75');

const firstRequestHeaders = payoutCalls[0].init.headers as Record<string, string>;
const replayRequestHeaders = payoutCalls[2].init.headers as Record<string, string>;
assert.equal(firstRequestHeaders['PayPal-Request-Id'], replayRequestHeaders['PayPal-Request-Id'],
  'provider retries must reuse a stable PayPal request identity');
assert.equal(
  paypalBody.sender_batch_header.sender_batch_id,
  JSON.parse(String(payoutCalls[2].init.body)).sender_batch_header.sender_batch_id
);

const batch = await adapter.getBatch('BATCH-VENMO', payPalSenderItemId('withdrawal-venmo'));
assert.equal(batch.item?.transactionStatus, 'SUCCESS');
assert.equal(batch.item?.actualProviderFeeCents, 25);
assert.equal(batch.item?.transactionId, 'TXN-VENMO');

const rawWebhook = JSON.stringify({
  id: 'WH-EVENT-1',
  event_type: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
  resource: { payout_batch_id: 'BATCH-VENMO' }
});
const verified = await adapter.verifyWebhook({
  rawBody: rawWebhook,
  headers: {
    authAlgo: 'SHA256withRSA',
    certUrl: 'https://api-m.sandbox.paypal.com/cert.pem',
    transmissionId: 'transmission-id',
    transmissionSig: 'transmission-signature',
    transmissionTime: '2026-09-02T12:00:00Z'
  }
});
assert.deepEqual(verified, {
  providerEventId: 'WH-EVENT-1',
  eventType: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
  resource: { payout_batch_id: 'BATCH-VENMO' }
});
const verificationCall = transport.calls.find((call) => call.url.endsWith('/v1/notifications/verify-webhook-signature'));
assert.ok(verificationCall);
const verificationBody = JSON.parse(String(verificationCall.init.body));
assert.equal(verificationBody.webhook_id, 'sandbox-webhook-id');
assert.deepEqual(verificationBody.webhook_event, JSON.parse(rawWebhook));

await assert.rejects(adapter.verifyWebhook({
  rawBody: rawWebhook,
  headers: {
    authAlgo: 'SHA256withRSA',
    certUrl: 'https://api-m.sandbox.paypal.com/cert.pem',
    transmissionId: 'bad-transmission-id',
    transmissionSig: 'bad-signature',
    transmissionTime: '2026-09-02T12:00:00Z'
  }
}), (error: unknown) => error instanceof PayPalPayoutsError
  && error.status === 401
  && error.retryable === false);

await assert.rejects(adapter.createPayout({
  withdrawalId: 'withdrawal-sandbox-phone',
  destinationKind: 'venmo',
  recipientType: 'phone',
  recipientValue: '+19855550123',
  netAmountCents: 1_000
}), (error: unknown) => error instanceof PayPalPayoutsError
  && error.providerName === 'SANDBOX_PHONE_UNSUPPORTED'
  && error.retryable === false);

const rateLimitedTransport = queuedFetch([
  jsonResponse({ access_token: 'token', expires_in: 3_600 }),
  jsonResponse({ name: 'RATE_LIMIT_REACHED', message: 'Retry later' }, 429)
]);
const rateLimited = createPayPalPayoutsAdapter({
  clientId: 'id',
  clientSecret: 'secret',
  webhookId: 'webhook',
  mode: 'live',
  feeCents: 25,
  fetchImpl: rateLimitedTransport.fetchImpl
});
await assert.rejects(rateLimited.createPayout({
  withdrawalId: 'withdrawal-rate-limit',
  destinationKind: 'paypal',
  recipientType: 'email',
  recipientValue: 'artist@example.test',
  netAmountCents: 1_000
}), (error: unknown) => error instanceof PayPalPayoutsError
  && error.status === 429
  && error.retryable
  && error.providerName === 'RATE_LIMIT_REACHED');
assert.ok(rateLimitedTransport.calls.every((call) => call.url.startsWith('https://api-m.paypal.com/')),
  'live credentials must never call the sandbox endpoint');

const duplicateTransport = queuedFetch([
  jsonResponse({ access_token: 'token', expires_in: 3_600 }),
  jsonResponse({
    name: 'VALIDATION_ERROR',
    message: 'Invalid request',
    details: [{ issue: 'DUPLICATE_BATCH_ID', field: 'sender_batch_header.sender_batch_id' }],
    links: [{
      href: 'https://api-m.paypal.com/v1/payments/payouts/ORIGINAL-BATCH-123',
      rel: 'self',
      method: 'GET'
    }]
  }, 400)
]);
const duplicate = createPayPalPayoutsAdapter({
  clientId: 'id',
  clientSecret: 'secret',
  webhookId: 'webhook',
  mode: 'live',
  feeCents: 25,
  fetchImpl: duplicateTransport.fetchImpl
});
const recoveredDuplicate = await duplicate.createPayout({
  withdrawalId: 'withdrawal-duplicate-batch',
  destinationKind: 'paypal',
  recipientType: 'email',
  recipientValue: 'artist@example.test',
  netAmountCents: 1_000
});
assert.deepEqual(recoveredDuplicate, {
  payoutBatchId: 'ORIGINAL-BATCH-123',
  senderItemId: payPalSenderItemId('withdrawal-duplicate-batch'),
  batchStatus: 'PENDING'
}, 'a duplicate response must recover the original PayPal batch identity without issuing another payout');

const untrustedDuplicateLinkTransport = queuedFetch([
  jsonResponse({ access_token: 'token', expires_in: 3_600 }),
  jsonResponse({
    name: 'VALIDATION_ERROR',
    details: [{ issue: 'DUPLICATE_BATCH_ID' }],
    links: [{ href: 'https://attacker.example/v1/payments/payouts/WRONG', rel: 'self', method: 'GET' }]
  }, 400)
]);
const untrustedDuplicateLink = createPayPalPayoutsAdapter({
  clientId: 'id',
  clientSecret: 'secret',
  webhookId: 'webhook',
  mode: 'live',
  feeCents: 25,
  fetchImpl: untrustedDuplicateLinkTransport.fetchImpl
});
await assert.rejects(untrustedDuplicateLink.createPayout({
  withdrawalId: 'withdrawal-untrusted-duplicate-link',
  destinationKind: 'paypal',
  recipientType: 'email',
  recipientValue: 'artist@example.test',
  netAmountCents: 1_000
}), (error: unknown) => error instanceof PayPalPayoutsError
  && error.retryable
  && error.duplicatePayoutBatchId === null,
'an untrusted duplicate link must never be followed or accepted as provider identity');

assert.equal(createConfiguredPayPalPayoutsAdapter({}), null);
assert.throws(() => createConfiguredPayPalPayoutsAdapter({
  SWAY_PAYPAL_PAYOUTS_MODE: 'live',
  SWAY_PAYPAL_PAYOUTS_CLIENT_ID: 'id'
}), /configuration_incomplete/);
assert.throws(() => createConfiguredPayPalPayoutsAdapter({
  SWAY_PAYPAL_PAYOUTS_MODE: 'test',
  SWAY_PAYPAL_PAYOUTS_CLIENT_ID: 'id',
  SWAY_PAYPAL_PAYOUTS_CLIENT_SECRET: 'secret',
  SWAY_PAYPAL_PAYOUTS_WEBHOOK_ID: 'webhook',
  SWAY_PAYPAL_PAYOUTS_FEE_CENTS: '-1'
}), /fee_invalid/);

console.log('PayPal Payouts adapter behavior test passed.');
