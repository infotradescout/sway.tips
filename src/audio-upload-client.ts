export const AUDIO_UPLOAD_PART_SIZE_BYTES = 5 * 1024 * 1024;

export async function sha256FileHex(file: File) {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function chunkFileForUpload(file: File, partSizeBytes = AUDIO_UPLOAD_PART_SIZE_BYTES) {
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
