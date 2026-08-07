/**
 * Public discovery attribution (Public Discovery Contract v1).
 *
 * First-touch UTM / referrer / landing path survive navigation and return visits
 * in the same browser. Optional offline "How did you find us?" never overwrites
 * a stronger recorded first-touch channel.
 */

const FIRST_TOUCH_KEY = 'sway.discovery.firstTouch';
const LATEST_TOUCH_KEY = 'sway.discovery.latestTouch';
const OFFLINE_FIND_US_KEY = 'sway.discovery.offlineFindUs';

export type DiscoveryChannel =
  | 'chatgpt'
  | 'google'
  | 'facebook'
  | 'referral'
  | 'existing_customer'
  | 'direct'
  | 'other'
  | 'unknown';

export type DiscoveryTouch = {
  channel: DiscoveryChannel;
  landingPath: string;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  capturedAt: string;
  strength: number;
};

const CHANNEL_STRENGTH: Record<DiscoveryChannel, number> = {
  chatgpt: 90,
  google: 80,
  facebook: 75,
  referral: 70,
  existing_customer: 60,
  other: 40,
  direct: 20,
  unknown: 10
};

function safePathname(): string {
  if (typeof window === 'undefined') return '/';
  return window.location.pathname || '/';
}

function readJson<T>(storage: Storage, key: string): T | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJson(storage: Storage, key: string, value: unknown) {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage may be blocked; attribution must never break the page.
  }
}

function normalizeSource(raw: string | null | undefined): DiscoveryChannel {
  const value = (raw || '').trim().toLowerCase();
  if (!value) return 'unknown';
  if (value.includes('chatgpt') || value === 'chat.openai.com' || value === 'openai') return 'chatgpt';
  if (value.includes('google') || value === 'bing' || value === 'duckduckgo') return 'google';
  if (value.includes('facebook') || value === 'fb' || value === 'instagram' || value === 'meta') return 'facebook';
  if (value === 'referral' || value === 'friend' || value === 'word_of_mouth') return 'referral';
  if (value === 'existing' || value === 'existing_customer' || value === 'customer') return 'existing_customer';
  if (value === 'direct') return 'direct';
  if (value === 'other') return 'other';
  return 'other';
}

function channelFromReferrer(referrer: string): DiscoveryChannel {
  const value = referrer.toLowerCase();
  if (!value) return 'direct';
  if (value.includes('chatgpt.com') || value.includes('chat.openai.com')) return 'chatgpt';
  if (value.includes('google.') || value.includes('bing.com') || value.includes('duckduckgo.com')) return 'google';
  if (value.includes('facebook.com') || value.includes('instagram.com') || value.includes('fb.com')) return 'facebook';
  try {
    const host = new URL(referrer).hostname.replace(/^www\./, '');
    if (host === 'sway.tips' || host === 'app.sway.tips') return 'direct';
  } catch {
    // ignore malformed referrer
  }
  return 'referral';
}

function buildTouchFromLocation(): DiscoveryTouch {
  const params = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search)
    : new URLSearchParams();
  const utmSource = params.get('utm_source');
  const utmMedium = params.get('utm_medium');
  const utmCampaign = params.get('utm_campaign');
  const referrer = typeof document !== 'undefined' ? document.referrer || '' : '';

  let channel: DiscoveryChannel = 'unknown';
  if (utmSource) channel = normalizeSource(utmSource);
  else if (referrer) channel = channelFromReferrer(referrer);
  else channel = 'direct';

  return {
    channel,
    landingPath: safePathname(),
    utmSource,
    utmMedium,
    utmCampaign,
    capturedAt: new Date().toISOString(),
    strength: CHANNEL_STRENGTH[channel]
  };
}

/** Capture first-touch once; always refresh latest touch for return-visit timing. */
export function captureDiscoveryAttribution(): DiscoveryTouch {
  const touch = buildTouchFromLocation();
  if (typeof window === 'undefined') return touch;

  const existingFirst = readJson<DiscoveryTouch>(window.localStorage, FIRST_TOUCH_KEY);
  if (!existingFirst) {
    writeJson(window.localStorage, FIRST_TOUCH_KEY, touch);
  } else if (
    (existingFirst.channel === 'direct' || existingFirst.channel === 'unknown')
    && touch.strength > (existingFirst.strength || 0)
    && touch.channel !== 'direct'
    && touch.channel !== 'unknown'
  ) {
    // Upgrade only a weak first-touch when a real campaign/referrer arrives.
    writeJson(window.localStorage, FIRST_TOUCH_KEY, {
      ...touch,
      landingPath: existingFirst.landingPath || touch.landingPath,
      capturedAt: existingFirst.capturedAt
    });
  }

  writeJson(window.sessionStorage, LATEST_TOUCH_KEY, touch);
  writeJson(window.localStorage, LATEST_TOUCH_KEY, {
    ...touch,
    capturedAt: new Date().toISOString()
  });

  return getFirstDiscoveryTouch() || touch;
}

export function getFirstDiscoveryTouch(): DiscoveryTouch | null {
  if (typeof window === 'undefined') return null;
  return readJson<DiscoveryTouch>(window.localStorage, FIRST_TOUCH_KEY);
}

export function getLatestDiscoveryTouch(): DiscoveryTouch | null {
  if (typeof window === 'undefined') return null;
  return readJson<DiscoveryTouch>(window.sessionStorage, LATEST_TOUCH_KEY)
    || readJson<DiscoveryTouch>(window.localStorage, LATEST_TOUCH_KEY);
}

export function getEffectiveDiscoveryChannel(): DiscoveryChannel {
  return getFirstDiscoveryTouch()?.channel || 'unknown';
}

/**
 * Optional offline answer. Never overwrites a stronger first-touch channel
 * (ChatGPT/Google/Facebook/referral UTMs already recorded).
 */
export function recordOfflineFindUs(answer: DiscoveryChannel): {
  recorded: boolean;
  overwroteFirstTouch: false;
  channel: DiscoveryChannel;
} {
  const normalized = normalizeSource(answer);
  if (typeof window !== 'undefined') {
    writeJson(window.localStorage, OFFLINE_FIND_US_KEY, {
      channel: normalized,
      capturedAt: new Date().toISOString()
    });
  }

  const first = getFirstDiscoveryTouch();
  if (!first || first.channel === 'direct' || first.channel === 'unknown') {
    if (typeof window !== 'undefined') {
      writeJson(window.localStorage, FIRST_TOUCH_KEY, {
        channel: normalized,
        landingPath: first?.landingPath || safePathname(),
        utmSource: first?.utmSource || null,
        utmMedium: first?.utmMedium || null,
        utmCampaign: first?.utmCampaign || null,
        capturedAt: first?.capturedAt || new Date().toISOString(),
        strength: CHANNEL_STRENGTH[normalized]
      } satisfies DiscoveryTouch);
    }
    return { recorded: true, overwroteFirstTouch: false, channel: normalized };
  }

  return { recorded: true, overwroteFirstTouch: false, channel: first.channel };
}

export function getOfflineFindUs(): DiscoveryChannel | null {
  if (typeof window === 'undefined') return null;
  const stored = readJson<{ channel?: string }>(window.localStorage, OFFLINE_FIND_US_KEY);
  return stored?.channel ? normalizeSource(stored.channel) : null;
}
