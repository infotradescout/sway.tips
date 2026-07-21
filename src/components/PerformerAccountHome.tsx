import { ExternalLink, FolderLock, QrCode, Radio } from 'lucide-react';

export default function PerformerAccountHome({
  performerHandle,
  displayName,
  stripeReady
}: {
  performerHandle?: string | null;
  displayName: string;
  stripeReady: boolean;
}) {
  const publicPath = performerHandle ? `/p/${performerHandle}` : null;

  return (
    <section
      data-sway-account-home="true"
      className="mx-auto w-full max-w-2xl rounded-3xl border border-cyan-500/20 bg-slate-900 p-4 shadow-2xl sm:p-6"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.28em] text-cyan-300">Your Sway</p>
          <h2 className="mt-1 font-display text-xl font-black uppercase text-white">{displayName}</h2>
          <p className="mt-2 text-sm text-slate-400">
            Use the site without going live. Start a room only when you want money and a queue tonight.
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
        <a
          href="/home"
          className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 text-sm font-black text-cyan-100 transition hover:border-cyan-300 hover:text-white"
        >
          <QrCode className="h-4 w-4" aria-hidden="true" />
          Join / scan a room
        </a>

        <a
          href="#sway-start-room"
          className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-fuchsia-600 px-4 text-sm font-black text-white transition hover:bg-fuchsia-500"
        >
          <Radio className="h-4 w-4" aria-hidden="true" />
          Start a live room
        </a>

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

        <div
          aria-disabled="true"
          title="Publishing foundation is on main as schema/contracts. Upload and share runtime is next."
          className="inline-flex min-h-12 cursor-not-allowed items-center justify-center gap-2 rounded-xl border border-white/10 bg-slate-950 px-4 text-sm font-black text-slate-500"
        >
          <FolderLock className="h-4 w-4" aria-hidden="true" />
          Files &amp; projects — next
        </div>
      </div>
    </section>
  );
}
