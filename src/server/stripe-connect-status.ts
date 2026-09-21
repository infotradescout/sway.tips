import { and, eq } from 'drizzle-orm';
import type { SwayDb } from '../db/client';
import { performerStripeConnectBindings, performers } from '../db/schema';
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
  paymentMode: 'test' | 'live';
  status: ConnectAccountStatus;
  source: 'return' | 'webhook_v1' | 'webhook_v2';
  providerEventId?: string | null;
  actorId: string | null;
  expectedPerformerId?: string;
  expectedOwnerUserId?: string;
  now?: Date;
}): Promise<StripeConnectStatusReconciliationResult> {
  return input.db.transaction(async (tx) => {
    const paymentMode = input.paymentMode;

    // A pre-migration process can still finish a test binding during a
    // rolling deploy. Import that legacy row before reconciliation; legacy
    // state is never considered evidence for a live binding.
    if (paymentMode === 'test') {
      const legacyFilters = [eq(performers.stripeConnectedAccountId, input.accountId)];
      if (input.expectedPerformerId) legacyFilters.push(eq(performers.id, input.expectedPerformerId));
      if (input.expectedOwnerUserId) legacyFilters.push(eq(performers.ownerUserId, input.expectedOwnerUserId));
      const legacyMatches = await tx
        .select({
          performerId: performers.id,
          accountId: performers.stripeConnectedAccountId,
          paymentAccountStatus: performers.paymentAccountStatus,
          chargesEnabled: performers.chargesEnabled,
          payoutsEnabled: performers.payoutsEnabled,
          statusCheckedAt: performers.stripeConnectStatusCheckedAt,
          createdAt: performers.createdAt,
          updatedAt: performers.updatedAt
        })
        .from(performers)
        .where(and(...legacyFilters))
        .for('update')
        .limit(2);
      if (legacyMatches.length > 1) throw new Error('stripe_connect_account_binding_conflict');
      const legacy = legacyMatches[0];
      if (legacy?.accountId) {
        await tx.insert(performerStripeConnectBindings).values({
          performerId: legacy.performerId,
          paymentMode,
          stripeAccountId: legacy.accountId,
          paymentAccountStatus: legacy.paymentAccountStatus,
          chargesEnabled: legacy.chargesEnabled,
          payoutsEnabled: legacy.payoutsEnabled,
          statusCheckedAt: legacy.statusCheckedAt,
          createdAt: legacy.createdAt,
          updatedAt: legacy.updatedAt
        }).onConflictDoNothing({
          target: [performerStripeConnectBindings.performerId, performerStripeConnectBindings.paymentMode]
        });
      }
    }

    const filters = [
      eq(performerStripeConnectBindings.stripeAccountId, input.accountId),
      eq(performerStripeConnectBindings.paymentMode, paymentMode)
    ];
    if (input.expectedPerformerId) filters.push(eq(performers.id, input.expectedPerformerId));
    if (input.expectedOwnerUserId) filters.push(eq(performers.ownerUserId, input.expectedOwnerUserId));

    const candidates = await tx
      .select({
        performerId: performers.id,
        ownerUserId: performers.ownerUserId
      })
      .from(performerStripeConnectBindings)
      .innerJoin(performers, eq(performers.id, performerStripeConnectBindings.performerId))
      .where(and(...filters))
      .limit(2);

    if (candidates.length === 0) return { kind: 'not_found' } as const;
    if (candidates.length !== 1) throw new Error('stripe_connect_account_binding_conflict');

    // All Connect mutations lock performer -> binding. This keeps status
    // reconciliation serialized with onboarding and ownership fencing while
    // avoiding lock-order inversions under webhook concurrency.
    const candidate = candidates[0];
    const ownerFilters = [eq(performers.id, candidate.performerId)];
    if (input.expectedOwnerUserId) ownerFilters.push(eq(performers.ownerUserId, input.expectedOwnerUserId));
    const [lockedOwner] = await tx
      .select({ ownerUserId: performers.ownerUserId })
      .from(performers)
      .where(and(...ownerFilters))
      .for('update')
      .limit(1);
    if (!lockedOwner) return { kind: 'not_found' } as const;

    const [binding] = await tx
      .select({
        paymentAccountStatus: performerStripeConnectBindings.paymentAccountStatus,
        chargesEnabled: performerStripeConnectBindings.chargesEnabled,
        payoutsEnabled: performerStripeConnectBindings.payoutsEnabled
      })
      .from(performerStripeConnectBindings)
      .where(and(
        eq(performerStripeConnectBindings.performerId, candidate.performerId),
        eq(performerStripeConnectBindings.paymentMode, paymentMode),
        eq(performerStripeConnectBindings.stripeAccountId, input.accountId)
      ))
      .for('update')
      .limit(1);
    if (!binding) return { kind: 'not_found' } as const;

    const current = {
      performerId: candidate.performerId,
      ownerUserId: lockedOwner.ownerUserId,
      ...binding
    };
    const next = buildStripeConnectPerformerStatusUpdate(input.status);
    const changed = current.paymentAccountStatus !== next.paymentAccountStatus
      || current.chargesEnabled !== next.chargesEnabled
      || current.payoutsEnabled !== next.payoutsEnabled;
    const checkedAt = input.now ?? new Date();

    const [updated] = await tx
      .update(performerStripeConnectBindings)
      .set({ ...next, statusCheckedAt: checkedAt, updatedAt: checkedAt })
      .where(and(
        eq(performerStripeConnectBindings.performerId, current.performerId),
        eq(performerStripeConnectBindings.paymentMode, paymentMode),
        eq(performerStripeConnectBindings.stripeAccountId, input.accountId)
      ))
      .returning({ id: performerStripeConnectBindings.performerId });
    if (!updated) return { kind: 'not_found' } as const;

    // Rolling-deploy compatibility only: historical performer columns remain
    // an exact mirror of the test binding. Live status is never written there.
    if (paymentMode === 'test') {
      await tx
        .update(performers)
        .set({ ...next, stripeConnectStatusCheckedAt: checkedAt, updatedAt: checkedAt })
        .where(and(
          eq(performers.id, current.performerId),
          eq(performers.ownerUserId, current.ownerUserId),
          eq(performers.stripeConnectedAccountId, input.accountId)
        ));
    }

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
          paymentMode,
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
