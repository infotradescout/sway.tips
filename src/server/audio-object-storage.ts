import type { Readable } from 'node:stream';
import { createLocalAudioObjectStore } from './audio-object-storage-local';
import { createR2AudioObjectStore } from './audio-object-storage-r2';

export type AudioStorageProvider = 'local_private_fs' | 'r2';

export type AudioObjectIdentity = {
  storageProvider: AudioStorageProvider;
  storageBucket: string;
  storageKey: string;
  providerUploadId?: string;
};

export type AudioUploadPartReference = {
  partNumber: number;
  etag: string;
};

export type AudioObjectStore = {
  provider: AudioStorageProvider;
  bucket: string;
  isEnabled: boolean;
  durability: 'development' | 'object_storage';
  verifyReady: () => Promise<void>;
  beginUpload: (input: {
    projectId: string;
    uploadSessionId: string;
    filename: string;
    mimeType: string;
  }) => Promise<AudioObjectIdentity>;
  abortUpload: (identity: AudioObjectIdentity) => Promise<void>;
  writePart: (input: {
    identity: AudioObjectIdentity;
    partNumber: number;
    body: Buffer;
  }) => Promise<{ etag: string; checksum: string; byteSize: number }>;
  assembleParts: (input: {
    identity: AudioObjectIdentity;
    parts: AudioUploadPartReference[];
    expectedByteSize: number;
    expectedSha256: string;
    mimeType: string;
  }) => Promise<{ byteSize: number; sha256: string }>;
  openOriginal: (identity: AudioObjectIdentity) => Promise<{
    stream: Readable;
    byteSize: number;
  }>;
};

export function parseAudioStorageProvider(value: string): AudioStorageProvider {
  if (value === 'local_private_fs' || value === 'r2') return value;
  throw new Error(`Unsupported SWAY_AUDIO_STORAGE_PROVIDER: ${value}`);
}

export function createConfiguredAudioObjectStore(env: NodeJS.ProcessEnv = process.env): AudioObjectStore | null {
  const rawProvider = (env.SWAY_AUDIO_STORAGE_PROVIDER || '').trim();
  if (!rawProvider) return null;
  const provider = parseAudioStorageProvider(rawProvider);

  if (provider === 'r2') return createR2AudioObjectStore(env);
  if (env.NODE_ENV === 'production') {
    throw new Error('Production audio storage requires SWAY_AUDIO_STORAGE_PROVIDER=r2.');
  }
  return createLocalAudioObjectStore(env);
}
