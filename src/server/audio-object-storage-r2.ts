import { S3Client } from '@aws-sdk/client-s3';
import type { AudioObjectStore } from './audio-object-storage';
import { createS3AudioObjectStore, type AudioS3StoreDependencies } from './audio-object-storage-s3';

function requireValue(env: NodeJS.ProcessEnv, name: string) {
  const value = (env[name] || '').trim();
  if (!value) throw new Error(`R2 audio storage requires ${name}.`);
  return value;
}

export function createR2AudioObjectStore(
  env: NodeJS.ProcessEnv,
  dependencies: AudioS3StoreDependencies = {}
): AudioObjectStore {
  const accountId = requireValue(env, 'SWAY_AUDIO_R2_ACCOUNT_ID');
  const accessKeyId = requireValue(env, 'SWAY_AUDIO_R2_ACCESS_KEY_ID');
  const secretAccessKey = requireValue(env, 'SWAY_AUDIO_R2_SECRET_ACCESS_KEY');
  const bucket = requireValue(env, 'SWAY_AUDIO_R2_BUCKET');
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error('SWAY_AUDIO_R2_BUCKET must be a valid private R2 bucket name.');
  }

  const client = dependencies.client ?? new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true
  });
  return createS3AudioObjectStore({ provider: 'r2', label: 'R2', bucket, client });
}
