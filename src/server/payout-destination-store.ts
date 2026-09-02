import { and, eq, inArray } from 'drizzle-orm';
import type { SwayDb } from '../db/client';
import { performerPayoutPreferences, performerWithdrawals, performers } from '../db/schema';
import type {
  NormalizedPayoutRecipient,
  PayoutDestinationKind,
  PayoutRecipientType
} from '../payout-destination';
import { writeAuditEvent } from './audit-log';
import type { PayoutRecipientCipher } from './payout-recipient-crypto';

export type PayoutDestinationStore = ReturnType<typeof createPayoutDestinationStore>;

export function createPayoutDestinationStore(
  db: SwayDb,
  cipher: PayoutRecipientCipher,
  paymentMode: 'test' | 'live',
  now = () => new Date()
) {
  return {
    async saveForOwner(input: {
      performerId: string;
      ownerUserId: string;
      recipient: NormalizedPayoutRecipient;
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

        const encrypted = cipher.encrypt({
          performerId: owner.performerId,
          paymentMode,
          destinationKind: input.recipient.destinationKind,
          recipientType: input.recipient.recipientType,
          recipientValue: input.recipient.recipientValue
        });
        const [previous] = await tx.select().from(performerPayoutPreferences)
          .where(eq(performerPayoutPreferences.performerId, owner.performerId))
          .limit(1);
        const unchanged = previous?.paymentMode === paymentMode
          && previous.destinationKind === input.recipient.destinationKind
          && previous.recipientType === input.recipient.recipientType
          && previous.recipientValueFingerprint === encrypted.fingerprint;
        if (unchanged) {
          return {
            kind: 'unchanged',
            destinationKind: input.recipient.destinationKind,
            recipientType: input.recipient.recipientType,
            recipientPreview: previous.recipientValuePreview
          } as const;
        }

        const [unresolvedWithdrawal] = await tx.select({ id: performerWithdrawals.id })
          .from(performerWithdrawals)
          .where(and(
            eq(performerWithdrawals.performerId, owner.performerId),
            inArray(performerWithdrawals.status, [
              'requested',
              'submitting',
              'processing',
              'unclaimed',
              'held'
            ])
          ))
          .limit(1);
        if (unresolvedWithdrawal) {
          return { kind: 'withdrawal_in_progress' } as const;
        }

        const savedAt = now();
        await tx.insert(performerPayoutPreferences).values({
          performerId: owner.performerId,
          paymentMode,
          destinationKind: input.recipient.destinationKind,
          recipientType: input.recipient.recipientType,
          recipientValueEncrypted: encrypted.encryptedValue,
          recipientValueFingerprint: encrypted.fingerprint,
          recipientValuePreview: input.recipient.recipientPreview,
          provider: 'paypal_payouts',
          privacyDeletionRequestedAt: null,
          createdAt: savedAt,
          updatedAt: savedAt
        }).onConflictDoUpdate({
          target: performerPayoutPreferences.performerId,
          set: {
            paymentMode,
            destinationKind: input.recipient.destinationKind,
            recipientType: input.recipient.recipientType,
            recipientValueEncrypted: encrypted.encryptedValue,
            recipientValueFingerprint: encrypted.fingerprint,
            recipientValuePreview: input.recipient.recipientPreview,
            provider: 'paypal_payouts',
            privacyDeletionRequestedAt: null,
            updatedAt: savedAt
          }
        });

        await writeAuditEvent(tx, {
          actorId: input.ownerUserId,
          actorType: 'performer',
          entityType: 'performer_payout_preference',
          entityId: owner.performerId,
          eventType: 'performer_payout_preference.save',
          previousStatus: previous?.destinationKind ?? 'not_selected',
          nextStatus: input.recipient.destinationKind,
          metadata: {
            provider: 'paypal_payouts',
            paymentMode,
            recipientType: input.recipient.recipientType,
            recipientPreview: input.recipient.recipientPreview,
            encryptedAtRest: true,
            rawRecipientStoredInAudit: false
          }
        });

        return {
          kind: 'updated',
          destinationKind: input.recipient.destinationKind,
          recipientType: input.recipient.recipientType,
          recipientPreview: input.recipient.recipientPreview
        } as const;
      });
    },

    fingerprintRecipient(input: {
      performerId: string;
      recipient: NormalizedPayoutRecipient;
    }) {
      return cipher.fingerprint({
        performerId: input.performerId,
        paymentMode,
        destinationKind: input.recipient.destinationKind,
        recipientType: input.recipient.recipientType,
        recipientValue: input.recipient.recipientValue
      });
    },

    async loadForPerformer(performerId: string): Promise<{
      destinationKind: PayoutDestinationKind;
      recipientType: PayoutRecipientType;
      recipientValue: string;
      recipientFingerprint: string;
      recipientPreview: string;
    } | null> {
      const [preference] = await db.select().from(performerPayoutPreferences)
        .where(and(
          eq(performerPayoutPreferences.performerId, performerId),
          eq(performerPayoutPreferences.paymentMode, paymentMode)
        ))
        .limit(1);
      if (!preference) return null;
      const destinationKind = preference.destinationKind as PayoutDestinationKind;
      const recipientType = preference.recipientType as PayoutRecipientType;
      const recipientValue = cipher.decrypt({
        performerId,
        paymentMode,
        destinationKind,
        recipientType,
        encryptedValue: preference.recipientValueEncrypted
      });
      return {
        destinationKind,
        recipientType,
        recipientValue,
        recipientFingerprint: preference.recipientValueFingerprint,
        recipientPreview: preference.recipientValuePreview
      };
    }
  };
}
