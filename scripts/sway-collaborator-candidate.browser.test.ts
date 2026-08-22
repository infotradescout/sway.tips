import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { AUDIO_UPLOAD_PART_SIZE_BYTES } from '../src/audio-upload-client';

const connectionId = '11111111-1111-4111-8111-111111111111';
const collaboratorGrantId = '22222222-2222-4222-8222-222222222222';
const creatorGrantId = '33333333-3333-4333-8333-333333333333';
const versionId = '44444444-4444-4444-8444-444444444444';
const uploadSessionId = '55555555-5555-4555-8555-555555555555';
const candidateId = '66666666-6666-4666-8666-666666666666';
const projectId = '77777777-7777-4777-8777-777777777777';
const assetId = '88888888-8888-4888-8888-888888888888';
const projectBId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const assetBId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const versionBId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const candidateGrantMaxBytes = 16 * 1024 * 1024;

type CapabilitySignal = 'connections' | 'incoming' | 'outgoing';

type CandidateBrowserState = {
  candidateSealed: boolean;
  capabilitiesEnabled: boolean;
  disabledCapabilitySignal: CapabilitySignal | null;
  failNextInitiation: boolean;
  failNextIncomingAfterDelayMs: number;
  refreshDelayMs: number;
  staleIncomingStarted: boolean;
  projectAssetDelayMs: Record<string, number>;
  projectAssetRequests: string[];
};

type CapturedRequest = {
  method: string;
  path: string;
  contentType: string;
  body: Buffer;
};

function wavFixture(label: string) {
  const dataSize = 800;
  const body = Buffer.alloc(44 + dataSize, 0x80);
  body.write('RIFF', 0, 'ascii');
  body.writeUInt32LE(body.byteLength - 8, 4);
  body.write('WAVE', 8, 'ascii');
  body.write('fmt ', 12, 'ascii');
  body.writeUInt32LE(16, 16);
  body.writeUInt16LE(1, 20);
  body.writeUInt16LE(1, 22);
  body.writeUInt32LE(8_000, 24);
  body.writeUInt32LE(8_000, 28);
  body.writeUInt16LE(1, 32);
  body.writeUInt16LE(8, 34);
  body.write('data', 36, 'ascii');
  body.writeUInt32LE(dataSize, 40);
  Buffer.from(label).copy(body, 44, 0, dataSize);
  return body;
}

async function reservePort() {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to reserve candidate browser-test port.');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function collaborationFile(input: {
  grantId: string;
  candidate: boolean;
  creatorRetained?: boolean;
}) {
  return {
    grantId: input.grantId,
    connectionId,
    projectTitle: 'Private revision proof',
    versionId,
    originalFilename: 'source-master.wav',
    mimeType: 'audio/wav',
    byteSize: 844,
    sha256: 'a'.repeat(64),
    grantPurpose: 'collaborator_revision_upload',
    canUploadCandidateRevision: true,
    maxCandidateBytes: candidateGrantMaxBytes,
    canDownloadOriginal: false,
    canComment: false,
    canApprove: false,
    expiresAt: input.creatorRetained ? new Date(Date.now() - 60_000).toISOString() : new Date(Date.now() + 3_600_000).toISOString(),
    revokedAt: input.creatorRetained ? new Date(Date.now() - 30_000).toISOString() : null,
    candidateId: input.candidate ? candidateId : null,
    candidateOriginalFilename: input.candidate ? 'candidate.wav' : null,
    candidateMimeType: input.candidate ? 'audio/wav' : null,
    candidateByteSize: input.candidate ? 844 : null,
    candidateSha256: input.candidate ? 'b'.repeat(64) : null,
    candidateDurationMs: input.candidate ? 100 : null,
    candidateSealedAt: input.candidate ? new Date().toISOString() : null,
    canRevoke: input.creatorRetained !== true,
    canReadReviews: false,
    initiatedByCurrentUser: input.creatorRetained === true,
    managedByCurrentUser: input.creatorRetained === true
  };
}

