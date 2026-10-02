import { S3Client } from '@aws-sdk/client-s3';
import type { AudioObjectStore } from './audio-object-storage';
import { createS3AudioObjectStore, type AudioS3StoreDependencies } from './audio-object-storage-s3';

function requireValue(env: NodeJS.ProcessEnv, name: string) {
  const value = (env[name] || '').trim();
  if (!value) throw new Error(`Neon audio storage requires ${name}.`);
  return value;
}

export function createNeonAudioObjectStore(
  env: NodeJS.ProcessEnv,
  dependencies: AudioS3StoreDependencies = {}
): AudioObjectStore {
  const endpoint = requireValue(env, 'AWS_ENDPOINT_URL_S3');
  const region = requireValue(env, 'AWS_REGION');
  const accessKeyId = requireValue(env, 'AWS_ACCESS_KEY_ID');
  const secretAccessKey = requireValue(env, 'AWS_SECRET_ACCESS_KEY');
  const bucket = requireValue(env, 'SWAY_AUDIO_NEON_BUCKET');
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('AWS_ENDPOINT_URL_S3 must be an HTTPS storage endpoint origin.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('AWS_ENDPOINT_URL_S3 must be an HTTPS storage endpoint origin.');
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(region)) {
    throw new Error('AWS_REGION must be a valid storage region.');
  }
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error('SWAY_AUDIO_NEON_BUCKET must be a valid private bucket name.');
  }

  const client = dependencies.client ?? new S3Client({
    endpoint: url.origin,
    region,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED'
  });
  // Neon documents multipart completion, but not CopyObject. The private
  // object becomes downloadable only after Sway verifies and seals its row.
  return createS3AudioObjectStore({
    provider: 'neon', label: 'Neon', bucket, client, multipartTarget: 'master'
  });
}
