import net from 'node:net';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { assertPlayerAction } from '../../src/player-connections.mjs';
import { requestTimeout, object, secondsMs, optionalText } from './player-transport.mjs';

const commands = Object.freeze({ play: ['set_property', 'pause', false], pause: ['set_property', 'pause', true],
  stop: ['stop'], next: ['playlist-next', 'weak'], previous: ['playlist-prev', 'weak'] });
export class MpvPlayerControl {
  constructor({ socketPath, timeoutMs = 5000 } = {}) {
    if (typeof socketPath !== 'string' || socketPath.length > 240 || /[\r\n\0]/.test(socketPath)
      || (process.platform === 'win32' ? !/^\\\\\.\\pipe\\[\w.-]+$/.test(socketPath) : !path.isAbsolute(socketPath))) {
      throw new Error('Choose an absolute local mpv IPC socket or a Windows named pipe.');
    }
    this.endpoint = process.platform === 'win32' ? socketPath : path.normalize(socketPath);
    this.timeoutMs = requestTimeout(timeoutMs);
    this.program = 'mpv'; this.protocol = 'mpv_json_ipc';
  }
  #request(command) {
    return new Promise((resolve, reject) => {
      const id = randomInt(1, 0x7fffffff);
      const socket = net.createConnection(this.endpoint);
      let pending = '', bytes = 0, completed = false;
      const finish = (error, value) => {
        if (completed) return;
        completed = true; clearTimeout(timer); socket.destroy();
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error('mpv response timed out; command delivery may be uncertain.')), this.timeoutMs);
      socket.setEncoding('utf8');
      socket.once('connect', () => socket.write(JSON.stringify({ command, request_id: id }) + '\n'));
      socket.on('error', () => finish(new Error('mpv IPC connection failed; command delivery may be uncertain.')));
      socket.once('end', () => finish(new Error('mpv closed before acknowledging the request.')));
      socket.once('close', () => finish(new Error('mpv connection closed without an acknowledgement.')));
      socket.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 1024 * 1024) return finish(new Error('mpv response exceeds the permitted size.'));
        pending += chunk;
        for (;;) {
          const end = pending.indexOf('\n'); if (end < 0) break;
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          if (!line.trim()) continue;
          let value;
          try { value = JSON.parse(line); } catch { return finish(new Error('Unreadable mpv response.')); }
          if (!object(value)) return finish(new Error('Invalid mpv response.'));
          if (value.request_id !== id) continue; // Events/other request IDs are not acknowledgement.
          if (value.error !== 'success') return finish(new Error('mpv did not accept the requested operation.'));
          return finish(null, value.data);
        }
      });
    });
  }
  async readState() {
    // Read-only property queries never start playback. Media fields can be absent while idle.
    const state = await this.#request(['get_property', 'property-list']);
    if (!Array.isArray(state) || !state.includes('pause') || !state.includes('idle-active')) {
      throw new Error('mpv did not return its property list.');
    }
    const [paused, idle, position, duration, title] = await Promise.all([
      this.#request(['get_property', 'pause']), this.#request(['get_property', 'idle-active']),
      this.#optionalProperty('time-pos'), this.#optionalProperty('duration'), this.#optionalProperty('media-title'),
    ]);
    if (typeof paused !== 'boolean' || typeof idle !== 'boolean') throw new Error('Unreadable mpv playback state.');
    return { sourceKey: 'mpv', transport: this.protocol, connectionStatus: 'connected', deck: 1,
      trackTitle: optionalText(title), trackArtist: null, trackPath: null,
      playing: !paused && !idle, positionMs: secondsMs(position), durationMs: secondsMs(duration),
      bpmTimes100: null, observedAt: new Date().toISOString(), metadata: { idle, paused } };
  }
  async #optionalProperty(name) {
    // Missing media fields on an idle player are not fabricated zeroes.
    try { return await this.#request(['get_property', name]); }
    catch (error) { if (error.message === 'mpv did not accept the requested operation.') return null; throw error; }
  }
  async executeCommand(command) {
    assertPlayerAction('mpv', command?.action, command?.payload?.deck);
    if (command.action === 'play') {
      const idle = await this.#request(['get_property', 'idle-active']);
      if (idle !== false) throw new Error('Load a track in the selected mpv player before sending Play.');
    }
    await this.#request(commands[command.action]);
    return { executionStatus: 'accepted', action: command.action, deck: 1, program: 'mpv' };
  }
}
