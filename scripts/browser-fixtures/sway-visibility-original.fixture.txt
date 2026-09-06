import { useEffect, useState } from 'react';
import type { PerformerVisibilityState } from '../server/public-profile';

const VISIBILITY_OPTIONS: ReadonlyArray<{
  value: PerformerVisibilityState;
  label: string;
  description: string;
}> = [
  {
    value: 'draft',
    label: 'Draft',
    description: 'No public profile route, search result, or sitemap listing.'
  },
  {
    value: 'unlisted',
    label: 'Unlisted',
    description: 'A direct link can work, but search and sitemap discovery stay off.'
  },
  {
    value: 'public',
    label: 'Public',
    description: 'Eligible for public search, sharing, and sitemap discovery.'
  }
];

function normalizeVisibilityState(value: unknown): PerformerVisibilityState {
  if (value === 'unlisted' || value === 'public') return value;
  return 'draft';
}

export function PerformerVisibilityControl({ previewMode = false }: { previewMode?: boolean }) {
  const [visibilityState, setVisibilityState] = useState<PerformerVisibilityState>('draft');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (previewMode) {
      setLoading(false);
      setMessage('Visibility controls are unavailable in preview mode.');
      return;
    }

    let active = true;
    void fetch('/api/talent/profile/public', { credentials: 'include' })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error ?? 'Unable to load visibility.');
        if (active) setVisibilityState(normalizeVisibilityState(body.profile?.visibilityState));
      })
      .catch((error) => {
        if (active) setMessage(error instanceof Error ? error.message : 'Unable to load visibility.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [previewMode]);

  async function saveVisibility() {
    if (previewMode) return;
    setSaving(true);
    setMessage('');
    try {
      const response = await fetch('/api/talent/profile/visibility', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visibilityState })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? 'Unable to update visibility.');
      setVisibilityState(normalizeVisibilityState(body.visibilityState));
      setMessage('Visibility saved.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to update visibility.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="border-b border-white/10 bg-slate-950/40 p-4 sm:p-6" aria-labelledby="performer-visibility-heading">
      <div className="mb-4">
        <p className="text-[10px] font-black uppercase tracking-[0.28em] text-cyan-300">Publication control</p>
        <h2 id="performer-visibility-heading" className="mt-2 font-display text-lg font-black text-white">Who can find your performer page?</h2>
        <p className="mt-2 max-w-xl text-xs leading-5 text-slate-400">This owner-only setting changes public reach. It does not change your profile content.</p>
      </div>

      <div className="grid gap-3" role="radiogroup" aria-label="Performer page visibility">
        {VISIBILITY_OPTIONS.map((option) => (
          <label
            key={option.value}
            className={`cursor-pointer rounded-xl border p-4 transition ${visibilityState === option.value ? 'border-cyan-300/40 bg-cyan-300/10' : 'border-white/10 bg-white/[0.03]'}`}
          >
            <span className="flex items-start gap-3">
              <input
                type="radio"
                name="performer-visibility"
                value={option.value}
                checked={visibilityState === option.value}
                disabled={previewMode || loading || saving}
                onChange={() => setVisibilityState(option.value)}
                className="mt-1"
              />
              <span>
                <span className="block text-sm font-semibold text-white">{option.label}</span>
                <span className="mt-1 block text-sm text-slate-400">{option.description}</span>
              </span>
            </span>
          </label>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void saveVisibility()}
          disabled={previewMode || loading || saving}
          className="rounded-full bg-cyan-300 px-4 py-2 text-sm font-black text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save visibility'}
        </button>
        {message ? <p className="text-sm text-slate-400" role="status">{message}</p> : null}
      </div>
    </section>
  );
}
