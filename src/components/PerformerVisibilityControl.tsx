import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PerformerVisibilityState } from '../server/public-profile';
import { requestPerformerVisibility, VisibilityRequestError } from '../performer-visibility-request';

const VISIBILITY_OPTIONS: ReadonlyArray<{
  value: PerformerVisibilityState;
  label: string;
  description: string;
}> = [
  { value: 'draft', label: 'Draft', description: 'No public profile route, search result, or sitemap listing.' },
  { value: 'unlisted', label: 'Unlisted', description: 'A direct link can work, but search and sitemap discovery stay off.' },
  { value: 'public', label: 'Public', description: 'Eligible for public search, sharing, and sitemap discovery.' }
];

type Scope = { active: boolean; busy: boolean; controller: AbortController | null };
type Phase = 'loading' | 'ready' | 'saving' | 'check';

export function PerformerVisibilityControl({ previewMode = false }: { previewMode?: boolean }) {
  // An old live response must never change the preview or a later live instance.
  return <ScopedVisibilityControl key={previewMode ? 'preview' : 'live'} previewMode={previewMode} />;
}

function ScopedVisibilityControl({ previewMode }: { previewMode: boolean }) {
  const [visibilityState, setVisibilityState] = useState<PerformerVisibilityState | null>(null);
  const [confirmedState, setConfirmedState] = useState<PerformerVisibilityState | null>(null);
  const [phase, setPhase] = useState<Phase>(previewMode ? 'check' : 'loading');
  const [message, setMessage] = useState(previewMode ? 'Visibility controls are unavailable in preview mode.' : '');
  const current = useRef<Scope | null>(null);
  useLayoutEffect(() => {
    const scope: Scope = { active: true, busy: false, controller: null };
    current.current = scope;
    return () => {
      scope.active = false;
      scope.controller?.abort();
      if (current.current === scope) current.current = null;
    };
  }, []);
  const isCurrent = (scope: Scope) => scope.active && current.current === scope;

  async function run(value?: PerformerVisibilityState) {
    const scope = current.current;
    if (previewMode || !scope || !isCurrent(scope) || scope.busy) return;
    if (value !== undefined && (phase !== 'ready' || confirmedState === null || value === confirmedState)) return;
    scope.busy = true;
    const controller = new AbortController();
    scope.controller = controller;
    setPhase(value === undefined ? 'loading' : 'saving');
    setMessage('');
    try {
      const saved = await requestPerformerVisibility({ signal: controller.signal, value });
      if (!isCurrent(scope) || scope.controller !== controller) return;
      setConfirmedState(saved);
      setVisibilityState(saved);
      setPhase('ready');
      setMessage(value === undefined ? 'Saved visibility checked.' : 'Visibility saved.');
    } catch (error) {
      if (!isCurrent(scope) || scope.controller !== controller) return;
      if (error instanceof VisibilityRequestError && error.kind === 'access') {
        setConfirmedState(null);
        setVisibilityState(null);
      }
      setPhase('check');
      setMessage(error instanceof VisibilityRequestError ? error.message : 'Visibility could not be confirmed. Check the saved setting before trying again.');
    } finally {
      if (isCurrent(scope) && scope.controller === controller) {
        scope.busy = false;
        scope.controller = null;
      }
    }
  }

  useEffect(() => { if (!previewMode) void run(); }, [previewMode]);
  const busy = phase === 'loading' || phase === 'saving';
  const ready = !previewMode && phase === 'ready' && confirmedState !== null;
  const savedLabel = VISIBILITY_OPTIONS.find(option => option.value === confirmedState)?.label;

  return (
    <section className="min-w-0 border-b border-white/10 bg-slate-950/40 p-4 sm:p-6" aria-labelledby="performer-visibility-heading" data-sway-visibility-control="true">
      <div className="mb-4">
        <p className="text-[10px] font-black uppercase tracking-[0.28em] text-cyan-300">Publication control</p>
        <h2 id="performer-visibility-heading" className="mt-2 font-display text-lg font-black text-white">Who can find your performer page?</h2>
        <p className="mt-2 max-w-xl text-xs leading-5 text-slate-400">This owner-only setting changes public reach. It does not change your profile content.</p>
        {!previewMode ? <p className="mt-2 text-sm text-slate-300" data-sway-saved-visibility="true">{savedLabel
          ? `${ready ? 'Saved visibility' : 'Last confirmed visibility'}: ${savedLabel}`
          : 'Saved visibility has not been confirmed.'}</p> : null}
      </div>
      <div className="grid gap-3" role="radiogroup" aria-label="Performer page visibility">
        {VISIBILITY_OPTIONS.map(option => (
          <label key={option.value} className={`min-w-0 rounded-xl border p-4 transition ${visibilityState === option.value ? 'border-cyan-300/40 bg-cyan-300/10' : 'border-white/10 bg-white/[0.03]'}`}>
            <span className="flex items-start gap-3">
              <input type="radio" name="performer-visibility" value={option.value} checked={visibilityState === option.value}
                disabled={!ready} onChange={() => { setVisibilityState(option.value); setMessage(''); }} className="mt-1" />
              <span className="min-w-0 [overflow-wrap:anywhere]"><span className="block text-sm font-semibold text-white">{option.label}</span><span className="mt-1 block text-sm text-slate-400">{option.description}</span></span>
            </span>
          </label>
        ))}
      </div>
      <div className="mt-4 flex min-w-0 flex-wrap items-center gap-3">
        <button type="button" onClick={() => { if (visibilityState !== null) void run(visibilityState); }}
          disabled={!ready || visibilityState === null || visibilityState === confirmedState}
          className="min-h-11 rounded-full bg-cyan-300 px-4 py-2 text-sm font-black text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-50">
          {phase === 'saving' ? 'Saving...' : 'Save visibility'}
        </button>
        {!previewMode && !busy ? <button type="button" onClick={() => void run()}
          className="min-h-11 rounded-full border border-white/20 px-4 py-2 text-sm font-semibold text-white">Check saved visibility</button> : null}
        {!previewMode && busy ? <button type="button" onClick={() => current.current?.controller?.abort()}
          className="min-h-11 rounded-full border border-white/20 px-4 py-2 text-sm font-semibold text-white">Stop waiting</button> : null}
      </div>
      <p className="mt-3 min-h-5 text-sm text-slate-300 [overflow-wrap:anywhere]" role="status" aria-live="polite">{message || (phase === 'loading' ? 'Checking saved visibility…' : '')}</p>
      {!previewMode && phase === 'check' ? <p className="mt-2 text-xs leading-5 text-slate-400">Checking only reads the saved setting. It does not publish your page or repeat the last change.</p> : null}
    </section>
  );
}
