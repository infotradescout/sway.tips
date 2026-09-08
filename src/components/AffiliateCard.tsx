import { useEffect, useState } from 'react';

type AffiliateOverview = {
  enrolled: boolean;
  rateBps: number;
  tier: 'standard' | 'sway_partner' | 'sway_exclusive';
  shareUrl: string;
  profileShareUrl: string | null;
  referralCount: number;
  commissions: Array<{ paymentMode: 'test' | 'live'; currency: string; earnedCents: string; reversedCents: string; netCents: string; heldCents: string }>;
  payoutMessage: string;
};

function money(cents: string, currency: string) {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(Number(cents) / 100); }
  catch { return `${(Number(cents) / 100).toFixed(2)} ${currency}`; }
}

export default function AffiliateCard() {
  const [data, setData] = useState<AffiliateOverview | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void (async () => {
      try {
        const response = await fetch('/api/account/affiliate', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('Affiliate details are temporarily unavailable.');
        const result: AffiliateOverview = await response.json();
        if (!controller.signal.aborted) setData(result);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Unable to load affiliate details.');
      }
    })();
    return () => controller.abort();
  }, [attempt]);

  const copy = async (url: string) => {
    try { await navigator.clipboard.writeText(url); setNotice('Affiliate link copied.'); }
    catch { setNotice('Select and copy the link below.'); }
  };
  return (
    <section aria-labelledby="affiliate-heading" className="mt-5 rounded-2xl border border-emerald-400/25 bg-emerald-400/5 p-4">
      <h2 id="affiliate-heading" className="font-display text-lg font-black text-emerald-100">Your affiliate links</h2>
      {error ? <div className="mt-3"><p role="status" className="text-sm text-slate-300">{error}</p><button type="button" onClick={() => setAttempt((value) => value + 1)} className="mt-2 min-h-11 rounded-xl border border-white/20 px-4 text-sm font-bold">Retry affiliate details</button></div> : !data ? <p role="status" className="mt-2 text-sm text-slate-400">Loading affiliate details…</p> : (
        <>
          <p className="mt-2 text-sm leading-6 text-slate-200">You’re automatically an affiliate. Earn <strong>{data.rateBps / 100}% of eligible Sway platform fees</strong> from people who join through your link.</p>
          <p className="mt-1 text-xs text-emerald-200">{data.tier === 'sway_exclusive' ? 'Sway Exclusive' : data.tier === 'sway_partner' ? 'Sway Partner' : 'Standard affiliate'} · {data.referralCount} referred {data.referralCount === 1 ? 'account' : 'accounts'}</p>
          {([{ label: 'Invite people to Sway', url: data.shareUrl }, ...(data.profileShareUrl ? [{ label: 'Share your public profile', url: data.profileShareUrl }] : [])]).map(({ label, url }) => (
            <div key={label} className="mt-4">
              <label className="block text-xs font-bold text-slate-200">{label}<input aria-label={`${label} affiliate link`} readOnly value={url} onFocus={(event) => event.currentTarget.select()} className="mt-2 min-h-11 w-full rounded-xl border border-white/15 bg-slate-950 px-3 text-xs text-slate-300" /></label>
              <button type="button" onClick={() => { void copy(url); }} className="mt-2 min-h-11 rounded-xl bg-emerald-300 px-4 text-sm font-black text-slate-950">Copy {label === 'Share your public profile' ? 'profile' : 'invite'} link</button>
            </div>
          ))}
          {notice ? <p role="status" aria-live="polite" className="mt-2 text-xs text-emerald-100">{notice}</p> : null}
          <div className="mt-4 border-t border-white/10 pt-3 text-xs leading-5 text-slate-400">
            {data.commissions.length ? data.commissions.map((row) => <p key={`${row.paymentMode}-${row.currency}`}><strong className="text-slate-200">{row.paymentMode === 'test' ? 'Test activity' : 'Recorded commissions'}: {money(row.netCents, row.currency)}</strong>{Number(row.heldCents) > 0 ? ` · ${money(row.heldCents, row.currency)} on hold` : ''}{row.paymentMode === 'test' ? ' · no real money' : ''}</p>) : <p>No commissions recorded yet.</p>}
            <p className="mt-1">{data.payoutMessage}</p>
          </div>
        </>
      )}
    </section>
  );
}
