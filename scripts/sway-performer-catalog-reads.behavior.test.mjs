import assert from 'node:assert/strict';
import { createCatalogReader, parseCatalogProjects, parseCatalogFiles, parseCatalogStorage, readCatalogJson } from '../src/performer-catalog-reads.ts';
const wait = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const usage = { workspaceLimitBytes: 1000, workingBytes: 50, sealedWorkingBytes: 50, reservedBytes: 0,
  releaseProtectedBytes: 0, availableWorkspaceBytes: 950, workingObjectCount: 1, workingObjectLimit: 100, releaseCountLimit: null };
const projects = [{ id: 'A', title: 'Project A' }, { id: 'B', title: 'Project B' }];
const files = id => ({ assets: [{ id: `asset-${id}`, title: `Asset ${id}` }], versions: [{ id: `version-${id}`, assetId: `asset-${id}`,
  originalFilename: `${id}.wav`, versionNumber: 1, byteSize: 50, sha256: 'a'.repeat(64), mimeType: 'audio/wav' }] });
const results = [];
async function test(name, run) {
  try { await run(); results.push({ name, status: 'PASS' }); }
  catch (error) { results.push({ name, status: 'FAIL', error: String(error) }); process.exitCode = 1; }
  console.log('CATALOG_READ_RESULT', JSON.stringify(results.at(-1)));
}
function fixture() {
  const state = { projectResponse: response({ projects }), storageResponse: response({ storageUsage: usage }),
    fileResponses: { A: response(files('A')), B: response(files('B')) }, calls: [] };
  const reader = createCatalogReader(async (url, options) => {
    state.calls.push({ url, options });
    if (url.endsWith('/storage-usage')) return await state.storageResponse;
    if (url.endsWith('/projects')) return await state.projectResponse;
    const id = decodeURIComponent(url.split('/').at(-2));
    return await state.fileResponses[id];
  }, 100);
  reader.start();
  return { state, reader };
}
await test('projects and files load while storage is stalled', async () => {
  const { state, reader } = fixture();
  const pending = deferred(); state.storageResponse = pending.promise;
  await reader.refreshStorageUsage(); // The real bounded read must settle, not hang the suite.
  await wait();
  assert.equal(reader.getSnapshot().versions[0].id, 'version-A');
  assert.equal(reader.getSnapshot().storageState, 'error');
  reader.stop(); pending.resolve(response({ storageUsage: usage }));
});
await test('project switch clears rows before new response', async () => {
  const { state, reader } = fixture(); await wait();
  const pending = deferred(); state.fileResponses.B = pending.promise;
  reader.selectProject('B');
  assert.equal(reader.getSnapshot().projectId, 'B'); assert.deepEqual(reader.getSnapshot().versions, []);
  pending.resolve(response(files('B'))); await wait();
  assert.equal(reader.getSnapshot().versions[0].id, 'version-B'); reader.stop();
});
await test('A to B to A ignores both delayed previous reads', async () => {
  const { state, reader } = fixture(); await wait();
  const oldA = deferred(), oldB = deferred();
  state.fileResponses.A = oldA.promise; void reader.refreshAssets('A');
  state.fileResponses.B = oldB.promise; reader.selectProject('B');
  state.fileResponses.A = response(files('A-new')); reader.selectProject('A'); await wait();
  oldB.resolve(response(files('B'))); oldA.resolve(response(files('A-old'))); await wait();
  assert.equal(reader.getSnapshot().versions[0].id, 'version-A-new'); reader.stop();
});
for (const status of [404, 409, 429, 500, 503]) await test(`HTTP ${status} retains same-project rows as read-only`, async () => {
  const { state, reader } = fixture(); await wait(); state.fileResponses.A = response({}, status);
  await reader.refreshAssets('A');
  assert.equal(reader.getSnapshot().versions[0].id, 'version-A'); assert.equal(reader.getSnapshot().filesState, 'error'); reader.stop();
});
await test('malformed file response is not empty', async () => {
  const { state, reader } = fixture(); await wait(); state.fileResponses.A = response({ assets: [], versions: null });
  await reader.refreshAssets('A'); assert.equal(reader.getSnapshot().versions.length, 1); assert.equal(reader.getSnapshot().filesState, 'error'); reader.stop();
});
await test('failed project read preserves selection and rows', async () => {
  const { state, reader } = fixture(); await wait(); state.projectResponse = response({ projects: null });
  await reader.refreshProjects(); assert.equal(reader.getSnapshot().projectId, 'A'); assert.equal(reader.getSnapshot().versions.length, 1);
  assert.equal(reader.getSnapshot().projectsState, 'error'); reader.stop();
});
await test('confirmed empty project list clears previous files', async () => {
  const { state, reader } = fixture(); await wait(); state.projectResponse = response({ projects: [] });
  await reader.refreshProjects(); assert.equal(reader.getSnapshot().projectId, ''); assert.deepEqual(reader.getSnapshot().assets, []);
  assert.deepEqual(reader.getSnapshot().versions, []); reader.stop();
});
await test('manual new-project choice survives delayed list', async () => {
  const { state, reader } = fixture(); await wait(); const pending = deferred(); state.projectResponse = pending.promise;
  const work = reader.refreshProjects(); reader.selectProject(''); pending.resolve(response({ projects })); await work;
  assert.equal(reader.getSnapshot().projectId, ''); assert.deepEqual(reader.getSnapshot().versions, []); reader.stop();
});
await test('old list cannot erase confirmed newly created project', async () => {
  const { state, reader } = fixture(); await wait(); const pending = deferred(); state.projectResponse = pending.promise;
  const work = reader.refreshProjects(); state.fileResponses.C = response(files('C'));
  reader.acceptProject({ id: 'C', title: 'Created' }); pending.resolve(response({ projects })); await work; await wait();
  assert.equal(reader.getSnapshot().projectId, 'C'); assert.equal(reader.getSnapshot().versions[0].id, 'version-C'); reader.stop();
});
for (const status of [401, 403]) for (const channel of ['projects', 'files', 'storage']) await test(`${channel} ${status} clears private state and cancels other reads`, async () => {
  const { state, reader } = fixture(); await wait();
  if (channel === 'projects') { state.projectResponse = response({}, status); await reader.refreshProjects(); }
  if (channel === 'files') { state.fileResponses.A = response({}, status); await reader.refreshAssets('A'); }
  if (channel === 'storage') { state.storageResponse = response({}, status); await reader.refreshStorageUsage(); }
  const snapshot = reader.getSnapshot(); assert.equal(snapshot.accessDenied, true); assert.deepEqual(snapshot.projects, []);
  assert.deepEqual(snapshot.versions, []); assert.equal(snapshot.storageUsage, null); assert.equal(reader.isActive(), false); reader.stop();
});
await test('late storage success cannot repopulate revoked context; explicit reload recovers', async () => {
  const { state, reader } = fixture(); await wait(); const pending = deferred(); state.storageResponse = pending.promise;
  const work = reader.refreshStorageUsage(); state.fileResponses.A = response({}, 401); await reader.refreshAssets('A');
  pending.resolve(response({ storageUsage: usage })); await work;
  assert.equal(reader.getSnapshot().storageUsage, null);
  state.storageResponse = response({ storageUsage: usage }); state.fileResponses.A = response(files('A'));
  await reader.refreshAll(); await wait(); assert.equal(reader.getSnapshot().accessDenied, false);
  assert.equal(reader.getSnapshot().versions[0].id, 'version-A'); reader.stop();
});
await test('stop prevents completion and start works after strict lifecycle cleanup', async () => {
  const { state, reader } = fixture(); await wait(); const pending = deferred(); state.fileResponses.A = pending.promise;
  const work = reader.refreshAssets('A'); reader.stop(); pending.resolve(response(files('obsolete'))); await work;
  assert.equal(reader.getSnapshot().versions[0].id, 'version-A');
  state.fileResponses.A = response(files('fresh')); reader.start(); await wait();
  assert.equal(reader.getSnapshot().versions[0].id, 'version-fresh'); reader.stop();
});
await test('recovery sends GET reads only and rejects unlisted selection', async () => {
  const { state, reader } = fixture(); await wait(); const before = state.calls.length;
  reader.selectProject('not-listed'); assert.equal(state.calls.length, before);
  await reader.refreshAll(); await wait(); assert.ok(state.calls.every(call => !call.options.method || call.options.method === 'GET')); reader.stop();
});
await test('deadline includes stalled JSON body', async () => {
  const controller = new AbortController();
  await assert.rejects(readCatalogJson('/fixture', controller.signal, async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }), 15), /too long/);
});
await test('abort settles transport that ignores signal', async () => {
  const controller = new AbortController();
  const work = readCatalogJson('/fixture', controller.signal, async () => new Promise(() => {}), 1000);
  controller.abort(); await assert.rejects(work, /cancelled/);
});
for (const [name, value, parser] of [
  ['missing projects', {}, parseCatalogProjects], ['duplicate projects', { projects: [projects[0], projects[0]] }, parseCatalogProjects],
  ['missing versions', { assets: [] }, parseCatalogFiles], ['orphan version', { ...files('A'), assets: [] }, parseCatalogFiles],
  ['bad checksum', { ...files('A'), versions: [{ ...files('A').versions[0], sha256: null }] }, parseCatalogFiles],
  ['bad storage', { storageUsage: { ...usage, availableWorkspaceBytes: '950' } }, parseCatalogStorage],
  ['zero storage divisor', { storageUsage: { ...usage, workspaceLimitBytes: 0 } }, parseCatalogStorage]
]) await test(name, () => assert.throws(() => parser(value), /incomplete/));
console.log('CATALOG_READ_SUMMARY', JSON.stringify({ total: results.length, passed: results.filter(row => row.status === 'PASS').length, failed: results.filter(row => row.status === 'FAIL') }));
