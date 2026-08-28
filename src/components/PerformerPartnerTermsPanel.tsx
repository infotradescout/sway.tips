import { BadgeCheck, RefreshCw, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';

type PartnerEntitlementState = {
  granted: boolean;
  active: boolean;
  accepted: boolean;
  suspended: boolean;
  acceptanceRequired: boolean;
  termsVersion: string | null;
  termsHash: string | null;
  termsText: string | null;
  acceptedAt: string | null;
  statusReason: string | null;
};

type LoadState = 'loading' | 'ready' | 'error';
type AcceptanceState = 'idle' | 'submitting' | 'success' | 'error';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringOrNull(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function exactTextOrNull(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function responseError(data: unknown, fallback: string) {
  return isRecord(data) && typeof data.error === 'string' && data.error.trim()
    ? data.error
    : fallback;
}

function parsePartnerState(value: unknown): PartnerEntitlementState {
  const partner = isRecord(value) ? value : {};
  return {
    granted: partner.granted === true,
    active: partner.active === true,
    accepted: partner.accepted === true,
    suspended: partner.suspended === true,
    acceptanceRequired: partner.acceptanceRequired === true,
    termsVersion: stringOrNull(partner.termsVersion),
    termsHash: stringOrNull(partner.termsHash)?.toLowerCase() ?? null,
    termsText: exactTextOrNull(partner.termsText),
    acceptedAt: stringOrNull(partner.acceptedAt),
    statusReason: stringOrNull(partner.statusReason)
  };
}

function formatAcceptedAt(value: string | null) {
  if (!value) return null;
  const acceptedAt = new Date(value);
  return Number.isNaN(acceptedAt.getTime()) ? null : acceptedAt.toLocaleString();
}

export default function PerformerPartnerTermsPanel({ previewMode = false }: { previewMode?: boolean }) {
  const [partner, setPartner] = useState<PartnerEntitlementState | null>(null);
  const [loadState, setLoadState] = useState<LoadState>(previewMode ? 'ready' : 'loading');
  const [loadMessage, setLoadMessage] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [acceptanceConfirmed, setAcceptanceConfirmed] = useState(false);
  const [acceptanceState, setAcceptanceState] = useState<AcceptanceState>('idle');
  const [acceptanceMessage, setAcceptanceMessage] = useState<string | null>(null);
  const [requiresReload, setRequiresReload] = useState(false);

  useEffect(() => {
    if (previewMode) return;
    let cancelled = false;
    const controller = new AbortController();

    const loadPartner = async () => {
      setLoadState('loading');
      setLoadMessage(null);
      try {
        const response = await fetch('/api/talent/partner/terms', {
          cache: 'no-store',
          signal: controller.signal
        });
        const data: unknown = await response.json().catch(() => null);
        if (cancelled) return;
        if (!response.ok || !isRecord(data) || !isRecord(data.partner)) {
          throw new Error(responseError(data, 'Unable to load Brand Partner terms.'));
        }

        setPartner(parsePartnerState(data.partner));
        setAcceptanceConfirmed(false);
        setAcceptanceState('idle');
        setAcceptanceMessage(null);
        setRequiresReload(false);
        setLoadState('ready');
      } catch (error) {
        if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) return;
        setLoadState('error');
        setLoadMessage(error instanceof Error ? error.message : 'Unable to load Brand Partner terms.');
      }
    };

    void loadPartner();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [previewMode, reloadKey]);

  const reloadTerms = () => setReloadKey((current) => current + 1);

  const handleAccept = async () => {
    if (
      previewMode
      || acceptanceState === 'submitting'
      || !acceptanceConfirmed
      || requiresReload
      || !partner?.termsVersion
      || !partner.termsHash
    ) return;

    const termsVersion = partner.termsVersion;
    const termsHash = partner.termsHash.toLowerCase();
    setAcceptanceState('submitting');
    setAcceptanceMessage(null);

    try {
      const response = await fetch('/api/talent/partner/terms/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accepted: true,
          termsVersion,
          termsHash
        })
      });
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 409) {
          setAcceptanceConfirmed(false);
          setRequiresReload(true);
        }
        throw new Error(responseError(data, 'Unable to record Brand Partner acceptance.'));
      }

      const receipt = isRecord(data) && isRecord(data.receipt) ? data.receipt : null;
      const receiptVersion = stringOrNull(receipt?.termsVersion);
      const receiptHash = stringOrNull(receipt?.termsHash)?.toLowerCase() ?? null;
      if (!isRecord(data) || data.success !== true || receiptVersion !== termsVersion || receiptHash !== termsHash) {
        setAcceptanceConfirmed(false);
        setRequiresReload(true);
        throw new Error('Sway returned a mismatched acceptance receipt. Reload the exact terms before trying again.');
      }

      const acceptedAt = stringOrNull(receipt?.acceptedAt);
      setPartner((current) => current ? {
        ...current,
        active: !current.suspended,
        accepted: true,
        acceptanceRequired: false,
        acceptedAt
      } : current);
      setAcceptanceConfirmed(false);
      setAcceptanceState('success');
      setAcceptanceMessage(`Brand Partner acceptance confirmed for version ${termsVersion} and SHA-256 ${termsHash}.`);
    } catch (error) {
      setAcceptanceState('error');
      setAcceptanceMessage(error instanceof Error ? error.message : 'Unable to record Brand Partner acceptance.');
    }
  };

  if (previewMode) return null;

  if (loadState === 'loading') {
    return (
      <section
        data-sway-partner-terms-panel="true"
        aria-busy="true"
        aria-labelledby="sway-partner-terms-heading"
        className="mt-5 rounded-2xl border border-amber-300/15 bg-slate-950/70 p-4"
      >
        <p className="text-[10px] font-black uppercase tracking-[0.24em] text-amber-200">Brand Partner</p>
        <h3 id="sway-partner-terms-heading" className="mt-1 text-sm font-black text-white">Loading partner terms...</h3>
      </section>
    );
  }

  if (loadState === 'error') {
    return (
      <section
        data-sway-partner-terms-panel="true"
        aria-labelledby="sway-partner-terms-heading"
        className="mt-5 rounded-2xl border border-rose-500/25 bg-rose-500/10 p-4"
      >
        <p className="text-[10px] font-black uppercase tracking-[0.24em] text-rose-200">Brand Partner</p>
        <h3 id="sway-partner-terms-heading" className="mt-1 text-sm font-black text-white">Partner terms unavailable</h3>
        <p role="alert" className="mt-2 text-xs leading-5 text-rose-100">{loadMessage}</p>
        <button
          type="button"
          onClick={reloadTerms}
          className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-xl border border-rose-300/25 bg-slate-950 px-4 py-2 text-xs font-black text-rose-100"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" /> Retry
        </button>
      </section>
    );
  }

  if (!partner?.granted) return null;

  const exactTermsAvailable = Boolean(partner.termsVersion && partner.termsHash && partner.termsText);
  const acceptedAtLabel = formatAcceptedAt(partner.acceptedAt);
  const statusLabel = partner.suspended
    ? 'Brand Partner suspended'
    : partner.active
      ? 'Active Brand Partner'
      : partner.acceptanceRequired
        ? 'Owner acceptance required'
        : partner.accepted
          ? 'Terms accepted'
          : 'Brand Partner grant';

  return (
    <section
      data-sway-partner-terms-panel="true"
      aria-labelledby="sway-partner-terms-heading"
      className="mt-5 overflow-hidden rounded-2xl border border-amber-300/20 bg-slate-950/70"
    >
      <div className="flex items-start gap-3 p-4 sm:p-5">
        <div className="shrink-0 rounded-xl border border-amber-300/20 bg-amber-300/10 p-2 text-amber-200">
          {partner.active ? <BadgeCheck className="h-4 w-4" aria-hidden="true" /> : <ShieldCheck className="h-4 w-4" aria-hidden="true" />}
        </div>
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-[0.24em] text-amber-200">Brand Partner</p>
          <h3 id="sway-partner-terms-heading" className="mt-1 text-sm font-black text-white">{statusLabel}</h3>
          {partner.active ? (
            <p className="mt-1 text-xs leading-5 text-slate-400">Your Sway-controlled pricing is governed by the accepted Brand Partner terms recorded here.</p>
          ) : partner.suspended ? (
            <p className="mt-1 text-xs leading-5 text-amber-100">
              {partner.accepted
                ? 'This partner grant is suspended. Accepted terms remain recorded, but partner benefits are not active.'
                : 'This partner grant is suspended. Partner benefits are not active, and owner acceptance is still pending.'}
            </p>
          ) : (
            <p className="mt-1 text-xs leading-5 text-slate-400">Review and accept the exact terms before Brand Partner benefits become active.</p>
          )}
          {partner.statusReason ? <p className="mt-1 text-[11px] leading-5 text-slate-500">Status note: {partner.statusReason}</p> : null}
          {partner.accepted && partner.termsVersion && partner.termsHash ? (
            <p className="mt-2 break-all font-mono text-[10px] leading-5 text-slate-500">
              Accepted version {partner.termsVersion} · SHA-256 {partner.termsHash}{acceptedAtLabel ? ` · ${acceptedAtLabel}` : ''}
            </p>
          ) : null}
        </div>
      </div>

      {partner.accepted && exactTermsAvailable ? (
        <details className="group border-t border-amber-300/15 bg-amber-300/[0.04] p-4 sm:p-5">
          <summary className="cursor-pointer list-none text-sm font-black text-amber-100">
            <span className="group-open:hidden">Review accepted Brand Partner terms</span>
            <span className="hidden group-open:inline">Hide accepted Brand Partner terms</span>
          </summary>
          <pre className="mt-3 whitespace-pre-wrap rounded-2xl border border-white/10 bg-slate-950 p-4 font-sans text-xs leading-6 text-slate-300">{partner.termsText}</pre>
          <p className="mt-3 break-all font-mono text-[10px] leading-5 text-slate-500">
            Version {partner.termsVersion} · SHA-256 {partner.termsHash}
          </p>
        </details>
      ) : null}
      {partner.accepted && !exactTermsAvailable ? (
        <p role="alert" className="border-t border-rose-500/20 bg-rose-500/10 px-5 py-3 text-xs leading-5 text-rose-100">
          The accepted Brand Partner record is incomplete. Contact Sway support before relying on partner pricing.
        </p>
      ) : null}

      {partner.acceptanceRequired ? (
        exactTermsAvailable ? (
          <div className="border-t border-amber-300/15 bg-amber-300/[0.04] p-4 sm:p-5">
            <h4 className="text-sm font-black text-white">Review the exact Brand Partner terms</h4>
            <pre className="mt-3 whitespace-pre-wrap rounded-2xl border border-white/10 bg-slate-950 p-4 font-sans text-xs leading-6 text-slate-300">{partner.termsText}</pre>
            <p className="mt-3 break-all font-mono text-[10px] leading-5 text-slate-500">
              Version {partner.termsVersion} · SHA-256 {partner.termsHash}
            </p>
            <label className="mt-3 flex items-start gap-3 rounded-2xl border border-amber-300/15 bg-slate-950/60 px-4 py-3 text-xs leading-5 text-slate-300">
              <input
                type="checkbox"
                checked={acceptanceConfirmed}
                onChange={(event) => setAcceptanceConfirmed(event.target.checked)}
                disabled={requiresReload || acceptanceState === 'submitting'}
                className="mt-0.5 h-4 w-4"
              />
              <span>I am the authenticated owner of this performer account and accept this exact version and hash.</span>
            </label>
            {acceptanceMessage ? (
              <p
                role={acceptanceState === 'error' ? 'alert' : 'status'}
                aria-live="polite"
                className={`mt-3 rounded-xl border px-4 py-3 text-xs ${acceptanceState === 'error' ? 'border-rose-500/25 bg-rose-500/10 text-rose-100' : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-100'}`}
              >
                {acceptanceMessage}
              </p>
            ) : null}
            {requiresReload ? (
              <button
                type="button"
                onClick={reloadTerms}
                className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-amber-300/25 bg-slate-950 px-4 py-3 text-xs font-black text-amber-100"
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" /> Reload exact terms
              </button>
            ) : (
              <button
                type="button"
                onClick={handleAccept}
                disabled={!acceptanceConfirmed || acceptanceState === 'submitting'}
                className="mt-3 inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-amber-300 px-4 py-3 text-sm font-black text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {acceptanceState === 'submitting' ? 'Recording acceptance...' : 'Accept exact Brand Partner terms'}
              </button>
            )}
          </div>
        ) : (
          <div className="border-t border-rose-500/20 bg-rose-500/10 p-4 sm:p-5">
            <p role="alert" className="text-xs leading-5 text-rose-100">Sway could not load the exact terms text, version, and hash. Acceptance is unavailable until they can be reviewed together.</p>
            <button
              type="button"
              onClick={reloadTerms}
              className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-xl border border-rose-300/25 bg-slate-950 px-4 py-2 text-xs font-black text-rose-100"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" /> Reload exact terms
            </button>
          </div>
        )
      ) : acceptanceMessage ? (
        <p role={acceptanceState === 'error' ? 'alert' : 'status'} aria-live="polite" className="border-t border-emerald-500/20 bg-emerald-500/5 px-5 py-3 text-xs text-emerald-100">
          {acceptanceMessage}
        </p>
      ) : null}
    </section>
  );
}
