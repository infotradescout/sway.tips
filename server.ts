/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from "express";
import path from "path";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { execFileSync } from "child_process";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { readFileSync } from "fs";
import { existsSync } from "fs";
import sharp from "sharp";
import { and, asc, desc, eq, gt, ilike, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { ActiveRoomSummary, BackendState, RequestItem, GigSession, BoostContribution } from "./src/types";
import { createSwayDb } from "./src/db/client";
import { activeBlocks, activeRoomRegistry, gigAccessGrants, gigSessions, moderationEvents, performerLibrarySources, performerLibraryTracks, performerLoginChallenges, performerOnboardingStatusEnum, performerPartnerEntitlements, performerPartnerEntitlementStatusEvents, performerPartnerTermsAcceptances, performerProfileLinks, performerProfilePreviews, performerPublicProfiles, performerSetlistTracks, performerMemberships, performers, promotionCampaigns, proModeStatusEvents, userRoleEnum, users } from "./src/db/schema";
import { createAccessControl, routeFamilyGuard } from "./src/server/access-control";
import { createIdempotencyStore, type DurableActionInput, type DurableActorActionInput } from "./src/server/idempotency-store";
import { createModerationService, type BlockScope } from "./src/server/moderation-service";
import { createBusinessStore } from "./src/server/business-store";
import { toAuditEntityUuid, writeAuditEvent } from "./src/server/audit-log";
import { createConfiguredPaymentProvider } from "./src/server/payment-provider";
import { createPaymentService } from "./src/server/payment-service";
import { resolveProposedPlatformFee } from "./src/server/fee-policy";
import { createPaymentWebhookService } from "./src/server/payment-webhook";
import { verifyPerformerBootstrapToken } from "./src/server/performer-bootstrap";
import { createPerformerSessionStore } from "./src/server/performer-session-store";
import { applyProModeTransition, getProModeStatus, type ProModeTransitionResult } from "./src/server/pro-mode";
import {
  createPerformerLoginChallengeStore,
  createPerformerLoginRateLimiter,
  hashPerformerLoginRequesterIp,
  normalizePerformerDisplayName,
  normalizePerformerLoginEmail,
  normalizePerformerHandle,
  normalizePerformerPhone,
  PERFORMER_LOGIN_CHALLENGE_TYPE_ACCOUNT_INVITE,
  PERFORMER_LOGIN_CHALLENGE_TYPE_CLAIM_CODE,
  PERFORMER_LOGIN_CHALLENGE_TYPE_LOGIN,
  PERFORMER_LOGIN_CHALLENGE_TYPE_PASSWORD_RESET,
  PERFORMER_LOGIN_CHALLENGE_TYPE_VERIFY_EMAIL,
  PERFORMER_LOGIN_SUCCESS_COPY,
  PERFORMER_SIGNUP_SUCCESS_COPY,
  resolvePerformerLoginRedirectPath
} from "./src/server/performer-login";
import { createPerformerLoginMailer, resolvePerformerLoginBaseUrl } from "./src/server/performer-login-mailer";
import {
  createPerformerPasswordLoginRateLimiter,
  hashPerformerPassword,
  normalizePerformerPassword,
  validatePerformerPasswordStrength,
  verifyPerformerPassword
} from "./src/server/performer-password-auth";
import { getMusicSourceCapabilityCatalog } from "./src/server/music-source-capabilities";
import { importSpotifyPlaylist, isCatalogSearchConfigured, searchCatalog } from "./src/server/spotify-catalog";
import { createConfiguredStripeConnectService } from "./src/server/stripe-connect";
import { lookupLyrics } from "./src/server/lyrics-provider";
import {
  escapePublicProfileMetadataAttribute,
  normalizePublicProfileEmail,
  normalizePublicProfileFeaturedMedia,
  normalizePublicProfileLinks,
  normalizePublicProfilePhone,
  normalizePublicProfileSpecialties,
  normalizePublicProfileText,
  normalizePublicProfileUrl,
  resolveVerifiedPublicBookingContact
} from "./src/server/public-profile";
import { buildSwayPartnerTermsSnapshot, SWAY_PARTNER_TERMS_HASH, SWAY_PARTNER_TERMS_TEXT, SWAY_PARTNER_TERMS_VERSION } from "./src/server/partner-entitlement";
import { loadPartnerEntitlementStateForPerformer } from "./src/server/partner-entitlement-store";
import {
  issuePatronStatusReceipt,
  matchesPatronStatusReceipt,
  projectPatronRequestStatus
} from "./src/server/patron-status-receipt";
import {
  projectPublicRoomState,
  sanitizePatronMutationResponseBody
} from "./src/server/public-room-state";
import { createConfiguredAudioObjectStore } from "./src/server/audio-object-storage";
import { createAudioPublishingService } from "./src/server/audio-publishing-service";
import { AUDIO_PUBLISHING_RUNTIME_CAPABILITIES } from "./src/server/audio-publishing-contract";

dotenv.config({ path: ".env.local", override: false });
dotenv.config({ override: false });

const app = express();
const PORT = Number(process.env.PORT ?? 3000);
const isProduction = process.env.NODE_ENV === "production";
const hasSwayEmailProvider = Boolean(process.env.SWAY_EMAIL_PROVIDER?.trim());
const hasSwayEmailApiKey = Boolean(process.env.SWAY_EMAIL_API_KEY?.trim());
const hasSwayEmailFrom = Boolean(process.env.SWAY_EMAIL_FROM?.trim());
// resolvePerformerLoginBaseUrl (performer-login-mailer.ts) already falls back
// to the hardcoded 'https://app.sway.tips' in production when neither env var
// is set -- so an explicit override isn't actually required there, only in
// non-production where there's no safe default to assume.
const hasSwayEmailBaseUrl = Boolean(process.env.SWAY_APP_BASE_URL?.trim() || process.env.APP_URL?.trim() || isProduction);
const hasPerformerLoginEmailConfig = Boolean(
  hasSwayEmailProvider
  && hasSwayEmailApiKey
  && hasSwayEmailFrom
  && hasSwayEmailBaseUrl
);
const IDEMPOTENCY_TTL_HOURS = 48;
const MAX_REQUESTS_PER_DEVICE_PER_SESSION = 8;
const MAX_CUSTOM_NOTES_PER_DEVICE_PER_SESSION = 4;
const MAX_BOOSTS_PER_DEVICE_PER_SESSION = 12;
const accessControl = createAccessControl({
  databaseUrl: process.env.DATABASE_URL,
  isProduction
});
const idempotencyStore = createIdempotencyStore(process.env.DATABASE_URL);
const moderationService = createModerationService(process.env.DATABASE_URL);
const businessStore = createBusinessStore(process.env.DATABASE_URL, createInactiveSession);
const businessDb = process.env.DATABASE_URL ? createSwayDb(process.env.DATABASE_URL) : null;
const audioObjectStore = (() => {
  try {
    return createConfiguredAudioObjectStore(process.env);
  } catch (error) {
    if (process.env.SWAY_AUDIO_STORAGE_PROVIDER?.trim()) {
      console.error('[sway.audio] storage config rejected:', error instanceof Error ? error.message : error);
    }
    return null;
  }
})();
const audioPublishingService = businessDb && audioObjectStore
  ? createAudioPublishingService({ db: businessDb, store: audioObjectStore })
  : null;
const performerSessionStore = createPerformerSessionStore({
  databaseUrl: process.env.DATABASE_URL,
  dbOverride: businessDb
});
const performerLoginChallengeStore = createPerformerLoginChallengeStore({
  databaseUrl: process.env.DATABASE_URL,
  dbOverride: businessDb
});
const performerLoginRateLimiter = createPerformerLoginRateLimiter();
const performerSignupRateLimiter = createPerformerLoginRateLimiter({
  maxRequests: parsePositiveInteger(process.env.SWAY_PERFORMER_SIGNUP_RATE_LIMIT_MAX, 3),
  windowMs: parsePositiveInteger(process.env.SWAY_PERFORMER_SIGNUP_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000)
});
const performerPasswordLoginRateLimiter = createPerformerPasswordLoginRateLimiter();
const hasAdminBootstrapSecret = Boolean(process.env.SWAY_ADMIN_BOOTSTRAP_SECRET?.trim());
const adminBootstrapRateLimiter = createPerformerLoginRateLimiter({
  maxRequests: parsePositiveInteger(process.env.SWAY_ADMIN_BOOTSTRAP_RATE_LIMIT_MAX, 3),
  windowMs: parsePositiveInteger(process.env.SWAY_ADMIN_BOOTSTRAP_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000)
});
const adminPasswordLoginRateLimiter = createPerformerPasswordLoginRateLimiter({
  maxFailures: parsePositiveInteger(process.env.SWAY_ADMIN_PASSWORD_LOGIN_RATE_LIMIT_MAX, 5),
  windowMs: parsePositiveInteger(process.env.SWAY_ADMIN_PASSWORD_LOGIN_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000)
});
const performerLoginMailer = createPerformerLoginMailer({
  env: process.env,
  isProduction
});
const paymentProvider = createConfiguredPaymentProvider(process.env);
const paymentService = createPaymentService({
  databaseUrl: process.env.DATABASE_URL,
  provider: paymentProvider
});
const paymentWebhookService = paymentProvider
  ? createPaymentWebhookService({ databaseUrl: process.env.DATABASE_URL, provider: paymentProvider })
  : null;
const stripeConnectService = createConfiguredStripeConnectService(process.env);

function resolveGitValue(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim() || null;
  } catch {
    return null;
  }
}

function applyNoStoreHeaders(res: express.Response) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
}

function parsePositiveInteger(rawValue: string | undefined, fallbackValue: number) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackValue;
  }
  return Math.floor(parsed);
}

const buildMarker = {
  service: 'sway.tips',
  commit: process.env.RENDER_GIT_COMMIT
    ?? process.env.COMMIT_SHA
    ?? process.env.GIT_COMMIT
    ?? resolveGitValue(['rev-parse', 'HEAD'])
    ?? 'unknown',
  branch: process.env.RENDER_GIT_BRANCH
    ?? process.env.GITHUB_REF_NAME
    ?? process.env.VERCEL_GIT_COMMIT_REF
    ?? process.env.GIT_BRANCH
    ?? resolveGitValue(['rev-parse', '--abbrev-ref', 'HEAD'])
    ?? 'unknown',
  buildTimestamp: process.env.SWAY_BUILD_TIMESTAMP
    ?? process.env.RENDER_BUILD_CREATED_AT
    ?? process.env.BUILD_TIMESTAMP
    ?? new Date().toISOString(),
  nodeEnv: process.env.NODE_ENV ?? 'unknown'
};

const ROOM_LOOKUP_UNAVAILABLE_COPY = 'Live room unavailable. Scan the performer QR again or request a fresh room link.';
const ROOM_LOOKUP_ENDED_COPY = 'This live room session has ended. Thank you for supporting the performer!';

