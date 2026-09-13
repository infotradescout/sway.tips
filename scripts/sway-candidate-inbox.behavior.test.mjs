import assert from 'node:assert/strict';
import { webcrypto, createHash } from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';

// Actual CollaboratorInbox and installed React/ReactDOM, synthetic HTTP in JSDOM.
// This is component behavior evidence, not browser layout, playback, server authorization or persistence proof.
const bundle = await build({
  stdin: { contents: `import React,{act} from 'react'; import {createRoot} from 'react-dom/client';
    import Inbox from './src/components/CollaboratorInbox.tsx';
    import Files from './src/components/PerformerAudioFiles.tsx';
    window.IS_REACT_ACT_ENVIRONMENT=true; window.__act=act; window.__accepted=0; window.__loaded=[];
    window.__root=createRoot(document.getElementById('root'));
    window.__mount=()=>act(async()=>window.__root.render(window.__ownerCatalog ? React.createElement(Files) : React.createElement(Inbox,{embedded:true,onCandidateAccepted:()=>window.__accepted++,onConnectionsLoaded:(connections)=>window.__loaded.push(connections)})));`,
    resolveDir: process.cwd(), sourcefile: 'candidate-inbox-proof.js', loader: 'js' },
  bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' }
});
const source = { grantId: 'source-grant', connectionId: 'connection', projectTitle: 'Private project', versionId: 'source-version',
  originalFilename: 'source.wav', mimeType: 'audio/wav', byteSize: 3, sha256: 'a'.repeat(64),
  canDownloadOriginal: true, canComment: false, canApprove: false };
const candidate = { ...source, grantId: 'candidate-grant', grantPurpose: 'collaborator_revision_upload',
  canDownloadOriginal: false, canUploadCandidateRevision: true, maxCandidateBytes: 16 * 1024 * 1024,
  candidateId: 'candidate', candidateOriginalFilename: 'returned.wav', candidateMimeType: 'audio/wav', candidateByteSize: 3,
  canDecideCandidate: true, managedByCurrentUser: true };
