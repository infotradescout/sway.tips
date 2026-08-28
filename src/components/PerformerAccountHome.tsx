import { CalendarDays, CheckCircle2, Circle, ExternalLink, Music2, Radio, UserRound, WalletCards } from 'lucide-react';
import PerformerRoomHistory from './PerformerRoomHistory';

export default function PerformerAccountHome({
  performerHandle,
  displayName,
  roleLabel,
  moneyReady,
  paymentMode,
  emailVerified,
  onStartRoom,
  onOpenShows,
  onOpenPublicPage,
  onOpenMoney,
  onOpenLibrary
}: {
  performerHandle?: string | null;
  displayName: string;
  roleLabel: string;
  moneyReady: boolean;
  paymentMode: 'test' | 'live' | 'unavailable';
  emailVerified: boolean;
  onStartRoom: () => void;
  onOpenShows: () => void;
  onOpenPublicPage: () => void;
  onOpenMoney: () => void;
  onOpenLibrary: () => void;
}) {
  const publicPath = performerHandle ? `/p/${performerHandle}` : null;
  const moneyReadinessLabel = paymentMode === 'live'
    ? 'Live payout setup'
    : paymentMode === 'test'
      ? 'Test-money rehearsal setup'
      : 'Money availability';
  const moneyStatusLabel = moneyReady
    ? paymentMode === 'live'
      ? 'Live-money ready'
      : 'Test-money ready'
    : 'Free rooms only';
  const readiness = [
    { done: emailVerified, label: 'Verify your account email', href: '/account/resend-verification' },
    { done: Boolean(performerHandle), label: 'Set your performer name and public handle', onClick: onOpenPublicPage },
    { done: moneyReady, label: moneyReadinessLabel, optional: true, onClick: onOpenMoney }
  ];

  return (
    <div>
      <section
        data-sway-account-home="true"
        className="mx-auto w-full max-w-2xl rounded-3xl border border-cyan-500/20 bg-slate-900 p-4 shadow-2xl sm:p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.28em] text-cyan-300">{roleLabel}</p>
            <h2 className="mt-1 font-display text-xl font-black text-white">{displayName}</h2>
            <p className="mt-2 text-sm text-slate-400">Finish the essentials, run a free test room, then share your live link or QR.</p>
          </div>
          <div className={`rounded-full px-3 py-1 text-[10px] font-black uppercase tracking-widest ${moneyReady ? 'bg-cyan-500/15 text-cyan-200' : 'bg-amber-500/15 text-amber-200'}`}>
            {moneyStatusLabel}
          </div>
        </div>

        <p role="status" className={`mt-4 rounded-xl border px-3 py-3 text-xs leading-5 ${
          paymentMode === 'live'
            ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-100'
            : paymentMode === 'test'
              ? 'border-cyan-500/25 bg-cyan-500/10 text-cyan-100'
              : 'border-amber-500/25 bg-amber-500/10 text-amber-100'
        }`}>
          {paymentMode === 'live'
            ? moneyReady
              ? 'Stripe live mode — real charges and the current bank-payout setup are ready.'
              : 'Stripe live mode — real charges. Complete bank-payout setup before starting a paid room.'
            : paymentMode === 'test'
              ? moneyReady
                ? 'Stripe test mode — test-money rehearsal is ready and no real money moves.'
                : 'Stripe test mode — no real money moves. Finish test payout setup before rehearsing paid money flows.'
              : 'Money actions are unavailable because Stripe could not be verified. Free rooms still work.'}
        </p>

        <ol className="mt-5 space-y-2" aria-label="First room readiness">
          {readiness.map((item) => (
            <li key={item.label} className="flex items-center gap-3 rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-sm">
              {item.done ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-300" /> : <Circle className="h-4 w-4 shrink-0 text-slate-500" />}
              {item.done ? (
                <span className="text-slate-300">{item.label}</span>
              ) : item.href ? (
                <a href={item.href} className="font-bold text-white underline decoration-white/30 underline-offset-4 hover:decoration-white">
                  {item.label}{item.optional ? ' (only for paid rooms)' : ''}
                </a>
              ) : (
                <button type="button" onClick={item.onClick} className="text-left font-bold text-white underline decoration-white/30 underline-offset-4 hover:decoration-white">
                  {item.label}{item.optional ? ' (only for paid rooms)' : ''}
                </button>
              )}
            </li>
          ))}
        </ol>

        <div className="mt-4 rounded-2xl border border-white/10 bg-slate-950 p-4">
          <p className="text-[10px] font-black uppercase tracking-[0.24em] text-fuchsia-300">Solo rehearsal</p>
          <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs leading-5 text-slate-300">
            <li>Start a free room and keep this console open.</li>
            <li>Open the room QR or link in three private browser windows or devices.</li>
            <li>Submit, approve, boost, fulfill, hide, reconnect, then end the room.</li>
          </ol>
        </div>

        <div className="mt-5 grid gap-2 sm:grid-cols-3">
          <button type="button" onClick={onStartRoom} disabled={!emailVerified} className="inline-flex min-h-14 items-center justify-center gap-2 rounded-xl bg-fuchsia-600 px-4 text-sm font-black text-white transition hover:bg-fuchsia-500 disabled:cursor-not-allowed disabled:opacity-50">
            <Radio className="h-4 w-4" aria-hidden="true" />
            Start first room
          </button>
          <button type="button" onClick={onOpenShows} className="inline-flex min-h-14 items-center justify-center gap-2 rounded-xl border border-fuchsia-500/30 bg-fuchsia-500/10 px-4 text-sm font-black text-fuchsia-100 transition hover:border-fuchsia-300 hover:text-white">
            <CalendarDays className="h-4 w-4" aria-hidden="true" />
            Schedule a show
          </button>
          <button type="button" onClick={onOpenLibrary} className="inline-flex min-h-14 items-center justify-center gap-2 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 text-sm font-black text-cyan-100 transition hover:border-cyan-300 hover:text-white">
            <Music2 className="h-4 w-4" aria-hidden="true" />
            Prepare request library
          </button>
          <button type="button" onClick={onOpenPublicPage} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-white/10 bg-slate-950 px-4 text-sm font-black text-white transition hover:border-white/30">
            <UserRound className="h-4 w-4" aria-hidden="true" />
            Edit Public Page
          </button>
          <button type="button" onClick={onOpenMoney} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-white/10 bg-slate-950 px-4 text-sm font-black text-white transition hover:border-white/30 sm:col-span-2">
            <WalletCards className="h-4 w-4" aria-hidden="true" />
            Open Money
          </button>
          {publicPath ? (
            <a href={publicPath} target="_blank" rel="noreferrer" className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-white/10 bg-slate-950 px-4 text-sm font-black text-white transition hover:border-white/30 sm:col-span-3">
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
              Preview public page
            </a>
          ) : null}
        </div>
      </section>
      <PerformerRoomHistory />
    </div>
  );
}