// Capture the raw request body so Stripe webhook signatures can be verified.
app.use(express.json({
  verify: (req, _res, buf) => {
    (req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf8');
  }
}));

app.use(async (req, _res, next) => {
  try {
    await accessControl.hydrateRequestActor(req);
    next();
  } catch (error) {
    next(error);
  }
});

app.use((_req, res, next) => {
  res.setHeader('x-sway-build', `${buildMarker.commit}:${buildMarker.buildTimestamp}`);
  res.setHeader('x-commit-sha', buildMarker.commit);
  next();
});

type SwayShell = 'public' | 'patron' | 'talent' | 'overlay' | 'admin' | 'dev-sandbox';

function normalizeHost(rawHost: string | undefined): string {
  if (!rawHost) return '';
  return rawHost.split(':')[0].trim().toLowerCase();
}

const CANONICAL_APP_HOST = 'app.sway.tips';
const CANONICAL_APP_ORIGIN = `https://${CANONICAL_APP_HOST}`;
const SHARE_REDIRECT_HOSTS = new Set(['sway.tips', 'www.sway.tips']);

function shouldRedirectToAppHost(rawHost: string | undefined) {
  return SHARE_REDIRECT_HOSTS.has(normalizeHost(rawHost));
}

function buildAppHostRedirectUrl(originalUrl: string) {
  const pathAndQuery = originalUrl.startsWith('/') ? originalUrl : `/${originalUrl}`;
  return `${CANONICAL_APP_ORIGIN}${pathAndQuery}`;
}

function resolveShellForRoute(urlPath: string, _rawHost?: string): SwayShell {
  if (urlPath === '/') return 'public';
  if (urlPath === '/home') return 'patron';
  if (urlPath.startsWith('/talent')) return 'talent';
  if (urlPath.startsWith('/overlay')) return 'overlay';
  if (urlPath.startsWith('/admin')) return 'admin';
  if (urlPath === '/dev/sandbox' || urlPath.startsWith('/dev-sandbox')) return 'dev-sandbox';
  if (urlPath.startsWith('/g/') || urlPath.startsWith('/p/')) return 'patron';
  return 'patron';
}

function shellHtmlRelativePath(shell: SwayShell): string {
  return `shells/${shell}.html`;
}

function isShellAllowed(shell: SwayShell): boolean {
  return !(isProduction && shell === 'dev-sandbox');
}

type ShareMetadata = {
  title: string;
  description: string;
  url: string;
  image: string;
  imageAlt: string;
};

type PublicShareProfile = {
  displayName: string;
  handle: string;
  bio: string | null;
  headline: string | null;
  city: string | null;
  avatarUrl: string | null;
};

const DEFAULT_SHARE_TITLE = 'Sway | Live Crowd Requests';
const DEFAULT_SHARE_DESCRIPTION = 'Scan into a live Sway room to request, tip, boost, and follow the queue in real time.';
const DEFAULT_SHARE_IMAGE_PATH = '/social-preview.png?v=1';
const DEFAULT_SHARE_IMAGE_WIDTH = 1672;
const DEFAULT_SHARE_IMAGE_HEIGHT = 941;

function resolveRequestOrigin(req: express.Request) {
  const configuredBaseUrl = (process.env.SWAY_APP_BASE_URL || process.env.APP_BASE_URL || '').trim().replace(/\/+$/, '');
  if (configuredBaseUrl) return configuredBaseUrl;

  const forwardedProto = typeof req.headers['x-forwarded-proto'] === 'string'
    ? req.headers['x-forwarded-proto'].split(',')[0]?.trim()
    : '';
  const proto = forwardedProto || req.protocol || 'https';
  const host = typeof req.headers.host === 'string' && req.headers.host.trim()
    ? req.headers.host.trim()
    : CANONICAL_APP_HOST;
  return `${proto}://${host}`;
}

function absoluteShareUrl(req: express.Request, pathOrUrl: string) {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const pathAndQuery = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
  return `${resolveRequestOrigin(req)}${pathAndQuery}`;
}

function defaultShareMetadata(req: express.Request, overrides: Partial<Omit<ShareMetadata, 'url' | 'image'>> & { url?: string; image?: string } = {}): ShareMetadata {
  return {
    title: overrides.title || DEFAULT_SHARE_TITLE,
    description: overrides.description || DEFAULT_SHARE_DESCRIPTION,
    url: absoluteShareUrl(req, overrides.url || req.originalUrl || '/'),
    image: absoluteShareUrl(req, overrides.image || DEFAULT_SHARE_IMAGE_PATH),
    imageAlt: overrides.imageAlt || 'Sway neon live request preview'
  };
}

function renderShareMetaTags(metadata: ShareMetadata) {
  const title = escapePublicProfileMetadataAttribute(metadata.title);
  const description = escapePublicProfileMetadataAttribute(metadata.description);
  const url = escapePublicProfileMetadataAttribute(metadata.url);
  const image = escapePublicProfileMetadataAttribute(metadata.image);
  const imageAlt = escapePublicProfileMetadataAttribute(metadata.imageAlt);

  return [
    '<meta name="sway-share-meta" content="server-rendered" />',
    `<title>${title}</title>`,
    `<meta name="description" content="${description}" />`,
    '<meta property="og:type" content="website" />',
    '<meta property="og:site_name" content="Sway" />',
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:image" content="${image}" />`,
    `<meta property="og:image:secure_url" content="${image}" />`,
    '<meta property="og:image:type" content="image/png" />',
    `<meta property="og:image:width" content="${DEFAULT_SHARE_IMAGE_WIDTH}" />`,
    `<meta property="og:image:height" content="${DEFAULT_SHARE_IMAGE_HEIGHT}" />`,
    `<meta property="og:image:alt" content="${imageAlt}" />`,
    '<meta name="twitter:card" content="summary_large_image" />',
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${description}" />`,
    `<meta name="twitter:image" content="${image}" />`
  ].join('\n    ');
}

function injectShareMetadata(html: string, metadata: ShareMetadata) {
  const metaTags = renderShareMetaTags(metadata);
  const withoutExisting = html
    .replace(/\s*<title>[\s\S]*?<\/title>/i, '')
    .replace(/\s*<meta\s+(?:name|property)=["'](?:description|og:[^"']+|twitter:[^"']+|sway-share-meta)["'][^>]*>/gi, '');

  return withoutExisting.replace('</head>', `    ${metaTags}\n  </head>`);
}

async function findPublicShareProfile(rawHandle: string): Promise<PublicShareProfile | null> {
  const normalizedHandle = normalizePerformerHandle(rawHandle);
  if (!normalizedHandle || !businessDb) return null;

  const [profile] = await businessDb
    .select({
      displayName: performers.displayName,
      handle: performers.handle,
      bio: performers.bio,
      headline: performerPublicProfiles.headline,
      city: performerPublicProfiles.city,
      avatarUrl: performerPublicProfiles.avatarUrl
    })
    .from(performers)
    .leftJoin(performerPublicProfiles, eq(performerPublicProfiles.performerId, performers.id))
    .where(and(
      sql`lower(${performers.handle}) = ${normalizedHandle.toLowerCase()}`,
      eq(performers.isActive, true),
      notInArray(performers.onboardingStatus, ['suspended'])
    ))
    .limit(1);

  if (profile) return profile;

  const [existingPerformer] = await businessDb
    .select({ id: performers.id })
    .from(performers)
    .where(sql`lower(${performers.handle}) = ${normalizedHandle.toLowerCase()}`)
    .limit(1);
  if (existingPerformer) return null;

  const [preview] = await businessDb
    .select({
      displayName: performerProfilePreviews.displayName,
      handle: performerProfilePreviews.handle,
      bio: performerProfilePreviews.bio,
      headline: performerProfilePreviews.headline,
      city: performerProfilePreviews.city,
      avatarUrl: performerProfilePreviews.avatarUrl
    })
    .from(performerProfilePreviews)
    .where(and(
      sql`lower(${performerProfilePreviews.handle}) = ${normalizedHandle.toLowerCase()}`,
      eq(performerProfilePreviews.isActive, true)
    ))
    .limit(1);

  return preview || null;
}

function escapeShareCardText(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wrapShareCardText(value: string, maxCharacters = 34) {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  for (const word of words) {
    const current = lines[lines.length - 1] || '';
    const candidate = current ? `${current} ${word}` : word;
    if (!current || candidate.length <= maxCharacters) {
      if (!current) lines.push(word);
      else lines[lines.length - 1] = candidate;
    } else if (lines.length < 2) {
      lines.push(word);
    } else {
      lines[lines.length - 1] = `${current.replace(/[.\u2026]+$/, '')}…`;
      break;
    }
  }
  return lines.slice(0, 2);
}

async function readShareCardAvatar(avatarUrl: string | null): Promise<Buffer | null> {
  const safeUrl = normalizePublicProfileUrl(avatarUrl);
  if (!safeUrl) return null;

  const parsed = new URL(safeUrl);
  if (['sway.tips', 'www.sway.tips', 'app.sway.tips'].includes(parsed.hostname) && parsed.pathname.startsWith('/assets/')) {
    const assetName = path.basename(parsed.pathname);
    for (const root of [path.join(process.cwd(), 'dist', 'assets'), path.join(process.cwd(), 'public', 'assets')]) {
      const candidate = path.join(root, assetName);
      if (existsSync(candidate)) return readFileSync(candidate);
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetch(safeUrl, { signal: controller.signal });
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function renderPerformerShareCard(profile: PublicShareProfile) {
  const width = DEFAULT_SHARE_IMAGE_WIDTH;
  const height = DEFAULT_SHARE_IMAGE_HEIGHT;
  const backgroundPath = [
    path.join(process.cwd(), 'dist', 'social-preview.png'),
    path.join(process.cwd(), 'public', 'social-preview.png')
  ].find((candidate) => existsSync(candidate));
  if (!backgroundPath) throw new Error('Sway share-card background is unavailable.');

  const headline = profile.headline || profile.bio || `Discover @${profile.handle} on Sway.`;
  const headlineLines = wrapShareCardText(headline);
  const nameFontSize = profile.displayName.length > 25 ? 60 : profile.displayName.length > 18 ? 74 : 92;
  const overlay = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="shade" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#03030a" stop-opacity="0.96"/>
        <stop offset="0.52" stop-color="#08051b" stop-opacity="0.86"/>
        <stop offset="1" stop-color="#03030a" stop-opacity="0.48"/>
      </linearGradient>
      <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#ff20d6"/><stop offset="1" stop-color="#27c8ff"/>
      </linearGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#shade)"/>
    <rect x="92" y="105" width="104" height="7" rx="3.5" fill="url(#accent)"/>
    <text x="92" y="170" fill="#f4a6ff" font-family="Arial, Helvetica, sans-serif" font-size="30" font-weight="700" letter-spacing="4">SWAY • PERFORMER PROFILE</text>
    <text x="92" y="340" fill="#ffffff" font-family="Arial, Helvetica, sans-serif" font-size="${nameFontSize}" font-weight="800">${escapeShareCardText(profile.displayName)}</text>
    <text x="96" y="402" fill="#55d9ff" font-family="Arial, Helvetica, sans-serif" font-size="36" font-weight="700">@${escapeShareCardText(profile.handle)}</text>
    ${headlineLines.map((line, index) => `<text x="96" y="${510 + index * 58}" fill="#e6e8f5" font-family="Arial, Helvetica, sans-serif" font-size="39" font-weight="500">${escapeShareCardText(line)}</text>`).join('')}
    <text x="96" y="800" fill="#ffffff" font-family="Arial, Helvetica, sans-serif" font-size="30" font-weight="700">sway to play</text>
    <text x="96" y="846" fill="#aab0c8" font-family="Arial, Helvetica, sans-serif" font-size="25">app.sway.tips/${escapeShareCardText(profile.handle)}</text>
  </svg>`);

  const composites: Array<{ input: Buffer; top: number; left: number }> = [{ input: overlay, top: 0, left: 0 }];
  const avatar = await readShareCardAvatar(profile.avatarUrl);
  if (avatar) {
    const size = 650;
    const roundedMask = Buffer.from(`<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><rect width="${size}" height="${size}" rx="72" fill="#fff"/></svg>`);
    const framedAvatar = await sharp(avatar)
      .resize(size, size, { fit: 'cover', position: 'attention' })
      .ensureAlpha()
      .composite([{ input: roundedMask, blend: 'dest-in' }])
      .png()
      .toBuffer();
    composites.push({ input: framedAvatar, top: 145, left: 930 });
  }

  return sharp(backgroundPath)
    .resize(width, height, { fit: 'cover' })
    .composite(composites)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function resolveShareMetadata(req: express.Request): Promise<ShareMetadata> {
  const pathParts = req.path.split('/').filter(Boolean);
  const defaultMetadata = defaultShareMetadata(req);

  if (!businessDb) return defaultMetadata;

  if (pathParts[0] === 'p' && pathParts[1]) {
    const normalizedHandle = normalizePerformerHandle(pathParts[1]);
    if (!normalizedHandle) return defaultMetadata;

    const profile = await findPublicShareProfile(normalizedHandle);

    if (!profile) return defaultMetadata;

    const title = `${profile.displayName} on Sway`;
    const handleCopy = profile.handle ? `@${profile.handle}` : 'this performer';
    const locationCopy = profile.city ? ` in ${profile.city}` : '';
    const description = profile.headline || profile.bio || `Explore ${handleCopy}${locationCopy} on Sway for public links, booking details, and live rooms.`;

    return defaultShareMetadata(req, {
      title,
      description,
      url: `/p/${profile.handle}`,
      image: `/api/public/performer/${encodeURIComponent(profile.handle)}/share-card.png?v=1`,
      imageAlt: `${profile.displayName} Sway performer profile`
    });
  }

  if (pathParts[0] === 'g' && pathParts[1] && UUID_PATTERN.test(pathParts[1])) {
    const [room] = await businessDb
      .select({
        talentName: activeRoomRegistry.talentName,
        talentRole: activeRoomRegistry.talentRole,
        routePath: activeRoomRegistry.routePath,
        registryStatus: activeRoomRegistry.registryStatus,
        performerName: performers.displayName,
        headline: performerPublicProfiles.headline,
        avatarUrl: performerPublicProfiles.avatarUrl
      })
      .from(activeRoomRegistry)
      .innerJoin(performers, eq(performers.id, activeRoomRegistry.performerId))
      .leftJoin(performerPublicProfiles, eq(performerPublicProfiles.performerId, performers.id))
      .where(and(
        eq(activeRoomRegistry.gigId, pathParts[1]),
        inArray(activeRoomRegistry.registryStatus, ['active', 'ending']),
        eq(performers.isActive, true),
        notInArray(performers.onboardingStatus, ['suspended'])
      ))
      .limit(1);

    if (!room) return defaultMetadata;

    const performerName = room.talentName || room.performerName || 'this performer';
    const title = `Join ${performerName}'s Sway room`;
    const statusCopy = room.registryStatus === 'ending'
      ? 'The live room is wrapping up.'
      : 'The live room is open.';
    const description = room.headline || `${statusCopy} Send requests, tips, boosts, and follow the queue in real time.`;

    return defaultShareMetadata(req, {
      title,
      description,
      url: room.routePath || req.originalUrl,
      image: normalizePublicProfileUrl(room.avatarUrl) || DEFAULT_SHARE_IMAGE_PATH,
      imageAlt: `${performerName} Sway live room`
    });
  }

  return defaultMetadata;
}

function renderStaticDocument(title: string, description: string, bodyHtml: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <meta name="description" content="${description}" />
    <style>
      :root {
        color-scheme: dark;
        --bg: #06070b;
        --panel: #11141b;
        --line: rgba(255, 255, 255, 0.10);
        --text: #f5f7ff;
        --muted: #a1a8bb;
        --accent: #35d59a;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: "Space Grotesk", "Segoe UI", system-ui, sans-serif;
        color: var(--text);
        background:
          radial-gradient(720px 420px at 20% -10%, rgba(53, 213, 154, 0.18), transparent 60%),
          radial-gradient(720px 420px at 90% 0%, rgba(124, 92, 255, 0.18), transparent 58%),
          var(--bg);
      }
      main {
        width: min(860px, calc(100% - 32px));
        margin: 0 auto;
        padding: 40px 0 72px;
      }
      .eyebrow {
        display: inline-flex;
        padding: 6px 10px;
        border-radius: 999px;
        border: 1px solid var(--line);
        color: var(--accent);
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      h1 {
        margin: 16px 0 10px;
        font-size: clamp(34px, 7vw, 56px);
        line-height: 1;
      }
      .lede {
        margin: 0 0 22px;
        color: var(--muted);
        font-size: 16px;
        line-height: 1.6;
      }
      .panel {
        padding: 24px;
        border-radius: 18px;
        border: 1px solid var(--line);
        background: rgba(17, 20, 27, 0.9);
      }
      h2 {
        margin: 24px 0 10px;
        font-size: 18px;
      }
      p, li {
        color: var(--muted);
        font-size: 15px;
        line-height: 1.7;
      }
      ul {
        margin: 0;
        padding-left: 20px;
      }
      a {
        color: #9fe8cb;
      }
      .nav {
        margin-top: 24px;
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
    </style>
  </head>
  <body>
    <main>
      <span class="eyebrow">Sway trust center</span>
      <h1>${title}</h1>
      <p class="lede">${description}</p>
      <section class="panel">
        ${bodyHtml}
        <div class="nav">
          <a href="/privacy">Privacy Policy</a>
          <a href="/terms">Terms</a>
          <a href="/support">Support</a>
          <a href="/privacy/data-deletion">Data deletion</a>
          <a href="/legal/payments">Payment terms</a>
          <a href="/legal/payouts">Payout terms</a>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

const supportPageHtml = renderStaticDocument(
  'Sway Support',
  'How to reach Sway support, report a problem, and request safety or account help.',
  `
    <p>Sway support is for safety issues, payment issues, performer account problems, and live-room failures.</p>
    <h2>Use Sway support for</h2>
    <ul>
      <li>reporting harassment, unsafe behavior, or abusive requests</li>
      <li>requesting help with a performer account or live room</li>
      <li>questioning a payment, refund, or missing request status</li>
      <li>starting a data deletion request</li>
    </ul>
    <h2>Current contact path</h2>
    <p>Use the in-app safety controls first when they are available. If you cannot access the app, use the published support route from this page and the data deletion route below.</p>
    <p>Support and review teams should verify the linked policies and live backend status before launch claims are made.</p>
  `
);

const faqPageHtml = renderStaticDocument(
  'Sway FAQ',
  'Quick answers, official links, and current support paths for Sway performers and audiences.',
  `
    <p>Sway lets audiences scan into a live room, send requests, and support performers while the performer keeps control of the queue.</p>
    <h2>How do I join a live room?</h2>
    <p>Use <a href="/home">SCAN</a> from the public landing page or scan a performer’s Sway QR code at the venue.</p>
    <h2>How do performers get started?</h2>
    <p>Use <a href="/talent/signup">Create account</a> to start a performer account, or <a href="/talent/login">Login</a> if you already have access.</p>
    <h2>Are paid requests guaranteed to play?</h2>
    <p>No. A paid request is a submission for performer review. Performers control approvals, denials, queue order, and fulfillment. Payment behavior must match backend confirmation and processor state.</p>
    <h2>Official links</h2>
    <ul>
      <li><a href="/">Sway public home</a></li>
      <li><a href="/home">Audience scan entry</a></li>
      <li><a href="/talent/signup">Create performer account</a></li>
      <li><a href="/talent/login">Performer login</a></li>
      <li><a href="/support">Support</a></li>
      <li><a href="/privacy">Privacy</a></li>
      <li><a href="/terms">Terms</a></li>
      <li><a href="/legal/payments">Payment terms</a></li>
      <li><a href="/legal/payouts">Payout terms</a></li>
      <li><a href="/privacy/data-deletion">Data deletion</a></li>
    </ul>
    <h2>Social links</h2>
    <p>Approved social profile URLs are not configured in this repository yet. When the official Sway social links are approved, this page is the public place to add them.</p>
  `
);

const privacyPageHtml = renderStaticDocument(
  'Sway Privacy Policy',
  'What Sway stores for performer accounts, live-room requests, payments, moderation, and support workflows.',
  `
    <p>Sway processes performer account data, live-room request data, payment-related records, moderation records, and support/deletion requests so the service can run and be audited.</p>
    <h2>Data Sway may store</h2>
    <ul>
      <li>performer account profile and login records</li>
      <li>live-room session, queue, request, tip, and boost records</li>
      <li>payment processor identifiers and related lifecycle status</li>
      <li>moderation reports, blocks, and audit events</li>
      <li>support and data deletion request metadata</li>
      <li>limited device, route, and friction telemetry needed to keep the service working</li>
    </ul>
    <h2>Third-party services</h2>
    <p>Sway may rely on payment, email, hosting, and database providers when configured. Those providers may process information required to deliver the service.</p>
    <h2>Deletion requests</h2>
    <p>Use <a href="/privacy/data-deletion">the data deletion page</a> or submit the API request path from inside the app. Sway may retain records that must be preserved for payments, fraud prevention, disputes, moderation, legal obligations, or audit history.</p>
  `
);

const termsPageHtml = renderStaticDocument(
  'Sway Terms',
  'Core rules for live performer rooms, paid requests, tips, refunds, and account use.',
  `
    <p>Sway is a live-event request and tipping platform. Patrons use Sway to support real-world performers and DJs during live sessions.</p>
    <h2>Service rules</h2>
    <ul>
      <li>a paid request is a paid submission for performer review, not a guaranteed performance</li>
      <li>performers control queue order, approval, denial, and fulfillment decisions</li>
      <li>tips and support payments may be voluntary even when no song is approved</li>
      <li>abuse, fraud, harassment, and attempts to bypass safety controls may result in blocks or account action</li>
    </ul>
    <h2>Money terms</h2>
    <p>Payment, refund, and payout behavior must match the live backend and processor state exactly. See the dedicated payment and payout terms below for the current operating rules.</p>
  `
);

const paymentTermsPageHtml = renderStaticDocument(
  'Sway Payment And Refund Terms',
  'How request, tip, boost, capture, void, and refund outcomes are represented in Sway.',
  `
    <p>Sway must only describe payment behavior that is actually implemented by the backend and processor configuration.</p>
    <ul>
      <li>request, tip, and boost submissions create payment-related records tied to the live room and request lifecycle</li>
      <li>a denied or unresolved request may be voided or refunded according to the implemented lifecycle</li>
      <li>payment success is not final until backend confirmation is recorded</li>
      <li>processor timelines, disputes, and refunds may affect final settlement timing</li>
    </ul>
    <p>If a patron needs help with a charge or refund outcome, use <a href="/support">Sway support</a>.</p>
  `
);

const payoutTermsPageHtml = renderStaticDocument(
  'Sway Performer Payout Terms',
  'How performer payout eligibility and verification constraints work in Sway.',
  `
    <p>Sway must not promise payouts before required verification and payout enablement are complete.</p>
    <ul>
      <li>performer payout access may require identity, tax, banking, or other verification steps</li>
      <li>processor rules, disputes, reserve periods, and compliance reviews may delay payout timing</li>
      <li>unverified performers must not be shown payout promises that the processor cannot support</li>
    </ul>
    <p>Current payout terms must stay aligned with the configured payment provider and KYC state.</p>
  `
);

const dataDeletionPageHtml = renderStaticDocument(
  'Sway Data Deletion',
  'How to request deletion of account or support-related data from Sway.',
  `
    <p>You can request deletion from inside the app or by posting to Sway’s data deletion API route.</p>
    <h2>What to include</h2>
    <ul>
      <li>your contact email if you want a follow-up</li>
      <li>whether you are a patron or performer</li>
      <li>what account, room, or request you want reviewed</li>
    </ul>
    <h2>API path</h2>
    <p>POST <code>/api/privacy/data-deletion</code> with JSON such as <code>{ "email": "you@example.com", "details": "Delete my account data." }</code>.</p>
    <p>Sway may keep records that must remain for payments, disputes, moderation, security, or legal obligations.</p>
  `
);

app.use((req, res, next) => {
  if (shouldRedirectToAppHost(typeof req.headers.host === 'string' ? req.headers.host : undefined)) {
    res.redirect(308, buildAppHostRedirectUrl(req.originalUrl));
    return;
  }
  req.headers['x-sway-shell'] = resolveShellForRoute(req.path, typeof req.headers.host === 'string' ? req.headers.host : undefined);
  next();
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/assets') || req.path.startsWith('/shells')) {
    next();
    return;
  }
  routeFamilyGuard(accessControl)(req, res, next);
});

const systemRequestPresets = [
  { id: "p-sys-15", label: "Speed Round", duration: 15, isSystem: true },
  { id: "p-sys-30", label: "Mid-Gig Rush", duration: 30, isSystem: true },
  { id: "p-sys-45", label: "Main Stage Vibe", duration: 45, isSystem: true }
];

function createInactiveSession(): GigSession {
  return {
    status: 'inactive',
    ownerActorUserId: null,
    lastMutationActorUserId: null,
    talentName: "",
    talentRole: 'DJ',
    feeType: 'patron',
    minimumTip: 5,
    endGigTimerStartedAt: null,
    isFeatured: false,
    featuredExpiresAt: null,
    featuredCost: 0,
    featuredDurationHours: 0,
    requestsOpen: true,
    requestWindowMode: 'manual',
    requestWindowExpiresAt: null,
    requestWindowDuration: null,
    requestWindowLabel: null,
    requestPresets: [...systemRequestPresets],
    operatingMode: 'manual',
    searchScope: 'library',
    paymentsEnabled: true,
    totals: {
      totalTips: 0,
      accumulatedFees: 0,
      totalCount: 0,
      topRequest: "None yet"
    }
  };
}

// Development-only state. Production must use a persistent business store.
function createEmptyBackendState(): BackendState {
  return {
    session: createInactiveSession(),
    requests: [],
    performers: [],
    activeGigId: null
  };
}

let state: BackendState = createEmptyBackendState();
let activeGigId: string | null = null;

function syncActiveGigRouteContext(inputState: BackendState, gigId: string | null = activeGigId) {
  inputState.activeGigId = inputState.session.status === 'active' ? (gigId ?? null) : null;
}

function prepareRoomState(inputState: BackendState, gigId: string | null) {
  syncActiveGigRouteContext(inputState, gigId);
  syncActivePerformer(inputState);
  return inputState;
}

function buildPatronRequestMutationResponse(input: {
  request: RequestItem;
  roomState: BackendState;
  gigId: string;
  receipt: string;
  reconciled?: boolean;
}) {
  return {
    success: true,
    ...(input.reconciled ? { reconciled: true } : {}),
    state: projectPublicRoomState(input.roomState, input.gigId),
    patron_status: projectPatronRequestStatus(input.request),
    patron_status_receipt: input.receipt
  };
}

function buildPatronBoostMutationResponse(input: {
  roomState: BackendState;
  gigId: string;
  reconciled?: boolean;
}) {
  return {
    success: true,
    ...(input.reconciled ? { reconciled: true } : {}),
    state: projectPublicRoomState(input.roomState, input.gigId)
  };
}

async function refreshBusinessState() {
  const snapshot = await businessStore.hydrateState(state);
  state = prepareRoomState(snapshot.state, snapshot.activeGigId);
  activeGigId = state.activeGigId;
  return snapshot;
}

async function persistBusinessState() {
  prepareRoomState(state, activeGigId);
  await businessStore.persistState({ state, activeGigId });
}

async function loadRoomState(gigId: string) {
  if (!businessStore.hasDurableStore) {
    if (state.activeGigId === gigId) {
      const fallbackState = prepareRoomState(state, gigId);
      return {
        state: fallbackState,
        activeGigId: fallbackState.activeGigId,
        roomStatus: fallbackState.session.status === 'closed'
          ? 'ended' as const
          : (fallbackState.session.status === 'active' || fallbackState.session.status === 'ending')
            ? 'active' as const
            : 'inactive' as const
      };
    }

    return {
      state: createEmptyBackendState(),
      activeGigId: null,
      roomStatus: 'missing' as const
    };
  }

  const snapshot = await businessStore.hydrateStateByGigId(gigId, createEmptyBackendState());
  return {
    ...snapshot,
    state: prepareRoomState(snapshot.state, snapshot.activeGigId)
  };
}

async function persistBusinessStateForRoom(roomState: BackendState, gigId: string) {
  const preparedState = prepareRoomState(roomState, gigId);

  if (!businessStore.hasDurableStore) {
    state = preparedState;
    activeGigId = preparedState.activeGigId;
    return;
  }

  await businessStore.persistState({ state: preparedState, activeGigId: gigId });

  if (activeGigId === gigId) {
    state = preparedState;
    activeGigId = preparedState.activeGigId;
  }
}

async function resolveLegacyWritableRoom(req: express.Request, res: express.Response) {
  await refreshBusinessState();

  const requestedGigId = parseDurableGigId(req.body?.gig_id);
  const targetGigId = requestedGigId ?? activeGigId;

  if (!targetGigId) {
    res.status(409).json({
      error: 'A specific live room must be selected before this action can continue.'
    });
    return null;
  }

  const roomSnapshot = await loadRoomState(targetGigId);
  if (roomSnapshot.roomStatus === 'missing') {
    res.status(404).json({ error: ROOM_LOOKUP_UNAVAILABLE_COPY });
    return null;
  }
  if (roomSnapshot.roomStatus === 'ended') {
    res.status(410).json({ error: ROOM_LOOKUP_ENDED_COPY });
    return null;
  }

  return {
    gigId: targetGigId,
    state: roomSnapshot.state
  };
}

async function findRoomStateByRequestId(requestId: string) {
  if (!businessStore.hasDurableStore) {
    const request = state.requests.find((item) => item.id === requestId);
    if (!request) return null;
    return {
      gigId: request.gigId ?? activeGigId,
      state,
      request
    };
  }

  const trackedGigIds = await businessStore.listTrackedGigIds();
  const seenGigIds = new Set<string>();

  for (const gigId of trackedGigIds) {
    if (seenGigIds.has(gigId)) continue;
    seenGigIds.add(gigId);

    const roomSnapshot = await loadRoomState(gigId);
    const request = roomSnapshot.state.requests.find((item) => item.id === requestId);
    if (request) {
      return {
        gigId,
        state: roomSnapshot.state,
        request
      };
    }
  }

  return null;
}

function buildActiveRoomSummary(roomState: BackendState, gigId: string, startedAt: string | null = null): ActiveRoomSummary {
  return {
    gigId,
    performerName: roomState.session.talentName || 'Unassigned performer',
    talentRole: roomState.session.talentRole,
    routePath: `/g/${gigId}`,
    startedAt,
    requestCount: roomState.requests.filter((request) => !request.hidden && !request.removed).length
  };
}

async function listReadableActiveRooms(performerId?: string): Promise<ActiveRoomSummary[]> {
  if (!businessStore.hasDurableStore) {
    await refreshBusinessState();
    return activeGigId ? [buildActiveRoomSummary(state, activeGigId)] : [];
  }

  return businessStore.listActiveRoomSummaries(performerId);
}

function requirePersistentBusinessStore(res: express.Response): boolean {
  if (!isProduction || businessStore.hasDurableStore) return true;
  res.status(503).json({
    error: "Persistent business store is not configured. Production routes cannot use in-memory gig, request, or ledger state."
  });
  return false;
}

function hashPayload(payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(payload ?? {}))
    .digest('hex');
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseDurableGigId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return UUID_PATTERN.test(trimmed) ? trimmed : null;
}

function canonicalJson(input: Record<string, string | number>): string {
  const orderedInput = {
    v: Number(input.v),
    idempotency_key: String(input.idempotency_key),
    patron_device_id_hash: String(input.patron_device_id_hash),
    gig_id: String(input.gig_id),
    action_type: String(input.action_type),
    target_entity_id: String(input.target_entity_id),
    amount_cents: Math.trunc(Number(input.amount_cents)),
    currency: String(input.currency).toUpperCase(),
    payload_hash: String(input.payload_hash)
  };

  return JSON.stringify(orderedInput);
}

function createIdempotencyFingerprint(input: {
  idempotency_key: string;
  patron_device_id_hash: string;
  gig_id: string;
  action_type: string;
  target_entity_id: string;
  amount_cents: number;
  currency: string;
  payload_hash: string;
}): string {
  const canonicalInput = canonicalJson({
    v: 1,
    idempotency_key: input.idempotency_key,
    patron_device_id_hash: input.patron_device_id_hash,
    gig_id: input.gig_id,
    action_type: input.action_type,
    target_entity_id: input.target_entity_id,
    amount_cents: Math.trunc(Number(input.amount_cents)),
    currency: input.currency.toUpperCase(),
    payload_hash: input.payload_hash
  });

  return createHash('sha256')
    .update(canonicalInput, 'utf8')
    .digest('hex');
}

function syncActivePerformer(inputState: BackendState) {
  if (inputState.session.status === 'inactive' || !inputState.session.talentName) {
    inputState.performers = [];
    return;
  }

  const activePerformer = {
    id: "p-active",
    name: inputState.session.talentName,
    role: inputState.session.talentRole,
    venueName: "Current gig",
    isFeatured: inputState.session.isFeatured,
    featuredExpiresAt: inputState.session.featuredExpiresAt,
    minimumTip: inputState.session.minimumTip,
    avatarUrl: ""
  };

  const existingIndex = inputState.performers.findIndex(p => p.id === activePerformer.id);
  if (existingIndex >= 0) {
    inputState.performers[existingIndex] = activePerformer;
  } else {
    inputState.performers = [activePerformer];
  }
}

function resolveActorUserId(req: express.Request): string | null {
  return accessControl.resolveServerActor(req).actorId;
}

type ProtectedMutationActor = {
  actorId: string;
  actorType: string;
};

async function loadAuthenticatedPerformerProfile(req: express.Request) {
  if (!businessDb) return null;

  const actor = accessControl.resolveServerActor(req);
  if (!actor.actorId) return null;

  try {
    const [performerRow] = await businessDb
      .select({
        performer_id: performers.id,
        display_name: performers.displayName,
        handle: performers.handle,
        owner_user_id: performers.ownerUserId,
        email_verified_at: users.emailVerifiedAt,
        charges_enabled: performers.chargesEnabled,
        payouts_enabled: performers.payoutsEnabled,
        stripe_connected_account_id: performers.stripeConnectedAccountId
      })
      .from(performers)
      .innerJoin(users, eq(users.id, performers.ownerUserId))
      .where(eq(performers.ownerUserId, actor.actorId))
      .limit(1);

    return performerRow ?? null;
  } catch (error) {
    console.warn('Unable to resolve authenticated performer profile for /api/state.', {
      actorUserId: actor.actorId,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

async function resolveProtectedMutationActor(req: express.Request, res: express.Response, gigId?: string | null): Promise<ProtectedMutationActor | null> {
  if (!requirePersistentBusinessStore(res)) {
    return null;
  }

  if (gigId) {
    const result = await accessControl.requireGigMutationAccess(req, gigId);
    if (result.allowed === false) {
      res.status(result.status).json({ error: result.reason });
      return null;
    }

    if (!result.actor.actorId) {
      res.status(401).json({ error: 'Sway actor resolution required.' });
      return null;
    }

    return {
      actorId: result.actor.actorId,
      actorType: result.role ?? 'unknown'
    };
  }

  const talentResult = await accessControl.requireTalentAccess(req);
  if (talentResult.allowed) {
    if (!talentResult.actor.actorId) {
      res.status(401).json({ error: 'Sway actor resolution required.' });
      return null;
    }

    return {
      actorId: talentResult.actor.actorId,
      actorType: talentResult.role ?? 'performer'
    };
  }

  const privilegedResult = await accessControl.requireAdminOrSupportAccess(req);
  if (privilegedResult.allowed === false) {
    res.status(privilegedResult.status).json({ error: privilegedResult.reason });
    return null;
  }

  if (!privilegedResult.actor.actorId) {
    res.status(401).json({ error: 'Sway actor resolution required.' });
    return null;
  }

  return {
    actorId: privilegedResult.actor.actorId,
    actorType: privilegedResult.role ?? 'unknown'
  };
}

async function resolveBootstrapTalentActor(actorUserId: string): Promise<ProtectedMutationActor | null> {
  const bootstrapReq = {
    headers: {
      'x-sway-resolved-actor-id': actorUserId,
      'x-sway-resolved-session-id': '',
      'x-sway-resolved-device-id-hash': '',
      'x-sway-actor-hydrated': '1'
    },
    path: '/api/talent/session/bootstrap',
    ip: null
  } as unknown as express.Request;

  const talentAccess = await accessControl.requireTalentAccess(bootstrapReq);
  if (talentAccess.allowed === false || !talentAccess.actor.actorId) {
    return null;
  }

  return {
    actorId: talentAccess.actor.actorId,
    actorType: talentAccess.role ?? 'performer'
  };
}

async function loadAuthorizedPerformerOwnerByEmail(email: string) {
  if (!businessDb) return null;

  const [row] = await businessDb
    .select({
      actorUserId: users.id,
      performerId: performers.id,
      performerHandle: performers.handle,
      performerDisplayName: performers.displayName
    })
    .from(users)
    .innerJoin(performers, eq(performers.ownerUserId, users.id))
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);

  return row ?? null;
}

async function loadPerformerPasswordAccountByEmail(executor: any, email: string) {
  const [row] = await executor
    .select({
      actorUserId: users.id,
      passwordHash: users.passwordHash,
      emailVerifiedAt: users.emailVerifiedAt,
      performerId: performers.id,
      performerIsActive: performers.isActive
    })
    .from(users)
    .innerJoin(performers, eq(performers.ownerUserId, users.id))
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);

  return row ?? null;
}

async function performerSignupEmailExists(executor: any, email: string) {
  const [row] = await executor
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);

  return Boolean(row);
}

async function performerHandleExists(executor: any, handle: string, options: { includePreviews?: boolean } = {}) {
  const [row] = await executor
    .select({ id: performers.id })
    .from(performers)
    .where(sql`lower(${performers.handle}) = ${handle.toLowerCase()}`)
    .limit(1);

  if (row || options.includePreviews === false) return Boolean(row);

  const [preview] = await executor
    .select({ id: performerProfilePreviews.id })
    .from(performerProfilePreviews)
    .where(and(
      sql`lower(${performerProfilePreviews.handle}) = ${handle.toLowerCase()}`,
      eq(performerProfilePreviews.isActive, true)
    ))
    .limit(1);

  return Boolean(preview);
}

async function loadPerformerOwnerVerificationState(actorUserId: string) {
  if (!businessDb) return null;

  const [row] = await businessDb
    .select({
      performerId: performers.id,
      isActive: performers.isActive,
      emailVerifiedAt: users.emailVerifiedAt
    })
    .from(performers)
    .innerJoin(users, eq(users.id, performers.ownerUserId))
    .where(eq(performers.ownerUserId, actorUserId))
    .limit(1);

  return row ?? null;
}

async function loadOwnedPerformerByActorUserId(actorUserId: string) {
  if (!businessDb) return null;

  const [row] = await businessDb
    .select({
      performerId: performers.id,
      displayName: performers.displayName,
      handle: performers.handle,
      bio: performers.bio
    })
    .from(performers)
    .where(eq(performers.ownerUserId, actorUserId))
    .limit(1);

  return row ?? null;
}

function normalizeLibraryText(value: unknown, maxLength = 160) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function toPublicSocialLinks(row: {
  facebookUrl: string | null;
  instagramUrl: string | null;
  tiktokUrl: string | null;
  youtubeUrl: string | null;
  soundcloudUrl: string | null;
  websiteUrl: string | null;
}) {
  return {
    facebook: normalizePublicProfileUrl(row.facebookUrl),
    instagram: normalizePublicProfileUrl(row.instagramUrl),
    tiktok: normalizePublicProfileUrl(row.tiktokUrl),
    youtube: normalizePublicProfileUrl(row.youtubeUrl),
    soundcloud: normalizePublicProfileUrl(row.soundcloudUrl),
    website: normalizePublicProfileUrl(row.websiteUrl)
  };
}

function resolvePublicStageName(input: {
  displayName: string | null;
  handle: string | null;
  headline: string | null;
  metadata: unknown;
}) {
  const metadataStageName = input.metadata && typeof input.metadata === 'object'
    ? normalizePublicProfileText((input.metadata as Record<string, unknown>).stageName, 80)
    : null;
  if (metadataStageName) return metadataStageName;

  // DJ3X is the performer-facing name already established by the public
  // handle and headline. Keep it ahead of the legal/display name until the
  // owner supplies an explicit stageName in their public profile metadata.
  if (input.handle?.trim().toLowerCase() === 'dj3x') return 'DJ3X';
  return input.displayName || input.handle || 'Performer';
}

function normalizeLibrarySourceKey(value: unknown) {
  const normalized = normalizeLibraryText(value, 64).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || null;
}

function buildLibraryExternalTrackId(input: {
  externalTrackId: string;
  title: string;
  artist: string;
  album: string;
}) {
  if (input.externalTrackId) return input.externalTrackId;

  return createHash('sha256')
    .update(`${input.title}|${input.artist}|${input.album}`, 'utf8')
    .digest('hex');
}

function issueLibrarySyncKey() {
  return `sway_lib_${randomBytes(24).toString('hex')}`;
}

function hashLibrarySyncKey(syncKey: string) {
  return createHash('sha256').update(syncKey, 'utf8').digest('hex');
}

async function upsertPerformerLibraryTrackBatch(executor: any, input: {
  performerId: string;
  sourceKey: string;
  sourceLabel: string;
  rawTracks: unknown[];
  replaceExisting?: boolean;
}) {
  const normalizedTracks = input.rawTracks
    .slice(0, 1000)
    .map((track) => {
      const title = normalizeLibraryText((track as any)?.title, 160);
      const artist = normalizeLibraryText((track as any)?.artist, 160) || 'Unknown artist';
      const album = normalizeLibraryText((track as any)?.album, 160);
      const artworkUrl = normalizeLibraryText((track as any)?.artworkUrl, 512);
      const externalTrackId = normalizeLibraryText((track as any)?.externalTrackId, 256);
      const searchableText = [title, artist, album].filter(Boolean).join(' ').toLowerCase();

      if (!title) return null;

      return {
        performerId: input.performerId,
        sourceKey: input.sourceKey,
        sourceLabel: input.sourceLabel,
        externalTrackId: buildLibraryExternalTrackId({ externalTrackId, title, artist, album }),
        title,
        artist,
        album: album || null,
        artworkUrl: artworkUrl || null,
        searchableText,
        metadata: (track as any)?.metadata && typeof (track as any).metadata === 'object' ? (track as any).metadata : null,
        lastSeenAt: new Date(),
        updatedAt: new Date()
      };
    })
    .filter(Boolean) as Array<{
      performerId: string;
      sourceKey: string;
      sourceLabel: string;
      externalTrackId: string;
      title: string;
      artist: string;
      album: string | null;
      artworkUrl: string | null;
      searchableText: string;
      metadata: Record<string, unknown> | null;
      lastSeenAt: Date;
      updatedAt: Date;
    }>;

  if (!normalizedTracks.length) {
    return { importedCount: 0, removedCount: 0 };
  }

  for (const track of normalizedTracks) {
    await executor
      .insert(performerLibraryTracks)
      .values(track)
      .onConflictDoUpdate({
        target: [
          performerLibraryTracks.performerId,
          performerLibraryTracks.sourceKey,
          performerLibraryTracks.externalTrackId
        ],
        set: {
          sourceLabel: track.sourceLabel,
          title: track.title,
          artist: track.artist,
          album: track.album,
          artworkUrl: track.artworkUrl,
          searchableText: track.searchableText,
          metadata: track.metadata,
          lastSeenAt: track.lastSeenAt,
          updatedAt: new Date()
        }
      });
  }

  let removedCount = 0;
  if (input.replaceExisting) {
    const retainedExternalTrackIds = normalizedTracks.map((track) => track.externalTrackId);
    const staleRows = await executor
      .delete(performerLibraryTracks)
      .where(and(
        eq(performerLibraryTracks.performerId, input.performerId),
        eq(performerLibraryTracks.sourceKey, input.sourceKey),
        notInArray(performerLibraryTracks.externalTrackId, retainedExternalTrackIds)
      ))
      .returning({ id: performerLibraryTracks.id });

    removedCount = staleRows.length;
  }

  return { importedCount: normalizedTracks.length, removedCount };
}

async function actorHasDurableTalentAccess(executor: any, actorUserId: string) {
  const [ownerRow] = await executor
    .select({ id: performers.id })
    .from(performers)
    .where(eq(performers.ownerUserId, actorUserId))
    .limit(1);

  if (ownerRow) return true;

  const [membershipRow] = await executor
    .select({ id: performerMemberships.id })
    .from(performerMemberships)
    .where(eq(performerMemberships.userId, actorUserId))
    .limit(1);

  if (membershipRow) return true;

  const [grantRow] = await executor
    .select({ id: gigAccessGrants.id })
    .from(gigAccessGrants)
    .where(eq(gigAccessGrants.userId, actorUserId))
    .limit(1);

  return Boolean(grantRow);
}

function performerLoginSuccessResponse() {
  return {
    success: true,
    message: PERFORMER_LOGIN_SUCCESS_COPY
  };
}

function performerPasswordLoginSuccessResponse(redirectPath: string) {
  return {
    success: true,
    redirectPath
  };
}

function performerSignupSuccessResponse(debugVerificationLink?: string) {
  return {
    success: true,
    message: PERFORMER_SIGNUP_SUCCESS_COPY,
    ...(!isProduction && debugVerificationLink
      ? {
          deliveryMode: 'mock',
          verificationLink: debugVerificationLink
        }
      : {})
  };
}

function performerCredentialFailureResponse() {
  return {
    error: 'Invalid email or password.'
  };
}

function performerLoginFailureRedirect(status: 'invalid-link' | 'unavailable' = 'invalid-link') {
  if (status === 'unavailable') {
    return '/talent/login?status=unavailable';
  }
  return '/talent/login?status=invalid-link';
}

function performerVerifyEmailFailureRedirect(status: 'invalid-link' | 'unavailable' = 'invalid-link') {
  if (status === 'unavailable') {
    return '/talent/login?status=unavailable';
  }
  return '/talent/login?status=invalid-link';
}

function performerVerifyEmailSuccessRedirect() {
  return '/talent/login?status=verified';
}

function isUniqueConstraintViolation(error: unknown, constraintName: string) {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' && candidate.constraint === constraintName;
}

async function persistStateWithAudit(input: {
  roomState: BackendState;
  gigId: string;
  actor: ProtectedMutationActor;
  entityType: string;
  entityId: string;
  eventType: string;
  previousStatus?: string | null;
  nextStatus?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const preparedState = prepareRoomState(input.roomState, input.gigId);

  if (!businessDb) {
    await persistBusinessStateForRoom(preparedState, input.gigId);
    return;
  }

  await businessDb.transaction(async (tx) => {
    await businessStore.persistState({ state: preparedState, activeGigId: input.gigId }, { executor: tx as any });
    await writeAuditEvent(tx, {
      actorId: input.actor.actorId,
      actorType: input.actor.actorType,
      entityType: input.entityType,
      entityId: input.entityId,
      eventType: input.eventType,
      previousStatus: input.previousStatus,
      nextStatus: input.nextStatus,
      metadata: input.metadata
    });
  });

  if (activeGigId === input.gigId) {
    state = preparedState;
    activeGigId = preparedState.activeGigId;
  }
}

async function writeMutationNoopAudit(input: {
  gigId: string;
  actor: ProtectedMutationActor;
  entityType: string;
  entityId: string;
  eventType: string;
  previousStatus?: string | null;
  nextStatus?: string | null;
  reason: string;
  metadata?: Record<string, unknown>;
}) {
  if (!businessDb) return;

  await writeAuditEvent(businessDb, {
    actorId: input.actor.actorId,
    actorType: input.actor.actorType,
    entityType: input.entityType,
    entityId: input.entityId,
    eventType: `${input.eventType}.noop`,
    previousStatus: input.previousStatus,
    nextStatus: input.nextStatus ?? input.previousStatus,
    metadata: {
      ...(input.metadata ?? {}),
      duplicate_noop: true,
      noop_reason: input.reason,
      gigId: input.gigId
    }
  });
}

function durableActorActionExpiresAt() {
  return new Date(Date.now() + IDEMPOTENCY_TTL_HOURS * 3600000).toISOString();
}

function buildDurableActorActionInput(input: {
  actor: ProtectedMutationActor;
  gigId: string;
  actionType: string;
  targetEntityType: string;
  targetEntityId: string;
  payload?: Record<string, unknown>;
  idempotencyKeySeed?: string;
  expiresAt?: string | null;
}): DurableActorActionInput {
  const actorScope = `actor:${input.actor.actorId}`;
  const payloadHash = hashPayload({
    actorId: input.actor.actorId,
    gigId: input.gigId,
    actionType: input.actionType,
    targetEntityType: input.targetEntityType,
    targetEntityId: input.targetEntityId,
    ...(input.payload ?? {})
  });
  const idempotencyKey = `performer:${hashPayload({
    actorId: input.actor.actorId,
    gigId: input.gigId,
    actionType: input.actionType,
    targetEntityType: input.targetEntityType,
    targetEntityId: input.targetEntityId,
    seed: input.idempotencyKeySeed ?? 'stable'
  })}`;

  return {
    idempotencyKey,
    actorId: input.actor.actorId,
    actorScope,
    gigId: input.gigId,
    actionType: input.actionType,
    amountCents: 0,
    currency: 'USD',
    targetEntityType: input.targetEntityType,
    targetEntityId: input.targetEntityId,
    payloadHash,
    intentFingerprint: createIdempotencyFingerprint({
      idempotency_key: idempotencyKey,
      patron_device_id_hash: actorScope,
      gig_id: input.gigId,
      action_type: input.actionType,
      target_entity_id: input.targetEntityId,
      amount_cents: 0,
      currency: 'USD',
      payload_hash: payloadHash
    }),
    expiresAt: input.expiresAt ?? durableActorActionExpiresAt()
  };
}

async function reserveDurableActorMutation(input: DurableActorActionInput) {
  return idempotencyStore.reserveDurableActorAction(input);
}

async function completeDurableActorMutation(input: {
  reservation: DurableActorActionInput | null;
  status: number;
  body: unknown;
}) {
  if (!input.reservation) return;
  await idempotencyStore.completeDurableActorAction({
    idempotencyKey: input.reservation.idempotencyKey,
    status: input.status,
    body: input.body
  });
}

function sendDurableMutationReplay(
  res: express.Response,
  replay: Awaited<ReturnType<typeof reserveDurableActorMutation>>
) {
  if (replay.kind === 'expired') {
    res.status(410).json({ error: 'Durable action window expired before mutation.' });
    return true;
  }
  if (replay.kind === 'misuse') {
    res.status(409).json({ error: 'idempotency misuse: same performer action key submitted with a different fingerprint.' });
    return true;
  }
  if (replay.kind === 'replay') {
    res.status(replay.status).json(replay.body);
    return true;
  }
  return false;
}

type RoomMutationContext = { gigId: string; state: BackendState };
type RequestMutationContext = RoomMutationContext & { request: RequestItem };

async function applyWindowToggle({
  roomContext,
  actor,
  nextOpen
}: {
  roomContext: RoomMutationContext;
  actor: ProtectedMutationActor;
  nextOpen: boolean;
}) {
  const roomState = roomContext.state;
  const previousStatus = roomState.session.requestsOpen ? 'open' : 'closed';

  roomState.session.requestsOpen = nextOpen;
  roomState.session.requestWindowMode = 'manual';
  roomState.session.requestWindowExpiresAt = null;
  roomState.session.requestWindowDuration = null;
  roomState.session.requestWindowLabel = null;
  roomState.session.lastMutationActorUserId = actor.actorId;

  await persistStateWithAudit({
    roomState,
    gigId: roomContext.gigId,
    actor,
    entityType: 'gig_session',
    entityId: roomContext.gigId,
    eventType: 'session.window.toggle',
    previousStatus,
    nextStatus: roomState.session.requestsOpen ? 'open' : 'closed',
    metadata: {
      requestWindowMode: roomState.session.requestWindowMode
    }
  });

  return { state: prepareRoomState(roomState, roomContext.gigId) };
}

async function applyRequestTriage({
  roomContext,
  actor,
  action
}: {
  roomContext: RequestMutationContext;
  actor: ProtectedMutationActor;
  action: 'approve' | 'deny';
}) {
  const roomState = roomContext.state;
  const request = roomContext.request;
  const previousStatus = request.status;
  const nextStatus = action === 'approve' ? 'approved' : 'denied';

  if (request.hidden || request.removed) {
    await writeMutationNoopAudit({
      gigId: roomContext.gigId,
      actor,
      entityType: 'request',
      entityId: request.id,
      eventType: `request.triage.${action === 'approve' ? 'approve' : 'deny'}`,
      previousStatus,
      reason: request.removed ? 'request_removed' : 'request_hidden',
      metadata: { requestId: request.id, requestedAction: action }
    });
    return {
      request,
      state: prepareRoomState(roomState, roomContext.gigId),
      noop: true,
      noopReason: request.removed ? 'request_removed' : 'request_hidden'
    };
  }

  if (previousStatus === nextStatus) {
    await writeMutationNoopAudit({
      gigId: roomContext.gigId,
      actor,
      entityType: 'request',
      entityId: request.id,
      eventType: `request.triage.${action === 'approve' ? 'approve' : 'deny'}`,
      previousStatus,
      nextStatus,
      reason: 'already_in_target_state',
      metadata: { requestId: request.id, requestedAction: action }
    });
    return {
      request,
      state: prepareRoomState(roomState, roomContext.gigId),
      noop: true,
      noopReason: 'already_in_target_state'
    };
  }

  if (
    previousStatus === 'fulfilled' ||
    (action === 'approve' && previousStatus === 'denied')
  ) {
    await writeMutationNoopAudit({
      gigId: roomContext.gigId,
      actor,
      entityType: 'request',
      entityId: request.id,
      eventType: `request.triage.${action === 'approve' ? 'approve' : 'deny'}`,
      previousStatus,
      nextStatus,
      reason: 'incompatible_terminal_state',
      metadata: { requestId: request.id, requestedAction: action }
    });
    return {
      request,
      state: prepareRoomState(roomState, roomContext.gigId),
      noop: true,
      noopReason: 'incompatible_terminal_state'
    };
  }

  request.status = nextStatus;
  request.lastMutationActorUserId = actor.actorId;
  roomState.session.lastMutationActorUserId = actor.actorId;

  if (paymentService.isEnabled()) {
    const paymentIds = [
      request.paymentId,
      ...request.boosts.map((boost) => boost.paymentId)
    ].filter((id): id is string => Boolean(id));

    if (action === 'approve') {
      for (const paymentId of paymentIds) {
        const capture = await paymentService.captureAuthorization(paymentId);
        if (capture.status === 'captured' && paymentId === request.paymentId) {
          request.paymentStatus = 'captured';
        }
      }
    } else {
      await paymentService.voidOrRefundMany(paymentIds);
      request.paymentStatus = 'voided_or_refunded';
    }
  }

  recalculateTotals(roomState);
  await persistStateWithAudit({
    roomState,
    gigId: roomContext.gigId,
    actor,
    entityType: 'request',
    entityId: request.id,
    eventType: `request.triage.${action === 'approve' ? 'approve' : 'deny'}`,
    previousStatus,
    nextStatus: request.status,
    metadata: {
      requestId: request.id,
      gigId: roomContext.gigId
    }
  });

  return { request, state: prepareRoomState(roomState, roomContext.gigId) };
}

async function applyRequestFulfill({
  roomContext,
  actor
}: {
  roomContext: RequestMutationContext;
  actor: ProtectedMutationActor;
}) {
  const roomState = roomContext.state;
  const request = roomContext.request;
  const previousStatus = request.status;

  if (request.hidden || request.removed) {
    await writeMutationNoopAudit({
      gigId: roomContext.gigId,
      actor,
      entityType: 'request',
      entityId: request.id,
      eventType: 'request.fulfill',
      previousStatus,
      reason: request.removed ? 'request_removed' : 'request_hidden',
      metadata: { requestId: request.id }
    });
    return {
      request,
      state: prepareRoomState(roomState, roomContext.gigId),
      noop: true,
      noopReason: request.removed ? 'request_removed' : 'request_hidden'
    };
  }

  if (previousStatus === 'fulfilled') {
    await writeMutationNoopAudit({
      gigId: roomContext.gigId,
      actor,
      entityType: 'request',
      entityId: request.id,
      eventType: 'request.fulfill',
      previousStatus,
      nextStatus: 'fulfilled',
      reason: 'already_in_target_state',
      metadata: { requestId: request.id }
    });
    return {
      request,
      state: prepareRoomState(roomState, roomContext.gigId),
      noop: true,
      noopReason: 'already_in_target_state'
    };
  }

  if (previousStatus !== 'approved') {
    await writeMutationNoopAudit({
      gigId: roomContext.gigId,
      actor,
      entityType: 'request',
      entityId: request.id,
      eventType: 'request.fulfill',
      previousStatus,
      nextStatus: 'fulfilled',
      reason: 'incompatible_terminal_state',
      metadata: { requestId: request.id }
    });
    return {
      request,
      state: prepareRoomState(roomState, roomContext.gigId),
      noop: true,
      noopReason: 'incompatible_terminal_state'
    };
  }

  request.status = 'fulfilled';
  request.lastMutationActorUserId = actor.actorId;
  roomState.session.lastMutationActorUserId = actor.actorId;

  if (paymentService.isEnabled()) {
    const paymentIds = [
      request.paymentId,
      ...request.boosts.map((boost) => boost.paymentId)
    ].filter((id): id is string => Boolean(id));
    for (const paymentId of paymentIds) {
      const capture = await paymentService.captureAuthorization(paymentId);
      if (capture.status === 'captured' && paymentId === request.paymentId) {
        request.paymentStatus = 'captured';
      }
    }
  }

  recalculateTotals(roomState);
  await persistStateWithAudit({
    roomState,
    gigId: roomContext.gigId,
    actor,
    entityType: 'request',
    entityId: request.id,
    eventType: 'request.fulfill',
    previousStatus,
    nextStatus: request.status,
    metadata: {
      requestId: request.id,
      gigId: roomContext.gigId
    }
  });

  return { request, state: prepareRoomState(roomState, roomContext.gigId) };
}

async function applyRequestHide({
  roomContext,
  actor,
  reason
}: {
  roomContext: RequestMutationContext;
  actor: ProtectedMutationActor;
  reason: string;
}) {
  const roomState = roomContext.state;
  const request = roomContext.request;
  const previousStatus = request.hidden ? 'hidden' : 'visible';

  if (request.hidden) {
    await writeMutationNoopAudit({
      gigId: roomContext.gigId,
      actor,
      entityType: 'request',
      entityId: request.id,
      eventType: 'moderation.hide',
      previousStatus,
      nextStatus: 'hidden',
      reason: 'already_in_target_state',
      metadata: { requestId: request.id, reason }
    });
    return {
      request,
      state: prepareRoomState(roomState, roomContext.gigId),
      noop: true,
      noopReason: 'already_in_target_state'
    };
  }

  if (request.removed) {
    await writeMutationNoopAudit({
      gigId: roomContext.gigId,
      actor,
      entityType: 'request',
      entityId: request.id,
      eventType: 'moderation.hide',
      previousStatus: 'removed',
      nextStatus: 'hidden',
      reason: 'request_removed',
      metadata: { requestId: request.id, reason }
    });
    return {
      request,
      state: prepareRoomState(roomState, roomContext.gigId),
      noop: true,
      noopReason: 'request_removed'
    };
  }

  request.hidden = true;
  request.lastMutationActorUserId = actor.actorId;
  roomState.session.lastMutationActorUserId = actor.actorId;

  if (paymentService.isEnabled()) {
    const paymentIds = [
      request.paymentId,
      ...request.boosts.map((boost) => boost.paymentId)
    ].filter((id): id is string => Boolean(id));
    if (paymentIds.length) {
      await paymentService.voidOrRefundMany(paymentIds);
      request.paymentStatus = 'voided_or_refunded';
    }
  }

  await persistStateWithAudit({
    roomState,
    gigId: roomContext.gigId,
    actor,
    entityType: 'request',
    entityId: request.id,
    eventType: 'moderation.hide',
    previousStatus,
    nextStatus: request.hidden ? 'hidden' : 'visible',
    metadata: {
      requestId: request.id,
      reason
    }
  });

  await moderationService.hideRequest({
    requestId: request.id,
    reason,
    // Always the authenticated actor -- never trust a client-supplied actor id.
    actorUserId: actor.actorId
  });

  return { request, state: prepareRoomState(roomState, roomContext.gigId) };
}

function visibleRoomRequests(roomState: BackendState): RequestItem[] {
  return roomState.requests.filter((request) => !request.hidden && !request.removed && !request.shadowBanned);
}

function topApprovedRoomRequest(roomState: BackendState): RequestItem | null {
  return visibleRoomRequests(roomState)
    .filter((request) => request.status === 'approved')
    .sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0))[0] ?? null;
}

function topPendingRoomRequest(roomState: BackendState): RequestItem | null {
  return visibleRoomRequests(roomState)
    .filter((request) => request.status === 'hold')
    .sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime())[0] ?? null;
}

const CONTROL_BRIDGE_SEARCH_PROVIDERS: Record<string, { label: string; url: (query: string) => string }> = {
  spotify: {
    label: 'Spotify search',
    url: (query) => `spotify:search:${encodeURIComponent(query)}`
  },
  soundcloud: {
    label: 'SoundCloud search',
    url: (query) => `https://soundcloud.com/search/sounds?q=${encodeURIComponent(query)}`
  },
  youtube: {
    label: 'YouTube search',
    url: (query) => `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
  }
};

function controlBridgeRequestText(request: RequestItem | null): string | null {
  if (!request) return null;
  const title = typeof request.title === 'string' ? request.title.trim() : '';
  const subtitle = typeof request.subtitle === 'string' ? request.subtitle.trim() : '';
  const text = [title, subtitle].filter(Boolean).join(' - ');
  return text || null;
}

// 5-Minute Timer Closeout Routine Worker
setInterval(async () => {
  if (!businessStore.hasDurableStore) {
    await refreshBusinessState();

    let changed = false;

    if (state.session.status === 'ending' && state.session.endGigTimerStartedAt) {
      const startTimeStamp = new Date(state.session.endGigTimerStartedAt).getTime();
      const elapsedTime = Date.now() - startTimeStamp;

      if (elapsedTime >= 300000) {
        console.log("Post-gig timer expired. Releasing pending requests.");
        executeAutoNuke(state);
        changed = true;
      }
    }

    if (state.session.isFeatured && state.session.featuredExpiresAt) {
      if (Date.now() > new Date(state.session.featuredExpiresAt).getTime()) {
        console.log("Featured Performer status has expired!");
        state.session.isFeatured = false;
        state.session.featuredExpiresAt = null;
        state.session.featuredCost = 0;
        state.session.featuredDurationHours = 0;
        changed = true;
      }
    }

    if (state.session.requestsOpen && state.session.requestWindowMode === 'preset' && state.session.requestWindowExpiresAt) {
      if (Date.now() > new Date(state.session.requestWindowExpiresAt).getTime()) {
        console.log("Request custom window expired! Closing requests automatically.");
        state.session.requestsOpen = false;
        state.session.requestWindowExpiresAt = null;
        state.session.requestWindowDuration = null;
        state.session.requestWindowLabel = null;
        changed = true;
      }
    }

    syncActivePerformer(state);
    if (changed) {
      await persistBusinessState();
    }
    return;
  }

  const trackedGigIds = await businessStore.listTrackedGigIds();

  for (const trackedGigId of trackedGigIds) {
    const roomSnapshot = await loadRoomState(trackedGigId);
    const roomState = roomSnapshot.state;
    let changed = false;

    if (roomState.session.status === 'ending' && roomState.session.endGigTimerStartedAt) {
      const startTimeStamp = new Date(roomState.session.endGigTimerStartedAt).getTime();
      const elapsedTime = Date.now() - startTimeStamp;

      if (elapsedTime >= 300000) {
        console.log("Post-gig timer expired. Releasing pending requests.");
        executeAutoNuke(roomState);
        changed = true;
      }
    }

    if (roomState.session.isFeatured && roomState.session.featuredExpiresAt) {
      if (Date.now() > new Date(roomState.session.featuredExpiresAt).getTime()) {
        console.log("Featured Performer status has expired!");
        roomState.session.isFeatured = false;
        roomState.session.featuredExpiresAt = null;
        roomState.session.featuredCost = 0;
        roomState.session.featuredDurationHours = 0;
        changed = true;
      }
    }

    if (roomState.session.requestsOpen && roomState.session.requestWindowMode === 'preset' && roomState.session.requestWindowExpiresAt) {
      if (Date.now() > new Date(roomState.session.requestWindowExpiresAt).getTime()) {
        console.log("Request custom window expired! Closing requests automatically.");
        roomState.session.requestsOpen = false;
        roomState.session.requestWindowExpiresAt = null;
        roomState.session.requestWindowDuration = null;
        roomState.session.requestWindowLabel = null;
        changed = true;
      }
    }

    if (changed) {
      await persistBusinessStateForRoom(roomState, trackedGigId);
    }
  }

  await refreshBusinessState();
}, 10000); // Check every 10 seconds for tighter precision

function executeAutoNuke(inputState: BackendState) {
  inputState.requests = inputState.requests.map(req => {
    if (req.status === 'hold') {
      return { ...req, status: 'denied' };
    }
    return req;
  });
  inputState.session.status = 'closed';
  inputState.session.endGigTimerStartedAt = null;

  // Compute final totals
  recalculateTotals(inputState);
}

function recalculateTotals(inputState: BackendState) {
  const fulfilledItems = inputState.requests.filter(r => r.status === 'fulfilled');
  const totalTips = fulfilledItems.reduce((acc, curr) => acc + curr.amount, 0);
  const totalCount = fulfilledItems.length;
  const accumulatedFees = (inputState.requests.filter(r => r.status !== 'denied').reduce((acc, curr) => acc + curr.sponsorCount, 0)) * 1.0;

  // Find top requested item
  const counts: Record<string, number> = {};
  fulfilledItems.forEach(r => {
    if (r.type === 'request') {
      counts[r.title] = (counts[r.title] || 0) + r.amount;
    }
  });
  let topRequest = "No requests fulfilled yet";
  let maxAmount = 0;
  for (const [title, amt] of Object.entries(counts)) {
    if (amt > maxAmount) {
      maxAmount = amt;
      topRequest = title;
    }
  }

  inputState.session.totals = {
    totalTips,
    accumulatedFees,
    totalCount,
    topRequest
  };
}

// API Routes
app.get("/api/health/network-probe", (_req, res) => {
  res.status(204).end();
});

app.get("/api/build-marker", (_req, res) => {
  applyNoStoreHeaders(res);
  res.json(buildMarker);
});

app.get('/api/runtime-config-status', (_req, res) => {
  applyNoStoreHeaders(res);
  res.json({
    hasDatabaseUrl: Boolean(process.env.DATABASE_URL?.trim()),
    hasPerformerBootstrapSecret: Boolean(process.env.SWAY_PERFORMER_BOOTSTRAP_SECRET?.trim()),
    hasAdminBootstrapSecret,
    hasPerformerLoginEmailConfig,
    performerLoginEmailConfig: {
      hasSwayEmailProvider,
      hasSwayEmailApiKey,
      hasSwayEmailFrom,
      hasSwayEmailBaseUrl
    },
    nodeEnv: process.env.NODE_ENV ?? null,
    commit: buildMarker.commit,
    branch: buildMarker.branch,
    buildTimestamp: buildMarker.buildTimestamp
  });
});

app.get('/api/payment/config', (_req, res) => {
  applyNoStoreHeaders(res);
  const publishableKey = (process.env.STRIPE_PUBLISHABLE_KEY || process.env.VITE_STRIPE_PUBLISHABLE_KEY || '').trim();
  const mode = publishableKey.startsWith('pk_test_')
    ? 'test'
    : publishableKey.startsWith('pk_live_')
      ? 'live'
      : null;

  if (!publishableKey || !mode) {
    return res.status(503).json({ error: 'Payment form is not configured.' });
  }

  return res.json({ publishableKey, mode });
});

app.post('/api/talent/invite/accept', async (req, res) => {
  applyNoStoreHeaders(res);

  if (!businessDb || !performerLoginChallengeStore.hasDurableStore || !performerSessionStore.hasDurableStore) {
    return res.status(503).json({ error: 'Performer invitation setup is temporarily unavailable.' });
  }

  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  const password = normalizePerformerPassword(req.body?.password);
  const confirmPassword = normalizePerformerPassword(req.body?.confirmPassword);
  const termsAccepted = req.body?.termsAccepted === true;
  const requesterIpHash = hashPerformerLoginRequesterIp(req.ip || null);
  const rateLimitResult = performerSignupRateLimiter.consume({
    requesterIpHash,
    targetEmail: '__talent_invite__'
  });

  if (!rateLimitResult.allowed) {
    return res.status(429).json({ error: 'Too many performer setup attempts. Please try again later.' });
  }
  if (!token) {
    return res.status(422).json({ error: 'A valid one-time invitation is required.' });
  }
  if (!termsAccepted) {
    return res.status(422).json({ error: 'Account terms acceptance is required to finish setup.' });
  }
  if (!password) {
    return res.status(422).json({ error: 'Choose a password to finish setup.' });
  }

  const passwordValidation = validatePerformerPasswordStrength(password);
  if (!passwordValidation.ok) {
    return res.status(422).json({ error: passwordValidation.error });
  }
  if (!confirmPassword || password !== confirmPassword) {
    return res.status(422).json({ error: 'Password confirmation does not match.' });
  }

  const passwordHash = await hashPerformerPassword(password);

  try {
    const outcome = await businessDb.transaction(async (tx) => {
      const invitation = await performerLoginChallengeStore.consumeChallengeFromToken({
        token,
        expectedChallengeType: PERFORMER_LOGIN_CHALLENGE_TYPE_ACCOUNT_INVITE,
        executor: tx
      });

      if (!invitation?.actorUserId) return null;

      const metadata = invitation.challengeMetadata && typeof invitation.challengeMetadata === 'object'
        ? invitation.challengeMetadata as Record<string, unknown>
        : {};
      const performerId = typeof metadata.performerId === 'string' && UUID_PATTERN.test(metadata.performerId)
        ? metadata.performerId
        : null;
      if (!performerId) return null;

      const [account] = await tx
        .select({
          userId: users.id,
          performerId: performers.id,
          passwordHash: users.passwordHash
        })
        .from(users)
        .innerJoin(performers, eq(performers.ownerUserId, users.id))
        .where(and(
          eq(users.id, invitation.actorUserId),
          eq(performers.id, performerId)
        ))
        .limit(1);

      if (!account || account.passwordHash) return null;

      const completedAt = new Date();
      const [updatedUser] = await tx
        .update(users)
        .set({
          passwordHash,
          emailVerifiedAt: completedAt,
          termsAcceptedAt: completedAt,
          updatedAt: completedAt
        })
        .where(and(
          eq(users.id, account.userId),
          isNull(users.passwordHash)
        ))
        .returning({ id: users.id });

      if (!updatedUser) return null;

      const requestedOnboardingStatus = typeof metadata.onboardingStatus === 'string'
        && VALID_ONBOARDING_STATUSES.has(metadata.onboardingStatus)
        ? metadata.onboardingStatus
        : 'profile_started';
      const activateAfterSetup = metadata.activateAfterSetup === true;

      await tx
        .update(performers)
        .set({
          isActive: activateAfterSetup,
          onboardingStatus: requestedOnboardingStatus as typeof performers.onboardingStatus.enumValues[number],
          updatedAt: completedAt
        })
        .where(eq(performers.id, account.performerId));

      const issuedSession = await performerSessionStore.issueSession({
        actorUserId: account.userId,
        issuedBy: account.userId,
        executor: tx
      });

      await writeAuditEvent(tx, {
        actorId: account.userId,
        actorType: 'performer',
        entityType: 'performer_login_challenge',
        entityId: invitation.id,
        eventType: 'performer_invitation.accept',
        previousStatus: 'pending',
        nextStatus: 'consumed',
        metadata: {
          performerId: account.performerId,
          accountTermsAcceptedAt: completedAt.toISOString(),
          passwordSetByOwner: true
        }
      });

      return { issuedSession };
    });

    if (!outcome) {
      return res.status(410).json({ error: 'This invitation is invalid, expired, or already used.' });
    }

    res.cookie(performerSessionStore.cookieName, outcome.issuedSession.token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      path: '/',
      expires: outcome.issuedSession.expiresAt
    });
    return res.status(200).json({ success: true, redirectPath: '/talent' });
  } catch (error) {
    console.warn('Performer invitation acceptance failed.', {
      path: req.path,
      ip: req.ip || null,
      reason: error instanceof Error ? error.message : String(error)
    });
    return res.status(500).json({ error: 'Unable to finish performer setup right now.' });
  }
});

app.post('/api/talent/claim/accept', async (req, res) => {
  applyNoStoreHeaders(res);

  if (!businessDb || !performerLoginChallengeStore.hasDurableStore || !performerSessionStore.hasDurableStore) {
    return res.status(503).json({ error: 'Performer claim setup is temporarily unavailable.' });
  }

  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  const normalizedEmail = normalizePerformerLoginEmail(req.body?.email);
  const normalizedPhone = normalizePerformerPhone(req.body?.phone);
  const password = normalizePerformerPassword(req.body?.password);
  const confirmPassword = normalizePerformerPassword(req.body?.confirmPassword);
  const termsAccepted = req.body?.termsAccepted === true;
  const requesterIpHash = hashPerformerLoginRequesterIp(req.ip || null);
  const rateLimitResult = performerSignupRateLimiter.consume({
    requesterIpHash,
    targetEmail: '__talent_claim__'
  });

  if (!rateLimitResult.allowed) {
    return res.status(429).json({ error: 'Too many claim attempts. Please try again later.' });
  }
  if (!token) {
    return res.status(422).json({ error: 'A valid claim code is required.' });
  }
  if (!termsAccepted) {
    return res.status(422).json({ error: 'Account terms acceptance is required to finish setup.' });
  }
  if (!normalizedEmail) {
    return res.status(422).json({ error: 'A valid email is required.' });
  }
  if (!normalizedPhone) {
    return res.status(422).json({ error: 'A valid phone number is required.' });
  }
  if (!password) {
    return res.status(422).json({ error: 'Choose a password to finish setup.' });
  }

  const passwordValidation = validatePerformerPasswordStrength(password);
  if (!passwordValidation.ok) {
    return res.status(422).json({ error: passwordValidation.error });
  }
  if (!confirmPassword || password !== confirmPassword) {
    return res.status(422).json({ error: 'Password confirmation does not match.' });
  }
  if (await performerSignupEmailExists(businessDb, normalizedEmail)) {
    return res.status(409).json({ error: 'This email is already in use on another account.' });
  }

  const passwordHash = await hashPerformerPassword(password);

  try {
    const outcome = await businessDb.transaction(async (tx) => {
      const claim = await performerLoginChallengeStore.consumeChallengeFromToken({
        token,
        expectedChallengeType: PERFORMER_LOGIN_CHALLENGE_TYPE_CLAIM_CODE,
        executor: tx
      });

      if (!claim?.actorUserId) return null;

      const metadata = claim.challengeMetadata && typeof claim.challengeMetadata === 'object'
        ? claim.challengeMetadata as Record<string, unknown>
        : {};
      const performerId = typeof metadata.performerId === 'string' && UUID_PATTERN.test(metadata.performerId)
        ? metadata.performerId
        : null;
      if (!performerId) return null;

      const [account] = await tx
        .select({
          userId: users.id,
          performerId: performers.id,
          passwordHash: users.passwordHash
        })
        .from(users)
        .innerJoin(performers, eq(performers.ownerUserId, users.id))
        .where(and(
          eq(users.id, claim.actorUserId),
          eq(performers.id, performerId)
        ))
        .limit(1);

      if (!account) return null;

      // The one deliberate difference from the invite-accept flow: no
      // "already has a password" guard. Whatever the artist submits here
      // overrides whatever was there before -- that's the handoff.
      const wasHandoff = Boolean(account.passwordHash);
      const completedAt = new Date();
      const [updatedUser] = await tx
        .update(users)
        .set({
          email: normalizedEmail,
          phone: normalizedPhone,
          passwordHash,
          emailVerifiedAt: completedAt,
          termsAcceptedAt: completedAt,
          updatedAt: completedAt
        })
        .where(eq(users.id, account.userId))
        .returning({ id: users.id });

      if (!updatedUser) return null;

      const issuedSession = await performerSessionStore.issueSession({
        actorUserId: account.userId,
        issuedBy: account.userId,
        executor: tx
      });

      await writeAuditEvent(tx, {
        actorId: account.userId,
        actorType: 'performer',
        entityType: 'performer_login_challenge',
        entityId: claim.id,
        eventType: 'performer_claim.accept',
        previousStatus: 'pending',
        nextStatus: 'consumed',
        metadata: {
          performerId: account.performerId,
          accountTermsAcceptedAt: completedAt.toISOString(),
          wasHandoff
        }
      });

      return { issuedSession };
    });

    if (!outcome) {
      return res.status(410).json({ error: 'This claim code is invalid, expired, or already used.' });
    }

    res.cookie(performerSessionStore.cookieName, outcome.issuedSession.token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      path: '/',
      expires: outcome.issuedSession.expiresAt
    });
    return res.status(200).json({ success: true, redirectPath: '/talent' });
  } catch (error) {
    console.warn('Performer claim acceptance failed.', {
      path: req.path,
      ip: req.ip || null,
      reason: error instanceof Error ? error.message : String(error)
    });
    return res.status(500).json({ error: 'Unable to finish performer claim right now.' });
  }
});

app.post('/api/talent/password-reset/accept', async (req, res) => {
  applyNoStoreHeaders(res);

  if (!businessDb || !performerLoginChallengeStore.hasDurableStore || !performerSessionStore.hasDurableStore) {
    return res.status(503).json({ error: 'Owner password reset is temporarily unavailable.' });
  }

  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  const password = normalizePerformerPassword(req.body?.password);
  const confirmPassword = normalizePerformerPassword(req.body?.confirmPassword);
  const requesterIpHash = hashPerformerLoginRequesterIp(req.ip || null);
  const rateLimitResult = performerSignupRateLimiter.consume({
    requesterIpHash,
    targetEmail: '__talent_password_reset__'
  });

  if (!rateLimitResult.allowed) {
    return res.status(429).json({ error: 'Too many password reset attempts. Please try again later.' });
  }
  if (!token || !password) {
    return res.status(422).json({ error: 'A valid one-time reset link and new password are required.' });
  }

  const passwordValidation = validatePerformerPasswordStrength(password);
  if (!passwordValidation.ok) {
    return res.status(422).json({ error: passwordValidation.error });
  }
  if (!confirmPassword || password !== confirmPassword) {
    return res.status(422).json({ error: 'Password confirmation does not match.' });
  }

  const passwordHash = await hashPerformerPassword(password);
  try {
    const outcome = await businessDb.transaction(async (tx) => {
      const resetChallenge = await performerLoginChallengeStore.consumeChallengeFromToken({
        token,
        expectedChallengeType: PERFORMER_LOGIN_CHALLENGE_TYPE_PASSWORD_RESET,
        executor: tx
      });
      if (!resetChallenge?.actorUserId) return null;

      const [updatedUser] = await tx
        .update(users)
        .set({
          passwordHash,
          emailVerifiedAt: new Date(),
          updatedAt: new Date()
        })
        .where(eq(users.id, resetChallenge.actorUserId))
        .returning({ id: users.id });
      if (!updatedUser) return null;

      const revokedSessions = await performerSessionStore.revokeActiveSessionsForActorUser({
        actorUserId: updatedUser.id,
        executor: tx
      });
      const issuedSession = await performerSessionStore.issueSession({
        actorUserId: updatedUser.id,
        issuedBy: updatedUser.id,
        executor: tx
      });

      await writeAuditEvent(tx, {
        actorId: updatedUser.id,
        actorType: 'performer',
        entityType: 'performer_login_challenge',
        entityId: resetChallenge.id,
        eventType: 'performer_password_reset.accept',
        previousStatus: 'pending',
        nextStatus: 'consumed',
        metadata: {
          passwordSetByOwner: true,
          revokedSessionCount: revokedSessions.length
        }
      });

      return { issuedSession };
    });

    if (!outcome) {
      return res.status(410).json({ error: 'This reset link is invalid, expired, or already used.' });
    }

    res.cookie(performerSessionStore.cookieName, outcome.issuedSession.token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      path: '/',
      expires: outcome.issuedSession.expiresAt
    });
    return res.status(200).json({ success: true, redirectPath: '/talent' });
  } catch (error) {
    console.warn('Owner password reset failed.', {
      path: req.path,
      ip: req.ip || null,
      reason: error instanceof Error ? error.message : String(error)
    });
    return res.status(500).json({ error: 'Unable to reset this password right now.' });
  }
});

app.post('/api/talent/signup', async (req, res) => {
  applyNoStoreHeaders(res);

  if (isProduction && !hasPerformerLoginEmailConfig) {
    res.status(503).json({ error: 'Performer verification email delivery is temporarily unavailable.' });
    return;
  }

  if (!businessStore.hasDurableStore) {
    res.status(503).json({ error: 'Performer signup requires durable persistence.' });
    return;
  }

  if (!businessDb || !performerLoginChallengeStore.hasDurableStore || !performerSessionStore.hasDurableStore) {
    res.status(503).json({ error: 'Performer signup is temporarily unavailable.' });
    return;
  }

  const normalizedEmail = normalizePerformerLoginEmail(req.body?.email);
  const normalizedHandle = normalizePerformerHandle(req.body?.handle);
  const normalizedDisplayName = normalizePerformerDisplayName(req.body?.displayName);
  const password = normalizePerformerPassword(req.body?.password);
  const confirmPassword = normalizePerformerPassword(req.body?.confirmPassword);
  const termsAccepted = req.body?.termsAccepted === true;
  const requesterIpHash = hashPerformerLoginRequesterIp(req.ip || null);
  const rateLimitResult = performerSignupRateLimiter.consume({
    requesterIpHash,
    targetEmail: '__talent_signup__'
  });

  if (!rateLimitResult.allowed) {
    res.status(429).json({ error: 'Too many performer signup attempts. Please try again later.' });
    return;
  }

  if (!normalizedEmail || !normalizedHandle || !normalizedDisplayName) {
    res.status(422).json({ error: 'Performer name, handle, and email are required.' });
    return;
  }

  if (!termsAccepted) {
    res.status(422).json({ error: 'Terms acceptance is required before creating a performer account.' });
    return;
  }

  if (!password) {
    res.status(422).json({ error: 'Password is required.' });
    return;
  }

  const passwordValidation = validatePerformerPasswordStrength(password);
  if (!passwordValidation.ok) {
    res.status(422).json({ error: passwordValidation.error });
    return;
  }

  if (!confirmPassword || password !== confirmPassword) {
    res.status(422).json({ error: 'Password confirmation does not match.' });
    return;
  }

  if (await performerHandleExists(businessDb, normalizedHandle)) {
    res.status(409).json({ error: 'This handle is already taken.' });
    return;
  }

  if (await performerSignupEmailExists(businessDb, normalizedEmail)) {
    res.status(409).json({ error: 'This email or handle is already in use.' });
    return;
  }

  try {
    const outcome = await businessDb.transaction(async (tx) => {
      const passwordHash = await hashPerformerPassword(password);
      const [createdUser] = await tx
        .insert(users)
        .values({
          email: normalizedEmail,
          displayName: normalizedDisplayName,
          passwordHash,
          emailVerifiedAt: null,
          termsAcceptedAt: new Date(),
          role: 'performer',
          // Performer signup begins Pro Mode onboarding immediately -- there is
          // no separate performer account type, just the universal users row
          // starting past the patron default of 'disabled'.
          proModeStatus: 'onboarding'
        })
        .returning({
          id: users.id
        });

      await tx.insert(proModeStatusEvents).values({
        userId: createdUser.id,
        previousStatus: 'disabled',
        nextStatus: 'onboarding',
        reason: 'performer_signup',
        actorUserId: createdUser.id
      });

      const [createdPerformer] = await tx
        .insert(performers)
        .values({
          ownerUserId: createdUser.id,
          handle: normalizedHandle,
          displayName: normalizedDisplayName,
          isActive: false,
          onboardingStatus: 'profile_started'
        })
        .returning({
          id: performers.id
        });

      const issuedChallenge = await performerLoginChallengeStore.issueChallenge({
        actorUserId: createdUser.id,
        targetEmail: normalizedEmail,
        challengeType: PERFORMER_LOGIN_CHALLENGE_TYPE_VERIFY_EMAIL,
        requesterIpHash,
        executor: tx
      });

      await writeAuditEvent(tx, {
        actorId: createdUser.id,
        actorType: 'performer',
        entityType: 'user',
        entityId: createdUser.id,
        eventType: 'performer_signup.user_create',
        previousStatus: null,
        nextStatus: 'created',
        metadata: {
          targetEmail: normalizedEmail,
          emailVerifiedAt: null
        }
      });

      await writeAuditEvent(tx, {
        actorId: createdUser.id,
        actorType: 'performer',
        entityType: 'performer',
        entityId: createdPerformer.id,
        eventType: 'performer_signup.profile_create',
        previousStatus: null,
        nextStatus: 'profile_started',
        metadata: {
          handle: normalizedHandle,
          isActive: false
        }
      });

      await writeAuditEvent(tx, {
        actorId: createdUser.id,
        actorType: 'performer',
        entityType: 'performer_login_challenge',
        entityId: issuedChallenge.challengeId,
        eventType: 'performer_verify_email.issue',
        previousStatus: null,
        nextStatus: 'pending',
        metadata: {
          targetEmail: normalizedEmail,
          challengeType: PERFORMER_LOGIN_CHALLENGE_TYPE_VERIFY_EMAIL
        }
      });

      return {
        createdUserId: createdUser.id,
        challengeId: issuedChallenge.challengeId,
        token: issuedChallenge.token
      };
    });

    const appBaseUrl = resolvePerformerLoginBaseUrl(process.env).replace(/\/+$/, '');
    const verificationLink = `${appBaseUrl}/api/talent/verify-email/consume?token=${encodeURIComponent(outcome.token)}`;
    const deliveryResult = await performerLoginMailer.sendVerificationLink({
      toEmail: normalizedEmail,
      verificationLink
    });

    if (!deliveryResult.delivered) {
      // The account was already created in the transaction above. If we only
      // revoke the challenge and stop here, the handle and email are
      // permanently squatted by a dead, unverifiable account -- signup can
      // never be retried with either one, and there's no resend-verification
      // endpoint to recover it. Any transient email-provider failure (not
      // just misconfiguration) would strand a real signup forever. Fully
      // undo the account creation so the person can just try again.
      await businessDb.transaction(async (tx) => {
        await tx.delete(performerLoginChallenges).where(eq(performerLoginChallenges.id, outcome.challengeId));
        await tx.delete(performers).where(eq(performers.ownerUserId, outcome.createdUserId));
        await tx.delete(users).where(eq(users.id, outcome.createdUserId));
      });
      res.status(503).json({ error: 'Performer verification email delivery is temporarily unavailable. Please try signing up again.' });
      return;
    }

    res.status(202).json(performerSignupSuccessResponse(
      deliveryResult.provider === 'mock' ? verificationLink : undefined
    ));
  } catch (error) {
    if (
      isUniqueConstraintViolation(error, 'idx_performers_handle') ||
      isUniqueConstraintViolation(error, 'idx_performers_handle_lower')
    ) {
      res.status(409).json({ error: 'This handle is already taken.' });
      return;
    }

    if (isUniqueConstraintViolation(error, 'users_email_idx')) {
      res.status(409).json({ error: 'This email or handle is already in use.' });
      return;
    }

    console.warn('Performer signup failed.', {
      path: req.path,
      ip: req.ip || null,
      reason: error instanceof Error ? error.message : String(error)
    });
    res.status(500).json({ error: 'Unable to create your performer account right now.' });
  }
});

app.post('/api/talent/login', async (req, res) => {
  applyNoStoreHeaders(res);

  if (!businessStore.hasDurableStore) {
    res.status(503).json({ error: 'Performer login requires durable persistence.' });
    return;
  }

  if (!businessDb || !performerSessionStore.hasDurableStore) {
    res.status(503).json({ error: 'Performer login is temporarily unavailable.' });
    return;
  }

  const normalizedEmail = normalizePerformerLoginEmail(req.body?.email);
  const password = normalizePerformerPassword(req.body?.password);
  const requesterIpHash = hashPerformerLoginRequesterIp(req.ip || null);
  const accountKey = normalizedEmail ?? '__invalid__';
  const rateLimitState = performerPasswordLoginRateLimiter.check({
    requesterIpHash,
    accountKey
  });

  if (!rateLimitState.allowed) {
    res.status(429).json({ error: 'Too many failed sign-in attempts. Please try again later.' });
    return;
  }

  if (!normalizedEmail || !password) {
    performerPasswordLoginRateLimiter.recordFailure({
      requesterIpHash,
      accountKey
    });
    res.status(401).json(performerCredentialFailureResponse());
    return;
  }

  const performerAccount = await loadPerformerPasswordAccountByEmail(businessDb, normalizedEmail);
  if (!performerAccount?.passwordHash) {
    performerPasswordLoginRateLimiter.recordFailure({
      requesterIpHash,
      accountKey
    });
    res.status(401).json(performerCredentialFailureResponse());
    return;
  }

  const passwordMatches = await verifyPerformerPassword(password, performerAccount.passwordHash);
  if (!passwordMatches) {
    performerPasswordLoginRateLimiter.recordFailure({
      requesterIpHash,
      accountKey
    });
    res.status(401).json(performerCredentialFailureResponse());
    return;
  }

  const redirectPath = resolvePerformerLoginRedirectPath(req.body?.redirect ?? req.query.redirect);

  const outcome = await businessDb.transaction(async (tx) => {
    const revokedSessions = await performerSessionStore.revokeActiveSessionsForActorUser({
      actorUserId: performerAccount.actorUserId,
      executor: tx
    });
    const issuedSession = await performerSessionStore.issueSession({
      actorUserId: performerAccount.actorUserId,
      issuedBy: performerAccount.actorUserId,
      executor: tx
    });

    for (const revokedSession of revokedSessions) {
      await writeAuditEvent(tx, {
        actorId: performerAccount.actorUserId,
        actorType: 'performer',
        entityType: 'performer_session',
        entityId: revokedSession.id,
        eventType: 'performer_session.revoke',
        previousStatus: 'active',
        nextStatus: 'revoked',
        metadata: {
          revokedActorUserId: revokedSession.actorUserId,
          revokedBy: 'performer_login.password'
        }
      });
    }

    await writeAuditEvent(tx, {
      actorId: performerAccount.actorUserId,
      actorType: 'performer',
      entityType: 'performer_session',
      entityId: issuedSession.sessionId,
      eventType: 'performer_session.issue',
      previousStatus: null,
      nextStatus: 'active',
      metadata: {
        expiresAt: issuedSession.expiresAt.toISOString(),
        source: 'performer_login.password'
      }
    });

    return {
      issuedSession
    };
  });

  performerPasswordLoginRateLimiter.reset({
    requesterIpHash,
    accountKey
  });

  res.cookie(performerSessionStore.cookieName, outcome.issuedSession.token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    expires: outcome.issuedSession.expiresAt
  });
  res.json(performerPasswordLoginSuccessResponse(redirectPath || '/talent'));
});

app.post('/api/talent/login/request', async (req, res) => {
  applyNoStoreHeaders(res);

  if (!businessStore.hasDurableStore) {
    res.status(503).json({ error: 'Performer login requires durable persistence.' });
    return;
  }

  if (!businessDb || !performerLoginChallengeStore.hasDurableStore || !performerSessionStore.hasDurableStore) {
    res.status(503).json({ error: 'Performer login is temporarily unavailable.' });
    return;
  }

  const rawEmailInput = typeof req.body?.email === 'string'
    ? req.body.email.trim().toLowerCase()
    : '';
  const normalizedEmail = normalizePerformerLoginEmail(req.body?.email);
  const requesterIpHash = hashPerformerLoginRequesterIp(req.ip || null);
  const rateLimitKeyEmail = normalizedEmail ?? rawEmailInput ?? '__invalid__';
  const rateLimitResult = performerLoginRateLimiter.consume({
    requesterIpHash,
    targetEmail: rateLimitKeyEmail
  });

  if (!rateLimitResult.allowed) {
    res.status(202).json(performerLoginSuccessResponse());
    return;
  }

  if (!normalizedEmail) {
    res.status(202).json(performerLoginSuccessResponse());
    return;
  }

  const performerOwner = await loadAuthorizedPerformerOwnerByEmail(normalizedEmail);
  if (!performerOwner) {
    res.status(202).json(performerLoginSuccessResponse());
    return;
  }

  const issuedChallenge = await performerLoginChallengeStore.issueChallenge({
    actorUserId: performerOwner.actorUserId,
    challengeType: PERFORMER_LOGIN_CHALLENGE_TYPE_LOGIN,
    targetEmail: normalizedEmail,
    requesterIpHash
  });

  const appBaseUrl = resolvePerformerLoginBaseUrl(process.env).replace(/\/+$/, '');
  const magicLink = `${appBaseUrl}/api/talent/login/consume?token=${encodeURIComponent(issuedChallenge.token)}`;
  const deliveryResult = await performerLoginMailer.sendMagicLink({
    toEmail: normalizedEmail,
    magicLink
  });

  if (!deliveryResult.delivered) {
    await performerLoginChallengeStore.revokeChallengeById({
      challengeId: issuedChallenge.challengeId
    });
  }

  res.status(202).json(performerLoginSuccessResponse());
});

app.get('/api/talent/login/consume', async (req, res) => {
  applyNoStoreHeaders(res);

  const redirectPath = resolvePerformerLoginRedirectPath(req.query.redirect);
  if (!businessStore.hasDurableStore) {
    return res.redirect(performerLoginFailureRedirect('unavailable'));
  }

  if (!businessDb || !performerLoginChallengeStore.hasDurableStore || !performerSessionStore.hasDurableStore) {
    return res.redirect(performerLoginFailureRedirect('unavailable'));
  }

  const token = typeof req.query.token === 'string' ? req.query.token.trim() : '';
  if (!token) {
    return res.redirect(performerLoginFailureRedirect());
  }

  try {
    const outcome = await businessDb.transaction(async (tx) => {
      const consumedChallenge = await performerLoginChallengeStore.consumeChallengeFromToken({
        token,
        executor: tx
      });

      if (!consumedChallenge) {
        return null;
      }

      if (consumedChallenge.challengeType !== PERFORMER_LOGIN_CHALLENGE_TYPE_LOGIN || !consumedChallenge.actorUserId) {
        return null;
      }

      const stillAuthorized = await actorHasDurableTalentAccess(tx, consumedChallenge.actorUserId);
      if (!stillAuthorized) {
        throw new Error('actor_no_longer_authorized');
      }

      await tx
        .update(users)
        .set({
          emailVerifiedAt: new Date()
        })
        .where(and(
          eq(users.id, consumedChallenge.actorUserId),
          isNull(users.emailVerifiedAt)
        ));

      await tx
        .update(performers)
        .set({
          isActive: true
        })
        .where(and(
          eq(performers.ownerUserId, consumedChallenge.actorUserId),
          eq(performers.isActive, false)
        ));

      const revokedSessions = await performerSessionStore.revokeActiveSessionsForActorUser({
        actorUserId: consumedChallenge.actorUserId,
        executor: tx
      });
      const issuedSession = await performerSessionStore.issueSession({
        actorUserId: consumedChallenge.actorUserId,
        issuedBy: consumedChallenge.actorUserId,
        executor: tx
      });

      await writeAuditEvent(tx, {
        actorId: consumedChallenge.actorUserId,
        actorType: 'performer',
        entityType: 'performer_login_challenge',
        entityId: consumedChallenge.id,
        eventType: 'performer_login.consume',
        previousStatus: 'pending',
        nextStatus: 'consumed',
        metadata: {
          targetEmail: consumedChallenge.targetEmail,
          requestedAt: consumedChallenge.requestedAt.toISOString()
        }
      });

      for (const revokedSession of revokedSessions) {
        await writeAuditEvent(tx, {
          actorId: consumedChallenge.actorUserId,
          actorType: 'performer',
          entityType: 'performer_session',
          entityId: revokedSession.id,
          eventType: 'performer_session.revoke',
          previousStatus: 'active',
          nextStatus: 'revoked',
          metadata: {
            revokedActorUserId: revokedSession.actorUserId,
            revokedBy: 'performer_login.consume'
          }
        });
      }

      await writeAuditEvent(tx, {
        actorId: consumedChallenge.actorUserId,
        actorType: 'performer',
        entityType: 'performer_session',
        entityId: issuedSession.sessionId,
        eventType: 'performer_session.issue',
        previousStatus: null,
        nextStatus: 'active',
        metadata: {
          expiresAt: issuedSession.expiresAt.toISOString(),
          source: 'performer_login.consume'
        }
      });

      return {
        issuedSession
      };
    });

    if (!outcome) {
      return res.redirect(performerLoginFailureRedirect());
    }

    res.cookie(performerSessionStore.cookieName, outcome.issuedSession.token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      path: '/',
      expires: outcome.issuedSession.expiresAt
    });
    return res.redirect(redirectPath || '/talent');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (reason !== 'actor_no_longer_authorized') {
      console.warn('Performer login consume failed.', {
        path: req.path,
        ip: req.ip || null,
        reason
      });
    }
    return res.redirect(performerLoginFailureRedirect());
  }
});

app.get('/api/talent/verify-email/consume', async (req, res) => {
  applyNoStoreHeaders(res);

  // Unlike password/magic-link login, consuming a verify-email token never
  // establishes a session -- redirecting to /talent would just bounce back
  // to a bare /talent/login, silently dropping the "email verified" banner.
  // Only honor an explicit ?redirect= the caller actually supplied.
  const redirectPath = typeof req.query.redirect === 'string'
    ? resolvePerformerLoginRedirectPath(req.query.redirect)
    : null;

  if (!businessStore.hasDurableStore) {
    return res.redirect(performerVerifyEmailFailureRedirect('unavailable'));
  }

  if (!businessDb || !performerLoginChallengeStore.hasDurableStore) {
    return res.redirect(performerVerifyEmailFailureRedirect('unavailable'));
  }

  const token = typeof req.query.token === 'string' ? req.query.token.trim() : '';
  if (!token) {
    return res.redirect(performerVerifyEmailFailureRedirect());
  }

  try {
    const verified = await businessDb.transaction(async (tx) => {
      const consumedChallenge = await performerLoginChallengeStore.consumeChallengeFromToken({
        token,
        executor: tx
      });

      if (!consumedChallenge) {
        return null;
      }

      if (consumedChallenge.challengeType !== PERFORMER_LOGIN_CHALLENGE_TYPE_VERIFY_EMAIL || !consumedChallenge.actorUserId) {
        return null;
      }

      const verifiedAt = new Date();
      await tx
        .update(users)
        .set({
          emailVerifiedAt: verifiedAt
        })
        .where(eq(users.id, consumedChallenge.actorUserId));

      const [verifiedPerformer] = await tx
        .update(performers)
        .set({
          isActive: true
        })
        .where(eq(performers.ownerUserId, consumedChallenge.actorUserId))
        .returning({
          id: performers.id
        });

      await writeAuditEvent(tx, {
        actorId: consumedChallenge.actorUserId,
        actorType: 'performer',
        entityType: 'performer_login_challenge',
        entityId: consumedChallenge.id,
        eventType: 'performer_verify_email.consume',
        previousStatus: 'pending',
        nextStatus: 'consumed',
        metadata: {
          targetEmail: consumedChallenge.targetEmail,
          verifiedAt: verifiedAt.toISOString()
        }
      });

      await writeAuditEvent(tx, {
        actorId: consumedChallenge.actorUserId,
        actorType: 'performer',
        entityType: 'user',
        entityId: consumedChallenge.actorUserId,
        eventType: 'performer_verify_email.complete',
        previousStatus: 'unverified',
        nextStatus: 'verified',
        metadata: {
          targetEmail: consumedChallenge.targetEmail
        }
      });

      if (verifiedPerformer) {
        await writeAuditEvent(tx, {
          actorId: consumedChallenge.actorUserId,
          actorType: 'performer',
          entityType: 'performer',
          entityId: verifiedPerformer.id,
          eventType: 'performer_verify_email.activate',
          previousStatus: 'inactive',
          nextStatus: 'active',
          metadata: {
            targetEmail: consumedChallenge.targetEmail
          }
        });
      }

      return true;
    });

    if (!verified) {
      return res.redirect(performerVerifyEmailFailureRedirect());
    }

    return res.redirect(redirectPath || performerVerifyEmailSuccessRedirect());
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn('Performer verify-email consume failed.', {
      path: req.path,
      ip: req.ip || null,
      reason
    });
    return res.redirect(performerVerifyEmailFailureRedirect());
  }
});

app.get('/api/talent/session/bootstrap', async (req, res) => {
  applyNoStoreHeaders(res);

  if (!requirePersistentBusinessStore(res)) {
    return;
  }

  if (!performerSessionStore.hasDurableStore) {
    res.status(503).json({
      error: 'Performer browser session bootstrap requires durable session persistence.'
    });
    return;
  }

  const bootstrapSecret = process.env.SWAY_PERFORMER_BOOTSTRAP_SECRET?.trim() || '';
  if (!bootstrapSecret) {
    res.status(503).json({
      error: 'Performer browser session bootstrap is not configured.'
    });
    return;
  }

  const bootstrapToken = typeof req.query.token === 'string' ? req.query.token.trim() : '';
  const verifiedBootstrap = verifyPerformerBootstrapToken(bootstrapToken, bootstrapSecret);
  if (!verifiedBootstrap.valid) {
    console.warn('Performer bootstrap token rejected.', {
      path: req.path,
      ip: req.ip || null,
      reason: verifiedBootstrap.reason
    });
    res.status(401).json({ error: 'Valid performer session bootstrap token required.' });
    return;
  }

  const actor = await resolveBootstrapTalentActor(verifiedBootstrap.claims.actorUserId);
  if (!actor) {
    console.warn('Performer bootstrap actor rejected.', {
      path: req.path,
      ip: req.ip || null,
      actorUserId: verifiedBootstrap.claims.actorUserId
    });
    res.status(403).json({ error: 'Authorized performer access is required.' });
    return;
  }

  const issuedSession = await performerSessionStore.issueSession({
    actorUserId: actor.actorId,
    issuedBy: actor.actorId
  });

  if (businessDb) {
    await writeAuditEvent(businessDb, {
      actorId: actor.actorId,
      actorType: actor.actorType,
      entityType: 'performer_session',
      entityId: issuedSession.sessionId,
      eventType: 'performer_session.issue',
      previousStatus: null,
      nextStatus: 'active',
      metadata: {
        expiresAt: issuedSession.expiresAt.toISOString()
      }
    });
  }

  res.cookie(performerSessionStore.cookieName, issuedSession.token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    expires: issuedSession.expiresAt
  });
  res.redirect('/talent');
});

app.post('/api/talent/session/logout', async (req, res) => {
  applyNoStoreHeaders(res);

  const actor = accessControl.resolveServerActor(req);
  const sessionToken = performerSessionStore.readSessionTokenFromRequest(req);
  const revokedSession = sessionToken
    ? await performerSessionStore.revokeSessionFromToken(sessionToken)
    : null;

  res.clearCookie(performerSessionStore.cookieName, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/'
  });

  if (businessDb && revokedSession && actor.actorId) {
    await writeAuditEvent(businessDb, {
      actorId: actor.actorId,
      actorType: 'performer',
      entityType: 'performer_session',
      entityId: revokedSession.sessionId,
      eventType: 'performer_session.revoke',
      previousStatus: 'active',
      nextStatus: 'revoked',
      metadata: {
        revokedActorUserId: revokedSession.actorUserId
      }
    });
  }

  res.json({ success: true });
});

// Universal-account Pro Mode surface (Phase 2 Slice 1). Deliberately gated by
// requireAuthenticatedAccountAccess, not requireTalentAccess -- a patron who
// has never touched a performer route must still be able to read and
// activate their own Pro Mode state on the same account.
app.get('/api/account/pro-mode', async (req, res) => {
  applyNoStoreHeaders(res);

  const access = await accessControl.requireAuthenticatedAccountAccess(req);
  if (access.allowed === false) {
    res.status(access.status).json({ error: access.reason });
    return;
  }

  if (!businessDb) {
    res.status(503).json({ error: 'Pro Mode requires durable persistence.' });
    return;
  }

  const status = await getProModeStatus(businessDb, access.actor.actorId!);
  if (!status) {
    res.status(404).json({ error: 'Account not found.' });
    return;
  }

  res.json({ status });
});

app.post('/api/account/pro-mode/activate', async (req, res) => {
  applyNoStoreHeaders(res);

  const access = await accessControl.requireAuthenticatedAccountAccess(req);
  if (access.allowed === false) {
    res.status(access.status).json({ error: access.reason });
    return;
  }

  if (!businessDb) {
    res.status(503).json({ error: 'Pro Mode requires durable persistence.' });
    return;
  }

  const actorId = access.actor.actorId!;
  const transition: ProModeTransitionResult = await applyProModeTransition(businessDb, {
    userId: actorId,
    action: 'self_activate',
    actorUserId: actorId,
    reason: 'patron_self_activate'
  });

  if (transition.allowed === false) {
    res.status(409).json({ error: transition.reason });
    return;
  }

  res.json({ status: transition.nextStatus, changed: transition.changed });
});

app.post('/api/talent/control-bridge/token', async (req, res) => {
  applyNoStoreHeaders(res);

  const actor = await resolveProtectedMutationActor(req, res, parseDurableGigId(req.body?.gig_id));
  if (!actor) return;

  if (!performerSessionStore.hasDurableStore) {
    res.status(503).json({ error: 'Control bridge token issuance requires durable session persistence.' });
    return;
  }

  const bridgeSession = await performerSessionStore.issueSession({
    actorUserId: actor.actorId,
    issuedBy: actor.actorId,
    ttlHours: 2
  });

  const requestOrigin = typeof req.headers.origin === 'string' && req.headers.origin.trim()
    ? req.headers.origin.trim().replace(/\/+$/, '')
    : null;
  const configuredBaseUrl = process.env.SWAY_APP_BASE_URL?.trim().replace(/\/+$/, '') || null;
  const fallbackBaseUrl = `${req.protocol}://${req.get('host')}`;
  const swayUrl = configuredBaseUrl || requestOrigin || fallbackBaseUrl;
  const gigId = parseDurableGigId(req.body?.gig_id);
  const bridgeCommand = gigId
    ? `npm run control:bridge -- --gig-id ${gigId} --auth-token ${bridgeSession.token} --sway-url ${swayUrl}`
    : null;

  if (businessDb) {
    await writeAuditEvent(businessDb, {
      actorId: actor.actorId,
      actorType: actor.actorType,
      entityType: 'performer_session',
      entityId: bridgeSession.sessionId,
      eventType: 'performer_control_bridge.token.issue',
      previousStatus: null,
      nextStatus: 'active',
      metadata: {
        gigId,
        expiresAt: bridgeSession.expiresAt.toISOString(),
        ttlHours: 2,
        tokenTransport: 'bridge_auth_token'
      }
    });
  }

  res.json({
    success: true,
    bridgeToken: bridgeSession.token,
    expiresAt: bridgeSession.expiresAt.toISOString(),
    gigId,
    swayUrl,
    command: bridgeCommand,
    tokenTransport: 'auth-token'
  });
});

const CONTROL_BRIDGE_ACTIONS = new Set([
  'toggle-requests',
  'fulfill-top',
  'hide-top',
  'approve-pending',
  'veto-pending',
  'open-top-source',
  'search-top-spotify',
  'search-top-soundcloud',
  'search-top-youtube'
]);
const CONTROL_BRIDGE_MUTATING_ACTIONS = new Set([
  'toggle-requests',
  'fulfill-top',
  'hide-top',
  'approve-pending',
  'veto-pending'
]);
const CONTROL_BRIDGE_REPLAY_WINDOW_MS = 2500;
const controlBridgeReplayCache = new Map<string, number>();

async function reserveControlBridgeMutation(input: { actor: ProtectedMutationActor; gigId: string; action: string }) {
  if (!CONTROL_BRIDGE_MUTATING_ACTIONS.has(input.action)) {
    return { replay: false, reservation: null };
  }

  const now = Date.now();
  const replayBucket = Math.floor(now / CONTROL_BRIDGE_REPLAY_WINDOW_MS);
  const replayKey = `${input.actor.actorId}:${input.gigId}:${input.action}:${replayBucket}`;
  const durableMutation = buildDurableActorActionInput({
    actor: input.actor,
    gigId: input.gigId,
    actionType: `control_bridge.${input.action}`,
    targetEntityType: 'control_bridge_action',
    targetEntityId: replayKey,
    idempotencyKeySeed: String(replayBucket),
    payload: {
      action: input.action,
      replayBucket,
      replayWindowMs: CONTROL_BRIDGE_REPLAY_WINDOW_MS
    }
  });
  const durableReplay = await reserveDurableActorMutation(durableMutation);
  if (durableReplay.kind === 'replay') {
    return { replay: true, replayKey, reservation: durableMutation, durableReplay };
  }
  if (durableReplay.kind === 'expired' || durableReplay.kind === 'misuse') {
    return { replay: true, replayKey, reservation: durableMutation, durableReplay };
  }

  for (const [key, expiresAt] of controlBridgeReplayCache.entries()) {
    if (expiresAt <= now) controlBridgeReplayCache.delete(key);
  }

  const processReplayKey = `${input.actor.actorId}:${input.gigId}:${input.action}`;
  const existingExpiresAt = controlBridgeReplayCache.get(processReplayKey);
  if (existingExpiresAt && existingExpiresAt > now) {
    return { replay: true, replayKey: processReplayKey, reservation: durableMutation };
  }

  controlBridgeReplayCache.set(processReplayKey, now + CONTROL_BRIDGE_REPLAY_WINDOW_MS);
  return { replay: false, replayKey: processReplayKey, reservation: durableMutation };
}

app.post('/api/talent/control-bridge/action/:action', async (req, res) => {
  applyNoStoreHeaders(res);

  const action = req.params.action;
  if (!CONTROL_BRIDGE_ACTIONS.has(action)) {
    res.status(404).json({ error: 'Unknown control bridge action.' });
    return;
  }

  const roomContext = await resolveLegacyWritableRoom(req, res);
  if (!roomContext) return;

  const actor = await resolveProtectedMutationActor(req, res, roomContext.gigId);
  if (!actor) return;

  const replayGuard = await reserveControlBridgeMutation({
    actor,
    gigId: roomContext.gigId,
    action
  });
  if (replayGuard.replay) {
    if (replayGuard.durableReplay?.kind === 'expired' || replayGuard.durableReplay?.kind === 'misuse') {
      sendDurableMutationReplay(res, replayGuard.durableReplay);
      return;
    }
    await writeMutationNoopAudit({
      gigId: roomContext.gigId,
      actor,
      entityType: 'control_bridge_action',
      entityId: replayGuard.replayKey ?? `${actor.actorId}:${roomContext.gigId}:${action}`,
      eventType: `control_bridge.${action}`,
      previousStatus: 'recently_applied',
      nextStatus: 'replay_noop',
      reason: 'control_bridge_replay_window',
      metadata: {
        action,
        replayWindowMs: CONTROL_BRIDGE_REPLAY_WINDOW_MS
      }
    });
    res.json({
      success: true,
      action,
      noop: true,
      noopReason: 'control_bridge_replay_window'
    });
    return;
  }

  const roomState = roomContext.state;

  if (action === 'toggle-requests') {
    const result = await applyWindowToggle({ roomContext, actor, nextOpen: !roomState.session.requestsOpen });
    const responseBody = { success: true, action, ...result };
    await completeDurableActorMutation({ reservation: replayGuard.reservation, status: 200, body: responseBody });
    res.json(responseBody);
    return;
  }

  if (action === 'fulfill-top' || action === 'hide-top') {
    const request = topApprovedRoomRequest(roomState);
    if (!request) {
      res.status(409).json({ error: 'No approved request is available.' });
      return;
    }
    const requestContext = { gigId: roomContext.gigId, state: roomState, request };
    const result = action === 'fulfill-top'
      ? await applyRequestFulfill({ roomContext: requestContext, actor })
      : await applyRequestHide({ roomContext: requestContext, actor, reason: 'control_bridge' });
    const responseBody = { success: true, action, ...result };
    await completeDurableActorMutation({ reservation: replayGuard.reservation, status: 200, body: responseBody });
    res.json(responseBody);
    return;
  }

  if (action === 'approve-pending' || action === 'veto-pending') {
    const request = topPendingRoomRequest(roomState);
    if (!request) {
      res.status(409).json({ error: 'No pending request is available.' });
      return;
    }
    const requestContext = { gigId: roomContext.gigId, state: roomState, request };
    const result = await applyRequestTriage({
      roomContext: requestContext,
      actor,
      action: action === 'approve-pending' ? 'approve' : 'deny'
    });
    const responseBody = { success: true, action, ...result };
    await completeDurableActorMutation({ reservation: replayGuard.reservation, status: 200, body: responseBody });
    res.json(responseBody);
    return;
  }

  const approved = topApprovedRoomRequest(roomState);
  if (!approved) {
    res.status(409).json({ error: 'No approved request is available.' });
    return;
  }

  if (action === 'open-top-source') {
    if (!approved.spotifyUrl) {
      res.status(409).json({ error: 'Top request has no source URL.' });
      return;
    }
    res.json({
      success: true,
      action,
      result: { openUrl: approved.spotifyUrl, title: approved.title, subtitle: approved.subtitle }
    });
    return;
  }

  const providerKey = action.replace(/^search-top-/, '');
  const provider = CONTROL_BRIDGE_SEARCH_PROVIDERS[providerKey];
  const text = controlBridgeRequestText(approved);
  if (!provider || !text) {
    res.status(409).json({ error: 'No approved request is available.' });
    return;
  }

  res.json({
    success: true,
    action,
    result: { openUrl: provider.url(text), title: approved.title, subtitle: approved.subtitle }
  });
});

app.post('/api/admin/bootstrap', async (req, res) => {
  applyNoStoreHeaders(res);

  if (!businessStore.hasDurableStore || !businessDb) {
    res.status(503).json({ error: 'Admin bootstrap requires durable persistence.' });
    return;
  }

  const bootstrapSecret = process.env.SWAY_ADMIN_BOOTSTRAP_SECRET?.trim() || '';
  if (!bootstrapSecret) {
    res.status(503).json({ error: 'Admin bootstrap is not configured.' });
    return;
  }

  const requesterIpHash = hashPerformerLoginRequesterIp(req.ip || null);
  const rateLimitResult = adminBootstrapRateLimiter.consume({
    requesterIpHash,
    targetEmail: '__admin_bootstrap__'
  });

  if (!rateLimitResult.allowed) {
    res.status(429).json({ error: 'Too many admin bootstrap attempts. Please try again later.' });
    return;
  }

  const providedSecretBuffer = Buffer.from(typeof req.body?.secret === 'string' ? req.body.secret : '');
  const expectedSecretBuffer = Buffer.from(bootstrapSecret);
  const secretMatches =
    providedSecretBuffer.length === expectedSecretBuffer.length &&
    timingSafeEqual(providedSecretBuffer, expectedSecretBuffer);

  if (!secretMatches) {
    console.warn('Admin bootstrap secret rejected.', { path: req.path, ip: req.ip || null });
    res.status(401).json({ error: 'Invalid admin bootstrap secret.' });
    return;
  }

  const normalizedEmail = normalizePerformerLoginEmail(req.body?.email);
  const normalizedDisplayName = normalizePerformerDisplayName(req.body?.displayName);
  const password = normalizePerformerPassword(req.body?.password);
  const confirmPassword = normalizePerformerPassword(req.body?.confirmPassword);

  if (!normalizedEmail || !normalizedDisplayName) {
    res.status(422).json({ error: 'Admin name and email are required.' });
    return;
  }

  if (!password) {
    res.status(422).json({ error: 'Password is required.' });
    return;
  }

  const passwordValidation = validatePerformerPasswordStrength(password);
  if (!passwordValidation.ok) {
    res.status(422).json({ error: passwordValidation.error });
    return;
  }

  if (!confirmPassword || password !== confirmPassword) {
    res.status(422).json({ error: 'Password confirmation does not match.' });
    return;
  }

  const [existingUser] = await businessDb
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${normalizedEmail}`)
    .limit(1);

  if (existingUser) {
    res.status(409).json({ error: 'This email is already in use.' });
    return;
  }

  const passwordHash = await hashPerformerPassword(password);
  const [createdAdmin] = await businessDb
    .insert(users)
    .values({
      email: normalizedEmail,
      displayName: normalizedDisplayName,
      passwordHash,
      emailVerifiedAt: new Date(),
      termsAcceptedAt: new Date(),
      role: 'admin'
    })
    .returning({ id: users.id });

  await writeAuditEvent(businessDb, {
    actorId: createdAdmin.id,
    actorType: 'admin',
    entityType: 'user',
    entityId: createdAdmin.id,
    eventType: 'admin_bootstrap.user_create',
    previousStatus: null,
    nextStatus: 'created',
    metadata: {
      targetEmail: normalizedEmail
    }
  });

  res.status(201).json({ success: true, message: 'Admin account created. Log in at /admin/login.' });
});

app.post('/api/admin/login', async (req, res) => {
  applyNoStoreHeaders(res);

  if (!businessStore.hasDurableStore) {
    res.status(503).json({ error: 'Admin login requires durable persistence.' });
    return;
  }

  if (!businessDb || !performerSessionStore.hasDurableStore) {
    res.status(503).json({ error: 'Admin login is temporarily unavailable.' });
    return;
  }

  const normalizedEmail = normalizePerformerLoginEmail(req.body?.email);
  const password = normalizePerformerPassword(req.body?.password);
  const requesterIpHash = hashPerformerLoginRequesterIp(req.ip || null);
  const accountKey = normalizedEmail ?? '__invalid__';
  const rateLimitState = adminPasswordLoginRateLimiter.check({
    requesterIpHash,
    accountKey
  });

  if (!rateLimitState.allowed) {
    res.status(429).json({ error: 'Too many failed sign-in attempts. Please try again later.' });
    return;
  }

  if (!normalizedEmail || !password) {
    adminPasswordLoginRateLimiter.recordFailure({ requesterIpHash, accountKey });
    res.status(401).json(performerCredentialFailureResponse());
    return;
  }

  const [adminAccount] = await businessDb
    .select({
      actorUserId: users.id,
      passwordHash: users.passwordHash,
      role: users.role
    })
    .from(users)
    .where(sql`lower(${users.email}) = ${normalizedEmail}`)
    .limit(1);

  if (!adminAccount?.passwordHash || (adminAccount.role !== 'admin' && adminAccount.role !== 'support')) {
    adminPasswordLoginRateLimiter.recordFailure({ requesterIpHash, accountKey });
    res.status(401).json(performerCredentialFailureResponse());
    return;
  }

  const passwordMatches = await verifyPerformerPassword(password, adminAccount.passwordHash);
  if (!passwordMatches) {
    adminPasswordLoginRateLimiter.recordFailure({ requesterIpHash, accountKey });
    res.status(401).json(performerCredentialFailureResponse());
    return;
  }

  const outcome = await businessDb.transaction(async (tx) => {
    const revokedSessions = await performerSessionStore.revokeActiveSessionsForActorUser({
      actorUserId: adminAccount.actorUserId,
      executor: tx
    });
    const issuedSession = await performerSessionStore.issueSession({
      actorUserId: adminAccount.actorUserId,
      issuedBy: adminAccount.actorUserId,
      executor: tx
    });

    for (const revokedSession of revokedSessions) {
      await writeAuditEvent(tx, {
        actorId: adminAccount.actorUserId,
        actorType: 'admin',
        entityType: 'performer_session',
        entityId: revokedSession.id,
        eventType: 'performer_session.revoke',
        previousStatus: 'active',
        nextStatus: 'revoked',
        metadata: {
          revokedActorUserId: revokedSession.actorUserId,
          revokedBy: 'admin_login.password'
        }
      });
    }

    await writeAuditEvent(tx, {
      actorId: adminAccount.actorUserId,
      actorType: 'admin',
      entityType: 'performer_session',
      entityId: issuedSession.sessionId,
      eventType: 'performer_session.issue',
      previousStatus: null,
      nextStatus: 'active',
      metadata: {
        expiresAt: issuedSession.expiresAt.toISOString(),
        source: 'admin_login.password'
      }
    });

    return { issuedSession };
  });

  adminPasswordLoginRateLimiter.reset({ requesterIpHash, accountKey });

  res.cookie(performerSessionStore.cookieName, outcome.issuedSession.token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    expires: outcome.issuedSession.expiresAt
  });
  res.json(performerPasswordLoginSuccessResponse('/admin'));
});

const VALID_USER_ROLES = new Set<string>(userRoleEnum.enumValues);
const VALID_ONBOARDING_STATUSES = new Set<string>(performerOnboardingStatusEnum.enumValues);

const adminAccountSelectColumns = {
  id: users.id,
  email: users.email,
  displayName: users.displayName,
  role: users.role,
  passwordSetupRequired: sql<boolean>`${users.passwordHash} is null`,
  emailVerifiedAt: users.emailVerifiedAt,
  createdAt: users.createdAt,
  performerId: performers.id,
  handle: performers.handle,
  performerDisplayName: performers.displayName,
  isActive: performers.isActive,
  onboardingStatus: performers.onboardingStatus,
  paymentAccountStatus: performers.paymentAccountStatus,
  payoutsEnabled: performers.payoutsEnabled,
  chargesEnabled: performers.chargesEnabled,
  payoutHoldReason: performers.payoutHoldReason,
  partnerEntitlementId: performerPartnerEntitlements.id,
  partnerTermsVersion: performerPartnerEntitlements.termsVersion,
  partnerTermsHash: performerPartnerEntitlements.termsHash,
  partnerGrantedAt: performerPartnerEntitlements.grantedAt,
  partnerKind: performerPartnerEntitlements.partnerKind,
  partnerAcceptedAt: sql<Date | null>`(
    select ${performerPartnerTermsAcceptances.acceptedAt}
    from ${performerPartnerTermsAcceptances}
    where ${performerPartnerTermsAcceptances.entitlementId} = ${performerPartnerEntitlements.id}
      and ${performerPartnerTermsAcceptances.accountUserId} = ${users.id}
      and ${performerPartnerTermsAcceptances.termsHash} = ${performerPartnerEntitlements.termsHash}
    order by ${performerPartnerTermsAcceptances.acceptedAt} desc
    limit 1
  )`,
  partnerStatus: sql<string | null>`(
    select ${performerPartnerEntitlementStatusEvents.status}
    from ${performerPartnerEntitlementStatusEvents}
    where ${performerPartnerEntitlementStatusEvents.entitlementId} = ${performerPartnerEntitlements.id}
    order by ${performerPartnerEntitlementStatusEvents.createdAt} desc, ${performerPartnerEntitlementStatusEvents.id} desc
    limit 1
  )`,
  partnerStatusReason: sql<string | null>`(
    select ${performerPartnerEntitlementStatusEvents.reason}
    from ${performerPartnerEntitlementStatusEvents}
    where ${performerPartnerEntitlementStatusEvents.entitlementId} = ${performerPartnerEntitlements.id}
    order by ${performerPartnerEntitlementStatusEvents.createdAt} desc, ${performerPartnerEntitlementStatusEvents.id} desc
    limit 1
  )`
};

function loadAdminAccountsBaseQuery(db: NonNullable<typeof businessDb>) {
  return db
    .select(adminAccountSelectColumns)
    .from(users)
    .leftJoin(performers, eq(performers.ownerUserId, users.id))
    .leftJoin(performerPartnerEntitlements, eq(performerPartnerEntitlements.performerId, performers.id));
}

app.get('/api/admin/accounts', async (req, res) => {
  const adminAccess = await accessControl.requireAdminOrSupportAccess(req);
  if (adminAccess.allowed === false) {
    res.status(adminAccess.status).json({ error: adminAccess.reason });
    return;
  }

  if (!businessDb) {
    res.status(503).json({ error: 'Admin accounts require durable persistence.' });
    return;
  }

  applyNoStoreHeaders(res);

  const rawQuery = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const roleFilter = typeof req.query.role === 'string' && VALID_USER_ROLES.has(req.query.role) ? req.query.role : null;
  const rawLimit = typeof req.query.limit === 'string' ? req.query.limit : undefined;
  const limit = Math.min(parsePositiveInteger(rawLimit, 50), 200);

  const conditions = [];
  if (rawQuery) {
    const likeTerm = `%${rawQuery}%`;
    conditions.push(or(
      ilike(users.email, likeTerm),
      ilike(users.displayName, likeTerm),
      ilike(performers.handle, likeTerm)
    ));
  }
  if (roleFilter) {
    conditions.push(eq(users.role, roleFilter as typeof users.role.enumValues[number]));
  }

  const rows = await loadAdminAccountsBaseQuery(businessDb)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(users.createdAt))
    .limit(limit);

  res.json({ accounts: rows });
});

app.get('/api/admin/accounts/:userId', async (req, res) => {
  const adminAccess = await accessControl.requireAdminOrSupportAccess(req);
  if (adminAccess.allowed === false) {
    res.status(adminAccess.status).json({ error: adminAccess.reason });
    return;
  }

  if (!businessDb) {
    res.status(503).json({ error: 'Admin accounts require durable persistence.' });
    return;
  }

  applyNoStoreHeaders(res);

  if (!UUID_PATTERN.test(req.params.userId)) {
    res.status(404).json({ error: 'Account not found.' });
    return;
  }

  const [account] = await loadAdminAccountsBaseQuery(businessDb)
    .where(eq(users.id, req.params.userId))
    .limit(1);

  if (!account) {
    res.status(404).json({ error: 'Account not found.' });
    return;
  }

  res.json({ account });
});

app.post('/api/admin/accounts/onboard', async (req, res) => {
  const adminAccess = await accessControl.requireAdminAccess(req);
  if (adminAccess.allowed === false) {
    res.status(adminAccess.status).json({ error: adminAccess.reason });
    return;
  }

  if (!businessDb) {
    res.status(503).json({ error: 'Admin accounts require durable persistence.' });
    return;
  }

  applyNoStoreHeaders(res);

  const normalizedEmail = normalizePerformerLoginEmail(req.body?.email);
  const normalizedHandle = normalizePerformerHandle(req.body?.handle);
  const normalizedDisplayName = normalizePerformerDisplayName(req.body?.displayName);
  const isActive = req.body?.isActive !== false;
  const isPartner = req.body?.isPartner === true;
  const partnerNote = normalizePublicProfileText(req.body?.partnerNote, 280);
  const onboardingStatus = typeof req.body?.onboardingStatus === 'string' && VALID_ONBOARDING_STATUSES.has(req.body.onboardingStatus)
    ? req.body.onboardingStatus
    : 'gig_ready';

  if (!normalizedEmail || !normalizedHandle || !normalizedDisplayName) {
    res.status(422).json({ error: 'Performer name, handle, and email are required.' });
    return;
  }

  if (isProduction && !hasPerformerLoginEmailConfig) {
    res.status(503).json({ error: 'Performer invitation email delivery is temporarily unavailable.' });
    return;
  }
  if (!performerLoginChallengeStore.hasDurableStore) {
    res.status(503).json({ error: 'Performer invitation issuance requires durable persistence.' });
    return;
  }

  const [reservedPreview] = await businessDb
    .select({ id: performerProfilePreviews.id })
    .from(performerProfilePreviews)
    .where(and(
      sql`lower(${performerProfilePreviews.handle}) = ${normalizedHandle.toLowerCase()}`,
      eq(performerProfilePreviews.isActive, true)
    ))
    .limit(1);

  if (await performerHandleExists(businessDb, normalizedHandle, { includePreviews: false })) {
    res.status(409).json({ error: 'This handle is already taken.' });
    return;
  }

  if (await performerSignupEmailExists(businessDb, normalizedEmail)) {
    res.status(409).json({ error: 'This email or handle is already in use.' });
    return;
  }

  const outcome = await businessDb.transaction(async (tx) => {
    const [createdUser] = await tx
      .insert(users)
      .values({
        email: normalizedEmail,
        displayName: normalizedDisplayName,
        passwordHash: null,
        emailVerifiedAt: null,
        termsAcceptedAt: null,
        role: 'performer'
      })
      .returning({ id: users.id });

    const [createdPerformer] = await tx
      .insert(performers)
      .values({
        ownerUserId: createdUser.id,
        handle: normalizedHandle,
        displayName: normalizedDisplayName,
        isActive: false,
        onboardingStatus: 'created'
      })
      .returning({ id: performers.id });

    if (reservedPreview) {
      await tx
        .update(performerProfilePreviews)
        .set({ claimedPerformerId: createdPerformer.id, updatedAt: new Date() })
        .where(eq(performerProfilePreviews.id, reservedPreview.id));
    }

    let partnerEntitlementId: string | null = null;
    if (isPartner) {
      const [createdEntitlement] = await tx
        .insert(performerPartnerEntitlements)
        .values({
          performerId: createdPerformer.id,
          grantedByUserId: adminAccess.actor.actorId,
          partnerKind: 'brand',
          termsVersion: SWAY_PARTNER_TERMS_VERSION,
          termsHash: SWAY_PARTNER_TERMS_HASH,
          termsText: SWAY_PARTNER_TERMS_TEXT,
          termsSnapshot: buildSwayPartnerTermsSnapshot(),
          note: partnerNote
        })
        .returning({ id: performerPartnerEntitlements.id });
      partnerEntitlementId = createdEntitlement.id;

      await tx.insert(performerPartnerEntitlementStatusEvents).values({
        entitlementId: createdEntitlement.id,
        performerId: createdPerformer.id,
        status: 'active',
        reason: 'Initial Brand Partner grant; owner acceptance pending.',
        actorUserId: adminAccess.actor.actorId
      });
    }

    const invitation = await performerLoginChallengeStore.issueChallenge({
      actorUserId: createdUser.id,
      targetEmail: normalizedEmail,
      challengeType: PERFORMER_LOGIN_CHALLENGE_TYPE_ACCOUNT_INVITE,
      challengeMetadata: {
        performerId: createdPerformer.id,
        activateAfterSetup: isActive,
        onboardingStatus
      },
      requesterIpHash: hashPerformerLoginRequesterIp(req.ip || null),
      executor: tx
    });

    await writeAuditEvent(tx, {
      actorId: adminAccess.actor.actorId,
      actorType: 'admin',
      entityType: 'user',
      entityId: createdUser.id,
      eventType: 'admin_account.onboard',
      previousStatus: null,
      nextStatus: 'created',
      metadata: {
        targetEmail: normalizedEmail,
        targetHandle: normalizedHandle,
        performerId: createdPerformer.id,
        passwordSetByAdmin: false,
        termsAcceptedByAdmin: false,
        invitationChallengeId: invitation.challengeId,
        isPartner,
        partnerKind: isPartner ? 'brand' : null,
        partnerTermsVersion: isPartner ? SWAY_PARTNER_TERMS_VERSION : null,
        partnerTermsHash: isPartner ? SWAY_PARTNER_TERMS_HASH : null,
        partnerEntitlementId
      }
    });

    return {
      userId: createdUser.id,
      performerId: createdPerformer.id,
      challengeId: invitation.challengeId,
      invitationToken: invitation.token
    };
  });

  const appBaseUrl = resolvePerformerLoginBaseUrl(process.env).replace(/\/+$/, '');
  const invitationLink = `${appBaseUrl}/talent/invite?token=${encodeURIComponent(outcome.invitationToken)}`;
  const deliveryResult = await performerLoginMailer.sendAccountInvitation({
    toEmail: normalizedEmail,
    invitationLink
  });

  if (!deliveryResult.delivered) {
    await performerLoginChallengeStore.revokeChallengeById({ challengeId: outcome.challengeId });
    res.status(503).json({
      error: 'The performer account was created, but invitation delivery failed. Use the resend invitation action.',
      accountCreated: true,
      userId: outcome.userId,
      performerId: outcome.performerId
    });
    return;
  }

  res.status(201).json({
    success: true,
    userId: outcome.userId,
    performerId: outcome.performerId,
    invitationDelivery: deliveryResult.provider,
    ...(!isProduction && deliveryResult.provider === 'mock' ? { invitationLink } : {})
  });
});

app.post('/api/admin/accounts/:userId/invite', async (req, res) => {
  const adminAccess = await accessControl.requireAdminAccess(req);
  if (adminAccess.allowed === false) {
    return res.status(adminAccess.status).json({ error: adminAccess.reason });
  }
  if (!businessDb || !performerLoginChallengeStore.hasDurableStore) {
    return res.status(503).json({ error: 'Performer invitation issuance requires durable persistence.' });
  }
  if (isProduction && !hasPerformerLoginEmailConfig) {
    return res.status(503).json({ error: 'Performer invitation email delivery is temporarily unavailable.' });
  }
  if (!UUID_PATTERN.test(req.params.userId)) {
    return res.status(404).json({ error: 'Account not found.' });
  }

  const [account] = await businessDb
    .select({
      userId: users.id,
      email: users.email,
      passwordHash: users.passwordHash,
      performerId: performers.id
    })
    .from(users)
    .innerJoin(performers, eq(performers.ownerUserId, users.id))
    .where(eq(users.id, req.params.userId))
    .limit(1);

  const normalizedEmail = normalizePerformerLoginEmail(account?.email);
  if (!account || !normalizedEmail) {
    return res.status(404).json({ error: 'Performer account not found.' });
  }
  if (account.passwordHash) {
    return res.status(409).json({ error: 'This owner has already completed password setup.' });
  }

  const activateAfterSetup = req.body?.activateAfterSetup !== false;
  const onboardingStatus = typeof req.body?.onboardingStatus === 'string'
    && VALID_ONBOARDING_STATUSES.has(req.body.onboardingStatus)
    ? req.body.onboardingStatus
    : 'gig_ready';

  const invitation = await businessDb.transaction(async (tx) => {
    await tx
      .update(performerLoginChallenges)
      .set({ revokedAt: new Date() })
      .where(and(
        eq(performerLoginChallenges.actorUserId, account.userId),
        eq(performerLoginChallenges.challengeType, PERFORMER_LOGIN_CHALLENGE_TYPE_ACCOUNT_INVITE),
        isNull(performerLoginChallenges.consumedAt),
        isNull(performerLoginChallenges.revokedAt)
      ));

    const issued = await performerLoginChallengeStore.issueChallenge({
      actorUserId: account.userId,
      targetEmail: normalizedEmail,
      challengeType: PERFORMER_LOGIN_CHALLENGE_TYPE_ACCOUNT_INVITE,
      challengeMetadata: {
        performerId: account.performerId,
        activateAfterSetup,
        onboardingStatus
      },
      requesterIpHash: hashPerformerLoginRequesterIp(req.ip || null),
      executor: tx
    });

    await writeAuditEvent(tx, {
      actorId: adminAccess.actor.actorId,
      actorType: 'admin',
      entityType: 'performer_login_challenge',
      entityId: issued.challengeId,
      eventType: 'admin_account.invitation_issue',
      previousStatus: null,
      nextStatus: 'pending',
      metadata: {
        targetUserId: account.userId,
        performerId: account.performerId,
        passwordSetByAdmin: false,
        termsAcceptedByAdmin: false
      }
    });

    return issued;
  });

  const appBaseUrl = resolvePerformerLoginBaseUrl(process.env).replace(/\/+$/, '');
  const invitationLink = `${appBaseUrl}/talent/invite?token=${encodeURIComponent(invitation.token)}`;
  const deliveryResult = await performerLoginMailer.sendAccountInvitation({
    toEmail: normalizedEmail,
    invitationLink
  });

  if (!deliveryResult.delivered) {
    await performerLoginChallengeStore.revokeChallengeById({ challengeId: invitation.challengeId });
    return res.status(503).json({ error: 'Invitation delivery failed. No password or terms acceptance was changed.' });
  }

  return res.status(202).json({
    success: true,
    invitationDelivery: deliveryResult.provider,
    ...(!isProduction && deliveryResult.provider === 'mock' ? { invitationLink } : {})
  });
});

// Claim-code flow: no email required from the admin at all -- the artist supplies
// their own email/password/phone when redeeming the code. Works for a brand-new
// performer slot (pass handle+displayName) or an existing one you already set up
// yourself (pass performerId), including one that already has a password -- that's
// the handoff case. The link is always returned directly; there is no email step.
app.post('/api/admin/performers/claim-link', async (req, res) => {
  const adminAccess = await accessControl.requireAdminAccess(req);
  if (adminAccess.allowed === false) {
    return res.status(adminAccess.status).json({ error: adminAccess.reason });
  }
  if (!businessDb || !performerLoginChallengeStore.hasDurableStore) {
    return res.status(503).json({ error: 'Claim link issuance requires durable persistence.' });
  }

  const requestedPerformerId = typeof req.body?.performerId === 'string' ? req.body.performerId : null;

  let userId: string;
  let performerId: string;
  let wasNewPerformer = false;

  if (requestedPerformerId) {
    if (!UUID_PATTERN.test(requestedPerformerId)) {
      return res.status(422).json({ error: 'Invalid performerId.' });
    }
    const [existing] = await businessDb
      .select({ userId: users.id, performerId: performers.id })
      .from(performers)
      .innerJoin(users, eq(users.id, performers.ownerUserId))
      .where(eq(performers.id, requestedPerformerId))
      .limit(1);
    if (!existing) {
      return res.status(404).json({ error: 'Performer not found.' });
    }
    userId = existing.userId;
    performerId = existing.performerId;
  } else {
    const normalizedHandle = normalizePerformerHandle(req.body?.handle);
    const normalizedDisplayName = normalizePerformerDisplayName(req.body?.displayName);
    if (!normalizedHandle || !normalizedDisplayName) {
      return res.status(422).json({ error: 'A handle and display name are required to create a new performer slot.' });
    }
    if (await performerHandleExists(businessDb, normalizedHandle, { includePreviews: false })) {
      return res.status(409).json({ error: 'This handle is already taken.' });
    }

    const [reservedPreview] = await businessDb
      .select({ id: performerProfilePreviews.id })
      .from(performerProfilePreviews)
      .where(and(
        sql`lower(${performerProfilePreviews.handle}) = ${normalizedHandle.toLowerCase()}`,
        eq(performerProfilePreviews.isActive, true)
      ))
      .limit(1);

    const created = await businessDb.transaction(async (tx) => {
      const [createdUser] = await tx
        .insert(users)
        .values({ email: null, displayName: normalizedDisplayName, passwordHash: null, role: 'performer' })
        .returning({ id: users.id });
      const [createdPerformer] = await tx
        .insert(performers)
        .values({
          ownerUserId: createdUser.id,
          handle: normalizedHandle,
          displayName: normalizedDisplayName,
          isActive: false,
          onboardingStatus: 'created'
        })
        .returning({ id: performers.id });

      if (reservedPreview) {
        await tx
          .update(performerProfilePreviews)
          .set({ claimedPerformerId: createdPerformer.id, updatedAt: new Date() })
          .where(eq(performerProfilePreviews.id, reservedPreview.id));
      }

      return { userId: createdUser.id, performerId: createdPerformer.id };
    });
    userId = created.userId;
    performerId = created.performerId;
    wasNewPerformer = true;
  }

  const issued = await businessDb.transaction(async (tx) => {
    await tx
      .update(performerLoginChallenges)
      .set({ revokedAt: new Date() })
      .where(and(
        eq(performerLoginChallenges.actorUserId, userId),
        eq(performerLoginChallenges.challengeType, PERFORMER_LOGIN_CHALLENGE_TYPE_CLAIM_CODE),
        isNull(performerLoginChallenges.consumedAt),
        isNull(performerLoginChallenges.revokedAt)
      ));

    // targetEmail is unused for this challenge type -- no email is ever sent for a
    // claim code, the artist supplies their own email when redeeming it.
    const challenge = await performerLoginChallengeStore.issueChallenge({
      actorUserId: userId,
      targetEmail: '',
      challengeType: PERFORMER_LOGIN_CHALLENGE_TYPE_CLAIM_CODE,
      challengeMetadata: { performerId },
      requesterIpHash: hashPerformerLoginRequesterIp(req.ip || null),
      executor: tx
    });

    await writeAuditEvent(tx, {
      actorId: adminAccess.actor.actorId,
      actorType: 'admin',
      entityType: 'performer_login_challenge',
      entityId: challenge.challengeId,
      eventType: 'admin_performer.claim_link_issue',
      previousStatus: null,
      nextStatus: 'pending',
      metadata: { userId, performerId, wasNewPerformer }
    });

    return challenge;
  });

  const appBaseUrl = resolvePerformerLoginBaseUrl(process.env).replace(/\/+$/, '');
  const claimLink = `${appBaseUrl}/talent/claim?code=${encodeURIComponent(issued.token)}`;

  return res.status(201).json({ success: true, userId, performerId, wasNewPerformer, claimLink });
});

app.patch('/api/admin/accounts/:userId', async (req, res) => {
  const adminAccess = await accessControl.requireAdminAccess(req);
  if (adminAccess.allowed === false) {
    res.status(adminAccess.status).json({ error: adminAccess.reason });
    return;
  }

  if (!businessDb) {
    res.status(503).json({ error: 'Admin accounts require durable persistence.' });
    return;
  }

  applyNoStoreHeaders(res);

  if (!UUID_PATTERN.test(req.params.userId)) {
    res.status(404).json({ error: 'Account not found.' });
    return;
  }

  const [existingAccount] = await loadAdminAccountsBaseQuery(businessDb)
    .where(eq(users.id, req.params.userId))
    .limit(1);

  if (!existingAccount) {
    res.status(404).json({ error: 'Account not found.' });
    return;
  }

  const userUpdates: Record<string, unknown> = {};
  const performerUpdates: Record<string, unknown> = {};
  const changedFields: string[] = [];
  const shouldGrantPartner = Boolean(
    existingAccount.performerId
    && req.body?.isPartner === true
    && !existingAccount.partnerTermsVersion
  );
  const partnerNote = normalizePublicProfileText(req.body?.partnerNote, 280);
  const requestedPartnerStatus = req.body?.partnerSuspended === true
    ? 'suspended'
    : req.body?.partnerSuspended === false
      ? 'active'
      : null;
  const shouldChangePartnerStatus = Boolean(
    existingAccount.partnerEntitlementId
    && requestedPartnerStatus
    && existingAccount.partnerStatus !== requestedPartnerStatus
  );
  const partnerStatusReason = normalizePublicProfileText(req.body?.partnerStatusReason, 280);

  if (shouldGrantPartner) {
    changedFields.push('partner');
  }
  if (shouldChangePartnerStatus) {
    changedFields.push('partnerStatus');
  }

  if (req.body?.email !== undefined) {
    const normalizedEmail = normalizePerformerLoginEmail(req.body.email);
    if (!normalizedEmail) {
      res.status(422).json({ error: 'A valid email is required.' });
      return;
    }
    if (normalizedEmail !== existingAccount.email) {
      const [conflict] = await businessDb
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.email}) = ${normalizedEmail} and ${users.id} != ${req.params.userId}`)
        .limit(1);
      if (conflict) {
        res.status(409).json({ error: 'This email is already in use.' });
        return;
      }
      userUpdates.email = normalizedEmail;
      changedFields.push('email');
    }
  }

  if (req.body?.displayName !== undefined) {
    const normalizedDisplayName = normalizePerformerDisplayName(req.body.displayName);
    if (!normalizedDisplayName) {
      res.status(422).json({ error: 'A valid display name is required.' });
      return;
    }
    userUpdates.displayName = normalizedDisplayName;
    performerUpdates.displayName = normalizedDisplayName;
    changedFields.push('displayName');
  }

  if (req.body?.role !== undefined) {
    if (typeof req.body.role !== 'string' || !VALID_USER_ROLES.has(req.body.role)) {
      res.status(422).json({ error: 'Invalid role.' });
      return;
    }
    userUpdates.role = req.body.role;
    changedFields.push('role');
  }

  if (req.body?.emailVerified !== undefined) {
    userUpdates.emailVerifiedAt = req.body.emailVerified ? new Date() : null;
    changedFields.push('emailVerified');
  }

  if (existingAccount.performerId) {
    if (req.body?.handle !== undefined) {
      const normalizedHandle = normalizePerformerHandle(req.body.handle);
      if (!normalizedHandle) {
        res.status(422).json({ error: 'A valid handle is required.' });
        return;
      }
      if (normalizedHandle.toLowerCase() !== (existingAccount.handle ?? '').toLowerCase()) {
        const [conflict] = await businessDb
          .select({ id: performers.id })
          .from(performers)
          .where(sql`lower(${performers.handle}) = ${normalizedHandle.toLowerCase()} and ${performers.id} != ${existingAccount.performerId}`)
          .limit(1);
        if (conflict) {
          res.status(409).json({ error: 'This handle is already taken.' });
          return;
        }
        performerUpdates.handle = normalizedHandle;
        changedFields.push('handle');
      }
    }

    if (req.body?.isActive !== undefined) {
      if (Boolean(req.body.isActive) && existingAccount.passwordSetupRequired) {
        res.status(409).json({ error: 'The performer owner must finish the one-time password setup before activation.' });
        return;
      }
      performerUpdates.isActive = Boolean(req.body.isActive);
      changedFields.push('isActive');
    }

    if (req.body?.onboardingStatus !== undefined) {
      if (typeof req.body.onboardingStatus !== 'string' || !VALID_ONBOARDING_STATUSES.has(req.body.onboardingStatus)) {
        res.status(422).json({ error: 'Invalid onboarding status.' });
        return;
      }
      performerUpdates.onboardingStatus = req.body.onboardingStatus;
      changedFields.push('onboardingStatus');
    }

    if (req.body?.payoutHoldReason !== undefined) {
      performerUpdates.payoutHoldReason = typeof req.body.payoutHoldReason === 'string' && req.body.payoutHoldReason.trim()
        ? req.body.payoutHoldReason.trim()
        : null;
      changedFields.push('payoutHoldReason');
    }
  }

  if (changedFields.length === 0) {
    res.status(422).json({ error: 'No valid fields to update.' });
    return;
  }

  await businessDb.transaction(async (tx) => {
    if (Object.keys(userUpdates).length > 0) {
      await tx.update(users).set(userUpdates).where(eq(users.id, req.params.userId));
    }
    if (existingAccount.performerId && Object.keys(performerUpdates).length > 0) {
      await tx.update(performers).set(performerUpdates).where(eq(performers.id, existingAccount.performerId));
    }
    if (shouldGrantPartner && existingAccount.performerId) {
      const grantedPartnerRows = await tx
        .insert(performerPartnerEntitlements)
        .values({
          performerId: existingAccount.performerId,
          grantedByUserId: adminAccess.actor.actorId,
          partnerKind: 'brand',
          termsVersion: SWAY_PARTNER_TERMS_VERSION,
          termsHash: SWAY_PARTNER_TERMS_HASH,
          termsText: SWAY_PARTNER_TERMS_TEXT,
          termsSnapshot: buildSwayPartnerTermsSnapshot(),
          note: partnerNote
        })
        .onConflictDoNothing()
        .returning({
          id: performerPartnerEntitlements.id,
          performerId: performerPartnerEntitlements.performerId
        });

      if (grantedPartnerRows.length > 0) {
        await tx.insert(performerPartnerEntitlementStatusEvents).values({
          entitlementId: grantedPartnerRows[0].id,
          performerId: existingAccount.performerId,
          status: 'active',
          reason: 'Initial Brand Partner grant; owner acceptance pending.',
          actorUserId: adminAccess.actor.actorId
        });

        await writeAuditEvent(tx, {
          actorId: adminAccess.actor.actorId,
          actorType: 'admin',
          entityType: 'performer',
          entityId: existingAccount.performerId,
          eventType: 'admin_account.partner_grant',
          previousStatus: null,
          nextStatus: 'partner',
          metadata: {
            targetEmail: existingAccount.email,
            partnerKind: 'brand',
            termsVersion: SWAY_PARTNER_TERMS_VERSION,
            termsHash: SWAY_PARTNER_TERMS_HASH,
            ownerAcceptanceRequired: true
          }
        });
      }
    }

    if (
      shouldChangePartnerStatus
      && existingAccount.performerId
      && existingAccount.partnerEntitlementId
      && requestedPartnerStatus
    ) {
      await tx.insert(performerPartnerEntitlementStatusEvents).values({
        entitlementId: existingAccount.partnerEntitlementId,
        performerId: existingAccount.performerId,
        status: requestedPartnerStatus,
        reason: partnerStatusReason,
        actorUserId: adminAccess.actor.actorId
      });

      await writeAuditEvent(tx, {
        actorId: adminAccess.actor.actorId,
        actorType: 'admin',
        entityType: 'performer',
        entityId: existingAccount.performerId,
        eventType: requestedPartnerStatus === 'suspended'
          ? 'admin_account.partner_suspend'
          : 'admin_account.partner_restore',
        previousStatus: existingAccount.partnerStatus,
        nextStatus: requestedPartnerStatus,
        metadata: {
          entitlementId: existingAccount.partnerEntitlementId,
          reason: partnerStatusReason,
          entitlementDeleted: false
        }
      });
    }

    await writeAuditEvent(tx, {
      actorId: adminAccess.actor.actorId,
      actorType: 'admin',
      entityType: 'user',
      entityId: req.params.userId,
      eventType: 'admin_account.update',
      previousStatus: null,
      nextStatus: null,
      metadata: {
        targetEmail: existingAccount.email,
        changedFields
      }
    });
  });

  const [updatedAccount] = await loadAdminAccountsBaseQuery(businessDb)
    .where(eq(users.id, req.params.userId))
    .limit(1);

  res.json({ account: updatedAccount });
});

app.post('/api/admin/accounts/:userId/reset-password', async (req, res) => {
  const adminAccess = await accessControl.requireAdminAccess(req);
  if (adminAccess.allowed === false) {
    return res.status(adminAccess.status).json({ error: adminAccess.reason });
  }

  if (!businessDb || !performerLoginChallengeStore.hasDurableStore) {
    return res.status(503).json({ error: 'Owner password reset requires durable persistence.' });
  }
  if (isProduction && !hasPerformerLoginEmailConfig) {
    return res.status(503).json({ error: 'Owner password reset email delivery is temporarily unavailable.' });
  }

  applyNoStoreHeaders(res);

  if (!UUID_PATTERN.test(req.params.userId)) {
    return res.status(404).json({ error: 'Account not found.' });
  }

  const [existingUser] = await businessDb
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, req.params.userId))
    .limit(1);

  if (!existingUser) {
    return res.status(404).json({ error: 'Account not found.' });
  }

  const normalizedEmail = normalizePerformerLoginEmail(existingUser.email);
  if (!normalizedEmail) {
    return res.status(422).json({ error: 'This account has no deliverable owner email.' });
  }

  const resetChallenge = await businessDb.transaction(async (tx) => {
    await tx
      .update(performerLoginChallenges)
      .set({ revokedAt: new Date() })
      .where(and(
        eq(performerLoginChallenges.actorUserId, existingUser.id),
        eq(performerLoginChallenges.challengeType, PERFORMER_LOGIN_CHALLENGE_TYPE_PASSWORD_RESET),
        isNull(performerLoginChallenges.consumedAt),
        isNull(performerLoginChallenges.revokedAt)
      ));

    const issued = await performerLoginChallengeStore.issueChallenge({
      actorUserId: existingUser.id,
      targetEmail: normalizedEmail,
      challengeType: PERFORMER_LOGIN_CHALLENGE_TYPE_PASSWORD_RESET,
      requesterIpHash: hashPerformerLoginRequesterIp(req.ip || null),
      executor: tx
    });

    await writeAuditEvent(tx, {
      actorId: adminAccess.actor.actorId,
      actorType: 'admin',
      entityType: 'performer_login_challenge',
      entityId: issued.challengeId,
      eventType: 'admin_account.password_reset_issue',
      previousStatus: null,
      nextStatus: 'pending',
      metadata: {
        targetEmail: existingUser.email,
        passwordSetByAdmin: false
      }
    });

    return issued;
  });

  const appBaseUrl = resolvePerformerLoginBaseUrl(process.env).replace(/\/+$/, '');
  const resetLink = `${appBaseUrl}/talent/invite?mode=reset&token=${encodeURIComponent(resetChallenge.token)}`;
  const deliveryResult = await performerLoginMailer.sendOwnerPasswordReset({
    toEmail: normalizedEmail,
    resetLink
  });

  if (!deliveryResult.delivered) {
    await performerLoginChallengeStore.revokeChallengeById({ challengeId: resetChallenge.challengeId });
    return res.status(503).json({ error: 'Password reset delivery failed. The existing password was not changed.' });
  }

  return res.status(202).json({
    success: true,
    deliveryMode: deliveryResult.provider,
    ...(!isProduction && deliveryResult.provider === 'mock' ? { resetLink } : {})
  });
});

