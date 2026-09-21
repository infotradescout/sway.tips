'use strict';

// Read-only check of the exact public pages served by the running process.
// Keep the configured entry point, but never require a narrower DJ-only product.
const { ABOUT_PAGE_HTML, FAQ_PAGE_HTML } = require('./sway-dj-beta-about-preload.cjs');

async function inspectPublicInformation(origin, expectedBuild = null, fetchImpl = fetch) {
  const results = await Promise.all([
    ['/about', ABOUT_PAGE_HTML],
    ['/faq', FAQ_PAGE_HTML]
  ].map(async ([path, expectedHtml]) => {
    const response = await fetchImpl(`${origin}${path}`, {
      headers: { accept: 'text/html', 'user-agent': 'sway-runtime-proof/2.0' },
      cache: 'no-store', signal: AbortSignal.timeout(5000)
    });
    const html = await response.text();
    const build = response.headers.get('x-commit-sha');
    return {
      path, status: response.status, build,
      passed: response.status === 200
        && /text\/html/i.test(response.headers.get('content-type') || '')
        && html === expectedHtml
        && (!expectedBuild || build === expectedBuild)
    };
  }));
  return { passed: results.every(result => result.passed), expectedBuild, results };
}

const entrypoint = String(process.argv[1] || '').replace(/\\/g, '/');
if (entrypoint.endsWith('/dist/server.cjs')) {
  const timer = setTimeout(async () => {
    try {
      const result = await inspectPublicInformation(
        `http://127.0.0.1:${process.env.PORT || '3000'}`,
        process.env.RENDER_GIT_COMMIT || null
      );
      const message = `[sway.about] runtime proof ${result.passed ? 'PASS' : 'FAIL'} ${JSON.stringify(result)}`;
      if (result.passed) console.log(message); else console.error(message);
    } catch (error) {
      console.error('[sway.about] runtime proof ERROR', {
        message: error instanceof Error ? error.message : String(error),
        expectedBuild: process.env.RENDER_GIT_COMMIT || null
      });
    }
  }, 8000);
  timer.unref?.();
}
module.exports = { inspectPublicInformation };
