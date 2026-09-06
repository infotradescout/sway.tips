/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Award, Coins, Music, Share2, TrendingUp } from 'lucide-react';
import type { GigSession, RequestItem } from '../types';
import { buildRecapShareText, formatRecapMoney, recapMoneyState, RECAP_REQUEST_STATUS } from '../recap-display';

interface VictoryScreenProps {
  session: GigSession;
  requests: RequestItem[];
  onRestart: () => void;
}
const PAGE_SIZE = 25;
const buttonClass = 'min-h-11 rounded-xl border border-white/20 px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-400';
const gradients = {
  neon: 'from-rose-500 via-purple-600 to-indigo-600',
  cyberpunk: 'from-amber-400 via-rose-500 to-violet-600',
  midnight: 'from-blue-600 via-indigo-900 to-purple-950'
};

function RequestHistory({ requests }: { requests: RequestItem[] }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(0);
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return requests.filter(request => !request.hidden && !request.removed
      && (status === 'all' || request.status === status)
      && (!term || `${request.title} ${request.subtitle}`.toLocaleLowerCase().includes(term)));
  }, [requests, query, status]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const entries = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  return (
    <section aria-labelledby="recap-history-title" className="mt-8 min-w-0 rounded-2xl border border-white/10 bg-gray-900/50 p-4 sm:p-6" data-sway-recap-history="true">
      <h2 id="recap-history-title" className="text-xl font-bold">Request history</h2>
      <p className="mt-2 text-sm text-gray-300">Your completed room is read-only. Search the saved requests and tips below.</p>
      <div className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2">
        <label className="min-w-0 text-sm">Search request history
          <input type="search" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} className="mt-1 min-h-11 w-full min-w-0 rounded-xl border border-white/20 bg-gray-950 px-3 text-white" />
        </label>
        <label className="min-w-0 text-sm">Request status
          <select value={status} onChange={event => { setStatus(event.target.value); setPage(0); }} className="mt-1 min-h-11 w-full min-w-0 rounded-xl border border-white/20 bg-gray-950 px-3 text-white">
            <option value="all">All statuses</option>
            {Object.entries(RECAP_REQUEST_STATUS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>
      <p role="status" className="mt-4 text-sm text-gray-300">
        {filtered.length ? `Showing ${currentPage * PAGE_SIZE + 1}–${Math.min((currentPage + 1) * PAGE_SIZE, filtered.length)} of ${filtered.length}` : 'No matching requests or tips.'}
      </p>
      <ul className="mt-3 min-w-0 divide-y divide-white/10" aria-label="Saved room requests">
        {entries.map(request => <li key={request.id} className="min-w-0 py-4 [overflow-wrap:anywhere]">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
            <p className="min-w-0 flex-1 font-semibold">{request.title || (request.type === 'tip' ? 'Tip' : 'Untitled request')}</p>
            <span className="rounded-lg bg-white/10 px-2 py-1 text-xs">{RECAP_REQUEST_STATUS[request.status] ?? 'Status unavailable'}</span>
          </div>
          {request.subtitle ? <p className="mt-1 text-sm text-gray-300">{request.subtitle}</p> : null}
          <p className="mt-1 text-xs text-gray-400">{request.type === 'tip' ? 'Tip' : 'Request'}</p>
        </li>)}
      </ul>
      {pageCount > 1 ? <nav aria-label="Request history pages" className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" className={buttonClass} disabled={currentPage === 0} onClick={() => setPage(0)}>First page</button>
        <button type="button" className={buttonClass} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous page</button>
        <span className="px-1 text-sm">Page {currentPage + 1} of {pageCount}</span>
        <button type="button" className={buttonClass} disabled={currentPage === pageCount - 1} onClick={() => setPage(currentPage + 1)}>Next page</button>
        <button type="button" className={buttonClass} disabled={currentPage === pageCount - 1} onClick={() => setPage(pageCount - 1)}>Last page</button>
      </nav> : null}
    </section>
  );
}

