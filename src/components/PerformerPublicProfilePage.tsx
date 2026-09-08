import {
  ArrowUpRight,
  ArrowDown,
  ArrowUp,
  BadgeCheck,
  CalendarDays,
  Disc3,
  Globe2,
  GripVertical,
  LayoutGrid,
  LockKeyhole,
  Mail,
  MapPin,
  Phone,
  Play,
  Radio,
  Share2,
  UserRound
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { captureCampaignCode } from '../shells/campaignAttribution';
import {
  captureDiscoveryAttribution,
  getEffectiveDiscoveryChannel
} from '../shells/discoveryAttribution';
import { sendAcquisitionEvent, sendDiscoveryEvent } from '../shells/frictionClient';
import {
  resolvePublicProfileHeroName,
  resolvePublicProfilePageKindLabel,
  resolvePublicProfileSectionOrder,
  type PublicProfileSectionId
} from '../server/public-profile';
import DiscoveryFindUsPrompt from './DiscoveryFindUsPrompt';
import AppBackdrop from './AppBackdrop';
import { PublicEventCard, type PublicEventDto } from './PublicEventPage';

type PublicProfileLink = {
  label: string;
  description: string | null;
  url: string;
  kind: string;
  sortOrder: number;
};

type PublicProfileMedia = {
  kind: 'youtube';
  title: string;
  description: string | null;
  url: string;
  embedUrl: string;
  sortOrder: number;
};

type PublicPerformerProfile = {
  layout?: { sectionOrder: PublicProfileSectionId[]; customized: boolean; revision: number };
  displayName: string;
  stageName: string | null;
  primaryRole: string | null;
  roles: string[];
  handle: string | null;
  bio: string | null;
  headline: string | null;
  specialties: string[];
  city: string | null;
  avatarUrl: string | null;
  booking: {
    email: string | null;
    phone: string | null;
    available: boolean;
    verificationRequired: boolean;
  };
  socialLinks: Record<string, string | null>;
  links: PublicProfileLink[];
  featuredMedia: PublicProfileMedia[];
  partner: {
    active: boolean;
    kind: string | null;
    termsVersion: string | null;
  };
  isPreview: boolean;
  claimState: 'unclaimed' | 'pending' | 'claimed';
};

type ActiveProfileRoom = {
  routePath: string;
  talentRole: string;
  requestCount: number;
};

type PublicProfileRelease = {
  id: string;
  title: string;
  primaryArtistName: string;
  releaseType: string;
  status: 'ready' | 'scheduled' | 'published';
  scheduledReleaseAt: string | null;
  publishedAt: string | null;
  releasePath: string;
  artworkUrl: string | null;
  creationTags: string[];
  humanWrittenLyrics: boolean;
  originalVirtualArtist: boolean;
  fullyGenerated: boolean;
};

function releaseTagClass(tag: string) {
  if (tag === 'Human-written lyrics') return 'border-emerald-300/30 bg-emerald-400/10 text-emerald-100';
  if (tag === 'Original virtual artist') return 'border-fuchsia-300/30 bg-cyan-400/10 text-fuchsia-100';
  if (tag === 'Rights checked') return 'border-violet-300/30 bg-violet-400/10 text-violet-100';
  return 'border-white/10 bg-white/[0.04] text-slate-300';
}

type ProfileResponse = {
  performer?: PublicPerformerProfile;
  activeRoom?: ActiveProfileRoom | null;
  events?: PublicEventDto[];
  releases?: PublicProfileRelease[];
  error?: string;
};

const SOCIAL_LABELS: Record<string, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  soundcloud: 'SoundCloud',
  website: 'Website'
};

// Curated public profile assets are also carried by the preview seed. Keep a
// visual fallback while an already-claimed partner row is being hydrated from
// that curated record; owners can replace it from the authenticated editor.
const CURATED_PUBLIC_AVATAR_FALLBACKS: Record<string, string> = {
  dj3x: '/assets/frank-broughton-avatar.png',
  coreymack: 'https://img1.wsimg.com/isteam/ip/507cdd9e-ba65-48f1-ac5c-290e6c33023b/72E6855B-ABEB-492D-8EA4-0DAB48CAA65E.jpeg'
};

function profileInitials(displayName: string) {
  return displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || 'S';
}

function formatLinkKind(kind: string) {
  const normalized = kind.trim().toLowerCase();
  if (!normalized || normalized === 'other') return 'Link';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

const PROFILE_SECTIONS = {
  identity: { label: 'Profile header', icon: UserRound },
  about: { label: 'About', icon: UserRound },
  live: { label: 'Live room', icon: Radio },
  events: { label: 'Shows & events', icon: CalendarDays },
  releases: { label: 'Releases', icon: Disc3 },
  media: { label: 'Featured performances', icon: Play },
  links: { label: 'Links', icon: ArrowUpRight },
  booking: { label: 'Booking', icon: Mail },
  social: { label: 'Social links', icon: Globe2 }
} as const;

function isMusicDestination(url: string) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return ['music.apple.com', 'open.spotify.com', 'audiomack.com', 'soundcloud.com', 'bandcamp.com'].includes(host)
      || host.endsWith('.bandcamp.com');
  } catch { return false; }
}

