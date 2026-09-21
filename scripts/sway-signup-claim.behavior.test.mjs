import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';

// Actual AccountSignup and installed React, with synthetic HTTP in JSDOM.
// This proves response ownership and submission, not browser layout or account authorization.
const bundle = await build({
  stdin: { contents: `import React,{act} from 'react';
    import {createRoot} from 'react-dom/client';
    import {AccountSignup} from './src/components/AccountAccess.tsx';
    window.IS_REACT_ACT_ENVIRONMENT=true;
    window.__act=act;
    window.__reads=[];
    window.fetch=(url,options={})=>new Promise((resolve,reject)=>window.__reads.push({url,options,resolve,reject}));
    window.__root=createRoot(document.getElementById('root'));
    window.__mount=()=>act(async()=>window.__root.render(React.createElement(AccountSignup)));`,
    resolveDir: process.cwd(), sourcefile: 'signup-claim-proof.js', loader: 'js' },
  bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: process.env.SWAY_SIGNUP_BASELINE_REF ? [{ name: 'signup-baseline', setup(builder) {
    builder.onLoad({ filter: /src\/components\/AccountAccess\.tsx$/ }, () => ({
      contents: execFileSync('git', ['show', `${process.env.SWAY_SIGNUP_BASELINE_REF}:src/components/AccountAccess.tsx`], { encoding: 'utf8' }),
      loader: 'tsx'
    }));
  } }] : []
});

