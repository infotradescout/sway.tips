import { createHmac, timingSafeEqual } from 'node:crypto';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PerformerBootstrapClaims = {
  v: 1;
  actor_user_id: string;
  exp: string;
};

export function createPerformerBootstrapToken(input: {
  actorUserId: string;
  secret: string;
  expiresAt: string;
}) {
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    actor_user_id: input.actorUserId,
    exp: input.expiresAt
  } satisfies PerformerBootstrapClaims), 'utf8').toString('base64url');

  const signature = createHmac('sha256', input.secret)
    .update(payload, 'utf8')
    .digest('base64url');

  return `${payload}.${signature}`;
}

export function verifyPerformerBootstrapToken(token: string, secret: string) {
  if (!token || !secret) {
    return { valid: false, reason: 'missing_token_or_secret' as const };
  }

  const separatorIndex = token.indexOf('.');
  if (separatorIndex <= 0 || separatorIndex === token.length - 1) {
    return { valid: false, reason: 'invalid_format' as const };
  }

  const payload = token.slice(0, separatorIndex);
  const signature = token.slice(separatorIndex + 1);
  const expectedSignature = createHmac('sha256', secret)
    .update(payload, 'utf8')
    .digest('base64url');

  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return { valid: false, reason: 'invalid_signature' as const };
  }

  let parsedPayload: PerformerBootstrapClaims;
  try {
    parsedPayload = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as PerformerBootstrapClaims;
  } catch {
    return { valid: false, reason: 'invalid_payload' as const };
  }

  if (parsedPayload.v !== 1 || !UUID_PATTERN.test(parsedPayload.actor_user_id)) {
    return { valid: false, reason: 'invalid_actor' as const };
  }

  const expiresAt = new Date(parsedPayload.exp);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    return { valid: false, reason: 'expired' as const };
  }

  return {
    valid: true,
    claims: {
      actorUserId: parsedPayload.actor_user_id,
      expiresAt
    }
  };
}
