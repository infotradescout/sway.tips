/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from "express";
import path from "path";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { execFileSync } from "child_process";
import { createHash, randomBytes } from "crypto";
import { readFileSync } from "fs";
import { and, asc, eq, gt, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { ActiveRoomSummary, BackendState, RequestItem, GigSession, BoostContribution } from "./src/types";
import { createSwayDb } from "./src/db/client";
import { activeBlocks, activeRoomRegistry, gigAccessGrants, gigSessions, moderationEvents, performerLibrarySources, performerLibraryTracks, performerPublicProfiles, performerSetlistTracks, performerMemberships, performers, users } from "./src/db/schema";
import { createAccessControl, routeFamilyGuard } from "./src/server/access-control";
import { createIdempotencyStore, type DurableActionInput } from "./src/server/idempotency-store";
import { createModerationService, type BlockScope } from "./src/server/moderation-service";
import { createBusinessStore } from "./src/server/business-store";
import { toAuditEntityUuid, writeAuditEvent } from "./src/server/audit-log";
import { createConfiguredPaymentProvider } from "./src/server/payment-provider";
import { createPaymentService } from "./src/server/payment-service";
import { createPaymentWebhookService } from "./src/server/payment-webhook";
import { verifyPerformerBootstrapToken } from "./src/server/performer-bootstrap";
import { createPerformerSessionStore } from "./src/server/performer-session-store";
import {
  createPerformerLoginChallengeStore,
  createPerformerLoginRateLimiter,
  hashPerformerLoginRequesterIp,
  normalizePerformerDisplayName,
  normalizePerformerLoginEmail,
  normalizePerformerHandle,
  PERFORMER_LOGIN_CHALLENGE_TYPE_LOGIN,
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
import { searchCatalog } from "./src/server/spotify-catalog";
import { createConfiguredStripeConnectService } from "./src/server/stripe-connect";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT ?? 3000);
const isProduction = process.env.NODE_ENV === "production";
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

const DEFAULT_SHARE_TITLE = 'Sway | Live Crowd Requests';
const DEFAULT_SHARE_DESCRIPTION = 'Scan into a live Sway room to request, tip, boost, and follow the queue in real time.';
const DEFAULT_SHARE_IMAGE_PATH = '/social-preview.png?v=1';
const DEFAULT_SHARE_IMAGE_WIDTH = 1672;
const DEFAULT_SHARE_IMAGE_HEIGHT = 941;

function escapeHtmlAttribute(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

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
  const title = escapeHtmlAttribute(metadata.title);
  const description = escapeHtmlAttribute(metadata.description);
  const url = escapeHtmlAttribute(metadata.url);
  const image = escapeHtmlAttribute(metadata.image);
  const imageAlt = escapeHtmlAttribute(metadata.imageAlt);

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

async function resolveShareMetadata(req: express.Request): Promise<ShareMetadata> {
  const pathParts = req.path.split('/').filter(Boolean);
  const defaultMetadata = defaultShareMetadata(req);

  if (!businessDb) return defaultMetadata;

  if (pathParts[0] === 'p' && pathParts[1]) {
    const normalizedHandle = normalizePerformerHandle(pathParts[1]);
    if (!normalizedHandle) return defaultMetadata;

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
      .where(sql`lower(${performers.handle}) = ${normalizedHandle.toLowerCase()}`)
      .limit(1);

    if (!profile) return defaultMetadata;

    const title = `${profile.displayName} on Sway`;
    const handleCopy = profile.handle ? `@${profile.handle}` : 'this performer';
    const locationCopy = profile.city ? ` in ${profile.city}` : '';
    const description = profile.headline || profile.bio || `Join ${handleCopy}${locationCopy} on Sway for live requests, tips, boosts, and queue updates.`;

    return defaultShareMetadata(req, {
      title,
      description,
      image: profile.avatarUrl || DEFAULT_SHARE_IMAGE_PATH,
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
      .where(eq(activeRoomRegistry.gigId, pathParts[1]))
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
      image: room.avatarUrl || DEFAULT_SHARE_IMAGE_PATH,
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

async function performerHandleExists(executor: any, handle: string) {
  const [row] = await executor
    .select({ id: performers.id })
    .from(performers)
    .where(sql`lower(${performers.handle}) = ${handle.toLowerCase()}`)
    .limit(1);

  return Boolean(row);
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
      handle: performers.handle
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

function normalizePublicProfileText(value: unknown, maxLength = 160) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function normalizePublicProfileUrl(value: unknown) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function toPublicSocialLinks(row: {
  instagramUrl: string | null;
  tiktokUrl: string | null;
  youtubeUrl: string | null;
  soundcloudUrl: string | null;
  websiteUrl: string | null;
}) {
  return {
    instagram: row.instagramUrl,
    tiktok: row.tiktokUrl,
    youtube: row.youtubeUrl,
    soundcloud: row.soundcloudUrl,
    website: row.websiteUrl
  };
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

function performerSignupSuccessResponse() {
  return {
    success: true,
    message: PERFORMER_SIGNUP_SUCCESS_COPY
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
    hasPerformerLoginEmailConfig: !isProduction || Boolean(
      process.env.SWAY_EMAIL_PROVIDER?.trim()
      && process.env.SWAY_EMAIL_API_KEY?.trim()
      && process.env.SWAY_EMAIL_FROM?.trim()
      && (process.env.SWAY_APP_BASE_URL?.trim() || process.env.APP_URL?.trim())
    ),
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

app.post('/api/talent/signup', async (req, res) => {
  applyNoStoreHeaders(res);

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
          role: 'performer'
        })
        .returning({
          id: users.id
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
      await performerLoginChallengeStore.revokeChallengeById({
        challengeId: outcome.challengeId
      });
      res.status(503).json({ error: 'Performer verification email delivery is temporarily unavailable.' });
      return;
    }

    res.status(202).json(performerSignupSuccessResponse());
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

  const [profileRow] = await businessDb
    .select({
      performerId: performerPublicProfiles.performerId,
      headline: performerPublicProfiles.headline,
      city: performerPublicProfiles.city,
      avatarUrl: performerPublicProfiles.avatarUrl,
      instagramUrl: performerPublicProfiles.instagramUrl,
      tiktokUrl: performerPublicProfiles.tiktokUrl,
      youtubeUrl: performerPublicProfiles.youtubeUrl,
      soundcloudUrl: performerPublicProfiles.soundcloudUrl,
      websiteUrl: performerPublicProfiles.websiteUrl,
      updatedAt: performerPublicProfiles.updatedAt
    })
    .from(performerPublicProfiles)
    .where(eq(performerPublicProfiles.performerId, performerOwner.performerId))
    .limit(1);

  return res.json({
    profile: {
      performerId: performerOwner.performerId,
      handle: performerOwner.handle,
      displayName: performerOwner.displayName,
      headline: profileRow?.headline ?? null,
      city: profileRow?.city ?? null,
      avatarUrl: profileRow?.avatarUrl ?? null,
      socialLinks: toPublicSocialLinks({
        instagramUrl: profileRow?.instagramUrl ?? null,
        tiktokUrl: profileRow?.tiktokUrl ?? null,
        youtubeUrl: profileRow?.youtubeUrl ?? null,
        soundcloudUrl: profileRow?.soundcloudUrl ?? null,
        websiteUrl: profileRow?.websiteUrl ?? null
      }),
      updatedAt: profileRow?.updatedAt ?? null
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

  const headline = normalizePublicProfileText(req.body?.headline, 140);
  const city = normalizePublicProfileText(req.body?.city, 80);
  const avatarUrl = normalizePublicProfileUrl(req.body?.avatarUrl);
  const instagramUrl = normalizePublicProfileUrl(req.body?.socialLinks?.instagram);
  const tiktokUrl = normalizePublicProfileUrl(req.body?.socialLinks?.tiktok);
  const youtubeUrl = normalizePublicProfileUrl(req.body?.socialLinks?.youtube);
  const soundcloudUrl = normalizePublicProfileUrl(req.body?.socialLinks?.soundcloud);
  const websiteUrl = normalizePublicProfileUrl(req.body?.socialLinks?.website);

  await businessDb
    .insert(performerPublicProfiles)
    .values({
      performerId: performerOwner.performerId,
      headline,
      city,
      avatarUrl,
      instagramUrl,
      tiktokUrl,
      youtubeUrl,
      soundcloudUrl,
      websiteUrl,
      updatedAt: new Date()
    })
    .onConflictDoUpdate({
      target: performerPublicProfiles.performerId,
      set: {
        headline,
        city,
        avatarUrl,
        instagramUrl,
        tiktokUrl,
        youtubeUrl,
        soundcloudUrl,
        websiteUrl,
        updatedAt: new Date()
      }
    });

  return res.status(202).json({
    success: true,
    profile: {
      performerId: performerOwner.performerId,
      handle: performerOwner.handle,
      displayName: performerOwner.displayName,
      headline,
      city,
      avatarUrl,
      socialLinks: {
        instagram: instagramUrl,
        tiktok: tiktokUrl,
        youtube: youtubeUrl,
        soundcloud: soundcloudUrl,
        website: websiteUrl
      }
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
          artworkUrl: performerLibraryTracks.artworkUrl
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
        spotifyUri: null,
        spotifyUrl: null
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
  res.json({
    session: state.session,
    requests: state.requests,
    performers: state.performers,
    activeGigId: talentAccess.allowed ? state.activeGigId : null,
    performerProfile
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
      return res.json({
        rooms: selectedRooms.map((room) => ({
          gigId: room.gigId,
          routePath: room.routePath,
          performerName: room.performerName,
          talentRole: room.talentRole,
          requestCount: room.requestCount,
          startedAt: room.startedAt,
          profile: null
        }))
      });
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
        instagramUrl: performerPublicProfiles.instagramUrl,
        tiktokUrl: performerPublicProfiles.tiktokUrl,
        youtubeUrl: performerPublicProfiles.youtubeUrl,
        soundcloudUrl: performerPublicProfiles.soundcloudUrl,
        websiteUrl: performerPublicProfiles.websiteUrl
      })
      .from(gigSessions)
      .innerJoin(performers, eq(performers.id, gigSessions.performerId))
      .leftJoin(performerPublicProfiles, eq(performerPublicProfiles.performerId, performers.id))
      .where(inArray(gigSessions.id, gigIds));

    const detailsByGigId = new Map(details.map((row) => [row.gigId, row]));

    return res.json({
      rooms: selectedRooms.map((room) => {
        const detail = detailsByGigId.get(room.gigId);
        return {
          gigId: room.gigId,
          routePath: room.routePath,
          performerName: detail?.performerName || room.performerName,
          performerHandle: detail?.performerHandle || null,
          performerPath: detail?.performerHandle ? `/p/${detail.performerHandle}` : null,
          talentRole: room.talentRole,
          requestCount: room.requestCount,
          startedAt: room.startedAt,
          profile: detail ? {
            headline: detail.headline,
            city: detail.city,
            avatarUrl: detail.avatarUrl,
            socialLinks: toPublicSocialLinks({
              instagramUrl: detail.instagramUrl,
              tiktokUrl: detail.tiktokUrl,
              youtubeUrl: detail.youtubeUrl,
              soundcloudUrl: detail.soundcloudUrl,
              websiteUrl: detail.websiteUrl
            })
          } : null
        };
      })
    });
  } catch (error) {
    console.error('Public feed lookup failed:', error);
    return res.status(500).json({ error: 'Unable to load the public feed right now.' });
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
        displayName: performers.displayName,
        handle: performers.handle,
        bio: performers.bio,
        headline: performerPublicProfiles.headline,
        city: performerPublicProfiles.city,
        avatarUrl: performerPublicProfiles.avatarUrl,
        instagramUrl: performerPublicProfiles.instagramUrl,
        tiktokUrl: performerPublicProfiles.tiktokUrl,
        youtubeUrl: performerPublicProfiles.youtubeUrl,
        soundcloudUrl: performerPublicProfiles.soundcloudUrl,
        websiteUrl: performerPublicProfiles.websiteUrl
      })
      .from(performers)
      .leftJoin(performerPublicProfiles, eq(performerPublicProfiles.performerId, performers.id))
      .where(sql`lower(${performers.handle}) = ${normalizedHandle.toLowerCase()}`)
      .limit(1);

    if (!profile) {
      return res.status(404).json({ error: 'Performer profile not found.' });
    }

    const [activeRoom] = await businessDb
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
      .limit(1);

    const activeRooms = await listReadableActiveRooms();
    const activeRoomSummary = activeRoom
      ? activeRooms.find((room) => room.gigId === activeRoom.gigId) ?? null
      : null;

    return res.json({
      performer: {
        id: profile.performerId,
        displayName: profile.displayName,
        handle: profile.handle,
        bio: profile.bio,
        headline: profile.headline,
        city: profile.city,
        avatarUrl: profile.avatarUrl,
        socialLinks: toPublicSocialLinks({
          instagramUrl: profile.instagramUrl,
          tiktokUrl: profile.tiktokUrl,
          youtubeUrl: profile.youtubeUrl,
          soundcloudUrl: profile.soundcloudUrl,
          websiteUrl: profile.websiteUrl
        })
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

  return res.json({
    session: roomSnapshot.state.session,
    requests: roomSnapshot.state.requests,
    performers: roomSnapshot.state.performers,
    activeGigId: roomSnapshot.state.activeGigId,
    room_lookup: 'active'
  });
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
  const { talentName, talentRole, feeType, minimumTip, gig_id } = req.body;

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
    minimumTip: Number(minimumTip) || 5,
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
      minimumTip: roomState.session.minimumTip
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
  const roomState = roomContext.state;
  const previousStatus = roomState.session.requestsOpen ? 'open' : 'closed';
  
  roomState.session.requestsOpen = !!open;
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
  res.json({ success: true, state: prepareRoomState(roomState, roomContext.gigId) });
});

// Operator selects the room-layer operating posture. Only the two usable runtime
// postures are accepted; any other value is rejected as defensive validation.
app.post("/api/session/mode", async (req, res) => {
  const roomContext = await resolveLegacyWritableRoom(req, res);
  if (!roomContext) return;
  const actor = await resolveProtectedMutationActor(req, res, roomContext.gigId);
  if (!actor) return;
  const { mode } = req.body;
  const roomState = roomContext.state;

  if (mode !== 'manual' && mode !== 'open_call') {
    return res.status(400).json({ error: "mode must be 'manual' or 'open_call'." });
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
    metadata: { operatingMode: mode }
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
    client_request_id,
    idempotency_key,
    patron_device_id_hash = "anonymous-device",
    gig_id,
    currency = "USD",
    expires_at,
    payment_method,
    payment_intent_id
  } = req.body;

  if (!client_request_id || !idempotency_key) {
    return res.status(400).json({ error: "client_request_id and idempotency_key are required." });
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
  const payload_hash = hashPayload({ type, targetType, title, subtitle, senderName, message, albumArt });
  const idempotencyFingerprint = createIdempotencyFingerprint({
    idempotency_key,
    patron_device_id_hash,
    gig_id: durableGigId,
    action_type: targetType === 'straight_tip' || type === 'tip' ? 'tip' : 'request',
    target_entity_id: title || 'request',
    amount_cents,
    currency: String(currency).toUpperCase(),
    payload_hash
  });

  const durableInput: DurableActionInput = {
    clientRequestId: client_request_id,
    idempotencyKey: idempotency_key,
    patronDeviceIdHash: patron_device_id_hash,
    gigId: durableGigId,
    actionType: targetType === 'straight_tip' || type === 'tip' ? 'tip' : 'request',
    amountCents: amount_cents,
    currency: String(currency).toUpperCase(),
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
    return res.status(durableReplay.status).json(durableReplay.body);
  }

  const existingRequest = roomState.requests.find(r => r.idempotencyKey === idempotency_key);
  if (existingRequest) {
    if (existingRequest.idempotencyFingerprint !== idempotencyFingerprint) {
      return res.status(409).json({ error: "idempotency misuse: same key submitted with a different fingerprint." });
    }
    const responseBody = { success: true, request: existingRequest, state: roomState, reconciled: true };
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
  const platformFee = paymentsEnabledForAction ? 1.0 : 0;

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

  const newItem: RequestItem = {
    id: `req-${String(client_request_id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)}`,
    type: isStraightTip ? 'tip' : 'request',
    targetType: targetType || 'music',
    title: isStraightTip ? 'Straight Tip' : (title || 'Request'),
    subtitle: isStraightTip ? 'Supported the talent directly!' : (subtitle || ''),
    albumArt: albumArt || (targetType === 'music' ? "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=150&h=150&fit=crop" : undefined),
    senderName: senderName || "Anonymous Patron",
    message: message || "",
    amount: tipAmount,
    holdAmount: holdAmount,
    platformFee: platformFee,
    sponsorCount: 1,
    status: shadowBanned ? 'hold' : (isStraightTip ? 'fulfilled' : 'hold'),
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
    currency: String(currency).toUpperCase(),
    boosts: []
  };

  // Provider-backed authorization/hold. A paid request/tip must NOT enter app
  // state or Private Triage until the provider confirms a real hold
  // (PaymentIntent requires_capture). Fail safe / fail closed otherwise.
  if (!paymentsEnabledForAction) {
    // Free room, non-tip request: no money changes hands, nothing to authorize.
    newItem.paymentStatus = 'not_applicable';
  } else if (paymentService.isEnabled()) {
    const platformFeeCents = roomState.session.feeType === 'patron' ? 100 : 0;
    const authorization = confirmedPaymentIntentId
      ? await paymentService.confirmAuthorizedAction({
          gigId: durableGigId,
          actionType: isStraightTip ? 'tip' : 'request',
          amountSubtotalCents: amount_cents,
          platformFeeCents,
          currency: String(currency).toUpperCase(),
          runtimeRequestId: newItem.id,
          clientRequestId: client_request_id,
          processorPaymentIntentId: confirmedPaymentIntentId
        })
      : await paymentService.authorizeAction({
          gigId: durableGigId,
          actionType: isStraightTip ? 'tip' : 'request',
          amountSubtotalCents: amount_cents,
          platformFeeCents,
          currency: String(currency).toUpperCase(),
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
      newItem.paymentId = authorization.paymentId;
      newItem.paymentIntentId = authorization.processorPaymentIntentId;
      newItem.paymentStatus = 'authorized';
      // A straight tip is not gated by Private Triage, so capture its authorized
      // hold immediately.
      if (isStraightTip) {
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

  const responseBody = {
    success: true, 
    request: newItem,
    state: roomState,
    moderation: {
      outage_behavior: moderationOutcome.decision,
      ai_assistive_only: true
    },
    shadowBannedFeedback: shadowBanned ? "Request received and queued for performer review." : null
  };
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
    payment_intent_id
  } = req.body;
  let amt = Math.max(Number(boostAmount) || 0, 1); // Minimum boost of $1
  if (!client_request_id || !idempotency_key) {
    return res.status(400).json({ error: "client_request_id and idempotency_key are required." });
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
    currency,
    payload_hash
  });

  const durableInput: DurableActionInput = {
    clientRequestId: client_request_id,
    idempotencyKey: idempotency_key,
    patronDeviceIdHash: patron_device_id_hash,
    gigId: durableGigId,
    actionType: 'boost',
    amountCents: amount_cents,
    currency: String(currency).toUpperCase(),
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
    return res.status(durableReplay.status).json(durableReplay.body);
  }

  const existingBoost = request.boosts.find(b => b.idempotencyKey === idempotency_key);
  if (existingBoost) {
    if (existingBoost.idempotencyFingerprint !== idempotencyFingerprint) {
      return res.status(409).json({ error: "idempotency misuse: same key submitted with a different fingerprint." });
    }
    const responseBody = { success: true, request, boost: existingBoost, state: roomState, reconciled: true };
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
          platformFeeCents: 100,
          currency: String(currency).toUpperCase(),
          runtimeRequestId: request.id,
          clientRequestId: client_request_id,
          processorPaymentIntentId: confirmedPaymentIntentId
        })
      : await paymentService.authorizeAction({
          gigId: durableGigId,
          actionType: 'boost',
          amountSubtotalCents: amount_cents,
          platformFeeCents: 100,
          currency: String(currency).toUpperCase(),
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
  request.platformFee += 1.0; // Flat platform fee grows by $1 per boost
  request.sponsorCount += 1;

  if (isBackerShadowed) {
    request.shadowBanned = true; // Cascade shadow ban if the booster is vulgar
  }

  recalculateTotals(roomState);
  await persistBusinessStateForRoom(roomState, durableGigId);
  const responseBody = { success: true, request, state: roomState };
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
  const previousStatus = request.status;

  if (action === 'approve') {
    request.status = 'approved';
  } else {
    request.status = 'denied';
  }
  request.lastMutationActorUserId = actor.actorId;
  roomState.session.lastMutationActorUserId = actor.actorId;

  // Settle the provider-backed hold according to the triage decision.
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
  res.json({ success: true, request, state: prepareRoomState(roomState, roomContext.gigId) });
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
  const previousStatus = request.status;

  request.status = 'fulfilled';
  request.lastMutationActorUserId = actor.actorId;
  roomState.session.lastMutationActorUserId = actor.actorId;

  // Capture any still-authorized holds for the fulfilled request (idempotent:
  // already-captured holds are a no-op).
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

  res.json({ success: true, request, state: prepareRoomState(roomState, roomContext.gigId) });
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

  const previousStatus = request.hidden ? 'hidden' : 'visible';
  request.hidden = true;
  request.lastMutationActorUserId = actor.actorId;
  roomState.session.lastMutationActorUserId = actor.actorId;

  // A hidden request is never publicly eligible, so release its funds.
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
      reason: String(reason)
    }
  });

  await moderationService.hideRequest({
    requestId: String(requestId),
    reason: String(reason),
    // Always the authenticated actor -- never trust a client-supplied actor id.
    actorUserId: actor.actorId
  });

  return res.json({ success: true, moderation_action: 'hidden', request, state: prepareRoomState(roomState, roomContext.gigId) });
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
        sourceLabel: performerLibraryTracks.sourceLabel
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
