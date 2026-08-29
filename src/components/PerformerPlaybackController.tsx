import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleDot, ListStart, Pause, Play, SkipBack, SkipForward, Square } from 'lucide-react';
import {
  listPlaybackMidiOutputs,
  MIDI_PLAYBACK_NOTE_MAP,
  requestPlaybackMidiAccess,
  sendPlaybackMidiAction,
  type BrowserMidiOutput
} from '../browser-midi-playback';
import type { PlaybackAction, PlaybackSourceKey } from '../playback-control';
import type { RequestItem } from '../types';

type PlaybackStateSnapshot = {
  sourceKey: PlaybackSourceKey;
  connectionStatus: 'connected' | 'degraded' | 'disconnected';
  deck: number | null;
  trackTitle: string | null;
  trackArtist: string | null;
  playing: boolean | null;
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

type PlaybackSnapshot = {
  state: PlaybackStateSnapshot | null;
  commands: PlaybackCommandSnapshot[];
};

const SOURCE_STORAGE_KEY = 'sway.performer.playbackSource.v1';
const DECK_STORAGE_KEY = 'sway.performer.playbackDeck.v1';
const MIDI_OUTPUT_STORAGE_KEY = 'sway.performer.playbackMidiOutput.v1';

function storedSource(): PlaybackSourceKey {
  if (typeof window === 'undefined') return 'virtualdj';
  return window.localStorage.getItem(SOURCE_STORAGE_KEY) === 'generic_midi' ? 'generic_midi' : 'virtualdj';
}

function storedDeck() {
  if (typeof window === 'undefined') return 1;
  const deck = Number(window.localStorage.getItem(DECK_STORAGE_KEY));
  return Number.isInteger(deck) && deck >= 1 && deck <= 4 ? deck : 1;
}

const ACTION_BUTTONS: Array<{
  action: PlaybackAction;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { action: 'previous', label: 'Previous', icon: SkipBack },
  { action: 'cue', label: 'Cue', icon: CircleDot },
  { action: 'play', label: 'Play', icon: Play },
  { action: 'pause', label: 'Pause', icon: Pause },
  { action: 'stop', label: 'Stop', icon: Square },
  { action: 'next', label: 'Next', icon: SkipForward }
];

function latestCommandMessage(commands: PlaybackCommandSnapshot[]) {
  const latest = commands.find((command) => Date.now() - new Date(command.createdAt).getTime() <= 30_000);
  if (!latest) return null;
  if (latest.status === 'failed' || latest.status === 'expired') {
    return { tone: 'error' as const, text: latest.errorText || `${latest.action} failed.` };
  }
  if (latest.status === 'succeeded') return { tone: 'success' as const, text: `${latest.action} confirmed by VirtualDJ.` };
  return { tone: 'pending' as const, text: `${latest.action} ${latest.status}.` };
}

export default function PerformerPlaybackController({
  gigId,
  approvedRequests,
  previewMode = false
}: {
  gigId: string | null;
  approvedRequests: RequestItem[];
  previewMode?: boolean;
}) {
  const [sourceKey, setSourceKey] = useState<PlaybackSourceKey>(() => storedSource());
  const [deck, setDeck] = useState(() => storedDeck());
  const [snapshot, setSnapshot] = useState<PlaybackSnapshot>({ state: null, commands: [] });
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PlaybackAction | null>(null);
  const [localMessage, setLocalMessage] = useState<{ tone: 'success' | 'pending' | 'error'; text: string } | null>(null);
  const [midiOutputs, setMidiOutputs] = useState<BrowserMidiOutput[]>([]);
  const [midiOutputId, setMidiOutputId] = useState(() => (
    typeof window === 'undefined' ? '' : window.localStorage.getItem(MIDI_OUTPUT_STORAGE_KEY) || ''
  ));
  const [midiStatus, setMidiStatus] = useState<'idle' | 'requesting' | 'ready' | 'error'>('idle');
  const midiAccessRef = useRef<Awaited<ReturnType<typeof requestPlaybackMidiAccess>> | null>(null);

  const refreshSnapshot = useCallback(async () => {
    if (!gigId || previewMode || sourceKey !== 'virtualdj') return;
    try {
      const response = await fetch(`/api/talent/playback/snapshot/${encodeURIComponent(gigId)}`, { cache: 'no-store' });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'Playback status is unavailable.');
      setSnapshot({
        state: data?.state && typeof data.state === 'object' ? data.state : null,
        commands: Array.isArray(data?.commands) ? data.commands : []
      });
      setSnapshotError(null);
    } catch (error) {
      setSnapshotError(error instanceof Error ? error.message : 'Playback status is unavailable.');
    }
  }, [gigId, previewMode, sourceKey]);

  useEffect(() => {
    void refreshSnapshot();
    if (!gigId || previewMode || sourceKey !== 'virtualdj') return;
    const interval = window.setInterval(() => void refreshSnapshot(), 2_000);
    return () => window.clearInterval(interval);
  }, [gigId, previewMode, refreshSnapshot, sourceKey]);

  useEffect(() => {
    window.localStorage.setItem(SOURCE_STORAGE_KEY, sourceKey);
  }, [sourceKey]);

  useEffect(() => {
    window.localStorage.setItem(DECK_STORAGE_KEY, String(deck));
  }, [deck]);

  useEffect(() => {
    if (!localMessage) return;
    const timeout = window.setTimeout(() => setLocalMessage(null), 8_000);
    return () => window.clearTimeout(timeout);
  }, [localMessage]);

  const selectedMidiOutput = useMemo(
    () => midiOutputs.find((output) => output.id === midiOutputId) || null,
    [midiOutputId, midiOutputs]
  );
  const virtualDjConnected = Boolean(
    snapshot.state?.fresh
    && snapshot.state.connectionStatus === 'connected'
    && snapshot.state.sourceKey === 'virtualdj'
  );
  const topRequest = approvedRequests[0] || null;
  const cloudMessage = latestCommandMessage(snapshot.commands);
  const message = localMessage || (sourceKey === 'virtualdj' ? cloudMessage : null);

  const chooseSource = (nextSource: PlaybackSourceKey) => {
    setSourceKey(nextSource);
    setLocalMessage(null);
  };

  const enableMidi = async () => {
    setMidiStatus('requesting');
    try {
      const access = await requestPlaybackMidiAccess();
      midiAccessRef.current = access;
      const refresh = () => {
        const outputs = listPlaybackMidiOutputs(access);
        setMidiOutputs(outputs);
        setMidiOutputId((current) => {
          const next = outputs.some((output) => output.id === current) ? current : outputs[0]?.id || '';
          if (next) window.localStorage.setItem(MIDI_OUTPUT_STORAGE_KEY, next);
          return next;
        });
      };
      access.onstatechange = refresh;
      refresh();
      setMidiStatus('ready');
      setLocalMessage({
        tone: 'success',
        text: listPlaybackMidiOutputs(access).length
          ? 'MIDI output ready. Use your DJ app’s MIDI Learn for notes 37–42.'
          : 'Web MIDI is enabled, but no output exists. Create an IAC Bus or loopMIDI port.'
      });
    } catch (error) {
      setMidiStatus('error');
      setLocalMessage({ tone: 'error', text: error instanceof Error ? error.message : 'MIDI access failed.' });
    }
  };

  const runAction = async (action: PlaybackAction) => {
    if (previewMode || !gigId || pendingAction) return;
    if (action === 'load' && !topRequest) {
      setLocalMessage({ tone: 'error', text: 'Approve a request before loading the crowd pick.' });
      return;
    }
    if (sourceKey === 'generic_midi') {
      if (action === 'load') {
        setLocalMessage({ tone: 'error', text: 'Generic MIDI cannot identify a track. Load it manually, then control transport from Sway.' });
        return;
      }
      if (!selectedMidiOutput) {
        setLocalMessage({ tone: 'error', text: 'Choose a virtual MIDI output first.' });
        return;
      }
      try {
        const sent = sendPlaybackMidiAction(selectedMidiOutput, action, deck);
        setLocalMessage({ tone: 'success', text: `${action} sent on MIDI channel ${sent.channel}, note ${sent.note}. One-way transport has no deck acknowledgement.` });
      } catch (error) {
        setLocalMessage({ tone: 'error', text: error instanceof Error ? error.message : 'MIDI command failed.' });
      }
      return;
    }
    if (!virtualDjConnected) {
      setLocalMessage({ tone: 'error', text: 'Start the Sway Control Bridge and VirtualDJ Network Control first.' });
      return;
    }

    setPendingAction(action);
    setLocalMessage({ tone: 'pending', text: `${action} queued for VirtualDJ.` });
    try {
      const response = await fetch('/api/talent/playback/commands', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          gig_id: gigId,
          clientCommandId: crypto.randomUUID(),
          sourceKey: 'virtualdj',
          action,
          payload: {
            deck,
            track: action === 'load' && topRequest ? {
              requestId: topRequest.id,
              sourceTrackId: topRequest.sourceTrackId || null,
              externalTrackId: topRequest.externalTrackId || null,
              title: topRequest.title,
              artist: topRequest.subtitle || null
            } : null
          }
        })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'Playback command failed.');
      setLocalMessage({ tone: 'pending', text: `${action} queued; waiting for VirtualDJ acknowledgement.` });
      window.setTimeout(() => void refreshSnapshot(), 300);
    } catch (error) {
      setLocalMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Playback command failed.' });
    } finally {
      setPendingAction(null);
    }
  };

  useEffect(() => {
    const onMappedHardwareAction = (event: Event) => {
      const action = (event as CustomEvent<PlaybackAction>).detail;
      if (!['load', 'play', 'pause', 'stop', 'cue', 'next', 'previous'].includes(action)) return;
      void runAction(action);
    };
    window.addEventListener('sway:playback-action', onMappedHardwareAction);
    return () => window.removeEventListener('sway:playback-action', onMappedHardwareAction);
  });

  const sourceStatus = sourceKey === 'virtualdj'
    ? virtualDjConnected ? 'VirtualDJ linked' : snapshotError || 'Bridge offline'
    : selectedMidiOutput ? `MIDI → ${selectedMidiOutput.name || 'output'}` : 'MIDI output not selected';

  return (
    <section
      data-sway-playback-controller="true"
      className="grid gap-2 rounded-2xl border border-fuchsia-500/20 bg-slate-900/95 p-2.5 shadow-lg sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
      aria-label="External DJ playback controller"
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${
            sourceKey === 'virtualdj' ? virtualDjConnected ? 'bg-emerald-400' : 'bg-rose-400' : selectedMidiOutput ? 'bg-cyan-400' : 'bg-amber-400'
          }`} />
          <p className="truncate text-xs font-black text-white">
            {sourceKey === 'virtualdj' && snapshot.state?.trackTitle
              ? `${snapshot.state.trackArtist ? `${snapshot.state.trackArtist} — ` : ''}${snapshot.state.trackTitle}`
              : topRequest
                ? `Up next: ${topRequest.title}`
                : 'No approved crowd pick'}
          </p>
          {sourceKey === 'virtualdj' && snapshot.state?.bpmTimes100 ? (
            <span className="shrink-0 font-mono text-[9px] text-fuchsia-200">{(snapshot.state.bpmTimes100 / 100).toFixed(1)} BPM</span>
          ) : null}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <select
            value={sourceKey}
            onChange={(event) => chooseSource(event.target.value as PlaybackSourceKey)}
            aria-label="Playback source"
            className="min-h-9 max-w-[11rem] rounded-lg border border-white/10 bg-slate-950 px-2 text-[10px] font-black text-white outline-none focus:border-fuchsia-400"
          >
            <option value="virtualdj">VirtualDJ · full control</option>
            <option value="generic_midi">MIDI · one-way</option>
          </select>
          <select
            value={deck}
            onChange={(event) => setDeck(Number(event.target.value))}
            aria-label="Target deck"
            className="min-h-9 rounded-lg border border-white/10 bg-slate-950 px-2 text-[10px] font-black text-white outline-none focus:border-fuchsia-400"
          >
            {[1, 2, 3, 4].map((value) => <option key={value} value={value}>Deck {value}</option>)}
          </select>
          {sourceKey === 'generic_midi' ? (
            midiStatus !== 'ready' ? (
              <button type="button" onClick={() => void enableMidi()} disabled={midiStatus === 'requesting'} className="min-h-9 rounded-lg bg-cyan-500 px-3 text-[10px] font-black uppercase text-slate-950 disabled:opacity-50">
                {midiStatus === 'requesting' ? 'Checking' : 'Choose MIDI output'}
              </button>
            ) : (
              <select
                value={midiOutputId}
                onChange={(event) => {
                  setMidiOutputId(event.target.value);
                  window.localStorage.setItem(MIDI_OUTPUT_STORAGE_KEY, event.target.value);
                }}
                aria-label="Virtual MIDI output"
                className="min-h-9 min-w-0 max-w-[12rem] rounded-lg border border-white/10 bg-slate-950 px-2 text-[10px] font-bold text-white"
              >
                {midiOutputs.length ? midiOutputs.map((output) => (
                  <option key={output.id} value={output.id}>{output.name || output.id}</option>
                )) : <option value="">No MIDI outputs</option>}
              </select>
            )
          ) : null}
          <span className="min-w-0 truncate text-[9px] font-bold text-slate-400">{sourceStatus}</span>
        </div>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-1 sm:justify-end">
        <button
          type="button"
          onClick={() => void runAction('load')}
          disabled={previewMode || !gigId || !topRequest || pendingAction !== null || sourceKey !== 'virtualdj'}
          className="inline-flex min-h-10 items-center gap-1 rounded-lg bg-fuchsia-600 px-2.5 text-[9px] font-black uppercase text-white disabled:cursor-not-allowed disabled:opacity-40"
          title={sourceKey === 'generic_midi' ? 'MIDI cannot carry a track identity.' : 'Load the top approved request'}
        >
          <ListStart className="h-3.5 w-3.5" /> Load top
        </button>
        {ACTION_BUTTONS.map(({ action, label, icon: Icon }) => (
          <button
            key={action}
            type="button"
            onClick={() => void runAction(action)}
            disabled={previewMode || !gigId || pendingAction !== null}
            aria-label={`${label} deck ${deck}`}
            title={sourceKey === 'generic_midi' ? `${label}: MIDI note ${MIDI_PLAYBACK_NOTE_MAP[action]}` : label}
            className={`flex h-10 w-10 items-center justify-center rounded-lg border text-white disabled:cursor-not-allowed disabled:opacity-40 ${
              action === 'play' ? 'border-emerald-500/40 bg-emerald-500/20' : 'border-white/10 bg-slate-950'
            }`}
          >
            <Icon className="h-4 w-4" />
          </button>
        ))}
      </div>

      {message ? (
        <p className={`min-w-0 truncate text-[9px] sm:col-span-2 ${
          message.tone === 'error' ? 'text-rose-300' : message.tone === 'success' ? 'text-emerald-300' : 'text-amber-200'
        }`} role="status">
          {message.text}
        </p>
      ) : null}
    </section>
  );
}
