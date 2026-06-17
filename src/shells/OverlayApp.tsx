import { RequestItem } from '../types';
import { DemoModeBanner, isDemoModeEnabled } from '../demo-mode';
import { EndedLiveRoomRecovery, JoinLiveRoomRecovery, LoadingState, useSwayState } from './shared';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function resolveOverlayGigId(pathname: string) {
  const parts = pathname.split('/').filter(Boolean);
  return parts[0] === 'overlay' && UUID_PATTERN.test(parts[1] || '') ? parts[1] : null;
}

export default function OverlayApp() {
  const routeGigId = resolveOverlayGigId(window.location.pathname);
  const { bState, isLoading, roomLookup } = useSwayState({
    statePath: routeGigId ? `/api/state/${routeGigId}` : null
  });

  if (isLoading) return <LoadingState />;
  if (roomLookup.status === 'ended') return <EndedLiveRoomRecovery />;
  if (roomLookup.status !== 'active') return <JoinLiveRoomRecovery />;

  const upNextQueue = bState.requests
    .filter((r: RequestItem) => r.status === 'approved')
    .sort((a, b) => b.amount - a.amount);
  const nowPlaying = bState.requests
    .filter((r: RequestItem) => r.status === 'fulfilled' && r.type !== 'tip' && !r.hidden && !r.removed)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] ?? null;

  return (
    <div className="absolute inset-0 bg-transparent text-white p-4 overflow-hidden select-none">
      <div className="flex items-center justify-between border-b border-fuchsia-500/30 pb-2 mb-3">
        <span className="font-display text-xs font-black tracking-widest text-fuchsia-400">SWAY LIVE ROOM</span>
        {isDemoModeEnabled() ? (
          <div aria-label="Demo data">
            <DemoModeBanner compact />
          </div>
        ) : (
          <span className="text-[9px] font-mono text-cyan-400 mr-1 animate-pulse">LIVE GIG FEED</span>
        )}
      </div>

      {nowPlaying && (
        <div className="mb-3 p-2.5 rounded-lg bg-slate-950/90 border border-cyan-500/40">
          <div className="text-[9px] font-mono tracking-widest text-cyan-400 uppercase">Now Playing</div>
          <div className="text-sm font-black text-white truncate">{nowPlaying.title}</div>
        </div>
      )}

      <div className="space-y-2.5">
        {upNextQueue.length > 0 && (
          <div className="text-[9px] font-mono tracking-widest text-fuchsia-400/80 uppercase">Up Next</div>
        )}
        {upNextQueue.slice(0, 5).map((req, idx) => (
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
        {upNextQueue.length === 0 && (
          <div className="text-center py-4 bg-slate-950/40 rounded border border-white/5 text-[10px] text-slate-500 font-mono">
            Waiting for gig requests...
          </div>
        )}
      </div>
    </div>
  );
}
