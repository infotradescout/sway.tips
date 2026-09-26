import { boundedPlayerJson } from './bounded-player-json.mjs';
import { playerCapabilities } from './player-connections.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function parseNativeConnection(value) {
  if (!object(value) || !UUID.test(value.id) || !UUID.test(value.revision) || !HASH.test(value.targetKey)) throw new Error('Unreadable native connection identity.');
  const capabilities = playerCapabilities(value.program);
  if (capabilities.kind !== 'native_player' || !capabilities.decks.includes(value.deck)
    || !object(value.capabilities) || !Array.isArray(value.capabilities.actions)
    || value.capabilities.actions.some(action => action === 'load' || !capabilities.actions.includes(action))
    || typeof value.uncertain !== 'boolean' || !Array.isArray(value.pendingReview)) throw new Error('Unreadable native player capabilities.');
  const pendingReview = value.pendingReview.map(item => {
    if (!object(item) || !UUID.test(item.id) || !capabilities.actions.includes(item.action) || !Number.isFinite(Date.parse(item.finishedAt))) {
      throw new Error('Unreadable pending player review.');
    }
    return { id: item.id, action: item.action, finishedAt: item.finishedAt };
  });
  if (value.uncertain !== Boolean(pendingReview.length)) throw new Error('Native player uncertainty is inconsistent.');
  return { id: value.id, revision: value.revision, targetKey: value.targetKey, program: value.program,
    deck: value.deck, label: capabilities.label, actions: [...new Set(value.capabilities.actions)],
    uncertain: value.uncertain, pendingReview };
}
export class NativePlayerClient {
  #key; #base; #fetch; #signal; #timeout;
  // Window.fetch requires its original receiver; Node-only tests did not expose this.
  constructor({ pairingKey, port = 4316, signal, fetchImpl = globalThis.fetch.bind(globalThis), timeoutMs = 10000 }) {
    if (typeof pairingKey !== 'string' || !/^[\w-]{32,128}$/.test(pairingKey) || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Enter the private pairing key displayed on your player computer.');
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 15000) throw new Error('Invalid player deadline.');
    this.#key = pairingKey; this.#base = `http://127.0.0.1:${port}`; this.#fetch = fetchImpl; this.#signal = signal; this.#timeout = timeoutMs;
  }
  async #request(path, body) {
    const controller = new AbortController(); let timer;
    let rejectAbort;
    const cancelled = new Promise((_, reject) => { rejectAbort = reject; });
    const abort = () => { rejectAbort(new Error('Player operation was interrupted; a command may have arrived. It will not be retried.')); controller.abort(); };
    this.#signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(abort, this.#timeout);
    try {
      if (this.#signal?.aborted) throw new Error('Player session ended.');
      return await Promise.race([cancelled, (async () => {
        const response = await this.#fetch(this.#base + path, { method: body === undefined ? 'GET' : 'POST',
          headers: { authorization: 'Bearer ' + this.#key, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
          body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', cache: 'no-store', signal: controller.signal });
        const value = await boundedPlayerJson(response);
        if (!response.ok) throw new Error(typeof value?.error === 'string' ? value.error.slice(0, 500) : 'Player operation could not be confirmed.');
        if (!object(value)) throw new Error('Unreadable native host response.');
        return value;
      })()]);
    } finally { clearTimeout(timer); this.#signal?.removeEventListener('abort', abort); }
  }
  async list() {
    const value = await this.#request('/v1/connections');
    if (!Array.isArray(value.connections) || value.connections.length > 64 || !Number.isFinite(Date.parse(value.expiresAt))
      || Date.parse(value.expiresAt) <= Date.now()) throw new Error('Player pairing is expired or unreadable.');
    const connections = value.connections.map(parseNativeConnection);
    if (new Set(connections.map(connection => connection.id)).size !== connections.length) throw new Error('Duplicate native connection identity.');
    return connections;
  }
  async state(connection) {
    const value = (await this.#request('/v1/state?' + new URLSearchParams({ connectionId: connection.id, revision: connection.revision }))).state;
    if (!object(value) || value.connectionId !== connection.id || value.revision !== connection.revision || value.targetKey !== connection.targetKey
      || value.sourceKey !== connection.program || value.deck !== connection.deck || value.connectionStatus !== 'connected'
      || typeof value.playing !== 'boolean' || !Number.isFinite(Date.parse(value.observedAt))) throw new Error('Player state did not match the selected connection.');
    const age = Date.now() - Date.parse(value.observedAt);
    if (age < -5000 || age > 15000) throw new Error('Player state is no longer current.');
    for (const field of ['trackTitle', 'trackArtist']) if (value[field] !== null && typeof value[field] !== 'string') throw new Error('Unreadable player metadata.');
    for (const field of ['positionMs', 'durationMs']) if (value[field] !== null && (!Number.isFinite(value[field]) || value[field] < 0)) throw new Error('Unreadable player position.');
    return { playing: value.playing, trackTitle: value.trackTitle, trackArtist: value.trackArtist,
      positionMs: value.positionMs, durationMs: value.durationMs, observedAt: value.observedAt };
  }
  async command(connection, { id, action }) {
    if (!UUID.test(id) || !connection.actions.includes(action) || connection.uncertain) throw new Error('Select an available action after reviewing uncertainty.');
    const value = (await this.#request('/v1/command', { connectionId: connection.id, revision: connection.revision, id, action, payload: { deck: connection.deck } })).receipt;
    if (!object(value) || value.id !== id || value.connectionId !== connection.id || value.revision !== connection.revision
      || value.targetKey !== connection.targetKey || value.program !== connection.program || value.deck !== connection.deck
      || typeof value.success !== 'boolean' || typeof value.replay !== 'boolean' || !object(value.result)
      || !Number.isFinite(Date.parse(value.finishedAt))) throw new Error('The command receipt could not be bound to its player.');
    if (value.success && !(value.result.executionStatus === 'accepted' || value.result.executed === true)) throw new Error('Unreadable command acknowledgement.');
    if (!value.success && value.result.executionStatus !== 'unknown') throw new Error('Unreadable command uncertainty.');
    return { id, accepted: value.success, uncertain: !value.success, replay: value.replay };
  }
  async reconnect(connection) {
    const value = parseNativeConnection((await this.#request('/v1/reconnect', { connectionId: connection.id, revision: connection.revision })).connection);
    if (value.id !== connection.id || value.targetKey !== connection.targetKey || value.program !== connection.program
      || value.deck !== connection.deck || value.revision === connection.revision) throw new Error('Reconnect changed the intended player.');
    return value;
  }
  async review(connection, id) {
    if (!connection.pendingReview.some(item => item.id === id)) throw new Error('Choose the exact uncertain command to review.');
    const value = (await this.#request('/v1/review', { connectionId: connection.id, revision: connection.revision, id, checkedOriginalPlayer: true })).review;
    if (!object(value) || value.id !== id || value.replayed !== false || !Number.isFinite(Date.parse(value.reviewedAt))) {
      throw new Error('Manual review could not be confirmed.');
    }
    return value;
  }
}
