import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const read = path => readFileSync(path, 'utf8');
const chooser = read('src/components/PerformerSourceImportChoices.tsx');
const wrapper = read('src/components/TalentDashboardWithSources.tsx');
const shell = read('src/shells/TalentApp.tsx');
const setup = read('src/components/PerformerSourcePlayerSetup.tsx');
assert(chooser.includes('<PerformerSourcePlayerSetup />'), 'Sources must mount the actual player setup.');
assert(shell.includes("import TalentDashboard from '../components/TalentDashboardWithSources'"), 'The real performer shell must supply context.');
for (const required of ['props.activeGigId === gigId', "props.session.status === 'active'", '!props.roomActionsBlocked', 'profile?.owner_user_id', 'onSelectRoom: props.onSelectGigId', '<TalentDashboard {...props} />']) assert(wrapper.includes(required), required);
for (const required of ['context.accountId, context.performerId, context.gigId, context.ready, context.previewMode', 'lifetime.current !== scope', 'request.current?.abort()', 'busyRef.current', 'confirmReplacement', 'SourcePlayerAccessError', 'Date.parse(download.expiresAt) <= Date.now()', 'player connection is not confirmed yet', '<PerformerPlaybackController']) assert(setup.includes(required), required);
for (const forbidden of ['localStorage', 'sessionStorage', 'document.cookie', "'/api/state'"]) assert(!setup.includes(forbidden), forbidden);
// Existing room commands and server permissions remain authoritative. These
// tests add proof of the setup flow, not provider or physical-device approval.
for (const args of [
  ['--import', 'tsx', 'scripts/sway-source-player-setup.behavior.test.ts'],
  ['scripts/sway-source-player-setup.browser.test.mjs']
]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', timeout: 300_000, shell: false });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.signal, null, 'Sources verification was interrupted.');
  assert.equal(result.status, 0, `Sources verification failed: ${args.join(' ')}`);
}
console.log('SOURCE_PLAYER_SETUP_CONTRACT_PASS');
