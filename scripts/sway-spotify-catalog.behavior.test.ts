import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importSpotifyPlaylist, searchCatalog } from '../src/server/spotify-catalog.ts';

const PLAYLIST_ID = '37i9dQZF1DXcBWIGoYBM5M';
const TRACK_ID = '4uLU6hMCjMI75M1A2tKUQC';
const OTHER_TRACK_ID = '7qiZfU4dY1lWllzX7mPBI3';
const tokenUrl = 'https://accounts.spotify.com/api/token';
const playlistUrl = `https://api.spotify.com/v1/playlists/${PLAYLIST_ID}`;
const snapshotUrl = `${playlistUrl}?fields=snapshot_id`;
const realFetch = globalThis.fetch;
let credentialSequence = 0;
function env() { return { SWAY_SPOTIFY_CLIENT_ID: `test-client-${++credentialSequence}`, SWAY_SPOTIFY_CLIENT_SECRET: 'test-secret' }; }
function track(id = TRACK_ID) { return { id, name: 'Track title', type: 'track', artists: [{ name: 'Artist' }], album: { name: 'Album', images: [{ url: 'https://i.scdn.co/image/art' }] } }; }
function page(items: unknown[], total = items.length, offset = 0, next: string | null = null) { return { items, total, offset, next }; }
function metadata(paging: unknown, shape: 'tracks' | 'items' = 'tracks') { return { id: PLAYLIST_ID, name: 'My playlist', snapshot_id: 'snapshot-one', [shape]: paging }; }
function json(data: unknown, status = 200, headers?: HeadersInit) { return new Response(JSON.stringify(data), { status, headers }); }
type ExpectedCall = { url: string | ((url: URL) => void); response: Response | ((init: RequestInit) => Response | Promise<Response>); token?: string };
function mockProvider(expected: ExpectedCall[]) {
  const queue = [...expected];
  let calls = 0;
  const failures: unknown[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls++;
    try {
      const step = queue.shift();
      assert.ok(step, `Unexpected provider request ${String(input)}`);
      const url = new URL(String(input));
      if (typeof step.url === 'function') step.url(url); else assert.equal(url.toString(), step.url);
      assert.equal(init?.redirect, 'error', 'Authenticated calls must refuse redirects');
      assert.ok(init?.signal instanceof AbortSignal, 'Every request must have an abort deadline');
      if (step.token) assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${step.token}`);
      return typeof step.response === 'function' ? await step.response(init!) : step.response;
    } catch (error) { if (error instanceof assert.AssertionError) failures.push(error); throw error; }
  }) as typeof fetch;
  return { done() { assert.deepEqual(failures, [], 'Provider boundary assertions failed'); assert.equal(queue.length, 0, 'Expected provider calls missing'); }, calls: () => calls };
}
function token(value = 'token-one', expires_in = 3600): ExpectedCall { return { url: tokenUrl, response: json({ access_token: value, expires_in, token_type: 'Bearer' }) }; }

test('Spotify catalog behavior at the mocked provider boundary', async (t) => {
  try {
    await t.test('search uses development-compatible limits and canonical track references', async () => {
      for (const [requested, expected] of [[undefined, 10], [50, 10], [-5, 1], [2.9, 2], [NaN, 10]] as const) {
        const provider = mockProvider([token(), { url(url) {
          assert.equal(url.pathname, '/v1/search'); assert.equal(url.searchParams.get('limit'), String(expected));
          assert.equal(url.searchParams.get('q'), 'artist & title'); assert.equal(url.searchParams.get('type'), 'track');
        }, token: 'token-one', response: json({ tracks: { items: [track()] } }) }]);
        const result = await searchCatalog({ query: '  artist & title  ', env: env(), limit: requested });
        assert.equal(result.status, 'ready'); assert.equal(result.results[0].spotifyUri, `spotify:track:${TRACK_ID}`);
        assert.equal(result.results[0].spotifyUrl, `https://open.spotify.com/track/${TRACK_ID}`);
        provider.done();
      }
    });
    await t.test('unconfigured and empty searches do not call the provider', async () => {
      const provider = mockProvider([]);
      assert.equal((await searchCatalog({ query: 'track', env: {} })).status, 'not_configured');
      assert.equal((await searchCatalog({ query: ' ', env: env() })).status, 'ready');
      assert.equal((await importSpotifyPlaylist({ playlistUrl: PLAYLIST_ID, env: {} })).configured, false);
      provider.done();
    });
    await t.test('invalid and deceptive playlist URLs are rejected before authentication', async () => {
      const provider = mockProvider([]);
      for (const reference of [`https://evil.example/open.spotify.com/playlist/${PLAYLIST_ID}`, `https://open.spotify.com.evil.example/playlist/${PLAYLIST_ID}`, `http://open.spotify.com/playlist/${PLAYLIST_ID}`, '1234567890']) {
        const result = await importSpotifyPlaylist({ playlistUrl: reference, env: env() });
        assert.equal(result.status, 'invalid_playlist'); assert.deepEqual(result.tracks, []);
      }
      provider.done();
    });
    await t.test('legacy and migrated playlists follow every page and retain stable source IDs', async () => {
      for (const shape of ['tracks', 'items'] as const) {
        const field = shape === 'tracks' ? 'track' : 'item';
        const next = `${playlistUrl}/${shape}?offset=1&limit=100`;
        const provider = mockProvider([token(), { url: playlistUrl, response: json(metadata(page([{ [field]: track() }], 3, 0, next), shape)) },
          { url: next, token: 'token-one', response: json(page([{ [field]: null }, { [field]: track(OTHER_TRACK_ID) }], 3, 1)) },
          { url: snapshotUrl, token: 'token-one', response: json({ snapshot_id: 'snapshot-one' }) }]);
        const result = await importSpotifyPlaylist({ playlistUrl: `https://open.spotify.com/intl-us/playlist/${PLAYLIST_ID}?si=share`, env: env() });
        assert.equal(result.status, 'ready'); assert.equal(result.playlistName, 'My playlist');
        assert.deepEqual(result.tracks.map((item) => item.externalTrackId), [`spotify:${TRACK_ID}`, `spotify:${OTHER_TRACK_ID}`]);
        provider.done();
      }
    });
    await t.test('a successful empty playlist is distinct from denied contents and unavailable entries', async () => {
      const cases = [
        [metadata(page([])), 'ready'],
        [{ id: PLAYLIST_ID, name: 'Private playlist' }, 'access_denied'],
        [metadata(page([{ track: null }, { track: { is_local: true } }, { track: { type: 'episode' } }])), 'no_importable_tracks']
      ] as const;
      for (const [payload, status] of cases) {
        const provider = mockProvider([token(), { url: playlistUrl, response: json(payload) }]);
        const result = await importSpotifyPlaylist({ playlistUrl: PLAYLIST_ID, env: env() });
        assert.equal(result.status, status); assert.deepEqual(result.tracks, []); provider.done();
      }
    });
    await t.test('a playlist beyond the old first-page limit is imported completely', async () => {
      const next = `${playlistUrl}/tracks?offset=100&limit=100`;
      const last = `${playlistUrl}/tracks?offset=200&limit=100`;
      const entries = Array.from({ length: 251 }, (_, index) => ({ track: track(String(index).padStart(22, '0')) }));
      const provider = mockProvider([token(), { url: playlistUrl, response: json(metadata(page(entries.slice(0, 100), 251, 0, next))) },
        { url: next, response: json(page(entries.slice(100, 200), 251, 100, last)) }, { url: last, response: json(page(entries.slice(200), 251, 200)) },
        { url: snapshotUrl, response: json({ snapshot_id: 'snapshot-one' }) }]);
      const result = await importSpotifyPlaylist({ playlistUrl: PLAYLIST_ID, env: env() });
      assert.equal(result.status, 'ready'); assert.equal(result.tracks.length, 251);
      assert.equal(result.tracks[250].externalTrackId, `spotify:${String(250).padStart(22, '0')}`); provider.done();
    });
    await t.test('Spotify local-file markers on playlist entries do not invalidate available catalog songs', async () => {
      const provider = mockProvider([token(), { url: playlistUrl, response: json(metadata(page([
        { is_local: true, track: { id: null, name: 'Local song', type: 'track', uri: 'spotify:local:artist:album:song:123' } },
        { track: track() }
      ]))) }]);
      const result = await importSpotifyPlaylist({ playlistUrl: PLAYLIST_ID, env: env() });
      assert.equal(result.status, 'ready'); assert.equal(result.tracks.length, 1); assert.equal(result.tracks[0].externalTrackId, `spotify:${TRACK_ID}`); provider.done();
    });
    await t.test('duplicate songs across playlist pages count as one saved source track', async () => {
      const next = `${playlistUrl}/items?offset=2&limit=100`;
      const provider = mockProvider([token(), { url: playlistUrl, response: json(metadata(page([{ item: track() }, { item: track() }], 4, 0, next), 'items')) },
        { url: next, response: json(page([{ item: track() }, { item: track(OTHER_TRACK_ID) }], 4, 2)) },
        { url: snapshotUrl, response: json({ snapshot_id: 'snapshot-one' }) }]);
      const result = await importSpotifyPlaylist({ playlistUrl: PLAYLIST_ID, env: env() });
      assert.equal(result.status, 'ready'); assert.deepEqual(result.tracks.map((item) => item.externalTrackId), [`spotify:${TRACK_ID}`, `spotify:${OTHER_TRACK_ID}`]); provider.done();
    });
    await t.test('same-size playlist edits during pagination cannot replace a saved source with mixed versions', async () => {
      const next = `${playlistUrl}/tracks?offset=1`;
      for (const snapshot of [{ snapshot_id: 'changed-snapshot' }, {}]) {
        const provider = mockProvider([token(), { url: playlistUrl, response: json(metadata(page([{ track: track() }], 2, 0, next))) },
          { url: next, response: json(page([{ track: track(OTHER_TRACK_ID) }], 2, 1)) }, { url: snapshotUrl, response: json(snapshot) }]);
        const result = await importSpotifyPlaylist({ playlistUrl: PLAYLIST_ID, env: env() });
        assert.equal(result.status, 'invalid_response'); assert.deepEqual(result.tracks, []); provider.done();
      }
    });
    await t.test('paginated imports require a starting playlist version', async () => {
      const payload = metadata(page([{ track: track() }], 2, 0, `${playlistUrl}/tracks?offset=1`));
      const { snapshot_id: _snapshot, ...withoutSnapshot } = payload;
      const provider = mockProvider([token(), { url: playlistUrl, response: json(withoutSnapshot) }]);
      const result = await importSpotifyPlaylist({ playlistUrl: PLAYLIST_ID, env: env() });
      assert.equal(result.status, 'invalid_response'); assert.deepEqual(result.tracks, []); provider.done();
    });
    await t.test('playlists larger than the bound never return a truncated import', async () => {
      for (const [requested, total] of [[1, 2], [5000, 1001]] as const) {
        const provider = mockProvider([token(), { url: playlistUrl, response: json(metadata(page([{ track: track() }], total, 0, `${playlistUrl}/tracks?offset=1`))) }]);
        const result = await importSpotifyPlaylist({ playlistUrl: PLAYLIST_ID, env: env(), limit: requested });
        assert.equal(result.status, 'too_large'); assert.deepEqual(result.tracks, []); provider.done();
      }
    });
    await t.test('missing metadata, truncated pages, and unreadable tracks never appear complete', async () => {
      const malformed = [
        { items: [{ track: track() }] },
        { items: [{ track: track() }], total: 1, offset: 0 },
        { items: [{ track: track() }], next: null, offset: 0 },
        page([{ track: track() }], 2),
        page([{ track: track() }], 1, 1),
        page([{ track: track() }, { track: { name: 'Missing id' } }]),
        page([{ track: track() }, {}]),
        page([], 1, 0, `${playlistUrl}/tracks?offset=0`)
      ];
      for (const payload of malformed) {
        const provider = mockProvider([token(), { url: playlistUrl, response: json(metadata(payload)) }]);
        const result = await importSpotifyPlaylist({ playlistUrl: PLAYLIST_ID, env: env() });
        assert.equal(result.status, 'invalid_response'); assert.deepEqual(result.tracks, []); provider.done();
      }
    });
    await t.test('provider pagination cannot send credentials to another origin or playlist', async () => {
      for (const next of ['https://evil.example/page', `http://api.spotify.com/v1/playlists/${PLAYLIST_ID}/tracks?offset=1`, `https://api.spotify.com/v1/me`, `https://api.spotify.com/v1/playlists/${OTHER_TRACK_ID}/tracks?offset=1`, `https://user:password@api.spotify.com/v1/playlists/${PLAYLIST_ID}/items?offset=1`, `${playlistUrl}/tracks?offset=1#fragment`]) {
        const provider = mockProvider([token(), { url: playlistUrl, response: json(metadata(page([{ track: track() }], 2, 0, next))) }]);
        const result = await importSpotifyPlaylist({ playlistUrl: PLAYLIST_ID, env: env() });
        assert.equal(result.status, 'invalid_response'); assert.deepEqual(result.tracks, []); assert.equal(provider.calls(), 2); provider.done();
      }
    });
    await t.test('pagination loops, changed totals, and skipped offsets are refused atomically', async () => {
      const next = `${playlistUrl}/items?offset=1`;
      for (const second of [page([{ item: track() }], 3, 1, next), page([{ item: track() }], 4, 1), page([{ item: track() }], 3, 2)]) {
        const provider = mockProvider([token(), { url: playlistUrl, response: json(metadata(page([{ item: track() }], 3, 0, next), 'items')) }, { url: next, response: json(second) }]);
        const result = await importSpotifyPlaylist({ playlistUrl: PLAYLIST_ID, env: env() });
        assert.equal(result.status, 'invalid_response'); assert.deepEqual(result.tracks, []); provider.done();
      }
    });
    await t.test('failed later pages return no importable batch and expose safe provider status', async () => {
      const next = `${playlistUrl}/tracks?offset=1`;
      for (const [httpStatus, status] of [[403, 'access_denied'], [404, 'not_found'], [429, 'rate_limited'], [503, 'unavailable']] as const) {
        const provider = mockProvider([token(), { url: playlistUrl, response: json(metadata(page([{ track: track() }], 2, 0, next))) },
          { url: next, response: json({ secret: 'provider-internal-secret' }, httpStatus, { 'Retry-After': '7' }) }]);
        const result = await importSpotifyPlaylist({ playlistUrl: PLAYLIST_ID, env: env() });
        assert.equal(result.status, status); assert.equal(result.configured, true); assert.deepEqual(result.tracks, []);
        assert.ok(!JSON.stringify(result).includes('provider-internal-secret'));
        if (httpStatus === 429) assert.equal(result.retryAfterSeconds, 7);
        provider.done();
      }
    });
    await t.test('revoked token refreshes once and persistent rejection stops', async () => {
      const provider = mockProvider([token('old'), { url: playlistUrl, token: 'old', response: json({}, 401) }, token('new'), { url: playlistUrl, token: 'new', response: json({}, 401) }]);
      const result = await importSpotifyPlaylist({ playlistUrl: PLAYLIST_ID, env: env() });
      assert.equal(result.status, 'authentication_failed'); assert.equal(result.configured, true); assert.deepEqual(result.tracks, []); provider.done();
    });
    await t.test('refreshed token can recover a request without losing its playlist', async () => {
      const provider = mockProvider([token('old'), { url: playlistUrl, token: 'old', response: json({}, 401) }, token('new'), { url: playlistUrl, token: 'new', response: json(metadata(page([{ track: track() }]))) }]);
      const result = await importSpotifyPlaylist({ playlistUrl: PLAYLIST_ID, env: env() });
      assert.equal(result.status, 'ready'); assert.equal(result.tracks.length, 1); provider.done();
    });
    await t.test('credential rotation cannot reuse another app’s cached token', async () => {
      const firstEnv = env();
      const secondEnv = { ...firstEnv, SWAY_SPOTIFY_CLIENT_SECRET: 'rotated-secret' };
      const provider = mockProvider([token('first'), { url: playlistUrl, token: 'first', response: json(metadata(page([]))) }, token('second'), { url: playlistUrl, token: 'second', response: json(metadata(page([]))) }]);
      assert.equal((await importSpotifyPlaylist({ playlistUrl: PLAYLIST_ID, env: firstEnv })).status, 'ready');
      assert.equal((await importSpotifyPlaylist({ playlistUrl: PLAYLIST_ID, env: secondEnv })).status, 'ready'); provider.done();
    });
    await t.test('tokens are cached until their bounded early expiry', async () => {
      const credentials = env();
      const realNow = Date.now;
      let now = realNow();
      Date.now = () => now;
      try {
        const provider = mockProvider([token('first', 10), { url: playlistUrl, token: 'first', response: json(metadata(page([]))) },
          { url: playlistUrl, token: 'first', response: json(metadata(page([]))) }, token('second', 10), { url: playlistUrl, token: 'second', response: json(metadata(page([]))) }]);
        assert.equal((await importSpotifyPlaylist({ playlistUrl: PLAYLIST_ID, env: credentials })).status, 'ready');
        now += 1000;
        assert.equal((await importSpotifyPlaylist({ playlistUrl: PLAYLIST_ID, env: credentials })).status, 'ready');
        now += 9000;
        assert.equal((await importSpotifyPlaylist({ playlistUrl: PLAYLIST_ID, env: credentials })).status, 'ready'); provider.done();
      } finally { Date.now = realNow; }
    });
    await t.test('concurrent searches share one credential exchange', async () => {
      const credentials = env();
      const search = (url: URL) => assert.equal(url.pathname, '/v1/search');
      const provider = mockProvider([token(), { url: search, response: json({ tracks: { items: [] } }) }, { url: search, response: json({ tracks: { items: [] } }) }]);
      const results = await Promise.all([searchCatalog({ query: 'first', env: credentials }), searchCatalog({ query: 'second', env: credentials })]);
      assert.deepEqual(results.map((result) => result.status), ['ready', 'ready']); provider.done();
    });
    await t.test('bad token responses and token-endpoint rejection retain configuration truth', async () => {
      for (const [response, expected] of [[json({ access_token: 'token', expires_in: -1 }), 'invalid_response'], [json({ access_token: 'token' }), 'invalid_response'], [json({}, 400), 'authentication_failed'], [json({}, 429, { 'Retry-After': '3' }), 'rate_limited']] as const) {
        const provider = mockProvider([{ url: tokenUrl, response }]);
        const result = await searchCatalog({ query: 'track', env: env() });
        assert.equal(result.configured, true); assert.equal(result.status, expected); assert.deepEqual(result.results, []); provider.done();
      }
    });
    await t.test('request deadline aborts a stalled provider and produces a retryable timeout', async () => {
      const realTimeout = AbortSignal.timeout;
      const durations: number[] = [];
      AbortSignal.timeout = (duration: number) => { durations.push(duration); return realTimeout(5); };
      // Keep Node alive while the unref'ed native timeout fires.
      const keepAlive = setTimeout(() => {}, 1000);
      try {
        const provider = mockProvider([{ url: tokenUrl, response: (init) => new Promise((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        }) }]);
        const result = await searchCatalog({ query: 'track', env: env() });
        assert.equal(result.status, 'timeout'); assert.equal(result.configured, true); assert.deepEqual(result.results, []);
        assert.deepEqual(durations, [10_000]); provider.done();
      } finally { clearTimeout(keepAlive); AbortSignal.timeout = realTimeout; }
    });
    await t.test('whole-operation deadline bounds long pagination even when individual pages respond', async () => {
      const realNow = Date.now;
      let now = realNow();
      Date.now = () => now;
      const next = `${playlistUrl}/tracks?offset=1`;
      try {
        const provider = mockProvider([token(), { url: playlistUrl, response() { now += 30_001; return json(metadata(page([{ track: track() }], 2, 0, next))); } }]);
        const result = await importSpotifyPlaylist({ playlistUrl: PLAYLIST_ID, env: env() });
        assert.equal(result.status, 'timeout'); assert.deepEqual(result.tracks, []); provider.done();
      } finally { Date.now = realNow; }
    });
    await t.test('unreadable JSON and malformed search envelopes are not reported as empty successes', async () => {
      for (const response of [new Response('not JSON'), json({ tracks: {} }), json([])]) {
        const provider = mockProvider([token(), { url: (url) => assert.equal(url.pathname, '/v1/search'), response }]);
        const result = await searchCatalog({ query: 'track', env: env() });
        assert.equal(result.status, 'invalid_response'); assert.deepEqual(result.results, []); provider.done();
      }
    });
    await t.test('wholly and partly malformed search items fail without partial results', async () => {
      for (const items of [[{ name: 'Missing id' }], [track(), { id: OTHER_TRACK_ID }], [null], [track(), null]]) {
        const provider = mockProvider([token(), { url: (url) => assert.equal(url.pathname, '/v1/search'), response: json({ tracks: { items } }) }]);
        const result = await searchCatalog({ query: 'track', env: env() });
        assert.equal(result.status, 'invalid_response'); assert.equal(result.configured, true); assert.deepEqual(result.results, []); provider.done();
      }
    });
    await t.test('a valid empty provider search remains a successful empty result', async () => {
      const provider = mockProvider([token(), { url: (url) => assert.equal(url.pathname, '/v1/search'), response: json({ tracks: { items: [] } }) }]);
      const result = await searchCatalog({ query: 'no matches', env: env() });
      assert.equal(result.status, 'ready'); assert.deepEqual(result.results, []); provider.done();
    });
  } finally { globalThis.fetch = realFetch; }
});
