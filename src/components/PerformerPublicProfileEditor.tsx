import {
  ArrowDown,
  ArrowUp,
  BadgeCheck,
  ExternalLink,
  Link2,
  Plus,
  Save,
  Trash2
} from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { PUBLIC_PERFORMER_PRIMARY_ROLES } from '../server/public-profile';

type LinkDraft = {
  key: string;
  label: string;
  description: string;
  url: string;
  kind: string;
  isActive: boolean;
};

type ProfileForm = {
  primaryRole: string;
  stageName: string;
  headline: string;
  specialties: string;
  bio: string;
  city: string;
  avatarUrl: string;
  bookingEmail: string;
  bookingPhone: string;
  facebook: string;
  instagram: string;
  tiktok: string;
  youtube: string;
  soundcloud: string;
  website: string;
  links: LinkDraft[];
};

const EMPTY_FORM: ProfileForm = {
  primaryRole: '',
  stageName: '',
  headline: '',
  specialties: '',
  bio: '',
  city: '',
  avatarUrl: '',
  bookingEmail: '',
  bookingPhone: '',
  facebook: '',
  instagram: '',
  tiktok: '',
  youtube: '',
  soundcloud: '',
  website: '',
  links: []
};

const LINK_KINDS = ['booking', 'brand', 'event', 'community', 'press', 'social', 'support', 'other'];

const SOCIAL_FIELDS = [
  ['facebook', 'Facebook', 'https://facebook.com/...'],
  ['instagram', 'Instagram', 'https://instagram.com/...'],
  ['tiktok', 'TikTok', 'https://tiktok.com/@...'],
  ['youtube', 'YouTube', 'https://youtube.com/...'],
  ['soundcloud', 'SoundCloud', 'https://soundcloud.com/...'],
  ['website', 'Website', 'https://yourdomain.com']
] as const;

