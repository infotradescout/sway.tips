import { type FormEvent, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  CalendarDays,
  Disc3,
  Loader2,
  MapPin,
  Radio,
  Search,
  Sparkles,
  UserRound
} from 'lucide-react';
import { PublicEventCard, type PublicEventDto } from './PublicEventPage';
import { sendDiscoveryEvent } from '../shells/frictionClient';

type PublicRoomDto = {
  gigId: string;
  routePath: string;
  performerName: string;
  performerHandle: string | null;
  performerPath: string | null;
  talentRole: string;
  requestCount: number;
  startedAt: string | null;
  profile: {
    headline: string | null;
    city: string | null;
    avatarUrl: string | null;
    socialLinks?: Record<string, string | null>;
  } | null;
};

type PublicFeedResponse = {
  rooms?: PublicRoomDto[];
  events?: PublicEventDto[];
  releases?: PublicReleaseDto[];
  error?: string;
};

type PublicReleaseDto = {
  id: string;
  title: string;
  primaryArtistName: string;
  releaseType: string;
  status: 'ready' | 'scheduled' | 'published';
  scheduledReleaseAt: string | null;
  publishedAt: string | null;
  releasePath: string;
  artworkUrl: string | null;
  creationTags: string[];
  humanWrittenLyrics: boolean;
  originalVirtualArtist: boolean;
  fullyGenerated: boolean;
  recordings: Array<{
    recordingId: string;
    title: string;
    lyricsExcerpt: string | null;
    credits: Array<{ displayName: string; role: string }>;
  }>;
};

type ReleaseFilter = 'all' | 'human_written' | 'virtual';

function releaseTagClass(tag: string) {
  if (tag === 'Human-written lyrics') return 'border-emerald-300/30 bg-emerald-400/10 text-emerald-100';
  if (tag === 'Original virtual artist') return 'border-cyan-300/30 bg-cyan-400/10 text-cyan-100';
  if (tag === 'Rights checked') return 'border-violet-300/30 bg-violet-400/10 text-violet-100';
  return 'border-white/10 bg-white/[0.04] text-slate-300';
}

function initials(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || 'S';
}

