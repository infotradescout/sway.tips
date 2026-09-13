export const AUDIO_UPLOAD_PART_SIZE_BYTES = 5 * 1024 * 1024;
export const AUDIO_HASH_CHUNK_SIZE_BYTES = 1024 * 1024;

/** Hash exact file bytes with bounded memory; large masters never become one ArrayBuffer. */
export async function sha256FileHex(file: File, options: {
  signal?: AbortSignal;
  onProgress?: (completedBytes: number, totalBytes: number) => void;
} = {}) {
  const checkCanceled = () => options.signal?.throwIfAborted();
  checkCanceled();
  if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error('The file size could not be read.');
  // Load the hashing implementation only for an actual upload.
  const { sha256 } = await import('@noble/hashes/sha2.js');
  checkCanceled();
  const hash = sha256.create();
  try {
    options.onProgress?.(0, file.size);
    for (let offset = 0; offset < file.size; offset += AUDIO_HASH_CHUNK_SIZE_BYTES) {
      checkCanceled();
      const end = Math.min(offset + AUDIO_HASH_CHUNK_SIZE_BYTES, file.size);
      const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
      checkCanceled();
      if (bytes.byteLength !== end - offset) throw new Error('The complete file could not be read. Choose the file again.');
      hash.update(bytes);
      options.onProgress?.(end, file.size);
      // Let input, cancellation and progress paint between bounded chunks.
      if (end < file.size) await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    checkCanceled();
    return Array.from(hash.digest(), byte => byte.toString(16).padStart(2, '0')).join('');
  } finally { hash.destroy(); }
}

export function chunkFileForUpload(file: File, partSizeBytes = AUDIO_UPLOAD_PART_SIZE_BYTES) {
  if (!Number.isSafeInteger(partSizeBytes) || partSizeBytes <= 0) throw new Error('Choose a positive whole-number upload part size.');
  if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error('The file size could not be read.');
  const parts: Blob[] = [];
  for (let offset = 0; offset < file.size; offset += partSizeBytes) {
    parts.push(file.slice(offset, Math.min(offset + partSizeBytes, file.size)));
  }
  return parts;
}

export function resolveAudioUploadMimeType(file: File) {
  if (file.type.toLowerCase().startsWith('audio/')) return file.type.toLowerCase();
  const extension = file.name.split('.').pop()?.toLowerCase();
  const mimeByExtension: Record<string, string> = {
    aac: 'audio/aac',
    aif: 'audio/aiff',
    aiff: 'audio/aiff',
    flac: 'audio/flac',
    m4a: 'audio/x-m4a',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    wav: 'audio/wav'
  };
  return extension ? mimeByExtension[extension] || '' : '';
}
