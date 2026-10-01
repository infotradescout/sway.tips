import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createSwayReverseOsmosisService } from '../src/server/reverse-osmosis-native';

const directory = await mkdtemp(join(tmpdir(), 'sway-ro-native-'));
let pg = new PGlite(directory);
const owner = randomUUID(), stranger = randomUUID(), performer = randomUUID(), binding = randomUUID();
try {
  await pg.exec(`CREATE TABLE users(id uuid PRIMARY KEY);
    CREATE TABLE performers(id uuid PRIMARY KEY,owner_user_id uuid NOT NULL REFERENCES users(id),bio text,updated_at timestamptz DEFAULT now());
    CREATE TABLE performer_public_profiles(performer_id uuid PRIMARY KEY REFERENCES performers(id),headline text,city text,updated_at timestamptz DEFAULT now());
    CREATE TABLE audit_events(event_id uuid PRIMARY KEY,actor_type text,actor_id uuid,entity_type text,entity_id uuid,event_type text,metadata jsonb);`);
  await pg.exec(await readFile(new URL('../drizzle/0052_sway_reverse_osmosis.sql', import.meta.url), 'utf8'));
  // Compare the applied PostgreSQL catalog with generator metadata, not SQL text.
  // Future generated DROP/ALTER commands must address constraints that really exist.
  const snapshot = JSON.parse(await readFile(new URL('../drizzle/meta/0052_snapshot.json', import.meta.url), 'utf8'));
  const actionCodes: Record<string,string> = {'no action':'a',restrict:'r',cascade:'c','set null':'n','set default':'d'};
  for (const name of ['sway_ro_business_bindings', 'sway_ro_proposals', 'sway_ro_approvals', 'sway_ro_operations']) {
    const table = snapshot.tables[`public.${name}`];
    const { rows } = await pg.query<{name:string;type:string;columns:string[];reference:string;referenced_columns:string[];delete_action:string;update_action:string}>(`
      SELECT c.conname::text AS name, c.contype::text AS type,
        ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num,pos)
          JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.pos) AS columns,
        target.relname::text AS reference,
        ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num,pos)
          JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num ORDER BY k.pos) AS referenced_columns,
        c.confdeltype::text AS delete_action, c.confupdtype::text AS update_action
      FROM pg_constraint c JOIN pg_class original ON original.oid=c.conrelid
        LEFT JOIN pg_class target ON target.oid=c.confrelid
      WHERE original.relname=$1 AND c.contype IN ('f','u') ORDER BY c.conname`, [name]);
    const expected = [
      ...Object.values(table.foreignKeys).map((fk: any) => ({name:fk.name,type:'f',columns:fk.columnsFrom,
        reference:fk.tableTo,referenced_columns:fk.columnsTo,
        delete_action:actionCodes[fk.onDelete],update_action:actionCodes[fk.onUpdate]})),
      ...Object.values(table.uniqueConstraints).map((unique: any) => ({name:unique.name,type:'u',columns:unique.columns}))
    ].sort((a,b) => a.name.localeCompare(b.name));
    const actual = rows.map(row => row.type === 'f' ? row : ({name:row.name,type:row.type,columns:row.columns}));
    assert.deepEqual(actual, expected, `${name}: applied constraints must match the migration snapshot`);
  }
  await pg.query('INSERT INTO users VALUES($1),($2)', [owner, stranger]);
  await pg.query('INSERT INTO performers(id,owner_user_id,bio) VALUES($1,$2,$3)', [performer,owner,'original']);
  await pg.query(`INSERT INTO sway_ro_business_bindings(id,performer_id,owner_id,business_id,tenant_id,provider,account_id,asset_kind,provider_verified,owner_authorized,verified_at,expires_at,revision,evidence_reference)
    VALUES($1,$2,$3,'business-1','tenant-1','fixture-provider','business-account-1','business-page',true,true,now(),now()+interval '1 hour','binding-1','isolated-trusted-connector-fixture')`, [binding,performer,owner]);
  let service = createSwayReverseOsmosisService(drizzle(pg), owner);
  const request = (eventId: string = randomUUID(), fields = { bio:'approved bio',headline:'Artist',city:'Paris' }, version='0', direction: 'social-to-native' | 'native-to-social'='social-to-native', causalProvenance?: string) => ({bindingId:binding,direction,eventId,sourceVersion:version,expectedNativeVersion:version,fields,...(causalProvenance ? {causalProvenance} : {})});
  const review = (p: any) => ({payloadDigest:p.proposal.payloadDigest,expectedNativeVersion:p.proposal.expectedNativeVersion,businessBindingRevision:p.proposal.businessBindingRevision});
  const p = await service.createProposal(request());
  await assert.rejects(service.run(p.id,randomUUID()), /exact-approval-required/);
  await assert.rejects(service.approveExact(p.id,{...review(p),payloadDigest:'forged'}), /review-mismatch/);
  const a = await service.approveExact(p.id,review(p));
  assert.equal((await service.run(p.id,a.id)).status,'completed');
  assert.deepEqual((await Promise.all([service.run(p.id,a.id),service.run(p.id,a.id)])).map(o=>o.status),['completed','completed']);
  assert.equal((await service.run(p.id,a.id)).status,'completed');
  assert.equal((await service.status(performer)).nativeVersion,'1');
  assert.equal((await pg.query<{bio:string}>('SELECT bio FROM performers')).rows[0].bio,'approved bio');
  assert.equal((await pg.query('SELECT * FROM audit_events')).rows.length,1);
  const exactReflection = await service.createProposal(request(randomUUID(),{bio:'approved bio',headline:'Artist',city:'Paris'},'1','native-to-social',p.proposal.operationKey));
  const exactReflectionApproval = await service.approveExact(exactReflection.id,review(exactReflection));
  assert.equal((await service.run(exactReflection.id,exactReflectionApproval.id)).status,'reflected');
  await assert.rejects(createSwayReverseOsmosisService(drizzle(pg),owner,{performerId:randomUUID()}).approveExact(p.id,review(p)),/selected-profile-mismatch/);
  await assert.rejects(createSwayReverseOsmosisService(drizzle(pg),stranger).readOutcome(p.id),/proposal-not-found/);
  await assert.rejects(service.createProposal(request(p.proposal.eventId,{bio:'collision',headline:'Artist',city:'Paris'})),/operation-payload-conflict/);
  await assert.rejects(pg.query('UPDATE sway_ro_proposals SET proposal=$1 WHERE id=$2',[{},p.id]),/immutable/);
  const conflict = await service.createProposal(request(randomUUID(),{bio:'conflict',headline:'Artist',city:'Paris'},'1'));
  const conflictApproval = await service.approveExact(conflict.id,review(conflict));
  await pg.exec('UPDATE performers SET public_profile_revision=2');
  await assert.rejects(service.run(conflict.id,conflictApproval.id),/native-version-conflict/);
  const revoked = await service.createProposal(request(randomUUID(),{bio:'revoked',headline:'Artist',city:'Paris'},'2'));
  const ra = await service.approveExact(revoked.id,review(revoked));
  await pg.exec('UPDATE sway_ro_business_bindings SET revoked=true');
  await assert.rejects(service.run(revoked.id,ra.id),/business-asset-required/);
  await pg.exec('UPDATE sway_ro_business_bindings SET revoked=false');
  const consentRevoked = await service.createProposal(request(randomUUID(),{bio:'no consent',headline:'Artist',city:'Paris'},'2'));
  const consent = await service.approveExact(consentRevoked.id,review(consentRevoked));
  await pg.query('UPDATE sway_ro_approvals SET revoked_at=now() WHERE id=$1',[consent.id]);
  await assert.rejects(service.run(consentRevoked.id,consent.id),/exact-approval-required/);
  await assert.rejects(pg.query('UPDATE sway_ro_approvals SET revoked_at=null WHERE id=$1',[consent.id]),/immutable/);
  await pg.exec("UPDATE sway_ro_business_bindings SET business_id='sibling-business'");
  await assert.rejects(service.run(revoked.id,ra.id),/business-asset-required|proposal-integrity|business-binding-changed/);
  await pg.exec("UPDATE sway_ro_business_bindings SET business_id='business-1'");
  for (const kind of ['personal','unknown']) {
    await pg.query('UPDATE sway_ro_business_bindings SET asset_kind=$1',[kind]);
    await assert.rejects(service.createProposal(request()),/business-asset-required/);
  }
  await pg.exec("UPDATE sway_ro_business_bindings SET asset_kind='business-page',verified_at=now()-interval '61 seconds'");
  await assert.rejects(service.createProposal(request()),/business-asset-required/);
  await pg.exec('UPDATE sway_ro_business_bindings SET verified_at=now()');
  const reflected = await service.createProposal(request(randomUUID(),{bio:'approved bio',headline:'Artist',city:'Paris'},'2','native-to-social',p.proposal.operationKey));
  // The causal source version is wrong (2 versus receipt 1), so it must reach a real hold.
  const reflectedApproval = await service.approveExact(reflected.id,review(reflected));
  assert.equal((await service.run(reflected.id,reflectedApproval.id)).status,'held');
  const blocked = await service.createProposal(request(randomUUID(),{bio:'bypass',headline:'Artist',city:'Paris'},'2'));
  const ba = await service.approveExact(blocked.id,review(blocked));
  await assert.rejects(service.run(blocked.id,ba.id),/target-reconciliation-required/);
  await pg.close(); pg = new PGlite(directory); service = createSwayReverseOsmosisService(drizzle(pg),owner);
  assert.equal((await service.readOutcome(reflected.id))?.status,'held');
  assert.equal((await service.reconcile(reflected.id)).status,'held');
  await assert.rejects(service.run(blocked.id,ba.id),/target-reconciliation-required/);
  await pg.exec("UPDATE sway_ro_operations SET status='absent' WHERE status='held'"); // Explicit test-only owner verifier.
  const crash = await service.createProposal(request(randomUUID(),{bio:'crash',headline:'Artist',city:'Paris'},'2'));
  const ca = await service.approveExact(crash.id,review(crash));
  await pg.query(`INSERT INTO sway_ro_operations(operation_key,proposal_id,payload_digest,approval_id,claim_token,status) VALUES($1,$2,$3,$4,$5,'claimed')`,[crash.proposal.operationKey,crash.id,crash.proposal.payloadDigest,ca.id,randomUUID()]);
  await pg.close(); pg = new PGlite(directory); service = createSwayReverseOsmosisService(drizzle(pg),owner);
  assert.equal((await service.run(crash.id,ca.id)).status,'held');
  assert.equal((await service.status(performer)).fields.bio,'approved bio');
  await pg.exec("UPDATE sway_ro_operations SET status='absent' WHERE status='claimed'");
  let syntheticCalls = 0;
  const uncertainService = createSwayReverseOsmosisService(drizzle(pg),owner,{performerId:performer,publish:async () => { syntheticCalls++; throw new Error('fixture transport ambiguous'); }});
  const uncertain = await uncertainService.createProposal(request(randomUUID(),{bio:'approved bio',headline:'Artist',city:'Paris'},'2','native-to-social','forged-origin'));
  const ua = await uncertainService.approveExact(uncertain.id,review(uncertain));
  await assert.rejects(uncertainService.run(uncertain.id,ua.id),/effect-uncertain-reconciliation-required/);
  assert.equal(syntheticCalls,1);
  assert.equal((await uncertainService.run(uncertain.id,ua.id)).status,'held');
  assert.equal(syntheticCalls,1);
  await pg.close(); pg = new PGlite(directory); service=createSwayReverseOsmosisService(drizzle(pg),owner);
  assert.equal((await service.reconcile(uncertain.id)).status,'held');
  await pg.exec('UPDATE sway_ro_business_bindings SET revoked=true');
  assert.equal((await service.status(performer)).bindings.length,0);
  assert.equal((await service.readStoredOutcome(uncertain.id))?.status,'held');
  await assert.rejects(service.run(uncertain.id,ua.id),/business-asset-required/);
  await assert.rejects(createSwayReverseOsmosisService(drizzle(pg),stranger).readStoredOutcome(uncertain.id),/proposal-not-found/);
  const otherPerformer=randomUUID();
  await pg.query('INSERT INTO performers(id,owner_user_id) VALUES($1,$2)',[otherPerformer,owner]);
  await assert.rejects(createSwayReverseOsmosisService(drizzle(pg),owner,{performerId:otherPerformer}).readStoredOutcome(uncertain.id),/selected-profile-mismatch/);
  console.log('PASS Sway native PGlite flow: immutable exact approval, CAS/replay, owner isolation, central policy, collision, uncertain target fence, reopen crash/hold. No provider acceptance claimed.');
} finally { await pg.close(); await rm(directory,{recursive:true,force:true}); }
