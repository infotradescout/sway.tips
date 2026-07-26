import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock,
  Copy,
  Loader2,
  MapPin,
  RefreshCw,
  ShieldCheck,
  Ticket
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';

export type TicketPassDto = {
  id: string;
  status: 'active' | 'checked_in' | 'refund_pending' | 'refunded' | 'disputed' | 'cancelled' | string;
  settlementStatus?: 'held' | 'release_pending' | 'released' | 'refund_pending' | 'refunded' | 'disputed' | 'voided' | string;
  ticketNumber?: string | null;
  qrToken?: string | null;
  qrExpiresAt?: string | null;
  manualCode?: string | null;
  admissionStatus?: 'scheduled' | 'open' | 'closed' | 'cancelled' | string;
  admissionOpensAt?: string | null;
  admissionClosesAt?: string | null;
  allInPriceCents?: number | null;
  currency?: 'USD' | string;
  termsVersion?: string | null;
  termsHash?: string | null;
  refundGraceMinutes?: number | null;
  checkedInAt?: string | null;
  refundRequestedAt?: string | null;
  refundedAt?: string | null;
  event: {
    id: string;
    title: string;
    eventPath?: string | null;
    startsAt: string;
    endsAt?: string | null;
    timeZone: string;
    locationName?: string | null;
    locationAddress?: string | null;
    city?: string | null;
    locationIsTba?: boolean;
    performerName?: string | null;
  };
};

type TicketPassResponse = {
  ticket?: TicketPassDto;
  error?: string;
};

export type TicketPassPageProps = {
  ticketId: string;
};

function loginHref(ticketId: string) {
  const next = `/tickets/${encodeURIComponent(ticketId)}`;
  return `/account/login?${new URLSearchParams({ next }).toString()}`;
}

function formatMoney(cents: number | null | undefined, currency = 'USD') {
  if (!Number.isFinite(cents)) return null;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency
  }).format(Number(cents) / 100);
}

function formatDateTime(value: string | null | undefined, timeZone?: string) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short'
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

function locationLabel(ticket: TicketPassDto) {
  if (ticket.event.locationIsTba) return 'Location TBA';
  return [ticket.event.locationName, ticket.event.city].filter(Boolean).join(' · ') || 'Location not listed';
}

function passState(ticket: TicketPassDto) {
  if (ticket.status === 'active') {
    if (ticket.admissionStatus === 'open') {
      return {
        heading: 'Ready for entry',
        body: 'Show this rotating QR to the performer. It can be accepted once.',
        tone: 'border-emerald-400/25 bg-emerald-500/10 text-emerald-100',
        valid: true
      };
    }
    if (ticket.admissionStatus === 'scheduled') {
      return {
        heading: 'Ticket confirmed',
        body: `Your admission code will appear when entry opens${
          formatDateTime(ticket.admissionOpensAt, ticket.event.timeZone)
            ? ` at ${formatDateTime(ticket.admissionOpensAt, ticket.event.timeZone)}`
            : ''
        }.`,
        tone: 'border-cyan-400/25 bg-cyan-500/10 text-cyan-100',
        valid: false
      };
    }
    if (ticket.admissionStatus === 'closed' || ticket.admissionStatus === 'cancelled') {
      return {
        heading: 'Admission window closed',
        body: 'This pass can no longer be scanned. If it was not accepted, the refund-only settlement path applies.',
        tone: 'border-amber-300/25 bg-amber-300/10 text-amber-100',
        valid: false
      };
    }
    return {
      heading: 'Admission status unavailable',
      body: 'Sway has not confirmed that entry is open. Refresh this pass before relying on an admission code.',
      tone: 'border-amber-300/25 bg-amber-300/10 text-amber-100',
      valid: false
    };
  }
  if (ticket.status === 'checked_in') {
    return {
      heading: 'Checked in',
      body: ticket.checkedInAt
        ? `Entry was accepted ${formatDateTime(ticket.checkedInAt, ticket.event.timeZone) || ''}. ${
            ticket.settlementStatus === 'released'
              ? 'Sway recorded the performer transfer.'
              : 'The performer transfer is still pending processor confirmation.'
          }`
        : 'Entry was accepted for this ticket.',
      tone: 'border-cyan-400/25 bg-cyan-500/10 text-cyan-100',
      valid: false
    };
  }
  if (ticket.status === 'refund_pending') {
    return {
      heading: 'Refund pending',
      body: 'This pass is no longer valid. Sway has requested a refund, but it is not complete until the processor confirms it.',
      tone: 'border-amber-300/25 bg-amber-300/10 text-amber-100',
      valid: false
    };
  }
  if (ticket.status === 'refunded') {
    return {
      heading: 'Refund confirmed',
      body: 'This pass is no longer valid. The processor confirmed the refund to the original payment method.',
      tone: 'border-slate-400/25 bg-slate-400/10 text-slate-200',
      valid: false
    };
  }
  if (ticket.status === 'disputed') {
    return {
      heading: 'Payment under review',
      body: 'This pass is not valid while the payment processor dispute is under controlled review.',
      tone: 'border-rose-400/25 bg-rose-500/10 text-rose-100',
      valid: false
    };
  }
  return {
    heading: 'Ticket not valid',
    body: 'This ticket cannot be accepted at the door. Review its current status or contact Sway support.',
    tone: 'border-rose-400/25 bg-rose-500/10 text-rose-100',
    valid: false
  };
}

