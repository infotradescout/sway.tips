import { spawnSync } from 'node:child_process';

const root = process.cwd();

const behaviorProgram = String.raw`
  import assert from 'node:assert/strict';
  import Stripe from 'stripe';
  import {
    createConfiguredEventTicketStripeProvider,
    createEventTicketStripeProvider
  } from './src/server/event-ticket-stripe-provider.ts';
  import { STRIPE_API_VERSION } from './src/server/payment-provider.ts';

  const webhookSecret = 'whsec_ticket_behavior_test';
  const secretKey = 'sk_test_ticket_behavior_test';
  const provider = createEventTicketStripeProvider({
    secretKey,
    webhookSecret,
    tax: {
      mode: 'stripe_automatic',
      productTaxCode: 'txcd_10000000'
    }
  });

  assert.equal(provider.processor, 'stripe');
  assert.deepEqual(provider.tax, {
    mode: 'stripe_automatic',
    productTaxCode: 'txcd_10000000'
  });

  assert.equal(createConfiguredEventTicketStripeProvider({}), null);
  assert.equal(createConfiguredEventTicketStripeProvider({
    STRIPE_SECRET_KEY: secretKey,
    STRIPE_TICKET_WEBHOOK_SECRET: webhookSecret
  }), null);
  assert.equal(createConfiguredEventTicketStripeProvider({
    STRIPE_SECRET_KEY: secretKey,
    STRIPE_TICKET_WEBHOOK_SECRET: webhookSecret,
    SWAY_TICKET_TAX_MODE: 'stripe_automatic'
  }), null);
  assert.throws(() => createEventTicketStripeProvider({
    secretKey,
    webhookSecret,
    tax: {
      mode: 'stripe_automatic',
      productTaxCode: 'not-a-tax-code'
    }
  }));

  const stripeProbe = new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION });
  const checkoutPrototype = Object.getPrototypeOf(stripeProbe.checkout.sessions);
  const paymentIntentPrototype = Object.getPrototypeOf(stripeProbe.paymentIntents);
  const transferPrototype = Object.getPrototypeOf(stripeProbe.transfers);
  const refundPrototype = Object.getPrototypeOf(stripeProbe.refunds);
  const originalCheckoutCreate = checkoutPrototype.create;
  const originalPaymentIntentRetrieve = paymentIntentPrototype.retrieve;
  const originalTransferCreate = transferPrototype.create;
  const originalRefundCreate = refundPrototype.create;
  const checkoutCalls = [];
  const paymentIntentRetrieveCalls = [];
  const transferCalls = [];
  const refundCalls = [];

  checkoutPrototype.create = async (...args) => {
    checkoutCalls.push(args);
    return {
      id: 'cs_ticket_order_1',
      object: 'checkout.session',
      url: 'https://checkout.stripe.test/c/pay/cs_ticket_order_1',
      status: 'open',
      payment_status: 'unpaid',
      payment_intent: null,
      amount_subtotal: 1_155,
      amount_total: 1_155,
      total_details: { amount_tax: 0 },
      currency: 'usd',
      expires_at: 2_000_000_000,
      metadata: { sway_ticket_order_id: 'order-1' }
    };
  };
  paymentIntentPrototype.retrieve = async (...args) => {
    paymentIntentRetrieveCalls.push(args);
    const paymentIntentId = args[0];
    const common = {
      id: paymentIntentId,
      object: 'payment_intent',
      status: 'succeeded',
      amount: 1_255,
      amount_received: 1_255,
      currency: 'usd',
      transfer_group: 'sway_ticket_order_1',
      metadata: { sway_ticket_order_id: 'order-1' }
    };
    if (paymentIntentId === 'pi_ticket_balance_unavailable') {
      return {
        ...common,
        latest_charge: {
          id: 'ch_ticket_balance_unavailable',
          object: 'charge',
          amount: 1_255,
          amount_captured: 1_255,
          currency: 'usd',
          balance_transaction: 'txn_ticket_balance_unavailable'
        }
      };
    }
    if (paymentIntentId === 'pi_ticket_balance_bad_net') {
      return {
        ...common,
        latest_charge: {
          id: 'ch_ticket_balance_bad_net',
          object: 'charge',
          amount: 1_255,
          amount_captured: 1_255,
          currency: 'usd',
          balance_transaction: {
            id: 'txn_ticket_balance_bad_net',
            object: 'balance_transaction',
            amount: 1_255,
            fee: 66,
            net: 1_190,
            currency: 'usd',
            source: 'ch_ticket_balance_bad_net'
          }
        }
      };
    }
    if (paymentIntentId === 'pi_ticket_balance_bad_currency') {
      return {
        ...common,
        latest_charge: {
          id: 'ch_ticket_balance_bad_currency',
          object: 'charge',
          amount: 1_255,
          amount_captured: 1_255,
          currency: 'usd',
          balance_transaction: {
            id: 'txn_ticket_balance_bad_currency',
            object: 'balance_transaction',
            amount: 1_255,
            fee: 66,
            net: 1_189,
            currency: 'eur',
            source: 'ch_ticket_balance_bad_currency'
          }
        }
      };
    }
    return {
      ...common,
      latest_charge: {
        id: 'ch_ticket_order_1',
        object: 'charge',
        amount: 1_255,
        amount_captured: 1_255,
        currency: 'usd',
        balance_transaction: {
          id: 'txn_ticket_order_1',
          object: 'balance_transaction',
          amount: 1_255,
          fee: 66,
          net: 1_189,
          currency: 'usd',
          source: 'ch_ticket_order_1'
        }
      }
    };
  };
  transferPrototype.create = async (...args) => {
    transferCalls.push(args);
    return {
      id: 'tr_ticket_order_1',
      object: 'transfer',
      amount: 1_000,
      amount_reversed: 0,
      currency: 'usd',
      destination: 'acct_performer_1',
      source_transaction: 'ch_ticket_order_1',
      transfer_group: 'sway_ticket_order_1',
      reversed: false,
      metadata: { sway_ticket_operation: 'performer_transfer' }
    };
  };
  refundPrototype.create = async (...args) => {
    refundCalls.push(args);
    return {
      id: 're_ticket_order_1',
      object: 'refund',
      payment_intent: 'pi_ticket_order_1',
      charge: 'ch_ticket_order_1',
      amount: args[0].amount ?? 1_155,
      currency: 'usd',
      status: 'succeeded',
      metadata: args[0].metadata
    };
  };

  try {
    const checkout = await provider.createCheckoutSession({
      orderId: 'order-1',
      eventId: 'event-1',
      offerId: 'offer-1',
      buyerAccountId: 'account-1',
      buyerEmail: 'buyer@example.test',
      ticketName: 'General admission — Test Show',
      ticketDescription: 'One general-admission ticket.',
      amountTotalCents: 1_155,
      currency: 'USD',
      successUrl: 'https://app.sway.test/tickets/order-1?checkout={CHECKOUT_SESSION_ID}',
      cancelUrl: 'https://app.sway.test/e/event-1',
      expiresAtUnixSeconds: 2_000_000_000,
      termsHash: 'a'.repeat(64),
      transferGroup: 'sway_ticket_order_1',
      idempotencyKey: 'ticket.checkout.order-1.v1',
      metadata: { ticket_id: 'ticket-1' }
    });

    assert.equal(checkout.checkoutSessionId, 'cs_ticket_order_1');
    assert.equal(checkoutCalls.length, 1);
    const [checkoutParams, checkoutOptions] = checkoutCalls[0];
    assert.equal(checkoutParams.mode, 'payment');
    assert.equal(checkoutParams.ui_mode, 'hosted_page');
    assert.deepEqual(checkoutParams.payment_method_types, ['card']);
    assert.equal(checkoutParams.line_items.length, 1);
    assert.equal(checkoutParams.line_items[0].quantity, 1);
    assert.equal(checkoutParams.line_items[0].price_data.unit_amount, 1_155);
    assert.equal(checkoutParams.line_items[0].price_data.tax_behavior, 'exclusive');
    assert.equal(
      checkoutParams.line_items[0].price_data.product_data.tax_code,
      'txcd_10000000'
    );
    assert.deepEqual(checkoutParams.automatic_tax, { enabled: true });
    assert.equal(checkoutParams.payment_intent_data.capture_method, 'automatic');
    assert.equal(
      checkoutParams.payment_intent_data.transfer_group,
      'sway_ticket_order_1'
    );
    assert.equal(
      checkoutParams.payment_intent_data.metadata.sway_ticket_order_id,
      'order-1'
    );
    assert.equal('transfer_data' in checkoutParams.payment_intent_data, false);
    assert.equal('destination' in checkoutParams.payment_intent_data, false);
    assert.equal('application_fee_amount' in checkoutParams.payment_intent_data, false);
    assert.equal(checkoutOptions.idempotencyKey, 'ticket.checkout.order-1.v1');

    const paymentIntent = await provider.retrievePaymentIntent('pi_ticket_order_1');
    assert.equal(paymentIntent.paymentIntentId, 'pi_ticket_order_1');
    assert.equal(paymentIntent.chargeId, 'ch_ticket_order_1');
    assert.equal(paymentIntent.balanceTransactionId, 'txn_ticket_order_1');
    assert.equal(paymentIntent.processingFeeCents, 66);
    assert.equal(paymentIntent.netCents, 1_189);
    assert.deepEqual(paymentIntentRetrieveCalls[0], [
      'pi_ticket_order_1',
      { expand: ['latest_charge.balance_transaction'] }
    ]);

    const unavailableBalanceEvidence = await provider.retrievePaymentIntent(
      'pi_ticket_balance_unavailable'
    );
    assert.equal(unavailableBalanceEvidence.balanceTransactionId, null);
    assert.equal(unavailableBalanceEvidence.processingFeeCents, null);
    assert.equal(unavailableBalanceEvidence.netCents, null);

    await assert.rejects(
      provider.retrievePaymentIntent('pi_ticket_balance_bad_net'),
      /net must equal its amount less its processing fee/
    );
    await assert.rejects(
      provider.retrievePaymentIntent('pi_ticket_balance_bad_currency'),
      /currency must be coherent USD/
    );

    const transfer = await provider.transferProceeds({
      destinationAccountId: 'acct_performer_1',
      sourceChargeId: 'ch_ticket_order_1',
      amountCents: 1_000,
      currency: 'USD',
      transferGroup: 'sway_ticket_order_1',
      idempotencyKey: 'ticket.transfer.order-1.v1',
      metadata: { order_id: 'order-1' }
    });
    assert.equal(transfer.transferId, 'tr_ticket_order_1');
    const [transferParams, transferOptions] = transferCalls[0];
    assert.equal(transferParams.destination, 'acct_performer_1');
    assert.equal(transferParams.source_transaction, 'ch_ticket_order_1');
    assert.equal(transferParams.amount, 1_000);
    assert.equal(transferParams.transfer_group, 'sway_ticket_order_1');
    assert.equal(transferOptions.idempotencyKey, 'ticket.transfer.order-1.v1');

    await provider.refundPayment({
      paymentIntentId: 'pi_ticket_order_1',
      idempotencyKey: 'ticket.refund.order-1.full.v1',
      metadata: { order_id: 'order-1' }
    });
    await provider.refundPayment({
      paymentIntentId: 'pi_ticket_order_1',
      amountCents: 500,
      idempotencyKey: 'ticket.refund.order-1.partial.v1',
      metadata: { order_id: 'order-1' }
    });
    assert.equal('amount' in refundCalls[0][0], false);
    assert.equal(refundCalls[0][1].idempotencyKey, 'ticket.refund.order-1.full.v1');
    assert.equal(refundCalls[1][0].amount, 500);
    assert.equal(refundCalls[1][1].idempotencyKey, 'ticket.refund.order-1.partial.v1');
  } finally {
    checkoutPrototype.create = originalCheckoutCreate;
    paymentIntentPrototype.retrieve = originalPaymentIntentRetrieve;
    transferPrototype.create = originalTransferCreate;
    refundPrototype.create = originalRefundCreate;
  }

  const signedEvent = (type, object, id, account = null) => {
    const payload = JSON.stringify({
      id,
      object: 'event',
      api_version: STRIPE_API_VERSION,
      created: 1_700_000_000,
      data: { object },
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type,
      ...(account ? { account } : {})
    });
    const signatureHeader = stripeProbe.webhooks.generateTestHeaderString({
      payload,
      secret: webhookSecret,
      timestamp: Math.floor(Date.now() / 1_000)
    });
    return provider.parseVerifiedWebhookEvent({
      rawBody: payload,
      signatureHeader
    });
  };

  const checkoutCompleted = signedEvent(
    'checkout.session.completed',
    {
      id: 'cs_ticket_order_1',
      object: 'checkout.session',
      payment_intent: 'pi_ticket_order_1',
      status: 'complete',
      payment_status: 'paid',
      amount_total: 1_255,
      total_details: { amount_tax: 100 },
      currency: 'usd',
      metadata: { sway_ticket_order_id: 'order-1' }
    },
    'evt_checkout_completed'
  );
  assert.equal(checkoutCompleted.kind, 'checkout_completed');
  assert.equal(checkoutCompleted.accountId, null);
  assert.equal(checkoutCompleted.checkoutSessionId, 'cs_ticket_order_1');
  assert.equal(checkoutCompleted.paymentIntentId, 'pi_ticket_order_1');
  assert.equal(checkoutCompleted.amountTaxCents, 100);

  const connectedAccountPayment = signedEvent(
    'payment_intent.succeeded',
    {
      id: 'pi_connected_live_room',
      object: 'payment_intent',
      latest_charge: 'ch_connected_live_room',
      status: 'succeeded',
      amount: 500,
      amount_received: 500,
      currency: 'usd',
      transfer_group: null,
      metadata: { sway_ticket_lane: 'native_ga' }
    },
    'evt_connected_account_payment',
    'acct_connected_performer'
  );
  assert.equal(connectedAccountPayment.accountId, 'acct_connected_performer');

  const checkoutExpired = signedEvent(
    'checkout.session.expired',
    {
      id: 'cs_ticket_order_2',
      object: 'checkout.session',
      payment_intent: null,
      status: 'expired',
      payment_status: 'unpaid',
      amount_total: 1_155,
      total_details: { amount_tax: 0 },
      currency: 'usd',
      metadata: { sway_ticket_order_id: 'order-2' }
    },
    'evt_checkout_expired'
  );
  assert.equal(checkoutExpired.kind, 'checkout_expired');
  assert.equal(checkoutExpired.paymentIntentId, null);

  const paymentSucceeded = signedEvent(
    'payment_intent.succeeded',
    {
      id: 'pi_ticket_order_1',
      object: 'payment_intent',
      latest_charge: 'ch_ticket_order_1',
      status: 'succeeded',
      amount: 1_255,
      amount_received: 1_255,
      currency: 'usd',
      transfer_group: 'sway_ticket_order_1',
      metadata: { sway_ticket_order_id: 'order-1' }
    },
    'evt_payment_succeeded'
  );
  assert.equal(paymentSucceeded.kind, 'payment_succeeded');
  assert.equal(paymentSucceeded.chargeId, 'ch_ticket_order_1');
  assert.equal(paymentSucceeded.amountCents, 1_255);

  const paymentFailed = signedEvent(
    'payment_intent.payment_failed',
    {
      id: 'pi_ticket_order_2',
      object: 'payment_intent',
      latest_charge: null,
      status: 'requires_payment_method',
      amount: 1_155,
      amount_received: 0,
      currency: 'usd',
      transfer_group: 'sway_ticket_order_2',
      metadata: { sway_ticket_order_id: 'order-2' }
    },
    'evt_payment_failed'
  );
  assert.equal(paymentFailed.kind, 'payment_failed');
  assert.equal(paymentFailed.amountCents, 1_155);

  const partiallyRefunded = signedEvent(
    'charge.refunded',
    {
      id: 'ch_ticket_order_1',
      object: 'charge',
      payment_intent: 'pi_ticket_order_1',
      refunded: false,
      amount_refunded: 500,
      currency: 'usd',
      transfer_group: 'sway_ticket_order_1',
      metadata: { sway_ticket_order_id: 'order-1' }
    },
    'evt_charge_refunded'
  );
  assert.equal(partiallyRefunded.kind, 'charge_refunded');
  assert.equal(partiallyRefunded.status, 'partially_refunded');
  assert.equal(partiallyRefunded.amountCents, 500);

  const refundUpdated = signedEvent(
    'refund.updated',
    {
      id: 're_ticket_order_1',
      object: 'refund',
      payment_intent: 'pi_ticket_order_1',
      charge: 'ch_ticket_order_1',
      status: 'succeeded',
      amount: 1_255,
      currency: 'usd',
      failure_reason: null,
      pending_reason: null,
      metadata: { sway_ticket_order_id: 'order-1' }
    },
    'evt_refund_updated'
  );
  assert.equal(refundUpdated.kind, 'refund_updated');
  assert.equal(refundUpdated.refundId, 're_ticket_order_1');
  assert.equal(refundUpdated.paymentIntentId, 'pi_ticket_order_1');
  assert.equal(refundUpdated.chargeId, 'ch_ticket_order_1');
  assert.equal(refundUpdated.status, 'succeeded');
  assert.equal(refundUpdated.amountCents, 1_255);
  assert.equal(refundUpdated.refundFailureReason, null);
  assert.equal(refundUpdated.refundPendingReason, null);

  const refundFailed = signedEvent(
    'refund.failed',
    {
      id: 're_ticket_order_2',
      object: 'refund',
      payment_intent: 'pi_ticket_order_2',
      charge: 'ch_ticket_order_2',
      status: 'failed',
      amount: 1_155,
      currency: 'usd',
      failure_reason: 'insufficient_funds',
      metadata: { sway_ticket_order_id: 'order-2' }
    },
    'evt_refund_failed'
  );
  assert.equal(refundFailed.kind, 'refund_failed');
  assert.equal(refundFailed.refundId, 're_ticket_order_2');
  assert.equal(refundFailed.status, 'failed');
  assert.equal(refundFailed.refundFailureReason, 'insufficient_funds');

  const disputed = signedEvent(
    'charge.dispute.created',
    {
      id: 'dp_ticket_order_1',
      object: 'dispute',
      charge: 'ch_ticket_order_1',
      payment_intent: 'pi_ticket_order_1',
      status: 'needs_response',
      amount: 1_255,
      currency: 'usd',
      reason: 'fraudulent',
      is_charge_refundable: true,
      metadata: { sway_ticket_order_id: 'order-1' }
    },
    'evt_charge_disputed'
  );
  assert.equal(disputed.kind, 'charge_disputed');
  assert.equal(disputed.disputeId, 'dp_ticket_order_1');
  assert.equal(disputed.chargeId, 'ch_ticket_order_1');
  assert.equal(disputed.paymentIntentId, 'pi_ticket_order_1');
  assert.equal(disputed.disputeReason, 'fraudulent');
  assert.equal(disputed.disputeIsChargeRefundable, true);

  const disputeClosed = signedEvent(
    'charge.dispute.closed',
    {
      id: 'dp_ticket_order_1',
      object: 'dispute',
      charge: 'ch_ticket_order_1',
      payment_intent: 'pi_ticket_order_1',
      status: 'won',
      amount: 1_255,
      currency: 'usd',
      reason: 'fraudulent',
      is_charge_refundable: false,
      metadata: { sway_ticket_order_id: 'order-1' }
    },
    'evt_charge_dispute_closed'
  );
  assert.equal(disputeClosed.kind, 'charge_dispute_closed');
  assert.equal(disputeClosed.disputeId, 'dp_ticket_order_1');
  assert.equal(disputeClosed.status, 'won');
  assert.equal(disputeClosed.paymentIntentId, 'pi_ticket_order_1');
  assert.equal(disputeClosed.chargeId, 'ch_ticket_order_1');
  assert.equal(disputeClosed.disputeReason, 'fraudulent');
  assert.equal(disputeClosed.disputeIsChargeRefundable, false);

  const transferCreated = signedEvent(
    'transfer.created',
    {
      id: 'tr_ticket_order_1',
      object: 'transfer',
      destination: 'acct_performer_1',
      source_transaction: 'ch_ticket_order_1',
      amount: 1_000,
      currency: 'usd',
      transfer_group: 'sway_ticket_order_1',
      metadata: { sway_ticket_order_id: 'order-1' }
    },
    'evt_transfer_created'
  );
  assert.equal(transferCreated.kind, 'transfer_created');
  assert.equal(transferCreated.destinationAccountId, 'acct_performer_1');
  assert.equal(transferCreated.sourceChargeId, 'ch_ticket_order_1');

  const deprecatedTransferFailed = signedEvent(
    'transfer.failed',
    {
      id: 'tr_ticket_order_2',
      object: 'transfer',
      destination: 'acct_performer_1',
      source_transaction: 'ch_ticket_order_2',
      amount: 1_000,
      currency: 'usd',
      transfer_group: 'sway_ticket_order_2',
      metadata: { sway_ticket_order_id: 'order-2' }
    },
    'evt_transfer_failed'
  );
  assert.equal(deprecatedTransferFailed.kind, 'unsupported');
  assert.equal(deprecatedTransferFailed.transferId, null);

  const unsupported = signedEvent(
    'invoice.created',
    { id: 'in_unrelated', object: 'invoice' },
    'evt_unsupported'
  );
  assert.equal(unsupported.kind, 'unsupported');
  assert.equal(unsupported.paymentIntentId, null);

  assert.throws(() => provider.parseVerifiedWebhookEvent({
    rawBody: JSON.stringify({ id: 'evt_invalid' }),
    signatureHeader: 't=1,v1=invalid'
  }));
  assert.throws(() => provider.parseVerifiedWebhookEvent({
    rawBody: '{}',
    signatureHeader: null
  }));
`;

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--input-type=module', '--eval', behaviorProgram],
  { cwd: root, encoding: 'utf8' }
);

if (result.status !== 0) {
  console.error('Event ticket Stripe provider behavior test failed:');
  console.error(result.stderr || result.stdout);
  process.exit(1);
}

console.log('Event ticket Stripe provider behavior test passed.');
