export const PUBLIC_PROFILE_MAX_LINKS = 12;
export const PUBLIC_PROFILE_MAX_FEATURED_MEDIA = 4;

const SUPPRESSED_PUBLIC_PROFILE_DOMAINS = ['djthreeex.com'];

export const PUBLIC_PERFORMER_PRIMARY_ROLES = [
  { id: 'dj', label: 'DJ' },
  { id: 'musician', label: 'Musician' },
  { id: 'comedian', label: 'Comedian' },
  { id: 'host', label: 'Host / MC' },
  { id: 'creator', label: 'Creator' },
  { id: 'dancer', label: 'Dancer' },
  { id: 'magician', label: 'Magician' },
  { id: 'speaker', label: 'Speaker' },
  { id: 'producer', label: 'Producer' },
  { id: 'other', label: 'Other' }
] as const;

export type PublicPerformerPrimaryRoleId = typeof PUBLIC_PERFORMER_PRIMARY_ROLES[number]['id'];

const PUBLIC_PERFORMER_PRIMARY_ROLE_IDS = new Set(
  PUBLIC_PERFORMER_PRIMARY_ROLES.map((role) => role.id)
);

export function normalizePublicProfilePrimaryRole(value: unknown): PublicPerformerPrimaryRoleId | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/[\s/]+/g, '_').replace(/_+/g, '_');
  const aliases: Record<string, PublicPerformerPrimaryRoleId> = {
    dj: 'dj',
    musician: 'musician',
    comedian: 'comedian',
    host: 'host',
    mc: 'host',
    host_mc: 'host',
    creator: 'creator',
    dancer: 'dancer',
    magician: 'magician',
    speaker: 'speaker',
    producer: 'producer',
    other: 'other',
    other_performer: 'other'
  };
  const mapped = aliases[normalized];
  if (mapped) return mapped;
  return PUBLIC_PERFORMER_PRIMARY_ROLE_IDS.has(normalized as PublicPerformerPrimaryRoleId)
    ? normalized as PublicPerformerPrimaryRoleId
    : null;
}

export function labelForPublicPerformerPrimaryRole(roleId: string | null | undefined) {
  const normalizedRoleId = normalizePublicProfilePrimaryRole(roleId);
  if (!normalizedRoleId) return null;
  const found = PUBLIC_PERFORMER_PRIMARY_ROLES.find((role) => role.id === normalizedRoleId);
  return found?.label ?? null;
}

export function resolvePublicProfileHeroName(input: {
  handle: string | null | undefined;
  stageName: string | null | undefined;
  displayName: string | null | undefined;
}) {
  const handle = typeof input.handle === 'string' ? input.handle.trim() : '';
  if (handle) return `@${handle}`;
  const stageName = typeof input.stageName === 'string' ? input.stageName.trim() : '';
  if (stageName) return stageName;
  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
  return displayName || 'Sway page';
}

export function resolvePublicProfilePageKindLabel(input: {
  primaryRole: string | null | undefined;
  specialties?: string[] | null;
  isPreview?: boolean;
}) {
  const roleLabel = labelForPublicPerformerPrimaryRole(input.primaryRole);
  if (roleLabel) return roleLabel;
  const specialty = Array.isArray(input.specialties)
    ? input.specialties.find((item) => (
        typeof item === 'string'
        && item.trim()
        && !['performer', 'other performer'].includes(item.trim().toLowerCase())
      ))
    : null;
  if (specialty) return specialty.trim();
  return input.isPreview ? 'Unclaimed public page' : 'Sway page';
}

export function mergePublicProfileMetadata(
  existing: unknown,
  updates: { stageName?: string | null; primaryRole?: string | null }
) {
  const merged = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? { ...(existing as Record<string, unknown>) }
    : {};

  if (updates.stageName !== undefined) {
    if (updates.stageName) merged.stageName = updates.stageName;
    else delete merged.stageName;
  }
  if (updates.primaryRole !== undefined) {
    if (updates.primaryRole) merged.primaryRole = updates.primaryRole;
    else delete merged.primaryRole;
  }

  return Object.keys(merged).length ? merged : null;
}

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

export type NormalizedPublicProfileMedia = {
  kind: 'youtube';
  title: string;
  description: string | null;
  url: string;
  embedUrl: string;
  sortOrder: number;
  isActive: boolean;
};

export type NormalizedPublicProfileMediaResult = {
  provided: boolean;
  media: NormalizedPublicProfileMedia[];
  error: string | null;
};

