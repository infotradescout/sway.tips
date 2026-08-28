import type { Request } from 'express';
import {
  classifyTrafficUserAgent,
  encodeTrafficTruthSource,
  isScannerTrafficPath,
  normalizeTrafficPath,
  type TrafficTruthUserAgentClass
} from '../traffic-truth';

type TrafficTruthEnvironment = Record<string, string | undefined>;

function readHeader(req: Pick<Request, 'headers'>, name: string) {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === 'string' ? value : null;
}

function normalizeIp(value: string | null | undefined) {
  if (!value) return null;
  return value.trim().replace(/^::ffff:/i, '');
}

function requestIps(req: Pick<Request, 'headers' | 'ip'>) {
  const forwarded = readHeader(req, 'x-forwarded-for')
    ?.split(',')
    .map((value) => normalizeIp(value))
    .filter((value): value is string => Boolean(value)) ?? [];
  const direct = normalizeIp(req.ip);
  return new Set(direct ? [...forwarded, direct] : forwarded);
}

function configuredQaIps(env: TrafficTruthEnvironment) {
  return new Set(
    (env.SWAY_TRAFFIC_TRUTH_QA_IPS ?? '')
      .split(/[\s,]+/)
      .map((value) => normalizeIp(value))
      .filter((value): value is string => Boolean(value))
  );
}

function hasQaMarker(req: Pick<Request, 'headers' | 'originalUrl'>) {
  const explicitClass = readHeader(req, 'x-sway-traffic-class')?.trim().toLowerCase();
  if (explicitClass === 'qa_automation') return true;
  const explicitQa = readHeader(req, 'x-sway-qa')?.trim().toLowerCase();
  if (explicitQa === '1' || explicitQa === 'true') return true;
  try {
    const url = new URL(req.originalUrl || '/', 'https://app.sway.tips');
    return url.searchParams.get('sway_qa') === '1'
      || url.searchParams.get('sway_traffic') === 'qa';
  } catch {
    return false;
  }
}

function explicitExcludedClass(req: Pick<Request, 'headers'>): TrafficTruthUserAgentClass | null {
  const value = readHeader(req, 'x-sway-traffic-class')?.trim().toLowerCase();
  if (value === 'known_bot' || value === 'scanner' || value === 'qa_automation') return value;
  return null;
}

export function classifyTrafficRequest(
  req: Pick<Request, 'headers' | 'ip' | 'originalUrl' | 'path'>,
  env: TrafficTruthEnvironment = process.env
): TrafficTruthUserAgentClass {
  const requestPath = normalizeTrafficPath(req.path || req.originalUrl || '/');
  if (isScannerTrafficPath(requestPath)) return 'scanner';

  const excludedHint = explicitExcludedClass(req);
  if (excludedHint) return excludedHint;

  const userAgentClass = classifyTrafficUserAgent(readHeader(req, 'user-agent'));
  if (userAgentClass !== 'human_candidate') return userAgentClass;
  if (hasQaMarker(req)) return 'qa_automation';

  const qaIps = configuredQaIps(env);
  if (qaIps.size > 0 && [...requestIps(req)].some((ip) => qaIps.has(ip))) return 'qa_automation';
  return 'human_candidate';
}

export function shouldHard404ScannerRequest(
  req: Pick<Request, 'path' | 'originalUrl'>
) {
  return isScannerTrafficPath(req.path || req.originalUrl || '/');
}

export function applyTrafficTruthToTelemetryRequest(
  req: Pick<Request, 'method' | 'path' | 'originalUrl' | 'headers' | 'ip' | 'body'>,
  env: TrafficTruthEnvironment = process.env
) {
  if (req.method !== 'POST' || normalizeTrafficPath(req.path || req.originalUrl || '/') !== '/api/analytics/shell') {
    return null;
  }
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return null;

  const body = req.body as Record<string, unknown>;
  const currentSource = typeof body.attribution_channel === 'string'
    ? body.attribution_channel
    : 'unknown';
  const classification = classifyTrafficRequest(req, env);
  body.attribution_channel = encodeTrafficTruthSource(classification, currentSource);
  return classification;
}
