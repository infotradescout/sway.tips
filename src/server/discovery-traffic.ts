import { AsyncLocalStorage } from 'node:async_hooks';

type RequestSignals = {
  method?: string;
  path?: string;
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
};
export type DiscoveryTrafficClass = 'browser_candidate' | 'automation_signal' | 'qa_signal' | 'unclassified';
export type DiscoveryTrafficEvidence = Readonly<{
  version: 1;
  classification: DiscoveryTrafficClass;
  reason: string;
  basis: 'server_observed_request_signals';
}>;

const context = new AsyncLocalStorage<DiscoveryTrafficEvidence>();
const publicOrigins = new Set(['https://app.sway.tips', 'https://sway.tips', 'https://www.sway.tips']);
const automation = /googlebot|google-inspectiontool|bingbot|duckduckbot|yandexbot|baiduspider|gptbot|oai-searchbot|chatgpt-user|claudebot|claude-user|claude-searchbot|perplexitybot|perplexity-user|facebookexternalhit|facebot|twitterbot|linkedinbot|slackbot|discordbot|telegrambot|applebot|bytespider|ahrefsbot|semrushbot|mj12bot|petalbot|crawler|spider|(?:^|[^a-z])bot(?:[^a-z]|$)/i;
const diagnostics = /headlesschrome|playwright|puppeteer|selenium|webdriver|phantomjs|lighthouse|sway-runtime-proof|sway-.*(?:proof|verification)|curl\/|wget\/|python-requests|python-urllib|node-fetch|undici|go-http-client|postmanruntime|uptimerobot|pingdom/i;
function header(req: RequestSignals, name: string): string {
  const value = req.headers[name];
  return typeof value === 'string' && value.length <= 4096 ? value : '';
}
function evidence(classification: DiscoveryTrafficClass, reason: string): DiscoveryTrafficEvidence {
  return Object.freeze({ version: 1, classification, reason, basis: 'server_observed_request_signals' });
}
function ownedReferrer(value: string): URL | null {
  try {
    const url = new URL(value);
    return publicOrigins.has(url.origin) && !url.username && !url.password ? url : null;
  } catch { return null; }
}

/** This is exclusion/measurement evidence, never bot identity, human verification, or authorization. */
export function classifyDiscoveryRequest(req: RequestSignals): DiscoveryTrafficEvidence {
  const ua = header(req, 'user-agent');
  const referrer = ownedReferrer(header(req, 'referer'));
  if (header(req, 'x-sway-qa') === '1'
    || header(req, 'x-sway-traffic-class') === 'qa_automation'
    || referrer?.searchParams.get('sway_qa') === '1'
    || referrer?.searchParams.get('sway_traffic') === 'qa') {
    return evidence('qa_signal', 'explicit_diagnostic_marker');
  }
  if (diagnostics.test(ua)) return evidence('qa_signal', 'diagnostic_user_agent');
  if (automation.test(ua)) return evidence('automation_signal', 'automation_user_agent');
  // Header claims can be spoofed. A browser-shaped request remains only a candidate.
  // Missing evidence must not be upgraded merely because no bot token was found.
  const browserShaped = /^Mozilla\//.test(ua) && /Chrome\/|Safari\/|Firefox\/|Edg\//.test(ua);
  const fetchSite = header(req, 'sec-fetch-site');
  const origin = header(req, 'origin');
  const originConsistent = !origin || publicOrigins.has(origin);
  if (browserShaped && req.method === 'POST' && referrer && originConsistent
    && (fetchSite === 'same-origin' || fetchSite === 'same-site')
    && /^(cors|same-origin)$/.test(header(req, 'sec-fetch-mode'))
    && header(req, 'sec-fetch-dest') === 'empty') {
    return evidence('browser_candidate', 'browser_fetch_signals');
  }
  return evidence('unclassified', 'insufficient_request_evidence');
}

/** Called only after the existing route guard allows continuation. No response or access decision changes. */
export function runDiscoveryTraffic<T>(req: RequestSignals, next: () => T): T {
  const pathname = (req.originalUrl || req.path || '').split('?')[0];
  if (req.method !== 'POST' || !/^\/api\/analytics\/shell\/?$/.test(pathname)) return next();
  return context.run(classifyDiscoveryRequest(req), next);
}

/** Separate metadata dimension; non-request writes and durable outcome contracts stay unchanged. */
export function withDiscoveryTrafficEvidence(metadata: Record<string, unknown>): Record<string, unknown> {
  const observed = context.getStore();
  return observed ? { ...metadata, traffic_quality: observed } : metadata;
}

export function readDiscoveryTrafficClass(metadata: unknown): DiscoveryTrafficClass | 'legacy_unclassified' {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return 'legacy_unclassified';
  const value = (metadata as Record<string, unknown>).traffic_quality;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'legacy_unclassified';
  const entry = value as Record<string, unknown>;
  if (entry.version !== 1 || entry.basis !== 'server_observed_request_signals') return 'unclassified';
  return ['browser_candidate', 'automation_signal', 'qa_signal', 'unclassified'].includes(String(entry.classification))
    ? entry.classification as DiscoveryTrafficClass : 'unclassified';
}
