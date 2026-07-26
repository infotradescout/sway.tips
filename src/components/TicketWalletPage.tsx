import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  Clock,
  Loader2,
  MapPin,
  ReceiptText,
  RefreshCw,
  Ticket
} from 'lucide-react';

export type TicketWalletItem = {
  id: string;
  status: 'active' | 'checked_in' | 'refund_pending' | 'refunded' | 'disputed' | 'cancelled' | string;
  settlementStatus?: 'held' | 'release_pending' | 'released' | 'refund_pending' | 'refunded' | 'disputed' | 'voided' | string;
  allInPriceCents?: number | null;
  currency?: 'USD' | string;
  createdAt?: string | null;
  checkedInAt?: string | null;
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

type TicketWalletResponse = {
  tickets?: TicketWalletItem[];
  error?: string;
};

type TicketOrderItem = {
  id: string;
  status: string;
  checkoutUrl?: string | null;
  checkoutExpiresAt?: string | null;
  ticketIds?: string[];
  event?: {
    id: string;
    title: string;
    eventPath?: string | null;
  } | null;
};

type TicketOrdersResponse = {
  orders?: TicketOrderItem[];
  error?: string;
};

function loginHref() {
  return `/account/login?${new URLSearchParams({ next: '/tickets' }).toString()}`;
}

function formatMoney(cents: number | null | undefined, currency = 'USD') {
  if (!Number.isFinite(cents)) return null;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency
  }).format(Number(cents) / 100);
}

