import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/catalog-action-request.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  reportDiagnostics: true
});
assert.deepEqual(compiled.diagnostics, []);
const { requestCatalogAction, CatalogActionUnconfirmedError, CatalogActionAccessError } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`);
const results = [];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const response = (body, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const run = async (name, check) => {
  await check(); results.push(name); console.log(`CATALOG_ACTION_PASS ${name}`);
};
const start = (fetcher, options = {}, signal = new AbortController().signal, init = { method: 'POST' }) =>
  requestCatalogAction('/api/talent/audio/projects', init, signal, 'Action rejected.', { fetcher, timeoutMs: 30, ...options });

await run('successful write preserves body and never retries', async () => {
  const calls = []; const body = JSON.stringify({ title: 'Original title' });
  const value = await start(async (url, init) => { calls.push({ url, init }); return response({ project: { id: 'A' } }); }, {}, undefined, { method: 'POST', body });
  assert.equal(value.project.id, 'A'); assert.equal(calls.length, 1);
  assert.equal(calls[0].init.body, body); assert.equal(calls[0].init.method, 'POST'); assert.equal(calls[0].init.redirect, 'error');
});
await run('raw upload bytes are not converted', async () => {
  const body = new Blob([new Uint8Array([0, 10, 250, 255])]); let seen;
  await start(async (_url, init) => { seen = init; return response({ ok: true }); }, {}, undefined,
    { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body });
  assert.equal(seen.body, body); assert.equal(seen.headers['Content-Type'], 'application/octet-stream');
});
await run('transport deadline settles a fetch that ignores abort', async () => {
  let calls = 0, signal;
  await assert.rejects(start((_url, init) => { calls++; signal = init.signal; return new Promise(() => {}); }), CatalogActionUnconfirmedError);
  assert.equal(calls, 1); assert.equal(signal.aborted, true);
});
await run('body deadline covers stalled successful response body', async () => {
  let calls = 0;
  await assert.rejects(start(async () => { calls++; return { ...response(null), json: () => new Promise(() => {}) }; }), CatalogActionUnconfirmedError);
  assert.equal(calls, 1);
});
await run('body deadline covers stalled rejected response body', async () => {
  await assert.rejects(start(async () => ({ ...response(null, 422), json: () => new Promise(() => {}) })), CatalogActionUnconfirmedError);
});
await run('already cancelled action never sends', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(start(async () => { calls++; return response({ ok: true }); }, {}, controller.signal), CatalogActionUnconfirmedError);
  assert.equal(calls, 0);
});
await run('explicit stop aborts transport without another write', async () => {
  const controller = new AbortController(); let calls = 0, transport;
  const pending = start((_url, init) => { calls++; transport = init.signal; return new Promise(() => {}); }, {}, controller.signal);
  controller.abort(); await assert.rejects(pending, /Stopped waiting/);
  assert.equal(transport.aborted, true); assert.equal(calls, 1);
});
await run('late successful headers cannot complete a cancelled action', async () => {
  const controller = new AbortController(), held = deferred(); let bodies = 0;
  const pending = start(() => held.promise, {}, controller.signal); controller.abort();
  await assert.rejects(pending, CatalogActionUnconfirmedError);
  held.resolve({ ...response(null), json: async () => { bodies++; return { ok: true }; } });
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(bodies, 0);
});
await run('late access headers cannot revoke a newer view', async () => {
  const controller = new AbortController(), held = deferred(); let revocations = 0;
  const pending = start(() => held.promise, { onAccessDenied: () => revocations++ }, controller.signal); controller.abort();
  await assert.rejects(pending, CatalogActionUnconfirmedError); held.resolve(response({}, 403));
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(revocations, 0);
});
await run('late body cannot complete a timed-out action', async () => {
  const held = deferred(); const pending = start(async () => ({ ...response(null), json: () => held.promise }));
  await assert.rejects(pending, CatalogActionUnconfirmedError); held.resolve({ ok: true });
  await new Promise(resolve => setTimeout(resolve, 0));
});
for (const status of [401, 403]) await run(`${status} revokes at headers without reading body`, async () => {
  let bodies = 0, revocations = 0;
  await assert.rejects(start(async () => ({ ...response(null, status), json: () => { bodies++; return new Promise(() => {}); } }),
    { onAccessDenied: () => revocations++ }), CatalogActionAccessError);
  assert.equal(revocations, 1); assert.equal(bodies, 0);
});
for (const status of [500, 502, 503]) await run(`${status} leaves result unconfirmed and does not retry`, async () => {
  let calls = 0;
  await assert.rejects(start(async () => { calls++; return response({ error: 'Server failed after accepting request.' }, status); }), CatalogActionUnconfirmedError);
  assert.equal(calls, 1);
});
await run('network loss remains an unknown result', async () => {
  let calls = 0;
  await assert.rejects(start(async () => { calls++; throw new Error('offline'); }), CatalogActionUnconfirmedError); assert.equal(calls, 1);
});
await run('validation rejection preserves useful server message', async () => {
  await assert.rejects(start(async () => response({ error: 'Enter a title.' }, 422)), error => error.message === 'Enter a title.' && !(error instanceof CatalogActionUnconfirmedError));
});
await run('safe fallback handles a rejection without message', async () => {
  await assert.rejects(start(async () => response({}, 409)), /Action rejected/);
});
for (const body of [null, [], 'wrong', 42, false]) await run(`malformed success ${JSON.stringify(body)} is not accepted`, async () => {
  await assert.rejects(start(async () => response(body)), CatalogActionUnconfirmedError);
});
await run('unreadable response is not success', async () => {
  await assert.rejects(start(async () => ({ ...response(null), json: async () => { throw new SyntaxError('bad json'); } })), CatalogActionUnconfirmedError);
});
for (const timeoutMs of [0, -1, NaN, Infinity]) await run(`invalid deadline ${String(timeoutMs)} never sends`, async () => {
  let calls = 0;
  await assert.rejects(start(async () => { calls++; return response({}); }, { timeoutMs }), /positive Catalog action deadline/); assert.equal(calls, 0);
});
await run('finished action removes cancellation callback', async () => {
  const controller = new AbortController(); let added = 0, removed = 0;
  const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args) => { added++; add(...args); };
  controller.signal.removeEventListener = (...args) => { removed++; remove(...args); };
  await start(async () => response({ ok: true }), {}, controller.signal);
  assert.equal(added, 1); assert.equal(removed, 1); controller.abort();
});
console.log(`CATALOG_ACTION_SUMMARY ${results.length} PASS / 0 FAIL`);
