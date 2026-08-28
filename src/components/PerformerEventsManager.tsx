import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  CalendarDays,
  CheckCircle2,
  Clock,
  DoorOpen,
  Edit3,
  ExternalLink,
  Loader2,
  MapPin,
  Plus,
  Save,
  Ticket,
  XCircle
} from 'lucide-react';

type TicketingMode = 'external' | 'native_ga';

type NativeTicketSummary = {
  capacity: number | null;
  faceValueCents: number | null;
  mandatoryFeeCents: number | null;
  unitAllInPriceCents: number | null;
  remainingCount: number | null;
  salesStatus: string | null;
};

type NativeTicketCapability = {
  salesAvailable: boolean;
  reasonCodes: string[];
  feeBps: number | null;
  feeFixedCents: number | null;
  taxMode: 'stripe_automatic' | 'not_required' | null;
  reservationMinutes: number | null;
  refundGraceMinutes: number | null;
  termsVersion: string;
  termsHash: string;
  supportEmail: string | null;
};

type ManagedEvent = {
  id: string;
  title: string;
  description: string | null;
  startsAt: string;
  doorOpensAt: string | null;
  endsAt: string | null;
  timeZone: string;
  locationName: string | null;
  locationAddress: string | null;
  city: string | null;
  locationIsTba: boolean;
  coverImageUrl: string | null;
  ticketingMode: TicketingMode;
  externalTicketUrl: string | null;
  externalTicketLabel: string | null;
  nativeTicket: NativeTicketSummary | null;
  visibility: 'public' | 'unlisted';
  status: string;
  eventPath: string | null;
  updatedAt: string;
};

type EventFormState = {
  eventId: string | null;
  clientRequestId: string;
  expectedUpdatedAt: string | null;
  title: string;
  description: string;
  startsAt: string;
  doorOpensAt: string;
  endsAt: string;
  timeZone: string;
  locationName: string;
  locationAddress: string;
  city: string;
  locationIsTba: boolean;
  coverImageUrl: string;
  ticketingMode: TicketingMode;
  externalTicketUrl: string;
  externalTicketLabel: string;
  nativeCapacity: string;
  nativeFaceValueUsd: string;
  nativeTermsAccepted: boolean;
  visibility: 'public' | 'unlisted';
};

const EXTERNAL_TICKET_LABELS = ['Get tickets', 'RSVP', 'View details'] as const;

function clientRequestId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const value = Math.floor(Math.random() * 16);
    const output = character === 'x' ? value : (value & 0x3) | 0x8;
    return output.toString(16);
  });
}

function detectedTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function emptyForm(): EventFormState {
  return {
    eventId: null,
    clientRequestId: clientRequestId(),
    expectedUpdatedAt: null,
    title: '',
    description: '',
    startsAt: '',
    doorOpensAt: '',
    endsAt: '',
    timeZone: detectedTimeZone(),
    locationName: '',
    locationAddress: '',
    city: '',
    locationIsTba: false,
    coverImageUrl: '',
    ticketingMode: 'external',
    externalTicketUrl: '',
    externalTicketLabel: 'Get tickets',
    nativeCapacity: '',
    nativeFaceValueUsd: '',
    nativeTermsAccepted: false,
    visibility: 'public'
  };
}

function text(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function nullableInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function normalizeNativeTicket(value: any): NativeTicketSummary | null {
  if (!value || typeof value !== 'object') return null;
  return {
    capacity: nullableInteger(value.capacity),
    faceValueCents: nullableInteger(value.faceValueCents),
    mandatoryFeeCents: nullableInteger(value.mandatoryFeeCents),
    unitAllInPriceCents: nullableInteger(value.unitAllInPriceCents ?? value.totalPriceCents),
    remainingCount: nullableInteger(value.remainingCount ?? value.availableCount),
    salesStatus: text(value.salesStatus) || null
  };
}

function normalizeManagedEvent(value: any): ManagedEvent | null {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string') return null;
  const nestedLocation = value.location && typeof value.location === 'object' ? value.location : {};
  const nestedTicket = value.externalTicket && typeof value.externalTicket === 'object' ? value.externalTicket : {};
  const nativeTicket = normalizeNativeTicket(value.nativeTicket ?? value.ticketOffer);
  const ticketingMode: TicketingMode = value.ticketingMode === 'native_ga' || nativeTicket
    ? 'native_ga'
    : 'external';
  return {
    id: value.id,
    title: text(value.title),
    description: text(value.description) || null,
    startsAt: text(value.startsAt),
    doorOpensAt: text(value.doorOpensAt) || null,
    endsAt: text(value.endsAt) || null,
    timeZone: text(value.timeZone) || detectedTimeZone(),
    locationName: text(value.locationName ?? nestedLocation.name) || null,
    locationAddress: text(value.locationAddress ?? nestedLocation.address) || null,
    city: text(value.city ?? nestedLocation.city) || null,
    locationIsTba: value.locationIsTba === true || nestedLocation.isTba === true,
    coverImageUrl: text(value.coverImageUrl) || null,
    ticketingMode,
    externalTicketUrl: text(value.externalTicketUrl ?? nestedTicket.url) || null,
    externalTicketLabel: text(value.externalTicketLabel ?? nestedTicket.label) || null,
    nativeTicket,
    visibility: value.visibility === 'unlisted' ? 'unlisted' : 'public',
    status: text(value.status) || 'draft',
    eventPath: text(value.eventPath) || null,
    updatedAt: text(value.updatedAt)
  };
}

function zonedParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const parts = Object.fromEntries(formatter.formatToParts(date)
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, Number(part.value)]));
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second
  };
}

function localInputFromIso(value: string | null, timeZone: string) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  try {
    const parts = zonedParts(date, timeZone);
    const pad = (part: number) => String(part).padStart(2, '0');
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
  } catch {
    return date.toISOString().slice(0, 16);
  }
}

