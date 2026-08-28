import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CalendarDays,
  Clock,
  ExternalLink,
  Loader2,
  MapPin,
  Share2,
  Ticket
} from 'lucide-react';
import EventTicketPurchaseCard, {
  type NativeAdmissionOffer
} from './EventTicketPurchaseCard';
import {
  captureDiscoveryAttribution,
  getEffectiveDiscoveryChannel
} from '../shells/discoveryAttribution';
import { sendAcquisitionEvent, sendDiscoveryEvent } from '../shells/frictionClient';
import DiscoveryFindUsPrompt from './DiscoveryFindUsPrompt';

type AttendanceMode = 'walk_in' | 'external_rsvp' | 'external_ticket' | 'native_ticket';

export type PublicEventDto = {
  id: string;
  title: string;
  description: string | null;
  startsAt: string;
  doorOpensAt: string | null;
  endsAt: string | null;
  timeZone: string;
  location: {
    name: string | null;
    address: string | null;
    city: string | null;
    isTba: boolean;
  };
  coverImageUrl: string | null;
  attendanceMode?: AttendanceMode;
  externalTicket: {
    url: string;
    label: string | null;
  } | null;
  nativeTicket: NativeAdmissionOffer | null;
  status: string;
  visibility: string;
  cancellationReason?: string | null;
  eventPath: string;
  performer: {
    displayName: string;
    handle: string | null;
    performerPath: string | null;
    avatarUrl: string | null;
    headline: string | null;
  };
};

function validDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function eventFormatter(
  event: Pick<PublicEventDto, 'timeZone'>,
  options: Intl.DateTimeFormatOptions
) {
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: event.timeZone });
  } catch {
    return new Intl.DateTimeFormat('en-US', options);
  }
}

