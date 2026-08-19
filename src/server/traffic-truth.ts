import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  SWAY_TRAFFIC_TRUTH_QA_COOKIE,
  SWAY_TRAFFIC_TRUTH_QA_QUERY_KEY,
  SWAY_TRAFFIC_TRUTH_QA_QUERY_VALUE
} from '../traffic-truth-contract';

export type TrafficTruthClass =
  | 'human_candidate'
  | 'known_bot'
  | 'scanner'
  | 'internal_qa'
  | 'platform_probe'
  | 'unknown_automation';

export type TrafficTruthRouteFamily =
  | 'home'
  | 'live_room'
  | 'performer_profile'
  | 'public_event'
  | 'public_release'
  | 'discover'
  | 'ticket'
  | 'performer_entry'
  | 'trust_legal'
  | 'crawler_resource'
  | 'unknown_public';

export type TrafficTruthAttributionChannel =
  | 'chatgpt'
  | 'google'
  | 'bing'
  | 'duckduckgo'
  | 'facebook'
  | 'instagram'
  | 'sway'
  | 'direct'
  | 'referral'
  | 'unknown';

type RequestHeaderValue = string | string[] | undefined;

export type TrafficTruthRequestLike = {
  method: string;
  path: string;
  headers: Record<string, RequestHeaderValue>;
  query?: Record<string, unknown>;
  ip?: string;
};

export type TrafficTruthResponseLike = {
  statusCode: number;
  once(event: 'finish' | 'close', listener: () => void): unknown;
};

export type TrafficTruthDecision = {
  classification: TrafficTruthClass;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  botFamily: string | null;
  routeFamily: TrafficTruthRouteFamily;
  attributionChannel: TrafficTruthAttributionChannel;
  visitorId: string | null;
  shouldLog: boolean;
  blockAsScanner: boolean;
};

const BOT_USER_AGENTS: ReadonlyArray<{ family: string; pattern: RegExp }> = [
  { family: 'google', pattern: /googlebot|google-inspectiontool|googleother/i },
  { family: 'bing', pattern: /bingbot|bingpreview/i },
  { family: 'apple', pattern: /applebot/i },
  { family: 'openai', pattern: /gptbot|oai-searchbot|chatgpt-user/i },
  { family: 'meta', pattern: /facebookexternalhit|facebot|meta-externalagent/i },
  { family: 'ahrefs', pattern: /ahrefsbot/i },
  { family: 'majestic', pattern: /mj12bot/i },
  { family: 'semrush', pattern: /semrushbot/i },
  { family: 'yandex', pattern: /yandexbot/i },
  { family: 'baidu', pattern: /baiduspider/i },
  { family: 'pinterest', pattern: /pinterestbot/i },
  { family: 'linkedin', pattern: /linkedinbot/i },
  { family: 'x', pattern: /twitterbot/i },
  { family: 'slack', pattern: /slackbot/i },
  { family: 'discord', pattern: /discordbot/i }
];

const PLATFORM_PROBE_USER_AGENTS: ReadonlyArray<{ family: string; pattern: RegExp }> = [
  { family: 'render', pattern: /render(?:-health)?|render\.com/i },
  { family: 'uptimerobot', pattern: /uptimerobot/i },
  { family: 'pingdom', pattern: /pingdom/i },
  { family: 'statuscake', pattern: /statuscake/i },
  { family: 'better-uptime', pattern: /better uptime|betterstack/i },
  { family: 'kubernetes', pattern: /kube-probe/i }
];

const AUTOMATION_USER_AGENT_PATTERN = /headlesschrome|playwright|puppeteer|cypress|selenium|phantomjs|postmanruntime|curl\/|wget\/|python-requests|python-urllib|aiohttp|node-fetch|undici|go-http-client|libwww-perl|apache-httpclient|axios\//i;
const BROWSER_USER_AGENT_PATTERN = /mozilla\/5\.0.*(?:chrome|crios|safari|firefox|fxios|edg|opr|samsungbrowser)/i;

