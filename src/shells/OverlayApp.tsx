import { useEffect, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Flame, Music, RotateCw, Rocket } from 'lucide-react';
import { QRCodeCanvas } from 'qrcode.react';
import { BackendState } from '../types';
import { DemoModeBanner, isDemoModeEnabled } from '../demo-mode';
import { useSwayState } from './shared';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function resolveOverlayGigId(pathname: string) {
  const parts = pathname.split('/').filter(Boolean);
  return parts[0] === 'overlay' && UUID_PATTERN.test(parts[1] || '') ? parts[1] : null;
}

function isOverlayTransparent() {
  return new URLSearchParams(window.location.search).get('transparent') === '1';
}

function resolveRoomLink(gigId: string) {
  if (typeof window === 'undefined') return `/g/${gigId}`;
  return new URL(`/g/${gigId}`, window.location.origin).toString();
}

// An OBS/streaming browser source needs a transparent background at all
// times when compositing over a camera feed -- but the default rendering
// (no ?transparent=1) is a full branded frame, since this view is also
// meant to work as the *entire* picture when captured directly from a
// phone or tablet screen.
function OverlayShell({
  transparent,
  children
}: {
  transparent: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`absolute inset-0 overflow-hidden select-none text-white ${transparent ? 'bg-transparent' : 'bg-slate-950'}`}>
      {children}
    </div>
  );
}

function OverlayCaption({ text, transparent }: { text: string; transparent: boolean }) {
  return (
    <OverlayShell transparent={transparent}>
      <div className="p-4">
        <div className="flex items-center justify-between border-b border-fuchsia-500/30 pb-2 mb-3">
          <span className="font-display text-xs font-black tracking-widest text-fuchsia-400">SWAY LIVE ROOM</span>
        </div>
        <div className="text-center py-4 bg-slate-950/40 rounded border border-white/5 text-[10px] text-slate-500 font-mono">
          {text}
        </div>
      </div>
    </OverlayShell>
  );
}

// Mobile/tablet capture sources (screen mirroring, a phone propped up as a
// camera) need a widescreen frame -- a portrait phone screen looks broken
// once composited into a 16:9 stream. This blocks the stage view until the
// device is rotated, but only on genuinely narrow/handheld viewports; a
// desktop OBS browser source (usually a fixed wide logical size) never
// matches this query.
function RotatePrompt() {
  return (
    <div className="fixed inset-0 z-50 hidden items-center justify-center bg-slate-950 p-6 text-center [@media(max-width:900px)_and_(orientation:portrait)]:flex">
      <div>
        <RotateCw className="mx-auto h-8 w-8 animate-spin text-fuchsia-400" style={{ animationDuration: '3s' }} />
        <p className="mt-4 font-display text-sm font-black uppercase tracking-widest text-white">Rotate to landscape</p>
        <p className="mt-2 max-w-xs text-xs text-slate-400">This stage view is built for widescreen streaming. Turn your device sideways to continue.</p>
      </div>
    </div>
  );
}