async function fixture(search = '') {
  const dom = new JSDOM('<div id="root"></div>', { url: `https://sway.test/account/signup${search}`, runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
  const w = dom.window;
  const channels = [];
  w.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this); } };
  w.eval(bundle.outputFiles[0].text);
  await w.__mount();
  const step = async fn => w.__act(async () => { fn(); await Promise.resolve(); });
  const input = name => w.document.querySelector(`[name="${name}"]`);
  const fill = (name, value) => step(() => {
    Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value').set.call(input(name), value);
    input(name).dispatchEvent(new w.Event('input', { bubbles: true }));
  });
  const blur = () => step(() => input('claimCode').dispatchEvent(new w.FocusEvent('focusout', { bubbles: true })));
  const lookups = () => w.__reads.filter(read => read.url === '/api/account/claim/peek');
  const signups = () => w.__reads.filter(read => read.url === '/api/account/signup');
  const answer = (read, body, status = 200) => step(() => read.resolve({ ok: status < 400, status, json: async () => body }));
  const ready = async () => {
    await fill('name', 'Synthetic Account'); await fill('email', 'synthetic@example.test');
    await fill('new-password', 'Synthetic123'); await fill('confirm-password', 'Synthetic123');
    await step(() => w.document.querySelector('[type="checkbox"]').click());
  };
  const submit = () => step(() => w.document.querySelector('form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })));
  const close = async () => { await step(() => w.__root.unmount()); dom.window.close(); for (const channel of channels) { channel.port1.close(); channel.port2.close(); } };
  return { w, step, input, fill, blur, lookups, signups, answer, ready, submit, close };
}

const results = [];
async function test(name, run, search) {
  const f = await fixture(search);
  try { await run(f); results.push({ name, status: 'PASS' }); }
  catch (error) { results.push({ name, status: 'FAIL', error: error.message }); }
  finally { await f.close(); console.log(results.at(-1)); }
}

for (const replacement of ['', 'second-code']) for (const status of [200, 400, 503]) {
  await test(`edited-code-ignores-${status}-${replacement || 'cleared'}`, async f => {
    await f.fill('claimCode', 'first-code'); await f.blur();
    assert.equal(f.lookups().length, 1);
    await f.fill('claimCode', replacement);
    await f.answer(f.lookups()[0], status === 200 ? { displayName: 'Previous Performer' } : { error: 'Previous code rejected' }, status);
    assert.equal(f.input('claimCode').value, replacement);
    assert.doesNotMatch(f.w.document.body.textContent, /Previous Performer|Previous code rejected/);
    assert.equal(f.input('claimCode').getAttribute('aria-busy'), 'false');
  });
}
await test('newer-code-wins-out-of-order-lookups', async f => {
  await f.fill('claimCode', 'first-code'); await f.blur();
  await f.fill('claimCode', 'second-code'); await f.blur();
  await f.answer(f.lookups()[1], { displayName: 'Current Performer' });
  await f.answer(f.lookups()[0], { displayName: 'Previous Performer' });
  assert.match(f.w.document.body.textContent, /Performer profile found: Current Performer/);
  assert.doesNotMatch(f.w.document.body.textContent, /Previous Performer/);
});
await test('submit-validates-current-code-once', async f => {
  await f.ready(); await f.fill('claimCode', 'current-code'); await f.submit();
  assert.equal(f.lookups().length, 1); assert.equal(f.signups().length, 0);
  await f.answer(f.lookups()[0], { displayName: 'Current Performer' });
  assert.equal(f.lookups().length, 1, 'Do not issue a redundant submit lookup');
  assert.equal(f.signups().length, 1);
  assert.equal(JSON.parse(f.signups()[0].options.body).claimCode, 'current-code');
  await f.answer(f.signups()[0], { message: 'Synthetic signup accepted' });
});
await test('failed-submit-lookup-never-creates-account', async f => {
  await f.ready(); await f.fill('claimCode', 'invalid-code'); await f.submit();
  await f.answer(f.lookups()[0], { error: 'Code rejected' }, 400);
  assert.equal(f.lookups().length, 1, 'A rejected check must not be retried silently');
  assert.equal(f.signups().length, 0);
  assert.match(f.w.document.body.textContent, /Code rejected/);
  assert.equal(f.input('claimCode').getAttribute('aria-invalid'), 'true');
  await f.submit();
  assert.equal(f.lookups().length, 1, 'Repeated submit does not recheck a definitively rejected claim');
  assert.equal(f.signups().length, 0);
});
for (const status of [408, 429, 500, 503, 599, 'network']) {
  await test(`explicit-submit-retries-temporary-failure-${status}`, async f => {
    await f.ready(); await f.fill('claimCode', 'current-code'); await f.blur(); await f.submit();
    assert.equal(f.lookups().length, 1);
    if (status === 'network') await f.step(() => f.lookups()[0].reject(new f.w.TypeError('Claim check unavailable')));
    else await f.answer(f.lookups()[0], { error: 'Claim check unavailable' }, status);
    assert.equal(f.lookups().length, 1, 'Never retry automatically');
    assert.equal(f.signups().length, 0);
    assert.equal(f.input('claimCode').disabled, false);
    assert.equal(f.input('claimCode').getAttribute('aria-invalid'), 'false');
    assert.match(f.w.document.body.textContent, /Claim check unavailable/);
    await f.submit();
    assert.equal(f.lookups().length, 2, 'Explicit submit retries without an edit or blur');
    assert.equal(f.signups().length, 0);
    await f.answer(f.lookups()[1], { displayName: 'Current Performer' });
    assert.equal(f.signups().length, 1);
    assert.equal(JSON.parse(f.signups()[0].options.body).claimCode, 'current-code');
    await f.answer(f.signups()[0], { message: 'Synthetic signup accepted' });
  });
}
for (const replacement of ['', 'replacement-code']) {
  await test(`superseded-submit-stops-${replacement || 'cleared'}`, async f => {
    await f.ready(); await f.fill('claimCode', 'first-code'); await f.submit();
    assert.equal(f.input('claimCode').disabled, true, 'Ordinary editing is locked during submission');
    // Force a programmatic edit despite disabled UI to test stale async work.
    await f.fill('claimCode', replacement);
    await f.answer(f.lookups()[0], { displayName: 'Previous Performer' });
    assert.equal(f.signups().length, 0, 'Superseded submission must stop before account creation');
    assert.equal(f.input('claimCode').value, replacement);
    assert.equal(f.input('claimCode').disabled, false, 'Superseded submission must release the pending state');
    assert.doesNotMatch(f.w.document.body.textContent, /Previous Performer/);
  });
}
await test('previous-valid-code-does-not-validate-new-submit', async f => {
  await f.ready(); await f.fill('claimCode', 'first-code'); await f.blur();
  await f.answer(f.lookups()[0], { displayName: 'Previous Performer' });
  await f.fill('claimCode', 'second-code'); await f.blur();
  await f.submit();
  assert.equal(f.signups().length, 0);
  assert.equal(f.lookups().length, 2, 'Submit waits for the current code check without duplicating it');
  assert.doesNotMatch(f.w.document.body.textContent, /Previous Performer/);
  await f.answer(f.lookups()[1], { displayName: 'Current Performer' });
  assert.equal(f.signups().length, 1);
  assert.equal(JSON.parse(f.signups()[0].options.body).claimCode, 'second-code');
  await f.answer(f.signups()[0], { message: 'Synthetic signup accepted' });
});
for (const status of [200, 400]) {
  await test(`returning-to-same-code-ignores-old-${status}`, async f => {
    await f.ready(); await f.fill('claimCode', 'first-code'); await f.blur();
    await f.fill('claimCode', 'second-code');
    await f.fill('claimCode', 'first-code'); await f.blur(); await f.submit();
    assert.equal(f.lookups().length, 2, 'Editing away and back requires a fresh check');
    await f.answer(f.lookups()[0], status === 200 ? { displayName: 'Previous Performer' } : { error: 'Previous code rejected' }, status);
    assert.equal(f.signups().length, 0, 'An old check for the same string cannot authorize the new submission');
    assert.doesNotMatch(f.w.document.body.textContent, /Previous Performer|Previous code rejected/);
    await f.answer(f.lookups()[1], { displayName: 'Current Performer' });
    assert.equal(f.signups().length, 1);
    await f.answer(f.signups()[0], { message: 'Synthetic signup accepted' });
  });
}
await test('failed-blur-check-stops-waiting-submit', async f => {
  await f.ready(); await f.fill('claimCode', 'invalid-code'); await f.blur(); await f.submit();
  assert.equal(f.lookups().length, 1);
  await f.answer(f.lookups()[0], { error: 'Code rejected' }, 400);
  assert.equal(f.signups().length, 0);
  assert.equal(f.input('claimCode').disabled, false, 'A failed shared check releases submission');
  assert.match(f.w.document.body.textContent, /Code rejected/);
});
await test('cleared-prefilled-code-ignores-initial-lookup', async f => {
  assert.equal(f.lookups().length, 1);
  await f.fill('claimCode', '');
  await f.answer(f.lookups()[0], { displayName: 'Previous Performer' });
  assert.doesNotMatch(f.w.document.body.textContent, /Previous Performer/);
}, '?claim=initial-code');
console.log(`Signup claim component proof: ${results.filter(result => result.status === 'PASS').length}/${results.length} passed; synthetic HTTP and JSDOM.`);
process.exitCode = results.some(result => result.status === 'FAIL') ? 1 : 0;
