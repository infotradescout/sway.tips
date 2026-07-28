import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  LockKeyhole,
  Ticket
} from 'lucide-react';

export type NativeAdmissionOffer = {
  mode: 'native_ga';
  salesStatus: 'scheduled' | 'on_sale' | 'sold_out' | 'closed' | 'cancelled' | string;
  currency: 'USD';
  faceValueCents: number;
  mandatoryFeeCents: number;
  unitAllInPriceCents: number;
  remainingCount: number;
  termsVersion: string;
  termsHash: string;
  refundGraceMinutes: number;
  sellerSupportEmail: string;
};

type TicketOrderCreateResponse = {
  orderId?: string;
  checkoutUrl?: string;
  ticketId?: string | null;
  error?: string;
  code?: string;
};

export type EventTicketPurchaseCardProps = {
  eventId: string;
  eventTitle: string;
  offer: NativeAdmissionOffer;
  className?: string;
};

function formatUsd(cents: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD'
  }).format(Math.max(0, cents) / 100);
}

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
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join('-');
}

function checkoutRequestStorageKey(eventId: string) {
  return `sway.ticket.checkout-request.${eventId}`;
}

function durableCheckoutRequestId(eventId: string) {
  const storageKey = checkoutRequestStorageKey(eventId);
  try {
    const existing = window.sessionStorage.getItem(storageKey);
    if (existing && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existing)) {
      return existing;
    }
    const created = clientRequestId();
    window.sessionStorage.setItem(storageKey, created);
    return created;
  } catch {
    return clientRequestId();
  }
}

function safeReturnPath() {
  if (typeof window === 'undefined') return '/discover';
  const returnUrl = new URL(window.location.href);
  returnUrl.searchParams.set('buy', '1');
  return `${returnUrl.pathname}${returnUrl.search}${returnUrl.hash}`;
}

function accountHref(path: '/account/login' | '/account/signup') {
  const params = new URLSearchParams({ next: safeReturnPath() });
  return `${path}?${params.toString()}`;
}

