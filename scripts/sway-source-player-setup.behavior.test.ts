import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareSourcePlayer, SourcePlayerAccessError, validateBoothDownload } from '../src/source-player-setup';

const room = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const bytes = Buffer.from('@echo off\r\necho synthetic booth fixture\r\n');
const fixture = () => ({ gigId: room, command: 'node synthetic-bridge --synthetic-only', windowsLauncher: {
  filename: 'sway-booth-11111111.cmd', contentType: 'application/x-msdos-program',
  contentBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'),
  expiresAt: new Date(Date.now() + 60_000).toISOString()
} });
const originalFetch = globalThis.fetch;
let checks = 0;
async function check(name: string, run: () => Promise<void>) {
  await run(); checks++; console.log(`SOURCE_PLAYER_BEHAVIOR_PASS ${name}`);
}
try {
  await check('exact server-shaped bytes and identity', async () => {
    const result = await validateBoothDownload(fixture(), room);
    assert.deepEqual(Buffer.from(result.bytes), bytes);
    assert.equal(result.filename, 'sway-booth-11111111.cmd');
  });
  const invalid: Array<[string, (value: any) => unknown]> = [
    ['foreign room', f => ({ ...f, gigId: other })], ['missing envelope', () => null],
    ['malformed envelope', () => []], ['missing launcher', f => ({ ...f, windowsLauncher: null })],
    ['foreign filename', f => ({ ...f, windowsLauncher: { ...f.windowsLauncher, filename: 'sway-booth-22222222.cmd' } })],
    ...Object.entries({ contentType: 'text/html', contentBase64: '', sha256: '0'.repeat(64), expiresAt: 'yesterday' }).map(([key, value]) =>
      [`invalid ${key}`, (f: any) => ({ ...f, windowsLauncher: { ...f.windowsLauncher, [key]: value } })] as [string, (value: any) => unknown]),
    ['bad base64 alphabet', f => ({ ...f, windowsLauncher: { ...f.windowsLauncher, contentBase64: '!!!!' } })],
    ['bad base64 length', f => ({ ...f, windowsLauncher: { ...f.windowsLauncher, contentBase64: 'abc' } })],
    ['oversized file', f => ({ ...f, windowsLauncher: { ...f.windowsLauncher, contentBase64: 'a'.repeat(1_000_004) } })],
    ['expired file', f => ({ ...f, windowsLauncher: { ...f.windowsLauncher, expiresAt: new Date(Date.now() - 1000).toISOString() } })],
    ['excessive lifetime', f => ({ ...f, windowsLauncher: { ...f.windowsLauncher, expiresAt: new Date(Date.now() + 8 * 3_600_000).toISOString() } })]
  ];
  for (const [name, change] of invalid) await check(name, async () => { await assert.rejects(validateBoothDownload(change(fixture()), room)); });
  await check('bad room cannot submit', async () => {
    globalThis.fetch = (async () => { throw new Error('Unexpected fetch'); }) as typeof fetch;
    await assert.rejects(prepareSourcePlayer('not-a-room', new AbortController()), /Select a live room/);
  });
  await check('one exact room POST without credential persistence', async () => {
    let calls = 0;
    globalThis.fetch = (async (url, init) => {
      calls++; assert.equal(url, '/api/talent/control-bridge/token'); assert.equal(init?.method, 'POST');
      assert.equal(init?.cache, 'no-store'); assert.deepEqual(JSON.parse(String(init?.body)), { gig_id: room });
      return { status: 200, ok: true, json: async () => fixture() } as Response;
    }) as typeof fetch;
    await prepareSourcePlayer(room, new AbortController()); assert.equal(calls, 1);
  });
  for (const status of [401, 403]) await check(`access loss ${status}`, async () => {
    globalThis.fetch = async () => new Response(null, { status });
    await assert.rejects(prepareSourcePlayer(room, new AbortController()), SourcePlayerAccessError);
  });
  await check('failed request never retries itself', async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; throw new TypeError('Synthetic failure'); }) as typeof fetch;
    await assert.rejects(prepareSourcePlayer(room, new AbortController())); assert.equal(calls, 1);
  });
  await check('pre-aborted request never posts', async () => {
    let calls = 0; globalThis.fetch = (async () => { calls++; throw new Error('Unexpected fetch'); }) as typeof fetch;
    const controller = new AbortController(); controller.abort();
    await assert.rejects(prepareSourcePlayer(room, controller), /cancelled/); assert.equal(calls, 0);
  });
  for (const bodyHold of [false, true]) await check(bodyHold ? 'whole-body deadline' : 'abort-insensitive fetch deadline', async () => {
    let calls = 0; const stalled = new Promise<Response>(() => {});
    globalThis.fetch = (async () => { calls++; return bodyHold ? { status: 200, ok: true, json: () => stalled } : stalled; }) as typeof fetch;
    const controller = new AbortController();
    await assert.rejects(prepareSourcePlayer(room, controller, 20), /may have replaced/);
    assert.equal(controller.signal.aborted, true); assert.equal(calls, 1);
  });
  await check('late response after cancellation remains rejected', async () => {
    let release: (value: Response) => void = () => {};
    globalThis.fetch = (() => new Promise<Response>(resolve => { release = resolve; })) as typeof fetch;
    const controller = new AbortController(); const pending = prepareSourcePlayer(room, controller);
    controller.abort(); await assert.rejects(pending, /interrupted/);
    release({ status: 200, ok: true, json: async () => fixture() } as Response);
    await new Promise(resolve => setTimeout(resolve, 10));
  });
  console.log(`SOURCE_PLAYER_BEHAVIOR_COMPLETE ${checks}`);
} finally { globalThis.fetch = originalFetch; }
