import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as a from '../src/shells/discoveryAttribution.ts';
const KEY='sway.discovery.journeyId';
const storage=()=>{const data=new Map();return {getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};};
function browser({denied=false,throws=false,local=storage(),session=storage(),referrer='',search='',pathname='/discover'}={}) {
 const win={location:{search,pathname}};
 for(const [key,value] of [['localStorage',local],['sessionStorage',session]])Object.defineProperty(win,key,{get(){if(denied)throw new Error('SecurityError');return throws?{getItem(){throw new Error('blocked')},setItem(){throw new Error('quota')},removeItem(){throw new Error('blocked')}}:value;}});
 globalThis.window=win;globalThis.document={referrer};return win;
}
test('denied storage getters preserve first/latest/offline and stable per-page journey',()=>{
 browser({denied:true,referrer:'https://www.google.com/search?q=music'});
 assert.equal(a.captureDiscoveryAttribution().channel,'google');assert.equal(a.getLatestDiscoveryTouch().channel,'google');
 const id=a.getOrCreateDiscoveryJourneyId();assert.equal(a.getOrCreateDiscoveryJourneyId(),id);
 assert.equal(a.recordOfflineFindUs('facebook').channel,'google');assert.equal(a.getOfflineFindUs(),'facebook');
 window.location.pathname='/p/dj3x';assert.equal(a.getDiscoveryEntryPath(),'/discover');assert.equal(a.getOrCreateDiscoveryJourneyId(),id);
});
test('storage method failures do not rotate each event',()=>{
 browser({throws:true,search:'?utm_source=chatgpt'});assert.equal(a.captureDiscoveryAttribution().channel,'chatgpt');
 const id=a.getOrCreateDiscoveryJourneyId();for(let i=0;i<4;i++)assert.equal(a.getOrCreateDiscoveryJourneyId(),id);
});
test('a local deletion failure does not bypass a working tab-session identifier',()=>{
 const session=storage();const id='aaaf0000-1111-4111-8111-111111111111';session.setItem(KEY,id);
 browser({local:{...storage(),removeItem(){throw new Error('local blocked')}},session});assert.equal(a.getOrCreateDiscoveryJourneyId(),id);
});
test('tab session survives reload but separate tabs and denied-storage pages rotate',()=>{
 const local=storage(),session=storage();local.setItem(KEY,'aaaf0000-1111-4111-8111-111111111111');
 const originalSet=local.setItem;local.setItem=(key,value)=>{assert.notEqual(key,KEY,'Journey IDs must not persist in localStorage');originalSet(key,value);};
 browser({local,session});const id=a.getOrCreateDiscoveryJourneyId();assert.equal(local.getItem(KEY),null,'Remove the old persistent journey ID');
 assert.equal(session.getItem(KEY),id,'Use tab session storage for the journey ID');
 browser({local,session});assert.equal(a.getOrCreateDiscoveryJourneyId(),id);assert.equal(local.getItem(KEY),null);
 browser();assert.notEqual(a.getOrCreateDiscoveryJourneyId(),id);
 browser({denied:true});const page=a.getOrCreateDiscoveryJourneyId();browser({denied:true});assert.notEqual(a.getOrCreateDiscoveryJourneyId(),page);
});
test('malformed persisted touch is ignored and replaced without throwing',()=>{
 for(const invalid of ['not-json','null','[]','"google"','{"channel":{"toString":null},"landingPath":"/","capturedAt":"2026-01-01"}','{"channel":"__proto__","landingPath":"/","capturedAt":"2026-01-01"}','{"channel":"google","landingPath":"//evil.example","capturedAt":"2026-01-01"}']){
  const local=storage();local.setItem('sway.discovery.firstTouch',invalid);browser({local});assert.equal(a.captureDiscoveryAttribution().channel,'direct');
 }
});
test('referrer classification uses hostname not query/path/userinfo substrings',()=>{
 for(const referrer of ['https://evil.example/?next=https://google.com','https://chatgpt.com.evil.example/','https://evil.example/google.com','https://notgoogle.com/']){
  browser({referrer});assert.equal(a.captureDiscoveryAttribution().channel,'referral',referrer);
 }
 for(const referrer of ['https://google.com@evil.example/','javascript:google.com','invalid google.com']){
  browser({referrer});assert.equal(a.captureDiscoveryAttribution().channel,'unknown',referrer);
 }
 for(const [referrer,expected] of [['https://www.google.co.uk/search','google'],['https://chatgpt.com/','chatgpt'],['https://www.sway.tips/','direct']]){
  browser({referrer});assert.equal(a.captureDiscoveryAttribution().channel,expected);
 }
});
test('unrecognized campaign labels cannot impersonate known providers via substring',()=>{
 browser({search:'?utm_source=notgoogle'});assert.equal(a.captureDiscoveryAttribution().channel,'other');
 browser({search:'?utm_source=chatgpt'});assert.equal(a.captureDiscoveryAttribution().channel,'chatgpt');
});
test('strong first-touch persists through navigation and offline self-report',()=>{
 browser({referrer:'https://chatgpt.com/'});const first=a.captureDiscoveryAttribution();document.referrer='https://app.sway.tips/discover';window.location.pathname='/p/dj3x';
 assert.deepEqual(a.captureDiscoveryAttribution(),first);assert.equal(a.recordOfflineFindUs('facebook').channel,'chatgpt');assert.equal(a.getLatestDiscoveryTouch().channel,'direct');
});
test('server-side calls do not access browser globals',()=>{
 delete globalThis.window;delete globalThis.document;assert.equal(a.getFirstDiscoveryTouch(),null);assert.equal(a.getLatestDiscoveryTouch(),null);
 assert.equal(a.getOrCreateDiscoveryJourneyId(),'00000000-0000-4000-8000-000000000000');assert.equal(a.captureDiscoveryAttribution().channel,'direct');
});
