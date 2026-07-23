import { AudioLines, ExternalLink, Music2, QrCode, Radio, ShieldCheck } from 'lucide-react';
import PerformerRoomHistory from './PerformerRoomHistory';

export default function PerformerAccountHome({
  performerHandle,
  displayName,
  roleLabel,
  stripeReady,
  onStartRoom,
  onOpenCatalog,
  onOpenLibrary
}: {
  performerHandle?: string | null;
  displayName: string;
  roleLabel: string;
  stripeReady: boolean;
  onStartRoom: () => void;
  onOpenCatalog: () => void;
  onOpenLibrary: () => void;
}) {
  const publicPath = performerHandle ? `/p/${performerHandle}` : null;

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
          <p className="mt-2 text-sm text-slate-400">
            Your music is ready here whenever you sign in. Start a room only when you want a live crowd queue.
          </p>
        </div>
        <div
          className={`rounded-full px-3 py-1 text-[10px] font-black uppercase tracking-widest ${
            stripeReady ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-200'
          }`}
        >
          {stripeReady ? 'Payouts ready' : 'Verify Stripe to get paid'}
        </div>
      </div>

      <div className="mt-5 grid gap-2 sm:grid-cols-2">
        <button type="button" onClick={onOpenCatalog} className="inline-flex min-h-14 items-center justify-center gap-2 rounded-xl bg-fuchsia-600 px-4 text-sm font-black text-white transition hover:bg-fuchsia-500">
          <AudioLines className="h-4 w-4" aria-hidden="true" />
          Open my Catalog
        </button>
        <button type="button" onClick={onOpenLibrary} className="inline-flex min-h-14 items-center justify-center gap-2 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 text-sm font-black text-cyan-100 transition hover:border-cyan-300 hover:text-white">
          <Music2 className="h-4 w-4" aria-hidden="true" />
          Open request Library
        </button>
        <a href="/talent/releases/review" className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 text-sm font-black text-amber-100 transition hover:border-amber-300 hover:text-white">
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          Rights review queue
        </a>
        <a
          href="/home"
          className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 text-sm font-black text-cyan-100 transition hover:border-cyan-300 hover:text-white"
        >
          <QrCode className="h-4 w-4" aria-hidden="true" />
          Join / scan a room
        </a>

        <button
          type="button"
          onClick={onStartRoom}
          className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-fuchsia-500/30 bg-fuchsia-500/10 px-4 text-sm font-black text-fuchsia-100 transition hover:border-fuchsia-300 hover:text-white"
        >
          <Radio className="h-4 w-4" aria-hidden="true" />
          Start a live room
        </button>

        {publicPath ? (
          <a
            href={publicPath}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-white/10 bg-slate-950 px-4 text-sm font-black text-white transition hover:border-white/30"
          >
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
            Public page
          </a>
        ) : (
          <div className="inline-flex min-h-12 items-center justify-center rounded-xl border border-dashed border-white/10 bg-slate-950 px-4 text-sm font-bold text-slate-500">
            Public page after handle is set
          </div>
        )}
      </div>
    </section>
    <PerformerRoomHistory />
    </div>
  );
}
