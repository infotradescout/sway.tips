import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { SwayDb } from '../db/client';
import { audioFileAccessGrants, audioObjectCleanupReceipts, audioProviderOperations, audioUploadSessions, auditEvents } from '../db/schema';
import { EXPIRABLE_AUDIO_UPLOAD_STATUSES } from './audio-storage-policy';

type Transaction = Parameters<Parameters<SwayDb['transaction']>[0]>[0];

/** Record revocation cleanup without needing any configured provider client. */
export async function reserveOfflineAudioRevocationCleanup(tx: Transaction, input: {
  actorUserId: string;
  connectionId?: string;
  grantId?: string;
}) {
  if (Boolean(input.connectionId) === Boolean(input.grantId)) throw new Error('One cleanup scope is required.');
  const grants = await tx.select({ id: audioFileAccessGrants.id }).from(audioFileAccessGrants)
    .where(input.grantId ? eq(audioFileAccessGrants.id, input.grantId) : eq(audioFileAccessGrants.connectionId, input.connectionId!))
    .orderBy(asc(audioFileAccessGrants.id)).for('update');
  if (!grants.length) return;
  const grantIds = grants.map(grant => grant.id);
  const sessions = await tx.select().from(audioUploadSessions).where(and(
    eq(audioUploadSessions.uploadPurpose, 'collaborator_revision'),
    inArray(audioUploadSessions.collaboratorFileGrantId, grantIds),
    inArray(audioUploadSessions.uploadStatus, [...EXPIRABLE_AUDIO_UPLOAD_STATUSES])
  )).orderBy(asc(audioUploadSessions.createdAt), asc(audioUploadSessions.id)).for('update');
  const operations = await tx.select().from(audioProviderOperations).where(and(
    eq(audioProviderOperations.operationType, 'initiate_multipart'), isNull(audioProviderOperations.uploadSessionId),
    inArray(audioProviderOperations.status, ['pending', 'leased', 'reconcile_required', 'awaiting_client_retry']),
    sql`${audioProviderOperations.requestPayload}->>'purpose' = 'collaborator_revision'`,
    inArray(sql`${audioProviderOperations.requestPayload}->>'collaboratorFileGrantId'`, grantIds)
  )).orderBy(asc(audioProviderOperations.createdAt), asc(audioProviderOperations.id)).for('update');
  const cleanupReason = input.connectionId ? 'candidate_connection_revoked' : 'candidate_grant_revoked';
  for (const item of [
    ...sessions.map(session => ({
      projectId: session.projectId, storageProvider: session.storageProvider, storageBucket: session.storageBucket,
      storageKey: session.storageKey, providerUploadId: session.providerUploadId, uploadSessionId: session.id, cleanupReason
    })),
    ...operations.map(operation => ({
      projectId: operation.projectId, storageProvider: operation.storageProvider, storageBucket: operation.storageBucket,
      storageKey: operation.storageKey, providerUploadId: operation.providerUploadId, uploadSessionId: null,
      cleanupReason: 'orphaned_candidate_initiation'
    }))
  ]) {
    const [receipt] = await tx.insert(audioObjectCleanupReceipts).values({
      projectId: item.projectId, actorUserId: input.actorUserId, uploadSessionId: item.uploadSessionId,
      storageProvider: item.storageProvider, storageBucket: item.storageBucket, storageKey: item.storageKey,
      providerUploadId: item.providerUploadId, cleanupReason: item.cleanupReason,
      cleanupStatus: 'pending', attemptCount: 1,
      lastError: 'Private storage is unavailable; authority is revoked and provider cleanup remains pending.',
      lastAttemptAt: new Date()
    }).onConflictDoNothing().returning({ id: audioObjectCleanupReceipts.id });
    if (receipt) {
      await tx.insert(auditEvents).values({
        actorType: 'account', actorId: input.actorUserId,
        entityType: 'audio_object_cleanup_receipt', entityId: receipt.id,
        eventType: 'audio_candidate_revision.offline_cleanup_requested',
        metadata: { cleanupReason, providerConfigured: false, uploadSessionId: item.uploadSessionId }
      });
    }
  }
}
