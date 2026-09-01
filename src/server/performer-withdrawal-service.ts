import { and, eq, inArray, sql } from 'drizzle-orm';
import type { SwayDb } from '../db/client';
import { payments, performerWithdrawals, performers } from '../db/schema';
import type { PayoutDestinationKind } from '../payout-destination';
import { writeAuditEvent } from './audit-log';

export const MINIMUM_WITHDRAWAL_CENTS = 1_000;

export type WithdrawalQuote = {
  provider: string;
  providerFeeCents: number;
};

export function quoteSimulatedWithdrawal(input: {
  grossAmountCents: number;
  deliverySpeed: 'standard' | 'instant';
}): WithdrawalQuote {
  const providerFeeCents = input.deliverySpeed === 'instant'
    ? Math.max(50, Math.ceil(input.grossAmountCents * 0.015))
    : 50;
  return { provider: 'sway_test_payout_simulator', providerFeeCents };
}

function normalizeIdempotencyKey(value: unknown) {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  return /^[a-zA-Z0-9:_-]{16,128}$/.test(key) ? key : null;
}

export function createPerformerWithdrawalService(db: SwayDb) {
  async function balancesForPerformer(performerId: string, paymentMode: 'test' | 'live') {
    const [earnings] = await db.select({
      pendingCents: sql<number>`coalesce(sum(case when ${payments.paymentStatus} in ('payment_pending', 'authorized') then ${payments.amountSubtotal} else 0 end), 0)::int`,
      capturedCents: sql<number>`coalesce(sum(case when ${payments.paymentStatus} = 'captured' and ${payments.refundStatus} = 'not_refunded' then ${payments.amountSubtotal} else 0 end), 0)::int`
    }).from(payments).where(and(
      eq(payments.performerId, performerId),
      eq(payments.paymentMode, paymentMode)
    ));

    const [withdrawn] = await db.select({
      reservedCents: sql<number>`coalesce(sum(${performerWithdrawals.grossAmountCents}), 0)::int`
    }).from(performerWithdrawals).where(and(
      eq(performerWithdrawals.performerId, performerId),
      inArray(performerWithdrawals.status, ['requested', 'processing', 'paid'])
    ));

    const capturedCents = Number(earnings?.capturedCents ?? 0);
    const reservedCents = Number(withdrawn?.reservedCents ?? 0);
    return {
      pendingCents: Number(earnings?.pendingCents ?? 0),
      capturedCents,
      reservedCents,
      availableCents: Math.max(0, capturedCents - reservedCents),
      currency: 'USD' as const
    };
  }

  return {
    async getOwnerBalance(input: { ownerUserId: string; paymentMode: 'test' | 'live' }) {
      const [owner] = await db.select({ performerId: performers.id })
        .from(performers)
        .where(eq(performers.ownerUserId, input.ownerUserId))
        .limit(1);
      if (!owner) return { kind: 'not_found' } as const;
      return { kind: 'ok', performerId: owner.performerId, ...(await balancesForPerformer(owner.performerId, input.paymentMode)) } as const;
    },

    async requestTestWithdrawal(input: {
      ownerUserId: string;
      paymentMode: 'test' | 'live';
      idempotencyKey: unknown;
      destinationKind: PayoutDestinationKind;
      deliverySpeed: 'standard' | 'instant';
      grossAmountCents: number;
    }) {
      const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
      if (!idempotencyKey) return { kind: 'invalid_idempotency_key' } as const;
      if (input.paymentMode !== 'test') return { kind: 'live_provider_required' } as const;
      if (!Number.isSafeInteger(input.grossAmountCents) || input.grossAmountCents < MINIMUM_WITHDRAWAL_CENTS) {
        return { kind: 'below_minimum' } as const;
      }

      return db.transaction(async (tx) => {
        const [owner] = await tx.select({ performerId: performers.id })
          .from(performers)
          .where(eq(performers.ownerUserId, input.ownerUserId))
          .for('update')
          .limit(1);
        if (!owner) return { kind: 'not_found' } as const;

        const [existing] = await tx.select().from(performerWithdrawals).where(and(
          eq(performerWithdrawals.performerId, owner.performerId),
          eq(performerWithdrawals.idempotencyKey, idempotencyKey)
        )).limit(1);
        if (existing) {
          const sameIntent = existing.destinationKind === input.destinationKind
            && existing.deliverySpeed === input.deliverySpeed
            && existing.grossAmountCents === input.grossAmountCents;
          return sameIntent
            ? { kind: 'replay', withdrawal: existing } as const
            : { kind: 'idempotency_conflict' } as const;
        }

        const [earnings] = await tx.select({
          capturedCents: sql<number>`coalesce(sum(${payments.amountSubtotal}), 0)::int`
        }).from(payments).where(and(
          eq(payments.performerId, owner.performerId),
          eq(payments.paymentMode, 'test'),
          eq(payments.paymentStatus, 'captured'),
          eq(payments.refundStatus, 'not_refunded')
        ));
        const [withdrawn] = await tx.select({
          reservedCents: sql<number>`coalesce(sum(${performerWithdrawals.grossAmountCents}), 0)::int`
        }).from(performerWithdrawals).where(and(
          eq(performerWithdrawals.performerId, owner.performerId),
          inArray(performerWithdrawals.status, ['requested', 'processing', 'paid'])
        ));
        const availableCents = Number(earnings?.capturedCents ?? 0) - Number(withdrawn?.reservedCents ?? 0);
        if (input.grossAmountCents > availableCents) return { kind: 'insufficient_balance', availableCents: Math.max(0, availableCents) } as const;

        const quote = quoteSimulatedWithdrawal({
          grossAmountCents: input.grossAmountCents,
          deliverySpeed: input.deliverySpeed
        });
        const netAmountCents = input.grossAmountCents - quote.providerFeeCents;
        if (netAmountCents <= 0) return { kind: 'fee_exceeds_amount' } as const;

        const [withdrawal] = await tx.insert(performerWithdrawals).values({
          performerId: owner.performerId,
          ownerUserId: input.ownerUserId,
          idempotencyKey,
          destinationKind: input.destinationKind,
          deliverySpeed: input.deliverySpeed,
          status: 'requested',
          grossAmountCents: input.grossAmountCents,
          providerFeeCents: quote.providerFeeCents,
          netAmountCents,
          provider: quote.provider
        }).returning();

        await writeAuditEvent(tx, {
          actorId: input.ownerUserId,
          actorType: 'performer',
          entityType: 'performer_withdrawal',
          entityId: withdrawal.id,
          eventType: 'performer_withdrawal.request',
          previousStatus: null,
          nextStatus: 'requested',
          metadata: {
            grossAmountCents: input.grossAmountCents,
            providerFeeCents: quote.providerFeeCents,
            netAmountCents,
            destinationKind: input.destinationKind,
            deliverySpeed: input.deliverySpeed,
            paymentMode: 'test',
            simulated: true,
            swayPayoutMarkupCents: 0
          }
        });
        return { kind: 'created', withdrawal } as const;
      });
    }
  };
}
