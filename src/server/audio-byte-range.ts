export type AudioByteRange = { start: number; end: number; totalBytes: number };

export class AudioRangeNotSatisfiableError extends Error {
  readonly status = 416;
  constructor(readonly totalBytes: number) {
    super('The requested audio range is not available.');
  }
}

export function assertAudioByteRange(range: AudioByteRange) {
  if (![range.start, range.end, range.totalBytes].every(Number.isSafeInteger)
    || range.start < 0 || range.end < range.start || range.end >= range.totalBytes) {
    throw new AudioRangeNotSatisfiableError(range.totalBytes);
  }
}

// Browser media requests use one range. Unknown units and multipart ranges are
// ignored, so they receive the complete representation rather than a false 206.
export function resolveAudioByteRange(
  header: string | undefined,
  totalBytes: number
): AudioByteRange | undefined {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
    throw new Error('Sealed audio is missing a valid byte size.');
  }
  if (!header || !/^bytes=/i.test(header) || header.includes(',')) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || (!match[1] && !match[2])) throw new AudioRangeNotSatisfiableError(totalBytes);
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first))
    || (last !== null && !Number.isSafeInteger(last))) {
    throw new AudioRangeNotSatisfiableError(totalBytes);
  }
  const start = first === null ? Math.max(0, totalBytes - last!) : first;
  const end = first === null || last === null ? totalBytes - 1 : Math.min(last, totalBytes - 1);
  const range = { start, end, totalBytes };
  assertAudioByteRange(range);
  return range;
}

export function audioContentRange(range: AudioByteRange) {
  return `bytes ${range.start}-${range.end}/${range.totalBytes}`;
}
