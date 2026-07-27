import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Clock3,
  Loader2,
  ReceiptText,
  RefreshCw,
  Ticket
} from 'lucide-react';

export type TicketOrderDto = {
  id: string;
  status: string;
  checkoutUrl?: string | null;
  allInTotalCents?: number | null;
  currency?: 'USD' | string;
  checkoutExpiresAt?: string | null;
  failureMessage?: string | null;
  ticketIds?: string[];
  tickets?: Array<{ id: string }>;
  event?: {
    id: string;
    title: string;
    eventPath?: string | null;
  } | null;
};

type TicketOrderResponse = {
  order?: TicketOrderDto;
  error?: string;
};

export type TicketOrderReturnPageProps = {
  orderId: string;
};

const TERMINAL_FAILURE_STATES = new Set([
  'checkout_expired',
  'payment_failed',
  'cancelled'
]);

function loginHref(orderId: string) {
  const next = `/tickets/orders/${encodeURIComponent(orderId)}/return`;
  return `/account/login?${new URLSearchParams({ next }).toString()}`;
}

function formatMoney(cents: number | null | undefined, currency = 'USD') {
  if (!Number.isFinite(cents)) return null;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency
  }).format(Number(cents) / 100);
}

function resolvedTicketIds(order: TicketOrderDto | null) {
  if (!order) return [];
  if (Array.isArray(order.ticketIds)) return order.ticketIds.filter((id) => typeof id === 'string');
  if (Array.isArray(order.tickets)) {
    return order.tickets.map((ticket) => ticket.id).filter((id) => typeof id === 'string');
  }
  return [];
}