export function formatEventDate(event: Pick<PublicEventDto, 'startsAt' | 'timeZone'>) {
  const startsAt = validDate(event.startsAt);
  if (!startsAt) return 'Date to be announced';
  return eventFormatter(event, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(startsAt);
}

export function formatEventTime(event: Pick<PublicEventDto, 'startsAt' | 'endsAt' | 'timeZone'>) {
  const startsAt = validDate(event.startsAt);
  if (!startsAt) return 'Time to be announced';

  const time = eventFormatter(event, {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  });
  const endsAt = validDate(event.endsAt);
  if (!endsAt) return time.format(startsAt);

  const localDay = eventFormatter(event, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  if (localDay.format(startsAt) === localDay.format(endsAt)) {
    return `${time.format(startsAt)} – ${time.format(endsAt)}`;
  }

  const endDateTime = eventFormatter(event, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  });
  return `${time.format(startsAt)} – ${endDateTime.format(endsAt)}`;
}

export function formatEventSchedule(
  event: Pick<PublicEventDto, 'startsAt' | 'doorOpensAt' | 'endsAt' | 'timeZone'>
) {
  const doorOpensAt = validDate(event.doorOpensAt);
  if (!doorOpensAt) return formatEventTime(event);
  const doorTime = eventFormatter(event, {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  }).format(doorOpensAt);
  return `Doors ${doorTime} · Show ${formatEventTime(event)}`;
}

export function eventLocationLabel(event: Pick<PublicEventDto, 'location'>) {
  if (event.location.isTba) return 'Location TBA';
  return [event.location.name, event.location.city].filter(Boolean).join(' · ') || 'Location not listed';
}

export function isEventCancelled(event: Pick<PublicEventDto, 'status'>) {
  return event.status === 'cancelled' || event.status === 'canceled';
}

export function hasEventStarted(event: Pick<PublicEventDto, 'startsAt'>) {
  const startsAt = validDate(event.startsAt);
  return startsAt ? startsAt.getTime() <= Date.now() : false;
}

export function hasEventEnded(event: Pick<PublicEventDto, 'endsAt'>) {
  const endsAt = validDate(event.endsAt);
  return endsAt ? endsAt.getTime() <= Date.now() : false;
}

export function externalTicketRedirectPath(eventId: string) {
  return `/api/public/events/${encodeURIComponent(eventId)}/ticket`;
}

type AttendanceResolvableEvent = Pick<PublicEventDto, 'attendanceMode' | 'nativeTicket' | 'externalTicket'>;

function resolvedAttendanceMode(event: AttendanceResolvableEvent): AttendanceMode {
  if (event.attendanceMode === 'walk_in'
    || event.attendanceMode === 'external_rsvp'
    || event.attendanceMode === 'external_ticket'
    || event.attendanceMode === 'native_ticket') return event.attendanceMode;
  if (event.nativeTicket) return 'native_ticket';
  if (event.externalTicket?.label === 'RSVP') return 'external_rsvp';
  return 'external_ticket';
}

function externalTicketCtaLabel(label: string | null | undefined, attendanceMode?: AttendanceMode) {
  if (attendanceMode === 'external_rsvp') return 'RSVP';
  return label === 'RSVP' || label === 'View details' ? label : 'Get tickets';
}

function attendanceModeLabel(event: AttendanceResolvableEvent) {
  const attendanceMode = resolvedAttendanceMode(event);
  if (attendanceMode === 'walk_in') return 'Walk-in · admission handled at the venue';
  if (attendanceMode === 'external_rsvp') return 'RSVP through an external provider';
  if (attendanceMode === 'native_ticket') return 'General admission sold by the performer through Sway';
  return 'Tickets through an external provider';
}

function externalAttendancePolicy(event: AttendanceResolvableEvent) {
  return resolvedAttendanceMode(event) === 'external_rsvp'
    ? 'Registration and attendance policies are handled by the external RSVP site.'
    : 'Checkout, charges, and refund policies are handled by the external ticket site.';
}

function externalAttendanceSiteLabel(event: AttendanceResolvableEvent) {
  return resolvedAttendanceMode(event) === 'external_rsvp'
    ? 'external RSVP site'
    : 'external ticket site';
}

function cancelledEventSupportCopy(
  event: AttendanceResolvableEvent
) {
  const attendanceMode = resolvedAttendanceMode(event);
  if (attendanceMode === 'native_ticket') {
    return 'Sway queues full refunds for eligible unused native tickets. Admitted tickets keep their recorded settlement, and disputed payments remain under support review.';
  }
  if (attendanceMode === 'external_rsvp') {
    return 'Contact the external RSVP provider, performer, or venue for next steps.';
  }
  if (attendanceMode === 'external_ticket') {
    return 'Contact the external ticket provider, performer, or venue for refund and support policies.';
  }
  return 'No Sway ticket or RSVP link. Contact the performer or venue for next steps.';
}

function formatUsd(cents: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD'
  }).format(Math.max(0, cents) / 100);
}

