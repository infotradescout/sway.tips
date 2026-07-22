import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { createSwayDb } from '../src/db/client.ts';
import { audioProjects, performers, users } from '../src/db/schema.ts';
import { createConfiguredAudioObjectStore } from '../src/server/audio-object-storage.ts';
import { createAudioPublishingService } from '../src/server/audio-publishing-service.ts';

const PROOF_TITLE = 'Production storage proof 2026-07-22';
const PROOF_FILENAME = 'sway-r2-production-proof-2026-07-22.wav';
const SAMPLE_BYTES = 16_000;

function createProofWav() {
  const body = Buffer.alloc(SAMPLE_BYTES);
  const wav = Buffer.alloc(44 + body.length);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + body.length, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8_000, 24);
  wav.writeUInt32LE(16_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(body.length, 40);
  body.copy(wav, 44);
  return wav;
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const accountEmail = process.env.SWAY_AUDIO_PROOF_EMAIL?.trim().toLowerCase();
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');
  if (!accountEmail) throw new Error('SWAY_AUDIO_PROOF_EMAIL is required.');

  const db = createSwayDb(databaseUrl);
  try {
    const [account] = await db.select({ id: users.id }).from(users).where(eq(users.email, accountEmail)).limit(1);
    if (!account) throw new Error('Proof account was not found.');

    const [performer] = await db
      .select({ id: performers.id })
      .from(performers)
      .where(eq(performers.ownerUserId, account.id))
      .limit(1);
    if (!performer) throw new Error('Proof account does not own a performer.');

    const store = createConfiguredAudioObjectStore(process.env);
    await store.verifyReady();
    const service = createAudioPublishingService({ db, store });

    let [project] = await db
      .select({ id: audioProjects.id })
      .from(audioProjects)
      .where(and(eq(audioProjects.performerId, performer.id), eq(audioProjects.title, PROOF_TITLE)))
      .limit(1);
    if (!project) {
      project = await service.createProject({
        performerId: performer.id,
        actorUserId: account.id,
        title: PROOF_TITLE
      });
    }

    const body = createProofWav();
    const sha256 = createHash('sha256').update(body).digest('hex');
    const session = await service.initiateUpload({
      projectId: project.id,
      actorUserId: account.id,
      title: PROOF_FILENAME,
      assetKind: 'master_audio',
      originalFilename: PROOF_FILENAME,
      mimeType: 'audio/wav',
      expectedByteSize: body.length,
      expectedSha256: sha256,
      idempotencyKey: `production-proof:${project.id}:${sha256}:${body.length}`,
      partSizeBytes: 5 * 1024 * 1024
    });

    await service.writeUploadPart({
      uploadSessionId: session.id,
      actorUserId: account.id,
      partNumber: 1,
      body
    });
    const version = await service.completeAndSealUpload({
      uploadSessionId: session.id,
      actorUserId: account.id,
      performerId: performer.id
    });
    const share = await service.createShareGrant({
      versionId: version.id,
      actorUserId: account.id,
      maxUses: 1,
      recipientLabel: 'production-readiness-proof'
    });
    const downloaded = await service.downloadSharedOriginal({
      rawToken: share.rawToken,
      actorUserId: account.id
    });
    const downloadedBody = await readAll(downloaded.stream);
    const downloadedSha256 = createHash('sha256').update(downloadedBody).digest('hex');

    if (!downloadedBody.equals(body)) throw new Error('Downloaded production master bytes differ from the uploaded fixture.');
    if (downloadedSha256 !== sha256 || downloaded.sha256 !== sha256) {
      throw new Error('Downloaded production master SHA-256 evidence does not match.');
    }
    if (downloaded.byteSize !== body.length || version.byteSize !== body.length) {
      throw new Error('Downloaded production master byte-size evidence does not match.');
    }

    console.log(JSON.stringify({
      outcome: 'verified',
      provider: store.provider,
      projectId: project.id,
      uploadSessionId: session.id,
      versionId: version.id,
      shareGrantId: share.grant.id,
      byteSize: body.length,
      sha256,
      exactBytesRecovered: true,
      shareUseCount: 1
    }));
  } finally {
    await db.$client.end();
  }
}

main().catch((error) => {
  console.error(`Production audio proof failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
