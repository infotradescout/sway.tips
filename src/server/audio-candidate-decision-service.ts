import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { SwayDb } from '../db/client';

export type AudioCandidateOwnerDecision = 'accepted' | 'rejected' | 'blocked';

export type AudioCandidateDecisionRecord = {
  id: string;
  candidateId: string;
  projectId: string;
  performerId: string;
  actorUserId: string;
  decision: AudioCandidateOwnerDecision;
  promotedVersionId: string | null;
  reason: string | null;
  createdAt: Date;
};

type PersistedDecision = AudioCandidateDecisionRecord & {
  idempotencyKeyHash: string;
  intentFingerprint: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decisionColumns = sql`
  id, candidate_id as "candidateId", project_id as "projectId", performer_id as "performerId",
  actor_user_id as "actorUserId", decision, promoted_version_id as "promotedVersionId", reason,
  created_at as "createdAt", idempotency_key_hash as "idempotencyKeyHash", intent_fingerprint as "intentFingerprint"
`;

function fail(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { status, code });
}

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function publicDecision(record: PersistedDecision): AudioCandidateDecisionRecord {
  const { idempotencyKeyHash: _key, intentFingerprint: _intent, ...decision } = record;
  return decision;
}

function databaseCode(error: unknown): string | undefined {
  let current = error;
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if ('code' in current && typeof current.code === 'string') return current.code;
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

/** Private owner review. No storage copy, source mutation, rights declaration or release change. */
export function createAudioCandidateDecisionService({ db }: { db: SwayDb }) {
  async function decideCandidate(input: {
    candidateId: string;
    actorUserId: string;
    decision: AudioCandidateOwnerDecision;
    idempotencyKey: string;
    reason?: string | null;
  }): Promise<{ decision: AudioCandidateDecisionRecord; replayed: boolean }> {
    if (!UUID.test(input.candidateId) || !UUID.test(input.actorUserId)) {
      throw fail(400, 'invalid_candidate_decision', 'A valid candidate and signed-in owner are required.');
    }
    if (!['accepted', 'rejected', 'blocked'].includes(input.decision)) {
      throw fail(400, 'invalid_candidate_decision', 'Choose accept, reject or block for this candidate.');
    }
    const key = typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';
    if (!key || key.length > 200) {
      throw fail(400, 'invalid_candidate_decision_key', 'An idempotency key of 1–200 characters is required.');
    }
    if (input.reason !== undefined && input.reason !== null && typeof input.reason !== 'string') {
      throw fail(400, 'invalid_candidate_decision_reason', 'The decision reason must be text.');
    }
    const reason = input.reason?.trim() || null;
    if ((reason?.length ?? 0) > 2000 || (input.decision === 'blocked' && !reason)) {
      throw fail(400, 'invalid_candidate_decision_reason', 'Blocking requires a reason; decision reasons may contain up to 2,000 characters.');
    }
    const candidateId = input.candidateId.toLowerCase();
    const actorUserId = input.actorUserId.toLowerCase();
    const idempotencyKeyHash = hash(key);
    const intentFingerprint = hash(JSON.stringify({ candidateId, actorUserId, decision: input.decision, reason }));

    try {
      return await db.transaction(async (tx) => {
        // The DB function locks ownership, active authority and candidate state before
        // an idempotency read or write. Revocation and another owner decision serialize.
        await tx.execute(sql`select sway_require_audio_candidate_decision_authority(
          ${candidateId}::uuid, ${actorUserId}::uuid, ${false}
        )`);
        const keyed = await tx.execute<PersistedDecision>(sql`
          select ${decisionColumns} from audio_candidate_owner_decisions
          where actor_user_id = ${actorUserId}::uuid and idempotency_key_hash = ${idempotencyKeyHash}
        `);
        const replay = keyed.rows[0];
        if (replay) {
          if (replay.intentFingerprint !== intentFingerprint || replay.candidateId !== candidateId) {
            throw fail(409, 'candidate_decision_idempotency_conflict', 'This decision key already belongs to a different review action.');
          }
          return { decision: publicDecision(replay), replayed: true };
        }
        const previous = await tx.execute<{ id: string }>(sql`
          select id from audio_candidate_owner_decisions where candidate_id = ${candidateId}::uuid
        `);
        if (previous.rows.length) {
          throw fail(409, 'candidate_already_decided', 'This candidate already has a final owner decision.');
        }

        const id = randomUUID();
        const promotedVersionId = input.decision === 'accepted' ? randomUUID() : null;
        const inserted = await tx.execute<PersistedDecision>(sql`
          insert into audio_candidate_owner_decisions
            (id, candidate_id, project_id, performer_id, actor_user_id, decision, promoted_version_id,
             idempotency_key_hash, intent_fingerprint, reason)
          select ${id}::uuid, candidate.id, candidate.project_id, candidate.performer_id,
            ${actorUserId}::uuid, ${input.decision}, ${promotedVersionId}::uuid,
            ${idempotencyKeyHash}, ${intentFingerprint}, ${reason}
          from audio_candidate_revisions candidate where candidate.id = ${candidateId}::uuid
          returning ${decisionColumns}
        `);
        const decision = inserted.rows[0];
        if (!decision) throw fail(404, 'candidate_unavailable', 'The private candidate is unavailable.');

        if (promotedVersionId) {
          // All versions of an asset serialize here; acceptance retains the candidate's
          // exact stored original and collaborator uploader. The database binds every
          // field to the immutable acceptance and candidate before allowing sealing.
          await tx.execute(sql`
            select asset.id from audio_assets asset
            join audio_candidate_revisions candidate on candidate.asset_id = asset.id
            where candidate.id = ${candidateId}::uuid for update of asset
          `);
          await tx.execute(sql`
            insert into audio_project_asset_versions
              (id, project_id, performer_id, asset_id, uploaded_by_user_id, upload_session_id,
               version_number, original_filename, storage_provider, storage_bucket, storage_key,
               provider_version_id, mime_type, byte_size, sha256, duration_ms, codec, sample_rate_hz,
               bit_depth, channel_count, integrity_status, integrity_verifier_key, integrity_verified_at,
               integrity_evidence, original_preserved, metadata, sealed_at)
            select ${promotedVersionId}::uuid, candidate.project_id, candidate.performer_id, candidate.asset_id,
              candidate.uploaded_by_user_id, candidate.upload_session_id,
              (select coalesce(max(version.version_number), 0) + 1 from audio_project_asset_versions version
               where version.asset_id = candidate.asset_id),
              candidate.original_filename, candidate.storage_provider, candidate.storage_bucket, candidate.storage_key,
              candidate.provider_version_id, candidate.mime_type, candidate.byte_size, candidate.sha256,
              candidate.duration_ms, candidate.codec, candidate.sample_rate_hz, candidate.bit_depth,
              candidate.channel_count, candidate.integrity_status, candidate.integrity_verifier_key,
              candidate.integrity_verified_at, candidate.integrity_evidence, candidate.original_preserved,
              jsonb_build_object('candidateRevisionId', candidate.id, 'sourceAssetVersionId', candidate.source_asset_version_id,
                'ownerDecisionId', ${id}::uuid), clock_timestamp()
            from audio_candidate_revisions candidate where candidate.id = ${candidateId}::uuid
          `);
        }
        return { decision: publicDecision(decision), replayed: false };
      });
    } catch (error) {
      if (databaseCode(error) === '42501') {
        throw fail(403, 'candidate_decision_forbidden', 'Current owner authority is required and held or blocked candidates cannot be accepted.');
      }
      if (databaseCode(error) === '23505') {
        throw fail(409, 'candidate_decision_conflict', 'This candidate or decision key already has a final review action. Refresh to read its result.');
      }
      throw error;
    }
  }

  return { decideCandidate };
}
