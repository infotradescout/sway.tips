import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/performer-visibility-request.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }, reportDiagnostics: true });
assert.deepEqual(compiled.diagnostics, []);
const { requestPerformerVisibility, VisibilityRequestError, isVisibilityState } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`);
const results = [];
const run = async (name, check) => { await check(); results.push(name); console.log(`VISIBILITY_REQUEST_PASS ${name}`); };
const reply = (body, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const pending = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const start = (fetcher, options = {}) => requestPerformerVisibility({ signal: new AbortController().signal, timeoutMs: 30, fetcher, ...options });
const failure = kind => error => error instanceof VisibilityRequestError && error.kind === kind;

for (const value of ['draft', 'unlisted', 'public']) {
  await run(`read confirms explicit ${value}`, async () => {
    let init, url; assert.equal(await start(async (path, options) => { url = path; init = options; return reply({ profile: { visibilityState: value } }); }), value);
    assert.equal(url, '/api/talent/profile/public'); assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
    assert.equal(init.cache, 'no-store'); assert.equal(init.credentials, 'include'); assert.equal(init.redirect, 'error');
  });
  await run(`one explicit ${value} write sends only the choice`, async () => {
    const calls = [];
    assert.equal(await start(async (url, init) => { calls.push({ url, init }); return reply({ visibilityState: value }); }, { value }), value);
    assert.equal(calls.length, 1); assert.equal(calls[0].url, '/api/talent/profile/visibility'); assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].init.body), { visibilityState: value }); assert.equal(calls[0].init.redirect, 'error');
  });
}
for (const value of [null, undefined, 'hidden', '', [], {}, 1]) await run(`state parser rejects ${JSON.stringify(value)}`, async () => assert.equal(isVisibilityState(value), false));
for (const body of [{}, { profile: {} }, { profile: [] }, { profile: { visibilityState: 'unknown' } }, null, [], 'html']) {
  await run(`unreadable saved state is never Draft: ${JSON.stringify(body)}`, async () => await assert.rejects(start(async () => reply(body)), failure('unconfirmed')));
}
for (const body of [{}, { visibilityState: 'draft' }, { visibilityState: 'hidden' }, { success: false, visibilityState: 'public' }, { error: 'denied', visibilityState: 'public' }, null, []]) {
  await run(`invalid publication acknowledgement never succeeds: ${JSON.stringify(body)}`, async () => await assert.rejects(start(async () => reply(body), { value: 'public' }), failure('unconfirmed')));
}
for (const value of [undefined, 'public']) {
  for (const status of [401, 403]) await run(`${value === undefined ? 'read' : 'write'} ${status} rejects before a stalled body`, async () => {
    let bodies = 0;
    await assert.rejects(start(async () => ({ ...reply(null, status), json: () => { bodies++; return new Promise(() => {}); } }), { value }), failure('access'));
    assert.equal(bodies, 0);
  });
  await run(`${value === undefined ? 'read' : 'write'} bounds a transport that ignores abort`, async () => {
    let calls = 0, signal;
    await assert.rejects(start((_url, init) => { calls++; signal = init.signal; return new Promise(() => {}); }, { value }), failure('unconfirmed'));
    assert.equal(calls, 1); assert.equal(signal.aborted, true);
  });
  await run(`${value === undefined ? 'read' : 'write'} bounds a stalled JSON body`, async () => {
    await assert.rejects(start(async () => ({ ...reply(null), json: () => new Promise(() => {}) }), { value }), failure('unconfirmed'));
  });
  await run(`${value === undefined ? 'read' : 'write'} unreadable JSON is not a success`, async () => {
    await assert.rejects(start(async () => ({ ...reply(null), json: async () => { throw new SyntaxError(); } }), { value }), failure('unconfirmed'));
  });
}
for (const status of [500, 502, 503]) await run(`${status} never retries an uncertain publication`, async () => {
  let calls = 0; await assert.rejects(start(async () => { calls++; return reply({ error: 'Failed after commit.' }, status); }, { value: 'public' }), failure('unconfirmed'));
  assert.equal(calls, 1);
});
for (const status of [409, 422, 429]) await run(`${status} remains an explicit rejection`, async () => {
  let calls = 0; await assert.rejects(start(async () => { calls++; return reply({ error: 'Check the saved setting.' }, status); }, { value: 'public' }), failure('rejected'));
  assert.equal(calls, 1);
});
await run('network loss never repeats a publication', async () => {
  let calls = 0; await assert.rejects(start(async () => { calls++; throw new Error('offline'); }, { value: 'public' }), failure('unconfirmed')); assert.equal(calls, 1);
});
await run('already cancelled work never sends', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(start(async () => { calls++; return reply({}); }, { signal: controller.signal, value: 'public' }), failure('cancelled')); assert.equal(calls, 0);
});
await run('stop waiting settles without a retry or claim of undo', async () => {
  const controller = new AbortController(); let calls = 0, transport;
  const promise = start((_url, init) => { calls++; transport = init.signal; return new Promise(() => {}); }, { signal: controller.signal, value: 'public' });
  controller.abort(); await assert.rejects(promise, error => failure('cancelled')(error) && error.message.includes('may already have been saved'));
  assert.equal(calls, 1); assert.equal(transport.aborted, true);
});
await run('late headers after cancellation do not read or apply a body', async () => {
  const controller = new AbortController(), held = pending(); let bodies = 0;
  const promise = start(() => held.promise, { signal: controller.signal }); controller.abort(); await assert.rejects(promise, failure('cancelled'));
  held.resolve({ ...reply(null), json: async () => { bodies++; return { profile: { visibilityState: 'public' } }; } });
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(bodies, 0);
});
await run('late body after deadline cannot establish success', async () => {
  const held = pending(); let succeeded = false;
  const promise = start(async () => ({ ...reply(null), json: () => held.promise }), { value: 'public' }).then(() => { succeeded = true; });
  await assert.rejects(promise, failure('unconfirmed')); held.resolve({ visibilityState: 'public' });
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(succeeded, false);
});
for (const timeoutMs of [0, -1, NaN, Infinity]) await run(`invalid deadline ${timeoutMs} never sends`, async () => {
  let calls = 0; await assert.rejects(start(async () => { calls++; return reply({}); }, { timeoutMs }), /positive visibility deadline/); assert.equal(calls, 0);
});
await run('invalid requested state never sends', async () => {
  let calls = 0; await assert.rejects(start(async () => { calls++; return reply({}); }, { value: 'hidden' }), /Invalid visibility choice/); assert.equal(calls, 0);
});
await run('success cleans up the cancellation listener', async () => {
  const controller = new AbortController(); let added = 0, removed = 0;
  const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args) => { added++; add(...args); }; controller.signal.removeEventListener = (...args) => { removed++; remove(...args); };
  await start(async () => reply({ visibilityState: 'public' }), { signal: controller.signal, value: 'public' }); assert.equal(added, 1); assert.equal(removed, 1);
});
console.log(`VISIBILITY_REQUEST_SUMMARY ${results.length} PASS / 0 FAIL`);
