import { boundedPlayerJson } from '../../src/bounded-player-json.mjs';
import { assertPlayerAction } from '../../src/player-connections.mjs';
import { localHttpEndpoint, requestTimeout, boundedOperation, object, secondsMs, optionalText } from './player-transport.mjs';

const commands = Object.freeze({ play: 'pl_forceresume', pause: 'pl_forcepause', stop: 'pl_stop', next: 'pl_next', previous: 'pl_previous' });
export class VlcPlayerControl {
  #authorization;
  #fetch;
  constructor({ baseUrl = 'http://127.0.0.1:8080', password, timeoutMs = 5000, fetchImpl = fetch } = {}) {
    if (typeof password !== 'string' || !password || password.length > 512 || /[\r\n]/.test(password)) {
      throw new Error('VLC requires a local HTTP password.');
    }
    this.endpoint = localHttpEndpoint(baseUrl);
    this.timeoutMs = requestTimeout(timeoutMs);
    this.#authorization = 'Basic ' + Buffer.from(':' + password).toString('base64');
    this.#fetch = fetchImpl;
    this.program = 'vlc';
    this.protocol = 'vlc_http';
  }
  async #status(command) {
    const url = new URL('/requests/status.json', this.endpoint);
    if (command) url.searchParams.set('command', command);
    const controller = new AbortController();
    return boundedOperation(this.timeoutMs, async () => {
      const response = await this.#fetch(url, { method: 'GET', redirect: 'error', cache: 'no-store',
        headers: { authorization: this.#authorization, accept: 'application/json' }, signal: controller.signal });
      if (!response.ok) throw new Error(`VLC rejected the request (HTTP ${response.status}).`);
      const value = await boundedPlayerJson(response);
      if (!object(value) || !['playing', 'paused', 'stopped'].includes(value.state)
        || Object.hasOwn(value, 'error')) throw new Error('VLC did not return a valid player state.');
      return value;
    }, () => controller.abort());
  }
  async readState() {
    const state = await this.#status();
    const meta = state.information?.category?.meta;
    return { sourceKey: 'vlc', transport: this.protocol, connectionStatus: 'connected', deck: 1,
      trackTitle: optionalText(meta?.title) ?? optionalText(meta?.filename), trackArtist: optionalText(meta?.artist),
      trackPath: null, playing: state.state === 'playing', positionMs: secondsMs(state.time),
      durationMs: secondsMs(state.length), bpmTimes100: null, observedAt: new Date().toISOString(),
      metadata: { playerState: state.state, playlistItemId: Number.isInteger(state.currentplid) ? state.currentplid : null } };
  }
  async executeCommand(command) {
    assertPlayerAction('vlc', command?.action, command?.payload?.deck);
    let operation = commands[command.action];
    if (command.action === 'play') {
      const current = await this.#status();
      if (current.state === 'playing') return { executionStatus: 'accepted', action: 'play', deck: 1, program: 'vlc', noOp: true };
      operation = current.state === 'paused' ? 'pl_forceresume' : 'pl_play';
    }
    await this.#status(operation);
    // An endpoint response is not independent proof of resulting playback.
    return { executionStatus: 'accepted', action: command.action, deck: 1, program: 'vlc' };
  }
}