app.delete('/api/admin/accounts/:userId', async (req, res) => {
  const adminAccess = await accessControl.requireAdminAccess(req);
  if (adminAccess.allowed === false) {
    res.status(adminAccess.status).json({ error: adminAccess.reason });
    return;
  }

  if (!businessDb) {
    res.status(503).json({ error: 'Admin accounts require durable persistence.' });
    return;
  }

  applyNoStoreHeaders(res);

  if (!UUID_PATTERN.test(req.params.userId)) {
    res.status(404).json({ error: 'Account not found.' });
    return;
  }

  if (req.params.userId === adminAccess.actor.actorId) {
    res.status(422).json({ error: 'You cannot delete your own account while signed in as it.' });
    return;
  }

  const [existingAccount] = await loadAdminAccountsBaseQuery(businessDb)
    .where(eq(users.id, req.params.userId))
    .limit(1);

  if (!existingAccount) {
    res.status(404).json({ error: 'Account not found.' });
    return;
  }

  // Sway's own privacy policy commits to retaining payment, fraud, dispute,
  // moderation, and audit records -- so this scrubs personally identifying
  // fields and locks the account out rather than deleting the row, keeping
  // every audit_events/gig_sessions/requests row it's referenced by intact.
  await businessDb.transaction(async (tx) => {
    await tx.update(users).set({
      email: null,
      displayName: 'Deleted account',
      passwordHash: null,
      emailVerifiedAt: null
    }).where(eq(users.id, req.params.userId));

    if (existingAccount.performerId) {
      await tx.update(performers).set({
        isActive: false,
        onboardingStatus: 'suspended',
        bio: null
      }).where(eq(performers.id, existingAccount.performerId));

      if (existingAccount.partnerEntitlementId && existingAccount.partnerStatus !== 'suspended') {
        await tx.insert(performerPartnerEntitlementStatusEvents).values({
          entitlementId: existingAccount.partnerEntitlementId,
          performerId: existingAccount.performerId,
          status: 'suspended',
          reason: 'Account privacy deletion and access suspension.',
          actorUserId: adminAccess.actor.actorId
        });
      }
    }

    if (performerSessionStore.hasDurableStore) {
      await performerSessionStore.revokeActiveSessionsForActorUser({
        actorUserId: req.params.userId,
        executor: tx
      });
    }

    await writeAuditEvent(tx, {
      actorId: adminAccess.actor.actorId,
      actorType: 'admin',
      entityType: 'user',
      entityId: req.params.userId,
      eventType: 'admin_account.delete',
      previousStatus: null,
      nextStatus: 'deleted',
      metadata: {
        targetEmail: existingAccount.email,
        targetHandle: existingAccount.handle
      }
    });
  });

  res.json({ success: true });
});

