import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import type { Server } from 'node:http';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createSwayReverseOsmosisService } from '../src/server/reverse-osmosis-native';
import { registerSwayReverseOsmosisRoutes } from '../src/server/reverse-osmosis-routes';

// Isolated fixture authentication and trusted connector evidence are NOT real
// customer consent, provider verification, or provider delivery proof.
const tempRoot = resolve(tmpdir());
const directory = await mkdtemp(join(tempRoot, 'sway-ro-http-'));
let pg = new PGlite(directory);
let server: Server | undefined;
const owner = randomUUID(), stranger = randomUUID(), performer = randomUUID(), sibling = randomUUID(), binding = randomUUID();
const completedTests: string[] = [];
async function test(name: string, body: () => Promise<void>) { await body(); completedTests.push(name); console.log(`PASS ${name}`); }
try {
  await pg.exec(`CREATE TABLE users(id uuid PRIMARY KEY);
    CREATE TABLE performers(id uuid PRIMARY KEY,owner_user_id uuid NOT NULL REFERENCES users(id),handle text,bio text,updated_at timestamptz DEFAULT now());
    CREATE TABLE performer_public_profiles(performer_id uuid PRIMARY KEY REFERENCES performers(id),headline text,city text,updated_at timestamptz DEFAULT now());
    CREATE TABLE audit_events(event_id uuid PRIMARY KEY,actor_type text,actor_id uuid,entity_type text,entity_id uuid,event_type text,metadata jsonb);`);
  // Apply the actual migration SQL, including its constraints and triggers.
  await pg.exec(await readFile(new URL('../drizzle/0052_sway_reverse_osmosis.sql', import.meta.url), 'utf8'));
  await pg.query('INSERT INTO users VALUES($1),($2)', [owner, stranger]);
  await pg.query("INSERT INTO performers(id,owner_user_id,handle,bio) VALUES($1,$2,'http-owner','original'),($3,$2,'http-sibling','sibling original')", [performer,owner,sibling]);
  await pg.query(`INSERT INTO sway_ro_business_bindings(id,performer_id,owner_id,business_id,tenant_id,provider,account_id,asset_kind,provider_verified,owner_authorized,verified_at,expires_at,revision,evidence_reference)
    VALUES($1,$2,$3,'fixture-business','fixture-tenant','fixture-provider','fixture-business-account','business-page',true,true,now(),now()+interval '1 hour','fixture-binding-v1','ISOLATED TEST evidence; not real customer/provider proof')`, [binding,performer,owner]);
  const app = express(); app.use(express.json());
  registerSwayReverseOsmosisRoutes(app, {
    database: () => drizzle(pg),
    externalOrigin: 'https://app.sway.tips',
    // Explicit test-only actor injection; production authentication is not claimed here.
    requireTalentAccess: async request => request.get('x-test-actor') ? { allowed:true, actor:{actorId:request.get('x-test-actor')} } : {allowed:false,status:401,reason:'fixture authentication required'},
    loadOwnedPerformer: async actorId => {
      const p = (await pg.query<{id:string;handle:string}>('SELECT id,handle FROM performers WHERE owner_user_id=$1 ORDER BY handle LIMIT 1',[actorId])).rows[0];
      return p ? {performerId:p.id,handle:p.handle} : null;
    },
  });
  server = await new Promise<Server>(resolveServer => { const listening = app.listen(0,'127.0.0.1',() => resolveServer(listening)); });
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/talent/profile/sync`;
  const http = async (suffix='', body?:unknown, actor=owner, handle='http-owner', extraHeaders:Record<string,string>={}) => {
    const response = await fetch(`${base}${suffix}?handle=${encodeURIComponent(handle)}`,{method:body === undefined?'GET':'POST',headers:{'x-test-actor':actor,...(body === undefined?{}:{'content-type':'application/json'}),...extraHeaders},...(body === undefined?{}:{body:JSON.stringify(body)})});
    assert.equal(response.headers.get('cache-control'),'no-store');
    return {status:response.status,body:await response.json() as any};
  };
  const native = () => createSwayReverseOsmosisService(drizzle(pg),owner,{performerId:performer});
  const seed = (version:string, bio:string) => native().createProposal({bindingId:binding,direction:'social-to-native',eventId:randomUUID(),sourceVersion:version,expectedNativeVersion:version,fields:{bio,headline:'HTTP Artist',city:'Paris'}});
  const review = (p:any) => ({confirmed:true,payloadDigest:p.proposal.payloadDigest,expectedNativeVersion:p.proposal.expectedNativeVersion,businessBindingRevision:p.proposal.businessBindingRevision});
  const approve = async (p:any) => {const r=await http(`/${p.id}/approve`,review(p));assert.equal(r.status,201);return r.body;};
  const state = async () => (await pg.query<{bio:string|null;public_profile_revision:number;headline:string|null;city:string|null}>('SELECT p.bio,p.public_profile_revision,s.headline,s.city FROM performers p LEFT JOIN performer_public_profiles s ON s.performer_id=p.id WHERE p.id=$1',[performer])).rows[0];
  const inbound = await seed('0','approved through HTTP');
  await test('pending exact review and HTTP confirmation mutate real native rows once',async()=>{
    const status = await http(); assert.equal(status.status,200); assert.equal(status.body.nativeVersion,'0');assert.equal(status.body.providerPublishingAvailable,false);
    const pending=status.body.proposals.find((p:any)=>p.id===inbound.id);assert.deepEqual(pending.proposal,JSON.parse(JSON.stringify(inbound.proposal)));assert.equal(pending.approval_id,null);
    assert.equal((await http(`/${inbound.id}/run`,{approvalId:randomUUID()})).status,409);
    assert.equal((await http(`/${inbound.id}/approve`,{...review(inbound),confirmed:'true'})).status,422);
    assert.equal((await http(`/${inbound.id}/approve`,{...review(inbound),payloadDigest:'forged'})).status,409);
    const a=await approve(inbound);assert.equal(a.approval.approvalId,a.id);
    const runs=await Promise.all([http(`/${inbound.id}/run`,{approvalId:a.id}),http(`/${inbound.id}/run`,{approvalId:a.id})]);
    for(const r of runs){assert.equal(r.status,200);assert.equal(r.body.outcome.status,'completed');assert.equal(r.body.outcome.operationKey,inbound.proposal.operationKey);assert.equal(r.body.outcome.payloadDigest,inbound.proposal.payloadDigest);}
    assert.deepEqual(await state(),{bio:'approved through HTTP',public_profile_revision:1,headline:'HTTP Artist',city:'Paris'});
    assert.equal((await pg.query('SELECT * FROM audit_events')).rows.length,1);
    assert.equal((await pg.query('SELECT * FROM sway_ro_operations WHERE proposal_id=$1',[inbound.id])).rows.length,1);
    assert.equal((await http(`/${inbound.id}/run`,{approvalId:a.id})).body.outcome.status,'completed');
  });
  await test('canonical HTTPS origin survives proxy shape and hostile forwarded origin is denied',async()=>{
    const before=await state();
    for(const protocol of ['https','http']){
      const preview=await http('/preview',{bindingId:binding},owner,'http-owner',{'origin':'https://app.sway.tips','x-forwarded-proto':protocol,'x-forwarded-host':'app.sway.tips'});
      assert.equal(preview.status,201);
      // An unapproved preview has no operation: this is the exact null shape
      // the browser must interpret as still pending, never as successful delivery.
      const pending=await http(`/${preview.body.id}/outcome`);
      assert.equal(pending.status,200);assert.deepEqual(pending.body,{outcome:null});
    }
    assert.equal((await http('/preview',{bindingId:binding},owner,'http-owner',{'origin':new URL(base).origin})).status,201);
    const count=(await pg.query('SELECT * FROM sway_ro_proposals')).rows.length;
    assert.equal((await http('/preview',{bindingId:binding},owner,'http-owner',{'origin':'https://hostile.example','x-forwarded-host':'app.sway.tips','x-forwarded-proto':'https'})).status,403);
    assert.equal((await pg.query('SELECT * FROM sway_ro_proposals')).rows.length,count);
    assert.deepEqual(await state(),before);
    assert.equal((await pg.query('SELECT * FROM audit_events')).rows.length,1);
  });
  await test('lost response recovery reads the exact durable outcome without dispatch',async()=>{
    const before=await state();const saved=await http(`/${inbound.id}/outcome`);assert.equal(saved.status,200);assert.equal(saved.body.outcome.operationKey,inbound.proposal.operationKey);assert.equal(saved.body.outcome.receipt.nativeVersion,'1');assert.deepEqual(await state(),before);assert.equal((await pg.query('SELECT * FROM audit_events')).rows.length,1);
    await pg.close();pg=new PGlite(directory);assert.equal((await http(`/${inbound.id}/outcome`)).body.outcome.status,'completed');
  });
  await test('actor and selected handle isolation plus strict preview input',async()=>{
    assert.equal((await http('',undefined,stranger)).status,403);
    assert.equal((await http('',undefined,owner,'http-sibling')).status,409);
    assert.equal((await http(`/${inbound.id}/outcome`,undefined,stranger)).status,403);
    const siblingBinding=randomUUID();await pg.query(`INSERT INTO sway_ro_business_bindings SELECT $1,$2,owner_id,business_id,tenant_id,provider,'fixture-sibling-account',asset_kind,provider_verified,owner_authorized,verified_at,expires_at,revoked,revision,evidence_reference FROM sway_ro_business_bindings WHERE id=$3`,[siblingBinding,sibling,binding]);
    assert.equal((await http('/preview',{bindingId:siblingBinding})).status,409);
    for(const extra of [{fields:{privateEmail:'invented'}},{eventId:'client-event'},{expectedNativeVersion:'999'}]) assert.equal((await http('/preview',{bindingId:binding,...extra})).status,422);
  });
  await test('central policy filters personal unknown revoked and expired bindings',async()=>{
    for(const patch of ["asset_kind='personal'","asset_kind='unknown'","revoked=true","expires_at=now()-interval '1 second'"]){
      await pg.exec(`UPDATE sway_ro_business_bindings SET ${patch} WHERE id='${binding}'`);assert.equal((await http()).body.bindings.length,0);assert.equal((await http('/preview',{bindingId:binding})).status,409);
      await pg.query("UPDATE sway_ro_business_bindings SET asset_kind='business-page',revoked=false,expires_at=now()+interval '1 hour',verified_at=now() WHERE id=$1",[binding]);
    }
  });
  await test('profile CAS conflict blocks stale approved native changes',async()=>{
    const p=await seed('1','must not apply');const a=await approve(p);await pg.query('UPDATE performers SET public_profile_revision=2 WHERE id=$1',[performer]);
    assert.equal((await http(`/${p.id}/run`,{approvalId:a.id})).status,409);assert.equal((await state()).bio,'approved through HTTP');assert.equal((await pg.query('SELECT * FROM audit_events')).rows.length,1);
  });
  await test('server captured preview never applies and missing publisher durably holds',async()=>{
    const before=await state();const p=await http('/preview',{bindingId:binding});assert.equal(p.status,201);assert.equal(p.body.proposal.direction,'native-to-social');assert.equal(p.body.proposal.expectedNativeVersion,'2');assert.deepEqual(p.body.proposal.fields,{bio:before.bio,headline:before.headline,city:before.city});assert.deepEqual(await state(),before);
    const a=await approve(p.body);const run=await http(`/${p.body.id}/run`,{approvalId:a.id});assert.equal(run.status,200);assert.equal(run.body.outcome.status,'held');assert.equal(run.body.outcome.receipt.reason,'provider-transport-unavailable');assert.deepEqual(await state(),before);
    const another=await http('/preview',{bindingId:binding});assert.equal(another.status,201);assert.notEqual(another.body.id,p.body.id);const aa=await approve(another.body);assert.equal((await http(`/${another.body.id}/run`,{approvalId:aa.id})).status,409);
    for(const patch of ['revoked=true',"revoked=false,expires_at=now()-interval '1 second'"]){await pg.query(`UPDATE sway_ro_business_bindings SET ${patch} WHERE id=$1`,[binding]);const saved=await http(`/${p.body.id}/outcome`);assert.equal(saved.status,200);assert.equal(saved.body.outcome.status,'held');assert.equal((await http(`/${p.body.id}/run`,{approvalId:a.id})).status,409);assert.equal((await http(`/${p.body.id}/outcome`,undefined,stranger)).status,403);}
    assert.equal((await pg.query('SELECT * FROM audit_events')).rows.length,1);assert.deepEqual(await state(),before);
    await pg.close();pg=new PGlite(directory);assert.equal((await http(`/${p.body.id}/outcome`)).body.outcome.status,'held');
  });
  console.log(`PASS ${completedTests.length} isolated actual HTTP + disk PGlite tests; fixture auth/evidence only; no external provider calls or publication claimed`);
} finally {
  if(server) await new Promise<void>((resolveClose,reject)=>{server!.close(error=>error?reject(error):resolveClose());server!.closeAllConnections();});
  await pg.close();
  const child=relative(tempRoot,resolve(directory));
  assert(child && !child.startsWith('..') && !isAbsolute(child) && child.startsWith('sway-ro-http-'),'cleanup must remain in owned private temp directory');
  await rm(directory,{recursive:true,force:true});
}




