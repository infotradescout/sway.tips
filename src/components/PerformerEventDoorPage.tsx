import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent
} from 'react';
import jsQR from 'jsqr';
import {
  AlertCircle,
  ArrowLeft,
  Camera,
  CheckCircle2,
  Keyboard,
  Loader2,
  RefreshCw,
  RotateCcw,
  ScanLine,
  ShieldAlert,
  Ticket,
  Users,
  X
} from 'lucide-react';

export type PerformerDoorSummaryDto = {
  event: {
    id: string;
    title: string;
    startsAt?: string | null;
    endsAt?: string | null;
    timeZone?: string | null;
    status: string;
  };
  canCheckIn: boolean;
  admissionWindow: {
    status: 'scheduled' | 'open' | 'closed' | 'cancelled' | string;
    opensAt: string;
    closesAt: string;
  };
  counts: {
    sold: number;
    active: number;
    checkedIn: number;
    refundPending: number;
    refunded: number;
  };
};

export type DoorCheckInResponse = {
  result?: 'accepted' | 'already_accepted';
  acceptedAt?: string;
  releaseStatus?: 'recorded' | 'pending' | string;
  ticket?: {
    id: string;
    ordinal?: number | null;
    maskedBuyerLabel?: string | null;
  };
  error?: string;
};

type DoorSummaryResponse = {
  door?: PerformerDoorSummaryDto;
  error?: string;
};

type DoorResult = {
  tone: 'success' | 'duplicate' | 'error';
  heading: string;
  body: string;
  acceptedAt?: string | null;
  buyerLabel?: string | null;
};

export type PerformerEventDoorPageProps = {
  eventId: string;
};

function clientRequestId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

function talentLoginHref(eventId: string) {
  const redirect = `/talent/events/${encodeURIComponent(eventId)}/door`;
  return `/talent/login?${new URLSearchParams({ redirect }).toString()}`;
}

function formatAcceptedAt(value: string | null | undefined, timeZone?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || undefined,
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short'
    }).format(date);
  } catch {
    return date.toLocaleTimeString();
  }
}

function formatDoorTime(value: string, timeZone?: string | null) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'the scheduled time';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || undefined,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short'
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

function extractQrToken(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 4096) return null;
  if (trimmed.startsWith('SWAY-TICKET:')) {
    return trimmed.slice('SWAY-TICKET:'.length).trim() || null;
  }
  try {
    const url = new URL(trimmed);
    const queryToken = url.searchParams.get('qrToken') || url.searchParams.get('token');
    if (queryToken?.trim()) return queryToken.trim();
    if (url.hash.length > 1) return decodeURIComponent(url.hash.slice(1)).trim() || null;
  } catch {
    // A raw opaque token is the preferred scanner payload.
  }
  return trimmed;
}

function resultTone(result: DoorResult) {
  if (result.tone === 'success') {
    return {
      panel: 'border-emerald-400/30 bg-emerald-500/15 text-emerald-50',
      icon: <CheckCircle2 className="h-10 w-10" aria-hidden="true" />
    };
  }
  if (result.tone === 'duplicate') {
    return {
      panel: 'border-amber-300/30 bg-amber-300/15 text-amber-50',
      icon: <RotateCcw className="h-10 w-10" aria-hidden="true" />
    };
  }
  return {
    panel: 'border-rose-400/30 bg-rose-500/15 text-rose-50',
    icon: <ShieldAlert className="h-10 w-10" aria-hidden="true" />
  };
}