async function installApiRoutes(
  context: BrowserContext,
  state: CandidateBrowserState,
  candidateBody: Buffer,
  captured: CapturedRequest[],
  grantRequests: CapturedRequest[]
) {
  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    const collaborationCapability = async (signal: CapabilitySignal) => {
      if (state.refreshDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, state.refreshDelayMs));
      }
      return {
        candidateUploads: state.capabilitiesEnabled && state.disabledCapabilitySignal !== signal
      };
    };

    if (request.method() === 'GET' && path === '/api/talent/audio/pairing/connections') {
      const capability = await collaborationCapability('connections');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          connections: [{
            connectionId,
            purpose: 'send_files',
            connectedAt: new Date().toISOString(),
            counterparty: { displayName: 'Casey Collaborator', handle: 'casey-collab' }
          }],
          capabilities: capability
        })
      });
      return;
    }
    if (request.method() === 'GET' && path === '/api/talent/audio/projects') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          projects: [
            { id: projectId, title: 'Private revision proof' },
            { id: projectBId, title: 'Second private project' }
          ]
        })
      });
      return;
    }
    if (request.method() === 'GET' && path === '/api/talent/audio/storage-usage') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          storageUsage: {
            workspaceLimitBytes: 5 * 1024 * 1024 * 1024,
            workingBytes: candidateBody.byteLength,
            sealedWorkingBytes: candidateBody.byteLength,
            reservedBytes: 0,
            releaseProtectedBytes: 0,
            availableWorkspaceBytes: 5 * 1024 * 1024 * 1024 - candidateBody.byteLength,
            workingObjectCount: 1,
            workingObjectLimit: 10_000,
            releaseCountLimit: null
          }
        })
      });
      return;
    }
    const projectAssetsMatch = path.match(/^\/api\/talent\/audio\/projects\/([^/]+)\/assets$/);
    if (request.method() === 'GET'
      && projectAssetsMatch
      && [projectId, projectBId].includes(projectAssetsMatch[1])) {
      const requestedProjectId = projectAssetsMatch[1];
      state.projectAssetRequests.push(requestedProjectId);
      const delayMs = state.projectAssetDelayMs[requestedProjectId] || 0;
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const isSecondProject = requestedProjectId === projectBId;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          assets: [{
            id: isSecondProject ? assetBId : assetId,
            title: isSecondProject ? 'Second project master' : 'Source master',
            metadata: { requestable: false }
          }],
          versions: [{
            id: isSecondProject ? versionBId : versionId,
            assetId: isSecondProject ? assetBId : assetId,
            versionNumber: 1,
            originalFilename: isSecondProject ? 'second-project-master.wav' : 'source-master.wav',
            byteSize: candidateBody.byteLength,
            sha256: 'a'.repeat(64),
            mimeType: 'audio/wav'
          }]
        })
      });
      return;
    }
    if (request.method() === 'GET'
      && [
        `/api/talent/audio/versions/${versionId}/content`,
        `/api/talent/audio/versions/${versionBId}/content`
      ].includes(path)) {
      await route.fulfill({ status: 200, contentType: 'audio/wav', body: candidateBody });
      return;
    }
    if (request.method() === 'GET' && path === '/api/talent/audio/files/shared-with-me') {
      if (state.failNextIncomingAfterDelayMs > 0) {
        const delayMs = state.failNextIncomingAfterDelayMs;
        state.failNextIncomingAfterDelayMs = 0;
        state.staleIncomingStarted = true;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Delayed stale incoming failure.' })
        });
        return;
      }
      const capability = await collaborationCapability('incoming');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          files: [collaborationFile({ grantId: collaboratorGrantId, candidate: state.candidateSealed })],
          capabilities: capability
        })
      });
      return;
    }
    if (request.method() === 'GET' && path === '/api/talent/audio/files/shared-by-me') {
      const capability = await collaborationCapability('outgoing');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          files: [collaborationFile({ grantId: creatorGrantId, candidate: true, creatorRetained: true })],
          capabilities: capability
        })
      });
      return;
    }
    if (request.method() === 'GET' && path.endsWith(`/candidates/${candidateId}/content`)) {
      await route.fulfill({ status: 200, contentType: 'audio/wav', body: candidateBody });
      return;
    }
    if (request.method() === 'POST'
      && path === `/api/talent/audio/pairing/connections/${connectionId}/candidate-revision-grants`) {
      grantRequests.push({
        method: request.method(),
        path,
        contentType: request.headers()['content-type'] || '',
        body: request.postDataBuffer() || Buffer.alloc(0)
      });
      const grantIntent = JSON.parse(request.postData() || '{}');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          grant: {
            id: collaboratorGrantId,
            connectionId,
            sourceAssetVersionId: grantIntent.versionId,
            granteeUserId: '99999999-9999-4999-8999-999999999999',
            canUploadCandidateRevision: true,
            maxCandidateBytes: candidateGrantMaxBytes,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString()
          },
          reused: false
        })
      });
      return;
    }

    const candidateRoutePrefix = `/api/talent/audio/file-grants/${collaboratorGrantId}/candidate-uploads`;
    if (request.method() === 'POST' && path === candidateRoutePrefix) {
      captured.push({
        method: request.method(),
        path,
        contentType: request.headers()['content-type'] || '',
        body: request.postDataBuffer() || Buffer.alloc(0)
      });
      if (state.failNextInitiation) {
        state.failNextInitiation = false;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Temporary candidate upload outage.' })
        });
        return;
      }
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          uploadSession: {
            id: uploadSessionId,
            expectedByteSize: candidateBody.byteLength,
            partSizeBytes: 5 * 1024 * 1024,
            expectedPartCount: 1,
            uploadStatus: 'initiated',
            expiresAt: new Date(Date.now() + 3_600_000).toISOString()
          }
        })
      });
      return;
    }
    if (request.method() === 'PUT' && path === `${candidateRoutePrefix}/${uploadSessionId}/parts/1`) {
      captured.push({
        method: request.method(),
        path,
        contentType: request.headers()['content-type'] || '',
        body: request.postDataBuffer() || Buffer.alloc(0)
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ part: { partNumber: 1, byteSize: candidateBody.byteLength } })
      });
      return;
    }
    if (request.method() === 'POST' && path === `${candidateRoutePrefix}/${uploadSessionId}/complete`) {
      captured.push({
        method: request.method(),
        path,
        contentType: request.headers()['content-type'] || '',
        body: request.postDataBuffer() || Buffer.alloc(0)
      });
      state.candidateSealed = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          candidate: {
            id: candidateId,
            sourceAssetVersionId: versionId,
            originalFilename: 'candidate.wav',
            mimeType: 'audio/wav',
            byteSize: candidateBody.byteLength,
            sha256: 'b'.repeat(64),
            durationMs: 100,
            codec: 'pcm',
            sampleRateHz: 8_000,
            bitDepth: 8,
            channelCount: 1,
            intakeStatus: 'private_review',
            sealedAt: new Date().toISOString()
          }
        })
      });
      return;
    }

    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: `Unexpected candidate browser fixture route: ${request.method()} ${path}` })
    });
  });
}

