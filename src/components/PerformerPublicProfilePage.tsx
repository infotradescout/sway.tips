import {
  ArrowUpRight,
  BadgeCheck,
  Coins,
  Globe2,
  LockKeyhole,
  Mail,
  MapPin,
  Phone,
  Play,
  Radio,
  Share2,
  Sparkles
} from 'lucide-react';
import { motion } from 'motion/react';
import { QRCodeCanvas } from 'qrcode.react';
import { useEffect, useMemo, useState } from 'react';

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
  displayName: string;
  stageName: string | null;
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

type ProfileResponse = {
  performer?: PublicPerformerProfile;
  activeRoom?: ActiveProfileRoom | null;
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
  dj3x: 'https://images.squarespace-cdn.com/content/v1/5cf285bbb53c220001bebf7d/1622122633773-7NUVXLO3VXOEC2LIFYQH/0A0A0388.jpg',
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

export default function PerformerPublicProfilePage({ performerHandle }: { performerHandle: string }) {
  const [profile, setProfile] = useState<PublicPerformerProfile | null>(null);
  const [activeRoom, setActiveRoom] = useState<ActiveProfileRoom | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'not-found' | 'error'>('loading');
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [shareMessage, setShareMessage] = useState<string | null>(null);
  const [tipMessage, setTipMessage] = useState<string | null>(null);
  const [tipOpen, setTipOpen] = useState(false);

  const handleTipClick = () => {
    if (!profile) return;

    if (profile.isPreview || profile.claimState !== 'claimed') {
      setTipOpen(false);
      setTipMessage('Tipping is unavailable until this profile is claimed and verified by the performer. No payment was started.');
      return;
    }

    setTipMessage(null);
    setTipOpen(true);
  };

  const handlePayClick = () => {
    if (!profile) return;
    if (profile.isPreview || profile.claimState !== 'claimed') {
      setTipMessage('Tipping is unavailable until this profile is claimed and verified by the performer. No payment was started.');
      return;
    }
    setTipMessage('Direct profile payments are not enabled for this performer yet. No payment was started.');
  };

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
        setAvatarFailed(false);
        setStatus('ready');
        document.title = `${data.performer.stageName || (data.performer.handle?.toLowerCase() === 'dj3x' ? 'DJ3X' : data.performer.displayName)} on Sway`;
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
  }, [performerHandle]);

  const socialLinks = useMemo(() => Object.entries(profile?.socialLinks || {})
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0), [profile]);

  const profileUrl = useMemo(() => {
    if (!profile) return '';
    const canonicalHandle = profile.handle || performerHandle;
    const profilePath = `/p/${encodeURIComponent(canonicalHandle)}`;
    return typeof window === 'undefined'
      ? profilePath
      : new URL(profilePath, window.location.origin).toString();
  }, [performerHandle, profile]);

  const profileTipUrl = useMemo(() => `${profileUrl}#tip`, [profileUrl]);

  const handleShare = async () => {
    if (!profile) return;
    const shareData = {
      title: `${profile.displayName} on Sway`,
      text: profile.headline || `Visit ${profile.displayName}'s public Sway page.`,
      url: profileUrl
    };

    try {
      if (navigator.share) {
        await navigator.share(shareData);
        return;
      }
      await navigator.clipboard.writeText(profileUrl);
      setShareMessage('Link copied');
      window.setTimeout(() => setShareMessage(null), 1800);
    } catch {
      // A dismissed native share sheet should leave the page unchanged.
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
              ? 'This performer page is not published right now.'
              : 'Sway could not load this page. Try again in a moment.'}
          </p>
          <a href="/" className="mt-6 inline-flex min-h-11 items-center justify-center rounded-xl border border-white/10 px-4 py-3 text-sm font-bold text-white hover:border-fuchsia-400/40">
            Return to Sway
          </a>
        </div>
      </div>
    );
  }

  const telephoneHref = profile.booking.phone
    ? `tel:${profile.booking.phone.replace(/[^\d+]/g, '')}`
    : null;
  const stageName = profile.stageName || (profile.handle?.toLowerCase() === 'dj3x' ? 'DJ3X' : profile.displayName);
  const hasDistinctDisplayName = stageName.trim().toLowerCase() !== profile.displayName.trim().toLowerCase();
  const publicAvatarUrl = profile.avatarUrl || (profile.handle ? CURATED_PUBLIC_AVATAR_FALLBACKS[profile.handle.toLowerCase()] || null : null);

  return (
    <div className="relative isolate min-h-screen overflow-hidden bg-[#05060a] text-slate-100">
      <div className="pointer-events-none fixed inset-0 -z-20 bg-[radial-gradient(circle_at_16%_0%,rgba(217,70,239,0.24),transparent_33%),radial-gradient(circle_at_88%_18%,rgba(34,211,238,0.18),transparent_30%),linear-gradient(180deg,#070811_0%,#05060a_55%,#020306_100%)]" />
      <div className="pointer-events-none fixed inset-x-0 top-0 -z-10 h-px bg-gradient-to-r from-transparent via-fuchsia-400/70 to-transparent" />

      <main className="mx-auto w-full max-w-2xl px-4 pb-14 pt-5 sm:px-6 sm:pt-8">
        <header className="flex items-center justify-between gap-3">
          <a href="/" aria-label="Sway home" className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] font-display text-lg font-black text-white backdrop-blur hover:border-fuchsia-400/40">
            S
          </a>
          <button
            type="button"
            onClick={handleShare}
            className="inline-flex min-h-10 items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-black text-slate-200 backdrop-blur transition hover:border-cyan-300/40 hover:text-white"
          >
            <Share2 className="h-3.5 w-3.5" />
            {shareMessage || 'Share'}
          </button>
        </header>

        <motion.section
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="mt-7 overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950/65 p-5 shadow-2xl shadow-fuchsia-950/20 backdrop-blur-xl sm:p-7"
        >
          <div className="flex flex-col items-center text-center">
            <div className="relative">
              <div className="absolute -inset-2 rounded-[2rem] bg-gradient-to-br from-fuchsia-500/45 to-cyan-400/35 blur-xl" />
              {publicAvatarUrl && !avatarFailed ? (
                <img
                  src={publicAvatarUrl}
                  alt={`${profile.displayName} profile`}
                  onError={() => setAvatarFailed(true)}
                  className="relative h-28 w-28 rounded-[1.75rem] border border-white/15 object-cover shadow-2xl sm:h-32 sm:w-32"
                />
              ) : (
                <div className="relative flex h-28 w-28 items-center justify-center rounded-[1.75rem] border border-white/15 bg-gradient-to-br from-fuchsia-500/25 to-cyan-400/15 font-display text-3xl font-black text-white shadow-2xl sm:h-32 sm:w-32">
                  {profileInitials(profile.displayName)}
                </div>
              )}
            </div>

            <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
              <p className="text-[10px] font-black uppercase tracking-[0.3em] text-cyan-300">{profile.isPreview ? 'Working profile preview' : 'Public performer page'}</p>
              {profile.isPreview ? (
                <span className="inline-flex min-h-7 items-center gap-1.5 rounded-full border border-cyan-300/25 bg-cyan-300/10 px-2.5 py-1 text-[9px] font-black uppercase tracking-[0.2em] text-cyan-100">
                  {profile.claimState === 'pending' ? 'Claim invite in progress' : 'Unclaimed · ready to review'}
                </span>
              ) : null}
              {profile.partner.active ? (
                <span className="inline-flex min-h-7 items-center gap-1.5 rounded-full border border-amber-300/25 bg-amber-300/10 px-2.5 py-1 text-[9px] font-black uppercase tracking-[0.2em] text-amber-100">
                  <BadgeCheck className="h-3.5 w-3.5" /> Sway Brand Partner
                </span>
              ) : null}
            </div>
            <h1 className="mt-2 font-display text-3xl font-black tracking-tight text-white sm:text-4xl">{stageName}</h1>
            {hasDistinctDisplayName ? <p className="mt-1 text-sm font-bold text-slate-400">{profile.displayName}</p> : null}
            <div className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-slate-400">
              {profile.handle ? <span>@{profile.handle}</span> : null}
              {profile.city ? (
                <span className="inline-flex items-center gap-1">
                  <MapPin className="h-3 w-3" />
                  {profile.city}
                </span>
              ) : null}
            </div>
            {profile.headline ? <p className="mt-4 max-w-xl text-base font-bold leading-7 text-slate-100">{profile.headline}</p> : null}
            {profile.specialties.length ? (
              <div className="mt-4 flex flex-wrap justify-center gap-2" aria-label="Specialties">
                {profile.specialties.map((specialty) => (
                  <span key={specialty} className="rounded-full border border-white/10 bg-white/[0.045] px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-slate-300">
                    {specialty}
                  </span>
                ))}
              </div>
            ) : null}
            {profile.bio ? <p className="mt-3 max-w-xl whitespace-pre-line text-sm leading-6 text-slate-400">{profile.bio}</p> : null}
          </div>

          {profile.isPreview ? (
            <div className="mt-6 rounded-2xl border border-cyan-300/20 bg-cyan-300/[0.06] px-4 py-4 text-left">
              <p className="text-[10px] font-black uppercase tracking-[0.24em] text-cyan-200">Prepared for the performer</p>
              <p className="mt-2 text-sm leading-6 text-slate-300">
                This is a review-ready Sway page. It is not claimed yet, and direct booking contact stays locked until the owner verifies the account.
              </p>
            </div>
          ) : null}

          <div className="mt-5">
            <button
              type="button"
              onClick={handleTipClick}
              className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border border-amber-300/30 bg-amber-300/[0.08] px-4 py-3 text-sm font-black text-amber-100 transition hover:border-amber-200/60 hover:bg-amber-300/[0.14]"
            >
              <Coins className="h-4 w-4" />
              Tip {stageName}
            </button>
            {tipMessage ? (
              <p id="public-profile-tip-message" role="status" className="mt-3 rounded-xl border border-amber-300/20 bg-amber-300/[0.06] px-4 py-3 text-left text-xs leading-5 text-amber-100/90">
                {tipMessage}
              </p>
            ) : null}
          </div>

          {tipOpen ? (
            <section className="mt-5 rounded-2xl border border-amber-300/25 bg-amber-300/[0.06] p-4 text-left" aria-label="Tip this performer">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-[10px] font-black uppercase tracking-[0.24em] text-amber-200">Tip {stageName}</p>
                <p className="mt-2 text-sm font-bold text-white">Scan to tip {stageName}, or pay directly here.</p>
                <p className="mt-2 break-all text-xs leading-5 text-slate-400">{profileTipUrl}</p>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(profileTipUrl);
                      setShareMessage('Tip link copied');
                      window.setTimeout(() => setShareMessage(null), 1800);
                    } catch {
                      setShareMessage('Copy unavailable');
                    }
                  }}
                  className="mt-3 inline-flex min-h-9 items-center justify-center rounded-xl border border-amber-300/25 bg-amber-300/[0.08] px-3 py-2 text-xs font-black text-amber-100 transition hover:border-amber-200/60 hover:bg-amber-300/[0.14]"
                >
                  Copy tip link
                </button>
                <button
                  type="button"
                  onClick={handlePayClick}
                  className="mt-3 inline-flex min-h-10 w-full items-center justify-center rounded-xl bg-amber-300 px-4 py-2 text-xs font-black text-slate-950 transition hover:bg-amber-200 sm:w-auto"
                >
                  Pay through Sway
                </button>
              </div>
              <div className="shrink-0 self-center rounded-2xl bg-white p-3 shadow-inner" data-public-profile-qr="true">
                <QRCodeCanvas
                  key={profileTipUrl}
                  aria-label="Sway tip QR code"
                  value={profileTipUrl}
                  size={156}
                  level="H"
                  bgColor="#ffffff"
                  fgColor="#000000"
                  marginSize={4}
                />
              </div>
            </div>
            </section>
          ) : null}

          {activeRoom ? (
            <a
              href={activeRoom.routePath}
              className="mt-6 flex min-h-16 items-center justify-between gap-4 rounded-2xl border border-fuchsia-300/30 bg-gradient-to-r from-fuchsia-600 to-violet-600 px-5 py-4 text-left shadow-lg shadow-fuchsia-950/30 transition hover:from-fuchsia-500 hover:to-violet-500"
            >
              <span>
                <span className="inline-flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.24em] text-fuchsia-100">
                  <Radio className="h-3.5 w-3.5" /> Live now
                </span>
                <span className="mt-1 block text-sm font-black text-white">Join the {activeRoom.talentRole || 'performer'} room</span>
              </span>
              <span className="shrink-0 text-xs font-bold text-fuchsia-100">
                {activeRoom.requestCount} {activeRoom.requestCount === 1 ? 'request' : 'requests'}
              </span>
            </a>
          ) : null}

          {profile.featuredMedia.length ? (
            <section className="mt-5 overflow-hidden rounded-2xl border border-white/10 bg-black/30" aria-label="Featured media">
              <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-red-500/15 text-red-200">
                    <Play className="h-4 w-4 fill-current" />
                  </span>
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-[0.24em] text-red-200">Featured performance</p>
                    <p className="mt-0.5 text-xs text-slate-500">Watch the work in motion</p>
                  </div>
                </div>
              </div>
              <div className="space-y-4 p-3 sm:p-4">
                {profile.featuredMedia.map((media) => (
                  <article key={`${media.sortOrder}:${media.embedUrl}`} className="overflow-hidden rounded-xl border border-white/10 bg-slate-950/70">
                    <div className="aspect-video bg-black">
                      <iframe
                        title={media.title}
                        src={media.embedUrl}
                        className="h-full w-full"
                        loading="lazy"
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                        referrerPolicy="strict-origin-when-cross-origin"
                        allowFullScreen
                      />
                    </div>
                    <div className="flex items-start justify-between gap-4 px-4 py-3">
                      <div>
                        <h2 className="text-sm font-black text-white">{media.title}</h2>
                        {media.description ? <p className="mt-1 text-xs leading-5 text-slate-400">{media.description}</p> : null}
                      </div>
                      <a href={media.url} target="_blank" rel="noreferrer" className="shrink-0 text-xs font-bold text-red-200 hover:text-white">Open</a>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          {(profile.booking.email || telephoneHref) ? (
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {profile.booking.email ? (
                <a href={`mailto:${profile.booking.email}`} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl border border-cyan-300/25 bg-cyan-400/10 px-4 py-3 text-sm font-black text-cyan-100 transition hover:border-cyan-300/50 hover:bg-cyan-400/15">
                  <Mail className="h-4 w-4" /> Book / contact
                </a>
              ) : null}
              {telephoneHref ? (
                <a href={telephoneHref} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-black text-white transition hover:border-white/25 hover:bg-white/[0.07]">
                  <Phone className="h-4 w-4" /> Call
                </a>
              ) : null}
            </div>
          ) : null}
          {profile.booking.verificationRequired ? (
            <div className="mt-5 flex items-start gap-3 rounded-2xl border border-amber-300/20 bg-amber-300/[0.07] px-4 py-3 text-left text-xs leading-5 text-amber-100/80">
              <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-amber-200" />
              <span>Direct booking contact unlocks after this performer claims and verifies the profile.</span>
            </div>
          ) : null}
        </motion.section>

        {profile.links.length ? (
          <section className="mt-4 space-y-3" aria-label="Profile links">
            {profile.links.map((link, index) => (
              <motion.a
                key={`${link.sortOrder}:${link.url}`}
                href={link.url}
                target="_blank"
                rel="noreferrer"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, delay: Math.min(index * 0.04, 0.24) }}
                className="group flex min-h-20 items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/[0.045] px-5 py-4 backdrop-blur transition hover:-translate-y-0.5 hover:border-cyan-300/35 hover:bg-white/[0.075]"
              >
                <span className="min-w-0">
                  <span className="text-[9px] font-black uppercase tracking-[0.25em] text-cyan-300/80">{formatLinkKind(link.kind)}</span>
                  <span className="mt-1 block text-sm font-black text-white sm:text-base">{link.label}</span>
                  {link.description ? <span className="mt-1 block text-xs leading-5 text-slate-400">{link.description}</span> : null}
                </span>
                <ArrowUpRight className="h-5 w-5 shrink-0 text-slate-500 transition group-hover:text-cyan-200" />
              </motion.a>
            ))}
          </section>
        ) : null}

        {socialLinks.length ? (
          <section className="mt-5 flex flex-wrap justify-center gap-2" aria-label="Social links">
            {socialLinks.map(([key, url]) => (
              <a
                key={key}
                href={url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-10 items-center gap-2 rounded-full border border-white/10 bg-slate-950/60 px-4 py-2 text-xs font-black text-slate-300 transition hover:border-fuchsia-300/35 hover:text-white"
              >
                {key === 'website' ? <Globe2 className="h-3.5 w-3.5" /> : null}
                {SOCIAL_LABELS[key] || key}
              </a>
            ))}
          </section>
        ) : null}

        <footer className="mt-10 text-center">
          <div className="inline-flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.28em] text-slate-600">
            <Sparkles className="h-3.5 w-3.5" /> sway to play
          </div>
          <a href="/talent/signup" className="mt-3 block text-xs font-bold text-slate-500 transition hover:text-fuchsia-200">
            Create your own free Sway page
          </a>
        </footer>
      </main>
    </div>
  );
}