export default function TicketOrderReturnPage({ orderId }: TicketOrderReturnPageProps) {
  const [order, setOrder] = useState<TicketOrderDto | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [pollCount, setPollCount] = useState(0);

  const loadOrder = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(`/api/account/ticket-orders/${encodeURIComponent(orderId)}`, {
        cache: 'no-store',
        signal
      });
      const data = await response.json().catch(() => null) as TicketOrderResponse | null;
      if (response.status === 401) {
        window.location.replace(loginHref(orderId));
        return;
      }
      if (!response.ok || !data?.order) {
        throw new Error(data?.error || 'Sway could not confirm this ticket order.');
      }
      setOrder(data.order);
      setStatus('ready');
      setMessage(null);
      document.title = `${data.order.event?.title || 'Ticket order'} | Sway`;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'Sway could not confirm this ticket order.');
    }
  }, [orderId]);

  useEffect(() => {
    const controller = new AbortController();
    void loadOrder(controller.signal);
    return () => controller.abort();
  }, [loadOrder]);

  const ticketIds = useMemo(() => resolvedTicketIds(order), [order]);
  const refundPending = order?.status === 'refund_pending';
  const refunded = order?.status === 'refunded';
  const disputed = order?.status === 'disputed';
  const confirmed = order?.status === 'paid' && ticketIds.length > 0;
  const terminalFailure = order ? TERMINAL_FAILURE_STATES.has(order.status) : false;

  useEffect(() => {
    if (
      (!confirmed && !terminalFailure && !refundPending && !refunded && !disputed)
      || !order?.event?.id
    ) return;
    try {
      window.sessionStorage.removeItem(`sway.ticket.checkout-request.${order.event.id}`);
    } catch {
      // Storage is optional; the server remains the idempotency authority.
    }
  }, [confirmed, terminalFailure, refundPending, refunded, disputed, order?.event?.id]);

  useEffect(() => {
    if (
      status !== 'ready'
      || confirmed
      || terminalFailure
      || refunded
      || disputed
      || pollCount >= 24
      || document.visibilityState !== 'visible'
    ) return;
    const timeout = window.setTimeout(() => {
      setPollCount((count) => count + 1);
      void loadOrder();
    }, pollCount < 10 ? 2_000 : 5_000);
    return () => window.clearTimeout(timeout);
  }, [status, confirmed, terminalFailure, refunded, disputed, pollCount, loadOrder]);

  if (status === 'loading') {
    return (
      <div className="grid min-h-[var(--sway-viewport-height,100vh)] place-items-center bg-[#05060a] text-fuchsia-200">
        <Loader2 className="h-7 w-7 animate-spin" aria-label="Checking ticket order" />
      </div>
    );
  }

  if (status === 'error' || !order) {
    return (
      <main className="grid min-h-[var(--sway-viewport-height,100vh)] place-items-center bg-[#05060a] px-4 text-center text-slate-100">
        <div className="max-w-md">
          <AlertCircle className="mx-auto h-9 w-9 text-rose-300" aria-hidden="true" />
          <h1 className="mt-4 text-2xl font-black">Order status unavailable</h1>
          <p className="mt-2 text-sm leading-6 text-slate-400">{message}</p>
          <button
            type="button"
            onClick={() => { setStatus('loading'); void loadOrder(); }}
            className="mt-5 inline-flex min-h-11 items-center gap-2 rounded-xl bg-white px-4 text-sm font-black text-slate-950"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Check again
          </button>
        </div>
      </main>
    );
  }

  const amount = formatMoney(order.allInTotalCents, order.currency);
  const pollingPaused = (
    !confirmed
    && !terminalFailure
    && !refunded
    && !disputed
    && pollCount >= 24
  );

  return (
    <main className="grid min-h-[var(--sway-viewport-height,100vh)] place-items-center bg-[radial-gradient(circle_at_20%_0%,rgba(217,70,239,0.24),transparent_35%),#05060a] px-4 py-8 text-slate-100">
      <section className="w-full max-w-md rounded-[2rem] border border-white/10 bg-slate-950/80 p-5 text-center shadow-2xl backdrop-blur-xl sm:p-7">
        {refundPending || refunded || disputed ? (
          <>
            <div className={`mx-auto grid h-16 w-16 place-items-center rounded-full border ${
              disputed
                ? 'border-rose-400/30 bg-rose-500/15 text-rose-200'
                : 'border-amber-300/30 bg-amber-400/15 text-amber-100'
            }`}>
              {refundPending ? (
                <Loader2 className="h-8 w-8 animate-spin" aria-hidden="true" />
              ) : (
                <ReceiptText className="h-8 w-8" aria-hidden="true" />
              )}
            </div>
            <p className="mt-5 text-[10px] font-black uppercase tracking-[0.24em] text-amber-100">
              {refunded ? 'Refund confirmed' : disputed ? 'Support review' : 'Refund processing'}
            </p>
            <h1 className="mt-2 text-2xl font-black text-white">
              {refunded
                ? 'This order was refunded'
                : disputed
                  ? 'This order needs support'
                  : 'Your refund is pending'}
            </h1>
            <p className="mt-3 text-sm leading-6 text-slate-300">
              {refunded
                ? 'Sway recorded the processor-confirmed refund to the original payment method.'
                : disputed
                  ? 'Sway has stopped the normal ticket settlement path while this payment is reviewed.'
                  : 'Sway queued a full refund. Processor timing can affect when it appears on the original payment method.'}
            </p>
            {amount ? <p className="mt-4 text-lg font-black text-white">{amount} order total</p> : null}
            <a
              href={disputed
                ? `/support?${new URLSearchParams({ orderId: order.id }).toString()}`
                : '/tickets'}
              className="mt-6 inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-white px-5 text-sm font-black text-slate-950"
            >
              {disputed ? 'Contact ticket support' : 'Open My tickets'}
            </a>
          </>
        ) : confirmed ? (
          <>
            <div className="mx-auto grid h-16 w-16 place-items-center rounded-full border border-emerald-400/30 bg-emerald-500/15 text-emerald-200">
              <CheckCircle2 className="h-8 w-8" aria-hidden="true" />
            </div>
            <p className="mt-5 text-[10px] font-black uppercase tracking-[0.24em] text-emerald-200">Backend confirmed</p>
            <h1 className="mt-2 text-2xl font-black text-white">Your ticket is ready</h1>
            <p className="mt-3 text-sm leading-6 text-slate-300">
              Sway confirmed payment and issued your admission pass. Your payment is held by Sway and is not
              transferred to the performer until check-in.
            </p>
            {amount ? <p className="mt-4 text-lg font-black text-white">{amount} total paid</p> : null}
            <a
              href={ticketIds.length === 1 ? `/tickets/${encodeURIComponent(ticketIds[0])}` : '/tickets'}
              className="mt-6 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-fuchsia-600 to-cyan-500 px-5 text-sm font-black text-white"
            >
              <Ticket className="h-4 w-4" aria-hidden="true" />
              Open admission pass
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </a>
          </>
        ) : terminalFailure ? (
          <>
            <div className="mx-auto grid h-16 w-16 place-items-center rounded-full border border-rose-400/30 bg-rose-500/15 text-rose-200">
              <AlertCircle className="h-8 w-8" aria-hidden="true" />
            </div>
            <p className="mt-5 text-[10px] font-black uppercase tracking-[0.24em] text-rose-200">Order not completed</p>
            <h1 className="mt-2 text-2xl font-black text-white">No ticket was issued</h1>
            <p className="mt-3 text-sm leading-6 text-slate-300">
              {order.failureMessage || 'Sway did not receive the backend confirmation required to issue this ticket.'}
            </p>
            <a
              href={order.event?.eventPath || (order.event?.id ? `/e/${encodeURIComponent(order.event.id)}` : '/discover')}
              className="mt-6 inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-white px-5 text-sm font-black text-slate-950"
            >
              Return to event
            </a>
          </>
        ) : (
          <>
            <div className="mx-auto grid h-16 w-16 place-items-center rounded-full border border-cyan-400/30 bg-cyan-500/15 text-cyan-200">
              <Loader2 className="h-8 w-8 animate-spin" aria-hidden="true" />
            </div>
            <p className="mt-5 text-[10px] font-black uppercase tracking-[0.24em] text-cyan-200">Processor confirmation</p>
            <h1 className="mt-2 text-2xl font-black text-white">
              {pollingPaused ? 'Still processing' : 'Confirming your ticket'}
            </h1>
            <p className="mt-3 text-sm leading-6 text-slate-300">
              {pollingPaused
                ? 'Automatic checks paused after repeated attempts. Your order is still saved; refresh it here or contact ticket support if it does not resolve.'
                : 'Stripe returned you to Sway, but that alone does not prove payment. Keep this page open while Sway waits for backend confirmation and ticket issuance.'}
            </p>
            <div className="mt-5 flex items-center justify-center gap-2 text-xs font-bold text-slate-500">
              <Clock3 className="h-4 w-4" aria-hidden="true" />
              Order status: {order.status.replace(/_/g, ' ')}
            </div>
            <button
              type="button"
              onClick={() => { void loadOrder(); }}
              className="mt-6 inline-flex min-h-11 items-center gap-2 rounded-xl border border-white/10 px-4 text-xs font-black text-slate-200"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Check now
            </button>
            {order.checkoutUrl ? (
              <a
                href={order.checkoutUrl}
                className="mt-3 inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-white px-4 text-xs font-black text-slate-950"
              >
                Resume secure checkout
              </a>
            ) : null}
            {pollingPaused ? (
              <a href="/support" className="mt-4 block text-xs font-black text-cyan-100 underline underline-offset-2">
                Contact ticket support
              </a>
            ) : null}
          </>
        )}

        <div className="mt-6 border-t border-white/10 pt-5">
          <p className="inline-flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">
            <ReceiptText className="h-4 w-4" aria-hidden="true" />
            Order {order.id.slice(0, 8)}
          </p>
        </div>
      </section>
    </main>
  );
}
