import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleDot, ListStart, Pause, Play, RefreshCw, SkipBack, SkipForward, Square } from 'lucide-react';
import {
  listPlaybackMidiOutputs,
  MIDI_PLAYBACK_NOTE_MAP,
  requestPlaybackMidiAccess,
  sendPlaybackMidiAction,
  type BrowserMidiOutput
} from '../browser-midi-playback';
import { isPlaybackAction, isPlaybackSourceKey, isPlaybackStateFresh, type PlaybackAction, type PlaybackSourceKey } from '../playback-control';
import type { RequestItem } from '../types';

type PlaybackStateSnapshot = {
  sourceKey: PlaybackSourceKey;
  connectionStatus: 'connected' | 'degraded' | 'disconnected';
  trackTitle: string | null;
  trackArtist: string | null;
  bpmTimes100: number | null;
  observedAt: string;
  fresh: boolean;
};
type PlaybackCommandSnapshot = {
  id: string;
  action: PlaybackAction;
  status: 'queued' | 'claimed' | 'succeeded' | 'failed' | 'expired';
  errorText: string | null;
  createdAt: string;
};
type PlaybackSnapshot = { state: PlaybackStateSnapshot | null; commands: PlaybackCommandSnapshot[] };
type PlaybackMessage = { tone: 'success' | 'pending' | 'error'; text: string };
type ControllerProps = { gigId: string | null; approvedRequests: RequestItem[]; previewMode?: boolean };

const SOURCE_STORAGE_KEY = 'sway.performer.playbackSource.v1';
const DECK_STORAGE_KEY = 'sway.performer.playbackDeck.v1';
const MIDI_OUTPUT_STORAGE_KEY = 'sway.performer.playbackMidiOutput.v1';
const EMPTY_SNAPSHOT: PlaybackSnapshot = { state: null, commands: [] };