const SCANNER_PATH_PATTERNS: readonly RegExp[] = [
  /^\/\.env(?:[./]|$)/i,
  /^\/\.git(?:[./]|$)/i,
  /^\/(?:wp-admin|wp-content|wp-includes|wp-json)(?:[/?]|$)/i,
  /^\/wp-(?:login|config|cron|signup|activate)\.php(?:[/?]|$)/i,
  /^\/xmlrpc\.php(?:[/?]|$)/i,
  /(?:^|\/)wlwmanifest\.xml(?:[/?]|$)/i,
  /^\/(?:phpmyadmin|pma|adminer)(?:[/?]|$)/i,
  /^\/(?:vendor\/phpunit|actuator|server-status|cgi-bin)(?:[/?]|$)/i,
  /(?:etc\/passwd|proc\/self\/environ)/i,
  /\.(?:php|asp|aspx|cgi)(?:[/?]|$)/i
];

const STATIC_ASSET_PATTERN = /\.(?:avif|bmp|css|gif|ico|jpe?g|js|map|mjs|mp3|mp4|ogg|pdf|png|svg|webm|webp|woff2?|ttf)$/i;

function firstHeaderValue(value: RequestHeaderValue) {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function firstQueryValue(value: unknown) {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : '';
  return typeof value === 'string' ? value : '';
}

function normalizeClientAddress(raw: string) {
  const first = raw.split(',')[0]?.trim() ?? '';
  const unwrapped = first.replace(/^::ffff:/i, '');
  if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(unwrapped)) {
    return unwrapped.replace(/:\d+$/, '');
  }
  return unwrapped.slice(0, 128);
}

function resolveClientAddress(req: TrafficTruthRequestLike) {
  const forwarded = firstHeaderValue(req.headers['x-forwarded-for']);
  return normalizeClientAddress(forwarded || req.ip || '');
}

function safeSecretMatch(candidate: string, expected: string) {
  if (!candidate || !expected) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function configuredQaAddresses(env: NodeJS.ProcessEnv) {
  return new Set(
    (env.SWAY_TRAFFIC_TRUTH_QA_IPS || '')
      .split(/[\s,]+/)
      .map((value) => normalizeClientAddress(value))
      .filter(Boolean)
  );
}

function hasQaCookie(req: TrafficTruthRequestLike) {
  const cookie = firstHeaderValue(req.headers.cookie);
  return cookie
    .split(';')
    .map((part) => part.trim().toLowerCase())
    .includes(`${SWAY_TRAFFIC_TRUTH_QA_COOKIE}=qa`);
}

function hasQaQueryMarker(req: TrafficTruthRequestLike) {
  return firstQueryValue(req.query?.[SWAY_TRAFFIC_TRUTH_QA_QUERY_KEY]).toLowerCase()
    === SWAY_TRAFFIC_TRUTH_QA_QUERY_VALUE;
}

function internalQaReason(req: TrafficTruthRequestLike, env: NodeJS.ProcessEnv) {
  const configuredToken = env.SWAY_TRAFFIC_TRUTH_QA_TOKEN?.trim() || '';
  const suppliedToken = firstHeaderValue(req.headers['x-sway-traffic-qa']);
  if (configuredToken && safeSecretMatch(suppliedToken, configuredToken)) {
    return 'authenticated_qa_header';
  }

  const address = resolveClientAddress(req);
  if (address && configuredQaAddresses(env).has(address)) {
    return 'configured_qa_address';
  }

  if (hasQaCookie(req)) return 'explicit_qa_cookie';
  if (hasQaQueryMarker(req)) return 'explicit_qa_query';
  return null;
}

function knownUserAgentFamily(userAgent: string, candidates: ReadonlyArray<{ family: string; pattern: RegExp }>) {
  return candidates.find((candidate) => candidate.pattern.test(userAgent))?.family ?? null;
}

function isScannerPath(pathname: string) {
  return SCANNER_PATH_PATTERNS.some((pattern) => pattern.test(pathname));
}

function routeFamily(pathname: string): TrafficTruthRouteFamily | null {
  if (pathname === '/') return 'home';
  if (/^\/g(?:\/|$)/i.test(pathname)) return 'live_room';
  if (/^\/p(?:\/|$)/i.test(pathname)) return 'performer_profile';
  if (/^\/e(?:\/|$)/i.test(pathname)) return 'public_event';
  if (/^\/r(?:\/|$)/i.test(pathname)) return 'public_release';
  if (/^\/discover(?:\/|$)/i.test(pathname)) return 'discover';
  if (/^\/tickets?(?:\/|$)/i.test(pathname)) return 'ticket';
  if (/^\/talent\/(?:login|signup|invite|claim|connect\/files)\/?$/i.test(pathname)) return 'performer_entry';
  if (/^\/(?:privacy|terms|trust|legal)(?:\/|$)/i.test(pathname)) return 'trust_legal';
  if (/^\/(?:robots\.txt|sitemap\.xml|llms\.txt)$/i.test(pathname)) return 'crawler_resource';
  if (/^\/(?:admin|overlay|talent)(?:\/|$)/i.test(pathname)) return null;
  return 'unknown_public';
}

function attributionFromText(value: string): TrafficTruthAttributionChannel | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.includes('chatgpt') || normalized.includes('openai')) return 'chatgpt';
  if (normalized.includes('google')) return 'google';
  if (normalized.includes('bing')) return 'bing';
  if (normalized.includes('duckduckgo')) return 'duckduckgo';
  if (normalized.includes('facebook') || normalized === 'fb') return 'facebook';
  if (normalized.includes('instagram')) return 'instagram';
  if (normalized.includes('sway.tips')) return 'sway';
  return null;
}