function graceLabel(minutes: number) {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'after the event closes';
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `${days} ${days === 1 ? 'day' : 'days'} after the event closes`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? 'hour' : 'hours'} after the event closes`;
  }
  return `${Math.round(minutes)} minutes after the event closes`;
}

function salesState(offer: NativeAdmissionOffer) {
  if (offer.salesStatus === 'on_sale' && offer.remainingCount > 0) {
    return { available: true, label: 'Buy one ticket' };
  }
  if (offer.salesStatus === 'sold_out' || offer.remainingCount <= 0) {
    return { available: false, label: 'Sold out' };
  }
  if (offer.salesStatus === 'scheduled') {
    return { available: false, label: 'Sales have not opened' };
  }
  if (offer.salesStatus === 'cancelled') {
    return { available: false, label: 'Event cancelled' };
  }
  return { available: false, label: 'Ticket sales closed' };
}

export default function EventTicketPurchaseCard({
  eventId,
  eventTitle,
  offer,
  className = ''
}: EventTicketPurchaseCardProps) {
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [status, setStatus] = useState<
    'idle' | 'submitting' | 'auth-required' | 'existing-order' | 'error'
  >('idle');
  const [message, setMessage] = useState<string | null>(null);
  const checkoutRequestIdRef = useRef<string | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const availability = useMemo(() => salesState(offer), [offer]);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('buy') !== '1') return;
    window.setTimeout(() => {
      cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      cardRef.current?.focus({ preventScroll: true });
    }, 0);
  }, []);

  const beginCheckout = async () => {
    if (!availability.available || !termsAccepted || status === 'submitting') return;
    setStatus('submitting');
    setMessage(null);

    try {
      const requestId = checkoutRequestIdRef.current ?? durableCheckoutRequestId(eventId);
      checkoutRequestIdRef.current = requestId;
      const response = await fetch('/api/account/ticket-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId,
          clientRequestId: requestId,
          termsAccepted: true
        })
      });
      const data = await response.json().catch(() => null) as TicketOrderCreateResponse | null;

      if (response.status === 401) {
        setStatus('auth-required');
        setMessage('Log in or create your Sway account, then you will return here to finish buying this ticket.');
        return;
      }
      if (!response.ok) {
        if (data?.code === 'ticket_order_request_consumed') {
          checkoutRequestIdRef.current = null;
          try {
            window.sessionStorage.removeItem(checkoutRequestStorageKey(eventId));
          } catch {
            // Storage is optional; the server remains the idempotency authority.
          }
          setStatus('error');
          setMessage('Your earlier checkout is closed. Press the button again to start a new checkout.');
          return;
        }
        if (data?.code === 'ticket_buyer_offer_limit') {
          setStatus('existing-order');
          setMessage('This account already has a ticket or checkout for this event. Open My tickets to continue.');
          return;
        }
        throw new Error(data?.error || 'Sway could not start ticket checkout.');
      }
      if (typeof data?.ticketId === 'string') {
        try {
          window.sessionStorage.removeItem(checkoutRequestStorageKey(eventId));
        } catch {
          // Storage is optional; the server remains the idempotency authority.
        }
        window.location.assign(`/tickets/${encodeURIComponent(data.ticketId)}`);
        return;
      }
      if (
        typeof data?.checkoutUrl !== 'string'
        || !/^https:\/\//i.test(data.checkoutUrl)
        || typeof data.orderId !== 'string'
      ) {
        throw new Error('Ticket checkout did not return a valid hosted payment link.');
      }

      window.location.assign(data.checkoutUrl);
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'Sway could not start ticket checkout.');
    }
  };

  return (
    <section
      ref={cardRef}
      id="native-ticket-checkout"
      tabIndex={-1}
      data-sway-native-ticket-purchase="true"
      className={`overflow-hidden rounded-2xl border border-fuchsia-300/25 bg-slate-950/80 shadow-xl shadow-fuchsia-950/20 ${className}`}
      aria-label={`Buy a general-admission ticket for ${eventTitle}`}
    >
      <div className="border-b border-white/10 bg-gradient-to-r from-fuchsia-500/15 via-cyan-500/10 to-transparent p-4 sm:p-5">
        <p className="inline-flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.24em] text-fuchsia-200">
          <Ticket className="h-4 w-4" aria-hidden="true" />
          General admission
        </p>
        <p className="mt-3 text-3xl font-black tracking-tight text-white sm:text-4xl">
          {formatUsd(offer.unitAllInPriceCents)}
        </p>
        <p className="mt-1 text-sm font-black text-cyan-100">
          one ticket before applicable government tax
        </p>
        <p className="mt-3 text-xs leading-5 text-slate-400">
          Includes {formatUsd(offer.faceValueCents)} admission and {formatUsd(offer.mandatoryFeeCents)} in
          mandatory Sway fees. Stripe will show any applicable government tax before payment. Refund-only
          permits one issued or pending ticket per verified Sway account for this event.
        </p>
        <p className="mt-2 text-xs leading-5 text-slate-400">
          Event support is provided by the seller at{' '}
          <a className="font-black text-cyan-100 underline" href={`mailto:${offer.sellerSupportEmail}`}>
            {offer.sellerSupportEmail}
          </a>. Sway handles platform, account, security, and payment infrastructure issues.
        </p>
      </div>

      <div className="space-y-4 p-4 sm:p-5">
        {availability.available ? (
          <>
            <div className="rounded-xl border border-cyan-300/20 bg-cyan-400/[0.06] p-3 text-xs leading-5 text-cyan-50">
              <p className="font-black">Your payment is held by Sway.</p>
              <p className="mt-1 text-cyan-50/80">
                Sway does not transfer the performer share until your ticket is checked in. If it is not
                checked in, Sway queues a full refund {graceLabel(offer.refundGraceMinutes)}.
              </p>
            </div>

            <label className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/[0.035] p-3 text-xs leading-5 text-slate-300">
              <input
                type="checkbox"
                checked={termsAccepted}
                onChange={(event) => setTermsAccepted(event.target.checked)}
                disabled={status === 'submitting'}
                className="mt-1 h-4 w-4 shrink-0"
              />
              <span>
                I agree to the ticket terms shown here, including payment now, release after check-in,
                and a refund if this ticket remains unaccepted after the disclosed grace period.{' '}
                <a
                  href="/legal/tickets"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-black text-cyan-100 underline underline-offset-2"
                >
                  Read the full ticket terms
                </a>.
                <span className="mt-1 block text-[10px] text-slate-500">
                  Terms {offer.termsVersion} · {offer.termsHash.slice(0, 12)}
                </span>
              </span>
            </label>

            <button
              type="button"
              onClick={() => { void beginCheckout(); }}
              disabled={!termsAccepted || status === 'submitting'}
              className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-fuchsia-600 to-cyan-500 px-5 text-sm font-black text-white transition hover:from-fuchsia-500 hover:to-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {status === 'submitting' ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <LockKeyhole className="h-4 w-4" aria-hidden="true" />
              )}
              {status === 'submitting'
                ? 'Opening secure checkout…'
                : `Continue to checkout · ${formatUsd(offer.unitAllInPriceCents)} before tax`}
              {status !== 'submitting' ? <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" /> : null}
            </button>

            {offer.remainingCount <= 10 ? (
              <p className="text-center text-[11px] font-bold text-amber-200">
                {offer.remainingCount} {offer.remainingCount === 1 ? 'ticket' : 'tickets'} remaining
              </p>
            ) : null}
          </>
        ) : (
          <div className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/[0.035] p-4 text-sm text-slate-300">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-200" aria-hidden="true" />
            <div>
              <p className="font-black text-white">{availability.label}</p>
              <p className="mt-1 text-xs leading-5 text-slate-400">
                Sway will not open checkout unless the server confirms an active sale and available ticket.
              </p>
            </div>
          </div>
        )}

        {message ? (
          <div
            role="status"
            className={`rounded-xl border p-3 text-xs leading-5 ${
              status === 'error'
                ? 'border-rose-400/25 bg-rose-500/10 text-rose-100'
                : 'border-cyan-300/25 bg-cyan-400/10 text-cyan-50'
            }`}
          >
            <p className="flex items-start gap-2 font-bold">
              {status === 'error'
                ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />}
              <span>{message}</span>
            </p>
            {status === 'auth-required' ? (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <a
                  href={accountHref('/account/login')}
                  className="inline-flex min-h-11 items-center justify-center rounded-xl border border-cyan-200/30 bg-cyan-400/10 px-4 font-black text-cyan-50"
                >
                  Log in
                </a>
                <a
                  href={accountHref('/account/signup')}
                  className="inline-flex min-h-11 items-center justify-center rounded-xl bg-cyan-400 px-4 font-black text-slate-950"
                >
                  Create account
                </a>
              </div>
            ) : null}
            {status === 'existing-order' ? (
              <a
                href="/tickets"
                className="mt-3 inline-flex min-h-11 w-full items-center justify-center rounded-xl border border-cyan-200/30 bg-cyan-400/10 px-4 font-black text-cyan-50"
              >
                Open My tickets
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