function roomStartedLabel(value: string | null) {
  if (!value) return 'Live now';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Live now';
  return `Live since ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

export default function PublicDiscoverPage() {
  const [rooms, setRooms] = useState<PublicRoomDto[]>([]);
  const [events, setEvents] = useState<PublicEventDto[]>([]);
  const [releases, setReleases] = useState<PublicReleaseDto[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [searchPhrase, setSearchPhrase] = useState('');
  const [releaseFilter, setReleaseFilter] = useState<ReleaseFilter>('all');

  const loadFeed = async (signal?: AbortSignal) => {
    setStatus('loading');
    setMessage(null);
    try {
      const response = await fetch('/api/public/feed', { cache: 'no-store', signal });
      const data = await response.json().catch(() => null) as PublicFeedResponse | null;
      if (!response.ok || !data) {
        throw new Error(data?.error || 'Unable to load live rooms and upcoming shows.');
      }
      setRooms(Array.isArray(data.rooms) ? data.rooms : []);
      setEvents(Array.isArray(data.events) ? data.events : []);
      setReleases(Array.isArray(data.releases) ? data.releases : []);
      setStatus('ready');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'Unable to load live rooms and upcoming shows.');
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    document.title = 'Discover live rooms and shows on Sway';
    void loadFeed(controller.signal);
    sendDiscoveryEvent('discovery_landing', {
      shell: 'patron', surface: 'public-discover', route_family: 'public-discover',
      has_route_context: true, has_session_context: false, build_commit: 'client-runtime',
      visibility_eligibility: 'unknown'
    });
    return () => controller.abort();
  }, []);

  const orderedEvents = useMemo(() => [...events].sort((left, right) => (
    new Date(left.startsAt).getTime() - new Date(right.startsAt).getTime()
  )), [events]);

  const normalizedSearchPhrase = searchPhrase.trim().toLowerCase();
  const filteredRooms = useMemo(() => normalizedSearchPhrase
    ? rooms.filter((room) => [room.performerName, room.talentRole, room.profile?.city, room.profile?.headline]
      .some((value) => value?.toLowerCase().includes(normalizedSearchPhrase)))
    : rooms, [normalizedSearchPhrase, rooms]);
  const filteredEvents = useMemo(() => normalizedSearchPhrase
    ? orderedEvents.filter((event) => [event.title, event.location.city, event.location.name, event.performer?.displayName]
      .some((value) => value?.toLowerCase().includes(normalizedSearchPhrase)))
    : orderedEvents, [normalizedSearchPhrase, orderedEvents]);
  const filteredReleases = useMemo(() => releases.filter((release) => {
    if (releaseFilter === 'human_written' && !release.humanWrittenLyrics) return false;
    if (releaseFilter === 'virtual' && !release.originalVirtualArtist) return false;
    if (!normalizedSearchPhrase) return true;
    return [
      release.title,
      release.primaryArtistName,
      ...release.recordings.flatMap((recording) => [
        recording.title,
        recording.lyricsExcerpt,
        ...recording.credits
          .filter((credit) => credit.role === 'songwriter' || credit.role === 'composer')
          .map((credit) => credit.displayName)
      ])
    ].some((value) => value?.toLowerCase().includes(normalizedSearchPhrase));
  }), [normalizedSearchPhrase, releaseFilter, releases]);

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    if (!searchPhrase.trim() || filteredRooms.length || filteredEvents.length || filteredReleases.length) return;
    sendDiscoveryEvent('internal_search_zero_result', {
      shell: 'patron', surface: 'public-discover', route_family: 'public-discover',
      has_route_context: true, has_session_context: false, build_commit: 'client-runtime',
      action_kind: 'other', visibility_eligibility: 'unknown', search_phrase: searchPhrase.trim()
    });
  };

  const isEmpty = status === 'ready' && rooms.length === 0 && orderedEvents.length === 0 && releases.length === 0;

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#05060a] px-4 py-5 text-slate-100 sm:py-8">
      <div className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(circle_at_12%_0%,rgba(217,70,239,0.22),transparent_34%),radial-gradient(circle_at_90%_18%,rgba(34,211,238,0.15),transparent_30%),linear-gradient(180deg,#070811_0%,#05060a_60%,#020306_100%)]" />

      <div className="mx-auto max-w-5xl">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <a
            href="/"
            aria-label="Sway home"
            className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] font-display text-lg font-black text-white transition hover:border-fuchsia-400/40"
          >
            S
          </a>
          <a
            href="/home"
            className="inline-flex min-h-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] px-4 text-xs font-black text-slate-200 transition hover:border-cyan-300/35 hover:text-white"
          >
            Join by room code
          </a>
        </header>

        <section className="mt-8 max-w-2xl">
          <p className="inline-flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.28em] text-cyan-300">
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            What&apos;s happening
          </p>
          <h1 className="mt-3 font-display text-3xl font-black tracking-tight text-white sm:text-5xl">
            Live rooms, shows, and original music
          </h1>
          <p className="mt-4 text-sm leading-7 text-slate-400 sm:text-base">
            Enter a performer&apos;s active room, open a real upcoming event, or discover a rights-checked release.
            Human-written songs stay credited to their writers, including when an original virtual artist performs them.
          </p>
        </section>

        {status === 'ready' ? (
          <form onSubmit={submitSearch} className="mt-7 flex max-w-2xl gap-2" role="search">
            <label className="sr-only" htmlFor="sway-discover-search">Search rooms, events, songs, lyrics, and songwriters</label>
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-slate-500" aria-hidden="true" />
              <input id="sway-discover-search" value={searchPhrase} onChange={(event) => setSearchPhrase(event.target.value)} maxLength={160} placeholder="Search performers, songs, writers, lyrics, places, and shows" className="min-h-11 w-full rounded-xl border border-white/10 bg-slate-950/70 pl-10 pr-3 text-sm text-white outline-none focus:border-cyan-300/50" />
            </div>
            <button className="min-h-11 rounded-xl bg-cyan-400 px-4 text-sm font-black text-slate-950">Search</button>
          </form>
        ) : null}

        {status === 'loading' ? (
          <div className="mt-12 flex min-h-48 items-center justify-center rounded-3xl border border-white/10 bg-slate-950/60">
            <div className="text-center">
              <Loader2 className="mx-auto h-7 w-7 animate-spin text-fuchsia-200" aria-label="Loading discovery" />
              <p className="mt-3 text-xs font-bold text-slate-500">Checking what is live and coming up</p>
            </div>
          </div>
        ) : null}

        {status === 'error' ? (
          <div className="mt-10 rounded-3xl border border-rose-400/25 bg-rose-500/10 p-6">
            <h2 className="text-lg font-black text-white">Discovery is temporarily unavailable</h2>
            <p className="mt-2 text-sm leading-6 text-rose-100/80">{message}</p>
            <button
              type="button"
              onClick={() => void loadFeed()}
              className="mt-5 inline-flex min-h-11 items-center justify-center rounded-xl bg-white px-4 text-sm font-black text-slate-950"
            >
              Try again
            </button>
          </div>
        ) : null}

        {isEmpty ? (
          <div className="mt-10 rounded-3xl border border-dashed border-white/10 bg-slate-950/55 p-8 text-center">
            <CalendarDays className="mx-auto h-8 w-8 text-slate-600" aria-hidden="true" />
            <h2 className="mt-4 text-lg font-black text-white">No live rooms or upcoming shows right now</h2>
            <p className="mt-2 text-sm leading-6 text-slate-400">
              Check back later or use a performer&apos;s direct room or event link.
            </p>
          </div>
        ) : null}

        {status === 'ready' && Boolean(normalizedSearchPhrase) && filteredRooms.length === 0 && filteredEvents.length === 0 && filteredReleases.length === 0 && !isEmpty ? (
          <div className="mt-10 rounded-3xl border border-dashed border-white/10 bg-slate-950/55 p-8 text-center">
            <Search className="mx-auto h-8 w-8 text-slate-600" aria-hidden="true" />
            <h2 className="mt-4 text-lg font-black text-white">No current matches</h2>
            <p className="mt-2 text-sm text-slate-400">Try another performer, songwriter, lyric, place, or show.</p>
          </div>
        ) : null}

        {status === 'ready' && filteredRooms.length ? (
          <section className="mt-12" aria-labelledby="live-now-heading">
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.24em] text-fuchsia-300">Live now</p>
                <h2 id="live-now-heading" className="mt-1 text-2xl font-black text-white">Enter the room</h2>
              </div>
              <span className="rounded-full border border-fuchsia-300/20 bg-fuchsia-500/10 px-3 py-1 text-xs font-black text-fuchsia-100">
                {filteredRooms.length}
              </span>
            </div>

            <div className="mt-4 grid gap-4 md:grid-cols-2">
              {filteredRooms.map((room) => (
                <article key={room.gigId} className="rounded-2xl border border-fuchsia-300/20 bg-slate-950/70 p-4 shadow-xl">
                  <div className="flex items-start gap-3">
                    <div className="relative grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-2xl border border-white/10 bg-fuchsia-500/10 font-display text-sm font-black text-fuchsia-100">
                      <span>{initials(room.performerName)}</span>
                      {room.profile?.avatarUrl ? (
                        <img
                          src={room.profile.avatarUrl}
                          alt={`${room.performerName} profile`}
                          loading="lazy"
                          onError={(event) => { event.currentTarget.style.display = 'none'; }}
                          className="absolute inset-0 h-full w-full object-cover"
                        />
                      ) : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="inline-flex items-center gap-1.5 text-[9px] font-black uppercase tracking-[0.22em] text-fuchsia-200">
                        <Radio className="h-3 w-3" aria-hidden="true" />
                        {roomStartedLabel(room.startedAt)}
                      </p>
                      {room.performerPath ? (
                        <a href={room.performerPath} className="mt-1 block truncate text-base font-black text-white hover:text-cyan-100">
                          {room.performerName}
                        </a>
                      ) : (
                        <h3 className="mt-1 truncate text-base font-black text-white">{room.performerName}</h3>
                      )}
                      <p className="mt-1 text-xs text-slate-400">{room.talentRole || 'Performer'} · {room.requestCount} live {room.requestCount === 1 ? 'request' : 'requests'}</p>
                      {room.profile?.city ? (
                        <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500">
                          <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                          {room.profile.city}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  {room.profile?.headline ? <p className="mt-3 text-xs leading-5 text-slate-400">{room.profile.headline}</p> : null}
                  <a
                    href={room.routePath}
                    onClick={() => sendDiscoveryEvent('discovery_primary_action', {
                      shell: 'patron', surface: 'public-discover', route_family: 'public-discover',
                      has_route_context: true, has_session_context: false, build_commit: 'client-runtime',
                      entity_kind: 'live_room', entity_key: room.gigId, action_kind: 'room_entry',
                      visibility_eligibility: 'eligible'
                    })}
                    className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-fuchsia-600 px-4 text-sm font-black text-white transition hover:bg-fuchsia-500"
                  >
                    Enter live room
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </a>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {status === 'ready' && filteredEvents.length ? (
          <section className="mt-12" aria-labelledby="upcoming-shows-heading">
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.24em] text-cyan-300">Coming up</p>
                <h2 id="upcoming-shows-heading" className="mt-1 text-2xl font-black text-white">Upcoming shows</h2>
              </div>
              <span className="rounded-full border border-cyan-300/20 bg-cyan-400/10 px-3 py-1 text-xs font-black text-cyan-100">
                {filteredEvents.length}
              </span>
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              {filteredEvents.map((event) => (
                <div key={event.id}>
                  <PublicEventCard event={event} showExternalPolicy showPerformer />
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {status === 'ready' && releases.length ? (
          <section className="mt-12" aria-labelledby="original-music-heading">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.24em] text-violet-300">Original music</p>
                <h2 id="original-music-heading" className="mt-1 text-2xl font-black text-white">Songs and their writers</h2>
                <p className="mt-2 max-w-xl text-xs leading-5 text-slate-400">Creation labels explain how each recording was made without hiding human authorship or downranking virtual artists.</p>
              </div>
              <div className="flex flex-wrap gap-2" aria-label="Filter releases">
                {([
                  ['all', 'All releases'],
                  ['human_written', 'Human-written lyrics'],
                  ['virtual', 'Original virtual artists']
                ] as Array<[ReleaseFilter, string]>).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setReleaseFilter(value)}
                    aria-pressed={releaseFilter === value}
                    className={`min-h-9 rounded-full border px-3 text-[10px] font-black uppercase tracking-wider transition ${releaseFilter === value ? 'border-cyan-300/40 bg-cyan-400/15 text-cyan-100' : 'border-white/10 bg-white/[0.04] text-slate-400 hover:text-white'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {filteredReleases.length ? (
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                {filteredReleases.map((release) => {
                  const writers = [...new Set(release.recordings.flatMap((recording) => recording.credits
                    .filter((credit) => credit.role === 'songwriter' || credit.role === 'composer')
                    .map((credit) => credit.displayName)))];
                  const excerpt = release.recordings.find((recording) => recording.lyricsExcerpt)?.lyricsExcerpt;
                  return (
                    <a
                      key={release.id}
                      href={release.releasePath}
                      onClick={() => sendDiscoveryEvent('discovery_primary_action', {
                        shell: 'patron', surface: 'public-discover', route_family: 'public-discover',
                        has_route_context: true, has_session_context: false, build_commit: 'client-runtime',
                        entity_kind: 'release', entity_key: release.id, action_kind: 'other',
                        visibility_eligibility: 'eligible'
                      })}
                      className="group rounded-2xl border border-violet-300/20 bg-slate-950/70 p-4 shadow-xl transition hover:border-violet-300/45"
                    >
                      <div className="flex gap-3">
                        {release.artworkUrl ? <img src={release.artworkUrl} alt={`${release.title} artwork`} loading="lazy" className="h-20 w-20 shrink-0 rounded-xl object-cover" /> : <span className="grid h-20 w-20 shrink-0 place-items-center rounded-xl bg-violet-500/10 text-violet-200"><Disc3 className="h-7 w-7" /></span>}
                        <div className="min-w-0">
                          <p className="text-[9px] font-black uppercase tracking-[0.2em] text-violet-300">{release.releaseType.replaceAll('_', ' ')}</p>
                          <h3 className="mt-1 truncate text-base font-black text-white group-hover:text-violet-100">{release.title}</h3>
                          <p className="mt-1 truncate text-xs text-slate-400">{release.primaryArtistName}</p>
                          {writers.length ? <p className="mt-2 truncate text-xs font-bold text-emerald-100">Written by {writers.join(', ')}</p> : null}
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-1.5">{release.creationTags.map((tag) => <span key={tag} className={`rounded-full border px-2 py-1 text-[9px] font-black ${releaseTagClass(tag)}`}>{tag}</span>)}</div>
                      {excerpt ? <p className="mt-3 line-clamp-2 text-xs italic leading-5 text-slate-400">“{excerpt}”</p> : null}
                    </a>
                  );
                })}
              </div>
            ) : (
              <div className="mt-4 rounded-2xl border border-dashed border-white/10 bg-slate-950/55 p-6 text-center text-sm text-slate-400">No releases match this filter.</div>
            )}
          </section>
        ) : null}

        <footer className="mt-14 border-t border-white/10 py-8 text-center">
          <UserRound className="mx-auto h-5 w-5 text-slate-600" aria-hidden="true" />
          <p className="mt-3 text-xs text-slate-500">Have a performer link? Open it directly to see their full page.</p>
          <a href="/account/signup?intent=performer" className="mt-3 inline-flex text-xs font-black text-fuchsia-200 transition hover:text-white">
            Create your own Sway page
          </a>
        </footer>
      </div>
    </main>
  );
}