function resolveAttributionChannel(req: TrafficTruthRequestLike): TrafficTruthAttributionChannel {
  const utmSource = firstQueryValue(req.query?.utm_source);
  const utmChannel = attributionFromText(utmSource);
  if (utmChannel) return utmChannel;
  if (utmSource) return 'referral';

  const referrer = firstHeaderValue(req.headers.referer || req.headers.referrer);
  if (!referrer) return 'direct';
  const knownReferrer = attributionFromText(referrer);
  if (knownReferrer) return knownReferrer;

  try {
    const referrerHost = new URL(referrer).hostname.replace(/^www\./i, '').toLowerCase();
    const requestHost = firstHeaderValue(req.headers.host).split(':')[0]?.replace(/^www\./i, '').toLowerCase();
    if (referrerHost && requestHost && referrerHost === requestHost) return 'sway';
    return 'referral';
  } catch {
    return 'unknown';
  }
}

function isBrowserNavigation(req: TrafficTruthRequestLike, userAgent: string) {
  const accept = firstHeaderValue(req.headers.accept).toLowerCase();
  const fetchMode = firstHeaderValue(req.headers['sec-fetch-mode']).toLowerCase();
  const fetchDest = firstHeaderValue(req.headers['sec-fetch-dest']).toLowerCase();
  return BROWSER_USER_AGENT_PATTERN.test(userAgent)
    && (
      fetchMode === 'navigate'
      || fetchDest === 'document'
      || accept.includes('text/html')
    );
}

function dailyVisitorId(
  req: TrafficTruthRequestLike,
  env: NodeJS.ProcessEnv,
  now: Date
) {
  const salt = env.SWAY_TRAFFIC_TRUTH_SALT?.trim() || '';
  if (salt.length < 32) return null;
  const address = resolveClientAddress(req);
  const userAgent = firstHeaderValue(req.headers['user-agent']).slice(0, 512);
  if (!address || !userAgent) return null;
  const dayBucket = now.toISOString().slice(0, 10);
  return createHmac('sha256', salt)
    .update(`${dayBucket}|${address}|${userAgent}`)
    .digest('hex')
    .slice(0, 24);
}

function baseDecision(input: {
  classification: TrafficTruthClass;
  confidence: TrafficTruthDecision['confidence'];
  reason: string;
  botFamily?: string | null;
  routeFamily: TrafficTruthRouteFamily;
  attributionChannel: TrafficTruthAttributionChannel;
  visitorId?: string | null;
  shouldLog?: boolean;
  blockAsScanner?: boolean;
}): TrafficTruthDecision {
  return {
    classification: input.classification,
    confidence: input.confidence,
    reason: input.reason,
    botFamily: input.botFamily ?? null,
    routeFamily: input.routeFamily,
    attributionChannel: input.attributionChannel,
    visitorId: input.visitorId ?? null,
    shouldLog: input.shouldLog ?? true,
    blockAsScanner: input.blockAsScanner ?? false
  };
}