function readPreference(key: string) {
  try { return typeof window === 'undefined' ? null : window.localStorage.getItem(key); }
  catch { return null; }
}
function savePreference(key: string, value: string) {
  try { window.localStorage.setItem(key, value); }
  catch { /* Playback remains usable when this browser cannot remember preferences. */ }
}
function storedDeck() {
  const deck = Number(readPreference(DECK_STORAGE_KEY));
  return Number.isInteger(deck) && deck >= 1 && deck <= 4 ? deck : 1;
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function nullableText(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error('Unreadable playback status.');
  return value;
}
function parseSnapshot(value: unknown, gigId: string): PlaybackSnapshot {
  if (!record(value) || !Object.prototype.hasOwnProperty.call(value, 'state') || !Array.isArray(value.commands)) {
    throw new Error('Unreadable playback status.');
  }
  let state: PlaybackStateSnapshot | null = null;
  if (value.state !== null) {
    const raw = value.state;
    if (!record(raw) || (raw.gigId !== undefined && raw.gigId !== gigId)
      || !isPlaybackSourceKey(raw.sourceKey)
      || !['connected', 'degraded', 'disconnected'].includes(String(raw.connectionStatus))
      || typeof raw.observedAt !== 'string' || !Number.isFinite(Date.parse(raw.observedAt))
      || typeof raw.fresh !== 'boolean'
      || (raw.bpmTimes100 != null && (typeof raw.bpmTimes100 !== 'number' || !Number.isFinite(raw.bpmTimes100) || raw.bpmTimes100 < 0))) {
      throw new Error('Unreadable playback status.');
    }
    state = {
      sourceKey: raw.sourceKey,
      connectionStatus: raw.connectionStatus as PlaybackStateSnapshot['connectionStatus'],
      trackTitle: nullableText(raw.trackTitle), trackArtist: nullableText(raw.trackArtist),
      bpmTimes100: raw.bpmTimes100 == null ? null : raw.bpmTimes100 as number,
      observedAt: raw.observedAt, fresh: raw.fresh
    };
  }
  const commands = value.commands.map((raw): PlaybackCommandSnapshot => {
    if (!record(raw) || typeof raw.id !== 'string' || !raw.id
      || (raw.gigId !== undefined && raw.gigId !== gigId)
      || !isPlaybackAction(raw.action)
      || !['queued', 'claimed', 'succeeded', 'failed', 'expired'].includes(String(raw.status))
      || typeof raw.createdAt !== 'string' || !Number.isFinite(Date.parse(raw.createdAt))) {
      throw new Error('Unreadable playback status.');
    }
    return { id: raw.id, action: raw.action, status: raw.status as PlaybackCommandSnapshot['status'],
      errorText: nullableText(raw.errorText), createdAt: raw.createdAt };
  });
  return { state, commands };
}

// Bound the response AND its body, even when a transport ignores cancellation.
async function withDeadline<T>(controller: AbortController, operation: () => Promise<T>): Promise<T> {
  let rejectAbort: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(new Error('Playback check cancelled or timed out.'));
  controller.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    if (controller.signal.aborted) throw new Error('Playback check cancelled.');
    return await Promise.race([operation(), aborted]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
  }
}
class PlaybackAccessError extends Error {}

const ACTION_BUTTONS: Array<{ action: PlaybackAction; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { action: 'previous', label: 'Previous', icon: SkipBack },
  { action: 'cue', label: 'Cue', icon: CircleDot },
  { action: 'play', label: 'Play', icon: Play },
  { action: 'pause', label: 'Pause', icon: Pause },
  { action: 'stop', label: 'Stop', icon: Square },
  { action: 'next', label: 'Next', icon: SkipForward }
];
function latestCommandMessage(commands: PlaybackCommandSnapshot[], now: number): PlaybackMessage | null {
  const latest = commands.find(command => {
    const age = now - Date.parse(command.createdAt);
    return age >= -5_000 && age <= 30_000;
  });
  if (!latest) return null;
  if (latest.status === 'failed' || latest.status === 'expired') {
    return { tone: 'error', text: latest.errorText || `${latest.action} failed.` };
  }
  if (latest.status === 'succeeded') return { tone: 'success', text: `${latest.action} confirmed by VirtualDJ.` };
  return { tone: 'pending', text: `${latest.action} ${latest.status}.` };
}

export default function PerformerPlaybackController(props: ControllerProps) {
  const [sourceKey, setSourceKey] = useState<PlaybackSourceKey>(() => (
    readPreference(SOURCE_STORAGE_KEY) === 'generic_midi' ? 'generic_midi' : 'virtualdj'
  ));
  useEffect(() => savePreference(SOURCE_STORAGE_KEY, sourceKey), [sourceKey]);
  // No state or late result from another room, source, or preview can be reused.
  return <PlaybackSession key={JSON.stringify([props.gigId, sourceKey, Boolean(props.previewMode)])}
    {...props} sourceKey={sourceKey} onSourceChange={setSourceKey} />;
}

function PlaybackSession({ gigId, approvedRequests, previewMode = false, sourceKey, onSourceChange }: ControllerProps & {
  sourceKey: PlaybackSourceKey; onSourceChange: (source: PlaybackSourceKey) => void;
}) {
  const [deck, setDeck] = useState(storedDeck);
  const [snapshot, setSnapshot] = useState<PlaybackSnapshot>(EMPTY_SNAPSHOT);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [pendingAction, setPendingAction] = useState<PlaybackAction | null>(null);
  const [localMessage, setLocalMessage] = useState<PlaybackMessage | null>(null);
  const [now, setNow] = useState(Date.now);
  const [midiOutputs, setMidiOutputs] = useState<BrowserMidiOutput[]>([]);
  const [midiOutputId, setMidiOutputId] = useState(() => readPreference(MIDI_OUTPUT_STORAGE_KEY) || '');
  const [midiStatus, setMidiStatus] = useState<'idle' | 'requesting' | 'ready' | 'error'>('idle');
  const lifetime = useRef<object | null>(null);
  const readRevision = useRef(0);
  const readController = useRef<AbortController | null>(null);
  const commandController = useRef<AbortController | null>(null);
  const commandBusy = useRef(false);
  const midiBusy = useRef(false);
  const accessLost = useRef(false);
  const detachMidi = useRef<(() => void) | null>(null);

  useEffect(() => {
    const scope = {};
    lifetime.current = scope;
    return () => {
      if (lifetime.current === scope) lifetime.current = null;
      readRevision.current += 1;
      readController.current?.abort();
      readController.current = null;
      commandController.current?.abort();
      commandController.current = null;
      commandBusy.current = false;
      midiBusy.current = false;
      detachMidi.current?.();
      detachMidi.current = null;
    };
  }, []);
  useEffect(() => savePreference(DECK_STORAGE_KEY, String(deck)), [deck]);

  const refreshSnapshot = useCallback(async (explicit = false) => {
    const scope = lifetime.current;
    if (!scope || !gigId || previewMode || sourceKey !== 'virtualdj') return;
    if (!explicit && (accessLost.current || readController.current)) return;
    if (explicit) accessLost.current = false;
    const revision = ++readRevision.current;
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    const current = () => lifetime.current === scope && revision === readRevision.current;
    setReading(true);
    try {
      const next = await withDeadline(controller, async () => {
        const response = await fetch(`/api/talent/playback/snapshot/${encodeURIComponent(gigId)}`, {
          cache: 'no-store', signal: controller.signal
        });
        if (response.status === 401 || response.status === 403) throw new PlaybackAccessError();
        if (!response.ok) throw new Error('Playback status unavailable.');
        return parseSnapshot(await response.json(), gigId);
      });
      if (!current()) return;
      setSnapshot(next);
      setSnapshotError(null);
      setNow(Date.now());
    } catch (error) {
      if (!current()) return;
      setSnapshot(EMPTY_SNAPSHOT);
      if (error instanceof PlaybackAccessError) {
        accessLost.current = true;
        setLocalMessage(null);
        setSnapshotError('Your room access changed. Check your account, then refresh playback status.');
      } else {
        setSnapshotError('Playback status could not be confirmed. Controls are paused. Refresh playback status to check again.');
      }
    } finally {
      if (current()) {
        readController.current = null;
        setReading(false);
      }
    }
  }, [gigId, previewMode, sourceKey]);

  useEffect(() => {
    void refreshSnapshot();
    if (!gigId || previewMode || sourceKey !== 'virtualdj') return;
    const poll = window.setInterval(() => void refreshSnapshot(), 2_000);
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => { window.clearInterval(poll); window.clearInterval(clock); };
  }, [gigId, previewMode, refreshSnapshot, sourceKey]);
  useEffect(() => {
    if (!localMessage || localMessage.tone === 'error') return;
    const timer = window.setTimeout(() => setLocalMessage(null), 8_000);
    return () => window.clearTimeout(timer);
  }, [localMessage]);

  const selectedMidiOutput = useMemo(() => midiOutputs.find(output => output.id === midiOutputId && output.state !== 'disconnected') || null, [midiOutputId, midiOutputs]);
  const virtualDjConnected = Boolean(!snapshotError && !accessLost.current && snapshot.state?.fresh
    && snapshot.state.sourceKey === 'virtualdj' && snapshot.state.connectionStatus === 'connected'
    && isPlaybackStateFresh(snapshot.state.observedAt, now));
  const topRequest = approvedRequests[0] || null;
  const message = localMessage || (sourceKey === 'virtualdj' ? latestCommandMessage(snapshot.commands, now) : null);
  const canControl = !previewMode && Boolean(gigId) && !pendingAction && !accessLost.current
    && (sourceKey === 'virtualdj' ? virtualDjConnected : Boolean(selectedMidiOutput));

  const enableMidi = async () => {
    const scope = lifetime.current;
    if (!scope || previewMode || !gigId || midiBusy.current) return;
    midiBusy.current = true;
    setMidiStatus('requesting');
    try {
      const access = await requestPlaybackMidiAccess();
      if (lifetime.current !== scope) return;
      detachMidi.current?.();
      const previous = access.onstatechange;
      const refresh = () => {
        if (lifetime.current !== scope) return;
        const outputs = listPlaybackMidiOutputs(access);
        setMidiOutputs(outputs);
        // Never silently redirect a disconnected output to another device.
        setMidiOutputId(current => outputs.some(output => output.id === current) ? current : '');
      };
      access.onstatechange = refresh;
      detachMidi.current = () => { if (access.onstatechange === refresh) access.onstatechange = previous; };
      refresh();
      setMidiStatus('ready');
      setLocalMessage({ tone: 'pending', text: 'Choose the MIDI output connected to your DJ app. MIDI sends one-way controls; Sway cannot confirm what the deck did.' });
    } catch {
      if (lifetime.current !== scope) return;
      setMidiStatus('error');
      setLocalMessage({ tone: 'error', text: 'MIDI access is unavailable. Check this browser’s device permission and your connected output, then try again.' });
    } finally {
      if (lifetime.current === scope) midiBusy.current = false;
    }
  };

  const runAction = async (action: PlaybackAction) => {
    const scope = lifetime.current;
    if (!scope || previewMode || !gigId || commandBusy.current || accessLost.current) return;
    if (action === 'load' && !topRequest) {
      setLocalMessage({ tone: 'error', text: 'Approve a request before loading the crowd pick.' });
      return;
    }
    if (sourceKey === 'generic_midi') {
      if (action === 'load') {
        setLocalMessage({ tone: 'error', text: 'Generic MIDI cannot identify a track. Load it manually, then control transport from Sway.' });
        return;
      }
      if (!selectedMidiOutput || selectedMidiOutput.state === 'disconnected') {
        setLocalMessage({ tone: 'error', text: 'Choose a connected MIDI output first.' });
        return;
      }
      commandBusy.current = true;
      try {
        const sent = sendPlaybackMidiAction(selectedMidiOutput, action, deck);
        setLocalMessage({ tone: 'pending', text: `${action} sent on MIDI channel ${sent.channel}, note ${sent.note}. This is not confirmation that the deck acted.` });
      } catch {
        setLocalMessage({ tone: 'error', text: 'The MIDI command could not be confirmed. Check your deck before sending another command.' });
      } finally {
        // Suppress repeated hardware events in the same dispatch turn.
        queueMicrotask(() => { if (lifetime.current === scope) commandBusy.current = false; });
      }
      return;
    }
    if (!virtualDjConnected || !isPlaybackStateFresh(snapshot.state?.observedAt)) {
      setLocalMessage({ tone: 'error', text: 'Playback status is not current. Refresh playback status before sending a command.' });
      return;
    }
    commandBusy.current = true;
    setPendingAction(action);
    setLocalMessage({ tone: 'pending', text: `Sending ${action} to VirtualDJ…` });
    const controller = new AbortController();
    commandController.current = controller;
    try {
      // A single deliberate action gets one durable command identity. There is
      // no automatic POST retry, including on timeout or a lost response.
      const clientCommandId = crypto.randomUUID();
      await withDeadline(controller, async () => {
        const response = await fetch('/api/talent/playback/commands', {
          method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ gig_id: gigId, clientCommandId, sourceKey: 'virtualdj', action,
            payload: { deck, track: action === 'load' && topRequest ? {
              requestId: topRequest.id, sourceTrackId: topRequest.sourceTrackId || null,
              externalTrackId: topRequest.externalTrackId || null,
              title: topRequest.title, artist: topRequest.subtitle || null
            } : null }
          })
        });
        if (response.status === 401 || response.status === 403) throw new PlaybackAccessError();
        const data: unknown = await response.json();
        if (!response.ok || !record(data)) throw new Error('Command confirmation unavailable.');
      });
      if (lifetime.current !== scope || accessLost.current) return;
      setLocalMessage({ tone: 'pending', text: `${action} submitted; waiting for VirtualDJ acknowledgement.` });
      void refreshSnapshot(true);
    } catch (error) {
      if (lifetime.current !== scope) return;
      if (error instanceof PlaybackAccessError) {
        accessLost.current = true;
        readRevision.current += 1;
        readController.current?.abort();
        readController.current = null;
        setReading(false);
        setSnapshot(EMPTY_SNAPSHOT);
        setSnapshotError('Your room access changed. Check your account, then refresh playback status.');
        setLocalMessage(null);
      } else {
        setLocalMessage({ tone: 'error', text: 'The command could not be confirmed. It may have reached your deck. Check playback before sending another command. Refreshing status will not resend it.' });
      }
    } finally {
      if (lifetime.current === scope) {
        commandBusy.current = false;
        commandController.current = null;
        setPendingAction(null);
      }
    }
  };

  useEffect(() => {
    const onMappedHardwareAction = (event: Event) => {
      const action = (event as CustomEvent<unknown>).detail;
      if (isPlaybackAction(action)) void runAction(action);
    };
    window.addEventListener('sway:playback-action', onMappedHardwareAction);
    return () => window.removeEventListener('sway:playback-action', onMappedHardwareAction);
  });

  const sourceStatus = previewMode ? 'Preview only — playback controls are off'
    : !gigId ? 'Open a room to use playback controls'
      : sourceKey === 'virtualdj'
        ? virtualDjConnected ? 'VirtualDJ linked' : snapshotError || (reading ? 'Checking playback status…' : 'Bridge offline or status expired')
        : selectedMidiOutput ? `MIDI → ${selectedMidiOutput.name || 'output'}` : 'Choose a connected MIDI output';

  return (
    <section data-sway-playback-controller="true"
      className="grid gap-2 rounded-2xl border border-fuchsia-500/20 bg-slate-900/95 p-2.5 shadow-lg sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
      aria-label="External DJ playback controller">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 rounded-full ${canControl ? 'bg-emerald-400' : 'bg-amber-400'}`} />
          <p className="min-w-0 break-words text-xs font-black text-white">
            {sourceKey === 'virtualdj' && virtualDjConnected && snapshot.state?.trackTitle
              ? `${snapshot.state.trackArtist ? `${snapshot.state.trackArtist} — ` : ''}${snapshot.state.trackTitle}`
              : topRequest ? `Up next: ${topRequest.title}` : 'No approved crowd pick'}
          </p>
          {sourceKey === 'virtualdj' && virtualDjConnected && snapshot.state?.bpmTimes100 ? (
            <span className="shrink-0 font-mono text-[10px] text-fuchsia-200">{(snapshot.state.bpmTimes100 / 100).toFixed(1)} BPM</span>
          ) : null}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <select value={sourceKey} onChange={event => onSourceChange(event.target.value as PlaybackSourceKey)}
            aria-label="Playback source" className="min-h-10 max-w-full rounded-lg border border-white/10 bg-slate-950 px-2 text-xs font-bold text-white">
            <option value="virtualdj">VirtualDJ · full control</option>
            <option value="generic_midi">MIDI · one-way</option>
          </select>
          <select value={deck} onChange={event => setDeck(Number(event.target.value))} disabled={pendingAction !== null}
            aria-label="Target deck" className="min-h-10 rounded-lg border border-white/10 bg-slate-950 px-2 text-xs font-bold text-white disabled:opacity-50">
            {[1, 2, 3, 4].map(value => <option key={value} value={value}>Deck {value}</option>)}
          </select>
          {sourceKey === 'generic_midi' ? midiStatus !== 'ready' ? (
            <button type="button" onClick={() => void enableMidi()} disabled={previewMode || !gigId || midiStatus === 'requesting'}
              className="min-h-10 rounded-lg bg-cyan-500 px-3 text-xs font-bold text-slate-950 disabled:opacity-50">
              {midiStatus === 'requesting' ? 'Checking MIDI access…' : 'Choose MIDI output'}
            </button>
          ) : (
            <select value={midiOutputId} onChange={event => {
              setMidiOutputId(event.target.value); savePreference(MIDI_OUTPUT_STORAGE_KEY, event.target.value);
            }} aria-label="Virtual MIDI output" className="min-h-10 min-w-0 max-w-full rounded-lg border border-white/10 bg-slate-950 px-2 text-xs font-bold text-white">
              <option value="">{midiOutputs.length ? 'Choose an output' : 'No MIDI outputs'}</option>
              {midiOutputs.map(output => <option key={output.id} value={output.id}>{output.name || output.id}</option>)}
            </select>
          ) : null}
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1 sm:justify-end">
        <button type="button" onClick={() => void runAction('load')}
          disabled={!canControl || !topRequest || sourceKey !== 'virtualdj'}
          className="inline-flex min-h-11 items-center gap-1 rounded-lg bg-fuchsia-600 px-2.5 text-xs font-bold text-white disabled:cursor-not-allowed disabled:opacity-40"
          title={sourceKey === 'generic_midi' ? 'MIDI cannot carry a track identity.' : 'Load the top approved request'}>
          <ListStart className="h-4 w-4" /> Load top
        </button>
        {ACTION_BUTTONS.map(({ action, label, icon: Icon }) => (
          <button key={action} type="button" onClick={() => void runAction(action)} disabled={!canControl}
            aria-label={`${label} deck ${deck}`}
            title={sourceKey === 'generic_midi' ? `${label}: MIDI note ${MIDI_PLAYBACK_NOTE_MAP[action]}` : label}
            className={`flex h-11 w-11 items-center justify-center rounded-lg border text-white disabled:cursor-not-allowed disabled:opacity-40 ${action === 'play' ? 'border-emerald-500/40 bg-emerald-500/20' : 'border-white/10 bg-slate-950'}`}>
            <Icon className="h-4 w-4" />
          </button>
        ))}
      </div>
      <p role="status" className="min-w-0 break-words text-xs leading-5 text-slate-300 sm:col-span-2">{sourceStatus}</p>
      {sourceKey === 'virtualdj' && !previewMode && gigId ? (
        <button type="button" onClick={() => void refreshSnapshot(true)}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-white/20 px-3 text-xs font-bold text-white sm:col-span-2">
          <RefreshCw aria-hidden="true" className="h-4 w-4" /> Refresh playback status
        </button>
      ) : null}
      {message ? (
        <p className={`min-w-0 break-words text-xs leading-5 sm:col-span-2 ${message.tone === 'error' ? 'text-rose-300' : message.tone === 'success' ? 'text-emerald-300' : 'text-amber-200'}`}
          role={message.tone === 'error' ? 'alert' : 'status'}>{message.text}</p>
      ) : null}
    </section>
  );
}
