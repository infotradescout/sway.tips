import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AUDIO_HASH_CHUNK_SIZE_BYTES, chunkFileForUpload, sha256FileHex } from '../src/audio-upload-client';

const reference = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
let passed = 0;
async function check(name: string, run: () => Promise<void> | void) {
  await run(); passed++; console.log(`PASS ${name}`);
}

await check('Exact digests match independent Node crypto across block and read boundaries', async () => {
  for (const size of [0, 1, 55, 56, 63, 64, 65, AUDIO_HASH_CHUNK_SIZE_BYTES - 1, AUDIO_HASH_CHUNK_SIZE_BYTES, AUDIO_HASH_CHUNK_SIZE_BYTES + 1, 3 * AUDIO_HASH_CHUNK_SIZE_BYTES + 97]) {
    const bytes = Uint8Array.from({ length: size }, (_, index) => (index * 17 + 31) % 256);
    assert.equal(await sha256FileHex(new File([bytes], 'master.wav')), reference(bytes), `byte size ${size}`);
  }
});
await check('Full-file arrayBuffer is never used and each read stays bounded', async () => {
  const bytes = new Uint8Array(3 * AUDIO_HASH_CHUNK_SIZE_BYTES + 1).fill(157);
  const file = new File([bytes], 'large.wav');
  const slices: number[] = [], progress: number[] = [];
  const originalSlice = file.slice.bind(file);
  Object.defineProperty(file, 'arrayBuffer', { value: () => { throw new Error('Whole-file allocation forbidden'); } });
  Object.defineProperty(file, 'slice', { value: (start: number, end: number) => {
    slices.push(end - start); return originalSlice(start, end);
  } });
  assert.equal(await sha256FileHex(file, { onProgress: (done, total) => { assert.equal(total, bytes.length); progress.push(done); } }), reference(bytes));
  assert.equal(slices.length, 4); assert(Math.max(...slices) <= AUDIO_HASH_CHUNK_SIZE_BYTES);
  assert.equal(progress[0], 0); assert.equal(progress.at(-1), bytes.length);
  assert(progress.every((value, index) => !index || value >= progress[index - 1]));
});
await check('An aborted selection reads no bytes', async () => {
  const controller = new AbortController(); controller.abort();
  const file = new File(['never read'], 'canceled.wav');
  Object.defineProperty(file, 'slice', { value: () => { throw new Error('Canceled file was read'); } });
  await assert.rejects(sha256FileHex(file, { signal: controller.signal }), { name: 'AbortError' });
});
await check('Cancellation between chunks stops before another read or final digest', async () => {
  const controller = new AbortController(); let reads = 0;
  const file = new File([new Uint8Array(3 * AUDIO_HASH_CHUNK_SIZE_BYTES)], 'cancel-midway.wav');
  const slice = file.slice.bind(file);
  Object.defineProperty(file, 'slice', { value: (start: number, end: number) => { reads++; return slice(start, end); } });
  await assert.rejects(sha256FileHex(file, {
    signal: controller.signal, onProgress: (done) => { if (done) controller.abort(); }
  }), { name: 'AbortError' });
  assert.equal(reads, 1);
});
await check('Truncated file reads fail without producing a wrong digest', async () => {
  const file = new File(['complete bytes'], 'truncated.wav');
  Object.defineProperty(file, 'slice', { value: () => new Blob(['short']) });
  await assert.rejects(sha256FileHex(file), /complete file could not be read/);
});
await check('Hashing yields to pending work before finishing large files', async () => {
  let yielded = false;
  const file = new File([new Uint8Array(3 * AUDIO_HASH_CHUNK_SIZE_BYTES)], 'responsive.wav');
  const timer = setTimeout(() => { yielded = true; }, 0);
  await sha256FileHex(file); clearTimeout(timer); assert.equal(yielded, true);
});
await check('Multipart slices preserve all bytes and reject non-progressing part sizes', async () => {
  const file = new File(['0123456789'], 'parts.wav');
  const parts = chunkFileForUpload(file, 3);
  assert.deepEqual(parts.map(part => part.size), [3, 3, 3, 1]);
  assert.equal(await new Blob(parts).text(), await file.text());
  for (const size of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => chunkFileForUpload(file, size), /positive whole-number/);
});
console.log(JSON.stringify({ passed, failed: 0, proof: 'Exact digest and bounded reads; browser responsiveness on real devices remains a separate gate.' }));
