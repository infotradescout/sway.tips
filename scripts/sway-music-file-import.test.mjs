import assert from 'node:assert/strict';
import { importMusicFile, identifyMusicFileImport } from '../src/music-file-import.ts';
import { parseDjLibraryText } from '../src/dj-library-file-parser.ts';

let passed = 0;
async function check(name, test) { await test(); passed++; console.log('PASS ' + name); }
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function fixture(overrides = {}) {
  const calls = [], statuses = [], messages = [], confirmations = [];
  let saved = 0;
  const input = { files: [new File(['Title,Artist\nFirst,Artist'], 'first.csv')], value: 'selected', dataset: {} };
  const options = {
    input, previewMode: false, performerId: 'performer-a',
    onStatus: status => statuses.push(status), onMessage: message => messages.push(message),
    onSaved: async () => { saved++; },
    confirm: message => { confirmations.push(message); return true; },
    fetcher: async (url, init) => {
      calls.push({ url, init });
      if (!init?.method) return json({ sources: [] });
      const body = JSON.parse(init.body);
      return json({ success: true, performerId: 'performer-a', sourceKey: body.sourceKey, importedCount: body.tracks.length }, 202);
    }, ...overrides
  };
  return { options, calls, statuses, messages, confirmations, get saved() { return saved; } };
}
const parsed = parseDjLibraryText('a.csv', 'Title,Artist\nFirst,Artist');
await check('Two different CSV exports retain separate source identities', async () => {
  assert.notEqual((await identifyMusicFileImport('first.csv', parsed)).sourceKey, (await identifyMusicFileImport('second.csv', parsed)).sourceKey);
});
await check('Repeating the same export retains its source identity', async () => {
  assert.equal((await identifyMusicFileImport('first.csv', parsed)).sourceKey, (await identifyMusicFileImport('first.csv', parsed)).sourceKey);
});
await check('Same filename from different named services stays separate', async () => {
  assert.notEqual((await identifyMusicFileImport('list.csv', parsed, 'TIDAL')).sourceKey, (await identifyMusicFileImport('list.csv', parsed, 'Serato')).sourceKey);
});
await check('Private folder path never appears in saved label or identity', async () => {
  const r = await identifyMusicFileImport('C:\\private\\first.csv', parsed);
  assert(!JSON.stringify(r).includes('private')); assert.match(r.sourceKey, /^file-[a-f0-9]{48}$/);
});
await check('Duplicate rows removed before the server receives them', async () => {
  const r = await identifyMusicFileImport('a.csv', { ...parsed, tracks: [parsed.tracks[0], parsed.tracks[0]] });
  assert.equal(r.tracks.length, 1); assert.equal(r.duplicatesRemoved, 1);
});
await check('Successful import requires checked sources, consent and exact receipt', async () => {
  const f = fixture(); await importMusicFile(f.options);
  assert.deepEqual(f.statuses, ['submitting', 'success']); assert.equal(f.saved, 1);
  assert.equal(f.calls.length, 2); assert.match(f.confirmations[0], /Add 1 tracks/);
  assert.equal(f.options.input.value, ''); assert.match(f.messages.at(-1), /Saved 1 tracks/);
});
await check('Cancellation never posts or refreshes saved records', async () => {
  const f = fixture({ confirm: () => false }); await importMusicFile(f.options);
  assert.equal(f.calls.length, 1); assert.equal(f.saved, 0); assert.equal(f.statuses.at(-1), 'idle');
});
await check('Replacement names the existing source before consent', async () => {
  const identity = await identifyMusicFileImport('first.csv', parsed);
  const f = fixture(); const original = f.options.fetcher;
  f.options.fetcher = async (url, init) => !init?.method ? json({ sources: [{ ...identity, syncKeyPreview: 'file-import', sourceLabel: 'Saved Friday list' }] }) : original(url, init);
  await importMusicFile(f.options); assert.match(f.confirmations[0], /Replace the tracks in “Saved Friday list”/); assert.match(f.messages.at(-1), /Updated 1 tracks/);
});
await check('Synced-source collision is refused', async () => {
  const identity = await identifyMusicFileImport('first.csv', parsed);
  const f = fixture({ fetcher: async () => json({ sources: [{ ...identity, syncKeyPreview: 'secret-preview' }] }) });
  await importMusicFile(f.options); assert.equal(f.statuses.at(-1), 'error'); assert.equal(f.saved, 0); assert.equal(f.confirmations.length, 0);
});
await check('Malformed source response cannot authorize a write', async () => {
  const f = fixture({ fetcher: async () => json({}) }); await importMusicFile(f.options);
  assert.equal(f.statuses.at(-1), 'error'); assert.equal(f.confirmations.length, 0);
});
await check('Invalid song list makes no server request', async () => {
  const f = fixture(); f.options.input.files = [new File([''], 'empty.txt')]; await importMusicFile(f.options);
  assert.equal(f.calls.length, 0); assert.equal(f.statuses.at(-1), 'error');
});
for (const [name, receipt] of [
  ['Malformed success response', {}],
  ['Foreign performer receipt', { success: true, performerId: 'performer-b' }],
  ['Wrong imported count', { success: true, performerId: 'performer-a', importedCount: 0 }]
]) await check(name + ' is not shown as saved', async () => {
  const f = fixture(); const original = f.options.fetcher;
  f.options.fetcher = async (url, init) => {
    if (!init?.method) return original(url, init);
    const body = JSON.parse(init.body);
    return json({ sourceKey: body.sourceKey, importedCount: 1, ...receipt });
  };
  await importMusicFile(f.options); assert.equal(f.statuses.at(-1), 'error'); assert.equal(f.saved, 0);
});
await check('Account change before source check completes prevents POST', async () => {
  let current = true, writes = 0;
  const f = fixture({ isCurrent: () => current, fetcher: async (_url, init) => { if (init?.method) writes++; current = false; return json({ sources: [] }); } });
  await importMusicFile(f.options); assert.equal(writes, 0); assert.equal(f.saved, 0); assert(!f.statuses.includes('success'));
});
await check('Preview mode never imports', async () => {
  const f = fixture({ previewMode: true }); await importMusicFile(f.options); assert.equal(f.calls.length, 0); assert.equal(f.statuses.length, 0);
});
await check('Oversized list requires explicit truncation consent', async () => {
  const f = fixture({ confirm: message => { assert.match(message, /Only the first 1,000/); return false; } });
  f.options.input.files = [new File([Array.from({ length: 1001 }, (_, i) => `Song ${i}`).join('\n')], 'large.txt')];
  await importMusicFile(f.options); assert.equal(f.calls.length, 1); assert.equal(f.saved, 0);
});
await check('Refresh failure does not pretend committed save was lost', async () => {
  const f = fixture({ onSaved: async () => { throw new Error('refresh failed'); } });
  await importMusicFile(f.options); assert.equal(f.statuses.at(-1), 'success'); assert.match(f.messages.at(-1), /could not refresh/);
});
console.log(JSON.stringify({ passed, failed: 0, scope: 'Actual import helper with injected HTTP responses; browser/database proof is separate' }));
