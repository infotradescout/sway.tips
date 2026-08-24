import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, asc, eq, or, sql } from 'drizzle-orm';
import type { SwayDb } from '../db/client';
import { accountDiscoveryAttributions, auditEvents } from '../db/schema';
import { discoveryEntityUuid, type DiscoveryLinkStrength } from './discovery-observatory';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_CLASSES = new Set(['organic_unpaid', 'paid', 'direct', 'referral', 'unknown']);
const EVIDENCE_STRENGTHS = new Set([
  'direct_server_observed',
  'client_correlated_unverified',
  'offline_self_reported',
  'unknown_unavailable'
]);
const ENTITY_KINDS = new Set(['performer', 'event', 'release', 'live_room']);
const PAID_MEDIUM_PATTERN = /(^|[_ .-])(cpc|ppc|paid|display|affiliate|sponsored)([_ .-]|$)/i;
const DISCOVERY_ATTRIBUTION_RECEIPT_VERSION = 1;

export const DISCOVERY_ATTRIBUTION_RECEIPT_COOKIE = 'sway_discovery_attribution';
export const DISCOVERY_ATTRIBUTION_RECEIPT_TTL_MS = 2 * 60 * 60 * 1000;

export type AcquisitionSourceClass = 'organic_unpaid' | 'paid' | 'direct' | 'referral' | 'unknown';
export type AttributionEvidenceStrength =
  | 'direct_server_observed'
  | 'client_correlated_unverified'
  | 'offline_self_reported'
  | 'unknown_unavailable';

export type ServerObservedAttributionEvidence = {
  source: string;
  sourceClass: AcquisitionSourceClass;
  claimedSourceClass: 'organic_unpaid' | 'paid' | null;
  linkStrength: DiscoveryLinkStrength;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  offlineSource: string | null;
  referrerHost: string | null;
  attributionReceipt: string | null;
  attributionReceiptId: string | null;
};

type DiscoveryAttributionReceiptPayload = {
  version: 1;
  receiptId: string;
  issuedAt: string;
  expiresAt: string;
  entryPath: string;
  source: string;
  sourceClass: AcquisitionSourceClass;
  claimedSourceClass: 'organic_unpaid' | 'paid';
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  referrerHost: string;
  navigationEvidence: 'header_observed_unverified';
};

function normalizeChannel(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!normalized) return 'unknown';
  if (normalized.includes('chatgpt') || normalized === 'openai' || normalized === 'chat.openai.com') return 'chatgpt';
  if (normalized.includes('google') || normalized === 'bing' || normalized === 'duckduckgo') return 'google';
  if (normalized.includes('facebook') || normalized === 'fb' || normalized === 'instagram' || normalized === 'meta') return 'facebook';
  if (normalized === 'referral' || normalized === 'friend' || normalized === 'word_of_mouth') return 'referral';
  if (normalized === 'existing' || normalized === 'existing_customer' || normalized === 'customer') return 'existing_customer';
  if (normalized === 'direct') return 'direct';
  if (normalized === 'other') return 'other';
  return 'unknown';
}

