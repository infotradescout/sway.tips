import { and, eq } from 'drizzle-orm';
import type { SwayDb } from '../db/client';
import { performers } from '../db/schema';
import { writeAuditEvent } from './audit-log';
import type { ConnectAccountStatus } from './stripe-connect';

export type StripeConnectPerformerStatusUpdate = {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  paymentAccountStatus: 'not_started' | 'created' | 'charges_enabled' | 'payouts_enabled';
};

export function buildStripeConnectPerformerStatusUpdate(
  status: ConnectAccountStatus
): StripeConnectPerformerStatusUpdate {
  const paymentAccountStatus = status.payoutsEnabled
    ? 'payouts_enabled'
    : status.chargesEnabled
      ? 'charges_enabled'
      : status.detailsSubmitted
        ? 'created'
        : 'not_started';

  return {
    chargesEnabled: status.chargesEnabled,
    payoutsEnabled: status.payoutsEnabled,
    paymentAccountStatus
  };
}

export type StripeConnectStatusReconciliationResult =
  | { kind: 'updated'; performerId: string }
  | { kind: 'unchanged'; performerId: string }
  | { kind: 'not_found' };

export async function reconcileStripeConnectPerformerStatus(input: {
  db: SwayDb;
  accountId: string;
  status: ConnectAccountStatus;
  source: 'return' | 'webhook_v1' | 'webhook_v2';
  providerEventId?: string | null;
  actorId: string | null;
  expectedPerformerId?: string;
  expectedOwnerUserId?: string;
  now?: Date;
}): Promise<StripeConnectStatusReconciliationResult> {
  return input.db.transaction(async (tx) => {
    const filters = [eq(performers.stripeConnectedAccountId, input.accountId)];
    if (input.expectedPerformerId) filters.push(eq(performers.id, input.expectedPerformerId));
    if (input.expectedOwnerUserId) filters.push(eq(performers.ownerUserId, input.expectedOwnerUserId));

    const matches = await tx
      .select({
        performerId: performers.id,
        ownerUserId: performers.ownerUserId,
        paymentAccountStatus: performers.paymentAccountStatus,
        chargesEnabled: performers.chargesEnabled,
        payoutsEnabled: performers.payoutsEnabled
      })
      .from(performers)
      .where(and(...filters))
      .for('update')
      .limit(2);

    if (matches.length === 0) return { kind: 'not_found' } as const;
    if (matches.length !== 1) throw new Error('stripe_connect_account_binding_conflict');

    const current = matches[0];
    const next = buildStripeConnectPerformerStatusUpdate(input.status);
    const changed = current.paymentAccountStatus !== next.paymentAccountStatus
      || current.chargesEnabled !== next.chargesEnabled
      || current.payoutsEnabled !== next.payoutsEnabled;
    const checkedAt = input.now ?? new Date();

    const [updated] = await tx
      .update(performers)
      .set({ ...next, stripeConnectStatusCheckedAt: checkedAt, updatedAt: checkedAt })
      .where(and(
        eq(performers.id, current.performerId),
        eq(performers.ownerUserId, current.ownerUserId),
        eq(performers.stripeConnectedAccountId, input.accountId)
      ))
      .returning({ id: performers.id });
    if (!updated) return { kind: 'not_found' } as const;

    if (changed) {
      await writeAuditEvent(tx, {
        actorType: input.actorId ? 'performer_owner' : 'stripe_webhook',
        actorId: input.actorId,
        entityType: 'performer',
        entityId: current.performerId,
        eventType: 'stripe_connect.readiness_changed',
        previousStatus: current.paymentAccountStatus,
        nextStatus: next.paymentAccountStatus,
        metadata: {
          source: input.source,
          providerEventId: input.providerEventId ?? null,
          accountId: input.accountId,
          previousChargesEnabled: current.chargesEnabled,
          previousPayoutsEnabled: current.payoutsEnabled,
          chargesEnabled: next.chargesEnabled,
          payoutsEnabled: next.payoutsEnabled,
          checkedAt: checkedAt.toISOString()
        }
      });
    }

    return { kind: changed ? 'updated' : 'unchanged', performerId: current.performerId } as const;
  });
}
