import { and, eq, isNull, ne, notIlike } from 'drizzle-orm';
import { createSwayDb } from '../src/db/client.ts';
import {
  audioProjectAccessGrants,
  audioProjectAssetVersions,
  audioProjects,
  audioShareGrants,
  audioUploadSessions,
  users
} from '../src/db/schema.ts';
import { createAudioPublishingService } from '../src/server/audio-publishing-service.ts';

const PROOF_TITLE = 'Production storage proof 2026-07-22';

function requireEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function main() {
  const databaseUrl = requireEnvironment('DATABASE_URL');
  const accountEmail = requireEnvironment('SWAY_AUDIO_PROOF_EMAIL').toLowerCase();
  const appBaseUrl = requireEnvironment('SWAY_APP_BASE_URL').replace(/\/$/, '');
  const db = createSwayDb(databaseUrl);

  try {
    const [markerResponse, runtimeResponse] = await Promise.all([
      fetch(`${appBaseUrl}/api/build-marker`, { headers: { accept: 'application/json' } }),
      fetch(`${appBaseUrl}/api/runtime-config-status`, { headers: { accept: 'application/json' } })
    ]);
    if (!markerResponse.ok) throw new Error(`Build marker returned ${markerResponse.status}.`);
    if (!runtimeResponse.ok) throw new Error(`Runtime status returned ${runtimeResponse.status}.`);

    const marker = await markerResponse.json();
    const runtime = await runtimeResponse.json();
    if (runtime?.audioStorage?.enabled !== true
      || runtime.audioStorage.provider !== 'r2'
      || runtime.audioStorage.objectStorageVerified !== true) {
      throw new Error('Production runtime does not report verified private R2 storage.');
    }

    const [owner] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, accountEmail))
      .limit(1);
    if (!owner) throw new Error('Proof account was not found.');

    const [project] = await db
      .select({ id: audioProjects.id })
      .from(audioProjects)
      .where(and(
        eq(audioProjects.createdByUserId, owner.id),
        eq(audioProjects.title, PROOF_TITLE)
      ))
      .limit(1);
    if (!project) throw new Error('Production proof project was not found.');

    const [upload] = await db
      .select({
        status: audioUploadSessions.uploadStatus,
        completedAt: audioUploadSessions.completedAt,
        expectedByteSize: audioUploadSessions.expectedByteSize,
        expectedSha256: audioUploadSessions.expectedSha256
      })
      .from(audioUploadSessions)
      .where(eq(audioUploadSessions.projectId, project.id))
      .limit(1);
    if (!upload || upload.status !== 'completed' || !upload.completedAt) {
      throw new Error('Production proof upload is not durably completed.');
    }

    const [version] = await db
      .select({
        byteSize: audioProjectAssetVersions.byteSize,
        sha256: audioProjectAssetVersions.sha256,
        integrityStatus: audioProjectAssetVersions.integrityStatus,
        originalPreserved: audioProjectAssetVersions.originalPreserved,
        sealedAt: audioProjectAssetVersions.sealedAt
      })
      .from(audioProjectAssetVersions)
      .where(eq(audioProjectAssetVersions.projectId, project.id))
      .limit(1);
    if (!version
      || version.integrityStatus !== 'verified'
      || version.originalPreserved !== true
      || !version.sealedAt
      || version.byteSize !== upload.expectedByteSize
      || version.sha256 !== upload.expectedSha256) {
      throw new Error('Production sealed-version evidence is incomplete or inconsistent.');
    }

    const [consumedShare] = await db
      .select({ maxUses: audioShareGrants.maxUses, useCount: audioShareGrants.useCount })
      .from(audioShareGrants)
      .where(eq(audioShareGrants.projectId, project.id))
      .limit(1);
    if (!consumedShare || consumedShare.maxUses !== 1 || consumedShare.useCount !== 1) {
      throw new Error('Production one-use share evidence is missing.');
    }

    const unauthenticatedResponse = await fetch(
      `${appBaseUrl}/api/talent/audio/projects/${project.id}/assets`,
      { headers: { accept: 'application/json' }, redirect: 'manual' }
    );
    if (unauthenticatedResponse.status !== 401) {
      throw new Error(`Unauthenticated project access returned ${unauthenticatedResponse.status}, expected 401.`);
    }

    let storageTouched = false;
    const service = createAudioPublishingService({
      db,
      store: {
        provider: 'r2',
        verifyReady: async () => { storageTouched = true; },
        initiateMultipartUpload: async () => { storageTouched = true; throw new Error('Object storage must not be reached.'); },
        uploadPart: async () => { storageTouched = true; throw new Error('Object storage must not be reached.'); },
        completeMultipartUpload: async () => { storageTouched = true; throw new Error('Object storage must not be reached.'); },
        abortMultipartUpload: async () => { storageTouched = true; },
        openOriginal: async () => { storageTouched = true; throw new Error('Object storage must not be reached.'); }
      }
    });

    const ownerPayload = await service.listProjectAssets({ projectId: project.id, actorUserId: owner.id });
    if (!ownerPayload.versions.some((candidate) => candidate.sha256 === version.sha256)) {
      throw new Error('Authorized owner cannot read the sealed proof version.');
    }

    const candidates = await db
      .select({ id: users.id })
      .from(users)
      .where(and(
        ne(users.id, owner.id),
        notIlike(users.email, '%smoke%')
      ))
      .limit(50);

    let unauthorizedActorId = null;
    for (const candidate of candidates) {
      const [grant] = await db
        .select({ id: audioProjectAccessGrants.id })
        .from(audioProjectAccessGrants)
        .where(and(
          eq(audioProjectAccessGrants.projectId, project.id),
          eq(audioProjectAccessGrants.granteeUserId, candidate.id),
          isNull(audioProjectAccessGrants.revokedAt)
        ))
        .limit(1);
      if (!grant) {
        unauthorizedActorId = candidate.id;
        break;
      }
    }
    if (!unauthorizedActorId) {
      throw new Error('No non-smoke production account is available for a read-only cross-account denial proof.');
    }

    let crossAccountDenied = false;
    try {
      await service.listProjectAssets({ projectId: project.id, actorUserId: unauthorizedActorId });
    } catch (error) {
      crossAccountDenied = error instanceof Error && error.message === 'Project access required.';
    }
    if (!crossAccountDenied) throw new Error('Cross-account project access was not denied.');
    if (storageTouched) throw new Error('Denied access reached private object storage.');

    console.log(JSON.stringify({
      outcome: 'verified',
      deployedCommit: marker.commit,
      provider: runtime.audioStorage.provider,
      objectStorageVerified: runtime.audioStorage.objectStorageVerified,
      durableUploadCompleted: true,
      sealedVersionIntegrityVerified: true,
      oneUseShareConsumed: true,
      exactByteSizeRecorded: version.byteSize,
      exactSha256Recorded: version.sha256,
      unauthenticatedHttpDenied: true,
      crossAccountProjectReadDenied: true,
      deniedAccessReachedObjectStorage: false,
      independentRecoveryVerified: false
    }));
  } finally {
    await db.$client.end();
  }
}

main().catch((error) => {
  console.error(`Production audio evidence audit failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