function sanitizeObservedValue(value: string | null, maxLength: number) {
  if (value === null) return null;
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > maxLength || /[?&#=]/.test(normalized)) return null;
  return normalized;
}

function fallbackAttributionEvidence(clientChannel: string | null | undefined): ServerObservedAttributionEvidence {
  return {
    source: normalizeChannel(clientChannel),
    sourceClass: 'unknown',
    claimedSourceClass: null,
    linkStrength: 'client_correlated_unverified',
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    offlineSource: null,
    referrerHost: null,
    attributionReceipt: null,
    attributionReceiptId: null
  };
}

export function resolveServerObservedAttributionEvidence(input: {
  landingUrl: string | null | undefined;
  allowedOrigins: string[];
  entryPath: string | null | undefined;
  clientChannel: string | null | undefined;
  referrer: string | null | undefined;
  fetchSite: string | null | undefined;
  fetchMode: string | null | undefined;
  fetchDest: string | null | undefined;
}): ServerObservedAttributionEvidence {
  const fallback = fallbackAttributionEvidence(input.clientChannel);
  if (!input.landingUrl || !input.entryPath) return fallback;

  let landingUrl: URL;
  try {
    landingUrl = new URL(input.landingUrl);
  } catch {
    return fallback;
  }
  const allowedOrigins = new Set(input.allowedOrigins.map((origin) => origin.trim().toLowerCase()).filter(Boolean));
  if (!allowedOrigins.has(landingUrl.origin.toLowerCase()) || landingUrl.pathname !== input.entryPath) return fallback;

  const trustedReferrer = resolveTrustedExternalReferrer(input.referrer);
  if (!trustedReferrer
    || input.fetchSite?.trim().toLowerCase() !== 'cross-site'
    || input.fetchMode?.trim().toLowerCase() !== 'navigate'
    || input.fetchDest?.trim().toLowerCase() !== 'document') {
    return fallback;
  }

  const rawUtmSource = landingUrl.searchParams.get('utm_source');
  const rawUtmMedium = landingUrl.searchParams.get('utm_medium');
  const rawUtmCampaign = landingUrl.searchParams.get('utm_campaign');
  const utmSource = sanitizeObservedValue(rawUtmSource, 100);
  const utmMedium = sanitizeObservedValue(rawUtmMedium, 100);
  const utmCampaign = sanitizeObservedValue(rawUtmCampaign, 160);
  if ((rawUtmSource && (!utmSource || normalizeChannel(utmSource) !== trustedReferrer.source))
    || (rawUtmMedium && !utmMedium)
    || (rawUtmCampaign && !utmCampaign)) return fallback;

  const source = trustedReferrer.source;
  // Provider-looking navigation headers are useful source context, but they
  // are not proof of origin: a non-browser HTTP client can forge them. Keep
  // the classification unknown until an independently verifiable provider
  // or campaign receipt exists.
  const sourceClass: AcquisitionSourceClass = 'unknown';
  const claimedSourceClass = PAID_MEDIUM_PATTERN.test(utmMedium ?? '') ? 'paid' : 'organic_unpaid';
  return {
    source,
    sourceClass,
    claimedSourceClass,
    linkStrength: 'client_correlated_unverified',
    utmSource,
    utmMedium,
    utmCampaign,
    offlineSource: null,
    referrerHost: trustedReferrer.host,
    attributionReceipt: null,
    attributionReceiptId: null
  };
}

function resolveTrustedExternalReferrer(referrer: string | null | undefined) {
  if (!referrer) return null;
  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const exactOrSubdomain = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (exactOrSubdomain('chatgpt.com') || host === 'chat.openai.com') {
    return { source: 'chatgpt', host } as const;
  }
  if (exactOrSubdomain('google.com')
    || /^(?:[a-z0-9-]+\.)*google\.(?:[a-z]{2,3}|com\.[a-z]{2})$/.test(host)
    || exactOrSubdomain('bing.com')
    || exactOrSubdomain('duckduckgo.com')) {
    return { source: 'google', host } as const;
  }
  if (exactOrSubdomain('facebook.com') || exactOrSubdomain('instagram.com')) {
    return { source: 'facebook', host } as const;
  }
  return null;
}

function validReceiptSecret(secret: string | null | undefined): secret is string {
  return typeof secret === 'string' && secret.trim().length >= 32;
}

function signReceiptBody(body: string, secret: string) {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

function signaturesMatch(received: string, expected: string) {
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer);
}

export function createDiscoveryAttributionReceipt(input: {
  landingUrl: string | null | undefined;
  allowedOrigins: string[];
  entryPath: string | null | undefined;
  secret: string | null | undefined;
  referrer: string | null | undefined;
  fetchSite: string | null | undefined;
  fetchMode: string | null | undefined;
  fetchDest: string | null | undefined;
  now?: Date;
}) {
  if (!validReceiptSecret(input.secret)) return null;
  const evidence = resolveServerObservedAttributionEvidence({
    landingUrl: input.landingUrl,
    allowedOrigins: input.allowedOrigins,
    entryPath: input.entryPath,
    clientChannel: null,
    referrer: input.referrer,
    fetchSite: input.fetchSite,
    fetchMode: input.fetchMode,
    fetchDest: input.fetchDest
  });
  if (evidence.source === 'unknown' || !evidence.claimedSourceClass || !evidence.referrerHost || !input.entryPath) return null;
  const issuedAt = input.now ?? new Date();
  const payload: DiscoveryAttributionReceiptPayload = {
    version: DISCOVERY_ATTRIBUTION_RECEIPT_VERSION,
    receiptId: randomUUID(),
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + DISCOVERY_ATTRIBUTION_RECEIPT_TTL_MS).toISOString(),
    entryPath: input.entryPath,
    source: evidence.source,
    sourceClass: evidence.sourceClass,
    claimedSourceClass: evidence.claimedSourceClass,
    utmSource: evidence.utmSource,
    utmMedium: evidence.utmMedium,
    utmCampaign: evidence.utmCampaign,
    referrerHost: evidence.referrerHost ?? '',
    navigationEvidence: 'header_observed_unverified'
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${signReceiptBody(body, input.secret.trim())}`;
}

function parseDiscoveryAttributionReceipt(input: {
  receipt: string | null | undefined;
  secret: string | null | undefined;
  entryPath: string | null | undefined;
  now: Date;
}): DiscoveryAttributionReceiptPayload | null {
  if (!input.receipt || !input.entryPath || !validReceiptSecret(input.secret)) return null;
  const [body, signature, extra] = input.receipt.split('.');
  if (!body || !signature || extra || !signaturesMatch(signature, signReceiptBody(body, input.secret.trim()))) return null;
  let payload: DiscoveryAttributionReceiptPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as DiscoveryAttributionReceiptPayload;
  } catch {
    return null;
  }
  const issuedAt = new Date(payload.issuedAt);
  const expiresAt = new Date(payload.expiresAt);
  if (payload.version !== DISCOVERY_ATTRIBUTION_RECEIPT_VERSION
    || !UUID_PATTERN.test(payload.receiptId)
    || payload.entryPath !== input.entryPath
    || !payload.entryPath.startsWith('/')
    || /[?#]/.test(payload.entryPath)
    || !SOURCE_CLASSES.has(payload.sourceClass)
    || payload.sourceClass !== 'unknown'
    || !['organic_unpaid', 'paid'].includes(payload.claimedSourceClass)
    || normalizeChannel(payload.source) !== payload.source
    || payload.source === 'unknown'
    || !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(payload.referrerHost)
    || payload.navigationEvidence !== 'header_observed_unverified'
    || Number.isNaN(issuedAt.getTime())
    || Number.isNaN(expiresAt.getTime())
    || issuedAt.getTime() > input.now.getTime() + 60_000
    || expiresAt.getTime() <= input.now.getTime()
    || expiresAt.getTime() - issuedAt.getTime() !== DISCOVERY_ATTRIBUTION_RECEIPT_TTL_MS) {
    return null;
  }
  return payload;
}

export function readDiscoveryAttributionReceiptCookie(cookieHeader: string | null | undefined) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== DISCOVERY_ATTRIBUTION_RECEIPT_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    return value || null;
  }
  return null;
}

export function resolveReceiptBackedAttributionEvidence(input: {
  receipt: string | null | undefined;
  secret: string | null | undefined;
  entryPath: string | null | undefined;
  clientChannel: string | null | undefined;
  now?: Date;
}): ServerObservedAttributionEvidence {
  const payload = parseDiscoveryAttributionReceipt({
    receipt: input.receipt,
    secret: input.secret,
    entryPath: input.entryPath,
    now: input.now ?? new Date()
  });
  if (!payload || !input.receipt) return fallbackAttributionEvidence(input.clientChannel);
  return {
    source: payload.source,
    sourceClass: payload.sourceClass,
    claimedSourceClass: payload.claimedSourceClass,
    linkStrength: 'client_correlated_unverified',
    utmSource: payload.utmSource,
    utmMedium: payload.utmMedium,
    utmCampaign: payload.utmCampaign,
    offlineSource: null,
    referrerHost: payload.referrerHost,
    attributionReceipt: input.receipt,
    attributionReceiptId: payload.receiptId
  };
}

function metadataObject(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function metadataText(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export function createAccountDiscoveryAttributionService(
  db: SwayDb,
  options: { receiptSecret?: string | null } = {}
) {
  async function linkFromJourney(input: { userId: string; journeyId: string }, now = new Date()) {
    if (!UUID_PATTERN.test(input.userId) || !UUID_PATTERN.test(input.journeyId)) {
      return { linked: false as const, reason: 'invalid_identifier' as const };
    }
    const journeyEntityId = discoveryEntityUuid(input.journeyId.toLowerCase());
    const [sourceEvent] = await db
      .select({
        eventId: auditEvents.eventId,
        metadata: auditEvents.metadata,
        createdAt: auditEvents.createdAt
      })
      .from(auditEvents)
      .where(and(
        eq(auditEvents.entityType, 'shell_friction'),
        eq(auditEvents.entityId, journeyEntityId),
        sql`${auditEvents.metadata}->>'stage' = 'entry'`
      ))
      .orderBy(
        sql`coalesce((${auditEvents.metadata}->>'occurred_at')::timestamptz, ${auditEvents.createdAt}) asc`,
        asc(auditEvents.createdAt),
        asc(auditEvents.eventId)
      )
      .limit(1);
    if (!sourceEvent) return { linked: false as const, reason: 'no_durable_entry' as const };

    const metadata = metadataObject(sourceEvent.metadata);
    if (!metadata) return { linked: false as const, reason: 'invalid_entry_evidence' as const };
    const sourceChannel = metadataText(metadata, 'source')?.toLowerCase() ?? 'unknown';
    const sourceClass = metadataText(metadata, 'source_class');
    const claimedSourceClass = metadataText(metadata, 'claimed_source_class');
    const evidenceStrength = metadataText(metadata, 'link_strength');
    const landingPath = metadataText(metadata, 'entry_path');
    const occurredAtValue = metadataText(metadata, 'occurred_at');
    const firstTouchAt = occurredAtValue ? new Date(occurredAtValue) : new Date(sourceEvent.createdAt);
    const entityKind = metadataText(metadata, 'entity_kind');
    const entityKey = metadataText(metadata, 'entity_key');
    const utmSource = metadataText(metadata, 'utm_source');
    const utmMedium = metadataText(metadata, 'utm_medium');
    const utmCampaign = metadataText(metadata, 'utm_campaign');
    const offlineSource = metadataText(metadata, 'offline_source');
    const referrerHost = metadataText(metadata, 'referrer_host');
    const attributionReceipt = metadataText(metadata, 'attribution_receipt');
    const attributionReceiptId = metadataText(metadata, 'attribution_receipt_id');

    if (!sourceClass || !SOURCE_CLASSES.has(sourceClass)
      || !evidenceStrength || !EVIDENCE_STRENGTHS.has(evidenceStrength)
      || !landingPath || !landingPath.startsWith('/') || /[?#]/.test(landingPath)
      || Number.isNaN(firstTouchAt.getTime()) || firstTouchAt.getTime() > now.getTime()
      || Boolean(entityKind) !== Boolean(entityKey)
      || (entityKind !== null && !ENTITY_KINDS.has(entityKind))) {
      return { linked: false as const, reason: 'invalid_entry_evidence' as const };
    }
    if (sourceClass === 'organic_unpaid'
      && (evidenceStrength !== 'direct_server_observed' || ['direct', 'unknown'].includes(sourceChannel))) {
      return { linked: false as const, reason: 'unverified_organic_evidence' as const };
    }
    if (Boolean(attributionReceipt) !== Boolean(attributionReceiptId)) {
      return { linked: false as const, reason: 'invalid_entry_evidence' as const };
    }
    if (attributionReceipt && attributionReceiptId) {
      const verifiedReceipt = resolveReceiptBackedAttributionEvidence({
        receipt: attributionReceipt,
        secret: options.receiptSecret,
        entryPath: landingPath,
        clientChannel: sourceChannel,
        now: firstTouchAt
      });
      if (verifiedReceipt.attributionReceiptId !== attributionReceiptId
        || verifiedReceipt.linkStrength !== evidenceStrength
        || verifiedReceipt.source !== sourceChannel
        || verifiedReceipt.sourceClass !== sourceClass
        || verifiedReceipt.claimedSourceClass !== claimedSourceClass
        || verifiedReceipt.utmSource !== utmSource
        || verifiedReceipt.utmMedium !== utmMedium
        || verifiedReceipt.utmCampaign !== utmCampaign
        || verifiedReceipt.referrerHost !== referrerHost) {
        return { linked: false as const, reason: 'unverified_server_evidence' as const };
      }
    }
    if (sourceClass === 'direct' && sourceChannel !== 'direct') {
      return { linked: false as const, reason: 'invalid_entry_evidence' as const };
    }
    if (evidenceStrength === 'unknown_unavailable' && sourceClass !== 'unknown') {
      return { linked: false as const, reason: 'invalid_entry_evidence' as const };
    }

    const inserted = await db
      .insert(accountDiscoveryAttributions)
      .values({
        userId: input.userId.toLowerCase(),
        sourceEventId: sourceEvent.eventId,
        journeyEntityId,
        sourceChannel,
        sourceClass: sourceClass as AcquisitionSourceClass,
        utmSource,
        utmMedium,
        utmCampaign,
        landingPath,
        entityKind,
        entityKey,
        offlineSource,
        firstTouchAt,
        linkedAt: now,
        evidenceStrength: evidenceStrength as AttributionEvidenceStrength,
        idempotencyKeyHash: sha256(`account-discovery:${input.userId.toLowerCase()}:${sourceEvent.eventId}`),
        createdAt: now
      })
      .onConflictDoNothing()
      .returning({ id: accountDiscoveryAttributions.id });
    if (inserted[0]) return { linked: true as const, attributionId: inserted[0].id };

    const existingRows = await db
      .select({ id: accountDiscoveryAttributions.id, journeyEntityId: accountDiscoveryAttributions.journeyEntityId })
      .from(accountDiscoveryAttributions)
      .where(or(
        eq(accountDiscoveryAttributions.userId, input.userId.toLowerCase()),
        eq(accountDiscoveryAttributions.journeyEntityId, journeyEntityId)
      ))
      .limit(2);
    const [sameUserRow] = await db
      .select({ id: accountDiscoveryAttributions.id })
      .from(accountDiscoveryAttributions)
      .where(and(
        eq(accountDiscoveryAttributions.userId, input.userId.toLowerCase()),
        eq(accountDiscoveryAttributions.journeyEntityId, journeyEntityId)
      ))
      .limit(1);
    if (sameUserRow) {
      return { linked: false as const, reason: 'already_linked' as const, attributionId: sameUserRow.id };
    }
    const existingConflict = existingRows[0];
    return {
      linked: false as const,
      reason: 'attribution_conflict' as const,
      ...(existingConflict ? { attributionId: existingConflict.id } : {})
    };
  }

  return { linkFromJourney };
}
