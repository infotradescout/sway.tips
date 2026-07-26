import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  CalendarDays,
  CheckCircle2,
  Clock,
  Edit3,
  ExternalLink,
  Loader2,
  MapPin,
  Plus,
  Save,
  Ticket,
  XCircle
} from 'lucide-react';

type ManagedEvent = {
  id: string;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string | null;
  timeZone: string;
  locationName: string | null;
  locationAddress: string | null;
  city: string | null;
  locationIsTba: boolean;
  coverImageUrl: string | null;
  externalTicketUrl: string | null;
  externalTicketLabel: string | null;
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
  endsAt: string;
  timeZone: string;
  locationName: string;
  locationAddress: string;
  city: string;
  locationIsTba: boolean;
  coverImageUrl: string;
  externalTicketUrl: string;
  externalTicketLabel: string;
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
    endsAt: '',
    timeZone: detectedTimeZone(),
    locationName: '',
    locationAddress: '',
    city: '',
    locationIsTba: false,
    coverImageUrl: '',
    externalTicketUrl: '',
    externalTicketLabel: 'Get tickets',
    visibility: 'public'
  };
}

function text(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function normalizeManagedEvent(value: any): ManagedEvent | null {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string') return null;
  const nestedLocation = value.location && typeof value.location === 'object' ? value.location : {};
  const nestedTicket = value.externalTicket && typeof value.externalTicket === 'object' ? value.externalTicket : {};
  return {
    id: value.id,
    title: text(value.title),
    description: text(value.description) || null,
    startsAt: text(value.startsAt),
    endsAt: text(value.endsAt) || null,
    timeZone: text(value.timeZone) || detectedTimeZone(),
    locationName: text(value.locationName ?? nestedLocation.name) || null,
    locationAddress: text(value.locationAddress ?? nestedLocation.address) || null,
    city: text(value.city ?? nestedLocation.city) || null,
    locationIsTba: value.locationIsTba === true || nestedLocation.isTba === true,
    coverImageUrl: text(value.coverImageUrl) || null,
    externalTicketUrl: text(value.externalTicketUrl ?? nestedTicket.url) || null,
    externalTicketLabel: text(value.externalTicketLabel ?? nestedTicket.label) || null,
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
    endsAt: localInputFromIso(event.endsAt, event.timeZone),
    timeZone: event.timeZone,
    locationName: event.locationName || '',
    locationAddress: event.locationAddress || '',
    city: event.city || '',
    locationIsTba: event.locationIsTba,
    coverImageUrl: event.coverImageUrl || '',
    externalTicketUrl: event.externalTicketUrl || '',
    externalTicketLabel: event.externalTicketLabel || 'Get tickets',
    visibility: event.visibility
  };
}

function eventDateLabel(event: ManagedEvent) {
  const date = new Date(event.startsAt);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: event.timeZone,
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
      const endsAt = form.endsAt ? isoFromZonedLocal(form.endsAt, form.timeZone.trim()) : null;
      if (endsAt && new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
        throw new Error('Event end time must be after the start time.');
      }

      const body = {
        ...(form.eventId
          ? { expectedUpdatedAt: form.expectedUpdatedAt }
          : { clientRequestId: form.clientRequestId }),
        title: form.title,
        description: form.description,
        startsAt,
        endsAt,
        timeZone: form.timeZone.trim(),
        locationName: form.locationName,
        locationAddress: form.locationAddress,
        city: form.city,
        locationIsTba: form.locationIsTba,
        coverImageUrl: form.coverImageUrl,
        externalTicketUrl: form.externalTicketUrl,
        externalTicketLabel: form.externalTicketUrl.trim() ? form.externalTicketLabel : '',
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

      setMessage(form.eventId ? 'Event changes saved.' : 'Event draft created.');
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
    if (!cancelDraft.externalProviderConfirmed) {
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
      setMessage('Sway listing cancelled. Its external ticket action is no longer public.');
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
      className="mx-auto w-full max-w-3xl scroll-mt-24 overflow-hidden rounded-2xl border border-fuchsia-300/20 bg-slate-900/80 shadow-xl shadow-fuchsia-950/10"
    >
      <div className="border-b border-white/10 bg-gradient-to-r from-fuchsia-500/10 via-cyan-500/10 to-transparent p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.28em] text-fuchsia-300">Shows and events</p>
            <h3 className="mt-2 font-display text-xl font-black text-white">Put upcoming shows on your public page</h3>
            <p className="mt-2 max-w-xl text-xs leading-5 text-slate-400">
              Add a real date and location, then add an external ticket or RSVP destination before publishing.
              Sway lists the event; checkout and refund policies remain with the external site.
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
              <span className={fieldLabel()}>Starts</span>
              <input
                required
                type="datetime-local"
                className={fieldClass()}
                value={form.startsAt}
                onChange={(event) => setForm((current) => ({ ...current, startsAt: event.target.value }))}
              />
            </label>
            <label className="space-y-1.5">
              <span className={fieldLabel()}>Ends — optional</span>
              <input
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
                placeholder="Pensacola, FL"
              />
            </label>
            <label className="space-y-1.5 sm:col-span-2">
              <span className={fieldLabel()}>Public address — optional</span>
              <input
                maxLength={240}
                disabled={form.locationIsTba}
                className={fieldClass()}
                value={form.locationAddress}
                onChange={(event) => setForm((current) => ({ ...current, locationAddress: event.target.value }))}
                placeholder="Only add an address you want visible to everyone"
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
              const cancellationClosedAt = new Date(event.endsAt || event.startsAt).getTime();
              const cancellationClosed = cancellationClosedAt <= Date.now();
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
                      </div>
                      <h5 className="mt-2 text-base font-black text-white">{event.title}</h5>
                      <p className="mt-2 flex items-start gap-2 text-xs leading-5 text-slate-400">
                        <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        {eventDateLabel(event)}
                      </p>
                      <p className="mt-1 flex items-start gap-2 text-xs leading-5 text-slate-500">
                        <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        {event.locationIsTba ? 'Location TBA' : [event.locationName, event.city].filter(Boolean).join(' · ') || 'No public location'}
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    <button
                      type="button"
                      onClick={() => openEditEvent(event)}
                      disabled={previewMode || actionPending || cancelled || (published && cancellationClosed)}
                      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/10 px-3 text-xs font-black text-slate-200 transition hover:border-white/25 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Edit3 className="h-3.5 w-3.5" aria-hidden="true" />
                      Edit
                    </button>
                    {!published && !cancelled ? (
                      <button
                        type="button"
                        onClick={() => void publishEvent(event)}
                        disabled={previewMode || actionPending || !event.externalTicketUrl || started}
                        title={
                          started
                            ? 'Only a future event can be published'
                            : event.externalTicketUrl
                              ? 'Publish event'
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

                  {!published && !cancelled && !event.externalTicketUrl ? (
                    <p className="mt-2 text-[11px] leading-5 text-amber-200/80">
                      Add a public HTTPS ticket or RSVP link before publishing.
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
                        Cancelling here only changes the Sway listing. It does not cancel tickets, issue refunds,
                        or notify buyers through the external provider.
                      </div>
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
                            || !cancelDraft.externalProviderConfirmed
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
