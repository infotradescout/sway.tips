import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { createSwayDb } from '../src/db/client.ts';
import { audioFileConnections, audioProjectAccessGrants, performers, users } from '../src/db/schema.ts';
import { createLocalAudioObjectStore } from '../src/server/audio-object-storage-local.ts';
import { createAudioPublishingService } from '../src/server/audio-publishing-service.ts';
import { createAudioFileCollaborationService } from '../src/server/audio-file-collaboration-service.ts';
import { createAudioCandidateDecisionService } from '../src/server/audio-candidate-decision-service.ts';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof.ts';
import { candidateDecisionProofMode } from './lib/candidate-decision-proof-mode.mjs';

const proofMode = candidateDecisionProofMode();
const strict = proofMode === 'real-postgres';
if (strict) process.env.SWAY_REQUIRE_REAL_POSTGRES_PROOF = 'true';
const proof = await startEmbeddedPostgresProof('audio_candidate_decisions');
assert.equal(proof.kind, proofMode, 'The selected fixture must match the explicit proof intent.');
const db = createSwayDb(proof.databaseUrl);
const objectRoot = mkdtempSync(join(dirname(process.cwd()), 'sway-candidate-decision-proof-'));
const digest = (body) => createHash('sha256').update(body).digest('hex');
const chainMatches = (error, pattern) => {
  for (let current = error; current; current = current.cause) if (pattern.test(current.message || '')) return true;
  return false;
};
function wav(label) {
  const body = Buffer.alloc(844, 128);
  body.write('RIFF', 0); body.writeUInt32LE(836, 4); body.write('WAVE', 8);
  body.write('fmt ', 12); body.writeUInt32LE(16, 16); body.writeUInt16LE(1, 20);
  body.writeUInt16LE(1, 22); body.writeUInt32LE(8000, 24); body.writeUInt32LE(8000, 28);
  body.writeUInt16LE(1, 32); body.writeUInt16LE(8, 34); body.write('data', 36); body.writeUInt32LE(800, 40);
  Buffer.from(label).copy(body, 44);
  return body;
}
async function bytes(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

try {
  const [ownerId, collaboratorId, outsiderId] = [randomUUID(), randomUUID(), randomUUID()].sort();
  const adminId = randomUUID();
  await db.insert(users).values([ownerId, collaboratorId, outsiderId].map((id) => ({
    id, email: `candidate-decision-${id}@example.test`, emailVerifiedAt: new Date()
  })));
  await db.insert(users).values({ id: adminId, role: 'admin', email: `candidate-moderation-admin-${adminId}@example.test` });
  const [performer] = await db.insert(performers).values({ ownerUserId: ownerId, displayName: 'Owner review proof' }).returning();
  const [otherPerformer] = await db.insert(performers).values({ ownerUserId: outsiderId, displayName: 'Other performer proof' }).returning();
  const localStore = createLocalAudioObjectStore({ SWAY_AUDIO_LOCAL_OBJECT_DIR: objectRoot, SWAY_AUDIO_LOCAL_BUCKET: 'candidate-owner-proof' });
  let afterObjectOpen = null;
  let lastOpenedStream = null;
  const store = {
    ...localStore,
    async openOriginal(identity, range) {
      const object = await localStore.openOriginal(identity, range);
      lastOpenedStream = object.stream;
      if (afterObjectOpen) await afterObjectOpen();
      return object;
    }
  };
  await store.verifyReady();
  const publishing = createAudioPublishingService({ db, store, collaboratorRevisionUploadsEnabled: true, workingObjectLimit: 100 });
  const collaboration = createAudioFileCollaborationService({
    db, store, collaboratorRevisionUploadsEnabled: true,
    beforeGrantRevocation: (tx, input) => publishing.reserveCollaboratorRevisionAuthorityCleanupIntent(tx, {
      actorUserId: input.actorUserId, grantId: input.grantId, cleanupReason: 'candidate_grant_revoked'
    }).then(() => undefined)
  });
  const decisions = createAudioCandidateDecisionService({ db });
  const project = await publishing.createProject({ performerId: performer.id, actorUserId: ownerId, title: 'Owner review' });
  async function capability(decision) {
    await db.execute(sql`
      insert into performer_capability_grant_events
        (performer_id, capability, decision, actor_type, actor_user_id, reason, evidence, idempotency_key_hash)
      values (${performer.id}::uuid, 'private_collaboration', ${decision}::performer_capability_decision,
        'system', null, 'Disposable candidate decision proof', '{"environment":"test"}'::jsonb, ${digest(randomUUID())})
    `);
  }
  await capability('granted');
  const sourceBody = wav('immutable source original');
  const upload = await publishing.initiateUpload({
    projectId: project.id, actorUserId: ownerId, title: 'Source original', assetKind: 'master_audio',
    originalFilename: 'source.wav', mimeType: 'audio/wav', expectedByteSize: sourceBody.length,
    expectedSha256: digest(sourceBody), idempotencyKey: 'source-original'
  });
  await publishing.writeUploadPart({ uploadSessionId: upload.id, actorUserId: ownerId, partNumber: 1, body: sourceBody });
  const source = await publishing.completeAndSealUpload({ uploadSessionId: upload.id, actorUserId: ownerId, performerId: performer.id });
  const sourceBefore = (await db.execute(sql`select * from audio_project_asset_versions where id = ${source.id}::uuid`)).rows[0];
  const [connection] = await db.insert(audioFileConnections).values({
    memberOneUserId: ownerId, memberTwoUserId: collaboratorId, createdByUserId: ownerId, createdFromPurpose: 'request_files'
  }).returning();
  async function candidate(label) {
    const body = wav(label);
    const { grant } = await collaboration.grantCandidateRevisionUpload({
      connectionId: connection.id, versionId: source.id, grantedByUserId: ownerId,
      idempotencyKey: `grant-${label}`, maxCandidateBytes: 4096
    });
    const session = await publishing.initiateCollaboratorRevisionUpload({
      grantId: grant.id, actorUserId: collaboratorId, originalFilename: `${label}.wav`, mimeType: 'audio/wav',
      expectedByteSize: body.length, expectedSha256: digest(body), idempotencyKey: `upload-${label}`
    });
    await publishing.writeUploadPart({ grantId: grant.id, uploadSessionId: session.id, actorUserId: collaboratorId, partNumber: 1, body });
    const result = await publishing.completeAndSealCollaboratorRevision({ grantId: grant.id, uploadSessionId: session.id, actorUserId: collaboratorId });
    await collaboration.revokeGrant({ grantId: grant.id, userId: ownerId, reason: 'Completed one bounded return; owner review retains the sealed candidate.' });
    return { ...result, body };
  }
  const accept = await candidate('accept');
  const reject = await candidate('reject');
  const block = await candidate('block');
  const held = await candidate('held');
  const concurrent = await candidate('concurrent');
  const authority = await candidate('authority');
  const noCapability = await candidate('capability');

  async function rawDecision(tx, target, { id = randomUUID(), actor = ownerId, decision = 'accepted', versionId = randomUUID(), scopePerformer = performer.id } = {}) {
    await tx.execute(sql`
      insert into audio_candidate_owner_decisions
        (id, candidate_id, project_id, performer_id, actor_user_id, decision, promoted_version_id, idempotency_key_hash, intent_fingerprint)
      values (${id}::uuid, ${target.id}::uuid, ${project.id}::uuid, ${scopePerformer}::uuid, ${actor}::uuid,
        ${decision}, ${decision === 'accepted' ? versionId : null}::uuid, ${digest(randomUUID())}, ${digest(randomUUID())})
    `);
    return { id, versionId };
  }
  async function rawVersion(tx, target, { versionId = randomUUID(), decisionId = randomUUID(), changedHash = null } = {}) {
    await tx.execute(sql`
      insert into audio_project_asset_versions
        (id, project_id, performer_id, asset_id, uploaded_by_user_id, upload_session_id, version_number,
         original_filename, storage_provider, storage_bucket, storage_key, provider_version_id, mime_type, byte_size,
         sha256, duration_ms, codec, sample_rate_hz, bit_depth, channel_count, integrity_status, integrity_verifier_key,
         integrity_verified_at, integrity_evidence, original_preserved, metadata)
      select ${versionId}::uuid, project_id, performer_id, asset_id, uploaded_by_user_id, upload_session_id, 99,
        original_filename, storage_provider, storage_bucket, storage_key, provider_version_id, mime_type, byte_size,
        coalesce(${changedHash}::text, sha256), duration_ms, codec, sample_rate_hz, bit_depth, channel_count,
        integrity_status, integrity_verifier_key, integrity_verified_at, integrity_evidence, original_preserved,
        jsonb_build_object('candidateRevisionId', id, 'sourceAssetVersionId', source_asset_version_id, 'ownerDecisionId', ${decisionId}::uuid)
      from audio_candidate_revisions where id = ${target.id}::uuid
    `);
  }

  // Direct DB writes cannot use selected-file upload authority to bypass owner review.
  await assert.rejects(rawVersion(db, accept), (error) => chainMatches(error, /exact immutable owner acceptance/));
  await assert.rejects(db.transaction((tx) => rawDecision(tx, accept, { actor: collaboratorId })), (error) => chainMatches(error, /current performer owner/));
  await assert.rejects(db.transaction((tx) => rawDecision(tx, accept, { scopePerformer: otherPerformer.id })), (error) => chainMatches(error, /scope must match/));
  await assert.rejects(db.transaction((tx) => rawDecision(tx, accept)), (error) => chainMatches(error, /foreign key|exact newly sealed/));
  await assert.rejects(db.transaction(async (tx) => {
    const decision = await rawDecision(tx, accept);
    await rawVersion(tx, accept, { versionId: decision.versionId, decisionId: decision.id, changedHash: 'f'.repeat(64) });
  }), (error) => chainMatches(error, /exact immutable owner acceptance/));
  assert.equal((await db.execute(sql`select count(*)::integer as count from audio_candidate_owner_decisions`)).rows[0].count, 0);

  await assert.rejects(decisions.decideCandidate({ candidateId: accept.id, actorUserId: collaboratorId, decision: 'accepted', idempotencyKey: 'not-owner' }), (error) => error.status === 403);
  await assert.rejects(decisions.decideCandidate({ candidateId: accept.id, actorUserId: outsiderId, decision: 'accepted', idempotencyKey: 'other-performer' }), (error) => error.status === 403);
  const usageBeforeAcceptance = await publishing.getStorageUsage({ performerId: performer.id });
  const accepted = await decisions.decideCandidate({ candidateId: accept.id, actorUserId: ownerId, decision: 'accepted', idempotencyKey: 'accept-one', reason: 'Approved as an additional private working version.' });
  const usageAfterAcceptance = await publishing.getStorageUsage({ performerId: performer.id });
  assert.deepEqual(usageAfterAcceptance, usageBeforeAcceptance, 'Acceptance reuses the exact sealed object; bytes and object quota must not double-count it.');
  assert.equal(accepted.replayed, false);
  assert.ok(accepted.decision.promotedVersionId);
  const promoted = (await db.execute(sql`select * from audio_project_asset_versions where id = ${accepted.decision.promotedVersionId}::uuid`)).rows[0];
  assert.equal(promoted.sha256, accept.sha256);
  assert.equal(Number(promoted.byte_size), accept.body.length);
  assert.equal(promoted.uploaded_by_user_id, collaboratorId);
  assert.equal(promoted.upload_session_id, accept.uploadSessionId);
  assert.equal(promoted.asset_id, source.assetId);
  assert.equal(promoted.version_number, 2);
  assert.equal(promoted.metadata.sourceAssetVersionId, source.id);
  assert.equal(promoted.metadata.candidateRevisionId, accept.id);
  assert.equal(promoted.metadata.ownerDecisionId, accepted.decision.id);
  const replay = await decisions.decideCandidate({ candidateId: accept.id, actorUserId: ownerId, decision: 'accepted', idempotencyKey: 'accept-one', reason: 'Approved as an additional private working version.' });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.decision, accepted.decision);
  await assert.rejects(decisions.decideCandidate({ candidateId: accept.id, actorUserId: ownerId, decision: 'rejected', idempotencyKey: 'accept-one' }), (error) => error.status === 409);
  await assert.rejects(decisions.decideCandidate({ candidateId: reject.id, actorUserId: ownerId, decision: 'accepted', idempotencyKey: 'accept-one' }), (error) => error.status === 409);
  await assert.rejects(decisions.decideCandidate({ candidateId: accept.id, actorUserId: ownerId, decision: 'accepted', idempotencyKey: 'different-key' }), (error) => error.status === 409);
  await assert.rejects(db.execute(sql`update audio_candidate_owner_decisions set reason = 'rewrite' where id = ${accepted.decision.id}::uuid`), (error) => chainMatches(error, /immutable|append-only/i));
  await assert.rejects(db.execute(sql`delete from audio_candidate_owner_decisions where id = ${accepted.decision.id}::uuid`), (error) => chainMatches(error, /immutable|append-only/i));
  await assert.rejects(db.execute(sql`update audio_project_asset_versions set sha256 = ${'a'.repeat(64)} where id = ${promoted.id}::uuid`), (error) => chainMatches(error, /immutable|append-only/i));
  assert.equal((await db.execute(sql`select count(*)::integer as count from music_releases where performer_id = ${performer.id}::uuid`)).rows[0].count, 0,
    'Owner acceptance must not create any release.');

  const reviewShare = await collaboration.shareVersion({
    connectionId: connection.id, versionId: promoted.id, grantedByUserId: ownerId, canDownloadOriginal: true
  });
  const tokenShare = await publishing.createShareGrant({ versionId: promoted.id, actorUserId: ownerId, maxUses: 100 });
  const aliases = [
    { name: 'owner catalog', read: () => publishing.openOwnedVersion({ versionId: promoted.id, actorUserId: ownerId }) },
    { name: 'selected-file download', read: () => collaboration.downloadGrantedOriginal({ grantId: reviewShare.grant.id, userId: collaboratorId }) },
    { name: 'selected-file listening', read: () => collaboration.listenToGrantedOriginal({ grantId: reviewShare.grant.id, userId: collaboratorId }) },
    { name: 'selected-file range', read: () => collaboration.listenToGrantedOriginal({ grantId: reviewShare.grant.id, userId: collaboratorId, rangeHeader: 'bytes=0-15' }), expected: accept.body.subarray(0, 16) },
    { name: 'private share token', read: () => publishing.downloadSharedOriginal({ rawToken: tokenShare.rawToken, actorUserId: ownerId }) },
    { name: 'candidate content', read: () => collaboration.openCandidateRevision({ grantId: accept.fileAccessGrantId, candidateId: accept.id, userId: ownerId }) }
  ];
  async function moderate(target, status, actor = ownerId) {
    await db.execute(sql`insert into moderation_events (actor_user_id, entity_type, entity_id, status, reason)
      values (${actor}::uuid, 'audio_candidate_revision', ${target.id}::uuid, ${status}::moderation_status, 'Disposable alias moderation proof')`);
  }
  for (const alias of aliases) {
    assert.deepEqual(await bytes((await alias.read()).stream), alias.expected ?? accept.body, `${alias.name} must work before a hold.`);
  }
  const releaseInput = {
    clientReleaseId: randomUUID(), performerId: performer.id, actorUserId: ownerId, projectId: project.id,
    masterAssetVersionId: promoted.id, title: 'Explicit owner draft', trackTitle: 'Accepted working version',
    primaryArtistName: 'Owner proof', songwriterName: 'Owner proof', releaseType: 'single',
    lyricsAuthorship: 'human', compositionAuthorship: 'human', vocalPerformance: 'human', productionMethod: 'human'
  };
  const explicitDraft = await publishing.createReleaseDraft(releaseInput);
  await moderate(accept, 'held_for_review');
  for (const alias of aliases) await assert.rejects(alias.read(), (error) => error.status === 410, `${alias.name} must honor the later candidate hold.`);
  const candidateAsVersion = { ...accept, id: promoted.id };
  await assert.rejects(publishing.validateReleasePackageAsset({ version: candidateAsVersion, roles: ['recording_master:proof'] }), (error) => error.status === 410);
  await assert.rejects(publishing.createReleaseDraft({ ...releaseInput, clientReleaseId: randomUUID() }), (error) => error.status === 410);
  const heldWorkspace = await publishing.listReleaseWorkspace({ performerId: performer.id, actorUserId: ownerId });
  assert.equal(heldWorkspace.masters.some(version => version.versionId === promoted.id), false);
  assert.equal(heldWorkspace.releases.find(release => release.id === explicitDraft.release.id).readiness.moderationIssues.length, 1);
  assert.deepEqual(await bytes((await publishing.openOwnedVersion({ versionId: source.id, actorUserId: ownerId })).stream), sourceBody,
    'A later candidate hold must not restrict the untouched source version.');
  await assert.rejects(moderate(accept, 'allowed', ownerId), (error) => chainMatches(error, /only an administrator may clear a hold/));
  await moderate(accept, 'allowed', adminId);
  for (const alias of aliases) assert.deepEqual(await bytes((await alias.read()).stream), alias.expected ?? accept.body, `${alias.name} restores after valid administrator clearance.`);
  assert.equal((await publishing.listReleaseWorkspace({ performerId: performer.id, actorUserId: ownerId })).releases
    .find(release => release.id === explicitDraft.release.id).readiness.moderationIssues.length, 0);

  // A hold committed while the provider opens must close that opened stream and
  // deny every alias before bytes are handed to an HTTP response or parser.
  for (const alias of [...aliases, { name: 'release package validation', read: () => publishing.validateReleasePackageAsset({ version: candidateAsVersion, roles: ['recording_master:proof'] }) }]) {
    afterObjectOpen = () => moderate(accept, 'held_for_review');
    try {
      await assert.rejects(alias.read(), (error) => error.status === 410, `${alias.name} must recheck moderation after opening storage.`);
      assert.equal(lastOpenedStream.destroyed, true, `${alias.name} must dispose its denied provider stream.`);
    } finally { afterObjectOpen = null; }
    await moderate(accept, 'allowed', adminId);
  }

  const rejected = await decisions.decideCandidate({ candidateId: reject.id, actorUserId: ownerId, decision: 'rejected', idempotencyKey: 'reject-one', reason: 'Please retain the original arrangement.' });
  assert.equal(rejected.decision.promotedVersionId, null);
  await assert.rejects(decisions.decideCandidate({ candidateId: reject.id, actorUserId: ownerId, decision: 'accepted', idempotencyKey: 'reject-cannot-accept' }), (error) => error.status === 409);
  await assert.rejects(rawVersion(db, reject), (error) => chainMatches(error, /exact immutable owner acceptance/));
  await assert.rejects(decisions.decideCandidate({ candidateId: block.id, actorUserId: ownerId, decision: 'blocked', idempotencyKey: 'missing-block-reason' }), (error) => error.status === 400);
  const blocked = await decisions.decideCandidate({ candidateId: block.id, actorUserId: ownerId, decision: 'blocked', idempotencyKey: 'block-one', reason: 'Unwanted return: retain the audit record and prevent acceptance.' });
  assert.equal(blocked.decision.promotedVersionId, null);
  assert.equal((await db.execute(sql`select status from moderation_events where entity_type = 'audio_candidate_revision' and entity_id = ${block.id}::uuid`)).rows[0].status, 'blocked');
  await assert.rejects(collaboration.openCandidateRevision({ grantId: block.fileAccessGrantId, candidateId: block.id, userId: ownerId }), (error) => error.status === 410);
  await moderate(block, 'allowed', adminId);
  await assert.rejects(collaboration.openCandidateRevision({ grantId: block.fileAccessGrantId, candidateId: block.id, userId: ownerId }), (error) => error.status === 410,
    'Administrator clearance cannot undo a terminal owner block.');
  await assert.rejects(decisions.decideCandidate({ candidateId: block.id, actorUserId: ownerId, decision: 'accepted', idempotencyKey: 'blocked-cannot-accept' }), (error) => error.status === 409);
  await db.execute(sql`insert into moderation_events (actor_user_id, entity_type, entity_id, status, reason) values (${ownerId}::uuid, 'audio_candidate_revision', ${held.id}::uuid, 'held_for_review', 'Pending review')`);
  await assert.rejects(db.execute(sql`insert into moderation_events (actor_user_id, entity_type, entity_id, status, reason) values (${outsiderId}::uuid, 'audio_candidate_revision', ${held.id}::uuid, 'allowed', 'Unauthorized clearance')`), (error) => chainMatches(error, /current owner or an administrator/));
  await assert.rejects(db.execute(sql`insert into moderation_events (actor_user_id, entity_type, entity_id, status, reason) values (${ownerId}::uuid, 'audio_candidate_revision', ${held.id}::uuid, 'allowed', 'Owner cannot override a moderation hold')`), (error) => chainMatches(error, /only an administrator may clear a hold/));
  await assert.rejects(db.execute(sql`update moderation_events set status = 'allowed' where entity_type = 'audio_candidate_revision' and entity_id = ${held.id}::uuid`), (error) => chainMatches(error, /moderation events are immutable/));
  await assert.rejects(db.execute(sql`delete from moderation_events where entity_type = 'audio_candidate_revision' and entity_id = ${held.id}::uuid`), (error) => chainMatches(error, /moderation events are immutable/));
  await assert.rejects(decisions.decideCandidate({ candidateId: held.id, actorUserId: ownerId, decision: 'accepted', idempotencyKey: 'held-cannot-accept' }), (error) => error.status === 403);
  assert.equal((await db.execute(sql`select count(*)::integer as count from audio_candidate_owner_decisions where candidate_id = ${held.id}::uuid`)).rows[0].count, 0);

  const competing = await Promise.allSettled([
    decisions.decideCandidate({ candidateId: concurrent.id, actorUserId: ownerId, decision: 'accepted', idempotencyKey: 'race-accept' }),
    decisions.decideCandidate({ candidateId: concurrent.id, actorUserId: ownerId, decision: 'rejected', idempotencyKey: 'race-reject' })
  ]);
  assert.equal(competing.filter((result) => result.status === 'fulfilled').length, 1);
  const loser = competing.find((result) => result.status === 'rejected');
  assert.equal(loser.reason.status, 409);
  assert.equal((await db.execute(sql`select count(*)::integer as count from audio_candidate_owner_decisions where candidate_id = ${concurrent.id}::uuid`)).rows[0].count, 1);

  await capability('revoked');
  await assert.rejects(decisions.decideCandidate({ candidateId: noCapability.id, actorUserId: ownerId, decision: 'accepted', idempotencyKey: 'without-capability' }), (error) => error.status === 403);
  await capability('granted');
  await db.update(performers).set({ ownerUserId: outsiderId }).where(eq(performers.id, performer.id));
  await assert.rejects(decisions.decideCandidate({ candidateId: authority.id, actorUserId: ownerId, decision: 'accepted', idempotencyKey: 'former-owner' }), (error) => error.status === 403);
  await assert.rejects(decisions.decideCandidate({ candidateId: authority.id, actorUserId: outsiderId, decision: 'accepted', idempotencyKey: 'new-owner-no-project-authority' }), (error) => error.status === 403);
  // The bootstrap owner grant is deliberately non-revocable. Exercise revocation
  // using a real revocable project grant issued to the new current owner.
  const [transferredAuthority] = await db.insert(audioProjectAccessGrants).values({
    projectId: project.id, granteeUserId: outsiderId, role: 'collaborator',
    canUploadVersions: true, canManageAccess: true, grantedByUserId: ownerId
  }).returning();
  await db.execute(sql`select sway_require_audio_candidate_decision_authority(${authority.id}::uuid, ${outsiderId}::uuid, true)`);
  await db.update(audioProjectAccessGrants).set({ revokedAt: new Date(), revokedByUserId: ownerId, revocationReason: 'Authority removal proof' }).where(eq(audioProjectAccessGrants.id, transferredAuthority.id));
  await assert.rejects(decisions.decideCandidate({ candidateId: authority.id, actorUserId: outsiderId, decision: 'accepted', idempotencyKey: 'revoked-authority' }), (error) => error.status === 403);
  await db.update(performers).set({ ownerUserId: ownerId }).where(eq(performers.id, performer.id));

  const sourceAfter = (await db.execute(sql`select * from audio_project_asset_versions where id = ${source.id}::uuid`)).rows[0];
  assert.deepEqual(sourceAfter, sourceBefore, 'Review must preserve every field of the immutable source version.');
  const sourceObject = await store.openOriginal(source);
  assert.deepEqual(await bytes(sourceObject.stream), sourceBody);
  const candidateObject = await store.openOriginal(accept);
  assert.deepEqual(await bytes(candidateObject.stream), accept.body);
  assert.equal((await db.execute(sql`select count(*)::integer as count from audio_project_access_grants where project_id = ${project.id}::uuid and grantee_user_id = ${collaboratorId}::uuid`)).rows[0].count, 0);
  assert.equal((await db.execute(sql`select count(*)::integer as count from music_releases where performer_id = ${performer.id}::uuid`)).rows[0].count, 1,
    'Only the explicit owner-created draft exists; the blocked release attempt left no extra draft.');
  assert.equal((await db.execute(sql`select count(*)::integer as count from audit_events where entity_type = 'audio_candidate_revision' and event_type = 'audio_candidate.accepted' and entity_id = ${accept.id}::uuid`)).rows[0].count, 1);
  console.log(`Candidate owner decisions passed on ${proof.kind}: immutable owner acceptance/rejection/blocking, forged-write denial, scope and authority isolation, later moderation across every promoted read alias and release use, post-open denial and stream cleanup, authorized nonterminal clearance, exact provider-object preservation, idempotent replay/conflict and ${strict ? 'independent PostgreSQL concurrency' : 'serialized embedded competing calls'}; owner decisions create no release or collaborator project grant.`);
} finally {
  await proof.close();
  rmSync(objectRoot, { recursive: true, force: true });
}
