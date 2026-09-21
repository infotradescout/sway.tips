#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { openConfiguredNativePlayerHub } from './sway-native-player-session.mjs';
import { startNativePlayerHost } from './lib/native-player-host.mjs';

const [configFile, journalFile, ...extra] = process.argv.slice(2);
if (!configFile || !journalFile || extra.length) {
  console.error('Usage: node scripts/sway-player-host.mjs PRIVATE_CONFIG.json ABSOLUTE_JOURNAL.json');
  process.exitCode = 2;
} else {
  let store;
  try {
    const configured = openConfiguredNativePlayerHub(configFile, journalFile); store = configured.store;
    const key = randomBytes(32).toString('base64url');
    const host = await startNativePlayerHost({ hub: configured.hub, token: key, expiresAt: Date.now() + 6 * 60 * 60 * 1000 });
    // This key is deliberately shown only to the computer's operator, never
    // copied to cloud logs, saved in browser storage, or placed in a URL.
    console.log(`Sway player host is listening only on 127.0.0.1:${host.port}.`);
    console.log('Open Sources in the Sway performer app, choose Link player computer, and enter this private key:');
    console.log(key);
    console.log('Keep this window open. Pairing expires in six hours. Connecting does not start playback.');
    let ending = false;
    const close = async () => {
      if (ending) return; ending = true;
      try { await host.close(); store.close(); } catch { process.exitCode = 1; }
    };
    process.once('SIGINT', close); process.once('SIGTERM', close);
  } catch {
    try { store?.close(); } catch { /* Preserve the startup failure. */ }
    console.error('Native player host could not start. Check private configuration, journal ownership and port availability.');
    process.exitCode = 1;
  }
}