// Sway-issued promotion campaigns: the only source of the "sway_promoted"
// commission rate (never invented in code -- always a negotiated deal term ops
// types in here). See resolveCampaignAttribution in business-store.ts for how a
// campaign_code on a sale gets verified against these rows.
app.get('/api/admin/campaigns', async (req, res) => {
  const adminAccess = await accessControl.requireAdminOrSupportAccess(req);
  if (adminAccess.allowed === false) {
    res.status(adminAccess.status).json({ error: adminAccess.reason });
    return;
  }
  if (!businessDb) {
    res.status(503).json({ error: 'Admin campaigns require durable persistence.' });
    return;
  }
  applyNoStoreHeaders(res);

  const performerId = typeof req.query.performerId === 'string' ? req.query.performerId : undefined;
  if (performerId && !UUID_PATTERN.test(performerId)) {
    res.status(422).json({ error: 'Invalid performerId.' });
    return;
  }

  const rows = await businessDb
    .select()
    .from(promotionCampaigns)
    .where(performerId ? eq(promotionCampaigns.performerId, performerId) : undefined)
    .orderBy(desc(promotionCampaigns.createdAt));

  res.json({ campaigns: rows });
});

app.post('/api/admin/campaigns', async (req, res) => {
  const adminAccess = await accessControl.requireAdminAccess(req);
  if (adminAccess.allowed === false) {
    res.status(adminAccess.status).json({ error: adminAccess.reason });
    return;
  }
  if (!businessDb) {
    res.status(503).json({ error: 'Admin campaigns require durable persistence.' });
    return;
  }
  applyNoStoreHeaders(res);

  const performerId = typeof req.body?.performerId === 'string' ? req.body.performerId : '';
  const campaignCode = typeof req.body?.campaignCode === 'string' ? req.body.campaignCode.trim() : '';
  const label = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
  const commissionBps = Number.isInteger(req.body?.commissionBps) ? req.body.commissionBps : null;
  const expiresAt = typeof req.body?.expiresAt === 'string' && req.body.expiresAt ? new Date(req.body.expiresAt) : null;

  if (!UUID_PATTERN.test(performerId)) {
    res.status(422).json({ error: 'A valid performerId is required.' });
    return;
  }
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(campaignCode)) {
    res.status(422).json({ error: 'campaignCode must be 2-64 lowercase alphanumeric/hyphen characters.' });
    return;
  }
  if (!label) {
    res.status(422).json({ error: 'A label describing the deal is required.' });
    return;
  }
  // Sway never invents this number -- it must come from the negotiated deal, every time.
  if (commissionBps === null || commissionBps <= 0 || commissionBps > 10000) {
    res.status(422).json({ error: 'commissionBps is required and must be between 1 and 10000 (the negotiated rate).' });
    return;
  }

  const [performerRow] = await businessDb.select({ id: performers.id }).from(performers).where(eq(performers.id, performerId)).limit(1);
  if (!performerRow) {
    res.status(404).json({ error: 'Performer not found.' });
    return;
  }

  const [existingCode] = await businessDb.select({ id: promotionCampaigns.id }).from(promotionCampaigns).where(eq(promotionCampaigns.campaignCode, campaignCode)).limit(1);
  if (existingCode) {
    res.status(409).json({ error: 'This campaign code is already in use.' });
    return;
  }

  const [created] = await businessDb
    .insert(promotionCampaigns)
    .values({ performerId, campaignCode, label, commissionBps, expiresAt })
    .returning();

  await writeAuditEvent(businessDb, {
    actorId: adminAccess.actor.actorId,
    actorType: 'admin',
    entityType: 'promotion_campaign',
    entityId: created.id,
    eventType: 'admin_campaign.create',
    previousStatus: null,
    nextStatus: created.status,
    metadata: { performerId, campaignCode, commissionBps }
  });

  res.status(201).json({ success: true, campaign: created });
});