function isoFromZonedLocal(value: string, timeZone: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error('Choose a valid event date and time.');

  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
  } catch {
    throw new Error('Use a valid IANA time zone, such as America/Chicago.');
  }

  const desired = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: 0
  };
  const desiredUtc = Date.UTC(
    desired.year,
    desired.month - 1,
    desired.day,
    desired.hour,
    desired.minute,
    desired.second
  );
  let candidate = desiredUtc;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const represented = zonedParts(new Date(candidate), timeZone);
    const representedUtc = Date.UTC(
      represented.year,
      represented.month - 1,
      represented.day,
      represented.hour,
      represented.minute,
      represented.second
    );
    const difference = desiredUtc - representedUtc;
    candidate += difference;
    if (difference === 0) break;
  }

  const roundTrip = zonedParts(new Date(candidate), timeZone);
  if (
    roundTrip.year !== desired.year
    || roundTrip.month !== desired.month
    || roundTrip.day !== desired.day
    || roundTrip.hour !== desired.hour
    || roundTrip.minute !== desired.minute
  ) {
    throw new Error('That local time does not exist in the selected time zone. Choose another time.');
  }

  return new Date(candidate).toISOString();
}

function editForm(event: ManagedEvent): EventFormState {
  return {
    eventId: event.id,
    clientRequestId: clientRequestId(),
    expectedUpdatedAt: event.updatedAt || null,
    title: event.title,
    description: event.description || '',
    startsAt: localInputFromIso(event.startsAt, event.timeZone),
    doorOpensAt: localInputFromIso(event.doorOpensAt, event.timeZone),
    endsAt: localInputFromIso(event.endsAt, event.timeZone),
    timeZone: event.timeZone,
    locationName: event.locationName || '',
    locationAddress: event.locationAddress || '',
    city: event.city || '',
    locationIsTba: event.locationIsTba,
    coverImageUrl: event.coverImageUrl || '',
    ticketingMode: event.ticketingMode,
    externalTicketUrl: event.externalTicketUrl || '',
    externalTicketLabel: event.externalTicketLabel || 'Get tickets',
    nativeCapacity: event.nativeTicket?.capacity === null || event.nativeTicket?.capacity === undefined
      ? ''
      : String(event.nativeTicket.capacity),
    nativeFaceValueUsd: event.nativeTicket?.faceValueCents === null
      || event.nativeTicket?.faceValueCents === undefined
      ? ''
      : (event.nativeTicket.faceValueCents / 100).toFixed(2),
    nativeTermsAccepted: false,
    visibility: event.visibility
  };
}

function usdInputToCents(value: string) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error('Enter the ticket face value in USD, using no more than two decimal places.');
  const dollars = Number(match[1]);
  const cents = Number((match[2] || '').padEnd(2, '0'));
  const total = dollars * 100 + cents;
  if (!Number.isSafeInteger(total) || total < 100) {
    throw new Error('Native ticket face value must be at least $1.00 USD.');
  }
  return total;
}

function positiveCapacity(value: string) {
  if (!/^\d+$/.test(value.trim())) throw new Error('Enter a whole-number native ticket capacity.');
  const capacity = Number(value);
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new Error('Native ticket capacity must be at least 1.');
  }
  return capacity;
}

function formatUsd(cents: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD'
  }).format(cents / 100);
}