export default function TicketPassPage({ ticketId }: TicketPassPageProps) {
  const [ticket, setTicket] = useState<TicketPassDto | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [refreshingQr, setRefreshingQr] = useState(false);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);

  const loadTicket = useCallback(async (options: { signal?: AbortSignal; background?: boolean } = {}) => {
    if (options.background) setRefreshingQr(true);
    else setStatus('loading');
    try {
      const response = await fetch(`/api/account/tickets/${encodeURIComponent(ticketId)}`, {
        cache: 'no-store',
        signal: options.signal
      });
      const data = await response.json().catch(() => null) as TicketPassResponse | null;
      if (response.status === 401) {
        window.location.replace(loginHref(ticketId));
        return;
      }
      if (!response.ok || !data?.ticket) {
        throw new Error(data?.error || 'Sway could not load this ticket.');
      }
      setTicket(data.ticket);
      setMessage(null);
      setStatus('ready');
      document.title = `${data.ticket.event.title} ticket | Sway`;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (!options.background || !ticket) {
        setStatus('error');
        setMessage(error instanceof Error ? error.message : 'Sway could not load this ticket.');
      }
    } finally {
      if (options.background) setRefreshingQr(false);
    }
  }, [ticketId, ticket]);

  useEffect(() => {
    const controller = new AbortController();
    void loadTicket({ signal: controller.signal });
    return () => controller.abort();
  }, [ticketId]);

  useEffect(() => {
    const settlementStillProcessing = ticket?.status === 'checked_in'
      && ['held', 'release_pending'].includes(ticket.settlementStatus || '');
    if (
      status !== 'ready'
      || !ticket
      || (
        !['active', 'refund_pending'].includes(ticket.status)
        && !settlementStillProcessing
      )
    ) return;
    const interval = window.setInterval(() => {
      void loadTicket({ background: true });
    }, 20_000);
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void loadTicket({ background: true });
    };
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [status, ticket, loadTicket]);

  const state = useMemo(() => ticket ? passState(ticket) : null, [ticket]);
  const qrExpired = ticket?.qrExpiresAt
    ? new Date(ticket.qrExpiresAt).getTime() <= Date.now()
    : false;

  const copyManualCode = async () => {
    if (!ticket?.manualCode) return;
    try {
      await navigator.clipboard.writeText(ticket.manualCode);
      setCopyMessage('Code copied');
    } catch {
      setCopyMessage('Copy unavailable');
    }
    window.setTimeout(() => setCopyMessage(null), 1800);
  };

  if (status === 'loading') {
    return (
      <div className="grid min-h-[var(--sway-viewport-height,100vh)] place-items-center bg-[#05060a] text-fuchsia-200">
        <Loader2 className="h-7 w-7 animate-spin" aria-label="Loading ticket" />
      </div>
    );
  }

  if (status === 'error' || !ticket || !state) {
    return (
      <main className="grid min-h-[var(--sway-viewport-height,100vh)] place-items-center bg-[#05060a] px-4 text-center text-slate-100">
        <div className="max-w-md">
          <AlertTriangle className="mx-auto h-9 w-9 text-rose-300" aria-hidden="true" />
          <h1 className="mt-4 text-2xl font-black">Ticket could not load</h1>
          <p className="mt-2 text-sm leading-6 text-slate-400">{message}</p>
          <button
            type="button"
            onClick={() => { void loadTicket(); }}
            className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-xl bg-white px-4 text-sm font-black text-slate-950"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Try again
          </button>
        </div>
      </main>
    );
  }

  const eventDate = formatDateTime(ticket.event.startsAt, ticket.event.timeZone);
  const amountPaid = formatMoney(ticket.allInPriceCents, ticket.currency);

  return (
    <main className="min-h-[var(--sway-viewport-height,100vh)] bg-[radial-gradient(circle_at_20%_0%,rgba(217,70,239,0.25),transparent_35%),radial-gradient(circle_at_90%_18%,rgba(34,211,238,0.14),transparent_32%),#05060a] px-4 pb-[calc(var(--sway-safe-bottom)+2rem)] pt-5 text-slate-100 sm:py-8">
      <div className="mx-auto max-w-lg">
        <header className="flex items-center justify-between gap-3">
          <a href="/tickets" className="inline-flex min-h-10 items-center gap-2 text-xs font-black text-slate-300 hover:text-white">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            My tickets
          </a>
          <span className="text-[10px] font-black uppercase tracking-[0.22em] text-fuchsia-200">
            General admission
          </span>
        </header>

        <article className="mt-5 overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950/80 shadow-2xl backdrop-blur-xl">
          <div className="border-b border-white/10 bg-gradient-to-br from-fuchsia-500/15 to-cyan-500/10 p-5 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.24em] text-cyan-200">
                  {ticket.event.performerName || 'Sway event'}
                </p>
                <h1 className="mt-2 font-display text-2xl font-black leading-tight text-white sm:text-3xl">
                  {ticket.event.title}
                </h1>
              </div>
              {ticket.ticketNumber ? (
                <span className="rounded-full border border-white/10 bg-slate-950/60 px-3 py-1 text-[10px] font-black text-slate-300">
                  {ticket.ticketNumber}
                </span>
              ) : null}
            </div>
            <div className="mt-4 space-y-2 text-xs leading-5 text-slate-300">
              <p className="flex items-start gap-2">
                <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fuchsia-200" aria-hidden="true" />
                {eventDate || 'Date unavailable'}
              </p>
              <p className="flex items-start gap-2">
                <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-200" aria-hidden="true" />
                <span>
                  {locationLabel(ticket)}
                  {!ticket.event.locationIsTba && ticket.event.locationAddress ? (
                    <span className="mt-0.5 block text-slate-500">{ticket.event.locationAddress}</span>
                  ) : null}
                </span>
              </p>
            </div>
          </div>

          <div className="space-y-5 p-5 sm:p-6">
            <div className={`rounded-2xl border p-4 ${state.tone}`}>
              <p className="flex items-center gap-2 font-black">
                {ticket.status === 'active' || ticket.status === 'checked_in'
                  ? <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
                  : <AlertTriangle className="h-5 w-5" aria-hidden="true" />}
                {state.heading}
              </p>
              <p className="mt-2 text-xs leading-5 opacity-85">{state.body}</p>
            </div>

            {state.valid ? (
              <section className="rounded-2xl border border-white/10 bg-white p-4 text-center text-slate-950">
                {ticket.qrToken && !qrExpired ? (
                  <>
                    <QRCodeSVG
                      value={ticket.qrToken}
                      size={260}
                      level="H"
                      marginSize={2}
                      className="mx-auto h-auto w-full max-w-[260px]"
                      aria-label="Rotating Sway admission QR code"
                    />
                    <p className="mt-3 inline-flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
                      <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                      {refreshingQr ? 'Refreshing secure code' : 'Rotating admission code'}
                    </p>
                  </>
                ) : (
                  <div className="grid min-h-64 place-items-center">
                    <div>
                      <Loader2 className="mx-auto h-7 w-7 animate-spin text-fuchsia-600" aria-hidden="true" />
                      <p className="mt-3 text-xs font-black text-slate-600">Refreshing admission code</p>
                    </div>
                  </div>
                )}
              </section>
            ) : null}

            {state.valid && ticket.manualCode ? (
              <section className="rounded-2xl border border-white/10 bg-white/[0.035] p-4 text-center">
                <p className="text-[9px] font-black uppercase tracking-[0.22em] text-slate-500">Manual entry code</p>
                <p className="mt-2 font-mono text-2xl font-black tracking-[0.22em] text-white">{ticket.manualCode}</p>
                <button
                  type="button"
                  onClick={() => { void copyManualCode(); }}
                  className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-xl border border-white/10 px-4 text-xs font-black text-slate-300"
                >
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                  {copyMessage || 'Copy code'}
                </button>
                <p className="mt-3 text-[11px] leading-5 text-slate-500">Use this only if the performer cannot scan the QR.</p>
              </section>
            ) : null}

            <section className="rounded-2xl border border-cyan-300/20 bg-cyan-400/[0.06] p-4 text-xs leading-5 text-cyan-50">
              <p className="font-black">Payment handling</p>
              <p className="mt-1 text-cyan-50/80">
                {ticket.status === 'active'
                  ? 'Your payment is held by Sway and is not transferred to the performer until check-in. An unaccepted ticket follows the refund-only terms recorded at purchase.'
                  : ticket.status === 'checked_in'
                    ? ticket.settlementStatus === 'released'
                      ? 'Entry was accepted and Sway recorded the performer transfer.'
                      : 'Entry was accepted and the performer transfer is pending processor confirmation.'
                    : ticket.status === 'refund_pending'
                      ? 'Sway requested the full refund. It is not complete until the processor confirms it.'
                      : ticket.status === 'refunded'
                        ? 'The processor confirmed the full refund to the original payment method.'
                        : ticket.status === 'disputed'
                          ? 'The payment is under processor dispute review. No admission or settlement outcome is implied.'
                          : 'This ticket is not valid for admission. Review its recorded status before relying on a payment outcome.'}
              </p>
              {amountPaid ? <p className="mt-2 font-black">{amountPaid} total paid</p> : null}
              {ticket.termsVersion ? (
                <p className="mt-2 text-[10px] text-cyan-100/60">
                  Terms {ticket.termsVersion}{ticket.termsHash ? ` · ${ticket.termsHash.slice(0, 12)}` : ''}
                  {' · '}
                  <a href="/legal/tickets" className="font-black underline underline-offset-2">
                    Full terms
                  </a>
                </p>
              ) : null}
            </section>

            <div className="grid gap-2 sm:grid-cols-2">
              <a
                href={ticket.event.eventPath || `/e/${encodeURIComponent(ticket.event.id)}`}
                className="inline-flex min-h-11 items-center justify-center rounded-xl border border-white/10 px-4 text-xs font-black text-slate-200"
              >
                Event details
              </a>
              <a
                href={`/support?${new URLSearchParams({ ticketId: ticket.id }).toString()}`}
                className="inline-flex min-h-11 items-center justify-center rounded-xl border border-white/10 px-4 text-xs font-black text-slate-200"
              >
                Ticket support
              </a>
            </div>
          </div>
        </article>

        <footer className="mt-6 text-center">
          <Ticket className="mx-auto h-5 w-5 text-slate-600" aria-hidden="true" />
          <p className="mt-2 text-xs text-slate-500">Do not share your admission QR or manual code.</p>
        </footer>
      </div>
    </main>
  );
}
