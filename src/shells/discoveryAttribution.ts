/** Public discovery attribution. Source labels are evidence, not verified humans. */
const FIRST_TOUCH_KEY = 'sway.discovery.firstTouch';
const LATEST_TOUCH_KEY = 'sway.discovery.latestTouch';
const OFFLINE_FIND_US_KEY = 'sway.discovery.offlineFindUs';
const JOURNEY_ID_KEY = 'sway.discovery.journeyId';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DiscoveryChannel = 'chatgpt' | 'google' | 'facebook' | 'referral' | 'existing_customer' | 'direct' | 'other' | 'unknown';
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
  chatgpt: 90, google: 80, facebook: 75, referral: 70,
  existing_customer: 60, other: 40, direct: 20, unknown: 10
};
type PageState = { first?: DiscoveryTouch; latest?: DiscoveryTouch; offline?: DiscoveryChannel; journeyId?: string };
// One page context only: no new cookie, durable identifier, or cross-tab tracking.
const pageStates = new WeakMap<object, PageState>();
function pageState(): PageState | null {
  if (typeof window === 'undefined') return null;
  let state = pageStates.get(window);
  if (!state) { state = {}; pageStates.set(window, state); }
  return state;
}
function safeStorage(kind: 'localStorage' | 'sessionStorage'): Storage | null {
  try { return typeof window === 'undefined' ? null : window[kind]; }
  catch { return null; }
}
function safePathname(): string {
  if (typeof window === 'undefined') return '/';
  return window.location.pathname || '/';
}
function readJson<T>(storage: Storage | null, key: string): T | null {
  try { const raw = storage?.getItem(key); return raw ? JSON.parse(raw) as T : null; }
  catch { return null; }
}
function writeJson(storage: Storage | null, key: string, value: unknown) {
  try { storage?.setItem(key, JSON.stringify(value)); }
  catch { /* Attribution must never block the page. */ }
}
function readTouch(storage: Storage | null, key: string): DiscoveryTouch | null {
  const value = readJson<DiscoveryTouch>(storage, key);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Object.prototype.hasOwnProperty.call(CHANNEL_STRENGTH, value.channel)
    || typeof value.landingPath !== 'string' || !value.landingPath.startsWith('/')
    || value.landingPath.startsWith('//') || typeof value.capturedAt !== 'string'
    || !Number.isFinite(Date.parse(value.capturedAt))) return null;
  return { ...value, strength: CHANNEL_STRENGTH[value.channel] };
}
function normalizeSource(raw: string | null | undefined): DiscoveryChannel {
  const value = (raw || '').trim().toLowerCase();
  if (!value) return 'unknown';
  if (['chatgpt', 'chatgpt.com', 'chat.openai.com', 'openai'].includes(value)) return 'chatgpt';
  // Retain the existing broad channel buckets; do not relabel historical data.
  if (['google', 'google.com', 'bing', 'duckduckgo'].includes(value)) return 'google';
  if (['facebook', 'facebook.com', 'fb', 'instagram', 'meta'].includes(value)) return 'facebook';
  if (['referral', 'friend', 'word_of_mouth'].includes(value)) return 'referral';
  if (['existing', 'existing_customer', 'customer'].includes(value)) return 'existing_customer';
  if (value === 'direct') return 'direct';
  return 'other';
}
function channelFromReferrer(referrer: string): DiscoveryChannel {
  if (!referrer) return 'direct';
  try {
    const url = new URL(referrer);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return 'unknown';
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    const under = (domain: string) => host === domain || host.endsWith('.' + domain);
    if (under('chatgpt.com') || under('chat.openai.com')) return 'chatgpt';
    if (/(^|\.)google\.(com|[a-z]{2}|com\.[a-z]{2}|co\.[a-z]{2})$/.test(host)
      || under('bing.com') || under('duckduckgo.com')) return 'google';
    if (under('facebook.com') || under('instagram.com') || under('fb.com')) return 'facebook';
    if (['sway.tips', 'www.sway.tips', 'app.sway.tips'].includes(host)) return 'direct';
    return 'referral';
  } catch { return 'unknown'; }
}
function buildTouchFromLocation(): DiscoveryTouch {
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const utmSource = params.get('utm_source');
  const utmMedium = params.get('utm_medium');
  const utmCampaign = params.get('utm_campaign');
  const referrer = typeof document !== 'undefined' ? document.referrer || '' : '';
  const channel = utmSource ? normalizeSource(utmSource) : channelFromReferrer(referrer);
  return { channel, landingPath: safePathname(), utmSource, utmMedium, utmCampaign,
    capturedAt: new Date().toISOString(), strength: CHANNEL_STRENGTH[channel] };
}
/** Capture first-touch once; upgrade only the existing weak first-touch case. */
export function captureDiscoveryAttribution(): DiscoveryTouch {
  const touch = buildTouchFromLocation();
  const state = pageState();
  if (!state) return touch;
  const existingFirst = getFirstDiscoveryTouch();
  if (!existingFirst) state.first = touch;
  else if ((existingFirst.channel === 'direct' || existingFirst.channel === 'unknown')
    && touch.strength > existingFirst.strength && touch.channel !== 'direct' && touch.channel !== 'unknown') {
    state.first = { ...touch, landingPath: existingFirst.landingPath || touch.landingPath, capturedAt: existingFirst.capturedAt };
  } else state.first = existingFirst;
  writeJson(safeStorage('localStorage'), FIRST_TOUCH_KEY, state.first);
  state.latest = touch;
  writeJson(safeStorage('sessionStorage'), LATEST_TOUCH_KEY, touch);
  writeJson(safeStorage('localStorage'), LATEST_TOUCH_KEY, touch);
  return state.first;
}
export function getFirstDiscoveryTouch(): DiscoveryTouch | null {
  return readTouch(safeStorage('localStorage'), FIRST_TOUCH_KEY) || pageState()?.first || null;
}
export function getLatestDiscoveryTouch(): DiscoveryTouch | null {
  return readTouch(safeStorage('sessionStorage'), LATEST_TOUCH_KEY)
    || pageState()?.latest || readTouch(safeStorage('localStorage'), LATEST_TOUCH_KEY);
}
export function getEffectiveDiscoveryChannel(): DiscoveryChannel {
  return getFirstDiscoveryTouch()?.channel || 'unknown';
}
function fallbackJourneyUuid() {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/** Session key when storage works; stable per-page key when it does not. */
export function getOrCreateDiscoveryJourneyId(): string {
  const state = pageState();
  if (!state) return '00000000-0000-4000-8000-000000000000';
  // Failure to remove a legacy key must not disable working session storage.
  try { safeStorage('localStorage')?.removeItem(JOURNEY_ID_KEY); } catch { /* Continue. */ }
  const session = safeStorage('sessionStorage');
  try {
    const existing = session?.getItem(JOURNEY_ID_KEY);
    if (existing && UUID_PATTERN.test(existing)) {
      state.journeyId = existing.toLowerCase();
      return state.journeyId;
    }
  } catch { /* Use the stable in-memory page key below. */ }
  if (!state.journeyId) state.journeyId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().toLowerCase() : fallbackJourneyUuid();
  try { session?.setItem(JOURNEY_ID_KEY, state.journeyId); } catch { /* Page key remains valid. */ }
  return state.journeyId;
}
export function getDiscoveryEntryPath() { return getFirstDiscoveryTouch()?.landingPath || safePathname(); }
/** Optional self-report preserves a stronger observed first-touch channel. */
export function recordOfflineFindUs(answer: DiscoveryChannel): {
  recorded: boolean; overwroteFirstTouch: false; channel: DiscoveryChannel;
} {
  const normalized = normalizeSource(answer);
  const state = pageState();
  if (state) {
    state.offline = normalized;
    writeJson(safeStorage('localStorage'), OFFLINE_FIND_US_KEY, { channel: normalized, capturedAt: new Date().toISOString() });
  }
  const first = getFirstDiscoveryTouch();
  if (!first || first.channel === 'direct' || first.channel === 'unknown') {
    if (state) {
      state.first = { channel: normalized, landingPath: first?.landingPath || safePathname(),
        utmSource: first?.utmSource || null, utmMedium: first?.utmMedium || null,
        utmCampaign: first?.utmCampaign || null, capturedAt: first?.capturedAt || new Date().toISOString(),
        strength: CHANNEL_STRENGTH[normalized] };
      writeJson(safeStorage('localStorage'), FIRST_TOUCH_KEY, state.first);
    }
    return { recorded: true, overwroteFirstTouch: false, channel: normalized };
  }
  return { recorded: true, overwroteFirstTouch: false, channel: first.channel };
}
export function getOfflineFindUs(): DiscoveryChannel | null {
  const stored = readJson<{ channel?: string }>(safeStorage('localStorage'), OFFLINE_FIND_US_KEY);
  return typeof stored?.channel === 'string' ? normalizeSource(stored.channel) : pageState()?.offline || null;
}
