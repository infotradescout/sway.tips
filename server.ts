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
import { and, asc, desc, eq, gt, ilike, inArray, isNotNull, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { ActiveRoomSummary, BackendState, RequestItem, GigSession, BoostContribution } from "./src/types";
import { LIVE_ROOM_LANGUAGE } from "./src/live-room-language";
import { normalizeSafeAccountNextPath } from "./src/file-collaboration-routing";
import { createSwayDb } from "./src/db/client";
import { activeBlocks, activeRoomRegistry, audioAssets, audioProjectAssetVersions, audioProjects, gigAccessGrants, gigSessions, moderationEvents, moderationMutationKeys, musicReleases, payments, performerEvents, performerLibrarySources, performerLibraryTracks, performerLoginChallenges, performerOnboardingStatusEnum, performerPartnerEntitlements, performerPartnerEntitlementStatusEvents, performerPartnerTermsAcceptances, performerProfileLinks, performerProfilePreviews, performerPublicProfiles, performerSetlistTracks, performerMemberships, performers, promotionCampaigns, proModeStatusEvents, requestBoosts, requests, userRoleEnum, users } from "./src/db/schema";
import { createAccessControl, routeFamilyGuard } from "./src/server/access-control";
import {
  evaluateReleaseHealth,
  loadExpectedMigrations
} from "./src/server/release-health";
import { createIdempotencyStore, type DurableActionInput, type DurableActorActionInput, type PendingActionOwner } from "./src/server/idempotency-store";
import { createModerationService, type BlockScope } from "./src/server/moderation-service";
import { lockModerationBlockIdentities } from "./src/server/moderation-block-lock";
import { createBusinessStore } from "./src/server/business-store";
import { toAuditEntityUuid, writeAuditEvent } from "./src/server/audit-log";
import { createConfiguredPaymentProvider } from "./src/server/payment-provider";
import { resolveLiveRoomPaymentRuntimeConfig } from "./src/server/live-room-payment-config";
import {
  createPaymentService,
  type CloseoutTotals,
  type PaymentReversalResult,
  type SettleResult
} from "./src/server/payment-service";
import { resolveProposedPlatformFee } from "./src/server/fee-policy";
import {
  isTestModePlatformBalancePerformerAllowed,
  resolveLiveRoomSellerMoneyReadiness,
  resolveTestModePlatformBalancePerformerIds
} from "./src/server/live-room-seller-readiness";
import { projectPerformerRoomRecap } from "./src/server/live-room-recap";
import { createPaymentWebhookService } from "./src/server/payment-webhook";
import { verifyPerformerBootstrapToken } from "./src/server/performer-bootstrap";
import { createPerformerSessionStore } from "./src/server/performer-session-store";
import { createPlaybackControlStore } from "./src/server/playback-control-store";
import {
  isPlaybackSourceKey,
  isUuid as isPlaybackUuid,
  normalizePlaybackCommandPayload,
  validatePlaybackCommandInput,
  type PlaybackCommandPayload
} from "./src/playback-control";
import { activateProModeWithPerformer, getProModeStatus } from "./src/server/pro-mode";
import {
  activateClaimedPerformerAndProMode,
  assertPerformerClaimableByHandoff,
  claimCodeFingerprint,
  mapClaimInspectionToClientError,
  readClaimPerformerId,
  transferPerformerOwnership
} from "./src/server/account-claim";
import {
  createPerformerLoginChallengeStore,
  createPerformerLoginRateLimiter,
  hashPerformerLoginRequesterIp,
  normalizePerformerDisplayName,
  normalizePerformerLoginEmail,
  normalizePerformerHandle,
  normalizePerformerPhone,
  ACCOUNT_LOGIN_CHALLENGE_TYPE_VERIFY_EMAIL,
  PERFORMER_CLAIM_CODE_TTL_MS,
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
  hashPerformerPassword,
  normalizePerformerPassword,
  validatePerformerPasswordStrength,
  verifyPerformerPassword
} from "./src/server/performer-password-auth";
import { getMusicSourceCapabilityCatalog } from "./src/server/music-source-capabilities";
import { importSpotifyPlaylist, isCatalogSearchConfigured, searchCatalog } from "./src/server/spotify-catalog";
import { createConfiguredStripeConnectService } from "./src/server/stripe-connect";
import { provisionStripeConnectRecipient } from "./src/server/stripe-connect-onboarding";
import { createStripeConnectOnboardingStore } from "./src/server/stripe-connect-onboarding-store";
import { handleStripeConnectReturn } from "./src/server/stripe-connect-return";
import { reconcileStripeConnectPerformerStatus } from "./src/server/stripe-connect-status";
import { handleStripeConnectAccountStatusWebhook } from "./src/server/stripe-connect-webhook";
import { lookupLyrics } from "./src/server/lyrics-provider";
import {
  escapePublicProfileMetadataAttribute,
  mergePublicProfileMetadata,
  normalizePublicProfileEmail,
  normalizePublicProfileFeaturedMedia,
  normalizePublicProfileLinks,
  normalizePublicProfilePhone,
  normalizePublicProfilePrimaryRole,
  normalizePublicProfileSpecialties,
  normalizePublicProfileText,
  normalizePublicProfileUrl,
  resolveVerifiedPublicBookingContact,
  evaluatePublicPerformerVisibility,
  type PerformerVisibilityState
} from "./src/server/public-profile";
import { parsePerformerVisibilityState } from "./src/server/performer-visibility-control";
import { buildSwayPartnerTermsSnapshot, SWAY_PARTNER_TERMS_HASH, SWAY_PARTNER_TERMS_TEXT, SWAY_PARTNER_TERMS_VERSION } from "./src/server/partner-entitlement";
import { loadPartnerEntitlementStateForPerformer } from "./src/server/partner-entitlement-store";
import {
  issuePatronStatusReceipt,
  matchesPatronStatusReceipt,
  projectPatronBoostStatus,
  projectPatronRequestStatus,
  selectPatronPaymentEvidence
} from "./src/server/patron-status-receipt";
import {
  projectPublicRoomState,
  sanitizePatronMutationResponseBody
} from "./src/server/public-room-state";
import { createConfiguredAudioObjectStore } from "./src/server/audio-object-storage";
import { createAudioPublishingService } from "./src/server/audio-publishing-service";
import {
  AudioStorageObjectLimitError,
  AudioStorageQuotaError,
  createAudioStoragePolicy
} from "./src/server/audio-storage-policy";
import {
  AUDIO_UPLOAD_PART_MAX_BYTES,
  AUDIO_UPLOAD_PART_PATH_PATTERN,
  createAudioUploadPartBodyParser
} from "./src/server/audio-upload-transport";
import { createAudioFilePairingService } from "./src/server/audio-file-pairing-service";
import { createAudioFileCollaborationService } from "./src/server/audio-file-collaboration-service";
import { AUDIO_PUBLISHING_RUNTIME_CAPABILITIES } from "./src/server/audio-publishing-contract";
import {
  createPerformerEventService,
  EventServiceError,
  isPublicEventExternalTicketLabel,
  normalizePublicEventHttpsUrl,
  type PerformerEventDto,
  type PublicPerformerEventDto
} from "./src/server/performer-event-service";
import {
  createEventTicketService,
  EventTicketServiceError
} from "./src/server/event-ticket-service";
import { createDiscoveryObservatoryStore } from "./src/server/discovery-observatory-store";
import {
  buildDiscoveryObservatorySnapshot,
  buildSwayDiscoveryQueryCollection,
  resolvePerformerDiscoveryEligibility,
  SWAY_DISCOVERY_EXPERIMENTS,
  type DiscoveryJourneyEventInput,
  type PerformerDiscoveryVisibilityState,
  type SwayDiscoverySupply
} from "./src/server/discovery-observatory";
import {
  NATIVE_TICKET_BUYER_TERMS_HASH,
  NATIVE_TICKET_BUYER_TERMS_TEXT,
  NATIVE_TICKET_SELLER_TERMS_HASH,
  NATIVE_TICKET_SELLER_TERMS_TEXT,
  NATIVE_TICKET_TERMS_VERSION,
  resolveNativeTicketRuntimeConfig
} from "./src/server/event-ticket-contract";

dotenv.config({ path: ".env.local", override: false });
dotenv.config({ override: false });

const app = express();
const PORT = Number(process.env.PORT ?? 3000);
const isProduction = process.env.NODE_ENV === "production";
const skipStartupBusinessStateHydration = process.env.SWAY_SKIP_STARTUP_BUSINESS_STATE_HYDRATION === 'true';
if (isProduction && skipStartupBusinessStateHydration) {
  throw new Error('SWAY_SKIP_STARTUP_BUSINESS_STATE_HYDRATION is not allowed in production.');
}
// Migration 0028 is live and the legacy snapshot writer has drained, so the
// durable writer is now canonical. Operators retain an explicit emergency
// kill switch; missing or malformed configuration does not silently disable
// the production write path after a deploy.
const liveRoomDurabilityKillSwitchActive = process.env.SWAY_LIVE_ROOM_DURABILITY_WRITES_DISABLED?.trim().toLowerCase() === 'true';
const liveRoomDurabilityWritesEnabled = !liveRoomDurabilityKillSwitchActive;
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
const discoveryObservatoryStore = businessDb
  ? createDiscoveryObservatoryStore(businessDb)
  : null;
const audioObjectStore = (() => {
  try {
    return createConfiguredAudioObjectStore(process.env);
  } catch (error) {
    if (process.env.SWAY_AUDIO_STORAGE_PROVIDER?.trim()) {
      console.error('[sway.audio] storage config rejected:', error instanceof Error ? error.message : error);
    }
    if (isProduction && process.env.SWAY_AUDIO_STORAGE_PROVIDER?.trim()) {
      throw error;
    }
    return null;
  }
})();
const audioStoragePolicy = createAudioStoragePolicy({ env: process.env });
let audioObjectStoreVerified = false;
const audioPublishingService = businessDb && audioObjectStore
  ? createAudioPublishingService({
      db: businessDb,
      store: audioObjectStore,
      workspaceLimitBytes: audioStoragePolicy.workspaceLimitBytes,
      workingObjectLimit: audioStoragePolicy.workingObjectLimit
    })
  : null;
const audioFilePairingService = businessDb
  ? createAudioFilePairingService({ db: businessDb })
  : null;
const audioFileCollaborationService = businessDb && audioObjectStore
  ? createAudioFileCollaborationService({ db: businessDb, store: audioObjectStore })
  : null;
const performerEventService = businessDb
  ? createPerformerEventService(businessDb)
  : null;
const nativeTicketRuntimeConfig = resolveNativeTicketRuntimeConfig(process.env, isProduction);
const eventTicketService = businessDb
  ? createEventTicketService({
      db: businessDb,
      runtimeConfig: nativeTicketRuntimeConfig
    })
  : null;
if (
  process.env.SWAY_NATIVE_TICKETS_ENABLED?.trim().toLowerCase() === 'true'
  && !nativeTicketRuntimeConfig.salesEnabled
) {
  console.warn(
    '[sway.tickets] native ticket sales remain disabled:',
    nativeTicketRuntimeConfig.disabledReasons.join(', ')
  );
}
const performerSessionStore = createPerformerSessionStore({
  databaseUrl: process.env.DATABASE_URL,
  dbOverride: businessDb
});
const playbackControlStore = businessDb
  ? createPlaybackControlStore({ db: businessDb })
  : null;
const performerLoginChallengeStore = createPerformerLoginChallengeStore({
  databaseUrl: process.env.DATABASE_URL,
  dbOverride: businessDb
});
const performerLoginRateLimiter = createPerformerLoginRateLimiter();
const performerSignupRateLimiter = createPerformerLoginRateLimiter({
  maxRequests: parsePositiveInteger(process.env.SWAY_PERFORMER_SIGNUP_RATE_LIMIT_MAX, 3),
  windowMs: parsePositiveInteger(process.env.SWAY_PERFORMER_SIGNUP_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000)
});
const performerClaimPeekRateLimiter = createPerformerLoginRateLimiter({
  maxRequests: parsePositiveInteger(process.env.SWAY_PERFORMER_CLAIM_PEEK_RATE_LIMIT_MAX, 20),
  windowMs: parsePositiveInteger(process.env.SWAY_PERFORMER_CLAIM_PEEK_RATE_LIMIT_WINDOW_MS, 5 * 60 * 1000)
});
const hasAdminBootstrapSecret = Boolean(process.env.SWAY_ADMIN_BOOTSTRAP_SECRET?.trim());
const adminBootstrapRateLimiter = createPerformerLoginRateLimiter({
  maxRequests: parsePositiveInteger(process.env.SWAY_ADMIN_BOOTSTRAP_RATE_LIMIT_MAX, 3),
  windowMs: parsePositiveInteger(process.env.SWAY_ADMIN_BOOTSTRAP_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000)
});
const DURABLE_PASSWORD_FAILURE_CHALLENGE_TYPE = 'password_login_failure';
const DURABLE_PASSWORD_FAILURE_WINDOW_MS = 15 * 60 * 1000;

async function checkDurablePasswordLoginLimit(input: {
  requesterIpHash: string;
  accountKey: string;
  scope: 'account' | 'admin';
  maxFailures: number;
}) {
  if (!businessDb) return { allowed: false };
  const bucketKey = `${input.scope}:${input.accountKey}`.slice(0, 320);
  const failures = await businessDb.select({ id: performerLoginChallenges.id })
    .from(performerLoginChallenges)
    .where(and(
      eq(performerLoginChallenges.challengeType, DURABLE_PASSWORD_FAILURE_CHALLENGE_TYPE),
      eq(performerLoginChallenges.requesterIpHash, input.requesterIpHash),
      eq(performerLoginChallenges.targetEmail, bucketKey),
      isNull(performerLoginChallenges.revokedAt),
      gt(performerLoginChallenges.requestedAt, new Date(Date.now() - DURABLE_PASSWORD_FAILURE_WINDOW_MS))
    ))
    .limit(input.maxFailures);
  return { allowed: failures.length < input.maxFailures };
}

async function recordDurablePasswordLoginFailure(input: {
  requesterIpHash: string;
  accountKey: string;
  scope: 'account' | 'admin';
}) {
  if (!businessDb) return;
  const bucketKey = `${input.scope}:${input.accountKey}`.slice(0, 320);
  await businessDb.insert(performerLoginChallenges).values({
    targetEmail: bucketKey,
    challengeType: DURABLE_PASSWORD_FAILURE_CHALLENGE_TYPE,
    tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
    expiresAt: new Date(Date.now() + DURABLE_PASSWORD_FAILURE_WINDOW_MS),
    requesterIpHash: input.requesterIpHash
  });
}

async function resetDurablePasswordLoginFailures(input: {
  requesterIpHash: string;
  accountKey: string;
  scope: 'account' | 'admin';
}) {
  if (!businessDb) return;
  const bucketKey = `${input.scope}:${input.accountKey}`.slice(0, 320);
  await businessDb.update(performerLoginChallenges).set({ revokedAt: new Date() }).where(and(
    eq(performerLoginChallenges.challengeType, DURABLE_PASSWORD_FAILURE_CHALLENGE_TYPE),
    eq(performerLoginChallenges.requesterIpHash, input.requesterIpHash),
    eq(performerLoginChallenges.targetEmail, bucketKey),
    isNull(performerLoginChallenges.revokedAt)
  ));
}
const performerLoginMailer = createPerformerLoginMailer({
  env: process.env,
  isProduction
});
const paymentProvider = createConfiguredPaymentProvider(process.env);
const stripeConnectService = createConfiguredStripeConnectService(process.env);
const stripeConnectOnboardingStore = businessDb
  ? createStripeConnectOnboardingStore(businessDb)
  : null;
const liveRoomPaymentRuntimeConfig = resolveLiveRoomPaymentRuntimeConfig({
  env: process.env,
  paymentProviderConfigured: Boolean(paymentProvider),
  stripeConnectConfigured: Boolean(stripeConnectService),
  durabilityWritesEnabled: liveRoomDurabilityWritesEnabled
});
const testModePlatformBalancePerformerIds = resolveTestModePlatformBalancePerformerIds({
  paymentMode: liveRoomPaymentRuntimeConfig.mode,
  configuredValue: process.env.SWAY_TEST_MODE_PLATFORM_BALANCE_ENABLED,
  performerIdsValue: process.env.SWAY_TEST_MODE_PLATFORM_BALANCE_PERFORMER_IDS
});
const testModePlatformBalanceEnabled = testModePlatformBalancePerformerIds.size > 0;
const paymentService = createPaymentService({
  databaseUrl: process.env.DATABASE_URL,
  provider: paymentProvider,
  testPlatformBalancePerformerIds: testModePlatformBalancePerformerIds
});
const paymentWebhookService = paymentProvider
  ? createPaymentWebhookService({
      databaseUrl: process.env.DATABASE_URL,
      provider: paymentProvider,
      expectedLivemode: liveRoomPaymentRuntimeConfig.mode === 'live'
    })
  : null;

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

// Parse bounded binary upload parts before the JSON middleware sees the body.
app.use(AUDIO_UPLOAD_PART_PATH_PATTERN, createAudioUploadPartBodyParser());
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

const LIVE_ROOM_MUTATION_ROLLOUT_PATHS = [
  /^\/api\/session(?:\/|$)/i,
  /^\/api\/request(?:\/|$)/i,
  /^\/api\/pending-action(?:\/|$)/i,
  /^\/api\/moderation\/(?:hide|remove)(?:\/|$)/i,
  /^\/api\/talent\/control-bridge\/action(?:\/|$)/i
];
app.use((req, res, next) => {
  const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
  const isLiveRoomMutation = LIVE_ROOM_MUTATION_ROLLOUT_PATHS.some((pattern) => pattern.test(req.path));
  if (liveRoomDurabilityWritesEnabled || !isMutation || !isLiveRoomMutation) {
    next();
    return;
  }
  applyNoStoreHeaders(res);
  res.status(503).json({
    error: 'Live-room updates are briefly paused while payment safety storage is activated. Retry shortly.',
    retryable: true,
    durability_rollout: 'read_only'
  });
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
  if (urlPath.startsWith('/r/') || urlPath.startsWith('/e/') || urlPath === '/discover') return 'patron';
  return 'patron';
}

function shellHtmlRelativePath(shell: SwayShell): string {
  return `shells/${shell}.html`;
}

function isShellAllowed(shell: SwayShell): boolean {
  return !(isProduction && shell === 'dev-sandbox');
}

type DiscoveryFacts = {
  entityType: 'performer' | 'event' | 'release' | 'live_room';
  entityName: string;
  heading: string;
  summary: string;
  categories: string[];
  location?: string | null;
  primaryActionLabel: string;
  primaryActionHref: string;
  relatedLinks: Array<{ label: string; href: string }>;
  lastUpdated?: string | null;
};

type ShareMetadata = {
  title: string;
  description: string;
  url: string;
  image: string;
  imageAlt: string;
  robots?: 'noindex, nofollow';
  structuredData?: Record<string, unknown>;
  discoveryFacts?: DiscoveryFacts;
};

type PublicShareProfile = {
  displayName: string;
  handle: string;
  bio: string | null;
  headline: string | null;
  city: string | null;
  avatarUrl: string | null;
  specialties: string[] | null;
  updatedAt: Date | null;
  visibility: 'public' | 'unlisted';
};

type PublicPerformerDiscoveryProfile = {
  performerId: string;
  ownerUserId: string;
  ownerEmailVerifiedAt: Date | null;
  displayName: string;
  handle: string | null;
  bio: string | null;
  visibilityState: PerformerVisibilityState;
  isActive: boolean;
  onboardingStatus: string;
  headline: string | null;
  specialties: string[] | null;
  city: string | null;
  avatarUrl: string | null;
  metadata: unknown;
  bookingEmail: string | null;
  bookingPhone: string | null;
  facebookUrl: string | null;
  instagramUrl: string | null;
  tiktokUrl: string | null;
  youtubeUrl: string | null;
  soundcloudUrl: string | null;
  websiteUrl: string | null;
  featuredMedia: unknown;
  updatedAt: Date | null;
};

type PublicPerformerDiscoveryResolution =
  | { kind: 'public' | 'unlisted'; profile: PublicPerformerDiscoveryProfile }
  | { kind: 'not_resolvable' | 'unavailable'; profile: null };

const DEFAULT_SHARE_TITLE = 'Sway | Every Way to Play';
const DEFAULT_SHARE_DESCRIPTION = 'Sway gives performers one place for public profiles, releases, events, tickets, live rooms, Requests, Tips, Boosts, and direct audience support.';
const DEFAULT_SHARE_IMAGE_PATH = '/social-preview.png?v=4';
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

/** Public entity canonical URLs always use app.sway.tips (apex/www may serve the same app). */
function canonicalPublicUrl(pathOrUrl: string) {
  if (/^https?:\/\//i.test(pathOrUrl)) {
    try {
      const parsed = new URL(pathOrUrl);
      return `${CANONICAL_APP_ORIGIN}${parsed.pathname}${parsed.search}`;
    } catch {
      return pathOrUrl;
    }
  }
  const pathAndQuery = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
  return `${CANONICAL_APP_ORIGIN}${pathAndQuery.split('#')[0]}`;
}

function defaultShareMetadata(req: express.Request, overrides: Partial<Omit<ShareMetadata, 'url' | 'image'>> & { url?: string; image?: string } = {}): ShareMetadata {
  return {
    title: overrides.title || DEFAULT_SHARE_TITLE,
    description: overrides.description || DEFAULT_SHARE_DESCRIPTION,
    url: overrides.url
      ? canonicalPublicUrl(overrides.url)
      : canonicalPublicUrl(req.path || '/'),
    image: absoluteShareUrl(req, overrides.image || DEFAULT_SHARE_IMAGE_PATH),
    imageAlt: overrides.imageAlt || 'Sway approved neon brand artwork',
    robots: overrides.robots,
    structuredData: overrides.structuredData,
    discoveryFacts: overrides.discoveryFacts
  };
}

function escapeDiscoveryHtmlText(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderDiscoveryBodyHtml(facts: DiscoveryFacts) {
  const categories = facts.categories.map((value) => value.trim()).filter(Boolean);
  const related = facts.relatedLinks
    .filter((link) => link.label.trim() && link.href.trim())
    .map((link) => `<li><a href="${escapeDiscoveryHtmlText(link.href)}">${escapeDiscoveryHtmlText(link.label)}</a></li>`)
    .join('');
  const location = facts.location?.trim()
    ? `<p data-discovery="location">${escapeDiscoveryHtmlText(facts.location.trim())}</p>`
    : '';
  const lastUpdated = facts.lastUpdated?.trim()
    ? `<p data-discovery="last-updated">Last updated: ${escapeDiscoveryHtmlText(facts.lastUpdated.trim())}</p>`
    : '';
  const categoryHtml = categories.length
    ? `<p data-discovery="categories">${categories.map((value) => escapeDiscoveryHtmlText(value)).join(' · ')}</p>`
    : '';

  return [
    '<main id="sway-discovery-first-response" data-sway-discovery="server-rendered">',
    `  <h1>${escapeDiscoveryHtmlText(facts.heading)}</h1>`,
    `  <p data-discovery="summary">${escapeDiscoveryHtmlText(facts.summary)}</p>`,
    `  <p data-discovery="entity"><span data-discovery="entity-name">${escapeDiscoveryHtmlText(facts.entityName)}</span> · <span data-discovery="entity-type">${escapeDiscoveryHtmlText(facts.entityType)}</span></p>`,
    location,
    categoryHtml,
    `  <p data-discovery="primary-action"><a href="${escapeDiscoveryHtmlText(facts.primaryActionHref)}">${escapeDiscoveryHtmlText(facts.primaryActionLabel)}</a></p>`,
    related ? `  <ul data-discovery="related-links">${related}</ul>` : '',
    lastUpdated,
    '</main>'
  ].filter(Boolean).join('\n    ');
}

function renderShareMetaTags(metadata: ShareMetadata) {
  const title = escapePublicProfileMetadataAttribute(metadata.title);
  const description = escapePublicProfileMetadataAttribute(metadata.description);
  const url = escapePublicProfileMetadataAttribute(metadata.url);
  const image = escapePublicProfileMetadataAttribute(metadata.image);
  const imageAlt = escapePublicProfileMetadataAttribute(metadata.imageAlt);
  const robots = metadata.robots
    ? `<meta name="robots" content="${escapePublicProfileMetadataAttribute(metadata.robots)}" />`
    : '';
  const structuredData = metadata.structuredData
    ? `<script type="application/ld+json">${JSON.stringify(metadata.structuredData).replace(/</g, '\\u003c')}</script>`
    : '';

  return [
    '<meta name="sway-share-meta" content="server-rendered" />',
    robots,
    `<title>${title}</title>`,
    `<meta name="description" content="${description}" />`,
    `<link rel="canonical" href="${url}" />`,
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
    `<meta name="twitter:image" content="${image}" />`,
    structuredData
  ].join('\n    ');
}

function injectShareMetadata(html: string, metadata: ShareMetadata) {
  const metaTags = renderShareMetaTags(metadata);
  const withoutExisting = html
    .replace(/\s*<title>[\s\S]*?<\/title>/i, '')
    .replace(/\s*<link\s+rel=["']canonical["'][^>]*>/gi, '')
    .replace(/\s*<script\s+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/\s*<main\s+id=["']sway-discovery-first-response["'][\s\S]*?<\/main>/gi, '')
    .replace(/\s*<meta\s+(?:name|property)=["'](?:description|robots|og:[^"']+|twitter:[^"']+|sway-share-meta)["'][^>]*>/gi, '');

  const withHead = withoutExisting.replace('</head>', `    ${metaTags}\n  </head>`);
  if (!metadata.discoveryFacts) return withHead;

  const discoveryBody = renderDiscoveryBodyHtml(metadata.discoveryFacts);
  return withHead.replace(
    /<div id="root"><\/div>/i,
    `<div id="root">\n    ${discoveryBody}\n    </div>`
  );
}

async function resolvePublicPerformerDiscovery(rawHandle: unknown): Promise<PublicPerformerDiscoveryResolution> {
  const normalizedHandle = normalizePerformerHandle(rawHandle);
  if (!normalizedHandle) return { kind: 'not_resolvable', profile: null };
  if (!businessDb) return { kind: 'unavailable', profile: null };

  try {
    const profiles = await businessDb
      .select({
        performerId: performers.id,
        ownerUserId: performers.ownerUserId,
        ownerEmailVerifiedAt: users.emailVerifiedAt,
        displayName: performers.displayName,
        handle: performers.handle,
        bio: performers.bio,
        visibilityState: performers.visibilityState,
        isActive: performers.isActive,
        onboardingStatus: performers.onboardingStatus,
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
        featuredMedia: performerPublicProfiles.featuredMedia,
        updatedAt: performerPublicProfiles.updatedAt
      })
      .from(performers)
      .innerJoin(users, eq(users.id, performers.ownerUserId))
      .leftJoin(performerPublicProfiles, eq(performerPublicProfiles.performerId, performers.id))
      .where(and(
        sql`lower(${performers.handle}) = ${normalizedHandle.toLowerCase()}`,
        sql`nullif(trim(${performers.bio}), '') is not null`
      ));

    if (profiles.length !== 1) return { kind: 'not_resolvable', profile: null };

    const candidate = profiles[0];
    if (!isDiscoveryEligibleHandle(candidate.handle)) return { kind: 'not_resolvable', profile: null };
    const storedHandle = normalizePerformerHandle(candidate.handle);
    const policy = evaluatePublicPerformerVisibility({
      claimed: true,
      hasOwner: Boolean(candidate.ownerUserId),
      isActive: candidate.isActive,
      onboardingStatus: candidate.onboardingStatus,
      visibilityState: candidate.visibilityState,
      handle: storedHandle,
      displayName: candidate.displayName,
      conflicted: false
    });

    if (policy.kind !== 'public' && policy.kind !== 'unlisted') {
      return { kind: 'not_resolvable', profile: null };
    }

    return {
      kind: policy.kind,
      profile: {
        ...candidate,
        handle: storedHandle?.toLowerCase() ?? null
      }
    };
  } catch (error) {
    console.error('[sway.discovery] claimed performer resolution failed:', error);
    return { kind: 'unavailable', profile: null };
  }
}

function toPublicShareProfile(
  profile: PublicPerformerDiscoveryProfile,
  visibility: 'public' | 'unlisted'
): PublicShareProfile {
  return {
    displayName: profile.displayName,
    handle: profile.handle!,
    bio: profile.bio,
    headline: profile.headline,
    city: profile.city,
    avatarUrl: profile.avatarUrl,
    specialties: profile.specialties,
    updatedAt: profile.updatedAt,
    visibility
  };
}

function buildPublicPerformerShareMetadata(
  req: express.Request,
  profile: PublicShareProfile
): ShareMetadata {
  const title = `@${profile.handle} on Sway`;
  const description = profile.headline?.trim() || profile.bio?.trim() || 'Public performer profile on Sway.';
  const canonicalProfileUrl = canonicalPublicUrl(`/p/${profile.handle}`);
  const categories = Array.isArray(profile.specialties)
    ? profile.specialties.map((value) => String(value).trim()).filter(Boolean).slice(0, 8)
    : [];
  const lastUpdated = profile.updatedAt instanceof Date && !Number.isNaN(profile.updatedAt.getTime())
    ? profile.updatedAt.toISOString().slice(0, 10)
    : null;

  return defaultShareMetadata(req, {
    title,
    description,
    url: `/p/${profile.handle}`,
    image: `/api/public/performer/${encodeURIComponent(profile.handle)}/share-card.png?v=1`,
    imageAlt: `@${profile.handle} Sway public page`,
    robots: profile.visibility === 'unlisted' ? 'noindex, nofollow' : undefined,
    structuredData: profile.visibility === 'public'
      ? {
          '@context': 'https://schema.org',
          '@type': 'Person',
          name: profile.displayName,
          alternateName: `@${profile.handle}`,
          description: profile.bio?.trim() || undefined,
          url: canonicalProfileUrl,
          image: normalizePublicProfileUrl(profile.avatarUrl) || undefined,
          homeLocation: profile.city ? { '@type': 'Place', name: profile.city } : undefined,
          mainEntityOfPage: canonicalProfileUrl,
          knowsAbout: categories.length ? categories : undefined
        }
      : undefined,
    discoveryFacts: {
      entityType: 'performer',
      entityName: profile.displayName || `@${profile.handle}`,
      heading: profile.displayName || `@${profile.handle}`,
      summary: description,
      categories: categories.length ? categories : ['Performer'],
      location: profile.city,
      primaryActionLabel: 'View performer page',
      primaryActionHref: canonicalProfileUrl,
      relatedLinks: [
        { label: 'Discover shows and live rooms', href: canonicalPublicUrl('/discover') },
        { label: 'About Sway', href: canonicalPublicUrl('/about') }
      ],
      lastUpdated
    }
  });
}

async function findPublicShareProfile(rawHandle: string): Promise<PublicShareProfile | null> {
  const resolution = await resolvePublicPerformerDiscovery(rawHandle);
  if ((resolution.kind !== 'public' && resolution.kind !== 'unlisted') || !resolution.profile) return null;
  return toPublicShareProfile(resolution.profile, resolution.kind);
}

const PUBLIC_PROFILE_NOT_FOUND_HTML = '<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow"><title>Sway performer profile not found</title></head><body><main><h1>Performer profile not found</h1><p>This Sway performer profile is not publicly available.</p></main></body></html>';
const PUBLIC_PROFILE_UNAVAILABLE_HTML = '<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow"><title>Sway performer profile unavailable</title></head><body><main><h1>Performer profile unavailable</h1><p>Sway could not load this performer profile right now.</p></main></body></html>';

function sendPublicProfileNotFound(res: express.Response) {
  return res
    .status(404)
    .type('html')
    .set('X-Robots-Tag', 'noindex, nofollow')
    .send(PUBLIC_PROFILE_NOT_FOUND_HTML);
}

function sendPublicProfileUnavailable(res: express.Response) {
  return res
    .status(503)
    .type('html')
    .set('X-Robots-Tag', 'noindex, nofollow')
    .send(PUBLIC_PROFILE_UNAVAILABLE_HTML);
}

async function renderPublicPerformerDocument(
  req: express.Request,
  res: express.Response,
  templateHtml: string
) {
  const rawHandle = req.params.handle ?? req.params[0];
  const resolution = await resolvePublicPerformerDiscovery(rawHandle);
  if (resolution.kind === 'unavailable') return sendPublicProfileUnavailable(res);
  if ((resolution.kind !== 'public' && resolution.kind !== 'unlisted') || !resolution.profile) {
    return sendPublicProfileNotFound(res);
  }

  const profile = toPublicShareProfile(resolution.profile, resolution.kind);
  const html = injectShareMetadata(templateHtml, buildPublicPerformerShareMetadata(req, profile));
  applyNoStoreHeaders(res);
  if (resolution.kind === 'unlisted') res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  return res.status(200).type('html').send(html);
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
  const heroName = `@${profile.handle}`;
  const nameFontSize = heroName.length > 28 ? 54 : heroName.length > 20 ? 68 : 86;
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
    <text x="92" y="170" fill="#f4a6ff" font-family="Arial, Helvetica, sans-serif" font-size="30" font-weight="700" letter-spacing="4">SWAY • PUBLIC PAGE</text>
    <text x="92" y="340" fill="#ffffff" font-family="Arial, Helvetica, sans-serif" font-size="${nameFontSize}" font-weight="800">${escapeShareCardText(heroName)}</text>
    ${headlineLines.map((line, index) => `<text x="96" y="${470 + index * 58}" fill="#e6e8f5" font-family="Arial, Helvetica, sans-serif" font-size="39" font-weight="500">${escapeShareCardText(line)}</text>`).join('')}
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
    return buildPublicPerformerShareMetadata(req, profile);
  }

  if (pathParts[0] === 'e' && pathParts[1] && UUID_PATTERN.test(pathParts[1]) && performerEventService) {
    const event = await performerEventService.getPublicEvent(pathParts[1]);
    if (!event) return defaultMetadata;

    const eventDate = new Date(event.startsAt);
    const dateCopy = Number.isNaN(eventDate.getTime())
      ? 'View event details.'
      : `Happening ${eventDate.toLocaleDateString('en-US', {
          month: 'long',
          day: 'numeric',
          year: 'numeric',
          timeZone: event.timeZone
        })}.`;
    const locationCopy = event.locationIsTba
      ? ' Location to be announced.'
      : event.locationName || event.city
        ? ` ${[event.locationName, event.city].filter(Boolean).join(' · ')}.`
        : '';
    const cancellationCopy = event.status === 'cancelled' ? ' This event has been cancelled.' : '';

    const canonicalEventUrl = canonicalPublicUrl(`/e/${event.id}`);
    const eventDescription = `${event.description || `${dateCopy}${locationCopy}`}${cancellationCopy}`.trim();
    const venueLabel = event.locationIsTba
      ? 'Location TBA'
      : [event.locationName, event.city].filter(Boolean).join(' · ') || null;
    const performerPath = event.performer.handle ? `/p/${event.performer.handle}` : null;

    return defaultShareMetadata(req, {
      title: `${event.title} on Sway`,
      description: eventDescription,
      url: `/e/${event.id}`,
      image: event.coverImageUrl || event.performer.avatarUrl || DEFAULT_SHARE_IMAGE_PATH,
      imageAlt: `${event.title} event artwork`,
      structuredData: {
        '@context': 'https://schema.org',
        '@type': 'Event',
        name: event.title,
        description: event.description || undefined,
        startDate: event.startsAt,
        endDate: event.endsAt || undefined,
        eventStatus: event.status === 'cancelled'
          ? 'https://schema.org/EventCancelled'
          : 'https://schema.org/EventScheduled',
        eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
        image: event.coverImageUrl || event.performer.avatarUrl || undefined,
        url: canonicalEventUrl,
        location: event.locationIsTba ? undefined : {
          '@type': 'Place',
          name: event.locationName || event.city || undefined,
          address: event.locationAddress || event.city || undefined
        },
        performer: {
          '@type': 'Person',
          name: event.performer.displayName,
          url: performerPath ? canonicalPublicUrl(performerPath) : undefined
        }
      },
      robots: event.visibility === 'unlisted'
        || event.status === 'cancelled'
        || eventDate.getTime() <= Date.now()
        ? 'noindex, nofollow'
        : undefined,
      discoveryFacts: {
        entityType: 'event',
        entityName: event.title,
        heading: event.title,
        summary: eventDescription,
        categories: ['Event', 'Live show'],
        location: venueLabel,
        primaryActionLabel: 'Attend this event',
        primaryActionHref: canonicalEventUrl,
        relatedLinks: [
          ...(performerPath
            ? [{ label: `View ${event.performer.displayName}`, href: canonicalPublicUrl(performerPath) }]
            : []),
          { label: 'Discover shows', href: canonicalPublicUrl('/discover') }
        ],
        lastUpdated: null
      }
    });
  }

  if (pathParts[0] === 'r' && pathParts[1] && UUID_PATTERN.test(pathParts[1]) && audioPublishingService) {
    const release = await audioPublishingService.getPublicRelease({ releaseId: pathParts[1] });
    if (!release) return defaultMetadata;
    const dateCopy = release.status === 'published'
      ? 'Out now.'
      : release.scheduledReleaseAt
        ? `Planned for ${new Date(release.scheduledReleaseAt).toLocaleDateString('en-US')}.`
        : 'Release ready; destination delivery is not yet confirmed.';
    const creationCopy = release.creationTags.length ? `${release.creationTags.join(' · ')}. ` : '';
    const releaseDescription = `${dateCopy} ${creationCopy}View the official credits and provider-confirmed availability on Sway.`;
    const canonicalReleaseUrl = canonicalPublicUrl(release.releasePath);
    return defaultShareMetadata(req, {
      title: `${release.title} by ${release.primaryArtistName}`,
      description: releaseDescription,
      url: release.releasePath,
      image: release.artworkUrl || DEFAULT_SHARE_IMAGE_PATH,
      imageAlt: `${release.title} release artwork`,
      structuredData: {
        '@context': 'https://schema.org',
        '@type': 'MusicAlbum',
        name: release.title,
        byArtist: {
          '@type': 'MusicGroup',
          name: release.primaryArtistName
        },
        datePublished: release.publishedAt || release.scheduledReleaseAt || undefined,
        image: release.artworkUrl || undefined,
        url: canonicalReleaseUrl,
        numTracks: Array.isArray(release.recordings) ? release.recordings.length : undefined
      },
      discoveryFacts: {
        entityType: 'release',
        entityName: release.title,
        heading: `${release.title} by ${release.primaryArtistName}`,
        summary: releaseDescription,
        categories: ['Release', 'Self-Production', ...release.creationTags],
        primaryActionLabel: 'View release',
        primaryActionHref: canonicalReleaseUrl,
        relatedLinks: [
          { label: 'Discover on Sway', href: canonicalPublicUrl('/discover') }
        ],
        lastUpdated: release.publishedAt
          ? new Date(release.publishedAt).toISOString().slice(0, 10)
          : null
      }
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
    const roomPath = room.routePath || req.originalUrl;
    const canonicalRoomUrl = canonicalPublicUrl(roomPath);

    return defaultShareMetadata(req, {
      title,
      description,
      url: roomPath,
      image: normalizePublicProfileUrl(room.avatarUrl) || DEFAULT_SHARE_IMAGE_PATH,
      imageAlt: `${performerName} Sway live room`,
      discoveryFacts: {
        entityType: 'live_room',
        entityName: performerName,
        heading: title,
        summary: description,
        categories: ['Live Room'],
        primaryActionLabel: 'Enter Live Room',
        primaryActionHref: canonicalRoomUrl,
        relatedLinks: [
          { label: 'Discover live rooms', href: canonicalPublicUrl('/discover') }
        ],
        lastUpdated: null
      }
    });
  }

  return defaultMetadata;
}

function escapeStaticDocumentText(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderExactTicketTerms(value: string) {
  return value
    .split('\n')
    .map((paragraph) => `<p>${escapeStaticDocumentText(paragraph)}</p>`)
    .join('');
}

function renderStaticDocument(title: string, description: string, bodyHtml: string, eyebrow = 'Sway trust center') {
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
      h3 {
        margin: 0 0 6px;
        font-size: 15px;
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
      ol {
        margin: 0;
        padding-left: 22px;
      }
      strong { color: var(--text); }
      .hero-note {
        margin: 0 0 18px;
        padding: 16px 18px;
        border: 1px solid rgba(53, 213, 154, 0.24);
        border-radius: 14px;
        background: rgba(53, 213, 154, 0.07);
        color: #dffbf1;
        font-size: 16px;
        line-height: 1.6;
      }
      .card-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
        margin: 14px 0 4px;
      }
      .card {
        padding: 16px;
        border: 1px solid var(--line);
        border-radius: 14px;
        background: rgba(4, 6, 12, 0.5);
      }
      .card p { margin: 0; font-size: 14px; }
      .steps {
        display: grid;
        gap: 10px;
        margin: 14px 0 4px;
        padding: 0;
        list-style: none;
        counter-reset: sway-step;
      }
      .steps li {
        position: relative;
        min-height: 48px;
        padding: 12px 14px 12px 50px;
        border: 1px solid var(--line);
        border-radius: 12px;
        background: rgba(4, 6, 12, 0.36);
        counter-increment: sway-step;
      }
      .steps li::before {
        content: counter(sway-step);
        position: absolute;
        left: 13px;
        top: 12px;
        display: grid;
        width: 25px;
        height: 25px;
        place-items: center;
        border-radius: 50%;
        background: var(--accent);
        color: #06110d;
        font-size: 12px;
        font-weight: 800;
      }
      .plain-language {
        margin-top: 20px;
        padding: 16px 18px;
        border-left: 3px solid #7c5cff;
        border-radius: 0 12px 12px 0;
        background: rgba(124, 92, 255, 0.09);
      }
      .plain-language p { margin: 0; }
      .primary-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin: 18px 0 4px;
      }
      .primary-actions a {
        display: inline-flex;
        min-height: 42px;
        align-items: center;
        justify-content: center;
        padding: 0 16px;
        border-radius: 11px;
        background: var(--accent);
        color: #06110d;
        font-size: 14px;
        font-weight: 800;
        text-decoration: none;
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
      @media (max-width: 640px) {
        main { width: min(100% - 20px, 860px); padding-top: 24px; }
        .panel { padding: 18px; }
        .card-grid { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <main>
      <span class="eyebrow">${eyebrow}</span>
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
          <a href="/legal/tickets">Ticket terms</a>
        </div>
      </section>
    </main>
  </body>
</html>`;
}

function renderSupportPageHtml(reference: { type: 'order' | 'ticket'; id: string } | null = null) {
  const supportEmail = nativeTicketRuntimeConfig.supportEmail;
  const referenceLabel = reference
    ? `${reference.type === 'order' ? 'Order' : 'Ticket'} ${reference.id}`
    : null;
  const subject = referenceLabel ? `Sway ticket support — ${referenceLabel}` : 'Sway support request';
  const body = [
    referenceLabel ? `${referenceLabel}\n` : '',
    'Describe what happened, the outcome you expected, and any processor receipt or event details that can help Sway investigate.'
  ].join('');
  const contactHtml = supportEmail
    ? `
      <p>Email the monitored Sway support channel. Include the account email used in Sway, but never send a password, full card number, bank account number, or admission QR.</p>
      ${referenceLabel ? `<p><strong>Reference:</strong> <code>${escapeStaticDocumentText(referenceLabel)}</code></p>` : ''}
      <div class="primary-actions">
        <a href="mailto:${escapeStaticDocumentText(supportEmail)}?subject=${encodeURIComponent(subject)}&amp;body=${encodeURIComponent(body)}">Email ${escapeStaticDocumentText(supportEmail)}</a>
      </div>
    `
    : `
      <p><strong>The monitored support contact is temporarily unavailable.</strong> Native ticket sales remain disabled while this contact is missing. If you already hold a ticket, keep its ticket or order reference and try this page again.</p>
    `;

  return renderStaticDocument(
    'Sway Support',
    'How to reach Sway support, report a problem, and request safety or account help.',
    `
      <p>Sway support is for safety issues, platform payment or refund-processing failures, account problems, security, admission-pass technology, and live-room failures. Event questions, entry policies, scheduling, attendee service, and seller cancellation policy belong to the performer selling the ticket; use the seller contact shown with that event or ticket.</p>
      <h2>Use Sway support for</h2>
      <ul>
        <li>reporting harassment, unsafe behavior, or abusive requests</li>
        <li>requesting help with a performer account or live room</li>
        <li>reporting a platform payment, dispute, refund-processing, or admission-pass technology failure</li>
        <li>starting a data deletion request</li>
      </ul>
      <h2>Contact Sway</h2>
      ${contactHtml}
      <p>Use in-app safety controls first when they are available. Use the data deletion route below for deletion requests.</p>
    `
  );
}

const aboutPageHtml = renderStaticDocument(
  'Sway: the whole performer business, connected',
  'One read on how Sway connects a performer’s public identity, live audience, music catalog, releases, distribution, payments, and control.',
  `
    <p class="hero-note"><strong>Sway gives independent performers two connected systems.</strong> Live Rooms earn and engage audiences during real performances. Self-Production helps creators own, release, ticket, distribute, and eventually stream original work—including planned Sway.DIO (Digital Independent Original) streaming. External distribution is one Self-Production outlet, not Sway’s whole identity.</p>

    <h2>The product in four connected parts</h2>
    <div class="card-grid">
      <article class="card"><h3>Your public page</h3><p>A shareable Sway profile for your story, image, featured media, social links, booking contact, support links, releases, and live-room entry. It is designed to replace a patchwork artist website and link page with one place that stays connected to the rest of your business.</p></article>
      <article class="card"><h3>Your live room</h3><p>Live Rooms is the current operating product: a performer-controlled room for real-world shows. People scan a QR code or open a room link, make requests, tip, boost approved queue items, and follow what happened from their own private status receipts. Stripe live money remains a separate release gate; test-mode payment proof comes first.</p></article>
      <article class="card"><h3>Your Catalog and collaborators</h3><p>Self-Production files and collaboration: private, original-quality storage for masters and works in progress. Uploads are sealed with integrity evidence, versioned, playable by the owner, shareable by permission, and connected to review and release work.</p></article>
      <article class="card"><h3>Your publishing and distribution</h3><p>Self-Production release prep plus one external-distribution outlet (DistroKid-class workflow) inside the same account—not the definition of Sway. The current release workspace assembles singles, EPs, and albums from verified masters, with an ordered track list, per-track metadata and credits, artwork, identifiers, territories, and reviewed rights evidence. It prepares a release but does not send it to stores: provider-backed delivery, royalty accounting, splits, payouts, true pre-saves, and safe distributor cutover are not live.</p></article>
    </div>

    <h2>How Sway works for an audience member</h2>
    <ol class="steps">
      <li><strong>Join the correct room.</strong> Scan the performer’s Sway QR code or open their room link. A download is not required to use the web experience.</li>
      <li><strong>Choose what you want to do.</strong> Send a music or custom request, leave a direct tip, or boost an already-approved request higher in the crowd signal.</li>
      <li><strong>Review the amount and authorize payment.</strong> Sway does not treat a button tap as payment success. The screen waits for backend and payment-provider confirmation.</li>
      <li><strong>Follow the outcome.</strong> A private receipt shows whether your request, tip, or boost is pending, approved, denied, fulfilled, captured, released, or refunded.</li>
    </ol>
    <div class="plain-language"><p><strong>A request is not a promise that something will be played.</strong> The performer keeps artistic and operational control. If an unresolved request is denied or the room closes, Sway releases or refunds the associated payment according to its confirmed processor state.</p></div>

    <h2>How Sway works for a performer</h2>
    <ol class="steps">
      <li><strong>Create one Sway account.</strong> Any account can join rooms. Activating Pro Mode adds the performer workspace and public identity to that same account.</li>
      <li><strong>Build your public presence.</strong> Set your handle, name, roles, location, biography, featured media, booking details, social accounts, and prioritized links. When you go live, the same page can route fans into your active room.</li>
      <li><strong>Start and share a room.</strong> Configure the room, minimum support amount, request source, and operating mode; then share the durable QR or link.</li>
      <li><strong>Run the crowd, not a second job.</strong> Pause or resume requests, manually review them, use open-call behavior, or use crowd autopilot for moderated requests. Approve, deny, order, fulfill, report, or remove items while Sway keeps payment state tied to the action.</li>
      <li><strong>Close with a real recap.</strong> Ending a room shuts requests, resolves outstanding holds, calculates captured totals from durable records, and keeps the completed session in room history.</li>
    </ol>

    <h2>From a master file to a release</h2>
    <ol class="steps">
      <li><strong>Add the work to Catalog.</strong> Sway preserves the original, its checksum, versions, project ownership, and access permissions. Catalog files stay private unless the owner explicitly shares or exposes them for requests.</li>
      <li><strong>Work with the right people.</strong> Connect collaborators, grant only the permissions they need, exchange files, comment at timecodes, request changes, record approvals, and revoke access.</li>
      <li><strong>Build and order the release tracks.</strong> Start with one verified master, add another verified master for each additional track, and edit or reorder the track list. Add artwork, release and recording titles, artist identity, UPC, per-track ISRCs, explicit flags, languages, label, copyright lines, dates, territories, and recording credits. A single must keep one track; EP and album readiness requires at least two. Track structure locks when rights review starts so sealed evidence cannot silently drift.</li>
      <li><strong>Clear the rights that apply.</strong> Every release readiness check requires independently verified master control, composition control, artwork control, and distribution authorization. Samples, third-party beats, cover songs, performer consent, and AI disclosure are conditional evidence: creators must document them when the facts of the recording require them, but they are not universal requirements for every release.</li>
      <li><strong>Prepare for delivery.</strong> A rights-cleared release becomes ready for a contracted delivery provider. When that integration is active, each destination will keep its own queued, submitted, accepted, live, correction, failure, or takedown state so “published” means provider-confirmed—not merely submitted.</li>
    </ol>

    <h2>Replacing an existing distributor</h2>
    <p>Sway’s catalog-transfer design is built around continuity, not a blind re-upload. It will snapshot the source catalog; map artist identities, UPCs, ISRCs, exact metadata, artwork, assets, rights, and destination IDs; stage replacement deliveries; verify overlap and store matching; and only permit an old-provider takedown after every expected release and recording has immutable continuity evidence. A mismatch, rights problem, Content ID conflict, or failed track link must stop the cutover. This cutover is not enabled until provider execution and production continuity proof exist.</p>

    <h2>Where the publishing product stands</h2>
    <p><strong>Available in the product:</strong> durable original masters, projects, private collaborator connections, immutable file sharing and review, editable ordered multi-recording release drafts built from one verified master per track, artwork, identifiers, territories, per-track credits, sealed rights declarations, independent rights review, readiness checks, public artist profiles, and eligible public release pages.</p>
    <p><strong>Still required for Self-Production external distribution (DistroKid-class outlet):</strong> a contracted DSP delivery provider, provider callbacks and corrections, store takedowns, royalty-statement ingestion and reconciliation, collaborator split agreements, tax/KYC and payouts, true destination pre-saves, and production-proven catalog transfer. Until those systems exist, Sway keeps delivery and cutover fail-closed. Those gaps do not make Live Rooms unfinished.</p>

    <h2>Money, ownership, and control</h2>
    <div class="card-grid">
      <article class="card"><h3>Payments follow evidence</h3><p>Requests, tips, and boosts use idempotent backend actions and processor-confirmed states. Sway distinguishes authorization, capture, release, refund, failure, and payout readiness.</p></article>
      <article class="card"><h3>Creators keep their rights</h3><p>Uploading work or preparing a release draft in Sway does not transfer a creator’s master or composition ownership to Sway. Collaborator terms and splits must be explicit, attributable, and accepted by the actual parties.</p></article>
      <article class="card"><h3>Performers control the room</h3><p>Money does not buy approval authority. Paid boosts only apply to already-approved visible items, and moderation can block abusive or unsafe submissions.</p></article>
      <article class="card"><h3>No false success</h3><p>Sway is designed to fail closed: no payment success before confirmation, no delivery success before provider evidence, no payout promise before identity and payout onboarding, and no catalog cutover on incomplete proof.</p></article>
    </div>

    <h2>What Sway is not</h2>
    <ul>
      <li>It is not a jukebox and does not take over the performer’s creative decisions.</li>
      <li>It is not a guarantee that a paid request will be performed.</li>
      <li>It is not a public dump of private Catalog files.</li>
      <li>It is not a claim on creator copyrights.</li>
      <li>It is not a “submitted means live” distributor or a “deployed means working” product.</li>
    </ul>

    <h2>Start where you are</h2>
    <p>Fans can join a room immediately. Creators can use the same account as a fan, then activate Pro Mode when they are ready to build a profile, run rooms, manage Catalog, and publish.</p>
    <div class="primary-actions">
      <a href="/home">Scan or join a room</a>
      <a href="/account/signup">Create a Sway account</a>
      <a href="/account/login">Log in</a>
    </div>
  `,
  'Sway to play'
);

// Keep the long-standing FAQ URL working while the landing-page explainer
// moves to its truthful name. Both routes intentionally render one canonical
// product explanation so old QR codes and bookmarks do not rot.
const faqPageHtml = aboutPageHtml;

const privacyPageHtml = renderStaticDocument(
  'Sway Privacy Policy',
  'What Sway stores for accounts, public profiles, live rooms, private Catalog work, release preparation, payments, safety, and support.',
  `
    <p>Sway processes account and public-profile data, live-room activity, private Catalog and collaboration records, release-draft and rights-review records, payment-related records, moderation records, and support or deletion requests so the service can run, protect access, and maintain an auditable history.</p>
    <h2>Data Sway may store</h2>
    <ul>
      <li>account, login, Pro Mode, performer-profile, booking, social-link, and public-page records</li>
      <li>live-room session, queue, request, tip, and boost records</li>
      <li>original master and supporting-file bytes, filenames, media types, byte counts, checksums, storage locations, versions, integrity results, and project ownership records</li>
      <li>project membership, collaborator connections, selected-file access grants, comments, timecodes, change requests, approvals, revocations, and related audit events</li>
      <li>release-draft metadata, artwork references, UPCs, ISRCs, territories, recording credits, rights documents, declarations, review decisions, and readiness results</li>
      <li>content a performer chooses to publish on a public performer profile or an eligible public release page</li>
      <li>payment processor identifiers and related lifecycle status</li>
      <li>native ticket offer, order, price-and-terms snapshot, admission, refund, performer-transfer, and reconciliation records when native ticket sales are enabled</li>
      <li>moderation reports, blocks, and audit events</li>
      <li>support and data deletion request metadata</li>
      <li>limited device, route, and friction telemetry needed to keep the service working</li>
    </ul>
    <h2>Private work and public pages</h2>
    <p>Uploading a file does not make a private Catalog file public. Project files and release drafts are available to the owner and to collaborators or reviewers who receive applicable access. A grant can be revoked for future access, but revocation cannot retrieve a copy someone already downloaded or erase audit evidence that Sway must retain. Performer-profile fields and eligible release information that a performer deliberately publishes can be viewed by anyone with the public page.</p>
    <h2>Third-party services</h2>
    <p>Sway may rely on payment, email, hosting, object-storage, and database providers when configured. Those providers may process information required to deliver the service. Provider-backed music delivery, royalty processing, collaborator payouts, pre-saves, and catalog cutover are not live; this policy does not imply that Sway currently sends a release to stores or a replacement distributor.</p>
    <h2>Deletion requests</h2>
    <p>Use <a href="/privacy/data-deletion">the data deletion page</a> or submit the API request path from inside the app. Sway may retain records that must be preserved for payments, fraud prevention, disputes, collaborator access history, rights evidence, moderation, legal obligations, or audit history. Creators should keep their own source-file backups; a deletion request and any required retention will be evaluated against the account, project, access, and legal records involved.</p>
  `
);

const termsPageHtml = renderStaticDocument(
  'Sway Terms',
  'Core rules for accounts, public pages, live rooms, private Catalog work, release drafts, payments, and platform use.',
  `
    <p>Sway connects a performer’s public page, live-event request and support room, private Catalog and collaborator work, and release preparation in one account. The current publishing runtime assembles ordered single, EP, and album drafts from verified masters. It does not yet provide provider-backed store delivery, royalty accounting, collaborator splits or payouts, true destination pre-saves, or distributor cutover.</p>
    <h2>Accounts and public pages</h2>
    <ul>
      <li>account holders must provide accurate information, protect their login, and may not impersonate another person or publish content they are not authorized to use</li>
      <li>performers control which profile and eligible release information they publish; public-page content can be viewed and shared by anyone</li>
      <li>Sway may restrict content or accounts used for fraud, infringement, harassment, abuse, or attempts to bypass access and safety controls</li>
    </ul>
    <h2>Live-room rules</h2>
    <ul>
      <li>a paid request is a paid submission for performer review, not a guaranteed performance</li>
      <li>performers control queue order, approval, denial, and fulfillment decisions</li>
      <li>tips and support payments may be voluntary even when no song is approved</li>
      <li>abuse, fraud, harassment, and attempts to bypass safety controls may result in blocks or account action</li>
    </ul>
    <h2>Catalog and collaborator rules</h2>
    <ul>
      <li>creators retain their ownership; uploading a master, supporting file, artwork, or rights document does not transfer copyright ownership to Sway</li>
      <li>an uploader must have authority to store the material and to grant each collaborator or reviewer the access they select</li>
      <li>granting access authorizes Sway to make the selected project or file available under that grant; revocation blocks future access but cannot retrieve copies already downloaded</li>
      <li>integrity checks and version records help preserve evidence, but creators remain responsible for maintaining their own source-file backups</li>
    </ul>
    <h2>Release drafts and rights</h2>
    <p>Each recording in a release draft is bound to its own verified master, metadata, credits, and track order. Track-specific master and composition control must be independently verified for every recording; artwork control and distribution authorization apply to the release as a whole. Sample clearance, third-party beat licenses, cover licenses, performer consent, and AI disclosure are conditional evidence that creators must provide when their work requires it. Track structure locks when rights review begins. A Sway declaration, reviewer decision, readiness result, or public release page is recordkeeping—not legal advice, a guarantee of ownership, or proof that a store accepted a release.</p>
    <h2>Distribution limits</h2>
    <p>Provider-backed delivery, store callbacks and corrections, royalties, splits, payouts, destination pre-saves, takedowns, and catalog cutover are not live. A draft marked ready or shown on a public page has not thereby been submitted, accepted, distributed, streamed, monetized, or migrated. Separate provider terms and disclosures will be required before Sway can transmit releases or money through those systems.</p>
    <h2>Money terms</h2>
    <p>Payment, refund, payout, and native ticket behavior must match the live backend and processor state exactly. See the dedicated payment, payout, and ticket terms below for the current operating rules.</p>
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

const ticketTermsPageHtml = renderStaticDocument(
  'Sway Native Ticket Terms',
  'How native general-admission prices, payment holds, admission, performer transfers, cancellation, and refunds work when ticket sales are enabled.',
  `
    <p><strong>Current terms version:</strong> <code>${escapeStaticDocumentText(NATIVE_TICKET_TERMS_VERSION)}</code></p>
    <p><strong>Buyer terms SHA-256:</strong> <code>${escapeStaticDocumentText(NATIVE_TICKET_BUYER_TERMS_HASH)}</code><br />
    <strong>Seller terms SHA-256:</strong> <code>${escapeStaticDocumentText(NATIVE_TICKET_SELLER_TERMS_HASH)}</code></p>
    <p><strong>Native Sway ticket sales are available only when the production ticket gate is enabled.</strong> An external event link is not a Sway ticket sale.</p>
    <h2>Exact buyer terms</h2>
    <div class="plain-language">${renderExactTicketTerms(NATIVE_TICKET_BUYER_TERMS_TEXT)}</div>
    <h2>Exact performer-seller terms</h2>
    <div class="plain-language">${renderExactTicketTerms(NATIVE_TICKET_SELLER_TERMS_TEXT)}</div>
    <p>The version and hashes above identify the exact text shown here. Each native order and offer stores its accepted text, version, and hash as an immutable snapshot.</p>
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

app.use('/admin/discovery-observatory', async (req, res, next) => {
  const adminAccess = await accessControl.requireAdminAccess(req);
  if (adminAccess.allowed === false) {
    res.status(adminAccess.status).send(adminAccess.reason);
    return;
  }
  applyNoStoreHeaders(res);
  next();
});

app.use('/admin/release-reports', async (req, res, next) => {
  const adminAccess = await accessControl.requireAdminAccess(req);
  if (adminAccess.allowed === false) {
    res.status(adminAccess.status).send(adminAccess.reason);
    return;
  }
  applyNoStoreHeaders(res);
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
    startedAt: null,
    autoCloseoutAt: null,
    closedAt: null,
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
    tipsEnabled: false,
    settlementMode: 'unavailable',
    paymentEnvironment: 'unavailable',
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
  request: RequestItem;
  boost: BoostContribution;
  roomState: BackendState;
  gigId: string;
  receipt: string;
  reconciled?: boolean;
}) {
  return {
    success: true,
    ...(input.reconciled ? { reconciled: true } : {}),
    state: projectPublicRoomState(input.roomState, input.gigId),
    patron_status: projectPatronBoostStatus(input.boost, input.request),
    patron_status_receipt: input.receipt
  };
}

async function loadPatronPaymentEvidence(input: {
  gigId: string;
  requestId?: string | null;
  requestBoostId?: string | null;
  paymentId?: string | null;
}) {
  if (!businessDb) return undefined;
  const actionCondition = input.requestId
    ? eq(payments.requestId, input.requestId)
    : input.requestBoostId
      ? eq(payments.requestBoostId, input.requestBoostId)
      : null;
  if (!actionCondition) return undefined;

  const paymentCandidates = await businessDb
    .select({
      id: payments.id,
      paymentStatus: payments.paymentStatus,
      refundStatus: payments.refundStatus
    })
    .from(payments)
    .where(and(
      eq(payments.gigId, input.gigId),
      actionCondition,
      ...(input.paymentId ? [eq(payments.id, input.paymentId)] : [])
    ))
    .limit(input.paymentId ? 1 : 2);
  return selectPatronPaymentEvidence({
    runtimePaymentId: input.paymentId,
    candidates: paymentCandidates
  });
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
  if (skipStartupBusinessStateHydration) {
    console.warn('[sway.startup] skipping live-room state hydration for a non-production HTTP proof.');
  } else {
    await refreshBusinessState();
  }

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

const PATRON_DEVICE_ID_HASH_PATTERN = /^[0-9a-f]{64}$/;

function normalizePatronDeviceIdHash(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return PATRON_DEVICE_ID_HASH_PATTERN.test(normalized) ? normalized : null;
}

function resolvePatronDeviceIdHash(req: express.Request, bodyValue: unknown): string | null {
  const actor = accessControl.resolveServerActor(req);
  return normalizePatronDeviceIdHash(actor.patronDeviceIdHash)
    ?? normalizePatronDeviceIdHash(bodyValue);
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
        profile_metadata: performerPublicProfiles.metadata,
        specialties: performerPublicProfiles.specialties,
        preview_metadata: performerProfilePreviews.metadata,
        preview_specialties: performerProfilePreviews.specialties,
        owner_user_id: performers.ownerUserId,
        email_verified_at: users.emailVerifiedAt,
        charges_enabled: performers.chargesEnabled,
        payouts_enabled: performers.payoutsEnabled,
        stripe_connected_account_id: performers.stripeConnectedAccountId,
        performer_is_active: performers.isActive,
        onboarding_status: performers.onboardingStatus,
        payment_account_status: performers.paymentAccountStatus,
        kyc_status: performers.kycStatus,
        payout_hold_reason: performers.payoutHoldReason
      })
      .from(performers)
      .innerJoin(users, eq(users.id, performers.ownerUserId))
      .leftJoin(performerPublicProfiles, eq(performerPublicProfiles.performerId, performers.id))
      .leftJoin(performerProfilePreviews, eq(performerProfilePreviews.claimedPerformerId, performers.id))
      .where(eq(performers.ownerUserId, actor.actorId))
      .limit(1);

    if (!performerRow) return null;
    const profileStageName = performerRow.profile_metadata && typeof performerRow.profile_metadata === 'object'
      ? normalizePublicProfileText((performerRow.profile_metadata as Record<string, unknown>).stageName, 80)
      : null;
    const previewStageName = performerRow.preview_metadata && typeof performerRow.preview_metadata === 'object'
      ? normalizePublicProfileText((performerRow.preview_metadata as Record<string, unknown>).stageName, 80)
      : null;
    return {
      performer_id: performerRow.performer_id,
      display_name: performerRow.display_name,
      handle: performerRow.handle,
      stage_name: profileStageName || previewStageName,
      primary_role: resolvePublicPrimaryRole(performerRow.profile_metadata)
        || resolvePublicPrimaryRole(performerRow.preview_metadata),
      specialties: performerRow.specialties?.length
        ? performerRow.specialties
        : performerRow.preview_specialties ?? [],
      owner_user_id: performerRow.owner_user_id,
      email_verified_at: performerRow.email_verified_at,
      charges_enabled: performerRow.charges_enabled,
      payouts_enabled: performerRow.payouts_enabled,
      stripe_connected_account_id: performerRow.stripe_connected_account_id,
      money_actions_ready: Boolean(
        performerRow.performer_is_active
        && performerRow.onboarding_status !== 'suspended'
        && performerRow.payment_account_status === 'payouts_enabled'
        && ['not_required', 'verified'].includes(performerRow.kyc_status)
        && performerRow.charges_enabled
        && performerRow.payouts_enabled
        && performerRow.stripe_connected_account_id?.trim()
        && !performerRow.payout_hold_reason
      ),
      test_mode_platform_balance_allowed: isTestModePlatformBalancePerformerAllowed(
        performerRow.performer_id,
        testModePlatformBalancePerformerIds
      )
    };
  } catch (error) {
    console.warn('Unable to resolve authenticated performer profile for /api/state.', {
      actorUserId: actor.actorId,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

async function resolveProtectedMutationActor(
  req: express.Request,
  res: express.Response,
  gigId?: string | null,
  options: { allowControlBridge?: boolean } = {}
): Promise<ProtectedMutationActor | null> {
  if (!requirePersistentBusinessStore(res)) {
    return null;
  }

  if (gigId) {
    const result = await accessControl.requireGigMutationAccess(req, gigId, options);
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
  if (!businessDb) return null;
  const [persistedTalent] = await businessDb
    .select({ actorId: users.id, role: users.role })
    .from(users)
    .leftJoin(performers, eq(performers.ownerUserId, users.id))
    .leftJoin(performerMemberships, eq(performerMemberships.userId, users.id))
    .leftJoin(gigAccessGrants, eq(gigAccessGrants.userId, users.id))
    .where(and(
      eq(users.id, actorUserId),
      or(
        isNotNull(performers.id),
        isNotNull(performerMemberships.id),
        isNotNull(gigAccessGrants.id)
      )
    ))
    .limit(1);
  if (!persistedTalent) return null;

  return {
    actorId: persistedTalent.actorId,
    actorType: persistedTalent.role ?? 'performer'
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
      bio: performers.bio,
      visibilityState: performers.visibilityState,
      stripeAccountId: performers.stripeConnectedAccountId
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

function toOwnedEventResponse(event: PerformerEventDto) {
  return {
    ...event,
    eventPath: event.status === 'published' || event.status === 'cancelled'
      ? `/e/${event.id}`
      : null
  };
}

async function toOwnedEventResponseWithTicket(
  event: PerformerEventDto,
  owner: PerformerEventOwnerContext
) {
  if (event.ticketingMode !== 'native_ga' || !eventTicketService) {
    return {
      ...toOwnedEventResponse(event),
      ticketOffer: null,
      nativeTicket: null
    };
  }

  const [offer, publicProjection] = await Promise.all([
    eventTicketService.getOwnerTicketOffer({
      eventId: event.id,
      performerId: owner.performerId,
      actorUserId: owner.actorUserId
    }),
    eventTicketService.getPublicOfferProjection({ eventId: event.id })
  ]);
  const ticketOffer = offer
    ? {
        ...offer,
        unitAllInPriceCents: offer.advertisedTotalCents,
        remainingCount: publicProjection?.remainingCount ?? offer.capacity,
        salesStatus: publicProjection?.salesStatus
          ?? (offer.status === 'draft' ? 'scheduled' : offer.status)
      }
    : null;

  return {
    ...toOwnedEventResponse(event),
    ticketOffer,
    nativeTicket: ticketOffer
  };
}

function toPublicEventResponse(event: PublicPerformerEventDto) {
  const externalTicketIsOpen = event.status === 'published'
    && Boolean(event.externalTicketUrl)
    && new Date(event.startsAt).getTime() > Date.now();
  return {
    id: event.id,
    title: event.title,
    description: event.description,
    startsAt: event.startsAt,
    doorOpensAt: event.doorOpensAt,
    endsAt: event.endsAt,
    timeZone: event.timeZone,
    location: {
      name: event.locationName,
      address: event.locationIsTba ? null : event.locationAddress,
      city: event.city,
      isTba: event.locationIsTba
    },
    coverImageUrl: event.coverImageUrl,
    ticketingMode: event.ticketingMode,
    externalTicket: externalTicketIsOpen && event.externalTicketUrl
      ? {
          url: event.externalTicketUrl,
          label: isPublicEventExternalTicketLabel(event.externalTicketLabel)
            ? event.externalTicketLabel
            : 'Get tickets'
        }
      : null,
    status: event.status,
    visibility: event.visibility,
    publishedAt: event.publishedAt,
    cancelledAt: event.cancelledAt,
    cancellationReason: event.cancellationReason,
    eventPath: `/e/${event.id}`,
    performer: {
      displayName: event.performer.displayName,
      handle: event.performer.handle,
      performerPath: event.performer.handle ? `/p/${event.performer.handle}` : null,
      avatarUrl: normalizePublicProfileUrl(event.performer.avatarUrl),
      headline: event.performer.headline,
      city: event.performer.city
    }
  };
}

async function toPublicEventResponseWithTicket(event: PublicPerformerEventDto) {
  const nativeTicket = event.ticketingMode === 'native_ga' && eventTicketService
    ? await eventTicketService.getPublicOfferProjection({ eventId: event.id })
    : null;
  return {
    ...toPublicEventResponse(event),
    nativeTicket
  };
}

function respondToEventServiceError(res: express.Response, error: unknown, fallback: string) {
  if (error instanceof EventServiceError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  console.error(fallback, error);
  return res.status(500).json({ error: fallback });
}

function respondToEventTicketServiceError(
  res: express.Response,
  error: unknown,
  fallback: string
) {
  if (error instanceof EventTicketServiceError) {
    return res.status(error.status).json({
      error: error.message,
      code: error.code,
      retryable: error.retryable
    });
  }
  console.error(fallback, error);
  return res.status(500).json({ error: fallback });
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
  return metadataStageName;
}

function resolvePublicPrimaryRole(metadata: unknown) {
  if (!metadata || typeof metadata !== 'object') return null;
  return normalizePublicProfilePrimaryRole((metadata as Record<string, unknown>).primaryRole);
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

async function loadRequestableCatalogTracks(executor: any, input: {
  performerId: string;
  query?: string;
  limit?: number;
}) {
  const query = normalizeLibraryText(input.query, 160).toLowerCase();
  const likeQuery = `%${query}%`;
  const filters = [
    eq(audioProjects.performerId, input.performerId),
    eq(audioProjects.status, 'active'),
    eq(audioAssets.status, 'active'),
    inArray(audioAssets.assetKind, ['master_audio', 'mix', 'other']),
    sql`${audioAssets.metadata}->>'requestable' = 'true'`
  ];
  if (query) {
    filters.push(sql`lower(concat_ws(' ', ${audioAssets.title}, ${audioProjects.title}, ${audioProjectAssetVersions.originalFilename})) like ${likeQuery}`);
  }

  const rows = await executor
    .select({
      id: audioProjectAssetVersions.id,
      assetId: audioAssets.id,
      title: audioAssets.title,
      projectTitle: audioProjects.title,
      filename: audioProjectAssetVersions.originalFilename,
      versionNumber: audioProjectAssetVersions.versionNumber,
      durationMs: audioProjectAssetVersions.durationMs,
      createdAt: audioProjectAssetVersions.createdAt
    })
    .from(audioProjectAssetVersions)
    .innerJoin(audioAssets, eq(audioAssets.id, audioProjectAssetVersions.assetId))
    .innerJoin(audioProjects, eq(audioProjects.id, audioProjectAssetVersions.projectId))
    .where(and(...filters))
    .orderBy(desc(audioProjectAssetVersions.versionNumber), desc(audioProjectAssetVersions.createdAt))
    .limit(Math.max(1, Math.min(Number(input.limit) || 100, 250)));

  const seenAssets = new Set<string>();
  return rows.filter((row: { assetId: string }) => {
    if (seenAssets.has(row.assetId)) return false;
    seenAssets.add(row.assetId);
    return true;
  });
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
  if (replay.kind === 'pending') {
    res.status(202).json({ success: false, pending: true });
    return true;
  }
  return false;
}

type ModerationMutationAction = 'block' | 'block_revoke';

function moderationMutationKeyHash(input: { actorId: string; actionType: ModerationMutationAction; idempotencyKey: string }) {
  return createHash('sha256')
    .update(`${input.actorId}:${input.actionType}:${input.idempotencyKey}`)
    .digest('hex');
}

async function executeModerationMutation(input: {
  actorId: string;
  actionType: ModerationMutationAction;
  idempotencyKey: string;
  intent: Record<string, unknown>;
  mutate: (tx: any) => Promise<{ status: number; body: Record<string, unknown> }>;
}) {
  if (!businessDb) throw new Error('moderation_mutation_store_unavailable');
  const keyHash = moderationMutationKeyHash(input);
  const intentFingerprint = hashPayload(input.intent);

  return businessDb.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(moderationMutationKeys)
      .values({
        keyHash,
        actorUserId: input.actorId,
        actionType: input.actionType,
        intentFingerprint
      })
      .onConflictDoNothing()
      .returning({ id: moderationMutationKeys.id });

    const [keyRecord] = await tx
      .select({
        intentFingerprint: moderationMutationKeys.intentFingerprint,
        firstResponseStatus: moderationMutationKeys.firstResponseStatus,
        firstResponseBody: moderationMutationKeys.firstResponseBody
      })
      .from(moderationMutationKeys)
      .where(eq(moderationMutationKeys.keyHash, keyHash))
      .for('update')
      .limit(1);

    if (!keyRecord) throw new Error('moderation_mutation_key_missing');
    if (keyRecord.intentFingerprint !== intentFingerprint) {
      return { status: 409, body: { error: 'idempotency misuse: the same key was submitted with a different moderation intent.' } };
    }
    if (!inserted && keyRecord.firstResponseStatus && keyRecord.firstResponseBody) {
      return { status: keyRecord.firstResponseStatus, body: keyRecord.firstResponseBody as Record<string, unknown> };
    }

    const response = await input.mutate(tx);
    await tx
      .update(moderationMutationKeys)
      .set({
        firstResponseStatus: response.status,
        firstResponseBody: response.body,
        updatedAt: new Date()
      })
      .where(eq(moderationMutationKeys.keyHash, keyHash));
    return response;
  });
}

type RoomMutationContext = { gigId: string; state: BackendState };
type RequestMutationContext = RoomMutationContext & { request: RequestItem };

function isTerminalPaymentReversal(result: SettleResult) {
  return ['noop', 'voided', 'refunded'].includes(result.status);
}

async function sendCanonicalPatronActionFailure(input: {
  res: express.Response;
  clientRequestId: string;
  idempotencyKey: string;
  gigId: string;
  actionType: 'request' | 'tip' | 'boost';
  status: number;
  body: Record<string, unknown>;
  owner?: PendingActionOwner | null;
}) {
  const terminalBody = {
    ...input.body,
    success: false,
    pending: false,
    terminal: true
  };
  try {
    const completion = await idempotencyStore.completePendingActionFailure({
      clientRequestId: input.clientRequestId,
      idempotencyKey: input.idempotencyKey,
      gigId: input.gigId,
      actionType: input.actionType,
      status: input.status,
      body: terminalBody,
      ...(input.owner ? { owner: input.owner } : {})
    });
    return input.res
      .status(completion.status)
      .json(sanitizePatronMutationResponseBody(completion.body));
  } catch (error) {
    if (error instanceof Error && ['pending_action_already_visible', 'pending_action_owner_fenced'].includes(error.message)) {
      // Visibility won the race. Never overwrite it with a failure; the
      // reconciliation endpoint will mint/replay the canonical success.
      return input.res.status(202).json({
        success: false,
        pending: true,
        payment_status: 'processing'
      });
    }
    throw error;
  }
}

function applyPaymentReversalTruth(
  request: RequestItem,
  reversals: PaymentReversalResult[]
) {
  const resultByPaymentId = new Map(
    reversals.map(({ paymentId, result }) => [paymentId, result])
  );
  const pendingPaymentIds: string[] = [];

  const applyStatus = (paymentId: string | null | undefined) => {
    if (!paymentId) return null;
    const result = resultByPaymentId.get(paymentId);
    const terminal = Boolean(result && isTerminalPaymentReversal(result));
    if (!terminal) pendingPaymentIds.push(paymentId);
    return terminal ? 'voided_or_refunded' : 'reversal_pending';
  };

  const requestPaymentStatus = applyStatus(request.paymentId);
  if (requestPaymentStatus) request.paymentStatus = requestPaymentStatus;
  for (const boost of request.boosts) {
    const boostPaymentStatus = applyStatus(boost.paymentId);
    if (boostPaymentStatus) boost.paymentStatus = boostPaymentStatus;
  }

  return [...new Set(pendingPaymentIds)];
}

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

  // Commit the performer's decision before any irreversible processor call.
  // A crash after this point is recoverable by the payment reconciler; a CAS
  // conflict before it guarantees Stripe has not been touched.
  recalculateTotals(roomState);
  await persistStateWithAudit({
    roomState,
    gigId: roomContext.gigId,
    actor,
    entityType: 'request',
    entityId: request.id,
    eventType: `request.triage.${action}.financial_intent`,
    previousStatus,
    nextStatus: request.status,
    metadata: { requestId: request.id, recoveryRequired: true }
  });

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
          continue;
        }
        if (capture.status !== 'captured') {
          const reversals = await paymentService.voidOrRefundMany(paymentIds);
          const pendingPaymentIds = applyPaymentReversalTruth(request, reversals);
          request.status = 'denied';
          recalculateTotals(roomState);
          await persistStateWithAudit({
            roomState,
            gigId: roomContext.gigId,
            actor,
            entityType: 'request',
            entityId: request.id,
            eventType: 'request.triage.approve_payment_failed',
            previousStatus,
            nextStatus: request.status,
            metadata: {
              requestId: request.id,
              paymentId,
              captureStatus: capture.status,
              pendingPaymentIds
            }
          });
          return {
            request,
            state: prepareRoomState(roomState, roomContext.gigId),
            paymentError: pendingPaymentIds.length
              ? 'Payment could not be captured. The request was denied, but its payment reversal is still processing.'
              : 'Payment could not be captured. The request was denied and its hold was released.'
          };
        }
      }
    } else {
      const reversals = await paymentService.voidOrRefundMany(paymentIds);
      applyPaymentReversalTruth(request, reversals);
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

  recalculateTotals(roomState);
  await persistStateWithAudit({
    roomState,
    gigId: roomContext.gigId,
    actor,
    entityType: 'request',
    entityId: request.id,
    eventType: 'request.fulfill.financial_intent',
    previousStatus,
    nextStatus: request.status,
    metadata: { requestId: request.id, recoveryRequired: true }
  });

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

  await persistStateWithAudit({
    roomState,
    gigId: roomContext.gigId,
    actor,
    entityType: 'request',
    entityId: request.id,
    eventType: 'moderation.hide.financial_intent',
    previousStatus,
    nextStatus: 'hidden',
    metadata: { requestId: request.id, reason, recoveryRequired: true }
  });

  if (paymentService.isEnabled()) {
    const paymentIds = [
      request.paymentId,
      ...request.boosts.map((boost) => boost.paymentId)
    ].filter((id): id is string => Boolean(id));
    if (paymentIds.length) {
      const reversals = await paymentService.voidOrRefundMany(paymentIds);
      applyPaymentReversalTruth(request, reversals);
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
  try {
  if (!liveRoomDurabilityWritesEnabled) return;
  if (!businessStore.hasDurableStore) {
    await refreshBusinessState();

    let changed = false;

    if (state.session.status === 'ending' && state.session.endGigTimerStartedAt) {
      const startTimeStamp = new Date(state.session.endGigTimerStartedAt).getTime();
      const elapsedTime = Date.now() - startTimeStamp;

      if (elapsedTime >= 300000) {
        console.log("Post-gig timer expired. Releasing pending requests.");
        await settleRoomCloseout(state, state.activeGigId || 'development-room');
        changed = true;
      }
    }

    if (state.session.status === 'active' && state.session.autoCloseoutAt && Date.now() >= new Date(state.session.autoCloseoutAt).getTime()) {
      console.log('Room reached its automatic closeout deadline.');
      await settleRoomCloseout(state, state.activeGigId || 'development-room');
      changed = true;
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
    try {
    const roomSnapshot = await loadRoomState(trackedGigId);
    const roomState = roomSnapshot.state;
    let changed = false;
    let closeoutReason: 'post_gig_timer' | 'maximum_room_duration' | null = null;
    let closeoutPendingPaymentIds: string[] = [];

    if (roomState.session.status === 'ending' && roomState.session.endGigTimerStartedAt) {
      const startTimeStamp = new Date(roomState.session.endGigTimerStartedAt).getTime();
      const elapsedTime = Date.now() - startTimeStamp;

      if (elapsedTime >= 300000) {
        console.log("Post-gig timer expired. Releasing pending requests.");
        const closeout = await settleRoomCloseout(roomState, trackedGigId);
        changed = true;
        if (closeout.status === 'complete') {
          closeoutReason = 'post_gig_timer';
        } else {
          closeoutPendingPaymentIds = closeout.pendingPaymentIds;
        }
      }
    }

    if (roomState.session.status === 'active' && roomState.session.autoCloseoutAt && Date.now() >= new Date(roomState.session.autoCloseoutAt).getTime()) {
      console.log('Room reached its automatic closeout deadline.');
      const closeout = await settleRoomCloseout(roomState, trackedGigId);
      changed = true;
      if (closeout.status === 'complete') {
        closeoutReason = 'maximum_room_duration';
      } else {
        closeoutPendingPaymentIds = closeout.pendingPaymentIds;
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
      if (closeoutReason) {
        await persistStateWithAudit({
          roomState,
          gigId: trackedGigId,
          actor: { actorId: roomState.session.ownerActorUserId || '00000000-0000-4000-8000-000000000111', actorType: 'system' },
          entityType: 'gig_session',
          entityId: trackedGigId,
          eventType: 'session.auto_closeout',
          previousStatus: closeoutReason === 'post_gig_timer' ? 'ending' : 'active',
          nextStatus: 'closed',
          metadata: { reason: closeoutReason }
        });
      } else if (closeoutPendingPaymentIds.length) {
        await persistStateWithAudit({
          roomState,
          gigId: trackedGigId,
          actor: { actorId: roomState.session.ownerActorUserId || '00000000-0000-4000-8000-000000000111', actorType: 'system' },
          entityType: 'gig_session',
          entityId: trackedGigId,
          eventType: 'session.closeout_reversal_pending',
          previousStatus: roomState.session.status,
          nextStatus: roomState.session.status,
          metadata: { pendingPaymentIds: closeoutPendingPaymentIds }
        });
      } else {
        await persistBusinessStateForRoom(roomState, trackedGigId);
      }
    }
    } catch (error) {
      // A bad provider response or optimistic-concurrency retry for one room
      // must not starve closeout and safety maintenance for every other room.
      console.error(`Room maintenance failed for ${trackedGigId}; skipping until the next cycle.`, error);
    }
  }

  await refreshBusinessState();
  } catch (error) {
    // Optimistic-concurrency conflicts are retry signals, not process-fatal
    // errors. The next bounded maintenance pass reloads the current room.
    console.error('Room maintenance cycle failed; it will retry safely.', error);
  }
}, 10000); // Check every 10 seconds for tighter precision

type RoomCloseoutResult =
  | { status: 'complete'; totals: CloseoutTotals | null; pendingPaymentIds: [] }
  | { status: 'reversal_pending'; totals: null; pendingPaymentIds: string[] };

async function settleRoomCloseout(inputState: BackendState, gigId: string): Promise<RoomCloseoutResult> {
  if (paymentService.hasDurableStore && UUID_PATTERN.test(gigId)) {
    await paymentService.reconcileActionVisibility({ limit: 100 });
  }
  if (businessStore.hasDurableStore && UUID_PATTERN.test(gigId)) {
    const barrier = await businessStore.beginRoomCloseout(gigId);
    if (!['started', 'already_pending', 'closed'].includes(barrier.status) || !('stateRevision' in barrier)) {
      return {
        status: 'reversal_pending',
        totals: null,
        pendingPaymentIds: [`closeout-barrier:${gigId}`]
      };
    }
    inputState.session.stateRevision = barrier.stateRevision;
    inputState.session.status = 'ending';
    inputState.session.requestsOpen = false;
    inputState.session.endGigTimerStartedAt = inputState.session.endGigTimerStartedAt ?? new Date().toISOString();

    // Reconciliation and the closeout barrier both advance durable revisions.
    // Replace the caller's snapshot in place so the final audited persistence
    // uses those exact revisions instead of turning a normal CAS retry into an
    // unhandled background rejection.
    const refreshed = await loadRoomState(gigId);
    Object.assign(inputState, refreshed.state);
  }
  const unresolved = inputState.requests.filter((request) => request.type === 'request' && request.status !== 'fulfilled');
  const runtimePaymentIds = unresolved.flatMap((request) => [
    request.paymentId,
    ...request.boosts.map((boost) => boost.paymentId)
  ]).filter((paymentId): paymentId is string => Boolean(paymentId));
  const durablePaymentIds = paymentService.hasDurableStore && UUID_PATTERN.test(gigId)
    ? await paymentService.listCloseoutReversalPaymentIds(gigId)
    : [];
  const paymentIds = [...new Set([...runtimePaymentIds, ...durablePaymentIds])];
  const reversals = await paymentService.voidOrRefundMany(paymentIds);
  const pendingPaymentIds = new Set<string>();
  for (const { paymentId, result } of reversals) {
    if (!isTerminalPaymentReversal(result)) pendingPaymentIds.add(paymentId);
  }
  for (const request of unresolved) {
    applyPaymentReversalTruth(request, reversals).forEach((paymentId) => pendingPaymentIds.add(paymentId));
  }
  if (paymentService.hasDurableStore && UUID_PATTERN.test(gigId)) {
    const blockingPaymentIds = await paymentService.listCloseoutBlockingPaymentIds(gigId);
    blockingPaymentIds.forEach((paymentId) => pendingPaymentIds.add(paymentId));
  }

  if (pendingPaymentIds.size) {
    return {
      status: 'reversal_pending',
      totals: null,
      pendingPaymentIds: [...pendingPaymentIds]
    };
  }

  executeAutoNuke(inputState);
  if (paymentService.hasDurableStore && UUID_PATTERN.test(gigId)) {
    const totals = await paymentService.aggregateCapturedTotals(gigId);
    inputState.session.totals.totalTips = totals.capturedSubtotalCents / 100;
    inputState.session.totals.accumulatedFees = totals.platformFeeCents / 100;
    inputState.session.totals.totalCount = totals.capturedCount;
    return { status: 'complete', totals, pendingPaymentIds: [] };
  }
  return { status: 'complete', totals: null, pendingPaymentIds: [] };
}

function executeAutoNuke(inputState: BackendState) {
  inputState.requests = inputState.requests.map(req => {
    if (req.type === 'request' && req.status !== 'fulfilled') {
      return { ...req, status: 'denied' };
    }
    return req;
  });
  inputState.session.status = 'closed';
  inputState.session.endGigTimerStartedAt = null;
  inputState.session.requestsOpen = false;
  inputState.session.closedAt = new Date().toISOString();

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

app.get("/api/release-health", async (_req, res) => {
  applyNoStoreHeaders(res);

  const { statusCode, report } = await evaluateReleaseHealth({
    buildMarker,
    databaseUrl: process.env.DATABASE_URL,
    expectedMigrations: loadExpectedMigrations()
  });

  res.status(statusCode).json(report);
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
    audioStorage: {
      enabled: Boolean(audioObjectStore?.isEnabled),
      provider: audioObjectStore?.provider ?? null,
      objectStorageVerified: audioObjectStoreVerified,
      workingStorageBounded: true,
      workspaceLimitBytes: audioStoragePolicy.workspaceLimitBytes,
      workingObjectLimit: audioStoragePolicy.workingObjectLimit,
      releaseCountLimit: audioStoragePolicy.releaseCountLimit
    },
    liveRoomDurabilityWritesEnabled,
    liveRoomDurabilityKillSwitchActive,
    nodeEnv: process.env.NODE_ENV ?? null,
    commit: buildMarker.commit,
    branch: buildMarker.branch,
    buildTimestamp: buildMarker.buildTimestamp
  });
});

app.get('/api/payment/config', (_req, res) => {
  applyNoStoreHeaders(res);
  if (!liveRoomPaymentRuntimeConfig.moneyEnabled) {
    return res.status(503).json({
      error: liveRoomPaymentRuntimeConfig.reason === 'durability_writes_disabled'
        ? 'Live-room money is temporarily paused by the durability safety switch.'
        : liveRoomPaymentRuntimeConfig.reason === 'mode_key_mismatch'
          ? 'Stripe publishable and secret keys must both be test or both be live.'
          : 'Stripe payment execution is not fully configured.',
      mode: liveRoomPaymentRuntimeConfig.mode,
      liveRoomMoneyEnabled: false,
      testModePlatformBalanceEnabled: false
    });
  }

  return res.json({
    publishableKey: liveRoomPaymentRuntimeConfig.publishableKey,
    mode: liveRoomPaymentRuntimeConfig.mode,
    liveRoomMoneyEnabled: true,
    testModePlatformBalanceEnabled
  });
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
    return res.status(200).json({ success: true, redirectPath: '/account' });
  } catch (error) {
    console.warn('Performer invitation acceptance failed.', {
      path: req.path,
      ip: req.ip || null,
      reason: error instanceof Error ? error.message : String(error)
    });
    return res.status(500).json({ error: 'Unable to finish performer setup right now.' });
  }
});

app.post('/api/talent/claim/peek', async (req, res) => {
  applyNoStoreHeaders(res);

  if (!businessDb || !performerLoginChallengeStore.hasDurableStore) {
    return res.status(503).json({ error: 'Performer claim lookup is temporarily unavailable.' });
  }

  const token = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  const requesterIpHash = hashPerformerLoginRequesterIp(req.ip || null);
  const rateLimitResult = performerClaimPeekRateLimiter.consume({
    requesterIpHash,
    targetEmail: '__talent_claim_peek__'
  });

  if (!rateLimitResult.allowed) {
    return res.status(429).json({ error: 'Too many lookups. Please slow down.' });
  }
  if (!token) {
    return res.status(422).json({ error: 'A code is required.' });
  }

  const claim = await performerLoginChallengeStore.peekChallengeByToken({
    token,
    expectedChallengeType: PERFORMER_LOGIN_CHALLENGE_TYPE_CLAIM_CODE
  });

  const metadata = claim?.challengeMetadata && typeof claim.challengeMetadata === 'object'
    ? claim.challengeMetadata as Record<string, unknown>
    : {};
  const performerId = typeof metadata.performerId === 'string' && UUID_PATTERN.test(metadata.performerId)
    ? metadata.performerId
    : null;

  if (!claim || !performerId) {
    return res.status(404).json({ error: 'This code is invalid, expired, or already used.' });
  }

  const [performer] = await businessDb
    .select({ handle: performers.handle, displayName: performers.displayName })
    .from(performers)
    .where(eq(performers.id, performerId))
    .limit(1);

  if (!performer) {
    return res.status(404).json({ error: 'This code is invalid, expired, or already used.' });
  }

  res.status(200).json({
    handle: performer.handle,
    displayName: performer.displayName
  });
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
  // Phone is optional on claim — code handoff should bypass onboarding fields.
  if (req.body?.phone != null && String(req.body.phone).trim() && !normalizedPhone) {
    return res.status(422).json({ error: 'Phone number format is invalid.' });
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
      if (!performerId) {
        const err = new Error('claim_redeem_failed');
        (err as Error & { claimCode?: string }).claimCode = 'not_recognized';
        throw err;
      }

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

      if (!account) {
        const err = new Error('claim_redeem_failed');
        (err as Error & { claimCode?: string }).claimCode = 'profile_already_claimed';
        throw err;
      }

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

      if (!updatedUser) {
        const err = new Error('claim_redeem_failed');
        (err as Error & { claimCode?: string }).claimCode = 'unavailable';
        throw err;
      }

      const claimable = await assertPerformerClaimableByHandoff(tx, {
        performerId: account.performerId,
        handoffUserId: account.userId
      });
      if (claimable.ok === false) {
        const err = new Error('claim_redeem_failed');
        (err as Error & { claimCode?: string }).claimCode = claimable.code;
        throw err;
      }

      const proMode = await activateClaimedPerformerAndProMode(tx, {
        userId: account.userId,
        performerId: account.performerId,
        completedAt,
        reason: 'performer_claim_redeem'
      });

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
          wasHandoff,
          proModeActivated: proMode.proModeActivated,
          claimCodeFingerprint: claimCodeFingerprint(token)
        }
      });

      return { issuedSession, performerId: account.performerId };
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
    const claimFailCode = error && typeof error === 'object' && 'claimCode' in error
      ? String((error as { claimCode?: string }).claimCode || '')
      : '';
    if (claimFailCode) {
      const mapped = mapClaimInspectionToClientError(claimFailCode);
      return res.status(mapped.status).json({ error: mapped.error, code: mapped.code });
    }
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
    return res.status(200).json({ success: true, redirectPath: '/account' });
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

  // Performer acquisition is one universal-account flow. Keep the old API
  // terminal and explicit so stale clients cannot create a second account
  // shape or bypass the account -> verification -> Pro Mode sequence.
  return res.status(410).json({
    error: 'Performer signup now uses one Sway account and Pro Mode.',
    code: 'universal_account_required',
    redirectPath: '/account/signup?intent=performer'
  });

  /* c8 ignore start -- retained below only until legacy deployment readers drain */
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
  /* c8 ignore stop */
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
  const rateLimitState = await checkDurablePasswordLoginLimit({
    requesterIpHash,
    accountKey,
    scope: 'account',
    maxFailures: 5
  });

  if (!rateLimitState.allowed) {
    res.status(429).json({ error: 'Too many failed sign-in attempts. Please try again later.' });
    return;
  }

  if (!normalizedEmail || !password) {
    await recordDurablePasswordLoginFailure({
      requesterIpHash,
      accountKey,
      scope: 'account'
    });
    res.status(401).json(performerCredentialFailureResponse());
    return;
  }

  const performerAccount = await loadPerformerPasswordAccountByEmail(businessDb, normalizedEmail);
  if (!performerAccount?.passwordHash) {
    await recordDurablePasswordLoginFailure({
      requesterIpHash,
      accountKey,
      scope: 'account'
    });
    res.status(401).json(performerCredentialFailureResponse());
    return;
  }

  const passwordMatches = await verifyPerformerPassword(password, performerAccount.passwordHash);
  if (!passwordMatches) {
    await recordDurablePasswordLoginFailure({
      requesterIpHash,
      accountKey,
      scope: 'account'
    });
    res.status(401).json(performerCredentialFailureResponse());
    return;
  }
  if (!validatePerformerPasswordStrength(password).ok) {
    res.status(403).json({
      error: 'This password no longer meets Sway security requirements. Reset it to continue.',
      code: 'password_reset_required'
    });
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

  await resetDurablePasswordLoginFailures({
    requesterIpHash,
    accountKey,
    scope: 'account'
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

app.post('/api/account/claim/peek', async (req, res) => {
  applyNoStoreHeaders(res);

  if (!businessDb || !performerLoginChallengeStore.hasDurableStore) {
    const mapped = mapClaimInspectionToClientError('unavailable');
    return res.status(mapped.status).json({ error: mapped.error, code: mapped.code });
  }

  const token = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  const requesterIpHash = hashPerformerLoginRequesterIp(req.ip || null);
  const rateLimitResult = performerClaimPeekRateLimiter.consume({
    requesterIpHash,
    targetEmail: '__account_claim_peek__'
  });

  if (!rateLimitResult.allowed) {
    const mapped = mapClaimInspectionToClientError('rate_limited');
    return res.status(mapped.status).json({ error: mapped.error, code: mapped.code });
  }
  if (!token) {
    const mapped = mapClaimInspectionToClientError('not_found');
    return res.status(mapped.status).json({ error: mapped.error, code: mapped.code });
  }

  try {
    const inspection = await performerLoginChallengeStore.inspectClaimChallengeByToken({ token });
    if (inspection.status !== 'valid') {
      const mapped = mapClaimInspectionToClientError(inspection.status);
      return res.status(mapped.status).json({ error: mapped.error, code: mapped.code });
    }

    const performerId = readClaimPerformerId(inspection.challengeMetadata);
    if (!performerId || !inspection.actorUserId) {
      const mapped = mapClaimInspectionToClientError('not_found');
      return res.status(mapped.status).json({ error: mapped.error, code: mapped.code });
    }

    const [performer] = await businessDb
      .select({
        handle: performers.handle,
        displayName: performers.displayName,
        ownerUserId: performers.ownerUserId,
        onboardingStatus: performers.onboardingStatus
      })
      .from(performers)
      .where(eq(performers.id, performerId))
      .limit(1);

    if (!performer) {
      const mapped = mapClaimInspectionToClientError('not_found');
      return res.status(mapped.status).json({ error: mapped.error, code: mapped.code });
    }
    if (performer.onboardingStatus === 'suspended') {
      const mapped = mapClaimInspectionToClientError('unavailable');
      return res.status(mapped.status).json({ error: mapped.error, code: mapped.code });
    }
    if (performer.ownerUserId !== inspection.actorUserId) {
      const mapped = mapClaimInspectionToClientError('profile_already_claimed');
      return res.status(mapped.status).json({ error: mapped.error, code: mapped.code });
    }

    return res.status(200).json({
      displayName: performer.displayName,
      handle: performer.handle,
      claimType: 'performer_profile',
      enablesProMode: true
    });
  } catch (error) {
    console.warn('Account claim peek failed.', {
      path: req.path,
      ip: req.ip || null,
      reason: error instanceof Error ? error.message : String(error)
    });
    const mapped = mapClaimInspectionToClientError('unavailable');
    return res.status(mapped.status).json({ error: mapped.error, code: mapped.code });
  }
});

app.post('/api/account/claim/attach', async (req, res) => {
  applyNoStoreHeaders(res);

  const access = await accessControl.requireAuthenticatedAccountAccess(req);
  if (access.allowed === false) {
    return res.status(access.status).json({ error: access.reason });
  }
  if (!businessDb || !performerLoginChallengeStore.hasDurableStore) {
    const mapped = mapClaimInspectionToClientError('unavailable');
    return res.status(mapped.status).json({ error: mapped.error, code: mapped.code });
  }

  const token = typeof req.body?.claimCode === 'string' ? req.body.claimCode.trim() : '';
  const requesterIpHash = hashPerformerLoginRequesterIp(req.ip || null);
  const rateLimitResult = performerSignupRateLimiter.consume({
    requesterIpHash,
    targetEmail: '__account_claim_attach__'
  });
  if (!rateLimitResult.allowed) {
    const mapped = mapClaimInspectionToClientError('rate_limited');
    return res.status(mapped.status).json({ error: mapped.error, code: mapped.code });
  }
  if (!token) {
    const mapped = mapClaimInspectionToClientError('not_found');
    return res.status(mapped.status).json({ error: mapped.error, code: mapped.code });
  }

  const currentUserId = access.actor.actorId!;

  try {
    const outcome = await businessDb.transaction(async (tx) => {
      const claim = await performerLoginChallengeStore.consumeChallengeFromToken({
        token,
        expectedChallengeType: PERFORMER_LOGIN_CHALLENGE_TYPE_CLAIM_CODE,
        executor: tx
      });
      if (!claim?.actorUserId) {
        const err = new Error('claim_redeem_failed');
        (err as Error & { claimCode?: string }).claimCode = 'already_used';
        throw err;
      }

      const performerId = readClaimPerformerId(claim.challengeMetadata);
      if (!performerId) {
        const err = new Error('claim_redeem_failed');
        (err as Error & { claimCode?: string }).claimCode = 'not_recognized';
        throw err;
      }

      const transfer = await transferPerformerOwnership(tx, {
        performerId,
        fromUserId: claim.actorUserId,
        toUserId: currentUserId
      });
      if (transfer.ok === false) {
        const err = new Error('claim_redeem_failed');
        (err as Error & { claimCode?: string }).claimCode = transfer.code;
        throw err;
      }

      const completedAt = new Date();
      const [account] = await tx
        .select({ emailVerifiedAt: users.emailVerifiedAt, displayName: users.displayName })
        .from(users)
        .where(eq(users.id, currentUserId))
        .for('update')
        .limit(1);
      if (!account?.emailVerifiedAt) {
        const err = new Error('claim_redeem_failed');
        (err as Error & { claimCode?: string }).claimCode = 'unavailable';
        throw err;
      }

      const [performer] = await tx
        .select({ displayName: performers.displayName, handle: performers.handle })
        .from(performers)
        .where(eq(performers.id, performerId))
        .limit(1);

      const proMode = await activateClaimedPerformerAndProMode(tx, {
        userId: currentUserId,
        performerId,
        completedAt,
        reason: 'account_claim_attach'
      });

      await writeAuditEvent(tx, {
        actorId: currentUserId,
        actorType: 'account',
        entityType: 'performer_login_challenge',
        entityId: claim.id,
        eventType: 'account.claim.attach',
        previousStatus: 'pending',
        nextStatus: 'consumed',
        metadata: {
          performerId,
          handoffUserId: claim.actorUserId,
          proModeActivated: proMode.proModeActivated,
          claimCodeFingerprint: claimCodeFingerprint(token)
        }
      });

      return {
        performerId,
        displayName: performer?.displayName || 'Performer',
        handle: performer?.handle || null
      };
    });

    return res.status(200).json({
      success: true,
      message: 'Profile claimed. Pro Mode is active on this account.',
      performer: {
        id: outcome.performerId,
        displayName: outcome.displayName,
        handle: outcome.handle
      },
      redirectPath: '/talent'
    });
  } catch (error) {
    const claimFailCode = error && typeof error === 'object' && 'claimCode' in error
      ? String((error as { claimCode?: string }).claimCode || '')
      : '';
    if (claimFailCode) {
      const mapped = mapClaimInspectionToClientError(claimFailCode);
      return res.status(mapped.status).json({ error: mapped.error, code: mapped.code });
    }
    console.warn('Account claim attach failed.', {
      path: req.path,
      ip: req.ip || null,
      reason: error instanceof Error ? error.message : String(error)
    });
    return res.status(500).json({ error: 'Unable to claim this profile right now.' });
  }
});

app.post('/api/account/signup', async (req, res) => {
  applyNoStoreHeaders(res);
  if (!businessDb || !performerLoginChallengeStore.hasDurableStore) {
    return res.status(503).json({ error: 'Account signup is temporarily unavailable.' });
  }

  const email = normalizePerformerLoginEmail(req.body?.email);
  const displayName = normalizePerformerDisplayName(req.body?.displayName);
  const password = normalizePerformerPassword(req.body?.password);
  const confirmPassword = normalizePerformerPassword(req.body?.confirmPassword);
  const claimCode = typeof req.body?.claimCode === 'string' ? req.body.claimCode.trim() : '';
  const accountNextPath = normalizeSafeAccountNextPath(req.body?.next);
  if (!email || !displayName || !password) {
    return res.status(422).json({ error: 'Name, email, and password are required.' });
  }
  if (req.body?.termsAccepted !== true) {
    return res.status(422).json({ error: 'Terms acceptance is required.' });
  }
  const passwordValidation = validatePerformerPasswordStrength(password);
  if (!passwordValidation.ok) return res.status(422).json({ error: passwordValidation.error });
  if (password !== confirmPassword) return res.status(422).json({ error: 'Password confirmation does not match.' });

  const requesterIpHash = hashPerformerLoginRequesterIp(req.ip || null);
  const rateLimit = performerSignupRateLimiter.consume({ requesterIpHash, targetEmail: '__account_signup__' });
  if (!rateLimit.allowed) return res.status(429).json({ error: 'Too many signup attempts. Please try again later.' });

  // Claim-code signup: redeem onto the pre-created handoff account (one Sway account).
  if (claimCode) {
    if (!performerSessionStore.hasDurableStore) {
      return res.status(503).json({ error: 'Account signup is temporarily unavailable.' });
    }

    const passwordHash = await hashPerformerPassword(password);
    try {
      const outcome = await businessDb.transaction(async (tx) => {
        const claim = await performerLoginChallengeStore.consumeChallengeFromToken({
          token: claimCode,
          expectedChallengeType: PERFORMER_LOGIN_CHALLENGE_TYPE_CLAIM_CODE,
          executor: tx
        });
        if (!claim?.actorUserId) {
          const err = new Error('claim_redeem_failed');
          (err as Error & { claimCode?: string }).claimCode = 'already_used';
          throw err;
        }

        const performerId = readClaimPerformerId(claim.challengeMetadata);
        if (!performerId) {
          const err = new Error('claim_redeem_failed');
          (err as Error & { claimCode?: string }).claimCode = 'not_recognized';
          throw err;
        }

        const claimable = await assertPerformerClaimableByHandoff(tx, {
          performerId,
          handoffUserId: claim.actorUserId
        });
        if (claimable.ok === false) {
          const err = new Error('claim_redeem_failed');
          (err as Error & { claimCode?: string }).claimCode = claimable.code;
          throw err;
        }

        const [emailOwner] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, email))
          .limit(1);
        if (emailOwner && emailOwner.id !== claim.actorUserId) {
          const err = new Error('claim_redeem_failed');
          (err as Error & { claimCode?: string }).claimCode = 'email_in_use';
          throw err;
        }

        const completedAt = new Date();
        const [updatedUser] = await tx
          .update(users)
          .set({
            email,
            displayName,
            passwordHash,
            emailVerifiedAt: completedAt,
            termsAcceptedAt: completedAt,
            updatedAt: completedAt
          })
          .where(eq(users.id, claim.actorUserId))
          .returning({ id: users.id });
        if (!updatedUser) {
          const err = new Error('claim_redeem_failed');
          (err as Error & { claimCode?: string }).claimCode = 'unavailable';
          throw err;
        }

        await tx
          .update(performers)
          .set({
            displayName,
            updatedAt: completedAt
          })
          .where(eq(performers.id, performerId));

        const proMode = await activateClaimedPerformerAndProMode(tx, {
          userId: claim.actorUserId,
          performerId,
          completedAt,
          reason: 'account_signup_claim_redeem'
        });

        const issuedSession = await performerSessionStore.issueSession({
          actorUserId: claim.actorUserId,
          issuedBy: claim.actorUserId,
          executor: tx
        });

        await writeAuditEvent(tx, {
          actorId: claim.actorUserId,
          actorType: 'account',
          entityType: 'performer_login_challenge',
          entityId: claim.id,
          eventType: 'account.signup.claim',
          previousStatus: 'pending',
          nextStatus: 'consumed',
          metadata: {
            performerId,
            proModeActivated: proMode.proModeActivated,
            claimCodeFingerprint: claimCodeFingerprint(claimCode)
          }
        });

        return {
          issuedSession,
          performerId,
          displayName: claimable.displayName
        };
      });

      res.cookie(performerSessionStore.cookieName, outcome.issuedSession.token, {
        httpOnly: true,
        secure: isProduction,
        sameSite: 'lax',
        path: '/',
        expires: outcome.issuedSession.expiresAt
      });
      return res.status(200).json({
        success: true,
        message: 'Account created. Performer profile claimed and Pro Mode activated.',
        redirectPath: '/talent'
      });
    } catch (error) {
      const claimFailCode = error && typeof error === 'object' && 'claimCode' in error
        ? String((error as { claimCode?: string }).claimCode || '')
        : '';
      if (claimFailCode === 'email_in_use') {
        return res.status(409).json({ error: 'This email is already in use.' });
      }
      if (claimFailCode) {
        const mapped = mapClaimInspectionToClientError(claimFailCode);
        return res.status(mapped.status).json({ error: mapped.error, code: mapped.code });
      }
      console.warn('Account signup with claim failed.', {
        path: req.path,
        ip: req.ip || null,
        reason: error instanceof Error ? error.message : String(error)
      });
      return res.status(500).json({ error: 'Unable to create account with that claim code right now.' });
    }
  }

  if (isProduction && !hasPerformerLoginEmailConfig) {
    return res.status(503).json({ error: 'Account verification email delivery is temporarily unavailable.' });
  }
  if (await performerSignupEmailExists(businessDb, email)) {
    return res.status(409).json({ error: 'This email is already in use.' });
  }

  const passwordHash = await hashPerformerPassword(password);
  const outcome = await businessDb.transaction(async (tx) => {
    const [account] = await tx.insert(users).values({
      email,
      displayName,
      passwordHash,
      termsAcceptedAt: new Date(),
      role: 'patron',
      proModeStatus: 'disabled'
    }).returning({ id: users.id });
    const challenge = await performerLoginChallengeStore.issueChallenge({
      actorUserId: account.id,
      targetEmail: email,
      challengeType: ACCOUNT_LOGIN_CHALLENGE_TYPE_VERIFY_EMAIL,
      requesterIpHash,
      challengeMetadata: accountNextPath ? { accountNextPath } : null,
      executor: tx
    });
    await writeAuditEvent(tx, {
      actorId: account.id,
      actorType: 'account',
      entityType: 'user',
      entityId: account.id,
      eventType: 'account.signup',
      previousStatus: null,
      nextStatus: 'unverified',
      metadata: { proModeStatus: 'disabled' }
    });
    return { accountId: account.id, challengeId: challenge.challengeId, token: challenge.token };
  });

  const baseUrl = resolvePerformerLoginBaseUrl(process.env).replace(/\/+$/, '');
  const verificationLink = `${baseUrl}/api/account/verify-email/consume?token=${encodeURIComponent(outcome.token)}`;
  const delivery = await performerLoginMailer.sendAccountVerificationLink({ toEmail: email, verificationLink });
  if (!delivery.delivered) {
    await businessDb.transaction(async (tx) => {
      await tx.delete(performerLoginChallenges).where(eq(performerLoginChallenges.id, outcome.challengeId));
      await tx.delete(users).where(eq(users.id, outcome.accountId));
    });
    return res.status(503).json({ error: 'Verification email could not be delivered. Please try again.' });
  }

  return res.status(202).json({
    success: true,
    message: 'Check your email to verify your Sway account.',
    ...(delivery.provider === 'mock' ? { verificationLink } : {})
  });
});

app.get('/api/account/verify-email/consume', async (req, res) => {
  applyNoStoreHeaders(res);
  if (!businessDb || !performerLoginChallengeStore.hasDurableStore) {
    return res.redirect('/account/login?error=unavailable');
  }
  const token = typeof req.query.token === 'string' ? req.query.token.trim() : '';
  if (!token) return res.redirect('/account/login?error=invalid');

  const verified = await businessDb.transaction(async (tx) => {
    const challenge = await performerLoginChallengeStore.consumeChallengeFromToken({
      token,
      expectedChallengeType: ACCOUNT_LOGIN_CHALLENGE_TYPE_VERIFY_EMAIL,
      executor: tx
    });
    if (!challenge?.actorUserId) return { ok: false as const, nextPath: null };
    const verifiedAt = new Date();
    await tx.update(users).set({ emailVerifiedAt: verifiedAt, updatedAt: verifiedAt }).where(eq(users.id, challenge.actorUserId));
    await writeAuditEvent(tx, {
      actorId: challenge.actorUserId,
      actorType: 'account',
      entityType: 'user',
      entityId: challenge.actorUserId,
      eventType: 'account.verify_email',
      previousStatus: 'unverified',
      nextStatus: 'verified',
      metadata: { verifiedAt: verifiedAt.toISOString() }
    });
    const rawNextPath = challenge.challengeMetadata
      && typeof challenge.challengeMetadata === 'object'
      && 'accountNextPath' in challenge.challengeMetadata
      ? (challenge.challengeMetadata as { accountNextPath?: unknown }).accountNextPath
      : null;
    return {
      ok: true as const,
      nextPath: normalizeSafeAccountNextPath(rawNextPath)
    };
  });
  if (!verified.ok) return res.redirect('/account/login?error=invalid');
  const verifiedQuery = new URLSearchParams({ verified: '1' });
  if (verified.nextPath) verifiedQuery.set('next', verified.nextPath);
  return res.redirect(`/account/login?${verifiedQuery.toString()}`);
});

app.post('/api/account/verification/resend', async (req, res) => {
  applyNoStoreHeaders(res);
  if (!businessDb || !performerLoginChallengeStore.hasDurableStore) {
    return res.status(503).json({ error: 'Account verification is temporarily unavailable.' });
  }
  if (isProduction && !hasPerformerLoginEmailConfig) {
    return res.status(503).json({ error: 'Account verification email delivery is temporarily unavailable.' });
  }

  const email = normalizePerformerLoginEmail(req.body?.email);
  const requesterIpHash = hashPerformerLoginRequesterIp(req.ip || null);
  const rateLimit = performerSignupRateLimiter.consume({
    requesterIpHash,
    targetEmail: email ?? '__invalid_account_verification_resend__'
  });
  if (!rateLimit.allowed) {
    return res.status(429).json({ error: 'Too many verification requests. Please try again later.' });
  }

  const genericResponse = {
    success: true,
    message: 'If that unverified account exists, a new verification link is on its way.'
  };
  if (!email) return res.status(202).json(genericResponse);

  const [account] = await businessDb.select({
    id: users.id,
    emailVerifiedAt: users.emailVerifiedAt
  }).from(users).where(eq(users.email, email)).limit(1);
  if (!account || account.emailVerifiedAt) return res.status(202).json(genericResponse);

  const issued = await businessDb.transaction(async (tx) => {
    await tx.update(performerLoginChallenges).set({ revokedAt: new Date() }).where(and(
      eq(performerLoginChallenges.actorUserId, account.id),
      eq(performerLoginChallenges.challengeType, ACCOUNT_LOGIN_CHALLENGE_TYPE_VERIFY_EMAIL),
      isNull(performerLoginChallenges.consumedAt),
      isNull(performerLoginChallenges.revokedAt)
    ));
    const challenge = await performerLoginChallengeStore.issueChallenge({
      actorUserId: account.id,
      targetEmail: email,
      challengeType: ACCOUNT_LOGIN_CHALLENGE_TYPE_VERIFY_EMAIL,
      requesterIpHash,
      executor: tx
    });
    await writeAuditEvent(tx, {
      actorId: account.id,
      actorType: 'account',
      entityType: 'performer_login_challenge',
      entityId: challenge.challengeId,
      eventType: 'account.verify_email.resend',
      previousStatus: null,
      nextStatus: 'pending'
    });
    return challenge;
  });

  const baseUrl = resolvePerformerLoginBaseUrl(process.env).replace(/\/+$/, '');
  const verificationLink = `${baseUrl}/api/account/verify-email/consume?token=${encodeURIComponent(issued.token)}`;
  const delivery = await performerLoginMailer.sendAccountVerificationLink({ toEmail: email, verificationLink });
  if (!delivery.delivered) {
    await performerLoginChallengeStore.revokeChallengeById({ challengeId: issued.challengeId });
    return res.status(503).json({ error: 'Verification email delivery is temporarily unavailable.' });
  }
  return res.status(202).json({
    ...genericResponse,
    ...(delivery.provider === 'mock' ? { verificationLink } : {})
  });
});

app.post('/api/account/password-reset/request', async (req, res) => {
  applyNoStoreHeaders(res);
  if (!businessDb || !performerLoginChallengeStore.hasDurableStore) {
    return res.status(503).json({ error: 'Password recovery is temporarily unavailable.' });
  }
  if (isProduction && !hasPerformerLoginEmailConfig) {
    return res.status(503).json({ error: 'Password recovery email delivery is temporarily unavailable.' });
  }

  const email = normalizePerformerLoginEmail(req.body?.email);
  const requesterIpHash = hashPerformerLoginRequesterIp(req.ip || null);
  const rateLimit = performerSignupRateLimiter.consume({
    requesterIpHash,
    targetEmail: email ?? '__invalid_account_password_reset__'
  });
  if (!rateLimit.allowed) {
    return res.status(429).json({ error: 'Too many password recovery requests. Please try again later.' });
  }

  const genericResponse = {
    success: true,
    message: 'If that account exists, a one-time password reset link is on its way.'
  };
  if (!email) return res.status(202).json(genericResponse);

  const [account] = await businessDb.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (!account) return res.status(202).json(genericResponse);

  const issued = await businessDb.transaction(async (tx) => {
    await tx.update(performerLoginChallenges).set({ revokedAt: new Date() }).where(and(
      eq(performerLoginChallenges.actorUserId, account.id),
      eq(performerLoginChallenges.challengeType, PERFORMER_LOGIN_CHALLENGE_TYPE_PASSWORD_RESET),
      isNull(performerLoginChallenges.consumedAt),
      isNull(performerLoginChallenges.revokedAt)
    ));
    const challenge = await performerLoginChallengeStore.issueChallenge({
      actorUserId: account.id,
      targetEmail: email,
      challengeType: PERFORMER_LOGIN_CHALLENGE_TYPE_PASSWORD_RESET,
      requesterIpHash,
      executor: tx
    });
    await writeAuditEvent(tx, {
      actorId: account.id,
      actorType: 'account',
      entityType: 'performer_login_challenge',
      entityId: challenge.challengeId,
      eventType: 'account.password_reset.issue',
      previousStatus: null,
      nextStatus: 'pending'
    });
    return challenge;
  });

  const baseUrl = resolvePerformerLoginBaseUrl(process.env).replace(/\/+$/, '');
  const resetLink = `${baseUrl}/account/password-reset?mode=reset&token=${encodeURIComponent(issued.token)}`;
  const delivery = await performerLoginMailer.sendOwnerPasswordReset({ toEmail: email, resetLink });
  if (!delivery.delivered) {
    await performerLoginChallengeStore.revokeChallengeById({ challengeId: issued.challengeId });
    return res.status(503).json({ error: 'Password recovery email delivery is temporarily unavailable.' });
  }
  return res.status(202).json({
    ...genericResponse,
    ...(delivery.provider === 'mock' ? { resetLink } : {})
  });
});

app.post('/api/account/login', async (req, res) => {
  applyNoStoreHeaders(res);
  if (!businessDb || !performerSessionStore.hasDurableStore) {
    return res.status(503).json({ error: 'Account login is temporarily unavailable.' });
  }
  const email = normalizePerformerLoginEmail(req.body?.email);
  const password = normalizePerformerPassword(req.body?.password);
  const claimCode = typeof req.body?.claimCode === 'string' ? req.body.claimCode.trim() : '';
  const accountNextPath = normalizeSafeAccountNextPath(req.body?.next);
  const requesterIpHash = hashPerformerLoginRequesterIp(req.ip || null);
  const accountKey = email ?? '__invalid__';
  const rateLimit = await checkDurablePasswordLoginLimit({ requesterIpHash, accountKey, scope: 'account', maxFailures: 5 });
  if (!rateLimit.allowed) return res.status(429).json({ error: 'Too many failed sign-in attempts. Please try again later.' });

  const [account] = email ? await businessDb.select({
    id: users.id,
    passwordHash: users.passwordHash,
    emailVerifiedAt: users.emailVerifiedAt
  }).from(users).where(eq(users.email, email)).limit(1) : [];
  if (!account?.passwordHash || !password || !(await verifyPerformerPassword(password, account.passwordHash))) {
    await recordDurablePasswordLoginFailure({ requesterIpHash, accountKey, scope: 'account' });
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  }
  if (!validatePerformerPasswordStrength(password).ok) {
    return res.status(403).json({
      error: 'This password no longer meets Sway security requirements. Reset it to continue.',
      code: 'password_reset_required'
    });
  }
  if (!account.emailVerifiedAt) return res.status(403).json({ error: 'Verify your email before logging in.' });

  const issuedSession = await performerSessionStore.issueSession({ actorUserId: account.id, issuedBy: account.id });
  await resetDurablePasswordLoginFailures({ requesterIpHash, accountKey, scope: 'account' });
  res.cookie(performerSessionStore.cookieName, issuedSession.token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    expires: issuedSession.expiresAt
  });
  const redirectPath = claimCode
    ? `/account?claim=${encodeURIComponent(claimCode)}`
    : accountNextPath || '/account';
  return res.json({ success: true, redirectPath });
});

app.get('/api/account/session', async (req, res) => {
  applyNoStoreHeaders(res);
  const access = await accessControl.requireAuthenticatedAccountAccess(req);
  if (access.allowed === false) return res.status(access.status).json({ error: access.reason });
  if (!businessDb) return res.status(503).json({ error: 'Account access requires durable persistence.' });

  const [account] = await businessDb.select({
    id: users.id,
    email: users.email,
    displayName: users.displayName,
    emailVerifiedAt: users.emailVerifiedAt,
    proModeStatus: users.proModeStatus
  }).from(users).where(eq(users.id, access.actor.actorId!)).limit(1);
  const [performer] = await businessDb.select({
    id: performers.id,
    displayName: performers.displayName,
    handle: performers.handle,
    payoutsEnabled: performers.payoutsEnabled
  }).from(performers).where(eq(performers.ownerUserId, access.actor.actorId!)).limit(1);
  let pendingRightsReviewCount = 0;
  if (audioPublishingService) {
    try {
      const pendingReviews = await audioPublishingService.listRightsReviewQueue({ actorUserId: access.actor.actorId! });
      pendingRightsReviewCount = pendingReviews.length;
    } catch {
      pendingRightsReviewCount = 0;
    }
  }
  return res.json({ account, performer: performer ?? null, pendingRightsReviewCount });
});

app.post('/api/account/logout', async (req, res) => {
  applyNoStoreHeaders(res);
  const token = performerSessionStore.readSessionTokenFromRequest(req);
  if (token) await performerSessionStore.revokeSessionFromToken(token);
  res.clearCookie(performerSessionStore.cookieName, { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/' });
  return res.json({ success: true });
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
  const [existingPerformer] = await businessDb.select({
    id: performers.id,
    displayName: performers.displayName,
    handle: performers.handle
  }).from(performers).where(eq(performers.ownerUserId, actorId)).limit(1);
  const displayName = existingPerformer?.displayName ?? normalizePerformerDisplayName(req.body?.displayName);
  const handle = existingPerformer?.handle ?? normalizePerformerHandle(req.body?.handle);
  if (!displayName || !handle) return res.status(422).json({ error: 'Performer name and handle are required.' });
  if (!existingPerformer && await performerHandleExists(businessDb, handle)) {
    return res.status(409).json({ error: 'This handle is already taken.' });
  }

  try {
    const activation = await activateProModeWithPerformer(businessDb, {
      userId: actorId,
      actorUserId: actorId,
      displayName,
      handle
    });
    if (activation.allowed === false) return res.status(409).json({ error: activation.reason });
    return res.json({
      status: activation.nextStatus,
      changed: activation.changed,
      performer: activation.performer,
      redirectPath: '/talent'
    });
  } catch (error) {
    if (isUniqueConstraintViolation(error, 'idx_performers_handle') || isUniqueConstraintViolation(error, 'idx_performers_handle_lower')) {
      return res.status(409).json({ error: 'This handle is already taken.' });
    }
    throw error;
  }
});

app.post('/api/talent/control-bridge/token', async (req, res) => {
  applyNoStoreHeaders(res);

  const gigId = parseDurableGigId(req.body?.gig_id);
  const actor = await resolveProtectedMutationActor(req, res, gigId);
  if (!actor) return;

  if (!performerSessionStore.hasDurableStore || !businessDb || !gigId) {
    res.status(503).json({ error: 'Control bridge token issuance requires durable session persistence.' });
    return;
  }

  const bridgeSession = await businessDb.transaction(async (tx) => {
    const [lockedGig] = await tx
      .select({ id: gigSessions.id })
      .from(gigSessions)
      .where(eq(gigSessions.id, gigId))
      .limit(1)
      .for('update');
    if (!lockedGig) throw new Error('The selected live room no longer exists.');

    await performerSessionStore.revokeActiveSessionsForActorUser({
      actorUserId: actor.actorId,
      sessionType: 'control_bridge',
      gigId,
      executor: tx
    });

    return performerSessionStore.issueSession({
      actorUserId: actor.actorId,
      issuedBy: actor.actorId,
      ttlHours: 6,
      sessionType: 'control_bridge',
      gigId,
      metadata: {
        purpose: 'dj_room_controller',
        issuedFrom: 'performer_connections'
      },
      executor: tx
    });
  });

  const requestOrigin = typeof req.headers.origin === 'string' && req.headers.origin.trim()
    ? req.headers.origin.trim().replace(/\/+$/, '')
    : null;
  const configuredBaseUrl = process.env.SWAY_APP_BASE_URL?.trim().replace(/\/+$/, '') || null;
  const fallbackBaseUrl = `${req.protocol}://${req.get('host')}`;
  const swayUrl = configuredBaseUrl || requestOrigin || fallbackBaseUrl;
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
        ttlHours: 6,
        sessionType: 'control_bridge',
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
  if (durableReplay.kind === 'replay' || durableReplay.kind === 'pending') {
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

  const actor = await resolveProtectedMutationActor(req, res, roomContext.gigId, { allowControlBridge: true });
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

async function requireScopedControlBridge(
  req: express.Request,
  res: express.Response,
  gigId: string
) {
  const access = await accessControl.requireGigMutationAccess(req, gigId, { allowControlBridge: true });
  if (access.allowed === false) {
    res.status(access.status).json({ error: access.reason });
    return null;
  }
  if (access.actor.sessionType !== 'control_bridge') {
    res.status(403).json({ error: 'A room-scoped control bridge token is required.' });
    return null;
  }
  return access;
}

function readLibraryTrackPath(metadata: unknown) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;
  for (const key of ['path', 'filePath', 'location', 'fileLocation']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 2_048);
  }
  return null;
}

async function resolvePlaybackCommandPayload(input: {
  gigId: string;
  performerId: string;
  action: string;
  payload: PlaybackCommandPayload;
}) {
  const payload = normalizePlaybackCommandPayload(input.payload);
  if (input.action !== 'load' || !businessDb) return payload;

  const roomSnapshot = await loadRoomState(input.gigId);
  const requestedRoomItem = payload.track?.requestId
    ? roomSnapshot.state.requests.find((item) => item.id === payload.track?.requestId) ?? null
    : null;
  const sourceTrackId = requestedRoomItem?.sourceTrackId ?? payload.track?.sourceTrackId ?? null;
  const libraryTrack = sourceTrackId && isPlaybackUuid(sourceTrackId)
    ? (await businessDb
        .select({
          id: performerLibraryTracks.id,
          externalTrackId: performerLibraryTracks.externalTrackId,
          title: performerLibraryTracks.title,
          artist: performerLibraryTracks.artist,
          metadata: performerLibraryTracks.metadata
        })
        .from(performerLibraryTracks)
        .where(and(
          eq(performerLibraryTracks.id, sourceTrackId),
          eq(performerLibraryTracks.performerId, input.performerId)
        ))
        .limit(1))[0] ?? null
    : null;

  return {
    deck: payload.deck,
    track: {
      requestId: requestedRoomItem?.id ?? payload.track?.requestId ?? null,
      sourceTrackId: libraryTrack?.id ?? sourceTrackId,
      externalTrackId: libraryTrack?.externalTrackId ?? requestedRoomItem?.externalTrackId ?? payload.track?.externalTrackId ?? null,
      title: libraryTrack?.title ?? requestedRoomItem?.title ?? payload.track?.title ?? null,
      artist: libraryTrack?.artist ?? requestedRoomItem?.subtitle ?? payload.track?.artist ?? null,
      // A local path is accepted only from the performer's persisted library
      // metadata. Browser input cannot instruct the booth machine to open an
      // arbitrary path.
      path: readLibraryTrackPath(libraryTrack?.metadata)
    }
  };
}

app.post('/api/talent/playback/commands', async (req, res) => {
  applyNoStoreHeaders(res);
  const gigId = parseDurableGigId(req.body?.gig_id);
  if (!gigId || !businessDb || !playbackControlStore) {
    return res.status(gigId ? 503 : 422).json({ error: gigId ? 'Playback control requires durable persistence.' : 'A valid gig_id is required.' });
  }
  const access = await accessControl.requireGigMutationAccess(req, gigId, { allowControlBridge: true });
  if (access.allowed === false) return res.status(access.status).json({ error: access.reason });
  if (!access.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });

  const validated = validatePlaybackCommandInput({
    clientCommandId: req.body?.clientCommandId,
    sourceKey: req.body?.sourceKey,
    action: req.body?.action,
    payload: req.body?.payload
  });
  if (!validated.ok) return res.status(422).json({ error: validated.error });
  if (access.actor.sessionType === 'control_bridge' && validated.command.sourceKey !== 'virtualdj') {
    return res.status(403).json({ error: 'Control bridge tokens may queue only VirtualDJ commands for their scoped room.' });
  }

  const [gig] = await businessDb
    .select({ performerId: gigSessions.performerId, status: gigSessions.status })
    .from(gigSessions)
    .where(eq(gigSessions.id, gigId))
    .limit(1);
  if (!gig) return res.status(404).json({ error: 'Live room not found.' });
  if (!['active', 'closeout_pending'].includes(gig.status)) {
    return res.status(409).json({ error: 'Playback control is available only while the room is live.' });
  }

  const payload = await resolvePlaybackCommandPayload({
    gigId,
    performerId: gig.performerId,
    action: validated.command.action,
    payload: validated.command.payload
  });

  try {
    const created = await playbackControlStore.createCommand({
      gigId,
      performerId: gig.performerId,
      actorUserId: access.actor.actorId,
      clientCommandId: validated.command.clientCommandId,
      sourceKey: validated.command.sourceKey,
      action: validated.command.action,
      payload
    });
    await writeAuditEvent(businessDb, {
      actorId: access.actor.actorId,
      actorType: access.role ?? 'performer',
      entityType: 'playback_command',
      entityId: created.command.id,
      eventType: created.replay ? 'playback.command.replay' : 'playback.command.queue',
      previousStatus: null,
      nextStatus: created.command.status,
      metadata: {
        gigId,
        sourceKey: created.command.sourceKey,
        action: created.command.action,
        clientCommandId: created.command.clientCommandId
      }
    });
    return res.status(created.replay ? 200 : 202).json({ success: true, replay: created.replay, command: created.command });
  } catch (error) {
    const status = typeof (error as { status?: number })?.status === 'number' ? (error as { status: number }).status : 400;
    return res.status(status).json({ error: error instanceof Error ? error.message : 'Playback command could not be queued.' });
  }
});

app.get('/api/talent/playback/snapshot/:gigId', async (req, res) => {
  applyNoStoreHeaders(res);
  const gigId = parseDurableGigId(req.params.gigId);
  if (!gigId || !playbackControlStore) return res.status(gigId ? 503 : 404).json({ error: 'Playback snapshot is unavailable.' });
  const access = await accessControl.requireGigMutationAccess(req, gigId);
  if (access.allowed === false) return res.status(access.status).json({ error: access.reason });
  return res.json(await playbackControlStore.getSnapshot({ gigId }));
});

app.get('/api/talent/control-bridge/state/:gigId', async (req, res) => {
  applyNoStoreHeaders(res);
  const gigId = parseDurableGigId(req.params.gigId);
  if (!gigId) return res.status(404).json({ error: 'Live room not found.' });
  const access = await requireScopedControlBridge(req, res, gigId);
  if (!access) return;
  const roomSnapshot = await loadRoomState(gigId);
  if (roomSnapshot.roomStatus === 'missing') return res.status(404).json({ error: ROOM_LOOKUP_UNAVAILABLE_COPY });
  if (roomSnapshot.roomStatus === 'ended') return res.status(410).json({ error: ROOM_LOOKUP_ENDED_COPY });
  return res.json({
    session: roomSnapshot.state.session,
    requests: roomSnapshot.state.requests,
    performers: roomSnapshot.state.performers,
    activeGigId: roomSnapshot.state.activeGigId,
    playback: playbackControlStore ? await playbackControlStore.getSnapshot({ gigId }) : null
  });
});

app.post('/api/talent/playback/bridge/claim', async (req, res) => {
  applyNoStoreHeaders(res);
  const gigId = parseDurableGigId(req.body?.gig_id);
  const sourceKey = req.body?.sourceKey;
  const bridgeInstanceId = normalizeLibraryText(req.body?.bridgeInstanceId, 128);
  if (!gigId || !isPlaybackSourceKey(sourceKey) || !bridgeInstanceId) {
    return res.status(422).json({ error: 'gig_id, sourceKey, and bridgeInstanceId are required.' });
  }
  const access = await requireScopedControlBridge(req, res, gigId);
  if (!access) return;
  if (!playbackControlStore) return res.status(503).json({ error: 'Playback control requires durable persistence.' });
  const commands = await playbackControlStore.claimCommands({ gigId, sourceKey, bridgeInstanceId });
  return res.json({ commands });
});

app.post('/api/talent/playback/bridge/complete', async (req, res) => {
  applyNoStoreHeaders(res);
  const gigId = parseDurableGigId(req.body?.gig_id);
  const sourceKey = req.body?.sourceKey;
  const bridgeInstanceId = normalizeLibraryText(req.body?.bridgeInstanceId, 128);
  const commandId = parseDurableGigId(req.body?.commandId);
  if (!gigId || !isPlaybackSourceKey(sourceKey) || !bridgeInstanceId || !commandId || typeof req.body?.success !== 'boolean') {
    return res.status(422).json({ error: 'A valid command completion identity and success flag are required.' });
  }
  const access = await requireScopedControlBridge(req, res, gigId);
  if (!access) return;
  if (!playbackControlStore) return res.status(503).json({ error: 'Playback control requires durable persistence.' });
  const completion = await playbackControlStore.completeCommand({
    gigId,
    sourceKey,
    bridgeInstanceId,
    commandId,
    success: req.body.success,
    result: req.body?.result,
    errorText: normalizeLibraryText(req.body?.error, 1_000)
  });
  if (!completion) return res.status(409).json({ error: 'Playback command is not claimed by this bridge.' });
  return res.json({ success: true, replay: completion.replay, command: completion.command });
});

app.post('/api/talent/playback/bridge/state', async (req, res) => {
  applyNoStoreHeaders(res);
  const gigId = parseDurableGigId(req.body?.gig_id);
  if (!gigId) return res.status(422).json({ error: 'A valid gig_id is required.' });
  const access = await requireScopedControlBridge(req, res, gigId);
  if (!access) return;
  if (!businessDb || !playbackControlStore) return res.status(503).json({ error: 'Playback control requires durable persistence.' });
  const [gig] = await businessDb.select({ performerId: gigSessions.performerId }).from(gigSessions).where(eq(gigSessions.id, gigId)).limit(1);
  if (!gig) return res.status(404).json({ error: 'Live room not found.' });
  const stateRow = await playbackControlStore.upsertState({ gigId, performerId: gig.performerId, state: req.body?.state });
  if (!stateRow) return res.status(422).json({ error: 'Playback state payload is invalid.' });
  return res.status(202).json({ success: true, state: stateRow });
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
  const rateLimitState = await checkDurablePasswordLoginLimit({
    requesterIpHash,
    accountKey,
    scope: 'admin',
    maxFailures: parsePositiveInteger(process.env.SWAY_ADMIN_PASSWORD_LOGIN_RATE_LIMIT_MAX, 5)
  });

  if (!rateLimitState.allowed) {
    res.status(429).json({ error: 'Too many failed sign-in attempts. Please try again later.' });
    return;
  }

  if (!normalizedEmail || !password) {
    await recordDurablePasswordLoginFailure({ requesterIpHash, accountKey, scope: 'admin' });
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
    await recordDurablePasswordLoginFailure({ requesterIpHash, accountKey, scope: 'admin' });
    res.status(401).json(performerCredentialFailureResponse());
    return;
  }

  const passwordMatches = await verifyPerformerPassword(password, adminAccount.passwordHash);
  if (!passwordMatches) {
    await recordDurablePasswordLoginFailure({ requesterIpHash, accountKey, scope: 'admin' });
    res.status(401).json(performerCredentialFailureResponse());
    return;
  }
  if (!validatePerformerPasswordStrength(password).ok) {
    res.status(403).json({
      error: 'This password no longer meets Sway security requirements. Reset it before using an administrative account.',
      code: 'password_reset_required'
    });
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

  await resetDurablePasswordLoginFailures({ requesterIpHash, accountKey, scope: 'admin' });

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
      executor: tx,
      ttlMs: PERFORMER_CLAIM_CODE_TTL_MS
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
  const claimLink = `${appBaseUrl}/signup?claim=${encodeURIComponent(issued.token)}`;

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
  'boost_started',
  'performer_profile_claim_started',
  'guest_to_performer_started',
  'public_profile_shared',
  'public_event_shared',
  'public_release_shared',
  'discovery_landing',
  'discovery_entity_view',
  'discovery_primary_action',
  'internal_search_zero_result'
]);

const shellTelemetryAllowedKeys = new Set([
  'shell',
  'surface',
  'event',
  'route_family',
  'has_route_context',
  'has_session_context',
  'build_commit',
  'attribution_channel',
  'entity_kind',
  'journey_id',
  'entry_path',
  'entity_key',
  'action_kind',
  'experiment_key',
  'visibility_eligibility',
  'search_phrase',
  'link_strength'
]);

const shellTelemetryRequiredKeys = new Set([
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
  surface: 'recovery-view' | 'room-entry' | 'share-kit' | 'public-profile' | 'public-event' | 'public-release' | 'public-discover';
  event: string;
  route_family: string;
  has_route_context: boolean;
  has_session_context: boolean;
  build_commit: string;
  attribution_channel?: string;
  entity_kind?: string;
  journey_id?: string;
  entry_path?: string;
  entity_key?: string;
  action_kind?: DiscoveryJourneyEventInput['actionKind'];
  experiment_key?: string;
  visibility_eligibility?: DiscoveryJourneyEventInput['visibilityEligibility'];
  search_phrase?: string;
  link_strength?: DiscoveryJourneyEventInput['linkStrength'];
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

  for (const key of shellTelemetryRequiredKeys) {
    if (!(key in payload)) {
      return { ok: false, status: 400, error: `Missing telemetry field: ${key}` };
    }
  }

  if (payload.shell !== 'patron' && payload.shell !== 'talent') {
    return { ok: false, status: 400, error: 'Shell telemetry requires shell=patron or shell=talent.' };
  }
  if (payload.surface !== 'recovery-view' && payload.surface !== 'room-entry' && payload.surface !== 'share-kit' && payload.surface !== 'public-profile' && payload.surface !== 'public-event' && payload.surface !== 'public-release' && payload.surface !== 'public-discover') {
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
  if (payload.attribution_channel !== undefined) {
    if (typeof payload.attribution_channel !== 'string'
      || payload.attribution_channel.length === 0
      || payload.attribution_channel.length > 64
      || /[?&=#]/.test(payload.attribution_channel)) {
      return { ok: false, status: 400, error: 'attribution_channel must be a coarse, query-free string.' };
    }
  }
  if (payload.entity_kind !== undefined) {
    if (typeof payload.entity_kind !== 'string'
      || !['performer', 'event', 'release', 'live_room'].includes(payload.entity_kind)) {
      return { ok: false, status: 400, error: 'entity_kind must be a supported public entity kind.' };
    }
  }
  if (payload.journey_id !== undefined && (typeof payload.journey_id !== 'string' || !UUID_PATTERN.test(payload.journey_id))) {
    return { ok: false, status: 400, error: 'journey_id must be a UUID.' };
  }
  if (payload.entry_path !== undefined && (
    typeof payload.entry_path !== 'string'
    || payload.entry_path.length === 0
    || payload.entry_path.length > 300
    || /[?#]/.test(payload.entry_path)
    || !/^\/(?:$|p\/[^\s]+|e\/[0-9a-f-]{36}|g\/[0-9a-f-]{36}|r\/[0-9a-f-]{36}|discover\/?$)/i.test(payload.entry_path)
  )) {
    return { ok: false, status: 400, error: 'entry_path must be a supported public path.' };
  }
  if (payload.entity_key !== undefined && (
    typeof payload.entity_key !== 'string' || !/^[a-z0-9][a-z0-9_.:-]{0,127}$/i.test(payload.entity_key)
  )) {
    return { ok: false, status: 400, error: 'entity_key is invalid.' };
  }
  if (Boolean(payload.entity_kind) !== Boolean(payload.entity_key)) {
    return { ok: false, status: 400, error: 'entity_kind and entity_key must be supplied together.' };
  }
  if (payload.action_kind !== undefined && (
    typeof payload.action_kind !== 'string'
    || !['follow', 'room_entry', 'event_entry', 'ticket', 'tip', 'request', 'boost', 'share', 'other'].includes(payload.action_kind)
  )) {
    return { ok: false, status: 400, error: 'action_kind is invalid.' };
  }
  if (payload.experiment_key !== undefined && (
    typeof payload.experiment_key !== 'string'
    || !SWAY_DISCOVERY_EXPERIMENTS.some((experiment) => experiment.key === payload.experiment_key)
  )) {
    return { ok: false, status: 400, error: 'experiment_key is not predeclared.' };
  }
  if (payload.visibility_eligibility !== undefined && (
    typeof payload.visibility_eligibility !== 'string'
    || !['eligible', 'ineligible', 'unknown'].includes(payload.visibility_eligibility)
  )) {
    return { ok: false, status: 400, error: 'visibility_eligibility is invalid.' };
  }
  if (payload.search_phrase !== undefined && (
    typeof payload.search_phrase !== 'string'
    || !payload.search_phrase.trim()
    || payload.search_phrase.length > 160
    || /@|https?:\/\/|\b\d{7,}\b|\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/i.test(payload.search_phrase)
  )) {
    return { ok: false, status: 400, error: 'search_phrase must be a short public discovery phrase without contact data or URLs.' };
  }
  if (payload.link_strength !== undefined && (
    typeof payload.link_strength !== 'string'
    || !['direct_server_observed', 'client_correlated_unverified', 'unknown_unavailable'].includes(payload.link_strength)
  )) {
    return { ok: false, status: 400, error: 'link_strength is invalid.' };
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
      build_commit: payload.build_commit,
      ...(typeof payload.attribution_channel === 'string'
        ? { attribution_channel: payload.attribution_channel }
        : {}),
      ...(typeof payload.entity_kind === 'string'
        ? { entity_kind: payload.entity_kind }
        : {}),
      ...(typeof payload.journey_id === 'string' ? { journey_id: payload.journey_id } : {}),
      ...(typeof payload.entry_path === 'string' ? { entry_path: payload.entry_path } : {}),
      ...(typeof payload.entity_key === 'string' ? { entity_key: payload.entity_key } : {}),
      ...(typeof payload.action_kind === 'string' ? { action_kind: payload.action_kind as ShellTelemetryPayload['action_kind'] } : {}),
      ...(typeof payload.experiment_key === 'string' ? { experiment_key: payload.experiment_key } : {}),
      ...(typeof payload.visibility_eligibility === 'string'
        ? { visibility_eligibility: payload.visibility_eligibility as ShellTelemetryPayload['visibility_eligibility'] }
        : {}),
      ...(typeof payload.search_phrase === 'string' ? { search_phrase: payload.search_phrase.trim().replace(/\s+/g, ' ') } : {}),
      ...(typeof payload.link_strength === 'string'
        ? { link_strength: payload.link_strength as ShellTelemetryPayload['link_strength'] }
        : {})
    }
  };
}

function discoveryStageForTelemetryEvent(event: string): DiscoveryJourneyEventInput['stage'] | null {
  if (event === 'discovery_landing' || event === 'discovery_entity_view' || event === 'room_entry_viewed') return 'entry';
  if (
    event === 'discovery_primary_action'
    || event === 'request_started'
    || event === 'boost_started'
    || event === 'internal_search_zero_result'
  ) return 'action';
  return null;
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
    const stage = discoveryStageForTelemetryEvent(payload.event);
    if (stage && payload.journey_id && discoveryObservatoryStore) {
      const visibilityEligibility = await resolveDiscoveryEntityVisibilityEligibility({
        entityKind: payload.entity_kind,
        entityKey: payload.entity_key
      });
      await discoveryObservatoryStore.recordJourneyEvent({
        journeyId: payload.journey_id,
        stage,
        eventType: payload.event,
        source: payload.attribution_channel ?? 'unknown',
        surface: payload.surface,
        entryPath: payload.entry_path ?? null,
        entityKind: payload.entity_kind as DiscoveryJourneyEventInput['entityKind'],
        entityKey: payload.entity_key ?? null,
        actionKind: payload.action_kind ?? (
          payload.event === 'request_started' ? 'request'
            : payload.event === 'boost_started' ? 'boost'
              : payload.event === 'internal_search_zero_result' ? 'other'
                : null
        ),
        // Anonymous shell telemetry cannot submit outcome evidence. Durable
        // room/tip results are written only by their server-owned state paths.
        outcomeStatus: null,
        experimentKey: payload.experiment_key ?? null,
        // Client eligibility is never trusted for funnel inclusion. Resolve
        // it from current public server state or keep it explicitly unknown.
        visibilityEligibility,
        linkStrength: 'client_correlated_unverified',
        searchPhrase: payload.search_phrase ?? null
      });
      return res.status(202).json({ accepted: true });
    }
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

function executeRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

async function loadDiscoveryPerformerSupply() {
  if (!businessDb) return {
    visibilitySchema: 'explicit_visibility_unavailable' as const,
    performers: [] as SwayDiscoverySupply['performers'],
    visibilityCounts: { eligible: 0, ineligible: 0, unknown: 0 }
  };
  const columnResult = await businessDb.execute(sql`
    select exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'performers'
        and column_name = 'visibility_state'
    ) as present
  `);
  const explicitVisibilityAvailable = Boolean(executeRows<{ present: boolean }>(columnResult)[0]?.present);
  const visibilityProjection = explicitVisibilityAvailable
    ? sql.raw('p.visibility_state')
    : sql.raw('null::text');
  const rowsResult = await businessDb.execute(sql`
    select
      p.id,
      p.owner_user_id,
      p.display_name,
      p.handle,
      p.is_active,
      p.onboarding_status,
      ${visibilityProjection} as visibility_state,
      pp.city,
      coalesce(pp.specialties, '[]'::jsonb) as specialties
    from performers p
    left join performer_public_profiles pp on pp.performer_id = p.id
    order by p.id
  `);
  const rows = executeRows<{
    id: string;
    owner_user_id: string | null;
    display_name: string;
    handle: string | null;
    is_active: boolean;
    onboarding_status: string;
    visibility_state: string | null;
    city: string | null;
    specialties: unknown;
  }>(rowsResult);
  const performerSupply: SwayDiscoverySupply['performers'] = rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    handle: row.handle,
    city: row.city,
    specialties: Array.isArray(row.specialties)
      ? row.specialties.map((value) => String(value).trim()).filter(Boolean).slice(0, 20)
      : [],
    visibilityState: explicitVisibilityAvailable
      ? row.visibility_state as PerformerDiscoveryVisibilityState | null
      : undefined,
    isActive: row.is_active,
    onboardingStatus: row.onboarding_status,
    claimed: Boolean(row.owner_user_id)
  }));
  const eligibility = performerSupply.map(resolvePerformerDiscoveryEligibility);
  return {
    visibilitySchema: explicitVisibilityAvailable
      ? 'explicit_visibility_available' as const
      : 'explicit_visibility_unavailable' as const,
    performers: performerSupply,
    visibilityCounts: {
      eligible: eligibility.filter((item) => item.eligible).length,
      ineligible: eligibility.filter((item) => !item.eligible).length,
      unknown: eligibility.filter((item) => item.evidence !== 'explicit_visibility').length
    }
  };
}

async function resolveDiscoveryEntityVisibilityEligibility(input: {
  entityKind?: string;
  entityKey?: string;
}): Promise<'eligible' | 'ineligible' | 'unknown'> {
  if (!businessDb || !input.entityKind || !input.entityKey) return 'unknown';
  try {
    const performerSupply = await loadDiscoveryPerformerSupply();
    const eligiblePerformerIds = new Set(performerSupply.performers
      .filter((performer) => resolvePerformerDiscoveryEligibility(performer).eligible)
      .map((performer) => performer.id));
    if (input.entityKind === 'performer') {
      const performer = performerSupply.performers.find((candidate) => (
        candidate.id === input.entityKey || candidate.handle?.toLowerCase() === input.entityKey?.toLowerCase()
      ));
      return performer ? (eligiblePerformerIds.has(performer.id) ? 'eligible' : 'ineligible') : 'unknown';
    }
    if (input.entityKind === 'event') {
      const [event] = await businessDb.select({
        performerId: performerEvents.performerId,
        status: performerEvents.status,
        visibility: performerEvents.visibility
      }).from(performerEvents).where(eq(performerEvents.id, input.entityKey)).limit(1);
      if (!event) return 'unknown';
      return event.status === 'published' && event.visibility === 'public'
        && eligiblePerformerIds.has(event.performerId) ? 'eligible' : 'ineligible';
    }
    if (input.entityKind === 'live_room') {
      const [room] = await businessDb.select({
        performerId: activeRoomRegistry.performerId,
        registryStatus: activeRoomRegistry.registryStatus
      }).from(activeRoomRegistry).where(eq(activeRoomRegistry.gigId, input.entityKey)).limit(1);
      if (!room) return 'unknown';
      return ['active', 'ending'].includes(room.registryStatus)
        && eligiblePerformerIds.has(room.performerId) ? 'eligible' : 'ineligible';
    }
    if (input.entityKind === 'release') {
      const [release] = await businessDb.select({
        id: musicReleases.id,
        performerId: musicReleases.performerId,
        status: musicReleases.status,
        distributionMode: musicReleases.distributionMode
      }).from(musicReleases).where(eq(musicReleases.id, input.entityKey)).limit(1);
      if (!release) return 'unknown';
      const publicRelease = audioPublishingService
        ? await audioPublishingService.getPublicRelease({ releaseId: release.id })
        : null;
      return release.distributionMode !== 'private'
        && ['ready', 'scheduled', 'published'].includes(release.status)
        && eligiblePerformerIds.has(release.performerId)
        && Boolean(publicRelease) ? 'eligible' : 'ineligible';
    }
    return 'unknown';
  } catch (error) {
    console.warn('[sway.discovery] entity eligibility could not be resolved.', {
      entityKind: input.entityKind,
      error: error instanceof Error ? error.message : String(error)
    });
    return 'unknown';
  }
}

async function loadSwayDiscoverySupply(auditRows: Array<{ metadata: unknown }>) {
  if (!businessDb) throw new Error('Discovery Observatory requires durable persistence.');
  const performerSupply = await loadDiscoveryPerformerSupply();
  const [eventRows, roomRows, releaseCandidates] = await Promise.all([
    businessDb.select({
      id: performerEvents.id,
      performerId: performerEvents.performerId,
      title: performerEvents.title,
      startsAt: performerEvents.startsAt,
      timeZone: performerEvents.timeZone,
      city: performerEvents.city,
      locationName: performerEvents.locationName,
      externalTicketUrl: performerEvents.externalTicketUrl
    }).from(performerEvents).where(and(
      eq(performerEvents.status, 'published'),
      eq(performerEvents.visibility, 'public'),
      gt(performerEvents.startsAt, new Date())
    )).orderBy(asc(performerEvents.startsAt)).limit(100),
    businessDb.select({
      gigId: activeRoomRegistry.gigId,
      performerId: activeRoomRegistry.performerId,
      performerName: activeRoomRegistry.talentName,
      performerDisplayName: performers.displayName,
      city: performerPublicProfiles.city,
      routePath: activeRoomRegistry.routePath,
      startedAt: activeRoomRegistry.startedAt,
      lastActivityAt: activeRoomRegistry.lastActivityAt
    }).from(activeRoomRegistry)
      .innerJoin(performers, eq(performers.id, activeRoomRegistry.performerId))
      .leftJoin(performerPublicProfiles, eq(performerPublicProfiles.performerId, performers.id))
      .where(inArray(activeRoomRegistry.registryStatus, ['active', 'ending']))
      .orderBy(desc(activeRoomRegistry.lastActivityAt)).limit(100),
    businessDb.select({
      id: musicReleases.id,
      performerId: musicReleases.performerId
    }).from(musicReleases).where(and(
      ne(musicReleases.distributionMode, 'private'),
      inArray(musicReleases.status, ['ready', 'scheduled', 'published'])
    )).orderBy(desc(musicReleases.updatedAt)).limit(100)
  ]);

  const publicReleases = audioPublishingService
    ? (await Promise.all(releaseCandidates.map(async (candidate) => {
        const release = await audioPublishingService.getPublicRelease({ releaseId: candidate.id });
        return release ? {
          id: release.id,
          performerId: candidate.performerId,
          title: release.title,
          primaryArtistName: release.primaryArtistName,
          credits: release.recordings.flatMap((recording) => recording.credits.map((credit) => ({
            displayName: credit.displayName,
            role: credit.role
          })))
        } : null;
      }))).filter((release): release is NonNullable<typeof release> => Boolean(release))
    : [];
  const internalZeroResults = auditRows.flatMap((row) => {
    if (!row.metadata || typeof row.metadata !== 'object' || Array.isArray(row.metadata)) return [];
    const metadata = row.metadata as Record<string, unknown>;
    return metadata.stage === 'action'
      && metadata.event_type === 'internal_search_zero_result'
      && typeof metadata.search_phrase === 'string'
      && typeof metadata.occurred_at === 'string'
      ? [{ phrase: metadata.search_phrase, observedAt: metadata.occurred_at }]
      : [];
  });
  const supply: SwayDiscoverySupply = {
    performers: performerSupply.performers,
    events: eventRows.map((event) => ({
      id: event.id,
      performerId: event.performerId,
      title: event.title,
      startsAt: event.startsAt.toISOString(),
      timeZone: event.timeZone,
      city: event.city,
      locationName: event.locationName,
      ticketAvailable: Boolean(event.externalTicketUrl)
    })),
    rooms: roomRows.map((room) => ({
      gigId: room.gigId,
      performerId: room.performerId,
      performerName: room.performerName || room.performerDisplayName,
      city: room.city,
      routePath: room.routePath,
      startedAt: room.startedAt?.toISOString() ?? null
    })),
    releases: publicReleases,
    internalZeroResults
  };
  return { supply, performerSupply, roomRows };
}

async function buildCurrentDiscoveryObservatory(windowDays: number) {
  if (!businessDb || !discoveryObservatoryStore) throw new Error('Discovery Observatory requires durable persistence.');
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const auditRows = await discoveryObservatoryStore.listDiscoveryAuditRows({ since });
  const { supply, performerSupply, roomRows } = await loadSwayDiscoverySupply(auditRows);
  const staleEventRows = await businessDb.select({
    id: performerEvents.id,
    performerId: performerEvents.performerId,
    startsAt: performerEvents.startsAt,
    updatedAt: performerEvents.updatedAt
  }).from(performerEvents).where(and(
    eq(performerEvents.status, 'published'),
    eq(performerEvents.visibility, 'public'),
    sql`${performerEvents.startsAt} <= now()`
  )).limit(200);
  const eligiblePerformerIds = new Set(performerSupply.performers
    .filter((performer) => resolvePerformerDiscoveryEligibility(performer).eligible)
    .map((performer) => performer.id));
  const staleEligibleEventRows = staleEventRows.filter((event) => eligiblePerformerIds.has(event.performerId));
  const staleRoomRows = roomRows.filter((room) => eligiblePerformerIds.has(room.performerId) && (
    room.lastActivityAt.getTime() < Date.now() - 30 * 60 * 1000
  ));
  const freshnessFailures = [
    ...staleEligibleEventRows.map((event) => ({
      kind: 'event', entityKey: event.id, reason: 'published_public_event_start_is_past',
      sourceAsOf: event.updatedAt.toISOString(), expiresAt: event.startsAt.toISOString()
    })),
    ...staleRoomRows.map((room) => ({
      kind: 'live_room', entityKey: room.gigId, reason: 'active_registry_has_no_recent_activity',
      sourceAsOf: room.lastActivityAt.toISOString(), freshnessThresholdMinutes: 30
    }))
  ];
  const queryCollection = buildSwayDiscoveryQueryCollection(supply);
  const eligibilityExclusions = {
    events: supply.events.filter((event) => !eligiblePerformerIds.has(event.performerId)).length,
    rooms: supply.rooms.filter((room) => !room.performerId || !eligiblePerformerIds.has(room.performerId)).length,
    releases: supply.releases.filter((release) => !eligiblePerformerIds.has(release.performerId)).length,
    unknownPerformerRooms: supply.rooms.filter((room) => !room.performerId).length
  };
  const generatedAt = new Date();
  return buildDiscoveryObservatorySnapshot({
    auditRows,
    queryCollection,
    visibilitySchema: performerSupply.visibilitySchema,
    visibilityCounts: performerSupply.visibilityCounts,
    freshnessFailures,
    eligibilityExclusions,
    sourceAvailability: [
      {
        source: 'audit_store', state: 'available', asOf: generatedAt.toISOString(),
        note: 'Current read from durable audit_events; window and event allowlists are applied.'
      },
      {
        source: 'current_public_supply', state: 'available', asOf: generatedAt.toISOString(),
        note: 'Current database projection of performers, public events, active rooms, and public release projections.'
      },
      {
        source: 'performer_visibility',
        state: performerSupply.visibilitySchema === 'explicit_visibility_available' ? 'available' : 'unavailable',
        asOf: generatedAt.toISOString(),
        note: performerSupply.visibilitySchema === 'explicit_visibility_available'
          ? 'Explicit performer visibility states were read without modification.'
          : 'The explicit visibility column is not present in this checkout/database; legacy eligibility is reported with unknown evidence.'
      },
      {
        source: 'performer_ownership', state: 'available', asOf: generatedAt.toISOString(),
        note: 'Current internal performer owner_user_id is available for admin-only unclaimed-demand measurement.'
      },
      {
        source: 'google_search_console', state: 'unavailable', asOf: null,
        note: 'No authorized Search Console source is connected to this observatory.'
      },
      {
        source: 'bing_webmaster_tools', state: 'unavailable', asOf: null,
        note: 'No authorized Bing Webmaster source is connected to this observatory.'
      }
    ],
    claimOwnershipSource: {
      state: 'available',
      asOf: generatedAt.toISOString(),
      unclaimedPublicEntities: (() => {
        const unclaimedEligibleIds = new Set(performerSupply.performers
          .filter((performer) => !performer.claimed && resolvePerformerDiscoveryEligibility(performer).eligible)
          .map((performer) => performer.id));
        return [
          ...performerSupply.performers
            .filter((performer) => unclaimedEligibleIds.has(performer.id) && Boolean(performer.handle))
            .map((performer) => ({ entityKind: 'performer' as const, entityKey: performer.handle! })),
          ...supply.events
            .filter((event) => unclaimedEligibleIds.has(event.performerId))
            .map((event) => ({ entityKind: 'event' as const, entityKey: event.id })),
          ...supply.rooms
            .filter((room) => Boolean(room.performerId) && unclaimedEligibleIds.has(room.performerId!))
            .map((room) => ({ entityKind: 'live_room' as const, entityKey: room.gigId })),
          ...supply.releases
            .filter((release) => unclaimedEligibleIds.has(release.performerId))
            .map((release) => ({ entityKind: 'release' as const, entityKey: release.id }))
        ];
      })()
    }
  });
}

app.get('/api/admin/discovery-observatory', async (req, res) => {
  const adminAccess = await accessControl.requireAdminAccess(req);
  if (adminAccess.allowed === false) return res.status(adminAccess.status).json({ error: adminAccess.reason });
  applyNoStoreHeaders(res);
  const windowDays = Math.max(1, Math.min(180, parsePositiveInteger(
    typeof req.query.windowDays === 'string' ? req.query.windowDays : undefined,
    30
  )));
  try {
    return res.json({ observatory: await buildCurrentDiscoveryObservatory(windowDays) });
  } catch (error) {
    console.error('[sway.discovery] observatory read failed:', error);
    return res.status(503).json({ error: 'Discovery Observatory is temporarily unavailable.' });
  }
});

app.post('/api/admin/discovery-observatory/observations', async (req, res) => {
  const adminAccess = await accessControl.requireAdminAccess(req);
  if (adminAccess.allowed === false) return res.status(adminAccess.status).json({ error: adminAccess.reason });
  if (!discoveryObservatoryStore || !adminAccess.actor.actorId) {
    return res.status(503).json({ error: 'Discovery observation persistence is unavailable.' });
  }
  applyNoStoreHeaders(res);
  try {
    const observation = await discoveryObservatoryStore.recordObservation({
      actorUserId: adminAccess.actor.actorId,
      observation: req.body
    });
    return res.status(201).json({ observation });
  } catch (error) {
    return res.status(422).json({ error: error instanceof Error ? error.message : 'Observation is invalid.' });
  }
});

app.post('/api/admin/discovery-observatory/experiments/:experimentKey/decision', async (req, res) => {
  const adminAccess = await accessControl.requireAdminAccess(req);
  if (adminAccess.allowed === false) return res.status(adminAccess.status).json({ error: adminAccess.reason });
  if (!discoveryObservatoryStore || !adminAccess.actor.actorId) {
    return res.status(503).json({ error: 'Discovery experiment persistence is unavailable.' });
  }
  applyNoStoreHeaders(res);
  try {
    const result = await discoveryObservatoryStore.recordExperimentDecision({
      actorUserId: adminAccess.actor.actorId,
      experimentKey: req.params.experimentKey,
      decision: req.body?.decision,
      evidenceNote: typeof req.body?.evidenceNote === 'string' ? req.body.evidenceNote : ''
    });
    return res.status(201).json({ experiment: result, publicChangeApplied: false });
  } catch (error) {
    return res.status(422).json({ error: error instanceof Error ? error.message : 'Experiment decision is invalid.' });
  }
});

app.post('/api/discovery/experiments/:experimentKey/assign', async (req, res) => {
  applyNoStoreHeaders(res);
  if (!discoveryObservatoryStore) return res.status(503).json({ error: 'Experiment assignment is unavailable.' });
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
    || Object.keys(req.body).some((key) => key !== 'journey_id')) {
    return res.status(400).json({ error: 'Experiment assignment accepts only a server-validated journey_id.' });
  }
  try {
    const result = await discoveryObservatoryStore.assignExperiment({
      journeyId: req.body?.journey_id,
      experimentKey: req.params.experimentKey
    });
    return res.status(result.created ? 201 : 200).json(result);
  } catch (error) {
    return res.status(409).json({ error: error instanceof Error ? error.message : 'Experiment assignment is unavailable.' });
  }
});

type TicketBuyerContext = {
  buyerUserId: string;
};

async function requireTicketBuyer(
  req: express.Request,
  res: express.Response
): Promise<TicketBuyerContext | null> {
  applyNoStoreHeaders(res);
  const accountAccess = await accessControl.requireAuthenticatedAccountAccess(req);
  if (accountAccess.allowed === false) {
    res.status(accountAccess.status).json({ error: accountAccess.reason });
    return null;
  }
  if (!accountAccess.actor.actorId) {
    res.status(401).json({ error: 'Sway account resolution required.' });
    return null;
  }
  if (!businessDb || !eventTicketService) {
    res.status(503).json({ error: 'Ticket accounts require durable persistence.' });
    return null;
  }
  return { buyerUserId: accountAccess.actor.actorId };
}

app.post('/api/account/ticket-orders', async (req, res) => {
  const buyer = await requireTicketBuyer(req, res);
  if (!buyer || !eventTicketService) return;

  try {
    const checkout = await eventTicketService.createCheckoutOrder({
      ...buyer,
      eventId: req.body?.eventId,
      clientRequestId: req.body?.clientRequestId,
      termsAccepted: req.body?.termsAccepted
    });
    return res.status(checkout.ticketId ? 200 : 201).json(checkout);
  } catch (error) {
    return respondToEventTicketServiceError(res, error, 'Unable to start ticket checkout.');
  }
});

app.get('/api/account/ticket-orders', async (req, res) => {
  const buyer = await requireTicketBuyer(req, res);
  if (!buyer || !eventTicketService) return;

  try {
    const orders = await eventTicketService.listBuyerOrders({
      ...buyer,
      limit: Number(req.query.limit) || 10
    });
    return res.json({ orders });
  } catch (error) {
    return respondToEventTicketServiceError(res, error, 'Unable to load ticket orders.');
  }
});

app.get('/api/account/ticket-orders/:orderId', async (req, res) => {
  const buyer = await requireTicketBuyer(req, res);
  if (!buyer || !eventTicketService) return;

  try {
    const order = await eventTicketService.getBuyerOrder({
      ...buyer,
      orderId: req.params.orderId
    });
    return res.json({ order });
  } catch (error) {
    return respondToEventTicketServiceError(res, error, 'Unable to load ticket order.');
  }
});

app.get('/api/account/tickets', async (req, res) => {
  const buyer = await requireTicketBuyer(req, res);
  if (!buyer || !eventTicketService) return;

  try {
    const tickets = await eventTicketService.listBuyerTickets(buyer);
    return res.json({ tickets });
  } catch (error) {
    return respondToEventTicketServiceError(res, error, 'Unable to load tickets.');
  }
});

app.get('/api/account/tickets/:ticketId', async (req, res) => {
  const buyer = await requireTicketBuyer(req, res);
  if (!buyer || !eventTicketService) return;

  try {
    const ticket = await eventTicketService.getBuyerTicketPass({
      ...buyer,
      ticketId: req.params.ticketId
    });
    return res.json({ ticket });
  } catch (error) {
    return respondToEventTicketServiceError(res, error, 'Unable to load ticket pass.');
  }
});

type PerformerEventOwnerContext = {
  actorUserId: string;
  performerId: string;
};

async function requirePerformerEventOwner(
  req: express.Request,
  res: express.Response
): Promise<PerformerEventOwnerContext | null> {
  applyNoStoreHeaders(res);
  try {
    const talentAccess = await accessControl.requireTalentAccess(req);
    if (talentAccess.allowed === false) {
      res.status(talentAccess.status).json({ error: talentAccess.reason });
      return null;
    }
    if (!talentAccess.actor.actorId || !businessDb || !performerEventService) {
      res.status(503).json({ error: 'Performer events require a durable database connection.' });
      return null;
    }

    const performerOwner = await loadOwnedPerformerByActorUserId(talentAccess.actor.actorId);
    if (!performerOwner) {
      res.status(403).json({ error: 'Only the performer owner can manage these events.' });
      return null;
    }

    return {
      actorUserId: talentAccess.actor.actorId,
      performerId: performerOwner.performerId
    };
  } catch (error) {
    console.error('Performer event owner lookup failed:', error);
    res.status(503).json({ error: 'Performer event access is temporarily unavailable.' });
    return null;
  }
}

app.get('/api/talent/events', async (req, res) => {
  const owner = await requirePerformerEventOwner(req, res);
  if (!owner || !performerEventService) return;

  try {
    const events = await performerEventService.listOwnedEvents({
      ...owner,
      limit: Number(req.query.limit) || 50
    });
    const eventResponses = await Promise.all(
      events.map((event) => toOwnedEventResponseWithTicket(event, owner))
    );
    return res.json({ events: eventResponses });
  } catch (error) {
    return respondToEventServiceError(res, error, 'Unable to load performer events.');
  }
});

app.get('/api/talent/events/native-ticket-capability', async (req, res) => {
  const owner = await requirePerformerEventOwner(req, res);
  if (!owner || !eventTicketService) return;

  try {
    const capability = await eventTicketService.getOwnerNativeTicketSalesCapability(owner);
    return res.json({ capability });
  } catch (error) {
    return respondToEventTicketServiceError(
      res,
      error,
      'Unable to load native ticket readiness.'
    );
  }
});

app.post('/api/talent/events', async (req, res) => {
  const owner = await requirePerformerEventOwner(req, res);
  if (!owner || !performerEventService) return;

  try {
    if (req.body?.ticketingMode === 'native_ga') {
      const capability = eventTicketService
        ? await eventTicketService.getOwnerNativeTicketSalesCapability(owner)
        : null;
      if (!capability?.salesAvailable) {
        return res.status(503).json({
          error: 'Native ticket event creation is disabled until its payment, tax, and admission configuration is complete.',
          code: 'native_ticket_sales_disabled'
        });
      }
    }
    const result = await performerEventService.createEvent({
      ...owner,
      clientRequestId: req.body?.clientRequestId,
      title: req.body?.title,
      description: req.body?.description,
      startsAt: req.body?.startsAt,
      doorOpensAt: req.body?.doorOpensAt,
      endsAt: req.body?.endsAt,
      timeZone: req.body?.timeZone,
      locationName: req.body?.locationName,
      locationAddress: req.body?.locationAddress,
      city: req.body?.city,
      locationIsTba: req.body?.locationIsTba,
      coverImageUrl: req.body?.coverImageUrl,
      ticketingMode: req.body?.ticketingMode,
      externalTicketUrl: req.body?.externalTicketUrl,
      externalTicketLabel: req.body?.externalTicketLabel,
      visibility: req.body?.visibility
    });
    return res.status(result.created ? 201 : 200).json({
      event: await toOwnedEventResponseWithTicket(result.event, owner),
      idempotentReplay: !result.created
    });
  } catch (error) {
    return respondToEventServiceError(res, error, 'Unable to create performer event.');
  }
});

app.patch('/api/talent/events/:eventId', async (req, res) => {
  const owner = await requirePerformerEventOwner(req, res);
  if (!owner || !performerEventService) return;

  const optionalFields = [
    'title',
    'description',
    'startsAt',
    'doorOpensAt',
    'endsAt',
    'timeZone',
    'locationName',
    'locationAddress',
    'city',
    'locationIsTba',
    'coverImageUrl',
    'externalTicketUrl',
    'externalTicketLabel',
    'visibility'
  ] as const;
  const changes = Object.fromEntries(optionalFields
    .filter((field) => Object.prototype.hasOwnProperty.call(req.body ?? {}, field))
    .map((field) => [field, req.body[field]]));

  try {
    const event = await performerEventService.updateEvent({
      ...owner,
      eventId: req.params.eventId,
      expectedUpdatedAt: req.body?.expectedUpdatedAt,
      ...changes
    });
    return res.json({ event: await toOwnedEventResponseWithTicket(event, owner) });
  } catch (error) {
    return respondToEventServiceError(res, error, 'Unable to update performer event.');
  }
});

app.get('/api/talent/events/:eventId/ticketing', async (req, res) => {
  const owner = await requirePerformerEventOwner(req, res);
  if (!owner || !performerEventService || !eventTicketService) return;

  try {
    const event = await performerEventService.getOwnedEvent({
      ...owner,
      eventId: req.params.eventId
    });
    if (event.ticketingMode !== 'native_ga') {
      return res.status(409).json({
        error: 'This event uses an external ticket or RSVP destination.',
        code: 'native_ticket_mode_required'
      });
    }
    const eventResponse = await toOwnedEventResponseWithTicket(event, owner);
    return res.json({
      ticketOffer: eventResponse.ticketOffer,
      nativeTicket: eventResponse.nativeTicket
    });
  } catch (error) {
    if (error instanceof EventServiceError) {
      return respondToEventServiceError(res, error, 'Unable to load native ticket setup.');
    }
    return respondToEventTicketServiceError(res, error, 'Unable to load native ticket setup.');
  }
});

app.put('/api/talent/events/:eventId/ticketing', async (req, res) => {
  const owner = await requirePerformerEventOwner(req, res);
  if (!owner || !eventTicketService) return;

  try {
    const ticketOffer = await eventTicketService.updateOwnerTicketOffer({
      ...owner,
      eventId: req.params.eventId,
      capacity: req.body?.capacity,
      faceValueCents: req.body?.faceValueCents,
      termsAccepted: req.body?.termsAccepted
    });
    return res.json({
      ticketOffer: {
        ...ticketOffer,
        unitAllInPriceCents: ticketOffer.advertisedTotalCents,
        remainingCount: ticketOffer.capacity,
        salesStatus: 'scheduled'
      }
    });
  } catch (error) {
    return respondToEventTicketServiceError(res, error, 'Unable to save native ticket setup.');
  }
});

app.get('/api/talent/events/:eventId/door', async (req, res) => {
  const owner = await requirePerformerEventOwner(req, res);
  if (!owner || !eventTicketService) return;

  try {
    const door = await eventTicketService.getDoorSummary({
      ...owner,
      eventId: req.params.eventId
    });
    return res.json({ door });
  } catch (error) {
    return respondToEventTicketServiceError(res, error, 'Unable to load the ticket door.');
  }
});

app.post('/api/talent/events/:eventId/check-ins', async (req, res) => {
  const owner = await requirePerformerEventOwner(req, res);
  if (!owner || !eventTicketService) return;

  try {
    const result = await eventTicketService.checkIn({
      ...owner,
      eventId: req.params.eventId,
      clientRequestId: req.body?.clientRequestId,
      qrToken: req.body?.qrToken,
      manualCode: req.body?.manualCode
    });
    return res.json(result);
  } catch (error) {
    return respondToEventTicketServiceError(res, error, 'Unable to check in this ticket.');
  }
});

app.post('/api/talent/events/:eventId/publish', async (req, res) => {
  const owner = await requirePerformerEventOwner(req, res);
  if (!owner || !performerEventService) return;

  try {
    const current = await performerEventService.getOwnedEvent({
      ...owner,
      eventId: req.params.eventId
    });
    if (current.ticketingMode === 'native_ga') {
      if (!eventTicketService) {
        return res.status(503).json({ error: 'Native ticket publishing is temporarily unavailable.' });
      }
      await eventTicketService.publishNativeEvent({
        ...owner,
        eventId: req.params.eventId,
        expectedUpdatedAt: req.body?.expectedUpdatedAt
      });
      const event = await performerEventService.getOwnedEvent({
        ...owner,
        eventId: req.params.eventId
      });
      return res.json({ event: await toOwnedEventResponseWithTicket(event, owner) });
    }
    const event = await performerEventService.publishEvent({
      ...owner,
      eventId: req.params.eventId,
      expectedUpdatedAt: req.body?.expectedUpdatedAt
    });
    return res.json({ event: await toOwnedEventResponseWithTicket(event, owner) });
  } catch (error) {
    if (error instanceof EventTicketServiceError) {
      return respondToEventTicketServiceError(res, error, 'Unable to publish performer event.');
    }
    return respondToEventServiceError(res, error, 'Unable to publish performer event.');
  }
});

app.post('/api/talent/events/:eventId/cancel', async (req, res) => {
  const owner = await requirePerformerEventOwner(req, res);
  if (!owner || !performerEventService) return;

  try {
    const current = await performerEventService.getOwnedEvent({
      ...owner,
      eventId: req.params.eventId
    });
    if (current.ticketingMode === 'native_ga') {
      if (!eventTicketService) {
        return res.status(503).json({ error: 'Native ticket cancellation is temporarily unavailable.' });
      }
      const result = await eventTicketService.cancelNativeEvent({
        ...owner,
        eventId: req.params.eventId,
        expectedUpdatedAt: req.body?.expectedUpdatedAt,
        cancellationReason: req.body?.cancellationReason
      });
      const event = await performerEventService.getOwnedEvent({
        ...owner,
        eventId: req.params.eventId
      });
      return res.json({
        event: await toOwnedEventResponseWithTicket(event, owner),
        refundsQueued: result.refundsQueued
      });
    }
    const event = await performerEventService.cancelEvent({
      ...owner,
      eventId: req.params.eventId,
      expectedUpdatedAt: req.body?.expectedUpdatedAt,
      cancellationReason: req.body?.cancellationReason
    });
    return res.json({ event: await toOwnedEventResponseWithTicket(event, owner) });
  } catch (error) {
    if (error instanceof EventTicketServiceError) {
      return respondToEventTicketServiceError(res, error, 'Unable to cancel performer event.');
    }
    return respondToEventServiceError(res, error, 'Unable to cancel performer event.');
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
        metadata: performerPublicProfiles.metadata,
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

  const profileMetadata = profileRow?.metadata && typeof profileRow.metadata === 'object'
    ? profileRow.metadata as Record<string, unknown>
    : null;

  return res.json({
    profile: {
      performerId: performerOwner.performerId,
      handle: performerOwner.handle,
      displayName: performerOwner.displayName,
      bio: performerOwner.bio,
      visibilityState: performerOwner.visibilityState,
      headline: profileRow?.headline ?? null,
      stageName: normalizePublicProfileText(profileMetadata?.stageName, 80),
      primaryRole: resolvePublicPrimaryRole(profileRow?.metadata),
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

app.post('/api/talent/profile/visibility', async (req, res) => {
  applyNoStoreHeaders(res);

  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) {
    return res.status(talentAccess.status).json({ error: talentAccess.reason });
  }
  if (!talentAccess.actor.actorId || !businessDb) {
    return res.status(503).json({ error: 'Performer visibility requires a durable database connection.' });
  }

  const nextVisibilityState = parsePerformerVisibilityState(req.body?.visibilityState);
  if (!nextVisibilityState) {
    return res.status(422).json({ error: 'Visibility must be draft, unlisted, or public.' });
  }

  try {
    const transition = await businessDb.transaction(async (tx) => {
      const [performer] = await tx
        .select({
          performerId: performers.id,
          visibilityState: performers.visibilityState
        })
        .from(performers)
        .where(eq(performers.ownerUserId, talentAccess.actor.actorId))
        .for('update')
        .limit(1);

      if (!performer) return null;

      const changed = performer.visibilityState !== nextVisibilityState;
      if (changed) {
        await tx
          .update(performers)
          .set({ visibilityState: nextVisibilityState, updatedAt: new Date() })
          .where(eq(performers.id, performer.performerId));

        await writeAuditEvent(tx, {
          actorId: talentAccess.actor.actorId,
          actorType: 'performer',
          entityType: 'performer',
          entityId: performer.performerId,
          eventType: 'performer_visibility.update',
          previousStatus: performer.visibilityState,
          nextStatus: nextVisibilityState,
          metadata: {
            control: 'owner',
            visibilityState: nextVisibilityState
          }
        });
      }

      return {
        changed,
        visibilityState: nextVisibilityState
      };
    });

    if (!transition) {
      return res.status(403).json({ error: 'Only the performer owner can manage visibility.' });
    }

    return res.json({
      success: true,
      changed: transition.changed,
      visibilityState: transition.visibilityState
    });
  } catch (error) {
    console.error('Performer visibility update failed', error);
    return res.status(500).json({ error: 'Unable to update performer visibility.' });
  }
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
  const stageNameProvided = req.body?.stageName !== undefined;
  const stageName = normalizePublicProfileText(req.body?.stageName, 80);
  const primaryRole = normalizePublicProfilePrimaryRole(req.body?.primaryRole);
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
  if (!primaryRole) {
    return res.status(422).json({ error: 'Choose your primary role.' });
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
    const [existingProfile] = await tx
      .select({ metadata: performerPublicProfiles.metadata })
      .from(performerPublicProfiles)
      .where(eq(performerPublicProfiles.performerId, performerOwner.performerId))
      .limit(1);

    const nextMetadata = mergePublicProfileMetadata(existingProfile?.metadata, {
      ...(stageNameProvided ? { stageName } : {}),
      primaryRole
    });

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
        metadata: nextMetadata,
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
          metadata: nextMetadata,
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
      previousStatus: performerOwner.visibilityState,
      nextStatus: performerOwner.visibilityState,
      metadata: {
        operation: 'profile_save',
        visibilityState: performerOwner.visibilityState,
        hasBio: Boolean(bio),
        specialtyCount: specialties?.length ?? 0,
        hasBookingEmail: Boolean(bookingEmail),
        hasBookingPhone: Boolean(bookingPhone),
        linkCount: normalizedLinks.provided ? normalizedLinks.links.length : null,
        primaryRole: primaryRole || null
      }
    });

    const links = await tx
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

    return { links, metadata: nextMetadata };
  });

  return res.status(202).json({
    success: true,
    profile: {
      performerId: performerOwner.performerId,
      handle: performerOwner.handle,
      displayName: performerOwner.displayName,
      bio,
      visibilityState: performerOwner.visibilityState,
      headline,
      stageName: normalizePublicProfileText(
        savedLinks.metadata && typeof savedLinks.metadata === 'object'
          ? (savedLinks.metadata as Record<string, unknown>).stageName
          : null,
        80
      ),
      primaryRole: resolvePublicPrimaryRole(savedLinks.metadata),
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
      links: savedLinks.links
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

app.get('/api/talent/library/tracks', async (req, res) => {
  applyNoStoreHeaders(res);
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) {
    return res.status(talentAccess.status).json({ error: talentAccess.reason });
  }
  if (!talentAccess.actor.actorId || !businessDb) {
    return res.status(503).json({ error: 'Your music requires a durable database connection.' });
  }

  const performerOwner = await loadOwnedPerformerByActorUserId(talentAccess.actor.actorId);
  if (!performerOwner) {
    return res.status(403).json({ error: 'Only the performer owner can view this library.' });
  }

  const [libraryRows, catalogRows] = await Promise.all([
    businessDb
      .select({
        id: performerLibraryTracks.id,
        externalTrackId: performerLibraryTracks.externalTrackId,
        title: performerLibraryTracks.title,
        artist: performerLibraryTracks.artist,
        album: performerLibraryTracks.album,
        artworkUrl: performerLibraryTracks.artworkUrl,
        sourceLabel: performerLibraryTracks.sourceLabel
      })
      .from(performerLibraryTracks)
      .where(eq(performerLibraryTracks.performerId, performerOwner.performerId))
      .orderBy(desc(performerLibraryTracks.updatedAt))
      .limit(100),
    loadRequestableCatalogTracks(businessDb, { performerId: performerOwner.performerId, limit: 100 })
  ]);

  return res.json({
    catalog: {
      category: 'sway_catalog',
      label: 'Catalog audio',
      playbackBoundary: 'sway_stored_audio',
      tracks: catalogRows.map((row: any) => ({
        id: `catalog:${row.id}`,
        title: row.title || row.filename,
        artist: performerOwner.displayName,
        album: row.projectTitle,
        artworkUrl: null,
        sourceLabel: 'Catalog',
        sourceKey: 'catalog'
      }))
    },
    external: {
      category: 'external_request_music',
      label: 'External request music',
      playbackBoundary: 'external_source_required',
      tracks: libraryRows.map((row) => ({ ...row, sourceKey: 'external' }))
    }
  });
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
      error: 'Private audio object storage is not configured or verified.'
    });
    return false;
  }
  return true;
}

app.get('/api/talent/audio/storage-usage', async (req, res) => {
  applyNoStoreHeaders(res);
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) return res.status(talentAccess.status).json({ error: talentAccess.reason });
  if (!talentAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireAudioPublishingRuntime(res) || !audioPublishingService) return;

  const performerOwner = await loadOwnedPerformerByActorUserId(talentAccess.actor.actorId);
  if (!performerOwner) return res.status(403).json({ error: 'Only the performer owner can view release workspace usage.' });

  try {
    const storageUsage = await audioPublishingService.getStorageUsage({
      performerId: performerOwner.performerId
    });
    return res.json({ storageUsage });
  } catch (error) {
    return res.status(503).json({
      error: error instanceof Error ? error.message : 'Release workspace usage is temporarily unavailable.'
    });
  }
});

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

app.get('/api/talent/audio/releases', async (req, res) => {
  applyNoStoreHeaders(res);
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) return res.status(talentAccess.status).json({ error: talentAccess.reason });
  if (!talentAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireAudioPublishingRuntime(res) || !audioPublishingService) return;

  const performerOwner = await loadOwnedPerformerByActorUserId(talentAccess.actor.actorId);
  if (!performerOwner) return res.status(403).json({ error: 'Only the performer owner can manage releases.' });

  try {
    const workspace = await audioPublishingService.listReleaseWorkspace({
      performerId: performerOwner.performerId,
      actorUserId: talentAccess.actor.actorId
    });
    return res.json({ performer: { displayName: performerOwner.displayName }, ...workspace });
  } catch (error) {
    return res.status(503).json({ error: error instanceof Error ? error.message : 'Release drafts are temporarily unavailable.' });
  }
});

app.post('/api/talent/audio/releases', async (req, res) => {
  applyNoStoreHeaders(res);
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) return res.status(talentAccess.status).json({ error: talentAccess.reason });
  if (!talentAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireAudioPublishingRuntime(res) || !audioPublishingService) return;

  const performerOwner = await loadOwnedPerformerByActorUserId(talentAccess.actor.actorId);
  if (!performerOwner) return res.status(403).json({ error: 'Only the performer owner can create releases.' });

  try {
    const result = await audioPublishingService.createReleaseDraft({
      clientReleaseId: typeof req.body?.clientReleaseId === 'string' ? req.body.clientReleaseId : '',
      performerId: performerOwner.performerId,
      actorUserId: talentAccess.actor.actorId,
      projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : '',
      masterAssetVersionId: typeof req.body?.masterAssetVersionId === 'string' ? req.body.masterAssetVersionId : '',
      title: typeof req.body?.title === 'string' ? req.body.title : '',
      trackTitle: typeof req.body?.trackTitle === 'string' ? req.body.trackTitle : '',
      versionTitle: typeof req.body?.versionTitle === 'string' ? req.body.versionTitle : null,
      primaryArtistName: typeof req.body?.primaryArtistName === 'string' ? req.body.primaryArtistName : '',
      songwriterName: typeof req.body?.songwriterName === 'string' ? req.body.songwriterName : '',
      releaseType: typeof req.body?.releaseType === 'string' ? req.body.releaseType : '',
      upc: typeof req.body?.upc === 'string' ? req.body.upc : null,
      isrc: typeof req.body?.isrc === 'string' ? req.body.isrc : null,
      labelName: typeof req.body?.labelName === 'string' ? req.body.labelName : null,
      pLine: typeof req.body?.pLine === 'string' ? req.body.pLine : null,
      cLine: typeof req.body?.cLine === 'string' ? req.body.cLine : null,
      originalReleaseDate: typeof req.body?.originalReleaseDate === 'string' ? req.body.originalReleaseDate : null,
      territories: Array.isArray(req.body?.territories)
        ? req.body.territories.filter((value: unknown): value is string => typeof value === 'string')
        : null,
      isExplicit: req.body?.isExplicit === true,
      languageCode: typeof req.body?.languageCode === 'string' ? req.body.languageCode : null,
      lyricsAuthorship: typeof req.body?.lyricsAuthorship === 'string' ? req.body.lyricsAuthorship : null,
      compositionAuthorship: typeof req.body?.compositionAuthorship === 'string' ? req.body.compositionAuthorship : null,
      vocalPerformance: typeof req.body?.vocalPerformance === 'string' ? req.body.vocalPerformance : null,
      productionMethod: typeof req.body?.productionMethod === 'string' ? req.body.productionMethod : null,
      lyricsExcerpt: typeof req.body?.lyricsExcerpt === 'string' ? req.body.lyricsExcerpt : null
    });
    return res.status(result.created ? 201 : 200).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not create release draft.';
    const status = /permission|required audio master|owned by this performer|another account/i.test(message) ? 403 : 422;
    return res.status(status).json({ error: message });
  }
});

app.patch('/api/talent/audio/releases/:releaseId', async (req, res) => {
  applyNoStoreHeaders(res);
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) return res.status(talentAccess.status).json({ error: talentAccess.reason });
  if (!talentAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireAudioPublishingRuntime(res) || !audioPublishingService) return;
  const performerOwner = await loadOwnedPerformerByActorUserId(talentAccess.actor.actorId);
  if (!performerOwner) return res.status(403).json({ error: 'Only the performer owner can edit releases.' });
  try {
    const result = await audioPublishingService.updateReleaseDraft({
      releaseId: req.params.releaseId,
      performerId: performerOwner.performerId,
      actorUserId: talentAccess.actor.actorId,
      expectedUpdatedAt: typeof req.body?.expectedUpdatedAt === 'string' ? req.body.expectedUpdatedAt : null,
      artworkAssetVersionId: typeof req.body?.artworkAssetVersionId === 'string' ? req.body.artworkAssetVersionId : null,
      title: typeof req.body?.title === 'string' ? req.body.title : '',
      trackTitle: typeof req.body?.trackTitle === 'string' ? req.body.trackTitle : '',
      versionTitle: typeof req.body?.versionTitle === 'string' ? req.body.versionTitle : null,
      primaryArtistName: typeof req.body?.primaryArtistName === 'string' ? req.body.primaryArtistName : '',
      releaseType: typeof req.body?.releaseType === 'string' ? req.body.releaseType : '',
      distributionMode: typeof req.body?.distributionMode === 'string' ? req.body.distributionMode : 'private',
      upc: typeof req.body?.upc === 'string' ? req.body.upc : null,
      isrc: typeof req.body?.isrc === 'string' ? req.body.isrc : null,
      labelName: typeof req.body?.labelName === 'string' ? req.body.labelName : null,
      pLine: typeof req.body?.pLine === 'string' ? req.body.pLine : null,
      cLine: typeof req.body?.cLine === 'string' ? req.body.cLine : null,
      originalReleaseDate: typeof req.body?.originalReleaseDate === 'string' ? req.body.originalReleaseDate : null,
      scheduledReleaseAt: typeof req.body?.scheduledReleaseAt === 'string' ? req.body.scheduledReleaseAt : null,
      territories: Array.isArray(req.body?.territories) ? req.body.territories.filter((value: unknown): value is string => typeof value === 'string') : null,
      isExplicit: req.body?.isExplicit === true,
      languageCode: typeof req.body?.languageCode === 'string' ? req.body.languageCode : null,
      credits: Array.isArray(req.body?.credits) ? req.body.credits : null,
      lyricsAuthorship: typeof req.body?.lyricsAuthorship === 'string' ? req.body.lyricsAuthorship : null,
      compositionAuthorship: typeof req.body?.compositionAuthorship === 'string' ? req.body.compositionAuthorship : null,
      vocalPerformance: typeof req.body?.vocalPerformance === 'string' ? req.body.vocalPerformance : null,
      productionMethod: typeof req.body?.productionMethod === 'string' ? req.body.productionMethod : null,
      lyricsExcerpt: typeof req.body?.lyricsExcerpt === 'string' ? req.body.lyricsExcerpt : null
    });
    return res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not update release draft.';
    const status = /permission|owner|not found/i.test(message) ? 403 : /another session/i.test(message) ? 409 : 422;
    return res.status(status).json({ error: message });
  }
});

app.post('/api/talent/audio/releases/:releaseId/recordings', async (req, res) => {
  applyNoStoreHeaders(res);
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) return res.status(talentAccess.status).json({ error: talentAccess.reason });
  if (!talentAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireAudioPublishingRuntime(res) || !audioPublishingService) return;
  const performerOwner = await loadOwnedPerformerByActorUserId(talentAccess.actor.actorId);
  if (!performerOwner) return res.status(403).json({ error: 'Only the performer owner can add release tracks.' });
  try {
    const result = await audioPublishingService.addReleaseRecording({
      releaseId: req.params.releaseId,
      clientRecordingId: typeof req.body?.clientRecordingId === 'string' ? req.body.clientRecordingId : '',
      performerId: performerOwner.performerId,
      actorUserId: talentAccess.actor.actorId,
      expectedUpdatedAt: typeof req.body?.expectedUpdatedAt === 'string' ? req.body.expectedUpdatedAt : null,
      masterAssetVersionId: typeof req.body?.masterAssetVersionId === 'string' ? req.body.masterAssetVersionId : '',
      title: typeof req.body?.title === 'string' ? req.body.title : '',
      versionTitle: typeof req.body?.versionTitle === 'string' ? req.body.versionTitle : null,
      primaryArtistName: typeof req.body?.primaryArtistName === 'string' ? req.body.primaryArtistName : '',
      isrc: typeof req.body?.isrc === 'string' ? req.body.isrc : null,
      isExplicit: req.body?.isExplicit === true,
      languageCode: typeof req.body?.languageCode === 'string' ? req.body.languageCode : null,
      originalReleaseDate: typeof req.body?.originalReleaseDate === 'string' ? req.body.originalReleaseDate : null,
      credits: Array.isArray(req.body?.credits) ? req.body.credits : null,
      lyricsAuthorship: typeof req.body?.lyricsAuthorship === 'string' ? req.body.lyricsAuthorship : null,
      compositionAuthorship: typeof req.body?.compositionAuthorship === 'string' ? req.body.compositionAuthorship : null,
      vocalPerformance: typeof req.body?.vocalPerformance === 'string' ? req.body.vocalPerformance : null,
      productionMethod: typeof req.body?.productionMethod === 'string' ? req.body.productionMethod : null,
      lyricsExcerpt: typeof req.body?.lyricsExcerpt === 'string' ? req.body.lyricsExcerpt : null
    });
    return res.status(result.created ? 201 : 200).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not add release track.';
    const status = /permission|owner|another release or account|verified audio master/i.test(message)
      ? 403
      : /another session|already part|sealed/i.test(message)
        ? 409
        : /not found/i.test(message)
          ? 404
          : 422;
    return res.status(status).json({ error: message });
  }
});

app.patch('/api/talent/audio/releases/:releaseId/recordings/:recordingId', async (req, res) => {
  applyNoStoreHeaders(res);
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) return res.status(talentAccess.status).json({ error: talentAccess.reason });
  if (!talentAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireAudioPublishingRuntime(res) || !audioPublishingService) return;
  const performerOwner = await loadOwnedPerformerByActorUserId(talentAccess.actor.actorId);
  if (!performerOwner) return res.status(403).json({ error: 'Only the performer owner can edit release tracks.' });
  try {
    const result = await audioPublishingService.updateReleaseRecording({
      releaseId: req.params.releaseId,
      recordingId: req.params.recordingId,
      performerId: performerOwner.performerId,
      actorUserId: talentAccess.actor.actorId,
      expectedUpdatedAt: typeof req.body?.expectedUpdatedAt === 'string' ? req.body.expectedUpdatedAt : null,
      title: typeof req.body?.title === 'string' ? req.body.title : '',
      versionTitle: typeof req.body?.versionTitle === 'string' ? req.body.versionTitle : null,
      primaryArtistName: typeof req.body?.primaryArtistName === 'string' ? req.body.primaryArtistName : '',
      isrc: typeof req.body?.isrc === 'string' ? req.body.isrc : null,
      isExplicit: req.body?.isExplicit === true,
      languageCode: typeof req.body?.languageCode === 'string' ? req.body.languageCode : null,
      originalReleaseDate: typeof req.body?.originalReleaseDate === 'string' ? req.body.originalReleaseDate : null,
      credits: Array.isArray(req.body?.credits) ? req.body.credits : null
    });
    return res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not update release track.';
    const status = /permission|owner/i.test(message)
      ? 403
      : /another session|sealed/i.test(message)
        ? 409
        : /not found/i.test(message)
          ? 404
          : 422;
    return res.status(status).json({ error: message });
  }
});

app.put('/api/talent/audio/releases/:releaseId/recordings/order', async (req, res) => {
  applyNoStoreHeaders(res);
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) return res.status(talentAccess.status).json({ error: talentAccess.reason });
  if (!talentAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireAudioPublishingRuntime(res) || !audioPublishingService) return;
  const performerOwner = await loadOwnedPerformerByActorUserId(talentAccess.actor.actorId);
  if (!performerOwner) return res.status(403).json({ error: 'Only the performer owner can reorder release tracks.' });
  try {
    const result = await audioPublishingService.reorderReleaseRecordings({
      releaseId: req.params.releaseId,
      performerId: performerOwner.performerId,
      actorUserId: talentAccess.actor.actorId,
      expectedUpdatedAt: typeof req.body?.expectedUpdatedAt === 'string' ? req.body.expectedUpdatedAt : null,
      recordingIds: Array.isArray(req.body?.recordingIds)
        ? req.body.recordingIds.filter((value: unknown): value is string => typeof value === 'string')
        : []
    });
    return res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not reorder release tracks.';
    const status = /permission|owner/i.test(message)
      ? 403
      : /another session|sealed/i.test(message)
        ? 409
        : /not found/i.test(message)
          ? 404
          : 422;
    return res.status(status).json({ error: message });
  }
});

app.delete('/api/talent/audio/releases/:releaseId/recordings/:recordingId', async (req, res) => {
  applyNoStoreHeaders(res);
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) return res.status(talentAccess.status).json({ error: talentAccess.reason });
  if (!talentAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireAudioPublishingRuntime(res) || !audioPublishingService) return;
  const performerOwner = await loadOwnedPerformerByActorUserId(talentAccess.actor.actorId);
  if (!performerOwner) return res.status(403).json({ error: 'Only the performer owner can remove release tracks.' });
  try {
    const result = await audioPublishingService.removeReleaseRecording({
      releaseId: req.params.releaseId,
      recordingId: req.params.recordingId,
      performerId: performerOwner.performerId,
      actorUserId: talentAccess.actor.actorId,
      expectedUpdatedAt: typeof req.body?.expectedUpdatedAt === 'string' ? req.body.expectedUpdatedAt : null
    });
    return res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not remove release track.';
    const status = /permission|owner/i.test(message)
      ? 403
      : /another session|sealed|rights evidence/i.test(message)
        ? 409
        : /not found/i.test(message)
          ? 404
          : 422;
    return res.status(status).json({ error: message });
  }
});

app.post('/api/talent/audio/releases/:releaseId/rights', async (req, res) => {
  applyNoStoreHeaders(res);
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) return res.status(talentAccess.status).json({ error: talentAccess.reason });
  if (!talentAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireAudioPublishingRuntime(res) || !audioPublishingService) return;
  const performerOwner = await loadOwnedPerformerByActorUserId(talentAccess.actor.actorId);
  if (!performerOwner) return res.status(403).json({ error: 'Only the performer owner can declare release rights.' });
  try {
    const declaration = await audioPublishingService.createRightsDeclaration({
      releaseId: req.params.releaseId,
      performerId: performerOwner.performerId,
      actorUserId: talentAccess.actor.actorId,
      declarationType: typeof req.body?.declarationType === 'string' ? req.body.declarationType : '',
      termsDocumentAssetVersionId: typeof req.body?.termsDocumentAssetVersionId === 'string' ? req.body.termsDocumentAssetVersionId : '',
      termsVersion: typeof req.body?.termsVersion === 'string' ? req.body.termsVersion : '',
      declarationText: typeof req.body?.declarationText === 'string' ? req.body.declarationText : '',
      evidenceNote: typeof req.body?.evidenceNote === 'string' ? req.body.evidenceNote : '',
      recordingId: typeof req.body?.recordingId === 'string' ? req.body.recordingId : null
    });
    return res.status(201).json({ declaration });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not record rights evidence.';
    return res.status(/permission|owner|not found/i.test(message) ? 403 : 422).json({ error: message });
  }
});

app.post('/api/talent/audio/projects/:projectId/release-reviewers', async (req, res) => {
  applyNoStoreHeaders(res);
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) return res.status(talentAccess.status).json({ error: talentAccess.reason });
  if (!talentAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireAudioPublishingRuntime(res) || !audioPublishingService) return;
  try {
    const result = await audioPublishingService.grantReleaseReviewer({
      projectId: req.params.projectId,
      connectionId: typeof req.body?.connectionId === 'string' ? req.body.connectionId : '',
      actorUserId: talentAccess.actor.actorId
    });
    return res.status(result.reused ? 200 : 201).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not add release reviewer.';
    return res.status(/permission|connection required/i.test(message) ? 403 : 422).json({ error: message });
  }
});

app.get('/api/talent/audio/rights/review-queue', async (req, res) => {
  applyNoStoreHeaders(res);
  const accountAccess = await accessControl.requireAuthenticatedAccountAccess(req);
  if (accountAccess.allowed === false) return res.status(accountAccess.status).json({ error: accountAccess.reason });
  if (!accountAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireAudioPublishingRuntime(res) || !audioPublishingService) return;
  try {
    const declarations = await audioPublishingService.listRightsReviewQueue({ actorUserId: accountAccess.actor.actorId });
    return res.json({ declarations });
  } catch (error) {
    return res.status(503).json({ error: error instanceof Error ? error.message : 'Rights review queue is temporarily unavailable.' });
  }
});

app.get('/api/talent/audio/rights/:declarationId/document', async (req, res) => {
  applyNoStoreHeaders(res);
  const accountAccess = await accessControl.requireAuthenticatedAccountAccess(req);
  if (accountAccess.allowed === false) return res.status(accountAccess.status).json({ error: accountAccess.reason });
  if (!accountAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireAudioPublishingRuntime(res) || !audioPublishingService) return;

  try {
    const opened = await audioPublishingService.openRightsReviewDocument({
      declarationId: req.params.declarationId,
      actorUserId: accountAccess.actor.actorId
    });
    res.setHeader('Content-Type', opened.version.mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', String(opened.byteSize));
    res.setHeader('Content-Disposition', `attachment; filename="${opened.version.originalFilename.replace(/["\r\n]/g, '')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Sway-Asset-Sha256', opened.version.sha256);
    opened.stream.pipe(res);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Rights evidence document access denied.';
    return res.status(/not found/i.test(message) ? 404 : 403).json({ error: message });
  }
});

app.post('/api/talent/audio/rights/:declarationId/review', async (req, res) => {
  applyNoStoreHeaders(res);
  const accountAccess = await accessControl.requireAuthenticatedAccountAccess(req);
  if (accountAccess.allowed === false) return res.status(accountAccess.status).json({ error: accountAccess.reason });
  if (!accountAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireAudioPublishingRuntime(res) || !audioPublishingService) return;
  const outcome = req.body?.outcome === 'verified' || req.body?.outcome === 'rejected' ? req.body.outcome : null;
  if (!outcome) return res.status(422).json({ error: 'Rights review outcome must be verified or rejected.' });
  try {
    const event = await audioPublishingService.reviewRightsDeclaration({
      declarationId: req.params.declarationId,
      actorUserId: accountAccess.actor.actorId,
      outcome,
      reason: typeof req.body?.reason === 'string' ? req.body.reason : ''
    });
    return res.status(201).json({ event });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not review rights evidence.';
    const status = /permission|independent|not found/i.test(message) ? 403 : /already has/i.test(message) ? 409 : 422;
    return res.status(status).json({ error: message });
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

app.post('/api/talent/audio/assets/:assetId/requestable', async (req, res) => {
  applyNoStoreHeaders(res);
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) return res.status(talentAccess.status).json({ error: talentAccess.reason });
  if (!talentAccess.actor.actorId || !businessDb) return res.status(503).json({ error: 'Catalog access requires a durable database connection.' });

  const performerOwner = await loadOwnedPerformerByActorUserId(talentAccess.actor.actorId);
  if (!performerOwner) return res.status(403).json({ error: 'Only the performer owner can change request availability.' });

  const [asset] = await businessDb
    .select({ id: audioAssets.id, metadata: audioAssets.metadata })
    .from(audioAssets)
    .innerJoin(audioProjects, eq(audioProjects.id, audioAssets.projectId))
    .where(and(
      eq(audioAssets.id, req.params.assetId),
      eq(audioProjects.performerId, performerOwner.performerId)
    ))
    .limit(1);
  if (!asset) return res.status(404).json({ error: 'Catalog track not found.' });

  const requestable = req.body?.requestable === true;
  const metadata = asset.metadata && typeof asset.metadata === 'object' && !Array.isArray(asset.metadata)
    ? asset.metadata as Record<string, unknown>
    : {};
  await businessDb
    .update(audioAssets)
    .set({ metadata: { ...metadata, requestable }, updatedAt: new Date() })
    .where(eq(audioAssets.id, asset.id));

  return res.json({ success: true, assetId: asset.id, requestable });
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
    if (error instanceof AudioStorageQuotaError) {
      return res.status(413).json({
        error: 'This file does not fit in the performer release workspace.',
        code: error.code,
        workspaceLimitBytes: error.workspaceLimitBytes,
        workingBytes: error.workingBytes,
        requestedBytes: error.requestedBytes,
        availableWorkspaceBytes: error.availableWorkspaceBytes,
        releaseCountLimit: null
      });
    }
    if (error instanceof AudioStorageObjectLimitError) {
      return res.status(429).json({
        error: 'This performer has reached the working-file count safeguard. Ready releases are not limited.',
        code: error.code,
        workingObjectCount: error.workingObjectCount,
        workingObjectLimit: error.workingObjectLimit,
        releaseCountLimit: null
      });
    }
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
  if (!Buffer.isBuffer(req.body)) {
    return res.status(415).json({ error: 'Upload parts require Content-Type: application/octet-stream.' });
  }
  const body = req.body;
  if (!body.byteLength || body.byteLength > AUDIO_UPLOAD_PART_MAX_BYTES) {
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

app.get('/api/talent/audio/versions/:versionId/content', async (req, res) => {
  applyNoStoreHeaders(res);
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) return res.status(talentAccess.status).json({ error: talentAccess.reason });
  if (!talentAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireAudioPublishingRuntime(res) || !audioPublishingService) return;

  try {
    const opened = await audioPublishingService.openOwnedVersion({
      versionId: req.params.versionId,
      actorUserId: talentAccess.actor.actorId
    });
    res.setHeader('Content-Type', opened.version.mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', String(opened.byteSize));
    res.setHeader('Content-Disposition', `inline; filename="${opened.version.originalFilename.replace(/"/g, '')}"`);
    res.setHeader('X-Sway-Asset-Sha256', opened.version.sha256);
    opened.stream.pipe(res);
  } catch (error) {
    return res.status(403).json({ error: error instanceof Error ? error.message : 'Catalog audio access denied.' });
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

function requireFilePairingRuntime(res: express.Response): boolean {
  if (!AUDIO_PUBLISHING_RUNTIME_CAPABILITIES.fileConnectionQrRoutes) {
    res.status(503).json({ error: 'Private file-pairing QR routes are not enabled.' });
    return false;
  }
  if (!businessDb || !audioFilePairingService) {
    res.status(503).json({ error: 'File pairing requires durable database persistence.' });
    return false;
  }
  return true;
}

function requireFileCollaborationRuntime(res: express.Response): boolean {
  if (!AUDIO_PUBLISHING_RUNTIME_CAPABILITIES.fileConnectionQrRoutes) {
    res.status(503).json({ error: 'Private file collaboration routes are not enabled.' });
    return false;
  }
  if (!businessDb || !audioFileCollaborationService || !audioObjectStore) {
    res.status(503).json({ error: 'File collaboration requires durable database and private object storage.' });
    return false;
  }
  return true;
}

app.post('/api/talent/audio/pairing/tokens', async (req, res) => {
  applyNoStoreHeaders(res);
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) return res.status(talentAccess.status).json({ error: talentAccess.reason });
  if (!talentAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireFilePairingRuntime(res) || !audioFilePairingService) return;

  try {
    const issued = await audioFilePairingService.createPairingToken({
      createdByUserId: talentAccess.actor.actorId,
      purpose: req.body?.purpose,
      tokenHash: req.body?.tokenHash,
      idempotencyKey: req.body?.idempotencyKey,
      connectionLabel: req.body?.connectionLabel
    });
    return res.status(issued.reused ? 200 : 201).json(issued);
  } catch (error) {
    const status = typeof (error as { status?: number })?.status === 'number'
      ? (error as { status: number }).status
      : 400;
    return res.status(status).json({ error: error instanceof Error ? error.message : 'Unable to create pairing QR.' });
  }
});

app.post('/api/talent/audio/pairing/preview', async (req, res) => {
  applyNoStoreHeaders(res);
  const accountAccess = await accessControl.requireAuthenticatedAccountAccess(req);
  if (accountAccess.allowed === false) return res.status(accountAccess.status).json({ error: accountAccess.reason });
  if (!accountAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireFilePairingRuntime(res) || !audioFilePairingService) return;

  const rawToken = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (!rawToken) return res.status(422).json({ error: 'token is required in the POST body.' });

  try {
    const preview = await audioFilePairingService.previewPairingToken({
      claimingUserId: accountAccess.actor.actorId,
      rawToken
    });
    return res.json(preview);
  } catch (error) {
    const status = typeof (error as { status?: number })?.status === 'number'
      ? (error as { status: number }).status
      : 410;
    return res.status(status).json({ error: error instanceof Error ? error.message : 'Unable to preview pairing QR.' });
  }
});

app.post('/api/talent/audio/pairing/claim', async (req, res) => {
  applyNoStoreHeaders(res);
  const accountAccess = await accessControl.requireAuthenticatedAccountAccess(req);
  if (accountAccess.allowed === false) return res.status(accountAccess.status).json({ error: accountAccess.reason });
  if (!accountAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireFilePairingRuntime(res) || !audioFilePairingService) return;

  const rawToken = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (!rawToken) return res.status(422).json({ error: 'token is required in the POST body.' });

  try {
    const claimed = await audioFilePairingService.claimPairingToken({
      claimingUserId: accountAccess.actor.actorId,
      rawToken
    });
    return res.json(claimed);
  } catch (error) {
    const status = typeof (error as { status?: number })?.status === 'number'
      ? (error as { status: number }).status
      : 410;
    return res.status(status).json({ error: error instanceof Error ? error.message : 'Unable to claim pairing QR.' });
  }
});

app.get('/api/talent/audio/pairing/connections', async (req, res) => {
  applyNoStoreHeaders(res);
  const accountAccess = await accessControl.requireAuthenticatedAccountAccess(req);
  if (accountAccess.allowed === false) return res.status(accountAccess.status).json({ error: accountAccess.reason });
  if (!accountAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireFilePairingRuntime(res) || !audioFilePairingService) return;

  const connections = await audioFilePairingService.listConnections({ userId: accountAccess.actor.actorId });
  return res.json({ connections });
});

app.post('/api/talent/audio/pairing/connections/:connectionId/shares', async (req, res) => {
  applyNoStoreHeaders(res);
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) return res.status(talentAccess.status).json({ error: talentAccess.reason });
  if (!talentAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireFileCollaborationRuntime(res) || !audioFileCollaborationService) return;

  try {
    const result = await audioFileCollaborationService.shareVersion({
      connectionId: String(req.params.connectionId || ''),
      versionId: typeof req.body?.versionId === 'string' ? req.body.versionId : '',
      grantedByUserId: talentAccess.actor.actorId,
      canDownloadOriginal: req.body?.canDownloadOriginal !== false,
      canComment: req.body?.canComment !== false,
      canApprove: req.body?.canApprove !== false,
      expiresAt: typeof req.body?.expiresAt === 'string' ? new Date(req.body.expiresAt) : null
    });
    return res.status(result.reused ? 200 : 201).json({
      grantId: result.grant.id,
      connectionId: result.grant.connectionId,
      versionId: result.grant.assetVersionId,
      granteeUserId: result.grant.granteeUserId,
      canDownloadOriginal: result.grant.canDownloadOriginal,
      canComment: result.grant.canComment,
      canApprove: result.grant.canApprove,
      expiresAt: result.grant.expiresAt,
      reused: result.reused
    });
  } catch (error) {
    const status = typeof (error as { status?: number })?.status === 'number'
      ? (error as { status: number }).status
      : 422;
    return res.status(status).json({ error: error instanceof Error ? error.message : 'Unable to share selected file.' });
  }
});

app.get('/api/talent/audio/files/shared-with-me', async (req, res) => {
  applyNoStoreHeaders(res);
  const accountAccess = await accessControl.requireAuthenticatedAccountAccess(req);
  if (accountAccess.allowed === false) return res.status(accountAccess.status).json({ error: accountAccess.reason });
  if (!accountAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireFileCollaborationRuntime(res) || !audioFileCollaborationService) return;

  try {
    const files = await audioFileCollaborationService.listSharedWithMe({ userId: accountAccess.actor.actorId });
    return res.json({ files });
  } catch (error) {
    console.error('[sway.audio] failed to list files shared with account.', error);
    return res.status(503).json({ error: 'Shared files are temporarily unavailable.' });
  }
});

app.get('/api/talent/audio/files/shared-by-me', async (req, res) => {
  applyNoStoreHeaders(res);
  const accountAccess = await accessControl.requireAuthenticatedAccountAccess(req);
  if (accountAccess.allowed === false) return res.status(accountAccess.status).json({ error: accountAccess.reason });
  if (!accountAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireFileCollaborationRuntime(res) || !audioFileCollaborationService) return;

  try {
    const files = await audioFileCollaborationService.listSharedByMe({ userId: accountAccess.actor.actorId });
    return res.json({ files });
  } catch (error) {
    console.error('[sway.audio] failed to list files shared by account.', error);
    return res.status(503).json({ error: 'Shared files are temporarily unavailable.' });
  }
});

app.get('/api/talent/audio/file-grants/:grantId/download', async (req, res) => {
  applyNoStoreHeaders(res);
  const accountAccess = await accessControl.requireAuthenticatedAccountAccess(req);
  if (accountAccess.allowed === false) return res.status(accountAccess.status).json({ error: accountAccess.reason });
  if (!accountAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireFileCollaborationRuntime(res) || !audioFileCollaborationService) return;

  try {
    const downloaded = await audioFileCollaborationService.downloadGrantedOriginal({
      grantId: String(req.params.grantId || ''),
      userId: accountAccess.actor.actorId
    });
    res.setHeader('Content-Type', downloaded.version.mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', String(downloaded.byteSize));
    res.setHeader('Content-Disposition', `attachment; filename="${downloaded.version.originalFilename.replace(/"/g, '')}"`);
    res.setHeader('X-Sway-Asset-Sha256', downloaded.version.sha256);
    downloaded.stream.pipe(res);
  } catch (error) {
    const status = typeof (error as { status?: number })?.status === 'number'
      ? (error as { status: number }).status
      : 403;
    return res.status(status).json({ error: error instanceof Error ? error.message : 'File download denied.' });
  }
});

app.get('/api/talent/audio/file-grants/:grantId/reviews', async (req, res) => {
  applyNoStoreHeaders(res);
  const accountAccess = await accessControl.requireAuthenticatedAccountAccess(req);
  if (accountAccess.allowed === false) return res.status(accountAccess.status).json({ error: accountAccess.reason });
  if (!accountAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireFileCollaborationRuntime(res) || !audioFileCollaborationService) return;

  try {
    const events = await audioFileCollaborationService.listReviewEvents({
      grantId: String(req.params.grantId || ''),
      userId: accountAccess.actor.actorId
    });
    return res.json({ events });
  } catch (error) {
    const status = typeof (error as { status?: number })?.status === 'number'
      ? (error as { status: number }).status
      : 403;
    return res.status(status).json({ error: error instanceof Error ? error.message : 'Review access denied.' });
  }
});

app.post('/api/talent/audio/file-grants/:grantId/reviews', async (req, res) => {
  applyNoStoreHeaders(res);
  const accountAccess = await accessControl.requireAuthenticatedAccountAccess(req);
  if (accountAccess.allowed === false) return res.status(accountAccess.status).json({ error: accountAccess.reason });
  if (!accountAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireFileCollaborationRuntime(res) || !audioFileCollaborationService) return;

  try {
    const event = await audioFileCollaborationService.addReviewEvent({
      grantId: String(req.params.grantId || ''),
      userId: accountAccess.actor.actorId,
      eventType: req.body?.eventType,
      body: req.body?.body,
      timecodeMs: req.body?.timecodeMs,
      supersedesEventId: req.body?.supersedesEventId
    });
    return res.status(201).json({ event });
  } catch (error) {
    const status = typeof (error as { status?: number })?.status === 'number'
      ? (error as { status: number }).status
      : 422;
    return res.status(status).json({ error: error instanceof Error ? error.message : 'Unable to record review.' });
  }
});

app.post('/api/talent/audio/file-grants/:grantId/revoke', async (req, res) => {
  applyNoStoreHeaders(res);
  const accountAccess = await accessControl.requireAuthenticatedAccountAccess(req);
  if (accountAccess.allowed === false) return res.status(accountAccess.status).json({ error: accountAccess.reason });
  if (!accountAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireFileCollaborationRuntime(res) || !audioFileCollaborationService) return;

  try {
    const revoked = await audioFileCollaborationService.revokeGrant({
      grantId: String(req.params.grantId || ''),
      userId: accountAccess.actor.actorId,
      reason: typeof req.body?.reason === 'string' ? req.body.reason : null
    });
    return res.json(revoked);
  } catch (error) {
    const status = typeof (error as { status?: number })?.status === 'number'
      ? (error as { status: number }).status
      : 400;
    return res.status(status).json({ error: error instanceof Error ? error.message : 'Unable to revoke file access.' });
  }
});

app.post('/api/talent/audio/pairing/connections/:connectionId/revoke', async (req, res) => {
  applyNoStoreHeaders(res);
  const accountAccess = await accessControl.requireAuthenticatedAccountAccess(req);
  if (accountAccess.allowed === false) return res.status(accountAccess.status).json({ error: accountAccess.reason });
  if (!accountAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireFilePairingRuntime(res) || !audioFilePairingService) return;

  try {
    const revoked = await audioFilePairingService.revokeConnection({
      userId: accountAccess.actor.actorId,
      connectionId: String(req.params.connectionId || ''),
      reason: typeof req.body?.reason === 'string' ? req.body.reason : null
    });
    return res.json(revoked);
  } catch (error) {
    const status = typeof (error as { status?: number })?.status === 'number'
      ? (error as { status: number }).status
      : 400;
    return res.status(status).json({ error: error instanceof Error ? error.message : 'Unable to revoke connection.' });
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
function resolveStripeConnectOnboardingUrls() {
  const appBaseUrl = resolvePerformerLoginBaseUrl(process.env).replace(/\/+$/, '');
  return {
    refreshUrl: `${appBaseUrl}/talent/connect/refresh`,
    returnUrl: `${appBaseUrl}/talent/connect/return`
  };
}

async function createStripeConnectOnboardingUrl(accountId: string) {
  if (!stripeConnectService) throw new Error('stripe_connect_unavailable');
  const { refreshUrl, returnUrl } = resolveStripeConnectOnboardingUrls();
  return stripeConnectService.createOnboardingLink({ accountId, refreshUrl, returnUrl });
}

app.post('/api/talent/connect/onboard', async (req, res) => {
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) {
    return res.status(talentAccess.status).json({ error: talentAccess.reason });
  }
  if (!talentAccess.actor.actorId || !businessDb) {
    return res.status(503).json({ error: 'Performer payouts require a durable database connection.' });
  }
  if (!stripeConnectService || !stripeConnectOnboardingStore || !liveRoomPaymentRuntimeConfig.connectEnabled) {
    return res.status(503).json({ error: 'Stripe test-mode Connect onboarding is unavailable until payment execution is fully configured.' });
  }

  const performerOwner = await loadOwnedPerformerByActorUserId(talentAccess.actor.actorId);
  if (!performerOwner) {
    return res.status(403).json({ error: 'Only the performer owner can connect a payout account.' });
  }

  try {
    const provisioning = await provisionStripeConnectRecipient({
      performerId: performerOwner.performerId,
      ownerUserId: talentAccess.actor.actorId,
      store: stripeConnectOnboardingStore,
      stripe: stripeConnectService
    });
    if (provisioning.kind === 'not_found') {
      return res.status(403).json({ error: 'Only the performer owner can connect a payout account.' });
    }
    if (provisioning.kind === 'unverified') {
      return res.status(409).json({ error: 'A verified performer account email is required before Stripe onboarding.' });
    }
    if (provisioning.kind === 'busy') {
      res.setHeader('Retry-After', '2');
      return res.status(409).json({ error: 'Stripe onboarding is already being prepared. Retry in a moment.' });
    }

    const { url } = await createStripeConnectOnboardingUrl(provisioning.accountId);

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

app.get('/talent/connect/refresh', async (req, res) => {
  applyNoStoreHeaders(res);
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) {
    return res.status(talentAccess.status).send('Authenticate as the performer owner to restart Stripe onboarding.');
  }
  if (!talentAccess.actor.actorId || !businessDb || !stripeConnectService || !liveRoomPaymentRuntimeConfig.connectEnabled) {
    return res.status(503).send('Stripe onboarding is temporarily unavailable.');
  }

  const [owner] = await businessDb.select({
    stripeAccountId: performers.stripeConnectedAccountId,
    emailVerifiedAt: users.emailVerifiedAt
  }).from(performers)
    .innerJoin(users, eq(users.id, performers.ownerUserId))
    .where(eq(performers.ownerUserId, talentAccess.actor.actorId))
    .limit(1);

  if (!owner?.emailVerifiedAt) {
    return res.status(409).send('Verify the performer owner email before restarting Stripe onboarding.');
  }
  if (!owner.stripeAccountId) {
    return res.status(409).send('Start Stripe onboarding from the performer account first.');
  }

  try {
    const { url } = await createStripeConnectOnboardingUrl(owner.stripeAccountId);
    return res.redirect(303, url);
  } catch (error) {
    console.error('Stripe Connect onboarding refresh failed.', {
      message: error instanceof Error ? error.message : 'unknown_error'
    });
    return res.status(502).send('Stripe onboarding could not be restarted. Return to the performer account and try again.');
  }
});

app.get('/talent/connect/return', async (req, res) => {
  applyNoStoreHeaders(res);
  return handleStripeConnectReturn({
    req,
    res,
    runtimeAvailable: Boolean(
      businessDb
      && stripeConnectService
      && liveRoomPaymentRuntimeConfig.connectEnabled
    ),
    requireTalentAccess: (request) => accessControl.requireTalentAccess(request),
    loadOwnedPerformer: loadOwnedPerformerByActorUserId,
    getAccountStatus: (accountId) => stripeConnectService!.getAccountStatus(accountId),
    applyStatus: ({ performerId, ownerUserId, accountId, providerStatus }) => (
      reconcileStripeConnectPerformerStatus({
        db: businessDb!,
        accountId,
        status: providerStatus,
        source: 'return',
        actorId: ownerUserId,
        expectedPerformerId: performerId,
        expectedOwnerUserId: ownerUserId
      })
    ),
    logError: (error) => {
      console.error('Stripe Connect return reconciliation failed.', {
        message: error instanceof Error ? error.message : 'unknown_error'
      });
    }
  });
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
    .where(and(
      eq(performerLibrarySources.syncKeyHash, syncKeyHash),
      eq(performerLibrarySources.connectionStatus, 'active')
    ))
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

// A separate endpoint supports a dedicated Stripe ticket-webhook signing
// secret. The shared endpoint below also multiplexes ticket events when both
// payment lanes use the same endpoint/secret.
app.post('/api/payment/ticket-webhook', async (req, res) => {
  const rawBody = (req as express.Request & { rawBody?: string }).rawBody;
  if (typeof rawBody !== 'string') {
    return res.status(400).json({ error: 'Raw request body unavailable for signature verification.' });
  }
  if (!eventTicketService) {
    return res.status(503).json({ error: 'Native ticket webhook processing is unavailable.' });
  }

  try {
    const result = await eventTicketService.ingestVerifiedWebhook({
      rawBody,
      signatureHeader: req.header('stripe-signature') ?? null
    });
    return res.json({ received: true, result });
  } catch (error) {
    return respondToEventTicketServiceError(res, error, 'Ticket webhook processing failed.');
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
        return handleStripeConnectAccountStatusWebhook({
          res,
          accountEvent,
          applyStatus: (event) => reconcileStripeConnectPerformerStatus({
            db: businessDb,
            accountId: event.accountId,
            status: event.status,
            source: event.eventType.startsWith('v2.') ? 'webhook_v2' : 'webhook_v1',
            providerEventId: event.providerEventId,
            actorId: null
          })
        });
      }
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : 'Connect webhook processing failed.'
      });
    }
  }

  const ticketWebhookSecret = (
    process.env.STRIPE_TICKET_WEBHOOK_SECRET
    || process.env.STRIPE_WEBHOOK_SECRET
    || ''
  ).trim();
  const sharedTicketWebhookSecret = Boolean(
    ticketWebhookSecret
    && webhookSecret
    && ticketWebhookSecret === webhookSecret.trim()
  );
  if (
    eventTicketService
    && eventTicketService.canVerifyWebhook()
    && sharedTicketWebhookSecret
  ) {
    try {
      const ticketResult = await eventTicketService.ingestVerifiedWebhook({
        rawBody,
        signatureHeader
      });
      if (ticketResult.status !== 'not_ticket') {
        return res.json({ received: true, result: ticketResult });
      }
    } catch (error) {
      return respondToEventTicketServiceError(res, error, 'Ticket webhook processing failed.');
    }
  }

  if (!paymentWebhookService) {
    return res.status(503).json({ error: "Payment provider is not configured." });
  }
  if (!liveRoomDurabilityWritesEnabled) {
    // Ask Stripe to retry after the migration-only release has drained the
    // legacy room writer. Signature admission and event processing resume in
    // the writer-enabled release; no event is acknowledged and lost here.
    return res.status(503).json({ error: 'Live-room payment reconciliation is briefly paused.' });
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
  const talentAccess = await accessControl.requireTalentAccess(req);
  const performerProfile = talentAccess.allowed
    ? await loadAuthenticatedPerformerProfile(req)
    : null;
  applyNoStoreHeaders(res);
  return res.json({
    ...projectPublicRoomState(createEmptyBackendState(), null),
    performerProfile
  });
});

app.get('/api/public/events/:eventId', async (req, res) => {
  applyNoStoreHeaders(res);
  if (!UUID_PATTERN.test(req.params.eventId)) {
    return res.status(404).json({ error: 'Public event not found.' });
  }
  if (!performerEventService) {
    return res.status(503).json({ error: 'Public events are temporarily unavailable.' });
  }

  try {
    const event = await performerEventService.getPublicEvent(req.params.eventId);
    if (!event) return res.status(404).json({ error: 'Public event not found.' });
    return res.json({ event: await toPublicEventResponseWithTicket(event) });
  } catch (error) {
    return respondToEventServiceError(res, error, 'Unable to load this event right now.');
  }
});

app.get('/api/public/events/:eventId/ticket', async (req, res) => {
  applyNoStoreHeaders(res);
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!UUID_PATTERN.test(req.params.eventId)) {
    return res.status(404).json({ error: 'Public event not found.' });
  }
  if (!performerEventService) {
    return res.status(503).json({ error: 'Public events are temporarily unavailable.' });
  }

  try {
    const event = await performerEventService.getPublicEvent(req.params.eventId);
    if (!event || event.status !== 'published' || !event.externalTicketUrl) {
      return res.status(404).json({ error: 'External ticket link not available.' });
    }
    if (new Date(event.startsAt).getTime() <= Date.now()) {
      return res.status(410).json({ error: 'This event has already started.' });
    }

    const safeDestination = normalizePublicEventHttpsUrl(event.externalTicketUrl, 'External ticket URL');
    if (!safeDestination) {
      return res.status(422).json({ error: 'External ticket link is not safe to open.' });
    }

    return res.redirect(302, safeDestination);
  } catch (error) {
    return respondToEventServiceError(res, error, 'Unable to open the external ticket link.');
  }
});

app.get('/api/public/feed', async (_req, res) => {
  applyNoStoreHeaders(res);

  try {
    const activeRooms = await listReadableActiveRooms();
    const roomLimit = Math.max(1, Math.min(30, Number(_req.query?.limit) || 12));
    const eventLimit = Math.max(1, Math.min(30, Number(_req.query?.eventLimit) || 12));
    const releaseLimit = Math.max(1, Math.min(30, Number(_req.query?.releaseLimit) || 12));

    if (!businessDb || !performerEventService) {
      return res.status(503).json({ error: 'Public performer discovery requires durable performer status checks.' });
    }

    const gigIds = activeRooms.map((room) => room.gigId);
    const [details, publicEvents, publicReleaseRows] = await Promise.all([
      gigIds.length
        ? businessDb
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
            .innerJoin(users, eq(users.id, performers.ownerUserId))
            .leftJoin(performerPublicProfiles, eq(performerPublicProfiles.performerId, performers.id))
            .where(and(
              inArray(gigSessions.id, gigIds),
              eq(performers.isActive, true),
              notInArray(performers.onboardingStatus, ['restricted', 'suspended']),
              eq(performers.visibilityState, 'public'),
              sql`nullif(trim(${performers.handle}), '') is not null`,
              sql`nullif(trim(${performers.bio}), '') is not null`,
              sql`nullif(trim(${performers.displayName}), '') is not null`
            ))
        : Promise.resolve([]),
      performerEventService.listPublicEvents({ limit: eventLimit }),
      businessDb
        .select({ id: musicReleases.id })
        .from(musicReleases)
        .where(and(
          ne(musicReleases.distributionMode, 'private'),
          inArray(musicReleases.status, ['ready', 'scheduled', 'published'])
        ))
        .orderBy(desc(musicReleases.publishedAt), desc(musicReleases.scheduledReleaseAt), desc(musicReleases.updatedAt))
        .limit(releaseLimit)
    ]);

    const detailsByGigId = new Map(details.map((row) => [row.gigId, row]));
    const selectedRooms = activeRooms
      .filter((room) => detailsByGigId.has(room.gigId))
      .slice(0, roomLimit);
    const publicReleases = audioPublishingService
      ? (await Promise.all(publicReleaseRows.map((release) => audioPublishingService!.getPublicRelease({ releaseId: release.id }))))
        .filter((release) => release !== null)
      : [];

    return res.json({
      rooms: selectedRooms
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
      }),
      events: await Promise.all(publicEvents.map(toPublicEventResponseWithTicket)),
      releases: publicReleases.map((release) => ({
        id: release.id,
        title: release.title,
        primaryArtistName: release.primaryArtistName,
        releaseType: release.releaseType,
        status: release.status,
        scheduledReleaseAt: release.scheduledReleaseAt,
        publishedAt: release.publishedAt,
        releasePath: release.releasePath,
        artworkUrl: release.artworkUrl,
        creationTags: release.creationTags,
        humanWrittenLyrics: release.humanWrittenLyrics,
        originalVirtualArtist: release.originalVirtualArtist,
        fullyGenerated: release.fullyGenerated,
        recordings: release.recordings.map((recording) => ({
          recordingId: recording.recordingId,
          title: recording.title,
          lyricsExcerpt: recording.lyricsExcerpt,
          credits: recording.credits
        }))
      }))
    });
  } catch (error) {
    console.error('Public feed lookup failed:', error);
    return res.status(500).json({ error: 'Unable to load the public feed right now.' });
  }
});

app.get('/api/public/performer/:handle/share-card.png', async (req, res) => {
  const resolution = await resolvePublicPerformerDiscovery(req.params.handle);
  if (resolution.kind === 'unavailable') return res.status(503).send('Public performer profiles require a durable database connection.');
  if ((resolution.kind !== 'public' && resolution.kind !== 'unlisted') || !resolution.profile) {
    return res.status(404).send('Performer profile not found.');
  }
  const profile = toPublicShareProfile(resolution.profile, resolution.kind);

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

app.get('/api/public/releases/:releaseId', async (req, res) => {
  applyNoStoreHeaders(res);
  if (!requireAudioPublishingRuntime(res) || !audioPublishingService) return;
  try {
    const release = await audioPublishingService.getPublicRelease({ releaseId: req.params.releaseId });
    if (!release) return res.status(404).json({ error: 'Public release not found.' });
    return res.json({ release });
  } catch (error) {
    return res.status(503).json({ error: error instanceof Error ? error.message : 'Public release is temporarily unavailable.' });
  }
});

app.post('/api/public/releases/:releaseId/reports', async (req, res) => {
  applyNoStoreHeaders(res);
  const accountAccess = await accessControl.requireAuthenticatedAccountAccess(req);
  if (accountAccess.allowed === false) return res.status(accountAccess.status).json({ error: accountAccess.reason });
  if (!accountAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireAudioPublishingRuntime(res) || !audioPublishingService) return;
  try {
    const report = await audioPublishingService.createReleaseReport({
      releaseId: req.params.releaseId,
      reporterUserId: accountAccess.actor.actorId,
      reason: typeof req.body?.reason === 'string' ? req.body.reason : '',
      details: typeof req.body?.details === 'string' ? req.body.details : ''
    });
    return res.status(201).json({ report: { id: report.id, status: report.status } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not submit this release report.';
    const status = /already have an active report/i.test(message)
      ? 409
      : /owners cannot report/i.test(message)
        ? 403
        : /not found/i.test(message)
          ? 404
          : 422;
    return res.status(status).json({ error: message });
  }
});

app.get('/api/admin/release-reports', async (req, res) => {
  applyNoStoreHeaders(res);
  const adminAccess = await accessControl.requireAdminAccess(req);
  if (adminAccess.allowed === false) return res.status(adminAccess.status).json({ error: adminAccess.reason });
  if (!adminAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireAudioPublishingRuntime(res) || !audioPublishingService) return;
  try {
    const reports = await audioPublishingService.listReleaseReports({
      status: typeof req.query?.status === 'string' ? req.query.status : null
    });
    return res.json({ reports });
  } catch (error) {
    return res.status(422).json({ error: error instanceof Error ? error.message : 'Could not load release reports.' });
  }
});

app.patch('/api/admin/release-reports/:reportId', async (req, res) => {
  applyNoStoreHeaders(res);
  const adminAccess = await accessControl.requireAdminAccess(req);
  if (adminAccess.allowed === false) return res.status(adminAccess.status).json({ error: adminAccess.reason });
  if (!adminAccess.actor.actorId) return res.status(401).json({ error: 'Sway actor resolution required.' });
  if (!requireAudioPublishingRuntime(res) || !audioPublishingService) return;
  try {
    const result = await audioPublishingService.reviewReleaseReport({
      reportId: req.params.reportId,
      actorUserId: adminAccess.actor.actorId,
      outcome: typeof req.body?.outcome === 'string' ? req.body.outcome : '',
      note: typeof req.body?.note === 'string' ? req.body.note : ''
    });
    return res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not review release report.';
    return res.status(/not found/i.test(message) ? 404 : /already|changed|final outcome/i.test(message) ? 409 : 422).json({ error: message });
  }
});

app.get('/api/public/releases/:releaseId/artwork', async (req, res) => {
  if (!requireAudioPublishingRuntime(res) || !audioPublishingService) return;
  try {
    const opened = await audioPublishingService.openPublicReleaseArtwork({ releaseId: req.params.releaseId });
    res.setHeader('Content-Type', opened.version.mimeType);
    res.setHeader('Content-Length', String(opened.byteSize));
    res.setHeader('Content-Disposition', `inline; filename="${opened.version.originalFilename.replace(/"/g, '')}"`);
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
    res.setHeader('X-Sway-Asset-Sha256', opened.version.sha256);
    opened.stream.pipe(res);
  } catch (error) {
    return res.status(404).json({ error: error instanceof Error ? error.message : 'Public release artwork not found.' });
  }
});

app.get('/api/public/performer/:handle', async (req, res) => {
  applyNoStoreHeaders(res);

  const resolution = await resolvePublicPerformerDiscovery(req.params.handle);
  if (resolution.kind === 'unavailable') {
    return res.status(503).json({ error: 'Public performer profiles require a durable database connection.' });
  }
  if ((resolution.kind !== 'public' && resolution.kind !== 'unlisted') || !resolution.profile) {
    return res.status(404).json({ error: 'Performer profile not found.' });
  }

  const profile = resolution.profile;
  try {

    const publicProfilePerformerId = profile.performerId;
    const [[activeRoom], linkRows, partnerState, publicReleaseRows, publicEventRows] = await Promise.all([
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
          id: musicReleases.id,
          title: musicReleases.title,
          primaryArtistName: musicReleases.primaryArtistName,
          releaseType: musicReleases.releaseType,
          status: musicReleases.status,
          scheduledReleaseAt: musicReleases.scheduledReleaseAt,
          publishedAt: musicReleases.publishedAt,
          artworkAssetVersionId: musicReleases.artworkAssetVersionId
        })
        .from(musicReleases)
        .where(and(
          eq(musicReleases.performerId, profile.performerId),
          ne(musicReleases.distributionMode, 'private'),
          inArray(musicReleases.status, ['ready', 'scheduled', 'published'])
        ))
        .orderBy(desc(musicReleases.scheduledReleaseAt), desc(musicReleases.updatedAt))
        .limit(12),
      performerEventService
        ? performerEventService.listPublicEvents({ performerId: publicProfilePerformerId, limit: 12 })
        : Promise.resolve([])
    ]);

    const activeRooms = await listReadableActiveRooms(profile.performerId);
    const activeRoomSummary = activeRoom
      ? activeRooms.find((room) => room.gigId === activeRoom.gigId) ?? null
      : null;
    const publicLinkRows = linkRows.flatMap((link) => {
      const safeUrl = normalizePublicProfileUrl(link.url);
      return safeUrl ? [{ ...link, url: safeUrl }] : [];
    });
    const combinedLinkRows = publicLinkRows.slice(0, 12);
    const effectiveHeadline = profile.headline;
    const effectiveBio = profile.bio;
    const effectiveSpecialties = profile.specialties ?? [];
    const effectiveCity = profile.city;
    const effectiveAvatarUrl = profile.avatarUrl;
    const normalizedMedia = normalizePublicProfileFeaturedMedia(profile.featuredMedia ?? undefined);
    const publicMedia = normalizedMedia.media
      .filter((media) => media.isActive)
      .map(({ isActive: _isActive, ...media }) => media);
    const effectiveMetadata = profile.metadata || null;
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
    const verifiedPublicReleases = audioPublishingService
      ? (await Promise.all(publicReleaseRows.map((release) => audioPublishingService!.getPublicRelease({ releaseId: release.id })))).filter((release) => release !== null)
      : [];

    return res.json({
      performer: {
        displayName: profile.displayName,
        stageName,
        primaryRole: resolvePublicPrimaryRole(effectiveMetadata),
        handle: profile.handle,
        bio: effectiveBio,
        headline: effectiveHeadline,
        specialties: effectiveSpecialties,
        city: effectiveCity,
        avatarUrl: normalizePublicProfileUrl(effectiveAvatarUrl),
        booking: publicBooking,
        socialLinks: toPublicSocialLinks({
          facebookUrl: profile.facebookUrl,
          instagramUrl: profile.instagramUrl,
          tiktokUrl: profile.tiktokUrl,
          youtubeUrl: profile.youtubeUrl,
          soundcloudUrl: profile.soundcloudUrl,
          websiteUrl: profile.websiteUrl
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
        : null,
      releases: verifiedPublicReleases.map((release) => ({
        id: release.id,
        title: release.title,
        primaryArtistName: release.primaryArtistName,
        releaseType: release.releaseType,
        status: release.status,
        scheduledReleaseAt: release.scheduledReleaseAt,
        publishedAt: release.publishedAt,
        releasePath: release.releasePath,
        artworkUrl: release.artworkUrl,
        creationTags: release.creationTags,
        humanWrittenLyrics: release.humanWrittenLyrics,
        originalVirtualArtist: release.originalVirtualArtist,
        fullyGenerated: release.fullyGenerated
      })),
      events: await Promise.all(publicEventRows.map(toPublicEventResponseWithTicket))
    });
  } catch (error) {
    console.error('Public performer profile lookup failed:', error);
    return res.status(503).json({ error: 'Public performer profiles require a durable database connection.' });
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

async function recordDirectRoomDiscoveryOutcome(
  req: express.Request,
  res: express.Response,
  gigId: string
) {
  if (req.headers['x-sway-discovery-entry-once'] !== '1' || !discoveryObservatoryStore) return;
  const journeyId = typeof req.headers['x-sway-discovery-journey'] === 'string'
    ? req.headers['x-sway-discovery-journey'].trim()
    : '';
  if (!UUID_PATTERN.test(journeyId)) return;
  const source = typeof req.headers['x-sway-discovery-source'] === 'string'
    && /^[a-z][a-z0-9_-]{0,63}$/i.test(req.headers['x-sway-discovery-source'])
    ? req.headers['x-sway-discovery-source'].toLowerCase()
    : 'unknown';
  const requestedEntryPath = typeof req.headers['x-sway-discovery-entry-path'] === 'string'
    ? req.headers['x-sway-discovery-entry-path']
    : `/g/${gigId}`;
  const entryPath = /^\/(?:$|p\/[^?#\s]+|e\/[0-9a-f-]{36}|g\/[0-9a-f-]{36}|r\/[0-9a-f-]{36}|discover\/?$)/i.test(requestedEntryPath)
    ? requestedEntryPath
    : `/g/${gigId}`;
  const visibilityEligibility = await resolveDiscoveryEntityVisibilityEligibility({
    entityKind: 'live_room', entityKey: gigId
  });

  try {
    await discoveryObservatoryStore.recordJourneyEvent({
      journeyId,
      stage: 'entry',
      eventType: 'discovery_landing',
      source,
      surface: 'room-entry',
      entryPath,
      entityKind: 'live_room',
      entityKey: gigId,
      visibilityEligibility,
      linkStrength: 'client_correlated_unverified'
    }, undefined, { idempotencyKey: `room-entry:${gigId}:entry` });
    await discoveryObservatoryStore.recordJourneyEvent({
      journeyId,
      stage: 'action',
      eventType: 'room_entry_attempted',
      source,
      surface: 'room-entry',
      entryPath,
      entityKind: 'live_room',
      entityKey: gigId,
      actionKind: 'room_entry',
      visibilityEligibility,
      linkStrength: 'direct_server_observed'
    }, undefined, { idempotencyKey: `room-entry:${gigId}:action` });
    await discoveryObservatoryStore.recordJourneyEvent({
      journeyId,
      stage: 'outcome',
      eventType: 'room_entry_completed',
      source,
      surface: 'room-entry',
      entryPath,
      entityKind: 'live_room',
      entityKey: gigId,
      actionKind: 'room_entry',
      outcomeStatus: 'completed',
      visibilityEligibility,
      linkStrength: 'direct_server_observed'
    }, undefined, { idempotencyKey: `room-entry:${gigId}:outcome` });
    res.setHeader('x-sway-discovery-recorded', '1');
  } catch (error) {
    console.warn('[sway.discovery] room entry evidence was not recorded.', {
      gigId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function recordDirectTipDiscoveryOutcome(input: {
  journeyId: unknown;
  source: unknown;
  entryPath: unknown;
  gigId: string;
  idempotencyKey: string;
}) {
  if (!discoveryObservatoryStore || typeof input.journeyId !== 'string' || !UUID_PATTERN.test(input.journeyId)) return;
  const source = typeof input.source === 'string' && /^[a-z][a-z0-9_-]{0,63}$/i.test(input.source)
    ? input.source.toLowerCase()
    : 'unknown';
  const entryPath = typeof input.entryPath === 'string'
    && /^\/(?:$|p\/[^?#\s]+|e\/[0-9a-f-]{36}|g\/[0-9a-f-]{36}|r\/[0-9a-f-]{36}|discover\/?$)/i.test(input.entryPath)
    ? input.entryPath
    : `/g/${input.gigId}`;
  const visibilityEligibility = await resolveDiscoveryEntityVisibilityEligibility({
    entityKind: 'live_room', entityKey: input.gigId
  });
  try {
    await discoveryObservatoryStore.recordJourneyEvent({
      journeyId: input.journeyId,
      stage: 'action',
      eventType: 'discovery_primary_action',
      source,
      surface: 'room-entry',
      entryPath,
      entityKind: 'live_room',
      entityKey: input.gigId,
      actionKind: 'tip',
      visibilityEligibility,
      linkStrength: 'direct_server_observed'
    }, undefined, { idempotencyKey: `tip:${input.idempotencyKey}:action` });
    await discoveryObservatoryStore.recordJourneyEvent({
      journeyId: input.journeyId,
      stage: 'outcome',
      eventType: 'tip_action_completed',
      source,
      surface: 'room-entry',
      entryPath,
      entityKind: 'live_room',
      entityKey: input.gigId,
      actionKind: 'tip',
      outcomeStatus: 'completed',
      visibilityEligibility,
      linkStrength: 'direct_server_observed'
    }, undefined, { idempotencyKey: `tip:${input.idempotencyKey}:outcome` });
  } catch (error) {
    console.warn('[sway.discovery] durable tip evidence was not recorded.', {
      gigId: input.gigId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

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

  await recordDirectRoomDiscoveryOutcome(req, res, requestedGigId);

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
  if (request) {
    const paymentEvidence = await loadPatronPaymentEvidence({
      gigId: requestedGigId,
      requestId: request.durableRequestId,
      paymentId: request.paymentId
    });
    return res.json({ patron_status: projectPatronRequestStatus(request, paymentEvidence) });
  }

  for (const candidate of roomSnapshot.state.requests) {
    const boost = candidate.boosts.find((entry) =>
      matchesPatronStatusReceipt(receipt, entry.patronStatusReceiptHash)
    );
    if (boost) {
      const paymentEvidence = await loadPatronPaymentEvidence({
        gigId: requestedGigId,
        requestBoostId: boost.durableBoostId,
        paymentId: boost.paymentId
      });
      return res.json({ patron_status: projectPatronBoostStatus(boost, candidate, paymentEvidence) });
    }
  }

  return res.status(404).json({ error: 'Patron request status not found.' });
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

app.get('/api/talent/rooms/history', async (req, res) => {
  applyNoStoreHeaders(res);
  const talentAccess = await accessControl.requireTalentAccess(req);
  if (talentAccess.allowed === false) return res.status(talentAccess.status).json({ error: talentAccess.reason });
  if (!businessDb || !talentAccess.actor.actorId) return res.status(503).json({ error: 'Room history requires durable persistence.' });

  const performerOwner = await loadOwnedPerformerByActorUserId(talentAccess.actor.actorId);
  if (!performerOwner) return res.json({ rooms: [] });
  const rows = await businessDb.select({
    gigId: gigSessions.id,
    runtimeSessionState: gigSessions.runtimeSessionState,
    startedAt: gigSessions.startedAt,
    closedAt: gigSessions.manualCloseoutCompletedAt,
    updatedAt: gigSessions.updatedAt
  }).from(gigSessions).where(and(
    eq(gigSessions.performerId, performerOwner.performerId),
    eq(gigSessions.status, 'closed')
  )).orderBy(desc(gigSessions.updatedAt)).limit(30);

  const roomIds = rows.map((row) => row.gigId);
  const roomPaymentRows = roomIds.length
    ? await businessDb.select({
        id: payments.id,
        gigId: payments.gigId,
        requestId: payments.requestId,
        requestBoostId: payments.requestBoostId,
        actionType: payments.actionType,
        legacyUnlinked: payments.legacyUnlinked,
        paymentStatus: payments.paymentStatus,
        refundStatus: payments.refundStatus,
        amountSubtotal: payments.amountSubtotal,
        platformFee: payments.platformFee,
        destinationAccountId: payments.destinationAccountId
      }).from(payments).where(inArray(payments.gigId, roomIds))
    : [];
  const roomRequestRows = roomIds.length
    ? await businessDb.select({
        id: requests.id,
        gigId: requests.gigId,
        status: requests.status,
        runtimeRequestState: requests.runtimeRequestState,
        activatedAt: requests.activatedAt
      }).from(requests).where(inArray(requests.gigId, roomIds))
    : [];
  const roomBoostRows = roomIds.length
    ? await businessDb.select({
        id: requestBoosts.id,
        gigId: requestBoosts.gigId,
        requestId: requestBoosts.requestId,
        runtimeBoostState: requestBoosts.runtimeBoostState,
        activatedAt: requestBoosts.activatedAt
      }).from(requestBoosts).where(inArray(requestBoosts.gigId, roomIds))
    : [];
  const paymentsByGig = new Map<string, Array<(typeof roomPaymentRows)[number]>>();
  for (const payment of roomPaymentRows) {
    const bucket = paymentsByGig.get(payment.gigId) ?? [];
    bucket.push(payment);
    paymentsByGig.set(payment.gigId, bucket);
  }
  const recapRequestsByGig = new Map<string, Array<{
    id: string;
    type: string;
    title: string;
    status: string;
    hidden: boolean;
    removed: boolean;
    paymentId: string | null;
  }>>();
  for (const request of roomRequestRows) {
    if (!request.activatedAt) continue;
    const runtime = request.runtimeRequestState && typeof request.runtimeRequestState === 'object'
      ? request.runtimeRequestState as Record<string, unknown>
      : {};
    const bucket = recapRequestsByGig.get(request.gigId) ?? [];
    bucket.push({
      id: request.id,
      type: runtime.type === 'request' || runtime.type === 'tip' ? runtime.type : 'unknown',
      title: typeof runtime.title === 'string' ? runtime.title : 'Untitled request',
      status: request.status,
      hidden: runtime.hidden === true,
      removed: runtime.removed === true,
      paymentId: typeof runtime.paymentId === 'string' ? runtime.paymentId : null
    });
    recapRequestsByGig.set(request.gigId, bucket);
  }
  const recapBoostsByGig = new Map<string, Array<{
    id: string;
    requestId: string;
    paymentId: string | null;
  }>>();
  for (const boost of roomBoostRows) {
    if (!boost.activatedAt) continue;
    const runtime = boost.runtimeBoostState && typeof boost.runtimeBoostState === 'object'
      ? boost.runtimeBoostState as Record<string, unknown>
      : {};
    const bucket = recapBoostsByGig.get(boost.gigId) ?? [];
    bucket.push({
      id: boost.id,
      requestId: boost.requestId,
      paymentId: typeof runtime.paymentId === 'string' ? runtime.paymentId : null
    });
    recapBoostsByGig.set(boost.gigId, bucket);
  }

  const rooms = rows.map((row) => {
    const session = row.runtimeSessionState && typeof row.runtimeSessionState === 'object'
      ? row.runtimeSessionState as Partial<GigSession>
      : {};
    const durablePayments = paymentsByGig.get(row.gigId) ?? [];
    return projectPerformerRoomRecap({
      gigId: row.gigId,
      performerName: session.talentName || performerOwner.displayName,
      startedAt: session.startedAt || row.startedAt?.toISOString() || null,
      closedAt: session.closedAt || row.closedAt?.toISOString() || row.updatedAt.toISOString(),
      runtimeSessionState: session,
      payments: durablePayments,
      requests: recapRequestsByGig.get(row.gigId) ?? [],
      boosts: recapBoostsByGig.get(row.gigId) ?? []
    });
  });
  return res.json({ rooms });
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
    const sanitizedBody = sanitizePatronMutationResponseBody(result.responseBody);
    if (result.responseStatus >= 400) {
      return res.status(result.responseStatus).json(sanitizedBody);
    }
    return res.json({
      ...result,
      responseBody: sanitizedBody
    });
  }

  let recoveryOwner: PendingActionOwner | null = null;

  if (
    (result.status === 'pending' || result.status === 'retrying')
    && result.gigId
    && ['request', 'tip', 'boost'].includes(result.actionType)
  ) {
    const reconciledActionType = result.actionType as 'request' | 'tip' | 'boost';
    const ownership = await idempotencyStore.claimPendingActionOwner({
      clientRequestId: client_request_id,
      idempotencyKey: idempotency_key
    });
    if (ownership.status === 'busy') {
      return res.status(202).json({
        ...result,
        pending: true,
        retry_after_ms: ownership.retryAfterMs
      });
    }
    if (ownership.status !== 'acquired') {
      return res.status(202).json({ ...result, pending: true });
    }
    recoveryOwner = ownership.owner;
    // A worker may have completed the processor/database work after the
    // original HTTP request disappeared. Converge visibility first, then mint
    // a fresh private receipt and persist the exact terminal replay before
    // telling the browser that the action succeeded.
    await paymentService.reconcileActionVisibility({
      limit: 50,
      ownedAction: {
        clientRequestId: client_request_id,
        idempotencyKey: idempotency_key,
        owner: recoveryOwner
      }
    });
    const snapshot = await loadRoomState(result.gigId);
    const receipt = issuePatronStatusReceipt();
    let responseBody: ReturnType<typeof buildPatronRequestMutationResponse> | ReturnType<typeof buildPatronBoostMutationResponse> | null = null;

    if (reconciledActionType === 'boost') {
      const request = snapshot.state.requests.find((item) =>
        item.boosts.some((boost) => boost.clientRequestId === client_request_id && boost.idempotencyKey === idempotency_key)
      );
      const boost = request?.boosts.find((item) =>
        item.clientRequestId === client_request_id && item.idempotencyKey === idempotency_key
      );
      if (request && boost) {
        recalculateTotals(snapshot.state);
        responseBody = buildPatronBoostMutationResponse({
          request,
          boost,
          roomState: snapshot.state,
          gigId: result.gigId,
          receipt: receipt.receipt,
          reconciled: true
        });
      }
    } else {
      const request = snapshot.state.requests.find((item) =>
        item.clientRequestId === client_request_id && item.idempotencyKey === idempotency_key
      );
      if (request) {
        recalculateTotals(snapshot.state);
        responseBody = buildPatronRequestMutationResponse({
          request,
          roomState: snapshot.state,
          gigId: result.gigId,
          receipt: receipt.receipt,
          reconciled: true
        });
      }
    }

    if (responseBody) {
      const completion = await idempotencyStore.completePendingAction({
        clientRequestId: client_request_id,
        idempotencyKey: idempotency_key,
        gigId: result.gigId,
        actionType: reconciledActionType,
        receiptHash: receipt.receiptHash,
        status: 200,
        body: responseBody,
        owner: recoveryOwner
      });
      return res.json({
        status: 'reconciled',
        responseStatus: completion.status,
        responseBody: sanitizePatronMutationResponseBody(completion.body)
      });
    }

    const terminalOutcome = await paymentService.loadInvisibleActionTerminalOutcome({
      clientRequestId: client_request_id,
      idempotencyKey: idempotency_key
    });
    if (terminalOutcome) {
      const responseStatus = terminalOutcome.outcome === 'failed' ? 402 : 409;
      const failureBody = {
        success: false,
        pending: false,
        terminal: true,
        error: terminalOutcome.outcome === 'failed'
          ? 'Payment authorization failed. Your card was not charged and the action was not created.'
          : 'The action was not created. Its payment hold was released or its charge was refunded.',
        payment_status: terminalOutcome.paymentStatus,
        payment_id: terminalOutcome.paymentId
      };
      try {
        const completion = await idempotencyStore.completePendingActionFailure({
          clientRequestId: client_request_id,
          idempotencyKey: idempotency_key,
          gigId: terminalOutcome.gigId,
          actionType: terminalOutcome.actionType,
          status: responseStatus,
          body: failureBody,
          owner: recoveryOwner
        });
        return res.status(completion.status).json(sanitizePatronMutationResponseBody(completion.body));
      } catch (error) {
        if (error instanceof Error && ['pending_action_already_visible', 'pending_action_owner_fenced'].includes(error.message)) {
          return res.json({ ...result, status: 'retrying' });
        }
        throw error;
      }
    }
    await idempotencyStore.releasePendingActionOwner({
      clientRequestId: client_request_id,
      idempotencyKey: idempotency_key,
      owner: recoveryOwner
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

  const { talentName, talentRole, feeType, minimumTip, paymentsEnabled, searchScope, gig_id } = req.body;
  const requestedGigId = parseDurableGigId(gig_id);
  if (!requestedGigId) {
    return res.status(422).json({
      error: 'A valid stable gig_id is required to start a room safely.',
      code: 'room_start_id_required'
    });
  }
  const requestedRoomConfig = {
    talentName: talentName || "DJ Pro",
    talentRole: talentRole || 'DJ',
    feeType: feeType || 'patron',
    minimumTip: Math.max(5, Number(minimumTip) || 5),
    paymentsEnabled: paymentsEnabled === true,
    searchScope: (searchScope === 'catalog' ? 'catalog' : 'library') as 'catalog' | 'library'
  };

  const loadMatchingStartedRoom = async () => {
    if (!businessStore.hasDurableStore) return { kind: 'missing' as const };
    const existing = await loadRoomState(requestedGigId);
    if (existing.roomStatus === 'missing') return { kind: 'missing' as const };
    const session = existing.state.session;
    const ownedByCaller = session.ownerActorUserId === actor.actorId;
    const sameConfig = session.talentName === requestedRoomConfig.talentName
      && session.talentRole === requestedRoomConfig.talentRole
      && session.feeType === requestedRoomConfig.feeType
      && session.minimumTip === requestedRoomConfig.minimumTip
      && session.paymentsEnabled === requestedRoomConfig.paymentsEnabled
      && session.searchScope === requestedRoomConfig.searchScope;
    if (ownedByCaller && sameConfig && session.status === 'active') {
      return { kind: 'replay' as const, state: existing.state };
    }
    return { kind: 'conflict' as const };
  };

  // The client supplies one stable UUID for a room-start attempt. Replaying
  // that exact intent is a read, not a second room mutation. Reusing the UUID
  // for another performer or different setup is rejected without leaking the
  // existing room's private state.
  const existingStart = await loadMatchingStartedRoom();
  if (existingStart.kind === 'replay') {
    state = prepareRoomState(existingStart.state, requestedGigId);
    activeGigId = requestedGigId;
    return res.json({ success: true, replayed: true, state });
  }
  if (existingStart.kind === 'conflict') {
    return res.status(409).json({ error: 'This room start identity was already used for a different or completed room.' });
  }

  if (requestedRoomConfig.paymentsEnabled && !liveRoomPaymentRuntimeConfig.moneyEnabled) {
    return res.status(503).json({
      error: 'Paid-room rehearsal is unavailable until Stripe test-mode payment execution is fully configured.',
      code: 'test_payment_runtime_unavailable'
    });
  }

  const [seller] = businessDb && actor.actorId
      ? await businessDb.select({
        id: performers.id,
        isActive: performers.isActive,
        onboardingStatus: performers.onboardingStatus,
        paymentAccountStatus: performers.paymentAccountStatus,
        kycStatus: performers.kycStatus,
        chargesEnabled: performers.chargesEnabled,
        payoutsEnabled: performers.payoutsEnabled,
        stripeConnectedAccountId: performers.stripeConnectedAccountId,
        payoutHoldReason: performers.payoutHoldReason
      }).from(performers).where(eq(performers.ownerUserId, actor.actorId)).limit(1)
    : [];
  const sellerMoneyReadiness = resolveLiveRoomSellerMoneyReadiness({
    seller,
    allowTestPlatformBalance: isTestModePlatformBalancePerformerAllowed(
      seller?.id,
      testModePlatformBalancePerformerIds
    )
  });
  const requestedPaymentsEnabled = requestedRoomConfig.paymentsEnabled;
  if (requestedPaymentsEnabled && !sellerMoneyReadiness.ready) {
    return res.status(409).json({
      error: 'Complete Stripe identity, charge, and payout setup before starting a paid room.',
      code: 'seller_payout_not_ready'
    });
  }

  const roomGigId = requestedGigId;
  const roomState = createEmptyBackendState();

  roomState.session = {
    status: 'active',
    startedAt: new Date().toISOString(),
    autoCloseoutAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    closedAt: null,
    ownerActorUserId: actor.actorId,
    lastMutationActorUserId: actor.actorId,
    talentName: requestedRoomConfig.talentName,
    talentRole: requestedRoomConfig.talentRole,
    feeType: requestedRoomConfig.feeType,
    minimumTip: requestedRoomConfig.minimumTip,
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
    searchScope: requestedRoomConfig.searchScope,
    paymentsEnabled: liveRoomPaymentRuntimeConfig.moneyEnabled && requestedPaymentsEnabled && sellerMoneyReadiness.ready,
    tipsEnabled: liveRoomPaymentRuntimeConfig.moneyEnabled && sellerMoneyReadiness.ready,
    settlementMode: liveRoomPaymentRuntimeConfig.moneyEnabled && sellerMoneyReadiness.ready
      ? sellerMoneyReadiness.settlementMode
      : 'unavailable',
    paymentEnvironment: liveRoomPaymentRuntimeConfig.moneyEnabled && sellerMoneyReadiness.ready
      ? liveRoomPaymentRuntimeConfig.mode
      : 'unavailable',
    totals: {
      totalTips: 0,
      accumulatedFees: 0,
      totalCount: 0,
      topRequest: "None yet"
    }
  };
  roomState.requests = [];
  try {
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
        tipsEnabled: roomState.session.tipsEnabled,
        settlementMode: roomState.session.settlementMode,
        paymentEnvironment: roomState.session.paymentEnvironment,
        searchScope: roomState.session.searchScope
      }
    });
  } catch (error) {
    // Concurrent copies of the same start can all observe an empty slot. The
    // database insert is the one-flight winner; losers reload and replay only
    // when ownership and immutable setup match exactly.
    if (error instanceof Error && error.message === 'gig_session_state_revision_conflict') {
      const racedStart = await loadMatchingStartedRoom();
      if (racedStart.kind === 'replay') {
        state = prepareRoomState(racedStart.state, roomGigId);
        activeGigId = roomGigId;
        return res.json({ success: true, replayed: true, state });
      }
      return res.status(409).json({ error: 'This room start identity was already used for a different room setup.' });
    }
    console.error('[sway.session.start] durable room start failed:', error);
    return res.status(503).json({ error: 'The room could not be started safely. Retry with the same room start.' });
  }

  state = prepareRoomState(roomState, roomGigId);
  activeGigId = roomGigId;
  return res.json({ success: true, state });
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
  if (businessStore.hasDurableStore && UUID_PATTERN.test(roomContext.gigId)) {
    const barrier = await businessStore.beginRoomCloseout(roomContext.gigId);
    if (!['started', 'already_pending'].includes(barrier.status) || !('stateRevision' in barrier)) {
      return res.status(503).json({ error: 'Room closeout could not be reserved safely. No payment state was changed.' });
    }
    roomState.session.stateRevision = barrier.stateRevision;
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
  const closeout = await settleRoomCloseout(roomState, roomContext.gigId);
  roomState.session.lastMutationActorUserId = actor.actorId;

  if (closeout.status === 'reversal_pending') {
    await persistStateWithAudit({
      roomState,
      gigId: roomContext.gigId,
      actor,
      entityType: 'gig_session',
      entityId: roomContext.gigId,
      eventType: 'session.closeout_reversal_pending',
      previousStatus,
      nextStatus: roomState.session.status,
      metadata: { pendingPaymentIds: closeout.pendingPaymentIds }
    });
    return res.status(409).json({
      success: false,
      error: 'Closeout is waiting for the payment processor to confirm every release or refund.',
      pending_payment_ids: closeout.pendingPaymentIds,
      state: prepareRoomState(roomState, roomContext.gigId)
    });
  }

  const closeoutTotals = closeout.totals;

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

  if (enabled) {
    if (!liveRoomPaymentRuntimeConfig.moneyEnabled) {
      return res.status(503).json({
        error: 'Paid-room rehearsal is unavailable until Stripe test-mode payment execution is fully configured.',
        code: 'test_payment_runtime_unavailable'
      });
    }
    const [seller] = businessDb && actor.actorId
      ? await businessDb.select({
          id: performers.id,
          isActive: performers.isActive,
          onboardingStatus: performers.onboardingStatus,
          paymentAccountStatus: performers.paymentAccountStatus,
          kycStatus: performers.kycStatus,
          chargesEnabled: performers.chargesEnabled,
          payoutsEnabled: performers.payoutsEnabled,
          stripeConnectedAccountId: performers.stripeConnectedAccountId,
          payoutHoldReason: performers.payoutHoldReason
        }).from(performers).where(eq(performers.ownerUserId, actor.actorId)).limit(1)
      : [];
    const sellerMoneyReadiness = resolveLiveRoomSellerMoneyReadiness({
      seller,
      allowTestPlatformBalance: isTestModePlatformBalancePerformerAllowed(
        seller?.id,
        testModePlatformBalancePerformerIds
      )
    });
    if (!sellerMoneyReadiness.ready) {
      return res.status(409).json({
        error: 'Complete Stripe identity, charge, and payout setup before enabling paid requests.',
        code: 'seller_payout_not_ready'
      });
    }
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
    sourceTrackId,
    externalTrackId,
    spotifyUri,
    spotifyUrl,
    client_request_id,
    idempotency_key,
    patron_device_id_hash,
    gig_id,
    currency = "USD",
    expires_at,
    payment_method,
    payment_intent_id,
    campaign_code,
    discovery_journey_id,
    discovery_source,
    discovery_entry_path
  } = req.body;
  const normalizedCurrency = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
  const normalizedCampaignCode = typeof campaign_code === 'string' ? campaign_code : null;
  const resolvedPatronDeviceIdHash = resolvePatronDeviceIdHash(req, patron_device_id_hash);

  if (!client_request_id || !idempotency_key) {
    return res.status(400).json({ error: "client_request_id and idempotency_key are required." });
  }
  if (!resolvedPatronDeviceIdHash) {
    return res.status(422).json({ error: 'A private browser identity is required. Reload this room and try again.' });
  }
  const durableGigId = parseDurableGigId(gig_id);
  const confirmedPaymentIntentId = typeof payment_intent_id === 'string' && payment_intent_id.trim()
    ? payment_intent_id.trim()
    : null;
  if (!durableGigId) {
    return res.status(422).json({ error: "A valid route gig_id is required for durable request submission." });
  }

  const isStraightTip = targetType === 'straight_tip' || type === 'tip';
  const durableActionType = isStraightTip ? 'tip' : 'request';
  const preliminaryReplay = await idempotencyStore.loadDurableActionRecord(idempotency_key);
  if (preliminaryReplay.kind === 'replay') {
    return res.status(preliminaryReplay.status).json(sanitizePatronMutationResponseBody(preliminaryReplay.body));
  }
  let actionOwner: PendingActionOwner | null = null;
  if (confirmedPaymentIntentId) {
    const ownership = await idempotencyStore.claimPendingActionOwner({
      clientRequestId: client_request_id,
      idempotencyKey: idempotency_key,
      expected: {
        gigId: durableGigId,
        actionType: durableActionType,
        patronDeviceIdHash: resolvedPatronDeviceIdHash
      }
    });
    if (ownership.status === 'busy') {
      return res.status(202).json({
        success: false,
        pending: true,
        payment_status: 'processing',
        retry_after_ms: ownership.retryAfterMs
      });
    }
    if (ownership.status === 'misuse') {
      return res.status(409).json({ error: 'The payment confirmation does not belong to this request.' });
    }
    if (ownership.status === 'expired') {
      return res.status(410).json({ error: 'Pending action expired before backend confirmation.' });
    }
    if (ownership.status !== 'acquired') {
      return res.status(202).json({ success: false, pending: true, payment_status: 'processing' });
    }
    actionOwner = ownership.owner;
  }
  // Reconcile an SCA-confirmed PaymentIntent against its immutable durable
  // action identity before reading any room setting that may have changed
  // while the customer was in Stripe.js.
  const confirmedAuthorization = confirmedPaymentIntentId
    ? await paymentService.confirmAuthorizedAction({
        gigId: durableGigId,
        actionType: isStraightTip ? 'tip' : 'request',
        clientRequestId: client_request_id,
        idempotencyKey: idempotency_key,
        patronDeviceIdHash: resolvedPatronDeviceIdHash,
        processorPaymentIntentId: confirmedPaymentIntentId
      })
    : null;
  if (confirmedAuthorization?.status === 'failed' || confirmedAuthorization?.status === 'disabled') {
    if (actionOwner) await idempotencyStore.releasePendingActionOwner({
      clientRequestId: client_request_id,
      idempotencyKey: idempotency_key,
      owner: actionOwner
    });
    return res.status(confirmedAuthorization.status === 'disabled' ? 503 : 402).json({
      success: false,
      error: confirmedAuthorization.status === 'disabled'
        ? 'Payments are temporarily unavailable. Confirmation is still pending.'
        : 'Payment confirmation could not be matched to this request.',
      payment_status: confirmedAuthorization.status === 'disabled' ? 'provider_unavailable' : 'failed'
    });
  }
  if (confirmedAuthorization?.status === 'processing') {
    if (actionOwner) await idempotencyStore.releasePendingActionOwner({
      clientRequestId: client_request_id,
      idempotencyKey: idempotency_key,
      owner: actionOwner
    });
    return res.status(202).json({
      success: false,
      pending: true,
      payment_status: 'processing',
      payment_id: confirmedAuthorization.paymentId
    });
  }
  if (confirmedAuthorization?.status === 'requires_confirmation') {
    if (actionOwner) await idempotencyStore.releasePendingActionOwner({
      clientRequestId: client_request_id,
      idempotencyKey: idempotency_key,
      owner: actionOwner
    });
    return res.status(402).json({
      success: false,
      error: 'Payment confirmation is still required before your request is submitted.',
      payment_status: 'requires_confirmation',
      payment_id: confirmedAuthorization.paymentId,
      payment_intent_id: confirmedAuthorization.processorPaymentIntentId,
      client_secret: confirmedAuthorization.clientSecret
    });
  }

  let durableReservationEstablished = preliminaryReplay.kind === 'pending'
    && Boolean(confirmedAuthorization && 'paymentId' in confirmedAuthorization);

  const completeReservedFailure = async (status: number, body: Record<string, unknown>) => {
    if (!durableReservationEstablished) return res.status(status).json(body);
    return sendCanonicalPatronActionFailure({
      res,
      clientRequestId: client_request_id,
      idempotencyKey: idempotency_key,
      gigId: durableGigId,
      actionType: isStraightTip ? 'tip' : 'request',
      status,
      body,
      owner: actionOwner
    });
  };

  const rejectAfterPaymentReversal = async (
    paymentId: string,
    status: number,
    body: Record<string, unknown>
  ) => {
    if (actionOwner) {
      const refreshedOwner = await idempotencyStore.refreshPendingActionOwner({
        clientRequestId: client_request_id,
        idempotencyKey: idempotency_key,
        owner: actionOwner
      });
      if (!refreshedOwner) {
        return res.status(202).json({ success: false, pending: true, payment_status: 'processing' });
      }
      actionOwner = refreshedOwner;
      const failureFence = await idempotencyStore.fencePendingActionFailure({
        clientRequestId: client_request_id,
        idempotencyKey: idempotency_key,
        gigId: durableGigId,
        actionType: durableActionType,
        owner: actionOwner
      });
      if (failureFence.status === 'already_visible') {
        return res.status(202).json({ success: false, pending: true, payment_status: 'processing' });
      }
    }
    const reversal = await paymentService.voidOrRefund(paymentId);
    const terminal = isTerminalPaymentReversal(reversal);
    const responseBody = {
      ...body,
      success: false,
      pending: !terminal,
      payment_status: terminal ? 'voided_or_refunded' : 'reversal_pending',
      payment_id: paymentId
    };
    if (!terminal) return res.status(202).json(responseBody);
    return completeReservedFailure(status, responseBody);
  };

  const rejectAfterConfirmedAuthorization = async (status: number, body: Record<string, unknown>) => {
    if (!confirmedAuthorization || !('paymentId' in confirmedAuthorization)) {
      return completeReservedFailure(status, body);
    }
    return rejectAfterPaymentReversal(confirmedAuthorization.paymentId, status, body);
  };

  if (preliminaryReplay.kind === 'expired') {
    return rejectAfterConfirmedAuthorization(410, { error: "Pending action expired before request creation." });
  }
  if (normalizedCurrency !== 'USD') {
    return rejectAfterConfirmedAuthorization(422, { error: "Sway Request and Tip payments currently support USD only." });
  }

  const roomSnapshot = await loadRoomState(durableGigId);
  const roomState = roomSnapshot.state;
  const paymentsEnabledForAction = isStraightTip
    ? roomState.session.tipsEnabled === true
    : roomState.session.paymentsEnabled !== false;

  if (paymentsEnabledForAction && !liveRoomPaymentRuntimeConfig.moneyEnabled) {
    return rejectAfterConfirmedAuthorization(503, {
      error: 'This paid action is paused until Stripe test-mode payment execution is fully configured.',
      code: 'test_payment_runtime_unavailable'
    });
  }

  const amount_cents = paymentsEnabledForAction
    ? Math.round(Math.max(Number(amount) || 0, roomState.session.minimumTip) * 100)
    : 0;
  const normalizedSourceProvider = normalizeLibraryText(sourceProvider, 80) || null;
  const normalizedSourceTrackId = normalizeLibraryText(sourceTrackId, 128) || null;
  const normalizedExternalTrackId = normalizeLibraryText(externalTrackId, 256) || null;
  const normalizedSpotifyUri = normalizeLibraryText(spotifyUri, 256) || null;
  const normalizedSpotifyUrl = normalizeLibraryText(spotifyUrl, 512) || null;
  const payload_hash = hashPayload({ type, targetType, title, subtitle, senderName, message, albumArt, normalizedSourceProvider, normalizedSourceTrackId, normalizedExternalTrackId, normalizedSpotifyUri, normalizedSpotifyUrl });
  const idempotencyFingerprint = createIdempotencyFingerprint({
    idempotency_key,
    patron_device_id_hash: resolvedPatronDeviceIdHash,
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
    patronDeviceIdHash: resolvedPatronDeviceIdHash,
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
    return rejectAfterConfirmedAuthorization(410, { error: "Pending action expired before request creation." });
  }
  if (durableReplay.kind === 'misuse') {
    return rejectAfterConfirmedAuthorization(409, { error: "idempotency misuse: same key submitted with a different fingerprint." });
  }
  if (durableReplay.kind === 'replay') {
    return res.status(durableReplay.status).json(sanitizePatronMutationResponseBody(durableReplay.body));
  }
  durableReservationEstablished = true;

  if (!actionOwner) {
    const ownership = await idempotencyStore.claimPendingActionOwner({
      clientRequestId: client_request_id,
      idempotencyKey: idempotency_key,
      expected: {
        gigId: durableGigId,
        actionType: durableActionType,
        patronDeviceIdHash: resolvedPatronDeviceIdHash
      }
    });
    if (ownership.status === 'busy') {
      return res.status(202).json({
        success: false,
        pending: true,
        payment_status: 'processing',
        retry_after_ms: ownership.retryAfterMs
      });
    }
    if (ownership.status !== 'acquired') {
      return res.status(ownership.status === 'expired' ? 410 : 409).json({
        error: ownership.status === 'expired'
          ? 'Pending action expired before backend confirmation.'
          : 'The pending action identity could not be owned safely.'
      });
    }
    actionOwner = ownership.owner;
  }

  const existingRequest = roomState.requests.find(r => r.idempotencyKey === idempotency_key);
  if (existingRequest) {
    if (existingRequest.idempotencyFingerprint !== idempotencyFingerprint) {
      return rejectAfterConfirmedAuthorization(409, { error: "idempotency misuse: same key submitted with a different fingerprint." });
    }
    const patronStatusReceipt = issuePatronStatusReceipt();
    const responseBody = buildPatronRequestMutationResponse({
      request: existingRequest,
      roomState,
      gigId: durableGigId,
      receipt: patronStatusReceipt.receipt,
      reconciled: true
    });
    const completion = await idempotencyStore.completePendingAction({
      clientRequestId: client_request_id,
      idempotencyKey: idempotency_key,
      gigId: durableGigId,
      actionType: isStraightTip ? 'tip' : 'request',
      receiptHash: patronStatusReceipt.receiptHash,
      status: 200,
      body: responseBody,
      owner: actionOwner
    });
    return res.status(completion.status).json(sanitizePatronMutationResponseBody(completion.body));
  }
  if (durableReplay.kind === 'pending' && !confirmedPaymentIntentId) {
    await idempotencyStore.releasePendingActionOwner({
      clientRequestId: client_request_id,
      idempotencyKey: idempotency_key,
      owner: actionOwner
    });
    return res.status(202).json({
      success: false,
      pending: true,
      payment_status: 'processing'
    });
  }

  if (roomSnapshot.roomStatus !== 'active') {
    return rejectAfterConfirmedAuthorization(404, { error: ROOM_LOOKUP_UNAVAILABLE_COPY });
  }
  if (isStraightTip && roomState.session.tipsEnabled !== true) {
    return rejectAfterConfirmedAuthorization(409, {
      error: 'Tips are unavailable until this performer completes payout setup.',
      code: 'seller_payout_not_ready'
    });
  }

  const tipAmount = paymentsEnabledForAction ? Math.max(Number(amount) || 0, roomState.session.minimumTip) : 0;
  const holdAmount = tipAmount;
  const attribution = paymentsEnabledForAction
    ? await businessStore.resolveCampaignAttribution(durableGigId, normalizedCampaignCode)
    : { kind: 'creator_direct' as const };
  const proposedFee = resolveProposedPlatformFee({ subtotalCents: amount_cents, attribution });
  const proposedPlatformFeeCents = paymentsEnabledForAction ? proposedFee.proposedPlatformFeeCents : 0;
  const platformFeePayer = roomState.session.feeType === 'talent' ? 'performer' : 'patron';

  const moderationOutcome = await moderationService.evaluateSubmission({
    senderName: senderName || "Patron",
    text: message || "",
    patronUserId: resolvedActor.actorId,
    patronDeviceIdHash: resolvedPatronDeviceIdHash
  });

  if (moderationOutcome.decision === 'block_submission') {
    await moderationService.recordBlockEnforcement({
      entityId: client_request_id,
      actorUserId: resolveActorUserId(req),
      blockId: moderationOutcome.blockId
    });
    return rejectAfterConfirmedAuthorization(403, {
      error: 'This submission is unavailable due to an active safety restriction.',
      outage_behavior: 'block_submission'
    });
  }

  if (moderationOutcome.blockStoreAvailable === false && isStraightTip) {
    return rejectAfterConfirmedAuthorization(503, {
      error: 'Safety checks are temporarily unavailable. No tip was accepted.',
      outage_behavior: 'hold_for_review'
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
    title: isStraightTip ? LIVE_ROOM_LANGUAGE.directTip : (title || LIVE_ROOM_LANGUAGE.request),
    subtitle: isStraightTip ? 'Supported the talent directly!' : (subtitle || ''),
    albumArt: albumArt || (targetType === 'music' ? "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=150&h=150&fit=crop" : undefined),
    sourceProvider: isStraightTip ? null : normalizedSourceProvider,
    sourceTrackId: isStraightTip ? null : normalizedSourceTrackId,
    externalTrackId: isStraightTip ? null : normalizedExternalTrackId,
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
    patronDeviceIdHash: resolvedPatronDeviceIdHash,
    gigId: durableGigId,
    payloadHash: payload_hash,
    amountCents: amount_cents,
    currency: normalizedCurrency,
    patronStatusReceiptHash: patronStatusReceipt.receiptHash,
    ...(!paymentsEnabledForAction ? { paymentStatus: 'not_applicable' } : {}),
    boosts: []
  };

  // Reserve an invisible, permanent request identity before any processor
  // call. The row is activated only after the payment reaches the state this
  // action requires (or immediately for a genuinely free request).
  try {
    await businessStore.reserveRequestAction(durableGigId, newItem, {
      maxRequestsPerDevicePerGig: MAX_REQUESTS_PER_DEVICE_PER_SESSION,
      maxCustomNotesPerDevicePerGig: MAX_CUSTOM_NOTES_PER_DEVICE_PER_SESSION
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'durable_request_reservation_failed';
    if (reason === 'request_device_per_gig_cap_reached') {
      return rejectAfterConfirmedAuthorization(429, {
        error: "You've reached the request limit for this session. Try again shortly as the queue moves."
      });
    }
    if (reason === 'request_custom_note_device_per_gig_cap_reached') {
      return rejectAfterConfirmedAuthorization(429, {
        error: "You've reached the custom-note limit for this session. Try a preset request next."
      });
    }
    if (reason === 'room_not_accepting_money') {
      return rejectAfterConfirmedAuthorization(409, { error: 'This room is closing and is no longer accepting requests or tips.' });
    }
    if (reason === 'room_not_accepting_requests') {
      return rejectAfterConfirmedAuthorization(400, { error: "Request submissions are currently closed by the host." });
    }
    if (reason === 'durable_request_identity_conflict') {
      return rejectAfterConfirmedAuthorization(409, { error: 'client_request_id or idempotency_key was already used for a different request.' });
    }
    return rejectAfterConfirmedAuthorization(503, { error: 'The request could not be reserved safely. No payment was attempted.' });
  }

  // Provider-backed authorization/hold. A paid request/tip must NOT enter app
  // state or Private Triage until the provider confirms a real hold
  // (PaymentIntent requires_capture). Fail safe / fail closed otherwise.
  if (!paymentsEnabledForAction) {
    // Free room, non-tip request: no money changes hands, nothing to authorize.
    newItem.paymentStatus = 'not_applicable';
  } else if (paymentService.isEnabled()) {
    const authorization = confirmedAuthorization ?? await paymentService.authorizeAction({
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
          intentFingerprint: idempotencyFingerprint,
          requestId: newItem.durableRequestId,
          runtimeRequestId: newItem.id,
          clientRequestId: client_request_id,
          paymentMethod: payment_method,
          confirm: typeof payment_method === 'string' && payment_method.length > 0
        });
    if (authorization.status === 'failed') {
      return completeReservedFailure(402, {
        error: "Payment authorization failed. Your card was not charged and no request was created.",
        payment_status: 'failed'
      });
    }
    if (authorization.status === 'requires_confirmation') {
      // No hold yet: do NOT create the request. Return the client_secret so the
      // patron can confirm their card; the request is created only after the
      // PaymentIntent reaches requires_capture.
      await idempotencyStore.releasePendingActionOwner({
        clientRequestId: client_request_id,
        idempotencyKey: idempotency_key,
        owner: actionOwner
      });
      return res.status(402).json({
        error: "Payment confirmation is required before your request is submitted.",
        payment_status: 'requires_confirmation',
        payment_id: authorization.paymentId,
        payment_intent_id: authorization.processorPaymentIntentId,
        client_secret: authorization.clientSecret
      });
    }
    if (authorization.status === 'processing') {
      await idempotencyStore.releasePendingActionOwner({
        clientRequestId: client_request_id,
        idempotencyKey: idempotency_key,
        owner: actionOwner
      });
      return res.status(202).json({
        success: false,
        pending: true,
        payment_status: 'processing',
        payment_id: authorization.paymentId
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
        } else {
          await idempotencyStore.releasePendingActionOwner({
            clientRequestId: client_request_id,
            idempotencyKey: idempotency_key,
            owner: actionOwner
          });
          return res.status(202).json({
            success: false,
            pending: true,
            // Preserve the established client-facing primary status while the
            // separate field carries the new durable reconciliation truth.
            payment_status: 'capture_failed',
            reconciliation_status: 'pending',
            payment_id: authorization.paymentId
          });
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

  try {
    const refreshedOwner = await idempotencyStore.refreshPendingActionOwner({
      clientRequestId: client_request_id,
      idempotencyKey: idempotency_key,
      owner: actionOwner
    });
    if (!refreshedOwner) throw new Error('pending_action_owner_fenced');
    actionOwner = refreshedOwner;
    await businessStore.activateRequestAction(durableGigId, newItem, actionOwner);
  } catch (error) {
    const pendingExpired = error instanceof Error && error.message === 'pending_action_expired';
    const ownerFenced = error instanceof Error && error.message === 'pending_action_owner_fenced';
    const activelyBlocked = error instanceof Error && error.message === 'active_moderation_block';
    if (ownerFenced) {
      return res.status(202).json({ success: false, pending: true, payment_status: 'processing' });
    }
    if (activelyBlocked) {
      await moderationService.recordBlockEnforcement({
        entityId: client_request_id,
        actorUserId: resolveActorUserId(req)
      });
      const blockedBody = {
        error: 'This submission is unavailable due to an active safety restriction.',
        outage_behavior: 'block_submission'
      };
      return newItem.paymentId
        ? rejectAfterPaymentReversal(newItem.paymentId, 403, blockedBody)
        : completeReservedFailure(403, blockedBody);
    }
    if (newItem.paymentId) {
      return rejectAfterPaymentReversal(newItem.paymentId, pendingExpired ? 410 : 409, {
        error: pendingExpired
          ? 'This request expired before it could be committed. Its payment is being released safely.'
          : 'The room changed before this request could be committed. Its payment is being released safely.'
      });
    }
    return completeReservedFailure(pendingExpired ? 410 : 409, {
      error: pendingExpired
        ? 'This request expired before it could be committed.'
        : 'The room changed before this request could be committed.'
    });
  }
  const committedSnapshot = await loadRoomState(durableGigId);
  const committedRequest = committedSnapshot.state.requests.find((item) => item.durableRequestId === newItem.durableRequestId);
  if (!committedRequest) {
    return res.status(202).json({
      success: false,
      pending: true,
      payment_status: newItem.paymentId ? 'processing' : 'not_applicable'
    });
  }
  recalculateTotals(committedSnapshot.state);

  const responseBody = buildPatronRequestMutationResponse({
    request: committedRequest,
    roomState: committedSnapshot.state,
    gigId: durableGigId,
    receipt: patronStatusReceipt.receipt
  });
  const completion = await idempotencyStore.completePendingAction({
    clientRequestId: client_request_id,
    idempotencyKey: idempotency_key,
    gigId: durableGigId,
    actionType: isStraightTip ? 'tip' : 'request',
    receiptHash: patronStatusReceipt.receiptHash,
    status: 200,
    body: responseBody,
    owner: actionOwner
  });
  if (isStraightTip) {
    await recordDirectTipDiscoveryOutcome({
      journeyId: discovery_journey_id,
      source: discovery_source,
      entryPath: discovery_entry_path,
      gigId: durableGigId,
      idempotencyKey: idempotency_key
    });
  }
  res.status(completion.status).json(sanitizePatronMutationResponseBody(completion.body));
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
    patron_device_id_hash,
    gig_id,
    currency = "USD",
    expires_at,
    payment_method,
    payment_intent_id,
    campaign_code
  } = req.body;
  const normalizedCurrency = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
  const normalizedCampaignCode = typeof campaign_code === 'string' ? campaign_code : null;
  const resolvedPatronDeviceIdHash = resolvePatronDeviceIdHash(req, patron_device_id_hash);
  if (!client_request_id || !idempotency_key) {
    return res.status(400).json({ error: "client_request_id and idempotency_key are required." });
  }
  if (!resolvedPatronDeviceIdHash) {
    return res.status(422).json({ error: 'A private browser identity is required. Reload this room and try again.' });
  }
  const durableGigId = parseDurableGigId(gig_id);
  const confirmedPaymentIntentId = typeof payment_intent_id === 'string' && payment_intent_id.trim()
    ? payment_intent_id.trim()
    : null;
  if (!durableGigId) {
    return res.status(422).json({ error: "A valid route gig_id is required for durable boost submission." });
  }

  const preliminaryReplay = await idempotencyStore.loadDurableActionRecord(idempotency_key);
  if (preliminaryReplay.kind === 'replay') {
    return res.status(preliminaryReplay.status).json(sanitizePatronMutationResponseBody(preliminaryReplay.body));
  }
  let actionOwner: PendingActionOwner | null = null;
  if (confirmedPaymentIntentId) {
    const ownership = await idempotencyStore.claimPendingActionOwner({
      clientRequestId: client_request_id,
      idempotencyKey: idempotency_key,
      expected: {
        gigId: durableGigId,
        actionType: 'boost',
        patronDeviceIdHash: resolvedPatronDeviceIdHash
      }
    });
    if (ownership.status === 'busy') {
      return res.status(202).json({
        success: false,
        pending: true,
        payment_status: 'processing',
        retry_after_ms: ownership.retryAfterMs
      });
    }
    if (ownership.status === 'misuse') {
      return res.status(409).json({ error: 'The payment confirmation does not belong to this boost.' });
    }
    if (ownership.status === 'expired') {
      return res.status(410).json({ error: 'Pending action expired before backend confirmation.' });
    }
    if (ownership.status !== 'acquired') {
      return res.status(202).json({ success: false, pending: true, payment_status: 'processing' });
    }
    actionOwner = ownership.owner;
  }
  const confirmedAuthorization = confirmedPaymentIntentId
    ? await paymentService.confirmAuthorizedAction({
        gigId: durableGigId,
        actionType: 'boost',
        clientRequestId: client_request_id,
        idempotencyKey: idempotency_key,
        patronDeviceIdHash: resolvedPatronDeviceIdHash,
        processorPaymentIntentId: confirmedPaymentIntentId
      })
    : null;
  if (confirmedAuthorization?.status === 'failed' || confirmedAuthorization?.status === 'disabled') {
    if (actionOwner) await idempotencyStore.releasePendingActionOwner({
      clientRequestId: client_request_id,
      idempotencyKey: idempotency_key,
      owner: actionOwner
    });
    return res.status(confirmedAuthorization.status === 'disabled' ? 503 : 402).json({
      success: false,
      error: confirmedAuthorization.status === 'disabled'
        ? 'Payments are temporarily unavailable. Confirmation is still pending.'
        : 'Payment confirmation could not be matched to this boost.',
      payment_status: confirmedAuthorization.status === 'disabled' ? 'provider_unavailable' : 'failed'
    });
  }
  if (confirmedAuthorization?.status === 'processing') {
    if (actionOwner) await idempotencyStore.releasePendingActionOwner({
      clientRequestId: client_request_id,
      idempotencyKey: idempotency_key,
      owner: actionOwner
    });
    return res.status(202).json({
      success: false,
      pending: true,
      payment_status: 'processing',
      payment_id: confirmedAuthorization.paymentId
    });
  }
  if (confirmedAuthorization?.status === 'requires_confirmation') {
    if (actionOwner) await idempotencyStore.releasePendingActionOwner({
      clientRequestId: client_request_id,
      idempotencyKey: idempotency_key,
      owner: actionOwner
    });
    return res.status(402).json({
      success: false,
      error: 'Payment confirmation is still required before your boost is applied.',
      payment_status: 'requires_confirmation',
      payment_id: confirmedAuthorization.paymentId,
      payment_intent_id: confirmedAuthorization.processorPaymentIntentId,
      client_secret: confirmedAuthorization.clientSecret
    });
  }

  let durableReservationEstablished = preliminaryReplay.kind === 'pending'
    && Boolean(confirmedAuthorization && 'paymentId' in confirmedAuthorization);

  const completeReservedFailure = async (status: number, body: Record<string, unknown>) => {
    if (!durableReservationEstablished) return res.status(status).json(body);
    return sendCanonicalPatronActionFailure({
      res,
      clientRequestId: client_request_id,
      idempotencyKey: idempotency_key,
      gigId: durableGigId,
      actionType: 'boost',
      status,
      body,
      owner: actionOwner
    });
  };

  const rejectAfterPaymentReversal = async (
    paymentId: string,
    status: number,
    body: Record<string, unknown>
  ) => {
    if (actionOwner) {
      const refreshedOwner = await idempotencyStore.refreshPendingActionOwner({
        clientRequestId: client_request_id,
        idempotencyKey: idempotency_key,
        owner: actionOwner
      });
      if (!refreshedOwner) {
        return res.status(202).json({ success: false, pending: true, payment_status: 'processing' });
      }
      actionOwner = refreshedOwner;
      const failureFence = await idempotencyStore.fencePendingActionFailure({
        clientRequestId: client_request_id,
        idempotencyKey: idempotency_key,
        gigId: durableGigId,
        actionType: 'boost',
        owner: actionOwner
      });
      if (failureFence.status === 'already_visible') {
        return res.status(202).json({ success: false, pending: true, payment_status: 'processing' });
      }
    }
    const reversal = await paymentService.voidOrRefund(paymentId);
    const terminal = isTerminalPaymentReversal(reversal);
    const responseBody = {
      ...body,
      success: false,
      pending: !terminal,
      payment_status: terminal ? 'voided_or_refunded' : 'reversal_pending',
      payment_id: paymentId
    };
    if (!terminal) return res.status(202).json(responseBody);
    return completeReservedFailure(status, responseBody);
  };

  const rejectAfterConfirmedAuthorization = async (status: number, body: Record<string, unknown>) => {
    if (!confirmedAuthorization || !('paymentId' in confirmedAuthorization)) {
      return completeReservedFailure(status, body);
    }
    return rejectAfterPaymentReversal(confirmedAuthorization.paymentId, status, body);
  };
  if (preliminaryReplay.kind === 'expired') {
    return rejectAfterConfirmedAuthorization(410, { error: "Pending action expired before boost creation." });
  }
  if (normalizedCurrency !== 'USD') {
    return rejectAfterConfirmedAuthorization(422, { error: "Sway Boost payments currently support USD only." });
  }

  const roomSnapshot = await loadRoomState(durableGigId);
  if (roomSnapshot.roomStatus !== 'active') {
    return rejectAfterConfirmedAuthorization(404, { error: ROOM_LOOKUP_UNAVAILABLE_COPY });
  }
  const roomState = roomSnapshot.state;
  if (roomState.session.status !== 'active') {
    return rejectAfterConfirmedAuthorization(409, { error: 'This room is closing and is no longer accepting boosts.' });
  }
  const paymentsEnabledForRoom = roomState.session.paymentsEnabled !== false;
  if (paymentsEnabledForRoom && !liveRoomPaymentRuntimeConfig.moneyEnabled) {
    return rejectAfterConfirmedAuthorization(503, {
      error: 'Paid boosts are paused until Stripe test-mode payment execution is fully configured.',
      code: 'test_payment_runtime_unavailable'
    });
  }
  let amt = Math.max(Number(boostAmount) || 0, roomState.session.minimumTip); // Paid boosts follow the room minimum.
  if (!paymentsEnabledForRoom) {
    // Free room: boosts become free upvotes -- fixed 1-unit weight, no money.
    amt = 1;
  }

  const request = roomState.requests.find(r => r.id === requestId);
  if (!request) {
    return rejectAfterConfirmedAuthorization(404, { error: "Request not found" });
  }

  const amount_cents = Math.round(amt * 100);
  const payload_hash = hashPayload({ requestId, patronName, boostAmount });
  const idempotencyFingerprint = createIdempotencyFingerprint({
    idempotency_key,
    patron_device_id_hash: resolvedPatronDeviceIdHash,
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
    patronDeviceIdHash: resolvedPatronDeviceIdHash,
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
    return rejectAfterConfirmedAuthorization(410, { error: "Pending action expired before boost creation." });
  }
  if (durableReplay.kind === 'misuse') {
    return rejectAfterConfirmedAuthorization(409, { error: "idempotency misuse: same key submitted with a different fingerprint." });
  }
  if (durableReplay.kind === 'replay') {
    return res.status(durableReplay.status).json(sanitizePatronMutationResponseBody(durableReplay.body));
  }
  durableReservationEstablished = true;

  if (!actionOwner) {
    const ownership = await idempotencyStore.claimPendingActionOwner({
      clientRequestId: client_request_id,
      idempotencyKey: idempotency_key,
      expected: {
        gigId: durableGigId,
        actionType: 'boost',
        patronDeviceIdHash: resolvedPatronDeviceIdHash
      }
    });
    if (ownership.status === 'busy') {
      return res.status(202).json({
        success: false,
        pending: true,
        payment_status: 'processing',
        retry_after_ms: ownership.retryAfterMs
      });
    }
    if (ownership.status !== 'acquired') {
      return res.status(ownership.status === 'expired' ? 410 : 409).json({
        error: ownership.status === 'expired'
          ? 'Pending action expired before backend confirmation.'
          : 'The pending boost identity could not be owned safely.'
      });
    }
    actionOwner = ownership.owner;
  }

  const existingBoost = request.boosts.find(b => b.idempotencyKey === idempotency_key);
  if (existingBoost) {
    if (existingBoost.idempotencyFingerprint !== idempotencyFingerprint) {
      return rejectAfterConfirmedAuthorization(409, { error: "idempotency misuse: same key submitted with a different fingerprint." });
    }
    const replayReceipt = issuePatronStatusReceipt();
    const responseBody = buildPatronBoostMutationResponse({
      request,
      boost: existingBoost,
      roomState,
      gigId: durableGigId,
      receipt: replayReceipt.receipt,
      reconciled: true
    });
    const completion = await idempotencyStore.completePendingAction({
      clientRequestId: client_request_id,
      idempotencyKey: idempotency_key,
      gigId: durableGigId,
      actionType: 'boost',
      receiptHash: replayReceipt.receiptHash,
      status: 200,
      body: responseBody,
      owner: actionOwner
    });
    return res.status(completion.status).json(sanitizePatronMutationResponseBody(completion.body));
  }
  if (durableReplay.kind === 'pending' && !confirmedPaymentIntentId) {
    await idempotencyStore.releasePendingActionOwner({
      clientRequestId: client_request_id,
      idempotencyKey: idempotency_key,
      owner: actionOwner
    });
    return res.status(202).json({
      success: false,
      pending: true,
      payment_status: 'processing'
    });
  }

  const moderationOutcome = await moderationService.evaluateSubmission({
    senderName: patronName || "Patron",
    text: '',
    patronUserId: resolvedActor.actorId,
    patronDeviceIdHash: resolvedPatronDeviceIdHash
  });

  if (moderationOutcome.decision === 'block_submission') {
    await moderationService.recordBlockEnforcement({
      entityId: client_request_id,
      actorUserId: resolveActorUserId(req),
      blockId: moderationOutcome.blockId
    });
    return rejectAfterConfirmedAuthorization(403, {
      error: 'This submission is unavailable due to an active safety restriction.',
      outage_behavior: 'block_submission'
    });
  }

  const isBackerShadowed = moderationOutcome.decision === 'hold_for_review';
  if (isBackerShadowed) {
    try {
      await businessStore.shadowRequestForBoostModeration(durableGigId, request);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'boost_moderation_persistence_failed';
      return rejectAfterConfirmedAuthorization(reason === 'room_not_accepting_money' ? 409 : 503, {
        error: reason === 'room_not_accepting_money'
          ? 'This room is closing and is no longer accepting boosts.'
          : 'The safety hold could not be persisted, so the boost was not applied.'
      });
    }
    return rejectAfterConfirmedAuthorization(409, {
      error: 'This boost was held by safety review and was not applied.',
      outage_behavior: 'hold_for_review'
    });
  }

  const newBoost: BoostContribution = {
    id: `boost-${String(client_request_id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)}`,
    patronName: patronName || "Co-Sponsor",
    amount: amt,
    actorUserId: resolvedActor.actorId,
    patronDeviceIdHash: resolvedPatronDeviceIdHash,
    timestamp: new Date().toISOString(),
    clientRequestId: client_request_id,
    idempotencyKey: idempotency_key,
    idempotencyFingerprint,
    idempotencyExpiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_HOURS * 3600000).toISOString(),
    ...(!paymentsEnabledForRoom ? { paymentStatus: 'not_applicable' } : {})
  };
  const patronStatusReceipt = issuePatronStatusReceipt();
  newBoost.patronStatusReceiptHash = patronStatusReceipt.receiptHash;
  const boostAttribution = paymentsEnabledForRoom
    ? await businessStore.resolveCampaignAttribution(durableGigId, normalizedCampaignCode)
    : { kind: 'creator_direct' as const };
  const proposedBoostFee = resolveProposedPlatformFee({ subtotalCents: amount_cents, attribution: boostAttribution });
  let appliedBoostPlatformFeeCents = paymentsEnabledForRoom ? proposedBoostFee.proposedPlatformFeeCents : 0;
  const boostPlatformFeePayer = roomState.session.feeType === 'talent' ? 'performer' : 'patron';

  // As with requests, the boost must have a stable invisible database identity
  // before Stripe is contacted. Concurrent duplicates converge on this row.
  try {
    await businessStore.reserveBoostAction(durableGigId, request, newBoost, {
      maxBoostsPerDevicePerGig: MAX_BOOSTS_PER_DEVICE_PER_SESSION
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'durable_boost_reservation_failed';
    if (reason === 'boost_device_per_gig_cap_reached') {
      return rejectAfterConfirmedAuthorization(429, {
        error: "You've reached the boost limit for this session. Try again later."
      });
    }
    if (reason === 'room_not_accepting_money') {
      return rejectAfterConfirmedAuthorization(409, { error: 'This room is closing and is no longer accepting boosts.' });
    }
    if (reason === 'boost_target_not_eligible') {
      return rejectAfterConfirmedAuthorization(409, { error: 'This request can no longer be boosted.' });
    }
    if (reason === 'durable_boost_identity_conflict') {
      return rejectAfterConfirmedAuthorization(409, { error: 'client_request_id or idempotency_key was already used for a different boost.' });
    }
    return rejectAfterConfirmedAuthorization(503, { error: 'The boost could not be reserved safely. No payment was attempted.' });
  }

  // Provider-backed authorization/hold for the boost. The booster only reaches
  // this point because the target request already cleared Private Triage, so the
  // boost never grants approval authority. Fail safe on provider rejection.
  if (!paymentsEnabledForRoom) {
    // Free room: the boost is a free upvote, nothing to authorize.
    newBoost.paymentStatus = 'not_applicable';
  } else if (paymentService.isEnabled()) {
    const authorization = confirmedAuthorization ?? await paymentService.authorizeAction({
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
          intentFingerprint: idempotencyFingerprint,
          requestBoostId: newBoost.durableBoostId,
          runtimeRequestId: request.id,
          clientRequestId: client_request_id,
          paymentMethod: payment_method,
          confirm: typeof payment_method === 'string' && payment_method.length > 0
        });
    if (authorization.status === 'failed') {
      return completeReservedFailure(402, {
        error: "Boost authorization failed. Your card was not charged.",
        payment_status: 'failed'
      });
    }
    if (authorization.status === 'requires_confirmation') {
      // No hold yet: do NOT create the boost. Return the client_secret so the
      // patron can confirm; the boost is created only after requires_capture.
      await idempotencyStore.releasePendingActionOwner({
        clientRequestId: client_request_id,
        idempotencyKey: idempotency_key,
        owner: actionOwner
      });
      return res.status(402).json({
        error: "Payment confirmation is required before your boost is applied.",
        payment_status: 'requires_confirmation',
        payment_id: authorization.paymentId,
        payment_intent_id: authorization.processorPaymentIntentId,
        client_secret: authorization.clientSecret
      });
    }
    if (authorization.status === 'processing') {
      await idempotencyStore.releasePendingActionOwner({
        clientRequestId: client_request_id,
        idempotencyKey: idempotency_key,
        owner: actionOwner
      });
      return res.status(202).json({
        success: false,
        pending: true,
        payment_status: 'processing',
        payment_id: authorization.paymentId
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
      } else {
        await idempotencyStore.releasePendingActionOwner({
          clientRequestId: client_request_id,
          idempotencyKey: idempotency_key,
          owner: actionOwner
        });
        return res.status(202).json({
          success: false,
          pending: true,
          payment_status: 'capture_failed',
          reconciliation_status: 'pending',
          payment_id: authorization.paymentId
        });
      }
    }
  } else if (isProduction) {
    // Fail closed: a visible money action must never silently create no-money
    // boost state in production when the payment provider is unavailable.
    return rejectAfterConfirmedAuthorization(503, {
      error: "Payments are temporarily unavailable. Your boost was not applied and you were not charged.",
      payment_status: 'provider_unavailable'
    });
  }

  // Persist the authoritative fee on the stable boost itself. Hydration folds
  // it into the parent projection without racing a whole-request snapshot.
  newBoost.platformFee = appliedBoostPlatformFeeCents / 100;
  try {
    const refreshedOwner = await idempotencyStore.refreshPendingActionOwner({
      clientRequestId: client_request_id,
      idempotencyKey: idempotency_key,
      owner: actionOwner
    });
    if (!refreshedOwner) throw new Error('pending_action_owner_fenced');
    actionOwner = refreshedOwner;
    await businessStore.activateBoostAction(durableGigId, request, newBoost, actionOwner);
  } catch (error) {
    const pendingExpired = error instanceof Error && error.message === 'pending_action_expired';
    const ownerFenced = error instanceof Error && error.message === 'pending_action_owner_fenced';
    const activelyBlocked = error instanceof Error && error.message === 'active_moderation_block';
    if (ownerFenced) {
      return res.status(202).json({ success: false, pending: true, payment_status: 'processing' });
    }
    if (activelyBlocked) {
      await moderationService.recordBlockEnforcement({
        entityId: client_request_id,
        actorUserId: resolveActorUserId(req)
      });
      const blockedBody = {
        error: 'This submission is unavailable due to an active safety restriction.',
        outage_behavior: 'block_submission'
      };
      return newBoost.paymentId
        ? rejectAfterPaymentReversal(newBoost.paymentId, 403, blockedBody)
        : completeReservedFailure(403, blockedBody);
    }
    if (newBoost.paymentId) {
      return rejectAfterPaymentReversal(newBoost.paymentId, pendingExpired ? 410 : 409, {
        error: pendingExpired
          ? 'This boost expired before it could be committed. Its payment is being released safely.'
          : 'The room changed before this boost could be committed. Its payment is being released safely.'
      });
    }
    return completeReservedFailure(pendingExpired ? 410 : 409, {
      error: pendingExpired
        ? 'This boost expired before it could be committed.'
        : 'The room changed before this boost could be committed.'
    });
  }
  const committedSnapshot = await loadRoomState(durableGigId);
  const committedRequest = committedSnapshot.state.requests.find((item) => item.durableRequestId === request.durableRequestId);
  const committedBoost = committedRequest?.boosts.find((item) => item.durableBoostId === newBoost.durableBoostId);
  if (!committedRequest || !committedBoost) {
    return res.status(202).json({
      success: false,
      pending: true,
      payment_status: newBoost.paymentId ? 'processing' : 'not_applicable'
    });
  }
  recalculateTotals(committedSnapshot.state);
  const responseBody = buildPatronBoostMutationResponse({
    request: committedRequest,
    boost: committedBoost,
    roomState: committedSnapshot.state,
    gigId: durableGigId,
    receipt: patronStatusReceipt.receipt
  });
  const completion = await idempotencyStore.completePendingAction({
    clientRequestId: client_request_id,
    idempotencyKey: idempotency_key,
    gigId: durableGigId,
    actionType: 'boost',
    receiptHash: patronStatusReceipt.receiptHash,
    status: 200,
    body: responseBody,
    owner: actionOwner
  });
  res.status(completion.status).json(sanitizePatronMutationResponseBody(completion.body));
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
  const responseStatus = result.paymentError ? 402 : 200;
  const responseBody = { success: !result.paymentError, ...result };
  await completeDurableActorMutation({ reservation: durableMutation, status: responseStatus, body: responseBody });
  res.status(responseStatus).json(responseBody);
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
  const resolvedPatronDeviceIdHash = resolvePatronDeviceIdHash(req, patron_device_id_hash);

  if (!allowedScopes.includes(scope) || !reason) {
    return res.status(400).json({
      error: "scope and reason are required. scope must be patron_device_id_hash or sender_name."
    });
  }

  const normalizedValue = scope === 'patron_device_id_hash'
    ? resolvedPatronDeviceIdHash
    : (typeof value === 'string' && value.trim().length > 0 ? value.trim().toLowerCase() : null);
  if (!normalizedValue) {
    return res.status(422).json({ error: 'A private browser identity or sender name is required for this block request.' });
  }
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
  const privilegedActor = await accessControl.requireAdminAccess(req);
  if (privilegedActor.allowed === false) {
    return res.status(privilegedActor.status).json({ error: privilegedActor.reason });
  }

  if (!privilegedActor.actor.actorId) {
    return res.status(401).json({ error: 'Sway actor resolution required.' });
  }

  const { scope, value, reason, idempotency_key } = req.body;
  const allowedScopes: BlockScope[] = ['patron_user_id', 'patron_device_id_hash', 'sender_name'];
  const normalizedValue = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const blockReason = typeof reason === 'string' ? reason.trim() : '';
  const idempotencyKey = typeof idempotency_key === 'string' ? idempotency_key.trim() : '';
  const validValue = scope === 'patron_user_id'
    ? UUID_PATTERN.test(normalizedValue)
    : scope === 'patron_device_id_hash'
      ? PATRON_DEVICE_ID_HASH_PATTERN.test(normalizedValue)
      : scope === 'sender_name'
        ? normalizedValue.length > 0 && normalizedValue.length <= 120
        : false;

  if (!allowedScopes.includes(scope) || !validValue || !blockReason || blockReason.length > 500 || !idempotencyKey || idempotencyKey.length > 200) {
    return res.status(400).json({
      error: "A valid scope, value, bounded reason, and idempotency_key are required."
    });
  }

  // Always attribute to the authenticated actor -- never trust a client-supplied
  // actor id, or any caller could falsify who performed a moderation action.
  const actorId = privilegedActor.actor.actorId;
  if (!businessDb) return res.status(503).json({ error: 'Persistent moderation store is not configured.' });

  const mutation = await executeModerationMutation({
    actorId,
    actionType: 'block',
    idempotencyKey,
    intent: { scope, normalizedValue, reason: blockReason },
    mutate: async (tx) => {
      await lockModerationBlockIdentities(tx, [{ scope, normalizedValue }]);
      const existingBlocks = await tx
        .select({
          id: activeBlocks.id,
          reason: activeBlocks.reason,
          actorUserId: activeBlocks.actorUserId,
          status: activeBlocks.status
        })
        .from(activeBlocks)
        .where(and(
          eq(activeBlocks.scope, scope),
          eq(activeBlocks.normalizedValue, normalizedValue)
        ))
        .for('update');

      const existingBlock = existingBlocks.find((row: { status: string }) => row.status === 'active')
        ?? existingBlocks.find((row: { status: string }) => row.status === 'revoked');

      const moderationAction = !existingBlock
        ? 'block_added'
        : existingBlock.status === 'active'
          ? 'block_updated'
          : 'block_reactivated';
      const eventSource = moderationAction === 'block_added'
        ? 'moderation.block'
        : moderationAction === 'block_updated'
          ? 'moderation.block.update'
          : 'moderation.block.reactivate';
      if (existingBlocks.length > 1 && existingBlock) {
        await tx.delete(activeBlocks).where(and(
          eq(activeBlocks.scope, scope),
          eq(activeBlocks.normalizedValue, normalizedValue),
          ne(activeBlocks.id, existingBlock.id)
        ));
      }

      const [activatedBlock] = existingBlock
        ? await tx
          .update(activeBlocks)
          .set({
            reason: blockReason,
            actorUserId: actorId,
            status: 'active',
            revokedAt: null,
            metadata: { source: eventSource },
            updatedAt: new Date()
          })
          .where(eq(activeBlocks.id, existingBlock.id))
          .returning({ id: activeBlocks.id })
        : await tx
          .insert(activeBlocks)
          .values({
            scope,
            normalizedValue,
            reason: blockReason,
            actorUserId: actorId,
            status: 'active',
            revokedAt: null,
            metadata: { source: eventSource }
          })
          .returning({ id: activeBlocks.id });

      await tx.insert(moderationEvents).values({
        actorUserId: actorId,
        entityType: 'block_rule',
        entityId: activatedBlock.id,
        status: 'blocked',
        reason: blockReason,
        metadata: {
          scope,
          value: normalizedValue,
          source: eventSource
        }
      });

      await writeAuditEvent(tx, {
        actorId,
        actorType: privilegedActor.role ?? 'unknown',
        entityType: 'moderation_block',
        entityId: `${scope}:${normalizedValue}`,
        eventType: eventSource,
        previousStatus: existingBlock
          ? existingBlock.status === 'active' ? 'blocked' : 'revoked'
          : null,
        nextStatus: 'blocked',
        metadata: {
          scope,
          value: normalizedValue,
          reason: blockReason,
          previous_reason: existingBlock?.reason ?? null,
          previous_actor_user_id: existingBlock?.actorUserId ?? null
        }
      });

      return {
        status: 200,
        body: {
          success: true,
          moderation_action: moderationAction,
          changed: true
        }
      };
    }
  });

  return res.status(mutation.status).json(mutation.body);
});

app.post("/api/moderation/block/revoke", async (req, res) => {
  if (!requirePersistentBusinessStore(res)) return;
  const privilegedActor = await accessControl.requireAdminAccess(req);
  if (privilegedActor.allowed === false) {
    return res.status(privilegedActor.status).json({ error: privilegedActor.reason });
  }

  if (!privilegedActor.actor.actorId) {
    return res.status(401).json({ error: 'Sway actor resolution required.' });
  }

  const { scope, value, reason, idempotency_key } = req.body;
  const allowedScopes: BlockScope[] = ['patron_user_id', 'patron_device_id_hash', 'sender_name'];
  const normalizedValue = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const revocationReason = typeof reason === 'string' ? reason.trim() : '';
  const idempotencyKey = typeof idempotency_key === 'string' ? idempotency_key.trim() : '';
  const validValue = scope === 'patron_user_id'
    ? UUID_PATTERN.test(normalizedValue)
    : scope === 'patron_device_id_hash'
      ? PATRON_DEVICE_ID_HASH_PATTERN.test(normalizedValue)
      : scope === 'sender_name'
        ? normalizedValue.length > 0 && normalizedValue.length <= 120
        : false;

  if (!allowedScopes.includes(scope) || !validValue || !revocationReason || revocationReason.length > 500 || !idempotencyKey || idempotencyKey.length > 200) {
    return res.status(400).json({
      error: "A valid scope, value, bounded reason, and idempotency_key are required."
    });
  }

  if (!businessDb) {
    return res.status(503).json({ error: 'Persistent moderation store is not configured.' });
  }

  const actorId = privilegedActor.actor.actorId;
  const revokedAt = new Date();
  const mutation = await executeModerationMutation({
    actorId,
    actionType: 'block_revoke',
    idempotencyKey,
    intent: { scope, normalizedValue, reason: revocationReason },
    mutate: async (tx) => {
      await lockModerationBlockIdentities(tx, [{ scope, normalizedValue }]);
      const existingBlocks = await tx
        .select({ id: activeBlocks.id, status: activeBlocks.status })
        .from(activeBlocks)
        .where(and(
          eq(activeBlocks.scope, scope),
          eq(activeBlocks.normalizedValue, normalizedValue)
        ))
        .for('update');
      const activeBlock = existingBlocks.find((row: { status: string }) => row.status === 'active');
      if (activeBlock && existingBlocks.length > 1) {
        await tx.delete(activeBlocks).where(and(
          eq(activeBlocks.scope, scope),
          eq(activeBlocks.normalizedValue, normalizedValue),
          ne(activeBlocks.id, activeBlock.id)
        ));
      }
      const [revokedBlock] = await tx
      .update(activeBlocks)
      .set({
        status: 'revoked',
        revokedAt,
        metadata: {
          source: 'moderation.block.revoke',
          revoked_by_actor_user_id: actorId,
          revocation_reason: revocationReason
        },
        updatedAt: revokedAt
      })
      .where(and(
        eq(activeBlocks.scope, scope),
        eq(activeBlocks.normalizedValue, normalizedValue),
        eq(activeBlocks.id, activeBlock?.id ?? '00000000-0000-0000-0000-000000000000'),
        eq(activeBlocks.status, 'active')
      ))
      .returning({ id: activeBlocks.id, reason: activeBlocks.reason });

      if (!revokedBlock) {
        return {
          status: 200,
          body: { success: true, moderation_action: 'block_already_inactive', changed: false }
        };
      }

    await tx.insert(moderationEvents).values({
      actorUserId: actorId,
      entityType: 'block_rule',
      entityId: revokedBlock.id,
      status: 'allowed',
      reason: revocationReason,
      metadata: {
        action: 'revoke',
        scope,
        value: normalizedValue,
        previous_reason: revokedBlock.reason,
        source: 'moderation.block.revoke'
      }
    });

    await writeAuditEvent(tx, {
      actorId,
      actorType: privilegedActor.role ?? 'unknown',
      entityType: 'moderation_block',
      entityId: `${scope}:${normalizedValue}`,
      eventType: 'moderation.block.revoke',
      previousStatus: 'blocked',
      nextStatus: 'revoked',
      metadata: {
        scope,
        value: normalizedValue,
        reason: revocationReason,
        previous_reason: revokedBlock.reason
      }
    });

      return {
        status: 200,
        body: { success: true, moderation_action: 'block_revoked', changed: true }
      };
    }
  });

  return res.status(mutation.status).json(mutation.body);
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

  recalculateTotals(roomState);
  await persistStateWithAudit({
    roomState,
    gigId: roomContext.gigId,
    actor,
    entityType: 'request',
    entityId: request.id,
    eventType: 'moderation.remove.financial_intent',
    previousStatus,
    nextStatus: request.status,
    metadata: {
      requestId: request.id,
      removed: true,
      reason: String(reason),
      recoveryRequired: true
    }
  });

  // A removed request is never publicly eligible, so release its funds.
  if (paymentService.isEnabled()) {
    const paymentIds = [
      request.paymentId,
      ...request.boosts.map((boost) => boost.paymentId)
    ].filter((id): id is string => Boolean(id));
    if (paymentIds.length) {
      const reversals = await paymentService.voidOrRefundMany(paymentIds);
      applyPaymentReversalTruth(request, reversals);
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

const INTERNAL_TEST_PROFILE_HANDLES = new Set([
  'platynum-47'
]);

function isDiscoveryEligibleHandle(handle: string | null | undefined) {
  return Boolean(handle && !INTERNAL_TEST_PROFILE_HANDLES.has(handle.trim().toLowerCase()));
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

app.get('/robots.txt', (_req, res) => {
  // Canonical host for sitemap locs and HTML <link rel="canonical"> is app.sway.tips.
  // Apex/www may serve the same crawler files; they must keep pointing at the app host.
  res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send([
    'User-agent: *',
    'Allow: /',
    'Disallow: /admin',
    'Disallow: /talent',
    'Disallow: /account',
    'Disallow: /api/',
    `# Canonical discovery host: ${CANONICAL_APP_HOST}`,
    `Sitemap: ${CANONICAL_APP_ORIGIN}/sitemap.xml`
  ].join('\n'));
});

app.get('/llms.txt', (_req, res) => {
  res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send([
    '# Sway',
    '',
    '> Sway gives working performers one public home for profiles, releases, events, tickets, live rooms, Requests, Tips, Boosts, and direct audience support.',
    '',
    `Canonical public host: ${CANONICAL_APP_ORIGIN}`,
    'Apex and www may redirect or mirror; permanent addresses and sitemap locs use the app host.',
    '',
    '## Public surfaces',
    `- [About Sway](${CANONICAL_APP_ORIGIN}/about)`,
    `- [Discover performers, shows, and live rooms](${CANONICAL_APP_ORIGIN}/discover)`,
    `- [FAQ](${CANONICAL_APP_ORIGIN}/faq)`,
    `- [Terms](${CANONICAL_APP_ORIGIN}/terms)`,
    `- [Privacy](${CANONICAL_APP_ORIGIN}/privacy)`,
    '',
    'Performer pages use /p/{handle}. Public event pages use /e/{event-id}. Public release pages use /r/{release-id}.',
    'Venue/location facts appear on event pages when published; Sway does not invent standalone venue catalog pages.',
    'Live Rooms (/g/{id}) are operating product pages when a room is active; Self-Production releases are a separate lane.',
    'Sway.DIO is not a live discovery surface.',
    'Only published, public, non-suspended records belong in search results. Planned delivery is not represented as confirmed store availability.'
  ].join('\n'));
});

app.get('/sitemap.xml', async (_req, res) => {
  if (!businessDb) {
    return res
      .status(503)
      .type('application/xml')
      .set('X-Robots-Tag', 'noindex, nofollow')
      .send('Sitemap temporarily unavailable.');
  }

  const staticPaths = ['/', '/about', '/discover', '/faq', '/terms', '/privacy', '/legal/payments', '/legal/payouts', '/legal/tickets'];
  type SitemapEntry = { loc: string; lastmod?: string | null };
  const entries = new Map<string, SitemapEntry>();
  for (const route of staticPaths) {
    entries.set(`${CANONICAL_APP_ORIGIN}${route}`, { loc: `${CANONICAL_APP_ORIGIN}${route}` });
  }

  if (businessDb) {
    try {
    const [profileRows, eventRows, releaseRows] = await Promise.all([
      businessDb.select({
        ownerUserId: performers.ownerUserId,
        handle: performers.handle,
        displayName: performers.displayName,
        bio: performers.bio,
        visibilityState: performers.visibilityState,
        isActive: performers.isActive,
        onboardingStatus: performers.onboardingStatus,
        updatedAt: performerPublicProfiles.updatedAt
      })
        .from(performers)
        .innerJoin(users, eq(users.id, performers.ownerUserId))
        .leftJoin(performerPublicProfiles, eq(performerPublicProfiles.performerId, performers.id))
        .where(and(
          eq(performers.visibilityState, 'public'),
          eq(performers.isActive, true),
          notInArray(performers.onboardingStatus, ['restricted', 'suspended']),
          sql`nullif(trim(${performers.handle}), '') is not null`,
          sql`nullif(trim(${performers.bio}), '') is not null`,
          sql`nullif(trim(${performers.displayName}), '') is not null`
        )),
      // Venue/location is event context only — no fake /v/ venue URLs.
      businessDb.select({
        id: performerEvents.id,
        updatedAt: performerEvents.updatedAt,
        startsAt: performerEvents.startsAt
      })
        .from(performerEvents)
        .where(and(
          eq(performerEvents.status, 'published'),
          eq(performerEvents.visibility, 'public'),
          gt(performerEvents.startsAt, new Date()),
          sql`nullif(trim(${performerEvents.title}), '') is not null`
        )),
      // Align with getPublicRelease: never list private distributionMode releases.
      businessDb.select({
        id: musicReleases.id,
        updatedAt: musicReleases.updatedAt,
        publishedAt: musicReleases.publishedAt
      })
        .from(musicReleases)
        .where(and(
          inArray(musicReleases.status, ['ready', 'scheduled', 'published']),
          ne(musicReleases.distributionMode, 'private'),
          sql`nullif(trim(${musicReleases.title}), '') is not null`
        ))
    ]);

    const rowsByHandle = new Map<string, typeof profileRows>();
    for (const row of profileRows) {
      if (!isDiscoveryEligibleHandle(row.handle)) continue;
      const normalizedHandle = normalizePerformerHandle(row.handle)?.toLowerCase();
      if (!normalizedHandle) continue;
      const existing = rowsByHandle.get(normalizedHandle) ?? [];
      existing.push(row);
      rowsByHandle.set(normalizedHandle, existing);
    }
    for (const [normalizedHandle, rows] of rowsByHandle) {
      if (rows.length !== 1) continue;
      const row = rows[0];
      const policy = evaluatePublicPerformerVisibility({
        claimed: true,
        hasOwner: Boolean(row.ownerUserId),
        isActive: row.isActive,
        onboardingStatus: row.onboardingStatus,
        visibilityState: row.visibilityState,
        handle: normalizedHandle,
        displayName: row.displayName,
        conflicted: false
      });
      if (policy.kind !== 'public') continue;
      const loc = `${CANONICAL_APP_ORIGIN}/p/${encodeURIComponent(normalizedHandle)}`;
      const lastmod = row.updatedAt instanceof Date && !Number.isNaN(row.updatedAt.getTime())
        ? row.updatedAt.toISOString()
        : null;
      entries.set(loc, { loc, lastmod });
    }
    for (const row of eventRows) {
      const loc = `${CANONICAL_APP_ORIGIN}/e/${row.id}`;
      const stamp = row.updatedAt || row.startsAt;
      const lastmod = stamp instanceof Date && !Number.isNaN(stamp.getTime()) ? stamp.toISOString() : null;
      entries.set(loc, { loc, lastmod });
    }
    for (const row of releaseRows) {
      const loc = `${CANONICAL_APP_ORIGIN}/r/${row.id}`;
      const stamp = row.publishedAt || row.updatedAt;
      const lastmod = stamp instanceof Date && !Number.isNaN(stamp.getTime()) ? stamp.toISOString() : null;
      entries.set(loc, { loc, lastmod });
    }
    } catch (error) {
      console.error('[sway.discovery] sitemap generation failed:', error);
      return res
        .status(503)
        .type('application/xml')
        .set('X-Robots-Tag', 'noindex, nofollow')
        .send('Sitemap temporarily unavailable.');
    }
  }

  const body = [...entries.values()]
    .sort((a, b) => a.loc.localeCompare(b.loc))
    .map((entry) => {
      const lastmod = entry.lastmod
        ? `\n    <lastmod>${escapeXml(entry.lastmod.slice(0, 10))}</lastmod>`
        : '';
      return `  <url>\n    <loc>${escapeXml(entry.loc)}</loc>${lastmod}\n  </url>`;
    })
    .join('\n');
  res.type('application/xml').set('Cache-Control', 'public, max-age=900').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>`
  );
});

app.get('/support', (req, res) => {
  const orderId = typeof req.query.orderId === 'string' && UUID_PATTERN.test(req.query.orderId)
    ? req.query.orderId
    : null;
  const ticketId = typeof req.query.ticketId === 'string' && UUID_PATTERN.test(req.query.ticketId)
    ? req.query.ticketId
    : null;
  const reference = orderId
    ? { type: 'order' as const, id: orderId }
    : ticketId
      ? { type: 'ticket' as const, id: ticketId }
      : null;
  res.type('html').send(renderSupportPageHtml(reference));
});

app.get('/faq', (_req, res) => {
  res.type('html').send(faqPageHtml);
});

app.get('/about', (_req, res) => {
  res.type('html').send(aboutPageHtml);
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

app.get('/legal/tickets', (_req, res) => {
  res.type('html').send(ticketTermsPageHtml);
});

app.get('/privacy/data-deletion', (_req, res) => {
  res.type('html').send(dataDeletionPageHtml);
});

app.get('/api/support/contact', (_req, res) => {
  return res.json({
    success: Boolean(nativeTicketRuntimeConfig.supportEmail),
    message: nativeTicketRuntimeConfig.supportEmail
      ? 'The monitored Sway support contact is available.'
      : 'The monitored Sway support contact is temporarily unavailable.',
    supportEmail: nativeTicketRuntimeConfig.supportEmail,
    supportPath: '/support',
    faqPath: '/faq',
    privacyPolicyPath: '/privacy',
    termsPath: '/terms',
    dataDeletionPath: '/privacy/data-deletion',
    paymentTermsPath: '/legal/payments',
    payoutTermsPath: '/legal/payouts',
    ticketTermsPath: '/legal/tickets'
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
        externalTrackId: performerLibraryTracks.externalTrackId,
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

    const catalogRows = await loadRequestableCatalogTracks(businessDb, {
      performerId: gigRow.performerId,
      query,
      limit: 25
    });

    return res.json({
      results: [
        ...catalogRows.map((row: any) => ({
          id: `catalog:${row.id}`,
          title: row.title || row.filename,
          artist: 'Catalog',
          albumArt,
          description: row.projectTitle || 'Catalog',
          source: 'Catalog',
          sourceProvider: 'sway_catalog',
          category: 'sway_catalog',
          targetType: 'music'
        })),
        ...libraryRows.map((row) => ({
          id: row.id,
          sourceTrackId: row.id,
          externalTrackId: row.externalTrackId,
          title: row.title,
          artist: row.artist,
          albumArt: row.artworkUrl || albumArt,
          description: row.album || 'Available in performer library',
          source: row.sourceLabel,
          category: 'external_request_music',
          sourceProvider: typeof (row.metadata as any)?.sourceProvider === 'string' ? (row.metadata as any).sourceProvider : undefined,
          spotifyUri: typeof (row.metadata as any)?.spotifyUri === 'string' ? (row.metadata as any).spotifyUri : undefined,
          spotifyUrl: typeof (row.metadata as any)?.spotifyUrl === 'string' ? (row.metadata as any).spotifyUrl : undefined,
          targetType: 'music'
        }))
      ].slice(0, 25),
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

function startEventTicketWorker() {
  if (!eventTicketService) return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await eventTicketService.runMaintenance({ limit: 100 });
      await eventTicketService.runDueOperations({ limit: 50 });
    } catch (error) {
      console.error(
        '[sway.tickets] durable worker iteration failed:',
        error instanceof Error ? error.message : error
      );
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => {
    void tick();
  }, 15_000);
  timer.unref();
}

function startLiveRoomPaymentWorker() {
  if (!liveRoomDurabilityWritesEnabled || !paymentService.hasDurableStore) return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      if (paymentService.isEnabled()) {
        await paymentService.runDueOperations({ limit: 50 });
      }
      await paymentService.reconcileActionVisibility({ limit: 50 });
      await paymentWebhookService?.runDueEvents({ limit: 50 });
    } catch (error) {
      console.error(
        '[sway.payments] durable worker iteration failed:',
        error instanceof Error ? error.message : error
      );
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => {
    void tick();
  }, 5_000);
  timer.unref();
}

function startAudioUploadCleanupWorker() {
  if (!audioPublishingService) return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await audioPublishingService.expireStaleUploadSessions({ limit: 100 });
      if (result.failedCount > 0) {
        console.warn(
          `[sway.audio] ${result.failedCount} expired multipart upload(s) could not be aborted and will retry.`
        );
      }
    } catch (error) {
      console.error(
        '[sway.audio] expired multipart cleanup failed:',
        error instanceof Error ? error.message : error
      );
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => {
    void tick();
  }, 15 * 60 * 1000);
  timer.unref();
}

// Vite Middleware & Front-End Serving Config
async function startServer() {
  if (audioObjectStore) {
    await audioObjectStore.verifyReady();
    audioObjectStoreVerified = true;
    console.log(`[sway.audio] verified private ${audioObjectStore.provider} bucket access.`);
  }
  await refreshBusinessState();
  startEventTicketWorker();
  startLiveRoomPaymentWorker();
  startAudioUploadCleanupWorker();

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
    const handlePublicPerformerRoute = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      try {
        const templatePath = path.join(process.cwd(), shellHtmlRelativePath('patron'));
        const template = readFileSync(templatePath, 'utf8');
        const transformedHtml = await vite.transformIndexHtml(req.originalUrl, template);
        await renderPublicPerformerDocument(req, res, transformedHtml);
      } catch (error) {
        next(error);
      }
    };
    app.get('/p/:handle', handlePublicPerformerRoute);
    app.get(/^\/p\/.+$/, handlePublicPerformerRoute);
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
    const handlePublicPerformerRoute = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      try {
        const htmlPath = path.join(distPath, shellHtmlRelativePath('patron'));
        const template = readFileSync(htmlPath, 'utf8');
        await renderPublicPerformerDocument(req, res, template);
      } catch (error) {
        next(error);
      }
    };
    app.get('/p/:handle', handlePublicPerformerRoute);
    app.get(/^\/p\/.+$/, handlePublicPerformerRoute);
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

startServer().catch((error) => {
  console.error('[sway.startup] server failed before accepting traffic:', error);
  process.exitCode = 1;
});
