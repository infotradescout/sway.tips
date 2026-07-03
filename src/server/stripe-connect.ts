import Stripe from 'stripe';
import { STRIPE_API_VERSION } from './payment-provider';

export type ConnectAccountStatus = {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
};

export type StripeConnectService = {
  createRecipientAccount: (input?: {
    displayName?: string | null;
    contactEmail?: string | null;
  }) => Promise<{ accountId: string }>;
  createOnboardingLink: (input: {
    accountId: string;
    refreshUrl: string;
    returnUrl: string;
  }) => Promise<{ url: string }>;
  getAccountStatus: (accountId: string) => Promise<ConnectAccountStatus>;
  // Verifies a webhook payload and, only if it is an account.updated event,
  // returns the affected account id + status. Returns null for any other
  // event type or an invalid signature -- callers should ignore, not error.
  parseAccountUpdatedEvent: (input: {
    rawBody: string;
    signatureHeader: string | null;
    webhookSecret: string;
  }) => Promise<{ accountId: string; status: ConnectAccountStatus } | null>;
};

/**
 * Reads STRIPE_SECRET_KEY and returns a configured Connect adapter, or null
 * when execution is not provisioned. A null service fails safe: no Connect
 * account, onboarding link, or status sync is ever created without real keys.
 */
export function createConfiguredStripeConnectService(env: NodeJS.ProcessEnv = process.env): StripeConnectService | null {
  const secretKey = env.STRIPE_SECRET_KEY;
  if (!secretKey) return null;

  const stripe = new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION });
  const connectCountry = (env.SWAY_STRIPE_CONNECT_COUNTRY || 'US').trim().toUpperCase();

  function mapV1AccountStatus(account: Stripe.Account): ConnectAccountStatus {
    return {
      chargesEnabled: Boolean(account.charges_enabled),
      payoutsEnabled: Boolean(account.payouts_enabled),
      detailsSubmitted: Boolean(account.details_submitted)
    };
  }

  function mapV2AccountStatus(account: Stripe.V2.Core.Account): ConnectAccountStatus {
    const stripeBalance = account.configuration?.recipient?.capabilities?.stripe_balance;
    const transfersEnabled = stripeBalance?.stripe_transfers?.status === 'active';
    const payoutsEnabled = stripeBalance?.payouts?.status === 'active';
    const activeRequirements = account.requirements?.entries?.some((entry) => entry.awaiting_action_from !== 'stripe') ?? true;

    return {
      // Sway uses destination charges without on_behalf_of, so this flag means
      // "safe to attach as transfer_data.destination" for the current flow.
      chargesEnabled: transfersEnabled,
      payoutsEnabled,
      detailsSubmitted: !activeRequirements && (transfersEnabled || payoutsEnabled)
    };
  }

  async function getAccountStatus(accountId: string): Promise<ConnectAccountStatus> {
    try {
      const account = await stripe.v2.core.accounts.retrieve(accountId, {
        include: ['configuration.recipient', 'requirements', 'identity', 'defaults']
      });
      if (account.applied_configurations.includes('recipient')) {
        return mapV2AccountStatus(account);
      }
    } catch {
      // Existing v1 connected accounts are read through the v1 fallback below.
    }

    const account = await stripe.accounts.retrieve(accountId);
    return mapV1AccountStatus(account);
  }

  async function parseV2AccountStatusEvent(input: {
    rawBody: string;
    signatureHeader: string | null;
    webhookSecret: string;
  }) {
    if (!input.signatureHeader) return null;
    let notification: Stripe.V2.Core.EventNotification;
    try {
      notification = stripe.parseEventNotification(input.rawBody, input.signatureHeader, input.webhookSecret);
    } catch {
      return null;
    }

    const isAccountStatusEvent = notification.type.startsWith('v2.core.account')
      || notification.type === 'v2.core.account_link.returned';
    if (!isAccountStatusEvent) return null;

    let accountId = 'related_object' in notification
      ? notification.related_object?.id ?? null
      : null;

    if (!accountId && notification.type === 'v2.core.account_link.returned') {
      const event = await notification.fetchEvent();
      accountId = typeof (event as { data?: { account_id?: unknown } }).data?.account_id === 'string'
        ? (event as { data: { account_id: string } }).data.account_id
        : null;
    }

    if (!accountId) return null;
    return { accountId, status: await getAccountStatus(accountId) };
  }

  function parseV1AccountUpdatedEvent(input: {
    rawBody: string;
    signatureHeader: string | null;
    webhookSecret: string;
  }) {
    if (!input.signatureHeader) return null;
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(input.rawBody, input.signatureHeader, input.webhookSecret);
    } catch {
      return null;
    }
    if (event.type !== 'account.updated') return null;
    const account = event.data.object as Stripe.Account;
    return {
      accountId: account.id,
      status: mapV1AccountStatus(account)
    };
  }

  return {
    async createRecipientAccount(input = {}) {
      const account = await stripe.v2.core.accounts.create({
        dashboard: 'express',
        ...(input.displayName ? { display_name: input.displayName } : {}),
        ...(input.contactEmail ? { contact_email: input.contactEmail } : {}),
        identity: {
          country: connectCountry
        },
        configuration: {
          recipient: {
            capabilities: {
              stripe_balance: {
                stripe_transfers: { requested: true }
              }
            }
          }
        },
        defaults: {
          currency: 'usd',
          responsibilities: {
            fees_collector: 'application',
            losses_collector: 'application'
          },
          profile: {
            product_description: 'Live performance tips and song request support through Sway.'
          }
        },
        include: ['configuration.recipient', 'requirements', 'identity', 'defaults']
      });
      return { accountId: account.id };
    },

    async createOnboardingLink({ accountId, refreshUrl, returnUrl }) {
      const link = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: refreshUrl,
        return_url: returnUrl,
        type: 'account_onboarding'
      });
      return { url: link.url };
    },

    async getAccountStatus(accountId) {
      return getAccountStatus(accountId);
    },

    async parseAccountUpdatedEvent(input) {
      return await parseV2AccountStatusEvent(input) ?? parseV1AccountUpdatedEvent(input);
    }
  };
}
