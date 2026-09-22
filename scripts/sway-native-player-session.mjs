#!/usr/bin/env node
// Native-host JSON-lines interface for the shared multi-player engine. Not a
// cloud endpoint and not a substitute for signed-in Sway authorization.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { NativePlayerHub } from './lib/native-player-hub.mjs';
import { openNativePlayerStore } from './lib/native-player-store.mjs';

export function openConfiguredNativePlayerHub(configFile, journalFile) {
  const descriptor = fs.openSync(configFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let config;
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 65536 || (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) {
      throw new Error('Connection config must be a private regular file owned by this user.');
    }
    config = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
  } finally { fs.closeSync(descriptor); }
  const actorId = 'local-os-user:' + os.userInfo().username;
  const store = openNativePlayerStore({ filename: path.resolve(journalFile), actorId });
  try {
    const hub = new NativePlayerHub({ configs: config.connections, actorId, store });
    return { hub, store };
  } catch (error) { store.close(); throw error; }
}
export async function runNativePlayerSession({ configFile, journalFile, input = process.stdin, output = process.stdout }) {
  const { hub, store } = openConfiguredNativePlayerHub(configFile, journalFile);
  try {
    output.write(JSON.stringify({ type: 'connections', connections: hub.list(), commandSent: false }) + '\n');
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let request;
        try {
          if (Buffer.byteLength(line) > 8192) throw new Error('Native host request is too large.');
          request = JSON.parse(line);
          let result;
          switch (request.type) {
            case 'state': result = await hub.readState(request.connectionId, request.revision); break;
            case 'command': result = await hub.execute(request.connectionId, request); break;
            case 'reconnect': result = hub.reconnect(request.connectionId, request.revision); break;
            case 'review': result = hub.reviewUnknown(request.connectionId, request); break;
            default: throw new Error('Unsupported native host operation.');
          }
          output.write(JSON.stringify({ ok: true, result }) + '\n');
        } catch (error) {
          output.write(JSON.stringify({ ok: false, error: error.message }) + '\n');
        }
      }
    } finally { lines.close(); }
  } finally { store.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [configFile, journalFile, ...extra] = process.argv.slice(2);
  if (!configFile || !journalFile || extra.length) {
    console.error('Usage: node scripts/sway-native-player-session.mjs PRIVATE_CONFIG.json ABSOLUTE_JOURNAL.json'); process.exitCode = 2;
  } else {
    runNativePlayerSession({ configFile, journalFile }).catch(() => {
      // No credentials, endpoint paths or raw transport bodies enter startup output.
      console.error('Native player session could not start. Check private configuration and journal ownership.'); process.exitCode = 1;
    });
  }
}
