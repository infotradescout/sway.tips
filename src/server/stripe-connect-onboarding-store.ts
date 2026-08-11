import { randomUUID } from 'crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { SwayDb } from '../db/client';
import {
  auditEvents,
  performers,
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

function operationKeyForPerformerOwner(performerId: string, ownerUserId: string) {
  return `sway-connect-recipient:${performerId}:owner:${ownerUserId}:v1`;
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
    async reserve(input: { performerId: string; ownerUserId: string }): Promise<StripeConnectProvisioningReservation> {
      return db.transaction(async (tx) => {
        const [owner] = await tx
          .select({
            performerId: performers.id,
            displayName: performers.displayName,
            stripeAccountId: performers.stripeConnectedAccountId,
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

        const operationKey = operationKeyForPerformerOwner(owner.performerId, input.ownerUserId);
        await tx.insert(stripeConnectOnboardingOperations).values({
          performerId: owner.performerId,
          ownerUserId: input.ownerUserId,
          operationKey
        }).onConflictDoNothing({ target: stripeConnectOnboardingOperations.performerId });

        const [operation] = await tx
          .select()
          .from(stripeConnectOnboardingOperations)
          .where(eq(stripeConnectOnboardingOperations.performerId, owner.performerId))
          .for('update')
          .limit(1);

        if (
          !operation
          || operation.ownerUserId !== input.ownerUserId
          || operation.operationKey !== operationKey
        ) {
          throw new Error('stripe_connect_operation_identity_conflict');
        }

        const durableAccountId = owner.stripeAccountId ?? operation.stripeAccountId;
        if (durableAccountId) {
          if (owner.stripeAccountId && operation.stripeAccountId && owner.stripeAccountId !== operation.stripeAccountId) {
            throw new Error('stripe_connect_account_binding_conflict');
          }
          if (!owner.stripeAccountId) {
            await tx.update(performers)
              .set({ stripeConnectedAccountId: durableAccountId })
              .where(and(
                eq(performers.id, owner.performerId),
                isNull(performers.stripeConnectedAccountId)
              ));
          }
          await tx.update(stripeConnectOnboardingOperations).set({
            status: 'bound',
            stripeAccountId: durableAccountId,
            leaseToken: null,
            leaseExpiresAt: null,
            lastError: null,
            updatedAt: now()
          }).where(eq(stripeConnectOnboardingOperations.performerId, owner.performerId));
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
        const [leased] = await tx.update(stripeConnectOnboardingOperations).set({
          status: 'provisioning',
          leaseToken,
          leaseExpiresAt,
          attemptCount: sql`${stripeConnectOnboardingOperations.attemptCount} + 1`,
          lastError: null,
          updatedAt: currentTime
        }).where(and(
          eq(stripeConnectOnboardingOperations.performerId, owner.performerId),
          isNull(stripeConnectOnboardingOperations.stripeAccountId)
        )).returning({ performerId: stripeConnectOnboardingOperations.performerId });

        if (!leased) return { kind: 'busy' } as const;
        return {
          kind: 'reserved',
          leaseToken,
          operationKey,
          displayName: owner.displayName,
          contactEmail: owner.contactEmail
        } as const;
      });
    },

    async complete(input: {
      performerId: string;
      ownerUserId: string;
      leaseToken: string;
      operationKey: string;
      accountId: string;
    }) {
      return db.transaction(async (tx) => {
        // Lock in the same performer -> operation order as reserve() so a
        // completion racing a retry cannot form a database deadlock cycle.
        const [owner] = await tx.select({
          accountId: performers.stripeConnectedAccountId
        }).from(performers).where(and(
          eq(performers.id, input.performerId),
          eq(performers.ownerUserId, input.ownerUserId)
        )).for('update').limit(1);

        if (!owner) throw new Error('stripe_connect_owner_not_found');

        const [operation] = await tx
          .select()
          .from(stripeConnectOnboardingOperations)
          .where(eq(stripeConnectOnboardingOperations.performerId, input.performerId))
          .for('update')
          .limit(1);

        if (
          !operation
          || operation.ownerUserId !== input.ownerUserId
          || operation.operationKey !== input.operationKey
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
        if (owner.accountId && owner.accountId !== input.accountId) {
          throw new Error('stripe_connect_account_binding_conflict');
        }

        const [bound] = owner.accountId ? [owner] : await tx.update(performers).set({
            stripeConnectedAccountId: input.accountId
          }).where(and(
            eq(performers.id, input.performerId),
            eq(performers.ownerUserId, input.ownerUserId),
            isNull(performers.stripeConnectedAccountId)
          )).returning({ accountId: performers.stripeConnectedAccountId });

        if (!bound?.accountId || bound.accountId !== input.accountId) {
          throw new Error('stripe_connect_account_binding_conflict');
        }

        await tx.update(stripeConnectOnboardingOperations).set({
          status: 'bound',
          stripeAccountId: input.accountId,
          leaseToken: null,
          leaseExpiresAt: null,
          lastError: null,
          updatedAt: now()
        }).where(and(
          eq(stripeConnectOnboardingOperations.performerId, input.performerId),
          eq(stripeConnectOnboardingOperations.leaseToken, input.leaseToken)
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
            stripeAccountId: input.accountId
          }
        });

        return { accountId: input.accountId };
      });
    },

    async fail(input: { performerId: string; leaseToken: string; error: unknown }) {
      await db.update(stripeConnectOnboardingOperations).set({
        status: 'pending',
        leaseToken: null,
        leaseExpiresAt: null,
        lastError: safeError(input.error),
        updatedAt: now()
      }).where(and(
        eq(stripeConnectOnboardingOperations.performerId, input.performerId),
        eq(stripeConnectOnboardingOperations.leaseToken, input.leaseToken),
        gt(stripeConnectOnboardingOperations.leaseExpiresAt, new Date(0))
      ));
    }
  };
}