async function assertNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth
  }));
  assert.ok(
    dimensions.document <= dimensions.viewport,
    `Collaborator candidate UI must fit the mobile viewport (${dimensions.document}px vs ${dimensions.viewport}px).`
  );
}

async function waitForCollaborationRefresh(page: Page) {
  await page.waitForFunction(() => {
    const refreshButton = document.querySelector<HTMLButtonElement>('button[aria-label="Refresh Collaborator Inbox"]');
    return refreshButton && !refreshButton.disabled;
  });
}

async function main() {
  let vite: ViteDevServer | null = null;
  let browser: Browser | null = null;
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const candidateBody = wavFixture('browser candidate proof');
  const expectedSha256 = createHash('sha256').update(candidateBody).digest('hex');
  const captured: CapturedRequest[] = [];
  const grantRequests: CapturedRequest[] = [];
  const state: CandidateBrowserState = {
    candidateSealed: false,
    capabilitiesEnabled: false,
    disabledCapabilitySignal: null,
    failNextInitiation: true,
    failNextIncomingAfterDelayMs: 0,
    refreshDelayMs: 0,
    staleIncomingStarted: false,
    projectAssetDelayMs: { [projectId]: 0, [projectBId]: 0 },
    projectAssetRequests: []
  };

  try {
    const port = await reservePort();
    vite = await createViteServer({
      root: process.cwd(),
      publicDir: join(process.cwd(), 'public'),
      logLevel: 'silent',
      server: { host: '127.0.0.1', port, strictPort: true }
    });
    await vite.listen();
    const baseUrl = `http://127.0.0.1:${port}`;

    browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    await context.addInitScript(() => {
      const proofWindow = window as Window & { __swayWholeFileReads?: number };
      const originalArrayBuffer = File.prototype.arrayBuffer;
      proofWindow.__swayWholeFileReads = 0;
      Object.defineProperty(File.prototype, 'arrayBuffer', {
        configurable: true,
        value(this: File) {
          proofWindow.__swayWholeFileReads = (proofWindow.__swayWholeFileReads ?? 0) + 1;
          return originalArrayBuffer.call(this);
        }
      });
    });
    await installApiRoutes(context, state, candidateBody, captured, grantRequests);
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    const screenshotDirectory = join(process.cwd(), '.tmp');
    mkdirSync(screenshotDirectory, { recursive: true });
    const creatorScreenshotPath = join(screenshotDirectory, 'sway-wave5a-candidate-request-browser.png');
    const collaboratorScreenshotPath = join(screenshotDirectory, 'sway-wave5a-candidate-browser.png');

    await page.goto(`${baseUrl}/scripts/browser-fixtures/sway-collaborator-candidate.html?mode=creator`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000
    });
    await page.getByText('source-master.wav · v1').waitFor({ state: 'visible' });
    await page.getByText('File details and sharing').click();
    assert.equal(
      await page.getByRole('button', { name: 'Request private candidate' }).count(),
      0,
      'The creator request action must remain absent while the server capability is disabled.'
    );

    state.capabilitiesEnabled = true;
    state.projectAssetDelayMs[projectId] = 750;
    state.projectAssetRequests = [];
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('Organize projects').click();
    const projectSelector = page.getByLabel('Catalog project');
    await projectSelector.waitFor({ state: 'visible' });
    const firstProjectRequestDeadline = Date.now() + 5_000;
    while (!state.projectAssetRequests.includes(projectId) && Date.now() < firstProjectRequestDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      state.projectAssetRequests.includes(projectId),
      true,
      'The deliberately delayed first-project request must start before project selection changes.'
    );
    await projectSelector.selectOption(projectBId);
    await page.getByText('second-project-master.wav · v1').waitFor({ state: 'visible' });
    await page.waitForTimeout(900);
    assert.equal(await projectSelector.inputValue(), projectBId);
    assert.equal(
      await page.getByText('source-master.wav · v1').count(),
      0,
      'A slower prior-project response must not overwrite the newly selected project.'
    );
    assert.equal(
      state.projectAssetRequests.includes(projectBId),
      true,
      'Changing projects must load the newly selected project.'
    );
    await projectSelector.focus();
    assert.equal(
      await projectSelector.evaluate((element) => document.activeElement === element),
      true,
      'The labeled Catalog project selector must accept keyboard focus.'
    );
    const projectTitleInput = page.getByLabel('New project title');
    await projectTitleInput.focus();
    assert.equal(
      await projectTitleInput.evaluate((element) => document.activeElement === element),
      true,
      'The labeled project-title input must accept keyboard focus.'
    );
    const liveStatus = page.locator('[role="status"][aria-live="polite"]');
    assert.equal(await liveStatus.count(), 1, 'Catalog status updates must use one polite live region.');
    state.projectAssetDelayMs[projectId] = 0;
    await page.getByText('File details and sharing').click();
    const requestCandidateButton = page.getByRole('button', { name: 'Request private candidate' });
    await requestCandidateButton.waitFor({ state: 'visible' });
    assert.equal(await requestCandidateButton.isEnabled(), true, 'The creator request action requires a selected active connection.');
    await page.getByText('Request ceiling: 16 MiB', { exact: false }).first().waitFor({ state: 'visible' });

    state.disabledCapabilitySignal = 'outgoing';
    state.refreshDelayMs = 750;
    const creatorRefreshButton = page.getByRole('button', { name: 'Refresh Collaborator Inbox' });
    await creatorRefreshButton.click();
    await requestCandidateButton.waitFor({ state: 'detached', timeout: 300 });
    assert.equal(
      grantRequests.length,
      0,
      'A creator request control must disappear at refresh start before any grant mutation.'
    );
    await waitForCollaborationRefresh(page);
    assert.equal(
      await requestCandidateButton.count(),
      0,
      'One false collaboration capability signal must keep the creator request control absent.'
    );

    state.disabledCapabilitySignal = null;
    state.refreshDelayMs = 0;
    await creatorRefreshButton.click();
    await requestCandidateButton.waitFor({ state: 'visible' });
    await requestCandidateButton.click();
    await page.getByText('Private-candidate upload requested for seven days with a 16 MiB ceiling. It cannot replace the source or enter a release.').waitFor({ state: 'visible' });
    assert.equal(grantRequests.length, 1, 'The creator action must issue exactly one private-candidate grant request.');
    assert.equal(grantRequests[0].contentType, 'application/json');
    assert.equal(grantRequests[0].path, `/api/talent/audio/pairing/connections/${connectionId}/candidate-revision-grants`);
    const grantIntent = JSON.parse(grantRequests[0].body.toString('utf8'));
    assert.equal(grantIntent.versionId, versionBId);
    assert.equal(grantIntent.maxCandidateBytes, candidateGrantMaxBytes);
    assert.equal(grantIntent.expiresInHours, 168);
    assert.match(grantIntent.idempotencyKey, new RegExp(`^candidate-grant:${versionBId}:[0-9a-f-]{36}$`, 'i'));
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: creatorScreenshotPath, fullPage: true });

    state.capabilitiesEnabled = false;
    state.disabledCapabilitySignal = null;
    await page.goto(`${baseUrl}/scripts/browser-fixtures/sway-collaborator-candidate.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000
    });
    await page.getByRole('heading', { name: 'Collaborator Inbox' }).waitFor({ state: 'visible' });
    await page.getByText('Private-candidate intake is currently disabled.').waitFor({ state: 'visible' });
    assert.equal(
      await page.getByLabel('Upload private candidate for source-master.wav').count(),
      0,
      'A missing capability signal must remove the candidate file input.'
    );
    assert.equal(captured.length, 0, 'Capability-off rendering must not issue candidate mutation requests.');

    state.capabilitiesEnabled = true;
    await page.reload({ waitUntil: 'domcontentloaded' });
    const uploadInput = page.getByLabel('Upload private candidate for source-master.wav');
    await uploadInput.waitFor({ state: 'visible' });
    assert.equal(await uploadInput.isEnabled(), true, 'Candidate input must enable only after all capability signals agree.');
    await page.getByText('creator-approved 16 MiB ceiling', { exact: false }).first().waitFor({ state: 'visible' });
    await uploadInput.focus();
    assert.equal(
      await uploadInput.evaluate((element) => document.activeElement === element),
      true,
      'The candidate file input must accept keyboard focus.'
    );
    const uploadBox = await uploadInput.boundingBox();
    assert.ok(uploadBox && uploadBox.width >= 44 && uploadBox.height >= 44, 'Candidate upload target must be at least 44 by 44 CSS pixels.');
    await assertNoHorizontalOverflow(page);

    const retainedCreatorPlayback = page.locator(`audio[src="/api/talent/audio/file-grants/${creatorGrantId}/candidates/${candidateId}/content"]`);
    await retainedCreatorPlayback.waitFor({ state: 'visible' });
    state.disabledCapabilitySignal = 'incoming';
    state.refreshDelayMs = 750;
    const collaboratorRefreshButton = page.getByRole('button', { name: 'Refresh Collaborator Inbox' });
    await collaboratorRefreshButton.click();
    await uploadInput.waitFor({ state: 'detached', timeout: 300 });
    await retainedCreatorPlayback.waitFor({ state: 'detached', timeout: 300 });
    assert.equal(captured.length, 0, 'Fail-closed refresh rendering must happen before any candidate upload mutation.');
    await waitForCollaborationRefresh(page);
    assert.equal(await uploadInput.count(), 0, 'One false capability signal must keep candidate upload controls absent.');
    assert.equal(await retainedCreatorPlayback.count(), 0, 'One false capability signal must keep candidate playback controls absent.');

    state.disabledCapabilitySignal = null;
    state.refreshDelayMs = 0;
    await collaboratorRefreshButton.click();
    await uploadInput.waitFor({ state: 'visible' });
    await retainedCreatorPlayback.waitFor({ state: 'visible' });

    state.failNextIncomingAfterDelayMs = 750;
    state.staleIncomingStarted = false;
    await page.evaluate(() => {
      const refresh = (window as Window & { __swayRefreshCollaboration?: () => void })
        .__swayRefreshCollaboration;
      if (!refresh) throw new Error('Candidate harness refresh control is unavailable.');
      refresh();
    });
    const staleStartDeadline = Date.now() + 5_000;
    while (!state.staleIncomingStarted && Date.now() < staleStartDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(state.staleIncomingStarted, true, 'The deliberately delayed older refresh must start.');
    await page.evaluate(() => {
      const refresh = (window as Window & { __swayRefreshCollaboration?: () => void })
        .__swayRefreshCollaboration;
      if (!refresh) throw new Error('Candidate harness refresh control is unavailable.');
      refresh();
    });
    await uploadInput.waitFor({ state: 'visible' });
    await retainedCreatorPlayback.waitFor({ state: 'visible' });
    await page.waitForTimeout(900);
    assert.equal(
      await uploadInput.count(),
      1,
      'An older failed refresh must not remove controls restored by a newer successful refresh.'
    );
    assert.equal(
      await retainedCreatorPlayback.count(),
      1,
      'An older failed refresh must not remove playback restored by a newer successful refresh.'
    );
    assert.equal(
      await page.getByText('Delayed stale incoming failure.').count(),
      0,
      'An older failed refresh must not overwrite the newer successful state.'
    );

    await page.evaluate(() => {
      (window as Window & { __swayWholeFileReads?: number }).__swayWholeFileReads = 0;
    });
    await uploadInput.setInputFiles({
      name: 'candidate-too-large.wav',
      mimeType: 'audio/wav',
      buffer: Buffer.alloc(candidateGrantMaxBytes + 1, 0x80)
    });
    await page.getByText("This file exceeds this request's creator-approved 16 MiB candidate ceiling.").waitFor({ state: 'visible' });
    assert.equal(
      await page.evaluate(() => (window as Window & { __swayWholeFileReads?: number }).__swayWholeFileReads ?? -1),
      0,
      'An oversized candidate must be refused before the whole-file read used by SHA-256 hashing.'
    );
    assert.equal(captured.length, 0, 'An oversized candidate must be refused before any upload API request.');
    assert.equal(await uploadInput.inputValue(), '', 'An oversized candidate rejection must clear the picker.');

    await uploadInput.setInputFiles({
      name: 'candidate.wav',
      mimeType: 'audio/wav',
      buffer: candidateBody
    });
    await page.getByText('Temporary candidate upload outage.').waitFor({ state: 'visible' });
    assert.equal(
      await page.evaluate(() => (window as Window & { __swayWholeFileReads?: number }).__swayWholeFileReads ?? -1),
      1,
      'The first in-cap candidate attempt must perform one whole-file hash read.'
    );
    assert.equal(await uploadInput.inputValue(), '', 'A failed upload start must clear the picker so the same file can be retried.');
    assert.equal(await uploadInput.isEnabled(), true, 'A failed upload start must restore the candidate input.');
    await uploadInput.setInputFiles({
      name: 'candidate.wav',
      mimeType: 'audio/wav',
      buffer: candidateBody
    });
    await page.getByText('Private candidate sealed for creator review. It did not replace the source or enter a release.').waitFor({ state: 'visible' });
    assert.equal(
      await page.evaluate(() => (window as Window & { __swayWholeFileReads?: number }).__swayWholeFileReads ?? -1),
      2,
      'The intentional same-file retry must perform one fresh bounded whole-file hash read.'
    );
    await page.getByText('Private candidate received for review').waitFor({ state: 'visible' });
    await page.getByText('Upload authority ended; the sealed candidate remains creator-visible.').waitFor({ state: 'visible' });

    assert.deepEqual(captured.map((request) => [request.method, request.path]), [
      ['POST', `/api/talent/audio/file-grants/${collaboratorGrantId}/candidate-uploads`],
      ['POST', `/api/talent/audio/file-grants/${collaboratorGrantId}/candidate-uploads`],
      ['PUT', `/api/talent/audio/file-grants/${collaboratorGrantId}/candidate-uploads/${uploadSessionId}/parts/1`],
      ['POST', `/api/talent/audio/file-grants/${collaboratorGrantId}/candidate-uploads/${uploadSessionId}/complete`]
    ]);
    const initiation = JSON.parse(captured[1].body.toString('utf8'));
    assert.deepEqual(initiation, {
      originalFilename: 'candidate.wav',
      mimeType: 'audio/wav',
      expectedByteSize: candidateBody.byteLength,
      expectedSha256,
      idempotencyKey: `candidate-upload:${collaboratorGrantId}:${expectedSha256}:${candidateBody.byteLength}`,
      partSizeBytes: AUDIO_UPLOAD_PART_SIZE_BYTES
    });
    assert.deepEqual(captured[0].body, captured[1].body, 'A same-file retry must replay the exact idempotent initiation intent.');
    assert.equal(captured[1].contentType, 'application/json');
    assert.equal(captured[2].contentType, 'application/octet-stream');
    assert.deepEqual(captured[2].body, candidateBody, 'The browser must send the exact selected bytes in the bounded part route.');
    assert.equal(captured[3].body.byteLength, 0, 'Candidate completion must not send an unbound payload.');
    assert.equal(await page.getByRole('button', { name: 'Review history' }).count(), 0, 'Upload-only grants must expose no review actions.');
    assert.equal(await page.getByRole('button', { name: 'Approve' }).count(), 0, 'Upload-only grants must expose no approval action.');
    assert.equal(await uploadInput.count(), 0, 'A sealed one-candidate grant must remove the upload input.');
    assert.equal(
      await page.locator(`audio[src="/api/talent/audio/file-grants/${creatorGrantId}/candidates/${candidateId}/content"]`).count(),
      1,
      'The creator must retain a playable candidate after upload authority ends.'
    );
    assert.equal(
      await page.locator('vite-error-overlay, .vite-error-overlay, #webpack-dev-server-client-overlay').count(),
      0,
      'The rendered candidate flow must not show a framework error overlay.'
    );
    await page.waitForFunction(() => [...document.images].every((image) => image.complete));
    const brokenImages = await page.locator('img').evaluateAll((images) => (images as HTMLImageElement[])
      .filter((image) => image.naturalWidth === 0)
      .map((image) => image.currentSrc || image.getAttribute('src') || 'unknown'));
    assert.deepEqual(brokenImages, [], `The rendered candidate flow contains broken images: ${brokenImages.join(', ')}`);
    await assertNoHorizontalOverflow(page);

    await page.screenshot({ path: collaboratorScreenshotPath, fullPage: true });
    assert.deepEqual(pageErrors, [], `Candidate browser flow raised page errors:\n${pageErrors.join('\n')}`);
    const injectedOutageErrors = consoleErrors.filter((message) => (
      message.includes('Failed to load resource') && message.includes('503')
    ));
    const unexpectedConsoleErrors = consoleErrors.filter((message) => !injectedOutageErrors.includes(message));
    assert.equal(
      injectedOutageErrors.length,
      2,
      'The browser must observe exactly the intentionally injected stale-refresh and upload-start 503 failures.'
    );
    assert.deepEqual(
      unexpectedConsoleErrors,
      [],
      `Candidate browser flow raised unexpected console errors:\n${unexpectedConsoleErrors.join('\n')}`
    );
    console.log(`Sway collaborator candidate browser proof passed. Screenshots: ${creatorScreenshotPath}, ${collaboratorScreenshotPath}`);
  } finally {
    await browser?.close().catch(() => undefined);
    await vite?.close().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
