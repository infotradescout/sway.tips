import { spawnSync } from 'node:child_process';

const root = process.cwd();

const behaviorProgram = String.raw`
  import assert from 'node:assert/strict';
  import { createHash } from 'node:crypto';
  import {
    NATIVE_TICKET_BUYER_TERMS_HASH,
    NATIVE_TICKET_BUYER_TERMS_TEXT,
    NATIVE_TICKET_SELLER_TERMS_HASH,
    NATIVE_TICKET_SELLER_TERMS_TEXT,
    NATIVE_TICKET_TERMS_VERSION,
    buildNativeTicketBuyerTermsSnapshot,
    buildNativeTicketSellerTermsSnapshot,
    calculateNativeTicketPrice,
    resolveNativeTicketRuntimeConfig
  } from './src/server/event-ticket-contract.ts';

  const baseEnabledEnv = {
    NODE_ENV: 'production',
    SWAY_NATIVE_TICKETS_ENABLED: 'true',
    SWAY_TICKET_FEE_BPS: '250',
    SWAY_TICKET_FEE_FIXED_CENTS: '35',
    SWAY_TICKET_TAX_MODE: 'not_required',
    SWAY_TICKET_QR_SECRET: 'q'.repeat(32),
    SWAY_TICKET_SUPPORT_EMAIL: 'Tickets@Sway.Test',
    SWAY_TICKET_PRODUCTION_APPROVAL_VERSION: NATIVE_TICKET_TERMS_VERSION,
    SWAY_APP_BASE_URL: 'https://app.sway.test'
  };

  const emptyConfig = resolveNativeTicketRuntimeConfig({}, true);
  assert.equal(emptyConfig.salesEnabled, false);
  assert.equal(emptyConfig.expectedStripeLivemode, true);
  assert.deepEqual(
    new Set(emptyConfig.disabledReasons),
    new Set([
      'native_ticket_sales_not_enabled',
      'ticket_fee_policy_missing',
      'ticket_tax_mode_missing',
      'ticket_qr_secret_missing',
      'ticket_support_email_missing'
    ])
  );
  assert.equal(emptyConfig.appBaseUrl, 'https://app.sway.tips');

  const requestedButIncomplete = resolveNativeTicketRuntimeConfig({
    SWAY_NATIVE_TICKETS_ENABLED: 'true'
  }, true);
  assert.equal(requestedButIncomplete.salesEnabled, false);
  assert(requestedButIncomplete.disabledReasons.includes('ticket_fee_policy_missing'));

  const enabledConfig = resolveNativeTicketRuntimeConfig(baseEnabledEnv, true);
  assert.equal(enabledConfig.salesEnabled, true);
  assert.equal(enabledConfig.expectedStripeLivemode, true);
  assert.deepEqual(enabledConfig.disabledReasons, []);
  assert.equal(enabledConfig.reservationMinutes, 31);
  assert.equal(enabledConfig.refundGraceMinutes, 24 * 60);
  assert.equal(enabledConfig.appBaseUrl, 'https://app.sway.test');
  assert.equal(enabledConfig.supportEmail, 'tickets@sway.test');

  const invalidSupportEmail = resolveNativeTicketRuntimeConfig({
    ...baseEnabledEnv,
    SWAY_TICKET_SUPPORT_EMAIL: 'not a safe email'
  }, true);
  assert.equal(invalidSupportEmail.salesEnabled, false);
  assert(invalidSupportEmail.disabledReasons.includes('ticket_support_email_invalid'));

  const missingAutomaticTaxCode = resolveNativeTicketRuntimeConfig({
    ...baseEnabledEnv,
    SWAY_TICKET_TAX_MODE: 'stripe_automatic'
  }, true);
  assert.equal(missingAutomaticTaxCode.salesEnabled, false);
  assert(missingAutomaticTaxCode.disabledReasons.includes('ticket_tax_code_missing'));

  const automaticTaxConfig = resolveNativeTicketRuntimeConfig({
    ...baseEnabledEnv,
    SWAY_TICKET_TAX_MODE: 'stripe_automatic',
    SWAY_TICKET_STRIPE_TAX_CODE: 'txcd_10000000'
  }, true);
  assert.equal(automaticTaxConfig.salesEnabled, true);
  assert.equal(automaticTaxConfig.stripeTaxCode, 'txcd_10000000');

  const insecureProductionUrl = resolveNativeTicketRuntimeConfig({
    ...baseEnabledEnv,
    SWAY_APP_BASE_URL: 'http://app.sway.test'
  }, true);
  assert.equal(insecureProductionUrl.salesEnabled, false);
  assert(insecureProductionUrl.disabledReasons.includes('ticket_app_base_url_missing'));

  assert.deepEqual(
    calculateNativeTicketPrice({
      faceValueCents: 100,
      feeBps: 0,
      feeFixedCents: 0
    }),
    {
      faceValueCents: 100,
      mandatoryFeeCents: 0,
      totalPriceCents: 100
    }
  );
  assert.deepEqual(
    calculateNativeTicketPrice({
      faceValueCents: 1_000,
      feeBps: 1_250,
      feeFixedCents: 30
    }),
    {
      faceValueCents: 1_000,
      mandatoryFeeCents: 155,
      totalPriceCents: 1_155
    }
  );
  assert.deepEqual(
    calculateNativeTicketPrice({
      faceValueCents: 101,
      feeBps: 333,
      feeFixedCents: 7
    }),
    {
      faceValueCents: 101,
      mandatoryFeeCents: 11,
      totalPriceCents: 112
    }
  );
  assert.equal(
    calculateNativeTicketPrice({
      faceValueCents: 1_000_000,
      feeBps: 0,
      feeFixedCents: 0
    }).totalPriceCents,
    1_000_000
  );

  for (const invalidInput of [
    { faceValueCents: 99, feeBps: 0, feeFixedCents: 0 },
    { faceValueCents: 100.5, feeBps: 0, feeFixedCents: 0 },
    { faceValueCents: 100, feeBps: -1, feeFixedCents: 0 },
    { faceValueCents: 100, feeBps: 5_001, feeFixedCents: 0 },
    { faceValueCents: 100, feeBps: 1.5, feeFixedCents: 0 },
    { faceValueCents: 100, feeBps: 0, feeFixedCents: -1 },
    { faceValueCents: 100, feeBps: 0, feeFixedCents: 10_001 },
    { faceValueCents: 100, feeBps: 0, feeFixedCents: 1.5 },
    { faceValueCents: 999_999, feeBps: 0, feeFixedCents: 2 }
  ]) {
    assert.throws(() => calculateNativeTicketPrice(invalidInput));
  }

  assert.equal(
    NATIVE_TICKET_SELLER_TERMS_HASH,
    createHash('sha256').update(NATIVE_TICKET_SELLER_TERMS_TEXT).digest('hex')
  );
  assert.equal(
    NATIVE_TICKET_BUYER_TERMS_HASH,
    createHash('sha256').update(NATIVE_TICKET_BUYER_TERMS_TEXT).digest('hex')
  );
  assert.match(NATIVE_TICKET_SELLER_TERMS_HASH, /^[a-f0-9]{64}$/);
  assert.match(NATIVE_TICKET_BUYER_TERMS_HASH, /^[a-f0-9]{64}$/);

  const mutableSellerInput = {
    ...automaticTaxConfig,
    feeBps: 250,
    feeFixedCents: 35,
    taxMode: 'stripe_automatic',
    stripeTaxCode: 'txcd_10000000',
    reservationMinutes: 45,
    refundGraceMinutes: 1_440
  };
  const sellerSnapshot = buildNativeTicketSellerTermsSnapshot(mutableSellerInput);
  mutableSellerInput.feeBps = 0;
  mutableSellerInput.feeFixedCents = 0;
  mutableSellerInput.stripeTaxCode = 'txcd_changed';
  mutableSellerInput.refundGraceMinutes = 60;
  assert.deepEqual(sellerSnapshot, {
    version: NATIVE_TICKET_TERMS_VERSION,
    termsHash: NATIVE_TICKET_SELLER_TERMS_HASH,
    settlementPolicy: 'refund_only',
    feeBps: 250,
    feeFixedCents: 35,
    taxMode: 'stripe_automatic',
    stripeTaxCode: 'txcd_10000000',
    reservationMinutes: 45,
    refundGraceMinutes: 1_440,
    performerTransferTrigger: 'admission_accept',
    perVerifiedAccountTicketLimit: 1,
    fundsDescription: 'captured_on_platform_not_yet_transferred'
  });

  assert.throws(() => buildNativeTicketSellerTermsSnapshot({
    ...enabledConfig,
    feeBps: null
  }));

  const mutableBuyerInput = {
    eventId: '30000000-0000-4000-8000-000000000001',
    offerId: '40000000-0000-4000-8000-000000000001',
    performerId: '20000000-0000-4000-8000-000000000001',
    performerDisplayName: 'Native Ticket Seller',
    eventTitle: 'Door-time show',
    startsAt: '2035-07-26T19:00:00.000Z',
    endsAt: '2035-07-26T21:00:00.000Z',
    timeZone: 'America/Chicago',
    locationName: 'Test Door',
    locationAddress: '100 Test Way',
    city: 'Chicago',
    locationIsTba: false,
    salesCloseAt: '2035-07-26T19:00:00.000Z',
    admissionOpensAt: '2035-07-26T18:00:00.000Z',
    admissionClosesAt: '2035-07-27T21:00:00.000Z',
    faceValueCents: 1_000,
    mandatoryFeeCents: 155,
    totalPriceCents: 1_155,
    quantity: 1,
    currency: 'USD',
    taxMode: 'stripe_automatic',
    refundGraceMinutes: 1_440
  };
  const buyerSnapshot = buildNativeTicketBuyerTermsSnapshot(mutableBuyerInput);
  mutableBuyerInput.faceValueCents = 1;
  mutableBuyerInput.mandatoryFeeCents = 0;
  mutableBuyerInput.totalPriceCents = 1;
  mutableBuyerInput.refundGraceMinutes = 60;
  assert.deepEqual(buyerSnapshot, {
    version: NATIVE_TICKET_TERMS_VERSION,
    termsHash: NATIVE_TICKET_BUYER_TERMS_HASH,
    settlementPolicy: 'refund_only',
    performerTransferTrigger: 'admission_accept',
    perVerifiedAccountTicketLimit: 1,
    fundsDescription: 'captured_on_platform_not_yet_transferred',
    eventId: '30000000-0000-4000-8000-000000000001',
    offerId: '40000000-0000-4000-8000-000000000001',
    performerId: '20000000-0000-4000-8000-000000000001',
    performerDisplayName: 'Native Ticket Seller',
    eventTitle: 'Door-time show',
    startsAt: '2035-07-26T19:00:00.000Z',
    endsAt: '2035-07-26T21:00:00.000Z',
    timeZone: 'America/Chicago',
    locationName: 'Test Door',
    locationAddress: '100 Test Way',
    city: 'Chicago',
    locationIsTba: false,
    salesCloseAt: '2035-07-26T19:00:00.000Z',
    admissionOpensAt: '2035-07-26T18:00:00.000Z',
    admissionClosesAt: '2035-07-27T21:00:00.000Z',
    faceValueCents: 1_000,
    mandatoryFeeCents: 155,
    totalPriceCents: 1_155,
    quantity: 1,
    currency: 'USD',
    taxMode: 'stripe_automatic',
    refundGraceMinutes: 1_440
  });
`;

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--input-type=module', '--eval', behaviorProgram],
  { cwd: root, encoding: 'utf8' }
);

if (result.status !== 0) {
  console.error('Event ticket contract behavior test failed:');
  console.error(result.stderr || result.stdout);
  process.exit(1);
}

console.log('Event ticket contract behavior test passed.');
