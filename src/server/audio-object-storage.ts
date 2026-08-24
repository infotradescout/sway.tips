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

export type AudioUploadPlanInput = {
  projectId: string;
  uploadSessionId: string;
  filename: string;
  mimeType: string;
};

export type AudioUploadReconciliation =
  | { status: 'absent' }
  | { status: 'found'; identity: AudioObjectIdentity }
  | { status: 'ambiguous'; identities: AudioObjectIdentity[] };

export type AudioPartReconciliation =
  | { status: 'absent' }
  | { status: 'confirmed'; etag: string; byteSize: number }
  | { status: 'mismatch'; etag: string | null; byteSize: number | null };

export type AudioAssemblyReconciliation =
  | { status: 'absent' }
  | { status: 'multipart_open' }
  | { status: 'staging'; byteSize: number; sha256: string }
  | { status: 'sealed'; byteSize: number; sha256: string }
  | { status: 'mismatch'; location: 'staging' | 'sealed'; byteSize: number; sha256: string };

export type AudioCleanupReconciliation = {
  status: 'absent' | 'present';
  multipartPresent: boolean;
  stagingPresent: boolean;
  sealedPresent: boolean;
};

export type AudioObjectStore = {
  provider: AudioStorageProvider;
  bucket: string;
  isEnabled: boolean;
  durability: 'development' | 'object_storage';
  verifyReady: () => Promise<void>;
  // Planning is pure and deterministic. Persist this identity before any
  // provider call so a lost response can be reconciled by exact key.
  planUploadIdentity: (input: AudioUploadPlanInput) => AudioObjectIdentity;
  beginUpload: (input: AudioUploadPlanInput & {
    identity?: AudioObjectIdentity;
    signal?: AbortSignal;
  }) => Promise<AudioObjectIdentity>;
  reconcileUpload: (input: {
    identity: AudioObjectIdentity;
    uploadSessionId: string;
    signal?: AbortSignal;
  }) => Promise<AudioUploadReconciliation>;
  abortUpload: (identity: AudioObjectIdentity, options?: { signal?: AbortSignal }) => Promise<void>;
  // Failure-only cleanup. Unlike abortUpload, this may remove a temporary
  // completed object and an unsealed target created before integrity failed.
  discardUpload?: (identity: AudioObjectIdentity, options?: { signal?: AbortSignal }) => Promise<void>;
  writePart: (input: {
    identity: AudioObjectIdentity;
    partNumber: number;
    body: Buffer;
    signal?: AbortSignal;
  }) => Promise<{ etag: string; checksum: string; byteSize: number }>;
  reconcilePart: (input: {
    identity: AudioObjectIdentity;
    partNumber: number;
    expectedByteSize: number;
    expectedMd5: string;
    signal?: AbortSignal;
  }) => Promise<AudioPartReconciliation>;
  assembleParts: (input: {
    identity: AudioObjectIdentity;
    parts: AudioUploadPartReference[];
    expectedByteSize: number;
    expectedSha256: string;
    mimeType: string;
    signal?: AbortSignal;
  }) => Promise<{ byteSize: number; sha256: string }>;
  reconcileAssembly: (input: {
    identity: AudioObjectIdentity;
    expectedByteSize: number;
    expectedSha256: string;
    signal?: AbortSignal;
  }) => Promise<AudioAssemblyReconciliation>;
  reconcileCleanup: (identity: AudioObjectIdentity, options?: { signal?: AbortSignal }) => Promise<AudioCleanupReconciliation>;
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
