import express from 'express';

export const AUDIO_UPLOAD_PART_MAX_BYTES = 6 * 1024 * 1024;

// Express validates the character after a regexp middleware match before
// invoking the handler. Keep the separator outside the match so nested upload
// routes reach the raw parser instead of falling through with an empty body.
export const AUDIO_UPLOAD_PART_PATH_PATTERN = /^\/api\/talent\/audio\/uploads(?=\/|$)/;

export function createAudioUploadPartBodyParser() {
  return express.raw({
    type: 'application/octet-stream',
    limit: AUDIO_UPLOAD_PART_MAX_BYTES
  });
}
