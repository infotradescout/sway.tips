'use strict';

/**
 * Exact-runtime proof for the opening DJ beta About/FAQ surface.
 *
 * NODE_OPTIONS loads this file in every Node child process. The proof runs
 * only in the deployed server process, after the HTTP listener has had time
 * to start. It makes no mutations and does not affect request handling.
 */

const entrypoint = String(process.argv[1] || '').replace(/\\/g, '/');
const isSwayServerRuntime = entrypoint.endsWith('/dist/server.cjs');

if (isSwayServerRuntime) {
  const requiredTerms = [
    'Run the crowd without stopping the set.',
    'Sway works alongside your existing DJ setup.',
    'Requests in one queue',
    'Approved boosts',
    'Clear status',
    'How patrons use Sway',
    'How to run Sway tonight',
    'Create your DJ account',
    'Log in and start',
    'Join a live room',
    'The opening DJ beta is focused on Request, Tip, Boost, queue control, patron status, and room recap.'
  ];

  const forbiddenTerms = [
    'Sway.DIO',
    'Self-Production',
    'DistroKid',
    'Replacing an existing distributor',
    'contracted DSP delivery provider',
    'royalty-statement',
    'catalog transfer',
    'multi-recording release',
    'provider-backed delivery'
  ];

  const requiredHrefs = [
    '/account/signup',
    '/account/login',
    '/home',
    '/privacy',
    '/terms',
    '/support',
    '/privacy/data-deletion',
    '/legal/payments',
    '/legal/payouts',
    '/legal/tickets'
  ];

  const port = String(process.env.PORT || '3000');
  const origin = `http://127.0.0.1:${port}`;

  const inspectRoute = async (path) => {
    const response = await fetch(`${origin}${path}`, {
      headers: {
        accept: 'text/html',
        'user-agent': 'sway-runtime-proof/1.0'
      },
      cache: 'no-store'
    });
    const html = await response.text();
    const missingRequiredTerms = requiredTerms.filter((term) => !html.includes(term));
    const presentForbiddenTerms = forbiddenTerms.filter((term) => html.includes(term));
    const missingHrefs = requiredHrefs.filter((href) => !html.includes(`href="${href}"`));

    return {
      path,
      status: response.status,
      contentType: response.headers.get('content-type'),
      build: response.headers.get('x-commit-sha'),
      missingRequiredTerms,
      presentForbiddenTerms,
      missingHrefs,
      passed: response.status === 200
        && /text\/html/i.test(response.headers.get('content-type') || '')
        && missingRequiredTerms.length === 0
        && presentForbiddenTerms.length === 0
        && missingHrefs.length === 0
    };
  };

  const runProof = async () => {
    try {
      const results = await Promise.all([
        inspectRoute('/about'),
        inspectRoute('/faq')
      ]);
      const passed = results.every((result) => result.passed);
      const payload = {
        passed,
        expectedBuild: process.env.RENDER_GIT_COMMIT || null,
        results
      };

      if (passed) {
        console.log(`[sway.about] runtime proof PASS ${JSON.stringify(payload)}`);
      } else {
        console.error(`[sway.about] runtime proof FAIL ${JSON.stringify(payload)}`);
      }
    } catch (error) {
      console.error('[sway.about] runtime proof ERROR', {
        message: error instanceof Error ? error.message : String(error),
        expectedBuild: process.env.RENDER_GIT_COMMIT || null
      });
    }
  };

  const proofTimer = setTimeout(runProof, 8000);
  proofTimer.unref?.();
}
