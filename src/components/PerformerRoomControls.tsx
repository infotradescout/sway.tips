import React from 'react';
import { GigSession } from '../types';

interface PerformerRoomControlsProps {
  session: GigSession;
  requestScopeLabel: string;
  selectedRoomLink: string | null;
  operatorNextAction: string;
  operatorNextDetail: string;
  actionPending: boolean;
  onToggleRequests: (open: boolean) => void;
  onSetMode: (mode: 'manual' | 'open_call' | 'crowd_autopilot') => void;
  onSetSearchScope: (scope: 'library' | 'catalog') => void;
  onEndSession: () => void;
}

export default function PerformerRoomControls({
  session,
  requestScopeLabel,
  selectedRoomLink,
  operatorNextAction,
  operatorNextDetail,
  actionPending,
  onToggleRequests,
  onSetMode,
  onSetSearchScope,
  onEndSession
}: PerformerRoomControlsProps) {
  return (
    <section
      data-sway-performer-room-controls="true"
      className="grid h-full min-h-0 min-w-0 w-full grid-cols-[minmax(0,1fr)] grid-rows-[auto_auto_auto_auto_auto] content-start gap-2 overflow-hidden rounded-2xl border border-white/10 bg-slate-900/90 p-3 landscape:p-2"
    >
      <div>
        <h3 className="font-display text-xs font-black uppercase tracking-widest text-white">Room Control</h3>
        <p className="mt-1 truncate text-[11px] text-slate-400">{operatorNextAction}: {operatorNextDetail}</p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => onToggleRequests(false)}
          disabled={actionPending || !session.requestsOpen}
          className="min-h-10 rounded-xl bg-rose-500 px-3 text-xs font-black uppercase text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Pause
        </button>
        <button
          type="button"
          onClick={() => onToggleRequests(true)}
          disabled={actionPending || session.requestsOpen}
          className="min-h-10 rounded-xl bg-emerald-500 px-3 text-xs font-black uppercase text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Resume
        </button>
      </div>

      <div data-sway-crowd-autopilot-control="true" className="grid grid-cols-3 gap-2">
        {[
          ['manual', 'Manual'],
          ['open_call', 'Open'],
          ['crowd_autopilot', 'Auto']
        ].map(([mode, label]) => (
          <button
            key={mode}
            type="button"
            onClick={() => onSetMode(mode as 'manual' | 'open_call' | 'crowd_autopilot')}
            disabled={actionPending}
            className={`min-h-9 rounded-xl px-2 text-[11px] font-black ${
              session.operatingMode === mode
                ? mode === 'crowd_autopilot' ? 'bg-fuchsia-500 text-white' : 'bg-cyan-500 text-slate-950'
                : 'border border-white/10 bg-slate-950 text-slate-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="grid gap-2 rounded-xl border border-white/10 bg-slate-950 p-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[9px] font-black uppercase tracking-widest text-slate-500">Request scope</p>
          <p className="truncate text-[10px] font-bold text-white">{requestScopeLabel}</p>
        </div>
        <div className="grid grid-cols-2 gap-1">
          {[
            ['library', 'Library'],
            ['catalog', 'Catalog']
          ].map(([scope, label]) => (
            <button
              key={scope}
              type="button"
              onClick={() => onSetSearchScope(scope as 'library' | 'catalog')}
              disabled={actionPending}
              className={`min-h-8 rounded-lg px-2 text-[10px] font-black ${
                session.searchScope === scope
                  ? 'bg-emerald-500 text-slate-950'
                  : 'border border-white/10 bg-slate-900 text-slate-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <a
          href={selectedRoomLink ? `/g/${selectedRoomLink}` : '/talent/gigs'}
          className="flex min-h-10 items-center justify-center rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-3 text-center text-xs font-black uppercase text-cyan-200"
        >
          Share
        </a>
        <button
          type="button"
          onClick={onEndSession}
          disabled={session.status !== 'active'}
          className="min-h-10 rounded-xl border border-white/10 bg-slate-950 px-3 text-xs font-black uppercase text-slate-300 disabled:cursor-not-allowed disabled:opacity-50"
        >
          End
        </button>
      </div>
    </section>
  );
}
