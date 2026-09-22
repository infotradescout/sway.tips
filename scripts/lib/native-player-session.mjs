import { createHash, randomUUID } from 'node:crypto';
import { assertPlayerAction } from '../../src/player-connections.mjs';
import { executeClaimedOnce, validateExecutionLedger } from './control-bridge-execution.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const assertUuid = value => { if (typeof value !== 'string' || !UUID.test(value)) throw new Error('A valid connection/command identity is required.'); };
const owns = (object, key) => Object.hasOwn(object, key);
const poisoned = new WeakSet();
const inFlight = new WeakMap();
export function newNativePlayerJournal(actorId) {
  if (typeof actorId !== 'string' || !actorId.trim() || actorId.length > 200) throw new Error('An authorized owner is required.');
  return { version: 1, actorId, connections: {}, bindings: {},
    execution: { version: 1, bridgeInstanceId: randomUUID(), outcomes: {}, pendingCompletionIds: [] } };
}
export function validateNativePlayerJournal(value, actorId) {
  if (!record(value) || value.version !== 1 || value.actorId !== actorId || !record(value.connections) || !record(value.bindings)) {
    throw new Error('Native player journal is corrupt or belongs to another owner.');
  }
  validateExecutionLedger(value.execution);
  for (const [id, connection] of Object.entries(value.connections)) {
    assertUuid(id); assertUuid(connection?.revision);
    if (!record(connection) || !SHA256.test(connection.targetKey)) throw new Error('Invalid durable target binding.');
  }
  const outcomes = value.execution.outcomes;
  for (const [id, binding] of Object.entries(value.bindings)) {
    assertUuid(id);
    if (!record(binding) || !SHA256.test(binding.fingerprint) || !SHA256.test(binding.targetKey)
      || !owns(value.connections, binding.connectionId) || !UUID.test(binding.revision)
      || !['play', 'pause', 'stop', 'cue', 'next', 'previous'].includes(binding.action) || !owns(outcomes, id)) throw new Error('Command binding has no matching durable outcome.');
    if (binding.reviewedAt !== undefined && (!Number.isFinite(Date.parse(binding.reviewedAt)) || outcomes[id].result.executionStatus !== 'unknown')) {
      throw new Error('Invalid manual uncertainty review.');
    }
  }
  if (Object.keys(outcomes).some(id => !owns(value.bindings, id))) throw new Error('An execution outcome lost its target binding.');
  return value;
}

