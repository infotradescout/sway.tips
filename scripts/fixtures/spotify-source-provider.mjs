// Test-only provider boundary. No Spotify network access or production credentials.
import assert from 'node:assert/strict';
import { readFileSync, appendFileSync } from 'node:fs';
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.SWAY_SPOTIFY_CLIENT_ID, 'sway-flow-fixture');
assert.equal(process.env.SWAY_SPOTIFY_CLIENT_SECRET, 'not-a-provider-secret');
const file = process.env.SWAY_SPOTIFY_FLOW_FIXTURE;
assert(file && file.includes('sway-spotify-flow-'));
const originalFetch = globalThis.fetch;
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {status, headers: {'content-type':'application/json', ...headers}});
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (['127.0.0.1', 'localhost'].includes(url.hostname)) return originalFetch(input, init);
  assert(['accounts.spotify.com','api.spotify.com'].includes(url.hostname), 'Unexpected external request blocked in Sources test');
  assert.equal(init?.redirect, 'error');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  appendFileSync(file+'.requests', JSON.stringify({path:url.pathname,query:url.search,revision:config.revision})+'\n');
  if (url.hostname === 'accounts.spotify.com') {
    assert.equal(url.pathname, '/api/token');
    return json({access_token:'fixture-token', expires_in:3600, token_type:'Bearer'});
  }
  assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-token');
  assert.match(url.pathname, /^\/v1\/playlists\/[A-Za-z0-9]{22}(?:\/items)?$/);
  if (config.delayMs) await new Promise(resolve=>setTimeout(resolve,config.delayMs));
  if (config.mode === 'rate_limited') return json({error:'provider fixture rate limit'},429,{'retry-after':'7'});
  if (config.mode === 'denied') return json({},403);
  if (url.searchParams.get('fields') === 'snapshot_id') return json({snapshot_id:config.mode === 'changed_snapshot' ? 'changed-version' : config.revision});
  const id=url.pathname.split('/')[3], offset=Number(url.searchParams.get('offset')||0);
  if (config.mode === 'failed_page' && offset>0) return json({},503);
  const count=config.count;
  const items=Array.from({length:Math.max(0,Math.min(100,count-offset))},(_,i)=>({item:{id:String(offset+i).padStart(22,'0'),name:config.revision+' song '+(offset+i),type:'track',artists:[{name:'Fixture Artist'}]}}));
  const page={items,total:count,offset,next:offset+items.length<count?'https://api.spotify.com/v1/playlists/'+id+'/items?offset='+(offset+items.length):null};
  return url.pathname.endsWith('/items') ? json(page) : json({id,name:'Sources flow playlist',snapshot_id:config.revision,items:page});
};
