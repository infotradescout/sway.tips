import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

// Actual restart and setup components, repository-locked React/ReactDOM.
// Only the visual recap is replaced. HTTP, room creation and DOM are fixtures.
// This suite is not browser/layout, durable-room or payment-provider evidence.
const outfile = resolve(`.sway-room-restart-${randomUUID()}.cjs`);
await build({
  entryPoints: [resolve('src/components/PerformerRoomRestart.tsx')],
  outfile, bundle: true, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic',
  plugins: [{ name: 'recap-fixture', setup(builder) {
    builder.onResolve({ filter: /\/VictoryScreen$/ }, () => ({ path: 'recap', namespace: 'fixture' }));
    builder.onResolve({ filter: /^react(?:\/.*)?$/, namespace: 'fixture' }, args => ({ path: args.path, external: true }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'jsx', resolveDir: process.cwd(), contents: `
      import React from 'react';
      export default function Recap({session,onRestart}) {
        return <section data-recap="true"><h1>Night recap</h1><p>{session.totals.totalTips}</p><button onClick={onRestart}>Start New Room</button></section>;
      }` }));
  } }]
});
const require = createRequire(import.meta.url);
const Restart = require(outfile).default;
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://sway.example.test/talent' });
const previous = new Map();
for (const [name, value] of Object.entries({
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent,
  IS_REACT_ACT_ENVIRONMENT: true
})) {
  previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
const originalFetch = globalThis.fetch;
let passed = 0;
let failed = 0;
const defaultConfig = { mode: 'test', liveRoomMoneyEnabled: true, testModePlatformBalanceEnabled: false };
const profile = { money_actions_ready: false, test_mode_platform_balance_allowed: false };

function visible(element) { return !element.closest('[hidden]'); }
function button(host, name) {
  const result = [...host.querySelectorAll('button')].find((element) => visible(element) && element.textContent.trim() === name);
  assert.ok(result, `Missing visible button: ${name}`);
  return result;
}
async function click(host, name) {
  const element = button(host, name);
  assert.equal(element.matches(':disabled'), false, `${name} unexpectedly disabled`);
  await act(async () => { element.click(); });
}
async function ready(fixture) {
  await click(fixture.host, 'Start New Room');
  for (let i = 0; i < 3; i += 1) await click(fixture.host, 'Next');
}
async function makeFixture(overrides = {}, options = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let config = options.config ?? defaultConfig;
  let configStatus = options.configStatus ?? 200;
  const requests = [];
  const starts = [];
  let startImpl = options.start ?? (async () => {});
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    assert.equal(url, '/api/payment/config');
    assert.equal(init.cache, 'no-store');
    assert.ok(init.signal);
    if (config instanceof Error) throw config;
    return { ok: configStatus === 200, status: configStatus, json: async () => config };
  };
  let props = {
    session: { status: 'closed', talentName: 'Old room name', talentRole: 'Performer', totals: { totalTips: 123 } },
    requests: [], performerName: 'EdgeWize', performerEmailVerified: true,
    performerProfile: profile, previewMode: false, roomActionsBlocked: false,
    onStartSession: async (data) => { starts.push(structuredClone(data)); await startImpl(data); },
    ...overrides
  };
  const render = async () => { await act(async () => { root.render(React.createElement(React.StrictMode, null, React.createElement(Restart, props))); }); };
  await render();
  return {
    host, requests, starts,
    setConfig(value, status = 200) { config = value; configStatus = status; },
    setStart(value) { startImpl = value; },
    async update(value) { props = { ...props, ...value }; await render(); },
    async dispose() { await act(async () => { root.unmount(); }); host.remove(); }
  };
}
async function test(name, fn) {
  let fixture;
  try {
    await fn(async (...args) => { fixture = await makeFixture(...args); return fixture; });
    passed += 1;
    console.log(`PASS restart: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL restart: ${name}`, error);
  } finally {
    if (fixture) await fixture.dispose();
  }
}