app.patch('/api/admin/campaigns/:campaignId', async (req, res) => {
  const adminAccess = await accessControl.requireAdminAccess(req);
  if (adminAccess.allowed === false) {
    res.status(adminAccess.status).json({ error: adminAccess.reason });
    return;
  }
  if (!businessDb) {
    res.status(503).json({ error: 'Admin campaigns require durable persistence.' });
    return;
  }
  applyNoStoreHeaders(res);

  if (!UUID_PATTERN.test(req.params.campaignId)) {
    res.status(404).json({ error: 'Campaign not found.' });
    return;
  }

  const [existing] = await businessDb.select().from(promotionCampaigns).where(eq(promotionCampaigns.id, req.params.campaignId)).limit(1);
  if (!existing) {
    res.status(404).json({ error: 'Campaign not found.' });
    return;
  }

  const VALID_CAMPAIGN_STATUSES = new Set(['draft', 'active', 'paused', 'ended']);
  if (req.body?.status !== undefined && !VALID_CAMPAIGN_STATUSES.has(req.body.status)) {
    res.status(422).json({ error: 'Invalid status.' });
    return;
  }

  const [updated] = await businessDb
    .update(promotionCampaigns)
    .set({
      ...(req.body?.status !== undefined ? { status: req.body.status } : {}),
      ...(req.body?.label !== undefined ? { label: String(req.body.label).trim() } : {}),
      ...(req.body?.expiresAt !== undefined ? { expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : null } : {}),
      updatedAt: new Date()
    })
    .where(eq(promotionCampaigns.id, req.params.campaignId))
    .returning();

  await writeAuditEvent(businessDb, {
    actorId: adminAccess.actor.actorId,
    actorType: 'admin',
    entityType: 'promotion_campaign',
    entityId: req.params.campaignId,
    eventType: 'admin_campaign.update',
    previousStatus: existing.status,
    nextStatus: updated.status,
    metadata: { changedFields: Object.keys(req.body ?? {}) }
  });

  res.json({ success: true, campaign: updated });
});

const shellTelemetryAllowedEvents = new Set([
  'telemetry_friction_patron_no_session_recovery_viewed',
  'telemetry_friction_patron_no_session_return_home_clicked',
  'room_entry_viewed',
  'room_entry_recovery_viewed',
  'share_link_copied',
  'request_started',
  'boost_started'
]);

const shellTelemetryAllowedKeys = new Set([
  'shell',
  'surface',
  'event',
  'route_family',
  'has_route_context',
  'has_session_context',
  'build_commit'
]);

const shellTelemetrySensitiveKeys = new Set([
  'card',
  'cvc',
  'cvv',
  'pan',
  'token',
  'secret',
  'cookie',
  'authorization',
  'session',
  'jwt',
  'email',
  'phone',
  'name',
  'message',
  'note',
  'request',
  'query',
  'url',
  'headers',
  'device',
  'location',
  'latitude',
  'longitude',
  'amount',
  'payment',
  'stripe'
]);

type ShellTelemetryPayload = {
  shell: 'patron' | 'talent';
  surface: 'recovery-view' | 'room-entry' | 'share-kit';
  event: string;
  route_family: string;
  has_route_context: boolean;
  has_session_context: boolean;
  build_commit: string;
};

function validateShellTelemetryPayload(body: unknown): { ok: true; payload: ShellTelemetryPayload } | { ok: false; status: number; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'Shell telemetry payload must be a JSON object.' };
  }

  const payload = body as Record<string, unknown>;
  const keys = Object.keys(payload);

  for (const key of keys) {
    if (shellTelemetrySensitiveKeys.has(key)) {
      return { ok: false, status: 400, error: `Sensitive telemetry field rejected: ${key}` };
    }
    if (!shellTelemetryAllowedKeys.has(key)) {
      return { ok: false, status: 400, error: `Unexpected telemetry field rejected: ${key}` };
    }
  }

  for (const key of shellTelemetryAllowedKeys) {
    if (!(key in payload)) {
      return { ok: false, status: 400, error: `Missing telemetry field: ${key}` };
    }
  }

  if (payload.shell !== 'patron' && payload.shell !== 'talent') {
    return { ok: false, status: 400, error: 'Shell telemetry requires shell=patron or shell=talent.' };
  }
  if (payload.surface !== 'recovery-view' && payload.surface !== 'room-entry' && payload.surface !== 'share-kit') {
    return { ok: false, status: 400, error: 'Shell telemetry requires a supported funnel surface.' };
  }
  if (typeof payload.event !== 'string' || !shellTelemetryAllowedEvents.has(payload.event)) {
    return { ok: false, status: 400, error: 'Unknown shell telemetry event.' };
  }
  if (typeof payload.route_family !== 'string' || payload.route_family.length === 0 || /[?&=#]/.test(payload.route_family)) {
    return { ok: false, status: 400, error: 'route_family must be a coarse, query-free string.' };
  }
  if (typeof payload.has_route_context !== 'boolean' || typeof payload.has_session_context !== 'boolean') {
    return { ok: false, status: 400, error: 'Shell telemetry context flags must be boolean.' };
  }
  if (typeof payload.build_commit !== 'string' || payload.build_commit.length === 0 || payload.build_commit.length > 128) {
    return { ok: false, status: 400, error: 'build_commit must be a non-empty string.' };
  }

  return {
    ok: true,
    payload: {
      shell: payload.shell,
      surface: payload.surface,
      event: payload.event,
      route_family: payload.route_family,
      has_route_context: payload.has_route_context,
      has_session_context: payload.has_session_context,
      build_commit: payload.build_commit
    }
  };
}

app.post("/api/analytics/shell", async (req, res) => {
  if (!req.is('application/json')) {
    return res.status(415).json({ error: 'Shell telemetry requires application/json.' });
  }

  const validation = validateShellTelemetryPayload(req.body);
  if (validation.ok === false) {
    return res.status(validation.status).json({ error: validation.error });
  }

  if (!businessDb) {
    return res.status(503).json({ error: 'Audit store unavailable for shell telemetry.' });
  }

  const { payload } = validation;
  // The client can't know its own deployed commit at build time (no build-time
  // injection wired up), so it always reports a placeholder. The server knows
  // its actual deployed commit -- record that instead so funnel analysis by
  // build/commit is actually meaningful.
  const auditPayload = { ...payload, build_commit: buildMarker.commit };

  try {
    await businessDb.transaction(async (tx) => {
      await writeAuditEvent(tx, {
        actorId: null,
        actorType: 'system',
        entityType: 'shell_friction',
        entityId: `${payload.shell}:${payload.surface}:${payload.event}:${payload.route_family}`,
        eventType: payload.event,
        metadata: auditPayload
      });
    });
    return res.status(202).json({ accepted: true });
  } catch {
    return res.status(500).json({ error: 'Unable to capture shell telemetry event.' });
  }
});

app.get('/api/talent/profile/public', async (req, res) => {
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) {
    return res.status(talentAccess.status).json({ error: talentAccess.reason });
  }
  if (!talentAccess.actor.actorId || !businessDb) {
    return res.status(503).json({ error: 'Performer profile requires a durable database connection.' });
  }

  const performerOwner = await loadOwnedPerformerByActorUserId(talentAccess.actor.actorId);
  if (!performerOwner) {
    return res.status(403).json({ error: 'Only the performer owner can manage this profile.' });
  }

  const [[profileRow], linkRows, partnerState] = await Promise.all([
    businessDb
      .select({
        performerId: performerPublicProfiles.performerId,
        headline: performerPublicProfiles.headline,
        specialties: performerPublicProfiles.specialties,
        city: performerPublicProfiles.city,
        avatarUrl: performerPublicProfiles.avatarUrl,
        bookingEmail: performerPublicProfiles.bookingEmail,
        bookingPhone: performerPublicProfiles.bookingPhone,
        facebookUrl: performerPublicProfiles.facebookUrl,
        instagramUrl: performerPublicProfiles.instagramUrl,
        tiktokUrl: performerPublicProfiles.tiktokUrl,
        youtubeUrl: performerPublicProfiles.youtubeUrl,
        soundcloudUrl: performerPublicProfiles.soundcloudUrl,
        websiteUrl: performerPublicProfiles.websiteUrl,
        updatedAt: performerPublicProfiles.updatedAt
      })
      .from(performerPublicProfiles)
      .where(eq(performerPublicProfiles.performerId, performerOwner.performerId))
      .limit(1),
    businessDb
      .select({
        id: performerProfileLinks.id,
        label: performerProfileLinks.label,
        description: performerProfileLinks.description,
        url: performerProfileLinks.url,
        kind: performerProfileLinks.kind,
        sortOrder: performerProfileLinks.sortOrder,
        isActive: performerProfileLinks.isActive
      })
      .from(performerProfileLinks)
      .where(eq(performerProfileLinks.performerId, performerOwner.performerId))
      .orderBy(asc(performerProfileLinks.sortOrder), asc(performerProfileLinks.createdAt)),
    loadPartnerEntitlementStateForPerformer(businessDb, performerOwner.performerId)
  ]);

  return res.json({
    profile: {
      performerId: performerOwner.performerId,
      handle: performerOwner.handle,
      displayName: performerOwner.displayName,
      bio: performerOwner.bio,
      headline: profileRow?.headline ?? null,
      specialties: profileRow?.specialties ?? [],
      city: profileRow?.city ?? null,
      avatarUrl: profileRow?.avatarUrl ?? null,
      booking: {
        email: profileRow?.bookingEmail ?? null,
        phone: profileRow?.bookingPhone ?? null
      },
      socialLinks: toPublicSocialLinks({
        facebookUrl: profileRow?.facebookUrl ?? null,
        instagramUrl: profileRow?.instagramUrl ?? null,
        tiktokUrl: profileRow?.tiktokUrl ?? null,
        youtubeUrl: profileRow?.youtubeUrl ?? null,
        soundcloudUrl: profileRow?.soundcloudUrl ?? null,
        websiteUrl: profileRow?.websiteUrl ?? null
      }),
      links: linkRows,
      partner: {
        granted: Boolean(partnerState),
        active: partnerState?.isEffective ?? false,
        accepted: partnerState?.isAccepted ?? false,
        suspended: partnerState?.isSuspended ?? false,
        acceptanceRequired: Boolean(partnerState && !partnerState.isAccepted),
        kind: partnerState?.partnerKind ?? null,
        termsVersion: partnerState?.termsVersion ?? null,
        termsHash: partnerState?.termsHash ?? null,
        termsText: partnerState?.termsText ?? null,
        termsSnapshot: partnerState?.termsSnapshot ?? null,
        grantedAt: partnerState?.grantedAt ?? null,
        acceptedAt: partnerState?.acceptedAt ?? null,
        status: partnerState?.currentStatus ?? null,
        statusReason: partnerState?.statusReason ?? null
      },
      updatedAt: profileRow?.updatedAt ?? null
    }
  });
});

app.post('/api/talent/partner/terms/accept', async (req, res) => {
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) {
    return res.status(talentAccess.status).json({ error: talentAccess.reason });
  }
  if (!talentAccess.actor.actorId || !businessDb) {
    return res.status(503).json({ error: 'Brand Partner terms acceptance requires durable authenticated persistence.' });
  }
  if (req.body?.accepted !== true) {
    return res.status(422).json({ error: 'Explicit owner acceptance is required.' });
  }

  const performerOwner = await loadOwnedPerformerByActorUserId(talentAccess.actor.actorId);
  if (!performerOwner) {
    return res.status(403).json({ error: 'Only the performer owner can accept Brand Partner terms.' });
  }

  const partnerState = await loadPartnerEntitlementStateForPerformer(businessDb, performerOwner.performerId);
  if (!partnerState) {
    return res.status(404).json({ error: 'No Brand Partner grant is pending for this performer.' });
  }

  const requestedTermsVersion = typeof req.body?.termsVersion === 'string' ? req.body.termsVersion.trim() : '';
  const requestedTermsHash = typeof req.body?.termsHash === 'string' ? req.body.termsHash.trim().toLowerCase() : '';
  if (requestedTermsVersion !== partnerState.termsVersion || requestedTermsHash !== partnerState.termsHash) {
    return res.status(409).json({ error: 'The Brand Partner terms changed. Reload and review the exact version before accepting.' });
  }

  const acceptedAt = new Date();
  const receiptRows = await businessDb.transaction(async (tx) => {
    const inserted = await tx
      .insert(performerPartnerTermsAcceptances)
      .values({
        entitlementId: partnerState.entitlementId,
        performerId: performerOwner.performerId,
        accountUserId: talentAccess.actor.actorId,
        termsVersion: partnerState.termsVersion,
        termsHash: partnerState.termsHash,
        termsText: partnerState.termsText,
        termsSnapshot: partnerState.termsSnapshot,
        acceptedAt
      })
      .onConflictDoNothing()
      .returning({ id: performerPartnerTermsAcceptances.id });

    if (inserted.length > 0) {
      await writeAuditEvent(tx, {
        actorId: talentAccess.actor.actorId,
        actorType: 'performer',
        entityType: 'performer',
        entityId: performerOwner.performerId,
        eventType: 'performer_partner_terms.accept',
        previousStatus: 'pending_acceptance',
        nextStatus: 'accepted',
        metadata: {
          accountUserId: talentAccess.actor.actorId,
          entitlementId: partnerState.entitlementId,
          termsVersion: partnerState.termsVersion,
          termsHash: partnerState.termsHash,
          acceptedAt: acceptedAt.toISOString(),
          acceptedByAdmin: false
        }
      });
    }

    return inserted;
  });

  return res.status(receiptRows.length > 0 ? 201 : 200).json({
    success: true,
    receipt: {
      accountUserId: talentAccess.actor.actorId,
      termsVersion: partnerState.termsVersion,
      termsHash: partnerState.termsHash,
      acceptedAt: receiptRows.length > 0 ? acceptedAt : partnerState.acceptedAt
    }
  });
});

app.post('/api/talent/profile/public', async (req, res) => {
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) {
    return res.status(talentAccess.status).json({ error: talentAccess.reason });
  }
  if (!talentAccess.actor.actorId || !businessDb) {
    return res.status(503).json({ error: 'Performer profile requires a durable database connection.' });
  }

  const performerOwner = await loadOwnedPerformerByActorUserId(talentAccess.actor.actorId);
  if (!performerOwner) {
    return res.status(403).json({ error: 'Only the performer owner can manage this profile.' });
  }

  const bio = normalizePublicProfileText(req.body?.bio, 1200);
  const headline = normalizePublicProfileText(req.body?.headline, 140);
  const specialtiesProvided = req.body?.specialties !== undefined;
  const specialties = normalizePublicProfileSpecialties(req.body?.specialties);
  const city = normalizePublicProfileText(req.body?.city, 80);
  const avatarUrl = normalizePublicProfileUrl(req.body?.avatarUrl);
  const bookingEmail = normalizePublicProfileEmail(req.body?.booking?.email);
  const bookingPhone = normalizePublicProfilePhone(req.body?.booking?.phone);
  const facebookUrl = normalizePublicProfileUrl(req.body?.socialLinks?.facebook);
  const instagramUrl = normalizePublicProfileUrl(req.body?.socialLinks?.instagram);
  const tiktokUrl = normalizePublicProfileUrl(req.body?.socialLinks?.tiktok);
  const youtubeUrl = normalizePublicProfileUrl(req.body?.socialLinks?.youtube);
  const soundcloudUrl = normalizePublicProfileUrl(req.body?.socialLinks?.soundcloud);
  const websiteUrl = normalizePublicProfileUrl(req.body?.socialLinks?.website);
  const normalizedLinks = normalizePublicProfileLinks(req.body?.links);

  if (specialtiesProvided && !Array.isArray(req.body?.specialties)) {
    return res.status(422).json({ error: 'Specialties must be an array.' });
  }

  const invalidUrlField = [
    ['Avatar URL', req.body?.avatarUrl, avatarUrl],
    ['Facebook URL', req.body?.socialLinks?.facebook, facebookUrl],
    ['Instagram URL', req.body?.socialLinks?.instagram, instagramUrl],
    ['TikTok URL', req.body?.socialLinks?.tiktok, tiktokUrl],
    ['YouTube URL', req.body?.socialLinks?.youtube, youtubeUrl],
    ['SoundCloud URL', req.body?.socialLinks?.soundcloud, soundcloudUrl],
    ['Website URL', req.body?.socialLinks?.website, websiteUrl]
  ].find(([, rawValue, normalizedValue]) => (
    typeof rawValue === 'string' && rawValue.trim().length > 0 && !normalizedValue
  ));

  if (invalidUrlField) {
    return res.status(422).json({ error: `${invalidUrlField[0]} must be a valid http or https URL.` });
  }
  if (typeof req.body?.booking?.email === 'string' && req.body.booking.email.trim() && !bookingEmail) {
    return res.status(422).json({ error: 'Booking email must be a valid email address.' });
  }
  if (typeof req.body?.booking?.phone === 'string' && req.body.booking.phone.trim() && !bookingPhone) {
    return res.status(422).json({ error: 'Booking phone must be a valid public phone number.' });
  }
  if (normalizedLinks.error) {
    return res.status(422).json({ error: normalizedLinks.error });
  }

  const savedLinks = await businessDb.transaction(async (tx) => {
    const now = new Date();

    await tx
      .update(performers)
      .set({ bio, updatedAt: now })
      .where(eq(performers.id, performerOwner.performerId));

    await tx
      .insert(performerPublicProfiles)
      .values({
        performerId: performerOwner.performerId,
        headline,
        specialties: specialties ?? [],
        city,
        avatarUrl,
        bookingEmail,
        bookingPhone,
        facebookUrl,
        instagramUrl,
        tiktokUrl,
        youtubeUrl,
        soundcloudUrl,
        websiteUrl,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: performerPublicProfiles.performerId,
        set: {
          headline,
          specialties: specialties ?? [],
          city,
          avatarUrl,
          bookingEmail,
          bookingPhone,
          facebookUrl,
          instagramUrl,
          tiktokUrl,
          youtubeUrl,
          soundcloudUrl,
          websiteUrl,
          updatedAt: now
        }
      });

    if (normalizedLinks.provided) {
      await tx.delete(performerProfileLinks).where(eq(performerProfileLinks.performerId, performerOwner.performerId));
      if (normalizedLinks.links.length) {
        await tx.insert(performerProfileLinks).values(normalizedLinks.links.map((link) => ({
          performerId: performerOwner.performerId,
          label: link.label,
          description: link.description,
          url: link.url,
          kind: link.kind,
          sortOrder: link.sortOrder,
          isActive: link.isActive,
          updatedAt: now
        })));
      }
    }

    await writeAuditEvent(tx, {
      actorId: talentAccess.actor.actorId,
      actorType: 'performer',
      entityType: 'performer',
      entityId: performerOwner.performerId,
      eventType: 'performer_public_profile.update',
      previousStatus: null,
      nextStatus: 'published',
      metadata: {
        hasBio: Boolean(bio),
        specialtyCount: specialties?.length ?? 0,
        hasBookingEmail: Boolean(bookingEmail),
        hasBookingPhone: Boolean(bookingPhone),
        linkCount: normalizedLinks.provided ? normalizedLinks.links.length : null
      }
    });

    return tx
      .select({
        id: performerProfileLinks.id,
        label: performerProfileLinks.label,
        description: performerProfileLinks.description,
        url: performerProfileLinks.url,
        kind: performerProfileLinks.kind,
        sortOrder: performerProfileLinks.sortOrder,
        isActive: performerProfileLinks.isActive
      })
      .from(performerProfileLinks)
      .where(eq(performerProfileLinks.performerId, performerOwner.performerId))
      .orderBy(asc(performerProfileLinks.sortOrder), asc(performerProfileLinks.createdAt));
  });

  return res.status(202).json({
    success: true,
    profile: {
      performerId: performerOwner.performerId,
      handle: performerOwner.handle,
      displayName: performerOwner.displayName,
      bio,
      headline,
      specialties: specialties ?? [],
      city,
      avatarUrl,
      booking: {
        email: bookingEmail,
        phone: bookingPhone
      },
      socialLinks: {
        facebook: facebookUrl,
        instagram: instagramUrl,
        tiktok: tiktokUrl,
        youtube: youtubeUrl,
        soundcloud: soundcloudUrl,
        website: websiteUrl
      },
      links: savedLinks
    }
  });
});

