import { useEffect, useState } from 'react';
import { CalendarDays, Coins, Music2 } from 'lucide-react';
import type { PerformerRoomRecap } from '../types';

export default function PerformerRoomHistory() {
  const [rooms, setRooms] = useState<PerformerRoomRecap[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/talent/rooms/history', { cache: 'no-store' })
      .then(async (response) => {
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error || 'Room history could not load.');
        if (!cancelled) setRooms(Array.isArray(data.rooms) ? data.rooms : []);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Room history could not load.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const money = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
  return (
    <section className="mx-auto mt-4 w-full max-w-2xl rounded-3xl border border-white/10 bg-slate-900 p-4 shadow-2xl sm:p-6" data-sway-room-history="true">
      <div className="flex items-center gap-2">
        <CalendarDays className="h-4 w-4 text-cyan-300" />
        <div><p className="text-[10px] font-black uppercase tracking-[0.28em] text-cyan-300">Past rooms</p><h2 className="font-display text-lg font-black text-white">Earnings and recaps</h2></div>
      </div>
      {loading ? <p className="mt-4 text-xs text-slate-400">Loading room history…</p> : null}
      {error ? <p className="mt-4 text-xs text-rose-300">{error}</p> : null}
      {!loading && !error && rooms.length === 0 ? <p className="mt-4 text-xs text-slate-400">Your completed rooms will stay available here.</p> : null}
      <div className="mt-4 space-y-2">
        {rooms.map((room) => (
          <article key={room.gigId} className="rounded-2xl border border-white/10 bg-slate-950 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0"><p className="truncate text-sm font-black text-white">{room.performerName}</p><p className="mt-1 text-[10px] text-slate-500">{room.closedAt ? new Date(room.closedAt).toLocaleString() : 'Completed room'}</p></div>
              <p className="font-mono text-lg font-black text-emerald-300">{money(room.capturedEarnings)}</p>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-lg bg-slate-900 p-3"><Coins className="h-3.5 w-3.5 text-emerald-300" /><p className="mt-1 text-slate-500">Paid actions</p><p className="font-bold text-white">{room.completedActions}</p></div>
              <div className="rounded-lg bg-slate-900 p-3"><Music2 className="h-3.5 w-3.5 text-fuchsia-300" /><p className="mt-1 text-slate-500">Top request</p><p className="truncate font-bold text-white">{room.topRequest}</p></div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
