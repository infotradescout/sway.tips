import { createHash } from 'node:crypto';
import type { PayoutDestinationKind, PayoutRecipientType } from '../payout-destination';

export type PayPalPayoutsMode = 'test' | 'live';

export type PayPalPayoutItem = {
  payoutBatchId: string;
  senderItemId: string;
  payoutItemId: string | null;
  transactionId: string | null;
  transactionStatus: string;
  actualProviderFeeCents: number | null;
  errorName: string | null;
};

export type PayPalPayoutWebhook = {
  providerEventId: string;
  eventType: string;
  resource: Record<string, unknown>;
};

export class PayPalPayoutsError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly providerName: string | null;
  readonly duplicatePayoutBatchId: string | null;

  constructor(input: {
    message: string;
    status: number;
    retryable: boolean;
    providerName?: string | null;
    duplicatePayoutBatchId?: string | null;
  }) {
    super(input.message);
    this.name = 'PayPalPayoutsError';
    this.status = input.status;
    this.retryable = input.retryable;
    this.providerName = input.providerName ?? null;
    this.duplicatePayoutBatchId = input.duplicatePayoutBatchId ?? null;
  }
}

export type PayPalPayoutsAdapter = ReturnType<typeof createPayPalPayoutsAdapter>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function usdToCents(value: unknown) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const [dollars, cents = ''] = value.split('.');
  const parsed = Number(dollars) * 100 + Number(cents.padEnd(2, '0'));
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function centsToUsd(cents: number) {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

export function payPalSenderItemId(withdrawalId: string) {
  return `sway-${createHash('sha256').update(withdrawalId).digest('hex').slice(0, 25)}`;
}

function payPalRequestId(withdrawalId: string) {
  return `sway-${createHash('sha256').update(`request:${withdrawalId}`).digest('hex').slice(0, 27)}`;
}

function recipientTypeForPayPal(type: PayoutRecipientType) {
  if (type === 'email') return 'EMAIL';
  if (type === 'phone') return 'PHONE';
  return 'USER_HANDLE';
}

function duplicatePayoutBatchId(body: unknown, baseUrl: string) {
  const links = asRecord(body).links;
  if (!Array.isArray(links)) return null;
  for (const value of links) {
    const link = asRecord(value);
    const href = asString(link.href);
    if (!href || asString(link.method)?.toUpperCase() !== 'GET') continue;
    try {
      const url = new URL(href);
      const base = new URL(baseUrl);
      if (url.origin !== base.origin) continue;
      const match = url.pathname.match(/^\/v1\/payments\/payouts\/([A-Za-z0-9_-]{1,64})$/);
      if (match) return match[1];
    } catch {
      // Ignore malformed provider links. They must never become fetch targets.
    }
  }
  return null;
}

function parseProviderError(body: unknown, status: number, baseUrl: string) {
  const record = asRecord(body);
  const providerName = asString(record.name);
  const message = asString(record.message) ?? `paypal_payouts_http_${status}`;
  const providerErrorText = JSON.stringify(body).toUpperCase();
  const duplicateSubmission = providerErrorText.includes('DUPLICATE_BATCH_ID')
    || providerErrorText.includes('BATCH_ALREADY_EXISTS')
    || providerErrorText.includes('SENDER_BATCH_ID ALREADY EXISTS');
  return new PayPalPayoutsError({
    message,
    status,
    providerName,
    duplicatePayoutBatchId: duplicateSubmission ? duplicatePayoutBatchId(body, baseUrl) : null,
    // A duplicate-batch response after a timeout means provider outcome is
    // uncertain, not rejected. Keep the performer balance reserved and retry
    // the same stable request identity until provider truth is reconciled.
    retryable: duplicateSubmission || status === 408 || status === 409 || status === 429 || status >= 500
  });
}

function normalizePayPalPayoutItem(value: unknown, fallbackBatchId: string): PayPalPayoutItem | null {
  const item = asRecord(value);
  const payoutItem = asRecord(item.payout_item);
  const senderItemId = asString(payoutItem.sender_item_id);
  const transactionStatus = asString(item.transaction_status);
  if (!senderItemId || !transactionStatus) return null;
  const fee = asRecord(item.payout_item_fee);
  const errors = asRecord(item.errors);
  return {
    payoutBatchId: asString(item.payout_batch_id) ?? fallbackBatchId,
    senderItemId,
    payoutItemId: asString(item.payout_item_id),
    transactionId: asString(item.transaction_id),
    transactionStatus,
    actualProviderFeeCents: asString(fee.currency) === 'USD' ? usdToCents(fee.value) : null,
    errorName: asString(errors.name)
  };
}

export function createPayPalPayoutsAdapter(input: {
  clientId: string;
  clientSecret: string;
  webhookId: string;
  mode: PayPalPayoutsMode;
  feeCents: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}) {
  const baseUrl = input.mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  let tokenCache: { value: string; expiresAt: number } | null = null;

  async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 12_000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      throw new PayPalPayoutsError({
        message: error instanceof Error ? error.message : 'paypal_payouts_network_error',
        status: 0,
        retryable: true,
        providerName: 'NETWORK_ERROR'
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async function accessToken() {
    if (tokenCache && tokenCache.expiresAt - 60_000 > now()) return tokenCache.value;
    const response = await fetchWithTimeout(`${baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: 'grant_type=client_credentials'
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw parseProviderError(body, response.status, baseUrl);
    const record = asRecord(body);
    const value = asString(record.access_token);
    const expiresIn = Number(record.expires_in);
    if (!value || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new PayPalPayoutsError({
        message: 'paypal_oauth_response_invalid',
        status: 502,
        retryable: true,
        providerName: 'OAUTH_RESPONSE_INVALID'
      });
    }
    tokenCache = { value, expiresAt: now() + expiresIn * 1_000 };
    return value;
  }

  async function authorizedJson(url: string, init: RequestInit = {}) {
    const token = await accessToken();
    const response = await fetchWithTimeout(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(init.headers ?? {})
      }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw parseProviderError(body, response.status, baseUrl);
    return body;
  }

  return {
    mode: input.mode,
    feeCents: input.feeCents,

    async createPayout(payout: {
      withdrawalId: string;
      destinationKind: PayoutDestinationKind;
      recipientType: PayoutRecipientType;
      recipientValue: string;
      netAmountCents: number;
    }) {
      if (input.mode === 'test' && payout.destinationKind === 'venmo' && payout.recipientType === 'phone') {
        throw new PayPalPayoutsError({
          message: 'paypal_sandbox_venmo_phone_unsupported',
          status: 422,
          retryable: false,
          providerName: 'SANDBOX_PHONE_UNSUPPORTED'
        });
      }
      const senderItemId = payPalSenderItemId(payout.withdrawalId);
      const requestId = payPalRequestId(payout.withdrawalId);
      const item: Record<string, unknown> = {
        recipient_type: recipientTypeForPayPal(payout.recipientType),
        amount: { value: centsToUsd(payout.netAmountCents), currency: 'USD' },
        receiver: payout.recipientValue,
        note: 'Your Sway performer earnings cash-out',
        sender_item_id: senderItemId
      };
      if (payout.destinationKind === 'venmo') item.recipient_wallet = 'Venmo';
      let body: unknown;
      try {
        body = await authorizedJson(`${baseUrl}/v1/payments/payouts`, {
          method: 'POST',
          headers: { 'PayPal-Request-Id': requestId },
          body: JSON.stringify({
            sender_batch_header: {
              sender_batch_id: requestId,
              email_subject: 'Your Sway earnings are on the way'
            },
            items: [item]
          })
        });
      } catch (error) {
        if (error instanceof PayPalPayoutsError && error.duplicatePayoutBatchId) {
          // PayPal rejects a duplicate sender_batch_id but includes a link to
          // the original payout. Recover that provider identity instead of
          // creating another payout or leaving the balance permanently stuck.
          return {
            payoutBatchId: error.duplicatePayoutBatchId,
            senderItemId,
            batchStatus: 'PENDING'
          };
        }
        throw error;
      }
      const header = asRecord(asRecord(body).batch_header);
      const payoutBatchId = asString(header.payout_batch_id);
      if (!payoutBatchId) {
        throw new PayPalPayoutsError({
          message: 'paypal_payout_batch_id_missing',
          status: 502,
          retryable: true,
          providerName: 'PAYOUT_RESPONSE_INVALID'
        });
      }
      return {
        payoutBatchId,
        senderItemId,
        batchStatus: asString(header.batch_status) ?? 'PENDING'
      };
    },

    async getBatch(payoutBatchId: string, senderItemId?: string) {
      const body = await authorizedJson(`${baseUrl}/v1/payments/payouts/${encodeURIComponent(payoutBatchId)}?fields=all`);
      const record = asRecord(body);
      const header = asRecord(record.batch_header);
      const normalizedBatchId = asString(header.payout_batch_id) ?? payoutBatchId;
      const items = Array.isArray(record.items)
        ? record.items.map((value) => normalizePayPalPayoutItem(value, normalizedBatchId)).filter(Boolean) as PayPalPayoutItem[]
        : [];
      return {
        payoutBatchId: normalizedBatchId,
        batchStatus: asString(header.batch_status) ?? 'PENDING',
        item: senderItemId ? items.find((item) => item.senderItemId === senderItemId) ?? null : items[0] ?? null
      };
    },

    async verifyWebhook(inputWebhook: {
      rawBody: string;
      headers: {
        authAlgo: string;
        certUrl: string;
        transmissionId: string;
        transmissionSig: string;
        transmissionTime: string;
      };
    }): Promise<PayPalPayoutWebhook> {
      let webhookEvent: unknown;
      try {
        webhookEvent = JSON.parse(inputWebhook.rawBody);
      } catch {
        throw new PayPalPayoutsError({
          message: 'paypal_webhook_json_invalid',
          status: 400,
          retryable: false,
          providerName: 'WEBHOOK_JSON_INVALID'
        });
      }
      const verification = await authorizedJson(`${baseUrl}/v1/notifications/verify-webhook-signature`, {
        method: 'POST',
        body: JSON.stringify({
          auth_algo: inputWebhook.headers.authAlgo,
          cert_url: inputWebhook.headers.certUrl,
          transmission_id: inputWebhook.headers.transmissionId,
          transmission_sig: inputWebhook.headers.transmissionSig,
          transmission_time: inputWebhook.headers.transmissionTime,
          webhook_id: input.webhookId,
          webhook_event: webhookEvent
        })
      });
      if (asString(asRecord(verification).verification_status) !== 'SUCCESS') {
        throw new PayPalPayoutsError({
          message: 'paypal_webhook_signature_invalid',
          status: 401,
          retryable: false,
          providerName: 'WEBHOOK_SIGNATURE_INVALID'
        });
      }
      const event = asRecord(webhookEvent);
      const providerEventId = asString(event.id);
      const eventType = asString(event.event_type);
      if (!providerEventId || !eventType) {
        throw new PayPalPayoutsError({
          message: 'paypal_webhook_shape_invalid',
          status: 400,
          retryable: false,
          providerName: 'WEBHOOK_SHAPE_INVALID'
        });
      }
      return { providerEventId, eventType, resource: asRecord(event.resource) };
    }
  };
}

export function createConfiguredPayPalPayoutsAdapter(env: NodeJS.ProcessEnv = process.env) {
  const mode = env.SWAY_PAYPAL_PAYOUTS_MODE?.trim().toLowerCase();
  const clientId = env.SWAY_PAYPAL_PAYOUTS_CLIENT_ID?.trim();
  const clientSecret = env.SWAY_PAYPAL_PAYOUTS_CLIENT_SECRET?.trim();
  const webhookId = env.SWAY_PAYPAL_PAYOUTS_WEBHOOK_ID?.trim();
  if (!mode && !clientId && !clientSecret && !webhookId) return null;
  if ((mode !== 'test' && mode !== 'live') || !clientId || !clientSecret || !webhookId) {
    throw new Error('paypal_payouts_configuration_incomplete');
  }
  const feeCents = Number(env.SWAY_PAYPAL_PAYOUTS_FEE_CENTS ?? '25');
  if (!Number.isSafeInteger(feeCents) || feeCents < 0 || feeCents > 1_000) {
    throw new Error('paypal_payouts_fee_invalid');
  }
  return createPayPalPayoutsAdapter({ clientId, clientSecret, webhookId, mode, feeCents });
}
