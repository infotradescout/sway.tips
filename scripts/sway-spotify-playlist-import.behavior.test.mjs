import assert from 'node:assert/strict';
import { importSpotifyPlaylistFromBrowser } from '../src/spotify-playlist-import.ts';
import { resolveSpotifyPlaylistId } from '../src/spotify-playlist-reference.ts';

const playlistId = '37i9dQZF1DXcBWIGoYBM5M';
const sourceKey = `spotify-${playlistId}`;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function fixture(overrides = {}) {
  const calls = [], statuses = [], messages = [];
  let refreshed = 0;
  const controller = new AbortController();
  const receipt = { success: true, playlistId, sourceKey, performerId: 'performer-a', importedCount: 137 };
  const options = {
    playlistUrl: `https://open.spotify.com/playlist/${playlistId}`, performerId: 'performer-a',
    previewMode: false, signal: controller.signal, isCurrent: () => true,
    onStatus: value => statuses.push(value), onMessage: value => messages.push(value),
    onSaved: async () => { refreshed++; return true; }, confirm: () => true,
    fetcher: async (url, init) => {
      calls.push({ url, init });
      return init?.method === 'POST' ? json(receipt, 202) : json({ performerId: 'performer-a', sources: [] });
    }, ...overrides
  };
  return { options, calls, statuses, messages, controller, receipt, get refreshed() { return refreshed; } };
}
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
await check('Only exact Spotify playlist references are accepted', async () => {
  for (const input of [playlistId, `spotify:playlist:${playlistId}`, `https://open.spotify.com/intl-en/playlist/${playlistId}?si=share`]) assert.equal(resolveSpotifyPlaylistId(input), playlistId);
  for (const input of [`https://evil.test/open.spotify.com/playlist/${playlistId}`, `https://open.spotify.com.evil.test/playlist/${playlistId}`, `http://open.spotify.com/playlist/${playlistId}`, `https://open.spotify.com/playlist/${playlistId}/other`, `https://user@open.spotify.com/playlist/${playlistId}`, `${playlistId}garbage`]) assert.equal(resolveSpotifyPlaylistId(input), null);
});
await check('Successful write carries owner identity and requires matching receipt', async () => {
  const f = fixture(); assert.equal(await importSpotifyPlaylistFromBrowser(f.options), true);
  assert.deepEqual(f.statuses, ['submitting', 'success']); assert.equal(f.calls.length, 2);
  assert.equal(JSON.parse(f.calls[1].init.body).performerId, 'performer-a');
  assert.equal(f.refreshed, 1); assert.match(f.messages.at(-1), /Saved 137 Spotify metadata tracks/);
});
await check('Replacement cancellation makes no write', async () => {
  let writes = 0;
  const f = fixture({ confirm: text => { assert.match(text, /Update “Friday”/); return false; }, fetcher: async (_url, init) => {
    if (init?.method) writes++;
    return json({ performerId: 'performer-a', sources: [{ id: 'source-a', sourceKey, sourceLabel: 'Friday', syncKeyPreview: 'spotify-import', updatedAt: '2026-09-13T00:00:00.000Z' }] });
  } });
  assert.equal(await importSpotifyPlaylistFromBrowser(f.options), false); assert.equal(writes, 0);
  assert.equal(f.statuses.at(-1), 'idle');
});
for (const [name, sources] of [['missing source list', {}], ['invalid source record', { sources: [{}] }], ['source identity collision', { sources: [{ sourceKey, sourceLabel: 'Synced deck', syncKeyPreview: 'sync' }] }]]) {
  await check(`${name} prevents replacement`, async () => {
    const calls = []; const f = fixture({ fetcher: async (_url, init) => { calls.push(init); return json({ performerId: 'performer-a', ...sources }); } });
    await importSpotifyPlaylistFromBrowser(f.options); assert.equal(calls.length, 1); assert.equal(f.statuses.at(-1), 'error'); assert.equal(f.refreshed, 0);
  });
}
await check('Replacement sends the exact observed source version', async () => {
  const f = fixture(); const original = f.options.fetcher;
  const expected = { id: 'source-a', updatedAt: '2026-09-13T00:00:00.000Z' };
  f.options.fetcher = async (url, init) => init?.method ? original(url, init) : json({
    performerId: 'performer-a', sources: [{ ...expected, sourceKey, sourceLabel: 'Friday', syncKeyPreview: 'spotify-import' }]
  });
  assert.equal(await importSpotifyPlaylistFromBrowser(f.options), true);
  assert.deepEqual(JSON.parse(f.calls[0].init.body).expectedSource, expected);
});
await check('Foreign source-list owner cannot authorize a write', async () => {
  let calls = 0; const f = fixture({ fetcher: async () => { calls++; return json({ performerId: 'performer-b', sources: [] }); } });
  await importSpotifyPlaylistFromBrowser(f.options); assert.equal(calls, 1); assert.equal(f.statuses.at(-1), 'error');
});
await check('Missing saved source version prevents replacement', async () => {
  const f = fixture({ fetcher: async () => json({ performerId: 'performer-a', sources: [{ sourceKey, sourceLabel: 'Friday', syncKeyPreview: 'spotify-import' }] }) });
  await importSpotifyPlaylistFromBrowser(f.options); assert.match(f.messages.at(-1), /version could not be confirmed/); assert.equal(f.refreshed, 0);
});
for (const [name, change] of [['foreign owner', { performerId: 'performer-b' }], ['different playlist', { playlistId: 'different' }], ['missing confirmation', { success: false }], ['empty saved import', { importedCount: 0 }], ['malformed count', { importedCount: '137' }]]) {
  await check(`${name} is never displayed as saved`, async () => {
    const f = fixture(); Object.assign(f.receipt, change);
    assert.equal(await importSpotifyPlaylistFromBrowser(f.options), false); assert.equal(f.refreshed, 0); assert.equal(f.statuses.at(-1), 'error');
  });
}
await check('Provider failure is retained and does not refresh or replay', async () => {
  const f = fixture(); const read = f.options.fetcher;
  f.options.fetcher = async (url, init) => init?.method ? json({ error: 'Spotify is rate limiting this import. Your saved source was not changed.' }, 429) : read(url, init);
  await importSpotifyPlaylistFromBrowser(f.options); assert.equal(f.refreshed, 0); assert.match(f.messages.at(-1), /rate limiting/);
});
await check('Lost POST response never retries automatically', async () => {
  let writes = 0; const f = fixture(); const read = f.options.fetcher;
  f.options.fetcher = async (url, init) => { if (init?.method) { writes++; throw new DOMException('Timed out', 'TimeoutError'); } return read(url, init); };
  await importSpotifyPlaylistFromBrowser(f.options); assert.equal(writes, 1); assert.match(f.messages.at(-1), /Refresh Sources before retrying/);
});
await check('Account change during preflight prevents POST', async () => {
  let current = true, writes = 0;
  const f = fixture({ isCurrent: () => current, fetcher: async (_url, init) => { if (init?.method) writes++; current = false; return json({ performerId: 'performer-a', sources: [] }); } });
  await importSpotifyPlaylistFromBrowser(f.options); assert.equal(writes, 0); assert.equal(f.refreshed, 0); assert(!f.statuses.includes('success'));
});
await check('Late response after account change cannot refresh or claim success', async () => {
  let current = true; const f = fixture({ isCurrent: () => current }); const original = f.options.fetcher;
  f.options.fetcher = async (url, init) => { const response = await original(url, init); if (init?.method) current = false; return response; };
  await importSpotifyPlaylistFromBrowser(f.options); assert.equal(f.refreshed, 0); assert(!f.statuses.includes('success'));
});
await check('Confirmed save survives a failed dashboard refresh', async () => {
  const f = fixture({ onSaved: async () => false }); assert.equal(await importSpotifyPlaylistFromBrowser(f.options), true);
  assert.equal(f.statuses.at(-1), 'success'); assert.match(f.messages.at(-1), /Saved 137.*could not refresh/);
});
await check('Preview and canceled lifetime do no work', async () => {
  for (const canceled of [false, true]) { const f = fixture({ previewMode: !canceled }); if (canceled) f.controller.abort(); await importSpotifyPlaylistFromBrowser(f.options); assert.equal(f.calls.length, 0); }
});
console.log(JSON.stringify({ passed, failed: 0, scope: 'Import workflow with provider-boundary responses; live Spotify acceptance remains separate.' }));