export default function PerformerEventDoorPage({ eventId }: PerformerEventDoorPageProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameRef = useRef<number | null>(null);
  const cameraRunningRef = useRef(false);
  const scanLockedRef = useRef(false);
  const checkInPendingRef = useRef(false);
  const lastScanAtRef = useRef(0);

  const [door, setDoor] = useState<PerformerDoorSummaryDto | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [cameraStatus, setCameraStatus] = useState<'idle' | 'starting' | 'active' | 'error'>('idle');
  const [cameraMessage, setCameraMessage] = useState<string | null>(null);
  const [manualCode, setManualCode] = useState('');
  const [checkInPending, setCheckInPending] = useState(false);
  const [result, setResult] = useState<DoorResult | null>(null);

  const stopCamera = useCallback(() => {
    cameraRunningRef.current = false;
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraStatus('idle');
  }, []);

  const loadDoor = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(`/api/talent/events/${encodeURIComponent(eventId)}/door`, {
        cache: 'no-store',
        signal
      });
      const data = await response.json().catch(() => null) as DoorSummaryResponse | null;
      if (response.status === 401) {
        window.location.replace(talentLoginHref(eventId));
        return;
      }
      if (!response.ok || !data?.door) {
        throw new Error(data?.error || 'Sway could not load this event door.');
      }
      setDoor(data.door);
      setStatus('ready');
      setMessage(null);
      document.title = `${data.door.event.title} door | Sway`;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'Sway could not load this event door.');
    }
  }, [eventId]);

  const refreshDoorCounts = useCallback(async () => {
    try {
      const response = await fetch(`/api/talent/events/${encodeURIComponent(eventId)}/door`, {
        cache: 'no-store'
      });
      const data = await response.json().catch(() => null) as DoorSummaryResponse | null;
      if (response.ok && data?.door) setDoor(data.door);
    } catch {
      // A confirmed admission result remains authoritative even when this
      // best-effort summary refresh fails.
    }
  }, [eventId]);

  useEffect(() => {
    const controller = new AbortController();
    void loadDoor(controller.signal);
    return () => {
      controller.abort();
      stopCamera();
    };
  }, [loadDoor, stopCamera]);

  useEffect(() => {
    if (status !== 'ready' || !door) return;
    const refreshWhenUsable = () => {
      if (document.visibilityState === 'visible' && navigator.onLine !== false) {
        void refreshDoorCounts();
      }
    };
    const interval = window.setInterval(refreshWhenUsable, 15_000);
    const boundaries = [
      new Date(door.admissionWindow.opensAt).getTime(),
      new Date(door.admissionWindow.closesAt).getTime()
    ].filter((value) => Number.isFinite(value) && value > Date.now());
    const nextBoundary = boundaries.length ? Math.min(...boundaries) : null;
    const boundaryTimer = nextBoundary === null
      ? null
      : window.setTimeout(refreshWhenUsable, Math.min(2_147_000_000, nextBoundary - Date.now() + 250));

    document.addEventListener('visibilitychange', refreshWhenUsable);
    window.addEventListener('online', refreshWhenUsable);
    return () => {
      window.clearInterval(interval);
      if (boundaryTimer !== null) window.clearTimeout(boundaryTimer);
      document.removeEventListener('visibilitychange', refreshWhenUsable);
      window.removeEventListener('online', refreshWhenUsable);
    };
  }, [
    door?.admissionWindow.closesAt,
    door?.admissionWindow.opensAt,
    refreshDoorCounts,
    status
  ]);

  const submitAdmission = async (
    input: { qrToken: string } | { manualCode: string }
  ) => {
    if (checkInPendingRef.current) return;
    if (navigator.onLine === false) {
      scanLockedRef.current = true;
      stopCamera();
      setResult({
        tone: 'error',
        heading: 'No check-in recorded',
        body: 'This device is offline. Reconnect and scan or enter the code again. Sway never queues offline admission.'
      });
      return;
    }

    checkInPendingRef.current = true;
    setCheckInPending(true);
    setResult(null);

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(`/api/talent/events/${encodeURIComponent(eventId)}/check-ins`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          ...input,
          clientRequestId: clientRequestId()
        })
      });
      const data = await response.json().catch(() => null) as DoorCheckInResponse | null;
      if (response.status === 401) {
        window.location.replace(talentLoginHref(eventId));
        return;
      }
      if (!response.ok) {
        throw new Error(data?.error || 'This ticket could not be checked in.');
      }

      const acceptedAt = formatAcceptedAt(data?.acceptedAt, door?.event.timeZone);
      const buyerLabel = data?.ticket?.maskedBuyerLabel || null;
      if (data?.result === 'already_accepted') {
        setResult({
          tone: 'duplicate',
          heading: 'Already checked in',
          body: acceptedAt
            ? `This ticket was already accepted at ${acceptedAt}. No second admission or transfer was recorded.`
            : 'This ticket was already accepted. No second admission or transfer was recorded.',
          acceptedAt: data.acceptedAt || null,
          buyerLabel
        });
      } else if (data?.result === 'accepted') {
        setResult({
          tone: 'success',
          heading: 'Entry accepted',
          body: 'Sway recorded this ticket as used. This confirms admission, not completion of a bank payout.',
          acceptedAt: data.acceptedAt || null,
          buyerLabel
        });
      } else {
        throw new Error('The server did not confirm an admission outcome.');
      }
      setManualCode('');
      void refreshDoorCounts();
    } catch (error) {
      setResult({
        tone: 'error',
        heading: 'No check-in recorded',
        body: error instanceof DOMException && error.name === 'AbortError'
          ? 'The request timed out, so the outcome is unknown. Reconnect and scan again; Sway will not record a second admission or transfer.'
          : error instanceof Error
            ? error.message
            : 'Sway did not confirm admission. Scan or enter the code again.'
      });
    } finally {
      window.clearTimeout(timeout);
      stopCamera();
      checkInPendingRef.current = false;
      setCheckInPending(false);
    }
  };

  const startCamera = async () => {
    if (cameraStatus === 'starting' || cameraStatus === 'active') return;
    setCameraStatus('starting');
    setCameraMessage(null);
    setResult(null);
    scanLockedRef.current = false;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false
      });
      streamRef.current = stream;
      cameraRunningRef.current = true;
      const video = videoRef.current;
      if (!video) throw new Error('Camera preview is unavailable.');
      video.srcObject = stream;
      await video.play();
      setCameraStatus('active');

      const tick = (timestamp = performance.now()) => {
        if (!cameraRunningRef.current) return;
        const currentVideo = videoRef.current;
        const canvas = canvasRef.current;
        if (
          !scanLockedRef.current
          && !checkInPendingRef.current
          && currentVideo
          && canvas
          && currentVideo.readyState === currentVideo.HAVE_ENOUGH_DATA
          && timestamp - lastScanAtRef.current >= 100
        ) {
          lastScanAtRef.current = timestamp;
          const scale = Math.min(1, 720 / Math.max(1, currentVideo.videoWidth));
          canvas.width = Math.max(1, Math.round(currentVideo.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(currentVideo.videoHeight * scale));
          const context = canvas.getContext('2d', { willReadFrequently: true });
          if (context) {
            context.drawImage(currentVideo, 0, 0, canvas.width, canvas.height);
            const image = context.getImageData(0, 0, canvas.width, canvas.height);
            const decoded = jsQR(image.data, image.width, image.height);
            if (decoded?.data) {
              const qrToken = extractQrToken(decoded.data);
              if (qrToken) {
                scanLockedRef.current = true;
                void submitAdmission({ qrToken });
              }
            }
          }
        }
        if (cameraRunningRef.current) {
          frameRef.current = window.requestAnimationFrame(tick);
        }
      };
      tick();
    } catch (error) {
      stopCamera();
      setCameraStatus('error');
      setCameraMessage(
        error instanceof Error
          ? error.message
          : 'Camera access was denied or is unavailable on this device.'
      );
    }
  };

  const submitManualCode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!door?.canCheckIn || checkInPending || !manualCode.trim()) return;
    scanLockedRef.current = true;
    void submitAdmission({ manualCode: manualCode.trim().toUpperCase() });
  };

  const resetForNext = () => {
    setResult(null);
    setManualCode('');
    scanLockedRef.current = false;
    window.setTimeout(() => {
      if (door?.canCheckIn) void startCamera();
    }, 0);
  };

  if (status === 'loading') {
    return (
      <div className="grid min-h-[var(--sway-viewport-height,100vh)] place-items-center bg-[#05060a] text-cyan-200">
        <Loader2 className="h-7 w-7 animate-spin" aria-label="Loading event door" />
      </div>
    );
  }

  if (status === 'error' || !door) {
    return (
      <main className="grid min-h-[var(--sway-viewport-height,100vh)] place-items-center bg-[#05060a] px-4 text-center text-slate-100">
        <div className="max-w-md">
          <AlertCircle className="mx-auto h-9 w-9 text-rose-300" aria-hidden="true" />
          <h1 className="mt-4 text-2xl font-black">Event door unavailable</h1>
          <p className="mt-2 text-sm leading-6 text-slate-400">{message}</p>
          <button
            type="button"
            onClick={() => { setStatus('loading'); void loadDoor(); }}
            className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-xl bg-white px-4 text-sm font-black text-slate-950"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Try again
          </button>
        </div>
      </main>
    );
  }

  const tone = result ? resultTone(result) : null;

  return (
    <main className="min-h-[var(--sway-viewport-height,100vh)] bg-[#05060a] px-3 pb-[calc(var(--sway-safe-bottom)+1rem)] pt-3 text-slate-100 sm:px-4 sm:py-5">
      <div className="mx-auto max-w-2xl">
        <header className="rounded-2xl border border-white/10 bg-slate-950/85 p-4 shadow-xl">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <a href="/talent" className="inline-flex min-h-9 items-center gap-2 text-xs font-black text-slate-400 hover:text-white">
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                Performer console
              </a>
              <p className="mt-3 text-[10px] font-black uppercase tracking-[0.24em] text-cyan-200">Ticket door</p>
              <h1 className="mt-1 truncate font-display text-xl font-black text-white sm:text-2xl">{door.event.title}</h1>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-2">
              <span className={`rounded-full border px-3 py-1 text-[9px] font-black uppercase tracking-wider ${
                door.canCheckIn
                  ? 'border-emerald-400/25 bg-emerald-500/10 text-emerald-100'
                  : 'border-rose-400/25 bg-rose-500/10 text-rose-100'
              }`}>
                {door.canCheckIn
                  ? 'Door open'
                  : door.admissionWindow.status === 'scheduled'
                    ? 'Not open yet'
                    : door.admissionWindow.status === 'cancelled'
                      ? 'Event cancelled'
                      : 'Door closed'}
              </span>
              <button
                type="button"
                onClick={() => { void refreshDoorCounts(); }}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 text-[10px] font-black text-slate-300"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                Refresh
              </button>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-xl border border-white/10 bg-white/[0.035] p-3">
              <Ticket className="mx-auto h-4 w-4 text-fuchsia-200" aria-hidden="true" />
              <p className="mt-1 font-mono text-lg font-black text-white">{door.counts.sold}</p>
              <p className="text-[8px] font-black uppercase tracking-wider text-slate-500">Sold</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[0.035] p-3">
              <Users className="mx-auto h-4 w-4 text-cyan-200" aria-hidden="true" />
              <p className="mt-1 font-mono text-lg font-black text-white">{door.counts.checkedIn}</p>
              <p className="text-[8px] font-black uppercase tracking-wider text-slate-500">Checked in</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[0.035] p-3">
              <ScanLine className="mx-auto h-4 w-4 text-emerald-200" aria-hidden="true" />
              <p className="mt-1 font-mono text-lg font-black text-white">{door.counts.active}</p>
              <p className="text-[8px] font-black uppercase tracking-wider text-slate-500">Awaiting entry</p>
            </div>
          </div>
        </header>

        {!door.canCheckIn ? (
          <div className="mt-3 rounded-2xl border border-rose-400/25 bg-rose-500/10 p-4 text-sm leading-6 text-rose-100">
            {door.admissionWindow.status === 'scheduled'
              ? `Check-in opens ${formatDoorTime(door.admissionWindow.opensAt, door.event.timeZone)}.`
              : `Check-in closed ${formatDoorTime(door.admissionWindow.closesAt, door.event.timeZone)}.`}
            {' '}The server will reject QR and manual-code attempts outside this window.
          </div>
        ) : null}

        {result && tone ? (
          <section
            role="status"
            className={`mt-3 rounded-3xl border p-6 text-center shadow-2xl ${tone.panel}`}
          >
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-current/20 bg-black/10">
              {tone.icon}
            </div>
            <h2 className="mt-4 text-2xl font-black">{result.heading}</h2>
            {result.buyerLabel ? <p className="mt-2 text-sm font-black">{result.buyerLabel}</p> : null}
            <p className="mt-3 text-sm leading-6 opacity-85">{result.body}</p>
            <button
              type="button"
              onClick={resetForNext}
              className="mt-5 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-white px-5 text-sm font-black text-slate-950"
            >
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              Scan next ticket
            </button>
          </section>
        ) : (
          <>
            <section className="relative mt-3 overflow-hidden rounded-3xl border border-white/10 bg-black shadow-2xl">
              <div className="relative aspect-[3/4] max-h-[62vh] min-h-[24rem] w-full bg-slate-950 sm:aspect-video sm:min-h-0">
                <video ref={videoRef} muted playsInline className="h-full w-full object-cover" />
                <canvas ref={canvasRef} className="hidden" />
                {cameraStatus === 'active' ? (
                  <div className="pointer-events-none absolute inset-0 grid place-items-center">
                    <div className="glow-fuchsia h-56 w-56 rounded-3xl border-2 border-fuchsia-300/80" />
                  </div>
                ) : (
                  <div className="absolute inset-0 grid place-items-center p-6 text-center">
                    <div>
                      <Camera className="mx-auto h-12 w-12 text-slate-600" aria-hidden="true" />
                      <p className="mt-4 text-sm font-black text-white">
                        {cameraStatus === 'starting' ? 'Opening camera…' : 'Scan a Sway ticket'}
                      </p>
                      <p className="mt-2 text-xs leading-5 text-slate-500">
                        Admission is recorded only after the server confirms the ticket.
                      </p>
                      <button
                        type="button"
                        onClick={() => { void startCamera(); }}
                        disabled={!door.canCheckIn || cameraStatus === 'starting'}
                        className="mt-5 inline-flex min-h-12 items-center gap-2 rounded-xl bg-fuchsia-600 px-5 text-sm font-black text-white disabled:opacity-50"
                      >
                        {cameraStatus === 'starting'
                          ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                          : <ScanLine className="h-4 w-4" aria-hidden="true" />}
                        {cameraStatus === 'starting' ? 'Opening camera…' : 'Start scanner'}
                      </button>
                    </div>
                  </div>
                )}
                {cameraStatus === 'active' ? (
                  <button
                    type="button"
                    onClick={stopCamera}
                    aria-label="Stop camera"
                    className="absolute right-3 top-3 inline-flex h-11 w-11 items-center justify-center rounded-full border border-white/15 bg-black/70 text-white"
                  >
                    <X className="h-5 w-5" aria-hidden="true" />
                  </button>
                ) : null}
                {checkInPending ? (
                  <div className="absolute inset-0 grid place-items-center bg-black/75">
                    <div className="text-center">
                      <Loader2 className="mx-auto h-8 w-8 animate-spin text-cyan-200" aria-hidden="true" />
                      <p className="mt-3 text-sm font-black text-white">Confirming with Sway…</p>
                    </div>
                  </div>
                ) : null}
              </div>
            </section>

            {cameraMessage ? (
              <div role="status" className="mt-3 rounded-xl border border-rose-400/25 bg-rose-500/10 p-3 text-xs leading-5 text-rose-100">
                {cameraMessage}
              </div>
            ) : null}

            <form onSubmit={submitManualCode} className="mt-3 rounded-2xl border border-white/10 bg-slate-950/85 p-4">
              <p className="inline-flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.22em] text-slate-400">
                <Keyboard className="h-4 w-4" aria-hidden="true" />
                Manual check-in
              </p>
              <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <input
                  value={manualCode}
                  onChange={(event) => setManualCode(event.target.value.toUpperCase())}
                  disabled={!door.canCheckIn || checkInPending}
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="Enter admission code"
                  aria-label="Manual admission code"
                  className="min-h-12 w-full rounded-xl border border-white/10 bg-slate-900 px-4 font-mono text-sm font-black uppercase tracking-widest text-white outline-none focus:border-cyan-400"
                />
                <button
                  type="submit"
                  disabled={!door.canCheckIn || checkInPending || !manualCode.trim()}
                  className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-cyan-400 px-5 text-sm font-black text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {checkInPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                  Check in
                </button>
              </div>
              <p className="mt-3 text-[11px] leading-5 text-slate-500">
                If this device loses its connection, no admission is queued. Reconnect and try again.
              </p>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
