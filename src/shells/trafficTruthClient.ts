import { classifyTrafficUserAgent, type TrafficTruthUserAgentClass } from '../traffic-truth';

export type BrowserTrafficTruthInput = {
  userAgent?: string | null;
  webdriver?: boolean;
  href?: string | null;
  hostname?: string | null;
};

function hasQaLocationMarker(href: string | null | undefined) {
  if (!href) return false;
  try {
    const url = new URL(href, 'https://app.sway.tips');
    return url.searchParams.get('sway_qa') === '1'
      || url.searchParams.get('sway_traffic') === 'qa';
  } catch {
    return false;
  }
}

export function classifyBrowserTraffic(input?: BrowserTrafficTruthInput): TrafficTruthUserAgentClass {
  const userAgent = input?.userAgent
    ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  const webdriver = input?.webdriver
    ?? (typeof navigator !== 'undefined' ? Boolean(navigator.webdriver) : false);
  const href = input?.href
    ?? (typeof window !== 'undefined' ? window.location.href : null);
  const hostname = input?.hostname
    ?? (typeof window !== 'undefined' ? window.location.hostname : null);

  const userAgentClass = classifyTrafficUserAgent(userAgent);
  if (userAgentClass !== 'human_candidate') return userAgentClass;
  if (webdriver || hasQaLocationMarker(href)) return 'qa_automation';
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return 'qa_automation';
  return 'human_candidate';
}
