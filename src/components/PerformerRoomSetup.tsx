import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Plus, Play, Trash2 } from 'lucide-react';
import type { LiveRoomType, RoomRequestMenuItem } from '../types';

export type PerformerRoomSetupData = {
  gig_id: string;
  talentName: string;
  talentRole: 'DJ' | 'Performer';
  roomType: LiveRoomType;
  requestMenu: RoomRequestMenuItem[];
  linkedEventId: string | null;
  feeType: 'talent' | 'patron';
  minimumTip: number;
  paymentsEnabled: boolean;
  searchScope: 'library' | 'catalog';
};

type LinkableEvent = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  status: string;
  ticketingMode: 'external' | 'native_ga';
  attendanceMode: 'walk_in' | 'external_rsvp' | 'external_ticket' | 'native_ticket';
};

const ROOM_LINK_OPEN_BEFORE_MS = 24 * 60 * 60 * 1_000;
const ROOM_LINK_DEFAULT_DURATION_MS = 4 * 60 * 60 * 1_000;

export function isEventWithinRoomLinkWindow(
  event: Pick<LinkableEvent, 'startsAt' | 'endsAt'>,
  now = Date.now()
) {
  const startsAt = new Date(event.startsAt).getTime();
  const closesAt = event.endsAt === null
    ? startsAt + ROOM_LINK_DEFAULT_DURATION_MS
    : new Date(event.endsAt).getTime();
  return Number.isFinite(startsAt)
    && Number.isFinite(closesAt)
    && closesAt > startsAt
    && now >= startsAt - ROOM_LINK_OPEN_BEFORE_MS
    && now < closesAt;
}

const steps = ['Room', 'Requests', 'Event', 'Start'];
const roomTypes: Array<{ id: LiveRoomType; label: string; description: string }> = [
  { id: 'music', label: 'Music', description: 'Song search, manual song requests, and optional host menu items.' },
  { id: 'comedy', label: 'Comedy', description: 'Audience prompts and host-defined comedy requests. Free-only in this release.' },
  { id: 'service', label: 'Service', description: 'Host-defined requests for hospitality or service professionals. Free-only in this release.' },
  { id: 'general', label: 'General', description: 'A flexible request room for any professional or gig worker. Free-only in this release.' }
];

function createMenuItem(): RoomRequestMenuItem {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return { id: `menu-${suffix}`, title: '', description: '', targetType: 'custom' };
}

function eventLabel(event: LinkableEvent) {
  const startsAt = new Date(event.startsAt);
  const date = Number.isNaN(startsAt.getTime())
    ? 'Date unavailable'
    : new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(startsAt);
  const attendance = event.attendanceMode === 'walk_in'
    ? 'Walk-in'
    : event.attendanceMode === 'external_rsvp'
      ? 'RSVP elsewhere'
      : 'Tickets elsewhere';
  return `${event.title} · ${date} · ${attendance}`;
}

