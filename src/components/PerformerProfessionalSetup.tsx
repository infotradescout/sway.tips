import { useEffect, useMemo, useRef, useState } from 'react';
import {
  PERFORMER_CAPABILITY_OPTIONS,
  PERFORMER_EARNING_MODE_OPTIONS,
  PROFESSIONAL_IDENTITY_OPTIONS,
  professionalIdentityLabel,
  type PerformerCapability,
  type PerformerEarningMode,
  type ProfessionalIdentityKind
} from '../talent-capability-catalog';

type IdentitySelection = {
  kind: ProfessionalIdentityKind;
  customLabel: string | null;
};

type CapabilityStatus = {
  capability: PerformerCapability;
  requested: boolean;
  decision: 'granted' | 'revoked' | 'expired' | 'denied' | null;
  grantCurrent: boolean;
  reason: string | null;
  expiresAt: string | null;
};

type SetupState = {
  primaryIdentity: IdentitySelection | null;
  secondaryIdentities: IdentitySelection[];
  earningModes: PerformerEarningMode[];
  desiredCapabilities: PerformerCapability[];
  capabilityStatuses: CapabilityStatus[];
  publication: {
    visibilityState: 'draft' | 'unlisted' | 'public';
    explicitlyPublic: boolean;
    managedSeparately: true;
  };
};

function checkboxClass(selected: boolean) {
  return `flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border px-3 py-3 transition ${selected
    ? 'border-cyan-300/35 bg-cyan-300/10 text-white'
    : 'border-white/10 bg-slate-950/55 text-slate-300 hover:border-white/20'}`;
}

function statusLabel(status: CapabilityStatus | undefined) {
  if (status?.decision === 'granted') return 'Server grant recorded';
  if (status?.decision === 'denied') return 'Not approved';
  if (status?.decision === 'revoked') return 'Grant revoked';
  if (status?.decision === 'expired') return 'Grant expired';
  if (status?.requested) return 'Requested';
  return 'Not requested';
}