export function classifyTrafficTruthRequest(
  req: TrafficTruthRequestLike,
  env: NodeJS.ProcessEnv = process.env,
  now = new Date()
): TrafficTruthDecision {
  const pathname = req.path || '/';
  const resolvedRouteFamily = routeFamily(pathname);
  const fallbackRouteFamily = resolvedRouteFamily ?? 'unknown_public';
  const attributionChannel = resolveAttributionChannel(req);
  const userAgent = firstHeaderValue(req.headers['user-agent']);

  if (isScannerPath(pathname)) {
    return baseDecision({
      classification: 'scanner',
      confidence: 'high',
      reason: 'known_exploit_or_secret_probe_path',
      routeFamily: fallbackRouteFamily,
      attributionChannel,
      blockAsScanner: true
    });
  }

  if (!resolvedRouteFamily) {
    return baseDecision({
      classification: 'unknown_automation',
      confidence: 'low',
      reason: 'private_or_protected_surface_not_counted',
      routeFamily: fallbackRouteFamily,
      attributionChannel,
      shouldLog: false
    });
  }

  if (STATIC_ASSET_PATTERN.test(pathname) && resolvedRouteFamily !== 'crawler_resource') {
    return baseDecision({
      classification: 'unknown_automation',
      confidence: 'low',
      reason: 'static_asset_not_counted',
      routeFamily: resolvedRouteFamily,
      attributionChannel,
      shouldLog: false
    });
  }

  const qaReason = internalQaReason(req, env);
  if (qaReason) {
    return baseDecision({
      classification: 'internal_qa',
      confidence: 'high',
      reason: qaReason,
      routeFamily: resolvedRouteFamily,
      attributionChannel,
      visitorId: dailyVisitorId(req, env, now)
    });
  }

  const botFamily = knownUserAgentFamily(userAgent, BOT_USER_AGENTS);
  if (botFamily) {
    return baseDecision({
      classification: 'known_bot',
      confidence: 'high',
      reason: 'recognized_crawler_or_link_preview_user_agent',
      botFamily,
      routeFamily: resolvedRouteFamily,
      attributionChannel
    });
  }

  const platformFamily = knownUserAgentFamily(userAgent, PLATFORM_PROBE_USER_AGENTS);
  if (platformFamily) {
    return baseDecision({
      classification: 'platform_probe',
      confidence: 'high',
      reason: 'recognized_platform_health_or_uptime_probe',
      botFamily: platformFamily,
      routeFamily: resolvedRouteFamily,
      attributionChannel
    });
  }

  const method = req.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return baseDecision({
      classification: 'unknown_automation',
      confidence: 'medium',
      reason: 'non_navigation_public_request',
      routeFamily: resolvedRouteFamily,
      attributionChannel,
      shouldLog: false
    });
  }

  if (AUTOMATION_USER_AGENT_PATTERN.test(userAgent)) {
    return baseDecision({
      classification: 'unknown_automation',
      confidence: 'high',
      reason: 'recognized_automation_user_agent',
      routeFamily: resolvedRouteFamily,
      attributionChannel
    });
  }

  if (isBrowserNavigation(req, userAgent)) {
    return baseDecision({
      classification: 'human_candidate',
      confidence: 'medium',
      reason: 'browser_document_navigation_signal',
      routeFamily: resolvedRouteFamily,
      attributionChannel,
      visitorId: dailyVisitorId(req, env, now)
    });
  }

  return baseDecision({
    classification: 'unknown_automation',
    confidence: 'low',
    reason: 'insufficient_browser_or_known_bot_signal',
    routeFamily: resolvedRouteFamily,
    attributionChannel
  });
}

export function beginTrafficTruthObservation(
  req: TrafficTruthRequestLike,
  res: TrafficTruthResponseLike,
  env: NodeJS.ProcessEnv = process.env,
  now = new Date()
) {
  const decision = classifyTrafficTruthRequest(req, env, now);
  if (!decision.shouldLog) return decision;

  const startedAt = Date.now();
  let emitted = false;
  const emit = () => {
    if (emitted) return;
    emitted = true;
    const record = {
      traffic_truth_version: 1,
      classification: decision.classification,
      confidence: decision.confidence,
      reason: decision.reason,
      bot_family: decision.botFamily,
      route_family: decision.routeFamily,
      attribution_channel: decision.attributionChannel,
      visitor_day_id: decision.visitorId,
      method: req.method.toUpperCase(),
      status_code: res.statusCode,
      duration_ms: Math.max(0, Date.now() - startedAt),
      occurred_at: now.toISOString()
    };
    console.info('[sway.traffic.truth]', JSON.stringify(record));
  };

  res.once('finish', emit);
  res.once('close', emit);
  return decision;
}