export function PublicEventCard({
  event,
  showExternalPolicy = false,
  showPerformer = false
}: {
  event: PublicEventDto;
  showExternalPolicy?: boolean;
  showPerformer?: boolean;
}) {
  const cancelled = isEventCancelled(event);
  const started = hasEventStarted(event);
  const ended = hasEventEnded(event);
  const attendanceMode = resolvedAttendanceMode(event);
  const eventPath = event.eventPath || `/e/${encodeURIComponent(event.id)}`;
  const [coverFailed, setCoverFailed] = useState(false);

  useEffect(() => setCoverFailed(false), [event.coverImageUrl]);

  return (
    <article className="overflow-hidden rounded-2xl border border-white/10 bg-slate-950/70">
      <div className="grid gap-4 p-4 sm:grid-cols-[6.5rem_minmax(0,1fr)]">
        {event.coverImageUrl && !coverFailed ? (
          <img
            src={event.coverImageUrl}
            alt={`${event.title} event artwork`}
            loading="lazy"
            onError={() => setCoverFailed(true)}
            className="aspect-square w-full rounded-xl border border-white/10 object-cover sm:h-[6.5rem]"
          />
        ) : (
          <div className="grid aspect-square w-full place-items-center rounded-xl border border-fuchsia-300/15 bg-fuchsia-500/10 text-fuchsia-200 sm:h-[6.5rem]">
            <CalendarDays className="h-8 w-8" aria-hidden="true" />
          </div>
        )}

        <div className="min-w-0">
          <time dateTime={event.startsAt} className="text-[10px] font-black uppercase tracking-[0.2em] text-fuchsia-200">
            {formatEventDate(event)}
          </time>
          <a
            href={eventPath}
            className="mt-1 block text-base font-black leading-6 text-white transition hover:text-fuchsia-100"
          >
            {event.title}
          </a>
          {showPerformer ? (
            <p className="mt-1 text-xs font-bold text-cyan-200">
              {event.performer.performerPath ? (
                <a href={event.performer.performerPath} className="transition hover:text-white">
                  Presented by {event.performer.displayName}
                </a>
              ) : `Presented by ${event.performer.displayName}`}
            </p>
          ) : null}
          <p className="mt-2 flex items-start gap-2 text-xs leading-5 text-slate-400">
            <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{formatEventSchedule(event)}</span>
          </p>
          <p className="mt-1 flex items-start gap-2 text-xs leading-5 text-slate-400">
            <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{eventLocationLabel(event)}</span>
          </p>
          <p className="mt-1 flex items-start gap-2 text-xs font-bold leading-5 text-cyan-100">
            {attendanceMode === 'walk_in' ? (
              <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <Ticket className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            )}
            <span>{attendanceModeLabel(event)}</span>
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2 border-t border-white/10 p-3 sm:flex-row">
        <a
          href={eventPath}
          className="inline-flex min-h-11 flex-1 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] px-4 text-xs font-black text-white transition hover:border-fuchsia-300/30"
        >
          Event details
        </a>
        {event.externalTicket && !cancelled && !started ? (
          <a
            href={externalTicketRedirectPath(event.id)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${externalTicketCtaLabel(event.externalTicket.label, attendanceMode)} on ${externalAttendanceSiteLabel(event)} (opens in a new tab)`}
            className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-fuchsia-600 px-4 text-xs font-black text-white transition hover:bg-fuchsia-500"
          >
            {externalTicketCtaLabel(event.externalTicket.label, attendanceMode)}
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        ) : event.nativeTicket && !cancelled && !started ? (
          <a
            href={eventPath}
            className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-fuchsia-600 px-4 text-xs font-black text-white transition hover:bg-fuchsia-500"
          >
            {event.nativeTicket.salesStatus === 'on_sale' && event.nativeTicket.remainingCount > 0
              ? `Tickets · ${formatUsd(event.nativeTicket.unitAllInPriceCents)} before tax`
              : event.nativeTicket.salesStatus === 'sold_out' || event.nativeTicket.remainingCount <= 0
                ? 'Sold out'
                : 'Ticket details'}
          </a>
        ) : null}
        {cancelled ? (
          <span className="inline-flex min-h-11 flex-1 items-center justify-center rounded-xl border border-rose-400/25 bg-rose-500/10 px-4 text-xs font-black text-rose-100">
            Event cancelled
          </span>
        ) : null}
        {started && !cancelled ? (
          <span className="inline-flex min-h-11 flex-1 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] px-4 text-xs font-black text-slate-300">
            {ended ? 'Event ended' : event.endsAt ? 'Event in progress' : 'Event started'}
          </span>
        ) : null}
      </div>

      {showExternalPolicy && event.externalTicket && !cancelled && !started ? (
        <p className="border-t border-white/10 px-4 py-3 text-xs leading-5 text-slate-400">
          {externalAttendancePolicy(event)}
        </p>
      ) : null}
    </article>
  );
}

export default function PublicEventPage({ eventId }: { eventId: string }) {
  const [event, setEvent] = useState<PublicEventDto | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [shareMessage, setShareMessage] = useState<string | null>(null);
  const [coverFailed, setCoverFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      setStatus('loading');
      try {
        const response = await fetch(`/api/public/events/${encodeURIComponent(eventId)}`, {
          cache: 'no-store',
          signal: controller.signal
        });
        const data = await response.json().catch(() => null);
        if (response.status === 404) {
          setStatus('missing');
          return;
        }
        if (!response.ok || !data?.event) {
          setStatus('error');
          return;
        }
        setEvent(data.event as PublicEventDto);
        setCoverFailed(false);
        setStatus('ready');
        document.title = `${data.event.title} on Sway`;
        captureDiscoveryAttribution();
        sendDiscoveryEvent('discovery_landing', {
          shell: 'patron', surface: 'public-event', route_family: 'public-event',
          has_route_context: true, has_session_context: false, build_commit: 'unknown',
          attribution_channel: getEffectiveDiscoveryChannel(), entity_kind: 'event', entity_key: eventId,
          visibility_eligibility: 'eligible'
        });
        sendDiscoveryEvent('discovery_entity_view', {
          shell: 'patron', surface: 'public-event', route_family: 'public-event',
          has_route_context: true, has_session_context: false, build_commit: 'unknown',
          attribution_channel: getEffectiveDiscoveryChannel(), entity_kind: 'event', entity_key: eventId,
          visibility_eligibility: 'eligible'
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setStatus('error');
      }
    })();

    return () => controller.abort();
  }, [eventId]);

  const handleShare = async () => {
    if (!event) return;
    const url = new URL(event.eventPath || `/e/${event.id}`, window.location.origin).toString();
    try {
      if (navigator.share) {
        await navigator.share({
          title: event.title,
          text: `${event.title} · ${formatEventDate(event)}`,
          url
        });
        setShareMessage('Share opened');
      } else {
        await navigator.clipboard.writeText(url);
        setShareMessage('Event link copied');
      }
      sendAcquisitionEvent('public_event_shared', {
        shell: 'patron', surface: 'public-event', route_family: 'public-event',
        has_route_context: true, has_session_context: false, build_commit: 'unknown'
      });
      window.setTimeout(() => setShareMessage(null), 1800);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setShareMessage('Could not share this event');
    }
  };

  if (status === 'loading') {
    return (
      <div className="grid min-h-screen place-items-center bg-[#05060a] text-fuchsia-200">
        <Loader2 className="h-7 w-7 animate-spin" aria-label="Loading event" />
      </div>
    );
  }

  if (status !== 'ready' || !event) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#05060a] px-4 text-center text-slate-100">
        <div className="max-w-md">
          <CalendarDays className="mx-auto h-9 w-9 text-slate-500" aria-hidden="true" />
          <h1 className="mt-4 text-2xl font-black">
            {status === 'missing' ? 'Event not available' : 'Event could not load'}
          </h1>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            {status === 'missing'
              ? 'This event may be private, archived, or no longer published.'
              : 'Sway could not load this event. Try again in a moment.'}
          </p>
          <div className="mt-6 flex flex-col justify-center gap-2 sm:flex-row">
            <a href="/discover" className="inline-flex min-h-11 items-center justify-center rounded-xl bg-fuchsia-600 px-4 text-sm font-black text-white">
              Discover shows
            </a>
            <a href="/" className="inline-flex min-h-11 items-center justify-center rounded-xl border border-white/10 px-4 text-sm font-bold text-slate-200">
              Sway home
            </a>
          </div>
        </div>
      </main>
    );
  }

  const cancelled = isEventCancelled(event);
  const started = hasEventStarted(event);
  const ended = hasEventEnded(event);
  const attendanceMode = resolvedAttendanceMode(event);
  const performerPath = event.performer.performerPath || (event.performer.handle
    ? `/p/${encodeURIComponent(event.performer.handle)}`
    : null);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_20%_0%,rgba(217,70,239,0.24),transparent_35%),radial-gradient(circle_at_90%_18%,rgba(34,211,238,0.14),transparent_32%),#05060a] px-4 py-5 text-slate-100 sm:py-8">
      <div className="mx-auto max-w-3xl">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <a
            href={performerPath || '/'}
            className="inline-flex min-h-10 items-center gap-2 text-xs font-bold text-slate-300 transition hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            {performerPath ? event.performer.displayName : 'Sway'}
          </a>
          <div className="flex items-center gap-2">
            <a
              href="/discover"
              className="inline-flex min-h-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] px-4 text-xs font-black text-slate-200 transition hover:border-fuchsia-300/35 hover:text-white"
            >
              Discover shows
            </a>
            <button
              type="button"
              onClick={handleShare}
              className="inline-flex min-h-10 items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 text-xs font-black text-slate-200 transition hover:border-cyan-300/35 hover:text-white"
            >
              <Share2 className="h-3.5 w-3.5" aria-hidden="true" />
              {shareMessage || 'Share'}
            </button>
          </div>
        </header>

        <section className="mt-5 overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950/75 shadow-2xl backdrop-blur-xl">
          {event.coverImageUrl && !coverFailed ? (
            <img
              src={event.coverImageUrl}
              alt={`${event.title} event artwork`}
              onError={() => setCoverFailed(true)}
              className="aspect-[16/9] w-full border-b border-white/10 object-cover"
            />
          ) : (
            <div className="grid aspect-[16/7] w-full place-items-center border-b border-white/10 bg-gradient-to-br from-fuchsia-500/20 to-cyan-400/10 text-fuchsia-100">
              <CalendarDays className="h-16 w-16" aria-hidden="true" />
            </div>
          )}

          <div className="p-5 sm:p-7">
            {cancelled ? (
              <div className="mb-5 flex items-start gap-3 rounded-2xl border border-rose-400/30 bg-rose-500/10 p-4 text-rose-100">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
                <div>
                  <p className="font-black">This event has been cancelled.</p>
                  <p className="mt-1 text-xs leading-5 text-rose-100/80">
                    {event.cancellationReason || 'This event is no longer taking place.'}{' '}
                    {cancelledEventSupportCopy(event)}
                  </p>
                </div>
              </div>
            ) : null}

            <time dateTime={event.startsAt} className="text-[10px] font-black uppercase tracking-[0.25em] text-fuchsia-200">
              {formatEventDate(event)}
            </time>
            <h1 className="mt-2 font-display text-3xl font-black leading-tight text-white sm:text-5xl">{event.title}</h1>
            <p className="mt-3 text-sm font-bold text-slate-300">
              Presented by{' '}
              {performerPath ? (
                <a href={performerPath} className="text-cyan-200 transition hover:text-white">{event.performer.displayName}</a>
              ) : event.performer.displayName}
            </p>

            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              <div className="flex items-start gap-3 rounded-2xl border border-white/10 bg-white/[0.035] p-4">
                <Clock className="mt-0.5 h-4 w-4 shrink-0 text-fuchsia-200" aria-hidden="true" />
                <div>
                  <p className="text-[9px] font-black uppercase tracking-[0.2em] text-slate-500">When</p>
                  <p className="mt-1 text-sm font-bold text-white">{formatEventSchedule(event)}</p>
                </div>
              </div>
              <div className="flex items-start gap-3 rounded-2xl border border-white/10 bg-white/[0.035] p-4">
                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-cyan-200" aria-hidden="true" />
                <div>
                  <p className="text-[9px] font-black uppercase tracking-[0.2em] text-slate-500">Where</p>
                  <p className="mt-1 text-sm font-bold text-white">{eventLocationLabel(event)}</p>
                  {!event.location.isTba && event.location.address ? (
                    <p className="mt-1 text-xs leading-5 text-slate-400">{event.location.address}</p>
                  ) : null}
                </div>
              </div>
              <div className="flex items-start gap-3 rounded-2xl border border-white/10 bg-white/[0.035] p-4 sm:col-span-2">
                {attendanceMode === 'walk_in' ? (
                  <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-emerald-200" aria-hidden="true" />
                ) : (
                  <Ticket className="mt-0.5 h-4 w-4 shrink-0 text-emerald-200" aria-hidden="true" />
                )}
                <div>
                  <p className="text-[9px] font-black uppercase tracking-[0.2em] text-slate-500">Attendance</p>
                  <p className="mt-1 text-sm font-bold text-white">{attendanceModeLabel(event)}</p>
                </div>
              </div>
            </div>

            {event.description ? (
              <div className="mt-6 whitespace-pre-line text-sm leading-7 text-slate-300">{event.description}</div>
            ) : null}

            {event.externalTicket && !cancelled && !started ? (
              <div className="mt-7 rounded-2xl border border-fuchsia-300/20 bg-fuchsia-500/[0.07] p-4">
                <a
                  href={externalTicketRedirectPath(event.id)}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => sendDiscoveryEvent('discovery_primary_action', {
                    shell: 'patron', surface: 'public-event', route_family: 'public-event',
                    has_route_context: true, has_session_context: false, build_commit: 'unknown',
                    attribution_channel: getEffectiveDiscoveryChannel(), entity_kind: 'event', entity_key: event.id,
                    action_kind: attendanceMode === 'external_rsvp' ? 'other' : 'ticket', visibility_eligibility: 'eligible'
                  })}
                  aria-label={`${externalTicketCtaLabel(event.externalTicket.label, attendanceMode)} on ${externalAttendanceSiteLabel(event)} (opens in a new tab)`}
                  className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-fuchsia-600 px-5 text-sm font-black text-white transition hover:bg-fuchsia-500"
                >
                  {externalTicketCtaLabel(event.externalTicket.label, attendanceMode)}
                  <ExternalLink className="h-4 w-4" aria-hidden="true" />
                </a>
                <p className="mt-3 text-xs leading-5 text-slate-400">
                  {attendanceMode === 'external_rsvp'
                    ? 'You are leaving Sway. Registration, admission, cancellations, and support are handled under the external RSVP provider’s policies.'
                    : 'You are leaving Sway. Checkout, charges, ticket delivery, admission, transfers, cancellations, refunds, and support are handled under the external ticket provider’s policies.'}
                </p>
              </div>
            ) : event.nativeTicket && !cancelled && !started ? (
              <EventTicketPurchaseCard
                className="mt-7"
                eventId={event.id}
                eventTitle={event.title}
                offer={event.nativeTicket}
              />
            ) : attendanceMode === 'walk_in' && !cancelled && !started ? (
              <div className="mt-7 rounded-2xl border border-white/10 bg-white/[0.035] p-4 text-slate-200">
                <p className="text-sm font-black text-white">Walk-in · admission handled at the venue</p>
                <p className="mt-2 text-xs leading-5 text-slate-400">
                  No Sway ticket or RSVP link. Contact the performer or venue for admission details.
                </p>
              </div>
            ) : !cancelled && !started ? (
              <div className="mt-7 rounded-2xl border border-amber-300/20 bg-amber-300/[0.06] p-4 text-sm text-amber-100">
                The listed attendance action is unavailable. Contact the performer or venue for details.
              </div>
            ) : started && !cancelled ? (
              <div className="mt-7 rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-sm text-slate-300">
                {ended
                  ? 'This event has ended.'
                  : attendanceMode === 'walk_in'
                    ? 'This event has started. Contact the performer or venue for current admission details.'
                    : 'This event has started. Ticket or RSVP actions are closed.'}
              </div>
            ) : null}
          </div>
        </section>

        <DiscoveryFindUsPrompt routeFamily="public-event" surface="public-event" entityKey={event.id} />

        <footer className="mt-8 flex flex-col items-center justify-center gap-3 pb-6 text-center sm:flex-row">
          <a href="/discover" className="text-xs font-black text-fuchsia-200 transition hover:text-white">Discover live rooms and shows</a>
          <span className="hidden text-slate-700 sm:inline">·</span>
          <a href="/" className="text-xs font-bold text-slate-500 transition hover:text-white">sway to play</a>
        </footer>
      </div>
    </main>
  );
}