export default function PerformerPublicProfilePage({ performerHandle }: { performerHandle: string }) {
  // A Sway-issued campaign link may land here (?camp=<code>) before the fan clicks
  // through to the live room; this just needs the persistence side effect -- PatronApp
  // reads it back on the room route. This page never submits a payment itself.
  captureCampaignCode();
  captureDiscoveryAttribution();
  const [profile, setProfile] = useState<PublicPerformerProfile | null>(null);
  const [activeRoom, setActiveRoom] = useState<ActiveProfileRoom | null>(null);
  const [events, setEvents] = useState<PublicEventDto[]>([]);
  const [releases, setReleases] = useState<PublicProfileRelease[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'not-found' | 'error'>('loading');
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [shareMessage, setShareMessage] = useState<string | null>(null);
  const [shareFallback, setShareFallback] = useState(false);
  const selectShareLink = useCallback((input: HTMLInputElement | null) => {
    if (input) { input.focus(); input.select(); }
  }, []);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [ownerLayout, setOwnerLayout] = useState<{ sectionOrder: PublicProfileSectionId[]; customized: boolean; revision: number } | null>(null);
  const [arranging, setArranging] = useState(false);
  const [previewingLayout, setPreviewingLayout] = useState(false);
  const [draftOrder, setDraftOrder] = useState<PublicProfileSectionId[]>([]);
  const [resetLayout, setResetLayout] = useState(false);
  const [layoutSaving, setLayoutSaving] = useState(false);
  const [layoutMessage, setLayoutMessage] = useState('');
  const [layoutConflict, setLayoutConflict] = useState(false);
  const [dragging, setDragging] = useState<PublicProfileSectionId | null>(null);
  const dragId = useRef<PublicProfileSectionId | null>(null);
  const layoutScope = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const loadProfile = async () => {
      setStatus('loading');
      try {
        const response = await fetch(`/api/public/performer/${encodeURIComponent(performerHandle)}`, {
          cache: 'no-store',
          signal: controller.signal
        });
        const data = await response.json().catch(() => null) as ProfileResponse | null;
        if (cancelled) return;
        if (response.status === 404) {
          setStatus('not-found');
          return;
        }
        if (!response.ok || !data?.performer) {
          setStatus('error');
          return;
        }

        setProfile({
          ...data.performer,
          roles: Array.isArray(data.performer.roles)
            ? data.performer.roles
            : data.performer.primaryRole
              ? [data.performer.primaryRole]
              : [],
          booking: data.performer.booking || {
            email: null,
            phone: null,
            available: false,
            verificationRequired: false
          },
          socialLinks: data.performer.socialLinks || {},
          specialties: Array.isArray(data.performer.specialties) ? data.performer.specialties : [],
          links: Array.isArray(data.performer.links) ? data.performer.links : [],
          featuredMedia: Array.isArray(data.performer.featuredMedia) ? data.performer.featuredMedia : [],
          partner: data.performer.partner || { active: false, kind: null, termsVersion: null },
          isPreview: data.performer.isPreview === true,
          claimState: data.performer.claimState === 'pending'
            ? 'pending'
            : data.performer.claimState === 'unclaimed'
              ? 'unclaimed'
              : 'claimed'
        });
        setActiveRoom(data.activeRoom || null);
        setEvents(Array.isArray(data.events) ? data.events : []);
        setReleases(Array.isArray(data.releases) ? data.releases : []);
        setAvatarFailed(false);
        setStatus('ready');
        document.title = `${resolvePublicProfileHeroName({
          handle: data.performer.handle,
          stageName: data.performer.stageName,
          displayName: data.performer.displayName
        })} on Sway`;
        sendDiscoveryEvent('discovery_landing', {
          shell: 'patron',
          surface: 'public-profile',
          route_family: 'performer-profile',
          has_route_context: true,
          has_session_context: false,
          build_commit: 'unknown',
          attribution_channel: getEffectiveDiscoveryChannel(),
          entity_kind: 'performer',
          entity_key: data.performer.handle || performerHandle,
          visibility_eligibility: 'eligible'
        });
        sendDiscoveryEvent('discovery_entity_view', {
          shell: 'patron',
          surface: 'public-profile',
          route_family: 'performer-profile',
          has_route_context: true,
          has_session_context: false,
          build_commit: 'unknown',
          attribution_channel: getEffectiveDiscoveryChannel(),
          entity_kind: 'performer',
          entity_key: data.performer.handle || performerHandle,
          visibility_eligibility: 'eligible'
        });
      } catch (error) {
        if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) return;
        setStatus('error');
      }
    };

    void loadProfile();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [performerHandle, loadAttempt]);

  useEffect(() => {
    const scope = ++layoutScope.current;
    const controller = new AbortController();
    setOwnerLayout(null);
    setArranging(false);
    setLayoutMessage('');
    setLayoutSaving(false);
    setLayoutConflict(false);
    if (status !== 'ready' || !profile) return;
    const handle = profile.handle || performerHandle;
    void fetch(`/api/talent/profile/layout?handle=${encodeURIComponent(handle)}`, { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        if (!response.ok) return;
        const data = await response.json();
        if (scope === layoutScope.current && data.handle === handle && data.layout) setOwnerLayout(data.layout);
      }).catch(() => { /* Public viewing does not depend on an owner session. */ });
    return () => { controller.abort(); layoutScope.current++; };
  }, [performerHandle, status, loadAttempt]);

  const savedOrder = useMemo(() => resolvePublicProfileSectionOrder({
    roles: profile?.roles,
    primaryRole: profile?.primaryRole,
    sectionOrder: ownerLayout?.sectionOrder || profile?.layout?.sectionOrder
  }), [profile, ownerLayout]);
  const layoutDirty = arranging && (resetLayout || draftOrder.join(',') !== savedOrder.join(','));

  useEffect(() => {
    if (!layoutDirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [layoutDirty]);

  const moveSection = (id: PublicProfileSectionId, target: PublicProfileSectionId) => {
    if (layoutSaving || id === target) return;
    setDraftOrder(current => {
      const from = current.indexOf(id);
      const to = current.indexOf(target);
      if (from < 0 || to < 0) return current;
      const next = [...current];
      next.splice(from, 1);
      next.splice(to, 0, id);
      return next;
    });
    setResetLayout(false);
    setLayoutMessage(`${PROFILE_SECTIONS[id].label} moved. Save to update your public page.`);
  };

  const saveLayout = async () => {
    if (!ownerLayout || !profile || layoutSaving || !layoutDirty) return;
    const scope = layoutScope.current;
    setLayoutSaving(true);
    setLayoutMessage('Saving your layout…');
    try {
      const response = await fetch('/api/talent/profile/layout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle: profile.handle || performerHandle, sectionOrder: resetLayout ? null : draftOrder, expectedRevision: ownerLayout.revision })
      });
      const data = await response.json().catch(() => null);
      if (scope !== layoutScope.current) return;
      if (response.status === 401 || response.status === 403) {
        setOwnerLayout(null);
        setArranging(false);
        setLayoutMessage('Your editing session ended. Sign in again to arrange your profile.');
        return;
      }
      if (response.status === 409) {
        setLayoutConflict(true);
        setLayoutMessage('Your layout changed on another device. Keep your arrangement to save it over the latest layout, or reload the saved layout.');
        return;
      }
      if (!response.ok || !data?.layout) throw new Error(data?.error || 'Your layout could not be saved. Your draft is still here; try again.');
      setOwnerLayout(data.layout);
      setProfile(current => current ? { ...current, layout: data.layout } : current);
      setDraftOrder(data.layout.sectionOrder);
      setArranging(false);
      setResetLayout(false);
      setLayoutConflict(false);
      setLayoutMessage('Layout saved. Your public page is updated.');
    } catch {
      if (scope === layoutScope.current) setLayoutMessage('Your layout could not be saved. Your draft is still here; try again.');
    } finally {
      if (scope === layoutScope.current) setLayoutSaving(false);
    }
  };

  const reloadLayout = async (keepDraft = false) => {
    const scope = layoutScope.current;
    setLayoutSaving(true);
    try {
      const response = await fetch(`/api/talent/profile/layout?handle=${encodeURIComponent(profile?.handle || performerHandle)}`, { cache: 'no-store' });
      const data = await response.json().catch(() => null);
      if (scope !== layoutScope.current) return;
      if (response.status === 401 || response.status === 403) {
        setOwnerLayout(null); setArranging(false);
        setLayoutMessage('Your editing session ended. Sign in again to arrange your profile.');
        return;
      }
      if (!response.ok || !data?.layout) throw new Error('reload');
      setOwnerLayout(data.layout);
      if (!keepDraft) { setDraftOrder(data.layout.sectionOrder); setResetLayout(false); }
      setLayoutConflict(false);
      setLayoutMessage(keepDraft ? 'Your arrangement is kept. Save to replace the latest public layout.' : 'Saved layout loaded.');
    } catch { if (scope === layoutScope.current) setLayoutMessage('The saved layout could not load. Your draft is still here.'); }
    finally { if (scope === layoutScope.current) setLayoutSaving(false); }
  };

  const socialLinks = useMemo(() => Object.entries(profile?.socialLinks || {})
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0)
    .filter(([, url]) => !profile?.links.some(link => link.url === url)), [profile]);

  const profileUrl = useMemo(() => {
    if (!profile) return '';
    const canonicalHandle = profile.handle || performerHandle;
    const profilePath = `/p/${encodeURIComponent(canonicalHandle)}`;
    return typeof window === 'undefined'
      ? profilePath
      : new URL(profilePath, window.location.origin).toString();
  }, [performerHandle, profile]);

  const handleShare = async () => {
    if (!profile) return;
    const shareData = {
      title: `${resolvePublicProfileHeroName({
        handle: profile.handle,
        stageName: profile.stageName,
        displayName: profile.displayName
      })} on Sway`,
      text: profile.headline || `Visit ${resolvePublicProfileHeroName({
        handle: profile.handle,
        stageName: profile.stageName,
        displayName: profile.displayName
      })}'s public Sway page.`,
      url: profileUrl
    };

    try {
      if (navigator.share) {
        await navigator.share(shareData);
        sendAcquisitionEvent('public_profile_shared', {
          shell: 'patron', surface: 'public-profile', route_family: 'performer-profile',
          has_route_context: true, has_session_context: false, build_commit: 'unknown'
        });
        return;
      }
      await navigator.clipboard.writeText(profileUrl);
      sendAcquisitionEvent('public_profile_shared', {
        shell: 'patron', surface: 'public-profile', route_family: 'performer-profile',
        has_route_context: true, has_session_context: false, build_commit: 'unknown'
      });
      setShareMessage('Link copied');
      window.setTimeout(() => setShareMessage(null), 1800);
    } catch (error) {
      // A dismissed native share sheet should leave the page unchanged.
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setShareFallback(true);
    }
  };

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#05060a] px-4 text-slate-100">
        <div className="text-center">
          <div className="mx-auto h-10 w-10 animate-pulse rounded-2xl bg-fuchsia-500/30" />
          <p className="mt-4 text-xs font-black uppercase tracking-[0.3em] text-slate-500">Loading profile</p>
        </div>
      </div>
    );
  }

  if (status !== 'ready' || !profile) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#05060a] px-4 text-slate-100">
        <div className="w-full max-w-md rounded-[2rem] border border-white/10 bg-slate-950/80 p-7 text-center shadow-2xl">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-fuchsia-400/20 bg-fuchsia-500/10 font-display text-xl font-black text-fuchsia-200">S</div>
          <h1 className="mt-5 font-display text-2xl font-black text-white">
            {status === 'not-found' ? 'Profile unavailable' : 'Profile could not load'}
          </h1>
          <p className="mt-3 text-sm leading-6 text-slate-400">
            {status === 'not-found'
              ? 'No public Sway page was found for this link.'
              : 'Sway could not load this page. Try again in a moment.'}
          </p>
          {status === 'error' ? <button type="button" onClick={() => setLoadAttempt(value => value + 1)} className="mt-6 mr-3 inline-flex min-h-11 items-center justify-center rounded-xl bg-fuchsia-600 px-4 py-3 text-sm font-bold text-white">Try again</button> : null}
          <a href="/" className="mt-6 inline-flex min-h-11 items-center justify-center rounded-xl border border-white/10 px-4 py-3 text-sm font-bold text-white hover:border-fuchsia-400/40">
            Return to Sway
          </a>
        </div>
      </div>
    );
  }

  const telephoneHref = profile.booking.phone ? `tel:${profile.booking.phone.replace(/[^\d+]/g, '')}` : null;
  const publicHeroName = resolvePublicProfileHeroName({ handle: profile.handle, stageName: profile.stageName, displayName: profile.displayName });
  const pageKindLabel = resolvePublicProfilePageKindLabel({ primaryRole: profile.primaryRole, roles: profile.roles, specialties: profile.specialties, isPreview: profile.isPreview });
  const publicAvatarUrl = profile.avatarUrl || (profile.handle ? CURATED_PUBLIC_AVATAR_FALLBACKS[profile.handle.toLowerCase()] || null : null);
  const role = profile.primaryRole || profile.roles[0] || 'other';
  const musicFirst = role === 'musician' || role === 'producer';
  const bookingLink = profile.links.find(link => link.kind === 'booking');
  const musicLink = profile.links.find(link => isMusicDestination(link.url));
  const mediaLink = profile.featuredMedia[0];
  const performanceLink = mediaLink || profile.links.find(link => {
    try { return ['youtube.com', 'www.youtube.com', 'youtu.be', 'vimeo.com', 'www.vimeo.com'].includes(new URL(link.url).hostname); }
    catch { return false; }
  });
  const roleLink = musicFirst ? musicLink : performanceLink || bookingLink;
  const mainAction = activeRoom
    ? { url: activeRoom.routePath, label: 'Join live room', external: false }
    : roleLink
      ? { url: roleLink.url, label: 'label' in roleLink ? roleLink.label : `Watch ${roleLink.title}`, external: true }
      : releases[0]
        ? { url: releases[0].releasePath, label: `View ${releases[0].title}`, external: false }
        : profile.links[0]
          ? { url: profile.links[0].url, label: profile.links[0].label, external: true }
          : null;
  const visibleOrder = arranging ? draftOrder : savedOrder;
  const onRoomEntry = () => activeRoom && sendDiscoveryEvent('discovery_primary_action', {
    shell: 'patron', surface: 'public-profile', route_family: 'performer-profile', has_route_context: true,
    has_session_context: false, build_commit: 'unknown', attribution_channel: getEffectiveDiscoveryChannel(),
    entity_kind: 'live_room', entity_key: activeRoom.routePath.split('/').filter(Boolean).at(-1),
    action_kind: 'room_entry', visibility_eligibility: 'eligible'
  });

  const sectionHeading = (id: PublicProfileSectionId, title = PROFILE_SECTIONS[id].label as string) => {
    return <h2 className="sway-profile-heading">{title}</h2>;
  };

  const sections: Record<PublicProfileSectionId, ReactNode> = {
    identity: <>
      <div className="sway-profile-identity">
        <div className="sway-profile-portrait">
          {publicAvatarUrl && !avatarFailed ? <img src={publicAvatarUrl} alt={`${publicHeroName} profile`} onError={() => setAvatarFailed(true)} className="aspect-square h-full w-full object-cover" /> : <div className="flex aspect-square items-center justify-center bg-fuchsia-950 font-display text-5xl font-black text-fuchsia-100">{profileInitials(profile.handle || profile.displayName)}</div>}
        </div>
        <div className="sway-profile-intro">
          <p className="sway-profile-type">{pageKindLabel}</p>
          <h1 className="sway-profile-name">{publicHeroName}</h1>
          {profile.headline ? <p className="sway-profile-headline">{profile.headline}</p> : null}
          <div className="sway-profile-details">
            {profile.city ? <p className="inline-flex items-center gap-1.5"><MapPin aria-hidden="true" className="h-3.5 w-3.5" />{profile.city}</p> : null}
            {profile.partner.active ? <span className="inline-flex items-center gap-1.5 text-fuchsia-200"><BadgeCheck aria-hidden="true" className="h-3.5 w-3.5" />{profile.partner.kind === 'exclusive' ? 'Sway Exclusive' : profile.partner.kind === 'brand' ? 'Sway Brand Partner' : 'Sway Partner'}</span> : null}
          </div>
          {mainAction ? <a href={mainAction.url} target={mainAction.external ? '_blank' : undefined} rel={mainAction.external ? 'noreferrer' : undefined} onClick={activeRoom ? onRoomEntry : undefined} className="sway-profile-primary mt-6"><span>{mainAction.label}</span>{activeRoom ? <Radio aria-hidden="true" className="h-4 w-4 shrink-0" /> : <ArrowUpRight aria-hidden="true" className="h-4 w-4 shrink-0" />}</a> : null}
        </div>
      </div>
      {profile.isPreview ? <div className="mt-6 border-t border-white/10 pt-4 text-sm text-slate-400"><p className="font-semibold text-fuchsia-200">Public page · unclaimed</p><span className="text-xs">{profile.claimState === 'pending' ? 'Claim invite in progress' : 'Unclaimed · still public'}</span><p className="mt-2">This page is public even before the performer claims it. Booking contact and tipping stay locked until the owner claims and verifies the account.</p></div> : null}
    </>,
    about: profile.bio || profile.specialties.length ? <>
      {sectionHeading('about')}
      {profile.bio ? <p className="whitespace-pre-line text-[15px] leading-7 text-slate-300">{profile.bio}</p> : null}
      {profile.specialties.length ? <ul className="mt-5 flex flex-wrap gap-x-3 gap-y-2 border-t border-white/10 pt-4 text-xs text-slate-400" aria-label="Specialties">{profile.specialties.map(specialty => <li key={specialty}>{specialty}</li>)}</ul> : null}
    </> : null,
    live: activeRoom ? <>
      <p className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-fuchsia-200"><span className="h-2 w-2 rounded-full bg-fuchsia-600" />Live now</p>
      <h2 className="font-display text-2xl font-bold text-white">Be part of the show.</h2>
      <p className="mt-2 text-sm text-slate-300">{activeRoom.requestCount} {activeRoom.requestCount === 1 ? 'request' : 'requests'} in the room.</p>
      <a href={activeRoom.routePath} onClick={onRoomEntry} className="mt-5 inline-flex min-h-12 items-center gap-3 rounded-xl bg-fuchsia-600 px-5 py-3 text-sm font-bold text-white">Join the {activeRoom.talentRole || pageKindLabel} room <ArrowUpRight aria-hidden="true" className="h-4 w-4" /></a>
    </> : null,
    events: events.length ? <>
      {sectionHeading('events')}
      <div className="grid gap-4" aria-label="Upcoming shows">{events.map(event => <PublicEventCard key={event.id} event={event} showExternalPolicy compact />)}</div>
    </> : null,
    releases: releases.length ? <>
      {sectionHeading('releases', musicFirst ? 'Music and releases' : 'Releases')}
      <p className="-mt-3 mb-5 text-xs text-slate-400">Official release pages from this performer</p>
      <div className="grid gap-4">{releases.map(release => <a key={release.id} href={release.releasePath} className="group rounded-xl border border-white/10 p-3 transition hover:border-fuchsia-200/40">
        <span className="flex items-center gap-4">{release.artworkUrl ? <img src={release.artworkUrl} alt={`${release.title} artwork`} loading="lazy" className="h-16 w-16 shrink-0 rounded-lg object-cover" /> : <Disc3 aria-hidden="true" className="h-12 w-12 shrink-0 text-fuchsia-200" />}<span className="min-w-0"><span className="block break-words font-bold text-white">{release.title}</span><span className="mt-1 block text-xs text-slate-400">{release.primaryArtistName}</span><span className="mt-1 block text-xs text-fuchsia-200">{release.status === 'published' ? 'Out now' : release.scheduledReleaseAt ? `Coming ${new Date(release.scheduledReleaseAt).toLocaleDateString()}` : 'Release ready'}</span></span><ArrowUpRight aria-hidden="true" className="ml-auto h-4 w-4 shrink-0 text-slate-400" /></span>
        <span className="mt-3 flex flex-wrap gap-1.5">{release.creationTags.map(tag => <span key={tag} className={`rounded-full border px-2 py-1 text-[10px] font-semibold ${releaseTagClass(tag)}`}>{tag}</span>)}</span>
      </a>)}</div>
    </> : null,
    media: profile.featuredMedia.length ? <>
      {sectionHeading('media', role === 'dj' ? 'Sets & performances' : 'Featured performances')}
      <div className="space-y-6">{profile.featuredMedia.map(media => <article key={`${media.sortOrder}:${media.embedUrl}`}>
        <div className="aspect-video overflow-hidden rounded-xl bg-black"><iframe title={media.title} src={media.embedUrl} className="h-full w-full" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerPolicy="strict-origin-when-cross-origin" allowFullScreen /></div>
        <div className="mt-3 flex items-start justify-between gap-4"><div className="min-w-0"><h3 className="text-sm font-bold text-white">{media.title}</h3>{media.description ? <p className="mt-1 text-xs leading-5 text-slate-400">{media.description}</p> : null}</div><a href={media.url} target="_blank" rel="noreferrer" className="inline-flex min-h-11 shrink-0 items-center gap-1 text-xs font-bold text-fuchsia-200">Watch <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" /></a></div>
      </article>)}</div>
    </> : null,
    links: profile.links.some(link => link.url !== bookingLink?.url) ? <>
      {sectionHeading('links', musicFirst && musicLink ? 'Listen & explore' : 'Explore more')}
      <div className="divide-y divide-white/10" aria-label="Profile links">{profile.links.map(link => link.url === bookingLink?.url ? null : <a key={`${link.sortOrder}:${link.url}`} href={link.url} target="_blank" rel="noreferrer" className="group flex min-h-20 items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
        <span className="min-w-0">{link.kind !== 'other' ? <span className="mb-1 block text-[10px] font-semibold uppercase tracking-widest text-slate-400">{formatLinkKind(link.kind)}</span> : null}<span className="block text-base font-semibold text-white group-hover:text-fuchsia-200">{link.label}</span>{link.description ? <span className="mt-1 block text-sm leading-6 text-slate-400">{link.description}</span> : null}</span><ArrowUpRight aria-hidden="true" className="h-4 w-4 shrink-0 text-slate-400 transition group-hover:text-fuchsia-200" />
      </a>)}</div>
    </> : null,
    booking: profile.booking.email || telephoneHref || bookingLink || profile.booking.verificationRequired ? <>
      {sectionHeading('booking')}
      <div className="flex flex-wrap gap-3">{profile.booking.email ? <a href={`mailto:${profile.booking.email}`} className="inline-flex min-h-12 items-center gap-2 rounded-xl bg-fuchsia-600 px-4 py-3 text-sm font-bold text-white"><Mail aria-hidden="true" className="h-4 w-4" />Book / contact</a> : null}{telephoneHref ? <a href={telephoneHref} className="inline-flex min-h-12 items-center gap-2 rounded-xl border border-white/15 px-4 py-3 text-sm font-bold"><Phone aria-hidden="true" className="h-4 w-4" />Call</a> : null}{bookingLink ? <a href={bookingLink.url} target="_blank" rel="noreferrer" className="inline-flex min-h-12 items-center gap-2 rounded-xl border border-white/15 px-4 py-3 text-sm font-bold text-fuchsia-200">{bookingLink.label}<ArrowUpRight aria-hidden="true" className="h-4 w-4" /></a> : null}</div>
      {profile.booking.verificationRequired ? <p className="mt-3 flex gap-2 text-xs leading-6 text-slate-400"><LockKeyhole aria-hidden="true" className="mt-1 h-3.5 w-3.5 shrink-0" />Direct booking contact unlocks after this performer claims and verifies the profile.</p> : null}
    </> : null,
    social: socialLinks.length ? <>
      {sectionHeading('social', 'Find me elsewhere')}
      <div className="flex flex-wrap gap-2" aria-label="Social links">{socialLinks.map(([key, url]) => <a key={key} href={url} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-2 rounded-full border border-white/15 px-4 py-2 text-sm font-medium text-slate-200 hover:border-fuchsia-200/50">{SOCIAL_LABELS[key] || key}<ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5 text-slate-400" /></a>)}</div>
    </> : null
  };

  return (
    <div className="sway-profile-page">
      <div className="sway-profile-backdrop"><AppBackdrop /></div>
      <main className="sway-profile-content">
        <header className="sway-profile-nav">
          <a href="/" aria-label="Sway home" className="inline-flex min-h-11 shrink-0 items-center gap-2.5"><img src="/icon-192.png" alt="" width="44" height="44" className="h-11 w-11 rounded-xl" /><span className="hidden text-xs font-medium tracking-widest text-fuchsia-100 sm:inline">sway to play</span></a>
          <div className="flex min-w-0 items-center gap-2">
            <a href="/discover" className="inline-flex min-h-11 items-center px-2 text-xs font-semibold text-slate-300 hover:text-white">Discover shows</a>
            <button type="button" onClick={handleShare} className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border border-white/15 px-4 py-2 text-xs font-semibold text-slate-200 hover:border-fuchsia-200/50"><Share2 aria-hidden="true" className="h-3.5 w-3.5" />{shareMessage || 'Share'}</button>
          </div>
        </header>

        {shareFallback ? <label className="mb-5 block text-xs text-slate-300">Copy this profile link<input aria-label="Profile link to copy" readOnly value={profileUrl} ref={selectShareLink} className="mt-2 min-h-11 w-full rounded-xl border border-fuchsia-200/30 bg-slate-950 px-3 text-sm text-white" /></label> : null}

        {ownerLayout && !arranging ? <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-fuchsia-200/20 bg-fuchsia-500/[0.04] px-4 py-3"><p className="text-xs text-slate-300">This is your public profile.</p><button type="button" onClick={() => { setDraftOrder(savedOrder); setResetLayout(false); setLayoutConflict(false); setLayoutMessage(''); setPreviewingLayout(false); setArranging(true); }} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-fuchsia-200/30 px-3 py-2 text-xs font-bold text-fuchsia-100"><LayoutGrid aria-hidden="true" className="h-4 w-4" />Arrange profile</button></div> : null}

        {ownerLayout && arranging ? <section className={`sway-profile-arranger ${previewingLayout ? 'sway-profile-arranger-preview' : ''}`} aria-label="Arrange your profile">
          <h2 className="font-display text-lg font-bold">{previewingLayout ? 'Your profile preview' : 'Your page, your order.'}</h2>
          {!previewingLayout ? <p className="mt-1 text-xs leading-5 text-slate-300">Drag sections or use the arrows, then preview your page.</p> : null}
          <div className="mt-3 grid grid-cols-3 gap-2">
            <button type="button" aria-pressed={previewingLayout} onClick={() => setPreviewingLayout(current => !current)} className="min-h-11 rounded-xl border border-fuchsia-300/30 px-2 py-2 text-[11px] font-bold text-fuchsia-100">{previewingLayout ? 'Arrange sections' : 'Preview layout'}</button>
            <button type="button" onClick={saveLayout} disabled={!layoutDirty || layoutSaving || layoutConflict} className="min-h-11 rounded-xl bg-fuchsia-600 px-2 py-2 text-[11px] font-bold text-white disabled:opacity-40">{layoutSaving ? 'Saving…' : 'Save layout'}</button>
            <button type="button" disabled={layoutSaving} onClick={() => {setArranging(false);setResetLayout(false);setLayoutMessage('');setLayoutConflict(false);}} className="min-h-11 rounded-xl border border-white/15 px-2 py-2 text-[11px] font-semibold disabled:opacity-40">Cancel</button>
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3"><span className="text-[10px] text-slate-400">{layoutDirty ? 'Unsaved changes' : 'No unsaved changes'}</span>{!previewingLayout ? <button type="button" disabled={layoutSaving} onClick={() => { setDraftOrder(resolvePublicProfileSectionOrder({roles:profile.roles,primaryRole:profile.primaryRole})); setResetLayout(true); setLayoutMessage('Suggested layout previewed. Save to use it on your public page.'); }} className="min-h-11 text-[11px] font-semibold text-fuchsia-200 disabled:opacity-40">Use suggested layout</button> : null}</div>
          {layoutConflict ? <div className="flex flex-wrap gap-3"><button type="button" disabled={layoutSaving} onClick={() => reloadLayout(true)} className="min-h-11 text-xs font-semibold text-fuchsia-200">Keep my arrangement</button><button type="button" disabled={layoutSaving} onClick={() => reloadLayout()} className="min-h-11 text-xs font-semibold text-fuchsia-200">Reload saved layout</button></div> : null}
          {!previewingLayout ? <div className="sway-profile-arrangement-grid">
            {draftOrder.map((id, index) => {
              const Icon = PROFILE_SECTIONS[id].icon;
              const label = PROFILE_SECTIONS[id].label;
              return <div key={id} data-arrange-target={id} className={`sway-profile-arrangement-tile ${dragging === id ? 'border-fuchsia-200 bg-fuchsia-500/10' : 'border-white/15 bg-[#0b0712]'}`}>
                <div className="flex items-center justify-between gap-1"><Icon aria-hidden="true" className="h-4 w-4 text-fuchsia-200" /><button type="button" tabIndex={-1} disabled={layoutSaving} aria-label={`Drag ${label}`} className="-my-1 flex h-11 w-11 shrink-0 touch-none select-none items-center justify-center rounded-lg text-slate-300 active:cursor-grabbing disabled:opacity-40" onPointerDown={event => { if (layoutSaving || (event.pointerType === 'mouse' && event.button !== 0)) return; event.currentTarget.setPointerCapture(event.pointerId); dragId.current = id; setDragging(id); }} onPointerMove={event => { if (dragId.current !== id || layoutSaving) return; const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-arrange-target]'); const targetId = target?.dataset.arrangeTarget as PublicProfileSectionId | undefined; if (targetId) moveSection(id, targetId); if (event.clientY < 70) window.scrollBy(0,-12); else if (event.clientY > innerHeight - 70) window.scrollBy(0,12); }} onPointerUp={() => { dragId.current = null; setDragging(null); }} onPointerCancel={() => { dragId.current = null; setDragging(null); }} onLostPointerCapture={() => { dragId.current = null; setDragging(null); }}><GripVertical aria-hidden="true" className="h-4 w-4" /></button></div>
                <p className="min-h-8 text-[11px] font-bold leading-4 text-white">{label}</p><p className="text-[10px] leading-4 text-slate-400">{sections[id] ? 'On your page' : 'Empty'}</p>
                <div className="mt-1 flex justify-center border-t border-white/10"><button type="button" aria-label={`Move ${label} earlier`} disabled={index===0 || layoutSaving} onClick={() => moveSection(id,draftOrder[index-1])} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-300 hover:bg-white/5 disabled:opacity-25"><ArrowUp aria-hidden="true" className="h-3.5 w-3.5" /></button><button type="button" aria-label={`Move ${label} later`} disabled={index===draftOrder.length-1 || layoutSaving} onClick={() => moveSection(id,draftOrder[index+1])} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-300 hover:bg-white/5 disabled:opacity-25"><ArrowDown aria-hidden="true" className="h-3.5 w-3.5" /></button></div>
              </div>;
            })}
          </div> : null}
        </section> : null}

        <p role="status" aria-live="polite" className={layoutMessage ? 'mb-5 text-sm text-fuchsia-100' : 'sr-only'}>{layoutMessage}</p>
        {arranging ? <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-slate-400">Your profile preview</p> : null}
        <div className="sway-profile-sections">
          {visibleOrder.map(id => sections[id] ? <section key={id} data-profile-section={id} className={`sway-profile-section ${id === 'identity' ? 'sway-profile-hero' : ''} ${id === 'live' ? 'sway-profile-live' : ''}`} aria-label={PROFILE_SECTIONS[id].label}>{sections[id]}</section> : null)}
        </div>

        <footer className="sway-profile-footer">
          <div className="flex flex-wrap items-center justify-between gap-3"><a href="/" className="inline-flex min-h-11 items-center gap-2 text-xs font-medium text-slate-400"><img src="/icon-192.png" alt="" width="28" height="28" className="h-7 w-7 rounded-lg" />sway to play</a><a href="/account/signup?intent=performer" className="inline-flex min-h-11 items-center gap-2 text-xs font-semibold text-fuchsia-200">Create your own free Sway page<ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" /></a></div>
          <details className="mt-3 max-w-xl text-xs text-slate-500"><summary className="w-fit cursor-pointer py-3 hover:text-slate-300">How did you discover Sway?</summary><DiscoveryFindUsPrompt routeFamily="performer-profile" surface="public-profile" entityKey={profile.handle || performerHandle} /></details>
        </footer>
      </main>
    </div>
  );
}
