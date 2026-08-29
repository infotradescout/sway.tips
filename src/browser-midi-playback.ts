import type { PlaybackAction } from './playback-control';

export type BrowserMidiOutput = {
  id: string;
  name: string | null;
  manufacturer: string | null;
  state: string;
  connection: string;
  send: (data: number[] | Uint8Array, timestamp?: number) => void;
};

type BrowserMidiAccess = {
  outputs: Map<string, BrowserMidiOutput>;
  onstatechange: ((event: unknown) => void) | null;
};

type MidiNavigator = Navigator & {
  requestMIDIAccess?: (options?: { sysex?: boolean; software?: boolean }) => Promise<BrowserMidiAccess>;
};

export const MIDI_PLAYBACK_NOTE_MAP: Record<PlaybackAction, number> = {
  load: 36,
  play: 37,
  pause: 38,
  stop: 39,
  cue: 40,
  next: 41,
  previous: 42
};

export async function requestPlaybackMidiAccess() {
  const request = (navigator as MidiNavigator).requestMIDIAccess;
  if (typeof request !== 'function') {
    throw new Error('Web MIDI is not available in this browser. Use Chrome or Edge on the booth computer.');
  }
  return request.call(navigator, { sysex: false, software: true });
}

export function listPlaybackMidiOutputs(access: BrowserMidiAccess) {
  return Array.from(access.outputs.values()).filter((output) => output.state !== 'disconnected');
}

export function sendPlaybackMidiAction(output: BrowserMidiOutput, action: PlaybackAction, deck = 1) {
  const channel = Math.max(0, Math.min(15, Math.floor(deck) - 1));
  const note = MIDI_PLAYBACK_NOTE_MAP[action];
  const noteOn = 0x90 | channel;
  const noteOff = 0x80 | channel;
  output.send([noteOn, note, 127]);
  output.send([noteOff, note, 0], performance.now() + 40);
  return { action, deck, channel: channel + 1, note };
}
