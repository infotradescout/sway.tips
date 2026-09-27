// Common capability descriptions, not a list of verified production integrations.
// Cloud accounts, native players and one-way MIDI remain different connection kinds.
const definitions = {
  virtualdj: { kind: 'native_player', protocol: 'virtualdj_network_control_http', label: 'VirtualDJ',
    actions: ['load', 'play', 'pause', 'stop', 'cue', 'next', 'previous'], decks: [1, 2, 3, 4, 5, 6, 7, 8],
    playbackFeedback: true, libraryBrowsing: false, exactTrackLoading: true },
  vlc: { kind: 'native_player', protocol: 'vlc_http', label: 'VLC',
    actions: ['play', 'pause', 'stop', 'next', 'previous'], decks: [1],
    playbackFeedback: true, libraryBrowsing: false, exactTrackLoading: false },
  mpv: { kind: 'native_player', protocol: 'mpv_json_ipc', label: 'mpv',
    actions: ['play', 'pause', 'stop', 'next', 'previous'], decks: [1],
    playbackFeedback: true, libraryBrowsing: false, exactTrackLoading: false },
  mixxx: { kind: 'midi_mapping', protocol: 'web_midi', label: 'Mixxx',
    actions: ['play', 'pause', 'stop', 'cue'], decks: [1, 2, 3, 4],
    playbackFeedback: false, libraryBrowsing: false, exactTrackLoading: false },
  spotify: { kind: 'account', protocol: 'spotify_web_api', label: 'Spotify',
    actions: ['play', 'resume', 'pause', 'next', 'previous', 'queue', 'transfer'], decks: [],
    playbackFeedback: true, libraryBrowsing: true, exactTrackLoading: false },
};
export const PLAYER_CONNECTION_CAPABILITIES = Object.freeze(Object.fromEntries(
  Object.entries(definitions).map(([program, value]) => [program, Object.freeze({
    program, ...value, actions: Object.freeze(value.actions), decks: Object.freeze(value.decks),
  })])));
export function playerCapabilities(program) {
  if (typeof program !== 'string' || !Object.hasOwn(PLAYER_CONNECTION_CAPABILITIES, program)) {
    throw new Error('No implemented connection profile for this program.');
  }
  return PLAYER_CONNECTION_CAPABILITIES[program];
}
export function assertPlayerAction(program, action, deck) {
  const capabilities = playerCapabilities(program);
  if (!capabilities.actions.includes(action)) throw new Error(`Unsupported ${capabilities.label} action.`);
  if (deck !== undefined && !capabilities.decks.includes(deck)) throw new Error('Unsupported target deck.');
  return capabilities;
}
