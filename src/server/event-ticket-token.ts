import { createHmac, timingSafeEqual } from 'node:crypto';

const TICKET_QR_VERSION = 1;
const DEFAULT_QR_LIFETIME_SECONDS = 45;
const MAX_QR_LIFETIME_SECONDS = 120;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type TicketQrPayload = {
  v: typeof TICKET_QR_VERSION;
  ticketId: string;
  eventId: string;
  issuedAt: number;
  expiresAt: number;
};

function requireQrSecret(secret: string) {
  const normalized = secret.trim();
  if (normalized.length < 32) {
    throw new Error('Ticket QR signing secret must contain at least 32 characters.');
  }
  return normalized;
}

function encodePayload(payload: TicketQrPayload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function signPayload(encodedPayload: string, secret: string) {
  return createHmac('sha256', requireQrSecret(secret))
    .update(encodedPayload, 'utf8')
    .digest('base64url');
}

export function issueEventTicketQrToken(input: {
  ticketId: string;
  eventId: string;
  secret: string;
  now?: Date;
  lifetimeSeconds?: number;
}) {
  if (!UUID_PATTERN.test(input.ticketId) || !UUID_PATTERN.test(input.eventId)) {
    throw new Error('Ticket QR ids must be valid UUIDs.');
  }

  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1_000);
  const lifetimeSeconds = input.lifetimeSeconds ?? DEFAULT_QR_LIFETIME_SECONDS;
  if (
    !Number.isSafeInteger(lifetimeSeconds)
    || lifetimeSeconds < 15
    || lifetimeSeconds > MAX_QR_LIFETIME_SECONDS
  ) {
    throw new Error('Ticket QR lifetime must be between 15 and 120 seconds.');
  }

  const payload: TicketQrPayload = {
    v: TICKET_QR_VERSION,
    ticketId: input.ticketId,
    eventId: input.eventId,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + lifetimeSeconds
  };
  const encodedPayload = encodePayload(payload);
  const signature = signPayload(encodedPayload, input.secret);

  return {
    token: `${encodedPayload}.${signature}`,
    expiresAt: new Date(payload.expiresAt * 1_000),
    payload
  };
}

export function verifyEventTicketQrToken(input: {
  token: string;
  eventId: string;
  secret: string;
  now?: Date;
}) {
  const token = input.token.trim();
  if (!token || token.length > 2_048 || !UUID_PATTERN.test(input.eventId)) return null;

  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expectedSignature = signPayload(parts[0], input.secret);
  const received = Buffer.from(parts[1], 'utf8');
  const expected = Buffer.from(expectedSignature, 'utf8');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const candidate = payload as Partial<TicketQrPayload>;
  if (
    candidate.v !== TICKET_QR_VERSION
    || typeof candidate.ticketId !== 'string'
    || !UUID_PATTERN.test(candidate.ticketId)
    || candidate.eventId !== input.eventId
    || !Number.isSafeInteger(candidate.issuedAt)
    || !Number.isSafeInteger(candidate.expiresAt)
  ) {
    return null;
  }

  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1_000);
  if (
    (candidate.issuedAt as number) > nowSeconds + 5
    || (candidate.expiresAt as number) <= nowSeconds
    || (candidate.expiresAt as number) - (candidate.issuedAt as number) > MAX_QR_LIFETIME_SECONDS
  ) {
    return null;
  }

  return candidate as TicketQrPayload;
}