app.post('/api/talent/library/import', async (req, res) => {
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) {
    return res.status(talentAccess.status).json({ error: talentAccess.reason });
  }
  if (!talentAccess.actor.actorId) {
    return res.status(401).json({ error: 'Performer session resolution required.' });
  }

  if (!businessDb) {
    return res.status(503).json({ error: 'Performer library import requires a durable database connection.' });
  }

  const performerOwner = await loadOwnedPerformerByActorUserId(talentAccess.actor.actorId);
  if (!performerOwner) {
    return res.status(403).json({ error: 'Only the performer owner can import available tracks.' });
  }

  const sourceKey = normalizeLibrarySourceKey(req.body?.sourceKey);
  const sourceLabel = normalizeLibraryText(req.body?.sourceLabel || req.body?.sourceKey, 80);
  const rawTracks = Array.isArray(req.body?.tracks) ? req.body.tracks : [];

  if (!sourceKey || !sourceLabel) {
    return res.status(422).json({ error: 'A sourceKey and sourceLabel are required for performer library import.' });
  }

  if (!rawTracks.length) {
    return res.status(422).json({ error: 'At least one track is required for performer library import.' });
  }

  await businessDb.transaction(async (tx) => {
    const result = await upsertPerformerLibraryTrackBatch(tx, {
      performerId: performerOwner.performerId,
      sourceKey,
      sourceLabel,
      rawTracks
    });
    if (!result.importedCount) {
      throw new Error('Imported tracks must include at least one valid title.');
    }
  });

  return res.status(202).json({
    success: true,
    performerId: performerOwner.performerId,
    sourceKey,
    sourceLabel,
    importedCount: rawTracks.length
  });
});

app.get('/api/talent/library/sources', async (req, res) => {
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) {
    return res.status(talentAccess.status).json({ error: talentAccess.reason });
  }
  if (!talentAccess.actor.actorId || !businessDb) {
    return res.status(503).json({ error: 'Performer library sources require a durable database connection.' });
  }

  const performerOwner = await loadOwnedPerformerByActorUserId(talentAccess.actor.actorId);
  if (!performerOwner) {
    return res.status(403).json({ error: 'Only the performer owner can manage linked library sources.' });
  }

  const sources = await businessDb
    .select({
      id: performerLibrarySources.id,
      sourceKey: performerLibrarySources.sourceKey,
      sourceLabel: performerLibrarySources.sourceLabel,
      syncKeyPreview: performerLibrarySources.syncKeyPreview,
      connectionStatus: performerLibrarySources.connectionStatus,
      lastSyncedAt: performerLibrarySources.lastSyncedAt,
      trackCount: sql<number>`(
        select count(*)::int
        from ${performerLibraryTracks}
        where ${performerLibraryTracks.performerId} = ${performerLibrarySources.performerId}
          and ${performerLibraryTracks.sourceKey} = ${performerLibrarySources.sourceKey}
      )`
    })
    .from(performerLibrarySources)
    .where(eq(performerLibrarySources.performerId, performerOwner.performerId));

  return res.json({ sources });
});

app.get('/api/talent/music/source-capabilities', async (req, res) => {
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) {
    return res.status(talentAccess.status).json({ error: talentAccess.reason });
  }

  return res.json({
    providers: getMusicSourceCapabilityCatalog({
      spotifyCatalogConfigured: isCatalogSearchConfigured(process.env)
    })
  });
});

app.post('/api/talent/music/spotify/import-playlist', async (req, res) => {
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) {
    return res.status(talentAccess.status).json({ error: talentAccess.reason });
  }
  if (!talentAccess.actor.actorId || !businessDb) {
    return res.status(503).json({ error: 'Spotify playlist import requires a durable database connection.' });
  }

  const performerOwner = await loadOwnedPerformerByActorUserId(talentAccess.actor.actorId);
  if (!performerOwner) {
    return res.status(403).json({ error: 'Only the performer owner can import Spotify playlist metadata.' });
  }

  const playlistUrl = normalizeLibraryText(req.body?.playlistUrl, 512);
  if (!playlistUrl) {
    return res.status(422).json({ error: 'A Spotify playlist URL, URI, or ID is required.' });
  }

  const imported = await importSpotifyPlaylist({
    playlistUrl,
    env: process.env,
    limit: 100
  });

  if (!imported.configured) {
    return res.status(503).json({ error: 'Spotify metadata import is not configured for this Sway environment.' });
  }
  if (!imported.playlistId) {
    return res.status(422).json({ error: 'Enter a valid Spotify playlist URL, URI, or ID.' });
  }
  if (!imported.tracks.length) {
    return res.status(422).json({ error: 'Sway could not import tracks from that Spotify playlist. Confirm the playlist is accessible to the configured Spotify app.' });
  }

  const sourceKey = `spotify-${imported.playlistId}`;
  const sourceLabel = imported.playlistName ? `Spotify: ${imported.playlistName}` : 'Spotify playlist';
  const result = await businessDb.transaction(async (tx) => {
    const upserted = await upsertPerformerLibraryTrackBatch(tx, {
      performerId: performerOwner.performerId,
      sourceKey,
      sourceLabel,
      rawTracks: imported.tracks.map((track) => ({
        title: track.title,
        artist: track.artist,
        album: track.album ?? '',
        artworkUrl: track.albumArt ?? '',
        externalTrackId: track.externalTrackId,
        metadata: {
          sourceProvider: 'spotify',
          spotifyUri: track.spotifyUri,
          spotifyUrl: track.spotifyUrl,
          playlistId: imported.playlistId
        }
      })),
      replaceExisting: true
    });

    await tx
      .insert(performerLibrarySources)
      .values({
        performerId: performerOwner.performerId,
        sourceKey,
        sourceLabel,
        syncKeyHash: hashLibrarySyncKey(issueLibrarySyncKey()),
        syncKeyPreview: 'spotify-import',
        connectionStatus: 'active',
        lastSyncedAt: new Date(),
        metadata: {
          sourceProvider: 'spotify',
          playlistId: imported.playlistId,
          importMode: 'metadata_only'
        },
        updatedAt: new Date()
      })
      .onConflictDoUpdate({
        target: [performerLibrarySources.performerId, performerLibrarySources.sourceKey],
        set: {
          sourceLabel,
          connectionStatus: 'active',
          lastSyncedAt: new Date(),
          metadata: {
            sourceProvider: 'spotify',
            playlistId: imported.playlistId,
            importMode: 'metadata_only'
          },
          updatedAt: new Date()
        }
      });

    return upserted;
  });

  return res.status(202).json({
    success: true,
    sourceKey,
    sourceLabel,
    playlistId: imported.playlistId,
    playlistName: imported.playlistName,
    importedCount: result.importedCount,
    removedCount: result.removedCount,
    playbackMode: 'open_in_spotify'
  });
});

app.post('/api/talent/library/sources', async (req, res) => {
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) {
    return res.status(talentAccess.status).json({ error: talentAccess.reason });
  }
  if (!talentAccess.actor.actorId || !businessDb) {
    return res.status(503).json({ error: 'Performer library sources require a durable database connection.' });
  }

  const performerOwner = await loadOwnedPerformerByActorUserId(talentAccess.actor.actorId);
  if (!performerOwner) {
    return res.status(403).json({ error: 'Only the performer owner can link library sources.' });
  }

  const sourceKey = normalizeLibrarySourceKey(req.body?.sourceKey || req.body?.sourceLabel);
  const sourceLabel = normalizeLibraryText(req.body?.sourceLabel || req.body?.sourceKey, 80);
  if (!sourceKey || !sourceLabel) {
    return res.status(422).json({ error: 'A sourceLabel is required to link a performer library source.' });
  }

  const syncKey = issueLibrarySyncKey();
  const syncKeyHash = hashLibrarySyncKey(syncKey);
  const syncKeyPreview = `${syncKey.slice(0, 12)}...`;

  await businessDb
    .insert(performerLibrarySources)
    .values({
      performerId: performerOwner.performerId,
      sourceKey,
      sourceLabel,
      syncKeyHash,
      syncKeyPreview,
      connectionStatus: 'active',
      updatedAt: new Date()
    })
    .onConflictDoUpdate({
      target: [performerLibrarySources.performerId, performerLibrarySources.sourceKey],
      set: {
        sourceLabel,
        syncKeyHash,
        syncKeyPreview,
        connectionStatus: 'active',
        updatedAt: new Date()
      }
    });

  return res.status(201).json({
    success: true,
    sourceKey,
    sourceLabel,
    syncKey,
    syncEndpointPath: '/api/library/sync'
  });
});

app.post('/api/talent/library/sources/:sourceId/rotate-key', async (req, res) => {
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) {
    return res.status(talentAccess.status).json({ error: talentAccess.reason });
  }
  if (!talentAccess.actor.actorId || !businessDb) {
    return res.status(503).json({ error: 'Performer library source rotation requires a durable database connection.' });
  }

  const performerOwner = await loadOwnedPerformerByActorUserId(talentAccess.actor.actorId);
  const sourceId = parseDurableGigId(req.params.sourceId);
  if (!performerOwner || !sourceId) {
    return res.status(404).json({ error: 'Linked library source not found.' });
  }

  const nextSyncKey = issueLibrarySyncKey();
  const nextSyncKeyHash = hashLibrarySyncKey(nextSyncKey);
  const nextSyncKeyPreview = `${nextSyncKey.slice(0, 12)}...`;

  const [rotated] = await businessDb
    .update(performerLibrarySources)
    .set({
      syncKeyHash: nextSyncKeyHash,
      syncKeyPreview: nextSyncKeyPreview,
      connectionStatus: 'active',
      updatedAt: new Date()
    })
    .where(and(
      eq(performerLibrarySources.id, sourceId),
      eq(performerLibrarySources.performerId, performerOwner.performerId)
    ))
    .returning({
      sourceKey: performerLibrarySources.sourceKey,
      sourceLabel: performerLibrarySources.sourceLabel
    });

  if (!rotated) {
    return res.status(404).json({ error: 'Linked library source not found.' });
  }

  return res.json({
    success: true,
    sourceKey: rotated.sourceKey,
    sourceLabel: rotated.sourceLabel,
    syncKey: nextSyncKey,
    syncEndpointPath: '/api/library/sync'
  });
});

app.post('/api/talent/library/sources/:sourceId/revoke', async (req, res) => {
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) {
    return res.status(talentAccess.status).json({ error: talentAccess.reason });
  }
  if (!talentAccess.actor.actorId || !businessDb) {
    return res.status(503).json({ error: 'Performer library source revoke requires a durable database connection.' });
  }

  const performerOwner = await loadOwnedPerformerByActorUserId(talentAccess.actor.actorId);
  const sourceId = parseDurableGigId(req.params.sourceId);
  if (!performerOwner || !sourceId) {
    return res.status(404).json({ error: 'Linked library source not found.' });
  }

  const [revoked] = await businessDb
    .update(performerLibrarySources)
    .set({
      connectionStatus: 'revoked',
      updatedAt: new Date()
    })
    .where(and(
      eq(performerLibrarySources.id, sourceId),
      eq(performerLibrarySources.performerId, performerOwner.performerId)
    ))
    .returning({ id: performerLibrarySources.id });

  if (!revoked) {
    return res.status(404).json({ error: 'Linked library source not found.' });
  }

  return res.json({ success: true, revoked: true });
});

function requireAudioPublishingRuntime(res: express.Response): boolean {
  if (!AUDIO_PUBLISHING_RUNTIME_CAPABILITIES.resumableUploadRoutes
    || !AUDIO_PUBLISHING_RUNTIME_CAPABILITIES.losslessObjectStorage
    || !AUDIO_PUBLISHING_RUNTIME_CAPABILITIES.privateDownloadAuthorization) {
    res.status(503).json({ error: 'Audio publishing runtime is not enabled.' });
    return false;
  }
  if (!businessDb || !audioPublishingService || !audioObjectStore) {
    res.status(503).json({
      error: 'Audio file storage is not configured. Set SWAY_AUDIO_STORAGE_PROVIDER=local_private_fs with a private object directory.'
    });
    return false;
  }
  return true;
}

app.get('/api/talent/audio/projects', async (req, res) => {
  applyNoStoreHeaders(res);
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) return res.status(talentAccess.status).json({ error: talentAccess.reason });
  if (!talentAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireAudioPublishingRuntime(res) || !audioPublishingService) return;

  const performerOwner = await loadOwnedPerformerByActorUserId(talentAccess.actor.actorId);
  if (!performerOwner) return res.status(403).json({ error: 'Only the performer owner can manage audio projects.' });

  const projects = await audioPublishingService.listProjects({
    performerId: performerOwner.performerId,
    actorUserId: talentAccess.actor.actorId
  });
  return res.json({ projects });
});

app.post('/api/talent/audio/projects', async (req, res) => {
  applyNoStoreHeaders(res);
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) return res.status(talentAccess.status).json({ error: talentAccess.reason });
  if (!talentAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireAudioPublishingRuntime(res) || !audioPublishingService) return;

  const performerOwner = await loadOwnedPerformerByActorUserId(talentAccess.actor.actorId);
  if (!performerOwner) return res.status(403).json({ error: 'Only the performer owner can create audio projects.' });

  try {
    const project = await audioPublishingService.createProject({
      performerId: performerOwner.performerId,
      actorUserId: talentAccess.actor.actorId,
      title: typeof req.body?.title === 'string' ? req.body.title : '',
      projectKind: req.body?.projectKind
    });
    return res.status(201).json({ project });
  } catch (error) {
    return res.status(422).json({ error: error instanceof Error ? error.message : 'Could not create project.' });
  }
});

app.get('/api/talent/audio/projects/:projectId/assets', async (req, res) => {
  applyNoStoreHeaders(res);
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) return res.status(talentAccess.status).json({ error: talentAccess.reason });
  if (!talentAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireAudioPublishingRuntime(res) || !audioPublishingService) return;

  try {
    const payload = await audioPublishingService.listProjectAssets({
      projectId: req.params.projectId,
      actorUserId: talentAccess.actor.actorId
    });
    return res.json(payload);
  } catch (error) {
    return res.status(403).json({ error: error instanceof Error ? error.message : 'Project access denied.' });
  }
});

app.post('/api/talent/audio/projects/:projectId/uploads', async (req, res) => {
  applyNoStoreHeaders(res);
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) return res.status(talentAccess.status).json({ error: talentAccess.reason });
  if (!talentAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireAudioPublishingRuntime(res) || !audioPublishingService) return;

  try {
    const session = await audioPublishingService.initiateUpload({
      projectId: req.params.projectId,
      actorUserId: talentAccess.actor.actorId,
      title: typeof req.body?.title === 'string' ? req.body.title : '',
      assetKind: typeof req.body?.assetKind === 'string' ? req.body.assetKind : 'master_audio',
      originalFilename: typeof req.body?.originalFilename === 'string' ? req.body.originalFilename : 'upload.bin',
      mimeType: typeof req.body?.mimeType === 'string' ? req.body.mimeType : 'application/octet-stream',
      expectedByteSize: Number(req.body?.expectedByteSize),
      expectedSha256: typeof req.body?.expectedSha256 === 'string' ? req.body.expectedSha256 : '',
      idempotencyKey: typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey : '',
      partSizeBytes: req.body?.partSizeBytes != null ? Number(req.body.partSizeBytes) : undefined
    });
    if (!session.idempotencyKey) {
      return res.status(422).json({ error: 'idempotencyKey is required.' });
    }
    return res.status(201).json({ uploadSession: session });
  } catch (error) {
    return res.status(422).json({ error: error instanceof Error ? error.message : 'Could not start upload.' });
  }
});

app.put('/api/talent/audio/uploads/:uploadSessionId/parts/:partNumber', async (req, res) => {
  applyNoStoreHeaders(res);
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) return res.status(talentAccess.status).json({ error: talentAccess.reason });
  if (!talentAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireAudioPublishingRuntime(res) || !audioPublishingService) return;

  const partNumber = Number(req.params.partNumber);
  const contentBase64 = typeof req.body?.contentBase64 === 'string' ? req.body.contentBase64 : '';
  if (!contentBase64) return res.status(422).json({ error: 'contentBase64 is required for this upload part.' });

  let body: Buffer;
  try {
    body = Buffer.from(contentBase64, 'base64');
  } catch {
    return res.status(422).json({ error: 'contentBase64 is invalid.' });
  }
  if (!body.byteLength || body.byteLength > 6 * 1024 * 1024) {
    return res.status(413).json({ error: 'Each upload part must be between 1 byte and 6 MiB.' });
  }

  try {
    const written = await audioPublishingService.writeUploadPart({
      uploadSessionId: req.params.uploadSessionId,
      actorUserId: talentAccess.actor.actorId,
      partNumber,
      body
    });
    return res.json({ part: written });
  } catch (error) {
    return res.status(422).json({ error: error instanceof Error ? error.message : 'Could not store upload part.' });
  }
});

app.post('/api/talent/audio/uploads/:uploadSessionId/complete', async (req, res) => {
  applyNoStoreHeaders(res);
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) return res.status(talentAccess.status).json({ error: talentAccess.reason });
  if (!talentAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireAudioPublishingRuntime(res) || !audioPublishingService) return;

  const performerOwner = await loadOwnedPerformerByActorUserId(talentAccess.actor.actorId);
  if (!performerOwner) return res.status(403).json({ error: 'Only the performer owner can seal uploads.' });

  try {
    const version = await audioPublishingService.completeAndSealUpload({
      uploadSessionId: req.params.uploadSessionId,
      actorUserId: talentAccess.actor.actorId,
      performerId: performerOwner.performerId
    });
    return res.json({ version });
  } catch (error) {
    return res.status(422).json({ error: error instanceof Error ? error.message : 'Could not seal upload.' });
  }
});

app.post('/api/talent/audio/versions/:versionId/shares', async (req, res) => {
  applyNoStoreHeaders(res);
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) return res.status(talentAccess.status).json({ error: talentAccess.reason });
  if (!talentAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireAudioPublishingRuntime(res) || !audioPublishingService) return;

  try {
    const result = await audioPublishingService.createShareGrant({
      versionId: req.params.versionId,
      actorUserId: talentAccess.actor.actorId,
      maxUses: req.body?.maxUses != null ? Number(req.body.maxUses) : 5,
      recipientLabel: typeof req.body?.recipientLabel === 'string' ? req.body.recipientLabel : null
    });
    return res.status(201).json({
      shareGrantId: result.grant.id,
      expiresAt: result.grant.expiresAt,
      maxUses: result.grant.maxUses,
      // Returned once. Client should keep it in memory / fragment transport only.
      shareToken: result.rawToken
    });
  } catch (error) {
    return res.status(422).json({ error: error instanceof Error ? error.message : 'Could not create share grant.' });
  }
});

app.post('/api/talent/audio/shares/download', async (req, res) => {
  applyNoStoreHeaders(res);
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) return res.status(talentAccess.status).json({ error: talentAccess.reason });
  if (!talentAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireAudioPublishingRuntime(res) || !audioPublishingService) return;

  const shareToken = typeof req.body?.shareToken === 'string' ? req.body.shareToken : '';
  if (!shareToken) return res.status(422).json({ error: 'shareToken is required in the POST body.' });

  try {
    const downloaded = await audioPublishingService.downloadSharedOriginal({
      rawToken: shareToken,
      actorUserId: talentAccess.actor.actorId
    });
    res.setHeader('Content-Type', downloaded.version.mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', String(downloaded.byteSize));
    res.setHeader('Content-Disposition', `attachment; filename="${downloaded.version.originalFilename.replace(/"/g, '')}"`);
    res.setHeader('X-Sway-Asset-Sha256', downloaded.version.sha256);
    downloaded.stream.pipe(res);
  } catch (error) {
    return res.status(403).json({ error: error instanceof Error ? error.message : 'Share download denied.' });
  }
});

app.get('/api/talent/setlist', async (req, res) => {
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) {
    return res.status(talentAccess.status).json({ error: talentAccess.reason });
  }
  if (!talentAccess.actor.actorId || !businessDb) {
    return res.status(503).json({ error: 'Performer setlists require a durable database connection.' });
  }

  const performerOwner = await loadOwnedPerformerByActorUserId(talentAccess.actor.actorId);
  if (!performerOwner) {
    return res.status(403).json({ error: 'Only the performer owner can manage a setlist.' });
  }

  const tracks = await businessDb
    .select({
      id: performerSetlistTracks.id,
      title: performerSetlistTracks.title,
      artist: performerSetlistTracks.artist,
      album: performerSetlistTracks.album,
      artworkUrl: performerSetlistTracks.artworkUrl,
      spotifyUri: performerSetlistTracks.spotifyUri,
      spotifyUrl: performerSetlistTracks.spotifyUrl,
      sourceKey: performerSetlistTracks.sourceKey,
      addedAt: performerSetlistTracks.addedAt
    })
    .from(performerSetlistTracks)
    .where(eq(performerSetlistTracks.performerId, performerOwner.performerId))
    .orderBy(asc(performerSetlistTracks.addedAt));

  return res.json({ tracks });
});

// Search candidates to add to the performer's setlist: their synced library
// plus the open catalog (when configured), merged into one result list.
app.get('/api/talent/setlist/search', async (req, res) => {
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) {
    return res.status(talentAccess.status).json({ error: talentAccess.reason });
  }
  if (!talentAccess.actor.actorId || !businessDb) {
    return res.status(503).json({ error: 'Performer setlists require a durable database connection.' });
  }

  const performerOwner = await loadOwnedPerformerByActorUserId(talentAccess.actor.actorId);
  if (!performerOwner) {
    return res.status(403).json({ error: 'Only the performer owner can manage a setlist.' });
  }

  const query = normalizeLibraryText(req.query?.query, 160);
  const likeQuery = `%${query.toLowerCase()}%`;

  const libraryRows = query
    ? await businessDb
        .select({
          externalTrackId: performerLibraryTracks.externalTrackId,
          title: performerLibraryTracks.title,
          artist: performerLibraryTracks.artist,
          album: performerLibraryTracks.album,
          artworkUrl: performerLibraryTracks.artworkUrl,
          metadata: performerLibraryTracks.metadata
        })
        .from(performerLibraryTracks)
        .where(and(
          eq(performerLibraryTracks.performerId, performerOwner.performerId),
          sql`lower(${performerLibraryTracks.searchableText}) like ${likeQuery}`
        ))
        .limit(15)
    : [];

  const catalog = query ? await searchCatalog({ query, env: process.env }) : { configured: false, results: [] as Awaited<ReturnType<typeof searchCatalog>>['results'] };

  return res.json({
    results: [
      ...libraryRows.map((row) => ({
        sourceKey: 'library',
        externalTrackId: row.externalTrackId,
        title: row.title,
        artist: row.artist,
        album: row.album,
        artworkUrl: row.artworkUrl,
        spotifyUri: typeof (row.metadata as any)?.spotifyUri === 'string' ? (row.metadata as any).spotifyUri : null,
        spotifyUrl: typeof (row.metadata as any)?.spotifyUrl === 'string' ? (row.metadata as any).spotifyUrl : null
      })),
      ...(catalog.configured ? catalog.results.map((track) => ({
        sourceKey: 'catalog',
        externalTrackId: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album ?? null,
        artworkUrl: track.albumArt ?? null,
        spotifyUri: track.spotifyUri ?? null,
        spotifyUrl: track.spotifyUrl ?? null
      })) : [])
    ]
  });
});

app.post('/api/talent/setlist/add', async (req, res) => {
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) {
    return res.status(talentAccess.status).json({ error: talentAccess.reason });
  }
  if (!talentAccess.actor.actorId || !businessDb) {
    return res.status(503).json({ error: 'Performer setlists require a durable database connection.' });
  }

  const performerOwner = await loadOwnedPerformerByActorUserId(talentAccess.actor.actorId);
  if (!performerOwner) {
    return res.status(403).json({ error: 'Only the performer owner can manage a setlist.' });
  }

  const title = normalizeLibraryText(req.body?.title, 160);
  const artist = normalizeLibraryText(req.body?.artist, 160);
  if (!title || !artist) {
    return res.status(422).json({ error: 'A title and artist are required to add a setlist track.' });
  }
  const album = normalizeLibraryText(req.body?.album, 160) || null;
  const artworkUrl = normalizeLibraryText(req.body?.artworkUrl, 512) || null;
  const spotifyUri = normalizeLibraryText(req.body?.spotifyUri, 256) || null;
  const spotifyUrl = normalizeLibraryText(req.body?.spotifyUrl, 512) || null;
  const sourceKey = normalizeLibrarySourceKey(req.body?.sourceKey) || 'manual';
  const externalTrackId = normalizeLibraryText(req.body?.externalTrackId, 256) || null;

  const [existing] = await businessDb
    .select({ id: performerSetlistTracks.id })
    .from(performerSetlistTracks)
    .where(and(
      eq(performerSetlistTracks.performerId, performerOwner.performerId),
      sql`lower(${performerSetlistTracks.title}) = ${title.toLowerCase()}`,
      sql`lower(${performerSetlistTracks.artist}) = ${artist.toLowerCase()}`
    ))
    .limit(1);

  if (existing) {
    return res.status(200).json({ success: true, alreadyAdded: true, id: existing.id });
  }

  const [inserted] = await businessDb
    .insert(performerSetlistTracks)
    .values({
      performerId: performerOwner.performerId,
      sourceKey,
      externalTrackId,
      title,
      artist,
      album,
      artworkUrl,
      spotifyUri,
      spotifyUrl,
      searchableText: `${title} ${artist}`.toLowerCase(),
      updatedAt: new Date()
    })
    .returning({ id: performerSetlistTracks.id });

  return res.status(201).json({ success: true, id: inserted.id });
});

app.post('/api/talent/setlist/remove', async (req, res) => {
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) {
    return res.status(talentAccess.status).json({ error: talentAccess.reason });
  }
  if (!talentAccess.actor.actorId || !businessDb) {
    return res.status(503).json({ error: 'Performer setlists require a durable database connection.' });
  }

  const performerOwner = await loadOwnedPerformerByActorUserId(talentAccess.actor.actorId);
  const trackId = parseDurableGigId(req.body?.trackId);
  if (!performerOwner || !trackId) {
    return res.status(404).json({ error: 'Setlist track not found.' });
  }

  const [removed] = await businessDb
    .delete(performerSetlistTracks)
    .where(and(
      eq(performerSetlistTracks.id, trackId),
      eq(performerSetlistTracks.performerId, performerOwner.performerId)
    ))
    .returning({ id: performerSetlistTracks.id });

  if (!removed) {
    return res.status(404).json({ error: 'Setlist track not found.' });
  }

  return res.json({ success: true, removed: true });
});

// Creates (if needed) the performer's Stripe recipient connected account and
// returns a fresh Stripe-hosted onboarding link. Idempotent: reuses the
// existing connected account on repeat calls instead of creating duplicates.
app.post('/api/talent/connect/onboard', async (req, res) => {
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) {
    return res.status(talentAccess.status).json({ error: talentAccess.reason });
  }
  if (!talentAccess.actor.actorId || !businessDb) {
    return res.status(503).json({ error: 'Performer payouts require a durable database connection.' });
  }
  if (!stripeConnectService) {
    return res.status(503).json({ error: 'Stripe Connect is not configured yet.' });
  }

  const performerOwner = await loadOwnedPerformerByActorUserId(talentAccess.actor.actorId);
  if (!performerOwner) {
    return res.status(403).json({ error: 'Only the performer owner can connect a payout account.' });
  }

  try {
    const [performerRow] = await businessDb
      .select({ stripeConnectedAccountId: performers.stripeConnectedAccountId })
      .from(performers)
      .where(eq(performers.id, performerOwner.performerId))
      .limit(1);

    let accountId = performerRow?.stripeConnectedAccountId ?? null;
    if (!accountId) {
      const created = await stripeConnectService.createRecipientAccount({
        displayName: performerOwner.displayName
      });
      accountId = created.accountId;
      await businessDb
        .update(performers)
        .set({ stripeConnectedAccountId: accountId })
        .where(eq(performers.id, performerOwner.performerId));
    }

    const appBaseUrl = resolvePerformerLoginBaseUrl(process.env).replace(/\/+$/, '');
    const { url } = await stripeConnectService.createOnboardingLink({
      accountId,
      refreshUrl: `${appBaseUrl}/talent/connect/refresh`,
      returnUrl: `${appBaseUrl}/talent/connect/return`
    });

    return res.json({ success: true, url });
  } catch (error) {
    console.error('Stripe Connect onboarding failed.', {
      message: error instanceof Error ? error.message : 'unknown_error'
    });
    return res.status(502).json({
      error: 'Stripe Connect onboarding could not be started. Confirm Stripe Connect is enabled for the Stripe account and Render is using test-mode Stripe keys.'
    });
  }
});

app.get('/talent/connect/refresh', (_req, res) => {
  res.redirect('/talent');
});

app.get('/talent/connect/return', (_req, res) => {
  res.redirect('/talent');
});

app.post('/api/library/sync', async (req, res) => {
  if (!businessDb) {
    return res.status(503).json({ error: 'Library sync requires a durable database connection.' });
  }

  const bearerToken = req.header('authorization')?.startsWith('Bearer ')
    ? req.header('authorization')?.slice('Bearer '.length).trim()
    : null;
  const rawSyncKey = req.header('x-sway-library-key')?.trim() || bearerToken || null;
  if (!rawSyncKey) {
    return res.status(401).json({ error: 'A valid library sync key is required.' });
  }

  const syncKeyHash = hashLibrarySyncKey(rawSyncKey);
  const [sourceRow] = await businessDb
    .select({
      id: performerLibrarySources.id,
      performerId: performerLibrarySources.performerId,
      sourceKey: performerLibrarySources.sourceKey,
      sourceLabel: performerLibrarySources.sourceLabel
    })
    .from(performerLibrarySources)
    .where(eq(performerLibrarySources.syncKeyHash, syncKeyHash))
    .limit(1);

  if (!sourceRow) {
    return res.status(403).json({ error: 'Invalid library sync key.' });
  }

  const rawTracks = Array.isArray(req.body?.tracks) ? req.body.tracks : [];
  const replaceExisting = req.body?.replaceExisting === true;
  if (!rawTracks.length) {
    return res.status(422).json({ error: 'At least one track is required for library sync.' });
  }

  try {
    const result = await businessDb.transaction(async (tx) => {
      const imported = await upsertPerformerLibraryTrackBatch(tx, {
        performerId: sourceRow.performerId,
        sourceKey: sourceRow.sourceKey,
        sourceLabel: sourceRow.sourceLabel,
        rawTracks,
        replaceExisting
      });

      await tx
        .update(performerLibrarySources)
        .set({
          connectionStatus: 'active',
          lastSyncedAt: new Date(),
          updatedAt: new Date()
        })
        .where(eq(performerLibrarySources.id, sourceRow.id));

      return imported;
    });

    return res.status(202).json({
      success: true,
      sourceKey: sourceRow.sourceKey,
      importedCount: result.importedCount,
      removedCount: result.removedCount,
      replaceExisting
    });
  } catch (error) {
    console.error('Library sync failed:', error);
    return res.status(400).json({
      error: error instanceof Error ? error.message : 'Library sync failed. Check the track payload and try again.'
    });
  }
});

// Stripe webhook ingestion. Signature verification is mandatory and the payment
// is resolved from the verified PaymentIntent id, never from request input.
app.post("/api/payment/webhook", async (req, res) => {
  const rawBody = (req as express.Request & { rawBody?: string }).rawBody;
  if (typeof rawBody !== 'string') {
    return res.status(400).json({ error: "Raw request body unavailable for signature verification." });
  }
  const signatureHeader = req.header('stripe-signature') ?? null;

  // Stripe can send both payment and Connect events to one endpoint. Try the
  // Connect (account.updated) branch first -- it's a no-op for any other
  // event type or an invalid signature, so it never interferes with the
  // payment webhook path below.
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (stripeConnectService && webhookSecret && businessDb) {
    try {
      const accountEvent = await stripeConnectService.parseAccountUpdatedEvent({ rawBody, signatureHeader, webhookSecret });
      if (accountEvent) {
        const { chargesEnabled, payoutsEnabled, detailsSubmitted } = accountEvent.status;
        const paymentAccountStatus = payoutsEnabled
          ? 'payouts_enabled'
          : chargesEnabled
            ? 'charges_enabled'
            : detailsSubmitted
              ? 'created'
              : 'not_started';
        await businessDb
          .update(performers)
          .set({ chargesEnabled, payoutsEnabled, paymentAccountStatus })
          .where(eq(performers.stripeConnectedAccountId, accountEvent.accountId));
        return res.json({ received: true, result: { type: 'account.updated' } });
      }
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : 'Connect webhook processing failed.'
      });
    }
  }

  if (!paymentWebhookService) {
    return res.status(503).json({ error: "Payment provider is not configured." });
  }
  try {
    const result = await paymentWebhookService.ingestWebhook({ rawBody, signatureHeader });
    return res.json({ received: true, result });
  } catch (error) {
    return res.status(400).json({
      error: error instanceof Error ? error.message : 'Webhook processing failed.'
    });
  }
});

app.get("/api/state", async (req, res) => {
  await refreshBusinessState();
  const talentAccess = await accessControl.requireTalentAccess(req);
  const performerProfile = talentAccess.allowed
    ? await loadAuthenticatedPerformerProfile(req)
    : null;
  applyNoStoreHeaders(res);
  if (talentAccess.allowed) {
    return res.json({
      session: state.session,
      requests: state.requests,
      performers: state.performers,
      activeGigId: state.activeGigId,
      performerProfile
    });
  }

  return res.json({
    ...projectPublicRoomState(state, null),
    performerProfile: null
  });
});

app.get('/api/public/feed', async (_req, res) => {
  applyNoStoreHeaders(res);

  try {
    const activeRooms = await listReadableActiveRooms();
    if (!activeRooms.length) {
      return res.json({ rooms: [] });
    }

    const roomLimit = Math.max(1, Math.min(30, Number(_req.query?.limit) || 12));
    const selectedRooms = activeRooms.slice(0, roomLimit);

    if (!businessDb) {
      return res.status(503).json({ error: 'Public performer discovery requires durable performer status checks.' });
    }

    const gigIds = selectedRooms.map((room) => room.gigId);
    const details = await businessDb
      .select({
        gigId: gigSessions.id,
        performerName: performers.displayName,
        performerHandle: performers.handle,
        headline: performerPublicProfiles.headline,
        city: performerPublicProfiles.city,
        avatarUrl: performerPublicProfiles.avatarUrl,
        facebookUrl: performerPublicProfiles.facebookUrl,
        instagramUrl: performerPublicProfiles.instagramUrl,
        tiktokUrl: performerPublicProfiles.tiktokUrl,
        youtubeUrl: performerPublicProfiles.youtubeUrl,
        soundcloudUrl: performerPublicProfiles.soundcloudUrl,
        websiteUrl: performerPublicProfiles.websiteUrl
      })
      .from(gigSessions)
      .innerJoin(performers, eq(performers.id, gigSessions.performerId))
      .leftJoin(performerPublicProfiles, eq(performerPublicProfiles.performerId, performers.id))
      .where(and(
        inArray(gigSessions.id, gigIds),
        eq(performers.isActive, true),
        notInArray(performers.onboardingStatus, ['suspended'])
      ));

    const detailsByGigId = new Map(details.map((row) => [row.gigId, row]));

    return res.json({
      rooms: selectedRooms
        .filter((room) => detailsByGigId.has(room.gigId))
        .map((room) => {
        const detail = detailsByGigId.get(room.gigId)!;
        return {
          gigId: room.gigId,
          routePath: room.routePath,
          performerName: detail.performerName || room.performerName,
          performerHandle: detail.performerHandle || null,
          performerPath: detail.performerHandle ? `/p/${detail.performerHandle}` : null,
          talentRole: room.talentRole,
          requestCount: room.requestCount,
          startedAt: room.startedAt,
          profile: {
            headline: detail.headline,
            city: detail.city,
            avatarUrl: normalizePublicProfileUrl(detail.avatarUrl),
            socialLinks: toPublicSocialLinks({
              facebookUrl: detail.facebookUrl,
              instagramUrl: detail.instagramUrl,
              tiktokUrl: detail.tiktokUrl,
              youtubeUrl: detail.youtubeUrl,
              soundcloudUrl: detail.soundcloudUrl,
              websiteUrl: detail.websiteUrl
            })
          }
        };
      })
    });
  } catch (error) {
    console.error('Public feed lookup failed:', error);
    return res.status(500).json({ error: 'Unable to load the public feed right now.' });
  }
});

app.get('/api/public/performer/:handle/share-card.png', async (req, res) => {
  const profile = await findPublicShareProfile(req.params.handle);
  if (!profile) return res.status(404).send('Performer profile not found.');

  try {
    const card = await renderPerformerShareCard(profile);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    res.setHeader('Content-Length', String(card.length));
    return res.status(200).send(card);
  } catch (error) {
    console.error('Performer share card render failed:', error);
    return res.status(500).send('Unable to render performer share card.');
  }
});