export default function OverlayApp() {
  const routeGigId = resolveOverlayGigId(window.location.pathname);
  const transparent = isOverlayTransparent();
  const { bState, isLoading, roomLookup } = useSwayState({
    statePath: routeGigId ? `/api/state/${routeGigId}` : null
  });
  // Hooks must run on every render regardless of the fail-closed status
  // checked below, so the now-playing lookup lives inside useLyrics
  // (defined after this component, past the fail-closed guards) instead
  // of being derived from the raw room state up here.
  const { lyricsOpen, setLyricsOpen, lyricsStatus, lyricsText, nowPlaying } = useLyrics(bState);

  if (isLoading) return null;
  if (roomLookup.status === 'ended') return <OverlayCaption text="Live room ended" transparent={transparent} />;
  if (roomLookup.status === 'error') return <OverlayCaption text="Reconnecting to live room..." transparent={transparent} />;
  if (!routeGigId) return <OverlayCaption text="This overlay link is missing a room ID" transparent={transparent} />;
  if (roomLookup.status !== 'active') return <OverlayCaption text="Waiting for this room to go live..." transparent={transparent} />;

  const visible = bState.requests.filter((r) => !r.hidden && !r.removed && !r.shadowBanned);
  const upNextQueue = visible
    .filter((r) => r.status === 'approved')
    .slice()
    .sort((a, b) => b.amount - a.amount);
  const recentTips = visible
    .filter((r) => r.type === 'tip')
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 5);
  const recentBoosts = visible
    .flatMap((r) => r.boosts.map((boost) => ({ ...boost, requestTitle: r.title })))
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 5);
  const roomLink = resolveRoomLink(routeGigId);
  const roomPath = `/g/${routeGigId}`;

  return (
    <>
      <RotatePrompt />
      <OverlayShell transparent={transparent}>
        <div className={transparent
          ? 'flex h-full flex-col gap-3 p-4 lg:flex-row lg:gap-5'
          : 'grid h-full grid-cols-[minmax(0,1fr)_minmax(280px,0.42fr)] gap-5 overflow-hidden bg-[linear-gradient(135deg,#020617_0%,#090716_48%,#111827_100%)] p-6'}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-hidden">
            <div className="flex items-center justify-between border-b border-fuchsia-500/30 pb-2">
              <span className="font-display text-xs font-black tracking-[0.28em] text-fuchsia-300">SWAY LIVE ROOM</span>
              {isDemoModeEnabled() ? (
                <div aria-label="Demo data">
                  <DemoModeBanner compact />
                </div>
              ) : (
                <span className="text-[9px] font-mono text-cyan-400 animate-pulse">LIVE GIG FEED</span>
              )}
            </div>

            {nowPlaying ? (
              <div className={`rounded-2xl border border-cyan-500/40 bg-slate-950/90 ${transparent ? 'p-3' : 'p-5 shadow-[0_0_42px_rgba(34,211,238,0.14)]'}`}>
                <div className="flex items-center gap-3">
                  {nowPlaying.albumArt ? (
                    <img src={nowPlaying.albumArt} alt="" className={`${transparent ? 'h-14 w-14' : 'h-24 w-24'} shrink-0 rounded-xl border border-white/10 object-cover`} />
                  ) : (
                    <div className={`${transparent ? 'h-14 w-14' : 'h-24 w-24'} flex shrink-0 items-center justify-center rounded-xl border border-white/10 bg-gradient-to-tr from-fuchsia-600/30 to-blue-600/30`}>
                      <Music className={`${transparent ? 'h-6 w-6' : 'h-10 w-10'} text-cyan-300`} />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] font-mono tracking-widest text-cyan-300 uppercase">Now Playing</div>
                    <div className={`truncate font-black text-white ${transparent ? 'text-base' : 'text-5xl leading-tight'}`}>{nowPlaying.title}</div>
                    {nowPlaying.subtitle && <div className={`truncate text-slate-300 ${transparent ? 'text-xs' : 'text-xl font-bold'}`}>{nowPlaying.subtitle}</div>}
                  </div>
                  {transparent ? (
                    <button
                      type="button"
                      onClick={() => setLyricsOpen((open) => !open)}
                      className="shrink-0 rounded-lg border border-white/10 bg-slate-900 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-300"
                    >
                      {lyricsOpen ? 'Hide lyrics' : 'Lyrics'}
                    </button>
                  ) : null}
                </div>
                {transparent && lyricsOpen && (
                  <div className="mt-2 max-h-32 overflow-y-auto whitespace-pre-line rounded-lg border border-white/10 bg-slate-950/70 p-2.5 text-xs leading-relaxed text-slate-300">
                    {lyricsStatus === 'loading' && 'Looking up lyrics...'}
                    {lyricsStatus === 'not-found' && 'No lyrics found for this song.'}
                    {lyricsStatus === 'found' && lyricsText}
                  </div>
                )}
              </div>
            ) : (
              <div className={`rounded-2xl border border-white/5 bg-slate-950/40 text-center font-mono text-slate-500 ${transparent ? 'p-4 text-[10px]' : 'p-10 text-xl'}`}>
                Waiting for the next song...
              </div>
            )}

            <div className="min-w-0 flex-1 space-y-2 overflow-hidden">
              {upNextQueue.length > 0 && (
                <div className={`${transparent ? 'text-[9px]' : 'text-sm'} font-mono tracking-widest text-fuchsia-300 uppercase`}>Up Next</div>
              )}
              {upNextQueue.slice(0, transparent ? 5 : 4).map((req, idx) => (
                <div
                  key={req.id}
                  className={`flex items-center justify-between rounded-xl border transition-transform ${transparent ? 'p-2 text-xs' : 'p-4 text-2xl'} ${
                    idx === 0 ? 'bg-slate-950/90 border-fuchsia-500/50 glow-fuchsia text-white' : 'bg-slate-900/80 border-white/5'
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={`rounded px-2 py-1 font-mono font-bold ${transparent ? 'text-[10px]' : 'text-base'} ${idx === 0 ? 'bg-fuchsia-500/20 text-fuchsia-300' : 'bg-slate-800 text-slate-400'}`}>
                      #{idx + 1}
                    </span>
                    <span className="truncate font-bold">{req.title}</span>
                  </div>
                  <span className="ml-2 font-mono font-bold text-cyan-400">${req.amount}</span>
                </div>
              ))}
              {upNextQueue.length === 0 && (
                <div className={`rounded-xl border border-white/5 bg-slate-950/40 text-center font-mono text-slate-500 ${transparent ? 'py-4 text-[10px]' : 'py-10 text-xl'}`}>
                  Waiting for requests...
                </div>
              )}
            </div>
          </div>

          <div className={transparent ? 'flex w-full flex-col gap-3 lg:w-64 lg:shrink-0' : 'grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-4'}>
            {!transparent ? (
              <div className="rounded-3xl border border-white/15 bg-white p-4 text-slate-950 shadow-[0_0_60px_rgba(217,70,239,0.28)]">
                <div className="rounded-2xl border-4 border-slate-950 p-3">
                  <QRCodeCanvas
                    value={roomLink}
                    size={300}
                    level="H"
                    bgColor="#ffffff"
                    fgColor="#000000"
                    marginSize={4}
                    className="h-auto w-full"
                    aria-label="Scan to open this Sway live room"
                  />
                </div>
                <div className="mt-4 text-center">
                  <p className="font-display text-4xl font-black uppercase tracking-wide">Scan</p>
                  <p className="text-xl font-black uppercase tracking-wide text-fuchsia-700">Request / Tip / Boost</p>
                  <p className="mt-2 break-all font-mono text-sm font-black text-slate-700">{roomPath}</p>
                </div>
              </div>
            ) : null}

            <div className={transparent ? 'contents' : 'grid min-h-0 grid-rows-2 gap-3 overflow-hidden'}>
            <div className="rounded-xl border border-white/10 bg-slate-950/70 p-3">
              <div className="flex items-center gap-1.5 text-[9px] font-mono uppercase tracking-widest text-emerald-400">
                <Flame className="h-3 w-3" /> Tips flowing in
              </div>
              <div className="mt-2 space-y-1.5">
                <AnimatePresence initial={false}>
                  {recentTips.map((tip) => (
                    <motion.div
                      key={tip.id}
                      initial={{ opacity: 0, x: 12 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0 }}
                      className="flex items-center justify-between rounded-lg bg-slate-900/80 border border-emerald-500/10 px-2 py-1.5 text-xs"
                    >
                      <span className="truncate text-slate-300">{tip.senderName || 'A fan'}</span>
                      <span className="font-mono font-bold text-emerald-300">${tip.amount}</span>
                    </motion.div>
                  ))}
                </AnimatePresence>
                {recentTips.length === 0 && (
                  <div className="py-2 text-center text-[10px] font-mono text-slate-500">No tips yet</div>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-white/10 bg-slate-950/70 p-3">
              <div className="flex items-center gap-1.5 text-[9px] font-mono uppercase tracking-widest text-fuchsia-400">
                <Rocket className="h-3 w-3" /> Boosts
              </div>
              <div className="mt-2 space-y-1.5">
                <AnimatePresence initial={false}>
                  {recentBoosts.map((boost) => (
                    <motion.div
                      key={boost.id}
                      initial={{ opacity: 0, x: 12 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0 }}
                      className="rounded-lg bg-slate-900/80 border border-fuchsia-500/10 px-2 py-1.5 text-xs"
                    >
                      <div className="flex items-center justify-between">
                        <span className="truncate text-slate-300">{boost.patronName || 'A fan'}</span>
                        <span className="font-mono font-bold text-fuchsia-300">+${boost.amount}</span>
                      </div>
                      <div className="truncate text-[10px] text-slate-500">boosted {boost.requestTitle}</div>
                    </motion.div>
                  ))}
                </AnimatePresence>
                {recentBoosts.length === 0 && (
                  <div className="py-2 text-center text-[10px] font-mono text-slate-500">No boosts yet</div>
                )}
              </div>
            </div>
            </div>
          </div>
        </div>
      </OverlayShell>
    </>
  );
}

function useLyrics(bState: BackendState) {
  const nowPlaying = bState.requests
    .filter((r) => !r.hidden && !r.removed && !r.shadowBanned)
    .filter((r) => r.status === 'fulfilled' && r.type !== 'tip')
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] ?? null;

  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [lyricsStatus, setLyricsStatus] = useState<'idle' | 'loading' | 'found' | 'not-found'>('idle');
  const [lyricsText, setLyricsText] = useState<string | null>(null);

  useEffect(() => {
    setLyricsOpen(false);
    setLyricsStatus('idle');
    setLyricsText(null);
  }, [nowPlaying?.id]);

  useEffect(() => {
    if (!lyricsOpen || !nowPlaying) return;
    let cancelled = false;
    setLyricsStatus('loading');
    const params = new URLSearchParams({ title: nowPlaying.title, artist: nowPlaying.subtitle || '' });
    fetch(`/api/lyrics?${params}`)
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return;
        if (data?.found && (data.plainLyrics || data.instrumental)) {
          setLyricsText(data.instrumental ? 'Instrumental — no lyrics.' : data.plainLyrics);
          setLyricsStatus('found');
        } else {
          setLyricsStatus('not-found');
        }
      })
      .catch(() => {
        if (!cancelled) setLyricsStatus('not-found');
      });
    return () => {
      cancelled = true;
    };
  }, [lyricsOpen, nowPlaying]);

  return { lyricsOpen, setLyricsOpen, lyricsStatus, lyricsText, nowPlaying };
}
