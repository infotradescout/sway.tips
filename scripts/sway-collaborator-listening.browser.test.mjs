import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';

// Actual browser rendering/audio and Inbox interactions with mocked HTTP only.
// No server authorization, persisted database, provider, or two-account production proof.

const vite = await createServer({ root: process.cwd(), publicDir: 'public', logLevel: 'error', cacheDir: 'node_modules/.vite-collaborator-listening', server: { host: '127.0.0.1', port: 0, watch: null, hmr: false } });
await vite.listen();
const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({ headless: true,
  ...(process.env.SWAY_BROWSER_EXECUTABLE ? { executablePath: process.env.SWAY_BROWSER_EXECUTABLE } : {}),
  ...(process.env.SWAY_BROWSER_ARGS ? { args: JSON.parse(process.env.SWAY_BROWSER_ARGS) } : {}) });
const file = { grantId: '10000000-0000-4000-8000-000000000001', connectionId: '20000000-0000-4000-8000-000000000001', projectTitle: 'Song review', versionId: '30000000-0000-4000-8000-000000000001', originalFilename: 'take-one.wav', mimeType: 'audio/wav', byteSize: 8044, sha256: 'a'.repeat(64), canDownloadOriginal: true, canComment: true, canApprove: true };
const wav = Buffer.alloc(8044, 128);
wav.write('RIFF'); wav.writeUInt32LE(8036, 4); wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34); wav.write('data', 36); wav.writeUInt32LE(8000, 40);
try {
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    let listeningAllowed = true;
    let grantPresent = true;
    let audioRequests = 0;
    let candidateScenario = false;
    let candidateSealed = false;
    let ownerView = false;
    let candidateDecision = null;
    let candidateDecisionReason = null;
    let decisionRequests = 0;
    let candidateUploadHash = '';
    let candidateGrantId = '40000000-0000-4000-8000-000000000001';
    let candidateId = '50000000-0000-4000-8000-000000000001';
    const candidateFile = () => ({ ...file, grantId: candidateGrantId, grantPurpose: 'collaborator_revision_upload',
      canDownloadOriginal: false, canComment: false, canApprove: false, canUploadCandidateRevision: true, maxCandidateBytes: 16 * 1024 * 1024,
      candidateId: candidateSealed ? candidateId : null, candidateOriginalFilename: candidateSealed ? 'returned.wav' : null,
      candidateByteSize: candidateSealed ? wav.length : null, candidateMimeType: 'audio/wav',
      canDecideCandidate: ownerView && candidateSealed && !candidateDecision, candidateDecision, candidateDecisionReason,
      candidatePromotedVersionId: candidateDecision === 'accepted' ? '60000000-0000-4000-8000-000000000001' : null });
    await context.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      const json = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      const capabilities = { candidateUploads: true, candidateRequestProjectIds: [] };
      if (path === '/api/account/session') return json({ account: { id: ownerView ? '70000000-0000-4000-8000-000000000002' : '70000000-0000-4000-8000-000000000001' } });
      if (path.endsWith('/connections')) return json({ connections: [{ connectionId: file.connectionId, counterparty: { displayName: 'Creator', handle: 'creator' } }], capabilities });
      if (path.endsWith('/shared-with-me')) return json({ files: candidateScenario ? (ownerView ? [] : [candidateFile()]) : grantPresent ? [file, { ...file, grantId: '10000000-0000-4000-8000-000000000002', originalFilename: 'review-only.wav', canDownloadOriginal: false }, { ...file, grantId: '10000000-0000-4000-8000-000000000003', originalFilename: 'artwork.png', mimeType: 'image/png' }] : [], capabilities });
      if (path.endsWith('/shared-by-me')) return json({ files: candidateScenario && ownerView ? [candidateFile()] : [], capabilities });
      if (path.endsWith('/preflight')) return json({ ok: true, maxCandidateBytes: 16 * 1024 * 1024 });
      if (path.endsWith('/candidate-uploads')) {
        const body = route.request().postDataJSON(); candidateUploadHash = body.expectedSha256;
        assert.equal(candidateUploadHash, createHash('sha256').update(wav).digest('hex'));
        return json({ uploadSession: { id: '80000000-0000-4000-8000-000000000001', expectedByteSize: wav.length, partSizeBytes: 5 * 1024 * 1024 } });
      }
      if (path.includes('/parts/')) { assert.deepEqual(route.request().postDataBuffer(), wav); return json({ part: { partNumber: 1, byteSize: wav.length } }); }
      if (path.endsWith('/complete')) {
        candidateSealed = true;
        return json({ candidate: { id: candidateId, sourceAssetVersionId: file.versionId, byteSize: wav.length, sha256: candidateUploadHash, intakeStatus: 'private_review' } });
      }
      if (path.endsWith('/decision')) {
        const body = route.request().postDataJSON(); decisionRequests += 1; candidateDecision = body.decision; candidateDecisionReason = body.reason || null;
        assert.ok(body.idempotencyKey);
        return json({ decision: { candidateId, decision: candidateDecision, reason: candidateDecisionReason,
          promotedVersionId: candidateDecision === 'accepted' ? '60000000-0000-4000-8000-000000000001' : null } });
      }
      if (path.endsWith('/listen') || path.endsWith(`/candidates/${candidateId}/content`)) {
        audioRequests += 1;
        if (!listeningAllowed) return route.fulfill({ status: 410, body: 'Access ended' });
        const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || '');
        const start = range ? Number(range[1]) : 0;
        const end = range?.[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
        return route.fulfill({ status: range ? 206 : 200, headers: { 'content-type': 'audio/wav', 'content-length': String(end - start + 1), 'accept-ranges': 'bytes', 'cache-control': 'private, no-store', ...(range ? { 'content-range': `bytes ${start}-${end}/${wav.length}` } : {}) }, body: wav.subarray(start, end + 1) });
      }
      return json({ events: [] });
    });
    await page.goto(`${base}/scripts/browser-fixtures/sway-collaborator-listening.html`);
    const audio = page.getByLabel('Listen to take-one.wav');
    await audio.waitFor();
    assert.equal(await page.locator('audio').count(), 1, 'Only downloadable audio receives a player.');
    assert.equal(audioRequests, 0, 'Opening inbox must not prefetch private masters.');
    await audio.evaluate(async element => { element.muted = true; await element.play(); element.pause(); });
    assert.ok(audioRequests > 0);
    assert.equal(await audio.evaluate(element => element.duration), 1);
    await audio.evaluate(element => { element.currentTime = 0.5; });
    assert.equal(await audio.evaluate(element => element.currentTime), 0.5);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    listeningAllowed = false;
    await audio.evaluate(element => element.load());
    await audio.evaluate(element => { void element.play().catch(() => {}); });
    await page.getByText('Audio could not play.', { exact: false }).waitFor();
    listeningAllowed = true;
    await page.getByRole('button', { name: 'Refresh Collaborator Inbox' }).click();
    await page.waitForFunction(() => !document.body.textContent.includes('Audio could not play.'));
    await audio.evaluate(async element => { element.muted = true; await element.play(); element.pause(); });
    grantPresent = false;
    await page.getByRole('button', { name: 'Refresh Collaborator Inbox' }).click();
    await page.getByText('No files have been shared with you.').waitFor();
    assert.equal(await page.locator('audio').count(), 0, 'Refreshing an ended grant must remove its player.');
    candidateScenario = true;
    await page.getByRole('button', { name: 'Refresh Collaborator Inbox' }).click();
    await page.getByLabel('Upload private candidate for take-one.wav').setInputFiles({ name: 'returned.wav', mimeType: 'audio/wav', buffer: wav });
    await page.getByText('Private candidate sealed for creator review.', { exact: false }).first().waitFor();
    const candidateAudio = page.getByLabel('Play private candidate returned.wav');
    await candidateAudio.waitFor();
    assert.equal(await candidateAudio.getAttribute('preload'), 'none');
    await candidateAudio.evaluate(async element => { element.muted = true; await element.play(); element.pause(); });
    assert.equal(await candidateAudio.evaluate(element => element.duration), 1);
    assert.equal(await page.getByRole('button', { name: 'Add as private version', exact: true }).count(), 0, 'Recipient does not receive owner decision actions.');
    ownerView = true;
    await page.getByRole('button', { name: 'Refresh Collaborator Inbox' }).click();
    await page.getByRole('button', { name: 'Add as private version', exact: true }).click();
    assert.equal(decisionRequests, 0, 'Choosing acceptance must first ask for confirmation.');
    await page.getByRole('button', { name: 'Confirm add private version' }).click();
    await page.getByText('Added as a new private file version.', { exact: false }).first().waitFor();
    assert.equal(decisionRequests, 1);
    assert.equal(await page.getByRole('button', { name: 'Add as private version', exact: true }).count(), 0);
    // A separate pending candidate fixture exercises blocking; accepted decisions stay terminal.
    candidateDecision = null;
    candidateGrantId = '40000000-0000-4000-8000-000000000002';
    candidateId = '50000000-0000-4000-8000-000000000002';
    await page.getByRole('button', { name: 'Refresh Collaborator Inbox' }).click();
    await page.getByRole('button', { name: 'Block candidate', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Confirm block candidate' }).isDisabled(), true);
    await page.getByLabel('Decision reason (required)').fill('Do not use this returned candidate.');
    await page.getByRole('button', { name: 'Confirm block candidate' }).click();
    await page.getByText('Candidate blocked.', { exact: false }).first().waitFor();
    assert.equal(await page.locator('audio').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await context.close();
    console.log(`Collaborator listening browser passed ${width}px: audio decode/play/seek, no prefetch, permission visibility, error recovery, ended grant, private candidate upload, owner confirmation and blocking. Mocked HTTP only.`);
  }
} finally {
  await browser.close();
  await vite.close();
}
