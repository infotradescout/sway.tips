import { RequestItem } from '../types';
import { LoadingState, useSwayState } from './shared';

export default function OverlayApp() {
  const { bState, isLoading } = useSwayState();

  if (isLoading) return <LoadingState />;

  const liveLadder = bState.requests
    .filter((r: RequestItem) => r.status === 'approved')
    .sort((a, b) => b.amount - a.amount);

  return (
    <div className="absolute inset-0 bg-transparent text-white p-4 overflow-hidden select-none">
      <div className="flex items-center justify-between border-b border-fuchsia-500/30 pb-2 mb-3">
        <span className="font-display text-xs font-black tracking-widest text-fuchsia-400">SWAY LIVE LADDER</span>
        <span className="text-[9px] font-mono text-cyan-400 mr-1 animate-pulse">LIVE GIG FEED</span>
      </div>

      <div className="space-y-2.5">
        {liveLadder.slice(0, 5).map((req, idx) => (
          <div
            key={req.id}
            className={`flex items-center justify-between p-2 rounded-lg border text-xs transition-transform ${
              idx === 0
                ? 'bg-slate-950/90 border-fuchsia-500/50 glow-fuchsia text-white'
                : 'bg-slate-900/80 border-white/5'
            }`}
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className={`font-mono font-bold text-[10px] px-1 py-0.5 rounded ${idx === 0 ? 'bg-fuchsia-500/20 text-fuchsia-300' : 'bg-slate-800 text-slate-400'}`}>
                #{idx + 1}
              </span>
              <span className="font-bold truncate">{req.title}</span>
            </div>
            <span className="font-mono text-cyan-400 font-bold ml-2">${req.amount}</span>
          </div>
        ))}
        {liveLadder.length === 0 && (
          <div className="text-center py-4 bg-slate-950/40 rounded border border-white/5 text-[10px] text-slate-500 font-mono">
            Waiting for gig requests...
          </div>
        )}
      </div>
    </div>
  );
}