function text(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function linkKey(index: number) {
  return `profile-link-${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`;
}

function fieldClass() {
  return 'min-h-12 w-full rounded-xl border border-white/10 bg-slate-950 px-3.5 py-3 text-sm font-semibold text-white outline-none transition focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400/30';
}

function fieldLabel() {
  return 'text-[9px] font-black uppercase tracking-[0.2em] text-slate-500';
}

export default function PerformerPublicProfileEditor({
  performerHandle,
  previewMode = false
}: {
  performerHandle?: string | null;
  previewMode?: boolean;
}) {
  const [form, setForm] = useState<ProfileForm>(EMPTY_FORM);
  const [status, setStatus] = useState<'loading' | 'idle' | 'saving' | 'success' | 'error'>(previewMode ? 'idle' : 'loading');
  const [message, setMessage] = useState<string | null>(null);
  const [partner, setPartner] = useState<{
    granted: boolean;
    active: boolean;
    accepted: boolean;
    suspended: boolean;
    acceptanceRequired: boolean;
    termsVersion: string | null;
    termsHash: string | null;
    termsText: string | null;
  }>({
    granted: false,
    active: false,
    accepted: false,
    suspended: false,
    acceptanceRequired: false,
    termsVersion: null,
    termsHash: null,
    termsText: null
  });
  const [partnerAcceptanceConfirmed, setPartnerAcceptanceConfirmed] = useState(false);
  const [partnerAcceptanceStatus, setPartnerAcceptanceStatus] = useState<'idle' | 'submitting' | 'error'>('idle');
  const [partnerAcceptanceMessage, setPartnerAcceptanceMessage] = useState<string | null>(null);

  useEffect(() => {
    if (previewMode) return;
    let cancelled = false;
    const controller = new AbortController();

    const load = async () => {
      setStatus('loading');
      setMessage(null);
      try {
        const response = await fetch('/api/talent/profile/public', { cache: 'no-store', signal: controller.signal });
        const data = await response.json().catch(() => null);
        if (cancelled) return;
        if (!response.ok || !data?.profile) {
          throw new Error(typeof data?.error === 'string' ? data.error : 'Unable to load your public page.');
        }

        const profile = data.profile;
        setForm({
          primaryRole: text(profile.primaryRole),
          stageName: text(profile.stageName),
          headline: text(profile.headline),
          specialties: Array.isArray(profile.specialties) ? profile.specialties.join(', ') : '',
          bio: text(profile.bio),
          city: text(profile.city),
          avatarUrl: text(profile.avatarUrl),
          bookingEmail: text(profile.booking?.email),
          bookingPhone: text(profile.booking?.phone),
          facebook: text(profile.socialLinks?.facebook),
          instagram: text(profile.socialLinks?.instagram),
          tiktok: text(profile.socialLinks?.tiktok),
          youtube: text(profile.socialLinks?.youtube),
          soundcloud: text(profile.socialLinks?.soundcloud),
          website: text(profile.socialLinks?.website),
          links: Array.isArray(profile.links)
            ? profile.links.map((link: any, index: number) => ({
                key: text(link.id) || linkKey(index),
                label: text(link.label),
                description: text(link.description),
                url: text(link.url),
                kind: LINK_KINDS.includes(link.kind) ? link.kind : 'other',
                isActive: link.isActive !== false
              }))
            : []
        });
        setPartner({
          granted: profile.partner?.granted === true,
          active: profile.partner?.active === true,
          accepted: profile.partner?.accepted === true,
          suspended: profile.partner?.suspended === true,
          acceptanceRequired: profile.partner?.acceptanceRequired === true,
          termsVersion: text(profile.partner?.termsVersion) || null,
          termsHash: text(profile.partner?.termsHash) || null,
          termsText: text(profile.partner?.termsText) || null
        });
        setStatus('idle');
      } catch (error) {
        if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) return;
        setStatus('error');
        setMessage(error instanceof Error ? error.message : 'Unable to load your public page.');
      }
    };

    void load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [previewMode]);

  const specialties = useMemo(() => form.specialties
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 8), [form.specialties]);

  const updateLink = (index: number, updates: Partial<LinkDraft>) => {
    setForm((current) => ({
      ...current,
      links: current.links.map((link, linkIndex) => linkIndex === index ? { ...link, ...updates } : link)
    }));
  };

  const moveLink = (index: number, direction: -1 | 1) => {
    setForm((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.links.length) return current;
      const links = [...current.links];
      [links[index], links[target]] = [links[target], links[index]];
      return { ...current, links };
    });
  };

  const removeLink = (index: number) => {
    setForm((current) => ({ ...current, links: current.links.filter((_, linkIndex) => linkIndex !== index) }));
  };

  const addLink = () => {
    setForm((current) => current.links.length >= 12
      ? current
      : {
          ...current,
          links: [...current.links, {
            key: linkKey(current.links.length),
            label: '',
            description: '',
            url: '',
            kind: 'other',
            isActive: true
          }]
        });
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (previewMode || status === 'saving') return;
    setStatus('saving');
    setMessage(null);

    try {
      const response = await fetch('/api/talent/profile/public', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          primaryRole: form.primaryRole || null,
          stageName: form.stageName,
          headline: form.headline,
          specialties,
          bio: form.bio,
          city: form.city,
          avatarUrl: form.avatarUrl,
          booking: {
            email: form.bookingEmail,
            phone: form.bookingPhone
          },
          socialLinks: {
            facebook: form.facebook,
            instagram: form.instagram,
            tiktok: form.tiktok,
            youtube: form.youtube,
            soundcloud: form.soundcloud,
            website: form.website
          },
          links: form.links.map(({ label, description, url, kind, isActive }) => ({
            label,
            description,
            url,
            kind,
            isActive
          }))
        })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(typeof data?.error === 'string' ? data.error : 'Unable to save your public page.');
      }
      setStatus('success');
      setMessage('Public page saved.');
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'Unable to save your public page.');
    }
  };

  const handleAcceptPartnerTerms = async () => {
    if (
      previewMode
      || partnerAcceptanceStatus === 'submitting'
      || !partnerAcceptanceConfirmed
      || !partner.termsVersion
      || !partner.termsHash
    ) return;

    setPartnerAcceptanceStatus('submitting');
    setPartnerAcceptanceMessage(null);
    try {
      const response = await fetch('/api/talent/partner/terms/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accepted: true,
          termsVersion: partner.termsVersion,
          termsHash: partner.termsHash
        })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(typeof data?.error === 'string' ? data.error : 'Unable to record Brand Partner acceptance.');
      }
      setPartner((current) => ({
        ...current,
        accepted: true,
        acceptanceRequired: false,
        active: !current.suspended
      }));
      setPartnerAcceptanceConfirmed(false);
      setPartnerAcceptanceStatus('idle');
      setPartnerAcceptanceMessage('Brand Partner terms accepted. Your immutable receipt is recorded.');
    } catch (error) {
      setPartnerAcceptanceStatus('error');
      setPartnerAcceptanceMessage(error instanceof Error ? error.message : 'Unable to record Brand Partner acceptance.');
    }
  };

  return (
    <section data-sway-public-profile-editor="true" className="mx-auto w-full max-w-3xl overflow-hidden rounded-2xl border border-cyan-300/20 bg-slate-900/80 shadow-xl shadow-cyan-950/10">
      <div className="border-b border-white/10 bg-gradient-to-r from-cyan-500/10 via-fuchsia-500/10 to-transparent p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[10px] font-black uppercase tracking-[0.28em] text-cyan-300">Your public Sway page</p>
              {partner.granted ? (
                <span className="inline-flex min-h-7 items-center gap-1.5 rounded-full border border-amber-300/25 bg-amber-300/10 px-2.5 py-1 text-[9px] font-black uppercase tracking-[0.18em] text-amber-100">
                  <BadgeCheck className="h-3.5 w-3.5" /> {partner.active ? 'Brand Partner' : partner.suspended ? 'Partner suspended' : 'Partner acceptance pending'}
                </span>
              ) : null}
            </div>
            <h3 className="mt-2 font-display text-xl font-black text-white">A free website that works between events</h3>
            <p className="mt-2 max-w-xl text-xs leading-5 text-slate-400">
              Share your work, brands, booking details, and any links you want. A live room and payment setup are optional.
            </p>
            {partner.active ? (
              <p className="mt-2 text-[10px] leading-5 text-amber-100/80">
                Your Sway-controlled pricing is grandfathered under Brand Partner terms {partner.termsVersion || ''}.
              </p>
            ) : null}
          </div>
          {performerHandle ? (
            <a
              href={`/p/${encodeURIComponent(performerHandle)}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/10 bg-slate-950 px-4 py-2 text-xs font-black text-white transition hover:border-cyan-300/40"
            >
              View page <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ) : null}
        </div>
      </div>

      {partner.acceptanceRequired && partner.termsVersion && partner.termsHash && partner.termsText ? (
        <div className="border-b border-amber-300/15 bg-amber-300/[0.04] p-4 sm:p-6">
          <p className="text-[10px] font-black uppercase tracking-[0.24em] text-amber-200">Owner acceptance required</p>
          <h4 className="mt-2 text-base font-black text-white">Review the exact Brand Partner terms</h4>
          <pre className="mt-3 whitespace-pre-wrap rounded-2xl border border-white/10 bg-slate-950 p-4 font-sans text-xs leading-6 text-slate-300">{partner.termsText}</pre>
          <p className="mt-3 break-all font-mono text-[10px] leading-5 text-slate-500">
            Version {partner.termsVersion} · SHA-256 {partner.termsHash}
          </p>
          <label className="mt-3 flex items-start gap-3 rounded-2xl border border-amber-300/15 bg-slate-950/60 px-4 py-3 text-xs leading-5 text-slate-300">
            <input
              type="checkbox"
              checked={partnerAcceptanceConfirmed}
              onChange={(event) => setPartnerAcceptanceConfirmed(event.target.checked)}
              className="mt-0.5 h-4 w-4"
            />
            <span>I am the authenticated owner of this performer account and accept this exact version and hash.</span>
          </label>
          {partnerAcceptanceMessage ? (
            <p className={`mt-3 rounded-xl border px-4 py-3 text-xs ${partnerAcceptanceStatus === 'error' ? 'border-rose-500/25 bg-rose-500/10 text-rose-100' : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-100'}`}>
              {partnerAcceptanceMessage}
            </p>
          ) : null}
          <button
            type="button"
            onClick={handleAcceptPartnerTerms}
            disabled={!partnerAcceptanceConfirmed || partnerAcceptanceStatus === 'submitting'}
            className="mt-3 inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-amber-300 px-4 py-3 text-sm font-black text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {partnerAcceptanceStatus === 'submitting' ? 'Recording acceptance...' : 'Accept exact Brand Partner terms'}
          </button>
        </div>
      ) : partnerAcceptanceMessage ? (
        <div className="border-b border-emerald-500/20 bg-emerald-500/5 px-5 py-3 text-xs text-emerald-100">{partnerAcceptanceMessage}</div>
      ) : null}

      <form className="space-y-6 p-4 sm:p-6" onSubmit={handleSubmit}>
        <fieldset disabled={previewMode || status === 'loading' || status === 'saving'} className="space-y-6 disabled:opacity-70">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1.5 sm:col-span-2">
              <span className={fieldLabel()}>What kind of performer are you?</span>
              <select
                className={fieldClass()}
                required
                value={form.primaryRole}
                onChange={(event) => setForm((current) => ({ ...current, primaryRole: event.target.value }))}
              >
                <option value="">Choose one</option>
                {PUBLIC_PERFORMER_PRIMARY_ROLES.map((role) => (
                  <option key={role.id} value={role.id}>{role.label}</option>
                ))}
              </select>
              <span className="block text-[11px] leading-5 text-slate-500">This appears at the top of your public page instead of a generic “performer” label.</span>
            </label>
            <label className="space-y-1.5 sm:col-span-2">
              <span className={fieldLabel()}>Stage name — optional</span>
              <input className={fieldClass()} maxLength={80} value={form.stageName} onChange={(event) => setForm((current) => ({ ...current, stageName: event.target.value }))} placeholder="Only if different from your @handle" />
              <span className="block text-[11px] leading-5 text-slate-500">Your @handle is the main public name. Stage name is a fallback when no handle is set.</span>
            </label>
            <label className="space-y-1.5 sm:col-span-2">
              <span className={fieldLabel()}>Headline</span>
              <input className={fieldClass()} maxLength={140} value={form.headline} onChange={(event) => setForm((current) => ({ ...current, headline: event.target.value }))} placeholder="What should someone know about you first?" />
            </label>
            <label className="space-y-1.5 sm:col-span-2">
              <span className={fieldLabel()}>Specialties — separate with commas, up to 8</span>
              <input className={fieldClass()} value={form.specialties} onChange={(event) => setForm((current) => ({ ...current, specialties: event.target.value }))} placeholder="Open format, beatbox, wedding MC, late-night sets" />
              {specialties.length ? (
                <span className="flex flex-wrap gap-1.5 pt-1">
                  {specialties.map((specialty) => <span key={specialty} className="rounded-full bg-white/5 px-2.5 py-1 text-[10px] font-bold text-slate-300">{specialty}</span>)}
                </span>
              ) : null}
            </label>
            <label className="space-y-1.5 sm:col-span-2">
              <span className={fieldLabel()}>About / vision</span>
              <textarea className={`${fieldClass()} min-h-32 resize-y leading-6`} maxLength={1200} value={form.bio} onChange={(event) => setForm((current) => ({ ...current, bio: event.target.value }))} placeholder="Tell people what you create, who you serve, and what you are building." />
            </label>
            <label className="space-y-1.5">
              <span className={fieldLabel()}>City</span>
              <input className={fieldClass()} maxLength={80} value={form.city} onChange={(event) => setForm((current) => ({ ...current, city: event.target.value }))} placeholder="Pensacola, FL" />
            </label>
            <label className="space-y-1.5">
              <span className={fieldLabel()}>Profile image URL</span>
              <input type="url" className={fieldClass()} value={form.avatarUrl} onChange={(event) => setForm((current) => ({ ...current, avatarUrl: event.target.value }))} placeholder="https://..." />
            </label>
          </div>

          <div>
            <h4 className="text-xs font-black uppercase tracking-[0.2em] text-white">Booking and contact</h4>
            <p className="mt-1 text-[11px] leading-5 text-slate-500">Only add contact information you want visible to everyone.</p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <label className="space-y-1.5">
                <span className={fieldLabel()}>Public booking email</span>
                <input type="email" className={fieldClass()} value={form.bookingEmail} onChange={(event) => setForm((current) => ({ ...current, bookingEmail: event.target.value }))} placeholder="booking@example.com" />
              </label>
              <label className="space-y-1.5">
                <span className={fieldLabel()}>Public booking phone</span>
                <input type="tel" className={fieldClass()} value={form.bookingPhone} onChange={(event) => setForm((current) => ({ ...current, bookingPhone: event.target.value }))} placeholder="(555) 555-5555" />
              </label>
            </div>
          </div>

          <div>
            <h4 className="text-xs font-black uppercase tracking-[0.2em] text-white">Socials and website</h4>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              {SOCIAL_FIELDS.map(([key, label, placeholder]) => (
                <label key={key} className="space-y-1.5">
                  <span className={fieldLabel()}>{label}</span>
                  <input type="url" className={fieldClass()} value={form[key]} onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))} placeholder={placeholder} />
                </label>
              ))}
            </div>
          </div>

          <div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h4 className="inline-flex items-center gap-2 text-xs font-black uppercase tracking-[0.2em] text-white"><Link2 className="h-4 w-4 text-cyan-300" /> Featured links</h4>
                <p className="mt-1 text-[11px] leading-5 text-slate-500">Brands, events, booking pages, press, communities, shops, or anything else. Media is optional.</p>
              </div>
              <button type="button" onClick={addLink} disabled={form.links.length >= 12} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-cyan-300/25 bg-cyan-400/10 px-4 py-2 text-xs font-black text-cyan-100 transition hover:bg-cyan-400/15 disabled:cursor-not-allowed disabled:opacity-50">
                <Plus className="h-4 w-4" /> Add link
              </button>
            </div>

            <div className="mt-3 space-y-3">
              {form.links.length === 0 ? (
                <button type="button" onClick={addLink} className="min-h-20 w-full rounded-2xl border border-dashed border-white/10 bg-slate-950/40 px-4 py-5 text-sm font-bold text-slate-400 transition hover:border-cyan-300/30 hover:text-white">
                  Add your first featured link
                </button>
              ) : form.links.map((link, index) => (
                <div key={link.key} className="rounded-2xl border border-white/10 bg-slate-950/65 p-3 sm:p-4">
                  <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
                    <label className="space-y-1.5">
                      <span className={fieldLabel()}>Link label</span>
                      <input className={fieldClass()} maxLength={80} required value={link.label} onChange={(event) => updateLink(index, { label: event.target.value })} placeholder="Book me for an event" />
                    </label>
                    <label className="space-y-1.5">
                      <span className={fieldLabel()}>Type</span>
                      <select className={fieldClass()} value={link.kind} onChange={(event) => updateLink(index, { kind: event.target.value })}>
                        {LINK_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
                      </select>
                    </label>
                    <label className="space-y-1.5 sm:col-span-2">
                      <span className={fieldLabel()}>URL</span>
                      <input type="url" className={fieldClass()} required value={link.url} onChange={(event) => updateLink(index, { url: event.target.value })} placeholder="https://..." />
                    </label>
                    <label className="space-y-1.5 sm:col-span-2">
                      <span className={fieldLabel()}>Short description — optional</span>
                      <input className={fieldClass()} maxLength={180} value={link.description} onChange={(event) => updateLink(index, { description: event.target.value })} placeholder="Tell visitors why this link matters." />
                    </label>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                    <label className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/10 px-3 py-2 text-xs font-bold text-slate-300">
                      <input type="checkbox" checked={link.isActive} onChange={(event) => updateLink(index, { isActive: event.target.checked })} className="h-4 w-4" />
                      Show publicly
                    </label>
                    <div className="flex gap-2">
                      <button type="button" aria-label="Move link up" onClick={() => moveLink(index, -1)} disabled={index === 0} className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/10 text-slate-300 hover:text-white disabled:opacity-30"><ArrowUp className="h-4 w-4" /></button>
                      <button type="button" aria-label="Move link down" onClick={() => moveLink(index, 1)} disabled={index === form.links.length - 1} className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/10 text-slate-300 hover:text-white disabled:opacity-30"><ArrowDown className="h-4 w-4" /></button>
                      <button type="button" aria-label="Remove link" onClick={() => removeLink(index)} className="flex h-11 w-11 items-center justify-center rounded-xl border border-rose-500/20 bg-rose-500/10 text-rose-200 hover:bg-rose-500/15"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </fieldset>

        {message ? (
          <div className={`rounded-xl border px-4 py-3 text-xs ${status === 'error' ? 'border-rose-500/25 bg-rose-500/10 text-rose-100' : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-100'}`}>
            {message}
          </div>
        ) : null}

        <button type="submit" disabled={previewMode || status === 'loading' || status === 'saving'} className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 to-fuchsia-600 px-5 py-3 text-sm font-black text-white shadow-lg shadow-fuchsia-950/30 transition hover:from-cyan-400 hover:to-fuchsia-500 disabled:cursor-not-allowed disabled:opacity-60">
          <Save className="h-4 w-4" />
          {status === 'loading' ? 'Loading page...' : status === 'saving' ? 'Saving page...' : 'Save public page'}
        </button>
      </form>
    </section>
  );
}
