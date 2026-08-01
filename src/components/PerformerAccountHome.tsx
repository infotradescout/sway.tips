import { CheckCircle2, Circle, ExternalLink, Music2, Radio } from 'lucide-react';
import PerformerRoomHistory from './PerformerRoomHistory';

export default function PerformerAccountHome({
  performerHandle,
  displayName,
  roleLabel,
  stripeReady,
  paymentMode,
  emailVerified,
  onStartRoom,
  onOpenLibrary
}: {
  performerHandle?: string | null;
  displayName: string;
  roleLabel: string;
  stripeReady: boolean;
  paymentMode: 'test' | 'unavailable';
  emailVerified: boolean;
  onStartRoom: () => void;
  onOpenLibrary: () => void;
}) {
  const publicPath = performerHandle ? `/p/${performerHandle}` : null;
  const readiness = [
    { done: emailVerified, label: 'Verify your account email' },
    { done: Boolean(performerHandle), label: 'Set your performer name and public handle' },
    { done: stripeReady, label: 'Finish Stripe test setup for paid-mode rehearsal', optional: true }
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
          <div className={`rounded-full px-3 py-1 text-[10px] font-black uppercase tracking-widest ${stripeReady ? 'bg-cyan-500/15 text-cyan-200' : 'bg-amber-500/15 text-amber-200'}`}>
            {stripeReady ? 'Test-money ready' : 'Free rooms only'}
          </div>
        </div>

        <p role="status" className={`mt-4 rounded-xl border px-3 py-3 text-xs leading-5 ${paymentMode === 'test' ? 'border-cyan-500/25 bg-cyan-500/10 text-cyan-100' : 'border-amber-500/25 bg-amber-500/10 text-amber-100'}`}>
          {paymentMode === 'test'
            ? 'Stripe test mode — no real money moves. Start with a free room; use test cards only when rehearsing money flows.'
            : 'Money actions are unavailable because Stripe test mode could not be verified. Free rooms still work.'}
        </p>

        <ol className="mt-5 space-y-2" aria-label="First room readiness">
          {readiness.map((item) => (
            <li key={item.label} className="flex items-center gap-3 rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-sm">
              {item.done ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-300" /> : <Circle className="h-4 w-4 shrink-0 text-slate-500" />}
              <span className={item.done ? 'text-slate-300' : 'font-bold text-white'}>
                {item.label}{item.optional && !item.done ? ' (only for paid rooms)' : ''}
              </span>
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

        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          <button type="button" onClick={onStartRoom} disabled={!emailVerified} className="inline-flex min-h-14 items-center justify-center gap-2 rounded-xl bg-fuchsia-600 px-4 text-sm font-black text-white transition hover:bg-fuchsia-500 disabled:cursor-not-allowed disabled:opacity-50">
            <Radio className="h-4 w-4" aria-hidden="true" />
            Start first room
          </button>
          <button type="button" onClick={onOpenLibrary} className="inline-flex min-h-14 items-center justify-center gap-2 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 text-sm font-black text-cyan-100 transition hover:border-cyan-300 hover:text-white">
            <Music2 className="h-4 w-4" aria-hidden="true" />
            Prepare request library
          </button>
          {publicPath ? (
            <a href={publicPath} target="_blank" rel="noreferrer" className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-white/10 bg-slate-950 px-4 text-sm font-black text-white transition hover:border-white/30 sm:col-span-2">
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