function RecapView({ session, requests, onRestart }: VictoryScreenProps) {
  const [selectedGradient, setSelectedGradient] = useState<keyof typeof gradients>('neon');
  const [shareState, setShareState] = useState<'idle' | 'pending' | 'copied' | 'shared' | 'error'>('idle');
  const sharePending = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const payment = recapMoneyState(session.paymentEnvironment, session.settlementMode, session.totals.totalTips);
  const formattedTips = formatRecapMoney(session.totals.totalTips);
  const shareText = buildRecapShareText(session.totals.totalTips);
  const visible = useMemo(() => requests.filter(request => !request.hidden && !request.removed), [requests]);
  const fulfilled = visible.filter(request => request.type === 'request' && request.status === 'fulfilled').length;
  const hasUncapturedPayments = requests.some(request => request.paymentStatus === 'authorized'
    || (request.status === 'fulfilled' && request.amount > 0
      && request.paymentStatus !== 'captured' && request.paymentStatus !== 'paid_out'));

  const handleShare = async () => {
    if (!payment.canShare || !shareText || sharePending.current) return;
    sharePending.current = true;
    setShareState('pending');
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share({ text: shareText, url: 'https://www.sway.tips' });
        if (mounted.current) setShareState('shared');
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareText);
        if (mounted.current) setShareState('copied');
      } else {
        throw new Error('Sharing is unavailable.');
      }
    } catch (error) {
      if (mounted.current) setShareState(error instanceof Error && error.name === 'AbortError' ? 'idle' : 'error');
    } finally {
      sharePending.current = false;
    }
  };

  return (
    <div id="victory_screen_container" className="relative min-h-screen min-w-0 bg-gray-950 px-4 py-8 text-white grid-bg sm:px-6">
      <div className="mx-auto w-full min-w-0 max-w-5xl">
        <div className="grid min-w-0 gap-8 lg:grid-cols-2">
          <section className="min-w-0 space-y-5 [overflow-wrap:anywhere]" aria-labelledby="night-recap-title">
            <p className="text-sm font-bold uppercase tracking-wide text-rose-400">Room closed</p>
            <h1 id="night-recap-title" className="font-display text-4xl font-extrabold">Night recap</h1>
            <p className="text-base font-semibold">{session.talentName}</p>
            <p className="text-sm leading-relaxed text-gray-300">Your completed room is saved. These figures are room records, not your available cash-out balance.</p>
            {hasUncapturedPayments && session.totals.totalTips === 0 ? <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4" role="note">
              <p className="font-semibold text-amber-200">Some payments are not confirmed as captured</p>
              <p className="mt-2 text-sm text-amber-100/90">A request amount is not proof that money was collected. The recorded captured total is $0. This recap does not establish why a payment was not captured.</p>
            </div> : null}
            {payment.test ? <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4" data-sway-test-volume="true">
              <p className="font-semibold text-amber-200">Test payment volume — no real money</p>
              <p className="mt-2 text-sm text-amber-100/90">These amounts are not earnings, cannot be cashed out to PayPal or Venmo, and cannot be shared as a real-money result.</p>
            </div> : null}
            <dl className="grid min-w-0 gap-3 sm:grid-cols-2">
              <div className="min-w-0 rounded-xl border border-gray-800 bg-gray-900/60 p-4"><Coins aria-hidden="true" className="mb-2 h-5 w-5 text-emerald-400" /><dt className="text-sm text-gray-300">{payment.label}</dt><dd className="mt-1 text-2xl font-bold" data-testid="recap-volume">{formattedTips}</dd><p className="mt-1 text-xs text-gray-400">Not a bank payout total</p></div>
              <div className="min-w-0 rounded-xl border border-gray-800 bg-gray-900/60 p-4"><TrendingUp aria-hidden="true" className="mb-2 h-5 w-5 text-cyan-400" /><dt className="text-sm text-gray-300">{payment.test ? 'Test platform fee volume' : 'Recorded platform fees'}</dt><dd className="mt-1 text-2xl font-bold" data-testid="recap-fees">{formatRecapMoney(session.totals.accumulatedFees)}</dd></div>
              <div className="min-w-0 rounded-xl border border-gray-800 bg-gray-900/60 p-4"><Award aria-hidden="true" className="mb-2 h-5 w-5 text-rose-400" /><dt className="text-sm text-gray-300">Fulfilled requests</dt><dd className="mt-1 text-2xl font-bold" data-testid="recap-fulfilled">{fulfilled}</dd></div>
              <div className="min-w-0 rounded-xl border border-gray-800 bg-gray-900/60 p-4"><Music aria-hidden="true" className="mb-2 h-5 w-5 text-indigo-400" /><dt className="text-sm text-gray-300">Requests and tips in this recap</dt><dd className="mt-1 text-2xl font-bold">{visible.length}</dd></div>
            </dl>
            <div className="min-w-0 rounded-xl border border-indigo-900/30 bg-gray-900 p-4"><h2 className="text-sm text-indigo-300">Recorded top request</h2><p className="mt-2 font-semibold">{session.totals.topRequest || 'No top request recorded'}</p></div>
            <button type="button" onClick={onRestart} className={`${buttonClass} flex w-full items-center justify-center gap-2 bg-rose-600`}>Start New Room <ArrowRight aria-hidden="true" className="h-4 w-4" /></button>
          </section>
          <section aria-label="Recap sharing" className="min-w-0 space-y-4">
            <div className={`mx-auto w-full min-w-0 max-w-sm rounded-3xl bg-gradient-to-tr ${gradients[selectedGradient]} p-1`}>
              <div className="min-w-0 space-y-8 rounded-[22px] bg-gray-950/95 p-5 [overflow-wrap:anywhere] sm:p-6">
                <p className="font-display text-sm font-black tracking-widest text-rose-400">SWAY</p>
                <div className="min-w-0 space-y-3 text-center"><p className="text-sm text-gray-300">{payment.test ? 'TEST VOLUME — NOT EARNINGS' : payment.label}</p><p className="text-3xl font-black sm:text-4xl">{formattedTips}</p><p className="text-sm text-rose-300">Room closed</p></div>
                <div className="min-w-0 rounded-xl border border-white/10 p-4"><p className="text-xs text-gray-400">Performer</p><p className="mt-1 font-semibold">{session.talentName}</p><p className="mt-3 text-xs text-gray-400">Recorded top request</p><p className="mt-1 text-sm">{session.totals.topRequest || 'No top request recorded'}</p></div>
                <p className="border-t border-white/10 pt-3 text-xs text-gray-400">{payment.test ? 'No real money' : 'Captured volume is not payout'} · sway.tips</p>
              </div>
            </div>
            <fieldset className="min-w-0"><legend className="mb-2 text-sm text-gray-300">Card appearance</legend><div className="flex flex-wrap gap-2">{(Object.keys(gradients) as Array<keyof typeof gradients>).map(style => <button key={style} type="button" aria-pressed={selectedGradient === style} onClick={() => setSelectedGradient(style)} className={`${buttonClass} ${selectedGradient === style ? 'border-rose-400 bg-white/10' : ''}`}>{style[0].toUpperCase() + style.slice(1)}</button>)}</div></fieldset>
            <p className="text-sm text-gray-300">Sharing sends recap text to an available app, or copies the text. It does not publish this card or post a story automatically.</p>
            <button type="button" onClick={handleShare} disabled={!payment.canShare || shareState === 'pending'} className={`${buttonClass} flex w-full items-center justify-center gap-2`}><Share2 aria-hidden="true" className="h-4 w-4" />{shareState === 'pending' ? 'Sharing recap…' : 'Share recap text'}</button>
            {!payment.canShare ? <p className="text-sm text-amber-200">{payment.test ? 'Sharing Disabled for Test Volume' : 'Sharing Requires Verified Live Settlement'}</p> : null}
            <div role="status" aria-live="polite" className="text-sm text-gray-300">{shareState === 'copied' ? 'Recap text copied.' : shareState === 'shared' ? 'Recap sent to your sharing app.' : ''}</div>
            {shareState === 'error' && payment.canShare && shareText ? <div className="min-w-0 rounded-xl border border-amber-500/30 p-4"><p role="alert" className="text-sm text-amber-200">The recap was not shared. Try again or select and copy the text below.</p><label className="mt-3 block text-sm">Recap text<textarea readOnly value={shareText} rows={5} className="mt-2 w-full min-w-0 rounded-lg border border-white/20 bg-gray-950 p-3 text-sm" /></label></div> : null}
          </section>
        </div>
        <RequestHistory requests={requests} />
      </div>
    </div>
  );
}

export default function VictoryScreen(props: VictoryScreenProps) {
  // A different completed night must not inherit search, page or pending-share UI.
  return <RecapView key={`${props.session.startedAt}:${props.session.closedAt}:${props.session.talentName}`} {...props} />;
}
