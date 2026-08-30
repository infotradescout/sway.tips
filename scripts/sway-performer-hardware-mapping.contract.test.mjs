import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const talentDashboard = readFileSync(join(root, 'src/components/TalentDashboard.tsx'), 'utf8');
const playbackController = readFileSync(join(root, 'src/components/PerformerPlaybackController.tsx'), 'utf8');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const failures = [];

for (const term of [
  "const HARDWARE_BINDING_STORAGE_KEY = 'sway.performer.hardwareBindings.v1'",
  "const HARDWARE_LISTENING_STORAGE_KEY = 'sway.performer.hardwareListening.v1'",
  "type HardwareActionId",
  "'toggle_requests'",
  "'fulfill_top'",
  "'hide_top'",
  "'approve_pending'",
  "'veto_pending'",
  "'open_top_source'",
  'data-sway-hardware-mapping-panel="true"',
  'data-sway-enable-hardware-controls="true"',
  'data-sway-hardware-controls-enabled="true"',
  'data-sway-performer-connections-workspace="true"',
  "if (!hardwareControlsActive && !hardwareLearnTarget) return;",
  'On for this room while this dashboard stays open.',
  "const hardwareControlsActive = roomHasControlContext && hardwareControlsEnabled;",
  "if (!roomHasControlContext && hardwareControlsEnabled)",
  'Open only if you use advanced booth controls.',
  'navigator as any).requestMIDIAccess',
  'resolveMidiBinding',
  "window.addEventListener('keydown'",
  'hardwareLearnTarget',
  'runHardwareAction',
  'onFulfill(topApproved.id)',
  "onTriage(topPending.id, 'approve')",
  "onTriage(topPending.id, 'deny')",
  'onHide(topApproved.id)',
  "window.open(topApproved.spotifyUrl, '_blank', 'noopener,noreferrer')",
  "'playback_load_top'",
  "'playback_play'",
  "window.dispatchEvent(new CustomEvent('sway:playback-action'",
  'window.localStorage.setItem(HARDWARE_BINDING_STORAGE_KEY',
  'window.localStorage.setItem(HARDWARE_LISTENING_STORAGE_KEY',
  'Booth connection',
  'onIssueBridgeToken'
]) {
  if (!talentDashboard.includes(term)) {
    failures.push(`Talent hardware mapping missing term: ${term}`);
  }
}

for (const term of [
  "window.addEventListener('sway:playback-action'",
  'sendPlaybackMidiAction',
  'MIDI · one-way'
]) {
  if (!playbackController.includes(term)) {
    failures.push(`Playback hardware mapping missing term: ${term}`);
  }
}

for (const forbidden of [
  'hardwareBindingsTable',
  'performer_hardware_bindings',
  'app.post("/api/talent/hardware',
  'automatically plays songs',
  'directly controls Spotify playback'
]) {
  if (talentDashboard.includes(forbidden)) {
    failures.push(`Hardware mapping must stay local/truthful in this slice: ${forbidden}`);
  }
}

for (const removedFailureMode of [
  'Keyboard and MIDI actions only listen while this panel is open.',
  'aria-label="Advanced key controls"'
]) {
  if (talentDashboard.includes(removedFailureMode)) {
    failures.push(`Hardware setup must not block or disable the live console: ${removedFailureMode}`);
  }
}

const testContracts = packageJson.scripts?.['test:contracts'] ?? '';
if (!testContracts.includes('node scripts/sway-performer-hardware-mapping.contract.test.mjs')) {
  failures.push('test:contracts must include the performer hardware mapping contract.');
}

if (failures.length) {
  console.error('Performer hardware mapping contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Performer hardware mapping contract passed.');