// The host must authorize actorId before constructing this session. This module
// does not replace Sway's performer/room authorization. The host must also own an
// exclusive journal-file lock for the session lifetime (see native-player-store).
export class NativePlayerSession {
  constructor({ player, actorId, connectionId, journal, persist }) {
    assertUuid(connectionId);
    validateNativePlayerJournal(journal, actorId);
    if (typeof persist !== 'function' || persist.constructor.name === 'AsyncFunction') throw new Error('Synchronous durable storage is required.');
    this.player = player; this.actorId = actorId; this.connectionId = connectionId; this.journal = journal; this.persist = persist;
    const existing = journal.connections[connectionId];
    if (existing && existing.targetKey !== player.targetKey) throw new Error('This connection belongs to another player/endpoint/deck. Reconfigure it explicitly.');
    if (!existing) {
      journal.connections[connectionId] = { revision: randomUUID(), targetKey: player.targetKey };
      this.#save();
    }
    this.revision = journal.connections[connectionId].revision;
  }
  #save() {
    if (poisoned.has(this.journal)) throw new Error('Player storage failed; reopen the durable journal before continuing.');
    try {
      const result = this.persist();
      if (result && typeof result.then === 'function') throw new Error('Asynchronous persistence cannot reserve before player I/O.');
    } catch (error) { poisoned.add(this.journal); throw error; }
  }
  #current(revision) {
    if (poisoned.has(this.journal)) throw new Error('Player storage failed; commands are held.');
    if (revision !== this.revision || this.journal.connections[this.connectionId].revision !== this.revision) {
      throw new Error('Stale player connection. Refresh and select the current target.');
    }
  }
  #held() {
    return Object.entries(this.journal.bindings).some(([id, binding]) => binding.targetKey === this.player.targetKey
      && this.journal.execution.outcomes[id].result.executionStatus === 'unknown' && !binding.reviewedAt);
  }
  describe() {
    return { id: this.connectionId, revision: this.revision, targetKey: this.player.targetKey,
      program: this.player.target.program, deck: this.player.target.deck, capabilities: { ...this.player.capabilities,
        actions: this.player.capabilities.actions.filter(action => action !== 'load'), exactTrackLoading: false },
      uncertain: this.#held(), pendingReview: Object.entries(this.journal.bindings).filter(([id, binding]) =>
        binding.targetKey === this.player.targetKey && this.journal.execution.outcomes[id].result.executionStatus === 'unknown' && !binding.reviewedAt)
        .map(([id, binding]) => ({ id, action: binding.action, finishedAt: this.journal.execution.outcomes[id].finishedAt })) };
  }
  #receipt(id, replay, outcome) {
    return { id, connectionId: this.connectionId, revision: this.revision, targetKey: this.player.targetKey,
      program: this.player.target.program, deck: this.player.target.deck, replay, ...structuredClone(outcome) };
  }
  async readState(revision) {
    this.#current(revision);
    const state = await this.player.adapter.readState(this.player.target.deck);
    this.#current(revision);
    if (state.sourceKey !== this.player.target.program || state.deck !== this.player.target.deck) {
      throw new Error('Player state did not match the selected target.');
    }
    return { ...state, connectionId: this.connectionId, revision, targetKey: this.player.targetKey };
  }
  async execute({ id, revision, action, payload = {} }) {
    this.#current(revision); assertUuid(id);
    assertPlayerAction(this.player.target.program, action, this.player.target.deck);
    if (!record(payload) || Object.keys(payload).some(key => key !== 'deck')
      || (payload.deck !== undefined && payload.deck !== this.player.target.deck)) {
      throw new Error('Command payload does not match this fixed player target.');
    }
    // Track loading remains in the existing approved-library route; no path or
    // arbitrary command is accepted through this transport-only session.
    if (action === 'load') throw new Error('Track loading requires the existing approved-library route.');
    const fingerprint = createHash('sha256').update(JSON.stringify({ actorId: this.actorId,
      connectionId: this.connectionId, revision, targetKey: this.player.targetKey, action })).digest('hex');
    const binding = this.journal.bindings[id];
    if (binding && binding.fingerprint !== fingerprint) throw new Error('Command identity already belongs to a different intent or target.');
    if (binding) return this.#receipt(id, true, this.journal.execution.outcomes[id]);
    if (this.#held()) throw new Error('Check the original player and explicitly review the uncertain command before sending another.');
    const active = inFlight.get(this.journal) ?? new Set(); inFlight.set(this.journal, active);
    if (active.has(this.player.targetKey)) throw new Error('A command for this target is still in flight.');
    if (Object.keys(this.journal.bindings).length >= 10000) throw new Error('Journal capacity reached; preserve it and perform supervised archival.');
    this.journal.bindings[id] = { fingerprint, connectionId: this.connectionId, revision, targetKey: this.player.targetKey, action };
    active.add(this.player.targetKey);
    try {
      const outcome = await executeClaimedOnce({ command: { id, action, payload: { deck: this.player.target.deck } },
        ledger: this.journal.execution, persist: () => this.#save(), execute: command => this.player.adapter.executeCommand(command) });
      return this.#receipt(id, false, outcome);
    } finally { active.delete(this.player.targetKey); }
  }
  reviewUnknown({ id, revision, checkedOriginalPlayer }) {
    this.#current(revision); assertUuid(id);
    const binding = this.journal.bindings[id];
    if (checkedOriginalPlayer !== true || !binding || binding.targetKey !== this.player.targetKey
      || this.journal.execution.outcomes[id].result.executionStatus !== 'unknown'
      || inFlight.get(this.journal)?.has(this.player.targetKey)) {
      throw new Error('Review requires a completed uncertain attempt and an explicit original-player check.');
    }
    binding.reviewedAt ??= new Date().toISOString(); this.#save();
    return { id, reviewedAt: binding.reviewedAt, replayed: false };
  }
  reconnect(revision) {
    this.#current(revision);
    if (inFlight.get(this.journal)?.has(this.player.targetKey)) throw new Error('Wait for the current command outcome before reconnecting.');
    this.revision = randomUUID(); this.journal.connections[this.connectionId].revision = this.revision; this.#save();
    // Rotating a connection never clears an uncertain outcome or dispatches it.
    return this.describe();
  }
}