app.get('/api/public/performer/:handle', async (req, res) => {
  applyNoStoreHeaders(res);

  const normalizedHandle = normalizePerformerHandle(req.params.handle);
  if (!normalizedHandle) {
    return res.status(404).json({ error: 'Performer profile not found.' });
  }

  if (!businessDb) {
    return res.status(503).json({ error: 'Public performer profiles require a durable database connection.' });
  }

  try {
    const [profile] = await businessDb
      .select({
        performerId: performers.id,
        ownerEmailVerifiedAt: users.emailVerifiedAt,
        displayName: performers.displayName,
        handle: performers.handle,
        bio: performers.bio,
        headline: performerPublicProfiles.headline,
        specialties: performerPublicProfiles.specialties,
        city: performerPublicProfiles.city,
        avatarUrl: performerPublicProfiles.avatarUrl,
        metadata: performerPublicProfiles.metadata,
        bookingEmail: performerPublicProfiles.bookingEmail,
        bookingPhone: performerPublicProfiles.bookingPhone,
        facebookUrl: performerPublicProfiles.facebookUrl,
        instagramUrl: performerPublicProfiles.instagramUrl,
        tiktokUrl: performerPublicProfiles.tiktokUrl,
        youtubeUrl: performerPublicProfiles.youtubeUrl,
        soundcloudUrl: performerPublicProfiles.soundcloudUrl,
        websiteUrl: performerPublicProfiles.websiteUrl,
        featuredMedia: performerPublicProfiles.featuredMedia
      })
      .from(performers)
      .innerJoin(users, eq(users.id, performers.ownerUserId))
      .leftJoin(performerPublicProfiles, eq(performerPublicProfiles.performerId, performers.id))
      .where(and(
        sql`lower(${performers.handle}) = ${normalizedHandle.toLowerCase()}`,
        eq(performers.isActive, true),
        notInArray(performers.onboardingStatus, ['suspended'])
      ))
      .limit(1);

    if (!profile) {
      // Never fall back to a preview when a real performer row exists but is
      // inactive or suspended. That keeps inactive/suspended handles dark.
      const [existingPerformer] = await businessDb
        .select({ id: performers.id })
        .from(performers)
        .where(sql`lower(${performers.handle}) = ${normalizedHandle.toLowerCase()}`)
        .limit(1);

      if (existingPerformer) {
        return res.status(404).json({ error: 'Performer profile not found.' });
      }

      const [preview] = await businessDb
        .select({
          displayName: performerProfilePreviews.displayName,
          handle: performerProfilePreviews.handle,
          claimedPerformerId: performerProfilePreviews.claimedPerformerId,
          bio: performerProfilePreviews.bio,
          headline: performerProfilePreviews.headline,
          specialties: performerProfilePreviews.specialties,
          city: performerProfilePreviews.city,
          avatarUrl: performerProfilePreviews.avatarUrl,
          metadata: performerProfilePreviews.metadata,
          facebookUrl: performerProfilePreviews.facebookUrl,
          instagramUrl: performerProfilePreviews.instagramUrl,
          tiktokUrl: performerProfilePreviews.tiktokUrl,
          youtubeUrl: performerProfilePreviews.youtubeUrl,
          soundcloudUrl: performerProfilePreviews.soundcloudUrl,
          websiteUrl: performerProfilePreviews.websiteUrl,
          links: performerProfilePreviews.links,
          featuredMedia: performerProfilePreviews.featuredMedia
        })
        .from(performerProfilePreviews)
        .where(and(
          sql`lower(${performerProfilePreviews.handle}) = ${normalizedHandle.toLowerCase()}`,
          eq(performerProfilePreviews.isActive, true)
        ))
        .limit(1);

      if (!preview) {
        return res.status(404).json({ error: 'Performer profile not found.' });
      }

      const normalizedPreviewLinks = normalizePublicProfileLinks(preview.links ?? undefined);
      const previewLinks = normalizedPreviewLinks.links
        .filter((link) => link.isActive)
        .map(({ isActive: _isActive, ...link }) => link);
      const normalizedPreviewMedia = normalizePublicProfileFeaturedMedia(preview.featuredMedia ?? undefined);
      const previewMedia = normalizedPreviewMedia.media
        .filter((media) => media.isActive)
        .map(({ isActive: _isActive, ...media }) => media);

      return res.json({
        performer: {
          displayName: preview.displayName,
          stageName: resolvePublicStageName({
            displayName: preview.displayName,
            handle: preview.handle,
            headline: preview.headline,
            metadata: preview.metadata
          }),
          handle: preview.handle,
          bio: preview.bio,
          headline: preview.headline,
          specialties: preview.specialties ?? [],
          city: preview.city,
          avatarUrl: normalizePublicProfileUrl(preview.avatarUrl),
          booking: {
            email: null,
            phone: null,
            available: false,
            verificationRequired: false
          },
          socialLinks: toPublicSocialLinks({
            facebookUrl: preview.facebookUrl,
            instagramUrl: preview.instagramUrl,
            tiktokUrl: preview.tiktokUrl,
            youtubeUrl: preview.youtubeUrl,
            soundcloudUrl: preview.soundcloudUrl,
            websiteUrl: preview.websiteUrl
          }),
          links: previewLinks,
          featuredMedia: previewMedia,
          partner: {
            active: false,
            kind: null,
            termsVersion: null
          },
          isPreview: true,
          claimState: preview.claimedPerformerId ? 'pending' : 'unclaimed'
        },
        activeRoom: null
      });
    }

    const [[activeRoom], linkRows, partnerState, [curatedPreview]] = await Promise.all([
      businessDb
        .select({
          gigId: activeRoomRegistry.gigId,
          routePath: activeRoomRegistry.routePath,
          talentRole: activeRoomRegistry.talentRole,
          startedAt: activeRoomRegistry.startedAt
        })
        .from(activeRoomRegistry)
        .where(and(
          eq(activeRoomRegistry.performerId, profile.performerId),
          eq(activeRoomRegistry.registryStatus, 'active')
        ))
        .orderBy(sql`${activeRoomRegistry.lastActivityAt} desc`)
        .limit(1),
      businessDb
        .select({
          label: performerProfileLinks.label,
          description: performerProfileLinks.description,
          url: performerProfileLinks.url,
          kind: performerProfileLinks.kind,
          sortOrder: performerProfileLinks.sortOrder
        })
        .from(performerProfileLinks)
        .where(and(
          eq(performerProfileLinks.performerId, profile.performerId),
          eq(performerProfileLinks.isActive, true)
        ))
        .orderBy(asc(performerProfileLinks.sortOrder), asc(performerProfileLinks.createdAt)),
      loadPartnerEntitlementStateForPerformer(businessDb, profile.performerId),
      businessDb
        .select({
          claimedPerformerId: performerProfilePreviews.claimedPerformerId,
          displayName: performerProfilePreviews.displayName,
          handle: performerProfilePreviews.handle,
          bio: performerProfilePreviews.bio,
          headline: performerProfilePreviews.headline,
          specialties: performerProfilePreviews.specialties,
          city: performerProfilePreviews.city,
          avatarUrl: performerProfilePreviews.avatarUrl,
          metadata: performerProfilePreviews.metadata,
          facebookUrl: performerProfilePreviews.facebookUrl,
          instagramUrl: performerProfilePreviews.instagramUrl,
          tiktokUrl: performerProfilePreviews.tiktokUrl,
          youtubeUrl: performerProfilePreviews.youtubeUrl,
          soundcloudUrl: performerProfilePreviews.soundcloudUrl,
          websiteUrl: performerProfilePreviews.websiteUrl,
          links: performerProfilePreviews.links,
          featuredMedia: performerProfilePreviews.featuredMedia
        })
        .from(performerProfilePreviews)
        .where(and(
          sql`lower(${performerProfilePreviews.handle}) = ${normalizedHandle.toLowerCase()}`,
          eq(performerProfilePreviews.isActive, true),
          or(isNull(performerProfilePreviews.claimedPerformerId), eq(performerProfilePreviews.claimedPerformerId, profile.performerId))
        ))
        .limit(1)
    ]);

    const activeRooms = await listReadableActiveRooms(profile.performerId);
    const activeRoomSummary = activeRoom
      ? activeRooms.find((room) => room.gigId === activeRoom.gigId) ?? null
      : null;
    const publicLinkRows = linkRows.flatMap((link) => {
      const safeUrl = normalizePublicProfileUrl(link.url);
      return safeUrl ? [{ ...link, url: safeUrl }] : [];
    });
    const normalizedCuratedLinks = normalizePublicProfileLinks(curatedPreview?.links ?? undefined);
    const curatedLinkRows = normalizedCuratedLinks.links
      .filter((link) => link.isActive)
      .map(({ isActive: _isActive, ...link }) => link);
    const combinedLinkRows = [...publicLinkRows, ...curatedLinkRows.filter((curatedLink) => (
      !publicLinkRows.some((publicLink) => publicLink.url === curatedLink.url || publicLink.label.toLowerCase() === curatedLink.label.toLowerCase())
    ))].slice(0, 12);
    const effectiveHeadline = profile.headline || curatedPreview?.headline || null;
    const effectiveBio = profile.bio || curatedPreview?.bio || null;
    const effectiveSpecialties = profile.specialties?.length
      ? profile.specialties
      : curatedPreview?.specialties ?? [];
    const effectiveCity = profile.city || curatedPreview?.city || null;
    const effectiveAvatarUrl = profile.avatarUrl || curatedPreview?.avatarUrl || null;
    const normalizedMedia = normalizePublicProfileFeaturedMedia(
      Array.isArray(profile.featuredMedia) && profile.featuredMedia.length
        ? profile.featuredMedia
        : curatedPreview?.featuredMedia
    );
    const publicMedia = normalizedMedia.media
      .filter((media) => media.isActive)
      .map(({ isActive: _isActive, ...media }) => media);
    const effectiveMetadata = profile.metadata || curatedPreview?.metadata || null;
    const stageName = resolvePublicStageName({
      displayName: profile.displayName,
      handle: profile.handle,
      headline: effectiveHeadline,
      metadata: effectiveMetadata
    });
    const publicBooking = resolveVerifiedPublicBookingContact({
      email: profile.bookingEmail,
      phone: profile.bookingPhone,
      ownerEmailVerifiedAt: profile.ownerEmailVerifiedAt
    });

    return res.json({
      performer: {
        displayName: profile.displayName,
        stageName,
        handle: profile.handle,
        bio: effectiveBio,
        headline: effectiveHeadline,
        specialties: effectiveSpecialties,
        city: effectiveCity,
        avatarUrl: normalizePublicProfileUrl(effectiveAvatarUrl),
        booking: publicBooking,
        socialLinks: toPublicSocialLinks({
          facebookUrl: profile.facebookUrl || curatedPreview?.facebookUrl || null,
          instagramUrl: profile.instagramUrl || curatedPreview?.instagramUrl || null,
          tiktokUrl: profile.tiktokUrl || curatedPreview?.tiktokUrl || null,
          youtubeUrl: profile.youtubeUrl || curatedPreview?.youtubeUrl || null,
          soundcloudUrl: profile.soundcloudUrl || curatedPreview?.soundcloudUrl || null,
          websiteUrl: profile.websiteUrl || curatedPreview?.websiteUrl || null
        }),
        links: combinedLinkRows,
        featuredMedia: publicMedia,
        partner: {
          active: partnerState?.isEffective ?? false,
          kind: partnerState?.isEffective ? partnerState.partnerKind : null,
          termsVersion: partnerState?.isEffective ? partnerState.termsVersion : null
        },
        isPreview: false,
        claimState: 'claimed'
      },
      activeRoom: activeRoom
        ? {
            gigId: activeRoom.gigId,
            routePath: activeRoom.routePath,
            talentRole: activeRoom.talentRole,
            startedAt: activeRoom.startedAt,
            requestCount: activeRoomSummary?.requestCount ?? 0
          }
        : null
    });
  } catch (error) {
    console.error('Public performer profile lookup failed:', error);
    return res.status(500).json({ error: 'Unable to load this performer profile right now.' });
  }
});

app.get("/api/lyrics", async (req, res) => {
  applyNoStoreHeaders(res);
  const title = typeof req.query.title === 'string' ? req.query.title.trim() : '';
  const artist = typeof req.query.artist === 'string' ? req.query.artist.trim() : '';

  if (!title) {
    return res.status(422).json({ error: 'A song title is required to look up lyrics.' });
  }

  const result = await lookupLyrics({ title, artist });
  return res.json(result);
});

app.get("/api/state/:gigId", async (req, res) => {
  applyNoStoreHeaders(res);

  const requestedGigId = parseDurableGigId(req.params.gigId);
  if (!requestedGigId) {
    return res.status(404).json({
      error: ROOM_LOOKUP_UNAVAILABLE_COPY,
      message: ROOM_LOOKUP_UNAVAILABLE_COPY,
      room_lookup: 'missing'
    });
  }

  const roomSnapshot = await loadRoomState(requestedGigId);

  if (roomSnapshot.roomStatus === 'missing') {
    return res.status(404).json({
      error: ROOM_LOOKUP_UNAVAILABLE_COPY,
      message: ROOM_LOOKUP_UNAVAILABLE_COPY,
      room_lookup: 'missing'
    });
  }

  if (roomSnapshot.roomStatus === 'ended') {
    return res.status(410).json({
      error: ROOM_LOOKUP_ENDED_COPY,
      message: ROOM_LOOKUP_ENDED_COPY,
      room_lookup: 'ended'
    });
  }

  if (roomSnapshot.roomStatus !== 'active') {
    return res.status(404).json({
      error: ROOM_LOOKUP_UNAVAILABLE_COPY,
      message: ROOM_LOOKUP_UNAVAILABLE_COPY,
      room_lookup: 'missing'
    });
  }

  const privateRoomAccess = await accessControl.requireGigMutationAccess(req, requestedGigId);
  if (privateRoomAccess.allowed) {
    return res.json({
      session: roomSnapshot.state.session,
      requests: roomSnapshot.state.requests,
      performers: roomSnapshot.state.performers,
      activeGigId: roomSnapshot.state.activeGigId,
      room_lookup: 'active'
    });
  }

  return res.json({
    ...projectPublicRoomState(roomSnapshot.state, requestedGigId),
    room_lookup: 'active'
  });
});

app.post("/api/patron/request-status", async (req, res) => {
  applyNoStoreHeaders(res);

  const requestedGigId = parseDurableGigId(req.body?.gig_id);
  const receipt = req.body?.patron_status_receipt;
  if (!requestedGigId || typeof receipt !== 'string') {
    return res.status(404).json({ error: 'Patron request status not found.' });
  }

  const roomSnapshot = await loadRoomState(requestedGigId);
  if (roomSnapshot.roomStatus === 'missing') {
    return res.status(404).json({ error: 'Patron request status not found.' });
  }

  const request = roomSnapshot.state.requests.find((candidate) =>
    matchesPatronStatusReceipt(receipt, candidate.patronStatusReceiptHash)
  );
  if (!request) {
    return res.status(404).json({ error: 'Patron request status not found.' });
  }

  return res.json({ patron_status: projectPatronRequestStatus(request) });
});

app.get("/api/talent/active-rooms", async (req, res) => {
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) {
    return res.status(talentAccess.status).json({ error: talentAccess.reason });
  }

  applyNoStoreHeaders(res);

  // Scope to this performer's own rooms -- listReadableActiveRooms has no
  // built-in tenant boundary, and without a performerId it returns every
  // performer's active rooms system-wide.
  const performerOwner = talentAccess.actor.actorId
    ? await loadOwnedPerformerByActorUserId(talentAccess.actor.actorId)
    : null;
  if (!performerOwner) {
    return res.json({ rooms: [] });
  }

  return res.json({ rooms: await listReadableActiveRooms(performerOwner.performerId) });
});

app.get("/api/admin/active-rooms", async (req, res) => {
  const adminAccess = await accessControl.requireAdminOrSupportAccess(req);
  if (adminAccess.allowed === false) {
    return res.status(adminAccess.status).json({ error: adminAccess.reason });
  }

  applyNoStoreHeaders(res);
  return res.json({ rooms: await listReadableActiveRooms() });
});

app.post("/api/pending-action/reconcile", async (req, res) => {
  const { client_request_id, idempotency_key } = req.body;
  if (!client_request_id || !idempotency_key) {
    return res.status(400).json({ error: "client_request_id and idempotency_key are required." });
  }

  const result = await idempotencyStore.reconcilePendingAction({
    clientRequestId: client_request_id,
    idempotencyKey: idempotency_key
  });

  if (result.status === 'unavailable') {
    return res.status(503).json({ error: "Durable pending action reconciliation is not configured." });
  }
  if (result.status === 'expired') {
    return res.status(410).json({ error: "Pending action expired before backend confirmation." });
  }

  if (result.status === 'reconciled') {
    return res.json({
      ...result,
      responseBody: sanitizePatronMutationResponseBody(result.responseBody)
    });
  }

  return res.json(result);
});

app.post("/api/session/start", async (req, res) => {
  const actor = await resolveProtectedMutationActor(req, res);
  if (!actor) return;

  if (actor.actorType === 'performer') {
    const verificationState = await loadPerformerOwnerVerificationState(actor.actorId);
    if (verificationState && !verificationState.emailVerifiedAt) {
      return res.status(403).json({ error: 'Verified performer email is required before starting a live room.' });
    }
  }

  await refreshBusinessState();
  const { talentName, talentRole, feeType, minimumTip, paymentsEnabled, searchScope, gig_id } = req.body;

  const requestedGigId = parseDurableGigId(gig_id);
  const roomGigId = requestedGigId ?? businessStore.createGigId();
  const roomState = createEmptyBackendState();

  roomState.session = {
    status: 'active',
    ownerActorUserId: actor.actorId,
    lastMutationActorUserId: actor.actorId,
    talentName: talentName || "DJ Pro",
    talentRole: talentRole || 'DJ',
    feeType: feeType || 'patron',
    minimumTip: Math.max(5, Number(minimumTip) || 5),
    endGigTimerStartedAt: null,
    isFeatured: false,
    featuredExpiresAt: null,
    featuredCost: 0,
    featuredDurationHours: 0,
    requestsOpen: true,
    requestWindowMode: 'manual',
    requestWindowExpiresAt: null,
    requestWindowDuration: null,
    requestWindowLabel: null,
    requestPresets: [...systemRequestPresets],
    operatingMode: 'manual',
    searchScope: searchScope === 'catalog' ? 'catalog' : 'library',
    paymentsEnabled: typeof paymentsEnabled === 'boolean' ? paymentsEnabled : true,
    totals: {
      totalTips: 0,
      accumulatedFees: 0,
      totalCount: 0,
      topRequest: "None yet"
    }
  };
  roomState.requests = [];
  activeGigId = roomGigId;
  state = prepareRoomState(roomState, roomGigId);
  await persistStateWithAudit({
    roomState,
    gigId: roomGigId,
    actor,
    entityType: 'gig_session',
    entityId: roomGigId,
    eventType: 'session.start',
    previousStatus: null,
    nextStatus: roomState.session.status,
    metadata: {
      talentName: roomState.session.talentName,
      talentRole: roomState.session.talentRole,
      feeType: roomState.session.feeType,
      minimumTip: roomState.session.minimumTip,
      paymentsEnabled: roomState.session.paymentsEnabled,
      searchScope: roomState.session.searchScope
    }
  });
  res.json({ success: true, state: prepareRoomState(roomState, roomGigId) });
});

app.post("/api/session/feature", async (req, res) => {
  const roomContext = await resolveLegacyWritableRoom(req, res);
  if (!roomContext) return;
  const actor = await resolveProtectedMutationActor(req, res, roomContext.gigId);
  if (!actor) return;
  const { hours, cost, activate } = req.body;
  const roomState = roomContext.state;
  const wasFeatured = roomState.session.isFeatured;
  
  if (activate) {
    roomState.session.isFeatured = true;
    roomState.session.featuredExpiresAt = new Date(Date.now() + Number(hours) * 3600000).toISOString();
    roomState.session.featuredCost = Number(cost) || 0;
    roomState.session.featuredDurationHours = Number(hours) || 1;
  } else {
    roomState.session.isFeatured = false;
    roomState.session.featuredExpiresAt = null;
    roomState.session.featuredCost = 0;
    roomState.session.featuredDurationHours = 0;
  }
  roomState.session.lastMutationActorUserId = actor.actorId;

  await persistStateWithAudit({
    roomState,
    gigId: roomContext.gigId,
    actor,
    entityType: 'gig_session',
    entityId: roomContext.gigId,
    eventType: activate ? 'session.feature.enable' : 'session.feature.disable',
    previousStatus: wasFeatured ? 'featured' : 'not_featured',
    nextStatus: roomState.session.isFeatured ? 'featured' : 'not_featured',
    metadata: {
      featuredDurationHours: roomState.session.featuredDurationHours,
      featuredCost: roomState.session.featuredCost,
      featuredExpiresAt: roomState.session.featuredExpiresAt
    }
  });
  res.json({ success: true, state: prepareRoomState(roomState, roomContext.gigId) });
});

app.post("/api/session/end", async (req, res) => {
  const roomContext = await resolveLegacyWritableRoom(req, res);
  if (!roomContext) return;
  const actor = await resolveProtectedMutationActor(req, res, roomContext.gigId);
  if (!actor) return;
  const roomState = roomContext.state;
  if (roomState.session.status !== 'active') {
    return res.status(400).json({ error: "No active session to end." });
  }
  const previousStatus = roomState.session.status;
  roomState.session.status = 'ending';
  roomState.session.endGigTimerStartedAt = new Date().toISOString();
  roomState.session.lastMutationActorUserId = actor.actorId;
  await persistStateWithAudit({
    roomState,
    gigId: roomContext.gigId,
    actor,
    entityType: 'gig_session',
    entityId: roomContext.gigId,
    eventType: 'session.end',
    previousStatus,
    nextStatus: roomState.session.status,
    metadata: {
      endGigTimerStartedAt: roomState.session.endGigTimerStartedAt
    }
  });
  res.json({ success: true, state: prepareRoomState(roomState, roomContext.gigId) });
});

app.post("/api/session/closeout", async (req, res) => {
  const roomContext = await resolveLegacyWritableRoom(req, res);
  if (!roomContext) return;
  const actor = await resolveProtectedMutationActor(req, res, roomContext.gigId);
  if (!actor) return;
  const roomState = roomContext.state;
  const previousStatus = roomState.session.status;
  executeAutoNuke(roomState);
  roomState.session.lastMutationActorUserId = actor.actorId;

  // Closeout totals are sourced from captured payment records in the database,
  // never from runtime arrays. Disabled provider mode reports zero captured funds.
  let closeoutTotals: Awaited<ReturnType<typeof paymentService.aggregateCapturedTotals>> | null = null;
  if (paymentService.hasDurableStore) {
    closeoutTotals = await paymentService.aggregateCapturedTotals(roomContext.gigId);
    roomState.session.totals.totalTips = closeoutTotals.capturedSubtotalCents / 100;
    roomState.session.totals.accumulatedFees = closeoutTotals.platformFeeCents / 100;
    roomState.session.totals.totalCount = closeoutTotals.capturedCount;
  }

  await persistStateWithAudit({
    roomState,
    gigId: roomContext.gigId,
    actor,
    entityType: 'gig_session',
    entityId: roomContext.gigId,
    eventType: 'session.closeout',
    previousStatus,
    nextStatus: roomState.session.status,
    metadata: {
      autoNukeApplied: true,
      closeoutTotalsSource: closeoutTotals ? closeoutTotals.source : 'provider_disabled',
      capturedTotalCents: closeoutTotals ? closeoutTotals.capturedTotalCents : 0
    }
  });
  res.json({ success: true, state: prepareRoomState(roomState, roomContext.gigId), closeoutTotals });
});

// REQUEST WINDOW MANAGERS & PRESETS ENDPOINTS

// Toggle overall requests status (Manual Mode)
app.post("/api/session/window/toggle", async (req, res) => {
  const roomContext = await resolveLegacyWritableRoom(req, res);
  if (!roomContext) return;
  const actor = await resolveProtectedMutationActor(req, res, roomContext.gigId);
  if (!actor) return;
  const { open } = req.body;
  const result = await applyWindowToggle({ roomContext, actor, nextOpen: !!open });
  res.json({ success: true, ...result });
});

// Operator selects the room-layer operating posture. Crowd autopilot lets clean
// requests move straight to the public queue so the performer is not forced to
// tap approvals between songs.
app.post("/api/session/mode", async (req, res) => {
  const roomContext = await resolveLegacyWritableRoom(req, res);
  if (!roomContext) return;
  const actor = await resolveProtectedMutationActor(req, res, roomContext.gigId);
  if (!actor) return;
  const { mode } = req.body;
  const roomState = roomContext.state;

  if (mode !== 'manual' && mode !== 'open_call' && mode !== 'crowd_autopilot') {
    return res.status(400).json({ error: "mode must be 'manual', 'open_call', or 'crowd_autopilot'." });
  }

  const previousMode = roomState.session.operatingMode;
  roomState.session.operatingMode = mode;
  roomState.session.lastMutationActorUserId = actor.actorId;

  await persistStateWithAudit({
    roomState,
    gigId: roomContext.gigId,
    actor,
    entityType: 'gig_session',
    entityId: roomContext.gigId,
    eventType: 'session.mode',
    previousStatus: previousMode,
    nextStatus: mode,
    metadata: {
      operatingMode: mode,
      autopilotBehavior: mode === 'crowd_autopilot'
        ? 'clean_requests_auto_approved_after_moderation_and_payment_authorization'
        : 'performer_controls_request_queue'
    }
  });
  res.json({ success: true, state: prepareRoomState(roomState, roomContext.gigId) });
});

// Operator selects the song search scope for this room: their own synced library
// only (default, safest) or the full open catalog when they explicitly opt in.
app.post("/api/session/search-scope", async (req, res) => {
  const roomContext = await resolveLegacyWritableRoom(req, res);
  if (!roomContext) return;
  const actor = await resolveProtectedMutationActor(req, res, roomContext.gigId);
  if (!actor) return;
  const { scope } = req.body;
  const roomState = roomContext.state;

  if (scope !== 'library' && scope !== 'catalog' && scope !== 'setlist') {
    return res.status(400).json({ error: "scope must be 'library', 'catalog', or 'setlist'." });
  }

  const previousScope = roomState.session.searchScope;
  roomState.session.searchScope = scope;
  roomState.session.lastMutationActorUserId = actor.actorId;

  await persistStateWithAudit({
    roomState,
    gigId: roomContext.gigId,
    actor,
    entityType: 'gig_session',
    entityId: roomContext.gigId,
    eventType: 'session.search_scope',
    previousStatus: previousScope,
    nextStatus: scope,
    metadata: { searchScope: scope }
  });
  res.json({ success: true, state: prepareRoomState(roomState, roomContext.gigId) });
});

// Operator toggles whether this room accepts payment at all. Off means a free
// event: tips are rejected, boosts become free upvotes, requests carry no
// payment step. Defaults to true (paid) for every room.
app.post("/api/session/payments-enabled", async (req, res) => {
  const roomContext = await resolveLegacyWritableRoom(req, res);
  if (!roomContext) return;
  const actor = await resolveProtectedMutationActor(req, res, roomContext.gigId);
  if (!actor) return;
  const { enabled } = req.body;
  const roomState = roomContext.state;

  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: "enabled must be a boolean." });
  }

  const previousEnabled = roomState.session.paymentsEnabled;
  roomState.session.paymentsEnabled = enabled;
  roomState.session.lastMutationActorUserId = actor.actorId;

  await persistStateWithAudit({
    roomState,
    gigId: roomContext.gigId,
    actor,
    entityType: 'gig_session',
    entityId: roomContext.gigId,
    eventType: 'session.payments_enabled',
    previousStatus: String(previousEnabled),
    nextStatus: String(enabled),
    metadata: { paymentsEnabled: enabled }
  });
  res.json({ success: true, state: prepareRoomState(roomState, roomContext.gigId) });
});

// Activate standard/custom preset time window
app.post("/api/session/window/preset/activate", async (req, res) => {
  const roomContext = await resolveLegacyWritableRoom(req, res);
  if (!roomContext) return;
  const actor = await resolveProtectedMutationActor(req, res, roomContext.gigId);
  if (!actor) return;
  const { durationMinutes, label } = req.body;
  const roomState = roomContext.state;
  
  const duration = Number(durationMinutes);
  if (isNaN(duration) || duration <= 0) {
    return res.status(400).json({ error: "Invalid duration, must be minutes greater than zero." });
  }
  
  roomState.session.requestsOpen = true;
  roomState.session.requestWindowMode = 'preset';
  roomState.session.requestWindowExpiresAt = new Date(Date.now() + duration * 60 * 1000).toISOString();
  roomState.session.requestWindowDuration = duration;
  roomState.session.requestWindowLabel = label || "Active Window";
  roomState.session.lastMutationActorUserId = actor.actorId;
  
  await persistStateWithAudit({
    roomState,
    gigId: roomContext.gigId,
    actor,
    entityType: 'gig_session',
    entityId: roomContext.gigId,
    eventType: 'session.window.preset.activate',
    previousStatus: 'manual',
    nextStatus: 'preset',
    metadata: {
      requestWindowDuration: roomState.session.requestWindowDuration,
      requestWindowLabel: roomState.session.requestWindowLabel,
      requestWindowExpiresAt: roomState.session.requestWindowExpiresAt
    }
  });
  res.json({ success: true, state: prepareRoomState(roomState, roomContext.gigId) });
});

// Create/Build beautiful custom preset
app.post("/api/session/window/preset/create", async (req, res) => {
  const roomContext = await resolveLegacyWritableRoom(req, res);
  if (!roomContext) return;
  const actor = await resolveProtectedMutationActor(req, res, roomContext.gigId);
  if (!actor) return;
  const { label, durationMinutes } = req.body;
  const roomState = roomContext.state;
  
  const duration = Number(durationMinutes);
  if (!label || isNaN(duration) || duration <= 0) {
    return res.status(400).json({ error: "Preset requires a title and valid duration in minutes." });
  }
  
  const newPreset = {
    id: "p-custom-" + Math.random().toString(36).substring(2, 9),
    label: String(label).trim(),
    duration: duration,
    isSystem: false
  };
  
  roomState.session.requestPresets.push(newPreset);
  roomState.session.lastMutationActorUserId = actor.actorId;
  await persistStateWithAudit({
    roomState,
    gigId: roomContext.gigId,
    actor,
    entityType: 'gig_session',
    entityId: roomContext.gigId,
    eventType: 'session.window.preset.create',
    previousStatus: null,
    nextStatus: null,
    metadata: {
      presetId: newPreset.id,
      label: newPreset.label,
      duration: newPreset.duration
    }
  });
  res.json({ success: true, state: prepareRoomState(roomState, roomContext.gigId) });
});

// Delete custom preset
app.post("/api/session/window/preset/delete", async (req, res) => {
  const roomContext = await resolveLegacyWritableRoom(req, res);
  if (!roomContext) return;
  const actor = await resolveProtectedMutationActor(req, res, roomContext.gigId);
  if (!actor) return;
  const { presetId } = req.body;
  const roomState = roomContext.state;
  
  roomState.session.requestPresets = roomState.session.requestPresets.filter(p => p.id !== presetId);
  roomState.session.lastMutationActorUserId = actor.actorId;
  await persistStateWithAudit({
    roomState,
    gigId: roomContext.gigId,
    actor,
    entityType: 'gig_session',
    entityId: roomContext.gigId,
    eventType: 'session.window.preset.delete',
    previousStatus: null,
    nextStatus: null,
    metadata: {
      presetId
    }
  });
  res.json({ success: true, state: prepareRoomState(roomState, roomContext.gigId) });
});