export function escapePublicProfileMetadataAttribute(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

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
    const hostname = parsed.hostname.toLowerCase();
    const suppressed = SUPPRESSED_PUBLIC_PROFILE_DOMAINS.some((domain) => (
      hostname === domain || hostname.endsWith(`.${domain}`)
    ));
    if (suppressed) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function isSuppressedPublicProfileUrl(value: unknown) {
  if (typeof value !== 'string') return false;
  try {
    const hostname = new URL(value.trim()).hostname.toLowerCase();
    return SUPPRESSED_PUBLIC_PROFILE_DOMAINS.some((domain) => (
      hostname === domain || hostname.endsWith(`.${domain}`)
    ));
  } catch {
    return false;
  }
}

function extractYouTubeVideoId(value: string) {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    let candidate = '';

    if (hostname === 'youtu.be') {
      candidate = parsed.pathname.split('/').filter(Boolean)[0] || '';
    } else if (hostname === 'youtube.com' || hostname === 'www.youtube.com' || hostname === 'm.youtube.com') {
      if (parsed.pathname === '/watch') {
        candidate = parsed.searchParams.get('v') || '';
      } else if (/^\/(shorts|embed|live)\//.test(parsed.pathname)) {
        candidate = parsed.pathname.split('/').filter(Boolean)[1] || '';
      }
    }

    return /^[A-Za-z0-9_-]{6,20}$/.test(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export function normalizePublicProfileFeaturedMedia(value: unknown): NormalizedPublicProfileMediaResult {
  if (value === undefined) {
    return { provided: false, media: [], error: null };
  }

  if (!Array.isArray(value)) {
    return { provided: true, media: [], error: 'Featured media must be an array.' };
  }

  if (value.length > PUBLIC_PROFILE_MAX_FEATURED_MEDIA) {
    return {
      provided: true,
      media: [],
      error: `A profile can include up to ${PUBLIC_PROFILE_MAX_FEATURED_MEDIA} featured videos.`
    };
  }

  const media: NormalizedPublicProfileMedia[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const rawMedia = value[index];
    if (!rawMedia || typeof rawMedia !== 'object') {
      return { provided: true, media: [], error: `Featured media ${index + 1} is invalid.` };
    }

    const url = normalizePublicProfileUrl((rawMedia as any).url);
    const videoId = url ? extractYouTubeVideoId(url) : null;
    const title = normalizePublicProfileText((rawMedia as any).title, 120)?.replace(/\s+/g, ' ') ?? 'Featured video';
    const description = normalizePublicProfileText((rawMedia as any).description, 200);

    if (!url || !videoId) {
      return {
        provided: true,
        media: [],
        error: `Featured media ${index + 1} must be a valid YouTube video URL.`
      };
    }

    media.push({
      kind: 'youtube',
      title,
      description,
      url,
      embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}?rel=0&modestbranding=1`,
      sortOrder: index,
      isActive: (rawMedia as any).isActive !== false
    });
  }

  return { provided: true, media, error: null };
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

export type PublicBookingContact = {
  email: string | null;
  phone: string | null;
  available: boolean;
  verificationRequired: boolean;
};

export function resolveVerifiedPublicBookingContact(input: {
  email: unknown;
  phone: unknown;
  ownerEmailVerifiedAt: Date | string | null | undefined;
}): PublicBookingContact {
  const email = normalizePublicProfileEmail(input.email);
  const phone = normalizePublicProfilePhone(input.phone);
  const hasConfiguredContact = Boolean(email || phone);
  const ownerEmailVerified = input.ownerEmailVerifiedAt instanceof Date
    ? !Number.isNaN(input.ownerEmailVerifiedAt.getTime())
    : typeof input.ownerEmailVerifiedAt === 'string' && input.ownerEmailVerifiedAt.trim().length > 0;

  return {
    email: ownerEmailVerified ? email : null,
    phone: ownerEmailVerified ? phone : null,
    available: ownerEmailVerified && hasConfiguredContact,
    verificationRequired: !ownerEmailVerified && hasConfiguredContact
  };
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
    const rawUrl = (rawLink as any).url;
    const url = normalizePublicProfileUrl(rawUrl);
    const requestedKind = typeof (rawLink as any).kind === 'string'
      ? (rawLink as any).kind.trim().toLowerCase()
      : 'other';
    const kind = (allowedKinds.has(requestedKind) ? requestedKind : 'other') as PublicProfileLinkKind;

    if (!label) {
      return { provided: true, links: [], error: `Profile link ${index + 1} needs a label.` };
    }
    if (!url) {
      if (isSuppressedPublicProfileUrl(rawUrl)) continue;
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
