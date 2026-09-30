import { createNativePlayerAdapter } from './native-player-registry.mjs';
import { NativePlayerSession } from './native-player-session.mjs';

// Shared native-host interface: no network listener, playback side effect or
// implicit target selection at construction. Account/MIDI hosts stay separate.
export class NativePlayerHub {
  #connections = new Map();
  constructor({ configs, actorId, store }) {
    if (!Array.isArray(configs) || !configs.length || configs.length > 64) throw new Error('Choose 1–64 explicit native-player connections.');
    if (new Set(configs.map(config => config.id)).size !== configs.length) throw new Error('Connection IDs must be unique.');
    // Validate every adapter before writing any new connection or contacting a player.
    const players = configs.map(config => createNativePlayerAdapter(config));
    configs.forEach((config, index) => this.#connections.set(config.id,
      new NativePlayerSession({ player: players[index], actorId, connectionId: config.id, journal: store.journal, persist: store.persist })));
  }
  list() { return [...this.#connections.values()].map(connection => connection.describe()); }
  #connection(id) {
    const value = this.#connections.get(id);
    if (!value) throw new Error('Choose an explicitly configured player connection.');
    return value;
  }
  readState(id, revision) { return this.#connection(id).readState(revision); }
  execute(id, command) { return this.#connection(id).execute(command); }
  reconnect(id, revision) { return this.#connection(id).reconnect(revision); }
  reviewUnknown(id, review) { return this.#connection(id).reviewUnknown(review); }
}
