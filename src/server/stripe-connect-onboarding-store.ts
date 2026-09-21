import { randomUUID } from 'crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { SwayDb } from '../db/client';
import {
  auditEvents,
  performerStripeConnectBindings,
  performers,
  stripeConnectModeOnboardingOperations,
  stripeConnectOnboardingOperations,
  users
} from '../db/schema';
import { toAuditEntityUuid } from './audit-log';

const STRIPE_CONNECT_LEASE_MS = 2 * 60 * 1000;

export type StripeConnectProvisioningReservation =
  | { kind: 'bound'; accountId: string }
  | { kind: 'busy' }
  | { kind: 'not_found' }
  | { kind: 'unverified' }
  | {
      kind: 'reserved';
      leaseToken: string;
      operationKey: string;
      displayName: string;
      contactEmail: string;
    };

export type StripeConnectOnboardingStore = ReturnType<typeof createStripeConnectOnboardingStore>;
export type StripePaymentMode = 'test' | 'live';

function operationKeyForPerformerOwner(performerId: string, ownerUserId: string, paymentMode: StripePaymentMode) {
  return paymentMode === 'test'
    ? `sway-connect-recipient:${performerId}:owner:${ownerUserId}:v1`
    : `sway-connect-recipient:live:${performerId}:owner:${ownerUserId}:v2`;
}

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : 'unknown_error';
  return message
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9_]+\b/g, '[stripe-key]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 500);
}