export default function PerformerRoomSetup({
  performerName,
  talentRole,
  performerEmailVerified,
  payoutReady,
  paymentMode,
  onStartSession
}: {
  performerName: string;
  talentRole: 'DJ' | 'Performer';
  performerEmailVerified: boolean;
  payoutReady: boolean;
  paymentMode: 'test' | 'live' | 'unavailable';
  onStartSession: (data: PerformerRoomSetupData) => Promise<void>;
}) {
  const [step, setStep] = useState(0);
  const [roomType, setRoomType] = useState<LiveRoomType>(talentRole === 'DJ' ? 'music' : 'general');
  const [requestMenu, setRequestMenu] = useState<RoomRequestMenuItem[]>([]);
  const [linkedEventId, setLinkedEventId] = useState<string | null>(null);
  const [linkableEvents, setLinkableEvents] = useState<LinkableEvent[]>([]);
  const [eventLoadStatus, setEventLoadStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [paymentsEnabled, setPaymentsEnabled] = useState(false);
  const [minimumTip, setMinimumTip] = useState(5);
  const [feeType, setFeeType] = useState<'talent' | 'patron'>('patron');
  const [searchScope, setSearchScope] = useState<'library' | 'catalog'>('library');
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const startAttemptRef = useRef<{ fingerprint: string; gigId: string } | null>(null);
  const moneyConfigured = paymentMode === 'test' || paymentMode === 'live';

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      setEventLoadStatus('loading');
      try {
        const response = await fetch('/api/talent/events', { cache: 'no-store', signal: controller.signal });
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error || 'Events unavailable.');
        const now = Date.now();
        const events = Array.isArray(data?.events) ? data.events : [];
        setLinkableEvents(events.filter((event: any): event is LinkableEvent => {
          if (!event || typeof event.id !== 'string' || typeof event.title !== 'string') return false;
          return event.status === 'published'
            && event.ticketingMode === 'external'
            && isEventWithinRoomLinkWindow(event, now);
        }));
        setEventLoadStatus('ready');
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setEventLoadStatus('error');
      }
    })();
    return () => controller.abort();
  }, []);

  const selectedEvent = useMemo(
    () => linkableEvents.find((event) => event.id === linkedEventId) ?? null,
    [linkableEvents, linkedEventId]
  );
  const pricingSummary = roomType !== 'music'
    ? 'Free requests and upvotes · all money actions off'
    : paymentsEnabled
      ? paymentMode === 'live'
        ? `Stripe live · $${minimumTip} minimum · ${feeType === 'patron' ? 'customer pays fee' : 'you absorb fee'}`
        : `Stripe test mode · $${minimumTip} minimum · ${feeType === 'patron' ? 'customer pays test fee' : 'you absorb test fee'}`
      : payoutReady
        ? (paymentMode === 'live' ? 'Free requests and upvotes · tips available' : 'Free requests and upvotes · test tips available')
        : 'Free requests and upvotes · money actions off';
  const requestSummary = roomType === 'music'
    ? searchScope === 'library'
      ? 'Customers search your synced library first and may type a manual request'
      : 'Customers can type a song request; you approve or deny it'
    : 'Customers choose from your menu or type a manual request; every request remains subject to your approval';

  const selectRoomType = (nextRoomType: LiveRoomType) => {
    setRoomType(nextRoomType);
    setStartError(null);
    if (nextRoomType !== 'music') setPaymentsEnabled(false);
  };

  const updateMenuItem = (id: string, field: 'title' | 'description', value: string) => {
    setRequestMenu((current) => current.map((item) => item.id === id ? { ...item, [field]: value } : item));
  };

  const submit = async () => {
    if (isStarting) return;
    if (requestMenu.some((item) => !item.title.trim() || !item.description.trim())) {
      setStartError('Every menu item needs both a title and a short description.');
      setStep(1);
      return;
    }
    const setup = {
      talentName: performerName,
      talentRole: roomType === 'music' && talentRole === 'DJ' ? 'DJ' as const : 'Performer' as const,
      roomType,
      requestMenu: requestMenu.map((item) => ({
        ...item,
        title: item.title.trim(),
        description: item.description.trim()
      })),
      linkedEventId,
      feeType,
      minimumTip: Math.max(5, minimumTip),
      paymentsEnabled: roomType === 'music' && paymentsEnabled,
      searchScope
    };
    const fingerprint = JSON.stringify(setup);
    if (!startAttemptRef.current || startAttemptRef.current.fingerprint !== fingerprint) {
      startAttemptRef.current = { fingerprint, gigId: globalThis.crypto.randomUUID() };
    }
    setIsStarting(true);
    setStartError(null);
    try {
      await onStartSession({ ...setup, gig_id: startAttemptRef.current.gigId });
    } catch (error) {
      setStartError(error instanceof Error ? error.message : 'The room could not be created. Retry uses the same safe room start.');
    } finally {
      setIsStarting(false);
    }
  };

  return (
    <section data-sway-performer-room-setup="true" className="mx-auto w-full max-w-2xl rounded-3xl border border-white/10 bg-slate-900 p-4 shadow-2xl sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.28em] text-cyan-300">Your live room</p>
          <h2 className="mt-1 font-display text-xl font-black uppercase text-white">{steps[step]}</h2>
        </div>
        <p className="font-mono text-[10px] font-black uppercase tracking-widest text-slate-400">Step {step + 1} of {steps.length}</p>
      </div>

      <div className="mt-4 grid grid-cols-4 gap-1" aria-label="Room setup progress">
        {steps.map((label, index) => (
          <div key={label} className="min-w-0">
            <div className={`h-1.5 rounded-full ${index <= step ? 'bg-fuchsia-500' : 'bg-slate-800'}`} />
            <p className={`mt-1 truncate text-center text-[8px] font-bold uppercase ${index === step ? 'text-white' : 'text-slate-600'}`}>{label}</p>
          </div>
        ))}
      </div>

      <div className="mt-5 min-h-[22rem]">
        {step === 0 ? (
          <div className="space-y-4">
            <div>
              <p className="text-xs font-bold text-cyan-300">{performerName}</p>
              <p className="mt-1 text-sm text-slate-400">Choose the room that matches what you are doing today.</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {roomTypes.map((option) => (
                <button key={option.id} type="button" onClick={() => selectRoomType(option.id)} className={`rounded-2xl border p-4 text-left ${roomType === option.id ? 'border-fuchsia-500 bg-fuchsia-500/15' : 'border-white/10 bg-slate-950'}`}>
                  <span className="font-black text-white">{option.label}</span>
                  <span className="mt-2 block text-xs leading-5 text-slate-400">{option.description}</span>
                </button>
              ))}
            </div>
            {roomType === 'music' ? (
              <div className="space-y-3 rounded-2xl border border-white/10 bg-slate-950 p-4">
                <p className="text-sm font-bold text-white">Music request pricing</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <button type="button" disabled={!payoutReady || !moneyConfigured || isStarting} onClick={() => setPaymentsEnabled(true)} className={`rounded-xl border p-3 text-left text-xs disabled:cursor-not-allowed disabled:opacity-50 ${paymentsEnabled ? 'border-cyan-400 bg-cyan-500/10 text-white' : 'border-white/10 text-slate-400'}`}>{paymentMode === 'live' ? 'Paid requests' : 'Test paid requests'}</button>
                  <button type="button" disabled={isStarting} onClick={() => setPaymentsEnabled(false)} className={`rounded-xl border p-3 text-left text-xs ${!paymentsEnabled ? 'border-cyan-400 bg-cyan-500/10 text-white' : 'border-white/10 text-slate-400'}`}>Free requests</button>
                </div>
                {paymentsEnabled ? (
                  <div>
                    <div className="flex justify-between text-sm font-bold text-white"><span>Minimum</span><span>${minimumTip}</span></div>
                    <input aria-label="Minimum request amount" type="range" min="5" max="25" value={minimumTip} onChange={(event) => setMinimumTip(Number(event.target.value))} className="mt-3 w-full accent-fuchsia-500" />
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <button type="button" onClick={() => setFeeType('patron')} className={`rounded-lg px-3 py-2 text-xs font-bold ${feeType === 'patron' ? 'bg-cyan-500 text-slate-950' : 'bg-slate-800 text-slate-300'}`}>Customer pays fee</button>
                      <button type="button" onClick={() => setFeeType('talent')} className={`rounded-lg px-3 py-2 text-xs font-bold ${feeType === 'talent' ? 'bg-cyan-500 text-slate-950' : 'bg-slate-800 text-slate-300'}`}>I absorb fee</button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="rounded-xl border border-emerald-400/20 bg-emerald-500/10 px-4 py-3 text-xs leading-5 text-emerald-100">This room is free-only. Requests and upvotes work; tips, paid requests, and paid boosts stay off.</p>
            )}
          </div>
        ) : step === 1 ? (
          <div className="space-y-4">
            {roomType === 'music' ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <button type="button" onClick={() => setSearchScope('library')} className={`rounded-2xl border p-4 text-left ${searchScope === 'library' ? 'border-fuchsia-500 bg-fuchsia-500/15' : 'border-white/10 bg-slate-950'}`}><span className="font-black text-white">My synced library first</span><span className="mt-2 block text-xs text-slate-400">Show your synced tracks first; manual song requests remain available.</span></button>
                <button type="button" onClick={() => setSearchScope('catalog')} className={`rounded-2xl border p-4 text-left ${searchScope === 'catalog' ? 'border-fuchsia-500 bg-fuchsia-500/15' : 'border-white/10 bg-slate-950'}`}><span className="font-black text-white">Open song requests</span><span className="mt-2 block text-xs text-slate-400">Customers type a song or artist for you to approve or deny.</span></button>
              </div>
            ) : null}
            <div className="flex items-start justify-between gap-3">
              <div><p className="text-sm font-black text-white">Optional quick-request menu</p><p className="mt-1 text-xs leading-5 text-slate-400">Add up to eight truthful, safe choices. No prices, alcohol, unsafe acts, or guaranteed fulfillment.</p></div>
              <button type="button" disabled={requestMenu.length >= 8} onClick={() => setRequestMenu((current) => [...current, createMenuItem()])} className="inline-flex min-h-10 shrink-0 items-center gap-2 rounded-xl bg-fuchsia-600 px-3 text-xs font-black text-white disabled:opacity-40"><Plus className="h-3.5 w-3.5" /> Add</button>
            </div>
            {requestMenu.length ? (
              <div className="space-y-3">
                {requestMenu.map((item, index) => (
                  <div key={item.id} className="rounded-2xl border border-white/10 bg-slate-950 p-4">
                    <div className="flex items-center justify-between gap-3"><p className="text-xs font-black text-cyan-200">Menu item {index + 1}</p><button type="button" aria-label={`Remove menu item ${index + 1}`} onClick={() => setRequestMenu((current) => current.filter((candidate) => candidate.id !== item.id))} className="rounded-lg p-2 text-slate-400 hover:bg-rose-500/10 hover:text-rose-200"><Trash2 className="h-4 w-4" /></button></div>
                    <label className="mt-2 block text-xs font-bold text-slate-300">Title<input maxLength={80} value={item.title} onChange={(event) => updateMenuItem(item.id, 'title', event.target.value)} placeholder="Example: Audience topic suggestion" className="mt-1 min-h-11 w-full rounded-xl border border-white/10 bg-slate-900 px-3 text-sm text-white outline-none focus:border-fuchsia-400" /></label>
                    <label className="mt-3 block text-xs font-bold text-slate-300">Description<textarea maxLength={240} value={item.description} onChange={(event) => updateMenuItem(item.id, 'description', event.target.value)} placeholder="Explain what the audience may request; the host still decides what happens." className="mt-1 min-h-20 w-full resize-y rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white outline-none focus:border-fuchsia-400" /></label>
                  </div>
                ))}
              </div>
            ) : <p className="rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-xs text-slate-500">No quick menu. Customers can still type a manual request.</p>}
          </div>
        ) : step === 2 ? (
          <div className="space-y-4">
            <div>
              <p className="text-sm font-black text-white">Link an event — optional</p>
              <p className="mt-1 text-xs leading-5 text-slate-400">A published walk-in, external RSVP, or external-ticket event becomes linkable 24 hours before it starts and stays linkable through its listed end, or for four hours when no end is listed. Native ticket sales remain outside this release.</p>
            </div>
            <select value={linkedEventId ?? ''} onChange={(event) => setLinkedEventId(event.target.value || null)} disabled={eventLoadStatus === 'loading'} className="min-h-12 w-full rounded-xl border border-white/10 bg-slate-950 px-3 text-sm text-white outline-none focus:border-fuchsia-400">
              <option value="">No linked event</option>
              {linkableEvents.map((event) => <option key={event.id} value={event.id}>{eventLabel(event)}</option>)}
            </select>
            {eventLoadStatus === 'loading' ? <p className="text-xs text-slate-500">Loading your published events…</p> : null}
            {eventLoadStatus === 'error' ? <p className="text-xs text-amber-200">Events could not load. You can still create an unlinked room.</p> : null}
            {eventLoadStatus === 'ready' && linkableEvents.length === 0 ? <p className="text-xs text-slate-500">No eligible published events yet. Create one in Events, or start this room without a link.</p> : null}
            <div className="space-y-2 pt-2">
              {[
                ['Host', performerName],
                ['Room', roomTypes.find((option) => option.id === roomType)?.label ?? roomType],
                ['Pricing', pricingSummary],
                ['Requests', `${requestSummary} · ${requestMenu.length} quick ${requestMenu.length === 1 ? 'choice' : 'choices'}`],
                ['Event', selectedEvent ? eventLabel(selectedEvent) : 'No linked event']
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl border border-white/10 bg-slate-950 p-4"><p className="text-[9px] font-black uppercase tracking-widest text-cyan-300">{label}</p><p className="mt-1 text-sm font-bold text-white">{value}</p></div>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex min-h-[22rem] flex-col items-center justify-center text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-300"><Check className="h-7 w-7" /></span>
            <h3 className="mt-4 font-display text-2xl font-black uppercase text-white">Ready to create</h3>
            <p className="mt-2 max-w-sm text-sm text-slate-400">Sway will persist these exact room rules, then create the audience link and QR.</p>
            {!performerEmailVerified ? <p className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">Verify your email before creating a room.</p> : null}
            {startError ? <p role="alert" aria-live="assertive" className="mt-4 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">{startError}</p> : null}
          </div>
        )}
      </div>

      <div className="mt-5 grid grid-cols-[auto_minmax(0,1fr)] gap-3">
        <button type="button" onClick={() => setStep((current) => Math.max(0, current - 1))} disabled={step === 0 || isStarting} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-white/10 bg-slate-950 px-4 text-sm font-bold text-slate-300 disabled:opacity-30"><ArrowLeft className="h-4 w-4" /> Back</button>
        {step < steps.length - 1 ? (
          <button type="button" onClick={() => setStep((current) => Math.min(steps.length - 1, current + 1))} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-fuchsia-600 px-4 text-sm font-black text-white">Next <ArrowRight className="h-4 w-4" /></button>
        ) : (
          <button type="button" onClick={() => { void submit(); }} disabled={!performerEmailVerified || isStarting} aria-busy={isStarting} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 text-sm font-black text-slate-950 disabled:bg-slate-800 disabled:text-slate-500"><Play className="h-4 w-4" /> {isStarting ? 'Creating room…' : 'Create room'}</button>
        )}
      </div>
    </section>
  );
}
