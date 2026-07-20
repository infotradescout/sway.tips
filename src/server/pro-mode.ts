import { eq } from 'drizzle-orm';
import type { SwayDb } from '../db/client';
import { proModeStatusEvents, users } from '../db/schema';

export type ProModeStatus = 'disabled' | 'onboarding' | 'active' | 'suspended' | 'revoked';
export type ProModeAction = 'performer_signup' | 'self_activate';

export type ProModeTransitionResult =
  | { allowed: true; nextStatus: ProModeStatus; changed: boolean }
  | { allowed: false; reason: string };

// Pure decision function -- no DB access -- so the transition rules are
// unit-testable without a database. Performer signup and patron self-service
// activation are the only two entry points in this slice; suspending or
// revoking Pro Mode is administrative-only and is not implemented here.
export function resolveProModeTransition(input: {
  currentStatus: ProModeStatus;
  action: ProModeAction;
}): ProModeTransitionResult {
  switch (input.action) {
    case 'performer_signup': {
      if (input.currentStatus !== 'disabled') {
        return {
          allowed: false,
          reason: `Performer signup requires a disabled Pro Mode account; current status is ${input.currentStatus}.`
        };
      }
      return { allowed: true, nextStatus: 'onboarding', changed: true };
    }

    case 'self_activate': {
      if (input.currentStatus === 'disabled' || input.currentStatus === 'onboarding') {
        return { allowed: true, nextStatus: 'active', changed: true };
      }
      if (input.currentStatus === 'active') {
        return { allowed: true, nextStatus: 'active', changed: false };
      }
      return {
        allowed: false,
        reason: `Pro Mode is ${input.currentStatus}; contact support to reactivate.`
      };
    }
  }
}

export async function getProModeStatus(db: SwayDb, userId: string): Promise<ProModeStatus | null> {
  const rows = await db
    .select({ proModeStatus: users.proModeStatus })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0]?.proModeStatus ?? null;
}

// Reads current status, computes the transition, and -- only if it actually
// changes the status -- writes the users row and an append-only audit event
// in one transaction. Self-activation on an already-onboarding/active
// account is a no-op success (idempotent), not a duplicate event.
//
// Concurrency: the initial SELECT takes FOR UPDATE, row-locking the target
// users row for the duration of the transaction. A second concurrent caller
// targeting the same account blocks until the first transaction commits,
// then re-reads the now-updated status and correctly resolves to a
// changed:false no-op instead of racing to a duplicate transition/event.
//
// Boundary: this function only ever reads/writes users.pro_mode_status and
// pro_mode_status_events. It never reads or writes performers.*, so
// activation can never change onboarding status, payout/payment-provider
// readiness, or talent access -- those remain governed entirely by
// requireTalentAccess and the performers table, independent of Pro Mode
// state.
export async function applyProModeTransition(
  db: SwayDb,
  input: { userId: string; action: ProModeAction; actorUserId: string; reason: string }
): Promise<ProModeTransitionResult> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ proModeStatus: users.proModeStatus })
      .from(users)
      .where(eq(users.id, input.userId))
      .for('update')
      .limit(1);

    if (!rows.length) {
      return { allowed: false, reason: 'Account not found.' };
    }

    const currentStatus = rows[0].proModeStatus;
    const transition = resolveProModeTransition({ currentStatus, action: input.action });
    if (transition.allowed === false) {
      return transition;
    }
    if (transition.changed === false) {
      return transition;
    }

    await tx
      .update(users)
      .set({ proModeStatus: transition.nextStatus, proModeStatusChangedAt: new Date() })
      .where(eq(users.id, input.userId));

    await tx.insert(proModeStatusEvents).values({
      userId: input.userId,
      previousStatus: currentStatus,
      nextStatus: transition.nextStatus,
      reason: input.reason,
      actorUserId: input.actorUserId
    });

    return transition;
  });
}
