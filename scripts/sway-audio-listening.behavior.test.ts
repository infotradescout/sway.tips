import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import express from 'express';
import type { S3Client } from '@aws-sdk/client-s3';
import { createLocalAudioObjectStore } from '../src/server/audio-object-storage-local';
import { createR2AudioObjectStore } from '../src/server/audio-object-storage-r2';
import { resolveAudioByteRange } from '../src/server/audio-byte-range';
import { sendPrivateAudioListeningResponse } from '../src/server/audio-listening-response';
import type { AudioFileCollaborationService } from '../src/server/audio-file-collaboration-service';
import { createAudioFileCollaborationService } from '../src/server/audio-file-collaboration-service';
import type { SwayDb } from '../src/db/client';

const body = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
const size = body.length;
const sha256 = createHash('sha256').update(body).digest('hex');
const root = mkdtempSync(join(dirname(process.cwd()), 'audio-listening-proof-'));
const local = createLocalAudioObjectStore({ SWAY_AUDIO_LOCAL_BUCKET: 'proof', SWAY_AUDIO_LOCAL_OBJECT_DIR: root });
const identity = await local.beginUpload({ projectId: randomUUID(), uploadSessionId: randomUUID(), filename: 'sample.wav', mimeType: 'audio/wav' });
const part = await local.writePart({ identity, partNumber: 1, body });
await local.assembleParts({ identity, parts: [{ partNumber: 1, etag: part.etag }], expectedByteSize: size, expectedSha256: sha256, mimeType: 'audio/wav' });
async function bytes(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
const version = { byteSize: size, sha256, mimeType: 'audio/wav' };
const etag = `"sha256:${sha256}"`;
const openedStreams: Readable[] = [];
const service = {
  async listenToGrantedOriginal(input: { userId: string; rangeHeader?: string; ifRange?: string }) {
    if (input.userId !== 'authorized') throw Object.assign(new Error('denied'), { status: 403 });
    const range = resolveAudioByteRange(input.ifRange && input.ifRange !== etag ? undefined : input.rangeHeader, size);
    const object = await local.openOriginal(identity, range);
    openedStreams.push(object.stream);
    return { version, ...object, etag, range };
  }
} as Pick<AudioFileCollaborationService, 'listenToGrantedOriginal'>;
const app = express();
app.get('/files/:grantId/listen', (req, res) => sendPrivateAudioListeningResponse(req, res, service, req.get('x-proof-user') || ''));
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const address = server.address();
assert.ok(address && typeof address === 'object');
const url = `http://127.0.0.1:${address.port}/files/private/listen`;
const get = (headers: Record<string, string> = {}, method = 'GET') => fetch(url, { method, headers: { 'x-proof-user': 'authorized', ...headers } });
try {
  for (const [header, start, end] of [
    ['bytes=0-0', 0, 0], ['bytes=4-11', 4, 11], ['bytes=30-', 30, size - 1],
    ['bytes=-7', size - 7, size - 1], ['bytes=20-999', 20, size - 1], ['bytes=-999', 0, size - 1]
  ] as const) {
    const response = await get({ range: header });
    assert.equal(response.status, 206, header);
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${size}`);
    assert.equal(response.headers.get('content-length'), String(end - start + 1));
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('content-disposition'), 'inline');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), body.subarray(start, end + 1));
  }
  for (const range of ['bytes=-0', 'bytes=36-', 'bytes=5-3', 'bytes=-', 'bytes=9007199254740992-', 'bytes=abc-1']) {
    const before = openedStreams.length;
    const response = await get({ range });
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get('content-range'), `bytes */${size}`);
    assert.equal(openedStreams.length, before, 'Invalid range must not read any bytes.');
    await response.arrayBuffer();
  }
  const fullRequests: Array<Record<string, string>> = [
    {}, { range: 'items=0-3' }, { range: 'bytes=0-2,5-8' }, { range: 'bytes=0-3', 'if-range': '"old-version"' }
  ];
  for (const headers of fullRequests) {
    const response = await get(headers);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(response.headers.get('etag'), etag);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
  }
  const matched = await get({ range: 'bytes=0-3', 'if-range': etag });
  assert.equal(matched.status, 206);
  assert.equal(await matched.text(), '0123');
  const head = await get({ range: 'bytes=0-3' }, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(size));
  assert.equal(await head.text(), '');
  assert.equal(openedStreams.at(-1)?.destroyed, true, 'HEAD must close the unused provider stream.');
  const beforeDenied = openedStreams.length;
  const denied = await get({ 'x-proof-user': 'other', range: 'bytes=999-' });
  assert.equal(denied.status, 403, 'Authorization must precede range/size disclosure.');
  assert.equal(denied.headers.get('content-range'), null);
  await denied.arrayBuffer();
  assert.equal(openedStreams.length, beforeDenied);

  const range = { start: 3, end: 9, totalBytes: size };
  let responseMode = 'valid';
  let providerStream: Readable | undefined;
  const client = { async send(command: { input: Record<string, unknown> }) {
    assert.equal(command.input.Range, 'bytes=3-9', 'R2 must request just the needed bytes.');
    providerStream = Readable.from(body.subarray(3, 10));
    return { Body: providerStream, ContentLength: 7, ContentRange: responseMode === 'valid' ? `bytes 3-9/${size}` : `bytes 0-6/${size}` };
  } } as unknown as Pick<S3Client, 'send'>;
  const r2 = createR2AudioObjectStore({ SWAY_AUDIO_R2_ACCOUNT_ID: 'fixture', SWAY_AUDIO_R2_ACCESS_KEY_ID: 'fixture', SWAY_AUDIO_R2_SECRET_ACCESS_KEY: 'fixture', SWAY_AUDIO_R2_BUCKET: 'proof-bucket' }, { client });
  const r2Identity = { storageProvider: 'r2' as const, storageBucket: 'proof-bucket', storageKey: 'masters/proof.wav' };
  const r2Audio = await r2.openOriginal(r2Identity, range);
  assert.deepEqual(await bytes(r2Audio.stream), body.subarray(3, 10));
  responseMode = 'wrong-range';
  await assert.rejects(r2.openOriginal(r2Identity, range), /does not match/);
  assert.equal(providerStream?.destroyed, true, 'An incorrect provider range must close without returning bytes.');
  await assert.rejects(local.openOriginal(identity, { ...range, totalBytes: size + 1 }), /no longer matches/);
  const original = await local.openOriginal(identity);
  assert.deepEqual(await bytes(original.stream), body, 'Listening must leave the sealed original unchanged.');
  const failingStream = new Readable({ read() {} });
  const grant = { id: randomUUID(), connectionId: randomUUID(), assetVersionId: randomUUID(), granteeUserId: 'authorized', grantedByUserId: 'owner', canDownloadOriginal: true };
  const connection = { id: grant.connectionId, memberOneUserId: 'authorized', memberTwoUserId: 'owner' };
  let queryCount = 0;
  let auditWrites = 0;
  const fakeDb = {
    select() {
      const query = { from() { return query; }, where() { return query; }, async limit() {
        queryCount += 1;
        if (queryCount === 4) {
          // Exactly after storage opens, while the service awaits its second
          // grant lookup; no HTTP pipeline has been attached yet.
          failingStream.destroy(new Error('upstream socket reset during access recheck'));
          await new Promise(resolve => setImmediate(resolve));
        }
        return queryCount === 3
          ? [{ ...version, id: grant.assetVersionId, integrityStatus: 'verified', originalPreserved: true, ...identity }]
          : [queryCount === 2 || queryCount === 5 ? connection : grant];
      } };
      return query;
    },
    insert() { return { async values() { auditWrites += 1; } }; }
  } as unknown as SwayDb;
  const failureService = createAudioFileCollaborationService({ db: fakeDb, store: { ...local, async openOriginal() { return { stream: failingStream, byteSize: size }; } } });
  await assert.rejects(
    failureService.listenToGrantedOriginal({ grantId: grant.id, userId: 'authorized' }),
    /audio stream ended before the listening response/,
    'Provider failure during async permission checks must reject without an uncaught stream error.'
  );
  assert.equal(auditWrites, 0, 'The failed read must stop before writing a successful listening-access event.');
  console.log('Private audio HTTP listening passed: exact ranges, suffix/seek, 416, If-Range, HEAD, no-store, authority-before-size, R2 range validation and unchanged original.');
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  rmSync(root, { recursive: true, force: true });
}
