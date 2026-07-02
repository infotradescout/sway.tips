import Stripe from 'stripe';

export type ConnectAccountStatus = {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
};

export type StripeConnectService = {
  createExpressAccount: () => Promise<{ accountId: string }>;
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
  }) => { accountId: string; status: ConnectAccountStatus } | null;
};

/**
 * Reads STRIPE_SECRET_KEY and returns a configured Connect adapter, or null
 * when execution is not provisioned. A null service fails safe: no Connect
 * account, onboarding link, or status sync is ever created without real keys.
 */
export function createConfiguredStripeConnectService(env: NodeJS.ProcessEnv = process.env): StripeConnectService | null {
  const secretKey = env.STRIPE_SECRET_KEY;
  if (!secretKey) return null;

  const stripe = new Stripe(secretKey);

  return {
    async createExpressAccount() {
      const account = await stripe.accounts.create({ type: 'express' });
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
      const account = await stripe.accounts.retrieve(accountId);
      return {
        chargesEnabled: Boolean(account.charges_enabled),
        payoutsEnabled: Boolean(account.payouts_enabled),
        detailsSubmitted: Boolean(account.details_submitted)
      };
    },

    parseAccountUpdatedEvent({ rawBody, signatureHeader, webhookSecret }) {
      if (!signatureHeader) return null;
      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(rawBody, signatureHeader, webhookSecret);
      } catch {
        return null;
      }
      if (event.type !== 'account.updated') return null;
      const account = event.data.object as Stripe.Account;
      return {
        accountId: account.id,
        status: {
          chargesEnabled: Boolean(account.charges_enabled),
          payoutsEnabled: Boolean(account.payouts_enabled),
          detailsSubmitted: Boolean(account.details_submitted)
        }
      };
    }
  };
}