export default function PerformerProfessionalSetup({ previewMode = false }: { previewMode?: boolean }) {
  const [loading, setLoading] = useState(!previewMode);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(previewMode ? 'Professional setup is unavailable in preview mode.' : '');
  const [error, setError] = useState(false);
  const [primaryKind, setPrimaryKind] = useState<ProfessionalIdentityKind | ''>('');
  const [primaryCustomLabel, setPrimaryCustomLabel] = useState('');
  const [secondarySelections, setSecondarySelections] = useState<Partial<Record<ProfessionalIdentityKind, string>>>({});
  const [earningModes, setEarningModes] = useState<PerformerEarningMode[]>([]);
  const [desiredCapabilities, setDesiredCapabilities] = useState<PerformerCapability[]>([]);
  const [capabilityStatuses, setCapabilityStatuses] = useState<CapabilityStatus[]>([]);
  const [publication, setPublication] = useState<SetupState['publication']>({
    visibilityState: 'draft',
    explicitlyPublic: false,
    managedSeparately: true
  });
  const pendingMutation = useRef<{ fingerprint: string; id: string } | null>(null);

  const applyState = (setup: SetupState) => {
    setPrimaryKind(setup.primaryIdentity?.kind ?? '');
    setPrimaryCustomLabel(setup.primaryIdentity?.customLabel ?? '');
    setSecondarySelections(Object.fromEntries(setup.secondaryIdentities.map((identity) => [identity.kind, identity.customLabel ?? ''])));
    setEarningModes(setup.earningModes);
    setDesiredCapabilities(setup.desiredCapabilities);
    setCapabilityStatuses(setup.capabilityStatuses);
    setPublication(setup.publication);
  };

  useEffect(() => {
    if (previewMode) return;
    let active = true;
    const controller = new AbortController();
    void fetch('/api/talent/professional-setup', {
      cache: 'no-store',
      credentials: 'include',
      signal: controller.signal
    }).then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.setup) throw new Error(body.error ?? 'Unable to load professional setup.');
      if (active) applyState(body.setup as SetupState);
    }).catch((loadError) => {
      if (!active || (loadError instanceof DOMException && loadError.name === 'AbortError')) return;
      setError(true);
      setMessage(loadError instanceof Error ? loadError.message : 'Unable to load professional setup.');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [previewMode]);

  const secondaryIdentities = useMemo(() => (Object.entries(secondarySelections) as Array<[ProfessionalIdentityKind, string]>)
    .map(([kind, customLabel]) => ({
      kind: kind as ProfessionalIdentityKind,
      customLabel: kind === 'other' ? customLabel?.trim() || null : null
    })), [secondarySelections]);

  const capabilityStatusById = useMemo(() => new Map(
    capabilityStatuses.map((status) => [status.capability, status])
  ), [capabilityStatuses]);

  const toggleSecondary = (kind: ProfessionalIdentityKind) => {
    setSecondarySelections((current) => {
      const next = { ...current };
      if (Object.prototype.hasOwnProperty.call(next, kind)) delete next[kind];
      else next[kind] = '';
      return next;
    });
  };

  const toggleValue = <T extends string>(values: T[], value: T, setter: (next: T[]) => void) => {
    setter(values.includes(value) ? values.filter((candidate) => candidate !== value) : [...values, value]);
  };

  const save = async () => {
    if (previewMode || loading || saving) return;
    if (!primaryKind) {
      setError(true);
      setMessage('Choose your primary professional identity.');
      return;
    }
    if (primaryKind === 'other' && !primaryCustomLabel.trim()) {
      setError(true);
      setMessage('Name your primary professional identity.');
      return;
    }
    if (secondarySelections.other !== undefined && !secondarySelections.other.trim()) {
      setError(true);
      setMessage('Name the secondary identity marked Other.');
      return;
    }

    const payloadWithoutId = {
      primaryIdentity: {
        kind: primaryKind,
        customLabel: primaryKind === 'other' ? primaryCustomLabel.trim() : null
      },
      secondaryIdentities,
      earningModes,
      desiredCapabilities
    };
    const fingerprint = JSON.stringify(payloadWithoutId);
    if (!pendingMutation.current || pendingMutation.current.fingerprint !== fingerprint) {
      pendingMutation.current = { fingerprint, id: crypto.randomUUID() };
    }

    setSaving(true);
    setError(false);
    setMessage('');
    try {
      const response = await fetch('/api/talent/professional-setup', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientMutationId: pendingMutation.current.id,
          ...payloadWithoutId
        })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.state) throw new Error(body.error ?? 'Unable to save professional setup.');
      applyState(body.state as SetupState);
      pendingMutation.current = null;
      setMessage(body.replayed ? 'Professional setup was already saved.' : body.changed ? 'Professional setup saved.' : 'Professional setup is already current.');
    } catch (saveError) {
      setError(true);
      setMessage(saveError instanceof Error ? saveError.message : 'Unable to save professional setup.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section id="sway-professional-setup" className="mx-auto w-full max-w-3xl scroll-mt-24 overflow-hidden rounded-2xl border border-violet-300/20 bg-slate-900/80 shadow-xl">
      <div className="border-b border-white/10 bg-gradient-to-r from-violet-500/10 via-cyan-500/10 to-transparent p-5 sm:p-6">
        <p className="text-[10px] font-black uppercase tracking-[0.28em] text-violet-300">Professional setup</p>
        <h2 className="mt-2 font-display text-xl font-black text-white">Tell Sway what you do and what you want to use</h2>
        <p className="mt-2 max-w-2xl text-xs leading-5 text-slate-400">
          Your identity and earning choices describe you. Capability requests ask for tools; they never grant money, ticketing, venue, catalog, payout, or administrative authority.
        </p>
      </div>

      <div className="space-y-7 p-4 sm:p-6">
        <fieldset disabled={previewMode || loading || saving} className="space-y-7 disabled:opacity-60">
          <div>
            <label className="block text-[10px] font-black uppercase tracking-[0.2em] text-slate-400" htmlFor="professional-primary-identity">Primary identity</label>
            <select
              id="professional-primary-identity"
              value={primaryKind}
              onChange={(event) => {
                const nextKind = event.target.value as ProfessionalIdentityKind | '';
                setPrimaryKind(nextKind);
                if (nextKind) setSecondarySelections((current) => {
                  const next = { ...current };
                  delete next[nextKind];
                  return next;
                });
              }}
              className="mt-2 min-h-12 w-full rounded-xl border border-white/10 bg-slate-950 px-3.5 py-3 text-sm font-semibold text-white outline-none focus:border-violet-300"
            >
              <option value="">Choose what best describes your work</option>
              {PROFESSIONAL_IDENTITY_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
            {primaryKind === 'other' ? (
              <input
                value={primaryCustomLabel}
                onChange={(event) => setPrimaryCustomLabel(event.target.value)}
                maxLength={80}
                placeholder="Describe your professional identity"
                className="mt-3 min-h-12 w-full rounded-xl border border-white/10 bg-slate-950 px-3.5 py-3 text-sm font-semibold text-white outline-none focus:border-violet-300"
              />
            ) : null}
          </div>

          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">Other identities — optional</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {PROFESSIONAL_IDENTITY_OPTIONS.filter((option) => option.id !== primaryKind).map((option) => {
                const selected = Object.prototype.hasOwnProperty.call(secondarySelections, option.id);
                return (
                  <label key={option.id} className={checkboxClass(selected)}>
                    <input type="checkbox" checked={selected} onChange={() => toggleSecondary(option.id)} className="mt-0.5 h-4 w-4" />
                    <span className="text-sm font-bold">{option.label}</span>
                  </label>
                );
              })}
            </div>
            {secondarySelections.other !== undefined ? (
              <input
                value={secondarySelections.other}
                onChange={(event) => setSecondarySelections((current) => ({ ...current, other: event.target.value }))}
                maxLength={80}
                placeholder="Describe the additional professional identity"
                className="mt-3 min-h-12 w-full rounded-xl border border-white/10 bg-slate-950 px-3.5 py-3 text-sm font-semibold text-white outline-none focus:border-violet-300"
              />
            ) : null}
          </div>

          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">How you earn or want to earn</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {PERFORMER_EARNING_MODE_OPTIONS.map((option) => {
                const selected = earningModes.includes(option.id);
                return (
                  <label key={option.id} className={checkboxClass(selected)}>
                    <input type="checkbox" checked={selected} onChange={() => toggleValue(earningModes, option.id, setEarningModes)} className="mt-0.5 h-4 w-4" />
                    <span className="text-sm font-bold">{option.label}</span>
                  </label>
                );
              })}
            </div>
          </div>

          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">Tools you want to use</p>
            <p className="mt-2 text-xs leading-5 text-amber-100/80">Saving a request is not approval and does not activate a paid or regulated feature.</p>
            <p className="mt-1 text-[11px] leading-5 text-slate-500">A recorded server grant is not final action permission; exact subject authority and action-specific gates still apply.</p>
            <div className="mt-3 space-y-2">
              {PERFORMER_CAPABILITY_OPTIONS.map((option) => {
                const selected = desiredCapabilities.includes(option.id);
                const status = capabilityStatusById.get(option.id);
                return (
                  <label key={option.id} className={checkboxClass(selected)}>
                    <input type="checkbox" checked={selected} onChange={() => toggleValue(desiredCapabilities, option.id, setDesiredCapabilities)} className="mt-0.5 h-4 w-4" />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm font-bold">{option.label}</span>
                        <span className="rounded-full border border-white/10 bg-slate-950 px-2 py-1 text-[9px] font-black uppercase tracking-wider text-slate-400">{statusLabel(status)}</span>
                      </span>
                      <span className="mt-1 block text-[11px] leading-5 text-slate-400">{option.gateNote}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        </fieldset>

        <div className="rounded-2xl border border-cyan-300/15 bg-cyan-300/[0.04] p-4">
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-cyan-200">Publication stays separate</p>
          <p className="mt-2 text-sm font-bold text-white">Current page setting: {publication.visibilityState}</p>
          <p className="mt-1 text-xs leading-5 text-slate-400">Saving this setup never publishes your page. Use the separate Publication control below to choose Draft, Unlisted, or Public.</p>
          <a href="#performer-visibility-heading" className="mt-3 inline-flex min-h-10 items-center rounded-full border border-cyan-300/20 px-4 text-xs font-black text-cyan-100">Go to publication control</a>
        </div>

        {primaryKind ? (
          <p className="text-xs text-slate-500">Primary identity preview: {professionalIdentityLabel(primaryKind, primaryCustomLabel)}</p>
        ) : null}
        {message ? <p role="status" className={`rounded-xl border px-4 py-3 text-xs ${error ? 'border-rose-500/25 bg-rose-500/10 text-rose-100' : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-100'}`}>{message}</p> : null}
        <button
          type="button"
          onClick={() => void save()}
          disabled={previewMode || loading || saving}
          className="min-h-12 w-full rounded-xl bg-gradient-to-r from-violet-500 to-cyan-500 px-5 py-3 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? 'Loading professional setup...' : saving ? 'Saving professional setup...' : 'Save professional setup'}
        </button>
      </div>
    </section>
  );
}