export function createStripeConnectOnboardingStore(db: SwayDb, now = () => new Date()) {
  return {
    async reserve(input: {
      performerId: string;
      ownerUserId: string;
      paymentMode: StripePaymentMode;
    }): Promise<StripeConnectProvisioningReservation> {
      return db.transaction(async (tx) => {
        const paymentMode = input.paymentMode;
        const [owner] = await tx
          .select({
            performerId: performers.id,
            displayName: performers.displayName,
            legacyTestStripeAccountId: performers.stripeConnectedAccountId,
            legacyTestPaymentAccountStatus: performers.paymentAccountStatus,
            legacyTestChargesEnabled: performers.chargesEnabled,
            legacyTestPayoutsEnabled: performers.payoutsEnabled,
            legacyTestStatusCheckedAt: performers.stripeConnectStatusCheckedAt,
            contactEmail: users.email,
            emailVerifiedAt: users.emailVerifiedAt
          })
          .from(performers)
          .innerJoin(users, eq(users.id, performers.ownerUserId))
          .where(and(
            eq(performers.id, input.performerId),
            eq(performers.ownerUserId, input.ownerUserId)
          ))
          .for('update')
          .limit(1);

        if (!owner) return { kind: 'not_found' } as const;
        if (!owner.contactEmail || !owner.emailVerifiedAt) return { kind: 'unverified' } as const;

        const newOperationKey = operationKeyForPerformerOwner(
          owner.performerId,
          input.ownerUserId,
          paymentMode
        );

        // A pre-migration server may finish a test-mode operation during the
        // rolling deploy. Import that row lazily and preserve its provider
        // idempotency key instead of creating a second recipient.
        if (paymentMode === 'test') {
          await tx.insert(stripeConnectOnboardingOperations).values({
            performerId: owner.performerId,
            ownerUserId: input.ownerUserId,
            operationKey: newOperationKey
          }).onConflictDoNothing({ target: stripeConnectOnboardingOperations.performerId });
        }
        const [legacyOperation] = paymentMode === 'test'
          ? await tx
              .select()
              .from(stripeConnectOnboardingOperations)
              .where(eq(stripeConnectOnboardingOperations.performerId, owner.performerId))
              .for('update')
              .limit(1)
          : [];

        await tx.insert(stripeConnectModeOnboardingOperations).values({
          performerId: owner.performerId,
          paymentMode,
          ownerUserId: input.ownerUserId,
          operationKey: legacyOperation?.operationKey ?? newOperationKey,
          status: legacyOperation?.status ?? 'pending',
          stripeAccountId: legacyOperation?.stripeAccountId ?? null,
          leaseToken: legacyOperation?.leaseToken ?? null,
          leaseExpiresAt: legacyOperation?.leaseExpiresAt ?? null,
          attemptCount: legacyOperation?.attemptCount ?? 0,
          lastError: legacyOperation?.lastError ?? null
        }).onConflictDoNothing({
          target: [
            stripeConnectModeOnboardingOperations.performerId,
            stripeConnectModeOnboardingOperations.paymentMode
          ]
        });

        let [operation] = await tx
          .select()
          .from(stripeConnectModeOnboardingOperations)
          .where(and(
            eq(stripeConnectModeOnboardingOperations.performerId, owner.performerId),
            eq(stripeConnectModeOnboardingOperations.paymentMode, paymentMode)
          ))
          .for('update')
          .limit(1);

        if (
          paymentMode === 'test'
          && legacyOperation
          && (
            legacyOperation.ownerUserId !== input.ownerUserId
            || legacyOperation.operationKey !== newOperationKey
          )
        ) {
          throw new Error('stripe_connect_operation_identity_conflict');
        }
        if (
          !operation
          || operation.ownerUserId !== input.ownerUserId
          || operation.paymentMode !== paymentMode
          || operation.operationKey !== newOperationKey
        ) {
          throw new Error('stripe_connect_operation_identity_conflict');
        }

        // The legacy row is the cross-version coordination lane for test
        // onboarding. A still-running old process writes only this row, so
        // mirror its bound/lease/failure state before consulting the new mode
        // row. New test writers update both rows in one transaction; live
        // state never enters this compatibility path.
        if (paymentMode === 'test' && legacyOperation) {
          if (
            operation.stripeAccountId !== legacyOperation.stripeAccountId
            && operation.stripeAccountId !== null
          ) {
            throw new Error('stripe_connect_account_binding_conflict');
          }
          const operationHasLease = operation.status === 'provisioning'
            && operation.leaseToken
            && operation.leaseExpiresAt;
          if (
            operationHasLease
            && (
              legacyOperation.status !== 'provisioning'
              || legacyOperation.leaseToken !== operation.leaseToken
              || legacyOperation.leaseExpiresAt?.getTime() !== operation.leaseExpiresAt?.getTime()
            )
          ) {
            throw new Error('stripe_connect_operation_lease_conflict');
          }
          if (legacyOperation.attemptCount < operation.attemptCount) {
            throw new Error('stripe_connect_operation_identity_conflict');
          }
          const [mirroredOperation] = await tx
            .update(stripeConnectModeOnboardingOperations)
            .set({
              status: legacyOperation.status,
              stripeAccountId: operation.stripeAccountId ?? legacyOperation.stripeAccountId,
              leaseToken: legacyOperation.leaseToken,
              leaseExpiresAt: legacyOperation.leaseExpiresAt,
              attemptCount: legacyOperation.attemptCount,
              lastError: legacyOperation.lastError,
              updatedAt: legacyOperation.updatedAt
            })
            .where(and(
              eq(stripeConnectModeOnboardingOperations.performerId, owner.performerId),
              eq(stripeConnectModeOnboardingOperations.paymentMode, paymentMode)
            ))
            .returning();
          if (!mirroredOperation) throw new Error('stripe_connect_operation_identity_conflict');
          operation = mirroredOperation;
        }

        const [binding] = await tx
          .select()
          .from(performerStripeConnectBindings)
          .where(and(
            eq(performerStripeConnectBindings.performerId, owner.performerId),
            eq(performerStripeConnectBindings.paymentMode, paymentMode)
          ))
          .for('update')
          .limit(1);
        const legacyAccountId = paymentMode === 'test'
          ? owner.legacyTestStripeAccountId ?? legacyOperation?.stripeAccountId ?? null
          : null;
        const durableAccountId = binding?.stripeAccountId ?? operation.stripeAccountId ?? legacyAccountId;
        if (durableAccountId) {
          const identities = [binding?.stripeAccountId, operation.stripeAccountId, legacyAccountId].filter(Boolean);
          if (new Set(identities).size > 1) {
            throw new Error('stripe_connect_account_binding_conflict');
          }
          await tx.insert(performerStripeConnectBindings).values({
            performerId: owner.performerId,
            paymentMode,
            stripeAccountId: durableAccountId,
            paymentAccountStatus: paymentMode === 'test' && owner.legacyTestStripeAccountId
              ? owner.legacyTestPaymentAccountStatus
              : 'not_started',
            chargesEnabled: paymentMode === 'test' && owner.legacyTestStripeAccountId
              ? owner.legacyTestChargesEnabled
              : false,
            payoutsEnabled: paymentMode === 'test' && owner.legacyTestStripeAccountId
              ? owner.legacyTestPayoutsEnabled
              : false,
            statusCheckedAt: paymentMode === 'test'
              ? owner.legacyTestStatusCheckedAt
              : null
          }).onConflictDoNothing({
            target: [performerStripeConnectBindings.performerId, performerStripeConnectBindings.paymentMode]
          });
          await tx.update(stripeConnectModeOnboardingOperations).set({
            status: 'bound',
            stripeAccountId: durableAccountId,
            leaseToken: null,
            leaseExpiresAt: null,
            lastError: null,
            updatedAt: now()
          }).where(and(
            eq(stripeConnectModeOnboardingOperations.performerId, owner.performerId),
            eq(stripeConnectModeOnboardingOperations.paymentMode, paymentMode)
          ));
          if (paymentMode === 'test') {
            const [legacyBound] = owner.legacyTestStripeAccountId
              ? [{ accountId: owner.legacyTestStripeAccountId }]
              : await tx.update(performers).set({
                  stripeConnectedAccountId: durableAccountId,
                  updatedAt: now()
                }).where(and(
                  eq(performers.id, owner.performerId),
                  eq(performers.ownerUserId, input.ownerUserId),
                  isNull(performers.stripeConnectedAccountId)
                )).returning({ accountId: performers.stripeConnectedAccountId });
            if (legacyBound?.accountId !== durableAccountId) {
              throw new Error('stripe_connect_account_binding_conflict');
            }
            await tx.update(stripeConnectOnboardingOperations).set({
              status: 'bound',
              stripeAccountId: durableAccountId,
              leaseToken: null,
              leaseExpiresAt: null,
              lastError: null,
              updatedAt: now()
            }).where(eq(stripeConnectOnboardingOperations.performerId, owner.performerId));
          }
          return { kind: 'bound', accountId: durableAccountId } as const;
        }

        const currentTime = now();
        if (
          operation.status === 'provisioning'
          && operation.leaseToken
          && operation.leaseExpiresAt
          && operation.leaseExpiresAt > currentTime
        ) {
          return { kind: 'busy' } as const;
        }

        const leaseToken = randomUUID();
        const leaseExpiresAt = new Date(currentTime.getTime() + STRIPE_CONNECT_LEASE_MS);
        const [leased] = await tx.update(stripeConnectModeOnboardingOperations).set({
          status: 'provisioning',
          leaseToken,
          leaseExpiresAt,
          attemptCount: sql`${stripeConnectModeOnboardingOperations.attemptCount} + 1`,
          lastError: null,
          updatedAt: currentTime
        }).where(and(
          eq(stripeConnectModeOnboardingOperations.performerId, owner.performerId),
          eq(stripeConnectModeOnboardingOperations.paymentMode, paymentMode),
          isNull(stripeConnectModeOnboardingOperations.stripeAccountId)
        )).returning({ performerId: stripeConnectModeOnboardingOperations.performerId });

        if (!leased) return { kind: 'busy' } as const;
        if (paymentMode === 'test') {
          await tx.update(stripeConnectOnboardingOperations).set({
            status: 'provisioning',
            leaseToken,
            leaseExpiresAt,
            attemptCount: sql`${stripeConnectOnboardingOperations.attemptCount} + 1`,
            lastError: null,
            updatedAt: currentTime
          }).where(and(
            eq(stripeConnectOnboardingOperations.performerId, owner.performerId),
            isNull(stripeConnectOnboardingOperations.stripeAccountId)
          ));
        }
        return {
          kind: 'reserved',
          leaseToken,
          operationKey: operation.operationKey,
          displayName: owner.displayName,
          contactEmail: owner.contactEmail
        } as const;
      });
    },

    async complete(input: {
      performerId: string;
      ownerUserId: string;
      paymentMode: StripePaymentMode;
      leaseToken: string;
      operationKey: string;
      accountId: string;
    }) {
      return db.transaction(async (tx) => {
        const paymentMode = input.paymentMode;
        const expectedOperationKey = operationKeyForPerformerOwner(
          input.performerId,
          input.ownerUserId,
          paymentMode
        );
        // Lock in the same performer -> operation order as reserve() so a
        // completion racing a retry cannot form a database deadlock cycle.
        const [owner] = await tx.select({
          legacyTestAccountId: performers.stripeConnectedAccountId
        }).from(performers).where(and(
          eq(performers.id, input.performerId),
          eq(performers.ownerUserId, input.ownerUserId)
        )).for('update').limit(1);

        if (!owner) throw new Error('stripe_connect_owner_not_found');

        const [operation] = await tx
          .select()
          .from(stripeConnectModeOnboardingOperations)
          .where(and(
            eq(stripeConnectModeOnboardingOperations.performerId, input.performerId),
            eq(stripeConnectModeOnboardingOperations.paymentMode, paymentMode)
          ))
          .for('update')
          .limit(1);

        if (
          !operation
          || operation.ownerUserId !== input.ownerUserId
          || operation.operationKey !== expectedOperationKey
          || input.operationKey !== expectedOperationKey
        ) {
          throw new Error('stripe_connect_operation_identity_conflict');
        }
        if (operation.stripeAccountId && operation.stripeAccountId !== input.accountId) {
          throw new Error('stripe_connect_account_binding_conflict');
        }
        if (operation.status === 'bound' && operation.stripeAccountId === input.accountId) {
          return { accountId: input.accountId };
        }
        if (operation.leaseToken !== input.leaseToken) {
          throw new Error('stripe_connect_operation_lease_conflict');
        }
        if (paymentMode === 'test' && owner.legacyTestAccountId && owner.legacyTestAccountId !== input.accountId) {
          throw new Error('stripe_connect_account_binding_conflict');
        }

        const [existingBinding] = await tx
          .select({ accountId: performerStripeConnectBindings.stripeAccountId })
          .from(performerStripeConnectBindings)
          .where(and(
            eq(performerStripeConnectBindings.performerId, input.performerId),
            eq(performerStripeConnectBindings.paymentMode, paymentMode)
          ))
          .for('update')
          .limit(1);
        if (existingBinding?.accountId && existingBinding.accountId !== input.accountId) {
          throw new Error('stripe_connect_account_binding_conflict');
        }
        await tx.insert(performerStripeConnectBindings).values({
          performerId: input.performerId,
          paymentMode,
          stripeAccountId: input.accountId
        }).onConflictDoNothing({
          target: [performerStripeConnectBindings.performerId, performerStripeConnectBindings.paymentMode]
        });

        if (paymentMode === 'test') {
          const [legacyBound] = owner.legacyTestAccountId
            ? [{ accountId: owner.legacyTestAccountId }]
            : await tx.update(performers).set({
                stripeConnectedAccountId: input.accountId,
                updatedAt: now()
              }).where(and(
                eq(performers.id, input.performerId),
                eq(performers.ownerUserId, input.ownerUserId),
                isNull(performers.stripeConnectedAccountId)
              )).returning({ accountId: performers.stripeConnectedAccountId });
          if (legacyBound?.accountId !== input.accountId) {
            throw new Error('stripe_connect_account_binding_conflict');
          }
          await tx.update(stripeConnectOnboardingOperations).set({
            status: 'bound',
            stripeAccountId: input.accountId,
            leaseToken: null,
            leaseExpiresAt: null,
            lastError: null,
            updatedAt: now()
          }).where(eq(stripeConnectOnboardingOperations.performerId, input.performerId));
        }

        await tx.update(stripeConnectModeOnboardingOperations).set({
          status: 'bound',
          stripeAccountId: input.accountId,
          leaseToken: null,
          leaseExpiresAt: null,
          lastError: null,
          updatedAt: now()
        }).where(and(
          eq(stripeConnectModeOnboardingOperations.performerId, input.performerId),
          eq(stripeConnectModeOnboardingOperations.paymentMode, paymentMode),
          eq(stripeConnectModeOnboardingOperations.leaseToken, input.leaseToken)
        ));

        await tx.insert(auditEvents).values({
          actorType: 'performer',
          actorId: input.ownerUserId,
          entityType: 'stripe_connect_account',
          entityId: toAuditEntityUuid(input.performerId),
          eventType: 'stripe_connect.account_bound',
          previousStatus: 'provisioning',
          nextStatus: 'bound',
          metadata: {
            operationKey: input.operationKey,
            stripeAccountId: input.accountId,
            paymentMode
          }
        });

        return { accountId: input.accountId };
      });
    },

    async fail(input: {
      performerId: string;
      paymentMode: StripePaymentMode;
      leaseToken: string;
      error: unknown;
    }) {
      const paymentMode = input.paymentMode;
      await db.transaction(async (tx) => {
        const [performer] = await tx
          .select({ id: performers.id })
          .from(performers)
          .where(eq(performers.id, input.performerId))
          .for('update')
          .limit(1);
        if (!performer) return;

        const [legacyOperation] = paymentMode === 'test'
          ? await tx
              .select({ leaseToken: stripeConnectOnboardingOperations.leaseToken })
              .from(stripeConnectOnboardingOperations)
              .where(eq(stripeConnectOnboardingOperations.performerId, input.performerId))
              .for('update')
              .limit(1)
          : [];
        await tx
          .select({ performerId: stripeConnectModeOnboardingOperations.performerId })
          .from(stripeConnectModeOnboardingOperations)
          .where(and(
            eq(stripeConnectModeOnboardingOperations.performerId, input.performerId),
            eq(stripeConnectModeOnboardingOperations.paymentMode, paymentMode)
          ))
          .for('update')
          .limit(1);

        if (paymentMode === 'test' && legacyOperation?.leaseToken !== input.leaseToken) return;
        const failure = safeError(input.error);
        const failedAt = now();
        if (paymentMode === 'test') {
          await tx.update(stripeConnectOnboardingOperations).set({
            status: 'pending',
            leaseToken: null,
            leaseExpiresAt: null,
            lastError: failure,
            updatedAt: failedAt
          }).where(and(
            eq(stripeConnectOnboardingOperations.performerId, input.performerId),
            eq(stripeConnectOnboardingOperations.leaseToken, input.leaseToken)
          ));
        }
        await tx.update(stripeConnectModeOnboardingOperations).set({
          status: 'pending',
          leaseToken: null,
          leaseExpiresAt: null,
          lastError: failure,
          updatedAt: failedAt
        }).where(and(
          eq(stripeConnectModeOnboardingOperations.performerId, input.performerId),
          eq(stripeConnectModeOnboardingOperations.paymentMode, paymentMode),
          eq(stripeConnectModeOnboardingOperations.leaseToken, input.leaseToken),
          gt(stripeConnectModeOnboardingOperations.leaseExpiresAt, new Date(0))
        ));
      });
    }
  };
}
