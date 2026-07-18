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

type LinkDraft = {
  key: string;
  label: string;
  description: string;
  url: string;
  kind: string;
  isActive: boolean;
};

type ProfileForm = {
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
  const [partner, setPartner] = useState<{ active: boolean; termsVersion: string | null }>({ active: false, termsVersion: null });

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
          active: profile.partner?.active === true,
          termsVersion: text(profile.partner?.termsVersion) || null
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

  return (
    <section data-sway-public-profile-editor="true" className="mx-auto w-full max-w-3xl overflow-hidden rounded-2xl border border-cyan-300/20 bg-slate-900/80 shadow-xl shadow-cyan-950/10">
      <div className="border-b border-white/10 bg-gradient-to-r from-cyan-500/10 via-fuchsia-500/10 to-transparent p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[10px] font-black uppercase tracking-[0.28em] text-cyan-300">Your public Sway page</p>
              {partner.active ? (
                <span className="inline-flex min-h-7 items-center gap-1.5 rounded-full border border-amber-300/25 bg-amber-300/10 px-2.5 py-1 text-[9px] font-black uppercase tracking-[0.18em] text-amber-100">
                  <BadgeCheck className="h-3.5 w-3.5" /> Brand Partner
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

      <form className="space-y-6 p-4 sm:p-6" onSubmit={handleSubmit}>
        <fieldset disabled={previewMode || status === 'loading' || status === 'saving'} className="space-y-6 disabled:opacity-70">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1.5 sm:col-span-2">
              <span className={fieldLabel()}>Headline</span>
              <input className={fieldClass()} maxLength={140} value={form.headline} onChange={(event) => setForm((current) => ({ ...current, headline: event.target.value }))} placeholder="What should someone know about you first?" />
            </label>
            <label className="space-y-1.5 sm:col-span-2">
              <span className={fieldLabel()}>Specialties — separate with commas, up to 8</span>
              <input className={fieldClass()} value={form.specialties} onChange={(event) => setForm((current) => ({ ...current, specialties: event.target.value }))} placeholder="DJ, Beatbox, Comedy, MC, Event host" />
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
