import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readRequestLibrary} from '../src/request-library-read.ts';
const version='a'.repeat(64);
const tracks=(count:number,start=0)=>Array.from({length:count},(_,i)=>({id:String(start+i),title:'Song '+(start+i),artist:'Fixture',album:null,artworkUrl:null,sourceLabel:'Source',sourceKey:'external'}));
const page=(offset=0,count=100,hasMore=false)=>({performerId:'performer-a',catalog:{tracks:[]},external:{tracks:tracks(count,offset),pagination:{offset,limit:100,version,hasMore,nextOffset:hasMore?offset+100:null}}});
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status});
test('saved library pagination never presents an incomplete or mixed snapshot as complete',async t=>{
 await t.test('all 251 tracks are returned with stable pages and owner',async()=>{
  const pending=[page(0,100,true),page(100,100,true),page(200,51)];const urls:string[]=[];
  const result=await readRequestLibrary({performerId:'performer-a',fetcher:(async(url,init)=>{urls.push(String(url));assert.equal(init?.cache,'no-store');assert(init?.signal);return json(pending.shift());}) as typeof fetch});
  assert.equal(result.external.tracks.length,251);assert.equal(result.external.tracks.at(-1)?.title,'Song 250');assert.equal(urls[0],'/api/talent/library/tracks');assert(urls[2].includes('offset=200'));assert(urls[2].includes('version='+version));
 });
 await t.test('a changed source version rejects the entire read',async()=>{
  const first=page(0,100,true),second=page(100,1);second.external.pagination.version='b'.repeat(64);const queue=[first,second];
  await assert.rejects(readRequestLibrary({performerId:'performer-a',fetcher:(async()=>json(queue.shift())) as typeof fetch}),/could not be confirmed/);
 });
 await t.test('foreign account, missing paging, invalid tracks and repeated IDs fail closed',async()=>{
  for(const mutation of [(p:any)=>p.performerId='other',(p:any)=>delete p.external.pagination,(p:any)=>delete p.external.tracks[0].title,(p:any)=>p.external.tracks[1].id=p.external.tracks[0].id]){
   const payload=page();mutation(payload);await assert.rejects(readRequestLibrary({performerId:'performer-a',fetcher:(async()=>json(payload)) as typeof fetch}));
  }
 });
 await t.test('a skipped or empty continuing page cannot loop or hide tracks',async()=>{
  for(const payload of [page(1),page(0,0,true),{...page(),external:{...page().external,pagination:{...page().external.pagination,hasMore:true,nextOffset:0}}}])await assert.rejects(readRequestLibrary({performerId:'performer-a',fetcher:(async()=>json(payload)) as typeof fetch}));
 });
 await t.test('provider-independent HTTP failure is visible, not a partial success',async()=>{
  const queue=[json(page(0,100,true)),json({error:'Your music changed while loading.'},409)];
  await assert.rejects(readRequestLibrary({performerId:'performer-a',fetcher:(async()=>queue.shift()!) as typeof fetch}),/Your music changed/);
 });
 await t.test('pre-aborted account lifetime never fetches',async()=>{
  const c=new AbortController();c.abort();let calls=0;await assert.rejects(readRequestLibrary({performerId:'performer-a',signal:c.signal,fetcher:(async()=>{calls++;return json(page());}) as typeof fetch}));assert.equal(calls,0);
 });
});
