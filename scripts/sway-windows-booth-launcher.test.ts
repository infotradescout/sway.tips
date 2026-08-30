import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildWindowsBoothLauncher } from '../src/server/windows-booth-launcher';
import { buildWindowsLibrarySyncLauncher } from '../src/server/windows-library-sync-launcher';

const gigId = '30000000-0000-4000-8000-000000000071';
const bridgeToken = "sway-room-token-with-a-'quote-and-enough-entropy";
const expiresAt = new Date(Date.now() + (6 * 60 * 60 * 1_000)).toISOString();
const launcher = buildWindowsBoothLauncher({
  swayUrl: 'https://app.sway.tips/',
  gigId,
  bridgeToken,
  expiresAt
});
const content = Buffer.from(launcher.contentBase64, 'base64');
const decoded = content.toString('utf8');

assert.equal(launcher.filename, 'sway-booth-30000000.cmd');
assert.equal(launcher.contentType, 'application/x-msdos-program');
assert.equal(launcher.expiresAt, expiresAt);
assert.equal(launcher.sha256, createHash('sha256').update(content).digest('hex'));
assert.ok(decoded.startsWith('@echo off\r\n'));
assert.ok(decoded.includes('powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass'));
assert.ok(decoded.includes('# SWAY_BOOTH_POWERSHELL\r\n'));
assert.ok(decoded.includes("$SwayUrl = 'https://app.sway.tips'"));
assert.ok(decoded.includes("$GigId = '30000000-0000-4000-8000-000000000071'"));
assert.ok(decoded.includes("$AuthToken = 'sway-room-token-with-a-''quote-and-enough-entropy'"));

for (const term of [
  '$VirtualDjUrl = "http://127.0.0.1:$port"',
  '[Net.SecurityProtocolType]::Tls12',
  'Local\\SwayBooth-$GigId',
  'Sway Booth is already open for this room.',
  '-AsSecureString',
  'ZeroFreeBSTR($passwordPointer)',
  "Invoke-VirtualDjRequest 'query' 'get_clock'",
  "Invoke-VirtualDjRequest 'execute' $Script",
  "'load' {",
  "'play' {",
  "'pause' {",
  "'stop' {",
  "'cue' {",
  "'next' {",
  "'previous' {",
  'exact_library_path',
  'virtualdj_search_first_result',
  "'/api/talent/playback/bridge/claim'",
  "'/api/talent/playback/bridge/complete'",
  "'/api/talent/playback/bridge/state'",
  "GetFolderPath('LocalApplicationData')",
  'booth-ledger-$GigId.json',
  'Leave this window open during the room.',
  'This room connection expired.'
]) {
  assert.ok(decoded.includes(term), `launcher missing ${term}`);
}

const persistOutcomeAt = decoded.indexOf('$Ledger[$commandId] = $entry\r\n        Save-Ledger');
const acknowledgeAt = decoded.indexOf('try { Complete-SwayCommand $commandId $entry }', persistOutcomeAt);
assert.ok(persistOutcomeAt > 0, 'launcher must persist each execution outcome');
assert.ok(acknowledgeAt > persistOutcomeAt, 'launcher must persist before cloud acknowledgement');
assert.ok(!decoded.includes('--allow-remote'));
assert.ok(!decoded.includes('0.0.0.0'));
assert.ok(!decoded.includes('multipart/form-data'));
assert.ok(!decoded.includes('SWAY_CONTROL_AUTH_COOKIE'));

assert.throws(
  () => buildWindowsBoothLauncher({ swayUrl: 'http://app.sway.tips', gigId, bridgeToken, expiresAt }),
  /requires HTTPS/
);
assert.throws(
  () => buildWindowsBoothLauncher({ swayUrl: 'https://app.sway.tips/untrusted-path', gigId, bridgeToken, expiresAt }),
  /invalid Sway origin/
);
assert.throws(
  () => buildWindowsBoothLauncher({ swayUrl: 'https://app.sway.tips', gigId: 'not-a-room', bridgeToken, expiresAt }),
  /valid live-room id/
);
assert.throws(
  () => buildWindowsBoothLauncher({ swayUrl: 'https://app.sway.tips', gigId, bridgeToken: `${bridgeToken}\r\nInjected`, expiresAt }),
  /valid room-scoped token/
);
assert.throws(
  () => buildWindowsBoothLauncher({
    swayUrl: 'https://app.sway.tips',
    gigId,
    bridgeToken,
    expiresAt: new Date(Date.now() + (8 * 60 * 60 * 1_000)).toISOString()
  }),
  /short-lived room connection/
);

const librarySyncKey = `sway_lib_${'ab'.repeat(24)}`;
const libraryLauncher = buildWindowsLibrarySyncLauncher({
  swayUrl: 'https://app.sway.tips/',
  sourceKey: 'main-booth-laptop',
  syncKey: librarySyncKey
});
const libraryContent = Buffer.from(libraryLauncher.contentBase64, 'base64');
const libraryDecoded = libraryContent.toString('utf8');
assert.equal(libraryLauncher.filename, 'sway-music-main-booth-laptop.cmd');
assert.equal(libraryLauncher.contentType, 'application/x-msdos-program');
assert.equal(libraryLauncher.sha256, createHash('sha256').update(libraryContent).digest('hex'));
for (const term of [
  '# SWAY_MUSIC_HELPER_POWERSHELL',
  'SWAY MUSIC HELPER',
  'Choose your latest DJ library export.',
  'System.Windows.Forms.OpenFileDialog',
  'x-sway-library-filename',
  'x-sway-library-key',
  '/api/library/import-file',
  'Your audio files stay on this computer.',
  "COULDN'T UPDATE YOUR MUSIC",
  'Nothing was removed. Check your connection or make a fresh helper in Sway.',
  'DONE - $count $trackReady ready in every room.',
  'Keep this helper. Double-click it again after your DJ library changes.'
]) {
  assert.ok(libraryDecoded.includes(term), `music helper missing ${term}`);
}
assert.ok(libraryDecoded.includes(`$SyncKey = '${librarySyncKey}'`));
assert.ok(!libraryDecoded.includes('/api/session'));
assert.ok(!libraryDecoded.includes('/api/talent/playback'));
assert.throws(
  () => buildWindowsLibrarySyncLauncher({ swayUrl: 'http://app.sway.tips', sourceKey: 'main-booth', syncKey: librarySyncKey }),
  /requires HTTPS/
);
assert.throws(
  () => buildWindowsLibrarySyncLauncher({ swayUrl: 'https://app.sway.tips/untrusted', sourceKey: 'main-booth', syncKey: librarySyncKey }),
  /invalid Sway origin/
);
assert.throws(
  () => buildWindowsLibrarySyncLauncher({ swayUrl: 'https://app.sway.tips', sourceKey: '../unsafe', syncKey: librarySyncKey }),
  /valid source id/
);
assert.throws(
  () => buildWindowsLibrarySyncLauncher({ swayUrl: 'https://app.sway.tips', sourceKey: 'main-booth', syncKey: `${librarySyncKey}\r\ninjected` }),
  /valid private sync key/
);

console.log('Sway Windows booth launcher tests passed.');
