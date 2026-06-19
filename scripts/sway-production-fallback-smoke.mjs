import { createHmac } from 'node:crypto';

const config = readConfig();
const failures = [];

function readConfig() {
  const baseUrl = process.env.SWAY_PRODUCTION_BASE_URL?.trim() || 'https://app.sway.tips';
  const expectedBuildSha = process.env.SWAY_EXPECTED_BUILD_SHA?.trim() || null;
  const secret = requireEnv('SWAY_FALLBACK_ACTOR_HEADER_SECRET');
  const performerActorId = requireEnv('SWAY_FALLBACK_TALENT_ACTOR_ID');
  const adminActorId = requireEnv('SWAY_FALLBACK_ADMIN_ACTOR_ID');
  const supportActorId = optionalEnv('SWAY_FALLBACK_SUPPORT_ACTOR_ID');
  const sessionId = process.env.SWAY_FALLBACK_SESSION_ID?.trim() || 'smoke-session';
  const timestamp = process.env.SWAY_FALLBACK_TIMESTAMP?.trim() || new Date().toISOString();

  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Error('SWAY_FALLBACK_TIMESTAMP must be a valid ISO-8601 timestamp when provided.');
  }

  return {
    baseUrl: baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl,
    expectedBuildSha,
    secret,
    performerActorId,
    adminActorId,
    supportActorId,
    sessionId,
    timestamp
  };
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function optionalEnv(name) {
  const value = process.env[name]?.trim();
  return value || null;
}

function signFallbackAssertion(actorId, sessionId, role, timestamp, secret) {
  return createHmac('sha256', secret)
    .update(`${actorId}|${sessionId}|${role}|${timestamp}`)
    .digest('hex');
}

function createFallbackHeaders(actorId, role, signatureOverride) {
  return {
    'x-sway-actor-id': actorId,
    'x-sway-session-id': config.sessionId,
    'x-sway-fallback-role': role,
    'x-sway-fallback-timestamp': config.timestamp,
    'x-sway-fallback-signature': signatureOverride
      ?? signFallbackAssertion(actorId, config.sessionId, role, config.timestamp, config.secret)
  };
}

async function request(name, path, options = {}) {
  const headers = new Headers(options.headers || {});
  const response = await fetch(`${config.baseUrl}${path}`, {
    method: options.method || 'GET',
    headers
  });
  const contentType = response.headers.get('content-type') || '';
  const body = await response.text();

  return {
    name,
    path,
    status: response.status,
    ok: response.ok,
    contentType,
    body
  };
}

function recordPass(message) {
  console.log(`PASS ${message}`);
}

function recordFailure(message) {
  failures.push(message);
  console.log(`FAIL ${message}`);
}

function summarizeBody(body) {
  if (!body) return '<empty>';
  const singleLine = body.replace(/\s+/g, ' ').trim();
  return singleLine.slice(0, 180);
}

function assertCondition(condition, successMessage, failureMessage) {
  if (condition) {
    recordPass(successMessage);
    return;
  }
  recordFailure(failureMessage);
}

async function verifyBuildMarker() {
  const response = await request('build-marker', '/api/build-marker', {
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' }
  });

  if (response.status !== 200) {
    recordFailure(`/api/build-marker returned ${response.status}`);
    return;
  }

  let marker;
  try {
    marker = JSON.parse(response.body);
  } catch {
    recordFailure('/api/build-marker returned invalid JSON');
    return;
  }

  assertCondition(
    marker?.service === 'sway.tips',
    `/api/build-marker service=${marker.service}`,
    `/api/build-marker service mismatch: ${marker?.service ?? 'missing'}`
  );
  assertCondition(
    typeof marker?.commit === 'string' && marker.commit.length > 0,
    `/api/build-marker commit=${marker.commit}`,
    '/api/build-marker commit missing'
  );
  assertCondition(
    typeof marker?.buildTimestamp === 'string' && !Number.isNaN(Date.parse(marker.buildTimestamp)),
    `/api/build-marker timestamp=${marker.buildTimestamp}`,
    '/api/build-marker timestamp missing or invalid'
  );

  if (config.expectedBuildSha) {
    assertCondition(
      marker?.commit === config.expectedBuildSha,
      `/api/build-marker matched expected sha ${config.expectedBuildSha}`,
      `/api/build-marker sha mismatch: expected ${config.expectedBuildSha}, got ${marker?.commit ?? 'missing'}`
    );
  }
}

