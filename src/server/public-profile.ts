export const PUBLIC_PROFILE_MAX_LINKS = 12;

export const PUBLIC_PROFILE_LINK_KINDS = [
  'booking',
  'brand',
  'event',
  'community',
  'press',
  'social',
  'support',
  'other'
] as const;

export type PublicProfileLinkKind = typeof PUBLIC_PROFILE_LINK_KINDS[number];

export type NormalizedPublicProfileLink = {
  label: string;
  description: string | null;
  url: string;
  kind: PublicProfileLinkKind;
  sortOrder: number;
  isActive: boolean;
};

export type NormalizedPublicProfileLinksResult = {
  provided: boolean;
  links: NormalizedPublicProfileLink[];
  error: string | null;
};

export function normalizePublicProfileSpecialties(value: unknown) {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return null;

  const unique = new Set<string>();
  for (const item of value) {
    const normalized = normalizePublicProfileText(item, 40)?.replace(/\s+/g, ' ');
    if (!normalized) continue;
    unique.add(normalized);
    if (unique.size === 8) break;
  }

  return [...unique];
}

export function normalizePublicProfileText(value: unknown, maxLength = 160) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

export function normalizePublicProfileUrl(value: unknown) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function normalizePublicProfileEmail(value: unknown) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return null;
  return normalized;
}

export function normalizePublicProfilePhone(value: unknown) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!normalized) return null;
  if (!/^[0-9+().\-\s]+$/.test(normalized)) return null;
  if (normalized.replace(/\D/g, '').length < 7) return null;
  return normalized;
}

export function normalizePublicProfileLinks(value: unknown): NormalizedPublicProfileLinksResult {
  if (value === undefined) {
    return { provided: false, links: [], error: null };
  }

  if (!Array.isArray(value)) {
    return { provided: true, links: [], error: 'Profile links must be an array.' };
  }

  if (value.length > PUBLIC_PROFILE_MAX_LINKS) {
    return {
      provided: true,
      links: [],
      error: `A public profile can include up to ${PUBLIC_PROFILE_MAX_LINKS} links.`
    };
  }

  const allowedKinds = new Set<string>(PUBLIC_PROFILE_LINK_KINDS);
  const links: NormalizedPublicProfileLink[] = [];

  for (let index = 0; index < value.length; index += 1) {
    const rawLink = value[index];
    if (!rawLink || typeof rawLink !== 'object') {
      return { provided: true, links: [], error: `Profile link ${index + 1} is invalid.` };
    }

    const label = normalizePublicProfileText((rawLink as any).label, 80)?.replace(/\s+/g, ' ') ?? null;
    const description = normalizePublicProfileText((rawLink as any).description, 180);
    const url = normalizePublicProfileUrl((rawLink as any).url);
    const requestedKind = typeof (rawLink as any).kind === 'string'
      ? (rawLink as any).kind.trim().toLowerCase()
      : 'other';
    const kind = (allowedKinds.has(requestedKind) ? requestedKind : 'other') as PublicProfileLinkKind;

    if (!label) {
      return { provided: true, links: [], error: `Profile link ${index + 1} needs a label.` };
    }
    if (!url) {
      return { provided: true, links: [], error: `Profile link ${index + 1} needs a valid http or https URL.` };
    }

    links.push({
      label,
      description,
      url,
      kind,
      sortOrder: index,
      isActive: (rawLink as any).isActive !== false
    });
  }

  return { provided: true, links, error: null };
}