function salesStatusLabel(value: string | null) {
  if (!value) return null;
  return value.replace(/_/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function durationLabel(minutes: number) {
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `${days} ${days === 1 ? 'day' : 'days'}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

function dateTimeLabel(value: string, timeZone: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
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

function eventDateLabel(event: ManagedEvent) {
  return dateTimeLabel(event.startsAt, event.timeZone);
}

function fieldClass() {
  return 'min-h-12 w-full rounded-xl border border-white/10 bg-slate-950 px-3.5 py-3 text-sm font-semibold text-white outline-none transition focus:border-fuchsia-400 focus:ring-1 focus:ring-fuchsia-400/30 disabled:cursor-not-allowed disabled:opacity-50';
}

function fieldLabel() {
  return 'text-[9px] font-black uppercase tracking-[0.2em] text-slate-500';
}

export default function PerformerEventsManager({ previewMode = false }: { previewMode?: boolean }) {
  const [events, setEvents] = useState<ManagedEvent[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(previewMode ? 'ready' : 'loading');
  const [actionPending, setActionPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [nativeCapability, setNativeCapability] = useState<NativeTicketCapability | null>(null);
  const [form, setForm] = useState<EventFormState>(() => emptyForm());
  const [formOpen, setFormOpen] = useState(false);
  const [cancelDraft, setCancelDraft] = useState<{
    eventId: string;
    reason: string;
    externalProviderConfirmed: boolean;
  } | null>(null);
  const [failedCoverImages, setFailedCoverImages] = useState<Set<string>>(() => new Set());

  const loadEvents = async (signal?: AbortSignal) => {
    if (previewMode) return;
    setStatus('loading');
    try {
      const response = await fetch('/api/talent/events', { cache: 'no-store', signal });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || 'Unable to load your events.');
      const capabilityResponse = await fetch('/api/talent/events/native-ticket-capability', {
        cache: 'no-store',
        signal
      });
      const capabilityData = await capabilityResponse.json().catch(() => null);
      const capability = capabilityData?.capability;
      setNativeCapability(
        capabilityResponse.ok && capability && typeof capability === 'object'
          ? {
              salesAvailable: capability.salesAvailable === true,
              reasonCodes: Array.isArray(capability.reasonCodes)
                ? capability.reasonCodes.filter((value: unknown): value is string => typeof value === 'string')
                : [],
              feeBps: nullableInteger(capability.feeBps),
              feeFixedCents: nullableInteger(capability.feeFixedCents),
              taxMode: capability.taxMode === 'stripe_automatic' || capability.taxMode === 'not_required'
                ? capability.taxMode
                : null,
              reservationMinutes: nullableInteger(capability.reservationMinutes),
              refundGraceMinutes: nullableInteger(capability.refundGraceMinutes),
              termsVersion: text(capability.termsVersion),
              termsHash: text(capability.termsHash),
              supportEmail: text(capability.supportEmail) || null
            }
          : {
              salesAvailable: false,
              reasonCodes: ['native_ticket_readiness_unavailable'],
              feeBps: null,
              feeFixedCents: null,
              taxMode: null,
              reservationMinutes: null,
              refundGraceMinutes: null,
              termsVersion: '',
              termsHash: '',
              supportEmail: null
            }
      );
      const normalized = Array.isArray(data?.events)
        ? data.events.map(normalizeManagedEvent).filter((event): event is ManagedEvent => Boolean(event))
        : [];
      setEvents(normalized);
      setStatus('ready');
      if (normalized.length === 0) setFormOpen(true);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'Unable to load your events.');
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void loadEvents(controller.signal);
    return () => controller.abort();
  }, [previewMode]);

  const sortedEvents = useMemo(() => {
    const now = Date.now();
    return [...events].sort((left, right) => {
      const leftStart = new Date(left.startsAt).getTime();
      const rightStart = new Date(right.startsAt).getTime();
      const leftUpcoming = leftStart >= now;
      const rightUpcoming = rightStart >= now;
      if (leftUpcoming !== rightUpcoming) return leftUpcoming ? -1 : 1;
      return leftUpcoming ? leftStart - rightStart : rightStart - leftStart;
    });
  }, [events]);
  const editingNativeTicket = form.eventId
    ? events.find((event) => event.id === form.eventId)?.nativeTicket ?? null
    : null;
  const nativePriceQuote = useMemo(() => {
    if (
      form.ticketingMode !== 'native_ga'
      || nativeCapability?.feeBps === null
      || nativeCapability?.feeBps === undefined
      || nativeCapability.feeFixedCents === null
    ) return null;
    try {
      const faceValueCents = usdInputToCents(form.nativeFaceValueUsd);
      const mandatoryFeeCents = Math.ceil(
        faceValueCents * nativeCapability.feeBps / 10_000
      ) + nativeCapability.feeFixedCents;
      return {
        faceValueCents,
        mandatoryFeeCents,
        totalPriceCents: faceValueCents + mandatoryFeeCents
      };
    } catch {
      return null;
    }
  }, [
    form.ticketingMode,
    form.nativeFaceValueUsd,
    nativeCapability?.feeBps,
    nativeCapability?.feeFixedCents
  ]);

  const resetForm = (clearMessage = true) => {
    setForm(emptyForm());
    if (clearMessage) setMessage(null);
  };

  const openNewEvent = () => {
    resetForm();
    setCancelDraft(null);
    setFormOpen(true);
  };

  const openEditEvent = (event: ManagedEvent) => {
    setForm(editForm(event));
    setCancelDraft(null);
    setFormOpen(true);
    setMessage(null);
    window.setTimeout(() => document.getElementById('sway-event-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  };

  const handleSave = async (submitEvent: FormEvent<HTMLFormElement>) => {
    submitEvent.preventDefault();
    if (previewMode || actionPending) return;
    setActionPending(true);
    setMessage(null);

    try {
      const startsAt = isoFromZonedLocal(form.startsAt, form.timeZone.trim());
      const doorOpensAt = form.ticketingMode === 'native_ga'
        ? isoFromZonedLocal(form.doorOpensAt, form.timeZone.trim())
        : null;
      const endsAt = form.endsAt ? isoFromZonedLocal(form.endsAt, form.timeZone.trim()) : null;
      if (form.ticketingMode === 'native_ga' && !endsAt) {
        throw new Error('Native paid admission requires an event end time.');
      }
      if (
        form.ticketingMode === 'native_ga'
        && !form.eventId
        && nativeCapability?.salesAvailable !== true
      ) {
        throw new Error('Native ticket sales are not ready for this performer. Choose an external ticket link.');
      }
      if (endsAt && new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
        throw new Error('Event end time must be after the start time.');
      }
      if (doorOpensAt && new Date(doorOpensAt).getTime() > new Date(startsAt).getTime()) {
        throw new Error('Door-open time must be at or before the show start time.');
      }

      const nativeConfig = form.ticketingMode === 'native_ga'
        ? {
            capacity: positiveCapacity(form.nativeCapacity),
            faceValueCents: usdInputToCents(form.nativeFaceValueUsd)
          }
        : null;
      if (nativeConfig && !form.nativeTermsAccepted) {
        throw new Error('Accept the native ticket seller terms before saving this setup.');
      }

      const body = {
        ...(form.eventId
          ? { expectedUpdatedAt: form.expectedUpdatedAt }
          : { clientRequestId: form.clientRequestId }),
        ...(!form.eventId ? { ticketingMode: form.ticketingMode } : {}),
        title: form.title,
        description: form.description,
        startsAt,
        doorOpensAt,
        endsAt,
        timeZone: form.timeZone.trim(),
        locationName: form.locationName,
        locationAddress: form.locationAddress,
        city: form.city,
        locationIsTba: form.locationIsTba,
        coverImageUrl: form.coverImageUrl,
        externalTicketUrl: form.ticketingMode === 'external' ? form.externalTicketUrl : '',
        externalTicketLabel: form.ticketingMode === 'external' && form.externalTicketUrl.trim()
          ? form.externalTicketLabel
          : '',
        visibility: form.visibility
      };

      if (form.eventId && !form.expectedUpdatedAt) {
        throw new Error('This event is missing its update version. Reload before editing it.');
      }

      const response = await fetch(
        form.eventId ? `/api/talent/events/${encodeURIComponent(form.eventId)}` : '/api/talent/events',
        {
          method: form.eventId ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }
      );
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || 'Unable to save this event.');

      const savedEvent = normalizeManagedEvent(data?.event);
      const savedEventId = savedEvent?.id || form.eventId;
      if (nativeConfig) {
        if (!savedEventId) {
          throw new Error('Event draft saved, but its native ticket setup could not be linked. Reload and try again.');
        }
        const ticketingResponse = await fetch(
          `/api/talent/events/${encodeURIComponent(savedEventId)}/ticketing`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              capacity: nativeConfig.capacity,
              faceValueCents: nativeConfig.faceValueCents,
              termsAccepted: true
            })
          }
        );
        const ticketingData = await ticketingResponse.json().catch(() => null);
        if (!ticketingResponse.ok) {
          setForm((current) => ({
            ...current,
            eventId: savedEventId,
            expectedUpdatedAt: savedEvent?.updatedAt || current.expectedUpdatedAt,
            clientRequestId: clientRequestId()
          }));
          throw new Error(
            `Event draft saved, but native ticket setup did not save. ${
              ticketingData?.error || 'Review the ticket details and try again.'
            }`
          );
        }
      }

      setMessage(
        nativeConfig
          ? form.eventId
            ? 'Event and native ticket setup saved.'
            : 'Event draft and native ticket setup saved. Review it before publishing.'
          : form.eventId
            ? 'Event changes saved.'
            : 'Event draft created.'
      );
      setFormOpen(false);
      resetForm(false);
      await loadEvents();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to save this event.');
    } finally {
      setActionPending(false);
    }
  };

  const publishEvent = async (event: ManagedEvent) => {
    if (previewMode || actionPending) return;
    if (!event.updatedAt) {
      setMessage('This event is missing its update version. Reload before publishing it.');
      return;
    }
    setActionPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/talent/events/${encodeURIComponent(event.id)}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedUpdatedAt: event.updatedAt })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || 'Unable to publish this event.');
      setMessage(
        event.visibility === 'unlisted'
          ? 'Event published as link-only. Share its event-page URL directly.'
          : 'Event published to your public profile and Discover.'
      );
      await loadEvents();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to publish this event.');
    } finally {
      setActionPending(false);
    }
  };

  const cancelEvent = async (event: ManagedEvent) => {
    if (previewMode || actionPending || cancelDraft?.eventId !== event.id) return;
    if (!cancelDraft.reason.trim()) {
      setMessage('Add a clear cancellation reason before cancelling this event.');
      return;
    }
    if (event.ticketingMode === 'external' && !cancelDraft.externalProviderConfirmed) {
      setMessage('Confirm that you will handle external-provider cancellation duties before continuing.');
      return;
    }
    if (!event.updatedAt) {
      setMessage('This event is missing its update version. Reload before cancelling it.');
      return;
    }

    setActionPending(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/talent/events/${encodeURIComponent(event.id)}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedUpdatedAt: event.updatedAt,
          cancellationReason: cancelDraft.reason.trim()
        })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || 'Unable to cancel this event.');
      setCancelDraft(null);
      setMessage(
        event.ticketingMode === 'native_ga'
          ? 'Event cancelled. Eligible unused native tickets are queued for refund. Admitted tickets keep their recorded settlement, disputed payments remain under support review, and processor confirmation may remain pending.'
          : 'Sway listing cancelled. Its external ticket action is no longer public.'
      );
      await loadEvents();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to cancel this event.');
    } finally {
      setActionPending(false);
    }
  };

  return (
    <section
      id="sway-events-manager"
      data-sway-events-manager="true"
      className="mx-auto w-full max-w-6xl scroll-mt-24 overflow-hidden rounded-2xl border border-fuchsia-300/20 bg-slate-900/80 shadow-xl shadow-fuchsia-950/10"
    >
      <div className="border-b border-white/10 bg-gradient-to-r from-fuchsia-500/10 via-cyan-500/10 to-transparent p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.28em] text-fuchsia-300">Shows and events</p>
            <h3 className="mt-2 font-display text-xl font-black text-white">Put upcoming shows on your public page</h3>
            <p className="mt-2 max-w-xl text-xs leading-5 text-slate-400">
              Add a real date and location, then choose an external ticket destination or native Sway
              general admission. Each event stays a performer-to-customer offer.
            </p>
          </div>
          <button
            type="button"
            onClick={openNewEvent}
            disabled={previewMode || actionPending}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-fuchsia-600 px-4 text-xs font-black text-white transition hover:bg-fuchsia-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add event
          </button>
        </div>
      </div>

      {previewMode ? (
        <div className="border-b border-amber-300/20 bg-amber-300/[0.06] px-5 py-3 text-xs leading-5 text-amber-100">
          Event management is read-only in demo mode. No event request will be sent.
        </div>
      ) : null}

      {message ? (
        <div role="status" className="border-b border-white/10 bg-slate-950/60 px-5 py-3 text-xs leading-5 text-slate-200">
          {message}
        </div>
      ) : null}

      {formOpen ? (
        <form id="sway-event-editor" className="space-y-5 border-b border-white/10 p-4 sm:p-6" onSubmit={handleSave}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.24em] text-cyan-300">
                {form.eventId ? 'Edit event' : 'New event'}
              </p>
              <h4 className="mt-1 text-lg font-black text-white">{form.eventId ? 'Update the listing' : 'List a show'}</h4>
            </div>
            <button
              type="button"
              onClick={() => {
                setFormOpen(false);
                resetForm();
              }}
              className="inline-flex min-h-10 items-center justify-center rounded-xl border border-white/10 px-3 text-xs font-black text-slate-300 hover:text-white"
            >
              Close
            </button>
          </div>

          <fieldset disabled={previewMode || actionPending} className="grid gap-4 disabled:opacity-60 sm:grid-cols-2">
            <label className="space-y-1.5 sm:col-span-2">
              <span className={fieldLabel()}>Event title</span>
              <input
                required
                maxLength={140}
                className={fieldClass()}
                value={form.title}
                onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                placeholder="Saturday night with @yourhandle"
              />
            </label>

            <label className="space-y-1.5 sm:col-span-2">
              <span className={fieldLabel()}>Description</span>
              <textarea
                maxLength={2000}
                className={`${fieldClass()} min-h-28 resize-y leading-6`}
                value={form.description}
                onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
                placeholder="What should someone know before they go?"
              />
            </label>

            <label className="space-y-1.5">
              <span className={fieldLabel()}>
                {form.ticketingMode === 'native_ga' ? 'Show starts' : 'Starts'}
              </span>
              <input
                required
                type="datetime-local"
                className={fieldClass()}
                value={form.startsAt}
                onChange={(event) => setForm((current) => ({ ...current, startsAt: event.target.value }))}
              />
            </label>
            {form.ticketingMode === 'native_ga' ? (
              <label className="space-y-1.5">
                <span className={fieldLabel()}>Doors open — check-in begins</span>
                <input
                  required
                  type="datetime-local"
                  className={fieldClass()}
                  value={form.doorOpensAt}
                  onChange={(event) => setForm((current) => ({ ...current, doorOpensAt: event.target.value }))}
                />
                <span className="block text-[11px] leading-5 text-slate-500">
                  Sway will not reveal admission credentials or accept a ticket before this time.
                </span>
              </label>
            ) : null}
            <label className="space-y-1.5">
              <span className={fieldLabel()}>
                Ends {form.ticketingMode === 'native_ga' ? '— required for native tickets' : '— optional'}
              </span>
              <input
                required={form.ticketingMode === 'native_ga'}
                type="datetime-local"
                className={fieldClass()}
                value={form.endsAt}
                onChange={(event) => setForm((current) => ({ ...current, endsAt: event.target.value }))}
              />
            </label>

            <label className="space-y-1.5 sm:col-span-2">
              <span className={fieldLabel()}>Event time zone</span>
              <input
                required
                className={fieldClass()}
                value={form.timeZone}
                onChange={(event) => setForm((current) => ({ ...current, timeZone: event.target.value }))}
                placeholder="America/Chicago"
              />
              <span className="block text-[11px] leading-5 text-slate-500">
                Use an IANA time zone. Times are saved and displayed in this zone.
              </span>
            </label>

            <label className="flex min-h-12 items-center gap-3 rounded-xl border border-white/10 bg-slate-950 px-4 text-xs font-bold text-slate-300 sm:col-span-2">
              <input
                type="checkbox"
                checked={form.locationIsTba}
                onChange={(event) => setForm((current) => ({ ...current, locationIsTba: event.target.checked }))}
                className="h-4 w-4"
              />
              Show “Location TBA” instead of public location details
            </label>

            <label className="space-y-1.5">
              <span className={fieldLabel()}>Location name</span>
              <input
                maxLength={160}
                disabled={form.locationIsTba}
                className={fieldClass()}
                value={form.locationName}
                onChange={(event) => setForm((current) => ({ ...current, locationName: event.target.value }))}
                placeholder="The room, hall, park, or online show"
              />
            </label>
            <label className="space-y-1.5">
              <span className={fieldLabel()}>City</span>
              <input
                maxLength={120}
                disabled={form.locationIsTba}
                className={fieldClass()}
                value={form.city}
                onChange={(event) => setForm((current) => ({ ...current, city: event.target.value }))}
                placeholder={form.ticketingMode === 'native_ga' ? 'Pensacola, FL 32501' : 'Pensacola, FL'}
              />
            </label>
            <label className="space-y-1.5 sm:col-span-2">
              <span className={fieldLabel()}>
                {form.ticketingMode === 'native_ga' ? 'Event street address' : 'Public address — optional'}
              </span>
              <input
                maxLength={240}
                disabled={form.locationIsTba}
                className={fieldClass()}
                value={form.locationAddress}
                onChange={(event) => setForm((current) => ({ ...current, locationAddress: event.target.value }))}
                placeholder={form.ticketingMode === 'native_ga'
                  ? 'Required for Stripe ticket-tax calculation'
                  : 'Only add an address you want visible to everyone'}
              />
            </label>

            <label className="space-y-1.5 sm:col-span-2">
              <span className={fieldLabel()}>Cover image URL — optional</span>
              <input
                type="url"
                className={fieldClass()}
                value={form.coverImageUrl}
                onChange={(event) => setForm((current) => ({ ...current, coverImageUrl: event.target.value }))}
                placeholder="https://..."
              />
            </label>

            <div className="space-y-2 sm:col-span-2">
              <span className={fieldLabel()}>Ticketing</span>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-xs leading-5 transition ${
                  form.ticketingMode === 'external'
                    ? 'border-fuchsia-300/35 bg-fuchsia-500/10 text-white'
                    : 'border-white/10 bg-slate-950 text-slate-400'
                }`}>
                  <input
                    type="radio"
                    name="ticketingMode"
                    value="external"
                    disabled={Boolean(form.eventId)}
                    checked={form.ticketingMode === 'external'}
                    onChange={() => setForm((current) => ({
                      ...current,
                      ticketingMode: 'external',
                      nativeTermsAccepted: false
                    }))}
                    className="mt-1 h-4 w-4 shrink-0"
                  />
                  <span>
                    <strong className="block font-black">External ticket or RSVP</strong>
                    Sway links customers to another provider.
                  </span>
                </label>
                <label className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-xs leading-5 transition ${
                  form.ticketingMode === 'native_ga'
                    ? 'border-cyan-300/35 bg-cyan-500/10 text-white'
                    : 'border-white/10 bg-slate-950 text-slate-400'
                }`}>
                  <input
                    type="radio"
                    name="ticketingMode"
                    value="native_ga"
                    disabled={Boolean(form.eventId) || nativeCapability?.salesAvailable !== true}
                    checked={form.ticketingMode === 'native_ga'}
                    onChange={() => setForm((current) => ({
                      ...current,
                      ticketingMode: 'native_ga',
                      nativeTermsAccepted: false
                    }))}
                    className="mt-1 h-4 w-4 shrink-0"
                  />
                  <span>
                    <strong className="block font-black">Native Sway paid GA</strong>
                    One general-admission ticket per customer checkout.
                  </span>
                </label>
              </div>
              {!form.eventId && nativeCapability?.salesAvailable !== true ? (
                <span className="block text-[11px] leading-5 text-amber-200">
                  Native sales stay unavailable until Sway’s payment, tax, admission, and performer payout
                  readiness checks all pass. You can create an external-ticket event now.
                </span>
              ) : null}
              {form.eventId ? (
                <span className="block text-[11px] leading-5 text-slate-500">
                  Ticketing mode is locked after the event draft is created.
                </span>
              ) : null}
            </div>

            {form.ticketingMode === 'external' ? (
              <>
                <label className="space-y-1.5 sm:col-span-2">
                  <span className={fieldLabel()}>External ticket or RSVP URL — required to publish</span>
                  <input
                    type="url"
                    inputMode="url"
                    className={fieldClass()}
                    value={form.externalTicketUrl}
                    onChange={(event) => setForm((current) => ({ ...current, externalTicketUrl: event.target.value }))}
                    placeholder="https://secure-ticket-site.example/..."
                  />
                  <span className="block text-[11px] leading-5 text-slate-500">
                    Sway provides an external handoff to this destination. Sway is not selling this ticket or verifying the provider.
                  </span>
                </label>

                <label className="space-y-1.5">
                  <span className={fieldLabel()}>Ticket button label</span>
                  <select
                    className={fieldClass()}
                    value={form.externalTicketLabel}
                    onChange={(event) => setForm((current) => ({
                      ...current,
                      externalTicketLabel: EXTERNAL_TICKET_LABELS.includes(event.target.value as typeof EXTERNAL_TICKET_LABELS[number])
                        ? event.target.value
                        : 'Get tickets'
                    }))}
                    disabled={!form.externalTicketUrl.trim()}
                  >
                    {EXTERNAL_TICKET_LABELS.map((label) => <option key={label} value={label}>{label}</option>)}
                  </select>
                </label>
              </>
            ) : (
              <>
                <label className="space-y-1.5">
                  <span className={fieldLabel()}>GA capacity</span>
                  <input
                    required
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    className={fieldClass()}
                    value={form.nativeCapacity}
                    onChange={(event) => setForm((current) => ({ ...current, nativeCapacity: event.target.value }))}
                    placeholder="150"
                  />
                </label>
                <label className="space-y-1.5">
                  <span className={fieldLabel()}>Face value — USD</span>
                  <input
                    required
                    type="number"
                    inputMode="decimal"
                    min="1"
                    step="0.01"
                    className={fieldClass()}
                    value={form.nativeFaceValueUsd}
                    onChange={(event) => setForm((current) => ({ ...current, nativeFaceValueUsd: event.target.value }))}
                    placeholder="20.00"
                  />
                </label>

                {nativePriceQuote || (
                  editingNativeTicket?.unitAllInPriceCents !== null
                  && editingNativeTicket?.unitAllInPriceCents !== undefined
                ) ? (
                    <div className="rounded-xl border border-cyan-300/20 bg-cyan-500/[0.07] p-4 sm:col-span-2">
                      <p className={fieldLabel()}>Customer ticket price and performer share</p>
                      <p className="mt-1 text-2xl font-black text-white">
                        {formatUsd(
                          nativePriceQuote?.totalPriceCents
                            ?? editingNativeTicket!.unitAllInPriceCents!
                        )}
                        <span className="ml-2 text-xs font-bold text-slate-400">
                          before applicable government tax
                        </span>
                      </p>
                      <p className="mt-2 text-xs leading-5 text-cyan-50/75">
                        Performer share after valid check-in:{' '}
                        <strong className="text-white">
                          {formatUsd(
                            nativePriceQuote?.faceValueCents
                              ?? editingNativeTicket?.faceValueCents
                              ?? 0
                          )}
                        </strong>
                        {nativePriceQuote ? (
                          <> · Mandatory Sway fee: {formatUsd(nativePriceQuote.mandatoryFeeCents)}</>
                        ) : null}
                      </p>
                    </div>
                  ) : null}

                {nativeCapability?.reservationMinutes !== null
                  && nativeCapability?.reservationMinutes !== undefined
                  && nativeCapability.refundGraceMinutes !== null ? (
                    <div className="rounded-xl border border-white/10 bg-white/[0.035] p-4 text-xs leading-5 text-slate-300 sm:col-span-2">
                      <p className={fieldLabel()}>Checkout and unused-ticket timing</p>
                      <p className="mt-2">
                        New hosted checkouts stop {durationLabel(nativeCapability.reservationMinutes)} before
                        show start. Each started checkout reserves one ticket for up to{' '}
                        {durationLabel(nativeCapability.reservationMinutes)}. A ticket still unaccepted when
                        the {durationLabel(nativeCapability.refundGraceMinutes)} post-event admission window
                        ends is queued for a full refund.
                      </p>
                    </div>
                  ) : null}

                <label className="flex items-start gap-3 rounded-xl border border-cyan-300/20 bg-cyan-500/[0.06] p-4 text-xs leading-5 text-slate-200 sm:col-span-2">
                  <input
                    required
                    type="checkbox"
                    checked={form.nativeTermsAccepted}
                    onChange={(event) => setForm((current) => ({
                      ...current,
                      nativeTermsAccepted: event.target.checked
                    }))}
                    className="mt-1 h-4 w-4 shrink-0"
                  />
                  <span>
                    <strong className="block font-black text-white">I accept the native ticket seller terms.</strong>
                    I am the performer selling admission and have authority to offer it. Sway charges the
                    customer and holds the performer share until a valid ticket is accepted at check-in.
                    Cancelled events and unaccepted tickets follow Sway’s refund-only policy. Identity, tax,
                    and payout requirements must be complete before publishing. Your verified account email
                    is shown to buyers for event support. Standard tickets carry a 10% buyer-paid Sway fee;
                    an active, accepted Sway Brand Partner receives the verified-exclusive $1 cap.{' '}
                    <a
                      href="/legal/tickets"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-black text-cyan-100 underline underline-offset-2"
                    >
                      Read the full ticket terms
                    </a>.
                    {nativeCapability?.termsVersion ? (
                      <span className="mt-1 block text-[10px] text-slate-500">
                        Terms {nativeCapability.termsVersion}
                        {nativeCapability.termsHash
                          ? ` · ${nativeCapability.termsHash.slice(0, 12)}`
                          : ''}
                      </span>
                    ) : null}
                  </span>
                </label>
              </>
            )}

            <label className="space-y-1.5">
              <span className={fieldLabel()}>Visibility</span>
              <select
                className={fieldClass()}
                value={form.visibility}
                onChange={(event) => setForm((current) => ({
                  ...current,
                  visibility: event.target.value === 'unlisted' ? 'unlisted' : 'public'
                }))}
              >
                <option value="public">Public profile + discover</option>
                <option value="unlisted">Link only</option>
              </select>
            </label>
          </fieldset>

          {message ? (
            <div
              id="sway-event-form-message"
              role="alert"
              className="rounded-xl border border-rose-400/25 bg-rose-500/10 p-3 text-xs leading-5 text-rose-100"
            >
              {message}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={previewMode || actionPending}
            className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-fuchsia-600 to-cyan-500 px-5 text-sm font-black text-white transition hover:from-fuchsia-500 hover:to-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {actionPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />}
            {actionPending ? 'Saving event...' : form.eventId ? 'Save event changes' : 'Create event draft'}
          </button>
        </form>
      ) : null}

      <div className="p-4 sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.24em] text-slate-500">Your event listings</p>
            <p className="mt-1 text-xs text-slate-400">Draft, publish, update, or truthfully cancel each event.</p>
          </div>
          {status === 'loading' ? <Loader2 className="h-5 w-5 animate-spin text-fuchsia-200" aria-label="Loading events" /> : null}
        </div>

        {status === 'error' ? (
          <div className="mt-4 rounded-2xl border border-rose-400/25 bg-rose-500/10 p-4 text-xs leading-5 text-rose-100">
            Events could not load. Your saved profile data was not changed.
            <button type="button" onClick={() => void loadEvents()} className="ml-2 font-black underline">Try again</button>
          </div>
        ) : null}

        {status === 'ready' && sortedEvents.length === 0 ? (
          <button
            type="button"
            onClick={openNewEvent}
            disabled={previewMode}
            className="mt-4 min-h-24 w-full rounded-2xl border border-dashed border-white/10 bg-slate-950/40 px-5 text-sm font-bold text-slate-400 transition hover:border-fuchsia-300/30 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            Add your first upcoming show
          </button>
        ) : null}

        {sortedEvents.length ? (
          <div className="mt-4 space-y-3">
            {sortedEvents.map((event) => {
              const cancelled = event.status === 'cancelled' || event.status === 'canceled';
              const published = event.status === 'published';
              const started = new Date(event.startsAt).getTime() <= Date.now();
              const admissionStarted = new Date(event.doorOpensAt || event.startsAt).getTime() <= Date.now();
              const cancellationClosedAt = new Date(event.endsAt || event.startsAt).getTime();
              const cancellationClosed = cancellationClosedAt <= Date.now();
              const ticketingReady = event.ticketingMode === 'native_ga'
                ? Boolean(event.nativeTicket)
                : Boolean(event.externalTicketUrl);
              const coverFailed = Boolean(
                event.coverImageUrl && failedCoverImages.has(event.coverImageUrl)
              );
              return (
                <article key={event.id} className="rounded-2xl border border-white/10 bg-slate-950/65 p-4">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                    {event.coverImageUrl && !coverFailed ? (
                      <img
                        src={event.coverImageUrl}
                        alt=""
                        loading="lazy"
                        onError={() => setFailedCoverImages((current) => new Set(current).add(event.coverImageUrl as string))}
                        className="aspect-video w-full rounded-xl object-cover sm:h-24 sm:w-32"
                      />
                    ) : (
                      <div className="grid aspect-video w-full place-items-center rounded-xl bg-fuchsia-500/10 text-fuchsia-200 sm:h-24 sm:w-32">
                        <CalendarDays className="h-7 w-7" aria-hidden="true" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded-full border px-2.5 py-1 text-[9px] font-black uppercase tracking-wider ${
                          cancelled
                            ? 'border-rose-400/25 bg-rose-500/10 text-rose-100'
                            : published
                              ? 'border-emerald-400/25 bg-emerald-500/10 text-emerald-100'
                              : 'border-amber-300/25 bg-amber-300/10 text-amber-100'
                        }`}>
                          {event.status}
                        </span>
                        <span className="text-[9px] font-black uppercase tracking-wider text-slate-500">{event.visibility}</span>
                        <span className="rounded-full border border-cyan-300/20 bg-cyan-500/[0.06] px-2.5 py-1 text-[9px] font-black uppercase tracking-wider text-cyan-100">
                          {event.ticketingMode === 'native_ga' ? 'Sway paid GA' : 'External tickets'}
                        </span>
                      </div>
                      <h5 className="mt-2 text-base font-black text-white">{event.title}</h5>
                      <p className="mt-2 flex items-start gap-2 text-xs leading-5 text-slate-400">
                        <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        {event.ticketingMode === 'native_ga' ? 'Show ' : ''}{eventDateLabel(event)}
                      </p>
                      {event.ticketingMode === 'native_ga' && event.doorOpensAt ? (
                        <p className="mt-1 flex items-start gap-2 text-xs leading-5 text-cyan-100/75">
                          <DoorOpen className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          Doors {dateTimeLabel(event.doorOpensAt, event.timeZone)}
                        </p>
                      ) : null}
                      <p className="mt-1 flex items-start gap-2 text-xs leading-5 text-slate-500">
                        <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        {event.locationIsTba ? 'Location TBA' : [event.locationName, event.city].filter(Boolean).join(' · ') || 'No public location'}
                      </p>
                      {event.ticketingMode === 'native_ga' && event.nativeTicket ? (
                        <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-xl border border-cyan-300/15 bg-cyan-500/[0.05] px-3 py-2">
                          {event.nativeTicket.unitAllInPriceCents !== null ? (
                            <span className="text-sm font-black text-white">
                              {formatUsd(event.nativeTicket.unitAllInPriceCents)} before tax
                            </span>
                          ) : null}
                          {event.nativeTicket.remainingCount !== null ? (
                            <span className="text-[11px] font-bold text-cyan-100">
                              {event.nativeTicket.remainingCount}
                              {event.nativeTicket.capacity !== null
                                ? ` of ${event.nativeTicket.capacity}`
                                : ''} available
                            </span>
                          ) : null}
                          {salesStatusLabel(event.nativeTicket.salesStatus) ? (
                            <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                              {salesStatusLabel(event.nativeTicket.salesStatus)}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    <button
                      type="button"
                      onClick={() => openEditEvent(event)}
                      disabled={
                        previewMode
                        || actionPending
                        || cancelled
                        || (published && cancellationClosed)
                        || (published && event.ticketingMode === 'native_ga')
                      }
                      title={
                        published && event.ticketingMode === 'native_ga'
                          ? 'Published native ticket details are sealed to preserve buyer terms'
                          : 'Edit event'
                      }
                      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/10 px-3 text-xs font-black text-slate-200 transition hover:border-white/25 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Edit3 className="h-3.5 w-3.5" aria-hidden="true" />
                      Edit
                    </button>
                    {!published && !cancelled ? (
                      <button
                        type="button"
                        onClick={() => void publishEvent(event)}
                        disabled={
                          previewMode
                          || actionPending
                          || !ticketingReady
                          || started
                          || (event.ticketingMode === 'native_ga' && admissionStarted)
                        }
                        title={
                          event.ticketingMode === 'native_ga' && admissionStarted
                            ? 'Native ticket events must publish before the disclosed door-open time'
                            : started
                            ? 'Only a future event can be published'
                            : ticketingReady
                              ? 'Publish event'
                              : event.ticketingMode === 'native_ga'
                                ? 'Save native capacity, price, and seller terms before publishing'
                                : 'Add an external ticket or RSVP URL before publishing'
                        }
                        className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-emerald-500 px-3 text-xs font-black text-slate-950 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                        Publish
                      </button>
                    ) : event.eventPath ? (
                      <a
                        href={event.eventPath}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-cyan-300/25 bg-cyan-400/10 px-3 text-xs font-black text-cyan-100"
                      >
                        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                        View page
                      </a>
                    ) : null}
                    {event.externalTicketUrl && published && !cancelled && !started ? (
                      <a
                        href={`/api/public/events/${encodeURIComponent(event.id)}/ticket`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-fuchsia-300/25 bg-fuchsia-500/10 px-3 text-xs font-black text-fuchsia-100"
                      >
                        <Ticket className="h-3.5 w-3.5" aria-hidden="true" />
                        Test ticket link
                      </a>
                    ) : null}
                    {event.ticketingMode === 'native_ga' && published && !cancelled ? (
                      <a
                        href={`/talent/events/${encodeURIComponent(event.id)}/door`}
                        className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-amber-300/25 bg-amber-300/10 px-3 text-xs font-black text-amber-100"
                      >
                        <DoorOpen className="h-3.5 w-3.5" aria-hidden="true" />
                        Door
                      </a>
                    ) : null}
                    {published && !cancelled && !cancellationClosed ? (
                      <button
                        type="button"
                        onClick={() => setCancelDraft({
                          eventId: event.id,
                          reason: '',
                          externalProviderConfirmed: false
                        })}
                        disabled={previewMode || actionPending}
                        className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-rose-400/20 bg-rose-500/10 px-3 text-xs font-black text-rose-100 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
                        Cancel event
                      </button>
                    ) : null}
                  </div>

                  {!published && !cancelled && !ticketingReady ? (
                    <p className="mt-2 text-[11px] leading-5 text-amber-200/80">
                      {event.ticketingMode === 'native_ga'
                        ? 'Save native capacity, face value, and seller terms before publishing.'
                        : 'Add a public HTTPS ticket or RSVP link before publishing.'}
                    </p>
                  ) : null}

                  {cancelDraft?.eventId === event.id ? (
                    <div className="mt-3 rounded-xl border border-rose-400/20 bg-rose-500/[0.06] p-3">
                      <label className="space-y-1.5">
                        <span className={fieldLabel()}>Public cancellation reason</span>
                        <input
                          autoFocus
                          maxLength={240}
                          className={fieldClass()}
                          value={cancelDraft.reason}
                          onChange={(inputEvent) => setCancelDraft({
                            ...cancelDraft,
                            reason: inputEvent.target.value
                          })}
                          placeholder="Reason shown on the Sway event page."
                        />
                      </label>
                      <div className="mt-3 rounded-xl border border-amber-300/25 bg-amber-300/[0.07] p-3 text-xs leading-5 text-amber-100">
                        {event.ticketingMode === 'native_ga'
                          ? 'When you confirm, Sway stops native ticket sales and queues full refunds for eligible unused tickets. Admitted tickets keep their recorded settlement, disputed payments remain under support review, and refunds may remain pending while the payment processor completes them.'
                          : 'Cancelling here only changes the Sway listing. It does not cancel tickets, issue refunds, or notify buyers through the external provider.'}
                      </div>
                      {event.ticketingMode === 'external' ? (
                        <label className="mt-3 flex items-start gap-3 text-xs leading-5 text-slate-300">
                          <input
                            type="checkbox"
                            checked={cancelDraft.externalProviderConfirmed}
                            onChange={(inputEvent) => setCancelDraft({
                              ...cancelDraft,
                              externalProviderConfirmed: inputEvent.target.checked
                            })}
                            className="mt-1 h-4 w-4 shrink-0"
                          />
                          <span>
                            I understand and will handle cancellation, buyer communication, and any refunds with
                            the external provider.
                          </span>
                        </label>
                      ) : null}
                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        <button
                          type="button"
                          onClick={() => setCancelDraft(null)}
                          className="min-h-11 rounded-xl border border-white/10 text-xs font-black text-slate-300"
                        >
                          Keep event
                        </button>
                        <button
                          type="button"
                          onClick={() => void cancelEvent(event)}
                          disabled={
                            actionPending
                            || !cancelDraft.reason.trim()
                            || (
                              event.ticketingMode === 'external'
                              && !cancelDraft.externalProviderConfirmed
                            )
                          }
                          className="min-h-11 rounded-xl bg-rose-500 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Confirm cancellation
                        </button>
                      </div>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        ) : null}
      </div>
    </section>
  );
}
