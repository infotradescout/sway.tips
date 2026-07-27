import { createHash } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import type { SwayDb } from '../db/client';
import { performers, proModeStatusEvents, users } from '../db/schema';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function claimCodeFingerprint(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 12);
}

export function readClaimPerformerId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const performerId = (metadata as Record<string, unknown>).performerId;
  if (typeof performerId !== 'string' || !UUID_PATTERN.test(performerId)) return null;
  return performerId;
}

export function mapClaimInspectionToClientError(status: string): { status: number; code: string; error: string } {
  switch (status) {
    case 'expired':
      return { status: 410, code: 'expired', error: 'Code expired' };
    case 'consumed':
      return { status: 410, code: 'already_used', error: 'Code already used' };
    case 'revoked':
      return { status: 410, code: 'already_used', error: 'Code already used' };
    case 'profile_already_claimed':
      return { status: 409, code: 'profile_already_claimed', error: 'Profile already claimed' };
    case 'unavailable':
      return { status: 503, code: 'unavailable', error: 'Code temporarily unavailable for validation' };
    case 'rate_limited':
      return { status: 429, code: 'rate_limited', error: 'Rate limit reached' };
    case 'not_found':
    case 'wrong_type':
    default:
      return { status: 404, code: 'not_recognized', error: 'Code not recognized' };
  }
}

type Tx = Parameters<Parameters<SwayDb['transaction']>[0]>[0];

export async function activateClaimedPerformerAndProMode(
  tx: Tx,
  input: { userId: string; performerId: string; completedAt?: Date; reason?: string }
) {
  const completedAt = input.completedAt ?? new Date();
  await tx
    .update(performers)
    .set({
      isActive: true,
      onboardingStatus: 'gig_ready',
      updatedAt: completedAt
    })
    .where(eq(performers.id, input.performerId));

  const [proModeRow] = await tx
    .select({ proModeStatus: users.proModeStatus })
    .from(users)
    .where(eq(users.id, input.userId))
    .for('update')
    .limit(1);
  const currentProMode = proModeRow?.proModeStatus ?? 'disabled';
  const shouldActivate = currentProMode === 'disabled' || currentProMode === 'onboarding';

  if (shouldActivate) {
    await tx
      .update(users)
      .set({
        role: 'performer',
        proModeStatus: 'active',
        proModeStatusChangedAt: completedAt,
        updatedAt: completedAt
      })
      .where(eq(users.id, input.userId));
    await tx.insert(proModeStatusEvents).values({
      userId: input.userId,
      previousStatus: currentProMode,
      nextStatus: 'active',
      reason: input.reason ?? 'performer_claim_redeem',
      actorUserId: input.userId
    });
  } else {
    await tx
      .update(users)
      .set({
        role: 'performer',
        updatedAt: completedAt
      })
      .where(eq(users.id, input.userId));
  }

  return { proModeActivated: shouldActivate, previousProMode: currentProMode };
}

export async function assertPerformerClaimableByHandoff(
  tx: Tx,
  input: { performerId: string; handoffUserId: string }
): Promise<{ ok: true; displayName: string; handle: string | null } | { ok: false; code: string }> {
  const [performer] = await tx
    .select({
      id: performers.id,
      ownerUserId: performers.ownerUserId,
      displayName: performers.displayName,
      handle: performers.handle,
      onboardingStatus: performers.onboardingStatus
    })
    .from(performers)
    .where(eq(performers.id, input.performerId))
    .for('update')
    .limit(1);

  if (!performer) return { ok: false, code: 'not_recognized' };
  if (performer.onboardingStatus === 'suspended') return { ok: false, code: 'unavailable' };
  if (performer.ownerUserId !== input.handoffUserId) {
    return { ok: false, code: 'profile_already_claimed' };
  }
  return { ok: true, displayName: performer.displayName, handle: performer.handle };
}

export async function transferPerformerOwnership(
  tx: Tx,
  input: {
    performerId: string;
    fromUserId: string;
    toUserId: string;
    completedAt?: Date;
  }
): Promise<{ ok: true } | { ok: false; code: string }> {
  const completedAt = input.completedAt ?? new Date();

  if (input.fromUserId === input.toUserId) {
    return { ok: true };
  }

  const [existingOwned] = await tx
    .select({ id: performers.id })
    .from(performers)
    .where(and(
      eq(performers.ownerUserId, input.toUserId),
      ne(performers.id, input.performerId)
    ))
    .limit(1);

  if (existingOwned) {
    return { ok: false, code: 'profile_already_claimed' };
  }

  const claimable = await assertPerformerClaimableByHandoff(tx, {
    performerId: input.performerId,
    handoffUserId: input.fromUserId
  });
  if (!claimable.ok) return claimable;

  const [updated] = await tx
    .update(performers)
    .set({
      ownerUserId: input.toUserId,
      isActive: true,
      onboardingStatus: 'gig_ready',
      updatedAt: completedAt
    })
    .where(and(
      eq(performers.id, input.performerId),
      eq(performers.ownerUserId, input.fromUserId)
    ))
    .returning({ id: performers.id });

  if (!updated) return { ok: false, code: 'profile_already_claimed' };
  return { ok: true };
}