async function fixture({ incoming = [], outgoing = [candidate], enabled = true, ownerCatalog = false, projectCapabilityIds = [] } = {}) {
  const consoleErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => consoleErrors.push(error.message));
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://sway.test/account/collaboration', runScripts: 'outside-only', virtualConsole });
  const w = dom.window;
  w.__ownerCatalog = ownerCatalog;
  const channels = [];
  w.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this); } };
  Object.defineProperty(w.crypto, 'subtle', { value: webcrypto.subtle });
  const deadlineCallbacks = new Map();
  const originalSetTimeout = w.setTimeout.bind(w), originalClearTimeout = w.clearTimeout.bind(w);
  w.setTimeout = (callback, delay, ...args) => {
    const id = originalSetTimeout(callback, delay, ...args);
    if (delay === 20_000) deadlineCallbacks.set(id, () => callback(...args));
    return id;
  };
  w.clearTimeout = id => { deadlineCallbacks.delete(id); originalClearTimeout(id); };
  let unmounted = false;
  const requests = [];
  let failRefresh = false;
  let accountId = 'account-a';
  let readImpl = null;
  let decisionImpl = async body => {
    const saved = { id: 'decision', candidateId: 'candidate', decision: body.decision,
      promotedVersionId: body.decision === 'accepted' ? 'private-version' : null, reason: body.reason ?? null };
    outgoing = outgoing.map(file => file.candidateId === 'candidate' ? { ...file, canDecideCandidate: false,
      candidateDecision: saved.decision, candidateDecisionReason: saved.reason, candidatePromotedVersionId: saved.promotedVersionId } : file);
    return response({ decision: saved, replayed: false });
  };
  let writeImpl = async () => response({ error: 'Unexpected upload' }, 500);
  const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  w.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (!options.method && readImpl) { const result = await readImpl(url, options); if (result) return result; }
    if (options.method === 'POST' && url.endsWith('/decision')) return decisionImpl(JSON.parse(options.body));
    if (options.method) return writeImpl(url, options);
    if (failRefresh) return response({ error: 'Refresh unavailable' }, 503);
    if (url === '/api/account/session') return response({ account: { id: accountId } });
    const capabilities = { candidateUploads: enabled, candidateRequestProjectIds: projectCapabilityIds };
    if (url === '/api/talent/audio/projects') return response({ projects: [{ id: 'project-a', title: 'Owner project' }] });
    if (url === '/api/talent/audio/projects/project-a/assets') return response({ assets: [{ id: 'asset', title: 'Source', metadata: { requestable: false } }], versions: [{ ...source, id: source.versionId, assetId: 'asset', versionNumber: 1 }] });
    if (url === '/api/talent/audio/storage-usage') return response({ storageUsage: { workspaceLimitBytes: 1024, workingBytes: 3, sealedWorkingBytes: 3, reservedBytes: 0, releaseProtectedBytes: 0, availableWorkspaceBytes: 1021, workingObjectCount: 1, workingObjectLimit: 10, releaseCountLimit: null } });
    if (url.endsWith('/pairing/connections')) return response({ connections: [{ connectionId: 'connection', counterparty: { displayName: 'Collaborator', handle: null } }], capabilities });
    if (url.endsWith('/files/shared-with-me')) return response({ files: incoming, capabilities });
    if (url.endsWith('/files/shared-by-me')) return response({ files: outgoing, capabilities });
    throw new Error(`Unexpected read ${url}`);
  };
  w.eval(bundle.outputFiles[0].text);
  await w.__mount();
  const step = fn => w.__act(async () => { fn?.(); await Promise.resolve(); });
  const button = name => [...w.document.querySelectorAll('button')].find(element => element.textContent.trim() === name || element.getAttribute('aria-label') === name);
  const click = async name => { const element = button(name); assert.ok(element, `Missing button: ${name}`); assert.equal(element.disabled, false, `Disabled button: ${name}`); await step(() => element.click()); };
  const fillReason = value => step(() => {
    const element = w.document.querySelector('[aria-label="Confirm candidate decision"] textarea');
    assert.ok(element);
    Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, 'value').set.call(element, value);
    element.dispatchEvent(new w.Event('input', { bubbles: true }));
  });
  const chooseFile = file => step(() => {
    const input = w.document.querySelector('input[type="file"]'); assert.ok(input);
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new w.Event('change', { bubbles: true }));
  });
  return { w, requests, response, button, click, step, fillReason, chooseFile,
    text: () => w.document.body.textContent,
    writes: () => requests.filter(request => request.options.method),
    setAccount: value => { accountId = value; }, setRead: value => { readImpl = value; },
    setIncoming: value => { incoming = value; }, setOutgoing: value => { outgoing = value; },
    setProjectCapabilityIds: value => { projectCapabilityIds = value; },
    setEnabled: value => { enabled = value; }, setFailRefresh: value => { failRefresh = value; },
    setDecision: value => { decisionImpl = value; }, setWrite: value => { writeImpl = value; },
    async expireRequests() { await step(() => { const callbacks = [...deadlineCallbacks.entries()]; assert.ok(callbacks.length, 'Expected an outstanding request deadline'); for (const [id, callback] of callbacks) { w.clearTimeout(id); callback(); } }); },
    async unmount() { await step(() => w.__root.unmount()); unmounted = true; },
    async close() { if (!unmounted) await step(() => w.__root.unmount()); dom.window.close(); for (const channel of channels) { channel.port1.close(); channel.port2.close(); } assert.deepEqual(consoleErrors, []); }
  };
}
let passed = 0;
async function test(name, run, options) {
  const f = await fixture(options);
  try { await run(f); passed++; console.log(`PASS ${name}`); }
  finally { await f.close(); }
}
await test('accept requires explicit confirmation, suppresses double submit, and reads saved private version', async f => {
  await f.click('Add as private version');
  assert.equal(f.writes().length, 0);
  assert.match(f.text(), /will not become a release master/);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.setDecision(async body => { await gate; return f.response({ decision: { candidateId: 'candidate', decision: body.decision, promotedVersionId: 'private-version' } }); });
  await f.step(() => { const confirm = f.button('Confirm add private version'); confirm.click(); confirm.click(); });
  assert.equal(f.writes().length, 1);
  f.setOutgoing([{ ...candidate, candidateDecision: 'accepted', candidatePromotedVersionId: 'private-version', canDecideCandidate: false }]);
  await f.step(() => release());
  assert.equal(f.w.__accepted, 1);
  assert.match(f.text(), /Added as a new private file version/);
  assert.equal(f.button('Add as private version'), undefined);
  assert.equal(f.writes()[0].url, '/api/talent/audio/candidates/candidate/decision');
});
await test('lost decision response retries the same durable intent key', async f => {
  f.setDecision(async () => { throw new TypeError('Connection interrupted'); });
  await f.click('Add as private version'); await f.click('Confirm add private version');
  assert.match(f.text(), /could not be confirmed/);
  assert.equal(f.w.__accepted, 0);
  const first = JSON.parse(f.writes()[0].options.body);
  await f.click('Refresh Collaborator Inbox');
  await f.click('Confirm add private version');
  assert.equal(JSON.parse(f.writes()[1].options.body).idempotencyKey, first.idempotencyKey);
});
await test('malformed acceptance cannot claim a new version', async f => {
  f.setDecision(async () => f.response({ decision: { candidateId: 'candidate', decision: 'accepted', promotedVersionId: null } }));
  await f.click('Add as private version'); await f.click('Confirm add private version');
  assert.match(f.text(), /could not be confirmed/);
  assert.equal(f.w.__accepted, 0);
  assert.doesNotMatch(f.text(), /Added as a new private file version/);
});
for (const choice of ['rejected', 'blocked']) await test(`${choice} requires a reason and persists the decision`, async f => {
  await f.click(choice === 'blocked' ? 'Block candidate' : 'Reject candidate');
  const confirm = choice === 'blocked' ? 'Confirm block candidate' : 'Confirm reject candidate';
  assert.equal(f.button(confirm).disabled, true);
  await f.fillReason('  The returned file is unsuitable.  '); await f.click(confirm);
  const body = JSON.parse(f.writes()[0].options.body);
  assert.equal(body.decision, choice); assert.equal(body.reason, 'The returned file is unsuitable.');
  assert.equal(f.w.__accepted, 0);
  assert.match(f.text(), choice === 'blocked' ? /Candidate blocked/ : /Candidate rejected/);
  if (choice === 'blocked') {
    assert.equal(f.w.document.querySelectorAll('audio').length, 0);
    assert.match(f.text(), /account and connection remain unchanged/);
  }
});
await test('project managers cannot see owner decision actions', async f => {
  assert.equal(f.button('Add as private version'), undefined);
  assert.equal(f.button('Reject candidate'), undefined);
  assert.equal(f.button('Block candidate'), undefined);
  assert.equal(f.w.document.querySelectorAll('audio').length, 1);
}, { outgoing: [{ ...candidate, canDecideCandidate: false, managedByCurrentUser: true }] });
for (const moderationStatus of ['held_for_review', 'blocked']) await test(`${moderationStatus} candidate cannot play or be accepted but can be rejected`, async f => {
  assert.equal(f.w.document.querySelectorAll('audio').length, 0);
  assert.equal(f.button('Add as private version').disabled, true);
  assert.match(f.text(), /Playback and acceptance are unavailable/);
  await f.click('Reject candidate'); await f.fillReason('Do not use this returned file.'); await f.click('Confirm reject candidate');
  assert.equal(JSON.parse(f.writes()[0].options.body).decision, 'rejected');
  assert.equal(f.w.__accepted, 0);
}, { outgoing: [{ ...candidate, candidateModerationStatus: moderationStatus }] });
await test('feature disabled and failed refresh fail closed', async f => {
  f.setFailRefresh(true); await f.click('Refresh Collaborator Inbox');
  assert.equal(f.button('Add as private version'), undefined);
  assert.equal(f.w.document.querySelectorAll('audio').length, 0);
  assert.match(f.text(), /Refresh unavailable/);
});
await test('source and candidate players avoid prefetch and refresh recreates failed players', async f => {
  const players = [...f.w.document.querySelectorAll('audio')]; assert.equal(players.length, 2);
  assert.ok(players.every(player => player.preload === 'none'));
  const sourcePlayer = players.find(player => player.src.endsWith('/listen'));
  const candidatePlayer = players.find(player => player.src.endsWith('/candidates/candidate/content'));
  assert.ok(sourcePlayer); assert.ok(candidatePlayer);
  await f.step(() => { sourcePlayer.dispatchEvent(new f.w.Event('error')); candidatePlayer.dispatchEvent(new f.w.Event('error')); });
  assert.match(f.text(), /Audio could not play/); assert.match(f.text(), /Candidate audio could not play/);
  await f.click('Refresh Collaborator Inbox');
  assert.equal(sourcePlayer.isConnected, false); assert.equal(candidatePlayer.isConnected, false);
  assert.doesNotMatch(f.text(), /could not play/);
  f.setIncoming([]); f.setOutgoing([]); await f.click('Refresh Collaborator Inbox');
  assert.equal(f.w.document.querySelectorAll('audio').length, 0);
}, { incoming: [source] });
const uploadGrant = { ...candidate, candidateId: null, canDecideCandidate: false };
await test('creator byte ceiling is enforced before hashing or upload', async f => {
  let hashed = false;
  await f.chooseFile({ name: 'large.wav', type: 'audio/wav', size: 17 * 1024 * 1024, arrayBuffer: async () => { hashed = true; throw new Error('Must not hash'); } });
  assert.equal(hashed, false); assert.equal(f.writes().length, 0);
  assert.match(f.text(), /exceeds this request/);
}, { incoming: [uploadGrant], outgoing: [] });
await test('server quota rejection prevents reading or hashing file bytes', async f => {
  let read = false;
  f.setWrite(async (url, options) => {
    assert.ok(url.endsWith('/candidate-uploads/preflight'));
    assert.deepEqual(JSON.parse(options.body), { filename: 'returned.wav', mimeType: 'audio/wav', byteSize: 3 });
    return f.response({ error: 'The creator has no available storage.' }, 413);
  });
  await f.chooseFile({ name: 'returned.wav', type: 'audio/wav', size: 3, slice: () => { read = true; throw new Error('Must not read bytes'); } });
  assert.equal(read, false); assert.equal(f.writes().length, 1);
  assert.match(f.text(), /no available storage/);
}, { incoming: [uploadGrant], outgoing: [] });
await test('HTTP 202 upload response never claims a sealed candidate', async f => {
  const bytes = new Uint8Array([1, 2, 3]);
  const file = { name: 'returned.wav', type: 'audio/wav', size: 3, arrayBuffer: async () => bytes.buffer,
    slice: () => new Blob([bytes], { type: 'audio/wav' }) };
  let completeStarted;
  const completeGate = new Promise(resolve => { completeStarted = resolve; });
  f.setWrite(async (url, options) => {
    if (url.endsWith('/preflight')) return f.response({ ok: true, maxCandidateBytes: uploadGrant.maxCandidateBytes });
    if (url.endsWith('/candidate-uploads')) return f.response({ uploadSession: { id: 'upload', expectedByteSize: 3, partSizeBytes: 5 * 1024 * 1024 } }, 201);
    if (options.method === 'PUT') return f.response({ part: { partNumber: 1, byteSize: 3 } });
    assert.ok(url.endsWith('/complete')); completeStarted();
    return f.response({ pending: true }, 202);
  });
  await f.w.__act(async () => { const input = f.w.document.querySelector('input[type="file"]'); Object.defineProperty(input, 'files', { value: [file] }); input.dispatchEvent(new f.w.Event('change', { bubbles: true })); await completeGate; });
  assert.equal(f.writes().length, 4);
  assert.match(f.text(), /still being processed/);
  assert.doesNotMatch(f.text(), /Private candidate sealed for creator review/);
  assert.equal(JSON.parse(f.writes()[1].options.body).expectedSha256, createHash('sha256').update(bytes).digest('hex'));
}, { incoming: [uploadGrant], outgoing: [] });
await test('canceling candidate preflight stops before hashing and allows an explicit retry', async f => {
  let read = false;
  f.setWrite((_url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
  }));
  await f.chooseFile({ name: 'returned.wav', type: 'audio/wav', size: 3, slice: () => { read = true; throw new Error('Must not read'); } });
  await f.click('Stop waiting for upload');
  assert.equal(read, false); assert.equal(f.writes().length, 1);
  assert.match(f.text(), /Stopped waiting for this upload/);
  assert.equal(f.w.document.querySelector('input[type="file"]').disabled, false);
}, { incoming: [uploadGrant], outgoing: [] });
for (const matches of [true, false]) await test(`candidate seal ${matches ? 'confirms' : 'rejects'} exact returned byte identity`, async f => {
  const bytes = new Uint8Array([4, 5, 6]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const file = { name: 'returned.wav', type: 'audio/wav', size: 3, slice: () => new Blob([bytes], { type: 'audio/wav' }) };
  let completeStarted;
  const completeGate = new Promise(resolve => { completeStarted = resolve; });
  f.setWrite(async (url, options) => {
    if (url.endsWith('/preflight')) return f.response({ ok: true, maxCandidateBytes: uploadGrant.maxCandidateBytes });
    if (url.endsWith('/candidate-uploads')) return f.response({ uploadSession: { id: 'upload', expectedByteSize: 3, partSizeBytes: 5 * 1024 * 1024 } }, 201);
    if (options.method === 'PUT') return f.response({ part: { partNumber: 1, byteSize: 3 } });
    completeStarted();
    if (matches) f.setIncoming([{ ...candidate, canDecideCandidate: false }]);
    return f.response({ candidate: { id: 'candidate', sourceAssetVersionId: 'source-version', byteSize: 3,
      sha256: matches ? sha256 : '0'.repeat(64), intakeStatus: 'private_review' } });
  });
  await f.w.__act(async () => { const input = f.w.document.querySelector('input[type="file"]'); Object.defineProperty(input, 'files', { value: [file] }); input.dispatchEvent(new f.w.Event('change', { bubbles: true })); await completeGate; });
  if (matches) {
    assert.match(f.text(), /Private candidate sealed for creator review/);
    assert.equal(f.w.document.querySelector('input[type="file"]'), null);
  } else {
    assert.match(f.text(), /sealing was not confirmed/);
    assert.doesNotMatch(f.text(), /Private candidate sealed for creator review/);
  }
}, { incoming: [uploadGrant], outgoing: [] });
const reviewSource = { ...source, canReadReviews: true, canApprove: true, canRevoke: true };
const reviewEvent = { id: 'review', eventType: 'approved', body: 'PRIVATE OLD REVIEW', timecodeMs: null, createdAt: '2026-09-13T00:00:00.000Z' };
for (const malformed of [{ files: null }, { files: [{ ...source, byteSize: 'unknown' }] }]) await test('malformed private lists fail visibly instead of empty success', async f => {
  f.setRead(async url => url.endsWith('/files/shared-with-me') ? f.response(malformed) : null);
  await f.click('Refresh Collaborator Inbox');
  assert.match(f.text(), /private file list could not be confirmed/);
  assert.doesNotMatch(f.text(), /No files have been shared with you/);
  assert.equal(f.w.document.querySelectorAll('article').length, 0);
  f.setRead(null); await f.click('Refresh Collaborator Inbox');
  assert.match(f.text(), /source.wav/);
}, { incoming: [reviewSource], outgoing: [] });
await test('review body deadline ignores an abort-insensitive late JSON result', async f => {
  let finishBody;
  f.setRead(async url => url.endsWith('/reviews') ? { ok: true, status: 200, json: () => new Promise(resolve => { finishBody = resolve; }) } : null);
  await f.click('Review history');
  assert.equal(typeof finishBody, 'function');
  await f.expireRequests();
  assert.match(f.text(), /timed out/);
  assert.equal(f.button('Refresh Collaborator Inbox').disabled, false);
  const textBefore = f.text();
  await f.step(() => finishBody({ events: [reviewEvent] }));
  assert.equal(f.text(), textBefore);
  assert.doesNotMatch(f.text(), /PRIVATE OLD REVIEW/);
}, { incoming: [reviewSource], outgoing: [] });
await test('malformed review lists cannot claim an empty review thread', async f => {
  f.setRead(async url => url.endsWith('/reviews') ? f.response({ events: {} }) : null);
  await f.click('Review history');
  assert.match(f.text(), /Review activity could not be confirmed/);
  assert.doesNotMatch(f.text(), /No review activity yet/);
}, { incoming: [reviewSource], outgoing: [] });
await test('new refresh supersedes an older list response without repopulating stale files', async f => {
  let finishOld, capturedSignal;
  let gated = false;
  f.setRead(async (url, options) => {
    if (!gated && url.endsWith('/files/shared-with-me')) { gated = true; capturedSignal = options.signal; return new Promise(resolve => { finishOld = resolve; }); }
    return null;
  });
  await f.click('Refresh Collaborator Inbox');
  f.setIncoming([{ ...reviewSource, originalFilename: 'current.wav' }]);
  await f.click('Refresh Collaborator Inbox');
  assert.equal(capturedSignal.aborted, true);
  assert.match(f.text(), /current.wav/);
  await f.step(() => finishOld(f.response({ files: [{ ...reviewSource, originalFilename: 'STALE PRIVATE.wav' }], capabilities: { candidateUploads: true } })));
  assert.doesNotMatch(f.text(), /STALE PRIVATE/); assert.match(f.text(), /current.wav/);
}, { incoming: [reviewSource], outgoing: [] });
await test('account change during a review read clears prior private data', async f => {
  let finishRead;
  f.setRead(async url => url.endsWith('/reviews') ? new Promise(resolve => { finishRead = resolve; }) : null);
  await f.click('Review history');
  f.setAccount('account-b');
  await f.step(() => finishRead(f.response({ events: [reviewEvent] })));
  assert.match(f.text(), /signed-in account changed/);
  assert.doesNotMatch(f.text(), /PRIVATE OLD REVIEW|source.wav/);
  assert.equal(f.w.document.querySelectorAll('audio').length, 0);
}, { incoming: [reviewSource], outgoing: [] });
await test('late access denial from a superseded account cannot erase current-account data', async f => {
  let finishRead;
  f.setRead(async url => url.endsWith('/reviews') ? new Promise(resolve => { finishRead = resolve; }) : null);
  await f.click('Review history');
  f.setAccount('account-b'); f.setIncoming([{ ...reviewSource, grantId: 'b-grant', originalFilename: 'account-b.wav' }]);
  await f.step(() => f.w.dispatchEvent(new f.w.Event('focus')));
  assert.match(f.text(), /account-b.wav/);
  await f.step(() => finishRead(f.response({ error: 'Old session ended' }, 401)));
  assert.match(f.text(), /account-b.wav/);
  assert.doesNotMatch(f.text(), /Old session ended/);
}, { incoming: [reviewSource], outgoing: [] });
await test('unmount aborts private reads and prevents late callbacks', async f => {
  let finishRead, capturedSignal;
  f.setRead(async (url, options) => url.endsWith('/reviews') ? (capturedSignal = options.signal, new Promise(resolve => { finishRead = resolve; })) : null);
  await f.click('Review history'); await f.unmount();
  assert.equal(capturedSignal.aborted, true);
  const callbackCount = f.w.__loaded.length;
  await f.step(() => finishRead(f.response({ events: [reviewEvent] })));
  assert.equal(f.w.__loaded.length, callbackCount); assert.equal(f.w.__accepted, 0);
}, { incoming: [reviewSource], outgoing: [] });
for (const action of ['review', 'grant', 'connection']) await test(`${action} mutation deadline includes JSON and never claims late success`, async f => {
  let finishBody;
  f.setWrite(async () => ({ ok: true, status: 200, json: () => new Promise(resolve => { finishBody = resolve; }) }));
  if (action === 'review') await f.click('Approve');
  else if (action === 'grant') { await f.click('Remove access'); await f.click('Remove access'); }
  else { await f.click('Remove connection'); await f.click('Remove connection'); }
  assert.equal(f.writes().length, 1);
  assert.equal(f.writes()[0].options.headers['X-Sway-Expected-Account-Id'], 'account-a');
  await f.expireRequests();
  assert.match(f.text(), /could not be confirmed in time/);
  const before = f.text();
  await f.step(() => finishBody(action === 'review' ? { event: reviewEvent } : action === 'grant'
    ? { grantId: 'source-grant', revokedAt: '2026-09-13T00:00:00.000Z' } : { connectionId: 'connection', revokedAt: '2026-09-13T00:00:00.000Z' }));
  assert.equal(f.text(), before);
  assert.doesNotMatch(f.text(), /Approval recorded|File access revoked|Connection removed/);
}, { incoming: [reviewSource], outgoing: [] });
await test('account-header conflict clears private state before retry', async f => {
  f.setWrite(async () => f.response({ code: 'account_context_changed', error: 'Account changed' }, 409));
  await f.click('Approve');
  assert.doesNotMatch(f.text(), /source.wav/);
  assert.match(f.text(), /account or file access changed/);
}, { incoming: [reviewSource], outgoing: [] });
await test('abort-insensitive candidate preflight cannot resume hashing after Stop waiting', async f => {
  let finishPreflight, read = false;
  f.setWrite(async () => new Promise(resolve => { finishPreflight = resolve; }));
  await f.chooseFile({ name: 'returned.wav', type: 'audio/wav', size: 3, slice: () => { read = true; throw new Error('Must not read'); } });
  await f.click('Stop waiting for upload');
  const before = f.text();
  await f.step(() => finishPreflight(f.response({ ok: true, maxCandidateBytes: uploadGrant.maxCandidateBytes })));
  assert.equal(read, false); assert.equal(f.writes().length, 1); assert.equal(f.text(), before);
}, { incoming: [uploadGrant], outgoing: [] });
await test('abort-insensitive decision response cannot publish a previous account success', async f => {
  let finishDecision;
  f.setDecision(async () => new Promise(resolve => { finishDecision = resolve; }));
  await f.click('Add as private version'); await f.click('Confirm add private version');
  f.setAccount('account-b'); f.setOutgoing([]); f.setIncoming([{ ...source, originalFilename: 'account-b.wav' }]);
  await f.step(() => f.w.dispatchEvent(new f.w.Event('focus')));
  await f.step(() => finishDecision(f.response({ decision: { candidateId: 'candidate', decision: 'accepted', promotedVersionId: 'private-version' } })));
  assert.equal(f.w.__accepted, 0);
  assert.match(f.text(), /account-b.wav/); assert.doesNotMatch(f.text(), /Added as a new private file version|returned.wav/);
});
for (const allowedProjects of [undefined, [], ['another-project'], ['project-a']]) await test(`owner candidate request controls require this project's persisted capability: ${JSON.stringify(allowedProjects)}`, async f => {
  const permitted = allowedProjects?.includes('project-a') === true;
  assert.equal(Boolean(f.button('Request private candidate')), permitted);
  if (permitted) {
    f.setWrite(async (url, options) => {
      assert.ok(url.endsWith('/candidate-revision-grants'));
      const body = JSON.parse(options.body);
      assert.equal(body.versionId, source.versionId);
      return f.response({ grant: { id: 'bounded-request', maxCandidateBytes: body.maxCandidateBytes }, reused: false });
    });
    await f.click('Request private candidate');
    assert.equal(f.writes().length, 1);
    f.setProjectCapabilityIds([]); await f.click('Refresh Collaborator Inbox');
    assert.equal(f.button('Request private candidate'), undefined);
  }
}, { ownerCatalog: true, incoming: [], outgoing: [], projectCapabilityIds: allowedProjects });
await test('returning from a native file picker does not cancel same-account upload work', async f => {
  let capturedSignal;
  f.setWrite(async (_url, options) => { capturedSignal = options.signal; return new Promise(() => {}); });
  await f.chooseFile({ name: 'returned.wav', type: 'audio/wav', size: 3, slice: () => { throw new Error('Must not hash during preflight'); } });
  await f.step(() => f.w.dispatchEvent(new f.w.Event('focus')));
  assert.equal(capturedSignal.aborted, false);
  assert.ok(f.button('Stop waiting for upload'));
  await f.click('Stop waiting for upload');
}, { incoming: [uploadGrant], outgoing: [] });
await test('access denial clears private rows at headers even if its body never resolves', async f => {
  let bodyRead = false;
  f.setRead(async url => url.endsWith('/reviews') ? { status: 403, ok: false, json: () => { bodyRead = true; return new Promise(() => {}); } } : null);
  await f.click('Review history');
  assert.equal(bodyRead, false);
  assert.doesNotMatch(f.text(), /source.wav/);
  assert.match(f.text(), /account or file access changed/);
}, { incoming: [reviewSource], outgoing: [] });
await test('account change during post-decision refresh prevents late acceptance callbacks', async f => {
  let decisionSent = false, finishOldRefresh, gated = false;
  f.setDecision(async () => { decisionSent = true; return f.response({ decision: { candidateId: 'candidate', decision: 'accepted', promotedVersionId: 'private-version' } }); });
  f.setRead(async url => {
    if (decisionSent && !gated && url.endsWith('/files/shared-by-me')) { gated = true; return new Promise(resolve => { finishOldRefresh = resolve; }); }
    return null;
  });
  await f.click('Add as private version'); await f.click('Confirm add private version');
  assert.equal(typeof finishOldRefresh, 'function'); assert.equal(f.w.__accepted, 0);
  f.setAccount('account-b'); f.setOutgoing([]); f.setIncoming([{ ...source, originalFilename: 'account-b.wav' }]);
  await f.step(() => f.w.dispatchEvent(new f.w.Event('focus')));
  await f.step(() => finishOldRefresh(f.response({ files: [{ ...candidate, candidateDecision: 'accepted', canDecideCandidate: false }], capabilities: { candidateUploads: true } })));
  assert.equal(f.w.__accepted, 0);
  assert.match(f.text(), /account-b.wav/); assert.doesNotMatch(f.text(), /Added as a new private file version/);
});
await test('hidden same-account picker and tab transitions preserve file selection and upload work', async f => {
  const input = f.w.document.querySelector('input[type="file"]');
  assert.ok(input);
  const changeVisibility = state => f.step(() => {
    Object.defineProperty(f.w.document, 'visibilityState', { configurable: true, value: state });
    f.w.document.dispatchEvent(new f.w.Event('visibilitychange'));
  });
  await changeVisibility('hidden');
  assert.equal(input.isConnected, true);
  await changeVisibility('visible');
  assert.equal(f.w.document.querySelector('input[type="file"]'), input);
  let uploadSignal;
  f.setWrite(async (_url, options) => { uploadSignal = options.signal; return new Promise(() => {}); });
  await f.chooseFile({ name: 'returned.wav', type: 'audio/wav', size: 3, slice: () => { throw new Error('Preflight has not finished'); } });
  assert.equal(f.writes().length, 1);
  assert.equal(uploadSignal.aborted, false);
  await changeVisibility('hidden');
  assert.equal(uploadSignal.aborted, false);
  assert.equal(input.isConnected, true);
  await changeVisibility('visible');
  assert.equal(uploadSignal.aborted, false);
  assert.ok(f.button('Stop waiting for upload'));
  assert.equal(f.writes().length, 1, 'Visibility changes must not retry the upload.');
  await f.click('Stop waiting for upload');
}, { incoming: [uploadGrant], outgoing: [] });
console.log(`${passed} candidate Inbox component checks passed. Synthetic HTTP + JSDOM; no browser, layout, playback, server authorization or persistence claim.`);
