import type { Readable } from 'node:stream';
import { sql } from 'drizzle-orm';
import type { SwayDb } from '../db/client';

type Executor = Pick<SwayDb, 'execute'>;
const restricted = () => Object.assign(new Error('This audio file is unavailable while candidate moderation restricts it.'), {
  status: 410, code: 'candidate_moderation_restricted'
});

export async function assertAudioCandidateModeration(executor: Executor, candidateId: string) {
  const result = await executor.execute<{ owner_decision: string | null; moderation_status: string | null }>(sql`
    select decision.decision as owner_decision,
      (select status::text from moderation_events where entity_type = 'audio_candidate_revision' and entity_id = candidate.id
       order by created_at desc, id desc limit 1) as moderation_status
    from audio_candidate_revisions candidate
    left join audio_candidate_owner_decisions decision on decision.candidate_id = candidate.id
    where candidate.id = ${candidateId}::uuid
  `);
  const row = result.rows[0];
  if (row?.owner_decision === 'blocked' || ['held_for_review', 'blocked'].includes(row?.moderation_status ?? '')) throw restricted();
}

/** Uses the immutable promotion relation, never editable metadata or a filename. */
export async function listRestrictedAudioVersionIds(executor: Executor, versionIds: string[]) {
  if (!versionIds.length) return new Set<string>();
  const result = await executor.execute<{ version_id: string }>(sql`
    select decision.promoted_version_id as version_id
    from audio_candidate_owner_decisions decision
    join audio_candidate_revisions candidate on candidate.id = decision.candidate_id
    join audio_project_asset_versions version on version.id = decision.promoted_version_id
    left join lateral (
      select status from moderation_events where entity_type = 'audio_candidate_revision' and entity_id = candidate.id
      order by created_at desc, id desc limit 1
    ) latest on true
    where decision.promoted_version_id in (${sql.join([...new Set(versionIds)].map(id => sql`${id}::uuid`), sql`, `)})
      and (decision.decision <> 'accepted' or version.upload_session_id <> candidate.upload_session_id
        or version.sha256 <> candidate.sha256 or version.byte_size <> candidate.byte_size
        or latest.status in ('held_for_review', 'blocked'))
  `);
  return new Set(result.rows.map(row => row.version_id));
}

export async function assertAudioVersionCandidateModeration(executor: Executor, versionId: string) {
  if ((await listRestrictedAudioVersionIds(executor, [versionId])).has(versionId.toLowerCase())) throw restricted();
}

/** Call within the release mutation transaction so a concurrent hold serializes with its commit. */
export async function lockAudioVersionCandidateModeration(executor: Executor, versionId: string) {
  await executor.execute(sql`
    select performer.id from audio_candidate_owner_decisions decision
    join performers performer on performer.id = decision.performer_id
    where decision.promoted_version_id = ${versionId}::uuid for share of performer
  `);
  await assertAudioVersionCandidateModeration(executor, versionId);
}

export async function openAudioVersionWithCandidateModeration<T extends { stream: Readable }>(
  executor: Executor, versionId: string, open: () => Promise<T>
): Promise<T> {
  await assertAudioVersionCandidateModeration(executor, versionId);
  const object = await open();
  let streamFailure: Error | null = null;
  object.stream.on('error', (error: Error) => { streamFailure = error; });
  const requireReadable = () => {
    if (streamFailure || object.stream.destroyed) throw new Error('Audio storage failed before the response.', { cause: streamFailure });
  };
  try {
    requireReadable();
    await assertAudioVersionCandidateModeration(executor, versionId);
    requireReadable();
    return object;
  } catch (error) {
    object.stream.destroy();
    throw error;
  }
}
