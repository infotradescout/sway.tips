import React from 'react';
import { GigSession, RequestItem } from '../types';
import { PerformerRoomQr } from './PerformerRoomShare';

export default function PerformerAudienceScreen({
  activeGigId,
  session,
  approvedQueue
}: {
  activeGigId: string | null;
  session: GigSession;
  approvedQueue: RequestItem[];
}) {
  const nowPlaying = approvedQueue[0] ?? null;
  const nextAfter = approvedQueue[1] ?? null;

  return (
    <section
      data-sway-performer-audience-screen="true"
      className="grid h-full min-h-0 grid-cols-[auto_minmax(0,1fr)] gap-3 overflow-hidden rounded-2xl border border-cyan-500/20 bg-[linear-gradient(135deg,rgba(8,13,28,0.96),rgba(30,8,43,0.82))] p-3 landscape:grid-cols-1 landscape:grid-rows-[auto_minmax(0,1fr)_auto] landscape:p-4"
    >
      <div className="rounded-xl bg-white p-2 text-slate-950 landscape:mx-auto landscape:w-full landscape:max-w-56">
        <div className="flex aspect-square items-center justify-center">
          <PerformerRoomQr activeGigId={activeGigId} size={224} />
        </div>
      </div>
      <div className="min-w-0 self-center overflow-hidden landscape:text-center">
        <p className="text-[9px] font-black uppercase tracking-[0.28em] text-cyan-300">Customer Screen</p>
        <p className="mt-1 font-display text-xl font-black uppercase tracking-wide text-white min-[360px]:text-2xl landscape:text-4xl">Scan to Request</p>
        <p className="mt-1 truncate text-xs font-bold text-fuchsia-200 landscape:text-sm">
          {session.operatingMode === 'crowd_autopilot' ? 'Crowd Picks What Is Next' : 'Tip / Boost / Move the Queue'}
        </p>
        <p className="mt-2 truncate font-mono text-[10px] font-bold text-slate-400">{activeGigId ? `/g/${activeGigId}` : 'Room link after start'}</p>
        <div className="mt-3 hidden gap-1.5 text-left min-[360px]:grid landscape:mt-4 landscape:grid">
          <div className="rounded-lg border border-white/10 bg-slate-950/70 px-3 py-2">
            <p className="text-[8px] font-black uppercase tracking-widest text-cyan-300">Now</p>
            <p className="truncate text-sm font-black text-white">{nowPlaying?.title ?? (session.requestsOpen ? 'Requests open' : 'Requests paused')}</p>
          </div>
          <div className="hidden rounded-lg border border-white/10 bg-slate-950/70 px-3 py-2 landscape:block">
            <p className="text-[8px] font-black uppercase tracking-widest text-fuchsia-300">Up next</p>
            <p className="truncate text-sm font-black text-white">{nextAfter?.title ?? 'Waiting for the crowd'}</p>
          </div>
        </div>
      </div>
      <div className="hidden rounded-xl border border-white/10 bg-slate-950/80 px-3 py-2 text-center landscape:block">
        <p className={`text-xs font-black uppercase tracking-widest ${session.requestsOpen ? 'text-emerald-300' : 'text-rose-300'}`}>
          {session.operatingMode === 'crowd_autopilot'
            ? 'Crowd autopilot live'
            : session.requestsOpen ? 'Live requests open' : 'Requests paused'}
        </p>
      </div>
    </section>
  );
}