try {
  await test('recap does not read configuration or create a room', async (make) => {
    const f = await make();
    assert.match(f.host.textContent, /Night recap/);
    assert.equal(f.requests.length, 0);
    assert.equal(f.starts.length, 0);
  });
  await test('restart opens setup with the actual name and no write', async (make) => {
    const f = await make();
    await click(f.host, 'Start New Room');
    assert.match(f.host.querySelector('[data-sway-performer-room-setup]').textContent, /EdgeWize/);
    assert.equal(f.starts.length, 0);
    assert.equal(f.host.querySelector('[data-recap]').closest('[hidden]') !== null, true);
  });
  await test('returning to recap preserves the chosen request source and review step', async (make) => {
    const f = await make();
    await click(f.host, 'Start New Room');
    await click(f.host, 'Next');
    const open = [...f.host.querySelectorAll('button')].find((el) => el.textContent.startsWith('Open requests'));
    await act(async () => { open.click(); });
    await click(f.host, 'Next');
    const before = f.host.querySelector('[data-sway-performer-room-setup]').textContent;
    await click(f.host, 'Back to night recap');
    assert.equal(visible(f.host.querySelector('[data-recap]')), true);
    assert.match(f.host.querySelector('[data-recap]').textContent, /123/);
    await click(f.host, 'Start New Room');
    assert.equal(f.host.querySelector('[data-sway-performer-room-setup]').textContent, before);
    assert.equal(f.starts.length, 0);
  });
  await test('creation uses the reviewed performer name and role', async (make) => {
    const f = await make();
    await ready(f);
    await click(f.host, 'Create room');
    assert.equal(f.starts.length, 1);
    assert.equal(f.starts[0].talentName, 'EdgeWize');
    assert.equal(f.starts[0].talentRole, 'Performer');
    assert.equal(f.starts[0].paymentsEnabled, false);
    assert.match(f.starts[0].gig_id, /^[a-f0-9-]{36}$/);
  });
  await test('failed start is visible and explicit retry uses the same room id', async (make) => {
    const f = await make({}, { start: async () => { throw new Error('Start rejected for this fixture'); } });
    await ready(f);
    await click(f.host, 'Create room');
    assert.match(f.host.querySelector('[data-sway-performer-room-setup] [role="alert"]').textContent, /Start rejected/);
    f.setStart(async () => {});
    await click(f.host, 'Create room');
    assert.equal(f.starts.length, 2);
    assert.deepEqual(f.starts[0], f.starts[1]);
    assert.match(f.host.querySelector('[data-recap]').textContent, /123/);
  });
  await test('same-tick double click sends one start and blocks leaving while pending', async (make) => {
    let release;
    const pending = new Promise((resolvePending) => { release = resolvePending; });
    const f = await make({}, { start: () => pending });
    await ready(f);
    const create = button(f.host, 'Create room');
    await act(async () => { create.click(); create.click(); });
    assert.equal(f.starts.length, 1);
    assert.equal(button(f.host, 'Back to night recap').matches(':disabled'), true);
    assert.equal(button(f.host, 'Creating room…').matches(':disabled'), true);
    assert.equal(button(f.host, 'Creating room…').getAttribute('aria-busy'), 'true');
    await act(async () => { release(); await pending; });
    assert.equal(button(f.host, 'Back to night recap').matches(':disabled'), false);
  });
  for (const [name, overrides] of [
    ['preview', { previewMode: true }],
    ['disconnected account', { roomActionsBlocked: true }],
    ['missing profile', { performerProfile: null }]
  ]) {
    await test(`${name} cannot submit a new room`, async (make) => {
      const f = await make(overrides);
      await click(f.host, 'Start New Room');
      assert.equal(button(f.host, 'Next').matches(':disabled'), true);
      assert.equal(f.starts.length, 0);
      if (name === 'preview') assert.equal(f.requests.length, 0);
    });
  }
  await test('unverified email cannot create a room', async (make) => {
    const f = await make({ performerEmailVerified: false });
    await ready(f);
    assert.equal(button(f.host, 'Create room').matches(':disabled'), true);
    assert.equal(f.starts.length, 0);
  });
  await test('config failure exposes a read-only retry and keeps paid requests off', async (make) => {
    const f = await make({}, { config: new Error('offline') });
    await click(f.host, 'Start New Room');
    assert.match(f.host.textContent, /Payment availability could not be checked/);
    const paid = [...f.host.querySelectorAll('button')].find((el) => el.textContent.startsWith('Test paid requests'));
    assert.equal(paid.matches(':disabled'), true);
    f.setConfig(defaultConfig);
    await click(f.host, 'Retry payment availability');
    assert.equal(f.host.textContent.includes('Payment availability could not be checked'), false);
    assert.equal(f.starts.length, 0);
  });
  await test('server-disabled money cannot be enabled by an otherwise ready profile', async (make) => {
    const f = await make({ performerProfile: { ...profile, money_actions_ready: true } }, { config: { ...defaultConfig, liveRoomMoneyEnabled: false } });
    await click(f.host, 'Start New Room');
    const paid = [...f.host.querySelectorAll('button')].find((el) => el.textContent.startsWith('Test paid requests'));
    assert.equal(paid.matches(':disabled'), true);
  });
  await test('test balance requires both server enablement and performer permission', async (make) => {
    const f = await make({ performerProfile: { ...profile, test_mode_platform_balance_allowed: true } }, { config: { ...defaultConfig, testModePlatformBalanceEnabled: true } });
    await click(f.host, 'Start New Room');
    const paid = [...f.host.querySelectorAll('button')].find((el) => el.textContent.startsWith('Test paid requests'));
    assert.equal(paid.matches(':disabled'), false);
    await f.update({ performerProfile: profile });
    assert.equal(paid.matches(':disabled'), true);
  });
  await test('test balance permission never unlocks live money', async (make) => {
    const f = await make({ performerProfile: { ...profile, test_mode_platform_balance_allowed: true } }, { config: { mode: 'live', liveRoomMoneyEnabled: true, testModePlatformBalanceEnabled: true } });
    await click(f.host, 'Start New Room');
    const paid = [...f.host.querySelectorAll('button')].find((el) => el.textContent.startsWith('Paid requests'));
    assert.equal(paid.matches(':disabled'), true);
  });
  await test('lost paid eligibility blocks a previously selected paid submission', async (make) => {
    const f = await make({ performerProfile: { ...profile, money_actions_ready: true } });
    await click(f.host, 'Start New Room');
    const paid = [...f.host.querySelectorAll('button')].find((el) => el.textContent.startsWith('Test paid requests'));
    await act(async () => { paid.click(); });
    for (let i = 0; i < 3; i += 1) await click(f.host, 'Next');
    await f.update({ performerProfile: profile });
    await click(f.host, 'Create room');
    assert.equal(f.starts.length, 0);
    assert.match(f.host.querySelector('[data-sway-performer-room-setup] [role="alert"]').textContent, /Paid requests are (?:not|no longer) available/);
  });
  await test('shell reuses its guarded start and keys setup to the account and room', async () => {
    const source = readFileSync(resolve('src/shells/TalentApp.tsx'), 'utf8');
    assert.equal(source.includes('resetInactiveSession'), false);
    assert.match(source, /<PerformerRoomRestart[\s\S]*?key=\{JSON\.stringify\(\[performerIdentity, selectedRoomRoute\]\)\}/);
    const block = source.slice(source.indexOf('<PerformerRoomRestart'), source.indexOf('/>', source.indexOf('<PerformerRoomRestart')));
    assert.match(block, /onStartSession=\{handleStartSession\}/);
    assert.match(block, /performerName=\{performerIdentityName\}/);
    assert.match(block, /roomActionsBlocked=\{restartBlocked\}/);
    assert.match(source, /const restartBlocked = roomActionsBlocked && roomLookup\.status !== 'ended'/);
  });
} finally {
  globalThis.fetch = originalFetch;
  dom.window.close();
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
  rmSync(outfile, { force: true });
}
console.log(`ROOM_RESTART_TOTAL ${passed + failed} PASS ${passed} FAIL ${failed}`);
if (failed) process.exitCode = 1;
