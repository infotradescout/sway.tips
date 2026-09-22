import { createHash } from 'node:crypto';
import { playerCapabilities } from '../../src/player-connections.mjs';
import { VirtualDjNetworkControl } from './virtualdj-network-control.mjs';
import { VlcPlayerControl } from './vlc-player-control.mjs';
import { MpvPlayerControl } from './mpv-player-control.mjs';
import { localHttpEndpoint } from './player-transport.mjs';

export function createNativePlayerAdapter(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('A player configuration is required.');
  const capabilities = playerCapabilities(config.program);
  if (capabilities.kind !== 'native_player') throw new Error('This connection uses its existing account or MIDI path, not a native adapter.');
  const deck = config.deck ?? 1;
  if (!Number.isInteger(deck) || !capabilities.decks.includes(deck)) throw new Error('Unsupported target deck.');
  let adapter;
  if (config.program === 'vlc') adapter = new VlcPlayerControl(config);
  else if (config.program === 'mpv') adapter = new MpvPlayerControl(config);
  else {
    const endpoint = localHttpEndpoint(config.baseUrl ?? 'http://127.0.0.1:8088');
    adapter = new VirtualDjNetworkControl({ baseUrl: endpoint, password: config.password, deck,
      requestTimeoutMs: config.timeoutMs, fetchImpl: config.fetchImpl });
    adapter.program = 'virtualdj'; adapter.protocol = capabilities.protocol; adapter.endpoint = endpoint;
  }
  const target = Object.freeze({ program: config.program, protocol: capabilities.protocol, endpoint: adapter.endpoint, deck });
  const targetKey = createHash('sha256').update(JSON.stringify(target)).digest('hex');
  // Authentication secrets are deliberately not part of a public connection description.
  return Object.freeze({ adapter: Object.freeze(adapter), target, targetKey, capabilities });
}
