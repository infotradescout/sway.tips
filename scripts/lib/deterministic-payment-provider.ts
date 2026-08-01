import type {
  PaymentProviderAdapter,
  ProviderActionResult,
  ProviderAuthorizeInput,
  ProviderAuthorizeResult,
  ProviderRefundInput,
  ProviderWebhookEnvelope
} from '../../src/server/payment-provider';

type IntentRecord = ProviderAuthorizeResult & {
  idempotencyKey: string;
  amountTotalCents: number;
};

type FaultName = 'authorize_after_commit' | 'capture_after_commit' | 'refund_pending_once' | 'void_after_commit';

export function createDeterministicPaymentProvider() {
  const intentsById = new Map<string, IntentRecord>();
  const intentIdByKey = new Map<string, string>();
  const faults = new Set<FaultName>();
  const calls = {
    authorize: 0,
    capture: 0,
    refund: 0,
    retrieve: 0,
    void: 0,
    uniqueAuthorizations: 0,
    lastRefundInput: null as ProviderRefundInput | null
  };
  let sequence = 0;
  let authorizeInterceptor: ((intent: IntentRecord) => Promise<void>) | null = null;
  let retrieveInterceptor: ((intent: IntentRecord) => Promise<ProviderAuthorizeResult>) | null = null;

  function snapshot(intent: IntentRecord): ProviderAuthorizeResult {
    return {
      processorPaymentIntentId: intent.processorPaymentIntentId,
      processorChargeId: intent.processorChargeId,
      status: intent.status,
      clientSecret: intent.clientSecret,
      amountCents: intent.amountCents,
      amountReceivedCents: intent.amountReceivedCents,
      amountCapturableCents: intent.amountCapturableCents,
      amountRefundedCents: intent.amountRefundedCents,
      fullyRefunded: intent.fullyRefunded,
      metadata: { ...(intent.metadata ?? {}) }
    };
  }

  function requireIntent(id: string) {
    const intent = intentsById.get(id);
    if (!intent) throw new Error(`deterministic_intent_not_found:${id}`);
    return intent;
  }

  function actionResult(intent: IntentRecord, extras: Partial<ProviderActionResult> = {}): ProviderActionResult {
    return {
      processorPaymentIntentId: intent.processorPaymentIntentId,
      processorChargeId: intent.processorChargeId,
      status: intent.status,
      ...extras
    };
  }

  const provider: PaymentProviderAdapter = {
    processor: 'stripe',

    async verifyWebhookSignature({ signatureHeader }) {
      return signatureHeader === 'deterministic-test-signature';
    },

    async parseWebhookEvent({ rawBody }) {
      return JSON.parse(rawBody) as ProviderWebhookEnvelope;
    },

    async authorizePayment(input: ProviderAuthorizeInput) {
      calls.authorize += 1;
      const existingId = intentIdByKey.get(input.idempotencyKey);
      let intent = existingId ? requireIntent(existingId) : null;
      if (!intent) {
        sequence += 1;
        const id = `pi_deterministic_${sequence}`;
        intent = {
          idempotencyKey: input.idempotencyKey,
          amountTotalCents: input.amountTotalCents,
          processorPaymentIntentId: id,
          processorChargeId: null,
          status: input.confirm ? 'requires_capture' : 'requires_payment_method',
          clientSecret: `${id}_secret_test`,
          amountCents: input.amountTotalCents,
          amountReceivedCents: 0,
          amountCapturableCents: input.confirm ? input.amountTotalCents : 0,
          amountRefundedCents: 0,
          fullyRefunded: false,
          metadata: { ...(input.metadata ?? {}) }
        };
        intentsById.set(id, intent);
        intentIdByKey.set(input.idempotencyKey, id);
        calls.uniqueAuthorizations += 1;
      }
      if (authorizeInterceptor) await authorizeInterceptor(intent);
      if (faults.delete('authorize_after_commit')) throw new Error('deterministic_authorize_response_lost');
      return snapshot(intent);
    },

    async retrievePaymentAuthorization(processorPaymentIntentId) {
      calls.retrieve += 1;
      const intent = requireIntent(processorPaymentIntentId);
      if (retrieveInterceptor) return retrieveInterceptor(intent);
      return snapshot(intent);
    },

    async capturePayment({ processorPaymentIntentId }) {
      calls.capture += 1;
      const intent = requireIntent(processorPaymentIntentId);
      intent.status = 'succeeded';
      intent.processorChargeId ??= `ch_${processorPaymentIntentId}`;
      intent.amountReceivedCents = intent.amountTotalCents;
      intent.amountCapturableCents = 0;
      if (faults.delete('capture_after_commit')) throw new Error('deterministic_capture_response_lost');
      return actionResult(intent);
    },

    async refundPayment(input) {
      calls.refund += 1;
      calls.lastRefundInput = input;
      const intent = requireIntent(input.processorPaymentIntentId);
      if (faults.delete('refund_pending_once')) {
        return actionResult(intent, { processorRefundId: `re_pending_${intent.processorPaymentIntentId}`, status: 'pending' });
      }
      intent.status = 'succeeded';
      intent.processorChargeId ??= `ch_${intent.processorPaymentIntentId}`;
      intent.amountReceivedCents = intent.amountTotalCents;
      intent.amountCapturableCents = 0;
      intent.amountRefundedCents = intent.amountTotalCents;
      intent.fullyRefunded = true;
      return actionResult(intent, { processorRefundId: `re_${intent.processorPaymentIntentId}`, status: 'succeeded' });
    },

    async voidPayment({ processorPaymentIntentId }) {
      calls.void += 1;
      const intent = requireIntent(processorPaymentIntentId);
      if (intent.status === 'succeeded') throw new Error('deterministic_intent_already_captured');
      intent.status = 'canceled';
      intent.amountCapturableCents = 0;
      if (faults.delete('void_after_commit')) throw new Error('deterministic_void_response_lost');
      return actionResult(intent);
    }
  };

  return {
    provider,
    calls,
    intentsById,
    failOnce(name: FaultName) {
      faults.add(name);
    },
    setAuthorizeInterceptor(interceptor: typeof authorizeInterceptor) {
      authorizeInterceptor = interceptor;
    },
    clearAuthorizeInterceptor() {
      authorizeInterceptor = null;
    },
    setRetrieveInterceptor(interceptor: typeof retrieveInterceptor) {
      retrieveInterceptor = interceptor;
    },
    clearRetrieveInterceptor() {
      retrieveInterceptor = null;
    },
    markFullyRefunded(processorPaymentIntentId: string) {
      const intent = requireIntent(processorPaymentIntentId);
      intent.status = 'succeeded';
      intent.processorChargeId ??= `ch_${intent.processorPaymentIntentId}`;
      intent.amountReceivedCents = intent.amountTotalCents;
      intent.amountRefundedCents = intent.amountTotalCents;
      intent.fullyRefunded = true;
    },
    snapshot(processorPaymentIntentId: string) {
      return snapshot(requireIntent(processorPaymentIntentId));
    }
  };
}