// Create request + check profanity
app.post("/api/request/create", async (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
  const resolvedActor = accessControl.resolveServerActor(req);
  const {
    type,
    targetType,
    title,
    subtitle,
    senderName,
    message,
    amount,
    albumArt,
    sourceProvider,
    spotifyUri,
    spotifyUrl,
    client_request_id,
    idempotency_key,
    patron_device_id_hash = "anonymous-device",
    gig_id,
    currency = "USD",
    expires_at,
    payment_method,
    payment_intent_id,
    campaign_code
  } = req.body;
  const normalizedCurrency = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
  const normalizedCampaignCode = typeof campaign_code === 'string' ? campaign_code : null;

  if (!client_request_id || !idempotency_key) {
    return res.status(400).json({ error: "client_request_id and idempotency_key are required." });
  }
  if (normalizedCurrency !== 'USD') {
    return res.status(422).json({ error: "Sway Request and Tip payments currently support USD only." });
  }

  const durableGigId = parseDurableGigId(gig_id);
  const confirmedPaymentIntentId = typeof payment_intent_id === 'string' && payment_intent_id.trim()
    ? payment_intent_id.trim()
    : null;
  if (!durableGigId) {
    return res.status(422).json({ error: "A valid route gig_id is required for durable request submission." });
  }

  const roomSnapshot = await loadRoomState(durableGigId);
  if (roomSnapshot.roomStatus !== 'active') {
    return res.status(404).json({ error: ROOM_LOOKUP_UNAVAILABLE_COPY });
  }
  const roomState = roomSnapshot.state;
  // Only song requests are gated by the room's payments toggle. Tips support the
  // performer directly and are always allowed, regardless of room state.
  const isStraightTip = targetType === 'straight_tip' || type === 'tip';
  const paymentsEnabledForAction = isStraightTip || roomState.session.paymentsEnabled !== false;

  const amount_cents = paymentsEnabledForAction
    ? Math.round(Math.max(Number(amount) || 0, roomState.session.minimumTip) * 100)
    : 0;
  const normalizedSourceProvider = normalizeLibraryText(sourceProvider, 80) || null;
  const normalizedSpotifyUri = normalizeLibraryText(spotifyUri, 256) || null;
  const normalizedSpotifyUrl = normalizeLibraryText(spotifyUrl, 512) || null;
  const payload_hash = hashPayload({ type, targetType, title, subtitle, senderName, message, albumArt, normalizedSourceProvider, normalizedSpotifyUri, normalizedSpotifyUrl });
  const idempotencyFingerprint = createIdempotencyFingerprint({
    idempotency_key,
    patron_device_id_hash,
    gig_id: durableGigId,
    action_type: targetType === 'straight_tip' || type === 'tip' ? 'tip' : 'request',
    target_entity_id: title || 'request',
    amount_cents,
    currency: normalizedCurrency,
    payload_hash
  });

  const durableInput: DurableActionInput = {
    clientRequestId: client_request_id,
    idempotencyKey: idempotency_key,
    patronDeviceIdHash: patron_device_id_hash,
    gigId: durableGigId,
    actionType: targetType === 'straight_tip' || type === 'tip' ? 'tip' : 'request',
    amountCents: amount_cents,
    currency: normalizedCurrency,
    targetEntityType: targetType || 'music',
    targetEntityId: title || 'request',
    payloadHash: payload_hash,
    intentFingerprint: idempotencyFingerprint,
    expiresAt: expires_at
  };

  const durableReplay = await idempotencyStore.reservePendingAction(durableInput);
  if (durableReplay.kind === 'expired') {
    return res.status(410).json({ error: "Pending action expired before request creation." });
  }
  if (durableReplay.kind === 'misuse') {
    return res.status(409).json({ error: "idempotency misuse: same key submitted with a different fingerprint." });
  }
  if (durableReplay.kind === 'replay') {
    return res.status(durableReplay.status).json(sanitizePatronMutationResponseBody(durableReplay.body));
  }

  const existingRequest = roomState.requests.find(r => r.idempotencyKey === idempotency_key);
  if (existingRequest) {
    if (existingRequest.idempotencyFingerprint !== idempotencyFingerprint) {
      return res.status(409).json({ error: "idempotency misuse: same key submitted with a different fingerprint." });
    }
    const patronStatusReceipt = issuePatronStatusReceipt();
    existingRequest.patronStatusReceiptHash = patronStatusReceipt.receiptHash;
    await persistBusinessStateForRoom(roomState, durableGigId);
    const responseBody = buildPatronRequestMutationResponse({
      request: existingRequest,
      roomState,
      gigId: durableGigId,
      receipt: patronStatusReceipt.receipt,
      reconciled: true
    });
    await idempotencyStore.completePendingAction({
      clientRequestId: client_request_id,
      idempotencyKey: idempotency_key,
      status: 200,
      body: responseBody
    });
    return res.json(responseBody);
  }

  const tipAmount = paymentsEnabledForAction ? Math.max(Number(amount) || 0, roomState.session.minimumTip) : 0;
  const holdAmount = tipAmount;
  const attribution = paymentsEnabledForAction
    ? await businessStore.resolveCampaignAttribution(durableGigId, normalizedCampaignCode)
    : { kind: 'creator_direct' as const };
  const proposedFee = resolveProposedPlatformFee({ subtotalCents: amount_cents, attribution });
  const proposedPlatformFeeCents = paymentsEnabledForAction ? proposedFee.proposedPlatformFeeCents : 0;
  const platformFeePayer = roomState.session.feeType === 'talent' ? 'performer' : 'patron';

  // Troll-control: durable server-side gate blocking requests when paused/ending/closed.
  if (!isStraightTip && (!roomState.session.requestsOpen || roomState.session.status !== 'active')) {
    return res.status(400).json({ error: "Request submissions are currently closed by the host." });
  }

  if (!isStraightTip) {
    const sameDeviceSessionRequests = roomState.requests.filter((item) =>
      item.gigId === durableGigId
      && item.patronDeviceIdHash === patron_device_id_hash
      && item.type === 'request'
    );

    if (sameDeviceSessionRequests.length >= MAX_REQUESTS_PER_DEVICE_PER_SESSION) {
      return res.status(429).json({
        error: "You've reached the request limit for this session. Try again shortly as the queue moves."
      });
    }

    const noteRequests = sameDeviceSessionRequests.filter((item) => typeof item.message === 'string' && item.message.trim().length > 0);
    if ((message || '').trim().length > 0 && noteRequests.length >= MAX_CUSTOM_NOTES_PER_DEVICE_PER_SESSION) {
      return res.status(429).json({
        error: "You've reached the custom-note limit for this session. Try a preset request next."
      });
    }
  }

  const moderationOutcome = await moderationService.evaluateSubmission({
    senderName: senderName || "Patron",
    text: message || "",
    patronUserId: resolvedActor.actorId,
    patronDeviceIdHash: resolvedActor.patronDeviceIdHash ?? (typeof patron_device_id_hash === 'string' ? patron_device_id_hash : null)
  });

  if (moderationOutcome.decision === 'block_submission') {
    await moderationService.recordPatronReport({
      requestId: client_request_id,
      reason: moderationOutcome.reason,
      actorUserId: resolveActorUserId(req),
      patronDeviceIdHash: patron_device_id_hash
    });
    return res.status(403).json({
      error: moderationOutcome.reason,
      outage_behavior: 'block_submission'
    });
  }

  const shadowBanned = moderationOutcome.decision === 'hold_for_review';
  const shouldAutopilotApprove =
    roomState.session.operatingMode === 'crowd_autopilot'
    && !isStraightTip
    && !shadowBanned;
  const patronStatusReceipt = issuePatronStatusReceipt();

  const newItem: RequestItem = {
    id: `req-${String(client_request_id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)}`,
    type: isStraightTip ? 'tip' : 'request',
    targetType: targetType || 'music',
    title: isStraightTip ? 'Straight Tip' : (title || 'Request'),
    subtitle: isStraightTip ? 'Supported the talent directly!' : (subtitle || ''),
    albumArt: albumArt || (targetType === 'music' ? "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=150&h=150&fit=crop" : undefined),
    sourceProvider: isStraightTip ? null : normalizedSourceProvider,
    spotifyUri: isStraightTip ? null : normalizedSpotifyUri,
    spotifyUrl: isStraightTip ? null : normalizedSpotifyUrl,
    senderName: senderName || "Anonymous Patron",
    message: message || "",
    amount: tipAmount,
    holdAmount: holdAmount,
    platformFee: proposedPlatformFeeCents / 100,
    sponsorCount: 1,
    status: shadowBanned ? 'hold' : (isStraightTip ? 'fulfilled' : (shouldAutopilotApprove ? 'approved' : 'hold')),
    shadowBanned: shadowBanned,
    actorUserId: resolvedActor.actorId,
    lastMutationActorUserId: resolvedActor.actorId,
    createdAt: new Date().toISOString(),
    clientRequestId: client_request_id,
    idempotencyKey: idempotency_key,
    idempotencyFingerprint,
    idempotencyExpiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_HOURS * 3600000).toISOString(),
    patronDeviceIdHash: patron_device_id_hash,
    gigId: durableGigId,
    payloadHash: payload_hash,
    amountCents: amount_cents,
    currency: normalizedCurrency,
    patronStatusReceiptHash: patronStatusReceipt.receiptHash,
    boosts: []
  };

  // Provider-backed authorization/hold. A paid request/tip must NOT enter app
  // state or Private Triage until the provider confirms a real hold
  // (PaymentIntent requires_capture). Fail safe / fail closed otherwise.
  if (!paymentsEnabledForAction) {
    // Free room, non-tip request: no money changes hands, nothing to authorize.
    newItem.paymentStatus = 'not_applicable';
  } else if (paymentService.isEnabled()) {
    const authorization = confirmedPaymentIntentId
      ? await paymentService.confirmAuthorizedAction({
          gigId: durableGigId,
          actionType: isStraightTip ? 'tip' : 'request',
          amountSubtotalCents: amount_cents,
          platformFeeCents: proposedPlatformFeeCents,
          platformFeePayer,
          attributionSource: proposedFee.attributionSource,
          campaignId: proposedFee.campaignId,
          commissionBpsApplied: proposedFee.commissionBpsApplied,
          currency: normalizedCurrency,
          runtimeRequestId: newItem.id,
          clientRequestId: client_request_id,
          processorPaymentIntentId: confirmedPaymentIntentId
        })
      : await paymentService.authorizeAction({
          gigId: durableGigId,
          actionType: isStraightTip ? 'tip' : 'request',
          amountSubtotalCents: amount_cents,
          platformFeeCents: proposedPlatformFeeCents,
          platformFeePayer,
          attributionSource: proposedFee.attributionSource,
          campaignId: proposedFee.campaignId,
          commissionBpsApplied: proposedFee.commissionBpsApplied,
          currency: normalizedCurrency,
          idempotencyKey: idempotency_key,
          runtimeRequestId: newItem.id,
          clientRequestId: client_request_id,
          paymentMethod: payment_method,
          confirm: typeof payment_method === 'string' && payment_method.length > 0
        });
    if (authorization.status === 'failed') {
      return res.status(402).json({
        error: "Payment authorization failed. Your card was not charged and no request was created.",
        payment_status: 'failed'
      });
    }
    if (authorization.status === 'requires_confirmation') {
      // No hold yet: do NOT create the request. Return the client_secret so the
      // patron can confirm their card; the request is created only after the
      // PaymentIntent reaches requires_capture.
      return res.status(402).json({
        error: "Payment confirmation is required before your request is submitted.",
        payment_status: 'requires_confirmation',
        payment_id: authorization.paymentId,
        payment_intent_id: authorization.processorPaymentIntentId,
        client_secret: authorization.clientSecret
      });
    }
    // status === 'authorized': a real hold exists. Only now may the request enter
    // app state / Private Triage.
    if (authorization.status === 'authorized') {
      newItem.platformFee = authorization.platformFeeCents / 100;
      newItem.paymentId = authorization.paymentId;
      newItem.paymentIntentId = authorization.processorPaymentIntentId;
      newItem.paymentStatus = 'authorized';
      // A straight tip is not gated by Private Triage, so capture its authorized
      // hold immediately. Crowd autopilot also captures once the clean request
      // clears moderation and moves directly into the public queue.
      if (isStraightTip || shouldAutopilotApprove) {
        const capture = await paymentService.captureAuthorization(authorization.paymentId);
        if (capture.status === 'captured') {
          newItem.paymentStatus = 'captured';
        }
      }
    }
  } else if (isProduction) {
    // Fail closed: a visible money action must never silently create no-money
    // request state in production. If the payment provider is not configured,
    // the action is rejected rather than processed for free.
    return res.status(503).json({
      error: "Payments are temporarily unavailable. Your request was not submitted and you were not charged.",
      payment_status: 'provider_unavailable'
    });
  }

  roomState.requests.push(newItem);
  recalculateTotals(roomState);
  await persistBusinessStateForRoom(roomState, durableGigId);

  const responseBody = buildPatronRequestMutationResponse({
    request: newItem,
    roomState,
    gigId: durableGigId,
    receipt: patronStatusReceipt.receipt
  });
  await idempotencyStore.completePendingAction({
    clientRequestId: client_request_id,
    idempotencyKey: idempotency_key,
    status: 200,
    body: responseBody
  });
  res.json(responseBody);
});

// Boost an existing request
app.post("/api/request/boost", async (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
  const resolvedActor = accessControl.resolveServerActor(req);
  const {
    requestId,
    patronName,
    boostAmount,
    client_request_id,
    idempotency_key,
    patron_device_id_hash = "anonymous-device",
    gig_id,
    currency = "USD",
    expires_at,
    payment_method,
    payment_intent_id,
    campaign_code
  } = req.body;
  const normalizedCurrency = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
  const normalizedCampaignCode = typeof campaign_code === 'string' ? campaign_code : null;
  if (!client_request_id || !idempotency_key) {
    return res.status(400).json({ error: "client_request_id and idempotency_key are required." });
  }
  if (normalizedCurrency !== 'USD') {
    return res.status(422).json({ error: "Sway Boost payments currently support USD only." });
  }

  const durableGigId = parseDurableGigId(gig_id);
  const confirmedPaymentIntentId = typeof payment_intent_id === 'string' && payment_intent_id.trim()
    ? payment_intent_id.trim()
    : null;
  if (!durableGigId) {
    return res.status(422).json({ error: "A valid route gig_id is required for durable boost submission." });
  }

  const roomSnapshot = await loadRoomState(durableGigId);
  if (roomSnapshot.roomStatus !== 'active') {
    return res.status(404).json({ error: ROOM_LOOKUP_UNAVAILABLE_COPY });
  }
  const roomState = roomSnapshot.state;
  const paymentsEnabledForRoom = roomState.session.paymentsEnabled !== false;
  let amt = Math.max(Number(boostAmount) || 0, roomState.session.minimumTip); // Paid boosts follow the room minimum.
  if (!paymentsEnabledForRoom) {
    // Free room: boosts become free upvotes -- fixed 1-unit weight, no money.
    amt = 1;
  }

  const request = roomState.requests.find(r => r.id === requestId);
  if (!request) {
    return res.status(404).json({ error: "Request not found" });
  }

  // Gate #9.2: Paid boosts must never bypass private triage or moderation.
  // A boost is an ordering action that may only touch content that has already
  // cleared the Private Triage Desk. Allowlist approved, non-shadowbanned,
  // visible requests only; everything else (hold/denied/fulfilled/hidden/removed)
  // is rejected so money can never grant display or approval authority.
  const isBoostEligible =
    request.status === 'approved'
    && !request.shadowBanned
    && !request.hidden
    && !request.removed;

  if (!isBoostEligible) {
    return res.status(409).json({
      error: "This request cannot be boosted right now. Boosts are only allowed on approved queue items."
    });
  }

  const sameActorBoostCount = resolvedActor.actorId
    ? roomState.requests.reduce((count, current) => {
        if (current.gigId !== durableGigId) return count;
        return count + current.boosts.filter((boost) => boost.actorUserId === resolvedActor.actorId).length;
      }, 0)
    : 0;

  if (sameActorBoostCount >= MAX_BOOSTS_PER_DEVICE_PER_SESSION) {
    return res.status(429).json({
      error: "You've reached the boost limit for this session. Try again later."
    });
  }

  const amount_cents = Math.round(amt * 100);
  const payload_hash = hashPayload({ requestId, patronName, boostAmount });
  const idempotencyFingerprint = createIdempotencyFingerprint({
    idempotency_key,
    patron_device_id_hash,
    gig_id: durableGigId,
    action_type: 'boost',
    target_entity_id: requestId,
    amount_cents,
    currency: normalizedCurrency,
    payload_hash
  });

  const durableInput: DurableActionInput = {
    clientRequestId: client_request_id,
    idempotencyKey: idempotency_key,
    patronDeviceIdHash: patron_device_id_hash,
    gigId: durableGigId,
    actionType: 'boost',
    amountCents: amount_cents,
    currency: normalizedCurrency,
    targetEntityType: 'request',
    targetEntityId: requestId,
    payloadHash: payload_hash,
    intentFingerprint: idempotencyFingerprint,
    expiresAt: expires_at
  };

  const durableReplay = await idempotencyStore.reservePendingAction(durableInput);
  if (durableReplay.kind === 'expired') {
    return res.status(410).json({ error: "Pending action expired before boost creation." });
  }
  if (durableReplay.kind === 'misuse') {
    return res.status(409).json({ error: "idempotency misuse: same key submitted with a different fingerprint." });
  }
  if (durableReplay.kind === 'replay') {
    return res.status(durableReplay.status).json(sanitizePatronMutationResponseBody(durableReplay.body));
  }

  const existingBoost = request.boosts.find(b => b.idempotencyKey === idempotency_key);
  if (existingBoost) {
    if (existingBoost.idempotencyFingerprint !== idempotencyFingerprint) {
      return res.status(409).json({ error: "idempotency misuse: same key submitted with a different fingerprint." });
    }
    const responseBody = buildPatronBoostMutationResponse({
      roomState,
      gigId: durableGigId,
      reconciled: true
    });
    await idempotencyStore.completePendingAction({
      clientRequestId: client_request_id,
      idempotencyKey: idempotency_key,
      status: 200,
      body: responseBody
    });
    return res.json(responseBody);
  }

  const moderationOutcome = await moderationService.evaluateSubmission({
    senderName: patronName || "Patron",
    text: '',
    patronUserId: resolvedActor.actorId,
    patronDeviceIdHash: resolvedActor.patronDeviceIdHash ?? (typeof patron_device_id_hash === 'string' ? patron_device_id_hash : null)
  });

  if (moderationOutcome.decision === 'block_submission') {
    await moderationService.recordPatronReport({
      requestId,
      reason: moderationOutcome.reason,
      actorUserId: resolveActorUserId(req),
      patronDeviceIdHash: patron_device_id_hash
    });
    return res.status(403).json({
      error: moderationOutcome.reason,
      outage_behavior: 'block_submission'
    });
  }

  const isBackerShadowed = moderationOutcome.decision === 'hold_for_review';

  const newBoost: BoostContribution = {
    id: `boost-${String(client_request_id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)}`,
    patronName: patronName || "Co-Sponsor",
    amount: amt,
    actorUserId: resolvedActor.actorId,
    timestamp: new Date().toISOString(),
    clientRequestId: client_request_id,
    idempotencyKey: idempotency_key,
    idempotencyFingerprint,
    idempotencyExpiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_HOURS * 3600000).toISOString()
  };
  const boostAttribution = paymentsEnabledForRoom
    ? await businessStore.resolveCampaignAttribution(durableGigId, normalizedCampaignCode)
    : { kind: 'creator_direct' as const };
  const proposedBoostFee = resolveProposedPlatformFee({ subtotalCents: amount_cents, attribution: boostAttribution });
  let appliedBoostPlatformFeeCents = paymentsEnabledForRoom ? proposedBoostFee.proposedPlatformFeeCents : 0;
  const boostPlatformFeePayer = roomState.session.feeType === 'talent' ? 'performer' : 'patron';

  // Provider-backed authorization/hold for the boost. The booster only reaches
  // this point because the target request already cleared Private Triage, so the
  // boost never grants approval authority. Fail safe on provider rejection.
  if (!paymentsEnabledForRoom) {
    // Free room: the boost is a free upvote, nothing to authorize.
    newBoost.paymentStatus = 'not_applicable';
  } else if (paymentService.isEnabled()) {
    const authorization = confirmedPaymentIntentId
      ? await paymentService.confirmAuthorizedAction({
          gigId: durableGigId,
          actionType: 'boost',
          amountSubtotalCents: amount_cents,
          platformFeeCents: appliedBoostPlatformFeeCents,
          platformFeePayer: boostPlatformFeePayer,
          attributionSource: proposedBoostFee.attributionSource,
          campaignId: proposedBoostFee.campaignId,
          commissionBpsApplied: proposedBoostFee.commissionBpsApplied,
          currency: normalizedCurrency,
          runtimeRequestId: request.id,
          clientRequestId: client_request_id,
          processorPaymentIntentId: confirmedPaymentIntentId
        })
      : await paymentService.authorizeAction({
          gigId: durableGigId,
          actionType: 'boost',
          amountSubtotalCents: amount_cents,
          platformFeeCents: appliedBoostPlatformFeeCents,
          platformFeePayer: boostPlatformFeePayer,
          attributionSource: proposedBoostFee.attributionSource,
          campaignId: proposedBoostFee.campaignId,
          commissionBpsApplied: proposedBoostFee.commissionBpsApplied,
          currency: normalizedCurrency,
          idempotencyKey: idempotency_key,
          runtimeRequestId: request.id,
          clientRequestId: client_request_id,
          paymentMethod: payment_method,
          confirm: typeof payment_method === 'string' && payment_method.length > 0
        });
    if (authorization.status === 'failed') {
      return res.status(402).json({
        error: "Boost authorization failed. Your card was not charged.",
        payment_status: 'failed'
      });
    }
    if (authorization.status === 'requires_confirmation') {
      // No hold yet: do NOT create the boost. Return the client_secret so the
      // patron can confirm; the boost is created only after requires_capture.
      return res.status(402).json({
        error: "Payment confirmation is required before your boost is applied.",
        payment_status: 'requires_confirmation',
        payment_id: authorization.paymentId,
        payment_intent_id: authorization.processorPaymentIntentId,
        client_secret: authorization.clientSecret
      });
    }
    // status === 'authorized': a real hold exists. The target request already
    // cleared Private Triage, so the approved boost is captured immediately.
    if (authorization.status === 'authorized') {
      appliedBoostPlatformFeeCents = authorization.platformFeeCents;
      newBoost.paymentId = authorization.paymentId;
      newBoost.paymentIntentId = authorization.processorPaymentIntentId;
      newBoost.paymentStatus = 'authorized';
      const capture = await paymentService.captureAuthorization(authorization.paymentId);
      if (capture.status === 'captured') {
        newBoost.paymentStatus = 'captured';
      }
    }
  } else if (isProduction) {
    // Fail closed: a visible money action must never silently create no-money
    // boost state in production when the payment provider is unavailable.
    return res.status(503).json({
      error: "Payments are temporarily unavailable. Your boost was not applied and you were not charged.",
      payment_status: 'provider_unavailable'
    });
  }

  request.boosts.push(newBoost);
  request.amount += amt; // Pool funds!
  request.platformFee += appliedBoostPlatformFeeCents / 100;
  request.sponsorCount += 1;

  if (isBackerShadowed) {
    request.shadowBanned = true; // Cascade shadow ban if the booster is vulgar
  }

  recalculateTotals(roomState);
  await persistBusinessStateForRoom(roomState, durableGigId);
  const responseBody = buildPatronBoostMutationResponse({ roomState, gigId: durableGigId });
  await idempotencyStore.completePendingAction({
    clientRequestId: client_request_id,
    idempotencyKey: idempotency_key,
    status: 200,
    body: responseBody
  });
  res.json(responseBody);
});

// Triage Queue Action (Accept / Deny)
app.post("/api/request/triage", async (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
  const { requestId, action } = req.body; // action: 'approve' | 'deny'
  const roomContext = await findRoomStateByRequestId(requestId);
  if (!roomContext || !roomContext.gigId) {
    return res.status(404).json({ error: "Request not found" });
  }
  const roomState = roomContext.state;
  const request = roomContext.request;

  const actor = await resolveProtectedMutationActor(req, res, roomContext.gigId);
  if (!actor) return;

  const durableMutation = buildDurableActorActionInput({
    actor,
    gigId: roomContext.gigId,
    actionType: `request.triage.${action === 'approve' ? 'approve' : 'deny'}`,
    targetEntityType: 'request',
    targetEntityId: request.id,
    payload: { requestId: request.id, requestedAction: action === 'approve' ? 'approve' : 'deny' }
  });
  const durableReplay = await reserveDurableActorMutation(durableMutation);
  if (sendDurableMutationReplay(res, durableReplay)) return;

  const result = await applyRequestTriage({
    roomContext: { gigId: roomContext.gigId, state: roomState, request },
    actor,
    action: action === 'approve' ? 'approve' : 'deny'
  });
  const responseBody = { success: true, ...result };
  await completeDurableActorMutation({ reservation: durableMutation, status: 200, body: responseBody });
  res.json(responseBody);
});

// Fulfillment Queue Action (Fulfill)
app.post("/api/request/fulfill", async (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
  const { requestId } = req.body;
  const roomContext = await findRoomStateByRequestId(requestId);
  if (!roomContext || !roomContext.gigId) {
    return res.status(404).json({ error: "Request not found (could be deleted)" });
  }
  const roomState = roomContext.state;
  const request = roomContext.request;

  const actor = await resolveProtectedMutationActor(req, res, roomContext.gigId);
  if (!actor) return;

  const durableMutation = buildDurableActorActionInput({
    actor,
    gigId: roomContext.gigId,
    actionType: 'request.fulfill',
    targetEntityType: 'request',
    targetEntityId: request.id,
    payload: { requestId: request.id }
  });
  const durableReplay = await reserveDurableActorMutation(durableMutation);
  if (sendDurableMutationReplay(res, durableReplay)) return;

  const result = await applyRequestFulfill({
    roomContext: { gigId: roomContext.gigId, state: roomState, request },
    actor
  });

  const responseBody = { success: true, ...result };
  await completeDurableActorMutation({ reservation: durableMutation, status: 200, body: responseBody });
  res.json(responseBody);
});

app.post("/api/moderation/report", async (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
  const resolvedActor = accessControl.resolveServerActor(req);

  const { requestId, reason, details, patron_device_id_hash } = req.body;
  if (!requestId || !reason) {
    return res.status(400).json({ error: "requestId and reason are required." });
  }

  await moderationService.recordPatronReport({
    requestId: String(requestId),
    reason: String(reason),
    details: typeof details === 'string' ? details : undefined,
    actorUserId: resolvedActor.actorId,
    patronDeviceIdHash: resolvedActor.patronDeviceIdHash ?? (typeof patron_device_id_hash === 'string' ? patron_device_id_hash : null)
  });

  return res.json({ success: true, moderation_action: 'report_submitted' });
});

app.post("/api/moderation/patron-block", async (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
  const resolvedActor = accessControl.resolveServerActor(req);
  const { scope, value, reason, patron_device_id_hash } = req.body;
  const allowedScopes: BlockScope[] = ['patron_device_id_hash', 'sender_name'];

  if (!allowedScopes.includes(scope) || !reason) {
    return res.status(400).json({
      error: "scope and reason are required. scope must be patron_device_id_hash or sender_name."
    });
  }

  const normalizedValue = typeof value === 'string' && value.trim().length > 0
    ? value.trim().toLowerCase()
    : resolvedActor.patronDeviceIdHash ?? (typeof patron_device_id_hash === 'string' ? patron_device_id_hash.trim().toLowerCase() : 'anonymous-device');
  const blockReason = String(reason).trim().slice(0, 500) || 'Patron requested a safety block.';
  const entityKey = `patron-block-request:${scope}:${normalizedValue}:${Date.now()}`;

  if (businessDb) {
    await businessDb.transaction(async (tx) => {
      await tx.insert(moderationEvents).values({
        actorUserId: resolvedActor.actorId,
        entityType: 'patron_block_request',
        entityId: toAuditEntityUuid(entityKey),
        status: 'held_for_review',
        reason: blockReason,
        metadata: {
          scope,
          value: normalizedValue,
          patronDeviceIdHash: resolvedActor.patronDeviceIdHash ?? null,
          source: 'moderation.patron_block'
        }
      });

      await writeAuditEvent(tx, {
        actorId: resolvedActor.actorId,
        actorType: resolvedActor.actorId ? 'resolved_actor' : 'anonymous',
        entityType: 'moderation_patron_block_request',
        entityId: entityKey,
        eventType: 'moderation.patron_block.requested',
        previousStatus: null,
        nextStatus: 'held_for_review',
        metadata: {
          scope,
          value: normalizedValue,
          reason: blockReason
        }
      });
    });
  } else {
    await moderationService.recordPatronBlockRequest({
      scope,
      value: normalizedValue,
      reason: blockReason,
      actorUserId: resolvedActor.actorId,
      patronDeviceIdHash: resolvedActor.patronDeviceIdHash ?? null
    });
  }

  return res.status(202).json({
    success: true,
    moderation_action: 'patron_block_requested'
  });
});

app.post("/api/moderation/block", async (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
  const privilegedActor = await accessControl.requireAdminOrSupportAccess(req);
  if (privilegedActor.allowed === false) {
    return res.status(privilegedActor.status).json({ error: privilegedActor.reason });
  }

  if (!privilegedActor.actor.actorId) {
    return res.status(401).json({ error: 'Sway actor resolution required.' });
  }

  const { scope, value, reason } = req.body;
  const allowedScopes: BlockScope[] = ['patron_user_id', 'patron_device_id_hash', 'sender_name'];

  if (!allowedScopes.includes(scope) || !value || !reason) {
    return res.status(400).json({
      error: "scope, value, and reason are required. scope must be patron_user_id, patron_device_id_hash, or sender_name."
    });
  }

  const normalizedValue = String(value).trim().toLowerCase();
  // Always attribute to the authenticated actor -- never trust a client-supplied
  // actor id, or any caller could falsify who performed a moderation action.
  const actorId = privilegedActor.actor.actorId;

  if (!businessDb) {
    await moderationService.addBlockRule({
      scope,
      value: String(value),
      reason: String(reason),
      actorUserId: actorId
    });
  } else {
    await businessDb.transaction(async (tx) => {
      await tx
        .insert(activeBlocks)
        .values({
          scope,
          normalizedValue,
          reason: String(reason),
          actorUserId: actorId,
          status: 'active',
          revokedAt: null,
          metadata: { source: 'moderation.block' }
        })
        .onConflictDoUpdate({
          target: [activeBlocks.scope, activeBlocks.normalizedValue, activeBlocks.status],
          set: {
            reason: String(reason),
            actorUserId: actorId,
            revokedAt: null,
            metadata: { source: 'moderation.block' },
            updatedAt: new Date()
          }
        });

      await tx.insert(moderationEvents).values({
        actorUserId: actorId,
        entityType: 'block_rule',
        entityId: toAuditEntityUuid(`${scope}:${normalizedValue}`),
        status: 'blocked',
        reason: String(reason),
        metadata: {
          scope,
          value: normalizedValue,
          source: 'moderation.block'
        }
      });

      await writeAuditEvent(tx, {
        actorId,
        actorType: privilegedActor.role ?? 'unknown',
        entityType: 'moderation_block',
        entityId: `${scope}:${normalizedValue}`,
        eventType: 'moderation.block',
        previousStatus: null,
        nextStatus: 'blocked',
        metadata: {
          scope,
          value: normalizedValue,
          reason: String(reason)
        }
      });
    });
  }

  return res.json({ success: true, moderation_action: 'block_added' });
});

app.post("/api/moderation/hide", async (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;

  const { requestId, reason } = req.body;
  if (!requestId || !reason) {
    return res.status(400).json({ error: "requestId and reason are required." });
  }

  const roomContext = await findRoomStateByRequestId(String(requestId));
  if (!roomContext || !roomContext.gigId) {
    return res.status(404).json({ error: "Request not found" });
  }
  const roomState = roomContext.state;
  const request = roomContext.request;

  const actor = await resolveProtectedMutationActor(req, res, roomContext.gigId);
  if (!actor) return;

  const durableMutation = buildDurableActorActionInput({
    actor,
    gigId: roomContext.gigId,
    actionType: 'moderation.hide',
    targetEntityType: 'request',
    targetEntityId: request.id,
    payload: { requestId: request.id }
  });
  const durableReplay = await reserveDurableActorMutation(durableMutation);
  if (sendDurableMutationReplay(res, durableReplay)) return;

  const result = await applyRequestHide({
    roomContext: { gigId: roomContext.gigId, state: roomState, request },
    actor,
    reason: String(reason)
  });

  const responseBody = { success: true, moderation_action: 'hidden', ...result };
  await completeDurableActorMutation({ reservation: durableMutation, status: 200, body: responseBody });
  return res.json(responseBody);
});

app.post("/api/moderation/remove", async (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;

  const { requestId, reason } = req.body;
  if (!requestId || !reason) {
    return res.status(400).json({ error: "requestId and reason are required." });
  }

  const roomContext = await findRoomStateByRequestId(String(requestId));
  if (!roomContext || !roomContext.gigId) {
    return res.status(404).json({ error: "Request not found" });
  }
  const roomState = roomContext.state;
  const request = roomContext.request;

  const actor = await resolveProtectedMutationActor(req, res, roomContext.gigId);
  if (!actor) return;

  const previousStatus = request.status;
  request.removed = true;
  request.status = 'denied';
  request.lastMutationActorUserId = actor.actorId;
  roomState.session.lastMutationActorUserId = actor.actorId;

  // A removed request is never publicly eligible, so release its funds.
  if (paymentService.isEnabled()) {
    const paymentIds = [
      request.paymentId,
      ...request.boosts.map((boost) => boost.paymentId)
    ].filter((id): id is string => Boolean(id));
    if (paymentIds.length) {
      await paymentService.voidOrRefundMany(paymentIds);
      request.paymentStatus = 'voided_or_refunded';
    }
  }
  recalculateTotals(roomState);
  await persistStateWithAudit({
    roomState,
    gigId: roomContext.gigId,
    actor,
    entityType: 'request',
    entityId: request.id,
    eventType: 'moderation.remove',
    previousStatus,
    nextStatus: request.status,
    metadata: {
      requestId: request.id,
      removed: true,
      reason: String(reason)
    }
  });

  await moderationService.removeRequest({
    requestId: String(requestId),
    reason: String(reason),
    // Always the authenticated actor -- never trust a client-supplied actor id.
    actorUserId: actor.actorId
  });

  return res.json({ success: true, moderation_action: 'removed', request, state: prepareRoomState(roomState, roomContext.gigId) });
});

app.get('/api/moderation/placeholders', (_req, res) => {
  return res.json({
    success: true,
    app_store_ugc_controls: moderationService.getAppStoreUgcControlPlaceholders()
  });
});

app.get('/support', (_req, res) => {
  res.type('html').send(supportPageHtml);
});

app.get('/faq', (_req, res) => {
  res.type('html').send(faqPageHtml);
});

app.get('/privacy', (_req, res) => {
  res.type('html').send(privacyPageHtml);
});

app.get('/terms', (_req, res) => {
  res.type('html').send(termsPageHtml);
});

app.get('/legal/payments', (_req, res) => {
  res.type('html').send(paymentTermsPageHtml);
});

app.get('/legal/payouts', (_req, res) => {
  res.type('html').send(payoutTermsPageHtml);
});

app.get('/privacy/data-deletion', (_req, res) => {
  res.type('html').send(dataDeletionPageHtml);
});

app.get('/api/support/contact', (_req, res) => {
  return res.json({
    success: true,
    message: 'Support options are published on the Sway support page.',
    supportPath: '/support',
    faqPath: '/faq',
    privacyPolicyPath: '/privacy',
    termsPath: '/terms',
    dataDeletionPath: '/privacy/data-deletion',
    paymentTermsPath: '/legal/payments',
    payoutTermsPath: '/legal/payouts'
  });
});

async function handleDataDeletionRequest(req: express.Request, res: express.Response) {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().slice(0, 320) : null;
  const details = typeof req.body?.details === 'string' ? req.body.details.trim().slice(0, 2000) : null;
  const source = typeof req.body?.source === 'string' ? req.body.source.trim().slice(0, 120) : 'unknown';
  const actor = accessControl.resolveServerActor(req);
  const requestFingerprint = `${source}:${email ?? 'anonymous'}:${req.ip ?? 'no-ip'}:${Date.now()}`;

  if (businessDb) {
    await writeAuditEvent(businessDb, {
      actorId: actor.actorId,
      actorType: actor.actorId ? 'resolved_actor' : 'anonymous',
      entityType: 'privacy_request',
      entityId: requestFingerprint,
      eventType: 'privacy.data_deletion.requested',
      nextStatus: 'requested',
      metadata: {
        email,
        details,
        source
      }
    });
  }

  return res.status(202).json({
    success: true,
    message: 'Data deletion request received for review.',
    requestAccepted: true,
    dataDeletionInfoPath: '/privacy/data-deletion'
  });
}

app.post('/api/privacy/data-deletion', handleDataDeletionRequest);
app.post('/api/privacy/data-deletion-placeholder', handleDataDeletionRequest);

// Truthful request helper only. This is not a licensed music-catalog integration.
app.post("/api/music/search", (req, res) => {
  const rawQuery = typeof req.body?.query === 'string' ? req.body.query : '';
  const query = rawQuery.trim();
  const requestedGigId = parseDurableGigId(req.body?.gig_id);
  const albumArt = 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=240&q=80';
  const manualResults = query
    ? [{
        id: `manual-${query.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'request'}`,
        title: query,
        artist: 'Manual song request',
        albumArt,
        description: 'Performer will review this request manually.'
      }]
    : [];

  if (!businessDb || !requestedGigId) {
    return res.json({
      results: manualResults,
      integrationMode: 'manual_request_only'
    });
  }

  void (async () => {
    const [gigRow] = await businessDb
      .select({ performerId: gigSessions.performerId })
      .from(gigSessions)
      .where(eq(gigSessions.id, requestedGigId))
      .limit(1);

    if (!gigRow) {
      return res.json({
        results: manualResults,
        integrationMode: 'manual_request_only'
      });
    }

    const roomSnapshot = await loadRoomState(requestedGigId);
    const searchScope = roomSnapshot.state.session.searchScope;

    if (searchScope === 'catalog') {
      const catalog = await searchCatalog({ query, env: process.env });
      if (catalog.configured) {
        return res.json({
          results: catalog.results.map((track) => ({
            id: track.id,
            title: track.title,
            artist: track.artist,
            albumArt: track.albumArt || albumArt,
            description: track.album || 'Open catalog',
            spotifyUri: track.spotifyUri,
            spotifyUrl: track.spotifyUrl,
            targetType: 'music'
          })),
          integrationMode: 'open_catalog'
        });
      }
      // Room is set to catalog mode but no catalog provider is configured yet --
      // fall through to the performer's own library instead of erroring.
    }

    if (searchScope === 'setlist') {
      const lowerQuery = query.toLowerCase();
      const likeQuery = `%${lowerQuery}%`;
      const setlistRows = await businessDb
        .select({
          id: performerSetlistTracks.id,
          title: performerSetlistTracks.title,
          artist: performerSetlistTracks.artist,
          album: performerSetlistTracks.album,
          artworkUrl: performerSetlistTracks.artworkUrl,
          spotifyUri: performerSetlistTracks.spotifyUri,
          spotifyUrl: performerSetlistTracks.spotifyUrl
        })
        .from(performerSetlistTracks)
        .where(
          query
            ? and(
                eq(performerSetlistTracks.performerId, gigRow.performerId),
                sql`lower(${performerSetlistTracks.searchableText}) like ${likeQuery}`
              )
            : eq(performerSetlistTracks.performerId, gigRow.performerId)
        )
        .limit(25);

      return res.json({
        results: setlistRows.map((row) => ({
          id: row.id,
          title: row.title,
          artist: row.artist,
          albumArt: row.artworkUrl || albumArt,
          description: row.album || "Tonight's setlist",
          spotifyUri: row.spotifyUri ?? undefined,
          spotifyUrl: row.spotifyUrl ?? undefined,
          targetType: 'music'
        })),
        integrationMode: 'gig_setlist'
      });
    }

    const lowerQuery = query.toLowerCase();
    const likeQuery = `%${lowerQuery}%`;
    const libraryRows = await businessDb
      .select({
        id: performerLibraryTracks.id,
        title: performerLibraryTracks.title,
        artist: performerLibraryTracks.artist,
        album: performerLibraryTracks.album,
        artworkUrl: performerLibraryTracks.artworkUrl,
        sourceLabel: performerLibraryTracks.sourceLabel,
        metadata: performerLibraryTracks.metadata
      })
      .from(performerLibraryTracks)
      .where(
        query
          ? and(
              eq(performerLibraryTracks.performerId, gigRow.performerId),
              sql`lower(${performerLibraryTracks.searchableText}) like ${likeQuery}`
            )
          : eq(performerLibraryTracks.performerId, gigRow.performerId)
      )
      .limit(25);

    return res.json({
      results: libraryRows.map((row) => ({
        id: row.id,
        title: row.title,
        artist: row.artist,
        albumArt: row.artworkUrl || albumArt,
        description: row.album || 'Available in performer library',
        source: row.sourceLabel,
        sourceProvider: typeof (row.metadata as any)?.sourceProvider === 'string' ? (row.metadata as any).sourceProvider : undefined,
        spotifyUri: typeof (row.metadata as any)?.spotifyUri === 'string' ? (row.metadata as any).spotifyUri : undefined,
        spotifyUrl: typeof (row.metadata as any)?.spotifyUrl === 'string' ? (row.metadata as any).spotifyUrl : undefined,
        targetType: 'music'
      })),
      integrationMode: 'performer_library'
    });
  })().catch((error) => {
    console.warn('Performer library search failed:', error);
    return res.json({
      results: manualResults,
      integrationMode: 'manual_request_only'
    });
  });
});

app.get('/:handle', async (req, res, next) => {
  const normalizedHandle = normalizePerformerHandle(req.params.handle);
  if (!normalizedHandle) return next();

  try {
    const profile = await findPublicShareProfile(normalizedHandle);
    if (!profile) return next();
    return res.redirect(308, `/p/${encodeURIComponent(profile.handle)}`);
  } catch (error) {
    return next(error);
  }
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API route not found.' });
});

// Vite Middleware & Front-End Serving Config
async function startServer() {
  await refreshBusinessState();

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: ['sway.tips', 'www.sway.tips', 'app.sway.tips']
      },
      appType: "custom",
    });
    app.use(vite.middlewares);
    // Vite's publicDir is disabled outside demo mode, so serve repo public/
    // assets (S mark, icons, manifest, sw) directly in dev to mirror the
    // production dist static behavior. Dev-only; no business/auth logic.
    app.use(express.static(path.join(process.cwd(), 'public'), { index: false }));
    app.get('*', async (req, res, next) => {
      try {
        const shell = resolveShellForRoute(req.path, typeof req.headers.host === 'string' ? req.headers.host : undefined);
        const templatePath = path.join(process.cwd(), shellHtmlRelativePath(shell));
        const template = readFileSync(templatePath, 'utf8');
        const transformedHtml = await vite.transformIndexHtml(req.originalUrl, template);
        const html = injectShareMetadata(transformedHtml, await resolveShareMetadata(req));
        applyNoStoreHeaders(res);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
      } catch (error) {
        next(error);
      }
    });
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.get('/shells/dev-sandbox.html', (_req, res) => {
      res.status(404).send('Not found');
    });
    app.get(/^\/assets\/dev-sandbox-.*\.js$/, (_req, res) => {
      res.status(404).send('Not found');
    });
    app.use(express.static(distPath, { index: false }));
    app.get('*', async (req, res, next) => {
      const shell = resolveShellForRoute(req.path, typeof req.headers.host === 'string' ? req.headers.host : undefined);
      if (!isShellAllowed(shell)) {
        res.status(404).send('Not found');
        return;
      }
      try {
        const htmlPath = path.join(distPath, shellHtmlRelativePath(shell));
        const template = readFileSync(htmlPath, 'utf8');
        const html = injectShareMetadata(template, await resolveShareMetadata(req));
        applyNoStoreHeaders(res);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
      } catch (error) {
        next(error);
      }
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

startServer();
