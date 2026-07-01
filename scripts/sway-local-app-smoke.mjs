const config = {
  baseUrl: (process.env.SWAY_LOCAL_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '')
};

const checks = [
  {
    name: 'public home',
    path: '/',
    expectedStatus: 200,
    contentType: 'text/html',
    mustInclude: ['Sway', 'Audience: join a live room', 'Performer sign in']
  },
  {
    name: 'patron shell entry',
    path: '/home',
    expectedStatus: 200,
    contentType: 'text/html'
  },
  {
    name: 'performer login',
    path: '/talent/login',
    expectedStatus: 200,
    contentType: 'text/html'
  },
  {
    name: 'install manifest',
    path: '/sway.webmanifest',
    expectedStatus: 200,
    contentType: 'application/manifest+json',
    mustInclude: ['"display":"standalone"', '"short_name":"Sway"']
  },
  {
    name: 'service worker',
    path: '/sw.js',
    expectedStatus: 200,
    contentType: 'text/javascript'
  },
  {
    name: 'offline fallback',
    path: '/offline.html',
    expectedStatus: 200,
    contentType: 'text/html',
    mustInclude: ['You are offline.', 'Return to Sway']
  },
  {
    name: 'apple touch icon',
    path: '/apple-touch-icon.png',
    expectedStatus: 200,
    contentType: 'image/png'
  }
];

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

function pass(message) {
  console.log(`PASS ${message}`);
}

for (const check of checks) {
  const response = await fetch(`${config.baseUrl}${check.path}`, {
    headers: { Accept: '*/*', 'Cache-Control': 'no-cache' }
  }).catch((error) => {
    fail(`${check.name} request failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });

  if (!response) continue;
  const body = await response.text().catch(() => '');
  const contentType = response.headers.get('content-type') || '';

  if (response.status !== check.expectedStatus) {
    fail(`${check.name} expected ${check.expectedStatus} but got ${response.status}`);
    continue;
  }

  if (check.contentType && !contentType.includes(check.contentType)) {
    fail(`${check.name} expected content-type containing ${check.contentType} but got ${contentType || '<none>'}`);
    continue;
  }

  if (Array.isArray(check.mustInclude)) {
    const normalized = body.replace(/\s+/g, ' ');
    const missing = check.mustInclude.filter((term) => !normalized.includes(term));
    if (missing.length > 0) {
      fail(`${check.name} missing expected content: ${missing.join(', ')}`);
      continue;
    }
  }

  pass(`${check.name} OK`);
}

if (process.exitCode && process.exitCode !== 0) {
  console.error(`Local app smoke failed against ${config.baseUrl}`);
  process.exit(process.exitCode);
}

console.log(`Local app smoke passed against ${config.baseUrl}`);