function formatEventDate(ticket: TicketWalletItem) {
  const date = new Date(ticket.event.startsAt);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: ticket.event.timeZone,
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

function locationLabel(ticket: TicketWalletItem) {
  if (ticket.event.locationIsTba) return 'Location TBA';
  return [ticket.event.locationName, ticket.event.city].filter(Boolean).join(' · ') || 'Location not listed';
}

function ticketStatus(ticket: TicketWalletItem) {
  if (ticket.status === 'active') {
    return { label: 'Ticket confirmed', tone: 'border-emerald-400/25 bg-emerald-500/10 text-emerald-100' };
  }
  if (ticket.status === 'checked_in') {
    return {
      label: ticket.settlementStatus === 'released' ? 'Checked in' : 'Transfer pending',
      tone: 'border-cyan-400/25 bg-cyan-500/10 text-cyan-100'
    };
  }
  if (ticket.status === 'refund_pending') {
    return { label: 'Refund pending', tone: 'border-amber-300/25 bg-amber-300/10 text-amber-100' };
  }
  if (ticket.status === 'refunded') {
    return { label: 'Refund confirmed', tone: 'border-slate-400/25 bg-slate-400/10 text-slate-200' };
  }
  if (ticket.status === 'disputed') {
    return { label: 'Payment disputed', tone: 'border-amber-300/25 bg-amber-300/10 text-amber-100' };
  }
  if (ticket.status === 'cancelled') {
    return { label: 'Not valid', tone: 'border-rose-400/25 bg-rose-500/10 text-rose-100' };
  }
  return { label: ticket.status.replace(/_/g, ' '), tone: 'border-white/10 bg-white/[0.04] text-slate-300' };
}

export default function TicketWalletPage() {
  const [tickets, setTickets] = useState<TicketWalletItem[]>([]);
  const [orders, setOrders] = useState<TicketOrderItem[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState<string | null>(null);

  const loadTickets = useCallback(async (signal?: AbortSignal, background = false) => {
    if (!background) setStatus('loading');
    setMessage(null);
    try {
      const [response, ordersResponse] = await Promise.all([
        fetch('/api/account/tickets', { cache: 'no-store', signal }),
        fetch('/api/account/ticket-orders?limit=10', { cache: 'no-store', signal })
      ]);
      const [data, ordersData] = await Promise.all([
        response.json().catch(() => null) as Promise<TicketWalletResponse | null>,
        ordersResponse.json().catch(() => null) as Promise<TicketOrdersResponse | null>
      ]);
      if (response.status === 401 || ordersResponse.status === 401) {
        window.location.replace(loginHref());
        return;
      }
      if (!response.ok) throw new Error(data?.error || 'Sway could not load your tickets.');
      if (!ordersResponse.ok) {
        throw new Error(ordersData?.error || 'Sway could not load your ticket orders.');
      }
      setTickets(Array.isArray(data?.tickets) ? data.tickets : []);
      setOrders(Array.isArray(ordersData?.orders) ? ordersData.orders : []);
      setStatus('ready');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      const failureMessage = error instanceof Error ? error.message : 'Sway could not load your tickets.';
      if (background) {
        setMessage(`Tickets could not refresh. Showing the last confirmed status. ${failureMessage}`);
        return;
      }
      setStatus('error');
      setMessage(failureMessage);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    document.title = 'My tickets | Sway';
    void loadTickets(controller.signal);
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void loadTickets(undefined, true);
    };
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      controller.abort();
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [loadTickets]);

  const orderedTickets = useMemo(() => [...tickets].sort((left, right) => {
    const leftActive = left.status === 'active' ? 0 : 1;
    const rightActive = right.status === 'active' ? 0 : 1;
    if (leftActive !== rightActive) return leftActive - rightActive;
    return new Date(left.event.startsAt).getTime() - new Date(right.event.startsAt).getTime();
  }), [tickets]);
  const pendingOrders = useMemo(() => orders.filter((order) => (
    (!Array.isArray(order.ticketIds) || order.ticketIds.length === 0)
    && !['checkout_expired', 'payment_failed', 'cancelled'].includes(order.status)
  )), [orders]);

  return (
    <main className="min-h-[var(--sway-viewport-height,100vh)] bg-[radial-gradient(circle_at_12%_0%,rgba(217,70,239,0.2),transparent_34%),#05060a] px-4 pb-[calc(var(--sway-safe-bottom)+2rem)] pt-5 text-slate-100 sm:py-8">
      <div className="mx-auto max-w-2xl">
        <header className="flex items-center justify-between gap-3">
          <a href="/account" className="inline-flex min-h-10 items-center gap-2 text-xs font-black text-slate-300 hover:text-white">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Account
          </a>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => { void loadTickets(undefined, true); }}
              className="inline-flex min-h-10 items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 text-xs font-black text-slate-200"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              Refresh
            </button>
            <a href="/discover" className="inline-flex min-h-10 items-center rounded-full border border-white/10 bg-white/[0.04] px-4 text-xs font-black text-slate-200">
              Discover shows
            </a>
          </div>
        </header>

        <section className="mt-7">
          <p className="text-[10px] font-black uppercase tracking-[0.28em] text-fuchsia-200">Your Sway</p>
          <h1 className="mt-2 font-display text-3xl font-black text-white sm:text-4xl">My tickets</h1>
          <p className="mt-3 text-sm leading-6 text-slate-400">
            Open a ticket to show its current admission code. Ticket and refund status always comes from Sway.
          </p>
        </section>

        {status === 'ready' && message ? (
          <div role="status" className="mt-5 rounded-2xl border border-amber-300/25 bg-amber-300/10 p-4 text-xs leading-5 text-amber-100">
            {message}
          </div>
        ) : null}

        {status === 'loading' ? (
          <div className="mt-8 grid min-h-40 place-items-center rounded-3xl border border-white/10 bg-slate-950/65">
            <div className="text-center">
              <Loader2 className="mx-auto h-7 w-7 animate-spin text-fuchsia-200" aria-label="Loading tickets" />
              <p className="mt-3 text-xs font-bold text-slate-500">Loading your tickets</p>
            </div>
          </div>
        ) : null}

        {status === 'error' ? (
          <div className="mt-8 rounded-3xl border border-rose-400/25 bg-rose-500/10 p-5">
            <p className="text-sm font-black text-white">Tickets could not load</p>
            <p className="mt-2 text-xs leading-5 text-rose-100/80">{message}</p>
            <button
              type="button"
              onClick={() => { void loadTickets(); }}
              className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl bg-white px-4 text-xs font-black text-slate-950"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Try again
            </button>
          </div>
        ) : null}

        {status === 'ready' && pendingOrders.length ? (
          <section className="mt-8">
            <div className="flex items-center gap-2">
              <ReceiptText className="h-4 w-4 text-cyan-200" aria-hidden="true" />
              <h2 className="text-sm font-black text-white">Orders in progress</h2>
            </div>
            <div className="mt-3 space-y-3">
              {pendingOrders.map((order) => (
                <article key={order.id} className="rounded-2xl border border-cyan-300/20 bg-cyan-500/[0.06] p-4">
                  <p className="text-sm font-black text-white">{order.event?.title || 'Sway ticket order'}</p>
                  <p className="mt-1 text-xs text-slate-400">
                    Status: {order.status.replace(/_/g, ' ')}
                  </p>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {order.checkoutUrl ? (
                      <a
                        href={order.checkoutUrl}
                        className="inline-flex min-h-11 items-center justify-center rounded-xl bg-white px-4 text-xs font-black text-slate-950"
                      >
                        Resume secure checkout
                      </a>
                    ) : null}
                    <a
                      href={`/tickets/orders/${encodeURIComponent(order.id)}/return`}
                      className="inline-flex min-h-11 items-center justify-center rounded-xl border border-white/10 px-4 text-xs font-black text-slate-200"
                    >
                      Check order status
                    </a>
                  </div>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {status === 'ready' && orderedTickets.length === 0 && pendingOrders.length === 0 ? (
          <div className="mt-8 rounded-3xl border border-dashed border-white/10 bg-slate-950/60 p-8 text-center">
            <Ticket className="mx-auto h-9 w-9 text-slate-600" aria-hidden="true" />
            <h2 className="mt-4 text-lg font-black text-white">No tickets yet</h2>
            <p className="mt-2 text-sm leading-6 text-slate-400">Tickets appear here only after Sway confirms payment.</p>
            <a href="/discover" className="mt-5 inline-flex min-h-11 items-center justify-center rounded-xl bg-fuchsia-600 px-4 text-sm font-black text-white">
              Discover shows
            </a>
          </div>
        ) : null}

        {status === 'ready' && orderedTickets.length > 0 ? (
          <div className="mt-8 space-y-4">
            {orderedTickets.map((ticket) => {
              const state = ticketStatus(ticket);
              const paid = formatMoney(ticket.allInPriceCents, ticket.currency);
              return (
                <article key={ticket.id} className="overflow-hidden rounded-2xl border border-white/10 bg-slate-950/75 shadow-xl">
                  <div className="p-4 sm:p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[9px] font-black uppercase tracking-[0.2em] text-fuchsia-200">
                          General admission
                        </p>
                        <h2 className="mt-1 text-lg font-black text-white">{ticket.event.title}</h2>
                        {ticket.event.performerName ? (
                          <p className="mt-1 text-xs font-bold text-cyan-200">{ticket.event.performerName}</p>
                        ) : null}
                      </div>
                      <span className={`rounded-full border px-3 py-1 text-[9px] font-black uppercase tracking-wider ${state.tone}`}>
                        {state.label}
                      </span>
                    </div>

                    <div className="mt-4 space-y-2 text-xs leading-5 text-slate-400">
                      <p className="flex items-start gap-2">
                        <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        {formatEventDate(ticket)}
                      </p>
                      <p className="flex items-start gap-2">
                        <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        {locationLabel(ticket)}
                      </p>
                      {paid ? (
                        <p className="flex items-center gap-2">
                          <ReceiptText className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          {paid} total paid
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <a
                    href={`/tickets/${encodeURIComponent(ticket.id)}`}
                    className="flex min-h-12 items-center justify-between border-t border-white/10 bg-white/[0.035] px-4 text-sm font-black text-white transition hover:bg-white/[0.06]"
                  >
                    <span>{ticket.status === 'active' ? 'Open admission pass' : 'View ticket status'}</span>
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </a>
                </article>
              );
            })}
          </div>
        ) : null}

        <footer className="mt-10 border-t border-white/10 py-6 text-center">
          <CalendarDays className="mx-auto h-5 w-5 text-slate-600" aria-hidden="true" />
          <p className="mt-2 text-xs text-slate-500">Admission and refund outcomes are confirmed by Sway records.</p>
        </footer>
      </div>
    </main>
  );
}
