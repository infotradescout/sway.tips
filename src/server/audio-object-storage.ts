import type { Readable } from 'node:stream';
import { createLocalAudioObjectStore } from './audio-object-storage-local';
import { createR2AudioObjectStore } from './audio-object-storage-r2';
import { createNeonAudioObjectStore } from './audio-object-storage-neon';
import type { AudioS3StoreDependencies } from './audio-object-storage-s3';

export type AudioStorageProvider = 'local_private_fs' | 'r2' | 'neon';

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
  // Failure-only cleanup. Unlike abortUpload, this may remove a temporary
  // completed object and an unsealed target created before integrity failed.
  discardUpload?: (identity: AudioObjectIdentity) => Promise<void>;
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
  if (value === 'local_private_fs' || value === 'r2' || value === 'neon') return value;
  throw new Error(`Unsupported SWAY_AUDIO_STORAGE_PROVIDER: ${value}`);
}

export function createConfiguredAudioObjectStore(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: Partial<Record<'r2' | 'neon', AudioS3StoreDependencies>> = {}
): AudioObjectStore | null {
  const rawProvider = (env.SWAY_AUDIO_STORAGE_PROVIDER || '').trim();
  if (!rawProvider) return null;
  const provider = parseAudioStorageProvider(rawProvider);

  function createStore(selected: AudioStorageProvider) {
    if (selected === 'r2') return createR2AudioObjectStore(env, dependencies.r2);
    if (selected === 'neon') return createNeonAudioObjectStore(env, dependencies.neon);
    if (env.NODE_ENV === 'production') {
      throw new Error('Production audio storage requires SWAY_AUDIO_STORAGE_PROVIDER=r2 or neon; local_private_fs is development-only.');
    }
    return createLocalAudioObjectStore(env);
  }

  const primary = createStore(provider);
  const additional = (env.SWAY_AUDIO_STORAGE_READ_PROVIDERS || '').trim();
  if (!additional) return primary;
  const stores = new Map<AudioStorageProvider, AudioObjectStore>([[provider, primary]]);
  for (const name of additional.split(',')) {
    const selected = parseAudioStorageProvider(name.trim());
    if (!stores.has(selected)) stores.set(selected, createStore(selected));
  }

  function storeFor(identity: AudioObjectIdentity) {
    const store = stores.get(identity.storageProvider);
    if (!store || store.bucket !== identity.storageBucket) {
      throw new Error('No configured audio store matches the persisted object identity.');
    }
    return store;
  }

  function writableStoreFor(identity: AudioObjectIdentity) {
    const store = storeFor(identity);
    if (store !== primary) {
      throw new Error('The persisted audio provider is configured for read-only access.');
    }
    return store;
  }

  // New uploads use the selected provider. Legacy reads match the persisted
  // provider AND bucket. A cloned preview must never mutate an extra backend.
  // Errors never retry on another backend.
  return {
    ...primary,
    async verifyReady() {
      await Promise.all([...stores.values()].map((store) => store.verifyReady()));
    },
    async abortUpload(identity) { await writableStoreFor(identity).abortUpload(identity); },
    async discardUpload(identity) {
      const store = writableStoreFor(identity);
      if (!store.discardUpload) throw new Error('The configured audio store cannot discard failed uploads.');
      await store.discardUpload(identity);
    },
    async writePart(input) { return writableStoreFor(input.identity).writePart(input); },
    async assembleParts(input) { return writableStoreFor(input.identity).assembleParts(input); },
    async openOriginal(identity) { return storeFor(identity).openOriginal(identity); }
  };
}