async function verifySignedApi(path, actorId, role, label) {
  const response = await request(label, path, {
    headers: {
      Accept: 'application/json',
      ...createFallbackHeaders(actorId, role)
    }
  });

  assertCondition(
    response.status >= 200 && response.status < 300,
    `${label} returned ${response.status}`,
    `${label} expected 2xx but returned ${response.status}: ${summarizeBody(response.body)}`
  );
  assertCondition(
    response.status !== 503,
    `${label} did not return 503`,
    `${label} returned 503, indicating fallback config is missing or not loaded`
  );
}

async function verifySignedHtml(path, actorId, role, label) {
  const response = await request(label, path, {
    headers: {
      Accept: 'text/html',
      ...createFallbackHeaders(actorId, role)
    }
  });

  assertCondition(
    response.status >= 200 && response.status < 300,
    `${label} returned ${response.status}`,
    `${label} expected 2xx but returned ${response.status}: ${summarizeBody(response.body)}`
  );
  assertCondition(
    response.contentType.includes('text/html'),
    `${label} returned HTML`,
    `${label} expected text/html but received ${response.contentType || 'no content-type'}`
  );
}

async function verifyAnonymousApi(path, label) {
  const response = await request(label, path, {
    headers: { Accept: 'application/json' }
  });

  assertCondition(
    response.status === 401,
    `${label} returned 401`,
    `${label} expected 401 but returned ${response.status}: ${summarizeBody(response.body)}`
  );
}

async function verifyAnonymousHtml(path, label) {
  // Protected HTML route families still return HTTP 401, but render a recovery page
  // because browser-style Accept headers request text/html.
  const response = await request(label, path, {
    headers: { Accept: 'text/html' }
  });

  assertCondition(
    response.status === 401,
    `${label} returned 401`,
    `${label} expected 401 but returned ${response.status}: ${summarizeBody(response.body)}`
  );
  assertCondition(
    response.contentType.includes('text/html'),
    `${label} returned protected HTML`,
    `${label} expected protected HTML but received ${response.contentType || 'no content-type'}`
  );
}

async function verifyInvalidSignatureFailClosed() {
  const response = await request('invalid-signature-talent-api', '/api/talent/active-rooms', {
    headers: {
      Accept: 'application/json',
      ...createFallbackHeaders(config.performerActorId, 'performer', 'deadbeef')
    }
  });

  assertCondition(
    response.status !== 503,
    'invalid-signature-talent-api did not return 503',
    'invalid-signature-talent-api returned 503, indicating fallback config is missing or not loaded'
  );
  assertCondition(
    response.status >= 400 && response.status < 500,
    `invalid-signature-talent-api failed closed with ${response.status}`,
    `invalid-signature-talent-api expected fail-closed 4xx but returned ${response.status}: ${summarizeBody(response.body)}`
  );
}

async function main() {
  console.log(`Running persisted access fallback smoke against ${config.baseUrl}`);
  if (config.expectedBuildSha) {
    console.log(`Expecting deployed build sha ${config.expectedBuildSha}`);
  }

  await verifyBuildMarker();
  await verifySignedApi('/api/talent/active-rooms', config.performerActorId, 'performer', 'signed-talent-api');
  await verifySignedApi('/api/admin/active-rooms', config.adminActorId, 'admin', 'signed-admin-api');
  await verifySignedHtml('/talent/gigs', config.performerActorId, 'performer', 'signed-talent-html');
  await verifySignedHtml('/admin', config.adminActorId, 'admin', 'signed-admin-html');
  await verifyAnonymousApi('/api/talent/active-rooms', 'anonymous-talent-api');
  await verifyAnonymousApi('/api/admin/active-rooms', 'anonymous-admin-api');
  await verifyAnonymousHtml('/talent/gigs', 'anonymous-talent-html');
  await verifyAnonymousHtml('/admin', 'anonymous-admin-html');
  await verifyInvalidSignatureFailClosed();

  if (config.supportActorId) {
    const response = await request('signed-support-admin-api', '/api/admin/active-rooms', {
      headers: {
        Accept: 'application/json',
        ...createFallbackHeaders(config.supportActorId, 'support')
      }
    });

    assertCondition(
      response.status >= 200 && response.status < 300,
      `signed-support-admin-api returned ${response.status}`,
      `signed-support-admin-api expected 2xx but returned ${response.status}: ${summarizeBody(response.body)}`
    );
  }

  if (failures.length > 0) {
    console.log(`Persisted access fallback smoke failed with ${failures.length} issue(s).`);
    process.exit(1);
  }

  console.log('Persisted access fallback smoke passed.');
}

main().catch((error) => {
  console.error('Persisted access fallback smoke failed.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
