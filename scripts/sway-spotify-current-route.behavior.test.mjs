import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { SpotifyPlaylistSourceConflict } from '../src/server/spotify-playlist-store.ts';
import { importSpotifyPlaylist } from '../src/server/spotify-catalog.ts';

// Exercise the actual current route body, not a hand-written copy. Provider
// responses, access resolution and persistence are synthetic boundaries here;
// this does not claim authenticated HTTP or real-database integration proof.
const source = ts.createSourceFile('server.ts', readFileSync('server.ts', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const candidates = [];
function visit(node) {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && node.expression.expression.getText(source) === 'app' && node.expression.name.text === 'post'
    && ts.isStringLiteral(node.arguments[0])
    && node.arguments[0].text === '/api/talent/music/spotify/import-playlist') candidates.push(node.arguments.at(-1));
  ts.forEachChild(node, visit);
}
visit(source);
assert.equal(candidates.length, 1, 'The actual Spotify import route must be uniquely identified.');
const callback = ts.transpileModule(`const handler = ${candidates[0].getText(source)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText;
const playlistId = '37i9dQZF1DXcBWIGoYBM5M';
const firstId = '4uLU6hMCjMI75M1A2tKUQC';
const secondId = '7qiZfU4dY1lWllzX7mPBI3';
const endpoint = `https://api.spotify.com/v1/playlists/${playlistId}`;
const next = `${endpoint}/tracks?offset=1&limit=100`;
const track = (id = firstId) => ({ id, name: 'Test song', type: 'track', artists: [{ name: 'Synthetic artist' }] });
const page = (items, total = items.length, offset = 0, nextUrl = null) => ({ items, total, offset, next: nextUrl });
const metadata = (paging) => ({ id: playlistId, name: 'Synthetic playlist', snapshot_id: 'version-one', tracks: paging });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
let sequence = 0;

async function exercise(responses, { allowed = true, owner = true, reference = playlistId, expectedStatus = 422, expectedTracks = null, performerId = 'synthetic-performer', conflict = null } = {}) {
  const realFetch = globalThis.fetch;
  const queue = [...responses];
  const networkFailures = [];
  let transactions = 0;
  let batches = 0;
  let sourceWrites = 0;
  let batch;
  let sourceRow;
  const bindings = {
    applyNoStoreHeaders: response => { response.noStore = true; },
    SpotifyPlaylistSourceConflict,
    prepareSpotifyPlaylistSource: async (_tx, input) => {
      if (conflict) throw new SpotifyPlaylistSourceConflict(409, 'spotify_source_changed', 'Refresh Sources before replacing this playlist.');
      assert.equal(input.performerId, 'synthetic-performer');
      assert.equal(input.actorId, 'synthetic-owner');
      assert.equal(input.sourceKey, 'spotify-' + playlistId);
      assert.equal(input.expectedSource, null);
      sourceRow = { metadata: { importMode: 'metadata_only' } }; sourceWrites++;
    },
    accessControl: { requireTalentAccess: async () => allowed
      ? { allowed: true, actor: { actorId: 'synthetic-owner' } }
      : { allowed: false, status: 401, reason: 'Sign in.' } },
    loadOwnedPerformerByActorUserId: async () => owner ? { performerId: 'synthetic-performer' } : null,
    normalizeLibraryText: (value, length) => typeof value === 'string' ? value.trim().slice(0, length) : '',
    importSpotifyPlaylist,
    process: { env: { SWAY_SPOTIFY_CLIENT_ID: `route-test-${++sequence}`, SWAY_SPOTIFY_CLIENT_SECRET: 'synthetic-secret' } },
    performerLibrarySources: { performerId: 'performer_id', sourceKey: 'source_key' },
    hashLibrarySyncKey: () => 'synthetic-hash',
    issueLibrarySyncKey: () => 'synthetic-key',
    upsertPerformerLibraryTrackBatch: async (_tx, input) => {
      batches++; batch = input; return { importedCount: input.rawTracks.length, removedCount: 0 };
    },
    businessDb: { transaction: async (work) => {
      transactions++;
      return work({ insert: () => ({ values: (input) => {
        sourceRow = input;
        return { onConflictDoUpdate: async () => { sourceWrites++; } };
      } }) });
    } }
  };
  const handler = new Function(...Object.keys(bindings), `${callback}\nreturn handler;`)(...Object.values(bindings));
  const response = { statusCode: 200, body: null, headers: {}, setHeader(name, value) { this.headers[name] = value; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  globalThis.fetch = async (url, init) => {
    try {
      const expected = queue.shift();
      assert.ok(expected, `Unexpected provider request: ${String(url)}`);
      assert.equal(String(url), expected[0]);
      assert.equal(init.redirect, 'error');
      return expected[1];
    } catch (error) { networkFailures.push(error); throw error; }
  };
  try {
    await handler({ body: { playlistUrl: reference, performerId, expectedSource: null } }, response);
    assert.deepEqual(networkFailures, []);
    assert.equal(queue.length, 0, 'Every expected provider request must happen.');
    assert.equal(response.statusCode, expectedStatus);
    assert.equal(response.noStore, true);
    const writesExpected = expectedTracks === null ? 0 : 1;
    assert.equal(transactions, conflict ? 1 : writesExpected, 'Incomplete imports must not open a replacement transaction.');
    assert.equal(batches, writesExpected, 'Incomplete imports must not call the track writer.');
    assert.equal(sourceWrites, writesExpected, 'Incomplete imports must not update source metadata.');
    if (expectedTracks !== null) {
      assert.equal(response.body.success, true);
      assert.equal(response.body.importedCount, expectedTracks.length);
      assert.deepEqual(batch.rawTracks.map(row => row.externalTrackId), expectedTracks.map(id => `spotify:${id}`));
      assert.equal(batch.performerId, 'synthetic-performer');
      assert.equal(batch.replaceExisting, true);
      assert.equal(sourceRow.metadata.importMode, 'metadata_only');
      assert.equal(response.body.playbackMode, 'open_in_spotify');
    }
  } finally { globalThis.fetch = realFetch; }
}
const token = () => ['https://accounts.spotify.com/api/token', json({ access_token: 'synthetic-token', expires_in: 3600 })];

test('Current Spotify route cannot persist an incomplete provider batch', async t => {
  await t.test('denied account access stops before provider and persistence', () => exercise([], { allowed: false, expectedStatus: 401 }));
  await t.test('a non-owner stops before provider and persistence', () => exercise([], { owner: false, expectedStatus: 403 }));
  await t.test('deceptive playlist URLs cannot reach provider or persistence', () => exercise([], { reference: `https://evil.example/open.spotify.com/playlist/${playlistId}` }));
  await t.test('an incomplete first page never replaces saved music', () => exercise([token(), [endpoint, json(metadata(page([{ track: track() }], 2)))]], { expectedStatus: 503 }));
  await t.test('a failed later page never replaces saved music', () => exercise([token(), [endpoint, json(metadata(page([{ track: track() }], 2, 0, next)))], [next, json({}, 429)]], { expectedStatus: 429 }));
  await t.test('a changed playlist snapshot never replaces saved music', () => exercise([token(), [endpoint, json(metadata(page([{ track: track() }], 2, 0, next)))], [next, json(page([{ track: track(secondId) }], 2, 1))], [`${endpoint}?fields=snapshot_id`, json({ snapshot_id: 'version-two' })]], { expectedStatus: 503 }));
  await t.test('the current HTTP route still enforces its explicit 1000-item ceiling without truncation', () => exercise([token(), [endpoint, json(metadata(page([{ track: track() }], 1001, 0, next)))]]));
  await t.test('a complete deduplicated playlist below that ceiling reaches the existing writer once', () => exercise([token(), [endpoint, json(metadata(page([{ track: track() }], 3, 0, next)))], [next, json(page([{ track: track() }, { track: track(secondId) }], 3, 1))], [`${endpoint}?fields=snapshot_id`, json({ snapshot_id: 'version-one' })]], { expectedStatus: 202, expectedTracks: [firstId, secondId] }));
  await t.test('a changed performer rejects before provider access', () => exercise([], { performerId: 'different-performer', expectedStatus: 409 }));
  await t.test('source conflict becomes 409 without touching tracks', () => exercise([token(), [endpoint, json(metadata(page([{ track: track() }]))) ]], { conflict: true, expectedStatus: 409 }));
  await t.test('251 tracks through the actual route are not capped at the old first-page ceiling', async () => {
    const ids = Array.from({length:251}, (_,i) => String(i).padStart(22,'0'));
    const entries = ids.map(id => ({track:track(id)}));
    const middle = endpoint+'/items?offset=100'; const last=endpoint+'/items?offset=200';
    await exercise([token(), [endpoint,json(metadata(page(entries.slice(0,100),251,0,middle)))], [middle,json(page(entries.slice(100,200),251,100,last))], [last,json(page(entries.slice(200),251,200))], [endpoint+'?fields=snapshot_id',json({snapshot_id:'version-one'})]], {expectedStatus:202,expectedTracks:ids});
  });

});
