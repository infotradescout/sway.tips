import { and, eq } from 'drizzle-orm';
import type { SwayDb } from '../db/client';
import { performerPayoutPreferences, performers } from '../db/schema';
import type { PayoutDestinationKind } from '../payout-destination';
import { writeAuditEvent } from './audit-log';

export type PayoutDestinationStore = ReturnType<typeof createPayoutDestinationStore>;

export function createPayoutDestinationStore(db: SwayDb, now = () => new Date()) {
  return {
    async selectForOwner(input: {
      performerId: string;
      ownerUserId: string;
      destinationKind: PayoutDestinationKind;
    }) {
      return db.transaction(async (tx) => {
        const [owner] = await tx
          .select({ performerId: performers.id })
          .from(performers)
          .where(and(
            eq(performers.id, input.performerId),
            eq(performers.ownerUserId, input.ownerUserId)
          ))
          .for('update')
          .limit(1);

        if (!owner) return { kind: 'not_found' } as const;

        const [previous] = await tx
          .select({ destinationKind: performerPayoutPreferences.destinationKind })
          .from(performerPayoutPreferences)
          .where(eq(performerPayoutPreferences.performerId, owner.performerId))
          .limit(1);

        const selectedAt = now();
        await tx.insert(performerPayoutPreferences).values({
          performerId: owner.performerId,
          destinationKind: input.destinationKind,
          createdAt: selectedAt,
          updatedAt: selectedAt
        }).onConflictDoUpdate({
          target: performerPayoutPreferences.performerId,
          set: {
            destinationKind: input.destinationKind,
            updatedAt: selectedAt
          }
        });

        if (previous?.destinationKind !== input.destinationKind) {
          await writeAuditEvent(tx, {
            actorId: input.ownerUserId,
            actorType: 'performer',
            entityType: 'performer_payout_preference',
            entityId: owner.performerId,
            eventType: 'performer_payout_preference.select',
            previousStatus: previous?.destinationKind ?? 'not_selected',
            nextStatus: input.destinationKind,
            metadata: {
              storesSensitiveAccountData: false,
              setupProvider: 'stripe_connect'
            }
          });
        }

        return {
          kind: previous?.destinationKind === input.destinationKind ? 'unchanged' : 'updated',
          destinationKind: input.destinationKind
        } as const;
      });
    }
  };
}
